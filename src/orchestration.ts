/**
 * Runtime Orchestration Routes
 *
 * Registers agent/workflow/memory orchestration routes on the top-level runtime server.
 */
import "dotenv/config";
import type { Request, Response, NextFunction } from "express";
import agentRoutes from "./agent-routes.js";
import {
    WORKFLOW_PRICES,
    type Workflow,
    type PaymentContext,
} from "./manowar/workflow/index.js";
import {
    cancelWorkflowRun,
    createComposeRunId,
    executeWorkflowRun,
    getWorkflowRunState,
    sanitizeExecutorOptions,
    signalStepApproval,
    startWorkflowRun,
    TemporalRunNotFoundError,
} from "./temporal/service.js";
import {
    parseTriggerFromNL,
    retrieveTriggers,
    storeTrigger,
    deleteTriggerFromMemory,
    registerTrigger,
    unregisterTrigger,
} from "./manowar/workflow/triggers.js";
import {
    getTemporalWorkerRuntimeStatus,
    isTemporalWorkerReady,
    startWorkflowTemporalWorkers,
} from "./temporal/worker.js";
import {
    ensureRegisteredWorkflowByWallet,
    markWorkflowExecuted,
    resolveAgent,
} from "./manowar/runtime.js";
import type { WorkflowStep, TriggerDefinition } from "./manowar/workflow/types.js";
import {
    addMemory as addGraphMemory,
    AgentMemoryInputError,
    assembleAgentMemoryContext,
    cleanupExpiredMemories,
    compressSession,
    consolidateAgentMemories,
    createMemoryArchive,
    deleteMemoryItem,
    extractExecutionPatterns,
    getEmbedding,
    getAllMemories,
    getLearnedSkill,
    getMemoryItem,
    getMemoryVectorsCollection,
    getMemoryStats,
    getMemoryWorkflowManifest,
    getMemoryWorkflowManifests,
    getProceduralPattern,
    getTranscriptBySessionId,
    getTranscriptByThreadId,
    getWorkingSessionMemory,
    hybridVectorSearch,
    indexSessionTranscript,
    indexMemoryContent,
    indexVector,
    listActiveMemoryAgentWallets,
    listLearnedSkills,
    listProceduralPatterns,
    normalizeAgentMemoryScope,
    promotePatternToSkill,
    recordAgentMemoryTurn,
    rerankDocuments,
    rememberAgentMemory,
    resolveMemoryConflict,
    runMemoryEval,
    runAgentMemoryLoop,
    searchMemory as searchGraphMemory,
    searchMemoryLayers,
    searchVectors,
    storeTranscript,
    syncArchiveToPinata,
    updateWorkingSessionMemory,
    updateMemoryItem,
    updateMemoryDecayScores,
    validateExtractedPattern,
} from "./manowar/memory/index.js";
import {
    getMemoryJob,
    runMemoryMaintenanceJob,
} from "./temporal/memory/service.js";
import {
    createMemorySchedules,
    deleteMemorySchedules,
    getMemoryScheduleStatus,
    pauseMemorySchedule,
    resumeMemorySchedule,
    triggerMemorySchedule,
} from "./temporal/memory/schedules.js";
import { extractRuntimeSessionHeaders, isRuntimeInternalRequest } from "./auth.js";
import {
    indexWorkspaceDocuments,
    normalizeKnowledgeLimit,
    normalizeWorkspaceDocuments,
    searchWorkspaceDocuments,
} from "./manowar/knowledge/index.js";

const activeRunIds = new Map<string, string>();
const SSE_HEARTBEAT_INTERVAL_MS = 10000;
const SSE_POLL_INTERVAL_MS = 1000;
const SSE_STATE_MISS_LIMIT = 8;
const SSE_POLL_TIMEOUT_MS = 5 * 60 * 1000;

function buildWorkflowFromWorkflow(workflow: {
    walletAddress: string;
    chainId: number;
    title?: string;
    description?: string;
    agentWalletAddresses?: string[];
}): Workflow {
    const steps: WorkflowStep[] = [];
    for (const agentWallet of (workflow.agentWalletAddresses || [])) {
        const agent = resolveAgent(agentWallet);
        steps.push({
            id: `agent-${agentWallet.slice(0, 8)}`,
            name: agent?.name || `Agent ${agentWallet.slice(0, 8)}`,
            type: "agent",
            agentAddress: agentWallet,
            // Pass the chainId to ensure tools use the correct chain
            chainId: workflow.chainId,
            inputTemplate: {
                agentAddress: agentWallet,
                agentCardUri: agent?.agentCardUri,
                chainId: workflow.chainId,
            },
            saveAs: `agent_${agentWallet.slice(0, 8)}_output`,
        });
    }

    return {
        id: `workflow-${workflow.walletAddress}`,
        name: workflow.title || `Workflow ${workflow.walletAddress.slice(0, 8)}`,
        description: workflow.description || "",
        steps,
        chainId: workflow.chainId,
    };
}

// Error handling wrapper
function asyncHandler(
    fn: (req: Request, res: Response, next: NextFunction) => Promise<void>
) {
    return (req: Request, res: Response, next: NextFunction) => {
        fn(req, res, next).catch(next);
    };
}

async function sendAgentMemoryJson<T>(res: Response, action: () => Promise<T>): Promise<void> {
    try {
        res.json(await action());
    } catch (error) {
        if (error instanceof AgentMemoryInputError) {
            res.status(error.statusCode).json({ error: error.message });
            return;
        }
        throw error;
    }
}

/**
 * Helper to extract string from route params (Express v5 types them as string | string[])
 */
function getParam(value: string | string[] | undefined): string {
    if (Array.isArray(value)) return value[0] || "";
    return value || "";
}

function getStringList(value: unknown): string[] {
    if (Array.isArray(value)) {
        return value.filter((item): item is string => typeof item === "string").flatMap((item) => item.split(","));
    }
    return typeof value === "string" ? value.split(",") : [];
}

type RouteRegistrar = {
    use: (...args: any[]) => unknown;
    get: (...args: any[]) => unknown;
    post: (...args: any[]) => unknown;
    put: (...args: any[]) => unknown;
    patch: (...args: any[]) => unknown;
    delete: (...args: any[]) => unknown;
};

