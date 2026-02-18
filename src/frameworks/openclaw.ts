import { createHash } from "node:crypto";
import type { AgentConfig, AgentInstance } from "./langchain.js";

const SANDBOX_URL = (
    process.env.SANDBOX_INTERNAL_OPENCLAW_URL ||
    process.env.SANDBOX_URL ||
    "https://services.compose.market/sandbox"
).replace(/\/+$/, "");

const MANOWAR_INTERNAL_SECRET = process.env.MANOWAR_INTERNAL_SECRET || "";

interface UsageSummary {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
}

type JsonRecord = Record<string, unknown>;

export interface OpenClawExecutionParams {
    agentWallet: string;
    model: string;
    message: string;
    userId?: string;
    threadId?: string;
    manowarWallet?: string;
    grantedPermissions?: string[];
}

export interface OpenClawExecutionResult {
    success: boolean;
    output: string;
    usage?: UsageSummary;
    promptTokens?: number;
    completionTokens?: number;
    runtimeId?: string;
    containerName?: string;
    sessionKey: string;
    toolCalls?: Array<{ name: string; args: Record<string, unknown>; result: unknown }>;
}

function buildHeaders(): Record<string, string> {
    return {
        "Content-Type": "application/json",
    };
}

function buildStableSessionKey(agentWallet: string, userKey: string): string {
    const hash = createHash("sha256")
        .update(`${agentWallet.toLowerCase()}:${userKey}`)
        .digest("hex")
        .slice(0, 32);
    return `agent:main:compose-${hash}`;
}

function coerceTextContent(content: unknown): string {
    if (typeof content === "string") return content;
    if (Array.isArray(content)) {
        return content
            .map((part) => {
                if (!part || typeof part !== "object") return "";
                const text = (part as { text?: unknown }).text;
                const inputText = (part as { input_text?: unknown }).input_text;
                if (typeof text === "string") return text;
                if (typeof inputText === "string") return inputText;
                return "";
            })
            .filter((v) => v.length > 0)
            .join("\n");
    }
    return "";
}

function parseUsage(payload: JsonRecord): UsageSummary | undefined {
    const usageRaw = payload.usage;
    if (!usageRaw || typeof usageRaw !== "object") return undefined;
    const usage = usageRaw as Record<string, unknown>;
    const promptTokens = Number(usage.prompt_tokens || 0);
    const completionTokens = Number(usage.completion_tokens || 0);
    const totalTokens = Number(
        usage.total_tokens || promptTokens + completionTokens,
    );
    if (!Number.isFinite(promptTokens) || !Number.isFinite(completionTokens) || !Number.isFinite(totalTokens)) {
        return undefined;
    }
    return {
        prompt_tokens: promptTokens,
        completion_tokens: completionTokens,
        total_tokens: totalTokens,
    };
}

async function parseErrorText(response: Response): Promise<string> {
    const fallback = `HTTP ${response.status}`;
    try {
        const json = await response.json() as JsonRecord;
        const err = json.error;
        if (typeof err === "string") return err;
        if (err && typeof err === "object" && typeof (err as { message?: unknown }).message === "string") {
            return (err as { message: string }).message;
        }
        return JSON.stringify(json);
    } catch {
        try {
            const text = await response.text();
            return text || fallback;
        } catch {
            return fallback;
        }
    }
}

async function postInternal(path: string, payload: JsonRecord): Promise<Response> {
    return fetch(`${SANDBOX_URL}${path}`, {
        method: "POST",
        headers: buildHeaders(),
        body: JSON.stringify(payload),
    });
}

export async function ensureOpenClawRuntime(params: Omit<OpenClawExecutionParams, "message">): Promise<{
    sessionKey: string;
    runtimeId?: string;
    containerName?: string;
}> {
    const userKey = params.userId || "";
    const sessionKey = buildStableSessionKey(params.agentWallet, userKey);

    const response = await postInternal("/internal/openclaw/runtime/ensure", {
        agentWallet: params.agentWallet,
        model: params.model,
        userKey,
        threadId: params.threadId,
        sessionKey,
    });

    if (!response.ok) {
        const errorText = await parseErrorText(response);
        throw new Error(`OpenClaw runtime ensure failed: ${errorText}`);
    }

    const payload = await response.json() as JsonRecord;
    return {
        sessionKey: String(payload.sessionKey || sessionKey),
        runtimeId: typeof payload.runtimeId === "string" ? payload.runtimeId : undefined,
        containerName: typeof payload.containerName === "string" ? payload.containerName : undefined,
    };
}

