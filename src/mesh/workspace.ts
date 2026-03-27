import path from "node:path";
import { appendFile, mkdir, readdir, readFile, writeFile } from "node:fs/promises";

const HEARTBEAT_OK_TOKEN = "HEARTBEAT_OK";
const DEFAULT_HEARTBEAT_INTERVAL_MS = 30_000;

interface PersistedLocalIdentity {
    userAddress?: string;
    composeKeyToken?: string;
    sessionId?: string;
    budget?: string;
    duration?: number;
    chainId?: number;
    expiresAt?: number;
    deviceId?: string;
}

interface PersistedInstalledAgent {
    agentWallet?: string;
    heartbeat?: {
        enabled?: boolean;
        intervalMs?: number;
    };
}

interface PersistedLocalState {
    identity?: PersistedLocalIdentity | null;
    installedAgents?: PersistedInstalledAgent[];
}

interface DaemonPermissionPolicy {
    shell?: string;
    filesystem_read?: string;
    filesystem_write?: string;
    filesystem_edit?: string;
    filesystem_delete?: string;
    camera?: string;
    microphone?: string;
    network?: string;
}

interface DaemonAgentState {
    agent_wallet?: string;
    desired_running?: boolean;
    permissions?: DaemonPermissionPolicy;
}

interface DaemonStateFile {
    agents?: Record<string, DaemonAgentState>;
}

export interface LocalIdentitySnapshot {
    userAddress: string;
    composeKeyToken: string;
    sessionId: string;
    budget: string;
    duration: number;
    chainId: number;
    expiresAt: number;
    deviceId: string;
}

export interface LocalHeartbeatSubject {
    agentWallet: string;
    desiredRunning: boolean;
    heartbeatEnabled: boolean;
    intervalMs: number;
    sessionGrants: string[];
}

export interface LocalRuntimeSnapshot {
    identity: LocalIdentitySnapshot | null;
    sharedSkillRelativePaths: string[];
    agents: Map<string, LocalHeartbeatSubject>;
}

export interface LocalSkillDocument {
    relativePath: string;
    content: string;
}

export interface WriteLocalSkillInput {
    agentWallet: string;
    skillName: string;
    skillMarkdown: string;
}

function normalizeWallet(value: unknown): string | null {
    if (typeof value !== "string") {
        return null;
    }
    const normalized = value.trim().toLowerCase();
    return /^0x[a-f0-9]{40}$/.test(normalized) ? normalized : null;
}

function normalizeRelativePath(value: string): string {
    return value.trim().replace(/^\/+/, "").replace(/\\/g, "/");
}

function runtimeStatePath(baseDir: string): string {
    return path.join(baseDir, "state.json");
}

function daemonStatePath(baseDir: string): string {
    return path.join(baseDir, "daemon_state.json");
}

function agentWorkspaceDir(baseDir: string, agentWallet: string): string {
    return path.join(baseDir, "agents", agentWallet.toLowerCase());
}

function agentRuntimeLogPath(baseDir: string, agentWallet: string): string {
    return path.join(agentWorkspaceDir(baseDir, agentWallet), "runtime.log");
}

function agentGeneratedSkillsDir(baseDir: string, agentWallet: string): string {
    return path.join(agentWorkspaceDir(baseDir, agentWallet), "skills", "generated");
}

function createSessionGrants(policy: DaemonPermissionPolicy | undefined): string[] {
    const grants = ["runtime.main", "runtime.cron", "runtime.subagent"];

    if (policy?.shell === "allow") grants.push("shell");
    if (policy?.filesystem_read === "allow") grants.push("fs.read");
    if (policy?.filesystem_write === "allow") grants.push("fs.write");
    if (policy?.filesystem_edit === "allow") grants.push("fs.edit");
    if (policy?.filesystem_delete === "allow") grants.push("fs.delete");
    if (policy?.camera === "allow") grants.push("camera");
    if (policy?.microphone === "allow") grants.push("microphone");
    if (policy?.network === "allow") grants.push("network");

    return grants;
}

async function readJsonFile<T>(filePath: string, fallback: T): Promise<T> {
    try {
        const raw = await readFile(filePath, "utf8");
        return JSON.parse(raw) as T;
    } catch {
        return fallback;
    }
}

