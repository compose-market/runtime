import type { MMRConfig, SearchResult } from "./types.js";

function getWordSet(text: string): Set<string> {
    return new Set(text.toLowerCase().split(/\s+/).filter((word) => word.length > 2));
}

function jaccardSimilarity(setA: Set<string>, setB: Set<string>): number {
    if (setA.size === 0 && setB.size === 0) return 1;
    if (setA.size === 0 || setB.size === 0) return 0;

    let intersectionSize = 0;
    const smaller = setA.size <= setB.size ? setA : setB;
    const larger = setA.size <= setB.size ? setB : setA;

    for (const token of smaller) {
        if (larger.has(token)) intersectionSize++;
    }

    const unionSize = setA.size + setB.size - intersectionSize;
    return unionSize === 0 ? 0 : intersectionSize / unionSize;
}

function mmrRerankFast(results: SearchResult[], lambda: number): SearchResult[] {
    const maxScore = Math.max(...results.map((result) => result.score));
    const minScore = Math.min(...results.map((result) => result.score));
    const scoreRange = maxScore - minScore;

    const normalizeScore = (score: number): number => {
        if (scoreRange === 0) return 1;
        return (score - minScore) / scoreRange;
    };

    const tokenCache = new Map<string, Set<string>>();
    const tokenStrings = new Map<string, string>();

    for (const item of results) {
        const tokens = getWordSet(item.content);
        tokenCache.set(item.id, tokens);
        tokenStrings.set(item.id, Array.from(tokens).sort().join("|"));
    }

    const sorted = [...results].sort((a, b) => b.score - a.score);
    const selected: SearchResult[] = [];
    const selectedTokenSets: Set<string>[] = [];
    const selectedIds = new Set<string>();

    const batchSize = 20;
    const compareLimit = 15;

    for (let batch = 0; batch < sorted.length; batch += batchSize) {
        const batchEnd = Math.min(batch + batchSize, sorted.length);

        for (let i = batch; i < batchEnd; i++) {
            const candidate = sorted[i];
            if (selectedIds.has(candidate.id)) continue;

            const normalizedRelevance = normalizeScore(candidate.score);
            let maxSimilarity = 0;

            if (selectedTokenSets.length > 0) {
                const candidateTokens = tokenCache.get(candidate.id)!;

                const startIndex = Math.max(0, selectedTokenSets.length - compareLimit);
                for (let j = startIndex; j < selectedTokenSets.length; j++) {
                    const similarity = jaccardSimilarity(candidateTokens, selectedTokenSets[j]);
                    if (similarity > maxSimilarity) maxSimilarity = similarity;
                    if (maxSimilarity > 0.8) break;
                }
            }

            const score = lambda * normalizedRelevance - (1 - lambda) * maxSimilarity;
            if (score >= -0.3 || selected.length < 10) {
                selected.push(candidate);
                selectedIds.add(candidate.id);
                selectedTokenSets.push(tokenCache.get(candidate.id)!);
            }
        }
    }

    for (const item of sorted) {
        if (!selectedIds.has(item.id)) {
            selected.push(item);
            selectedIds.add(item.id);
        }
    }

    return selected;
}

function mmrRerankPreciseInternal(results: SearchResult[], lambda: number): SearchResult[] {
    const maxScore = Math.max(...results.map((r) => r.score));
    const minScore = Math.min(...results.map((r) => r.score));
    const scoreRange = maxScore - minScore;

    const normalizeScore = (score: number): number => {
        if (scoreRange === 0) return 1;
        return (score - minScore) / scoreRange;
    };

    const tokenCache = new Map<string, Set<string>>();
    for (const item of results) {
        tokenCache.set(item.id, getWordSet(item.content));
    }

    const selected: SearchResult[] = [];
    const remaining = [...results];
    const selectedTokenSets: Set<string>[] = [];
    const selectedIds = new Set<string>();

    while (remaining.length > 0) {
        let bestIndex = 0;
        let bestMMRScore = -Infinity;

        for (let i = 0; i < remaining.length; i++) {
            const candidate = remaining[i];
            if (selectedIds.has(candidate.id)) continue;

            const normalizedRelevance = normalizeScore(candidate.score);
            let maxSimilarity = 0;
            const candidateTokens = tokenCache.get(candidate.id)!;

            for (const selectedTokens of selectedTokenSets) {
                const similarity = jaccardSimilarity(candidateTokens, selectedTokens);
                if (similarity > maxSimilarity) maxSimilarity = similarity;
            }

            const mmrScore = lambda * normalizedRelevance - (1 - lambda) * maxSimilarity;
            if (mmrScore > bestMMRScore) {
                bestMMRScore = mmrScore;
                bestIndex = i;
            }
        }

        const bestItem = remaining[bestIndex];
        selected.push(bestItem);
        selectedIds.add(bestItem.id);
        selectedTokenSets.push(tokenCache.get(bestItem.id)!);
        remaining.splice(bestIndex, 1);
    }

    return selected;
}

export function mmrRerank(results: SearchResult[], config: Partial<MMRConfig> = {}): SearchResult[] {
    const { enabled = false, lambda = 0.7 } = config;

    if (!enabled || results.length <= 1) return [...results];

    const clampedLambda = Math.max(0, Math.min(1, lambda));
    if (clampedLambda === 1) return [...results].sort((a, b) => b.score - a.score);

    if (results.length > 100) {
        return mmrRerankFast(results, clampedLambda);
    }

    return mmrRerankPreciseInternal(results, clampedLambda);
}

export function mmrRerankPrecise(results: SearchResult[], config: Partial<MMRConfig> = {}): SearchResult[] {
    const { enabled = false, lambda = 0.7 } = config;

    if (!enabled || results.length <= 1) return [...results];

    const clampedLambda = Math.max(0, Math.min(1, lambda));
    if (clampedLambda === 1) return [...results].sort((a, b) => b.score - a.score);

    return mmrRerankPreciseInternal(results, clampedLambda);
}
