/**
 * Framework Module
 * `manowar` is the single runtime surface for agent execution.
 */

export * as manowar from "./manowar.js";
export * as knowledge from "./knowledge/index.js";
export * as runtime from "./runtime.js";

export type FrameworkType = "manowar";

export interface FrameworkInfo {
  id: FrameworkType;
  name: string;
  description: string;
  features: string[];
  status: "active" | "coming_soon";
}

export const FRAMEWORKS: FrameworkInfo[] = [
  {
    id: "manowar",
    name: "Manowar",
    description: "Unified runtime for agent execution across chat, streaming, mesh, and skills",
    features: ["Unified execution", "Built-in memory", "Tool calling", "Mesh integration"],
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
