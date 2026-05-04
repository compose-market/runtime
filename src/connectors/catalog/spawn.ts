/**
 * Spawn config resolver.
 *
 * Given a server slug, returns the next transport to try based on observed
 * priority (last_success_at - W * failure_streak - L * median_latency_ms).
 * Falls back to the row's stored `priority` value when no signals exist
 * yet (initial inspect).
 */

import type { Env } from "../worker/env.js";
import { getTransports, parseStringArray } from "./d1.js";

export interface ServerSpawnConfig {
    transport: "stdio" | "http" | "docker" | "npx";
    command?: string;
    args?: string[];
    env?: Record<string, string>;
    envRequired?: string[];
    envOptional?: string[];
    image?: string;
    remoteUrl?: string;
    protocol?: "sse" | "streamable-http";
    package?: string;
}

const FAILURE_WEIGHT = 100;
const LATENCY_WEIGHT = 0.001;

function score(row: {
    last_success_at: string | null;
    failure_streak: number;
    median_latency_ms: number | null;
    priority: number;
}): number {
    const last = row.last_success_at ? new Date(row.last_success_at).getTime() : 0;
    return (
        row.priority +
        (last / 1_000_000) -
        FAILURE_WEIGHT * row.failure_streak -
        LATENCY_WEIGHT * (row.median_latency_ms ?? 0)
    );
}

export async function getSpawnConfigs(env: Env, slug: string): Promise<ServerSpawnConfig[]> {
    const rows = await getTransports(env, slug);
    if (rows.length === 0) return [];
    const ordered = [...rows].sort((a, b) => score(b) - score(a));
    const out: ServerSpawnConfig[] = [];
    for (const row of ordered) {
        const cmdArgs = parseStringArray(row.cmd_args);
        if (row.kind === "http") {
            if (!row.remote_url) continue;
            out.push({
                transport: "http",
                remoteUrl: row.remote_url,
                protocol: row.protocol ?? undefined,
                envRequired: parseStringArray(row.env_required),
                envOptional: parseStringArray(row.env_optional),
            });
        } else if (row.kind === "docker") {
            if (!row.image) continue;
            out.push({
                transport: "docker",
                image: row.image,
                envRequired: parseStringArray(row.env_required),
                envOptional: parseStringArray(row.env_optional),
            });
        } else if (row.kind === "npx") {
            if (!row.package) continue;
            out.push({
                transport: "npx",
                package: row.package,
                args: cmdArgs.length > 0 ? cmdArgs : undefined,
                envRequired: parseStringArray(row.env_required),
                envOptional: parseStringArray(row.env_optional),
            });
        } else if (row.kind === "stdio") {
            const command = cmdArgs[0];
            if (!command) continue;
            out.push({
                transport: "stdio",
                command,
                args: cmdArgs.slice(1),
                envRequired: parseStringArray(row.env_required),
                envOptional: parseStringArray(row.env_optional),
            });
        }
        // goat-plugin transports are handled in the GOAT runtime path, not
        // here; they're never returned as ServerSpawnConfig.
    }
    return out;
}
