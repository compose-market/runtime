export type CandidateTransportKind = "stdio" | "http" | "docker" | "npx";

export interface RegistryEntry {
    server: {
        name: string;
        title?: string;
        description?: string;
        version: string;
        repository?: { url?: string; source?: string };
        packages?: Array<{
            registryType: string;
            identifier: string;
            version?: string;
            transport?: { type: string };
            environmentVariables?: Array<{ name: string; description?: string; isSecret?: boolean }>;
        }>;
        remotes?: Array<{ type: string; url: string }>;
        tools?: Array<{ name: string; description?: string; inputSchema?: Record<string, unknown> }>;
        websiteUrl?: string;
    };
    _meta?: { "io.modelcontextprotocol.registry/official"?: { status?: string; isLatest?: boolean } };
}

export interface CandidateCredential {
    varName: string;
    description: string | null;
    obtainUrl: string | null;
    source: "registry" | "probe";
}

export interface CatalogCandidateTransport {
    transport: CandidateTransportKind;
    package: string | null;
    image: string | null;
    remoteUrl: string | null;
    protocol: "sse" | "streamable-http" | null;
    args: string[];
    envRequired: string[];
    envOptional: string[];
    priority: number;
}

export interface CatalogCandidate {
    slug: string;
    namespace: string;
    rawName: string;
    rawDescription: string;
    tags: string[];
    repoUrl: string | null;
    image: string | null;
    statefulness: "stateless" | "stateful" | "unknown";
    sourceVersion: string;
    sourceHash: string;
    rawKey: string;
    transports: CatalogCandidateTransport[];
    credentials: CandidateCredential[];
    rawTools: Array<{ name: string; description?: string | null; inputSchema?: Record<string, unknown> }>;
}

export type ServedCatalogStatus = "live" | "credential_gated";
export type CatalogStatus =
    | ServedCatalogStatus
    | "inspecting"
    | "verified"
    | "metadata_reviewed"
    | "embedded"
    | "shadowed"
    | "quarantined"
    | "deprecated";

