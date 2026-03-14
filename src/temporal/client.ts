import { createHash } from "crypto";
import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";
import { Client, Connection } from "@temporalio/client";
import type { VersioningOverride, WorkerDeploymentVersion } from "@temporalio/common";

let cachedConnection: Connection | null = null;
let cachedClient: Client | null = null;
let cachedDeploymentVersion: WorkerDeploymentVersion | null = null;
let cachedPackageMetadata: { name: string; version: string } | null = null;

function normalizeAddress(rawAddress: string): string {
    return rawAddress.replace(/^https?:\/\//, "").replace(/\/$/, "");
}

function getRuntimeRootDirectory(): string {
    const currentDirectory = path.dirname(fileURLToPath(import.meta.url));
    return path.resolve(currentDirectory, "..", "..");
}

function readPackageMetadata(): { name: string; version: string } {
    if (cachedPackageMetadata) {
        return cachedPackageMetadata;
    }

    const packageJsonPath = path.join(getRuntimeRootDirectory(), "package.json");
    const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf8")) as {
        name?: string;
        version?: string;
    };

    if (!packageJson.name || !packageJson.version) {
        throw new Error(`Invalid runtime package metadata at ${packageJsonPath}`);
    }

    cachedPackageMetadata = {
        name: packageJson.name,
        version: packageJson.version,
    };

    return cachedPackageMetadata;
}

function sanitizeIdentifier(value: string): string {
    return value
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "");
}

function collectFingerprintFiles(directory: string, extensions: ReadonlySet<string>): string[] {
    const files: string[] = [];
    const entries = fs.readdirSync(directory, { withFileTypes: true });

    for (const entry of entries) {
        if (entry.name.startsWith(".")) {
            continue;
        }

        const fullPath = path.join(directory, entry.name);
        if (entry.isDirectory()) {
            files.push(...collectFingerprintFiles(fullPath, extensions));
            continue;
        }

        if (extensions.has(path.extname(entry.name))) {
            files.push(fullPath);
        }
    }

    return files;
}

function resolveBuildFingerprintRoot(): { root: string; extensions: ReadonlySet<string> } {
    const runtimeRoot = getRuntimeRootDirectory();
    const distRoot = path.join(runtimeRoot, "dist");
    if (fs.existsSync(distRoot)) {
        return {
            root: distRoot,
            extensions: new Set([".js", ".json"]),
        };
    }

    const sourceRoot = path.join(runtimeRoot, "src");
    if (fs.existsSync(sourceRoot)) {
        return {
            root: sourceRoot,
            extensions: new Set([".ts", ".json"]),
        };
    }

    throw new Error("Unable to locate runtime source or build output for Temporal deployment fingerprinting");
}

function computeDeploymentBuildId(): string {
    const { name, version } = readPackageMetadata();
    const { root, extensions } = resolveBuildFingerprintRoot();
    const hash = createHash("sha256");
    const files = collectFingerprintFiles(root, extensions).sort((left, right) => left.localeCompare(right));

    for (const filePath of files) {
        hash.update(path.relative(root, filePath));
        hash.update("\0");
        hash.update(fs.readFileSync(filePath));
        hash.update("\0");
    }

    return `${name}@${version}+${hash.digest("hex").slice(0, 24)}`;
}

export function isTemporalConfigured(): boolean {
    return Boolean(
        process.env.TEMPORAL_NAMESPACE &&
        process.env.TEMPORAL_ADDRESS &&
        process.env.TEMPORAL_API_KEY,
    );
}

export function getTemporalNamespace(): string {
    const namespace = process.env.TEMPORAL_NAMESPACE;
    if (!namespace) {
        throw new Error("TEMPORAL_NAMESPACE is required");
    }
    return namespace;
}

export function getTemporalAddress(): string {
    const endpoint = process.env.TEMPORAL_ADDRESS;
    if (!endpoint) {
        throw new Error("TEMPORAL_ADDRESS is required");
    }

    return normalizeAddress(endpoint);
}

export function getTemporalApiKey(): string {
    const apiKey = process.env.TEMPORAL_API_KEY;
    if (!apiKey) {
        throw new Error("TEMPORAL_API_KEY is required");
    }

    return apiKey;
}

export function getTemporalDeploymentVersion(): WorkerDeploymentVersion {
    if (cachedDeploymentVersion) {
        return cachedDeploymentVersion;
    }

    const { name } = readPackageMetadata();
    cachedDeploymentVersion = {
        deploymentName: sanitizeIdentifier(`${name}-${getTemporalNamespace()}`),
        buildId: computeDeploymentBuildId(),
    };

    return cachedDeploymentVersion;
}

export function getTemporalPinnedVersioningOverride(): VersioningOverride {
    return {
        pinnedTo: getTemporalDeploymentVersion(),
    };
}

export function getTemporalDeploymentMetadata(): {
    deploymentName: string;
    buildId: string;
    canonicalVersion: string;
} {
    const deploymentVersion = getTemporalDeploymentVersion();
    return {
        deploymentName: deploymentVersion.deploymentName,
        buildId: deploymentVersion.buildId,
        canonicalVersion: `${deploymentVersion.deploymentName}.${deploymentVersion.buildId}`,
    };
}

export function createTemporalIdentity(scope: string, taskQueue?: string): string {
    const host = process.env.HOSTNAME || process.env.COMPUTE_INSTANCE || "localhost";
    const segments = [scope, taskQueue, host, String(process.pid)].filter(Boolean);
    return segments.join(".");
}

export async function getTemporalConnection(): Promise<Connection> {
    if (cachedConnection) {
        return cachedConnection;
    }

    cachedConnection = await Connection.connect({
        address: getTemporalAddress(),
        apiKey: getTemporalApiKey(),
        tls: true,
    });

    return cachedConnection;
}

export async function getTemporalClient(): Promise<Client> {
    if (cachedClient) {
        return cachedClient;
    }
    const connection = await getTemporalConnection();
    cachedClient = new Client({
        connection,
        namespace: getTemporalNamespace(),
    });
    return cachedClient;
}