function normalizeIdentity(identity: PersistedLocalIdentity | null | undefined): LocalIdentitySnapshot | null {
    const userAddress = normalizeWallet(identity?.userAddress);
    if (!userAddress) {
        return null;
    }

    return {
        userAddress,
        composeKeyToken: typeof identity?.composeKeyToken === "string" ? identity.composeKeyToken.trim() : "",
        sessionId: typeof identity?.sessionId === "string" ? identity.sessionId.trim() : "",
        budget: typeof identity?.budget === "string" ? identity.budget.trim() : "0",
        duration: Number.isFinite(identity?.duration) ? Number(identity?.duration) : 0,
        chainId: Number.isFinite(identity?.chainId) ? Number(identity?.chainId) : 0,
        expiresAt: Number.isFinite(identity?.expiresAt) ? Number(identity?.expiresAt) : 0,
        deviceId: typeof identity?.deviceId === "string" ? identity.deviceId.trim() : "",
    };
}

export function hasActiveMeshSession(identity: LocalIdentitySnapshot | null | undefined): boolean {
    if (!identity) {
        return false;
    }
    if (!identity.composeKeyToken || identity.expiresAt <= Date.now()) {
        return false;
    }
    try {
        return BigInt(identity.budget || "0") > 0n;
    } catch {
        return false;
    }
}

export function clampBudgetToNumber(value: string): number {
    try {
        const parsed = BigInt(value);
        if (parsed <= 0n) {
            return 0;
        }
        const max = BigInt(Number.MAX_SAFE_INTEGER);
        return Number(parsed > max ? max : parsed);
    } catch {
        return 0;
    }
}

export async function loadLocalRuntimeSnapshot(baseDir: string): Promise<LocalRuntimeSnapshot> {
    const [runtimeState, daemonState, sharedSkillFiles] = await Promise.all([
        readJsonFile<PersistedLocalState>(runtimeStatePath(baseDir), {}),
        readJsonFile<DaemonStateFile>(daemonStatePath(baseDir), {}),
        listSkillDocuments(path.join(baseDir, "skills")),
    ]);

    const heartbeatByWallet = new Map<string, { heartbeatEnabled: boolean; intervalMs: number }>();
    for (const agent of runtimeState.installedAgents || []) {
        const wallet = normalizeWallet(agent.agentWallet);
        if (!wallet) {
            continue;
        }
        heartbeatByWallet.set(wallet, {
            heartbeatEnabled: agent.heartbeat?.enabled !== false,
            intervalMs: Number.isFinite(agent.heartbeat?.intervalMs)
                ? Math.max(5_000, Number(agent.heartbeat?.intervalMs))
                : DEFAULT_HEARTBEAT_INTERVAL_MS,
        });
    }

    const agents = new Map<string, LocalHeartbeatSubject>();
    for (const [recordKey, daemonAgent] of Object.entries(daemonState.agents || {})) {
        const wallet = normalizeWallet(recordKey) || normalizeWallet(daemonAgent.agent_wallet);
        if (!wallet) {
            continue;
        }

        const heartbeat = heartbeatByWallet.get(wallet);
        agents.set(wallet, {
            agentWallet: wallet,
            desiredRunning: daemonAgent.desired_running === true,
            heartbeatEnabled: heartbeat?.heartbeatEnabled !== false,
            intervalMs: heartbeat?.intervalMs || DEFAULT_HEARTBEAT_INTERVAL_MS,
            sessionGrants: createSessionGrants(daemonAgent.permissions),
        });
    }

    const sharedSkillRelativePaths = Array.from(new Set(sharedSkillFiles));

    return {
        identity: normalizeIdentity(runtimeState.identity),
        sharedSkillRelativePaths: sharedSkillRelativePaths
            .map((filePath) => normalizeRelativePath(path.relative(baseDir, path.dirname(filePath))))
            .filter(Boolean)
            .sort((left, right) => left.localeCompare(right)),
        agents,
    };
}

async function readFileIfPresent(filePath: string): Promise<string | null> {
    try {
        return await readFile(filePath, "utf8");
    } catch {
        return null;
    }
}

async function listSkillDocuments(rootDir: string): Promise<string[]> {
    try {
        const entries = await readdir(rootDir, { withFileTypes: true });
        const files: string[] = [];
        for (const entry of entries) {
            const entryPath = path.join(rootDir, entry.name);
            if (entry.isDirectory()) {
                files.push(...await listSkillDocuments(entryPath));
                continue;
            }
            if (entry.isFile() && entry.name === "SKILL.md") {
                files.push(entryPath);
            }
        }
        return files.sort((left, right) => left.localeCompare(right));
    } catch {
        return [];
    }
}

export async function readAgentGeneratedSkillDocuments(
    baseDir: string,
    agentWallet: string,
): Promise<LocalSkillDocument[]> {
    const files = await listSkillDocuments(agentGeneratedSkillsDir(baseDir, agentWallet));
    const documents = await Promise.all(
        files.map(async (filePath) => {
            const content = await readFileIfPresent(filePath);
            if (!content || content.trim().length === 0) {
                return null;
            }
            return {
                relativePath: normalizeRelativePath(path.relative(baseDir, filePath)),
                content: content.trim(),
            };
        }),
    );

    return documents.filter((document): document is LocalSkillDocument => document !== null);
}

