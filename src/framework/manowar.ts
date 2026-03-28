import { ChatOpenAI } from "@langchain/openai";
import { HumanMessage } from "@langchain/core/messages";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import type { AgentWallet } from "../agent-wallet.js";
import { createAgentGraph } from "./agent/graph.js";
import { createAgentTools } from "./agent/tools.js";
import { Mem0CallbackHandler } from "./agent/callbacks.js";
import { runWithAgentExecutionContext } from "./agent/context.js";
import {
  buildApiInternalHeaders,
  requireApiInternalToken,
  requireApiInternalUrl,
} from "../auth.js";
import {
  AgentMemoryTracker,
  extractTokens,
  resolveAuthoritativeTokens,
} from "./langsmith.js";
import { shouldEnforceCloudPermissions } from "./mode.js";

export interface BackpackConnectedAccount {
  slug: string;
  name: string;
  connected: boolean;
  accountId?: string;
  status?: string;
}

export interface AgentSessionContext {
  sessionActive: boolean;
  sessionBudgetRemaining: number;
  sessionGrants?: string[];
  cloudPermissions?: string[];
  backpackAccounts?: BackpackConnectedAccount[];
}

export interface AgentConfig {
  name: string;
  agentWallet: string;
  wallet?: AgentWallet;
  chainId?: number;
  model?: string;
  temperature?: number;
  systemPrompt?: string;
  memory?: boolean;
  plugins?: string[];
  userAddress?: string;
  workflowWallet?: string;
  sessionContext?: AgentSessionContext;
}

export interface AgentInstance {
  id: string;
  name: string;
  executor: any;
  config: AgentConfig;
  tools: any[];
}

export interface ExecutionResult {
  success: boolean;
  messages: Array<{ role: string; content: string }>;
  output?: string;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
  promptTokens?: number;
  completionTokens?: number;
  error?: string;
  executionTime: number;
}

export interface ManowarStatus {
  ready: boolean;
  framework: "manowar";
  version: "manowar";
  agentCount: number;
}

export interface ExecuteOptions {
  threadId?: string;
  userAddress?: string;
  workflowWallet?: string;
  attachment?: Record<string, unknown>;
  sessionContext?: AgentSessionContext;
  composeRunId?: string;
}

type StreamUsageTotals = {
  promptTokens: number;
  completionTokens: number;
  reasoningTokens: number;
  totalTokens: number;
};

type SessionUnlock = () => void;

interface WorkerCronJob {
  id: string;
  everyMs: number;
  message: string;
  sessionKey: string;
  timer: NodeJS.Timeout | null;
}

interface CloudAgentWorker {
  runtime: AgentInstance;
  config: AgentConfig;
  lanes: SessionLaneLock;
  runtimeId: string;
  createdAt: number;
  logsFile: string;
  cronJobs: Map<string, WorkerCronJob>;
}

export interface ManagedAgentExecutionParams {
  agentWallet: string;
  model: string;
  message: string;
  userAddress?: string;
  threadId?: string;
  sessionKey?: string;
  workflowWallet?: string;
  sessionGrants?: string[];
  cloudPermissions?: string[];
  backpackAccounts?: BackpackConnectedAccount[];
  subagentDepth?: number;
}

export interface ManagedAgentExecutionResult {
  success: boolean;
  output?: string;
  usage?: Record<string, unknown>;
  promptTokens?: number;
  completionTokens?: number;
  runtimeId: string;
  containerName: string;
  sessionKey: string;
  toolCalls: Array<{ name: string; content?: string }>;
  skillsRevision: string;
}

export interface AgentResponsesRequest extends Record<string, unknown> {}
export interface AgentResponsesResult extends Record<string, unknown> {}

const agents = new Map<string, AgentInstance>();
const workers = new Map<string, CloudAgentWorker>();
const DEFAULT_CRON_SESSION_PREFIX = "cron";
const DEFAULT_SUBAGENT_MAX_DEPTH = 3;
const DEFAULT_CLOUD_WORKER_ROOT = path.resolve(process.cwd(), "data", "cloud-agents");

