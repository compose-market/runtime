/**
 * Credential detection.
 *
 * Captures required env-var names ONLY from structured signals. No keyword
 * matching against tool/server names. The signals we recognize:
 *
 *   1. JSON-RPC error envelopes with code -32602 carrying `data.envVar`
 *      or `data.required` arrays (this is what well-behaved MCP servers
 *      emit when they detect missing config).
 *   2. Node `Error [ERR_INVALID_ENV]: ...` lines from stderr.
 *   3. Structured server messages like "requires credentials: VAR_NAME"
 *      or "credentials required: VAR_NAME".
 *   4. Standard Node throws like
 *        "Error: Missing environment variable: X"
 *        "Missing env: X"
 *        "X environment variable required"
 *
 * Anything else returns an empty list. We never invent var names.
 */

export interface CredentialDetectionResult {
    varNames: string[];
    /** R2 key of the captured stderr/JSON-RPC payload, set by the caller. */
    evidenceKey: string | null;
}

/** Names returned from a free-text scan are filtered against this denylist. */
const RESERVED_NAMES: ReadonlySet<string> = new Set([
    "SERVER", "ERROR", "FAILED", "TIMEOUT", "SESSION", "ID", "MCP", "API",
    "JSON", "RPC", "STDIO", "HTTP", "URL", "PORT", "PATH", "NODE", "NPM",
    "PYTHON", "DOCKER", "CONNECTION",
]);

function isUpperEnvName(s: string): boolean {
    return /^[A-Z][A-Z0-9_]{2,}$/.test(s) && !RESERVED_NAMES.has(s);
}

interface JsonRpcEnvelope {
    jsonrpc?: string;
    error?: { code?: number; message?: string; data?: unknown };
}

export function detectFromJsonRpc(payload: unknown): string[] {
    const envelope = payload as JsonRpcEnvelope | null | undefined;
    if (!envelope || typeof envelope !== "object") return [];
    const err = envelope.error;
    if (!err || err.code !== -32602) return [];
    const data = err.data as Record<string, unknown> | undefined;
    if (!data) return [];
    const out: string[] = [];
    if (typeof data.envVar === "string" && isUpperEnvName(data.envVar)) {
        out.push(data.envVar);
    }
    if (Array.isArray(data.required)) {
        for (const item of data.required) {
            if (typeof item === "string" && isUpperEnvName(item)) out.push(item);
        }
    }
    return [...new Set(out)];
}

const STRUCTURED_PATTERNS: ReadonlyArray<RegExp> = [
    /requires credentials:\s*([A-Z][A-Z0-9_]{2,})/g,
    /credentials required:\s*([A-Z][A-Z0-9_]{2,})/g,
    /Missing environment variable:\s*([A-Z][A-Z0-9_]{2,})/g,
    /Missing env:\s*([A-Z][A-Z0-9_]{2,})/g,
    /\bERR_INVALID_ENV[^]{0,100}?([A-Z][A-Z0-9_]{2,})/g,
    /\b([A-Z][A-Z0-9_]{2,})\s+environment variable required/g,
    /\b([A-Z][A-Z0-9_]{2,})\s+is not (?:set|defined|configured)/g,
];

export function detectFromStderr(stderr: string): string[] {
    if (!stderr) return [];
    const out: string[] = [];
    for (const pattern of STRUCTURED_PATTERNS) {
        // Reset lastIndex because the regex is shared (`g` flag).
        pattern.lastIndex = 0;
        let m: RegExpExecArray | null;
        while ((m = pattern.exec(stderr)) !== null) {
            const name = m[1];
            if (name && isUpperEnvName(name)) {
                out.push(name);
            }
        }
    }
    return [...new Set(out)];
}

/**
 * Combine signals from JSON-RPC error envelopes and captured stderr.
 *
 * The caller is responsible for persisting the raw stderr/JSON-RPC bytes
 * to R2 first, and then passing the resulting key as `evidenceKey`.
 */
export function detectRequiredVars(input: {
    stderr?: string;
    jsonRpcEnvelope?: unknown;
    evidenceKey?: string | null;
}): CredentialDetectionResult {
    const a = input.stderr ? detectFromStderr(input.stderr) : [];
    const b = input.jsonRpcEnvelope ? detectFromJsonRpc(input.jsonRpcEnvelope) : [];
    return {
        varNames: [...new Set([...a, ...b])],
        evidenceKey: input.evidenceKey ?? null,
    };
}

/**
 * Format the broker's CallCredentialsRequired payload into the exact error
 * message string the runtime client converts to a non-retryable error
 * (`MCP credentials required: <vars>`). Matches
 * runtime/src/connectors/client.ts.
 */
export function formatMissingMessage(varNames: string[]): string {
    return `MCP credentials required: ${varNames.join(", ")}`;
}
