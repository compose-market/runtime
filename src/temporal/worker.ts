import { VersioningBehavior } from "@temporalio/common";
import type { Worker as TemporalWorker } from "@temporalio/worker";
import { NativeConnection, Worker } from "@temporalio/worker";
import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";
import { AGENT_ACTIVITY_TASK_QUEUE, AGENT_TASK_QUEUE, WORKFLOW_ACTIVITY_TASK_QUEUE, WORKFLOW_TASK_QUEUE, MEMORY_ACTIVITY_TASK_QUEUE } from "./constants.js";
import {
    createTemporalIdentity,
    getTemporalAddress,
    getTemporalApiKey,
    getTemporalClient,
    getTemporalDeploymentMetadata,
    getTemporalDeploymentVersion,
    getTemporalNamespace,
    getRuntimeRootDirectory,
    isTemporalConfigured,
} from "./client.js";
import { getEncryptionStatus } from "./encryption.js";

let running = false;
let workerLifecycleState: "stopped" | "starting" | "ready" | "error" = "stopped";
let workerLifecycleError: string | undefined;
const workerPollers: Record<string, number> = {
    [WORKFLOW_TASK_QUEUE]: 0,
    [AGENT_TASK_QUEUE]: 0,
    [WORKFLOW_ACTIVITY_TASK_QUEUE]: 0,
    [AGENT_ACTIVITY_TASK_QUEUE]: 0,
    [MEMORY_ACTIVITY_TASK_QUEUE]: 0,
};

function resetWorkerPollers(): void {
    for (const queue of Object.keys(workerPollers)) {
        workerPollers[queue] = 0;
    }
}

export function getTemporalWorkerPollers(): Record<string, number> {
    return { ...workerPollers };
}

function setWorkerLifecycleState(
    state: "stopped" | "starting" | "ready" | "error",
    error?: string,
): void {
    workerLifecycleState = state;
    workerLifecycleError = error;
}

export function getTemporalWorkerRuntimeStatus(): {
    state: "stopped" | "starting" | "ready" | "error";
    error?: string;
    pollers: Record<string, number>;
    ready: boolean;
    deployment: ReturnType<typeof getTemporalDeploymentMetadata> | null;
} {
    const pollers = getTemporalWorkerPollers();
    const ready = workerLifecycleState === "ready" && Object.values(pollers).every((count) => count > 0);

    return {
        state: workerLifecycleState,
        error: workerLifecycleError,
        pollers,
        ready,
        deployment: isTemporalConfigured() ? getTemporalDeploymentMetadata() : null,
    };
}

export function isTemporalWorkerReady(): boolean {
    return getTemporalWorkerRuntimeStatus().ready;
}

function resolveWorkflowsPath(): string {
    const currentDir = path.dirname(fileURLToPath(import.meta.url));
    const jsPath = path.join(currentDir, "workflows.js");
    const tsPath = path.join(currentDir, "workflows.ts");
    return fs.existsSync(jsPath) ? jsPath : tsPath;
}

function resolveWorkflowBundle(): { codePath: string } | undefined {
    // Production optimization: use pre-built workflow bundle if available
    const bundlePath = path.join(getRuntimeRootDirectory(), "dist", "workflow-bundle.js");

    if (process.env.NODE_ENV === "production" && fs.existsSync(bundlePath)) {
        console.log(`[temporal/worker] Using pre-built workflow bundle: ${bundlePath}`);
        return { codePath: bundlePath };
    }
    return undefined;
}

function markWorkerFailure(taskQueue: string, error: unknown): void {
    workerPollers[taskQueue] = Math.max(0, (workerPollers[taskQueue] || 1) - 1);
    running = false;
    setWorkerLifecycleState("error", error instanceof Error ? error.message : String(error));
    console.error(`[temporal] Worker for ${taskQueue} stopped:`, error);
}

function startWorker(worker: TemporalWorker, taskQueue: string): void {
    workerPollers[taskQueue] = (workerPollers[taskQueue] || 0) + 1;
    worker.run().catch((error) => markWorkerFailure(taskQueue, error));
}

async function shutdownWorkers(workerEntries: Array<{ worker: TemporalWorker; taskQueue: string }>): Promise<void> {
    for (const { worker } of workerEntries) {
        worker.shutdown();
    }
    resetWorkerPollers();
    running = false;
}

async function promoteCurrentDeploymentVersion(): Promise<void> {
    const client = await getTemporalClient();
    const { deploymentName, buildId, canonicalVersion } = getTemporalDeploymentMetadata();
    const namespace = getTemporalNamespace();
    const maxAttempts = 20;
    let lastError: unknown;

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        try {
            await client.workflowService.setWorkerDeploymentCurrentVersion({
                namespace,
                deploymentName,
                buildId,
                identity: createTemporalIdentity("deployment-promotion"),
            });

            console.log(`[temporal] Promoted current worker deployment version: ${canonicalVersion}`);
            return;
        } catch (error) {
            lastError = error;
            const message = error instanceof Error ? error.message : String(error);
            console.warn(
                `[temporal] Waiting for pollers before promoting deployment version (${attempt}/${maxAttempts}): ${message}`,
            );
            await new Promise((resolve) => setTimeout(resolve, 2000));
        }
    }

    throw new Error(
        `Failed to promote Temporal deployment version ${canonicalVersion}: ${lastError instanceof Error ? lastError.message : String(lastError)}`,
    );
}

