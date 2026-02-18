import { Client, Connection } from "@temporalio/client";

let cachedConnection: Connection | null = null;
let cachedClient: Client | null = null;

function normalizeAddress(rawAddress: string): string {
    return rawAddress.replace(/^https?:\/\//, "").replace(/\/$/, "");
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

export async function getTemporalConnection(): Promise<Connection> {
    if (cachedConnection) {
        return cachedConnection;
    }

    const endpoint = process.env.TEMPORAL_ADDRESS;
    const apiKey = process.env.TEMPORAL_API_KEY;

    if (!endpoint) {
        throw new Error("TEMPORAL_ADDRESS is required");
    }
    if (!apiKey) {
        throw new Error("TEMPORAL_API_KEY is required");
    }

    cachedConnection = await Connection.connect({
        address: normalizeAddress(endpoint),
        apiKey,
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