function formatSection(label: string, content: string | null): string | null {
    if (!content || content.trim().length === 0) {
        return null;
    }
    return `[${label}]\n${content.trim()}`;
}

export async function buildLocalHeartbeatPrompt(
    baseDir: string,
    snapshot: LocalRuntimeSnapshot,
    agentWallet: string,
): Promise<string | null> {
    const workspaceDir = agentWorkspaceDir(baseDir, agentWallet);
    const sharedSkillSections = await Promise.all(
        snapshot.sharedSkillRelativePaths.map(async (relativePath) => {
            const skillMd = await readFileIfPresent(path.join(baseDir, relativePath, "SKILL.md"));
            return formatSection(`${relativePath}/SKILL.md`, skillMd);
        }),
    );
    const generatedSkillSections = await readAgentGeneratedSkillDocuments(baseDir, agentWallet);

    const sections = [
        formatSection("AGENTS.md", await readFileIfPresent(path.join(workspaceDir, "AGENTS.md"))),
        formatSection("SOUL.md", await readFileIfPresent(path.join(workspaceDir, "SOUL.md"))),
        formatSection("TOOLS.md", await readFileIfPresent(path.join(workspaceDir, "TOOLS.md"))),
        formatSection("IDENTITY.md", await readFileIfPresent(path.join(workspaceDir, "IDENTITY.md"))),
        formatSection("USER.md", await readFileIfPresent(path.join(workspaceDir, "USER.md"))),
        formatSection("HEARTBEAT.md", await readFileIfPresent(path.join(workspaceDir, "HEARTBEAT.md"))),
        ...sharedSkillSections,
        ...generatedSkillSections.map((document) => formatSection(document.relativePath, document.content)),
    ].filter((section): section is string => section !== null);

    if (sections.length === 0) {
        return null;
    }

    return [
        "You are running as a fully local, always-on agent on the user's device.",
        "Read the local operating files below and do only device-owned/local skill work.",
        `If no work is needed right now, respond exactly with ${HEARTBEAT_OK_TOKEN}.`,
        "If you discover a reusable local procedure, persist it with save_local_skill so it stays on this device.",
        "",
        sections.join("\n\n"),
    ].join("\n");
}

function slugify(value: string): string {
    const normalized = value
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "");
    return normalized || "skill";
}

export async function appendLocalAgentLog(
    baseDir: string,
    agentWallet: string,
    message: string,
): Promise<void> {
    const logPath = agentRuntimeLogPath(baseDir, agentWallet);
    await mkdir(path.dirname(logPath), { recursive: true });
    const line = `[${new Date().toISOString()}] ${message.trim()}\n`;
    await appendFile(logPath, line, "utf8");
}

export async function writeLocalSkillDocument(
    baseDir: string,
    input: WriteLocalSkillInput,
): Promise<{ absolutePath: string; relativePath: string }> {
    const agentWallet = normalizeWallet(input.agentWallet);
    if (!agentWallet) {
        throw new Error("agentWallet must be a valid wallet address");
    }

    const skillName = input.skillName.trim();
    if (!skillName) {
        throw new Error("skillName is required");
    }

    const rawMarkdown = input.skillMarkdown.trim();
    if (!rawMarkdown) {
        throw new Error("skillMarkdown is required");
    }

    const directory = path.join(agentGeneratedSkillsDir(baseDir, agentWallet), slugify(skillName));
    const filePath = path.join(directory, "SKILL.md");
    const normalizedMarkdown = rawMarkdown.startsWith("#")
        ? rawMarkdown
        : `# ${skillName}\n\n${rawMarkdown}`;

    await mkdir(directory, { recursive: true });
    await writeFile(filePath, normalizedMarkdown.endsWith("\n") ? normalizedMarkdown : `${normalizedMarkdown}\n`, "utf8");

    return {
        absolutePath: filePath,
        relativePath: normalizeRelativePath(path.relative(baseDir, filePath)),
    };
}

export function isHeartbeatOk(output: string | null | undefined): boolean {
    const trimmed = String(output || "").trim().toUpperCase();
    return trimmed === HEARTBEAT_OK_TOKEN || trimmed.startsWith(`${HEARTBEAT_OK_TOKEN}\n`);
}

export function resolveLocalBaseDir(env: NodeJS.ProcessEnv = process.env): string | null {
    if (env.RUNTIME_HOST_MODE !== "local") {
        return null;
    }
    const baseDir = String(env.COMPOSE_LOCAL_BASE_DIR || "").trim();
    return baseDir.length > 0 ? baseDir : null;
}
