/**
 * Multimodal Inference Handler
 * 
 * Handles non-chat models (text-to-image, text-to-audio, ASR, etc.)
 * using HuggingFace InferenceClient with automatic provider routing.
 * 
 * Also supports Google GenAI models (Gemini, Veo, Lyria) via @google/genai SDK.
 * 
 * This is used for agents configured with multimodal models instead
 * of LangChain's ChatOpenAI which only works with chat models.
 */

import { InferenceClient } from "@huggingface/inference";
import { GoogleGenAI, type GenerateContentResponse, type Part } from "@google/genai";

const HF_TOKEN = process.env.HUGGING_FACE_INFERENCE_TOKEN || "";
const GOOGLE_API_KEY = process.env.GOOGLE_GENERATIVE_AI_API_KEY || "";
const LAMBDA_API_URL = process.env.LAMBDA_API_URL || "https://api.compose.market";

// Initialize Google GenAI client (lazy)
let googleClient: GoogleGenAI | null = null;
function getGoogleClient(): GoogleGenAI {
    if (!GOOGLE_API_KEY) {
        throw new Error("Google API key not configured (GOOGLE_GENERATIVE_AI_API_KEY)");
    }
    if (!googleClient) {
        googleClient = new GoogleGenAI({ apiKey: GOOGLE_API_KEY });
    }
    return googleClient;
}

/**
 * Check if a model is a Google model based on ID patterns
 */
function isGoogleModel(modelId: string): boolean {
    const lower = modelId.toLowerCase();
    return (
        lower.startsWith("gemini") ||
        lower.startsWith("veo") ||
        lower.startsWith("lyria") ||
        lower.includes("models/gemini") ||
        lower.includes("models/veo") ||
        lower.includes("models/lyria")
    );
}

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

interface ModelInfo {
    id: string;
    task?: string;
    source?: string;
}

// =============================================================================
// Task Detection
// =============================================================================

// Cache for model info
const modelInfoCache = new Map<string, ModelInfo>();

/**
 * Detect the task type for a model from the registry
 */
export async function detectModelTask(modelId: string): Promise<TaskType> {
    // Check cache
    if (modelInfoCache.has(modelId)) {
        const cached = modelInfoCache.get(modelId)!;
        return (cached.task as TaskType) || "text-generation";
    }

    try {
        const response = await fetch(
            `${LAMBDA_API_URL}/api/registry/model/${encodeURIComponent(modelId)}`
        );

        if (response.ok) {
            const data = await response.json() as ModelInfo;
            modelInfoCache.set(modelId, data);
            return (data.task as TaskType) || "text-generation";
        }
    } catch (error) {
        console.warn(`[multimodal] Failed to fetch model info for ${modelId}:`, error);
    }

    // Fallback: infer from model ID
    return inferTaskFromModelId(modelId);
}

/**
 * Infer task type from model ID patterns
 */