export async function executeOpenClawAgent(params: OpenClawExecutionParams): Promise<OpenClawExecutionResult> {
    const userKey = params.userId || "";
    const sessionKey = buildStableSessionKey(params.agentWallet, userKey);

    const response = await postInternal("/internal/openclaw/chat", {
        agentWallet: params.agentWallet,
        model: params.model,
        message: params.message,
        userKey,
        userId: params.userId,
        threadId: params.threadId,
        manowarWallet: params.manowarWallet,
        grantedPermissions: params.grantedPermissions || [],
        sessionKey,
    });

    if (!response.ok) {
        const errorText = await parseErrorText(response);
        throw new Error(`OpenClaw chat failed: ${errorText}`);
    }

    const payload = await response.json() as JsonRecord;
    const usage = parseUsage(payload);
    const explicitOutput = typeof payload.output === "string" ? payload.output : undefined;

    let output = explicitOutput || "";
    if (!output && payload.choices && Array.isArray(payload.choices)) {
        const firstChoice = payload.choices[0] as Record<string, unknown> | undefined;
        const message = firstChoice?.message as Record<string, unknown> | undefined;
        output = coerceTextContent(message?.content);
    }

    return {
        success: true,
        output,
        usage,
        promptTokens: usage?.prompt_tokens,
        completionTokens: usage?.completion_tokens,
        runtimeId: typeof payload.runtimeId === "string" ? payload.runtimeId : undefined,
        containerName: typeof payload.containerName === "string" ? payload.containerName : undefined,
        sessionKey: typeof payload.sessionKey === "string" ? payload.sessionKey : sessionKey,
        toolCalls: Array.isArray(payload.toolCalls)
            ? payload.toolCalls as Array<{ name: string; args: Record<string, unknown>; result: unknown }>
            : undefined,
    };
}

export async function* streamOpenClawAgent(
    params: OpenClawExecutionParams,
): AsyncGenerator<Record<string, unknown>, void, unknown> {
    const userKey = params.userId || "";
    const sessionKey = buildStableSessionKey(params.agentWallet, userKey);

    const response = await postInternal("/internal/openclaw/chat/stream", {
        agentWallet: params.agentWallet,
        model: params.model,
        message: params.message,
        userKey,
        userId: params.userId,
        threadId: params.threadId,
        manowarWallet: params.manowarWallet,
        grantedPermissions: params.grantedPermissions || [],
        sessionKey,
    });

    if (!response.ok) {
        const errorText = await parseErrorText(response);
        throw new Error(`OpenClaw stream failed: ${errorText}`);
    }

    const reader = response.body?.getReader();
    if (!reader) {
        throw new Error("OpenClaw stream missing response body");
    }

    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";

        for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed.startsWith("data:")) continue;
            const data = trimmed.slice(5).trim();
            if (!data || data === "[DONE]") {
                return;
            }

            try {
                yield JSON.parse(data) as Record<string, unknown>;
            } catch {
                yield {
                    type: "response.output_text.delta",
                    delta: data,
                };
            }
        }
    }

    if (buffer.trim().startsWith("data:")) {
        const data = buffer.trim().slice(5).trim();
        if (data && data !== "[DONE]") {
            try {
                yield JSON.parse(data) as Record<string, unknown>;
            } catch {
                yield {
                    type: "response.output_text.delta",
                    delta: data,
                };
            }
        }
    }
}

export async function createOpenClawAgent(config: AgentConfig): Promise<AgentInstance> {
    // OpenClaw runtime deployment is lazy per (agent,user) and handled by sandbox.
    // Runtime registration still needs an instance envelope in the registry.
    return {
        id: config.agentWallet,
        name: config.name,
        executor: null,
        config,
        tools: [],
    };
}
