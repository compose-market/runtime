/**
 * Service auth helpers for runtime-internal control-plane calls.
 *
 * Runtime modules that need to re-enter an agent route must call the embedded workflow mount.
 */
import type { Request } from "express";

function normalizeUrl(value: string): string {
    return value.replace(/\/+$/, "");
}

function normalizeHost(value: string): string {
    return value
        .trim()
        .replace(/^https?:\/\//i, "")
        .replace(/\/+$/, "");
}

function requireInternalServiceSecret(): string {
    const value = process.env.RUNTIME_INTERNAL_SECRET;
    if (!value) throw new Error("RUNTIME_INTERNAL_SECRET is required");
    return value;
}

const PINATA_API_URL = "https://api.pinata.cloud";

// ---------------------------------------------------------------------------
// API Control Plane
// ---------------------------------------------------------------------------

export function requireApiInternalUrl(): string {
    const value = process.env.API_URL;
    if (!value) throw new Error("API_URL is required");
    return normalizeUrl(value);
}

export function requireApiInternalToken(): string {
    return requireInternalServiceSecret();
}

export function buildApiInternalHeaders(
    extra?: Record<string, string>,
): Record<string, string> {
    return {
        Authorization: `Bearer ${requireApiInternalToken()}`,
        ...(extra || {}),
    };
}

// ---------------------------------------------------------------------------
// Compose Runtime Service (MCP / GOAT tool host)
// ---------------------------------------------------------------------------

export function requireRuntimeServiceUrl(): string {
    const value = process.env.RUNTIME_URL;
    if (!value) throw new Error("RUNTIME_URL is required");
    return normalizeUrl(value);
}

export function requireRuntimeInternalToken(): string {
    return requireInternalServiceSecret();
}

export function buildRuntimeInternalHeaders(
    extra?: Record<string, string>,
): Record<string, string> {
    return {
        Authorization: `Bearer ${requireRuntimeInternalToken()}`,
        ...(extra || {}),
    };
}

// ---------------------------------------------------------------------------
// Embedded workflow runtime routes
// ---------------------------------------------------------------------------

export function requireEmbeddedRuntimeBaseUrl(): string {
    return `${requireRuntimeServiceUrl()}/internal/workflow`;
}

export function requirePinataApiUrl(): string {
    return PINATA_API_URL;
}

export function requirePinataGatewayHost(): string {
    const value = process.env.PINATA_GATEWAY_URL;
    if (!value) throw new Error("PINATA_GATEWAY_URL is required");
    return normalizeHost(value);
}

export function buildPinataGatewayIpfsUrl(cid: string): string {
    const normalizedCid = cid
        .replace(/^ipfs:\/\//i, "")
        .replace(/^\/+/, "");
    return `https://${requirePinataGatewayHost()}/ipfs/${normalizedCid}`;
}

export interface RuntimeSessionHeaders {
    sessionActive: boolean;
    sessionBudgetRemaining: number;
    sessionUserAddress?: string;
}

function readHeader(req: Request, name: string): string | undefined {
    const value = req.headers[name.toLowerCase()];
    if (Array.isArray(value)) {
        return value[0];
    }
    return typeof value === "string" ? value : undefined;
}

export function extractRuntimeSessionHeaders(req: Request): RuntimeSessionHeaders {
    const sessionActive = readHeader(req, "x-session-active") === "true";
    const sessionBudgetRaw = readHeader(req, "x-session-budget-remaining");
    const sessionBudgetRemaining = sessionBudgetRaw ? Number.parseInt(sessionBudgetRaw, 10) : 0;
    const sessionUserAddress = readHeader(req, "x-session-user-address");

    return {
        sessionActive,
        sessionBudgetRemaining: Number.isFinite(sessionBudgetRemaining) && sessionBudgetRemaining >= 0
            ? sessionBudgetRemaining
            : 0,
        ...(sessionUserAddress ? { sessionUserAddress } : {}),
    };
}

function requireRuntimeInternalSecret(): string {
    return requireInternalServiceSecret();
}

export function buildEmbeddedRuntimeHeaders(
    extra?: Record<string, string>,
): Record<string, string> {
    return {
        "x-runtime-internal-token": requireRuntimeInternalToken(),
        "X-Internal-Secret": requireRuntimeInternalSecret(),
        ...(extra || {}),
    };
}

/**
 * Check whether an incoming Express request was issued by embedded runtime
 * delegation via the shared internal secret.
 */
export function isRuntimeInternalRequest(req: Request): boolean {
    const secret = requireInternalServiceSecret();
    const header = req.headers["x-internal-secret"];
    return Array.isArray(header) ? header[0] === secret : header === secret;
}
