import { gzipSync } from "zlib";
import { requirePinataApiUrl } from "../auth.js";
import { createContentHash, invalidateMemoryScope } from "./cache.js";
import { calculateDecayMultiplier } from "./decay.js";
import {
    getArchivesCollection,
    getMemoryVectorsCollection,
    getPatternsCollection,
    getSessionTranscriptsCollection,
    getSessionsCollection,
    getSkillsCollection,
} from "./mongo.js";
import type {
    MemoryArchive,
    MemoryStats,
    ProceduralPattern,
    SkillDocument,
} from "./types.js";

interface TimeRange {
    start: number;
    end: number;
}

function nowMs(): number {
    return Date.now();
}

function summarizeToolSequence(sequence: string[]): string {
    return sequence.join(" -> ");
}

function patternIdFrom(agentWallet: string, sequence: string[]): string {
    return `pat_${agentWallet.slice(2, 10)}_${createContentHash(sequence.join("|")).slice(0, 20)}`;
}

export async function getMemoryStats(agentWallet?: string): Promise<MemoryStats> {
    const vectors = await getMemoryVectorsCollection();
    const transcripts = await getSessionTranscriptsCollection();
    const vectorFilter = agentWallet ? { agentWallet } : {};

    const [
        totalVectors,
        totalTranscripts,
        avgDecay,
        oldest,
        newest,
        byTypeRows,
    ] = await Promise.all([
        vectors.countDocuments(vectorFilter),
        transcripts.countDocuments(agentWallet ? { agentWallet } : {}),
        vectors.aggregate<{ avg: number }>([
            { $match: vectorFilter },
            { $group: { _id: null, avg: { $avg: "$decayScore" } } },
        ]).toArray(),
        vectors.find(vectorFilter).sort({ createdAt: 1 }).limit(1).toArray(),
        vectors.find(vectorFilter).sort({ createdAt: -1 }).limit(1).toArray(),
        vectors.aggregate<{ _id: string; count: number }>([
            { $match: vectorFilter },
            { $group: { _id: "$source", count: { $sum: 1 } } },
        ]).toArray(),
    ]);

    const byType: Record<string, number> = {};
    for (const row of byTypeRows) {
        byType[row._id || "unknown"] = row.count;
    }

    return {
        totalVectors,
        totalTranscripts,
        avgDecayScore: avgDecay[0]?.avg ?? 0,
        oldestVector: oldest[0]?.createdAt ?? 0,
        newestVector: newest[0]?.createdAt ?? 0,
        byType,
    };
}

export async function consolidateAgentMemories(input: {
    agentWallets: string[];
    batchSize?: number;
}): Promise<{ consolidated: number }> {
    const vectors = await getMemoryVectorsCollection();
    let consolidated = 0;

    for (const agentWallet of input.agentWallets) {
        const docs = await vectors.find({ agentWallet }).sort({ createdAt: -1 }).toArray();
        const seen = new Set<string>();

        for (const doc of docs) {
            const fingerprint = createContentHash(`${doc.content.trim().toLowerCase()}::${doc.source}`).slice(0, 20);
            if (seen.has(fingerprint)) {
                await vectors.deleteOne({ vectorId: doc.vectorId });
                consolidated += 1;
                continue;
            }
            seen.add(fingerprint);
        }
    }

    for (const agentWallet of input.agentWallets) {
        await invalidateMemoryScope({ agentWallet });
    }

    return { consolidated };
}

function extractToolCalls(messages: Array<{ toolCalls?: Array<{ name: string; args: Record<string, unknown> }> }>): string[] {
    const calls: string[] = [];
    for (const message of messages) {
        for (const toolCall of message.toolCalls || []) {
            if (toolCall.name) {
                calls.push(toolCall.name);
            }
        }
    }
    return calls;
}