export function registerWorkspaceRoutes(app: Pick<RouteRegistrar, "post">): void {
    app.post("/api/workspace/index", asyncHandler(async (req: Request, res: Response) => {
        const runtimeSession = extractRuntimeSessionHeaders(req);
        const agentWallet = typeof req.body?.agentWallet === "string" ? req.body.agentWallet.trim() : "";
        const documents = normalizeWorkspaceDocuments(req.body?.documents);

        if (!runtimeSession.sessionActive || !runtimeSession.sessionUserAddress) {
            res.status(401).json({ error: "An active session is required for workspace access" });
            return;
        }

        if (!agentWallet || documents.length === 0) {
            res.status(400).json({ error: "agentWallet and documents are required" });
            return;
        }

        const result = await indexWorkspaceDocuments({
            agentWallet,
            userAddress: runtimeSession.sessionUserAddress,
            documents,
        });
        res.json(result);
    }));

    app.post("/api/workspace/search", asyncHandler(async (req: Request, res: Response) => {
        const runtimeSession = extractRuntimeSessionHeaders(req);
        const agentWallet = typeof req.body?.agentWallet === "string" ? req.body.agentWallet.trim() : "";
        const query = typeof req.body?.query === "string" ? req.body.query.trim() : "";
        const limit = normalizeKnowledgeLimit(req.body?.limit);

        if (!runtimeSession.sessionActive || !runtimeSession.sessionUserAddress) {
            res.status(401).json({ error: "An active session is required for workspace access" });
            return;
        }

        if (!agentWallet || !query) {
            res.status(400).json({ error: "agentWallet and query are required" });
            return;
        }

        const results = await searchWorkspaceDocuments({
            agentWallet,
            userAddress: runtimeSession.sessionUserAddress,
            query,
            limit,
        });
        res.json({ results });
    }));
}