class SessionLaneLock {
  private tails = new Map<string, Promise<void>>();

  async acquire(sessionKey: string): Promise<SessionUnlock> {
    const prior = this.tails.get(sessionKey) || Promise.resolve();

    let resolveCurrent: (() => void) | null = null;
    const current = new Promise<void>((resolve) => {
      resolveCurrent = resolve;
    });

    this.tails.set(sessionKey, prior.then(() => current));
    await prior;

    let released = false;
    return () => {
      if (released) return;
      released = true;
      resolveCurrent?.();
      if (this.tails.get(sessionKey) === current) {
        this.tails.delete(sessionKey);
      }
    };
  }

  async run<T>(sessionKey: string, task: () => Promise<T>): Promise<T> {
    const unlock = await this.acquire(sessionKey);
    try {
      return await task();
    } finally {
      unlock();
    }
  }
}

function createEmptyStreamUsageTotals(): StreamUsageTotals {
  return {
    promptTokens: 0,
    completionTokens: 0,
    reasoningTokens: 0,
    totalTokens: 0,
  };
}

function buildDynamicSystemContext(config: AgentConfig): string | undefined {
  const lines: string[] = [];
  const sessionContext = config.sessionContext;
  if (!sessionContext) {
    return undefined;
  }

  lines.push("Execution context:");
  lines.push(`- Session active: ${sessionContext.sessionActive ? "yes" : "no"}`);
  lines.push(`- Session budget remaining: ${sessionContext.sessionBudgetRemaining}`);
  if (shouldEnforceCloudPermissions() && sessionContext.cloudPermissions?.length) {
    lines.push(`- Backpack cloud permissions: ${sessionContext.cloudPermissions.join(", ")}`);
  }

  if (sessionContext.backpackAccounts) {
    const connectedAccounts = sessionContext.backpackAccounts.filter((account) => account.connected);
    if (connectedAccounts.length > 0) {
      lines.push("Backpack accounts currently connected for this user:");
      connectedAccounts.forEach((account) => {
        lines.push(`- ${account.slug}: ${account.name} (${account.status || "ACTIVE"})`);
      });
      lines.push("Backpack accounts are authenticated user accounts. They are distinct from MCP servers and distinct from skills.");
      lines.push("Use the backpack tools to inspect available actions and execute them through the user's connected account.");
    } else {
      lines.push("No Backpack accounts are currently connected for this user.");
    }
  }

  return lines.join("\n");
}

export function createModel(modelName: string, temperature: number = 0.7): BaseChatModel {
  return new ChatOpenAI({
    modelName,
    temperature,
    configuration: {
      baseURL: `${requireApiInternalUrl()}/v1`,
      apiKey: requireApiInternalToken(),
    },
    verbose: true,
  });
}

export async function createAgent(config: AgentConfig): Promise<AgentInstance> {
  if (!config.model) {
    throw new Error("Agent model is required - should be set from on-chain metadata");
  }

  const id = config.agentWallet;
  const composeTools = await createAgentTools(
    config.plugins || [],
    config.wallet,
    () => config.sessionContext,
    undefined,
    config.chainId,
    config.userAddress,
  );
  const model = createModel(config.model, config.temperature ?? 0.7);
  const checkpointDir = path.resolve(process.cwd(), "data", "checkpoints");
  const executor = createAgentGraph(
    model,
    composeTools,
    checkpointDir,
    config.systemPrompt,
    () => buildDynamicSystemContext(config),
  );
  const instance: AgentInstance = {
    id,
    name: config.name,
    executor,
    config,
    tools: [...composeTools],
  };
  agents.set(id, instance);
  return instance;
}

export function getAgent(id: string): AgentInstance | undefined {
  return agents.get(id);
}

export function listAgents(): AgentInstance[] {
  return Array.from(agents.values());
}

export function deleteAgent(id: string): boolean {
  return agents.delete(id);
}

export function getStatus(): ManowarStatus {
  return {
    ready: true,
    framework: "manowar",
    version: "manowar",
    agentCount: agents.size,
  };
}

