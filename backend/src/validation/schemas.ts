// Input validation schemas using Zod for type-safe request validation

import { z } from "zod";

// ─── Common Schemas ──────────────────────────────────────────────────────────

export const SessionIdSchema = z.string()
    .min(1, "Session ID is required")
    .max(64, "Session ID too long")
    .regex(/^[a-zA-Z0-9_-]+$/, "Invalid session ID format");

export const ProviderNameSchema = z.enum([
    "anthropic", "openai", "google", "gemini", "copilot", "codex", "openrouter", "cline",
    "groq", "xai", "azure", "bedrock", "vertexai", "local",
    "deepseek", "togetherai", "cerebras", "fireworks", "huggingface", "deepinfra",
    "minimax", "moonshot", "ollama", "ollamacloud", "lmstudio", "llamacpp",
    "cloudflare", "vercel", "baseten", "helicone", "portkey",
    "hyperbolic", "ionet", "nebius", "zai", "cortecs", "stepfun",
    "qwen", "alibaba", "zhipuai", "modelscope",
    "replicate", "modal", "scaleway", "venice", "zenmux", "firmware",
    "mistralai", "cohere", "perplexity", "luma", "fal",
    "elevenlabs", "deepgram", "gladia", "assemblyai", "lmnt",
    "nvidia", "nim", "friendliai", "friendli", "voyageai", "mixedbread",
    "mem0", "letta", "blackforestlabs", "klingai", "prodia",
    "302ai", "opencodezen", "novita-ai", "upstage", "v0",
    "siliconflow", "abacus", "llama", "vultr", "wandb", "poe",
    "github-models", "requesty", "inference", "submodel", "synthetic", "moark", "nova",
]).transform((val) => val === "gemini" ? "google" : val);

export const ContentSchema = z.string()
    .min(1, "Content is required")
    .max(100000, "Content exceeds maximum length");

export const TitleSchema = z.string()
    .max(200, "Title too long")
    .optional();

// ─── API Request Schemas ─────────────────────────────────────────────────────

export const CreateSessionRequestSchema = z.object({
    title: TitleSchema,
    parentSessionId: SessionIdSchema.optional(),
});

export const SendMessageRequestSchema = z.object({
    sessionId: SessionIdSchema,
    content: ContentSchema,
    model: z.string().optional(),
    reasoningLevel: z.string().optional(),
    attachments: z.array(z.object({
        type: z.enum(["image", "file"]),
        data: z.string(),
        name: z.string(),
    })).optional(),
});

export const UpdateSessionRequestSchema = z.object({
    title: z.string().min(1).max(200),
});

export const SetProviderCredentialsRequestSchema = z.object({
    apiKey: z.string().max(500).optional(),
    authToken: z.string().max(1000).optional(),
    baseUrl: z.string().url().max(500).optional(),
    selectedModels: z.array(z.string()).optional(),
    hideModelSelector: z.boolean().optional(),
    authMode: z.enum(["api_key", "codex", "cli", "antigravity", "claude_code"]).optional(),
});

export const ApplyChangesRequestSchema = z.object({
    acceptAll: z.boolean().optional(),
    rejectAll: z.boolean().optional(),
    acceptPaths: z.array(z.string()).optional(),
    rejectPaths: z.array(z.string()).optional(),
});

export const GitStageRequestSchema = z.object({
    file: z.string().min(1, "File path is required"),
    unstage: z.boolean().optional(),
});

export const GitCommitRequestSchema = z.object({
    message: z.string().min(1, "Commit message is required").max(500, "Message too long"),
});

export const GitCheckoutRequestSchema = z.object({
    branch: z.string().min(1, "Branch name is required"),
    create: z.boolean().optional(),
});

export const GitMergeRequestSchema = z.object({
    branch: z.string().min(1, "Branch name is required"),
});

export const UpdateAssignmentsRequestSchema = z.object({
    assignments: z.record(z.string(), z.string()),
});

export const CancelAgentRequestSchema = z.object({
    agentId: z.string().min(1, "Agent ID is required"),
});

export const UserInputRequestSchema = z.object({
    sessionId: SessionIdSchema,
    selection: z.string(),
    text: z.string().optional(),
});

// ─── Response Types ──────────────────────────────────────────────────────────

export type ValidationResult<T> =
    | { success: true; data: T }
    | { success: false; errors: z.ZodError };

export function validate<T>(schema: z.ZodSchema<T>, data: unknown): ValidationResult<T> {
    const result = schema.safeParse(data);
    if (result.success) {
        return { success: true, data: result.data };
    }
    return { success: false, errors: result.error };
}

// ─── Validation Middleware Helper ────────────────────────────────────────────

import type { APIResponse } from "@koryphaios/shared";

export function validationErrorResponse(errors: z.ZodError): APIResponse {
    const messages = errors.issues.map((e) => `${e.path.join(".")}: ${e.message}`);
    return {
        ok: false,
        error: `Validation failed: ${messages.join(", ")}`,
    };
}
