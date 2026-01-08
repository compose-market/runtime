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
  agentWallet: string; // Wallet address - ONLY identifier
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
// Model Factory - Direct Provider Routing (like legacy)
// LangChain agents call providers directly for proper tool-calling support.
// Lambda is only used for multimodal inference and model registry, NOT chat.
// =============================================================================

const LAMBDA_API_URL = process.env.LAMBDA_API_URL || "https://api.compose.market";

interface ProviderConfig {
  baseURL: string;
  apiKeyEnv: string;
  source: string;
}

/**
 * Infer provider configuration from model ID.
 * Routes to the correct provider API based on model name patterns.
 */
function inferProviderConfig(modelId: string): ProviderConfig {
  const lowerId = modelId.toLowerCase();

  // Google/Gemini models
  if (lowerId.startsWith("gemini") || lowerId.includes("gemini")) {
    return {
      baseURL: "https://generativelanguage.googleapis.com/v1beta",
      apiKeyEnv: "GOOGLE_GENERATIVE_AI_API_KEY",
      source: "google"
    };
  }

  // OpenAI models
  if (lowerId.startsWith("gpt") || lowerId.startsWith("o1") || lowerId.startsWith("o3") || lowerId.includes("openai")) {
    return {
      baseURL: "https://api.openai.com/v1",
      apiKeyEnv: "OPENAI_API_KEY",
      source: "openai"
    };
  }

  // Anthropic models
  if (lowerId.startsWith("claude") || lowerId.includes("anthropic")) {
    return {
      baseURL: "https://api.anthropic.com/v1",
      apiKeyEnv: "ANTHROPIC_API_KEY",
      source: "anthropic"
    };
  }

  // ASI Cloud models
  if (lowerId.startsWith("asi1-mini") || lowerId.startsWith("google/gemma") ||
    lowerId.startsWith("meta-llama/") || lowerId.startsWith("mistralai/") ||
    lowerId.startsWith("qwen/")) {
    return {
      baseURL: "https://inference.asicloud.cudos.org/v1",
      apiKeyEnv: "ASI_INFERENCE_API_KEY",
      source: "asi-cloud"
    };
  }

  // ASI One models
  if (lowerId.startsWith("asi1-")) {
    return {
      baseURL: "https://api.asi1.ai/v1",
      apiKeyEnv: "ASI_ONE_API_KEY",
      source: "asi-one"
    };
  }

  // AI/ML API models (e.g., gpt-image-1, flux models)
  // These typically have specific model naming from aimlapi.com catalog
  if (lowerId.includes("flux") && !lowerId.includes("huggingface")) {
    return {
      baseURL: "https://api.aimlapi.com/v1",
      apiKeyEnv: "AI_ML_API_KEY",
      source: "aiml"
    };
  }

  // OpenRouter models - identified by org/model pattern
  // Common patterns: nvidia/, moonshotai/, allenai/, minimax/, arcee-ai/, nex-agi/, etc.
  // Most coordinator models use OpenRouter for access to diverse model providers
  const openRouterPatterns = [
    "nvidia/", "moonshotai/", "allenai/", "minimax/", "arcee-ai/", "nex-agi/",
    "deepseek/", "cohere/", "perplexity/", "fireworks/", "together/",
    "01-ai/", "x-ai/", "cognitivecomputations/", "sao10k/", "neversleep/",
    "sophosympatheia/", "pygmalionai/", "recursal/", "undi95/", "gryphe/",
    ":free", ":extended"  // OpenRouter free/extended tier suffixes
  ];
  if (openRouterPatterns.some(p => lowerId.includes(p))) {
    return {
      baseURL: "https://openrouter.ai/api/v1",
      apiKeyEnv: "OPEN_ROUTER_API_KEY",
      source: "openrouter"
    };
  }

  // Default: HuggingFace router
  return {
    baseURL: "https://router.huggingface.co/v1",
    apiKeyEnv: "HUGGING_FACE_INFERENCE_TOKEN",
    source: "huggingface"
  };
}