function normalizeMessageContent(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }
  if (Array.isArray(content)) {
    return content
      .map((part: any) => {
        if (typeof part === "string") return part;
        if (part.type === "text") return part.text || "";
        if (part.text) return part.text;
        return JSON.stringify(part);
      })
      .join("");
  }
  if (content) {
    return JSON.stringify(content);
  }
  return "";
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

function extractTextFromStructuredOutput(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }

  if (Array.isArray(value)) {
    return value
      .map((entry) => extractTextFromStructuredOutput(entry))
      .filter((entry) => entry.length > 0)
      .join("");
  }

  const record = asRecord(value);
  if (!record) {
    return "";
  }

  if (typeof record.text === "string" && record.text.length > 0) {
    return record.text;
  }

  const nestedContent = normalizeMessageContent(record.content);
  if (nestedContent.length > 0) {
    return nestedContent;
  }

  const nestedOutput = extractTextFromStructuredOutput(record.output);
  if (nestedOutput.length > 0) {
    return nestedOutput;
  }

  return extractTextFromStructuredOutput(record.tool_outputs);
}

function resolveMessageText(message: unknown): string {
  const record = asRecord(message);
  if (!record) {
    return "";
  }

  const directContent = normalizeMessageContent(record.content);
  if (directContent.length > 0) {
    return directContent;
  }

  const additionalKwargs = asRecord(record.additional_kwargs);
  const responseMetadata = asRecord(record.response_metadata);

  return (
    extractTextFromStructuredOutput(additionalKwargs?.tool_outputs) ||
    extractTextFromStructuredOutput(responseMetadata?.output) ||
    extractTextFromStructuredOutput(additionalKwargs?.output) ||
    ""
  );
}

async function buildHumanMessage(message: string, options: ExecuteOptions): Promise<HumanMessage> {
  if (!options.attachment) {
    return new HumanMessage(message);
  }

  const attachment = options.attachment;
  const type = typeof attachment.type === "string" ? attachment.type.trim() : "";
  if (!type) {
    throw new Error("attachment.type is required");
  }

  return new HumanMessage({
    content: [
      { type: "text", text: message },
      { ...attachment, type },
    ],
  });
}

async function executeAgentCore(
  agent: AgentInstance,
  message: string,
  options: ExecuteOptions,
): Promise<ExecutionResult> {
  const agentWallet = agent.config.agentWallet;
  const threadId = options.threadId || `thread-${agentWallet}`;
  const userAddress = options.userAddress;
  const workflowWallet = options.workflowWallet;
  const start = Date.now();

  try {
    if (options.sessionContext) {
      agent.config.sessionContext = options.sessionContext;
    }

    const mem0Handler = new Mem0CallbackHandler(agentWallet, threadId, userAddress, workflowWallet, options.composeRunId);
    const usageTracker = new AgentMemoryTracker(agentWallet, threadId);
    const humanMessage = await buildHumanMessage(message, options);

    const maxRecursionLimit = Math.min(parseInt(process.env.MAX_AGENT_RECURSION_DEPTH || "100", 10), 500);
    const result = await runWithAgentExecutionContext(
      {
        composeRunId: options.composeRunId,
        threadId,
        agentWallet,
        userAddress,
        workflowWallet,
      },
      async () =>
        agent.executor.invoke(
          {
            messages: [humanMessage],
          },
          {
            configurable: {
              thread_id: threadId,
              recursionDepth: 0,
              maxRecursionDepth: maxRecursionLimit,
              startTime: Date.now(),
            },
            callbacks: [mem0Handler, usageTracker],
            recursionLimit: maxRecursionLimit,
          },
        ),
    );

    const messages = Array.isArray((result as { messages?: unknown[] }).messages)
      ? (result as { messages: any[] }).messages
      : [];
    const lastMessage = messages[messages.length - 1];
    const trackedMetrics = usageTracker.getMetrics().contextMetrics;
    const extractedTokens = resolveAuthoritativeTokens(
      result,
      trackedMetrics
        ? {
            inputTokens: trackedMetrics.inputTokens,
            outputTokens: trackedMetrics.outputTokens,
            reasoningTokens: 0,
            totalTokens: trackedMetrics.totalTokens,
          }
        : null,
    );

    return {
      success: true,
      messages: messages.map((item: any) => ({
        role: item._getType?.() || "unknown",
        content: resolveMessageText(item),
      })),
      output: resolveMessageText(lastMessage),
      usage: {
        prompt_tokens: extractedTokens.inputTokens,
        completion_tokens: extractedTokens.outputTokens,
        total_tokens: extractedTokens.totalTokens,
      },
      promptTokens: extractedTokens.inputTokens,
      completionTokens: extractedTokens.outputTokens,
      executionTime: Date.now() - start,
    };
  } catch (error) {
    return {
      success: false,
      messages: [],
      error: error instanceof Error ? error.message : String(error),
      executionTime: Date.now() - start,
    };
  }
}

