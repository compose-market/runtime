import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import {
  createAgent,
  executeAgent,
  streamAgent,
  type AgentConfig,
  type AgentInstance,
  type BackpackConnectedAccount,
  type ExecuteOptions,
} from "./langchain.js";
import {
  extractExecutionPatterns,
  getPatternsCollection,
  promotePatternToSkill,
  searchMemoryLayers,
  validateExtractedPattern,
} from "../memory/index.js";

const HEARTBEAT_OK = "HEARTBEAT_OK";
const DEFAULT_HEARTBEAT_MS = 30_000;
const DEFAULT_REFLECTION_MS = 10 * 60_000;
const DEFAULT_CRON_SESSION_PREFIX = "cron";
const DEFAULT_SUBAGENT_MAX_DEPTH = 3;
const DEFAULT_WORKSPACE_ROOT = process.env.OPENCLAW_WORKSPACE_ROOT || path.resolve(process.cwd(), "data", "openclaw");
const SHARED_SKILLS_ROOT = process.env.OPENCLAW_SHARED_SKILLS_ROOT || path.join(os.homedir(), ".compose", "runtime", "skills");
const BUNDLED_SKILLS_ROOT = process.env.OPENCLAW_BUNDLED_SKILLS_ROOT || path.resolve(process.cwd(), "skills");

type SessionUnlock = () => void;
type PermissionSet = Set<string>;

class SessionLaneLock {
  private tails = new Map<string, Promise<void>>();

  async acquire(sessionKey: string): Promise<SessionUnlock> {
    const prior = this.tails.get(sessionKey) || Promise.resolve();

    let resolveCurrent: (() => void) | null = null;
    const current = new Promise<void>((resolve) => {
      resolveCurrent = resolve;
    });

    this.tails.set(sessionKey, prior.then(() => current));
    await prior;

    let released = false;
    return () => {
      if (released) return;
      released = true;
      resolveCurrent?.();
      if (this.tails.get(sessionKey) === current) {
        this.tails.delete(sessionKey);
      }
    };
  }

  async run<T>(sessionKey: string, task: () => Promise<T>): Promise<T> {
    const unlock = await this.acquire(sessionKey);
    try {
      return await task();
    } finally {
      unlock();
    }
  }
}

interface AgentDnaLock {
  agentWallet: string;
  modelId: string;
  chainId?: number;
  agentCardCid: string;
  mcpToolsHash: string;
  dnaHash?: string;
  lockedAt?: number;
}

interface SkillRequirement {
  bins: string[];
  anyBins: string[];
  env: string[];
  config: string[];
  os: string[];
}

interface SkillSpec {
  key: string;
  source: "agent" | "shared" | "bundled" | "generated";
  path: string;
  name: string;
  description: string;
  commands: string[];
  requirements: SkillRequirement;
  eligible: boolean;
  missing: string[];
  revision: string;
}

interface SkillAuditRecord {
  at: string;
  revision: string;
  action: "created" | "updated" | "rollback";
  skillPath: string;
  patternId?: string;
  confidence?: number;
  notes?: string;
}

interface WorkerCronJob {
  id: string;
  everyMs: number;
  message: string;
  sessionKey: string;
  timer: NodeJS.Timeout | null;
}

interface OpenClawWorker {
  runtime: AgentInstance;
  config: AgentConfig;
  lanes: SessionLaneLock;
  runtimeId: string;
  createdAt: number;
  workspaceRoot: string;
  workspaceSkillsRoot: string;
  generatedSkillsRoot: string;
  logsFile: string;
  dnaLock: AgentDnaLock;
  heartbeatTimer: NodeJS.Timeout | null;
  reflectionTimer: NodeJS.Timeout | null;
  cronJobs: Map<string, WorkerCronJob>;
  skills: Map<string, SkillSpec>;
}

const workers = new Map<string, OpenClawWorker>();

function ensureDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
}

function fileExists(filePath: string): boolean {
  try {
    return fs.existsSync(filePath);
  } catch {
    return false;
  }
}

