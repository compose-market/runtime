// Current mesh reputation is receipt-based. Hypercert-backed attestations are
// not wired into runtime yet.
function clamp(value: number): number {
    if (!Number.isFinite(value)) {
        return 0;
    }
    return Math.max(0, Math.min(1, value));
}

export interface ReputationReceipt {
    conclaveId: string;
    finishedAt: number;
    success: boolean;
    qualityScore?: number;
}

export interface ReputationEngineOptions {
    receipts: ReputationReceipt[];
    now?: number;
    decayLambda?: number;
}

export interface ReputationSummary {
    score: number;
    successRate: number;
    qualityMultiplier: number;
    activityMultiplier: number;
    totalConclaves: number;
    successfulConclaves: number;
    lastConclaveAt: number | null;
    daysSinceLastConclave: number | null;
}

export function quality(receipts: ReputationReceipt[]): number {
    const scored = receipts
        .map((receipt) => receipt.qualityScore)
        .filter((score): score is number => Number.isFinite(score));

    if (scored.length === 0) {
        return 1;
    }

    return clamp(scored.reduce((sum, score) => sum + clamp(score), 0) / scored.length);
}

export function activity(days: number | null, decay = 0.01): number {
    if (days == null) {
        return 0;
    }
    return clamp(Math.exp(-decay * Math.max(0, days)));
}

export function summarizeReputation(options: ReputationEngineOptions): ReputationSummary {
    const now = options.now ?? Date.now();
    const decay = options.decayLambda ?? 0.01;
    const receipts = [...options.receipts].sort((left, right) => right.finishedAt - left.finishedAt);
    const totalConclaves = receipts.length;
    const successfulConclaves = receipts.filter((receipt) => receipt.success).length;
    const successRate = totalConclaves === 0 ? 0 : successfulConclaves / totalConclaves;
    const lastConclaveAt = receipts[0]?.finishedAt ?? null;
    const daysSinceLastConclave = lastConclaveAt == null ? null : (now - lastConclaveAt) / 86_400_000;
    const qualityMultiplier = quality(receipts);
    const activityMultiplier = activity(daysSinceLastConclave, decay);

    return {
        score: clamp(successRate * qualityMultiplier * activityMultiplier),
        successRate: clamp(successRate),
        qualityMultiplier,
        activityMultiplier,
        totalConclaves,
        successfulConclaves,
        lastConclaveAt,
        daysSinceLastConclave,
    };
}