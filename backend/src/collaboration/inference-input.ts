import { z } from 'zod';
import type { RemoteInferenceRequestPayload, SharedProviderCatalog } from '@koryphaios/shared';

const boundedText = z.string().max(1_000_000);
const contentBlock = z.object({
  type: z.enum(['text', 'image', 'audio', 'video', 'tool_use', 'tool_result']),
  text: boundedText.optional(),
  toolCallId: z.string().max(200).optional(),
  toolName: z.string().max(200).optional(),
  toolInput: z.record(z.string(), z.unknown()).optional(),
  toolOutput: boundedText.optional(),
  isError: z.boolean().optional(),
  imageData: z.string().max(20_000_000).optional(),
  imageMimeType: z.string().max(100).optional(),
  mediaData: z.string().max(20_000_000).optional(),
  mediaMimeType: z.string().max(100).optional(),
});
const schema = z.object({
  provider: z.string().min(1).max(128),
  model: z.string().min(1).max(512),
  messages: z
    .array(
      z.object({
        role: z.enum(['system', 'user', 'assistant', 'tool']),
        content: z.union([boundedText, z.array(contentBlock).max(512)]),
        tool_call_id: z.string().max(200).optional(),
        tool_calls: z
          .array(
            z.object({
              id: z.string().max(200),
              name: z.string().max(200),
              input: z.record(z.string(), z.unknown()),
            }),
          )
          .max(256)
          .optional(),
      }),
    )
    .max(300),
  systemPrompt: z.string().max(128_000),
  tools: z
    .array(
      z.object({
        name: z.string().min(1).max(200),
        description: z.string().max(16_000),
        inputSchema: z.record(z.string(), z.unknown()),
      }),
    )
    .max(256)
    .optional(),
  maxTokens: z.number().int().min(1).max(65_536).optional(),
  temperature: z.number().min(0).max(2).optional(),
  reasoningLevel: z.string().max(64).optional(),
  speedTier: z.string().max(64).optional(),
  modelParameters: z.record(z.string(), z.union([z.number(), z.string()])).optional(),
  fusion: z
    .strictObject({
      lead: z.string().max(256),
      leadEffort: z.string().max(32),
      leadFast: z.boolean(),
      sidekick: z.string().max(256),
      sidekickEffort: z.string().max(32).nullable(),
    })
    .optional(),
  forceFreshConversation: z.boolean().optional(),
  imageInputOverride: z
    .object({ provider: z.string().max(128), model: z.string().max(512) })
    .optional(),
  // Needed only by explicitly authorized collaboration tiers, never model codes.
  projectSync: z
    .object({
      mode: z.enum(['full', 'delta']),
      files: z
        .array(z.object({ path: z.string().min(1).max(1024), content: boundedText }))
        .max(5000),
      deletes: z.array(z.string().min(1).max(1024)).max(5000),
    })
    .optional(),
});

/** Peer JSON cannot supply local sessions, paths, roles, permission modes,
 * auth config, bridge grants or other host execution authority. */
export function parseRemoteInferenceInput(value: unknown): RemoteInferenceRequestPayload | null {
  const result = schema.safeParse(value);
  return result.success ? result.data : null;
}

const catalogSchema = z
  .object({
    hostName: z.string().min(1).max(80),
    providers: z
      .array(
        z.object({
          provider: z
            .string()
            .min(1)
            .max(128)
            .regex(/^[a-zA-Z0-9][a-zA-Z0-9:_-]*$/),
          label: z.string().min(1).max(160),
          agentic: z.boolean(),
          risk: z.enum(['ok', 'caution', 'prohibited']).default('caution'),
          models: z
            .array(
              z.object({
                id: z.string().min(1).max(512),
                name: z.string().min(1).max(512),
                contextWindow: z.number().int().positive().max(10_000_000).optional(),
                maxOutputTokens: z.number().int().positive().max(1_000_000).optional(),
                canReason: z.boolean().optional(),
                reasoningLevels: z.array(z.string().max(64)).max(20).optional(),
              }),
            )
            .max(10_000),
        }),
      )
      .max(128),
  })
  .refine(
    (catalog) =>
      catalog.providers.reduce((count, provider) => count + provider.models.length, 0) <= 20_000,
  );

export function parseSharedProviderCatalog(value: unknown): SharedProviderCatalog | null {
  const result = catalogSchema.safeParse(value);
  return result.success ? result.data : null;
}