function sha256Hex(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

function walletWorkspace(agentWallet: string): string {
  return path.join(DEFAULT_WORKSPACE_ROOT, agentWallet.toLowerCase());
}

function heartbeatPath(agentWallet: string): string {
  return path.join(walletWorkspace(agentWallet), "HEARTBEAT.md");
}

function dnaPath(agentWallet: string): string {
  return path.join(walletWorkspace(agentWallet), "DNA.md");
}

function soulPath(agentWallet: string): string {
  return path.join(walletWorkspace(agentWallet), "SOUL.md");
}

function defaultDnaLock(config: AgentConfig): AgentDnaLock {
  const plugins = [...(config.plugins || [])].map((value) => value.trim().toLowerCase()).filter(Boolean).sort();
  return {
    agentWallet: config.agentWallet.toLowerCase(),
    modelId: config.model || "",
    chainId: config.chainId,
    agentCardCid: "unknown",
    mcpToolsHash: sha256Hex(plugins.join("|")),
    dnaHash: undefined,
    lockedAt: Date.now(),
  };
}

function parseMarkdownKeyValue(input: string): Record<string, string> {
  const out: Record<string, string> = {};
  const lines = input.split(/\r?\n/);

  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;

    const idx = line.indexOf(":");
    if (idx <= 0) continue;

    const key = line.slice(0, idx).trim().toLowerCase();
    const value = line.slice(idx + 1).trim();
    if (key) {
      out[key] = value;
    }
  }

  return out;
}

function readDnaLock(config: AgentConfig): AgentDnaLock {
  const file = dnaPath(config.agentWallet);
  if (!fileExists(file)) {
    return defaultDnaLock(config);
  }

  const content = fs.readFileSync(file, "utf8");
  const parsed = parseMarkdownKeyValue(content);

  const lock: AgentDnaLock = {
    agentWallet: (parsed.agentwallet || config.agentWallet).toLowerCase(),
    modelId: parsed.modelid || config.model || "",
    chainId: parsed.chainid ? Number(parsed.chainid) : config.chainId,
    agentCardCid: parsed.agentcardcid || "unknown",
    mcpToolsHash: parsed.mcptoolshash || defaultDnaLock(config).mcpToolsHash,
    dnaHash: parsed.dnahash || undefined,
    lockedAt: parsed.lockedat ? Number(parsed.lockedat) : Date.now(),
  };

  return lock;
}

function verifyDnaLock(config: AgentConfig, lock: AgentDnaLock): void {
  const expectedWallet = config.agentWallet.toLowerCase();
  if (lock.agentWallet !== expectedWallet) {
    throw new Error(`DNA lock wallet mismatch: expected ${expectedWallet}, got ${lock.agentWallet}`);
  }

  if (config.model && lock.modelId && config.model !== lock.modelId) {
    throw new Error(`DNA lock model mismatch: expected ${config.model}, got ${lock.modelId}`);
  }

  if (typeof config.chainId === "number" && typeof lock.chainId === "number" && config.chainId !== lock.chainId) {
    throw new Error(`DNA lock chain mismatch: expected ${config.chainId}, got ${lock.chainId}`);
  }

  const plugins = [...(config.plugins || [])].map((value) => value.trim().toLowerCase()).filter(Boolean).sort();
  const expectedHash = sha256Hex(plugins.join("|"));
  if (lock.mcpToolsHash !== expectedHash) {
    throw new Error(`DNA lock MCP hash mismatch for ${config.agentWallet}`);
  }
}

function writeWorkerLog(worker: OpenClawWorker, level: "info" | "warn" | "error", message: string): void {
  const timestamp = new Date().toISOString();
  const line = `${timestamp} [${level}] ${message}\n`;
  fs.appendFileSync(worker.logsFile, line, { encoding: "utf8" });
}

