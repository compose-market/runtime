/**
 * Frameworks Module
 * 
 * Exports all framework runtimes:
 * - ElizaOS: Agent framework with plugins
 * - LangChain: LLM application framework with LangGraph
 * - OpenClaw: Skills-based agent with infinite memory + Backpack
 * - Runtime: Unified agent/workflow registry (consolidated from agent-registry + workflow-registry)
 */

export * as langchain from "./langchain.js";
export * as openclaw from "./openclaw.js";
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
    description: "LLM application framework with LangGraph for building stateful agents",
    features: ["LangGraph agents", "Built-in memory", "RAG support", "Tool calling"],
    status: "active",
  },
  {
    id: "openclaw",
    name: "OpenClaw",
    description: "Skills-based agent with infinite memory, web access, and Backpack connectors",
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