function inferTaskFromModelId(modelId: string): TaskType {
    const lower = modelId.toLowerCase();

    // Google Gemini image models (Nano Banana)
    if (lower.includes("gemini") && (lower.includes("-image") || lower.includes("image-"))) {
        return "text-to-image";
    }
    // Google Veo video models
    if (lower.startsWith("veo") || lower.includes("veo-")) {
        return "text-to-video";
    }
    // Google Lyria audio/music models
    if (lower.startsWith("lyria") || lower.includes("lyria-")) {
        return "text-to-audio";
    }

    if (lower.includes("flux") || lower.includes("stable-diffusion") || lower.includes("sdxl")) {
        // FLUX.2-dev is image-to-image, FLUX.1 is text-to-image
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
// Multimodal Inference
// =============================================================================

// Providers to try (avoid fal-ai which requires PRO)
const TEXT_TO_IMAGE_PROVIDERS = ["hf-inference", "wavespeed", "replicate", "novita"] as const;
const IMAGE_TO_IMAGE_PROVIDERS = ["wavespeed", "hf-inference", "replicate", "novita"] as const;

/**
 * Execute multimodal inference based on task type
 */
export async function executeMultimodal(
    modelId: string,
    task: TaskType,
    input: string,
    imageData?: string // base64 encoded
): Promise<MultimodalResult> {
    const start = Date.now();

    // Route Google models to Google GenAI SDK
    if (isGoogleModel(modelId)) {
        console.log(`[multimodal] Detected Google model: ${modelId}, routing to Google GenAI`);
        return await executeGoogleMultimodal(modelId, task, input, imageData, start);
    }

    // HuggingFace models
    if (!HF_TOKEN) {
        return {
            success: false,
            type: "text",
            error: "HuggingFace token not configured",
            executionTime: 0,
        };
    }

    const client = new InferenceClient(HF_TOKEN);

    try {
        switch (task) {
            case "text-to-image":
                return await handleTextToImage(client, modelId, input, start);

            case "image-to-image":
                if (!imageData) {
                    return {
                        success: false,
                        type: "image",
                        error: "Image data required for image-to-image",
                        executionTime: Date.now() - start,
                    };
                }
                return await handleImageToImage(client, modelId, input, imageData, start);

            case "text-to-speech":
            case "text-to-audio":
                return await handleTextToAudio(client, modelId, input, start);

            case "automatic-speech-recognition":
                if (!imageData) { // We reuse imageData for audio data
                    return {
                        success: false,
                        type: "text",
                        error: "Audio data required for speech recognition",
                        executionTime: Date.now() - start,
                    };
                }
                return await handleASR(client, modelId, imageData, start);

            case "text-to-video":
                return await handleTextToVideo(client, modelId, input, start);

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
        return {
            success: false,
            type: "text",
            error: message,
            executionTime: Date.now() - start,
        };
    }
}

// =============================================================================
// Google GenAI Handler
// =============================================================================

/**
 * Execute multimodal inference for Google models
 */
async function executeGoogleMultimodal(
    modelId: string,
    task: TaskType,
    input: string,
    imageData: string | undefined,
    start: number
): Promise<MultimodalResult> {
    try {
        const client = getGoogleClient();
        const cleanModelId = modelId.replace("models/", "");

        switch (task) {
            case "text-to-image": {
                console.log(`[multimodal] Google text-to-image: ${cleanModelId}`);
                const response = await client.models.generateContent({
                    model: cleanModelId,
                    contents: input,
                }) as GenerateContentResponse;

                // Extract image from response
                const parts = response.candidates?.[0]?.content?.parts;
                if (!parts || parts.length === 0) {
                    throw new Error("No content in response");
                }

                // Find the inline data part (base64 image)
                for (const part of parts as Part[]) {
                    if ("inlineData" in part && part.inlineData?.data) {
                        return {
                            success: true,
                            type: "image",
                            data: part.inlineData.data,
                            mimeType: part.inlineData.mimeType || "image/png",
                            executionTime: Date.now() - start,
                        };
                    }
                }

                // Check for text response (model may return text describing why it couldn't generate)
                const textPart = (parts as Part[]).find((p: Part) => "text" in p);
                if (textPart && "text" in textPart) {
                    throw new Error(`Model returned text instead of image: ${textPart.text?.substring(0, 200)}`);
                }

                throw new Error("No image data in response");
            }

            case "text-to-video": {
                console.log(`[multimodal] Google text-to-video (Veo): ${cleanModelId}`);
                // Start the video generation operation
                let operation = await client.models.generateVideos({
                    model: cleanModelId,
                    prompt: input,
                });

                // Poll for completion (max 5 minutes)
                const maxWaitMs = 5 * 60 * 1000;
                const pollIntervalMs = 10000;
                const pollStart = Date.now();

                while (!operation.done && (Date.now() - pollStart) < maxWaitMs) {
                    console.log(`[multimodal] Waiting for video generation... (${Math.round((Date.now() - pollStart) / 1000)}s)`);
                    await new Promise(resolve => setTimeout(resolve, pollIntervalMs));
                    operation = await client.operations.getVideosOperation({ operation });
                }

                if (!operation.done) {
                    throw new Error("Video generation timed out after 5 minutes");
                }

                const generatedVideo = operation.response?.generatedVideos?.[0];
                if (!generatedVideo?.video?.uri) {
                    throw new Error("No video generated in response");
                }

                // Download video and convert to base64
                const videoResponse = await fetch(generatedVideo.video.uri);
                if (!videoResponse.ok) {
                    throw new Error("Failed to download generated video");
                }
                const arrayBuffer = await videoResponse.arrayBuffer();
                const base64 = Buffer.from(arrayBuffer).toString("base64");

                return {
                    success: true,
                    type: "video",
                    data: base64,
                    mimeType: generatedVideo.video.mimeType || "video/mp4",
                    executionTime: Date.now() - start,
                };
            }

            case "text-to-audio":
            case "text-to-speech": {
                console.log(`[multimodal] Google text-to-audio: ${cleanModelId}`);
                const response = await client.models.generateContent({
                    model: cleanModelId,
                    contents: input,
                    config: {
                        responseModalities: ["AUDIO"],
                    },
                }) as GenerateContentResponse;

                const parts = response.candidates?.[0]?.content?.parts;
                const audioPart = (parts as Part[] | undefined)?.find((p: Part) => "inlineData" in p && p.inlineData?.data);
                if (audioPart && "inlineData" in audioPart && audioPart.inlineData?.data) {
                    return {
                        success: true,
                        type: "audio",
                        data: audioPart.inlineData.data,
                        mimeType: audioPart.inlineData.mimeType || "audio/wav",
                        executionTime: Date.now() - start,
                    };
                }

                throw new Error("No audio data in response");
            }

            default:
                return {
                    success: false,
                    type: "text",
                    error: `Unsupported task type for Google model: ${task}`,
                    executionTime: Date.now() - start,
                };
        }
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`[multimodal] Google GenAI error:`, message);

        // Provide helpful error messages
        if (message.includes("PERMISSION_DENIED") || message.includes("403")) {
            return {
                success: false,
                type: "text",
                error: `Access denied for model "${modelId}". Verify GOOGLE_GENERATIVE_AI_API_KEY permissions.`,
                executionTime: Date.now() - start,
            };
        }
        if (message.includes("not found") || message.includes("404")) {
            return {
                success: false,
                type: "text",
                error: `Model "${modelId}" not found. Check model availability.`,
                executionTime: Date.now() - start,
            };
        }

        return {
            success: false,
            type: "text",
            error: message,
            executionTime: Date.now() - start,
        };
    }
}

// =============================================================================
// Handler Functions
// =============================================================================

async function handleTextToImage(
    client: InferenceClient,
    modelId: string,
    prompt: string,
    start: number
): Promise<MultimodalResult> {
    let lastError: Error | null = null;

    for (const provider of TEXT_TO_IMAGE_PROVIDERS) {
        try {
            console.log(`[multimodal] Text-to-image: ${modelId} with provider=${provider}`);

            const result = await client.textToImage({
                provider,
                model: modelId,
                inputs: prompt,
            });

            const blob = result as unknown as Blob;
            const arrayBuffer = await blob.arrayBuffer();
            const base64 = Buffer.from(arrayBuffer).toString("base64");

            return {
                success: true,
                type: "image",
                data: base64,
                mimeType: "image/png",
                executionTime: Date.now() - start,
            };
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            console.log(`[multimodal] Provider ${provider} failed: ${message}`);
            lastError = error instanceof Error ? error : new Error(message);

            if (message.includes("PRO") || message.includes("not supported") ||
                message.includes("not available") || message.includes("404")) {
                continue;
            }
            throw error;
        }
    }

    throw lastError || new Error("All providers failed");
}

async function handleImageToImage(
    client: InferenceClient,
    modelId: string,
    prompt: string,
    imageDataBase64: string,
    start: number
): Promise<MultimodalResult> {
    let imageBuffer: Buffer;
    let imageBlob: Blob;

    try {
        imageBuffer = Buffer.from(imageDataBase64, "base64");
        imageBlob = new Blob([new Uint8Array(imageBuffer)], { type: "image/png" });
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`[multimodal] Failed to decode image data: ${message}`);
        return {
            success: false,
            type: "image",
            error: `Failed to decode image data: ${message}`,
            executionTime: Date.now() - start,
        };
    }

    const errors: string[] = [];

    for (const provider of IMAGE_TO_IMAGE_PROVIDERS) {
        try {
            console.log(`[multimodal] Image-to-image: ${modelId} with provider=${provider}`);

            const result = await client.imageToImage({
                provider,
                model: modelId,
                inputs: imageBlob,
                parameters: { prompt },
            });

            const blob = result as unknown as Blob;
            const arrayBuffer = await blob.arrayBuffer();
            const base64 = Buffer.from(arrayBuffer).toString("base64");

            return {
                success: true,
                type: "image",
                data: base64,
                mimeType: "image/png",
                executionTime: Date.now() - start,
            };
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            console.log(`[multimodal] Provider ${provider} failed: ${message}`);
            errors.push(`${provider}: ${message}`);

            // Continue to next provider for known recoverable errors
            if (message.includes("PRO") || message.includes("not supported") ||
                message.includes("not available") || message.includes("404") ||
                message.includes("Upgrade") || message.includes("rate") ||
                message.includes("timeout") || message.includes("500")) {
                continue;
            }
            // For other errors, still continue but log them
            continue;
        }
    }

    // All providers failed - return error result instead of throwing
    const errorSummary = errors.length > 0
        ? `All providers failed for ${modelId}: ${errors.join("; ")}`
        : `No providers available for ${modelId}`;
    console.error(`[multimodal] ${errorSummary}`);

    return {
        success: false,
        type: "image",
        error: errorSummary,
        executionTime: Date.now() - start,
    };
}

async function handleTextToAudio(
    client: InferenceClient,
    modelId: string,
    text: string,
    start: number
): Promise<MultimodalResult> {
    console.log(`[multimodal] Text-to-audio: ${modelId}`);

    const result = await client.textToSpeech({
        provider: "auto",
        model: modelId,
        inputs: text,
    });

    const blob = result as unknown as Blob;
    const arrayBuffer = await blob.arrayBuffer();
    const base64 = Buffer.from(arrayBuffer).toString("base64");

    return {
        success: true,
        type: "audio",
        data: base64,
        mimeType: "audio/wav",
        executionTime: Date.now() - start,
    };
}

async function handleASR(
    client: InferenceClient,
    modelId: string,
    audioDataBase64: string,
    start: number
): Promise<MultimodalResult> {
    console.log(`[multimodal] ASR: ${modelId}`);

    const audioBuffer = Buffer.from(audioDataBase64, "base64");
    const audioBlob = new Blob([new Uint8Array(audioBuffer)], { type: "audio/wav" });

    const result = await client.automaticSpeechRecognition({
        provider: "auto",
        model: modelId,
        inputs: audioBlob,
    });

    return {
        success: true,
        type: "text",
        content: result.text,
        executionTime: Date.now() - start,
    };
}

async function handleTextToVideo(
    client: InferenceClient,
    modelId: string,
    prompt: string,
    start: number
): Promise<MultimodalResult> {
    console.log(`[multimodal] Text-to-video: ${modelId}`);

    // HuggingFace inference doesn't have a built-in textToVideo method
    // Use direct API call
    const response = await fetch(`https://router.huggingface.co/hf-inference/models/${modelId}`, {
        method: "POST",
        headers: {
            Authorization: `Bearer ${HF_TOKEN}`,
            "Content-Type": "application/json",
        },
        body: JSON.stringify({ inputs: prompt }),
    });

    if (!response.ok) {
        throw new Error(`Video generation failed: ${response.status}`);
    }

    const arrayBuffer = await response.arrayBuffer();
    const base64 = Buffer.from(arrayBuffer).toString("base64");

    return {
        success: true,
        type: "video",
        data: base64,
        mimeType: "video/mp4",
        executionTime: Date.now() - start,
    };
}
