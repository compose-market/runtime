/**
 * LangChain/LangGraph Framework Runtime
 * 
 * Provides LangChain.js and LangGraph.js integration.
 * USES NEW COMPONENT ARCHITECTURE:
 * - src/agent/graph.ts: StateGraph definition
 * - src/agent/tools.ts: Tool factories
 * - src/agent/callbacks.ts: Memory middleware (backed by src/memory/*)
 * - src/agent/checkpoint.ts: Persistence
 */

import { ChatOpenAI } from "@langchain/openai";
import { HumanMessage, type BaseMessage } from "@langchain/core/messages";
import type { AgentWallet } from "../agent-wallet.js";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import fs from "fs";
import path from "path";

// New Modules
import { createAgentGraph } from "../agent/graph.js";
import { createAgentTools } from "../agent/tools.js";
import { Mem0CallbackHandler } from "../agent/callbacks.js";
import { runWithAgentExecutionContext } from "../agent/context.js";
import { requireApiInternalToken, requireApiInternalUrl } from "../auth.js";
import {
  AgentMemoryTracker,
  extractTokens,
  resolveAuthoritativeTokens,
} from "./langsmith.js";

// =============================================================================
// Helpers
// =============================================================================

/**
 * Check if a model ID is a Google/Gemini model
 */
function isGeminiModel(modelId: string): boolean {
  const lowerId = modelId.toLowerCase();
  return lowerId.startsWith("gemini") || lowerId.includes("gemini");
}

/**
 * Fetch a URL and convert it to a base64 data URL
 * Required for Google/Gemini models which don't accept HTTP URLs for images
 */
