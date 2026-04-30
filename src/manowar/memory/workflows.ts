import { AGENT_MEMORY_WORKFLOW_VERSION } from "./agent-loop.js";

export interface MemoryWorkflowStepManifest {
    operationId: string;
    method: "GET" | "POST" | "PATCH" | "DELETE";
    path: string;
    purpose: string;
}

export interface MemoryWorkflowManifest {
    id: string;
    version: typeof AGENT_MEMORY_WORKFLOW_VERSION;
    description: string;
    loop: "hot" | "durable" | "maintenance";
    tokenPolicy: "returns compact prompt only" | "returns metadata only";
    steps: MemoryWorkflowStepManifest[];
}

const MEMORY_WORKFLOW_MANIFESTS: MemoryWorkflowManifest[] = [
    {
        id: "agent_memory_loop",
        version: AGENT_MEMORY_WORKFLOW_VERSION,
        description: "Canonical pre-turn retrieval, post-turn recording, and durable fact capture loop.",
        loop: "hot",
        tokenPolicy: "returns compact prompt only",
        steps: [
            {
                operationId: "assembleAgentMemoryContext",
                method: "POST",
                path: "/api/memory/context/assemble",
                purpose: "Retrieve compact working, scene, graph, pattern, archive, and vector context before an agent turn.",
            },
            {
                operationId: "recordAgentMemoryTurn",
                method: "POST",
                path: "/api/memory/turns/record",
                purpose: "Persist transcript, update working memory, and index turn evidence after an agent turn.",
            },
            {
                operationId: "rememberAgentMemory",
                method: "POST",
                path: "/api/memory/remember",
                purpose: "Store an explicit durable fact, preference, rule, or operational note.",
            },
        ],
    },
    {
        id: "memory_maintenance_loop",
        version: AGENT_MEMORY_WORKFLOW_VERSION,
        description: "Consolidate duplicates, extract reusable patterns, archive cold memory, and refresh decay scores.",
        loop: "maintenance",
        tokenPolicy: "returns metadata only",
        steps: [
            {
                operationId: "createMemoryJob",
                method: "POST",
                path: "/api/memory/jobs",
                purpose: "Start targeted memory maintenance without exposing internal Temporal implementation details.",
            },
            {
                operationId: "getMemoryJob",
                method: "GET",
                path: "/api/memory/jobs/{jobId}",
                purpose: "Read maintenance status and summary output.",
            },
        ],
    },
    {
        id: "memory_pattern_loop",
        version: AGENT_MEMORY_WORKFLOW_VERSION,
        description: "Extract, validate, and promote recurring tool or decision patterns into learned skills.",
        loop: "durable",
        tokenPolicy: "returns metadata only",
        steps: [
            {
                operationId: "listMemoryPatterns",
                method: "GET",
                path: "/api/memory/patterns",
                purpose: "Discover high-signal procedural patterns by agent and success rate.",
            },
            {
                operationId: "validateMemoryPattern",
                method: "POST",
                path: "/api/memory/patterns/{patternId}/validate",
                purpose: "Validate frequency and success evidence before promotion.",
            },
            {
                operationId: "promoteMemoryPattern",
                method: "POST",
                path: "/api/memory/patterns/{patternId}/promote",
                purpose: "Convert a validated pattern into an executable learned skill document.",
            },
        ],
    },
    {
        id: "memory_archive_loop",
        version: AGENT_MEMORY_WORKFLOW_VERSION,
        description: "Compress long transcripts and sync cold archives without adding raw history to the live context.",
        loop: "durable",
        tokenPolicy: "returns metadata only",
        steps: [
            {
                operationId: "compressMemorySession",
                method: "POST",
                path: "/api/memory/sessions/{sessionId}/compress",
                purpose: "Extract compact summary and entities from long transcripts.",
            },
            {
                operationId: "syncMemoryArchive",
                method: "POST",
                path: "/api/memory/archives/{archiveId}/sync",
                purpose: "Pin a memory archive to durable external storage.",
            },
        ],
    },
];

export function getMemoryWorkflowManifests(): MemoryWorkflowManifest[] {
    return MEMORY_WORKFLOW_MANIFESTS.map((workflow) => ({
        ...workflow,
        steps: workflow.steps.map((step) => ({ ...step })),
    }));
}

export function getMemoryWorkflowManifest(id: string): MemoryWorkflowManifest | null {
    return getMemoryWorkflowManifests().find((workflow) => workflow.id === id) ?? null;
}