export async function startWorkflowTemporalWorkers(): Promise<void> {
    if (running) {
        return;
    }
    setWorkerLifecycleState("starting");
    if (!isTemporalConfigured()) {
        const message = "Temporal is mandatory: TEMPORAL_NAMESPACE, TEMPORAL_ADDRESS, and TEMPORAL_API_KEY must be set.";
        setWorkerLifecycleState("error", message);
        throw new Error(message);
    }

    const connection = await NativeConnection.connect({
        address: getTemporalAddress(),
        apiKey: getTemporalApiKey(),
        tls: true,
    });
    const namespace = getTemporalNamespace();
    const workflowsPath = resolveWorkflowsPath();
    const workflowBundle = resolveWorkflowBundle();
    const activities = await import("./activities.js");
    const memoryActivities = await import("./memory/activities.js");
    const allActivities = { ...activities, ...memoryActivities };
    resetWorkerPollers();

    // Log encryption status (data converter integration ready for future SDK upgrade)
    console.log(getEncryptionStatus());

    // Worker configuration with best practices
    // Note: shutdownGraceTime and shutdownForceTime use Temporal Duration format (ms or object)
    const workerConfig = {
        connection,
        namespace,
        activities: allActivities,
        shutdownGraceTime: 30_000, // Allow 30s (in ms) for activities to complete gracefully
        shutdownForceTime: 60_000, // Force shutdown after 60s (in ms)
        maxConcurrentActivityTaskExecutions: 100,
        maxConcurrentWorkflowTaskExecutions: 100,
        workerDeploymentOptions: {
            version: getTemporalDeploymentVersion(),
            useWorkerVersioning: true,
            defaultVersioningBehavior: VersioningBehavior.PINNED,
        },
    };

    const workerEntries = await Promise.all([
        Worker.create({
            ...workerConfig,
            taskQueue: WORKFLOW_TASK_QUEUE,
            identity: createTemporalIdentity("workflow-worker", WORKFLOW_TASK_QUEUE),
            ...(workflowBundle ? { workflowBundle } : { workflowsPath }),
        }).then((worker) => ({ taskQueue: WORKFLOW_TASK_QUEUE, worker })),
        Worker.create({
            ...workerConfig,
            taskQueue: AGENT_TASK_QUEUE,
            identity: createTemporalIdentity("workflow-worker", AGENT_TASK_QUEUE),
            ...(workflowBundle ? { workflowBundle } : { workflowsPath }),
        }).then((worker) => ({ taskQueue: AGENT_TASK_QUEUE, worker })),
        Worker.create({
            ...workerConfig,
            taskQueue: WORKFLOW_ACTIVITY_TASK_QUEUE,
            identity: createTemporalIdentity("workflow-worker", WORKFLOW_ACTIVITY_TASK_QUEUE),
            ...(workflowBundle ? { workflowBundle } : { workflowsPath }),
        }).then((worker) => ({ taskQueue: WORKFLOW_ACTIVITY_TASK_QUEUE, worker })),
        Worker.create({
            ...workerConfig,
            taskQueue: AGENT_ACTIVITY_TASK_QUEUE,
            identity: createTemporalIdentity("workflow-worker", AGENT_ACTIVITY_TASK_QUEUE),
            ...(workflowBundle ? { workflowBundle } : { workflowsPath }),
        }).then((worker) => ({ taskQueue: AGENT_ACTIVITY_TASK_QUEUE, worker })),
        Worker.create({
            ...workerConfig,
            taskQueue: MEMORY_ACTIVITY_TASK_QUEUE,
            identity: createTemporalIdentity("workflow-worker", MEMORY_ACTIVITY_TASK_QUEUE),
            ...(workflowBundle ? { workflowBundle } : { workflowsPath }),
        }).then((worker) => ({ taskQueue: MEMORY_ACTIVITY_TASK_QUEUE, worker })),
    ]);

    running = true;
    for (const { taskQueue, worker } of workerEntries) {
        startWorker(worker, taskQueue);
    }

    try {
        await promoteCurrentDeploymentVersion();
    } catch (error) {
        await shutdownWorkers(workerEntries);
        setWorkerLifecycleState("error", error instanceof Error ? error.message : String(error));
        throw error;
    }

    setWorkerLifecycleState("ready");
    console.log(
        `[temporal] Workers started with deployment version ${getTemporalDeploymentMetadata().canonicalVersion}`,
    );
    console.log(
        `[temporal] Active queues: ${WORKFLOW_TASK_QUEUE}, ${AGENT_TASK_QUEUE}, ${WORKFLOW_ACTIVITY_TASK_QUEUE}, ${AGENT_ACTIVITY_TASK_QUEUE}, ${MEMORY_ACTIVITY_TASK_QUEUE}`,
    );
}
