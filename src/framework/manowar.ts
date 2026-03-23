import { ChatOpenAI } from "@langchain/openai";
import { HumanMessage, SystemMessage, ToolMessage, type BaseMessage } from "@langchain/core/messages";
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
  extractExecutionPatterns,
  getPatternsCollection,
  promotePatternToSkill,
  searchMemoryLayers,
  validateExtractedPattern,
} from "./memory/index.js";
import {
  AgentMemoryTracker,
  extractTokens,
  resolveAuthoritativeTokens,
} from "./langsmith.js";
import { resolveRuntimeHostMode, shouldEnforceCloudPermissions } from "./mode.js";

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
interface AgentDnaLock {
  agentWallet: string;
  modelId: string;
  chainId?: number;
  agentCardCid: string;
  mcpToolsHash: string;
  dnaHash?: string;
  lockedAt?: number;
}

interface SkillRequirement {
  bins: string[];
  anyBins: string[];
  env: string[];
  config: string[];
  os: string[];
}

interface SkillSpec {
  key: string;
  source: "agent" | "runtime" | "generated";
  path: string;
  name: string;
  description: string;
  commands: string[];
  requirements: SkillRequirement;
  eligible: boolean;
  missing: string[];
  revision: string;
}

interface SkillAuditRecord {
  at: string;
  revision: string;
  action: "created" | "updated" | "rollback";
  skillPath: string;
  patternId?: string;
  confidence?: number;
  notes?: string;
}

interface WorkerCronJob {
  id: string;
  everyMs: number;
  message: string;
  sessionKey: string;
  timer: NodeJS.Timeout | null;
}

