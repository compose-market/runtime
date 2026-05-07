/**
 * Agent Tool Factories
 * 
 * Creates LangChain tools from Manowar agents.
 */

import { DynamicStructuredTool } from "@langchain/core/tools";
import { z } from "zod";
import type { AgentWallet } from "../../agent-wallet.js";
import { getAgentExecutionContext } from "./context.js";
import { resolveMemoryScope } from "./memory-scope.js";
import { searchKnowledge } from "../knowledge/index.js";
import { persistExplicitAgentMemory } from "./memory.js";
import { searchMemoryLayers } from "../memory/index.js";
import { shouldEnforceCloudPermissions } from "../mode.js";
import { executeGoatTool, getPlugin } from "../../connectors/index.js";
import { executeServerTool, getServerTools } from "../../connectors/index.js";
import { normalizeConnectorBinding } from "../../connectors/index.js";
import {
    buildApiInternalHeaders,
    requireApiInternalUrl,
} from "../../auth.js";

interface ToolExecutionContext {
    getComposeRunId?: () => string | undefined;
    getThreadId?: () => string | undefined;
}

type CloudPermissionKey =
    | "filesystem"
    | "camera"
    | "microphone"
    | "geolocation"
    | "clipboard"
    | "notifications";

type BackpackConnectedAccount = {
    slug: string;
    name: string;
    connected: boolean;
    accountId?: string;
    status?: string;
};
type AgentSessionContext = {
    sessionActive: boolean;
    sessionBudgetRemaining: number;
    sessionGrants?: string[];
    cloudPermissions?: string[];
    backpackAccounts?: BackpackConnectedAccount[];
};
type SessionContextProvider = AgentSessionContext | (() => AgentSessionContext | undefined) | undefined;

const RETRYABLE_STATUSES = new Set([429, 500, 502, 503, 504]);
const TOOL_RETRY_MAX_ATTEMPTS = 3;
const TOOL_RETRY_INITIAL_MS = 300;
const TOOL_RETRY_MAX_MS = 2000;
const DEFAULT_TOOL_RESULT_MAX_CHARS = 1_800;
const DEFAULT_TOOL_RESULT_ARRAY_ITEMS = 3;
const DEFAULT_TOOL_RESULT_OBJECT_KEYS = 12;
const DEFAULT_TOOL_RESULT_STRING_CHARS = 240;
const DEFAULT_TOOL_RESULT_MAX_DEPTH = 5;

type ToolResultBudget = {
    maxChars: number;
    arrayItems: number;
    objectKeys: number;
    stringChars: number;
    maxDepth: number;
};

function readPositiveIntegerEnv(name: string, fallback: number): number {
    const value = Number.parseInt(process.env[name] || "", 10);
    return Number.isFinite(value) && value > 0 ? value : fallback;
}

function resolveToolResultBudget(overrides: Partial<ToolResultBudget> = {}): ToolResultBudget {
    return {
        maxChars: overrides.maxChars ?? readPositiveIntegerEnv("AGENT_TOOL_RESULT_MAX_CHARS", DEFAULT_TOOL_RESULT_MAX_CHARS),
        arrayItems: overrides.arrayItems ?? readPositiveIntegerEnv("AGENT_TOOL_RESULT_ARRAY_ITEMS", DEFAULT_TOOL_RESULT_ARRAY_ITEMS),
        objectKeys: overrides.objectKeys ?? readPositiveIntegerEnv("AGENT_TOOL_RESULT_OBJECT_KEYS", DEFAULT_TOOL_RESULT_OBJECT_KEYS),
        stringChars: overrides.stringChars ?? readPositiveIntegerEnv("AGENT_TOOL_RESULT_STRING_CHARS", DEFAULT_TOOL_RESULT_STRING_CHARS),
        maxDepth: overrides.maxDepth ?? readPositiveIntegerEnv("AGENT_TOOL_RESULT_MAX_DEPTH", DEFAULT_TOOL_RESULT_MAX_DEPTH),
    };
}

function safeJsonStringify(value: unknown): string {
    const seen = new WeakSet<object>();
    return JSON.stringify(value, (_key, nested) => {
        if (typeof nested === "bigint") {
            return nested.toString();
        }
        if (nested instanceof Error) {
            return {
                name: nested.name,
                message: nested.message,
            };
        }
        if (nested && typeof nested === "object") {
            if (seen.has(nested)) {
                return "[Circular]";
            }
            seen.add(nested);
        }
        return nested;
    });
}

function truncateText(value: string, maxChars: number): string {
    if (value.length <= maxChars) {
        return value;
    }
    return `${value.slice(0, Math.max(0, maxChars))}... [truncated ${value.length - maxChars} chars]`;
}

function compactToolResultValue(
    value: unknown,
    budget: ToolResultBudget,
    depth = 0,
    seen = new WeakSet<object>(),
): unknown {
    if (value === null || value === undefined) {
        return value ?? null;
    }
    if (typeof value === "string") {
        return truncateText(value, budget.stringChars);
    }
    if (typeof value === "bigint") {
        return value.toString();
    }
    if (typeof value !== "object") {
        return value;
    }
    if (value instanceof Error) {
        return {
            name: value.name,
            message: truncateText(value.message, budget.stringChars),
        };
    }
    if (seen.has(value)) {
        return "[Circular]";
    }
    seen.add(value);

    if (depth >= budget.maxDepth) {
        return Array.isArray(value)
            ? `[Array(${value.length})]`
            : "[Object]";
    }

    if (Array.isArray(value)) {
        const visible = value
            .slice(0, budget.arrayItems)
            .map((item) => compactToolResultValue(item, budget, depth + 1, seen));
        if (value.length > budget.arrayItems) {
            visible.push({
                __compose_truncated: {
                    omittedItems: value.length - budget.arrayItems,
                    totalItems: value.length,
                },
            });
        }
        return visible;
    }

    const record = value as Record<string, unknown>;
    const keys = Object.keys(record);
    const output: Record<string, unknown> = {};
    for (const key of keys.slice(0, budget.objectKeys)) {
        output[key] = compactToolResultValue(record[key], budget, depth + 1, seen);
    }
    if (keys.length > budget.objectKeys) {
        output.__compose_truncated = {
            omittedKeys: keys.length - budget.objectKeys,
            totalKeys: keys.length,
        };
    }
    return output;
}

function tightenToolResultBudget(budget: ToolResultBudget): ToolResultBudget {
    return {
        maxChars: budget.maxChars,
        arrayItems: budget.arrayItems,
        objectKeys: Math.max(6, Math.floor(budget.objectKeys / 2)),
        stringChars: Math.max(120, Math.floor(budget.stringChars / 2)),
        maxDepth: Math.max(3, budget.maxDepth - 1),
    };
}

function compactPrimaryCollection(value: unknown, budget: ToolResultBudget): unknown | undefined {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        return undefined;
    }

    const record = value as Record<string, unknown>;
    const entries = Object.entries(record);
    const primary = entries.find(([, entryValue]) => Array.isArray(entryValue) && entryValue.length > 0);
    if (!primary) {
        return undefined;
    }

    const [primaryKey, primaryValue] = primary;
    const focusedBudget: ToolResultBudget = {
        ...budget,
        objectKeys: Math.max(8, Math.floor(budget.objectKeys / 2)),
        stringChars: Math.max(120, Math.floor(budget.stringChars / 2)),
        maxDepth: Math.max(4, budget.maxDepth - 1),
    };

    return {
        [primaryKey]: compactToolResultValue(primaryValue, focusedBudget),
        __compose_truncated: {
            strategy: "primary_collection",
            omittedTopLevelKeys: entries.length - 1,
            totalTopLevelKeys: entries.length,
        },
    };
}

export function formatToolResultForAgent(
    value: unknown,
    overrides: Partial<ToolResultBudget> = {},
): string {
    const budget = resolveToolResultBudget(overrides);

    if (typeof value === "string") {
        if (value.length <= budget.maxChars) {
            return value;
        }
        return safeJsonStringify({
            __compose_tool_result: "truncated_text",
            originalChars: value.length,
            text: truncateText(value, Math.max(0, budget.maxChars - 220)),
        });
    }

    const raw = safeJsonStringify(value);
    if (raw.length <= budget.maxChars) {
        return raw;
    }

    const compactValue = compactToolResultValue(value, budget);
    const compact = safeJsonStringify({
        __compose_tool_result: "compacted_json",
        originalChars: raw.length,
        value: compactValue,
    });
    if (compact.length <= budget.maxChars) {
        return compact;
    }

    const tightBudget = tightenToolResultBudget(budget);
    const tighter = safeJsonStringify({
        __compose_tool_result: "compacted_json",
        originalChars: raw.length,
        value: compactToolResultValue(value, tightBudget),
    });
    if (tighter.length <= budget.maxChars) {
        return tighter;
    }

    const primaryCollection = compactPrimaryCollection(value, tightBudget);
    if (primaryCollection) {
        const focused = safeJsonStringify({
            __compose_tool_result: "compacted_json",
            originalChars: raw.length,
            value: primaryCollection,
        });
        if (focused.length <= budget.maxChars) {
            return focused;
        }
    }

    const minimalBudget = {
        ...tightBudget,
        arrayItems: 1,
        objectKeys: 6,
        stringChars: 120,
        maxDepth: 3,
    };
    const minimal = safeJsonStringify({
        __compose_tool_result: "compacted_json",
        originalChars: raw.length,
        value: compactToolResultValue(value, minimalBudget),
    });
    if (minimal.length <= budget.maxChars) {
        return minimal;
    }

    return safeJsonStringify({
        __compose_tool_result: "truncated_json",
        originalChars: raw.length,
        preview: truncateText(minimal, Math.max(0, budget.maxChars - 240)),
    });
}

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function computeBackoffDelayMs(attempt: number): number {
    const exponential = Math.min(
        TOOL_RETRY_MAX_MS,
        TOOL_RETRY_INITIAL_MS * Math.pow(2, Math.max(0, attempt - 1)),
    );
    const jitter = Math.floor(Math.random() * 200);
    return exponential + jitter;
}

