/**
 * Multimodal Inference Handler
 * 
 * Routes ALL multimodal models through Lambda API gateway.
 * Lambda handles provider routing (HuggingFace, Google, etc.).
 * 
 * Endpoints used:
 * - /v1/images/generations (text-to-image, image-to-image)
 * - /v1/videos/generations (text-to-video)
 * - /v1/audio/speech (text-to-speech)
 * - /v1/audio/transcriptions (ASR)
 */

import { buildApiInternalHeaders, requireApiInternalUrl } from "../auth.js";

// =============================================================================
// Types
// =============================================================================

export type TaskType = string | string[];

export interface MultimodalResult {
    success: boolean;
    type: "text" | "image" | "audio" | "video" | "embedding";
    content?: string;
    data?: string; // base64 encoded
    mimeType?: string;
    usage?: Record<string, unknown>;
    media?: {
        generatedUnits?: number;
        generatedSeconds?: number;
        generatedMinutes?: number;
        requests?: number;
        jobId?: string;
        status?: string;
        progress?: number;
    };
    error?: string;
    executionTime: number;
}

// =============================================================================
// Task Detection
// =============================================================================

const modelInfoCache = new Map<string, { modelId: string; type: TaskType; provider?: string }>();

/**
 * Detect the task type for a model from the registry
 */
export async function detectModelTask(modelId: string): Promise<TaskType> {
    if (modelInfoCache.has(modelId)) {
        const cached = modelInfoCache.get(modelId)!;
        return cached.type;
    }

    try {
        const apiInternalUrl = requireApiInternalUrl();
        console.log(`[multimodal] Fetching task type for: "${modelId}" from ${apiInternalUrl}`);
        const response = await fetch(
            `${apiInternalUrl}/v1/models/${encodeURIComponent(modelId)}`,
            { headers: buildApiInternalHeaders() },
        );

        if (response.ok) {
            const data = await response.json();
            const task = data?.type;
            if (typeof task !== "string" && !Array.isArray(task)) {
                throw new Error(`type is required for model ${modelId}`);
            }
            console.log(`[multimodal] Task detected for "${modelId}": ${task}`);
            modelInfoCache.set(modelId, { modelId: data.modelId, type: task, provider: data.provider });
            return task;
        } else {
            console.warn(`[multimodal] Model lookup failed for "${modelId}": ${response.status}`);
        }
    } catch (error) {
        console.warn(`[multimodal] Failed to fetch model info for "${modelId}":`, error);
        throw error;
    }
    throw new Error(`Unable to resolve model type for ${modelId}`);
}

/**
 * Check if a model is a chat/text model (uses LangChain) or multimodal (uses this handler)
 */
export function isChatModel(task: TaskType): boolean {
    const taskValues = Array.isArray(task) ? task : [task];
    return !taskValues.some((value) => {
        const normalized = value.toLowerCase();
        return normalized.includes("image")
            || normalized.includes("video")
            || normalized.includes("audio")
            || normalized.includes("speech")
            || normalized.includes("embedding")
            || normalized.includes("feature-extraction");
    });
}

function hasTask(task: TaskType, expected: string): boolean {
    const taskValues = Array.isArray(task) ? task : [task];
    return taskValues.some((value) => value.toLowerCase() === expected);
}

// =============================================================================
// Multimodal Inference - Routes through Lambda Gateway
// =============================================================================

/**
 * Execute multimodal inference by routing through Lambda API gateway.
 * Lambda handles all provider routing (HuggingFace, Google, etc.).
 */
export async function executeMultimodal(
    modelId: string,
    task: TaskType,
    input: string,
    imageData?: string
): Promise<MultimodalResult> {
    const start = Date.now();

    console.log(`[multimodal] Executing via Lambda: model=${modelId}, task=${task}`);

    try {
        if (hasTask(task, "text-to-image") || hasTask(task, "image-to-image")) {
            return await callLambdaImageGeneration(modelId, input, imageData, start);
        }

        if (hasTask(task, "text-to-video") || hasTask(task, "image-to-video")) {
            return await callLambdaVideoGeneration(modelId, input, imageData, start);
        }

        if (hasTask(task, "text-to-speech") || hasTask(task, "text-to-audio")) {
            return await callLambdaAudioGeneration(modelId, input, start);
        }

        if (hasTask(task, "automatic-speech-recognition") || hasTask(task, "speech-to-text")) {
            if (!imageData) {
                return {
                    success: false,
                    type: "text",
                    error: "Audio data required for speech recognition",
                    executionTime: Date.now() - start,
                };
            }
            return await callLambdaTranscription(modelId, imageData, start);
        }

        if (hasTask(task, "feature-extraction")) {
            return await callLambdaEmbeddings(modelId, input, start);
        }

        if (isChatModel(task)) {
            return {
                success: false,
                type: "text",
                error: `Text models must route through the text execution path: ${Array.isArray(task) ? task.join(", ") : task}`,
                executionTime: Date.now() - start,
            };
        }

        return {
            success: false,
            type: "text",
            error: `Unsupported task type: ${Array.isArray(task) ? task.join(", ") : task}`,
            executionTime: Date.now() - start,
        };
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`[multimodal] Lambda error:`, message);
        return {
            success: false,
            type: "text",
            error: message,
            executionTime: Date.now() - start,
        };
    }
}

// =============================================================================
// Lambda Gateway Calls
// =============================================================================

