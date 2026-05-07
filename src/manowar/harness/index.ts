/**
 * Compose Agent Loop (cal) — public harness surface.
 *
 * Phase 1 (sub-agent harness):
 *   runSubAgent / runParallel / runIsolatedSubAgent / runCalPlan
 *
 * Phase 2 (discovery + dynamic coordinators):
 *   searchTools / searchAgents / searchModels
 *   listAgenticCoordinators / isAgenticCoordinatorModel
 *
 * Phase 3 (durability + agent-only swarms):
 *   createCalCheckpointStore — step-by-step Redis checkpoints
 *   isRegisteredAgent / ensureRegisteredAgent — agent-fabric enforcement
 *
 * Scratchpad exposes a per-run note store backed by Redis.
 */
export * from "./types.js";
export { runSubAgent, type RunSubAgentOptions, type ResolveToolsContext } from "./engine.js";
export { runParallel, type ParallelInput, type ParallelOutput, type GatherMode } from "./parallel.js";
export { runIsolatedSubAgent } from "./sandbox.js";
export {
    runCalPlan,
    parseCalPlan,
    CalValidationError,
    type InterpreterContext,
} from "./interpreter.js";
export { createScratchpad } from "./scratchpad.js";
export {
    createConclaveBus,
    type ConclaveBus,
    type ConclaveEntry,
} from "./conclave.js";
export {
    createCalCheckpointStore,
    type CalCheckpoint,
    type CalCheckpointStore,
} from "./checkpoint.js";
export {
    canonicalJson,
    createProofAccumulator,
    hashValue,
    pinProofBundleToIPFS,
    signProofBundle,
    type ProofAccumulator,
    type ProofBundle,
    type ProofSandboxMetadata,
    type ProofStepRecord,
} from "./proof.js";
export {
    isRegisteredAgent,
    ensureRegisteredAgent,
    clearAgentRegistryCache,
    UnregisteredAgentError,
} from "./registry.js";
export {
    searchTools,
    searchAgents,
    searchModels,
    type ToolSearchHit,
    type AgentSearchHit,
    type ModelSearchHit,
} from "./discovery.js";
export {
    listAgenticCoordinators,
    isAgenticCoordinatorModel,
    clearCoordinatorCache,
    type CoordinatorModel,
} from "./coordinators.js";