function readSkillSpec(skillPath: string, source: SkillSpec["source"]): SkillSpec | null {
  if (!fileExists(skillPath)) {
    return null;
  }

  const text = fs.readFileSync(skillPath, "utf8");
  const lines = text.split(/\r?\n/);

  let name = path.basename(path.dirname(skillPath));
  let description = "";
  const commands: string[] = [];
  const requirements: SkillRequirement = {
    bins: [],
    anyBins: [],
    env: [],
    config: [],
    os: [],
  };

  for (const raw of lines) {
    const line = raw.trim();
    if (line.startsWith("# ") && name === path.basename(path.dirname(skillPath))) {
      name = line.slice(2).trim() || name;
      continue;
    }

    const lower = line.toLowerCase();
    if (lower.startsWith("description:")) {
      description = line.slice("description:".length).trim();
      continue;
    }

    if (lower.startsWith("bins:")) {
      requirements.bins.push(...line.slice(5).split(",").map((item) => item.trim()).filter(Boolean));
      continue;
    }

    if (lower.startsWith("anybins:")) {
      requirements.anyBins.push(...line.slice(8).split(",").map((item) => item.trim()).filter(Boolean));
      continue;
    }

    if (lower.startsWith("env:")) {
      requirements.env.push(...line.slice(4).split(",").map((item) => item.trim()).filter(Boolean));
      continue;
    }

    if (lower.startsWith("config:")) {
      requirements.config.push(...line.slice(7).split(",").map((item) => item.trim()).filter(Boolean));
      continue;
    }

    if (lower.startsWith("os:")) {
      requirements.os.push(...line.slice(3).split(",").map((item) => item.trim().toLowerCase()).filter(Boolean));
      continue;
    }

    if (line.startsWith("`") && line.endsWith("`")) {
      commands.push(line.slice(1, -1));
      continue;
    }

    if (line.startsWith("- `") && line.endsWith("`")) {
      commands.push(line.slice(3, -1));
      continue;
    }
  }

  const key = `${source}:${path.basename(path.dirname(skillPath)).toLowerCase()}`;
  const revision = sha256Hex(text);

  const eligibility = evaluateSkillEligibility(requirements, path.dirname(skillPath));
  return {
    key,
    source,
    path: skillPath,
    name,
    description,
    commands,
    requirements,
    eligible: eligibility.eligible,
    missing: eligibility.missing,
    revision,
  };
}

function hasCommand(binary: string): boolean {
  const paths = (process.env.PATH || "").split(path.delimiter).filter(Boolean);
  return paths.some((entry) => {
    const candidate = path.join(entry, binary);
    return fileExists(candidate);
  });
}

function evaluateSkillEligibility(requirements: SkillRequirement, skillDir: string): { eligible: boolean; missing: string[] } {
  const missing: string[] = [];

  for (const bin of requirements.bins) {
    if (!hasCommand(bin)) {
      missing.push(`bin:${bin}`);
    }
  }

  if (requirements.anyBins.length > 0) {
    const anyAvailable = requirements.anyBins.some((bin) => hasCommand(bin));
    if (!anyAvailable) {
      missing.push(`anyBins:${requirements.anyBins.join("|")}`);
    }
  }

  for (const envKey of requirements.env) {
    if (!process.env[envKey]) {
      missing.push(`env:${envKey}`);
    }
  }

  for (const cfg of requirements.config) {
    const target = path.join(skillDir, cfg);
    if (!fileExists(target)) {
      missing.push(`config:${cfg}`);
    }
  }

  if (requirements.os.length > 0) {
    const current = process.platform.toLowerCase();
    const acceptable = requirements.os.map((item) => item.toLowerCase());
    if (!acceptable.some((item) => current.includes(item))) {
      missing.push(`os:${requirements.os.join("|")}`);
    }
  }

  return {
    eligible: missing.length === 0,
    missing,
  };
}

function loadSkills(worker: OpenClawWorker): Map<string, SkillSpec> {
  const discovered = new Map<string, SkillSpec>();

  const roots: Array<{ root: string; source: SkillSpec["source"] }> = [
    { root: worker.workspaceSkillsRoot, source: "agent" },
    { root: SHARED_SKILLS_ROOT, source: "shared" },
    { root: BUNDLED_SKILLS_ROOT, source: "bundled" },
    { root: worker.generatedSkillsRoot, source: "generated" },
  ];

  for (const { root, source } of roots) {
    if (!fileExists(root)) continue;

    const entries = fs.readdirSync(root, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const skillMd = path.join(root, entry.name, "SKILL.md");
      const spec = readSkillSpec(skillMd, source);
      if (!spec) continue;

      if (!discovered.has(spec.key)) {
        discovered.set(spec.key, spec);
      }
    }
  }

  return discovered;
}

