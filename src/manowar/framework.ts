import { ChatOpenAI } from "@langchain/openai";
import { HumanMessage } from "@langchain/core/messages";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import type { AgentWallet } from "../agent-wallet.js";
import { createAgentGraph } from "./agent/graph.js";
import { createAgentTools, createMemoryTools } from "./agent/tools.js";
import { getAgentExecutionContext, runWithAgentExecutionContext } from "./agent/context.js";
import { persistAgentConversationTurn, retrieveAgentMemory } from "./agent/memory.js";
import { resolveMemoryScope } from "./agent/memory-scope.js";
import { peekAgentIdentity, renderIdentitySection, resolveAgentIdentity, type AgentIdentity } from "./agent/identity.js";
import { ensureIdentityKnowledge } from "./knowledge/identity.js";
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
  messages: Array<{
    role: string;
    content: string;
    name?: string;
    toolCalls?: Array<{ id: string; name: string; args?: unknown }>;
  }>;
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

/**
 * Live stream abort registry.
 * Key: composeRunId (or `${agentWallet}:${threadId}` if no runId).
 * Stop endpoint signals these to abort an in-flight stream without losing
 * the LangGraph checkpoint — the model's conversation/CoT/memory survives
 * for that (userAddress, agentWallet, runId) triplet on resume.
 */
const liveRunControllers = new Map<string, AbortController>();

export function registerRunAbortController(runKey: string): AbortController {
  const existing = liveRunControllers.get(runKey);
  if (existing) {
    return existing;
  }
  const controller = new AbortController();
  liveRunControllers.set(runKey, controller);
  return controller;
}

export function clearRunAbortController(runKey: string): void {
  liveRunControllers.delete(runKey);
}

export function abortRun(runKey: string): boolean {
  const controller = liveRunControllers.get(runKey);
  if (!controller) return false;
  controller.abort(new Error("[compose:stop] run aborted by user"));
  liveRunControllers.delete(runKey);
  return true;
}

export function buildRunKey(agentWallet: string, runId: string | undefined, threadId?: string): string {
  if (runId && runId.trim()) return `run:${agentWallet}:${runId.trim()}`;
  return `thread:${agentWallet}:${threadId || "default"}`;
}
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

/**
 * Per-turn dynamic system block. Stable layout:
 *   1. Identity (stated, never reasoned — mesh@native pattern)
 *   2. Persona override (if operator supplied one at registration)
 *   3. Memory recall (only when populated)
 *   4. Session context (only when populated)
 *   5. Discipline footer (one line)
 *
 * Token budget target: 200–350 tokens cold, 400–600 with full memory recall.
 */
function buildPromptContext(config: AgentConfig): string | undefined {
  const sections: string[] = [];

  const identity: AgentIdentity | undefined = peekAgentIdentity(config.agentWallet);
  if (identity) {
    sections.push(renderIdentitySection(identity));
  } else {
    // Identity not yet hydrated — fall back to whatever AgentConfig knows so the model
    // never says "I'm a helpful assistant" between warmup and first IPFS read.
    sections.push(`You are ${config.name}. Wallet: ${config.agentWallet}`);
  }

  if (config.systemPrompt) {
    sections.push(config.systemPrompt);
  }

  const memoryPrompt = getAgentExecutionContext()?.memoryPrompt;
  if (memoryPrompt) {
    sections.push(memoryPrompt);
  }

  const sessionContext = config.sessionContext;
  if (sessionContext) {
    const sessionLines: string[] = [];
    if (sessionContext.sessionActive) {
      sessionLines.push(`Session: active, budget=${sessionContext.sessionBudgetRemaining}`);
    }
    if (shouldEnforceCloudPermissions() && sessionContext.cloudPermissions?.length) {
      sessionLines.push(`Cloud permissions: ${sessionContext.cloudPermissions.join(", ")}`);
    }
    if (sessionContext.backpackAccounts?.length) {
      const connected = sessionContext.backpackAccounts.filter((a) => a.connected);
      if (connected.length > 0) {
        sessionLines.push(`Backpack: ${connected.map((a) => a.slug).join(", ")}`);
      }
    }
    if (sessionLines.length > 0) {
      sections.push(sessionLines.join("\n"));
    }
  }

  // Discipline: one terse line. Models are smart — more rules = more drift.
  sections.push(
    "Use tools when the task needs live data, on-chain action, or memory. Continue calling tools across multiple steps until the task is complete; only stop when you have a final answer.",
  );

  return sections.length > 0 ? sections.join("\n\n") : undefined;
}