interface AgentWorker {
  runtime: AgentInstance;
  config: AgentConfig;
  lanes: SessionLaneLock;
  runtimeId: string;
  createdAt: number;
  workspaceRoot: string;
  workspaceSkillsRoot: string;
  generatedSkillsRoot: string;
  logsFile: string;
  dnaLock: AgentDnaLock;
  heartbeatTimer: NodeJS.Timeout | null;
  reflectionTimer: NodeJS.Timeout | null;
  cronJobs: Map<string, WorkerCronJob>;
  skills: Map<string, SkillSpec>;
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

export interface AgentResponsesRequest extends Record<string, unknown> { }
export interface AgentResponsesResult extends Record<string, unknown> { }

const HEARTBEAT_OK = "HEARTBEAT_OK";
const DEFAULT_HEARTBEAT_MS = 30_000;
const DEFAULT_REFLECTION_MS = 10 * 60_000;
const DEFAULT_CRON_SESSION_PREFIX = "cron";
const DEFAULT_SUBAGENT_MAX_DEPTH = 3;
const LOCAL_BASE_DIR = String(process.env.COMPOSE_LOCAL_BASE_DIR || "").trim();
const DEFAULT_WORKSPACE_ROOT = process.env.COMPOSE_AGENT_WORKSPACE_ROOT
  || (LOCAL_BASE_DIR ? path.join(LOCAL_BASE_DIR, "agents") : path.resolve(process.cwd(), "data", "compose-agents"));
const RUNTIME_SKILLS_ROOT = process.env.COMPOSE_RUNTIME_SKILLS_ROOT || path.resolve(process.cwd(), "skills");

const agents = new Map<string, AgentInstance>();
const workers = new Map<string, AgentWorker>();

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
  const executor = createAgentGraph(model, composeTools, checkpointDir, config.systemPrompt, () => buildDynamicSystemContext(config));
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
    return content.map((part: any) => {
      if (typeof part === "string") return part;
      if (part.type === "text") return part.text || "";
      if (part.text) return part.text;
      return JSON.stringify(part);
    }).join("");
  }
  if (content) {
    return JSON.stringify(content);
  }
  return "";
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
      async () => agent.executor.invoke({
        messages: [humanMessage],
      }, {
        configurable: {
          thread_id: threadId,
          recursionDepth: 0,
          maxRecursionDepth: maxRecursionLimit,
          startTime: Date.now(),
        },
        callbacks: [mem0Handler, usageTracker],
        recursionLimit: maxRecursionLimit,
      }),
    );

    const messages = Array.isArray((result as { messages?: unknown[] }).messages) ? (result as { messages: any[] }).messages : [];
    const lastMessage = messages[messages.length - 1];
    const trackedMetrics = usageTracker.getMetrics().contextMetrics;
    const extractedTokens = resolveAuthoritativeTokens(
      result,
      trackedMetrics ? {
        inputTokens: trackedMetrics.inputTokens,
        outputTokens: trackedMetrics.outputTokens,
        reasoningTokens: 0,
        totalTokens: trackedMetrics.totalTokens,
      } : null,
    );

    return {
      success: true,
      messages: messages.map((item: any) => ({
        role: item._getType?.() || "unknown",
        content: normalizeMessageContent(item.content),
      })),
      output: normalizeMessageContent(lastMessage?.content),
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
      async () => agent.executor.streamEvents({
        messages: [humanMessage],
      }, {
        configurable: {
          thread_id: threadId,
          recursionDepth: 0,
          maxRecursionDepth: maxRecursionLimit,
          startTime: Date.now(),
        },
        callbacks: [mem0Handler, usageTracker],
        recursionLimit: maxRecursionLimit,
        version: "v2",
      }),
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
        trackedMetrics ? {
          inputTokens: trackedMetrics.inputTokens,
          outputTokens: trackedMetrics.outputTokens,
          reasoningTokens: 0,
          totalTokens: trackedMetrics.totalTokens,
        } : null,
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

function resolveWorkerExecutionContext(
  agentWallet: string,
  message: string,
  options: ExecuteOptions,
): { worker: AgentWorker; sessionKey: string; message: string } | null {
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

export async function executeAgent(
  agentWallet: string,
  message: string,
  options: ExecuteOptions = {},
): Promise<ExecutionResult> {
  const agent = agents.get(agentWallet);
  if (!agent) {
    throw new Error(`Agent ${agentWallet} not found`);
  }

  const executionContext = resolveWorkerExecutionContext(agentWallet, message, options);
  if (!executionContext) {
    return executeAgentCore(agent, message, options);
  }

  const { worker, sessionKey, message: runtimeMessage } = executionContext;
  const execution = await worker.lanes.run(sessionKey, async () => executeAgentCore(agent, runtimeMessage, options));
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

  const executionContext = resolveWorkerExecutionContext(agentWallet, message, options);
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

function walletWorkspace(agentWallet: string): string {
  return path.join(DEFAULT_WORKSPACE_ROOT, agentWallet.toLowerCase());
}

function heartbeatPath(agentWallet: string): string {
  return path.join(walletWorkspace(agentWallet), "HEARTBEAT.md");
}

function dnaPath(agentWallet: string): string {
  return path.join(walletWorkspace(agentWallet), "DNA.md");
}

function soulPath(agentWallet: string): string {
  return path.join(walletWorkspace(agentWallet), "SOUL.md");
}

function isLocalRuntimeHost(): boolean {
  return resolveRuntimeHostMode() === "local";
}

function defaultDnaLock(config: AgentConfig): AgentDnaLock {
  const plugins = [...(config.plugins || [])].map((value) => value.trim().toLowerCase()).filter(Boolean).sort();
  return {
    agentWallet: config.agentWallet.toLowerCase(),
    modelId: config.model || "",
    chainId: config.chainId,
    agentCardCid: "unknown",
    mcpToolsHash: sha256Hex(plugins.join("|")),
    lockedAt: Date.now(),
  };
}

function parseMarkdownKeyValue(input: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of input.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const idx = line.indexOf(":");
    if (idx <= 0) continue;
    out[line.slice(0, idx).trim().toLowerCase()] = line.slice(idx + 1).trim();
  }
  return out;
}

function readDnaLock(config: AgentConfig): AgentDnaLock {
  const file = dnaPath(config.agentWallet);
  if (!fileExists(file)) {
    return defaultDnaLock(config);
  }
  const parsed = parseMarkdownKeyValue(fs.readFileSync(file, "utf8"));
  return {
    agentWallet: (parsed.agentwallet || config.agentWallet).toLowerCase(),
    modelId: parsed.modelid || config.model || "",
    chainId: parsed.chainid ? Number(parsed.chainid) : config.chainId,
    agentCardCid: parsed.agentcardcid || "unknown",
    mcpToolsHash: parsed.mcptoolshash || defaultDnaLock(config).mcpToolsHash,
    dnaHash: parsed.dnahash || undefined,
    lockedAt: parsed.lockedat ? Number(parsed.lockedat) : Date.now(),
  };
}

function verifyDnaLock(config: AgentConfig, lock: AgentDnaLock): void {
  const expectedWallet = config.agentWallet.toLowerCase();
  if (lock.agentWallet !== expectedWallet) {
    throw new Error(`DNA lock wallet mismatch: expected ${expectedWallet}, got ${lock.agentWallet}`);
  }
  if (config.model && lock.modelId && config.model !== lock.modelId) {
    throw new Error(`DNA lock model mismatch: expected ${config.model}, got ${lock.modelId}`);
  }
  if (typeof config.chainId === "number" && typeof lock.chainId === "number" && config.chainId !== lock.chainId) {
    throw new Error(`DNA lock chain mismatch: expected ${config.chainId}, got ${lock.chainId}`);
  }
  const plugins = [...(config.plugins || [])].map((value) => value.trim().toLowerCase()).filter(Boolean).sort();
  if (lock.mcpToolsHash !== sha256Hex(plugins.join("|"))) {
    throw new Error(`DNA lock MCP hash mismatch for ${config.agentWallet}`);
  }
}

function writeWorkerLog(worker: AgentWorker, level: "info" | "warn" | "error", message: string): void {
  fs.appendFileSync(worker.logsFile, `${new Date().toISOString()} [${level}] ${message}\n`, "utf8");
}

function hasCommand(binary: string): boolean {
  return (process.env.PATH || "").split(path.delimiter).filter(Boolean).some((entry) => fileExists(path.join(entry, binary)));
}

function evaluateSkillEligibility(requirements: SkillRequirement, skillDir: string): { eligible: boolean; missing: string[] } {
  const missing: string[] = [];
  for (const bin of requirements.bins) {
    if (!hasCommand(bin)) missing.push(`bin:${bin}`);
  }
  if (requirements.anyBins.length > 0 && !requirements.anyBins.some((bin) => hasCommand(bin))) {
    missing.push(`anyBins:${requirements.anyBins.join("|")}`);
  }
  for (const envKey of requirements.env) {
    if (!process.env[envKey]) missing.push(`env:${envKey}`);
  }
  for (const configFile of requirements.config) {
    if (!fileExists(path.join(skillDir, configFile))) missing.push(`config:${configFile}`);
  }
  if (requirements.os.length > 0) {
    const current = process.platform.toLowerCase();
    if (!requirements.os.some((item) => current.includes(item.toLowerCase()))) {
      missing.push(`os:${requirements.os.join("|")}`);
    }
  }
  return { eligible: missing.length === 0, missing };
}

function readSkillSpec(skillPath: string, source: SkillSpec["source"]): SkillSpec | null {
  if (!fileExists(skillPath)) return null;
  const text = fs.readFileSync(skillPath, "utf8");
  const lines = text.split(/\r?\n/);
  let name = path.basename(path.dirname(skillPath));
  let description = "";
  const commands: string[] = [];
  const requirements: SkillRequirement = { bins: [], anyBins: [], env: [], config: [], os: [] };

  for (const raw of lines) {
    const line = raw.trim();
    if (line.startsWith("# ") && name === path.basename(path.dirname(skillPath))) {
      name = line.slice(2).trim() || name;
      continue;
    }
    const lower = line.toLowerCase();
    if (lower.startsWith("description:")) {
      description = line.slice("description:".length).trim();
    } else if (lower.startsWith("bins:")) {
      requirements.bins.push(...line.slice(5).split(",").map((item) => item.trim()).filter(Boolean));
    } else if (lower.startsWith("anybins:")) {
      requirements.anyBins.push(...line.slice(8).split(",").map((item) => item.trim()).filter(Boolean));
    } else if (lower.startsWith("env:")) {
      requirements.env.push(...line.slice(4).split(",").map((item) => item.trim()).filter(Boolean));
    } else if (lower.startsWith("config:")) {
      requirements.config.push(...line.slice(7).split(",").map((item) => item.trim()).filter(Boolean));
    } else if (lower.startsWith("os:")) {
      requirements.os.push(...line.slice(3).split(",").map((item) => item.trim().toLowerCase()).filter(Boolean));
    } else if (line.startsWith("`") && line.endsWith("`")) {
      commands.push(line.slice(1, -1));
    } else if (line.startsWith("- `") && line.endsWith("`")) {
      commands.push(line.slice(3, -1));
    }
  }

  const eligibility = evaluateSkillEligibility(requirements, path.dirname(skillPath));
  return {
    key: `${source}:${path.basename(path.dirname(skillPath)).toLowerCase()}`,
    source,
    path: skillPath,
    name,
    description,
    commands,
    requirements,
    eligible: eligibility.eligible,
    missing: eligibility.missing,
    revision: sha256Hex(text),
  };
}

function loadSkills(worker: AgentWorker): Map<string, SkillSpec> {
  if (isLocalRuntimeHost()) {
    return new Map();
  }

  const discovered = new Map<string, SkillSpec>();
  const roots: Array<{ root: string; source: SkillSpec["source"] }> = [
    { root: worker.workspaceSkillsRoot, source: "agent" },
    { root: RUNTIME_SKILLS_ROOT, source: "runtime" },
    { root: worker.generatedSkillsRoot, source: "generated" },
  ];

  for (const { root, source } of roots) {
    if (!fileExists(root)) continue;
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const spec = readSkillSpec(path.join(root, entry.name, "SKILL.md"), source);
      if (spec && !discovered.has(spec.key)) {
        discovered.set(spec.key, spec);
      }
    }
  }
  return discovered;
}

function skillsPrompt(skills: Map<string, SkillSpec>): string {
  const values = [...skills.values()].filter((skill) => skill.eligible);
  if (values.length === 0) return "No eligible runtime skills are currently installed.";
  return [
    "Eligible runtime skills (precedence: agent -> runtime -> generated):",
    ...values.slice(0, 48).map((skill) => {
      const preview = skill.commands.slice(0, 3).join(", ");
      return `- ${skill.name} [${skill.key}]${preview ? ` commands: ${preview}` : ""}`;
    }),
  ].join("\n");
}

function parseSessionKey(agentWallet: string, threadId?: string, explicit?: string): string {
  if (explicit && explicit.trim().length > 0) return explicit.trim();
  if (threadId?.trim()) return `agent:${agentWallet}:session:${threadId.trim()}`;
  return `agent:${agentWallet}:session:main`;
}

function withSkillContext(message: string, skills: Map<string, SkillSpec>): string {
  if (isLocalRuntimeHost()) {
    return message;
  }
  return `${skillsPrompt(skills)}\n\nUser message:\n${message}`;
}

function ensureCloudWorkspaceFiles(config: AgentConfig): void {
  const root = walletWorkspace(config.agentWallet);
  ensureDir(root);
  ensureDir(path.join(root, "skills"));
  ensureDir(path.join(root, "skills", "generated"));
  const defaults = [
    {
      file: dnaPath(config.agentWallet),
      content: [
        "# DNA",
        `agentWallet: ${config.agentWallet.toLowerCase()}`,
        `modelId: ${config.model || ""}`,
        `chainId: ${config.chainId || ""}`,
        "agentCardCid: unknown",
        `mcpToolsHash: ${defaultDnaLock(config).mcpToolsHash}`,
        "dnaHash: ",
        `lockedAt: ${Date.now()}`,
        "",
      ].join("\n"),
    },
    {
      file: soulPath(config.agentWallet),
      content: "# SOUL\n\nMutable behavior and persona notes for this local deployment.\n",
    },
    {
      file: heartbeatPath(config.agentWallet),
      content: "# HEARTBEAT\n\nKeep checks lightweight. Reply exactly HEARTBEAT_OK when no action is needed.\n",
    },
    {
      file: path.join(root, "AGENTS.md"),
      content: "# AGENTS\n\nPer-agent local instructions and workflow policies.\n",
    },
    {
      file: path.join(root, "TOOLS.md"),
      content: "# TOOLS\n\nImmutable MCP/GOAT tool identities are derived from DNA.md.\n",
    },
    {
      file: path.join(root, "IDENTITY.md"),
      content: `# IDENTITY\n\nagentWallet: ${config.agentWallet.toLowerCase()}\n`,
    },
    {
      file: path.join(root, "USER.md"),
      content: "# USER\n\nPer-user local preferences and policies.\n",
    },
  ];

  for (const item of defaults) {
    if (!fileExists(item.file)) {
      fs.writeFileSync(item.file, item.content, "utf8");
    }
  }
}

function ensureLocalWorkspace(config: AgentConfig): void {
  const root = walletWorkspace(config.agentWallet);
  if (!fileExists(root)) {
    throw new Error(`Local agent workspace is missing for ${config.agentWallet}`);
  }
  if (!fileExists(dnaPath(config.agentWallet))) {
    throw new Error(`Local agent DNA is missing for ${config.agentWallet}`);
  }
}

function parseSubagentDepth(sessionKey: string): number {
  const match = sessionKey.match(/subagent:depth:(\d+)/i);
  if (!match) return 0;
  const value = Number(match[1]);
  return Number.isFinite(value) ? value : 0;
}

async function runHeartbeat(worker: AgentWorker): Promise<void> {
  const file = heartbeatPath(worker.runtime.id);
  if (!fileExists(file)) return;
  const prompt = fs.readFileSync(file, "utf8").trim();
  if (!prompt) return;

  await worker.lanes.run(`agent:${worker.runtime.id}:session:main`, async () => {
    const result = await executeAgent(worker.runtime.id, prompt, {
      threadId: `heartbeat-${worker.runtime.id}`,
      userAddress: worker.config.userAddress,
      workflowWallet: worker.config.workflowWallet,
      sessionContext: {
        sessionActive: true,
        sessionBudgetRemaining: Number.MAX_SAFE_INTEGER,
      },
    });
    if (!result.success) {
      writeWorkerLog(worker, "warn", `heartbeat failed: ${result.error || "unknown"}`);
      return;
    }
    const output = result.output?.trim() || "";
    if (output && output !== HEARTBEAT_OK) {
      writeWorkerLog(worker, "warn", `heartbeat alert: ${output.slice(0, 240)}`);
    }
  });
}

async function appendSkillAudit(worker: AgentWorker, record: SkillAuditRecord): Promise<void> {
  if (isLocalRuntimeHost()) return;
  const auditPath = path.join(worker.generatedSkillsRoot, "audit.jsonl");
  ensureDir(path.dirname(auditPath));
  fs.appendFileSync(auditPath, `${JSON.stringify(record)}\n`, "utf8");
}

async function runReflection(worker: AgentWorker): Promise<void> {
  if (isLocalRuntimeHost()) return;
  try {
    await searchMemoryLayers({
      query: "recent successful tool sequences and outcomes",
      agentWallet: worker.runtime.id,
      userAddress: worker.config.userAddress,
      layers: ["patterns", "working", "scene"],
      limit: 5,
    });
    await extractExecutionPatterns({
      agentWallet: worker.runtime.id,
      timeRange: {
        start: Date.now() - 7 * 24 * 60 * 60 * 1000,
        end: Date.now(),
      },
      confidenceThreshold: 0.25,
    });

    const patternsCollection = await getPatternsCollection();
    const patterns = await patternsCollection
      .find({ agentWallet: worker.runtime.id })
      .sort({ updatedAt: -1, successRate: -1 })
      .limit(6)
      .toArray();

    for (const pattern of patterns as any[]) {
      const validation = await validateExtractedPattern({ patternId: pattern.patternId });
      if (!validation.valid) continue;

      const promoted = await promotePatternToSkill({
        patternId: pattern.patternId,
        skillName: `learned-${pattern.patternId.slice(0, 8)}`,
        validationData: validation,
      });
      if (!promoted.promoted || !promoted.skillId) continue;

      const skillDir = path.join(worker.generatedSkillsRoot, promoted.skillId);
      ensureDir(skillDir);
      const skillPath = path.join(skillDir, "SKILL.md");
      const skillContents = [
        `# ${promoted.skillId}`,
        `description: Auto-generated from pattern ${pattern.patternId}`,
        "env:",
        "bins:",
        "os:",
        "",
        "## Commands",
        ...validation.toolSequence.map((tool: string) => `- \`${tool}\``),
        "",
      ].join("\n");

      if (fileExists(skillPath)) {
        const previous = fs.readFileSync(skillPath, "utf8");
        const backup = `${skillPath}.${Date.now()}.bak`;
        fs.writeFileSync(backup, previous, "utf8");
        await appendSkillAudit(worker, {
          at: new Date().toISOString(),
          revision: sha256Hex(previous),
          action: "rollback",
          skillPath: backup,
          notes: "pre-update backup",
        });
      }

      fs.writeFileSync(skillPath, skillContents, "utf8");
      await appendSkillAudit(worker, {
        at: new Date().toISOString(),
        revision: sha256Hex(skillContents),
        action: "created",
        skillPath,
        patternId: pattern.patternId,
        confidence: validation.confidence,
      });
    }

    worker.skills = loadSkills(worker);
  } catch (error) {
    writeWorkerLog(worker, "warn", `reflection skipped: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function startBackgroundLoops(worker: AgentWorker): void {
  if (worker.heartbeatTimer) {
    clearInterval(worker.heartbeatTimer);
    worker.heartbeatTimer = null;
  }
  if (worker.reflectionTimer) {
    clearInterval(worker.reflectionTimer);
    worker.reflectionTimer = null;
  }

  if (isLocalRuntimeHost()) {
    return;
  }

  if (worker.heartbeatTimer) clearInterval(worker.heartbeatTimer);
  worker.heartbeatTimer = setInterval(() => {
    void runHeartbeat(worker).catch((error) => {
      writeWorkerLog(worker, "error", `heartbeat loop error: ${error instanceof Error ? error.message : String(error)}`);
    });
  }, DEFAULT_HEARTBEAT_MS);

  if (worker.reflectionTimer) clearInterval(worker.reflectionTimer);
  worker.reflectionTimer = setInterval(() => {
    void runReflection(worker).catch((error) => {
      writeWorkerLog(worker, "error", `reflection loop error: ${error instanceof Error ? error.message : String(error)}`);
    });
  }, DEFAULT_REFLECTION_MS);
}

function stopBackgroundLoops(worker: AgentWorker): void {
  if (worker.heartbeatTimer) {
    clearInterval(worker.heartbeatTimer);
    worker.heartbeatTimer = null;
  }
  if (worker.reflectionTimer) {
    clearInterval(worker.reflectionTimer);
    worker.reflectionTimer = null;
  }
  for (const job of worker.cronJobs.values()) {
    if (job.timer) {
      clearInterval(job.timer);
      job.timer = null;
    }
  }
  worker.cronJobs.clear();
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

function ensureWorker(agentWallet: string): AgentWorker {
  const worker = workers.get(agentWallet);
  if (!worker) {
    throw new Error(`Managed agent worker not found for ${agentWallet}`);
  }
  return worker;
}

export async function createManagedAgent(config: AgentConfig): Promise<AgentInstance> {
  const existing = workers.get(config.agentWallet);
  if (existing) return existing.runtime;

  if (isLocalRuntimeHost()) {
    ensureLocalWorkspace(config);
  } else {
    ensureCloudWorkspaceFiles(config);
  }
  const root = walletWorkspace(config.agentWallet);
  if (!isLocalRuntimeHost()) {
    ensureDir(root);
    ensureDir(path.join(root, "skills"));
    ensureDir(path.join(root, "skills", "generated"));
  }

  const dnaLock = readDnaLock(config);
  verifyDnaLock(config, dnaLock);

  const runtime = await createAgent({
    ...config,
    systemPrompt: `${config.systemPrompt || `You are ${config.name}.`}\n\nRuntime invariants:\n- DNA lock is immutable at runtime\n- MCP/tool identity cannot mutate from skills\n- Self-learning may only add local skills`,
  });

  const logsFile = path.join(root, "runtime.log");
  if (!fileExists(logsFile)) {
    fs.writeFileSync(logsFile, "", "utf8");
  }

  const worker: AgentWorker = {
    runtime,
    config,
    lanes: new SessionLaneLock(),
    runtimeId: `compose-agent-${config.agentWallet}-${Date.now()}`,
    createdAt: Date.now(),
    workspaceRoot: root,
    workspaceSkillsRoot: path.join(root, "skills"),
    generatedSkillsRoot: path.join(root, "skills", "generated"),
    logsFile,
    dnaLock,
    heartbeatTimer: null,
    reflectionTimer: null,
    cronJobs: new Map(),
    skills: new Map(),
  };

  worker.skills = loadSkills(worker);
  startBackgroundLoops(worker);
  workers.set(config.agentWallet, worker);
  writeWorkerLog(worker, "info", `worker started runtimeId=${worker.runtimeId} skills=${worker.skills.size}`);
  return runtime;
}

export function scheduleManagedAgentCron(input: {
  agentWallet: string;
  id: string;
  everyMs: number;
  message: string;
}): void {
  if (isLocalRuntimeHost()) {
    throw new Error("Managed cron scheduling is cloud-only");
  }
  const worker = ensureWorker(input.agentWallet);
  const everyMs = Math.max(1_000, input.everyMs);
  const sessionKey = `${DEFAULT_CRON_SESSION_PREFIX}:${input.id}`;
  const existing = worker.cronJobs.get(input.id);
  if (existing?.timer) clearInterval(existing.timer);

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
  if (!job) return;
  if (job.timer) clearInterval(job.timer);
  worker.cronJobs.delete(jobId);
  writeWorkerLog(worker, "info", `cron unscheduled id=${jobId}`);
}

export async function executeManagedAgent(params: ManagedAgentExecutionParams): Promise<ManagedAgentExecutionResult> {
  const worker = ensureWorker(params.agentWallet);
  worker.skills = loadSkills(worker);
  const sessionKey = parseSessionKey(params.agentWallet, params.threadId, params.sessionKey);
  const subDepth = sessionKey.includes("subagent") ? parseSubagentDepth(sessionKey) : (params.subagentDepth || 0);
  if (subDepth > DEFAULT_SUBAGENT_MAX_DEPTH) {
    throw new Error(`Subagent depth exceeded (${subDepth} > ${DEFAULT_SUBAGENT_MAX_DEPTH})`);
  }

  enforceSessionPermissions(sessionKey, params.sessionGrants);
  const execution = await worker.lanes.run(sessionKey, async () => {
    return executeAgent(params.agentWallet, withSkillContext(params.message, worker.skills), toExecutionOptions(params));
  });

  writeWorkerLog(worker, execution.success ? "info" : "warn", `session=${sessionKey} success=${execution.success}`);
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
    skillsRevision: sha256Hex(
      [...worker.skills.values()].map((item) => `${item.key}:${item.revision}:${item.eligible}`).sort().join("|"),
    ),
  };
}

export async function* streamManagedAgent(params: ManagedAgentExecutionParams): AsyncGenerator<unknown> {
  const worker = ensureWorker(params.agentWallet);
  worker.skills = loadSkills(worker);
  const sessionKey = parseSessionKey(params.agentWallet, params.threadId, params.sessionKey);
  const subDepth = sessionKey.includes("subagent") ? parseSubagentDepth(sessionKey) : (params.subagentDepth || 0);
  if (subDepth > DEFAULT_SUBAGENT_MAX_DEPTH) {
    throw new Error(`Subagent depth exceeded (${subDepth} > ${DEFAULT_SUBAGENT_MAX_DEPTH})`);
  }

  enforceSessionPermissions(sessionKey, params.sessionGrants);
  const unlock = await worker.lanes.acquire(sessionKey);
  try {
    for await (const chunk of streamAgent(params.agentWallet, withSkillContext(params.message, worker.skills), toExecutionOptions(params))) {
      yield chunk;
    }
    writeWorkerLog(worker, "info", `stream completed session=${sessionKey}`);
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
  skills?: Array<{ key: string; eligible: boolean; source: string; revision: string }>;
} {
  const worker = workers.get(agentWallet);
  if (!worker) return { running: false };
  return {
    running: true,
    runtimeId: worker.runtimeId,
    createdAt: worker.createdAt,
    cronJobs: [...worker.cronJobs.keys()],
    skills: [...worker.skills.values()].map((item) => ({
      key: item.key,
      eligible: item.eligible,
      source: item.source,
      revision: item.revision,
    })),
  };
}

export function stopManagedAgent(agentWallet: string): void {
  const worker = workers.get(agentWallet);
  if (!worker) return;
  stopBackgroundLoops(worker);
  writeWorkerLog(worker, "info", "worker stopped");
  workers.delete(agentWallet);
}

export function getManagedAgentLogs(agentWallet: string, maxLines: number = 200): string[] {
  const worker = workers.get(agentWallet);
  const logsPath = worker?.logsFile || path.join(walletWorkspace(agentWallet), "runtime.log");
  if (!fileExists(logsPath)) return [];
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
    if (record.error && typeof record.error === "object" && typeof (record.error as Record<string, unknown>).message === "string") {
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