async function fetchWithRetry(url: string, init: RequestInit): Promise<Response> {
    let lastError: unknown;

    for (let attempt = 1; attempt <= TOOL_RETRY_MAX_ATTEMPTS; attempt += 1) {
        try {
            const response = await fetch(url, init);
            if (!RETRYABLE_STATUSES.has(response.status) || attempt === TOOL_RETRY_MAX_ATTEMPTS) {
                return response;
            }
        } catch (error) {
            lastError = error;
            if (attempt === TOOL_RETRY_MAX_ATTEMPTS) {
                throw error;
            }
        }
        await sleep(computeBackoffDelayMs(attempt));
    }

    throw (lastError instanceof Error ? lastError : new Error("Tool request failed after retries"));
}

function resolveSessionContext(input: SessionContextProvider): AgentSessionContext | undefined {
    if (typeof input === "function") {
        return input();
    }
    return input;
}

export function createKnowledgeTools(input: {
    agentWallet?: Pick<AgentWallet, "address">;
    userAddress?: string;
}): DynamicStructuredTool[] {
    if (!input.agentWallet) {
        return [];
    }

    return [
        new DynamicStructuredTool({
            name: "search_knowledge",
            description: "Search the agent identity knowledge from the creator and, when a user is present, the private workspace knowledge for this specific user-agent pair. This does not inject documents by default; use it only when you need reference material.",
            schema: z.object({
                query: z.string().min(1).describe("Knowledge question or retrieval query"),
                scope: z.enum(["genesis", "workspace", "all"]).optional().describe("Limit search to creator-baked genesis knowledge, private workspace knowledge, or both"),
                limit: z.number().int().min(1).max(8).optional().describe("Maximum number of knowledge hits to return"),
            }),
            func: async ({ query, scope, limit }: {
                query: string;
                scope?: "genesis" | "workspace" | "all";
                limit?: number;
            }) => {
                const results = await searchKnowledge({
                    agentWallet: input.agentWallet!.address,
                    userAddress: input.userAddress,
                    query,
                    scope,
                    limit,
                });
                if (results.length === 0) {
                    return "No relevant knowledge found.";
                }

                return results
                    .map((item) => `[Knowledge ${item.scope} | score=${item.score.toFixed(2)}]\n${item.content}`)
                    .join("\n\n");
            },
        }),
    ];
}

// =============================================================================
// Failed Tool Tracking
// =============================================================================

interface FailedTool {
    failures: number;
    lastFailure: Date;
    reason: string;
}

// Cache of tools that have failed - prevents LLM from repeatedly trying broken tools
const failedTools = new Map<string, FailedTool>();
const TOOL_FAILURE_TTL_MS = 5 * 60 * 1000; // 5 minutes
const MAX_TOOL_FAILURES = 2;

function markToolFailed(toolKey: string, reason: string): void {
    const existing = failedTools.get(toolKey);
    const now = new Date();

    if (existing && (now.getTime() - existing.lastFailure.getTime() < TOOL_FAILURE_TTL_MS)) {
        failedTools.set(toolKey, { failures: existing.failures + 1, lastFailure: now, reason });
    } else {
        failedTools.set(toolKey, { failures: 1, lastFailure: now, reason });
    }
}

function isToolFailed(toolKey: string): { failed: boolean; reason?: string } {
    const entry = failedTools.get(toolKey);
    if (!entry) return { failed: false };

    // Clear stale entries
    if (Date.now() - entry.lastFailure.getTime() > TOOL_FAILURE_TTL_MS) {
        failedTools.delete(toolKey);
        return { failed: false };
    }

    if (entry.failures >= MAX_TOOL_FAILURES) {
        return { failed: true, reason: entry.reason };
    }
    return { failed: false };
}

function clearToolFailure(toolKey: string): void {
    if (failedTools.has(toolKey)) {
        failedTools.delete(toolKey);
    }
}

function normalizeGrantedPermissions(values: string[] | undefined): Set<string> {
    return new Set((values || []).map((value) => value.trim().toLowerCase()).filter(Boolean));
}

function isCloudPermissionKey(value: string): value is CloudPermissionKey {
    return value === "filesystem"
        || value === "camera"
        || value === "microphone"
        || value === "geolocation"
        || value === "clipboard"
        || value === "notifications";
}

function resolveToolPermissions(toolName: string, toolDescription?: string): CloudPermissionKey[] {
    const inferredConsent = inferConsentFromToolSemantics(toolName, toolDescription);
    if (inferredConsent && isCloudPermissionKey(inferredConsent)) {
        return [inferredConsent];
    }

    return [];
}

function buildConsentRequiredError(permission: CloudPermissionKey): Error {
    return new Error(JSON.stringify({
        code: "CONSENT_REQUIRED",
        consentType: permission,
        message: `Permission denied for ${permission} access. This feature requires your consent.`,
    }));
}

async function fetchBackpackPermissions(userAddress: string): Promise<CloudPermissionKey[]> {
    const response = await fetchWithRetry(
        `${requireApiInternalUrl()}/api/backpack/permissions?userAddress=${encodeURIComponent(userAddress)}`,
        {
            headers: buildApiInternalHeaders(),
        },
    );

    if (!response.ok) {
        throw new Error(`Failed to load Backpack permissions (${response.status})`);
    }

    const payload = await response.json() as {
        permissions?: Array<{ consentType?: string; granted?: boolean }>;
    };

    if (!Array.isArray(payload.permissions)) {
        return [];
    }

    return payload.permissions
        .filter((permission) => permission.granted && typeof permission.consentType === "string" && isCloudPermissionKey(permission.consentType))
        .map((permission) => permission.consentType as CloudPermissionKey);
}

async function enforceToolPermissions(input: {
    toolName: string;
    toolDescription?: string;
    cloudPermissions?: string[];
    userAddress?: string;
}): Promise<void> {
    if (!shouldEnforceCloudPermissions()) {
        return;
    }

    const required = resolveToolPermissions(input.toolName, input.toolDescription);
    if (required.length === 0) {
        return;
    }

    const availablePermissions = input.cloudPermissions || (input.userAddress ? await fetchBackpackPermissions(input.userAddress) : []);
    const grants = normalizeGrantedPermissions(availablePermissions);

    for (const permission of required) {
        if (!grants.has(permission)) {
            throw buildConsentRequiredError(permission);
        }
    }
}

function isRetryableToolFailure(status: number, errorText: string): boolean {
    const normalized = errorText.toLowerCase();
    if (
        normalized.includes("credentials required") ||
        normalized.includes("mcp credentials required") ||
        normalized.includes("consent required")
    ) {
        return false;
    }
    if (RETRYABLE_STATUSES.has(status)) {
        return true;
    }
    return (
        normalized.includes("temporarily unavailable") ||
        normalized.includes("timeout") ||
        normalized.includes("network") ||
        normalized.includes("spawn")
    );
}

// =============================================================================
// Dynamic Consent Detection
// =============================================================================

function inferConsentFromError(errorText: string): string | null {
    const lowerError = errorText.toLowerCase();

    if (lowerError.includes("eacces") ||
        lowerError.includes("permission denied") ||
        lowerError.includes("file") && (lowerError.includes("access") || lowerError.includes("read") || lowerError.includes("write")) ||
        lowerError.includes("directory") ||
        lowerError.includes("filesystem")) {
        return "filesystem";
    }

    if (lowerError.includes("camera") ||
        lowerError.includes("video") && lowerError.includes("capture") ||
        lowerError.includes("notreadableerror") && lowerError.includes("video")) {
        return "camera";
    }

    if (lowerError.includes("microphone") ||
        lowerError.includes("audio") && lowerError.includes("recording") ||
        lowerError.includes("notreadableerror") && lowerError.includes("audio")) {
        return "microphone";
    }

    if (lowerError.includes("geolocation") ||
        lowerError.includes("location") && lowerError.includes("denied") ||
        lowerError.includes("gps")) {
        return "geolocation";
    }

    if (lowerError.includes("clipboard") && lowerError.includes("denied")) {
        return "clipboard";
    }

    return null;
}

function inferConsentFromToolSemantics(toolName: string, toolDescription?: string): string | null {
    const text = `${toolName} ${toolDescription || ""}`.toLowerCase();

    if (text.includes("file") || text.includes("directory") || text.includes("folder") || text.includes("read_") || text.includes("write_") || text.includes("list_dir")) {
        return "filesystem";
    }
    if (text.includes("camera") || text.includes("photo") || text.includes("video") && text.includes("capture")) {
        return "camera";
    }
    if (text.includes("microphone") || text.includes("record") && text.includes("audio") || text.includes("voice")) {
        return "microphone";
    }
    if (text.includes("location") || text.includes("gps") || text.includes("coordinates")) {
        return "geolocation";
    }
    if (text.includes("clipboard") && (text.includes("paste") || text.includes("copy"))) {
        return "clipboard";
    }
    if (text.includes("notification") || text.includes("notify") || text.includes("alert")) {
        return "notifications";
    }

    return null;
}