export function createModel(modelName: string, temperature: number = 0.7): BaseChatModel {
  return new ChatOpenAI({
    modelName,
    temperature,
    streaming: true,
    configuration: {
      baseURL: `${requireApiInternalUrl()}/v1`,
      apiKey: requireApiInternalToken(),
    },
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
  const memoryTools = config.memory === false
    ? []
    : createMemoryTools(config.agentWallet, config.userAddress, config.workflowWallet);
  const runtimeTools = [...composeTools, ...memoryTools];
  const model = createModel(config.model, config.temperature ?? 0.7);
  const checkpointDir = path.resolve(process.cwd(), "data", "checkpoints");
  const executor = createAgentGraph(
    model,
    runtimeTools,
    checkpointDir,
    undefined, // identity is rendered per-turn via dynamicSystemPrompt
    () => buildPromptContext(config),
  );
  const instance: AgentInstance = {
    id,
    name: config.name,
    executor,
    config,
    tools: runtimeTools,
  };
  agents.set(id, instance);

  // Fire-and-forget warmups: hydrate IPFS identity + index identity knowledge.
  // First turn doesn't block on these; subsequent turns benefit.
  void resolveAgentIdentity(config.agentWallet).catch((err) => {
    console.warn(`[manowar] Identity hydration failed for ${config.agentWallet}:`, err instanceof Error ? err.message : err);
  });
  if (config.memory !== false) {
    void ensureIdentityKnowledge(config.agentWallet).catch((err) => {
      console.warn(`[manowar] Identity knowledge index failed for ${config.agentWallet}:`, err instanceof Error ? err.message : err);
    });
  }

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
        if (part.type === "reasoning" || part.type === "thinking" || part.type === "reasoning_text") return "";
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

  const kwargs = asRecord(record.kwargs);
  const kwargsContent = normalizeMessageContent(kwargs?.content);
  if (kwargsContent.length > 0) {
    return kwargsContent;
  }

  const lcKwargs = asRecord(record.lc_kwargs);
  const lcKwargsContent = normalizeMessageContent(lcKwargs?.content);
  if (lcKwargsContent.length > 0) {
    return lcKwargsContent;
  }

  const nestedOutput = extractTextFromStructuredOutput(record.output);
  if (nestedOutput.length > 0) {
    return nestedOutput;
  }

  return extractTextFromStructuredOutput(record.tool_outputs);
}

function extractReasoningFromStructuredOutput(value: unknown, depth = 0): string {
  if (depth > 6 || value === null || value === undefined) {
    return "";
  }
  if (Array.isArray(value)) {
    return value
      .map((entry) => extractReasoningFromStructuredOutput(entry, depth + 1))
      .filter((entry) => entry.length > 0)
      .join("");
  }
  const record = asRecord(value);
  if (!record) {
    return "";
  }

  for (const key of ["reasoning_content", "reasoning_delta", "reasoning_text", "thinking", "thought"]) {
    const direct = record[key];
    if (typeof direct === "string" && direct.length > 0) {
      return direct;
    }
  }

  if (record.type === "reasoning" || record.type === "thinking" || record.type === "reasoning_text") {
    const text = typeof record.text === "string"
      ? record.text
      : typeof record.content === "string"
        ? record.content
        : "";
    if (text.length > 0) {
      return text;
    }
  }

  for (const key of ["content", "additional_kwargs", "response_metadata", "kwargs", "lc_kwargs", "delta"]) {
    const nested = extractReasoningFromStructuredOutput(record[key], depth + 1);
    if (nested.length > 0) {
      return nested;
    }
  }
  return "";
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
  const kwargs = asRecord(record.kwargs);
  const lcKwargs = asRecord(record.lc_kwargs);
  const kwargsContent = normalizeMessageContent(kwargs?.content);
  if (kwargsContent.length > 0) {
    return kwargsContent;
  }
  const lcKwargsContent = normalizeMessageContent(lcKwargs?.content);
  if (lcKwargsContent.length > 0) {
    return lcKwargsContent;
  }

  return (
    extractTextFromStructuredOutput(additionalKwargs?.tool_outputs) ||
    extractTextFromStructuredOutput(kwargs?.tool_outputs) ||
    extractTextFromStructuredOutput(lcKwargs?.tool_outputs) ||
    extractTextFromStructuredOutput(responseMetadata?.output) ||
    extractTextFromStructuredOutput(additionalKwargs?.output) ||
    extractTextFromStructuredOutput(kwargs?.output) ||
    extractTextFromStructuredOutput(lcKwargs?.output) ||
    ""
  );
}

function resolveToolMessageName(message: unknown): string | undefined {
  const record = asRecord(message);
  if (!record) {
    return undefined;
  }
  const kwargs = asRecord(record.kwargs);
  const lcKwargs = asRecord(record.lc_kwargs);
  return readRecordString(record, "name")
    ?? (kwargs ? readRecordString(kwargs, "name") : undefined)
    ?? (lcKwargs ? readRecordString(lcKwargs, "name") : undefined);
}

function readRecordString(record: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.length > 0) {
      return value;
    }
  }
  return undefined;
}

