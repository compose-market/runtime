/**
 * LangChain/LangGraph Framework Runtime
 * 
 * Provides LangChain.js and LangGraph.js integration.
 * USES NEW COMPONENT ARCHITECTURE:
 * - src/agent/graph.ts: StateGraph definition
 * - src/agent/tools.ts: Tool factories
 * - src/agent/callbacks.ts: Mem0 middleware
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
import { createAgentTools, createMem0Tools } from "../agent/tools.js";
import { Mem0CallbackHandler } from "../agent/callbacks.js";

// =============================================================================
// Types
// =============================================================================

export interface AgentConfig {
  name: string;
  agentId?: number | bigint;
  wallet?: AgentWallet;
  model?: string;
  temperature?: number;
  systemPrompt?: string;
  memory?: boolean;
  plugins?: string[];
  // Identity Context
  userId?: string;    // The user interacting with the agent
  manowarWallet?: string; // The orchestrating Manowar's wallet address (if any)
  sessionContext?: {  // Session for payment
    sessionActive: boolean;
    sessionBudgetRemaining: number;
    grantedPermissions?: string[];
  };
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
  error?: string;
  executionTime: number;
}

export interface LangChainStatus {
  ready: boolean;
  framework: "langchain";
  version: "0.4.0 (Modular)";
  agentCount: number;
}

const agents = new Map<string, AgentInstance>();

// =============================================================================
// Model Factory - Route ALL models through Lambda Gateway
// =============================================================================

const LAMBDA_API_URL = process.env.LAMBDA_API_URL || "https://api.compose.market";

// Set in .env
function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} environment variable is required`);
  }
  return value;
}

// Internal secret for bypassing x402 payment on Lambda API (for nested Manowar calls)
const MANOWAR_INTERNAL_SECRET = requireEnv("MANOWAR_INTERNAL_SECRET");

/**
 * Create a LangChain chat model that routes through Lambda API gateway.
 * Lambda handles all provider routing, API keys, and response formatting.
 * 
 * Uses x-manowar-internal header to bypass x402 payment since Manowar
 * already verified payment at the agent chat endpoint level.
 */
export function createModel(modelName: string, temperature: number = 0.7): BaseChatModel {
  console.log(`[LangChain] Creating model via Lambda gateway: ${modelName}`);

  return new ChatOpenAI({
    modelName,
    temperature,
    configuration: {
      baseURL: `${LAMBDA_API_URL}/v1`,
      defaultHeaders: {
        // Bypass x402 payment for internal LLM calls - payment was already verified
        // at the Manowar agent chat endpoint level
        "x-manowar-internal": MANOWAR_INTERNAL_SECRET,
      },
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

  // Use stable ID if provided (preferred for persistence), otherwise generate random
  const id = config.agentId
    ? String(config.agentId)
    : `agent-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;

  //  1. Prepare Tools from on-chain plugins (GOAT + MCP + Eliza via Compose Runtime)
  const composeTools = await createAgentTools(
    config.plugins || [],
    config.wallet,
    config.sessionContext  // Pass session context for tool execution
  );
  const memTools = createMem0Tools(id, config.userId, config.manowarWallet);
  const tools = [...composeTools, ...memTools];


  // 2. Prepare Model - use model from on-chain metadata via Lambda gateway
  const model = createModel(config.model, config.temperature ?? 0.7);

  // 3. Prepare Checkpoint Directory
  const checkpointDir = path.resolve(process.cwd(), "data", "checkpoints");

  // 4. Compile Graph
  const app = createAgentGraph(model, tools, checkpointDir, config.systemPrompt);

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
  manowarWallet?: string;
  sessionContext?: {
    sessionActive: boolean;
    sessionBudgetRemaining: number;
    grantedPermissions?: string[];
  };
}


export async function executeAgent(
  agentId: string,
  message: string,
  options: string | ExecuteOptions = {} // Backwards compatibility: if string, it's threadId
): Promise<ExecutionResult> {
  const agent = agents.get(agentId);
  if (!agent) throw new Error(`Agent ${agentId} not found`);

  // Normalize options
  const opts: ExecuteOptions = typeof options === "string" ? { threadId: options } : options;

  const threadId = opts.threadId || `thread-${agentId}`;
  const userId = opts.userId;
  const manowarWallet = opts.manowarWallet;

  const start = Date.now();

  try {
    // Update session context in config (but DON'T recreate tools - they're already bound)
    // Session context is passed through headers during tool execution, not via recreation
    if (opts.sessionContext && agent.config) {
      agent.config.sessionContext = opts.sessionContext;
      // Tools are created once during createAgent() and cached in agent.tools
      // Recreating them on every message causes repeated MCP spawns → looping
    }

    // Setup Callbacks (Mem0) with full identity context
    const mem0Handler = new Mem0CallbackHandler(agentId, threadId, userId, manowarWallet);

    const input = { messages: [new HumanMessage(message)] };
    const config = {
      configurable: { thread_id: threadId },
      callbacks: [mem0Handler],
      recursionLimit: 50, // Increase from default 25 for multi-tool tasks
    };

    // Invoke
    console.log(`[LangChain] Invoking agent ${agentId} (Thread: ${threadId}, User: ${userId || 'anon'}, Manowar: ${manowarWallet || 'none'})...`);
    const result = await agent.executor.invoke(input, config);

    // Parse Result
    const messages = result.messages || [];
    const lastMsg = messages[messages.length - 1];

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

// Stub for streamAgent if needed - explicitly not implemented fully yet as per plan focus on specific features
// but we leave a placeholder to avoid breaking imports
export async function* streamAgent(agentId: string, message: string, threadId?: string): AsyncGenerator<any> {
  yield { type: "error", content: "Streaming not yet refactored in modular update." };
}