export function registerOrchestrationRoutes(app: RouteRegistrar): void {
    app.use("/agent", agentRoutes);

    // ============================================================================
    // Health Check
    // ============================================================================

    app.get("/health", asyncHandler(async (_req: Request, res: Response) => {
        const temporalStatus = getTemporalWorkerRuntimeStatus();
        const pollerTotal = Object.values(temporalStatus.pollers).reduce((sum, count) => sum + count, 0);
        res.json({
            status: "ok",
            timestamp: new Date().toISOString(),
            service: "workflow-orchestration",
            version: "0.1.0",
            temporal: {
                state: temporalStatus.state,
                error: temporalStatus.error,
                ready: temporalStatus.ready,
                pollers: temporalStatus.pollers,
                pollerTotal,
                deployment: temporalStatus.deployment,
            },
        });
    }));

    // ============================================================================
    // Workflow Routes (Workflow Orchestration)
    // ============================================================================

    app.post("/workflow/execute", asyncHandler(async (req: Request, res: Response) => {
        const { payload } = req.body;
        const walletAddress = String(payload.walletAddress || payload.id);
        const registeredWorkflow = await ensureRegisteredWorkflowByWallet(walletAddress);

        if (!registeredWorkflow) {
            res.status(404).json({ error: `Workflow "${walletAddress}" not found` });
            return;
        }

        console.log(`[workflow] Executing workflow: ${registeredWorkflow.title} (${registeredWorkflow.walletAddress})`);

        // Build workflow from registry data using the helper
        const builtWorkflow = buildWorkflowFromWorkflow(registeredWorkflow);
        console.log(`[workflow] Built ${builtWorkflow.steps.length} agent steps from wallets: [${registeredWorkflow.agentWalletAddresses?.join(", ") || "none"}]`);

        const runtimeSession = extractRuntimeSessionHeaders(req);
        // Prepare payment context
        const paymentContext: PaymentContext = {
            paymentData: null,
            sessionActive: runtimeSession.sessionActive,
            sessionBudgetRemaining: runtimeSession.sessionBudgetRemaining,
            resourceUrlBase: `${req.protocol}://${req.get("host")}`,
            userAddress: runtimeSession.sessionUserAddress,
        };

        // Execute workflow with orchestrator
        const userMessage = typeof payload.input === "string"
            ? payload.input
            : payload.input?.message || payload.message || "Execute workflow";
        const requestedThreadId =
            typeof payload.threadId === "string"
                ? payload.threadId
                : typeof payload.input?.threadId === "string"
                    ? payload.input.threadId
                    : undefined;

        if (!isTemporalReady()) {
            const temporalStatus = getTemporalWorkerRuntimeStatus();
            res.status(503).json({
                error: "Temporal worker deployment is not ready",
                temporal: temporalStatus,
            });
            return;
        }

        const runId = createComposeRunId();
        try {
            const result = await executeWorkflowRun(
                registeredWorkflow.walletAddress,
                builtWorkflow,
                userMessage,
                sanitizeExecutorOptions({
                    payment: paymentContext,
                    coordinatorModel: registeredWorkflow.coordinatorModel,
                    workflowCardUri: registeredWorkflow.workflowCardUri,
                    userAddress: runtimeSession.sessionUserAddress,
                    threadId: requestedThreadId,
                    workflowWallet: registeredWorkflow.walletAddress,
                }),
                runId,
            );

            // Mark as executed
            markWorkflowExecuted(registeredWorkflow.walletAddress);
            res.json(result);
        } catch (error) {
            throw error;
        }
    }));

    app.get("/workflow/prices", (_req: Request, res: Response) => {
        res.json({
            ORCHESTRATION: WORKFLOW_PRICES.ORCHESTRATION,
            AGENT_STEP: WORKFLOW_PRICES.AGENT_STEP,
            INFERENCE: WORKFLOW_PRICES.INFERENCE,
            MCP_TOOL: WORKFLOW_PRICES.MCP_TOOL,
        });
    });

    // ============================================================================
    // Trigger Routes (parse, list, create, update, delete)
    // ============================================================================

    app.post("/api/workflow/triggers/parse", asyncHandler(async (req: Request, res: Response) => {
        const { nlDescription } = req.body || {};
        if (!nlDescription) {
            res.status(400).json({ error: "nlDescription is required" });
            return;
        }
        const parsed = await parseTriggerFromNL(nlDescription);
        if (!parsed.success) {
            res.status(400).json({ error: parsed.error || "Could not parse schedule" });
            return;
        }
        res.json({ cronExpression: parsed.cronExpression, cronReadable: parsed.cronReadable });
    }));

    app.get("/api/workflow/:walletAddress/triggers", asyncHandler(async (req: Request, res: Response) => {
        const workflowWallet = getParam(req.params.walletAddress);
        const userAddress = req.headers["x-session-user-address"] as string | undefined;
        const triggers = await retrieveTriggers(workflowWallet, userAddress);
        res.json({ triggers });
    }));

    app.post("/api/workflow/:walletAddress/triggers", asyncHandler(async (req: Request, res: Response) => {
        const workflowWallet = getParam(req.params.walletAddress);
        const userAddress = req.headers["x-session-user-address"] as string | undefined;
        const trigger = req.body as TriggerDefinition;
        if (!trigger?.id || !trigger?.name || !trigger?.type) {
            res.status(400).json({ error: "Invalid trigger payload" });
            return;
        }
        trigger.workflowWallet = workflowWallet;
        const memoryId = await storeTrigger(trigger, userAddress);
        trigger.memoryId = memoryId || trigger.memoryId;

        if (trigger.enabled && trigger.cronExpression) {
            await registerTrigger(trigger, async () => {
                return;
            });
        }

        res.json(trigger);
    }));

    app.put("/api/workflow/:walletAddress/triggers/:triggerId", asyncHandler(async (req: Request, res: Response) => {
        const workflowWallet = getParam(req.params.walletAddress);
        const triggerId = getParam(req.params.triggerId);
        const userAddress = req.headers["x-session-user-address"] as string | undefined;
        const updates = req.body as Partial<TriggerDefinition>;

        const triggers = await retrieveTriggers(workflowWallet, userAddress);
        const existing = triggers.find(t => t.id === triggerId);
        if (!existing) {
            res.status(404).json({ error: "Trigger not found" });
            return;
        }

        const updated: TriggerDefinition = { ...existing, ...updates, id: triggerId, workflowWallet };
        await deleteTriggerFromMemory(triggerId, workflowWallet, userAddress);
        const memoryId = await storeTrigger(updated, userAddress);
        updated.memoryId = memoryId || updated.memoryId;

        if (updated.enabled && updated.cronExpression) {
            await registerTrigger(updated, async () => {
                return;
            });
        } else {
            await unregisterTrigger(triggerId, workflowWallet);
        }

        res.json(updated);
    }));

    app.delete("/api/workflow/:walletAddress/triggers/:triggerId", asyncHandler(async (req: Request, res: Response) => {
        const workflowWallet = getParam(req.params.walletAddress);
        const triggerId = getParam(req.params.triggerId);
        const userAddress = req.headers["x-session-user-address"] as string | undefined;
        const ok = await deleteTriggerFromMemory(triggerId, workflowWallet, userAddress);
        res.json({ success: ok });
    }));

    // ============================================================================
    // Memory Routes (Workflow Local Authority)
    // ============================================================================

    app.post("/api/memory/context/assemble", asyncHandler(async (req: Request, res: Response) => {
        await sendAgentMemoryJson(res, async () => assembleAgentMemoryContext(req.body));
    }));

    app.post("/api/memory/turns/record", asyncHandler(async (req: Request, res: Response) => {
        await sendAgentMemoryJson(res, async () => recordAgentMemoryTurn(req.body));
    }));

    app.post("/api/memory/remember", asyncHandler(async (req: Request, res: Response) => {
        await sendAgentMemoryJson(res, async () => rememberAgentMemory(req.body));
    }));

    app.post("/api/memory/loop", asyncHandler(async (req: Request, res: Response) => {
        await sendAgentMemoryJson(res, async () => runAgentMemoryLoop(req.body));
    }));

    app.get("/api/memory/workflows", asyncHandler(async (_req: Request, res: Response) => {
        res.json({ workflows: getMemoryWorkflowManifests() });
    }));

    app.get("/api/memory/workflows/:workflowId", asyncHandler(async (req: Request, res: Response) => {
        const workflowId = getParam(req.params.workflowId);
        const workflow = getMemoryWorkflowManifest(workflowId);
        if (!workflow) {
            res.status(404).json({ error: "Memory workflow not found" });
            return;
        }
        res.json({ workflow });
    }));

    app.get("/api/memory/patterns", asyncHandler(async (req: Request, res: Response) => {
        const patternType = typeof req.query.patternType === "string"
            && ["workflow", "decision", "response", "tool_sequence"].includes(req.query.patternType)
            ? req.query.patternType as "workflow" | "decision" | "response" | "tool_sequence"
            : undefined;
        const result = await listProceduralPatterns({
            agentWallet: typeof req.query.agentWallet === "string" ? req.query.agentWallet : undefined,
            patternType,
            minSuccessRate: typeof req.query.minSuccessRate === "string" ? Number(req.query.minSuccessRate) : undefined,
            limit: typeof req.query.limit === "string" ? Number(req.query.limit) : undefined,
        });
        res.json(result);
    }));

    app.get("/api/memory/patterns/:patternId", asyncHandler(async (req: Request, res: Response) => {
        const patternId = getParam(req.params.patternId);
        const result = await getProceduralPattern({
            patternId,
            agentWallet: typeof req.query.agentWallet === "string" ? req.query.agentWallet : undefined,
        });
        if (!result.pattern) {
            res.status(404).json({ error: "Memory pattern not found" });
            return;
        }
        res.json(result);
    }));

    app.post("/api/memory/patterns/:patternId/validate", asyncHandler(async (req: Request, res: Response) => {
        const patternId = getParam(req.params.patternId);
        const result = await validateExtractedPattern({ patternId });
        res.json(result);
    }));

    app.post("/api/memory/patterns/:patternId/promote", asyncHandler(async (req: Request, res: Response) => {
        const patternId = getParam(req.params.patternId);
        const { skillName, validationData } = req.body || {};
        if (typeof skillName !== "string" || !validationData) {
            res.status(400).json({ error: "skillName and validationData are required" });
            return;
        }
        const result = await promotePatternToSkill({ patternId, skillName, validationData });
        res.json(result);
    }));

    app.get("/api/memory/skills", asyncHandler(async (req: Request, res: Response) => {
        const result = await listLearnedSkills({
            agentWallet: typeof req.query.agentWallet === "string" ? req.query.agentWallet : undefined,
            category: typeof req.query.category === "string" ? req.query.category : undefined,
            limit: typeof req.query.limit === "string" ? Number(req.query.limit) : undefined,
        });
        res.json(result);
    }));

    app.get("/api/memory/skills/:skillId", asyncHandler(async (req: Request, res: Response) => {
        const skillId = getParam(req.params.skillId);
        const result = await getLearnedSkill({
            skillId,
            agentWallet: typeof req.query.agentWallet === "string" ? req.query.agentWallet : undefined,
        });
        if (!result.skill) {
            res.status(404).json({ error: "Memory skill not found" });
            return;
        }
        res.json(result);
    }));

    app.post("/api/memory/transcripts/index", asyncHandler(async (req: Request, res: Response) => {
        const { sessionId, threadId, agentWallet, userAddress, mode, haiId, messages, modelUsed, model, totalTokens, tokenCount, rememberWorkingMemory } = req.body || {};
        if (typeof sessionId !== "string" || typeof threadId !== "string" || typeof agentWallet !== "string" || !Array.isArray(messages)) {
            res.status(400).json({ error: "sessionId, threadId, agentWallet, and messages are required" });
            return;
        }
        const result = await indexSessionTranscript({
            sessionId,
            threadId,
            agentWallet,
            userAddress,
            mode,
            haiId,
            messages,
            modelUsed: typeof modelUsed === "string" ? modelUsed : typeof model === "string" ? model : "unknown",
            totalTokens: typeof totalTokens === "number" ? totalTokens : typeof tokenCount === "number" ? tokenCount : 0,
            rememberWorkingMemory: rememberWorkingMemory !== false,
        });
        res.json(result);
    }));

    app.get("/api/memory/sessions/:sessionId/working", asyncHandler(async (req: Request, res: Response) => {
        const sessionId = getParam(req.params.sessionId);
        const agentWallet = typeof req.query.agentWallet === "string" ? req.query.agentWallet : undefined;
        if (!agentWallet) {
            res.status(400).json({ error: "agentWallet is required" });
            return;
        }
        const session = await getWorkingSessionMemory({ sessionId, agentWallet });
        if (!session) {
            res.status(404).json({ error: "Working memory session not found" });
            return;
        }
        res.json({ session });
    }));

    app.patch("/api/memory/sessions/:sessionId/working", asyncHandler(async (req: Request, res: Response) => {
        const sessionId = getParam(req.params.sessionId);
        const { agentWallet, userAddress, threadId, mode, haiId, context, entities, state, metadata, replace } = req.body || {};
        if (typeof agentWallet !== "string") {
            res.status(400).json({ error: "agentWallet is required" });
            return;
        }
        const result = await updateWorkingSessionMemory({
            sessionId,
            agentWallet,
            userAddress,
            threadId,
            mode,
            haiId,
            context: Array.isArray(context) ? context.filter((item): item is string => typeof item === "string") : undefined,
            entities: entities && typeof entities === "object" && !Array.isArray(entities) ? entities : undefined,
            state: state && typeof state === "object" && !Array.isArray(state) ? state : undefined,
            metadata: metadata && typeof metadata === "object" && !Array.isArray(metadata) ? metadata : undefined,
            replace: replace === true,
        });
        res.json(result);
    }));

    app.post("/api/memory/sessions/:sessionId/compress", asyncHandler(async (req: Request, res: Response) => {
        const sessionId = getParam(req.params.sessionId);
        const { agentWallet, coordinatorModel } = req.body || {};
        if (typeof agentWallet !== "string" || typeof coordinatorModel !== "string") {
            res.status(400).json({ error: "agentWallet and coordinatorModel are required" });
            return;
        }
        const result = await compressSession({ sessionId, agentWallet, coordinatorModel });
        res.json(result);
    }));

    app.post("/api/memory/archives/:archiveId/sync", asyncHandler(async (req: Request, res: Response) => {
        const archiveId = getParam(req.params.archiveId);
        const { agentWallet } = req.body || {};
        if (typeof agentWallet !== "string") {
            res.status(400).json({ error: "agentWallet is required" });
            return;
        }
        const result = await syncArchiveToPinata({ archiveId, agentWallet });
        res.json(result);
    }));

    app.get("/api/memory/schedules", asyncHandler(async (req: Request, res: Response) => {
        const requestedWallets = getStringList(req.query.agentWallets);
        const agentWallets = requestedWallets.length > 0
            ? requestedWallets
            : (await listActiveMemoryAgentWallets()).agentWallets;
        const schedules = await getMemoryScheduleStatus(agentWallets);
        res.json({ schedules });
    }));

    app.post("/api/memory/schedules", asyncHandler(async (req: Request, res: Response) => {
        const { agentWallets } = req.body || {};
        if (!Array.isArray(agentWallets) || !agentWallets.every((wallet) => typeof wallet === "string")) {
            res.status(400).json({ error: "agentWallets is required" });
            return;
        }
        await createMemorySchedules(agentWallets);
        res.json({ created: true });
    }));

    app.delete("/api/memory/schedules", asyncHandler(async (req: Request, res: Response) => {
        const requestedWallets = getStringList(req.query.agentWallets);
        const agentWallets = requestedWallets.length > 0
            ? requestedWallets
            : (await listActiveMemoryAgentWallets()).agentWallets;
        await deleteMemorySchedules(agentWallets);
        res.json({ deleted: true });
    }));

    app.post("/api/memory/schedules/:scheduleId/pause", asyncHandler(async (req: Request, res: Response) => {
        const scheduleId = getParam(req.params.scheduleId);
        await pauseMemorySchedule(scheduleId);
        res.json({ paused: true });
    }));

    app.post("/api/memory/schedules/:scheduleId/resume", asyncHandler(async (req: Request, res: Response) => {
        const scheduleId = getParam(req.params.scheduleId);
        await resumeMemorySchedule(scheduleId);
        res.json({ resumed: true });
    }));

    app.post("/api/memory/schedules/:scheduleId/trigger", asyncHandler(async (req: Request, res: Response) => {
        const scheduleId = getParam(req.params.scheduleId);
        await triggerMemorySchedule(scheduleId);
        res.json({ triggered: true });
    }));

    app.post("/api/memory/add", asyncHandler(async (req: Request, res: Response) => {
        await sendAgentMemoryJson(res, async () => {
            const { messages } = req.body || {};
            if (!Array.isArray(messages)) {
                throw new AgentMemoryInputError("messages is required");
            }
            const scope = normalizeAgentMemoryScope(req.body || {});
            return addGraphMemory({
                messages,
                agent_id: scope.agentWallet,
                user_id: scope.userAddress,
                run_id: scope.threadId,
                mode: scope.mode,
                haiId: scope.haiId,
                metadata: scope.metadata,
            });
        });
    }));

    app.post("/api/memory/search", asyncHandler(async (req: Request, res: Response) => {
        await sendAgentMemoryJson(res, async () => {
            const { query } = req.body || {};
            if (typeof query !== "string") {
                throw new AgentMemoryInputError("query is required");
            }
            const scope = normalizeAgentMemoryScope(req.body || {});
            return searchGraphMemory({
                query,
                agent_id: scope.agentWallet,
                user_id: scope.userAddress,
                run_id: scope.threadId,
                mode: scope.mode,
                haiId: scope.haiId,
                filters: scope.filters,
            });
        });
    }));

    app.get("/api/memory/:agentWallet", asyncHandler(async (req: Request, res: Response) => {
        const agentWallet = getParam(req.params.agentWallet);
        const userAddress = typeof req.query.userAddress === "string" ? req.query.userAddress : undefined;

        const memories = await getAllMemories({
            agent_id: agentWallet,
            user_id: userAddress,
        });

        res.json(memories);
    }));

    app.post("/api/memory/vector-search", asyncHandler(async (req: Request, res: Response) => {
        const {
            query,
            queryEmbedding,
            limit,
            threshold,
        } = req.body || {};

        await sendAgentMemoryJson(res, async () => {
            if (typeof query !== "string") {
                throw new AgentMemoryInputError("query is required");
            }
            const scope = normalizeAgentMemoryScope(req.body || {});

            if (Array.isArray(queryEmbedding) && queryEmbedding.length > 0) {
                const results = await hybridVectorSearch({
                    query,
                    queryEmbedding,
                    agentWallet: scope.agentWallet,
                    userAddress: scope.userAddress,
                    threadId: scope.threadId,
                    mode: scope.mode,
                    haiId: scope.haiId,
                    filters: scope.filters,
                    limit: typeof limit === "number" ? limit : 10,
                    threshold: typeof threshold === "number" ? threshold : undefined,
                    applyDecay: true,
                });
                return { results };
            }

            const results = await searchVectors({
                query,
                agentWallet: scope.agentWallet,
                userAddress: scope.userAddress,
                threadId: scope.threadId,
                mode: scope.mode,
                haiId: scope.haiId,
                filters: scope.filters,
                limit: typeof limit === "number" ? limit : 10,
                threshold: typeof threshold === "number" ? threshold : undefined,
                options: {
                    temporalDecay: true,
                    rerank: true,
                    mmr: true,
                    mmrLambda: 0.7,
                },
            });
            return { results };
        });
    }));

    app.post("/api/memory/vector-index", asyncHandler(async (req: Request, res: Response) => {
        const { content, embedding, source, metadata } = req.body || {};
        const validSources = new Set(["session", "knowledge", "pattern", "archive", "fact"]);

        await sendAgentMemoryJson(res, async () => {
            if (typeof content !== "string" || typeof source !== "string" || !validSources.has(source)) {
                throw new AgentMemoryInputError("content, agentWallet, and source are required");
            }
            const scope = normalizeAgentMemoryScope(req.body || {});
            const result = Array.isArray(embedding) && embedding.length > 0
                ? await indexVector({
                    content,
                    embedding,
                    agentWallet: scope.agentWallet,
                    userAddress: scope.userAddress,
                    threadId: scope.threadId,
                    mode: scope.mode,
                    haiId: scope.haiId,
                    source: source as "session" | "knowledge" | "pattern" | "archive" | "fact",
                    metadata,
                })
                : await indexMemoryContent({
                    content,
                    agentWallet: scope.agentWallet,
                    userAddress: scope.userAddress,
                    threadId: scope.threadId,
                    mode: scope.mode,
                    haiId: scope.haiId,
                    source: source as "session" | "knowledge" | "pattern" | "archive" | "fact",
                    metadata,
                });

            return { success: true, vectorId: result.vectorId };
        });
    }));

    app.post("/api/memory/transcript-store", asyncHandler(async (req: Request, res: Response) => {
        const { sessionId, threadId, agentWallet, userAddress, mode, haiId, messages, tokenCount, summary, summaryEmbedding, metadata } = req.body || {};
        if (!sessionId || !threadId || !agentWallet || !Array.isArray(messages) || typeof tokenCount !== "number") {
            res.status(400).json({ error: "sessionId, threadId, agentWallet, messages, and tokenCount are required" });
            return;
        }

        const result = await storeTranscript({
            sessionId,
            threadId,
            agentWallet,
            userAddress,
            mode,
            haiId,
            messages,
            tokenCount,
            summary,
            summaryEmbedding,
            metadata,
        });

        res.json(result);
    }));

    app.get("/api/memory/transcript-get/:id", asyncHandler(async (req: Request, res: Response) => {
        const id = getParam(req.params.id);
        const type = typeof req.query.type === "string" ? req.query.type : "sessionId";

        const transcript = type === "threadId"
            ? await getTranscriptByThreadId(id)
            : await getTranscriptBySessionId(id);
        const agentWallet = typeof req.query.agentWallet === "string" ? req.query.agentWallet : undefined;
        const userAddress = typeof req.query.userAddress === "string" ? req.query.userAddress : undefined;

        if (
            !transcript
            || (agentWallet && transcript.agentWallet !== agentWallet)
            || (userAddress && transcript.userAddress !== userAddress)
        ) {
            res.status(404).json({ error: "Transcript not found" });
            return;
        }

        res.json(transcript);
    }));

    app.post("/api/memory/rerank", asyncHandler(async (req: Request, res: Response) => {
        const { query, documents, topK } = req.body || {};
        if (typeof query !== "string" || !Array.isArray(documents)) {
            res.status(400).json({ error: "query and documents are required" });
            return;
        }

        const results = await rerankDocuments({ query, documents, topK });
        res.json({ results });
    }));

    app.post("/api/memory/layers/search", asyncHandler(async (req: Request, res: Response) => {
        await sendAgentMemoryJson(res, async () => {
            const { query, layers, limit } = req.body || {};
            if (typeof query !== "string") {
                throw new AgentMemoryInputError("query is required");
            }
            const scope = normalizeAgentMemoryScope(req.body || {});
            return searchMemoryLayers({
                query,
                agentWallet: scope.agentWallet,
                userAddress: scope.userAddress,
                threadId: scope.threadId,
                mode: scope.mode,
                haiId: scope.haiId,
                filters: scope.filters,
                layers: Array.isArray(layers) ? layers : ["working", "scene", "graph", "patterns", "archives", "vectors"],
                limit: typeof limit === "number" ? limit : 5,
            });
        });
    }));

    app.get("/api/memory/stats/:agentWallet", asyncHandler(async (req: Request, res: Response) => {
        const agentWallet = getParam(req.params.agentWallet);
        const stats = await getMemoryStats(agentWallet);
        res.json(stats);
    }));

    app.post("/api/memory/items/search", asyncHandler(async (req: Request, res: Response) => {
        await sendAgentMemoryJson(res, async () => {
            const { query, layers, limit } = req.body || {};
            if (typeof query !== "string") {
                throw new AgentMemoryInputError("query is required");
            }
            const scope = normalizeAgentMemoryScope(req.body || {});
            return searchMemoryLayers({
                query,
                agentWallet: scope.agentWallet,
                userAddress: scope.userAddress,
                threadId: scope.threadId,
                mode: scope.mode,
                haiId: scope.haiId,
                filters: scope.filters,
                layers: Array.isArray(layers) ? layers : ["working", "scene", "graph", "patterns", "archives", "vectors"],
                limit: typeof limit === "number" ? limit : 5,
            });
        });
    }));

    app.get("/api/memory/items/:id", asyncHandler(async (req: Request, res: Response) => {
        const id = getParam(req.params.id);
        const agentWallet = typeof req.query.agentWallet === "string" ? req.query.agentWallet : undefined;
        const userAddress = typeof req.query.userAddress === "string" ? req.query.userAddress : undefined;
        const item = await getMemoryItem({ id, agentWallet, userAddress });
        if (!item) {
            res.status(404).json({ error: "Memory item not found" });
            return;
        }
        res.json({ item });
    }));

    app.patch("/api/memory/items/:id", asyncHandler(async (req: Request, res: Response) => {
        const id = getParam(req.params.id);
        const { agentWallet, userAddress, threadId, content, metadata, retention, confidence, status, filters } = req.body || {};
        const result = await updateMemoryItem({
            id,
            agentWallet,
            userAddress,
            threadId,
            content,
            metadata,
            retention,
            confidence,
            status,
            filters: typeof filters === "object" && filters ? filters : undefined,
        });
        if (!result.updated) {
            res.status(404).json({ error: "Memory item not found" });
            return;
        }
        res.json(result);
    }));

    app.delete("/api/memory/items/:id", asyncHandler(async (req: Request, res: Response) => {
        const id = getParam(req.params.id);
        const agentWallet = typeof req.query.agentWallet === "string" ? req.query.agentWallet : undefined;
        const userAddress = typeof req.query.userAddress === "string" ? req.query.userAddress : undefined;
        const hardDelete = req.query.hardDelete === "true";
        const result = await deleteMemoryItem({ id, agentWallet, userAddress, hardDelete });
        if (!result.deleted) {
            res.status(404).json({ error: "Memory item not found" });
            return;
        }
        res.json(result);
    }));

    app.post("/api/memory/conflicts/:id/resolve", asyncHandler(async (req: Request, res: Response) => {
        const memoryId = getParam(req.params.id);
        const { agentWallet, resolution, winningMemoryId, reason } = req.body || {};
        if (resolution !== "supersede" && resolution !== "keep" && resolution !== "merge" && resolution !== "ignore") {
            res.status(400).json({ error: "resolution must be supersede, keep, merge, or ignore" });
            return;
        }
        const result = await resolveMemoryConflict({
            memoryId,
            agentWallet,
            resolution,
            winningMemoryId,
            reason,
        });
        res.json(result);
    }));

    app.post("/api/memory/jobs", asyncHandler(async (req: Request, res: Response) => {
        const { type } = req.body || {};
        if (type !== "consolidate" && type !== "patterns_extract" && type !== "archive_create" && type !== "decay_update" && type !== "cleanup") {
            res.status(400).json({ error: "type must be consolidate, patterns_extract, archive_create, decay_update, or cleanup" });
            return;
        }
        const result = await runMemoryMaintenanceJob({ ...req.body, type });
        res.json(result);
    }));

    app.get("/api/memory/jobs/:jobId", asyncHandler(async (req: Request, res: Response) => {
        const jobId = getParam(req.params.jobId);
        const job = await getMemoryJob(jobId);
        if (!job) {
            res.status(404).json({ error: "Memory job not found" });
            return;
        }
        res.json(job);
    }));

    app.post("/api/memory/evals/runs", asyncHandler(async (req: Request, res: Response) => {
        const { agentWallet, agent_id, testCases } = req.body || {};
        if (typeof (agentWallet || agent_id) !== "string" || !Array.isArray(testCases)) {
            res.status(400).json({ error: "agentWallet and testCases are required" });
            return;
        }
        const result = await runMemoryEval({
            ...req.body,
            agentWallet: agentWallet || agent_id,
            testCases,
        });
        res.json(result);
    }));

    app.post("/internal/memory/consolidate", asyncHandler(async (req: Request, res: Response) => {
        if (!isRuntimeInternalRequest(req)) {
            res.status(401).json({ success: false, error: "Unauthorized" });
            return;
        }

        const { agentWallets } = req.body || {};
        if (!Array.isArray(agentWallets)) {
            res.status(400).json({ success: false, error: "agentWallets is required" });
            return;
        }

        const data = await consolidateAgentMemories({ agentWallets });
        res.json({ success: true, data });
    }));

    app.post("/internal/memory/patterns/extract", asyncHandler(async (req: Request, res: Response) => {
        if (!isRuntimeInternalRequest(req)) {
            res.status(401).json({ success: false, error: "Unauthorized" });
            return;
        }

        const { agentWallet, timeRange, confidenceThreshold } = req.body || {};
        if (typeof agentWallet !== "string" || !timeRange || typeof timeRange.start !== "number" || typeof timeRange.end !== "number") {
            res.status(400).json({ success: false, error: "agentWallet and valid timeRange are required" });
            return;
        }

        const data = await extractExecutionPatterns({
            agentWallet,
            timeRange,
            confidenceThreshold: typeof confidenceThreshold === "number" ? confidenceThreshold : 0.7,
        });
        res.json({ success: true, data });
    }));

    app.post("/internal/memory/archive/create", asyncHandler(async (req: Request, res: Response) => {
        if (!isRuntimeInternalRequest(req)) {
            res.status(401).json({ success: false, error: "Unauthorized" });
            return;
        }

        const { agentWallet, dateRange, options } = req.body || {};
        if (typeof agentWallet !== "string" || !dateRange || typeof dateRange.start !== "number" || typeof dateRange.end !== "number") {
            res.status(400).json({ success: false, error: "agentWallet and valid dateRange are required" });
            return;
        }

        const data = await createMemoryArchive({
            agentWallet,
            dateRange,
            compress: options?.compress,
        });
        res.json({ success: true, data });
    }));

    app.post("/internal/memory/decay/update", asyncHandler(async (req: Request, res: Response) => {
        if (!isRuntimeInternalRequest(req)) {
            res.status(401).json({ success: false, error: "Unauthorized" });
            return;
        }

        const { halfLifeDays } = req.body || {};
        const data = await updateMemoryDecayScores({
            halfLifeDays: typeof halfLifeDays === "number" ? halfLifeDays : 30,
        });
        res.json({ success: true, data });
    }));

    app.post("/internal/memory/patterns/validate", asyncHandler(async (req: Request, res: Response) => {
        if (!isRuntimeInternalRequest(req)) {
            res.status(401).json({ success: false, error: "Unauthorized" });
            return;
        }

        const { patternId } = req.body || {};
        if (typeof patternId !== "string") {
            res.status(400).json({ success: false, error: "patternId is required" });
            return;
        }

        const data = await validateExtractedPattern({ patternId });
        res.json({ success: true, data });
    }));

    app.post("/internal/memory/patterns/promote", asyncHandler(async (req: Request, res: Response) => {
        if (!isRuntimeInternalRequest(req)) {
            res.status(401).json({ success: false, error: "Unauthorized" });
            return;
        }

        const { patternId, skillName, validationData } = req.body || {};
        if (typeof patternId !== "string" || typeof skillName !== "string" || !validationData) {
            res.status(400).json({ success: false, error: "patternId, skillName, and validationData are required" });
            return;
        }

        const data = await promotePatternToSkill({ patternId, skillName, validationData });
        res.json({ success: true, data });
    }));

    app.post("/internal/memory/cleanup", asyncHandler(async (req: Request, res: Response) => {
        if (!isRuntimeInternalRequest(req)) {
            res.status(401).json({ success: false, error: "Unauthorized" });
            return;
        }

        const { olderThanDays } = req.body || {};
        const data = await cleanupExpiredMemories({
            olderThanDays: typeof olderThanDays === "number" ? olderThanDays : 90,
        });
        res.json({ success: true, data });
    }));

    app.post("/internal/memory/archive/sync-pinata", asyncHandler(async (req: Request, res: Response) => {
        if (!isRuntimeInternalRequest(req)) {
            res.status(401).json({ success: false, error: "Unauthorized" });
            return;
        }

        const { archiveId, agentWallet } = req.body || {};
        if (typeof archiveId !== "string" || typeof agentWallet !== "string") {
            res.status(400).json({ success: false, error: "archiveId and agentWallet are required" });
            return;
        }

        const data = await syncArchiveToPinata({ archiveId, agentWallet });
        res.json({ success: true, data });
    }));

    // ============================================================================
    // Workflow Chat (x402 Payable, Streaming)
    // ============================================================================

    const workflowChatHandler = asyncHandler(async (req: Request, res: Response) => {
        const identifier = getParam(req.params.walletAddress);
        const registeredWorkflow = await ensureRegisteredWorkflowByWallet(identifier);

        if (!registeredWorkflow) {
            res.status(404).json({ error: `Workflow "${identifier}" not found` });
            return;
        }

        console.log(`[workflow] Resolved workflow: ${registeredWorkflow.title} (${registeredWorkflow.walletAddress})`);

        const builtWorkflow = buildWorkflowFromWorkflow(registeredWorkflow);
        console.log(`[workflow] Built ${builtWorkflow.steps.length} agent steps from wallets: [${registeredWorkflow.agentWalletAddresses?.join(", ") || "none"}]`);

        // Parse request - handle both legacy (image/audio) and new (attachment) formats
        const { message, threadId, image, audio, attachment, continuous, composeRunId, lastEventIndex: requestedLastEventIndex } = req.body;
        if (!message) {
            res.status(400).json({ error: "message is required" });
            return;
        }
        const cancellationKey = `${registeredWorkflow.walletAddress}:${threadId || "default"}`;

        const runtimeSession = extractRuntimeSessionHeaders(req);
        // Prepare payment context
        const paymentContext: PaymentContext = {
            paymentData: null,
            sessionActive: runtimeSession.sessionActive,
            sessionBudgetRemaining: runtimeSession.sessionBudgetRemaining,
            resourceUrlBase: `${req.protocol}://${req.get("host")}`,
            userAddress: runtimeSession.sessionUserAddress,
        };

        // Set up SSE response for long-running workflows
        res.setHeader("Content-Type", "text/event-stream");
        res.setHeader("Cache-Control", "no-cache");
        res.setHeader("Connection", "keep-alive");
        res.setHeader("X-Accel-Buffering", "no"); // Disable nginx buffering
        // Explicit CORS for SSE (browsers require this)
        const origin = req.headers.origin;
        if (origin) res.setHeader("Access-Control-Allow-Origin", origin);
        res.setHeader("Access-Control-Allow-Credentials", "true");
        res.flushHeaders();
        let clientDisconnected = false;
        const heartbeat = setInterval(() => {
            if (!res.writableEnded) {
                res.write(": ping\n\n");
            }
        }, SSE_HEARTBEAT_INTERVAL_MS);
        res.on("close", () => {
            clientDisconnected = true;
            clearInterval(heartbeat);
        });

        const runId = typeof composeRunId === "string" && composeRunId.length > 0 ? composeRunId : createComposeRunId();
        res.setHeader("x-compose-run-id", runId);
        res.write(`event: start\ndata: ${JSON.stringify({ runId, message: "Starting workflow..." })}\n\n`);

        activeRunIds.set(cancellationKey, runId);

        let result: any;

        if (!isTemporalReady()) {
            const temporalStatus = getTemporalWorkerRuntimeStatus();
            res.write(`event: error\ndata: ${JSON.stringify({ runId, error: "Temporal worker deployment is not ready", temporal: temporalStatus })}\n\n`);
            res.write("event: done\ndata: {}\n\n");
            clearInterval(heartbeat);
            activeRunIds.delete(cancellationKey);
            res.end();
            return;
        }

        // Use Temporal workflow execution with polling for SSE
        const handle = await startWorkflowRun(
            registeredWorkflow.walletAddress,
            builtWorkflow,
            message,
            sanitizeExecutorOptions({
                payment: paymentContext,
                coordinatorModel: registeredWorkflow.coordinatorModel,
                workflowCardUri: registeredWorkflow.workflowCardUri,
                continuous: Boolean(continuous),
                maxLoopIterations: Boolean(continuous) ? 5 : undefined,
                userAddress: req.headers["x-session-user-address"] as string | undefined,
                threadId,
                workflowWallet: registeredWorkflow.walletAddress,
            }),
            runId,
        );

        let lastEventIndex = typeof requestedLastEventIndex === "number" && Number.isFinite(requestedLastEventIndex)
            ? Math.max(0, requestedLastEventIndex)
            : 0;
        let latestState = await getWorkflowRunState(registeredWorkflow.walletAddress, runId);
        let missingStateCount = latestState ? 0 : 1;
        const pollStartedAt = Date.now();
        let pollFailed = false;

        while (true) {
            if (clientDisconnected) {
                return;
            }
            latestState = await getWorkflowRunState(registeredWorkflow.walletAddress, runId);
            if (!latestState) {
                missingStateCount += 1;
                const pollTimedOut = Date.now() - pollStartedAt >= SSE_POLL_TIMEOUT_MS;
                if (missingStateCount >= SSE_STATE_MISS_LIMIT || pollTimedOut) {
                    pollFailed = true;
                    const reason = pollTimedOut
                        ? "Run state polling timed out"
                        : "Run state unavailable";
                    res.write(`event: error\ndata: ${JSON.stringify({ runId, error: reason })}\n\n`);
                    break;
                }
                await new Promise((resolve) => setTimeout(resolve, SSE_POLL_INTERVAL_MS));
                continue;
            }

            missingStateCount = 0;
            if (latestState?.events?.length) {
                while (lastEventIndex < latestState.events.length) {
                    const event = latestState.events[lastEventIndex];
                    res.write(`event: ${event.type}\ndata: ${JSON.stringify(event.data)}\n\n`);
                    lastEventIndex++;
                }
            }

            const status = latestState?.status;
            if (status === "success" || status === "error" || status === "cancelled") {
                break;
            }
            if (Date.now() - pollStartedAt >= SSE_POLL_TIMEOUT_MS) {
                pollFailed = true;
                res.write(`event: error\ndata: ${JSON.stringify({ runId, error: "Run state polling timed out" })}\n\n`);
                break;
            }
            await new Promise((resolve) => setTimeout(resolve, SSE_POLL_INTERVAL_MS));
        }

        if (pollFailed) {
            result = {
                success: false,
                result: "",
                stepResults: [],
                totalTokensUsed: 0,
                usageRecords: [],
                error: latestState?.error || "Workflow state became unavailable",
            };
        } else {
            try {
                result = await handle.result();
            } catch (error) {
                if (clientDisconnected) {
                    return;
                }
                const errorMessage = error instanceof Error ? error.message : String(error);
                result = {
                    success: false,
                    result: "",
                    stepResults: [],
                    totalTokensUsed: 0,
                    usageRecords: [],
                    error: latestState?.error || errorMessage,
                };
            }
        }

        activeRunIds.delete(cancellationKey);

        // Mark as executed
        markWorkflowExecuted(registeredWorkflow.walletAddress);

        // Extract output from result
        const output = result.result || (result.success ? "Workflow completed" : result.error || "");

        // Send final result as SSE event
        const finalData = {
            success: result.success,
            output: typeof output === "string" ? output : JSON.stringify(output),
            walletAddress: registeredWorkflow.walletAddress,
            onchainTokenId: registeredWorkflow.onchainTokenId,
            usageRecords: Array.isArray(result.usageRecords) ? result.usageRecords : [],
            error: result.error,
        };
        res.write(`event: result\ndata: ${JSON.stringify(finalData)}\n\n`);
        res.write(`event: done\ndata: {}\n\n`);
        clearInterval(heartbeat);
        res.end();
    });

    app.post("/workflow/:walletAddress/chat", workflowChatHandler);

    // Stop a running workflow (best-effort, cancels between steps)
    app.post("/workflow/:walletAddress/stop", asyncHandler(async (req: Request, res: Response) => {
        const walletAddress = getParam(req.params.walletAddress);
        const { threadId, runId: requestedRunId } = req.body || {};
        const cancellationKey = `${walletAddress}:${threadId || "default"}`;
        const runId = typeof requestedRunId === "string" && requestedRunId.length > 0
            ? requestedRunId
            : activeRunIds.get(cancellationKey);
        if (!runId) {
            res.status(404).json({ success: false, error: "No active run found" });
            return;
        }

        try {
            await cancelWorkflowRun(walletAddress, runId);
            res.json({ success: true, runId });
            return;
        } catch (error) {
            if (error instanceof TemporalRunNotFoundError) {
                res.status(404).json({ success: false, error: error.message });
                return;
            }
            throw error;
        }
    }));

    app.get("/workflow/:walletAddress/runs/:runId/state", asyncHandler(async (req: Request, res: Response) => {
        const walletAddress = getParam(req.params.walletAddress);
        const runId = getParam(req.params.runId);
        const state = await getWorkflowRunState(walletAddress, runId);
        if (!state) {
            res.status(404).json({ success: false, error: "Run not found" });
            return;
        }
        res.json(state);
    }));

    app.post("/workflow/:walletAddress/runs/:runId/approval", asyncHandler(async (req: Request, res: Response) => {
        const walletAddress = getParam(req.params.walletAddress);
        const runId = getParam(req.params.runId);
        const { stepKey, status, approver, reason } = req.body || {};

        if (!stepKey || typeof stepKey !== "string") {
            res.status(400).json({ success: false, error: "stepKey is required" });
            return;
        }
        if (status !== "approved" && status !== "rejected") {
            res.status(400).json({ success: false, error: "status must be 'approved' or 'rejected'" });
            return;
        }

        try {
            await signalStepApproval(walletAddress, runId, stepKey, status, approver, reason);
            res.json({ success: true });
        } catch (error) {
            if (error instanceof TemporalRunNotFoundError) {
                res.status(404).json({ success: false, error: error.message });
                return;
            }
            throw error;
        }
    }));

    app.post("/workflow/:id/run", (req: Request, res: Response, next: NextFunction) => {
        (req.params as Record<string, string>).walletAddress = getParam(req.params.id);
        return workflowChatHandler(req, res, next);
    });

    // ============================================================================
    // Local Agent Memory API (for local agents)
    // ============================================================================

    app.post("/api/local/memory/add", asyncHandler(async (req: Request, res: Response) => {
        const { agentWallet, userAddress, messages, metadata, runId, run_id } = req.body || {};
        const agentId = agentWallet;
        const user = userAddress;
        const run = runId || run_id || `local-${Date.now()}`;

        if (!agentId) {
            res.status(400).json({ error: "agentWallet is required" });
            return;
        }

        if (!Array.isArray(messages) || messages.length === 0) {
            res.status(400).json({ error: "messages array is required" });
            return;
        }

        const result = await addGraphMemory({
            messages,
            agent_id: agentId,
            user_id: user,
            run_id: run,
            metadata: typeof metadata === "object" && metadata ? metadata : undefined,
        });

        console.log(`[Local Memory] Added ${result.length} memories for agent ${agentId}`);
        res.json({ success: true, count: result.length, memories: result });
    }));

    app.post("/api/local/memory/search", asyncHandler(async (req: Request, res: Response) => {
        const { query, agentWallet, userAddress, runId, run_id, limit } = req.body || {};
        const agentId = agentWallet;
        const user = userAddress;
        const run = runId || run_id;

        if (!query || !agentId) {
            res.status(400).json({ error: "query and agentWallet are required" });
            return;
        }

        const memories = await searchGraphMemory({
            query,
            agent_id: agentId,
            user_id: user,
            run_id: run,
            limit: typeof limit === "number" ? limit : 10,
        });

        res.json({
            memories,
            entities: [],
            relations: [],
        });
    }));

    app.get("/api/local/memory/:agentWallet", asyncHandler(async (req: Request, res: Response) => {
        const agentWallet = getParam(req.params.agentWallet);
        const userAddress = typeof req.query.userAddress === "string" ? req.query.userAddress : undefined;

        const memories = await getAllMemories({
            agent_id: agentWallet,
            user_id: userAddress,
        });

        res.json({
            agentWallet,
            memories,
            count: memories.length,
        });
    }));

    app.post("/api/local/memory/context", asyncHandler(async (req: Request, res: Response) => {
        const { agentWallet, userAddress, runId, run_id } = req.body || {};
        const agentId = agentWallet;
        const user = userAddress;
        const run = runId || run_id;

        if (!agentId) {
            res.status(400).json({ error: "agentWallet is required" });
            return;
        }

        const memories = await getAllMemories({
            agent_id: agentId,
            user_id: user,
            run_id: run,
        });

        const contextText = memories
            .slice(0, 10)
            .map(m => m.memory)
            .join("\n\n");

        res.json({
            context: contextText || "No prior context found.",
            memoryCount: memories.length,
        });
    }));

}