export async function extractExecutionPatterns(input: {
    agentWallet: string;
    timeRange: TimeRange;
    confidenceThreshold: number;
}): Promise<{ patterns: number; extracted: number }> {
    const transcripts = await getSessionTranscriptsCollection();
    const patternsCollection = await getPatternsCollection();

    const rows = await transcripts.find({
        agentWallet: input.agentWallet,
        createdAt: { $gte: input.timeRange.start, $lte: input.timeRange.end },
    }).toArray();

    const sequenceFrequency = new Map<string, { sequence: string[]; count: number; lastExecuted: number }>();

    for (const row of rows) {
        const sequence = extractToolCalls(row.messages);
        if (sequence.length === 0) {
            continue;
        }

        const key = sequence.join("|");
        const current = sequenceFrequency.get(key);
        if (current) {
            current.count += 1;
            current.lastExecuted = Math.max(current.lastExecuted, row.createdAt);
        } else {
            sequenceFrequency.set(key, {
                sequence,
                count: 1,
                lastExecuted: row.createdAt,
            });
        }
    }

    let patterns = 0;
    for (const entry of sequenceFrequency.values()) {
        const confidence = Math.min(1, entry.count / 10);
        if (confidence < input.confidenceThreshold) {
            continue;
        }

        const patternId = patternIdFrom(input.agentWallet, entry.sequence);
        const summary = summarizeToolSequence(entry.sequence);

        const patternDoc: ProceduralPattern = {
            patternId,
            agentWallet: input.agentWallet,
            patternType: "tool_sequence",
            trigger: {
                type: "context",
                value: entry.sequence[0],
            },
            steps: entry.sequence.map((action, index) => ({
                action,
                order: index,
            })),
            summary,
            successRate: Math.min(0.99, 0.5 + entry.count / 20),
            executionCount: entry.count,
            lastExecuted: entry.lastExecuted,
            metadata: {
                taskType: "auto-extracted",
                tags: ["tool-sequence", "learned"],
            },
            createdAt: nowMs(),
            updatedAt: nowMs(),
        };

        await patternsCollection.updateOne(
            { patternId },
            {
                $set: {
                    ...patternDoc,
                    updatedAt: nowMs(),
                },
                $setOnInsert: {
                    createdAt: patternDoc.createdAt,
                },
            },
            { upsert: true },
        );

        patterns += 1;
    }

    if (patterns > 0) {
        await invalidateMemoryScope({ agentWallet: input.agentWallet });
    }

    return {
        patterns,
        extracted: rows.length,
    };
}

export async function createMemoryArchive(input: {
    agentWallet: string;
    dateRange: TimeRange;
    compress?: boolean;
}): Promise<{ archiveId: string; memoriesArchived: number; compressedSize: number }> {
    const vectors = await getMemoryVectorsCollection();
    const archives = await getArchivesCollection();

    const docs = await vectors.find({
        agentWallet: input.agentWallet,
        createdAt: { $gte: input.dateRange.start, $lte: input.dateRange.end },
    }).toArray();

    const archiveId = `arc_${input.agentWallet.slice(2, 10)}_${nowMs()}`;
    const payload = JSON.stringify({
        archiveId,
        agentWallet: input.agentWallet,
        dateRange: input.dateRange,
        vectors: docs,
    });

    const useCompression = input.compress !== false;
    const storedContent = useCompression ? gzipSync(payload).toString("base64") : payload;
    const compressedSize = Buffer.byteLength(storedContent, "utf8");

    const archive: MemoryArchive = {
        archiveId,
        agentWallet: input.agentWallet,
        summary: `Archive for ${new Date(input.dateRange.start).toISOString()} - ${new Date(input.dateRange.end).toISOString()}`,
        content: storedContent,
        compressed: useCompression,
        dateRange: input.dateRange,
        metadata: {
            entryCount: docs.length,
            originalSize: Buffer.byteLength(payload, "utf8"),
            compressedSize,
            topics: [],
        },
        createdAt: nowMs(),
    };

    await archives.insertOne(archive);
    await invalidateMemoryScope({ agentWallet: input.agentWallet });

    return {
        archiveId,
        memoriesArchived: docs.length,
        compressedSize,
    };
}

