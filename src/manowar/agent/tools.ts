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
import { DEFAULT_AGENT_MEMORY_LAYERS, persistExplicitAgentMemory, retrieveAgentMemory } from "./memory.js";
import { searchMemoryLayers } from "../memory/index.js";
import { shouldEnforceCloudPermissions } from "../mode.js";
import { executeGoatTool, getPlugin } from "../../mcps/goat.js";
import { executeServerTool, getServerTools } from "../../mcps/mcp.js";
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
                scope: z.enum(["identity", "workspace", "all"]).optional().describe("Limit search to creator identity knowledge, private workspace knowledge, or both"),
                limit: z.number().int().min(1).max(8).optional().describe("Maximum number of knowledge hits to return"),
            }),
            func: async ({ query, scope, limit }: {
                query: string;
                scope?: "identity" | "workspace" | "all";
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
    if (RETRYABLE_STATUSES.has(status)) {
        return true;
    }
    const normalized = errorText.toLowerCase();
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
        return tools;
    }

    for (const pluginId of pluginIds) {
        try {
            // Normalize plugin ID to extract source and ID
            // Supports: "goat-coingecko", "goat:coingecko", "goat:goat-coingecko", "coingecko"
            //           "mcp-github", "mcp:github", "github"
            let source = "goat"; // Default source
            let id = pluginId;

            // Strip ALL goat/mcp prefixes (handles double-prefix edge cases like "goat:goat-coingecko")
            // Keep stripping until no more prefixes found
            while (id.startsWith("goat-") || id.startsWith("goat:") ||
                id.startsWith("mcp-") || id.startsWith("mcp:")) {
                if (id.startsWith("goat-") || id.startsWith("goat:")) {
                    source = "goat";
                    id = id.replace(/^goat[-:]/, "");
                } else if (id.startsWith("mcp-") || id.startsWith("mcp:")) {
                    source = "mcp";
                    id = id.replace(/^mcp[-:]/, "");
                }
            }

            console.log(`[createAgentTools] Normalized "${pluginId}" → source="${source}", id="${id}"`);

            if (source === "goat") {
                const pluginData = await getPlugin(id);
                if (!pluginData) {
                    console.warn(`[createAgentTools] GOAT plugin ${id} not found`);
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
            } else if (source === "mcp") {
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
                                if (isRetryableToolFailure(503, errorMessage)) {
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

    console.log(`[createAgentTools] Created ${tools.length} tools from ${pluginIds.length} plugins`);
    return tools;
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

        throw new Error(`Runtime memory tool requires ${field} or lastUserMessage`);
    }

    const searchKnowledge = new DynamicStructuredTool({
        name: "search_memory",
        description: "Search the full runtime memory stack for past interactions or learned facts across working memory, transcripts, vectors, graph memory, patterns, and archives.",
        schema: z.object({
            query: z.string().optional().describe("Search query. Always pass the user recall request here; if omitted, the runtime falls back to the latest user message."),
        }),
        func: async ({ query }: { query?: string }) => {
            try {
                const effectiveQuery = resolveToolText(query, "query");
                const scope = resolveMemoryScope({
                    agentWallet,
                    userAddress,
                    workflowWallet,
                    context: getAgentExecutionContext(),
                });
                const { summary } = await retrieveAgentMemory({
                    query: effectiveQuery,
                    scope,
                    limit: 8,
                });
                if (!summary) return "No relevant memories found.";
                return summary;
            } catch (error) {
                return `Runtime memory unavailable: ${error instanceof Error ? error.message : String(error)}`;
            }
        },
    });

    const storeKnowledge = new DynamicStructuredTool({
        name: "save_memory",
        description: "Explicitly save an important fact or user preference to your long-term memory. Entities and relations are automatically extracted.",
        schema: z.object({
            content: z.string().optional().describe("Fact to remember. Always pass the durable fact here; if omitted, the runtime falls back to the latest user message."),
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
            if (!saved) return "Failed to save memory.";
            return "Memory saved.";
        },
    });

    const hybridSearch = new DynamicStructuredTool({
        name: "search_all_memory",
        description: "Hybrid search across all runtime memory layers including working, scene, graph, patterns, archives, and vectors.",
        schema: z.object({
            query: z.string().optional().describe("Search query. Always pass the user recall request here; if omitted, the runtime falls back to the latest user message."),
            layers: z.array(z.enum(["working", "scene", "graph", "patterns", "archives", "vectors"])).optional(),
        }),
        func: async ({ query, layers }: { query?: string; layers?: string[] }) => {
            try {
                const effectiveQuery = resolveToolText(query, "query");
                const scope = resolveMemoryScope({
                    agentWallet,
                    userAddress,
                    workflowWallet,
                    context: getAgentExecutionContext(),
                });
                const results = await searchMemoryLayers({
                    query: effectiveQuery,
                    agentWallet: scope.agentWallet,
                    userAddress: scope.userId,
                    threadId: scope.threadId,
                    mode: scope.mode,
                    haiId: scope.haiId,
                    filters: scope.filters,
                    layers: (layers as Array<"working" | "scene" | "graph" | "patterns" | "archives" | "vectors"> | undefined) || [...DEFAULT_AGENT_MEMORY_LAYERS],
                    limit: 5,
                });
                return formatToolResultForAgent(results);
            } catch (error) {
                return JSON.stringify({
                    query: query || getAgentExecutionContext()?.lastUserMessage || "",
                    layers: {},
                    totals: {},
                    error: error instanceof Error ? error.message : String(error),
                });
            }
        },
    });

    return [searchKnowledge, storeKnowledge, hybridSearch];
}
