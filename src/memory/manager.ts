/**
 * Infinite Memory Manager for standalone agents.
 *
 * Uses Lambda HTTP APIs as the single integration surface:
 * - /api/memory/* for Mem0 + scene/cell memory
 * - /v1/chat/completions for extraction and consolidation prompts
 */

const LAMBDA_API_URL = process.env.LAMBDA_API_URL || process.env.API_URL || "https://api.compose.market";

function buildHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
        "Content-Type": "application/json",
    };
    return headers;
}

async function parseJson<T>(response: Response): Promise<T> {
    const text = await response.text();
    if (!text) {
        return {} as T;
    }
    return JSON.parse(text) as T;
}

interface OpenAIChatChoice {
    message?: {
        content?: string;
    };
}

interface OpenAIChatCompletionResponse {
    choices?: OpenAIChatChoice[];
}

export interface MemoryCell {
    id: string;
    scene: string;
    cellType: "fact" | "plan" | "preference" | "decision" | "task" | "risk";
    salience: number;
    content: string;
    agentWallet: string;
    createdAt: number;
    evergreen: boolean;
}

export interface SceneSummary {
    sceneId: string;
    agentWallet: string;
    summary: string;
    consolidatedAt: number;
    cellCount?: number;
}

export interface MemoryItem {
    id: string;
    memory: string;
    user_id?: string;
    agent_id?: string;
    run_id?: string;
    metadata?: Record<string, unknown>;
    created_at?: string;
    updated_at?: string;
    relations?: Array<{ source: string; target: string; relation: string }>;
}

export interface MemorySearchResult {
    id: string;
    content: string;
    score: number;
    effectiveScore: number;
    source: "mem0" | "redis";
    scene?: string;
    cellType?: MemoryCell["cellType"];
    relations?: Array<{ source: string; target: string; relation: string }>;
}

export interface ConsolidationResult {
    sceneId: string;
    summary: string;
    cellCount: number;
    consolidatedAt: number;
}

export interface ExtractionResult {
    cells: MemoryCell[];
    scene: string;
}

export class InfiniteMemoryManager {
    private async generateText(model: string, prompt: string, maxTokens = 512): Promise<string> {
        const response = await fetch(`${LAMBDA_API_URL}/v1/chat/completions`, {
            method: "POST",
            headers: buildHeaders(),
            body: JSON.stringify({
                model,
                messages: [{ role: "user", content: prompt }],
                temperature: 0.2,
                max_tokens: maxTokens,
            }),
        });

        if (!response.ok) {
            throw new Error(`Model invocation failed (${response.status})`);
        }

        const data = await parseJson<OpenAIChatCompletionResponse>(response);
        return data.choices?.[0]?.message?.content?.trim() || "";
    }

    async saveCell(params: {
        agentWallet: string;
        content: string;
        scene?: string;
        cellType?: MemoryCell["cellType"];
        salience?: number;
        evergreen?: boolean;
    }): Promise<{ success: boolean; cellId?: string; error?: string }> {
        try {
            const response = await fetch(`${LAMBDA_API_URL}/api/memory/cell`, {
                method: "POST",
                headers: buildHeaders(),
                body: JSON.stringify({
                    agentWallet: params.agentWallet,
                    content: params.content,
                    scene: params.scene || "general",
                    cellType: params.cellType || "fact",
                    salience: params.salience ?? 0.8,
                    evergreen: params.evergreen ?? false,
                }),
            });

            if (!response.ok) {
                const body = await response.text();
                return { success: false, error: body || `HTTP ${response.status}` };
            }

            const result = await parseJson<{ success: boolean; cellId?: string }>(response);
            return { success: result.success, cellId: result.cellId };
        } catch (error) {
            return { success: false, error: error instanceof Error ? error.message : String(error) };
        }
    }

    async getSceneSummary(params: { sceneId: string; agentWallet: string }): Promise<SceneSummary | null> {
        try {
            const response = await fetch(
                `${LAMBDA_API_URL}/api/memory/scene/${encodeURIComponent(params.agentWallet)}/${encodeURIComponent(params.sceneId)}`,
                {
                    method: "GET",
                    headers: buildHeaders(),
                }
            );
            if (!response.ok) {
                return null;
            }
            return await parseJson<SceneSummary>(response);
        } catch {
            return null;
        }
    }

