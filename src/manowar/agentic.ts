/**
 * Agentic Coordinator Models
 * 
 * Curated selection of models optimized for multi-agent workflows.
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
 */
export const coordinatorModels: AgenticModel[] = [
    {
        id: "nvidia/nemotron-3-nano-30b-a3b:free",
        name: "Nemotron 3 Nano 30B",
        provider: "nvidia",
        contextLength: 128000,
        activeParams: "30B",
        keyStrength: "Multi-step tool orchestration, RAG, reasoning",
        description: "Post-trained for agentic workflows with SFT across math, code, and science.",
    },
    {
        id: "moonshotai/kimi-k2-thinking",
        name: "Kimi K2 Thinking",
        provider: "moonshotai",
        contextLength: 256000,
        activeParams: "32B",
        keyStrength: "200-300 sequential tool calls, long-horizon reasoning",
        description: "Advanced agentic capabilities with tool-use learning.",
    },
    {
        id: "minimax/minimax-m2.1",
        name: "MiniMax M2.1",
        provider: "minimax",
        contextLength: 4000000,
        activeParams: "45.9B",
        keyStrength: "Interleaved Thinking (plan→act→reflect), 4M context",
        description: "Agentic-first design with dynamic Plan→Act→Reflect loop.",
    },
    {
        id: "nex-agi/deepseek-v3.1-nex-n1:free",
        name: "DeepSeek V3.1 Nex N1",
        provider: "nex-agi",
        contextLength: 164000,
        activeParams: "~10B",
        keyStrength: "Autonomous operation, tool adherence",
        description: "Post-trained for agent autonomy and real-world productivity.",
    },
    {
        id: "allenai/olmo-3.1-32b-think:free",
        name: "OLMo 3.1 Think 32B",
        provider: "allenai",
        contextLength: 128000,
        activeParams: "32B",
        keyStrength: "Fully open, long chain-of-thought reasoning",
        description: "Ai2's strongest fully open reasoning model.",
    },
    {
        id: "arcee-ai/trinity-mini:free",
        name: "Arcee Trinity Mini",
        provider: "arcee-ai",
        contextLength: 128000,
        activeParams: "~7B",
        keyStrength: "Fast, cost-effective, versatile",
        description: "Compact model for quick agent coordination tasks.",
    },
];

/**
 * Get a specific agentic model by ID
 */
export function getAgenticModel(modelId: string): AgenticModel | undefined {
    return coordinatorModels.find(m => m.id === modelId);
}

/**
 * Get all agentic coordinator model IDs
 */
export function getAgenticModelIds(): string[] {
    return coordinatorModels.map(m => m.id);
}

/**
 * Check if a model ID is an approved agentic coordinator model
 */
export function isAgenticCoordinatorModel(modelId: string): boolean {
    return coordinatorModels.some(m => m.id === modelId);
}

/**
 * Get default coordinator model (returns null - must be set by user)
 */
export function getDefaultCoordinatorModel(): string | null {
    return null;
}