// =============================================================================
// Helper: Schema Conversion
// =============================================================================

function asPlainRecord(value: unknown): Record<string, unknown> | null {
    return value && typeof value === "object" && !Array.isArray(value)
        ? value as Record<string, unknown>
        : null;
}

function requiredFieldNames(schema: Record<string, unknown>): Set<string> {
    return new Set(Array.isArray(schema.required)
        ? schema.required.filter((value): value is string => typeof value === "string")
        : []);
}

function withSchemaDescription(schema: z.ZodTypeAny, description: unknown, fallback: string): z.ZodTypeAny {
    const text = compactSchemaDescription(description) || fallback;
    return text ? schema.describe(text) : schema;
}

function zodUnion(types: z.ZodTypeAny[]): z.ZodTypeAny {
    const usable = types.filter(Boolean);
    if (usable.length === 0) {
        return z.any();
    }
    if (usable.length === 1) {
        return usable[0];
    }
    return z.union(usable as [z.ZodTypeAny, z.ZodTypeAny, ...z.ZodTypeAny[]]);
}

function literalSchema(value: unknown): z.ZodTypeAny {
    if (value === null) {
        return z.null();
    }
    const valueType = typeof value;
    if (valueType === "string" || valueType === "number" || valueType === "boolean") {
        return z.literal(value as never);
    }
    return z.any();
}

function literalUnion(values: unknown[]): z.ZodTypeAny {
    return zodUnion(values.map(literalSchema));
}

function createZodTypeFromJsonSchema(rawSchema: unknown, fallbackName: string): z.ZodTypeAny {
    const schema = asPlainRecord(rawSchema);
    if (!schema) {
        return z.any();
    }

    if (Array.isArray(schema.enum) && schema.enum.length > 0) {
        return withSchemaDescription(literalUnion(schema.enum), schema.description, fallbackName);
    }

    if (Object.prototype.hasOwnProperty.call(schema, "const")) {
        return withSchemaDescription(literalSchema(schema.const), schema.description, fallbackName);
    }

    if (Array.isArray(schema.anyOf) && schema.anyOf.length > 0) {
        const variants = schema.anyOf.map((entry, index) => createZodTypeFromJsonSchema(entry, `${fallbackName} option ${index + 1}`));
        return withSchemaDescription(zodUnion(variants), schema.description, fallbackName);
    }

    if (Array.isArray(schema.oneOf) && schema.oneOf.length > 0) {
        const variants = schema.oneOf.map((entry, index) => createZodTypeFromJsonSchema(entry, `${fallbackName} option ${index + 1}`));
        return withSchemaDescription(zodUnion(variants), schema.description, fallbackName);
    }

    if (Array.isArray(schema.type)) {
        const variants = schema.type.map((typeName) => createZodTypeFromJsonSchema({ ...schema, type: typeName }, fallbackName));
        return withSchemaDescription(zodUnion(variants), schema.description, fallbackName);
    }

    let zodType: z.ZodTypeAny;
    switch (schema.type) {
        case "string":
            zodType = z.string();
            if (typeof schema.minLength === "number") {
                zodType = (zodType as z.ZodString).min(schema.minLength);
            }
            if (typeof schema.maxLength === "number") {
                zodType = (zodType as z.ZodString).max(schema.maxLength);
            }
            break;
        case "number":
            zodType = z.number();
            if (typeof schema.minimum === "number") {
                zodType = (zodType as z.ZodNumber).min(schema.minimum);
            }
            if (typeof schema.maximum === "number") {
                zodType = (zodType as z.ZodNumber).max(schema.maximum);
            }
            break;
        case "integer":
            zodType = z.number().int();
            if (typeof schema.minimum === "number") {
                zodType = (zodType as z.ZodNumber).min(schema.minimum);
            }
            if (typeof schema.maximum === "number") {
                zodType = (zodType as z.ZodNumber).max(schema.maximum);
            }
            break;
        case "boolean":
            zodType = z.boolean();
            break;
        case "null":
            zodType = z.null();
            break;
        case "array": {
            const itemSchema = createZodTypeFromJsonSchema(schema.items, `${fallbackName} item`);
            zodType = z.array(itemSchema);
            if (typeof schema.minItems === "number") {
                zodType = (zodType as z.ZodArray<z.ZodTypeAny>).min(schema.minItems);
            }
            if (typeof schema.maxItems === "number") {
                zodType = (zodType as z.ZodArray<z.ZodTypeAny>).max(schema.maxItems);
            }
            break;
        }
        case "object":
        default: {
            const properties = asPlainRecord(schema.properties);
            if (!properties) {
                zodType = schema.type === "object" ? z.object({}).passthrough() : z.any();
                break;
            }

            const required = requiredFieldNames(schema);
            const shape: Record<string, z.ZodTypeAny> = {};
            for (const [key, propertySchema] of Object.entries(properties)) {
                let propertyType = createZodTypeFromJsonSchema(propertySchema, key);
                if (!required.has(key)) {
                    propertyType = propertyType.optional();
                }
                shape[key] = propertyType;
            }
            const objectType = z.object(shape);
            zodType = schema.additionalProperties === false ? objectType.strict() : objectType.passthrough();
            break;
        }
    }

    return withSchemaDescription(zodType, schema.description, fallbackName);
}

function createZodSchema(jsonSchema: Record<string, unknown>): z.ZodObject<any> {
    const schema = createZodTypeFromJsonSchema(jsonSchema, "input");
    return schema instanceof z.ZodObject ? schema : z.object({});
}

function compactSchemaDescription(value: unknown): string | undefined {
    return typeof value === "string" && value.trim().length > 0
        ? value.trim().replace(/\s+/g, " ")
        : undefined;
}

function buildToolDescription(name: string, description: string | undefined, jsonSchema: Record<string, unknown> | undefined): string {
    void jsonSchema;
    return compactSchemaDescription(description) || `Execute ${name}`;
}

function sanitizeToolName(name: string): string {
    const sanitized = name.replace(/[^a-zA-Z0-9_]/g, "_");
    return sanitized.length > 0 ? sanitized : "tool";
}

function reserveToolName(baseName: string, usedNames: Set<string>): string {
    const candidate = sanitizeToolName(baseName);
    if (!usedNames.has(candidate)) {
        usedNames.add(candidate);
        return candidate;
    }

    let suffix = 2;
    while (usedNames.has(`${candidate}_${suffix}`)) {
        suffix += 1;
    }
    const unique = `${candidate}_${suffix}`;
    usedNames.add(unique);
    return unique;
}

// =============================================================================
// Tool Creation from MCP Service
// =============================================================================

/**
 * Create tools for agent from plugin IDs by calling MCP service
 * 
 * @param pluginIds Plugin IDs to load (e.g. ["goat:coingecko", "mcp:github"])
 * @param agentWallet Agent wallet context
 * @param sessionContext Session context for payment headers
 * @param executionContext Optional run context for correlation headers
 * @returns Array of LangChain DynamicStructuredTool instances
 */