    async extractCells(params: {
        user: string;
        assistant: string;
        agentWallet: string;
        model?: string;
    }): Promise<ExtractionResult> {
        const model = params.model || process.env.OPENCLAW_MEMORY_MODEL || "gpt-4o-mini";
        const prompt = `Convert this interaction into structured memory cells.

Return a JSON array with objects:
- scene (topic/context)
- cellType (fact, plan, preference, decision, task, risk)
- salience (0-1)
- content (compressed factual statement)

User: ${params.user}
Assistant: ${params.assistant}

Return only valid JSON.`;

        try {
            const content = await this.generateText(model, prompt, 700);
            const jsonMatch = content.match(/\[[\s\S]*\]/);
            if (!jsonMatch) {
                return { cells: [], scene: "general" };
            }

            const parsed = JSON.parse(jsonMatch[0]) as Array<{
                scene?: string;
                cellType?: MemoryCell["cellType"];
                salience?: number;
                content?: string;
            }>;

            const now = Date.now();
            const cells = parsed
                .filter((item) => typeof item.content === "string" && item.content.trim().length > 0)
                .map((item, index) => ({
                    id: `cell_${now}_${index}_${Math.random().toString(36).slice(2, 8)}`,
                    scene: item.scene || "general",
                    cellType: item.cellType || "fact",
                    salience: Math.max(0, Math.min(1, item.salience ?? 0.5)),
                    content: item.content!,
                    agentWallet: params.agentWallet,
                    createdAt: now,
                    evergreen: false,
                }));

            return { cells, scene: cells[0]?.scene || "general" };
        } catch {
            return { cells: [], scene: "general" };
        }
    }

    async storeInteraction(params: {
        user: string;
        assistant: string;
        agentWallet: string;
        userId?: string;
        model?: string;
        framework?: string;
    }): Promise<{ cells: MemoryCell[]; mem0Items: MemoryItem[] }> {
        const { cells } = await this.extractCells(params);

        for (const cell of cells) {
            await this.saveCell({
                agentWallet: params.agentWallet,
                content: cell.content,
                scene: cell.scene,
                cellType: cell.cellType,
                salience: cell.salience,
                evergreen: cell.evergreen,
            });
        }

        let mem0Items: MemoryItem[] = [];
        try {
            const response = await fetch(`${LAMBDA_API_URL}/api/memory/add`, {
                method: "POST",
                headers: buildHeaders(),
                body: JSON.stringify({
                    messages: [
                        { role: "user", content: params.user },
                        { role: "assistant", content: params.assistant },
                    ],
                    agentWallet: params.agentWallet,
                    userId: params.userId,
                    enableGraph: true,
                    metadata: {
                        source: params.framework,
                        scene: cells[0]?.scene,
                        cellCount: cells.length,
                    },
                }),
            });
            if (response.ok) {
                const body = await parseJson<MemoryItem[] | { items?: MemoryItem[] }>(response);
                mem0Items = Array.isArray(body) ? body : (body.items || []);
            }
        } catch {
            mem0Items = [];
        }

        const scenes = new Set(cells.map((cell) => cell.scene));
        for (const scene of scenes) {
            await this.consolidateScene({
                sceneId: scene,
                agentWallet: params.agentWallet,
                model: params.model,
            });
        }

        return { cells, mem0Items };
    }

    async consolidateScene(params: {
        sceneId: string;
        agentWallet: string;
        model?: string;
    }): Promise<ConsolidationResult | null> {
        const model = params.model || "gpt-4o-mini";
        const existing = await this.getSceneSummary(params);
        const existingResult: ConsolidationResult | null = existing
            ? {
                sceneId: existing.sceneId,
                summary: existing.summary,
                cellCount: existing.cellCount ?? 0,
                consolidatedAt: existing.consolidatedAt,
            }
            : null;

        const cellResponse = await fetch(`${LAMBDA_API_URL}/api/memory/cell/search`, {
            method: "POST",
            headers: buildHeaders(),
            body: JSON.stringify({
                agentWallet: params.agentWallet,
                limit: 100,
            }),
        });

        if (!cellResponse.ok) {
            return existingResult;
        }

        const allCells = await parseJson<Array<MemoryCell & { effectiveScore?: number }>>(cellResponse);
        const sceneCells = allCells.filter((cell) => cell.scene === params.sceneId);
        if (sceneCells.length < 3) {
            return existingResult;
        }

        const prompt = `Summarize this scene in under 100 words.
Scene: ${params.sceneId}
Cells:
${sceneCells.map((cell) => `- [${cell.cellType}] ${cell.content}`).join("\n")}`;

        try {
            const summary = await this.generateText(model, prompt, 180);
            const saveResponse = await fetch(`${LAMBDA_API_URL}/api/memory/scene`, {
                method: "POST",
                headers: buildHeaders(),
                body: JSON.stringify({
                    sceneId: params.sceneId,
                    agentWallet: params.agentWallet,
                    summary,
                    cellCount: sceneCells.length,
                }),
            });
            if (!saveResponse.ok) {
                return existingResult;
            }

            return {
                sceneId: params.sceneId,
                summary,
                cellCount: sceneCells.length,
                consolidatedAt: Date.now(),
            };
        } catch {
            return existingResult;
        }
    }