function skillsPrompt(skills: Map<string, SkillSpec>): string {
  const values = [...skills.values()].filter((skill) => skill.eligible);
  if (values.length === 0) {
    return "No eligible local skills are currently installed.";
  }

  const compact = values.slice(0, 48).map((skill) => {
    const commandPreview = skill.commands.slice(0, 3).join(", ");
    return `- ${skill.name} [${skill.key}]${commandPreview ? ` commands: ${commandPreview}` : ""}`;
  });

  return [
    "Eligible local skills (OpenClaw precedence: agent -> shared -> bundled -> generated):",
    ...compact,
  ].join("\n");
}

function parseSessionKey(agentWallet: string, threadId?: string, explicit?: string): string {
  if (explicit && explicit.trim().length > 0) {
    return explicit.trim();
  }

  const normalizedThread = threadId?.trim();
  if (normalizedThread) {
    return `agent:${agentWallet}:session:${normalizedThread}`;
  }

  return `agent:${agentWallet}:session:main`;
}

function withSkillContext(message: string, skills: Map<string, SkillSpec>): string {
  const prefix = skillsPrompt(skills);
  return `${prefix}\n\nUser message:\n${message}`;
}

function ensureWorkspaceFiles(config: AgentConfig): void {
  const root = walletWorkspace(config.agentWallet);
  ensureDir(root);
  ensureDir(path.join(root, "skills"));
  ensureDir(path.join(root, "skills", "generated"));

  const defaults: Array<{ file: string; content: string }> = [
    {
      file: dnaPath(config.agentWallet),
      content: [
        "# DNA",
        `agentWallet: ${config.agentWallet.toLowerCase()}`,
        `modelId: ${config.model || ""}`,
        `chainId: ${config.chainId || ""}`,
        `agentCardCid: unknown`,
        `mcpToolsHash: ${defaultDnaLock(config).mcpToolsHash}`,
        `dnaHash: `,
        `lockedAt: ${Date.now()}`,
        "",
      ].join("\n"),
    },
    {
      file: soulPath(config.agentWallet),
      content: "# SOUL\n\nMutable behavior and persona notes for this local deployment.\n",
    },
    {
      file: heartbeatPath(config.agentWallet),
      content: "# HEARTBEAT\n\nKeep checks lightweight. Reply exactly HEARTBEAT_OK when no action is needed.\n",
    },
    {
      file: path.join(root, "AGENTS.md"),
      content: "# AGENTS\n\nPer-agent local instructions and workflow policies.\n",
    },
    {
      file: path.join(root, "TOOLS.md"),
      content: "# TOOLS\n\nImmutable MCP/GOAT tool identities are derived from DNA.md.\n",
    },
    {
      file: path.join(root, "IDENTITY.md"),
      content: `# IDENTITY\n\nagentWallet: ${config.agentWallet.toLowerCase()}\n`,
    },
    {
      file: path.join(root, "USER.md"),
      content: "# USER\n\nPer-user local preferences and policies.\n",
    },
  ];

  for (const item of defaults) {
    if (!fileExists(item.file)) {
      fs.writeFileSync(item.file, item.content, "utf8");
    }
  }
}

function parseSubagentDepth(sessionKey: string): number {
  const match = sessionKey.match(/subagent:depth:(\d+)/i);
  if (!match) return 0;
  const value = Number(match[1]);
  return Number.isFinite(value) ? value : 0;
}