export async function createAgentTools(
    pluginIds: string[],
    agentWallet?: AgentWallet,
    sessionContext?: SessionContextProvider,
    executionContext?: ToolExecutionContext,
    chainId?: number,
    userAddress?: string,
): Promise<DynamicStructuredTool[]> {
    const tools: DynamicStructuredTool[] = [];
    const usedToolNames = new Set<string>();

    for (const tool of createKnowledgeTools({ agentWallet, userAddress })) {
        tools.push(tool);
        usedToolNames.add(tool.name);
    }

    if (userAddress) {
        for (const tool of createBackpackTools({ userAddress, sessionContext, executionContext })) {
            tools.push(tool);
            usedToolNames.add(tool.name);
        }
    }

    if (!pluginIds || pluginIds.length === 0) {
        appendHarnessTools(tools, usedToolNames, agentWallet?.address, userAddress);
        return tools;
    }

    for (const pluginId of pluginIds) {
        try {
            const binding = normalizeConnectorBinding(pluginId, { defaultOrigin: "onchain" });
            const source = binding.origin;
            const id = binding.slug;

            console.log(`[createAgentTools] Normalized "${pluginId}" → source="${source}", id="${id}"`);

            if (source === "onchain") {
                const pluginData = await getPlugin(id);
                if (!pluginData) {
                    console.warn(`[createAgentTools] onchain plugin ${id} not found`);
                    continue;
                }

                const pluginTools = pluginData.tools || [];

                // Create a LangChain tool for each GOAT tool
                for (const toolDef of pluginTools) {
                    const toolName = reserveToolName(toolDef.name, usedToolNames);
                    const tool = new DynamicStructuredTool({
                        name: toolName,
                        description: buildToolDescription(toolDef.name, toolDef.description, toolDef.parameters),
                        schema: toolDef.parameters ? createZodSchema(toolDef.parameters) : z.object({}),
                        func: async (args: Record<string, unknown>) => {
                            const activeSessionContext = resolveSessionContext(sessionContext);
                            await enforceToolPermissions({
                                toolName: toolDef.name,
                                toolDescription: toolDef.description,
                                cloudPermissions: activeSessionContext?.cloudPermissions,
                                userAddress,
                            });

                            const result = await executeGoatTool(id, toolDef.name, args);
                            if (!result.success) {
                                throw new Error(
                                    `GOAT tool "${toolDef.name}" failed: ${result.error || "unknown error"}`,
                                );
                            }
                            return formatToolResultForAgent(result.result);
                        },
                    });
                    tools.push(tool);
                }
            } else if (source === "tools") {
                console.log(`[createAgentTools] Fetching tools for MCP server "${id}"`);

                // Add timeout to prevent indefinite blocking on spawn failures
                const controller = new AbortController();
                const timeoutId = setTimeout(() => controller.abort(), 10000); // 10s timeout

                let serverData: Awaited<ReturnType<typeof getServerTools>>;
                try {
                    serverData = await Promise.race([
                        getServerTools(id),
                        new Promise<never>((_, reject) => {
                            controller.signal.addEventListener("abort", () => {
                                const error = new Error("MCP tools fetch aborted");
                                error.name = "AbortError";
                                reject(error);
                            });
                        }),
                    ]);
                } catch (err: any) {
                    if (err.name === 'AbortError') {
                        console.warn(`[createAgentTools] ✗ MCP server "${id}" timed out after 10s, skipping`);
                    } else {
                        console.warn(`[createAgentTools] ✗ MCP server "${id}" fetch failed:`, err.message);
                    }
                    continue; // Skip this server, don't fail entire agent
                } finally {
                    clearTimeout(timeoutId);
                }
                const serverTools = serverData.tools || [];

                if (serverTools.length === 0) {
                    console.warn(`[createAgentTools] ✗ MCP server "${id}" has no tools, skipping`);
                    continue;
                }

                console.log(`[createAgentTools] ✓ Found MCP server "${id}" with ${serverTools.length} tools`);

                for (const toolDef of serverTools) {
                    const toolName = reserveToolName(toolDef.name, usedToolNames);
                    const tool = new DynamicStructuredTool({
                        name: toolName,
                        description: buildToolDescription(toolDef.name, toolDef.description || `Execute ${toolDef.name} on MCP server ${id}`, toolDef.inputSchema),
                        schema: toolDef.inputSchema ? createZodSchema(toolDef.inputSchema) : z.object({}),
                        func: async (args: Record<string, unknown>) => {
                            const activeSessionContext = resolveSessionContext(sessionContext);
                            await enforceToolPermissions({
                                toolName: toolDef.name,
                                toolDescription: toolDef.description || `MCP tool on server ${id}`,
                                cloudPermissions: activeSessionContext?.cloudPermissions,
                                userAddress,
                            });

                            const toolKey = `${id}:${toolDef.name}`;

                            const failCheck = isToolFailed(toolKey);
                            if (failCheck.failed) {
                                throw new Error(
                                    `Tool "${toolDef.name}" is temporarily unavailable: ${failCheck.reason || "recent failures"}`,
                                );
                            }

                            console.log(`[MCP Tool] ${toolName} -> ${toolDef.name}(${JSON.stringify(args)})`);

                            try {
                                const result = await executeServerTool(id, toolDef.name, args);
                                clearToolFailure(toolKey);
                                return formatToolResultForAgent(result);
                            } catch (err: any) {
                                const errorMessage = err instanceof Error ? err.message : String(err);
                                const statusCode = typeof err?.statusCode === "number" ? err.statusCode : 503;
                                if (isRetryableToolFailure(statusCode, errorMessage)) {
                                    markToolFailed(toolKey, errorMessage);
                                }
                                throw new Error(`MCP tool "${toolDef.name}" failed: ${errorMessage}`);
                            }
                        },
                    });
                    tools.push(tool);
                }
            }
        } catch (error) {
            console.error(`[createAgentTools] Failed to load plugin ${pluginId}:`, error);
        }
    }

    appendHarnessTools(tools, usedToolNames, agentWallet?.address, userAddress);
    console.log(`[createAgentTools] Created ${tools.length} tools from ${pluginIds.length} plugins`);
    return tools;
}

/**
 * Append harness tools (task / delegate / compose_plan / search_* /
 * scratchpad_* / synthesize) to the agent's tool list. The harness needs
 * an opaque agent identity for scratchpad scoping; if the caller didn't
 * provide one (raw-model agents) we synthesize a stable per-process label.
 */
function appendHarnessTools(
    tools: DynamicStructuredTool[],
    usedToolNames: Set<string>,
    agentWallet: string | undefined,
    userAddress: string | undefined,
): void {
    const identity = agentWallet && agentWallet.length > 0
        ? agentWallet
        : `agent:anonymous:${process.pid}`;
    // Capability tools first so the cal harness can reference them by name
    // through bind.composeTools without callers needing to know they exist.
    for (const tool of createCapabilityTools()) {
        if (usedToolNames.has(tool.name)) continue;
        tools.push(tool);
        usedToolNames.add(tool.name);
    }
    const resolveTools = defaultBindResolver(tools);
    const harness = createHarnessTools({
        agentWallet: identity,
        userAddress,
        resolveTools,
        directTools: () => new Map(tools.map((t) => [t.name, t] as const)),
    });
    for (const tool of harness) {
        if (usedToolNames.has(tool.name)) continue;
        tools.push(tool);
        usedToolNames.add(tool.name);
    }
}

async function fetchBackpackConnections(userAddress: string): Promise<BackpackConnectedAccount[]> {
    const response = await fetchWithRetry(
        `${requireApiInternalUrl()}/api/backpack/connections?userAddress=${encodeURIComponent(userAddress)}`,
        {
            headers: buildApiInternalHeaders(),
        },
    );

    if (!response.ok) {
        throw new Error(`Failed to load Backpack accounts (${response.status})`);
    }

    const payload = await response.json() as { connections?: BackpackConnectedAccount[] };
    return Array.isArray(payload.connections) ? payload.connections : [];
}

async function fetchBackpackToolkitActions(toolkit: string, limit = 40): Promise<Array<{
    slug: string;
    name: string;
    description: string;
    toolkitSlug: string;
    toolkitName: string;
    noAuth: boolean;
    scopes: string[];
    inputParameters: Record<string, unknown>;
}>> {
    const response = await fetchWithRetry(
        `${requireApiInternalUrl()}/api/backpack/toolkits/${encodeURIComponent(toolkit)}/actions?limit=${limit}`,
        {
            headers: buildApiInternalHeaders(),
        },
    );

    if (!response.ok) {
        throw new Error(`Failed to load Backpack actions for ${toolkit} (${response.status})`);
    }

    const payload = await response.json() as {
        actions?: Array<{
            slug: string;
            name: string;
            description: string;
            toolkitSlug: string;
            toolkitName: string;
            noAuth: boolean;
            scopes: string[];
            inputParameters: Record<string, unknown>;
        }>;
    };
    return Array.isArray(payload.actions) ? payload.actions : [];
}

async function executeBackpackAction(input: {
    userAddress: string;
    toolkit: string;
    action: string;
    params?: Record<string, unknown>;
    text?: string;
}): Promise<unknown> {
    const response = await fetchWithRetry(
        `${requireApiInternalUrl()}/api/backpack/execute`,
        {
            method: "POST",
            headers: buildApiInternalHeaders({
                "Content-Type": "application/json",
            }),
            body: JSON.stringify(input),
        },
    );

    const payload = await response.json().catch(async () => ({
        success: false,
        error: await response.text(),
    })) as { success?: boolean; result?: unknown; error?: string };

    if (!response.ok || !payload.success) {
        throw new Error(payload.error || `Backpack action failed (${response.status})`);
    }

    return payload.result;
}

function createBackpackTools(input: {
    userAddress: string;
    sessionContext?: SessionContextProvider;
    executionContext?: ToolExecutionContext;
}): DynamicStructuredTool[] {
    const listAccounts = new DynamicStructuredTool({
        name: "backpack_list_accounts",
        description: "List the user's connected Backpack accounts. Backpack accounts are authenticated user accounts and are distinct from MCP servers and distinct from skills.",
        schema: z.object({}),
        func: async () => {
            const activeSessionContext = resolveSessionContext(input.sessionContext);
            await enforceToolPermissions({
                toolName: "backpack_list_accounts",
                toolDescription: "List connected Backpack accounts",
                cloudPermissions: activeSessionContext?.cloudPermissions,
                userAddress: input.userAddress,
            });

            const accounts = activeSessionContext?.backpackAccounts || await fetchBackpackConnections(input.userAddress);
            if (accounts.length === 0) {
                return "No Backpack accounts are connected for this user.";
            }
            return formatToolResultForAgent(accounts);
        },
    });

    const listActions = new DynamicStructuredTool({
        name: "backpack_list_actions",
        description: "List the available Backpack actions for a connected toolkit, including the exact action slugs to use when executing through that account.",
        schema: z.object({
            toolkit: z.string().describe("Toolkit slug, for example gmail, github, notion, or slack"),
            limit: z.number().int().min(1).max(100).optional(),
        }),
        func: async ({ toolkit, limit }: { toolkit: string; limit?: number }) => {
            const activeSessionContext = resolveSessionContext(input.sessionContext);
            await enforceToolPermissions({
                toolName: "backpack_list_actions",
                toolDescription: `List Backpack actions for ${toolkit}`,
                cloudPermissions: activeSessionContext?.cloudPermissions,
                userAddress: input.userAddress,
            });

            const actions = await fetchBackpackToolkitActions(toolkit, limit || 40);
            if (actions.length === 0) {
                return `No Backpack actions were found for toolkit "${toolkit}".`;
            }
            return formatToolResultForAgent(actions);
        },
    });

    const executeAction = new DynamicStructuredTool({
        name: "backpack_execute_action",
        description: "Execute a Backpack action through one of the user's connected accounts. First inspect connected accounts and available actions, then call the exact action slug with structured params.",
        schema: z.object({
            toolkit: z.string().describe("Toolkit slug bound to the user's connected account"),
            action: z.string().describe("Exact Backpack action slug to execute"),
            params: z.object({}).passthrough().optional().describe("Structured action arguments"),
            text: z.string().optional().describe("Optional natural-language instruction for Composio input generation"),
        }),
        func: async ({ toolkit, action, params, text }: {
            toolkit: string;
            action: string;
            params?: Record<string, unknown>;
            text?: string;
        }) => {
            const activeSessionContext = resolveSessionContext(input.sessionContext);
            await enforceToolPermissions({
                toolName: action,
                toolDescription: `Execute Backpack action on ${toolkit}`,
                cloudPermissions: activeSessionContext?.cloudPermissions,
                userAddress: input.userAddress,
            });

            const accounts = activeSessionContext?.backpackAccounts || await fetchBackpackConnections(input.userAddress);
            const account = accounts.find((item) => item.slug === toolkit && item.connected);
            if (!account) {
                throw new Error(`No connected Backpack account found for toolkit "${toolkit}"`);
            }

            const result = await executeBackpackAction({
                userAddress: input.userAddress,
                toolkit,
                action,
                params,
                text,
            });

            return formatToolResultForAgent(result);
        },
    });

    return [listAccounts, listActions, executeAction];
}