export function cleanCandidateSlug(name: string): string {
    return name
        .toLowerCase()
        .replace(/^@[\w-]+\//, "")
        .replace(/^model-?context-?protocol[/-]?/gi, "")
        .replace(/^io\.github\.[\w.-]*[/-]?/gi, "")
        .replace(/^io-github-[\w-]*-?/gi, "")
        .replace(/^io[.-]/gi, "")
        .replace(/^github-/gi, "")
        .replace(/\s*mcp\s*server\s*/gi, "")
        .replace(/\s*server\s*/gi, "")
        .replace(/\s*mcp\s*/gi, "")
        .replace(/-mcp$/gi, "")
        .replace(/^mcp-/gi, "")
        .replace(/-official$/gi, "")
        .replace(/^official-/gi, "")
        .replace(/\s*by\s+[\w-]+/gi, "")
        .replace(/\s*\|\s*.+$/g, "")
        .replace(/^goat[:-]/, "")
        .replace(/^eliza[:-]/, "")
        .replace(/[^a-z0-9-]/g, "-")
        .replace(/--+/g, "-")
        .replace(/^-+|-+$/g, "");
}

function namespaceFromName(name: string): string {
    const slashParts = name.split("/");
    if (slashParts.length > 1 && slashParts[0]) return slashParts[0];
    const dotParts = name.split(".");
    if (dotParts.length > 2) return dotParts.slice(0, 2).join(".");
    return "unknown";
}

function isEnvName(value: string): boolean {
    return /^[A-Z][A-Z0-9_]{2,}$/.test(value);
}

async function sha256Hex(text: string): Promise<string> {
    const bytes = new TextEncoder().encode(text);
    const digest = await crypto.subtle.digest("SHA-256", bytes);
    return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function buildCandidateFromRegistryEntry(
    entry: RegistryEntry,
    ghcrImages: Record<string, string>,
    rawKey: string,
): Promise<CatalogCandidate | null> {
    const server = entry.server;
    const rawName = server.name || server.title || "";
    if (!rawName) return null;

    const slug = cleanCandidateSlug(rawName);
    if (!slug) return null;

    const tags: string[] = [];
    if (entry._meta?.["io.modelcontextprotocol.registry/official"]?.isLatest) tags.push("latest");
    if (server.remotes && server.remotes.length > 0) tags.push("remote");
    if (server.packages?.some((pkg) => pkg.registryType === "npm" || pkg.registryType === "npmjs")) tags.push("npm");
    if (server.packages?.some((pkg) => pkg.registryType === "oci" || pkg.registryType === "docker")) tags.push("docker");

    const image = ghcrImages[slug] || null;
    const transports: CatalogCandidateTransport[] = [];
    const credentials: CandidateCredential[] = [];

    for (const remote of server.remotes || []) {
        const protocol = remote.type === "streamable-http"
            ? "streamable-http"
            : remote.type === "sse" ? "sse" : null;
        transports.push({
            transport: "http",
            package: null,
            image: null,
            remoteUrl: remote.url,
            protocol,
            args: [],
            envRequired: [],
            envOptional: [],
            priority: 100,
        });
    }

    for (const pkg of server.packages || []) {
        const envRequired = (pkg.environmentVariables || [])
            .filter((env) => env.isSecret === true && isEnvName(env.name))
            .map((env) => env.name);
        const envOptional = (pkg.environmentVariables || [])
            .filter((env) => env.isSecret !== true && isEnvName(env.name))
            .map((env) => env.name);

        for (const env of pkg.environmentVariables || []) {
            if (env.isSecret === true && isEnvName(env.name)) {
                credentials.push({
                    varName: env.name,
                    description: env.description ?? null,
                    obtainUrl: null,
                    source: "registry",
                });
            }
        }

        if (pkg.registryType === "npm" || pkg.registryType === "npmjs") {
            transports.push({
                transport: "npx",
                package: pkg.identifier,
                image: null,
                remoteUrl: null,
                protocol: null,
                args: [],
                envRequired,
                envOptional,
                priority: 80,
            });
        }
        if (pkg.registryType === "oci" || pkg.registryType === "docker") {
            transports.push({
                transport: "docker",
                package: null,
                image: pkg.identifier,
                remoteUrl: null,
                protocol: null,
                args: [],
                envRequired,
                envOptional,
                priority: 60,
            });
        }
    }

    if (image) {
        transports.push({
            transport: "docker",
            package: null,
            image,
            remoteUrl: null,
            protocol: null,
            args: [],
            envRequired: [],
            envOptional: [],
            priority: 50,
        });
    }

    const sourceVersion = `v0:${server.version}`;
    const sourceHash = await sha256Hex(JSON.stringify({
        rawName,
        version: sourceVersion,
        repoUrl: server.repository?.url ?? null,
        packages: server.packages ?? [],
        remotes: server.remotes ?? [],
    }));

    return {
        slug,
        namespace: namespaceFromName(rawName),
        rawName,
        rawDescription: server.description || `MCP server: ${rawName}`,
        tags,
        repoUrl: server.repository?.url ?? null,
        image,
        statefulness: "unknown",
        sourceVersion,
        sourceHash,
        rawKey,
        transports,
        credentials: dedupeCredentials(credentials),
        rawTools: (server.tools || [])
            .filter((tool) => typeof tool.name === "string" && tool.name.trim().length > 0)
            .map((tool) => ({
                name: tool.name,
                description: tool.description ?? null,
                inputSchema: tool.inputSchema || {},
            })),
    };
}

export function candidateObjectKey(candidate: Pick<CatalogCandidate, "slug" | "sourceHash">): string {
    return `candidates/${candidate.slug}/${candidate.sourceHash}.json`;
}

export function shadowObjectKey(candidate: Pick<CatalogCandidate, "slug" | "sourceHash">): string {
    return `shadows/${candidate.slug}/${candidate.sourceHash}.json`;
}

export function declaredCredentialVars(candidate: Pick<CatalogCandidate, "credentials" | "transports">): string[] {
    const vars = [
        ...candidate.credentials.map((credential) => credential.varName),
        ...candidate.transports.flatMap((transport) => transport.envRequired),
    ];
    return [...new Set(vars)].sort();
}

export function isServedCatalogStatus(status: string | null | undefined): status is ServedCatalogStatus {
    return status === "live" || status === "credential_gated";
}

function dedupeCredentials(credentials: CandidateCredential[]): CandidateCredential[] {
    const byName = new Map<string, CandidateCredential>();
    for (const credential of credentials) {
        if (!byName.has(credential.varName)) byName.set(credential.varName, credential);
    }
    return [...byName.values()].sort((a, b) => a.varName.localeCompare(b.varName));
}