async function runHeartbeat(worker: OpenClawWorker): Promise<void> {
  const file = heartbeatPath(worker.runtime.id);
  if (!fileExists(file)) return;

  const prompt = fs.readFileSync(file, "utf8").trim();
  if (!prompt) return;

  const sessionKey = `agent:${worker.runtime.id}:session:main`;
  await worker.lanes.run(sessionKey, async () => {
    const result = await executeAgent(worker.runtime.id, prompt, {
      threadId: `heartbeat-${worker.runtime.id}`,
      userId: worker.config.userId,
      workflowWallet: worker.config.workflowWallet,
      sessionContext: {
        sessionActive: true,
        sessionBudgetRemaining: Number.MAX_SAFE_INTEGER,
      },
    });

    if (!result.success) {
      writeWorkerLog(worker, "warn", `heartbeat failed: ${result.error || "unknown"}`);
      return;
    }

    const output = result.output?.trim() || "";
    if (output && output !== HEARTBEAT_OK) {
      writeWorkerLog(worker, "warn", `heartbeat alert: ${output.slice(0, 240)}`);
    }
  });
}

async function appendSkillAudit(worker: OpenClawWorker, record: SkillAuditRecord): Promise<void> {
  const auditPath = path.join(worker.generatedSkillsRoot, "audit.jsonl");
  ensureDir(path.dirname(auditPath));
  fs.appendFileSync(auditPath, `${JSON.stringify(record)}\n`, "utf8");
}