// =============================================================================
// Memory / Built-in Tools
// =============================================================================

/**
 * Compose memory tools — minimal surface (Phase 1.5).
 *
 * Recall is server-side and automatic per the `memory.arazzo.yaml` contract:
 * the cross-layer ranker considers all 6 layers (working, scene, graph,
 * patterns, archives, vectors) and pre-injects up to 6 items / 900 chars
 * into the system prompt before each turn. Agents do NOT pick layers and
 * do NOT call a recall tool — that would duplicate the ranker.
 *
 * Only `memory_remember` is exposed: explicit user-stated facts that the
 * auto-extractor (gemini-3.1-flash-lite-preview) sometimes misses.
 */
export function createMemoryTools(agentWallet: string, userAddress?: string, workflowWallet?: string): DynamicStructuredTool[] {
    function resolveToolText(value: string | undefined, field: "content" | "query"): string {
        const trimmed = value?.trim();
        if (trimmed) {
            return trimmed;
        }

        const fallback = getAgentExecutionContext()?.lastUserMessage?.trim();
        if (fallback) {
            return fallback;
        }

        throw new Error(`memory tool requires ${field} (or a non-empty user message in scope)`);
    }

    // Note: a `memory_recall` tool was deliberately removed (Phase 1.5).
    // The memory.arazzo.yaml contract states "ranker picks for you" — every
    // agent turn pre-injects up to 6 ranked items / 900 chars via
    // retrieveAgentMemory + buildPromptContext. Letting the model
    // second-guess the ranker mid-turn duplicates work and contradicts
    // the contract. `memory_remember` stays because explicit user-stated
    // facts (auto-extractor misses ~5%) are an orthogonal need.

    const memoryRemember = new DynamicStructuredTool({
        name: "memory_remember",
        description: "Save a durable fact, preference, or rule about the user. Use when the user volunteers stable information ('my name is X', 'I work at Y', 'I prefer Z'). Stored as a graph-layer fact and surfaced automatically on future turns.",
        schema: z.object({
            content: z.string().optional().describe("The durable fact in plain language. One fact per call; keep it under 200 characters."),
        }),
        func: async ({ content }: { content?: string }) => {
            const effectiveContent = resolveToolText(content, "content");
            const scope = resolveMemoryScope({
                agentWallet,
                userAddress,
                workflowWallet,
                context: getAgentExecutionContext(),
            });
            const saved = await persistExplicitAgentMemory({
                scope,
                content: effectiveContent,
                metadata: {
                    workflow_wallet: workflowWallet,
                },
            });
            return saved ? "Memory saved." : "Failed to save memory.";
        },
    });

    return [memoryRemember];
}

// =============================================================================
// Harness Tools — task / delegate / compose_plan / search_* / scratchpad_* / synthesize
// =============================================================================

/**
 * Cal harness tool surface, exposed to every agent by default. Wired
 * through createAgentTools so the entire harness (sub-agents, parallel
 * fan-out, deterministic step interpreter, vector discovery) is available
 * via standard LangChain function-calling.
 *
 * Resolver wiring:
 *  - resolveTools: returns the LangChain tool subset for a sub-agent given
 *    a BindSpec. Default implementation here filters the parent's already
 *    loaded tools by name; hosts can swap in semantic-bind logic.
 *
 * Model resolution is automatic: every `task`/`delegate` step targets a
 * registered on-chain agent (Phase 3.1 enforcement), and the interpreter
 * looks up that agent's card model directly. No host hook needed. Raw
 * model calls live in the `model_tool` plugin (Phase 4.7), where models
 * are TOOLS within an agent's turn — not swarm participants.
 *
 * Pricing/cost is NOT touched here. Tools emit usage in their JSON results;
 * the api layer aggregates / settles separately.
 */
export interface HarnessToolWiring {
    /** Parent run id used for scratchpad scoping + sub-agent runKey chain. */
    composeRunId?: string;
    /** Parent agent identity. */
    agentWallet: string;
    /** End-user identity propagated into sub-agents. */
    userAddress?: string;
    /**
     * Returns the LangChain tool list to bind to a sub-agent given the
     * BindSpec. Typical implementation: filter already-loaded parent tools
     * by name. Hosts can plug in semantic-bind retrieval here.
     */
    resolveTools: (bind: HarnessBindSpec | undefined) => Promise<DynamicStructuredTool[]>;
    /**
     * Direct-tool registry used by `op: tool` cal steps. Defaults to the
     * full parent tool list; pass an explicit Map for tighter sandboxing.
     */
    directTools?: () => Map<string, DynamicStructuredTool>;
}

// Re-import from the harness module — kept inside the file body so the
// existing imports section above remains untouched.
import {
    parseCalPlan as harnessParseCalPlan,
    runCalPlan as harnessRunCalPlan,
    runSubAgent as harnessRunSubAgent,
    runIsolatedSubAgent as harnessRunIsolatedSubAgent,
    searchAgents as harnessSearchAgents,
    searchModels as harnessSearchModels,
    searchTools as harnessSearchTools,
    createScratchpad as harnessCreateScratchpad,
    createConclaveBus as harnessCreateConclaveBus,
    type BindSpec as HarnessBindSpec,
    type CalPlan as HarnessCalPlan,
    type InterpreterContext as HarnessInterpreterContext,
    type SubAgentSpec as HarnessSubAgentSpec,
} from "../harness/index.js";
import { createModel as createHarnessModel } from "../framework.js";
import { peekAgentIdentity as harnessPeekAgentIdentity, resolveAgentIdentity as harnessResolveAgentIdentity } from "./identity.js";
import { HumanMessage as HarnessHumanMessage, SystemMessage as HarnessSystemMessage } from "@langchain/core/messages";

/**
 * Resolve a registered agent's card model, sync-cache first then IPFS.
 * Mirrors `harness/interpreter.ts:resolveStepModel` for the parallel
 * tool-surface path. Returns undefined when the wallet isn't registered
 * or the card has no model.
 */
async function resolveAgentCardModel(agentWallet: string | undefined): Promise<string | undefined> {
    if (!agentWallet || agentWallet.length === 0) return undefined;
    const cached = harnessPeekAgentIdentity(agentWallet);
    if (cached?.model && cached.model.length > 0) return cached.model;
    try {
        const identity = await harnessResolveAgentIdentity(agentWallet);
        if (identity.model && identity.model.length > 0) return identity.model;
    } catch {
        // Fall through to undefined.
    }
    return undefined;
}

const HARNESS_BUDGET_SCHEMA = z
    .object({
        maxToolBatches: z.number().int().positive().optional(),
        maxTokens: z.number().int().positive().optional(),
        maxWallMs: z.number().int().positive().optional(),
        maxDepth: z.number().int().positive().optional(),
    })
    .optional();

const HARNESS_BIND_SCHEMA = z
    .object({
        composeTools: z.array(z.string()).optional(),
        agentTools: z.array(z.string()).optional(),
        memory: z.boolean().optional(),
        knowledge: z.boolean().optional(),
        semanticBind: z
            .object({
                query: z.string().min(1),
                topK: z.number().int().positive().optional(),
            })
            .optional(),
    })
    .optional();

function harnessRunId(wiring: HarnessToolWiring): string {
    return wiring.composeRunId
        ?? getAgentExecutionContext()?.composeRunId
        ?? `cal:${Date.now().toString(36)}`;
}

function harnessInterpreterCtx(wiring: HarnessToolWiring): HarnessInterpreterContext {
    const composeRunId = harnessRunId(wiring);
    return {
        agentWallet: wiring.agentWallet,
        composeRunId,
        // Inherit the layer-0 root from the parent execution context when
        // present (we're running inside a depth-N sub-agent's tool call);
        // fall back to our own composeRunId when we ARE the layer-0
        // coordinator. Either way, every layer of the same swarm gets
        // the SAME rootComposeRunId, which keys `compose_conclave_*`.
        rootComposeRunId: getAgentExecutionContext()?.rootComposeRunId ?? composeRunId,
        userAddress: wiring.userAddress ?? getAgentExecutionContext()?.userAddress,
        resolveTools: async ({ bind }) => wiring.resolveTools(bind),
        parentExecutionContext: getAgentExecutionContext(),
        directTools: wiring.directTools?.(),
    };
}

/**
 * Default `resolveTools` implementation: filter parent's pre-loaded tool
 * list by name. Memory + knowledge tools are added by the engine based on
 * bind.memory / bind.knowledge, so we only handle compose/agent tool name
 * filtering here.
 */