export async function updateMemoryDecayScores(input: { halfLifeDays: number }): Promise<{ updated: number; avgDecayScore: number }> {
    const vectors = await getMemoryVectorsCollection();
    const halfLifeDays = Math.max(1, input.halfLifeDays || 30);
    const now = Date.now();

    const docs = await vectors.find({}).toArray();
    if (docs.length === 0) {
        return { updated: 0, avgDecayScore: 0 };
    }

    let totalDecay = 0;
    const updates = docs.map((doc) => {
        const ageInDays = Math.max(0, now - doc.createdAt) / (24 * 60 * 60 * 1000);
        const decayScore = calculateDecayMultiplier(ageInDays, halfLifeDays);
        totalDecay += decayScore;
        return {
            updateOne: {
                filter: { vectorId: doc.vectorId },
                update: {
                    $set: {
                        decayScore,
                        updatedAt: now,
                    },
                },
            },
        };
    });

    await vectors.bulkWrite(updates, { ordered: false });

    const avgDecayScore = totalDecay / updates.length;

    const impactedAgents = new Set(docs.map((doc) => doc.agentWallet).filter(Boolean));
    for (const agentWallet of impactedAgents) {
        await invalidateMemoryScope({ agentWallet });
    }

    return {
        updated: updates.length,
        avgDecayScore,
    };
}

export async function validateExtractedPattern(input: {
    patternId: string;
}): Promise<{
    valid: boolean;
    confidence: number;
    occurrences: number;
    successRate: number;
    toolSequence: string[];
}> {
    const patterns = await getPatternsCollection();
    const pattern = await patterns.findOne({ patternId: input.patternId });

    if (!pattern) {
        return {
            valid: false,
            confidence: 0,
            occurrences: 0,
            successRate: 0,
            toolSequence: [],
        };
    }

    const confidence = Math.min(1, (pattern.executionCount / 10) * pattern.successRate);
    const valid = pattern.executionCount >= 2 && pattern.successRate >= 0.55 && confidence >= 0.2;

    return {
        valid,
        confidence,
        occurrences: pattern.executionCount,
        successRate: pattern.successRate,
        toolSequence: pattern.steps.map((step) => step.action),
    };
}

export async function promotePatternToSkill(input: {
    patternId: string;
    skillName: string;
    validationData: {
        valid: boolean;
        confidence: number;
        occurrences: number;
        successRate: number;
        toolSequence: string[];
    };
}): Promise<{ skillId: string; promoted: boolean }> {
    if (!input.validationData.valid) {
        return {
            skillId: "",
            promoted: false,
        };
    }

    const patterns = await getPatternsCollection();
    const skills = await getSkillsCollection();
    const pattern = await patterns.findOne({ patternId: input.patternId });

    if (!pattern) {
        return {
            skillId: "",
            promoted: false,
        };
    }

    const skillId = `skill_${pattern.patternId}_${createContentHash(input.skillName + nowMs()).slice(0, 20)}`;

    const skill: SkillDocument = {
        skillId,
        name: input.skillName,
        description: `Learned from pattern ${pattern.patternId}: ${pattern.summary}`,
        category: "learned",
        trigger: {
            type: "pattern",
            patterns: [pattern.patternId, ...input.validationData.toolSequence],
        },
        spawnConfig: {
            skillType: "learned",
            tools: input.validationData.toolSequence,
            maxSteps: Math.max(3, input.validationData.toolSequence.length),
            conditions: {
                minConfidence: input.validationData.confidence,
            },
        },
        successRate: input.validationData.successRate,
        usageCount: 0,
        creator: "system",
        agents: [pattern.agentWallet],
        tags: ["auto-promoted", "pattern"],
        createdAt: nowMs(),
    };

    await skills.insertOne(skill);

    await patterns.updateOne(
        { patternId: pattern.patternId },
        { $set: { updatedAt: nowMs(), "metadata.taskType": "promoted" } },
    );

    await invalidateMemoryScope({ agentWallet: pattern.agentWallet });

    return {
        skillId,
        promoted: true,
    };
}

