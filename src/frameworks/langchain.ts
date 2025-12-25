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
import { ChatGoogleGenerativeAI } from "@langchain/google-genai";
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
  manowarId?: string; // The workflow context (if any)
  sessionContext?: {  // Session for payment
    sessionActive: boolean;
    sessionBudgetRemaining: number;
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
// Model Factory - Uses shared/models.ts logic for dynamic provider routing
// =============================================================================

// =============================================================================
// Model Factory - Dynamic Registry Access (Lambda Gateway)
// =============================================================================

const LAMBDA_API_URL = process.env.LAMBDA_API_URL || "https://api.compose.market";

interface RemoteModelConfig {
  baseURL: string;
  apiKeyEnv?: string;
  source: string;
}

// Cache for model configs to avoid hitting Lambda on every request
const modelConfigCache = new Map<string, RemoteModelConfig>();

async function fetchModelConfig(modelId: string): Promise<RemoteModelConfig> {
  if (modelConfigCache.has(modelId)) {
    return modelConfigCache.get(modelId)!;
  }

  try {
    const response = await fetch(`${LAMBDA_API_URL}/api/registry/model/${encodeURIComponent(modelId)}`);
    if (!response.ok) {
      console.warn(`[LangChain] Failed to fetch model config for ${modelId}: ${response.status} ${response.statusText}`);
      // Fallback logic (local heuristics) if API fails
      return inferLocalConfig(modelId);
    }

    const data = await response.json();

    // Map source to specific provider configuration
    let baseURL = "https://router.huggingface.co/v1";
    let apiKeyEnv = "HUGGING_FACE_INFERENCE_TOKEN";

    switch (data.source) {
      case "asi-cloud":
        baseURL = "https://inference.asicloud.cudos.org/v1";
        apiKeyEnv = "ASI_INFERENCE_API_KEY";
        break;
      case "asi-one":
        baseURL = "https://api.asi1.ai/v1";
        apiKeyEnv = "ASI_ONE_API_KEY";
        break;
      case "openai":
        baseURL = "https://api.openai.com/v1";
        apiKeyEnv = "OPENAI_API_KEY";
        break;
      case "anthropic":
        baseURL = "https://api.anthropic.com/v1";
        apiKeyEnv = "ANTHROPIC_API_KEY";
        break;
      case "google":
        baseURL = "https://generativelanguage.googleapis.com/v1beta";
        apiKeyEnv = "GOOGLE_GENERATIVE_AI_API_KEY";
        break;
    }

    const config = { baseURL, apiKeyEnv, source: data.source };
    modelConfigCache.set(modelId, config);
    return config;
  } catch (error) {
    console.warn(`[LangChain] Error fetching model config:`, error);
    return inferLocalConfig(modelId);
  }
}

function inferLocalConfig(modelId: string): RemoteModelConfig {
  if (modelId.startsWith("asi1-mini") || modelId.startsWith("google/gemma") || modelId.startsWith("meta-llama/") || modelId.startsWith("mistralai/") || modelId.startsWith("qwen/")) {
    return { baseURL: "https://inference.asicloud.cudos.org/v1", apiKeyEnv: "ASI_INFERENCE_API_KEY", source: "asi-cloud" };
  } else if (modelId.startsWith("asi1-")) {
    return { baseURL: "https://api.asi1.ai/v1", apiKeyEnv: "ASI_ONE_API_KEY", source: "asi-one" };
  } else if (modelId.startsWith("gpt")) {
    return { baseURL: "https://api.openai.com/v1", apiKeyEnv: "OPENAI_API_KEY", source: "openai" };
  } else if (modelId.startsWith("claude")) {
    return { baseURL: "https://api.anthropic.com/v1", apiKeyEnv: "ANTHROPIC_API_KEY", source: "anthropic" };
  } else if (modelId.startsWith("gemini")) {
    return { baseURL: "https://generativelanguage.googleapis.com/v1beta", apiKeyEnv: "GOOGLE_GENERATIVE_AI_API_KEY", source: "google" };
  }
  return { baseURL: "https://router.huggingface.co/v1", apiKeyEnv: "HUGGING_FACE_INFERENCE_TOKEN", source: "huggingface" };
}

export function createModel(modelName: string, temperature: number = 0.7): BaseChatModel {

  const config = inferLocalConfig(modelName);
  const apiKey = process.env[config.apiKeyEnv || ""] || "";

  // Use ChatGoogleGenerativeAI for Gemini models - it properly handles Gemini's function calling format
  if (config.source === "google") {
    console.log(`[LangChain] Creating Gemini model: ${modelName}`);
    return new ChatGoogleGenerativeAI({
      model: modelName,
      temperature,
      apiKey,
      // Gemini-specific options for better tool calling
      convertSystemMessageToHumanContent: true,
    });
  }

  const modelKwargs: any = {};

  // Force strict mode for ASI Cloud to enable reliable tool calling
  if (config.source === "asi-cloud") {
    // Legacy behavior: do not enforce strict mode
    // modelKwargs.strict = true;
  }

  return new ChatOpenAI({
    modelName,
    temperature,
    configuration: { baseURL: config.baseURL, apiKey },
    verbose: true,
    modelKwargs
  });
}

// Async version to be used in createAgent
export async function createModelAsync(modelName: string, temperature: number = 0.7): Promise<BaseChatModel> {
  const config = await fetchModelConfig(modelName);
  const apiKey = process.env[config.apiKeyEnv || ""] || "";

  // Use ChatGoogleGenerativeAI for Gemini models - it properly handles Gemini's function calling format
  if (config.source === "google") {
    console.log(`[LangChain] Creating Gemini model (async): ${modelName}`);
    return new ChatGoogleGenerativeAI({
      model: modelName,
      temperature,
      apiKey,
      convertSystemMessageToHumanContent: true,
    });
  }

  const modelKwargs: any = {};
  if (config.source === "asi-cloud") {
    // Legacy behavior: do not enforce strict mode
    // modelKwargs.strict = true;
  }

  return new ChatOpenAI({
    modelName,
    temperature,
    configuration: { baseURL: config.baseURL, apiKey },
    verbose: true,
    modelKwargs
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
  const memTools = createMem0Tools(id, config.userId, config.manowarId);
  const tools = [...composeTools, ...memTools];


  // 2. Prepare Model - use model from on-chain metadata (NO FALLBACKS)
  // Use async factory to fetch dynamic config from Lambda
  const model = await createModelAsync(config.model, config.temperature ?? 0.7);

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
  manowarId?: string;
  sessionContext?: {
    sessionActive: boolean;
    sessionBudgetRemaining: number;
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
  const manowarId = opts.manowarId;

  const start = Date.now();

  try {
    // Update agent config with session context if provided
    if (opts.sessionContext && agent.config) {
      agent.config.sessionContext = opts.sessionContext;
      // Recreate tools with session context
      const composeTools = await createAgentTools(
        agent.config.plugins || [],
        agent.config.wallet,
        opts.sessionContext
      );
      const memTools = createMem0Tools(agentId, opts.userId, opts.manowarId);
      agent.tools = [...composeTools, ...memTools];
    }

    // Setup Callbacks (Mem0) with full identity context
    const mem0Handler = new Mem0CallbackHandler(agentId, threadId, userId, manowarId);

    const input = { messages: [new HumanMessage(message)] };
    const config = {
      configurable: { thread_id: threadId },
      callbacks: [mem0Handler]
    };

    // Invoke
    console.log(`[LangChain] Invoking agent ${agentId} (Thread: ${threadId}, User: ${userId || 'anon'}, Manowar: ${manowarId || 'none'})...`);
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
