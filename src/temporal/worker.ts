import { NativeConnection, Worker } from "@temporalio/worker";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { AGENT_ACTIVITY_TASK_QUEUE, AGENT_TASK_QUEUE, MANOWAR_ACTIVITY_TASK_QUEUE, MANOWAR_TASK_QUEUE, MEMORY_ACTIVITY_TASK_QUEUE } from "./constants.js";
import { getTemporalNamespace, isTemporalConfigured } from "./client.js";
import { validateEncryptionSetup, getEncryptionStatus } from "./encryption.js";

let running = false;
const workerPollers: Record<string, number> = {
    [MANOWAR_TASK_QUEUE]: 0,
    [AGENT_TASK_QUEUE]: 0,
    [MANOWAR_ACTIVITY_TASK_QUEUE]: 0,
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

function resolveWorkflowsPath(): string {
    const currentDir = path.dirname(fileURLToPath(import.meta.url));
    const jsPath = path.join(currentDir, "workflows.js");
    const tsPath = path.join(currentDir, "workflows.ts");
    return fs.existsSync(jsPath) ? jsPath : tsPath;
}

function resolveWorkflowBundle(): { codePath: string } | undefined {
    // Production optimization: use pre-built workflow bundle if available
    const currentDir = path.dirname(fileURLToPath(import.meta.url));
    const bundlePath = path.join(currentDir, "..", "..", "dist", "workflow-bundle.js");

    if (process.env.NODE_ENV === "production" && fs.existsSync(bundlePath)) {
        console.log(`[temporal/worker] Using pre-built workflow bundle: ${bundlePath}`);
        return { codePath: bundlePath };
    }
    return undefined;
}

function normalizeAddress(rawAddress: string): string {
    return rawAddress.replace(/^https?:\/\//, "").replace(/\/$/, "");
}

function generateWorkerIdentity(taskQueue: string): string {
    // Best practice: meaningful worker identity for debugging
    const env = process.env.NODE_ENV || "development";
    const host = process.env.HOSTNAME || process.env.COMPUTE_INSTANCE || "localhost";
    const pid = process.pid;
    const timestamp = Date.now();
    return `manowar-${taskQueue}-${env}-${host}-${pid}-${timestamp}`;
}

export async function startManowarTemporalWorkers(): Promise<void> {
    if (running) {
        return;
    }
    if (!isTemporalConfigured()) {
        throw new Error("Temporal is mandatory: TEMPORAL_NAMESPACE, TEMPORAL_ADDRESS, and TEMPORAL_API_KEY must be set.");
    }
    const endpoint = process.env.TEMPORAL_ADDRESS;
    const apiKey = process.env.TEMPORAL_API_KEY;
    if (!endpoint || !apiKey) {
        throw new Error("Temporal is mandatory: TEMPORAL_ADDRESS and TEMPORAL_API_KEY must be set.");
    }

    const connection = await NativeConnection.connect({
        address: normalizeAddress(endpoint),
        apiKey,
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
    };

    const workerEntries = await Promise.all([
        Worker.create({
            ...workerConfig,
            taskQueue: MANOWAR_TASK_QUEUE,
            identity: generateWorkerIdentity(MANOWAR_TASK_QUEUE),
            ...(workflowBundle ? { workflowBundle } : { workflowsPath }),
        }).then((worker) => ({ taskQueue: MANOWAR_TASK_QUEUE, worker })),
        Worker.create({
            ...workerConfig,
            taskQueue: AGENT_TASK_QUEUE,
            identity: generateWorkerIdentity(AGENT_TASK_QUEUE),
            ...(workflowBundle ? { workflowBundle } : { workflowsPath }),
        }).then((worker) => ({ taskQueue: AGENT_TASK_QUEUE, worker })),
        Worker.create({
            ...workerConfig,
            taskQueue: MANOWAR_ACTIVITY_TASK_QUEUE,
            identity: generateWorkerIdentity(MANOWAR_ACTIVITY_TASK_QUEUE),
            ...(workflowBundle ? { workflowBundle } : { workflowsPath }),
        }).then((worker) => ({ taskQueue: MANOWAR_ACTIVITY_TASK_QUEUE, worker })),
        Worker.create({
            ...workerConfig,
            taskQueue: AGENT_ACTIVITY_TASK_QUEUE,
            identity: generateWorkerIdentity(AGENT_ACTIVITY_TASK_QUEUE),
            ...(workflowBundle ? { workflowBundle } : { workflowsPath }),
        }).then((worker) => ({ taskQueue: AGENT_ACTIVITY_TASK_QUEUE, worker })),
        Worker.create({
            ...workerConfig,
            taskQueue: MEMORY_ACTIVITY_TASK_QUEUE,
            identity: generateWorkerIdentity(MEMORY_ACTIVITY_TASK_QUEUE),
            ...(workflowBundle ? { workflowBundle } : { workflowsPath }),
        }).then((worker) => ({ taskQueue: MEMORY_ACTIVITY_TASK_QUEUE, worker })),
    ]);

    running = true;
    for (const { taskQueue, worker } of workerEntries) {
        workerPollers[taskQueue] = (workerPollers[taskQueue] || 0) + 1;
        worker.run().catch((error) => {
            workerPollers[taskQueue] = Math.max(0, (workerPollers[taskQueue] || 1) - 1);
            running = false;
            console.error("[temporal] Worker stopped:", error);
        });
    }

    console.log(
        `[temporal] Workers started with optimized config (heartbeat: 30s, maxRetries: 3, identity tracking enabled)`,
    );
    console.log(
        `[temporal] Active queues: ${MANOWAR_TASK_QUEUE}, ${AGENT_TASK_QUEUE}, ${MANOWAR_ACTIVITY_TASK_QUEUE}, ${AGENT_ACTIVITY_TASK_QUEUE}, ${MEMORY_ACTIVITY_TASK_QUEUE}`,
    );
}
