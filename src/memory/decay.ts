import type { SearchResult, TemporalDecayConfig } from "./types.js";

const DAY_MS = 24 * 60 * 60 * 1000;

export function toDecayLambda(halfLifeDays: number): number {
    if (!Number.isFinite(halfLifeDays) || halfLifeDays <= 0) {
        return 0;
    }
    return Math.LN2 / halfLifeDays;
}

export function calculateDecayMultiplier(ageInDays: number, halfLifeDays: number): number {
    const lambda = toDecayLambda(halfLifeDays);
    const clampedAge = Math.max(0, ageInDays);
    if (lambda <= 0 || !Number.isFinite(clampedAge)) {
        return 1;
    }
    return Math.exp(-lambda * clampedAge);
}

export function applyTemporalDecay(score: number, createdAt: number, config: TemporalDecayConfig): number {
    if (!config.enabled) {
        return score;
    }

    const ageMs = Date.now() - createdAt;
    const ageInDays = ageMs / DAY_MS;
    return score * calculateDecayMultiplier(ageInDays, config.halfLifeDays);
}

export function applyDecayToResults(results: SearchResult[], config: TemporalDecayConfig): SearchResult[] {
    if (!config.enabled) {
        return results;
    }

    const now = Date.now();
    const processed = results.map((result) => {
        const ageInDays = (now - result.createdAt) / DAY_MS;
        const decayScore = calculateDecayMultiplier(ageInDays, config.halfLifeDays);

        return {
            ...result,
            score: result.score * decayScore,
            decayScore,
        };
    });

    return processed.sort((a, b) => b.score - a.score);
}
