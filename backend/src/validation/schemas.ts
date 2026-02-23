/**
 * Zod Validation Schemas
 * 
 * Input validation for API endpoints.
 * All user input must be validated before processing.
 */

import { z } from 'zod';

// ─── Credential Schemas ─────────────────────────────────────────────────────

export const CreateCredentialSchema = z.object({
  provider: z.enum([
    'openai', 'anthropic', 'google', 'xai', 'openrouter',
    'groq', 'azure', 'bedrock', 'vertexai', 'ollama', 'local',
    'cline', 'copilot', 'codex', 'opencodezen',
    '302ai', 'azurecognitive', 'baseten', 'cerebras', 'cloudflare', 'cortecs', 'deepseek', 'deepinfra',
    'firmware', 'fireworks', 'gitlab', 'huggingface', 'helicone', 'llamacpp', 'ionet', 'lmstudio',
    'moonshot', 'minimax', 'nebius', 'ollamacloud', 'sapai', 'stackit', 'ovhcloud', 'scaleway',
    'togetherai', 'venice', 'vercel', 'zai', 'zenmux',
  ]),
  credential: z.string()
    .min(1, 'Credential is required')
    .max(4096, 'Credential too long (max 4096 chars)'),
  metadata: z.record(z.unknown()).optional(),
});

export const UpdateCredentialSchema = z.object({
  metadata: z.record(z.unknown()),
});

export const DeleteCredentialSchema = z.object({
  reason: z.string().max(500).optional(),
}).optional();

export const RotateCredentialSchema = z.object({
  reason: z.string().max(500).optional(),
}).optional();

// ─── API Key Schemas ────────────────────────────────────────────────────────

export const ApiKeyScopeSchema = z.enum(['read', 'write', 'admin', 'provider:*']);

export const CreateApiKeySchema = z.object({
  name: z.string()
    .min(1, 'Name is required')
    .max(100, 'Name too long (max 100 chars)')
    .regex(/^[a-zA-Z0-9_\-\s]+$/, 'Name contains invalid characters'),
  scopes: z.array(z.string())
    .min(1, 'At least one scope is required')
    .max(10, 'Too many scopes (max 10)')
    .optional()
    .default(['read']),
  rateLimitTier: z.enum(['free', 'premium', 'pro', 'enterprise'])
    .optional()
    .default('free'),
  expiresInDays: z.number()
    .int()
    .min(1)
    .max(365)
    .optional(),
  metadata: z.record(z.unknown()).optional(),
});

export const UpdateApiKeySchema = z.object({
  name: z.string()
    .min(1)
    .max(100)
    .regex(/^[a-zA-Z0-9_\-\s]+$/)
    .optional(),
  scopes: z.array(z.string())
    .min(1)
    .max(10)
    .optional(),
  rateLimitTier: z.enum(['free', 'premium', 'pro', 'enterprise'])
    .optional(),
});

// ─── Audit Schemas ──────────────────────────────────────────────────────────

export const QueryAuditSchema = z.object({
  userId: z.string().optional(),
  action: z.string().max(50).optional(),
  resourceType: z.string().max(50).optional(),
  resourceId: z.string().max(100).optional(),
  startTime: z.coerce.number().int().optional(),
  endTime: z.coerce.number().int().optional(),
  success: z.enum(['true', 'false']).optional(),
  limit: z.coerce.number().int().min(1).max(1000).optional().default(100),
  offset: z.coerce.number().int().min(0).optional().default(0),
});

export const SuspiciousActivitySchema = z.object({
  userId: z.string().min(1, 'userId is required'),
});

// ─── Helper Functions ───────────────────────────────────────────────────────

export function validateBody<T>(schema: z.ZodSchema<T>, body: unknown): { 
  success: true; 
  data: T;
} | { 
  success: false; 
  errors: string[];
} {
  const result = schema.safeParse(body);
  
  if (result.success) {
    return { success: true, data: result.data };
  }
  
  const errors = result.error.errors.map(e => `${e.path.join('.')}: ${e.message}`);
  return { success: false, errors };
}

export function validateQuery<T>(schema: z.ZodSchema<T>, query: URLSearchParams): {
  success: true;
  data: T;
} | {
  success: false;
  errors: string[];
} {
  const obj: Record<string, unknown> = {};
  
  for (const [key, value] of query.entries()) {
    obj[key] = value;
  }
  
  const result = schema.safeParse(obj);
  
  if (result.success) {
    return { success: true, data: result.data };
  }
  
  const errors = result.error.errors.map(e => `${e.path.join('.')}: ${e.message}`);
  return { success: false, errors };
}

// ─── Rate Limit Config ──────────────────────────────────────────────────────

export const RateLimitConfigSchema = z.object({
  windowMs: z.number().int().min(1000).max(3600000).optional().default(60000),
  maxRequests: z.number().int().min(1).max(10000).optional().default(100),
  algorithm: z.enum(['sliding-window', 'token-bucket']).optional().default('sliding-window'),
});