export function defaultBindResolver(parentTools: DynamicStructuredTool[]): (bind: HarnessBindSpec | undefined) => Promise<DynamicStructuredTool[]> {
    const byName = new Map(parentTools.map((t) => [t.name, t] as const));
    return async (bind) => {
        if (!bind) return [];
        const wanted = new Set<string>();
        for (const name of bind.composeTools ?? []) wanted.add(name);
        for (const name of bind.agentTools ?? []) wanted.add(name);
        const out: DynamicStructuredTool[] = [];
        for (const name of wanted) {
            const tool = byName.get(name);
            if (tool) out.push(tool);
        }
        return out;
    };
}

/**
 * Build the harness tool surface. Append to whatever the rest of
 * createAgentTools already produced.
 */
export function createHarnessTools(wiring: HarnessToolWiring): DynamicStructuredTool[] {
    const composePlanTool = new DynamicStructuredTool({
        name: "compose_plan",
        description:
            "Execute a typed Compose Agent Loop (cal) plan written in YAML. " +
            "Use this whenever you need multiple steps, parallel sub-agents, " +
            "or deterministic tool dispatch. The plan is parsed and executed " +
            "by the runtime — you never re-read prompts about how to use it. " +
            "Steps: task | delegate | fanout | tool | search_tools | " +
            "search_agents | search_models | if | loop | scratch | " +
            "synthesize | stop | ask_user. Save outputs with saveAs and " +
            "reference them via {{stepId}} mustache syntax.",
        schema: z.object({
            yaml: z.string().min(1).describe("The cal plan as YAML text. Must contain a top-level `steps:` array."),
        }),
        func: async ({ yaml }: { yaml: string }) => {
            let plan: HarnessCalPlan;
            try {
                plan = harnessParseCalPlan(yaml);
            } catch (error) {
                return formatToolResultForAgent({
                    success: false,
                    error: error instanceof Error ? error.message : String(error),
                });
            }
            const result = await harnessRunCalPlan(plan, harnessInterpreterCtx(wiring));
            return formatToolResultForAgent({
                success: result.success,
                output: result.output,
                stopReason: result.stopReason,
                error: result.error,
                steps: result.steps.map((s) => ({
                    op: s.op,
                    saveAs: s.saveAs,
                    success: s.success,
                    error: s.error,
                })),
                aggregate: result.aggregateUsage,
                planId: result.planId,
            });
        },
    });

    const taskTool = new DynamicStructuredTool({
        name: "task",
        description:
            "Spawn a focused sub-agent for a single bounded task. The sub-agent " +
            "runs with its own scoped tool subset, fresh memory scope, and a " +
            "tool/wall budget — its chain-of-thought never pollutes your own. " +
            "Use this for deep research, side investigations, or anything you " +
            "want to keep out of your main context. Returns a distilled answer.",
        schema: z.object({
            prompt: z.string().min(1).describe("What the sub-agent should accomplish."),
            model: z.string().optional().describe("Specific model id. Falls back to the target agent's card model."),
            agentWallet: z.string().optional().describe("Optional opaque target identity (typically a registered agent wallet)."),
            bind: HARNESS_BIND_SCHEMA,
            budget: HARNESS_BUDGET_SCHEMA,
            isolated: z.boolean().optional().describe("Run inside a Daytona sandbox."),
            systemPrompt: z.string().optional(),
        }),
        func: async (input) => {
            const ctx = harnessInterpreterCtx(wiring);
            const model = input.model ?? (await resolveAgentCardModel(input.agentWallet));
            if (!model) {
                return formatToolResultForAgent({
                    success: false,
                    error: "task requires `model` (or the target agentWallet's card must declare one)",
                });
            }
            const subId = `task_${Date.now().toString(36)}`;
            const spec: HarnessSubAgentSpec = {
                parentRunId: ctx.composeRunId,
                subId,
                depth: 1,
                agentWallet: input.agentWallet,
                userAddress: ctx.userAddress,
                model,
                systemPrompt: input.systemPrompt,
                prompt: input.prompt,
                bind: input.bind,
                budget: input.budget,
                isolated: input.isolated === true,
            };
            const result = spec.isolated
                ? await harnessRunIsolatedSubAgent(spec, {
                    resolveTools: async ({ bind }) => wiring.resolveTools(bind),
                    parentExecutionContext: getAgentExecutionContext(),
                })
                : await harnessRunSubAgent(spec, {
                    resolveTools: async ({ bind }) => wiring.resolveTools(bind),
                    parentExecutionContext: getAgentExecutionContext(),
                });
            return formatToolResultForAgent({
                success: result.success,
                output: result.output,
                stopReason: result.stopReason,
                error: result.error,
                usage: result.usage,
                toolBatches: result.toolBatches,
                wallMs: result.wallMs,
                runKey: result.runKey,
            });
        },
    });

    const delegateTool = new DynamicStructuredTool({
        name: "delegate",
        description:
            "Delegate a request to another registered agent identified by " +
            "wallet (or any opaque identity the host understands). The " +
            "receiving agent runs with its own tools, memory, and reputation.",
        schema: z.object({
            agentWallet: z.string().min(1).describe("Opaque target identity (typically a registered agent wallet)."),
            prompt: z.string().min(1),
            model: z.string().optional(),
            budget: HARNESS_BUDGET_SCHEMA,
        }),
        func: async (input) => {
            const ctx = harnessInterpreterCtx(wiring);
            const model = input.model ?? (await resolveAgentCardModel(input.agentWallet));
            if (!model) {
                return formatToolResultForAgent({
                    success: false,
                    error: "delegate requires `model` (or the target agentWallet's card must declare one)",
                });
            }
            const subId = `delegate_${Date.now().toString(36)}`;
            const spec: HarnessSubAgentSpec = {
                parentRunId: ctx.composeRunId,
                subId,
                depth: 1,
                agentWallet: input.agentWallet,
                userAddress: ctx.userAddress,
                model,
                prompt: input.prompt,
                budget: input.budget,
            };
            const result = await harnessRunSubAgent(spec, {
                resolveTools: async ({ bind }) => wiring.resolveTools(bind),
                parentExecutionContext: getAgentExecutionContext(),
            });
            return formatToolResultForAgent({
                success: result.success,
                output: result.output,
                stopReason: result.stopReason,
                error: result.error,
                usage: result.usage,
                toolBatches: result.toolBatches,
                wallMs: result.wallMs,
                runKey: result.runKey,
            });
        },
    });

    const searchToolsTool = new DynamicStructuredTool({
        name: "search_tools",
        description:
            "Semantic search over the connectors MCP catalog. Returns top-K " +
            "candidates ranked by Voyage embeddings + rerank. Use this BEFORE " +
            "calling task/delegate when you need a tool you don't already " +
            "have bound — it costs no LLM tokens.",
        schema: z.object({
            query: z.string().min(1),
            topK: z.number().int().min(1).max(50).optional(),
        }),
        func: async ({ query, topK }) => {
            const hits = await harnessSearchTools(query, topK);
            return formatToolResultForAgent(hits);
        },
    });

    const searchAgentsTool = new DynamicStructuredTool({
        name: "search_agents",
        description:
            "Semantic search over the Compose agent marketplace. Returns " +
            "wallet addresses + skills + plugins for top-K specialist agents " +
            "matching the query. Pair with `delegate` to dispatch work.",
        schema: z.object({
            query: z.string().min(1),
            topK: z.number().int().min(1).max(50).optional(),
        }),
        func: async ({ query, topK }) => {
            const hits = await harnessSearchAgents(query, topK);
            return formatToolResultForAgent(hits);
        },
    });

    const searchModelsTool = new DynamicStructuredTool({
        name: "search_models",
        description:
            "Semantic search over Compose's model catalog (vectorized " +
            "models.json). Use to pick a coordinator/specialist model. " +
            "Optional capability filter (reasoning, vision, tools, agentic, " +
            "computer-use, ...).",
        schema: z.object({
            query: z.string().min(1),
            topK: z.number().int().min(1).max(50).optional(),
            capability: z.string().optional(),
        }),
        func: async ({ query, topK, capability }) => {
            const hits = await harnessSearchModels(query, { topK, capability });
            return formatToolResultForAgent(hits);
        },
    });

    const synthesizeTool = new DynamicStructuredTool({
        name: "synthesize",
        description:
            "Combine multiple text artifacts into a single coherent answer " +
            "using a chosen model. Useful after a fanout to merge branch " +
            "outputs without re-prompting yourself with the raw text.",
        schema: z.object({
            instruction: z.string().min(1),
            artifacts: z.array(z.object({ label: z.string(), text: z.string() })).min(1),
            model: z.string().optional(),
        }),
        func: async ({ instruction, artifacts, model }) => {
            const ctx = harnessInterpreterCtx(wiring);
            // No agentWallet on synthesize — it's a coordinator-side LLM
            // glue call. Phase 3.4 will default to a dynamic coordinator
            // from harness/coordinators.listAgenticCoordinators. Today,
            // an explicit `model` is required.
            const modelId = model;
            if (!modelId) {
                return formatToolResultForAgent({
                    success: false,
                    error: "synthesize requires `model` (no fallback configured)",
                });
            }
            const inputs = artifacts.map((a) => `### ${a.label}\n${a.text}`).join("\n\n");
            const llm = createHarnessModel(modelId, 0.2);
            const response = await llm.invoke([
                new HarnessSystemMessage(
                    "You are a synthesizer. Combine the input artifacts into a single coherent answer. Do not invent facts; only use what's provided.",
                ),
                new HarnessHumanMessage(`# INSTRUCTION\n${instruction}\n\n# INPUTS\n${inputs}`),
            ]);
            return typeof response.content === "string" ? response.content : JSON.stringify(response.content);
        },
    });

    const scratchpadWrite = new DynamicStructuredTool({
        name: "scratchpad_write",
        description:
            "Persist a value to the per-run scratchpad under `key`. Keyed by " +
            "(agentWallet, composeRunId), TTL 1h. Use for cross-step notes " +
            "without polluting your prompt context.",
        schema: z.object({
            key: z.string().min(1),
            value: z.union([z.string(), z.number(), z.boolean(), z.record(z.string(), z.any()), z.array(z.any())]),
        }),
        func: async ({ key, value }) => {
            const pad = harnessCreateScratchpad({
                agentWallet: wiring.agentWallet,
                composeRunId: harnessRunId(wiring),
            });
            await pad.write(key, value);
            return formatToolResultForAgent({ ok: true, key });
        },
    });

    const scratchpadRead = new DynamicStructuredTool({
        name: "scratchpad_read",
        description: "Read a previously-written scratchpad value by key.",
        schema: z.object({ key: z.string().min(1) }),
        func: async ({ key }) => {
            const pad = harnessCreateScratchpad({
                agentWallet: wiring.agentWallet,
                composeRunId: harnessRunId(wiring),
            });
            const value = await pad.read(key);
            return formatToolResultForAgent({ key, value });
        },
    });

    const scratchpadList = new DynamicStructuredTool({
        name: "scratchpad_list",
        description: "List the keys currently stored in the per-run scratchpad.",
        schema: z.object({}),
        func: async () => {
            const pad = harnessCreateScratchpad({
                agentWallet: wiring.agentWallet,
                composeRunId: harnessRunId(wiring),
            });
            const keys = await pad.list();
            return formatToolResultForAgent({ keys });
        },
    });

    // ── Conclave bus ── (Phase 3.2)
    //
    // SHARED state across every layer of the swarm. Whereas
    // `scratchpad_*` is private to ONE agent's run, `compose_conclave_*`
    // is the operational hand-off bus that the layer-0 coordinator and
    // every depth-N child read and write together. Use for:
    //   - todo / plan markdowns (Manus-style recitation)
    //   - intermediate artifacts a downstream specialist needs
    //   - status flags ("phase=editing", "phase=review")
    //   - hot-persisted swarm state for crash resume
    //
    // Authorship is automatic: every write carries `writtenBy` (the
    // agentWallet of the writer) so the coordinator can audit which
    // specialist contributed which artifact. Version counter monotonic
    // across writes for cheap change detection.

    const conclaveFor = () => {
        const ctx = getAgentExecutionContext();
        // Layer-0 case: ctx.rootComposeRunId is undefined, fall back to
        // the current composeRunId. Layer-1+ inherits a real root.
        const rootComposeRunId = ctx?.rootComposeRunId ?? ctx?.composeRunId ?? harnessRunId(wiring);
        return harnessCreateConclaveBus({
            rootComposeRunId,
            writtenBy: wiring.agentWallet,
        });
    };

    const conclaveWrite = new DynamicStructuredTool({
        name: "compose_conclave_write",
        description:
            "Write a value to the SHARED swarm conclave under `key`. " +
            "Visible to every agent in the same swarm (coordinator + every " +
            "depth-N specialist). Use for hand-off artifacts, plan / todo " +
            "markdowns, and coordination state. Authorship is recorded " +
            "automatically. TTL 24h.",
        schema: z.object({
            key: z.string().min(1).describe("Conclave key. Use stable names like 'plan.md', 'phase', 'draft.html'."),
            value: z.union([z.string(), z.number(), z.boolean(), z.record(z.string(), z.any()), z.array(z.any())]),
        }),
        func: async ({ key, value }) => {
            const cv = conclaveFor();
            const entry = await cv.write(key, value);
            return formatToolResultForAgent({
                ok: true,
                key,
                version: entry.version,
                writtenBy: entry.writtenBy,
                ts: entry.ts,
            });
        },
    });

    const conclaveRead = new DynamicStructuredTool({
        name: "compose_conclave_read",
        description:
            "Read a SHARED conclave value by key. Returns the value, the " +
            "agentWallet that wrote it, the timestamp, and the monotonic " +
            "version. null when the key is missing or expired.",
        schema: z.object({ key: z.string().min(1) }),
        func: async ({ key }) => {
            const cv = conclaveFor();
            const entry = await cv.read(key);
            return formatToolResultForAgent({ key, entry });
        },
    });

    const conclaveList = new DynamicStructuredTool({
        name: "compose_conclave_list",
        description:
            "List all live keys in the shared swarm conclave. Use to " +
            "discover what artifacts the coordinator (or peer specialists) " +
            "already wrote.",
        schema: z.object({}),
        func: async () => {
            const cv = conclaveFor();
            const keys = await cv.list();
            return formatToolResultForAgent({ keys });
        },
    });

    const conclaveDelete = new DynamicStructuredTool({
        name: "compose_conclave_delete",
        description:
            "Delete a key from the shared swarm conclave. Use sparingly " +
            "— other agents may be reading the key. Returns true when the " +
            "key existed.",
        schema: z.object({ key: z.string().min(1) }),
        func: async ({ key }) => {
            const cv = conclaveFor();
            const removed = await cv.delete(key);
            return formatToolResultForAgent({ key, removed });
        },
    });

    return [
        composePlanTool,
        taskTool,
        delegateTool,
        searchToolsTool,
        searchAgentsTool,
        searchModelsTool,
        synthesizeTool,
        scratchpadWrite,
        scratchpadRead,
        scratchpadList,
        conclaveWrite,
        conclaveRead,
        conclaveList,
        conclaveDelete,
    ];
}