async function* streamAgentCore(
  agent: AgentInstance,
  message: string,
  options: ExecuteOptions,
): AsyncGenerator<any> {
  const agentWallet = agent.config.agentWallet;
  if (options.sessionContext) {
    agent.config.sessionContext = options.sessionContext;
  }

  const threadId = options.threadId || `thread-${agentWallet}`;
  const userAddress = options.userAddress;
  const workflowWallet = options.workflowWallet;
  const mem0Handler = new Mem0CallbackHandler(agentWallet, threadId, userAddress, workflowWallet, options.composeRunId);
  const usageTracker = new AgentMemoryTracker(agentWallet, threadId);
  const humanMessage = await buildHumanMessage(message, options);

  const maxRecursionLimit = Math.min(parseInt(process.env.MAX_AGENT_RECURSION_DEPTH || "100", 10), 500);
  const usageTotals = createEmptyStreamUsageTotals();
  let thinkingActive = false;
  let lastUsageCandidate: unknown = null;

  try {
    const eventStream = await runWithAgentExecutionContext(
      {
        composeRunId: options.composeRunId,
        threadId,
        agentWallet,
        userAddress,
        workflowWallet,
      },
      async () =>
        agent.executor.streamEvents(
          {
            messages: [humanMessage],
          },
          {
            configurable: {
              thread_id: threadId,
              recursionDepth: 0,
              maxRecursionDepth: maxRecursionLimit,
              startTime: Date.now(),
            },
            callbacks: [mem0Handler, usageTracker],
            recursionLimit: maxRecursionLimit,
            version: "v2",
          },
        ),
    );

    for await (const event of eventStream) {
      if (event.event === "on_chat_model_start") {
        thinkingActive = true;
        yield {
          type: "thinking_start",
          message: "Thinking...",
        };
      } else if (event.event === "on_chat_model_stream") {
        if (thinkingActive) {
          thinkingActive = false;
          yield {
            type: "thinking_end",
          };
        }
        const chunk = event.data?.chunk;
        const content = normalizeMessageContent(chunk?.content);
        if (content) {
          yield { choices: [{ delta: { content } }] };
        }
      } else if (event.event === "on_chat_model_end") {
        if (thinkingActive) {
          thinkingActive = false;
          yield {
            type: "thinking_end",
          };
        }
        lastUsageCandidate = event.data?.output ?? event.data ?? lastUsageCandidate;
        try {
          const tokens = extractTokens(lastUsageCandidate);
          if (tokens.totalTokens > 0) {
            usageTotals.promptTokens += tokens.inputTokens;
            usageTotals.completionTokens += tokens.outputTokens;
            usageTotals.reasoningTokens += tokens.reasoningTokens;
            usageTotals.totalTokens += tokens.totalTokens;
          }
        } catch {
          // Tool-heavy streams can emit model-end events without usage metadata.
        }
      } else if (event.event === "on_tool_start") {
        const toolInput = event.data?.input;
        let paramBlock = "";
        if (toolInput && typeof toolInput === "object") {
          for (const [key, value] of Object.entries(toolInput)) {
            const serialized = typeof value === "string" ? value : JSON.stringify(value);
            paramBlock += `<${key}>${serialized}</${key}>\n`;
          }
        }
        yield {
          type: "tool_start",
          toolName: event.name,
          input: toolInput,
          content: `\n<invoke>\n${event.name}\n${paramBlock}</invoke>\n`,
        };
      } else if (event.event === "on_tool_end") {
        yield {
          type: "tool_end",
          toolName: event.name,
          output: event.data?.output,
        };
      }
    }

    if (usageTotals.totalTokens <= 0) {
      const trackedMetrics = usageTracker.getMetrics().contextMetrics;
      const authoritativeTokens = resolveAuthoritativeTokens(
        lastUsageCandidate ?? { messages: [] },
        trackedMetrics
          ? {
              inputTokens: trackedMetrics.inputTokens,
              outputTokens: trackedMetrics.outputTokens,
              reasoningTokens: 0,
              totalTokens: trackedMetrics.totalTokens,
            }
          : null,
      );
      usageTotals.promptTokens = authoritativeTokens.inputTokens;
      usageTotals.completionTokens = authoritativeTokens.outputTokens;
      usageTotals.reasoningTokens = authoritativeTokens.reasoningTokens;
      usageTotals.totalTokens = authoritativeTokens.totalTokens;
    }

    yield {
      type: "done",
      model: agent.config.model,
      usage: {
        input_tokens: usageTotals.promptTokens,
        output_tokens: usageTotals.completionTokens,
        total_tokens: usageTotals.totalTokens,
        reasoning_tokens: usageTotals.reasoningTokens,
      },
      promptTokens: usageTotals.promptTokens,
      completionTokens: usageTotals.completionTokens,
      totalTokens: usageTotals.totalTokens,
      reasoningTokens: usageTotals.reasoningTokens,
    };
  } catch (error) {
    const messageText = error instanceof Error ? error.message : String(error);
    yield {
      type: "error",
      content: `\n\n[System Error: ${messageText}]\n`,
      error: messageText,
    };
  }
}