async function fetchUrlAsDataUrl(url: string): Promise<string> {
  console.log(`[LangChain] Fetching URL for base64 conversion: ${url.slice(0, 60)}...`);
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to fetch URL ${url}: ${response.status}`);
  }

  // Get MIME type from content-type header or infer from URL
  let mimeType = response.headers.get("content-type") || "image/png";
  // Clean up MIME type (remove charset etc)
  mimeType = mimeType.split(";")[0].trim();

  const buffer = Buffer.from(await response.arrayBuffer());
  const base64 = buffer.toString("base64");

  console.log(`[LangChain] Converted to data URL (${mimeType}, ${buffer.length} bytes)`);
  return `data:${mimeType};base64,${base64}`;
}

// =============================================================================
// Types
// =============================================================================

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
  grantedPermissions?: string[];
  permissionPolicy?: Record<string, "allow" | "ask" | "deny">;
  backpackAccounts?: BackpackConnectedAccount[];
}

export interface AgentConfig {
  name: string;
  agentWallet: string; // Wallet address - ONLY identifier
  wallet?: AgentWallet;
  chainId?: number;    // Chain ID context
  model?: string;
  temperature?: number;
  systemPrompt?: string;
  memory?: boolean;
  plugins?: string[];
  // Identity Context
  userId?: string;    // The user interacting with the agent
  workflowWallet?: string; // The orchestrating Workflow's wallet address (if any)
  sessionContext?: AgentSessionContext;  // Session for payment + execution authority
}


export interface AgentInstance {
  id: string;
  name: string;
  executor: any; // CompiledStateGraph
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

type StreamUsageTotals = {
  promptTokens: number;
  completionTokens: number;
  reasoningTokens: number;
  totalTokens: number;
};

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

  if (sessionContext) {
    lines.push("Execution context:");
    lines.push(`- Session active: ${sessionContext.sessionActive ? "yes" : "no"}`);
    lines.push(`- Session budget remaining: ${sessionContext.sessionBudgetRemaining}`);

    if (sessionContext.grantedPermissions?.length) {
      lines.push(`- Local authority grants: ${sessionContext.grantedPermissions.join(", ")}`);
    }

    const connectedAccounts = (sessionContext.backpackAccounts || []).filter((account) => account.connected);
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

  return lines.length > 0 ? lines.join("\n") : undefined;
}

export interface LangChainStatus {
  ready: boolean;
  framework: "langchain";
  version: "0.4.0 (Modular)";
  agentCount: number;
}

const agents = new Map<string, AgentInstance>();

// =============================================================================
// Model Factory - Lambda Gateway Routing
// ALL chat/text inference is routed through Lambda (/v1/chat/completions).
// =============================================================================

/**
 * Create a LangChain chat model routed through Lambda gateway.
 * Lambda owns provider routing, policy, and x402 settlement surfaces.
 */
export function createModel(modelName: string, temperature: number = 0.7): BaseChatModel {
  const baseURL = `${requireApiInternalUrl()}/v1`;
  console.log(`[LangChain] Creating model: ${modelName} via lambda gateway (${baseURL})`);

  return new ChatOpenAI({
    modelName,
    temperature,
    configuration: {
      baseURL,
      apiKey: requireApiInternalToken(),
    },
    verbose: true,
  });
}

// =============================================================================
// Agent Lifecycle
// =============================================================================

export async function createAgent(config: AgentConfig): Promise<AgentInstance> {
  // Model MUST be provided - it's read from on-chain during agent registration
  if (!config.model) {
    throw new Error("Agent model is required - should be set from on-chain metadata");
  }

  // Use wallet address as the stable, unique identifier
  const id = config.agentWallet;

  //  1. Prepare Tools from on-chain plugins (GOAT + MCP + Eliza via Compose Runtime)
  const composeTools = await createAgentTools(
    config.plugins || [],
    config.wallet,
    () => config.sessionContext,  // Read the latest session context at tool execution time
    undefined,              // executionContext
    config.chainId,         // Pass chainId context
    config.userId,
  );
  const tools = [...composeTools];


  // 2. Prepare Model - use model from on-chain metadata via Lambda gateway
  const model = createModel(config.model, config.temperature ?? 0.7);

  // 3. Prepare Checkpoint Directory
  const checkpointDir = path.resolve(process.cwd(), "data", "checkpoints");

  // 4. Compile Graph
  const app = createAgentGraph(model, tools, checkpointDir, config.systemPrompt, () => buildDynamicSystemContext(config));

  const instance: AgentInstance = {
    id,
    name: config.name,
    executor: app,
    config,
    tools
  };

  agents.set(id, instance);
  console.log(`[LangChain] Created agent ${config.name} (${id}) with model ${config.model} and ${tools.length} tools`);
  return instance;
}

export function getAgent(id: string) { return agents.get(id); }
export function listAgents() { return Array.from(agents.values()); }
export function deleteAgent(id: string) { return agents.delete(id); }
export function getStatus(): LangChainStatus {
  return {
    ready: true,
    framework: "langchain",
    version: "0.4.0 (Modular)",
    agentCount: agents.size
  };
}

// =============================================================================
// Execution
// =============================================================================

export interface ExecuteOptions {
  threadId?: string;
  userId?: string;
  workflowWallet?: string;
  attachment?: { type: "image" | "audio" | "video"; url: string };  // For vision models
  sessionContext?: AgentSessionContext;
  composeRunId?: string; // Optional: for Temporal workflow correlation
}


export async function executeAgent(
  agentWallet: string,
  message: string,
  options: ExecuteOptions = {}
): Promise<ExecutionResult> {
  const agent = agents.get(agentWallet);
  if (!agent) throw new Error(`Agent ${agentWallet} not found`);

  const opts = options;

  const threadId = opts.threadId || `thread-${agentWallet}`;
  const userId = opts.userId;
  const workflowWallet = opts.workflowWallet;

  const start = Date.now();

  try {
    // Update session context in config (but don't recreate tools - they're already bound)
    // Session context is passed through headers during tool execution, not via recreation
    if (opts.sessionContext && agent.config) {
      agent.config.sessionContext = opts.sessionContext;
      // Tools are created once during createAgent() and cached in agent.tools
      // Recreating them on every message causes repeated MCP spawns → looping
    }

    // Setup Callbacks (Mem0) with full identity context
    const mem0Handler = new Mem0CallbackHandler(
      agentWallet,
      threadId,
      userId,
      workflowWallet,
      opts.composeRunId,
    );
    const usageTracker = new AgentMemoryTracker(agentWallet, threadId);

    // Create message - use multipart content if attachment is provided (for vision/audio models)
    let humanMessage: HumanMessage;
    if (opts.attachment?.url) {
      const contentParts: any[] = [{ type: "text", text: message }];

      if (opts.attachment.type === "image") {
        console.log(`[LangChain] Including image attachment: ${opts.attachment.url.slice(0, 60)}...`);
        // Gemini models require base64 data URLs, not HTTP URLs
        const modelId = agent.config.model || "";
        if (isGeminiModel(modelId)) {
          const dataUrl = await fetchUrlAsDataUrl(opts.attachment.url);
          contentParts.push({ type: "image_url", image_url: { url: dataUrl } });
        } else {
          contentParts.push({ type: "image_url", image_url: { url: opts.attachment.url } });
        }
      } else if (opts.attachment.type === "audio") {
        console.log(`[LangChain] Including audio attachment: ${opts.attachment.url.slice(0, 60)}...`);
        // Use input_audio format for audio-capable models
        contentParts.push({ type: "input_audio", input_audio: { url: opts.attachment.url } });
      } else if (opts.attachment.type === "video") {
        console.log(`[LangChain] Including video attachment: ${opts.attachment.url.slice(0, 60)}...`);
        // Some vision models can process video frames - use similar format to image
        contentParts.push({ type: "video_url", video_url: { url: opts.attachment.url } });
      }

      humanMessage = new HumanMessage({ content: contentParts });
    } else {
      humanMessage = new HumanMessage(message);
    }

    const input = { messages: [humanMessage] };

    // Dynamic recursion limit from environment (default: 100, max: 500)
    // Allows agents freedom to operate without arbitrary constraints
    const maxRecursionLimit = Math.min(
      parseInt(process.env.MAX_AGENT_RECURSION_DEPTH || "100", 10),
      500 // Hard ceiling for safety
    );

    const config = {
      configurable: {
        thread_id: threadId,
        recursionDepth: 0, // Track depth for smart stop logic
        maxRecursionDepth: maxRecursionLimit,
        startTime: Date.now(), // Track execution time
      },
      callbacks: [mem0Handler, usageTracker],
      recursionLimit: maxRecursionLimit,
    };

    // Invoke
    console.log(`[LangChain] Invoking agent ${agentWallet} (Thread: ${threadId}, User: ${userId || 'anon'}, Workflow: ${workflowWallet || 'none'})...`);
    const result = await runWithAgentExecutionContext(
      {
        composeRunId: opts.composeRunId,
        threadId,
        agentWallet,
        userId,
        workflowWallet,
      },
      async () => {
        return await agent.executor.invoke(input, config);
      },
    );

    // Parse Result
    const messages = result.messages || [];
    const lastMsg = messages[messages.length - 1];
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

    // Handle different content formats (Gemini returns content as array of parts, OpenAI as string)
    let output = "";
    if (lastMsg?.content) {
      if (typeof lastMsg.content === "string") {
        output = lastMsg.content;
      } else if (Array.isArray(lastMsg.content)) {
        // Gemini/multimodal format: array of { type: "text", text: "..." } parts
        output = lastMsg.content
          .map((part: any) => {
            if (typeof part === "string") return part;
            if (part.type === "text") return part.text;
            if (part.text) return part.text;
            return JSON.stringify(part);
          })
          .join("");
      } else if (typeof lastMsg.content === "object") {
        // Fallback: stringify the object
        output = JSON.stringify(lastMsg.content);
      }
    }

    console.log(`[LangChain] Finished in ${Date.now() - start}ms. Output: ${output.substring(0, 100)}...`);

    // Also fix message content parsing for the response
    return {
      success: true,
      messages: messages.map((m: any) => {
        let content = "";
        if (typeof m.content === "string") {
          content = m.content;
        } else if (Array.isArray(m.content)) {
          content = m.content
            .map((part: any) => {
              if (typeof part === "string") return part;
              if (part.type === "text") return part.text;
              if (part.text) return part.text;
              return JSON.stringify(part);
            })
            .join("");
        } else if (m.content) {
          content = JSON.stringify(m.content);
        }
        return { role: m._getType?.() || "unknown", content };
      }),
      output,
      usage: {
        prompt_tokens: extractedTokens.inputTokens,
        completion_tokens: extractedTokens.outputTokens,
        total_tokens: extractedTokens.totalTokens,
      },
      promptTokens: extractedTokens.inputTokens,
      completionTokens: extractedTokens.outputTokens,
      executionTime: Date.now() - start
    };

  } catch (err: any) {
    console.error("Execution failed:", err);
    return {
      success: false,
      messages: [],
      error: err.message,
      executionTime: Date.now() - start
    };
  }
}

// -----------------------------------------------------------------------------
// Streaming Implementation
// -----------------------------------------------------------------------------

/**
 * Stream agent execution using LangGraph streamEvents (v2)
 * Yields OpenAI-compatible chunks for seamless frontend integration.
 * Wraps <think>, <invoke> etc. in content deltas.
 */
export async function* streamAgent(
  agentWallet: string,
  message: string,
  options?: ExecuteOptions
): AsyncGenerator<any> {
  const agent = agents.get(agentWallet);
  if (!agent) throw new Error(`Agent ${agentWallet} not found`);

  const opts: ExecuteOptions = options || {};
  const tId = opts.threadId || `thread-${agentWallet}`;
  const userId = opts.userId;
  const workflowWallet = opts.workflowWallet;

  // Update session context if provided
  if (opts.sessionContext && agent.config) {
    agent.config.sessionContext = opts.sessionContext;
  }

  // Setup Callbacks (Mem0) with full identity context
  const mem0Handler = new Mem0CallbackHandler(
    agentWallet,
    tId,
    userId,
    workflowWallet,
    opts.composeRunId,
  );

  // Create message - use multipart content if attachment is provided
  let humanMessage: HumanMessage;
  if (opts.attachment?.url) {
    const contentParts: any[] = [{ type: "text", text: message }];

    if (opts.attachment.type === "image") {
      console.log(`[LangChain Stream] Including image attachment: ${opts.attachment.url.slice(0, 60)}...`);
      // Gemini models require base64 data URLs, not HTTP URLs
      const modelId = agent.config.model || "";
      if (isGeminiModel(modelId)) {
        const dataUrl = await fetchUrlAsDataUrl(opts.attachment.url);
        contentParts.push({ type: "image_url", image_url: { url: dataUrl } });
      } else {
        contentParts.push({ type: "image_url", image_url: { url: opts.attachment.url } });
      }
    } else if (opts.attachment.type === "audio") {
      console.log(`[LangChain Stream] Including audio attachment: ${opts.attachment.url.slice(0, 60)}...`);
      contentParts.push({ type: "input_audio", input_audio: { url: opts.attachment.url } });
    } else if (opts.attachment.type === "video") {
      console.log(`[LangChain Stream] Including video attachment: ${opts.attachment.url.slice(0, 60)}...`);
      contentParts.push({ type: "video_url", video_url: { url: opts.attachment.url } });
    }

    humanMessage = new HumanMessage({ content: contentParts });
  } else {
    humanMessage = new HumanMessage(message);
  }

  const input = { messages: [humanMessage] };

  // Dynamic recursion limit from environment (default: 100, max: 500)
  const maxRecursionLimit = Math.min(
    parseInt(process.env.MAX_AGENT_RECURSION_DEPTH || "100", 10),
    500
  );

  const config = {
    configurable: {
      thread_id: tId,
      recursionDepth: 0,
      maxRecursionDepth: maxRecursionLimit,
      startTime: Date.now(),
    },
    callbacks: [mem0Handler],
    recursionLimit: maxRecursionLimit,
    version: "v2" as const // Use v2 streaming (streamEvents)
  };

  console.log(`[LangChain] Streaming agent ${agentWallet} (Thread: ${tId}, User: ${userId || 'anon'}, Workflow: ${workflowWallet || 'none'})...`);

  // Helper to create OpenAI-style chunk
  const createChunk = (content: string) => ({
    choices: [{ delta: { content } }]
  });

  const usageTotals = createEmptyStreamUsageTotals();

  try {
    // Use streamEvents to get fine-gained events (tokens, tool start/end)
    const eventStream = await runWithAgentExecutionContext(
      {
        composeRunId: opts.composeRunId,
        threadId: tId,
        agentWallet,
        userId,
        workflowWallet,
      },
      async () => {
        return await agent.executor.streamEvents(input, config);
      },
    );

    for await (const event of eventStream) {
      const eventType = event.event;

      // 1. Text Streaming (LLM generation)
      if (eventType === "on_chat_model_stream") {
        const chunk = event.data?.chunk;
        // LangChain chunk is BaseMessageChunk
        if (chunk && chunk.content) {
          let text = "";
          if (typeof chunk.content === "string") {
            text = chunk.content;
          } else if (Array.isArray(chunk.content)) {
            // Handle multimodal content parts if any
            text = chunk.content
              .map((c: any) => c.type === "text" ? c.text : "")
              .join("");
          }

          if (text) {
            yield createChunk(text);
          }
        }
      }

      else if (eventType === "on_chat_model_end") {
        const tokens = extractTokens(event.data?.output ?? event.data);
        if (tokens.totalTokens > 0) {
          usageTotals.promptTokens += tokens.inputTokens;
          usageTotals.completionTokens += tokens.outputTokens;
          usageTotals.reasoningTokens += tokens.reasoningTokens;
          usageTotals.totalTokens += tokens.totalTokens;
        }
      }

      // 2. Tool Start -> <invoke> tag
      else if (eventType === "on_tool_start") {
        const toolName = event.name;
        const toolInput = event.data?.input; // Arguments

        // Ignore internal tools if desired, but usually we want to show everything
        // Note: Mem0 tools might be noisy, but let's show them for now or filter if needed?
        // "search_memory", "save_memory" are user-facing enough.

        let paramBlock = "";
        if (toolInput && typeof toolInput === "object") {
          for (const [key, value] of Object.entries(toolInput)) {
            const valStr = typeof value === "string" ? value : JSON.stringify(value);
            paramBlock += `<${key}>${valStr}</${key}>\n`;
          }
        }

        const invokeBlock = `\n<invoke>\n${toolName}\n${paramBlock}</invoke>\n`;
        yield {
          type: "tool_start",
          toolName,
          input: toolInput,
          content: invokeBlock,
        };
      }

      // 3. Tool End -> (Optional) 
      else if (eventType === "on_tool_end") {
        yield {
          type: "tool_end",
          toolName: event.name,
          output: event.data?.output,
        };
      }

      // 4. Chain Start (Thinking?)
    }

    if (usageTotals.totalTokens <= 0) {
      throw new Error("authoritative stream usage is required");
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

  } catch (err: any) {
    console.error("Streaming failed:", err);
    yield createChunk(`\n\n[System Error: ${err.message}]\n`);
  }
}
