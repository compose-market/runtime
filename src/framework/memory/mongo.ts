import { MongoClient, type Collection, type Db, type MongoClientOptions } from "mongodb";
import {
    ARCHIVE_INDEXES,
    MEMORY_VECTOR_INDEXES,
    PATTERN_INDEXES,
    SESSION_INDEXES,
    SKILL_INDEXES,
    TRANSCRIPT_INDEXES,
    type MemoryArchive,
    type MemoryVector,
    type ProceduralPattern,
    type SessionMemory,
    type SessionTranscript,
    type SkillDocument,
} from "./types.js";

const DEFAULT_DB_NAME = process.env.MONGO_MEMORY_DB || "compose_memory";
const MAX_RETRIES = 5;
const BASE_DELAY_MS = 100;
const MAX_DELAY_MS = 5000;
const VECTOR_SEARCH_INDEX_NAME = "vector_index";

const VECTOR_SEARCH_INDEX_DEFINITION = {
    fields: [
        {
            type: "vector",
            path: "embedding",
            numDimensions: 1024,
            similarity: "cosine",
        },
        { type: "filter", path: "agentWallet" },
        { type: "filter", path: "userAddress" },
        { type: "filter", path: "threadId" },
        { type: "filter", path: "source" },
    ],
} as const;

let client: MongoClient | null = null;
let db: Db | null = null;
let connectionPromise: Promise<MongoClient> | null = null;

function buildMongoMemoryUri(): string {
    if (process.env.MONGO_MEMORY_URI) {
        return process.env.MONGO_MEMORY_URI;
    }

    const user = process.env.MONGO_MEMORY_USER;
    const password = process.env.MONGO_MEMORY_PASSWORD;
    const cluster = process.env.MONGO_MEMORY_CLUSTER;
    const appName = process.env.MONGO_MEMORY_APP_NAME;

    if (!user || !password || !cluster) {
        throw new Error("MONGO_MEMORY_URI or (MONGO_MEMORY_USER, MONGO_MEMORY_PASSWORD, MONGO_MEMORY_CLUSTER) is required");
    }

    const encodedPassword = encodeURIComponent(password);
    const clusterHost = cluster.includes(".") ? cluster : `${cluster}.mongodb.net`;
    const appNameParam = appName ? `&appName=${encodeURIComponent(appName)}` : "";

    return `mongodb+srv://${user}:${encodedPassword}@${clusterHost}/?retryWrites=true&w=majority${appNameParam}`;
}

function getMongoOptions(): MongoClientOptions {
    return {
        maxPoolSize: 15,
        minPoolSize: 2,
        maxIdleTimeMS: 30000,
        connectTimeoutMS: 10000,
        socketTimeoutMS: 30000,
        serverSelectionTimeoutMS: 10000,
    };
}

async function sleep(ms: number): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, ms));
}

async function connectWithRetry(retryCount = 0): Promise<MongoClient> {
    const uri = buildMongoMemoryUri();

    try {
        const mongoClient = new MongoClient(uri, getMongoOptions());
        await mongoClient.connect();
        return mongoClient;
    } catch (error) {
        if (retryCount >= MAX_RETRIES) {
            throw error;
        }

        const delay = Math.min(BASE_DELAY_MS * Math.pow(2, retryCount), MAX_DELAY_MS);
        console.warn(`[memory:mongo] connection attempt ${retryCount + 1} failed, retrying in ${delay}ms`, error);
        await sleep(delay);
        return connectWithRetry(retryCount + 1);
    }
}

async function ensureIndexes(targetDb: Db): Promise<void> {
    const vectors = targetDb.collection<MemoryVector>("memory");
    const transcripts = targetDb.collection<SessionTranscript>("session_transcripts");
    const patterns = targetDb.collection<ProceduralPattern>("patterns");
    const archives = targetDb.collection<MemoryArchive>("archives");
    const skills = targetDb.collection<SkillDocument>("skills");
    const sessions = targetDb.collection<SessionMemory>("sessions");

    for (const index of MEMORY_VECTOR_INDEXES) {
        await vectors.createIndex(index.key, { name: index.name });
    }
    for (const index of TRANSCRIPT_INDEXES) {
        await transcripts.createIndex(index.key, { name: index.name, unique: Boolean(index.unique) });
    }
    for (const index of PATTERN_INDEXES) {
        await patterns.createIndex(index.key, { name: index.name });
    }
    for (const index of ARCHIVE_INDEXES) {
        await archives.createIndex(index.key, { name: index.name });
    }
    for (const index of SKILL_INDEXES) {
        await skills.createIndex(index.key, { name: index.name });
    }
    for (const index of SESSION_INDEXES) {
        await sessions.createIndex(index.key, { name: index.name });
    }

    await ensureVectorSearchIndex(vectors);
}

