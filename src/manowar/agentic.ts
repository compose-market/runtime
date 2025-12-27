/**
 * Agentic Coordinator Models
 * 
 * Curated selection of models optimized for multi-agent workflows, tool-calling,
 * and coordinator responsibilities. These models are specifically designed for:
 * - Multi-step tool orchestration
 * - Long-horizon reasoning (200-300+ sequential tool calls)
 * - Interleaved Thinking (plan → act → reflect)
 * - Autonomous operation with tool adherence
 * 
 * Model IDs verified against the project's normalized registry in models.json
 */

export interface AgenticModel {
    id: string;
    name: string;
    provider: string;
    contextLength: number;
    activeParams: string;
    keyStrength: string;
    description: string;
}

/**
 * Curated list of agentic coordinator models
 * IDs match the normalized format from models.ts after deduplication
 */
export const AGENTIC_COORDINATOR_MODELS: AgenticModel[] = [
    {
        id: "nvidia/llama-3.3-nemotron-super-49b-v1.5",
        name: "Nemotron Super 49B",
        provider: "nvidia",
        contextLength: 128000,
        activeParams: "49B",
        keyStrength: "Multi-step tool orchestration, RAG, reasoning",
        description: "Post-trained for agentic workflows with SFT across math, code, and science. Uses RPO, RLVR, and DPO for tool-use refinement.",
    },
    {
        id: "moonshotai/kimi-k2-thinking",
        name: "Kimi K2 Thinking",
        provider: "moonshotai",
        contextLength: 256000,
        activeParams: "32B",
        keyStrength: "200-300 sequential tool calls, long-horizon reasoning",
        description: "Advanced agentic capabilities with tool-use learning and general RL. Auto-comprehends tool usage without workflow scripting.",
    },
    {
        id: "minimax/minimax-m2.1",
        name: "MiniMax M2.1",
        provider: "minimax",
        contextLength: 4000000,
        activeParams: "45.9B",
        keyStrength: "Interleaved Thinking (plan→act→reflect), 4M context",
        description: "Agentic-first design with dynamic Plan→Act→Reflect loop. Leading multilingual coding and versatile agent brain for IDEs.",
    },
    {
        id: "nex-agi/deepseek-v3.1-nex-n1:free",
        name: "DeepSeek V3.1 Nex N1",
        provider: "nex-agi",
        contextLength: 164000,
        activeParams: "~10B",
        keyStrength: "Autonomous operation, tool adherence, practical coding",
        description: "Post-trained for agent autonomy, tool use, and real-world productivity. Strong in coding and HTML generation.",
    },
    {
        id: "allenai/olmo-3.1-32b-think:free",
        name: "OLMo 3.1 Think 32B",
        provider: "allenai",
        contextLength: 128000,
        activeParams: "32B",
        keyStrength: "Fully open, long chain-of-thought reasoning",
        description: "Ai2's strongest fully open reasoning model. Excels in math, logic, and instruction-following with tool use support.",
    },
    {
        id: "arcee-ai/trinity-mini:free",
        name: "Arcee Trinity Mini",
        provider: "arcee-ai",
        contextLength: 128000,
        activeParams: "~7B",
        keyStrength: "Fast, cost-effective, versatile",
        description: "Compact but capable model for quick agent coordination tasks. Optimized for low-latency responses.",
    },
];

/**
 * Get a specific agentic model by ID
 */
export function getAgenticModel(modelId: string): AgenticModel | undefined {
    return AGENTIC_COORDINATOR_MODELS.find(m => m.id === modelId);
}

/**
 * Get all agentic coordinator model IDs
 */
export function getAgenticModelIds(): string[] {
    return AGENTIC_COORDINATOR_MODELS.map(m => m.id);
}

/**
 * Check if a model ID is an approved agentic coordinator model
 */
export function isAgenticCoordinatorModel(modelId: string): boolean {
    return AGENTIC_COORDINATOR_MODELS.some(m => m.id === modelId);
}

/**
 * Get the default coordinator model (highest capability)
 */
export function getDefaultCoordinatorModel(): string {
    // MiniMax M2.1 as default due to largest context and Interleaved Thinking
    return "minimax/minimax-m2.1";
}

// =============================================================================
// Context Sub-Agent Definitions
// =============================================================================

export type ContextAgentRole =
    | "note_taker"
    | "window_tracker"
    | "mem0_optimizer"
    | "memory_wipe"
    | "summarizer"
    | "tool_boxer"
    | "evaluator"
    | "reviewer";

export interface ContextSubAgent {
    role: ContextAgentRole;
    name: string;
    description: string;
    activatesOn: "always" | "continuous-loop-only" | "threshold" | "loop-boundary";
}

/**
 * Specialized sub-agents for the context management workflow
 */
export const CONTEXT_SUB_AGENTS: ContextSubAgent[] = [
    {
        role: "note_taker",
        name: "NoteTaker",
        description: "Tracks every token input/output per-agent per-action. Compiles checkpoints for each action.",
        activatesOn: "always",
    },
    {
        role: "window_tracker",
        name: "WindowTracker",
        description: "Maintains knowledge of every model's context window specs. Provides MECW calculations.",
        activatesOn: "always",
    },
    {
        role: "mem0_optimizer",
        name: "Mem0GraphOptimizer",
        description: "Extracts entities and relationships for semantic graph memory. Enables cross-context linking.",
        activatesOn: "always",
    },
    {
        role: "memory_wipe",
        name: "MemoryWipe",
        description: "Triggers cleanup when approaching context limit for each agent. Preserves critical messages.",
        activatesOn: "threshold",
    },
    {
        role: "summarizer",
        name: "Summarizer",
        description: "Intelligently summarizes goal, actions, and outcomes within current workflow execution (not historical).",
        activatesOn: "threshold",
    },
    {
        role: "tool_boxer",
        name: "ToolBoxer",
        description: "Access to 16K+ unified capabilities from registry.ts. Recommends optimal MCP/tool for each task.",
        activatesOn: "always",
    },
    // Continuous-loop-only agents (activated only in multi-loop workflows)
    {
        role: "evaluator",
        name: "Evaluator",
        description: "End-of-loop agent. Evaluates performance and adherence to initial scope. Proposes improvements for next execution.",
        activatesOn: "continuous-loop-only",
    },
    {
        role: "reviewer",
        name: "Reviewer",
        description: "Start-of-loop agent (loop 2+). Reviews previous Evaluator's suggestions. Decides how to efficiently incorporate improvements.",
        activatesOn: "continuous-loop-only",
    },
];

/**
 * Get sub-agents that should be active based on workflow type
 */
export function getActiveSubAgents(isContinuousLoop: boolean): ContextSubAgent[] {
    if (isContinuousLoop) {
        return CONTEXT_SUB_AGENTS;
    }
    return CONTEXT_SUB_AGENTS.filter(a => a.activatesOn !== "continuous-loop-only");
}