export async function cleanupExpiredMemories(input: {
    olderThanDays: number;
}): Promise<{ deleted: number; freedBytes: number }> {
    const cutoff = nowMs() - input.olderThanDays * 24 * 60 * 60 * 1000;

    const vectors = await getMemoryVectorsCollection();
    const sessions = await getSessionsCollection();
    const transcripts = await getSessionTranscriptsCollection();

    const staleVectors = await vectors.find({ createdAt: { $lt: cutoff }, decayScore: { $lt: 0.2 } }).toArray();
    const freedBytes = staleVectors.reduce((sum, vector) => sum + Buffer.byteLength(vector.content, "utf8"), 0);

    const vectorDeleteResult = await vectors.deleteMany({
        createdAt: { $lt: cutoff },
        decayScore: { $lt: 0.2 },
    });

    const sessionDeleteResult = await sessions.deleteMany({
        $or: [
            { expiresAt: { $lt: nowMs() } },
            { lastAccessedAt: { $lt: cutoff } },
        ],
    });

    const transcriptDeleteResult = await transcripts.deleteMany({
        createdAt: { $lt: cutoff },
    });

    await invalidateMemoryScope({});

    return {
        deleted:
            (vectorDeleteResult.deletedCount || 0)
            + (sessionDeleteResult.deletedCount || 0)
            + (transcriptDeleteResult.deletedCount || 0),
        freedBytes,
    };
}

async function pinJsonToIpfs(payload: Record<string, unknown>, name: string): Promise<string> {
    const jwt = process.env.PINATA_JWT;
    const apiKey = process.env.PINATA_API_Key;
    const apiSecret = process.env.PINATA_API_SECRET;

    const headers: Record<string, string> = {
        "Content-Type": "application/json",
    };

    if (jwt) {
        headers.Authorization = `Bearer ${jwt}`;
    } else if (apiKey && apiSecret) {
        headers.pinata_api_key = apiKey;
        headers.pinata_secret_api_key = apiSecret;
    } else {
        throw new Error("Pinata credentials not configured");
    }

    const response = await fetch(`${requirePinataApiUrl()}/pinning/pinJSONToIPFS`, {
        method: "POST",
        headers,
        body: JSON.stringify({
            pinataContent: payload,
            pinataMetadata: {
                name,
            },
            pinataOptions: {
                cidVersion: 1,
            },
        }),
    });

    if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Pinata pin failed (${response.status}): ${errorText}`);
    }

    const data = (await response.json()) as { IpfsHash?: string };
    if (!data.IpfsHash) {
        throw new Error("Pinata response missing IpfsHash");
    }

    return data.IpfsHash;
}

export async function syncArchiveToPinata(input: {
    archiveId: string;
    agentWallet: string;
}): Promise<{ ipfsHash: string; pinned: boolean }> {
    const archives = await getArchivesCollection();
    const archive = await archives.findOne({ archiveId: input.archiveId, agentWallet: input.agentWallet });

    if (!archive) {
        throw new Error(`Archive ${input.archiveId} not found for agent ${input.agentWallet}`);
    }

    if (archive.ipfsCid) {
        return {
            ipfsHash: archive.ipfsCid,
            pinned: true,
        };
    }

    const contentPayload = {
        archiveId: archive.archiveId,
        agentWallet: archive.agentWallet,
        summary: archive.summary,
        dateRange: archive.dateRange,
        compressed: archive.compressed,
        content: archive.content,
        metadata: archive.metadata,
        createdAt: archive.createdAt,
    };

    const ipfsHash = await pinJsonToIpfs(contentPayload, `compose-memory-archive-${archive.archiveId}`);

    await archives.updateOne(
        { archiveId: archive.archiveId },
        { $set: { ipfsCid: ipfsHash } },
    );

    await invalidateMemoryScope({ agentWallet: input.agentWallet });

    return {
        ipfsHash,
        pinned: true,
    };
}