function nestedRecord(record: Record<string, unknown>, key: string): Record<string, unknown> | null {
  return asRecord(record[key]);
}

function resolveLangChainMessageType(value: unknown, record: Record<string, unknown>): string | undefined {
  if (typeof (value as any)._getType === "function") {
    return (value as any)._getType();
  }

  const directType = readRecordString(record, "type");
  if (directType) {
    return directType;
  }

  if (Array.isArray(record.id)) {
    const serializedType = record.id
      .filter((item): item is string => typeof item === "string")
      .find((item) => item.endsWith("Message"));
    if (serializedType === "ToolMessage") return "tool";
    if (serializedType === "AIMessage") return "ai";
    if (serializedType === "HumanMessage") return "human";
    if (serializedType === "SystemMessage") return "system";
  }

  return undefined;
}

function collectMessageLikeValues(value: unknown, output: unknown[] = [], depth = 0): unknown[] {
  if (depth > 6 || value === null || value === undefined) {
    return output;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      collectMessageLikeValues(item, output, depth + 1);
    }
    return output;
  }

  const record = asRecord(value);
  if (!record) {
    return output;
  }

  const lcKwargs = nestedRecord(record, "lc_kwargs");
  const kwargs = nestedRecord(record, "kwargs");
  const additionalKwargs = nestedRecord(record, "additional_kwargs")
    ?? (kwargs ? nestedRecord(kwargs, "additional_kwargs") : null);
  const messageType = resolveLangChainMessageType(value, record);
  if (
    messageType ||
    record.tool_calls ||
    record.toolCalls ||
    record.tool_call_id ||
    lcKwargs?.tool_call_id ||
    lcKwargs?.tool_calls ||
    kwargs?.tool_call_id ||
    kwargs?.tool_calls ||
    additionalKwargs?.tool_calls
  ) {
    output.push(value);
  }

  for (const key of ["messages", "message", "output", "chunk", "generations", "lc_kwargs", "kwargs", "additional_kwargs"]) {
    collectMessageLikeValues(record[key], output, depth + 1);
  }

  return output;
}

function parseToolArgs(value: unknown): unknown {
  if (typeof value !== "string") {
    return value;
  }
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function summarizeToolOutput(value: unknown): string | undefined {
  const text = extractTextFromStructuredOutput(value) || normalizeMessageContent(value);
  if (!text) {
    return undefined;
  }
  return text.length > 1_000 ? `${text.slice(0, 1_000)}...` : text;
}

function formatToolInvocation(name: string, input: unknown): string {
  let paramBlock = "";
  if (input && typeof input === "object" && !Array.isArray(input)) {
    for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
      const serialized = typeof value === "string" ? value : JSON.stringify(value);
      paramBlock += `<${key}>${serialized}</${key}>\n`;
    }
  }
  return `\n<invoke>\n${name}\n${paramBlock}</invoke>\n`;
}

/**
 * Per-token tool-args streaming. LangGraph chat-model stream chunks carry
 * `tool_call_chunks` arrays with partial args being typed token-by-token.
 * SOTA pattern (Codex `response.function_call_arguments.delta`,
 * Claude Code `input_json_delta`).
 */
function extractToolCallChunks(value: unknown): Array<{ id?: string; name?: string; args?: string; index?: number }> {
  const out: Array<{ id?: string; name?: string; args?: string; index?: number }> = [];
  const candidates = [value, asRecord(value)?.kwargs, asRecord(value)?.lc_kwargs];
  for (const candidate of candidates) {
    const record = asRecord(candidate);
    if (!record) continue;
    const chunks = record.tool_call_chunks ?? record.toolCallChunks;
    if (!Array.isArray(chunks)) continue;
    for (const raw of chunks) {
      const chunk = asRecord(raw);
      if (!chunk) continue;
      const id = readRecordString(chunk, "id", "tool_call_id");
      const name = readRecordString(chunk, "name");
      const args = readRecordString(chunk, "args", "arguments");
      const indexValue = chunk.index;
      const index = typeof indexValue === "number" ? indexValue : undefined;
      if (!id && !name && !args) continue;
      out.push({ id, name, args, index });
    }
    if (out.length > 0) break;
  }
  return out;
}