// ============================================================================
// Temporal Integration Helpers
// ============================================================================

function isTemporalReady(): boolean {
    return isTemporalWorkerReady();
}

async function ensureMemoryMaintenanceSchedules(): Promise<void> {
    if (process.env.MEMORY_AUTO_SCHEDULES === "false") {
        return;
    }
    const limit = Number.parseInt(process.env.MEMORY_AUTO_SCHEDULE_LIMIT || "250", 10);
    const { agentWallets } = await listActiveMemoryAgentWallets({
        limit: Number.isFinite(limit) && limit > 0 ? limit : 250,
    });
    await createMemorySchedules(agentWallets);
    console.log(`[workflow] Memory maintenance schedules ready for ${agentWallets.length} active agents`);
}

// ============================================================================
// Server Startup
// ============================================================================

let initializationStarted = false;

export function initializeWorkflowRuntime(): void {
    if (initializationStarted) {
        return;
    }
    initializationStarted = true;

    console.log("[workflow] Initializing embedded runtime");

    console.log("[workflow] Starting Temporal workers...");
    void startWorkflowTemporalWorkers()
        .then(() => {
            console.log("[workflow] Temporal workers ready");
            void ensureMemoryMaintenanceSchedules().catch((error) => {
                console.error("[workflow] Failed to initialize memory maintenance schedules:", error);
            });
        })
        .catch((error) => {
            console.error("[workflow] Failed to start Temporal workers:", error);
        });
}