async function callLambdaImageGeneration(
    modelId: string,
    prompt: string,
    imageData: string | undefined,
    start: number
): Promise<MultimodalResult> {
    // Detect if imageData is a URL or base64 and send appropriate field
    const isUrl = imageData?.startsWith("http://") || imageData?.startsWith("https://");

    const response = await fetch(`${requireApiInternalUrl()}/v1/images/generations`, {
        method: "POST",
        headers: buildApiInternalHeaders({
            "Content-Type": "application/json",
        }),
        body: JSON.stringify({
            model: modelId,
            prompt,
            // Send as image_url if URL, otherwise as image (base64)
            ...(isUrl ? { image_url: imageData } : { image: imageData }),
        }),
    });

    if (!response.ok) {
        const error = await response.json().catch(() => ({ error: { message: response.statusText } }));
        throw new Error(error?.error?.message || `Image generation failed: ${response.status}`);
    }

    const data = await response.json();
    const images = Array.isArray(data?.data) ? data.data : [];
    const item = images[0];

    if (!item) {
        throw new Error("No image data in response");
    }

    return {
        success: true,
        type: "image",
        data: item.b64_json || item.url,
        mimeType: "image/png",
        media: {
            generatedUnits: images.length,
            requests: 1,
        },
        executionTime: Date.now() - start,
    };
}

async function callLambdaVideoGeneration(
    modelId: string,
    prompt: string,
    imageData: string | undefined,
    start: number
): Promise<MultimodalResult> {
    // Detect if imageData is a URL or base64 and send appropriate field
    const isUrl = imageData?.startsWith("http://") || imageData?.startsWith("https://");

    const response = await fetch(`${requireApiInternalUrl()}/v1/videos/generations`, {
        method: "POST",
        headers: buildApiInternalHeaders({
            "Content-Type": "application/json",
        }),
        body: JSON.stringify({
            model: modelId,
            prompt,
            // Send as image_url if URL, otherwise as image (base64)
            ...(isUrl ? { image_url: imageData } : { image: imageData }),
        }),
    });

    if (!response.ok) {
        const error = await response.json().catch(() => ({ error: { message: response.statusText } }));
        throw new Error(error?.error?.message || `Video generation failed: ${response.status}`);
    }

    const data = await response.json();

    if (typeof data?.id === "string" && typeof data?.status === "string") {
        return {
            success: true,
            type: "video",
            media: {
                generatedUnits: 1,
                requests: 1,
                jobId: data.id,
                status: data.status,
                progress: typeof data.progress === "number" ? data.progress : undefined,
            },
            executionTime: Date.now() - start,
        };
    }

    const videos = Array.isArray(data?.data) ? data.data : [];
    const item = videos[0];

    if (!item) {
        throw new Error("No video data in response");
    }

    return {
        success: true,
        type: "video",
        data: item.b64_json || item.url,
        mimeType: "video/mp4",
        media: {
            generatedUnits: videos.length,
            generatedSeconds: typeof item.duration === "number" ? item.duration : undefined,
            generatedMinutes: typeof item.duration === "number" ? item.duration / 60 : undefined,
            requests: 1,
        },
        executionTime: Date.now() - start,
    };
}

async function callLambdaAudioGeneration(
    modelId: string,
    input: string,
    start: number
): Promise<MultimodalResult> {
    const response = await fetch(`${requireApiInternalUrl()}/v1/audio/speech`, {
        method: "POST",
        headers: buildApiInternalHeaders({
            "Content-Type": "application/json",
        }),
        body: JSON.stringify({
            model: modelId,
            input,
        }),
    });

    if (!response.ok) {
        const error = await response.json().catch(() => ({ error: { message: response.statusText } }));
        throw new Error(error?.error?.message || `Audio generation failed: ${response.status}`);
    }

    const arrayBuffer = await response.arrayBuffer();
    const base64 = Buffer.from(arrayBuffer).toString("base64");

    return {
        success: true,
        type: "audio",
        data: base64,
        mimeType: "audio/wav",
        media: {
            requests: 1,
        },
        executionTime: Date.now() - start,
    };
}

async function callLambdaTranscription(
    modelId: string,
    audioDataBase64: string,
    start: number
): Promise<MultimodalResult> {
    const response = await fetch(`${requireApiInternalUrl()}/v1/audio/transcriptions`, {
        method: "POST",
        headers: buildApiInternalHeaders({
            "Content-Type": "application/json",
        }),
        body: JSON.stringify({
            model: modelId,
            file: audioDataBase64,
        }),
    });

    if (!response.ok) {
        const error = await response.json().catch(() => ({ error: { message: response.statusText } }));
        throw new Error(error?.error?.message || `Transcription failed: ${response.status}`);
    }

    const data = await response.json();

    return {
        success: true,
        type: "text",
        content: data.text,
        media: {
            requests: 1,
        },
        executionTime: Date.now() - start,
    };
}

async function callLambdaEmbeddings(
    modelId: string,
    input: string,
    start: number
): Promise<MultimodalResult> {
    const response = await fetch(`${requireApiInternalUrl()}/v1/embeddings`, {
        method: "POST",
        headers: buildApiInternalHeaders({
            "Content-Type": "application/json",
        }),
        body: JSON.stringify({
            model: modelId,
            input,
        }),
    });

    if (!response.ok) {
        const error = await response.json().catch(() => ({ error: { message: response.statusText } }));
        throw new Error(error?.error?.message || `Embeddings failed: ${response.status}`);
    }

    const data = await response.json();

    return {
        success: true,
        type: "embedding",
        content: JSON.stringify(data.data?.[0]?.embedding),
        usage: data.usage,
        media: {
            requests: 1,
        },
        executionTime: Date.now() - start,
    };
}