async function ensureVectorSearchIndex(vectors: Collection<MemoryVector>): Promise<void> {
    const collection = vectors as Collection<MemoryVector> & {
        listSearchIndexes?: (name?: string) => { toArray: () => Promise<Array<Record<string, unknown>>> };
        createSearchIndex?: (definition: Record<string, unknown>) => Promise<string>;
        updateSearchIndex?: (name: string, definition: Record<string, unknown>) => Promise<void>;
    };

    if (
        typeof collection.listSearchIndexes !== "function"
        || typeof collection.createSearchIndex !== "function"
        || typeof collection.updateSearchIndex !== "function"
    ) {
        return;
    }

    try {
        const existing = await collection.listSearchIndexes(VECTOR_SEARCH_INDEX_NAME).toArray();
        if (existing.length > 0) {
            await collection.updateSearchIndex(VECTOR_SEARCH_INDEX_NAME, VECTOR_SEARCH_INDEX_DEFINITION);
            return;
        }

        await collection.createSearchIndex({
            name: VECTOR_SEARCH_INDEX_NAME,
            type: "vectorSearch",
            definition: VECTOR_SEARCH_INDEX_DEFINITION,
        });
    } catch {
        // Ignore unsupported deployment or transient Atlas search index errors.
    }
}

function attachShutdownHandlers(mongoClient: MongoClient): void {
    const shutdown = async () => {
        try {
            await mongoClient.close();
        } catch (error) {
            console.error("[memory:mongo] shutdown close failed", error);
        }
    };

    process.once("SIGTERM", shutdown);
    process.once("SIGINT", shutdown);
}

export async function getMemoryMongoClient(): Promise<MongoClient> {
    if (client) {
        try {
            await client.db().admin().ping();
            return client;
        } catch {
            client = null;
            db = null;
        }
    }

    if (connectionPromise) {
        return connectionPromise;
    }

    connectionPromise = (async () => {
        const mongoClient = await connectWithRetry();
        client = mongoClient;
        db = mongoClient.db(DEFAULT_DB_NAME);
        await ensureIndexes(db);
        attachShutdownHandlers(mongoClient);
        connectionPromise = null;
        return mongoClient;
    })();

    return connectionPromise;
}

export async function getMemoryMongoDb(): Promise<Db> {
    if (db) {
        return db;
    }

    await getMemoryMongoClient();
    if (!db) {
        throw new Error("MongoDB memory DB not initialized");
    }

    return db;
}

export async function closeMemoryMongo(): Promise<void> {
    if (client) {
        await client.close();
        client = null;
        db = null;
        connectionPromise = null;
    }
}

export async function getMemoryVectorsCollection(): Promise<Collection<MemoryVector>> {
    const database = await getMemoryMongoDb();
    return database.collection<MemoryVector>("memory");
}

export async function getSessionTranscriptsCollection(): Promise<Collection<SessionTranscript>> {
    const database = await getMemoryMongoDb();
    return database.collection<SessionTranscript>("session_transcripts");
}

export async function getPatternsCollection(): Promise<Collection<ProceduralPattern>> {
    const database = await getMemoryMongoDb();
    return database.collection<ProceduralPattern>("patterns");
}

export async function getArchivesCollection(): Promise<Collection<MemoryArchive>> {
    const database = await getMemoryMongoDb();
    return database.collection<MemoryArchive>("archives");
}

export async function getSkillsCollection(): Promise<Collection<SkillDocument>> {
    const database = await getMemoryMongoDb();
    return database.collection<SkillDocument>("skills");
}

export async function getSessionsCollection(): Promise<Collection<SessionMemory>> {
    const database = await getMemoryMongoDb();
    return database.collection<SessionMemory>("sessions");
}
