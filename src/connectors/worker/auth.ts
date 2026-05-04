/**
 * Authorization middleware.
 *
 * Public catalog reads: no auth (anyone can list/inspect available
 * connectors, their tools and metadata).
 *
 * Privileged calls (execution, inspect, internal workflow triggers): bearer
 * `RUNTIME_INTERNAL_SECRET`.
 */

import type { Context, MiddlewareHandler } from "hono";
import type { Env } from "./env.js";

export const requireInternalSecret: MiddlewareHandler<{ Bindings: Env }> = async (
    c: Context<{ Bindings: Env }>,
    next,
) => {
    const expected = c.env.RUNTIME_INTERNAL_SECRET;
    if (!expected) {
        return c.json(
            { error: { code: "MCP_RUNTIME_UNAVAILABLE", message: "RUNTIME_INTERNAL_SECRET not configured", retryable: false } },
            500,
        );
    }
    const header = c.req.header("authorization") || "";
    if (header !== `Bearer ${expected}`) {
        return c.json(
            { error: { code: "MCP_RUNTIME_UNAVAILABLE", message: "Missing or invalid runtime internal authorization", retryable: false } },
            401,
        );
    }
    await next();
    return undefined;
};
