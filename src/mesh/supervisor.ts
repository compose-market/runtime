import { randomUUID } from "node:crypto";

import { executeAgent, type ExecuteOptions, type ExecutionResult } from "../framework/manowar.js";
import {
    ensureAgentRuntimeReady,
    ensureRegisteredAgentByWallet,
} from "../framework/runtime.js";
import {
    appendLocalAgentLog,
    buildLocalHeartbeatPrompt,
    clampBudgetToNumber,
    hasActiveMeshSession,
    isHeartbeatOk,
    loadLocalRuntimeSnapshot,
    resolveLocalBaseDir,
} from "./workspace.js";

const RECONCILE_INTERVAL_MS = 5_000;

interface WorkerState {
    intervalMs: number;
    timer: NodeJS.Timeout;
    running: boolean;
}

interface LocalAgentHeartbeatHostDeps {
    ensureAgentRegistered?: (agentWallet: string) => Promise<unknown>;
    ensureAgentReady?: (agentWallet: string) => Promise<unknown>;
    executeAgent?: (
        agentWallet: string,
        prompt: string,
        options: ExecuteOptions,
    ) => Promise<ExecutionResult>;
    now?: () => number;
    setIntervalFn?: typeof globalThis.setInterval;
    clearIntervalFn?: typeof globalThis.clearInterval;
}

export class LocalAgentHeartbeatHost {
    private readonly baseDir: string;
    private readonly ensureAgentRegistered;
    private readonly ensureAgentReady;
    private readonly executeAgent;
    private readonly now;
    private readonly setIntervalFn;
    private readonly clearIntervalFn;
    private readonly workers = new Map<string, WorkerState>();
    private reconcileTimer: NodeJS.Timeout | null = null;
    private reconciling = false;

    constructor(baseDir: string, deps: LocalAgentHeartbeatHostDeps = {}) {
        this.baseDir = baseDir;
        this.ensureAgentRegistered = deps.ensureAgentRegistered || ensureRegisteredAgentByWallet;
        this.ensureAgentReady = deps.ensureAgentReady || ensureAgentRuntimeReady;
        this.executeAgent = deps.executeAgent || executeAgent;
        this.now = deps.now || (() => Date.now());
        this.setIntervalFn = deps.setIntervalFn || globalThis.setInterval;
        this.clearIntervalFn = deps.clearIntervalFn || globalThis.clearInterval;
    }

    start(): void {
        if (this.reconcileTimer) {
            return;
        }

        void this.reconcile();
        this.reconcileTimer = this.setIntervalFn(() => {
            void this.reconcile();
        }, RECONCILE_INTERVAL_MS);
    }

    stop(): void {
        if (this.reconcileTimer) {
            this.clearIntervalFn(this.reconcileTimer);
            this.reconcileTimer = null;
        }

        for (const worker of this.workers.values()) {
            this.clearIntervalFn(worker.timer);
        }
        this.workers.clear();
    }

    async reconcile(): Promise<void> {
        if (this.reconciling) {
            return;
        }
        this.reconciling = true;

        try {
            const snapshot = await loadLocalRuntimeSnapshot(this.baseDir);
            const desiredWallets = new Set<string>();

            for (const subject of snapshot.agents.values()) {
                if (!subject.desiredRunning || !subject.heartbeatEnabled) {
                    continue;
                }

                desiredWallets.add(subject.agentWallet);
                const existing = this.workers.get(subject.agentWallet);
                if (existing && existing.intervalMs === subject.intervalMs) {
                    continue;
                }
                if (existing) {
                    this.clearIntervalFn(existing.timer);
                    this.workers.delete(subject.agentWallet);
                }

                const timer = this.setIntervalFn(() => {
                    void this.runAgentTick(subject.agentWallet);
                }, subject.intervalMs);
                this.workers.set(subject.agentWallet, {
                    intervalMs: subject.intervalMs,
                    timer,
                    running: false,
                });

                void this.runAgentTick(subject.agentWallet);
            }

            for (const [agentWallet, worker] of this.workers.entries()) {
                if (desiredWallets.has(agentWallet)) {
                    continue;
                }
                this.clearIntervalFn(worker.timer);
                this.workers.delete(agentWallet);
            }
        } finally {
            this.reconciling = false;
        }
    }

    async runAgentTick(agentWallet: string): Promise<void> {
        const worker = this.workers.get(agentWallet);
        if (worker?.running) {
            return;
        }
        if (worker) {
            worker.running = true;
        }

        try {
            const snapshot = await loadLocalRuntimeSnapshot(this.baseDir);
            const subject = snapshot.agents.get(agentWallet);
            if (!subject || !subject.desiredRunning || !subject.heartbeatEnabled) {
                return;
            }

            const identity = snapshot.identity;
            if (!identity) {
                await appendLocalAgentLog(this.baseDir, agentWallet, "heartbeat skipped: local identity is required");
                return;
            }

            const prompt = await buildLocalHeartbeatPrompt(this.baseDir, snapshot, agentWallet);
            if (!prompt) {
                await appendLocalAgentLog(this.baseDir, agentWallet, "heartbeat skipped: no local heartbeat instructions");
                return;
            }

            const registered = await this.ensureAgentRegistered(agentWallet);
            if (typeof registered === "undefined") {
                throw new Error(`Agent ${agentWallet} is not registered`);
            }
            await this.ensureAgentReady(agentWallet);

            const result = await this.executeAgent(agentWallet, prompt, {
                threadId: `heartbeat-${agentWallet}`,
                composeRunId: `local-heartbeat-${randomUUID()}`,
                userAddress: identity.userAddress,
                sessionContext: {
                    sessionActive: hasActiveMeshSession(identity),
                    sessionBudgetRemaining: clampBudgetToNumber(identity.budget),
                    sessionGrants: subject.sessionGrants,
                },
            });

            if (!result.success) {
                throw new Error(result.error || "Local heartbeat execution failed");
            }

            if (isHeartbeatOk(result.output)) {
                await appendLocalAgentLog(this.baseDir, agentWallet, "heartbeat ok");
                return;
            }

            const output = String(result.output || "").trim();
            if (output.length === 0) {
                await appendLocalAgentLog(this.baseDir, agentWallet, "heartbeat ok");
                return;
            }

            const singleLine = output.replace(/\s+/g, " ").slice(0, 500);
            await appendLocalAgentLog(this.baseDir, agentWallet, `heartbeat alert: ${singleLine}`);
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            await appendLocalAgentLog(this.baseDir, agentWallet, `heartbeat error: ${message}`);
        } finally {
            if (worker) {
                worker.running = false;
            }
        }
    }
}

let heartbeatHostSingleton: LocalAgentHeartbeatHost | null = null;

export function initializeLocalAgentHeartbeatHost(env: NodeJS.ProcessEnv = process.env): LocalAgentHeartbeatHost | null {
    const baseDir = resolveLocalBaseDir(env);
    if (!baseDir) {
        return null;
    }

    if (!heartbeatHostSingleton) {
        heartbeatHostSingleton = new LocalAgentHeartbeatHost(baseDir);
        heartbeatHostSingleton.start();
    }

    return heartbeatHostSingleton;
}

export function getLocalAgentHeartbeatHost(): LocalAgentHeartbeatHost | null {
    return heartbeatHostSingleton;
}

export {
    buildLocalHeartbeatPrompt,
    loadLocalRuntimeSnapshot,
    resolveLocalBaseDir,
    writeLocalSkillDocument,
} from "./workspace.js";