async function runReflection(worker: OpenClawWorker): Promise<void> {
  try {
    await searchMemoryLayers({
      query: "recent successful tool sequences and outcomes",
      agentWallet: worker.runtime.id,
      userId: worker.config.userId,
      layers: ["patterns", "working", "scene"],
      limit: 5,
    });

    await extractExecutionPatterns({
      agentWallet: worker.runtime.id,
      timeRange: {
        start: Date.now() - 7 * 24 * 60 * 60 * 1000,
        end: Date.now(),
      },
      confidenceThreshold: 0.25,
    });

    const patternsCollection = await getPatternsCollection();
    const patterns = await patternsCollection
      .find({ agentWallet: worker.runtime.id })
      .sort({ updatedAt: -1, successRate: -1 })
      .limit(6)
      .toArray();

    for (const pattern of patterns) {
      const validation = await validateExtractedPattern({ patternId: pattern.patternId });
      if (!validation.valid) continue;

      const promoted = await promotePatternToSkill({
        patternId: pattern.patternId,
        skillName: `learned-${pattern.patternId.slice(0, 8)}`,
        validationData: validation,
      });
      if (!promoted.promoted || !promoted.skillId) continue;

      const skillDir = path.join(worker.generatedSkillsRoot, promoted.skillId);
      ensureDir(skillDir);
      const skillPath = path.join(skillDir, "SKILL.md");
      const skillContents = [
        `# ${promoted.skillId}`,
        `description: Auto-generated from pattern ${pattern.patternId}`,
        `env:`,
        `bins:`,
        `os:`,
        "",
        "## Commands",
        ...validation.toolSequence.map((tool) => `- \`${tool}\``),
        "",
      ].join("\n");

      if (fileExists(skillPath)) {
        const previous = fs.readFileSync(skillPath, "utf8");
        const backup = `${skillPath}.${Date.now()}.bak`;
        fs.writeFileSync(backup, previous, "utf8");
        await appendSkillAudit(worker, {
          at: new Date().toISOString(),
          revision: sha256Hex(previous),
          action: "rollback",
          skillPath: backup,
          notes: "pre-update backup",
        });
      }

      fs.writeFileSync(skillPath, skillContents, "utf8");
      await appendSkillAudit(worker, {
        at: new Date().toISOString(),
        revision: sha256Hex(skillContents),
        action: "created",
        skillPath,
        patternId: pattern.patternId,
        confidence: validation.confidence,
      });
    }

    worker.skills = loadSkills(worker);
  } catch (error) {
    writeWorkerLog(worker, "warn", `reflection skipped: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function startBackgroundLoops(worker: OpenClawWorker): void {
  if (worker.heartbeatTimer) clearInterval(worker.heartbeatTimer);
  worker.heartbeatTimer = setInterval(() => {
    void runHeartbeat(worker).catch((error) => {
      writeWorkerLog(worker, "error", `heartbeat loop error: ${error instanceof Error ? error.message : String(error)}`);
    });
  }, DEFAULT_HEARTBEAT_MS);

  if (worker.reflectionTimer) clearInterval(worker.reflectionTimer);
  worker.reflectionTimer = setInterval(() => {
    void runReflection(worker).catch((error) => {
      writeWorkerLog(worker, "error", `reflection loop error: ${error instanceof Error ? error.message : String(error)}`);
    });
  }, DEFAULT_REFLECTION_MS);
}

function stopBackgroundLoops(worker: OpenClawWorker): void {
  if (worker.heartbeatTimer) {
    clearInterval(worker.heartbeatTimer);
    worker.heartbeatTimer = null;
  }

  if (worker.reflectionTimer) {
    clearInterval(worker.reflectionTimer);
    worker.reflectionTimer = null;
  }

  for (const job of worker.cronJobs.values()) {
    if (job.timer) {
      clearInterval(job.timer);
      job.timer = null;
    }
  }
  worker.cronJobs.clear();
}

function toExecutionOptions(params: OpenClawExecutionParams): ExecuteOptions {
  return {
    threadId: params.threadId,
    userId: params.userId,
    workflowWallet: params.workflowWallet,
    sessionContext: {
      sessionActive: true,
      sessionBudgetRemaining: Number.MAX_SAFE_INTEGER,
      grantedPermissions: params.grantedPermissions || [],
      permissionPolicy: params.permissionPolicy,
      backpackAccounts: params.backpackAccounts,
    },
  };
}

function normalizePermissions(grantedPermissions?: string[]): PermissionSet {
  return new Set((grantedPermissions || []).map((item) => item.trim().toLowerCase()).filter(Boolean));
}

function hasPermission(grants: PermissionSet, key: string): boolean {
  if (grants.has("*")) return true;
  if (grants.has(key)) return true;
  if (key.startsWith("fs.") && grants.has("filesystem")) return true;
  return false;
}

function enforceSessionPermissions(sessionKey: string, grantedPermissions?: string[]): void {
  const grants = normalizePermissions(grantedPermissions);

  const requiredByPrefix: Array<{ prefix: string; permission: string }> = [
    { prefix: "cron:", permission: "runtime.cron" },
    { prefix: "subagent:", permission: "runtime.subagent" },
    { prefix: "agent:", permission: "runtime.main" },
  ];

  for (const { prefix, permission } of requiredByPrefix) {
    if (sessionKey.includes(prefix) && !hasPermission(grants, permission)) {
      throw new Error(`Permission denied for ${permission}`);
    }
  }
}

function ensureWorker(agentWallet: string): OpenClawWorker {
  const worker = workers.get(agentWallet);
  if (!worker) {
    throw new Error(`OpenClaw worker not found for ${agentWallet}`);
  }
  return worker;
}

export interface OpenClawExecutionParams {
  agentWallet: string;
  model: string;
  message: string;
  userId?: string;
  threadId?: string;
  sessionKey?: string;
  workflowWallet?: string;
  grantedPermissions?: string[];
  permissionPolicy?: Record<string, "allow" | "ask" | "deny">;
  backpackAccounts?: BackpackConnectedAccount[];
  subagentDepth?: number;
}

export interface OpenClawExecutionResult {
  success: boolean;
  output?: string;
  usage?: Record<string, unknown>;
  promptTokens?: number;
  completionTokens?: number;
  runtimeId: string;
  containerName: string;
  sessionKey: string;
  toolCalls: Array<{ name: string; content?: string }>;
  skillsRevision: string;
}

export async function createOpenClawAgent(config: AgentConfig): Promise<AgentInstance> {
  if (workers.has(config.agentWallet)) {
    return workers.get(config.agentWallet)!.runtime;
  }

  ensureWorkspaceFiles(config);

  const root = walletWorkspace(config.agentWallet);
  ensureDir(root);
  ensureDir(path.join(root, "skills"));
  ensureDir(path.join(root, "skills", "generated"));

  const dnaLock = readDnaLock(config);
  verifyDnaLock(config, dnaLock);

  const runtime = await createAgent({
    ...config,
    systemPrompt: `${config.systemPrompt || `You are ${config.name}.`}\n\nRuntime invariants:\n- DNA lock is immutable at runtime\n- MCP/tool identity cannot mutate from skills\n- Self-learning may only add local skills`,
  });

  const logsFile = path.join(root, "runtime.log");
  if (!fileExists(logsFile)) {
    fs.writeFileSync(logsFile, "", "utf8");
  }

  const worker: OpenClawWorker = {
    runtime,
    config,
    lanes: new SessionLaneLock(),
    runtimeId: `openclaw-${config.agentWallet}-${Date.now()}`,
    createdAt: Date.now(),
    workspaceRoot: root,
    workspaceSkillsRoot: path.join(root, "skills"),
    generatedSkillsRoot: path.join(root, "skills", "generated"),
    logsFile,
    dnaLock,
    heartbeatTimer: null,
    reflectionTimer: null,
    cronJobs: new Map(),
    skills: new Map(),
  };

  worker.skills = loadSkills(worker);
  startBackgroundLoops(worker);
  workers.set(config.agentWallet, worker);

  writeWorkerLog(worker, "info", `worker started runtimeId=${worker.runtimeId} skills=${worker.skills.size}`);
  return runtime;
}

export function scheduleOpenClawCron(input: {
  agentWallet: string;
  id: string;
  everyMs: number;
  message: string;
}): void {
  const worker = ensureWorker(input.agentWallet);
  const everyMs = Math.max(1_000, input.everyMs);
  const sessionKey = `${DEFAULT_CRON_SESSION_PREFIX}:${input.id}`;

  const existing = worker.cronJobs.get(input.id);
  if (existing?.timer) {
    clearInterval(existing.timer);
  }

  const job: WorkerCronJob = {
    id: input.id,
    everyMs,
    message: input.message,
    sessionKey,
    timer: setInterval(() => {
      void executeOpenClawAgent({
        agentWallet: input.agentWallet,
        model: worker.config.model || "",
        message: input.message,
        sessionKey,
        userId: worker.config.userId,
        workflowWallet: worker.config.workflowWallet,
        grantedPermissions: ["runtime.cron", "runtime.main"],
      }).catch((error) => {
        writeWorkerLog(worker, "warn", `cron ${input.id} failed: ${error instanceof Error ? error.message : String(error)}`);
      });
    }, everyMs),
  };

  worker.cronJobs.set(input.id, job);
  writeWorkerLog(worker, "info", `cron scheduled id=${input.id} everyMs=${everyMs}`);
}

export function unscheduleOpenClawCron(agentWallet: string, jobId: string): void {
  const worker = ensureWorker(agentWallet);
  const job = worker.cronJobs.get(jobId);
  if (!job) return;

  if (job.timer) {
    clearInterval(job.timer);
  }
  worker.cronJobs.delete(jobId);
  writeWorkerLog(worker, "info", `cron unscheduled id=${jobId}`);
}

export async function executeOpenClawAgent(params: OpenClawExecutionParams): Promise<OpenClawExecutionResult> {
  const worker = ensureWorker(params.agentWallet);
  worker.skills = loadSkills(worker);

  const sessionKey = parseSessionKey(params.agentWallet, params.threadId, params.sessionKey);
  const subDepth = sessionKey.includes("subagent") ? parseSubagentDepth(sessionKey) : (params.subagentDepth || 0);
  if (subDepth > DEFAULT_SUBAGENT_MAX_DEPTH) {
    throw new Error(`Subagent depth exceeded (${subDepth} > ${DEFAULT_SUBAGENT_MAX_DEPTH})`);
  }

  enforceSessionPermissions(sessionKey, params.grantedPermissions);

  const message = withSkillContext(params.message, worker.skills);

  const execution = await worker.lanes.run(sessionKey, async () => {
    return executeAgent(params.agentWallet, message, toExecutionOptions(params));
  });

  writeWorkerLog(worker, execution.success ? "info" : "warn", `session=${sessionKey} success=${execution.success}`);

  const skillRevision = sha256Hex(
    [...worker.skills.values()].map((item) => `${item.key}:${item.revision}:${item.eligible}`).sort().join("|"),
  );

  return {
    success: execution.success,
    output: execution.output,
    usage: execution.usage,
    promptTokens: execution.promptTokens,
    completionTokens: execution.completionTokens,
    runtimeId: worker.runtimeId,
    containerName: worker.runtime.id,
    sessionKey,
    toolCalls: execution.messages
      .filter((messageItem) => messageItem.role === "tool")
      .map((messageItem, idx) => ({
        name: `tool-${idx + 1}`,
        content: messageItem.content,
      })),
    skillsRevision: skillRevision,
  };
}

export async function* streamOpenClawAgent(params: OpenClawExecutionParams): AsyncGenerator<unknown> {
  const worker = ensureWorker(params.agentWallet);
  worker.skills = loadSkills(worker);

  const sessionKey = parseSessionKey(params.agentWallet, params.threadId, params.sessionKey);
  const subDepth = sessionKey.includes("subagent") ? parseSubagentDepth(sessionKey) : (params.subagentDepth || 0);
  if (subDepth > DEFAULT_SUBAGENT_MAX_DEPTH) {
    throw new Error(`Subagent depth exceeded (${subDepth} > ${DEFAULT_SUBAGENT_MAX_DEPTH})`);
  }

  enforceSessionPermissions(sessionKey, params.grantedPermissions);

  const unlock = await worker.lanes.acquire(sessionKey);

  try {
    const message = withSkillContext(params.message, worker.skills);
    for await (const chunk of streamAgent(params.agentWallet, message, toExecutionOptions(params))) {
      yield chunk;
    }
    writeWorkerLog(worker, "info", `stream completed session=${sessionKey}`);
  } finally {
    unlock();
  }
}

export async function executeOpenClawSubagent(input: {
  agentWallet: string;
  model: string;
  message: string;
  parentSessionKey: string;
  subagentId: string;
  depth: number;
  grantedPermissions?: string[];
}): Promise<OpenClawExecutionResult> {
  if (input.depth > DEFAULT_SUBAGENT_MAX_DEPTH) {
    throw new Error(`Subagent depth exceeded (${input.depth} > ${DEFAULT_SUBAGENT_MAX_DEPTH})`);
  }

  return executeOpenClawAgent({
    agentWallet: input.agentWallet,
    model: input.model,
    message: input.message,
    sessionKey: `subagent:${input.subagentId}:depth:${input.depth}:parent:${input.parentSessionKey}`,
    grantedPermissions: [
      ...(input.grantedPermissions || []),
      "runtime.subagent",
      "runtime.main",
    ],
  });
}

export function getOpenClawWorkerStatus(agentWallet: string): {
  running: boolean;
  runtimeId?: string;
  createdAt?: number;
  cronJobs?: string[];
  skills?: Array<{ key: string; eligible: boolean; source: string; revision: string }>;
} {
  const worker = workers.get(agentWallet);
  if (!worker) {
    return { running: false };
  }

  return {
    running: true,
    runtimeId: worker.runtimeId,
    createdAt: worker.createdAt,
    cronJobs: [...worker.cronJobs.keys()],
    skills: [...worker.skills.values()].map((item) => ({
      key: item.key,
      eligible: item.eligible,
      source: item.source,
      revision: item.revision,
    })),
  };
}

export function stopOpenClawAgent(agentWallet: string): void {
  const worker = workers.get(agentWallet);
  if (!worker) return;

  stopBackgroundLoops(worker);
  writeWorkerLog(worker, "info", "worker stopped");
  workers.delete(agentWallet);
}

export function getOpenClawWorkerLogs(agentWallet: string, maxLines = 200): string[] {
  const worker = workers.get(agentWallet);
  const logsPath = worker?.logsFile || path.join(walletWorkspace(agentWallet), "runtime.log");

  if (!fileExists(logsPath)) {
    return [];
  }

  const lines = fs.readFileSync(logsPath, "utf8").split(/\r?\n/).filter(Boolean);
  if (lines.length <= maxLines) {
    return lines;
  }
  return lines.slice(lines.length - maxLines);
}
