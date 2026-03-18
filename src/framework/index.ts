/**
 * Framework Module
 *
 * `manowar` is the single runtime surface for agent execution.
 * It subsumes the old LangChain/OpenClaw split while preserving
 * agent-card framework metadata for registration and UX.
 */

export * as manowar from "./manowar.js";
export * as runtime from "./runtime.js";

export type FrameworkType = "eliza" | "langchain" | "openclaw";

export interface FrameworkInfo {
  id: FrameworkType;
  name: string;
  description: string;
  features: string[];
  status: "active" | "coming_soon";
}

export const FRAMEWORKS: FrameworkInfo[] = [
  {
    id: "eliza",
    name: "ElizaOS",
    description: "Agent framework with 200+ plugins for blockchain, social, AI, and more",
    features: ["200+ plugins", "Natural language actions", "Multi-chain support", "Social integrations"],
    status: "active",
  },
  {
    id: "langchain",
    name: "LangChain",
    description: "LangGraph-backed agent runtime surfaced through Manowar",
    features: ["LangGraph agents", "Built-in memory", "RAG support", "Tool calling"],
    status: "active",
  },
  {
    id: "openclaw",
    name: "OpenClaw",
    description: "Continuous skills-first runtime surfaced through Manowar",
    features: ["Infinite memory", "800+ connectors access", "Web access", "Self-learning"],
    status: "active",
  },
];

/**
 * Get framework info by ID
 */
export function getFramework(id: FrameworkType): FrameworkInfo | undefined {
  return FRAMEWORKS.find((f) => f.id === id);
}

/**
 * List all available frameworks
 */
export function listFrameworks(): FrameworkInfo[] {
  return FRAMEWORKS;
}