/**
 * Create a LangChain chat model that routes DIRECTLY to the provider.
 * This is required for proper tool-calling support - Lambda's OpenAI-compatible
 * endpoint doesn't handle the multi-turn tool conversation format.
 * 
 * For Gemini: Uses ChatGoogleGenerativeAI which handles Gemini's native format.
 * For others: Uses ChatOpenAI pointing directly to provider API.
 */
export function createModel(modelName: string, temperature: number = 0.7): BaseChatModel {
  const config = inferProviderConfig(modelName);
  const apiKey = process.env[config.apiKeyEnv] || "";

  console.log(`[LangChain] Creating model: ${modelName} via ${config.source} (${config.baseURL})`);

  // Use ChatGoogleGenerativeAI for Gemini - it handles Gemini's function calling format natively
  if (config.source === "google") {
    return new ChatGoogleGenerativeAI({
      model: modelName,
      temperature,
      apiKey,
      // Required for proper system message handling
      convertSystemMessageToHumanContent: true,
    });
  }

  // For all other providers, use ChatOpenAI pointing directly to provider API
  return new ChatOpenAI({
    modelName,
    temperature,
    configuration: {
      baseURL: config.baseURL,
      apiKey
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
  agentWallet: string,
  message: string,
  options: string | ExecuteOptions = {} // Backwards compatibility: if string, it's threadId
): Promise<ExecutionResult> {
  const agent = agents.get(agentWallet);
  if (!agent) throw new Error(`Agent ${agentWallet} not found`);

  // Normalize options
  const opts: ExecuteOptions = typeof options === "string" ? { threadId: options } : options;

  const threadId = opts.threadId || `thread-${agentWallet}`;
  const userId = opts.userId;
  const manowarWallet = opts.manowarWallet;

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
    const mem0Handler = new Mem0CallbackHandler(agentWallet, threadId, userId, manowarWallet);

    const input = { messages: [new HumanMessage(message)] };
    const config = {
      configurable: { thread_id: threadId },
      callbacks: [mem0Handler],
      recursionLimit: 50, // Increase from default 25 for multi-tool tasks
    };

    // Invoke
    console.log(`[LangChain] Invoking agent ${agentWallet} (Thread: ${threadId}, User: ${userId || 'anon'}, Manowar: ${manowarWallet || 'none'})...`);
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
  const manowarWallet = opts.manowarWallet;

  // Update session context if provided
  if (opts.sessionContext && agent.config) {
    agent.config.sessionContext = opts.sessionContext;
  }

  // Setup Callbacks (Mem0) with full identity context
  const mem0Handler = new Mem0CallbackHandler(agentWallet, tId, userId, manowarWallet);

  const input = { messages: [new HumanMessage(message)] };
  const config = {
    configurable: { thread_id: tId },
    callbacks: [mem0Handler],
    recursionLimit: 50,
    version: "v2" as const // Use v2 streaming (streamEvents)
  };

  console.log(`[LangChain] Streaming agent ${agentWallet} (Thread: ${tId}, User: ${userId || 'anon'}, Manowar: ${manowarWallet || 'none'})...`);

  // Helper to create OpenAI-style chunk
  const createChunk = (content: string) => ({
    choices: [{ delta: { content } }]
  });

  try {
    // Use streamEvents to get fine-gained events (tokens, tool start/end)
    const eventStream = await agent.executor.streamEvents(input, config);

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
        yield createChunk(invokeBlock);
      }

      // 3. Tool End -> (Optional) 
      else if (eventType === "on_tool_end") {
        // output is in event.data.output
      }

      // 4. Chain Start (Thinking?)
    }

  } catch (err: any) {
    console.error("Streaming failed:", err);
    yield createChunk(`\n\n[System Error: ${err.message}]\n`);
  }
}