    async search(params: {
        query: string;
        agentWallet: string;
        userId?: string;
        limit?: number;
    }): Promise<MemorySearchResult[]> {
        const limit = params.limit || 10;

        let mem0Results: MemoryItem[] = [];
        try {
            const response = await fetch(`${LAMBDA_API_URL}/api/memory/search`, {
                method: "POST",
                headers: buildHeaders(),
                body: JSON.stringify({
                    query: params.query,
                    agentWallet: params.agentWallet,
                    userId: params.userId,
                    limit: limit * 2,
                    enableGraph: true,
                }),
            });
            if (response.ok) {
                mem0Results = await parseJson<MemoryItem[]>(response);
            }
        } catch {
            mem0Results = [];
        }

        let redisResults: Array<MemoryCell & { effectiveScore: number }> = [];
        try {
            const response = await fetch(`${LAMBDA_API_URL}/api/memory/cell/search`, {
                method: "POST",
                headers: buildHeaders(),
                body: JSON.stringify({
                    agentWallet: params.agentWallet,
                    limit: limit * 2,
                }),
            });
            if (response.ok) {
                redisResults = await parseJson<Array<MemoryCell & { effectiveScore: number }>>(response);
            }
        } catch {
            redisResults = [];
        }

        const mem0Mapped: MemorySearchResult[] = mem0Results.map((item) => ({
            id: item.id,
            content: item.memory,
            score: 0.8,
            effectiveScore: 0.8,
            source: "mem0",
            relations: item.relations,
        }));

        const redisMapped: MemorySearchResult[] = redisResults.map((cell) => ({
            id: cell.id,
            content: cell.content,
            score: cell.salience,
            effectiveScore: cell.effectiveScore || cell.salience,
            source: "redis",
            scene: cell.scene,
            cellType: cell.cellType,
        }));

        const merged = [...mem0Mapped, ...redisMapped];
        merged.sort((a, b) => b.effectiveScore - a.effectiveScore);

        const deduped: MemorySearchResult[] = [];
        const seen = new Set<string>();
        for (const result of merged) {
            const key = `${result.source}:${result.id}`;
            if (seen.has(key)) {
                continue;
            }
            seen.add(key);
            deduped.push(result);
            if (deduped.length >= limit) {
                break;
            }
        }

        return deduped;
    }

    async getPromptContext(params: {
        query: string;
        agentWallet: string;
        userId?: string;
        maxTokens?: number;
    }): Promise<string> {
        const results = await this.search(params);
        if (results.length === 0) {
            return "";
        }

        const maxChars = Math.max(400, (params.maxTokens || 1000) * 4);
        const parts: string[] = ["[Memory Context]"];
        for (const result of results) {
            parts.push(`- ${result.content}`);
            if (parts.join("\n").length >= maxChars) {
                break;
            }
        }
        return parts.join("\n");
    }

    async runDecayUpdate(): Promise<{ updated: number; errors: number }> {
        try {
            const response = await fetch(`${LAMBDA_API_URL}/api/memory/decay/update`, {
                method: "POST",
                headers: buildHeaders(),
                body: JSON.stringify({ halfLifeDays: 30 }),
            });
            if (!response.ok) {
                return { updated: 0, errors: 1 };
            }
            return await parseJson<{ updated: number; errors: number }>(response);
        } catch {
            return { updated: 0, errors: 1 };
        }
    }
}