// =============================================================================
// Capability Tools — compose_search / compose_fetch_url / compose_run_code / compose_browser
// =============================================================================
//
// These belong to the harness surface but live in tools.ts because every
// agent gets them by default through createAgentTools (appendHarnessTools
// composes them in alongside the cal toolkit).
//
// Provider config:
//   - compose_search: Linkup structured search (LINKUP_API_KEY) with
//     graceful fallback to Perplexity (PERPLEXITY_API_KEY) when Linkup is
//     unavailable.
//   - compose_fetch_url: plain fetch + HTML→text reduction.
//   - compose_run_code: Daytona conclave sandbox (DAYTONA_API_KEY).
//   - compose_browser: Daytona conclave sandbox running headless Chromium.
//
// All four NEVER touch pricing. Usage signals (latency, byte counts, exit
// codes) flow back as JSON in the tool result; api/ is responsible for any
// settlement.

import {
    createDaytonaClient as composeDaytonaClient,
    loadDaytonaConfig as composeLoadDaytonaConfig,
    runConclaveSandbox as composeRunConclaveSandbox,
} from "../../mesh/sandbox.js";

interface LinkupSearchResult {
    name?: string;
    url?: string;
    content?: string;
    snippet?: string;
}

async function searchViaLinkup(query: string, depth: "standard" | "deep"): Promise<{ results: LinkupSearchResult[]; provider: "linkup" }> {
    const apiKey = process.env.LINKUP_API_KEY;
    if (!apiKey) throw new Error("LINKUP_API_KEY missing");
    const response = await fetch("https://api.linkup.so/v1/search", {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
            q: query,
            depth,
            outputType: "searchResults",
        }),
        signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) {
        const detail = await response.text().catch(() => "");
        throw new Error(`Linkup ${response.status}: ${detail.slice(0, 300)}`);
    }
    const body = (await response.json()) as { results?: LinkupSearchResult[] };
    return { results: Array.isArray(body.results) ? body.results : [], provider: "linkup" };
}

async function searchViaPerplexity(query: string): Promise<{ results: LinkupSearchResult[]; provider: "perplexity" }> {
    const apiKey = process.env.PERPLEXITY_API_KEY;
    if (!apiKey) throw new Error("PERPLEXITY_API_KEY missing");
    const response = await fetch("https://api.perplexity.ai/chat/completions", {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
            model: "sonar",
            messages: [{ role: "user", content: query }],
        }),
        signal: AbortSignal.timeout(20000),
    });
    if (!response.ok) {
        const detail = await response.text().catch(() => "");
        throw new Error(`Perplexity ${response.status}: ${detail.slice(0, 300)}`);
    }
    const body = (await response.json()) as {
        choices?: Array<{ message?: { content?: string } }>;
        citations?: string[];
    };
    const summary = body.choices?.[0]?.message?.content ?? "";
    const citations = Array.isArray(body.citations) ? body.citations : [];
    return {
        results: [
            { name: "perplexity-summary", content: summary },
            ...citations.map((url) => ({ url, name: url })),
        ],
        provider: "perplexity",
    };
}

function htmlToText(html: string, maxChars: number): string {
    const stripped = html
        .replace(/<script[\s\S]*?<\/script>/gi, " ")
        .replace(/<style[\s\S]*?<\/style>/gi, " ")
        .replace(/<!--[\s\S]*?-->/g, " ")
        .replace(/<\/(p|div|li|h[1-6]|br|tr)>/gi, "\n")
        .replace(/<[^>]+>/g, " ")
        .replace(/&nbsp;/g, " ")
        .replace(/&amp;/g, "&")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/[ \t]+/g, " ")
        .replace(/\n{3,}/g, "\n\n")
        .trim();
    if (stripped.length <= maxChars) return stripped;
    return `${stripped.slice(0, maxChars)}... [truncated ${stripped.length - maxChars} chars]`;
}