function extractStreamToolCalls(value: unknown): Array<{ id: string; name: string; args?: unknown }> {
  const calls: Array<{ id: string; name: string; args?: unknown }> = [];
  for (const item of collectMessageLikeValues(value)) {
    const record = asRecord(item);
    if (!record) continue;
    const additional = nestedRecord(record, "additional_kwargs");
    const lcKwargs = nestedRecord(record, "lc_kwargs");
    const kwargs = nestedRecord(record, "kwargs");
    const kwargsAdditional = kwargs ? nestedRecord(kwargs, "additional_kwargs") : null;
    const rawCalls = record.tool_calls
      ?? record.toolCalls
      ?? additional?.tool_calls
      ?? lcKwargs?.tool_calls
      ?? kwargs?.tool_calls
      ?? kwargsAdditional?.tool_calls;
    if (!Array.isArray(rawCalls)) continue;
    rawCalls.forEach((raw, index) => {
      const call = asRecord(raw);
      const fn = call ? asRecord(call.function) : null;
      const name = call
        ? readRecordString(call, "name")
          ?? (fn ? readRecordString(fn, "name") : undefined)
        : undefined;
      if (!name) return;
      const id = call
        ? readRecordString(call, "id", "tool_call_id")
          ?? `${name}:${index}`
        : `${name}:${index}`;
      const args = call
        ? call.args ?? call.arguments ?? (fn ? parseToolArgs(fn.arguments) : undefined)
        : undefined;
      calls.push({ id, name, args });
    });
  }
  return calls;
}

function isToolResultError(record: Record<string, unknown>, lcKwargs: Record<string, unknown> | null, kwargs: Record<string, unknown> | null, output: unknown): boolean {
  const status = record.status ?? lcKwargs?.status ?? kwargs?.status;
  if (status === "error") {
    return true;
  }
  return typeof output === "string" && /^Error:/i.test(output.trim());
}

function isToolOutputError(value: unknown): boolean {
  const record = asRecord(value);
  if (!record) {
    return isToolResultError({}, null, null, value);
  }
  const lcKwargs = nestedRecord(record, "lc_kwargs");
  const kwargs = nestedRecord(record, "kwargs");
  const output = record.content ?? lcKwargs?.content ?? kwargs?.content ?? value;
  return isToolResultError(record, lcKwargs, kwargs, output);
}

