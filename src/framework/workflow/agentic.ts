export interface AgenticModel {
    modelId: string;
}

export const COORDINATOR_MODEL_IDS = [
    "nvidia/nemotron-3-nano-30b-a3b",
    "moonshotai/kimi-k2-thinking",
    "minimax/minimax-m2.1",
    "nex-agi/deepseek-v3.1-nex-n1",
    "allenai/olmo-3.1-32b-think",
] as const;

export const coordinatorModels: AgenticModel[] = COORDINATOR_MODEL_IDS.map((modelId) => ({ modelId }));

export function getAgenticModel(modelId: string): AgenticModel | undefined {
    return coordinatorModels.find((model) => model.modelId === modelId);
}

export function getAgenticModelIds(): string[] {
    return [...COORDINATOR_MODEL_IDS];
}

export function isAgenticCoordinatorModel(modelId: string): boolean {
    return COORDINATOR_MODEL_IDS.includes(modelId as (typeof COORDINATOR_MODEL_IDS)[number]);
}

export function getDefaultCoordinatorModel(): string | null {
    return null;
}
