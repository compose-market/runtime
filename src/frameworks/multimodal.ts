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

const LAMBDA_API_URL = process.env.LAMBDA_API_URL || "https://api.compose.market";

// set in .env
function requireEnv(name: string): string {
    const value = process.env[name];
    if (!value) {
        throw new Error(`${name} environment variable is required`);
    }
    return value;
}

const MANOWAR_INTERNAL_SECRET = requireEnv("MANOWAR_INTERNAL_SECRET");

// =============================================================================
// Types
// =============================================================================

export type TaskType =
    | "text-generation"
    | "text-to-image"
    | "image-to-image"
    | "text-to-speech"
    | "text-to-audio"
    | "automatic-speech-recognition"
    | "text-to-video"
    | "image-to-video"
    | "feature-extraction"
    | "other";

export interface MultimodalResult {
    success: boolean;
    type: "text" | "image" | "audio" | "video" | "embedding";
    content?: string;
    data?: string; // base64 encoded
    mimeType?: string;
    error?: string;
    executionTime: number;
}

// =============================================================================
// Task Detection
// =============================================================================

const modelInfoCache = new Map<string, { id: string; task?: string; source?: string }>();

/**
 * Detect the task type for a model from the registry
 */
export async function detectModelTask(modelId: string): Promise<TaskType> {
    if (modelInfoCache.has(modelId)) {
        const cached = modelInfoCache.get(modelId)!;
        return (cached.task as TaskType) || "text-generation";
    }

    try {
        console.log(`[multimodal] Fetching task type for: "${modelId}" from ${LAMBDA_API_URL}`);
        const response = await fetch(
            `${LAMBDA_API_URL}/v1/models/${encodeURIComponent(modelId)}`
        );

        if (response.ok) {
            const data = await response.json();
            console.log(`[multimodal] Task detected for "${modelId}": ${data.task_type || 'text-generation'}`);
            modelInfoCache.set(modelId, { id: data.id, task: data.task_type, source: data.provider });
            return (data.task_type as TaskType) || "text-generation";
        } else {
            console.warn(`[multimodal] Model lookup failed for "${modelId}": ${response.status}`);
        }
    } catch (error) {
        console.warn(`[multimodal] Failed to fetch model info for "${modelId}":`, error);
    }

    return inferTaskFromModelId(modelId);
}

function inferTaskFromModelId(modelId: string): TaskType {
    const lower = modelId.toLowerCase();

    if (lower.includes("gemini") && (lower.includes("-image") || lower.includes("image-"))) {
        return "text-to-image";
    }
    if (lower.startsWith("veo") || lower.includes("veo-")) {
        return "text-to-video";
    }
    if (lower.startsWith("lyria") || lower.includes("lyria-")) {
        return "text-to-audio";
    }
    if (lower.includes("flux") || lower.includes("stable-diffusion") || lower.includes("sdxl")) {
        if (lower.includes("2-dev") || lower.includes("2.dev")) {
            return "image-to-image";
        }
        return "text-to-image";
    }
    if (lower.includes("whisper") || lower.includes("asr")) {
        return "automatic-speech-recognition";
    }
    if (lower.includes("tts") || lower.includes("text-to-speech") || lower.includes("bark") || lower.includes("speecht5")) {
        return "text-to-speech";
    }
    if (lower.includes("musicgen") || lower.includes("audiogen")) {
        return "text-to-audio";
    }
    if (lower.includes("video") || lower.includes("mochi") || lower.includes("cogvideo")) {
        return "text-to-video";
    }
    if (lower.includes("embed") || lower.includes("bge") || lower.includes("e5-")) {
        return "feature-extraction";
    }

    return "text-generation";
}

/**
 * Check if a model is a chat/text model (uses LangChain) or multimodal (uses this handler)
 */
export function isChatModel(task: TaskType): boolean {
    return task === "text-generation" || task === "other";
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
        switch (task) {
            case "text-to-image":
            case "image-to-image":
                return await callLambdaImageGeneration(modelId, input, imageData, start);

            case "text-to-video":
            case "image-to-video":
                return await callLambdaVideoGeneration(modelId, input, imageData, start);

            case "text-to-speech":
            case "text-to-audio":
                return await callLambdaAudioGeneration(modelId, input, start);

            case "automatic-speech-recognition":
                if (!imageData) {
                    return {
                        success: false,
                        type: "text",
                        error: "Audio data required for speech recognition",
                        executionTime: Date.now() - start,
                    };
                }
                return await callLambdaTranscription(modelId, imageData, start);

            case "feature-extraction":
                return await callLambdaEmbeddings(modelId, input, start);

            default:
                return {
                    success: false,
                    type: "text",
                    error: `Unsupported task type: ${task}`,
                    executionTime: Date.now() - start,
                };
        }
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

    const response = await fetch(`${LAMBDA_API_URL}/v1/images/generations`, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            "x-manowar-internal": MANOWAR_INTERNAL_SECRET
        },
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
    const item = data?.data?.[0];

    if (!item) {
        throw new Error("No image data in response");
    }

    return {
        success: true,
        type: "image",
        data: item.b64_json || item.url,
        mimeType: "image/png",
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

    const response = await fetch(`${LAMBDA_API_URL}/v1/videos/generations`, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            "x-manowar-internal": MANOWAR_INTERNAL_SECRET,
        },
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
    const item = data?.data?.[0];

    if (!item) {
        throw new Error("No video data in response");
    }

    return {
        success: true,
        type: "video",
        data: item.b64_json || item.url,
        mimeType: "video/mp4",
        executionTime: Date.now() - start,
    };
}

async function callLambdaAudioGeneration(
    modelId: string,
    input: string,
    start: number
): Promise<MultimodalResult> {
    const response = await fetch(`${LAMBDA_API_URL}/v1/audio/speech`, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            "x-manowar-internal": MANOWAR_INTERNAL_SECRET,
        },
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
        executionTime: Date.now() - start,
    };
}

async function callLambdaTranscription(
    modelId: string,
    audioDataBase64: string,
    start: number
): Promise<MultimodalResult> {
    const response = await fetch(`${LAMBDA_API_URL}/v1/audio/transcriptions`, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            "x-manowar-internal": MANOWAR_INTERNAL_SECRET,
        },
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
        executionTime: Date.now() - start,
    };
}

async function callLambdaEmbeddings(
    modelId: string,
    input: string,
    start: number
): Promise<MultimodalResult> {
    const response = await fetch(`${LAMBDA_API_URL}/v1/embeddings`, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            "x-manowar-internal": MANOWAR_INTERNAL_SECRET,
        },
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
        executionTime: Date.now() - start,
    };
}