function extractStreamToolResults(value: unknown): Array<{ id: string; name?: string; output?: unknown; failed?: boolean; error?: string }> {
  const results: Array<{ id: string; name?: string; output?: unknown; failed?: boolean; error?: string }> = [];
  for (const item of collectMessageLikeValues(value)) {
    const record = asRecord(item);
    if (!record) continue;
    const lcKwargs = nestedRecord(record, "lc_kwargs");
    const kwargs = nestedRecord(record, "kwargs");
    const messageType = resolveLangChainMessageType(item, record);
    const id = readRecordString(record, "tool_call_id")
      ?? (lcKwargs ? readRecordString(lcKwargs, "tool_call_id") : undefined)
      ?? (kwargs ? readRecordString(kwargs, "tool_call_id") : undefined);
    if (messageType !== "tool" && !id) continue;
    const output = record.content ?? lcKwargs?.content ?? kwargs?.content;
    const failed = isToolResultError(record, lcKwargs, kwargs, output);
    results.push({
      id: id ?? readRecordString(record, "id") ?? "tool",
      name: readRecordString(record, "name")
        ?? (lcKwargs ? readRecordString(lcKwargs, "name") : undefined)
        ?? (kwargs ? readRecordString(kwargs, "name") : undefined),
      output,
      failed,
      ...(failed ? { error: normalizeMessageContent(output) } : {}),
    });
  }
  return results;
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

function buildGlobalMemoryScope(agentWallet: string, options: ExecuteOptions, threadId: string) {
  return resolveMemoryScope({
    agentWallet,
    userAddress: options.userAddress,
    workflowWallet: options.workflowWallet,
    context: {
      mode: "global",
      composeRunId: options.composeRunId,
      threadId,
      agentWallet,
      userAddress: options.userAddress,
      workflowWallet: options.workflowWallet,
    },
  });
}

function buildConversationTurnSessionId(agentWallet: string, threadId: string, composeRunId?: string): string {
  if (composeRunId && composeRunId.trim().length > 0) {
    return composeRunId.trim();
  }
  return `turn:${agentWallet}:${threadId}:${Date.now()}`;
}

function resolveExecutionThreadId(agentWallet: string, options: ExecuteOptions): string {
  const explicitThreadId = options.threadId?.trim();
  if (explicitThreadId) {
    return explicitThreadId;
  }

  const composeRunId = options.composeRunId?.trim();
  if (composeRunId) {
    return `run:${agentWallet}:${composeRunId}`;
  }

  return `run:${agentWallet}:${Date.now()}:${randomUUID()}`;
}

async function loadConversationMemoryPrompt(
  agentWallet: string,
  message: string,
  options: ExecuteOptions,
  threadId: string,
): Promise<string | undefined> {
  const query = message.trim();
  if (!query) {
    return undefined;
  }

  try {
    const scope = buildGlobalMemoryScope(agentWallet, options, threadId);
    const { prompt } = await retrieveAgentMemory({
      query,
      scope,
      limit: 3,
    });
    return prompt || undefined;
  } catch (error) {
    console.error("[manowar] failed to load runtime memory", error);
    return undefined;
  }
}

async function persistConversationTurnSafely(input: {
  agentWallet: string;
  threadId: string;
  options: ExecuteOptions;
  userMessage: string;
  assistantMessage: string;
  modelUsed: string;
  totalTokens: number;
}): Promise<void> {
  try {
    const scope = buildGlobalMemoryScope(input.agentWallet, input.options, input.threadId);
    await persistAgentConversationTurn({
      scope,
      sessionId: buildConversationTurnSessionId(input.agentWallet, input.threadId, input.options.composeRunId),
      userMessage: input.userMessage,
      assistantMessage: input.assistantMessage,
      modelUsed: input.modelUsed,
      totalTokens: input.totalTokens,
      metadata: {
        workflow_wallet: input.options.workflowWallet,
      },
    });
  } catch (error) {
    console.error("[manowar] failed to persist conversation turn memory", error);
  }
}

async function executeAgentCore(
  agent: AgentInstance,
  message: string,
  options: ExecuteOptions,
): Promise<ExecutionResult> {
  const agentWallet = agent.config.agentWallet;
  const threadId = resolveExecutionThreadId(agentWallet, options);
  const userAddress = options.userAddress;
  const workflowWallet = options.workflowWallet;
  const start = Date.now();

  try {
    if (options.sessionContext) {
      agent.config.sessionContext = options.sessionContext;
    }

    const usageTracker = new AgentMemoryTracker(agentWallet, threadId);
    const callbacks = [usageTracker];
    const humanMessage = await buildHumanMessage(message, options);
    const memoryPrompt = agent.config.memory === false
      ? undefined
      : await loadConversationMemoryPrompt(agentWallet, message, options, threadId);

    const maxRecursionLimit = Math.min(parseInt(process.env.MAX_AGENT_RECURSION_DEPTH || "100", 10), 500);
    const result = await runWithAgentExecutionContext(
      {
        mode: "global",
        composeRunId: options.composeRunId,
        threadId,
        agentWallet,
        userAddress,
        workflowWallet,
        memoryPrompt,
        lastUserMessage: message,
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
            callbacks,
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
    const output = resolveMessageText(lastMessage);

    if (agent.config.memory !== false) {
      await persistConversationTurnSafely({
        agentWallet,
        threadId,
        options,
        userMessage: message,
        assistantMessage: output,
        modelUsed: agent.config.model || "unknown",
        totalTokens: extractedTokens.totalTokens,
      });
    }

    return {
      success: true,
      messages: messages.map((item: any) => ({
        role: item._getType?.() || "unknown",
        content: resolveMessageText(item),
        name: resolveToolMessageName(item),
        toolCalls: extractStreamToolCalls(item),
      })),
      output,
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

  const threadId = resolveExecutionThreadId(agentWallet, options);
  const userAddress = options.userAddress;
  const workflowWallet = options.workflowWallet;
  const usageTracker = new AgentMemoryTracker(agentWallet, threadId);
  const callbacks = [usageTracker];
  const humanMessage = await buildHumanMessage(message, options);
  const memoryPrompt = agent.config.memory === false
    ? undefined
    : await loadConversationMemoryPrompt(agentWallet, message, options, threadId);

  const runKey = buildRunKey(agentWallet, options.composeRunId, threadId);
  const abortController = registerRunAbortController(runKey);

  const maxRecursionLimit = Math.min(parseInt(process.env.MAX_AGENT_RECURSION_DEPTH || "100", 10), 500);
  const usageTotals = createEmptyStreamUsageTotals();
  let thinkingActive = false;
  let lastUsageCandidate: unknown = null;
  let streamedAssistantText = "";
  const startedToolCallIds = new Set<string>();
  const endedToolCallIds = new Set<string>();

  try {
    const eventStream = await runWithAgentExecutionContext(
      {
        mode: "global",
        composeRunId: options.composeRunId,
        threadId,
        agentWallet,
        userAddress,
        workflowWallet,
        memoryPrompt,
        lastUserMessage: message,
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
            callbacks,
            recursionLimit: maxRecursionLimit,
            version: "v2",
            signal: abortController.signal,
          },
        ),
    );

    for await (const event of eventStream) {
      if (abortController.signal.aborted) {
        yield {
          type: "stopped",
          reason: "user_stop",
        };
        break;
      }
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
        const reasoning = extractReasoningFromStructuredOutput(chunk);
        if (reasoning) {
          yield { type: "reasoning_delta", delta: reasoning };
        }
        // Tool-args streaming: LangGraph exposes per-token tool argument deltas
        // via tool_call_chunks on chat-model stream chunks. SOTA pattern.
        const toolCallChunks = extractToolCallChunks(chunk);
        for (const tcc of toolCallChunks) {
          yield {
            type: "tool_args_delta",
            id: tcc.id,
            toolName: tcc.name,
            argsDelta: tcc.args,
            index: tcc.index,
          };
        }
        const content = extractTextFromStructuredOutput(chunk);
        if (content) {
          streamedAssistantText += content;
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
        const toolId = typeof event.run_id === "string" ? event.run_id : event.name;
        if (startedToolCallIds.has(toolId)) {
          continue;
        }
        startedToolCallIds.add(toolId);
        yield {
          type: "tool_start",
          toolName: event.name,
          input: toolInput,
          content: formatToolInvocation(event.name, toolInput),
        };
      } else if (event.event === "on_tool_end") {
        const toolId = typeof event.run_id === "string" ? event.run_id : event.name;
        if (endedToolCallIds.has(toolId)) {
          continue;
        }
        endedToolCallIds.add(toolId);
        const failed = isToolOutputError(event.data?.output);
        yield {
          type: "tool_end",
          toolName: event.name,
          output: event.data?.output,
          message: summarizeToolOutput(event.data?.output),
          failed,
          ...(failed ? { error: normalizeMessageContent(event.data?.output) } : {}),
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

    if (agent.config.memory !== false) {
      void persistConversationTurnSafely({
        agentWallet,
        threadId,
        options,
        userMessage: message,
        assistantMessage: streamedAssistantText,
        modelUsed: agent.config.model || "unknown",
        totalTokens: usageTotals.totalTokens,
      });
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
    // Carry the same usage envelope on terminal stop/error events so the API
    // gateway can settle x402 against whatever metering accumulated. Without
    // this, an aborted or errored stream silently aborts the prepared payment
    // and the user is never charged for the work the model already did.
    const usagePayload = {
      input_tokens: usageTotals.promptTokens,
      output_tokens: usageTotals.completionTokens,
      total_tokens: usageTotals.totalTokens,
      reasoning_tokens: usageTotals.reasoningTokens,
    };
    if (abortController.signal.aborted) {
      yield {
        type: "stopped",
        reason: "user_stop",
        model: agent.config.model,
        usage: usagePayload,
        promptTokens: usageTotals.promptTokens,
        completionTokens: usageTotals.completionTokens,
        totalTokens: usageTotals.totalTokens,
        reasoningTokens: usageTotals.reasoningTokens,
      };
    } else {
      yield {
        type: "error",
        content: `\n\n[System Error: ${messageText}]\n`,
        error: messageText,
        model: agent.config.model,
        usage: usagePayload,
        promptTokens: usageTotals.promptTokens,
        completionTokens: usageTotals.completionTokens,
        totalTokens: usageTotals.totalTokens,
        reasoningTokens: usageTotals.reasoningTokens,
      };
    }
  } finally {
    clearRunAbortController(runKey);
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
