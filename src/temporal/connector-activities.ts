interface ConnectorMaintenanceOptions {
    seedMaxPages?: number;
    verifyLimit?: number;
    metadataLimit?: number;
    publishLimit?: number;
    embedLimit?: number;
    shardCount?: number;
    /**
     * Legacy option name kept so already-created Temporal schedules do not fail
     * while the new daily schedule replaces them.
     */
    compileLimit?: number;
}

function requireConnectorsUrl(): string {
    const value = process.env.CONNECTORS_URL;
    if (!value) throw new Error("CONNECTORS_URL is required");
    return value.replace(/\/+$/, "");
}

function requireRuntimeInternalSecret(): string {
    const value = process.env.RUNTIME_INTERNAL_SECRET;
    if (!value) throw new Error("RUNTIME_INTERNAL_SECRET is required");
    return value;
}

async function callConnectors<T>(path: string, body: Record<string, unknown> = {}): Promise<T> {
    const response = await fetch(`${requireConnectorsUrl()}${path}`, {
        method: "POST",
        headers: {
            "Authorization": `Bearer ${requireRuntimeInternalSecret()}`,
            "Content-Type": "application/json",
            "Accept": "application/json",
        },
        body: JSON.stringify(body),
    });
    const text = await response.text();
    if (!response.ok) {
        throw new Error(`connectors ${path} failed (${response.status}): ${text.slice(0, 500)}`);
    }
    return JSON.parse(text) as T;
}

export async function seedConnectorCatalogActivity(input: ConnectorMaintenanceOptions = {}): Promise<unknown> {
    return await callConnectors("/seed", { maxPages: input.seedMaxPages });
}

export async function verifyConnectorCatalogShardActivity(input: ConnectorMaintenanceOptions & { shardId: number }): Promise<unknown> {
    return await callConnectors("/verify", {
        shardId: input.shardId,
        shardCount: input.shardCount ?? 3,
        limit: input.verifyLimit,
    });
}

export async function runConnectorMetadataAgentsActivity(input: ConnectorMaintenanceOptions = {}): Promise<unknown> {
    const limit = input.metadataLimit ?? input.compileLimit;
    return await Promise.all([
        callConnectors("/metadata-agents/run", { agentId: 0, limit }),
        callConnectors("/metadata-agents/run", { agentId: 1, limit }),
        callConnectors("/metadata-agents/run", { agentId: 2, limit }),
    ]);
}

export async function publishConnectorCatalogActivity(input: ConnectorMaintenanceOptions = {}): Promise<unknown> {
    return await callConnectors("/publish", {
        limit: input.publishLimit ?? input.metadataLimit ?? input.compileLimit,
    });
}

export async function compileConnectorMetadataActivity(input: ConnectorMaintenanceOptions = {}): Promise<unknown> {
    const reports = await runConnectorMetadataAgentsActivity(input);
    const publish = await publishConnectorCatalogActivity(input);
    return { metadataAgents: reports, publish };
}

export async function embedConnectorCatalogActivity(input: ConnectorMaintenanceOptions = {}): Promise<unknown> {
    return await callConnectors("/embed", { limit: input.embedLimit });
}

export async function rollupConnectorHealthActivity(): Promise<unknown> {
    return await callConnectors("/health");
}

export async function gcConnectorCatalogActivity(): Promise<unknown> {
    return await callConnectors("/gc");
}