/**
 * Capability tools. Appended to every agent by appendHarnessTools.
 */
export function createCapabilityTools(): DynamicStructuredTool[] {
    const composeSearch = new DynamicStructuredTool({
        name: "compose_search",
        description:
            "Web search. Returns a ranked list of {name, url, content} hits. " +
            "Uses Linkup when available, falls back to Perplexity. Use this " +
            "to ground answers in fresh information when memory + knowledge " +
            "tools are insufficient.",
        schema: z.object({
            query: z.string().min(1),
            depth: z.enum(["standard", "deep"]).optional().describe("Linkup depth. Ignored by other providers."),
        }),
        func: async ({ query, depth }) => {
            const errors: string[] = [];
            try {
                const out = await searchViaLinkup(query, depth ?? "standard");
                return formatToolResultForAgent(out);
            } catch (error) {
                errors.push(`linkup: ${error instanceof Error ? error.message : String(error)}`);
            }
            try {
                const out = await searchViaPerplexity(query);
                return formatToolResultForAgent(out);
            } catch (error) {
                errors.push(`perplexity: ${error instanceof Error ? error.message : String(error)}`);
            }
            return formatToolResultForAgent({ success: false, error: errors.join("; ") });
        },
    });

    const composeFetchUrl = new DynamicStructuredTool({
        name: "compose_fetch_url",
        description:
            "Fetch a URL and return readable text. Strips HTML, scripts, and " +
            "styles. Use after compose_search or when given a direct URL.",
        schema: z.object({
            url: z.string().url(),
            maxChars: z.number().int().min(500).max(50_000).optional(),
        }),
        func: async ({ url, maxChars }) => {
            try {
                const response = await fetch(url, {
                    method: "GET",
                    headers: {
                        Accept: "text/html, application/xhtml+xml, text/plain, */*",
                        "User-Agent": "Compose-Harness/1.0",
                    },
                    signal: AbortSignal.timeout(15000),
                    redirect: "follow",
                });
                if (!response.ok) {
                    return formatToolResultForAgent({
                        success: false,
                        status: response.status,
                        error: `HTTP ${response.status} ${response.statusText}`,
                    });
                }
                const contentType = response.headers.get("content-type") ?? "";
                const body = await response.text();
                const cap = maxChars ?? 12_000;
                const text = contentType.includes("html")
                    ? htmlToText(body, cap)
                    : body.length <= cap
                        ? body
                        : `${body.slice(0, cap)}... [truncated ${body.length - cap} chars]`;
                return formatToolResultForAgent({
                    success: true,
                    url: response.url,
                    contentType,
                    bytes: body.length,
                    text,
                });
            } catch (error) {
                return formatToolResultForAgent({
                    success: false,
                    error: error instanceof Error ? error.message : String(error),
                });
            }
        },
    });

    const composeRunCode = new DynamicStructuredTool({
        name: "compose_run_code",
        description:
            "Execute code in a Daytona sandbox. Per-call container, fire-and-" +
            "kill. Returns {exitCode, stdout, stderr, wallMs}. Use for " +
            "calculations, data transforms, or anything you'd run in a shell. " +
            "Network access is allowed by default; pass allowNetwork:false to " +
            "block egress.",
        schema: z.object({
            language: z.enum(["bash", "python", "node", "typescript"]).default("bash"),
            code: z.string().min(1),
            timeoutMs: z.number().int().min(1000).max(15 * 60_000).optional(),
            allowNetwork: z.boolean().optional(),
        }),
        func: async ({ language, code, timeoutMs, allowNetwork }) => {
            let config;
            try {
                config = composeLoadDaytonaConfig();
            } catch (error) {
                return formatToolResultForAgent({
                    success: false,
                    error: `Daytona not configured: ${error instanceof Error ? error.message : String(error)}`,
                });
            }
            const client = composeDaytonaClient(config);
            const startedAt = Date.now();
            const command = buildCodeCommand(language, code);
            try {
                const receipt = await composeRunConclaveSandbox(client, config, {
                    conclaveId: `tool-run-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
                    command,
                    labels: { kind: "compose_run_code", language },
                    networkBlockAll: allowNetwork === false,
                    timeoutMs,
                });
                return formatToolResultForAgent({
                    success: receipt.exitCode === 0,
                    exitCode: receipt.exitCode,
                    stdout: receipt.stdout,
                    stderr: receipt.stderr,
                    wallMs: receipt.finishedAt - receipt.startedAt,
                });
            } catch (error) {
                return formatToolResultForAgent({
                    success: false,
                    error: error instanceof Error ? error.message : String(error),
                    wallMs: Date.now() - startedAt,
                });
            }
        },
    });

    const composeBrowser = new DynamicStructuredTool({
        name: "compose_browser",
        description:
            "Drive a headless Chromium tab in a Daytona sandbox. Single-shot: " +
            "navigate to a URL, optionally run a small JS evaluator, return " +
            "page text + screenshot path. For multi-step browsing, call this " +
            "tool repeatedly inside a `task` sub-agent so each step has its " +
            "own short-lived sandbox.",
        schema: z.object({
            url: z.string().url(),
            evaluate: z.string().optional().describe("Optional JS expression evaluated against the document. Returns the stringified result."),
            timeoutMs: z.number().int().min(1000).max(10 * 60_000).optional(),
            waitMs: z.number().int().min(0).max(60_000).optional().describe("Idle wait after navigation, ms."),
        }),
        func: async ({ url, evaluate, timeoutMs, waitMs }) => {
            let config;
            try {
                config = composeLoadDaytonaConfig();
            } catch (error) {
                return formatToolResultForAgent({
                    success: false,
                    error: `Daytona not configured: ${error instanceof Error ? error.message : String(error)}`,
                });
            }
            const client = composeDaytonaClient(config);
            const startedAt = Date.now();
            const command = buildBrowserCommand(url, evaluate, waitMs ?? 1500);
            try {
                const receipt = await composeRunConclaveSandbox(client, config, {
                    conclaveId: `tool-browser-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
                    command,
                    labels: { kind: "compose_browser" },
                    networkBlockAll: false,
                    timeoutMs,
                });
                return formatToolResultForAgent({
                    success: receipt.exitCode === 0,
                    exitCode: receipt.exitCode,
                    stdout: receipt.stdout,
                    stderr: receipt.stderr,
                    wallMs: receipt.finishedAt - receipt.startedAt,
                });
            } catch (error) {
                return formatToolResultForAgent({
                    success: false,
                    error: error instanceof Error ? error.message : String(error),
                    wallMs: Date.now() - startedAt,
                });
            }
        },
    });

    return [composeSearch, composeFetchUrl, composeRunCode, composeBrowser];
}

function buildCodeCommand(language: "bash" | "python" | "node" | "typescript", code: string): string {
    const here64 = Buffer.from(code, "utf8").toString("base64");
    switch (language) {
        case "bash":
            return `set -euo pipefail; printf %s "${here64}" | base64 -d | bash`;
        case "python":
            return `set -euo pipefail; printf %s "${here64}" | base64 -d | python3 -`;
        case "node":
            return `set -euo pipefail; printf %s "${here64}" | base64 -d > /tmp/main.js && node /tmp/main.js`;
        case "typescript":
            return `set -euo pipefail; printf %s "${here64}" | base64 -d > /tmp/main.ts && npx --yes tsx /tmp/main.ts`;
    }
}

function buildBrowserCommand(url: string, evaluate: string | undefined, waitMs: number): string {
    // Boots a tiny headless-Chromium driver via puppeteer-core (assumed in
    // the Daytona snapshot). When puppeteer is missing we degrade to curl so
    // the tool still returns a useful body.
    const script = [
        `const url = ${JSON.stringify(url)};`,
        `const waitMs = ${waitMs};`,
        `const evaluate = ${evaluate ? JSON.stringify(evaluate) : "null"};`,
        `(async () => {`,
        `  let pup;`,
        `  try { pup = await import("puppeteer"); } catch { try { pup = await import("puppeteer-core"); } catch { pup = null; } }`,
        `  if (!pup) {`,
        `    const r = await fetch(url, { redirect: "follow" });`,
        `    process.stdout.write(JSON.stringify({ provider: "fetch", status: r.status, body: (await r.text()).slice(0, 50000) }));`,
        `    return;`,
        `  }`,
        `  const browser = await pup.default.launch({ headless: true, args: ["--no-sandbox", "--disable-setuid-sandbox"] });`,
        `  const page = await browser.newPage();`,
        `  await page.goto(url, { waitUntil: "networkidle2", timeout: 60000 });`,
        `  await new Promise((r) => setTimeout(r, waitMs));`,
        `  const text = await page.evaluate(() => document.body && document.body.innerText ? document.body.innerText : "");`,
        `  let evalResult = null;`,
        `  if (evaluate) { try { evalResult = await page.evaluate(evaluate); } catch (e) { evalResult = { error: String(e) }; } }`,
        `  await browser.close();`,
        `  process.stdout.write(JSON.stringify({ provider: "puppeteer", url: page.url(), text: text.slice(0, 30000), evalResult }));`,
        `})().catch((e) => { process.stderr.write(String(e && e.stack || e)); process.exit(1); });`,
    ].join("\n");
    const here64 = Buffer.from(script, "utf8").toString("base64");
    return `set -euo pipefail; printf %s "${here64}" | base64 -d > /tmp/browse.mjs && node /tmp/browse.mjs`;
}