export async function executeAgent(
  agentWallet: string,
  message: string,
  options: ExecuteOptions = {},
): Promise<ExecutionResult> {
  const agent = agents.get(agentWallet);
  if (!agent) {
    throw new Error(`Agent ${agentWallet} not found`);
  }

  const executionContext = resolveManagedExecutionContext(agentWallet, message, options);
  if (!executionContext) {
    return executeAgentCore(agent, message, options);
  }

  const { worker, sessionKey, message: runtimeMessage } = executionContext;
  const execution = await worker.lanes.run(sessionKey, async () =>
    executeAgentCore(agent, runtimeMessage, options),
  );
  writeWorkerLog(worker, execution.success ? "info" : "warn", `session=${sessionKey} success=${execution.success}`);
  return execution;
}

export async function* streamAgent(
  agentWallet: string,
  message: string,
  options: ExecuteOptions = {},
): AsyncGenerator<any> {
  const agent = agents.get(agentWallet);
  if (!agent) {
    throw new Error(`Agent ${agentWallet} not found`);
  }

  const executionContext = resolveManagedExecutionContext(agentWallet, message, options);
  if (!executionContext) {
    yield* streamAgentCore(agent, message, options);
    return;
  }

  const { worker, sessionKey, message: runtimeMessage } = executionContext;
  const unlock = await worker.lanes.acquire(sessionKey);
  try {
    yield* streamAgentCore(agent, runtimeMessage, options);
    writeWorkerLog(worker, "info", `stream completed session=${sessionKey}`);
  } finally {
    unlock();
  }
}

function ensureDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
}

function fileExists(filePath: string): boolean {
  try {
    return fs.existsSync(filePath);
  } catch {
    return false;
  }
}

function sha256Hex(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

function cloudWorkerRoot(agentWallet: string): string {
  return path.join(DEFAULT_CLOUD_WORKER_ROOT, agentWallet.toLowerCase());
}

function cloudWorkerLogPath(agentWallet: string): string {
  return path.join(cloudWorkerRoot(agentWallet), "runtime.log");
}

function writeWorkerLog(worker: CloudAgentWorker, level: "info" | "warn" | "error", message: string): void {
  ensureDir(path.dirname(worker.logsFile));
  fs.appendFileSync(worker.logsFile, `${new Date().toISOString()} [${level}] ${message}\n`, "utf8");
}

function parseSessionKey(agentWallet: string, threadId?: string, explicit?: string): string {
  if (explicit && explicit.trim().length > 0) return explicit.trim();
  if (threadId?.trim()) return `agent:${agentWallet}:session:${threadId.trim()}`;
  return `agent:${agentWallet}:session:main`;
}

type PermissionSet = Set<string>;

function normalizePermissions(sessionGrants?: string[]): PermissionSet {
  return new Set((sessionGrants || []).map((item) => item.trim().toLowerCase()).filter(Boolean));
}

function hasPermission(grants: PermissionSet, key: string): boolean {
  return grants.has("*") || grants.has(key);
}

function enforceSessionPermissions(sessionKey: string, sessionGrants?: string[]): void {
  const grants = normalizePermissions(sessionGrants);
  const requiredByPrefix = [
    { prefix: "cron:", permission: "runtime.cron" },
    { prefix: "subagent:", permission: "runtime.subagent" },
    { prefix: "agent:", permission: "runtime.main" },
  ];
  for (const { prefix, permission } of requiredByPrefix) {
    if (sessionKey.includes(prefix) && !hasPermission(grants, permission)) {
      throw new Error(`Permission denied for ${permission}`);
    }
  }
}

function resolveManagedExecutionContext(
  agentWallet: string,
  message: string,
  options: ExecuteOptions,
): { worker: CloudAgentWorker; sessionKey: string; message: string } | null {
  const worker = workers.get(agentWallet);
  if (!worker) {
    return null;
  }

  const sessionKey = parseSessionKey(agentWallet, options.threadId);
  enforceSessionPermissions(sessionKey, options.sessionContext?.sessionGrants);

  return {
    worker,
    sessionKey,
    message,
  };
}

function toExecutionOptions(params: ManagedAgentExecutionParams): ExecuteOptions {
  return {
    threadId: params.threadId,
    userAddress: params.userAddress,
    workflowWallet: params.workflowWallet,
    sessionContext: {
      sessionActive: true,
      sessionBudgetRemaining: Number.MAX_SAFE_INTEGER,
      sessionGrants: params.sessionGrants,
      cloudPermissions: params.cloudPermissions,
      backpackAccounts: params.backpackAccounts,
    },
  };
}

function ensureWorker(agentWallet: string): CloudAgentWorker {
  const worker = workers.get(agentWallet);
  if (!worker) {
    throw new Error(`Managed agent worker not found for ${agentWallet}`);
  }
  return worker;
}

function stopCronJobs(worker: CloudAgentWorker): void {
  for (const job of worker.cronJobs.values()) {
    if (job.timer) {
      clearInterval(job.timer);
      job.timer = null;
    }
  }
  worker.cronJobs.clear();
}

function parseSubagentDepth(sessionKey: string): number {
  const match = sessionKey.match(/subagent:depth:(\d+)/i);
  if (!match) return 0;
  const value = Number(match[1]);
  return Number.isFinite(value) ? value : 0;
}

export async function createManagedAgent(config: AgentConfig): Promise<AgentInstance> {
  const existing = workers.get(config.agentWallet);
  if (existing) {
    return existing.runtime;
  }

  const runtime = await createAgent(config);
  const logsFile = cloudWorkerLogPath(config.agentWallet);
  ensureDir(path.dirname(logsFile));
  if (!fileExists(logsFile)) {
    fs.writeFileSync(logsFile, "", "utf8");
  }

  const worker: CloudAgentWorker = {
    runtime,
    config,
    lanes: new SessionLaneLock(),
    runtimeId: `compose-cloud-agent-${config.agentWallet}-${Date.now()}`,
    createdAt: Date.now(),
    logsFile,
    cronJobs: new Map(),
  };

  workers.set(config.agentWallet, worker);
  writeWorkerLog(worker, "info", `cloud worker started runtimeId=${worker.runtimeId}`);
  return runtime;
}

export function scheduleManagedAgentCron(input: {
  agentWallet: string;
  id: string;
  everyMs: number;
  message: string;
}): void {
  const worker = ensureWorker(input.agentWallet);
  const everyMs = Math.max(1_000, input.everyMs);
  const sessionKey = `${DEFAULT_CRON_SESSION_PREFIX}:${input.id}`;
  const existing = worker.cronJobs.get(input.id);
  if (existing?.timer) {
    clearInterval(existing.timer);
  }

  const job: WorkerCronJob = {
    id: input.id,
    everyMs,
    message: input.message,
    sessionKey,
    timer: setInterval(() => {
      void executeManagedAgent({
        agentWallet: input.agentWallet,
        model: worker.config.model || "",
        message: input.message,
        sessionKey,
        userAddress: worker.config.userAddress,
        workflowWallet: worker.config.workflowWallet,
        sessionGrants: ["runtime.cron", "runtime.main"],
      }).catch((error) => {
        writeWorkerLog(worker, "warn", `cron ${input.id} failed: ${error instanceof Error ? error.message : String(error)}`);
      });
    }, everyMs),
  };

  worker.cronJobs.set(input.id, job);
  writeWorkerLog(worker, "info", `cron scheduled id=${input.id} everyMs=${everyMs}`);
}

export function unscheduleManagedAgentCron(agentWallet: string, jobId: string): void {
  const worker = ensureWorker(agentWallet);
  const job = worker.cronJobs.get(jobId);
  if (!job) {
    return;
  }
  if (job.timer) {
    clearInterval(job.timer);
  }
  worker.cronJobs.delete(jobId);
  writeWorkerLog(worker, "info", `cron unscheduled id=${jobId}`);
}

export async function executeManagedAgent(params: ManagedAgentExecutionParams): Promise<ManagedAgentExecutionResult> {
  const worker = ensureWorker(params.agentWallet);
  const sessionKey = parseSessionKey(params.agentWallet, params.threadId, params.sessionKey);
  const subDepth = sessionKey.includes("subagent") ? parseSubagentDepth(sessionKey) : (params.subagentDepth || 0);
  if (subDepth > DEFAULT_SUBAGENT_MAX_DEPTH) {
    throw new Error(`Subagent depth exceeded (${subDepth} > ${DEFAULT_SUBAGENT_MAX_DEPTH})`);
  }

  enforceSessionPermissions(sessionKey, params.sessionGrants);
  const execution = await worker.lanes.run(sessionKey, async () =>
    executeAgentCore(worker.runtime, params.message, toExecutionOptions(params)),
  );

  writeWorkerLog(worker, execution.success ? "info" : "warn", `managed session=${sessionKey} success=${execution.success}`);
  return {
    success: execution.success,
    output: execution.output,
    usage: execution.usage,
    promptTokens: execution.promptTokens,
    completionTokens: execution.completionTokens,
    runtimeId: worker.runtimeId,
    containerName: worker.runtime.id,
    sessionKey,
    toolCalls: execution.messages
      .filter((messageItem) => messageItem.role === "tool")
      .map((messageItem, idx) => ({
        name: `tool-${idx + 1}`,
        content: messageItem.content,
      })),
    skillsRevision: "cloud-managed",
  };
}

export async function* streamManagedAgent(params: ManagedAgentExecutionParams): AsyncGenerator<unknown> {
  const worker = ensureWorker(params.agentWallet);
  const sessionKey = parseSessionKey(params.agentWallet, params.threadId, params.sessionKey);
  const subDepth = sessionKey.includes("subagent") ? parseSubagentDepth(sessionKey) : (params.subagentDepth || 0);
  if (subDepth > DEFAULT_SUBAGENT_MAX_DEPTH) {
    throw new Error(`Subagent depth exceeded (${subDepth} > ${DEFAULT_SUBAGENT_MAX_DEPTH})`);
  }

  enforceSessionPermissions(sessionKey, params.sessionGrants);
  const unlock = await worker.lanes.acquire(sessionKey);
  try {
    yield* streamAgentCore(worker.runtime, params.message, toExecutionOptions(params));
    writeWorkerLog(worker, "info", `managed stream completed session=${sessionKey}`);
  } finally {
    unlock();
  }
}

export async function executeManagedSubagent(input: {
  agentWallet: string;
  model: string;
  message: string;
  parentSessionKey: string;
  subagentId: string;
  depth: number;
  sessionGrants?: string[];
  cloudPermissions?: string[];
}): Promise<ManagedAgentExecutionResult> {
  if (input.depth > DEFAULT_SUBAGENT_MAX_DEPTH) {
    throw new Error(`Subagent depth exceeded (${input.depth} > ${DEFAULT_SUBAGENT_MAX_DEPTH})`);
  }

  return executeManagedAgent({
    agentWallet: input.agentWallet,
    model: input.model,
    message: input.message,
    sessionKey: `subagent:${input.subagentId}:depth:${input.depth}:parent:${input.parentSessionKey}`,
    sessionGrants: [...(input.sessionGrants || []), "runtime.subagent", "runtime.main"],
    cloudPermissions: input.cloudPermissions,
  });
}

export function getManagedAgentStatus(agentWallet: string): {
  running: boolean;
  runtimeId?: string;
  createdAt?: number;
  cronJobs?: string[];
} {
  const worker = workers.get(agentWallet);
  if (!worker) {
    return { running: false };
  }

  return {
    running: true,
    runtimeId: worker.runtimeId,
    createdAt: worker.createdAt,
    cronJobs: [...worker.cronJobs.keys()],
  };
}

export function stopManagedAgent(agentWallet: string): void {
  const worker = workers.get(agentWallet);
  if (!worker) {
    return;
  }

  stopCronJobs(worker);
  writeWorkerLog(worker, "info", "cloud worker stopped");
  workers.delete(agentWallet);
}

export function getManagedAgentLogs(agentWallet: string, maxLines: number = 200): string[] {
  const worker = workers.get(agentWallet);
  const logsPath = worker?.logsFile || cloudWorkerLogPath(agentWallet);
  if (!fileExists(logsPath)) {
    return [];
  }

  const lines = fs.readFileSync(logsPath, "utf8").split(/\r?\n/).filter(Boolean);
  return lines.length <= maxLines ? lines : lines.slice(lines.length - maxLines);
}

function buildResponsesRequestBody(model: string, request: AgentResponsesRequest): AgentResponsesRequest {
  if (typeof request.model === "string" && request.model.trim().length > 0) {
    throw new Error("responses request must not override the fixed agent model");
  }
  if (typeof request.provider === "string" && request.provider.trim().length > 0) {
    throw new Error("responses request must not override provider resolution");
  }
  return { ...request, model };
}

function extractApiErrorMessage(status: number, body: unknown): string {
  if (body && typeof body === "object") {
    const record = body as Record<string, unknown>;
    if (typeof record.error === "string") return record.error;
    if (
      record.error &&
      typeof record.error === "object" &&
      typeof (record.error as Record<string, unknown>).message === "string"
    ) {
      return (record.error as Record<string, unknown>).message as string;
    }
  }
  return `responses request failed: ${status}`;
}

export async function executeResponses(
  model: string,
  request: AgentResponsesRequest,
): Promise<AgentResponsesResult> {
  const response = await fetch(`${requireApiInternalUrl()}/v1/responses`, {
    method: "POST",
    headers: buildApiInternalHeaders({
      "Content-Type": "application/json",
    }),
    body: JSON.stringify(buildResponsesRequestBody(model, request)),
  });

  const body = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(extractApiErrorMessage(response.status, body));
  }
  if (!body || typeof body !== "object") {
    throw new Error("responses request returned an invalid payload");
  }
  return body as AgentResponsesResult;
}
