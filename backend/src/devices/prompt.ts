import { z } from 'zod';

const schema = z.object({
  content: z.string().max(32_000),
  model: z.string().min(1).max(512).optional(),
  reasoningLevel: z.string().max(64).optional(),
  contextWindow: z.number().int().positive().max(10_000_000).optional(),
  interactionMode: z.enum(['act', 'plan']).optional(),
  fastMode: z.boolean().optional(),
  speedTier: z.string().optional(),
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
  imageInputMode: z.enum(['reject', 'omit', 'allow']).optional(),
  attachments: z.array(z.object({
    type: z.enum(['image', 'file', 'audio', 'video']),
    data: z.string().max(600_000),
    name: z.string().min(1).max(512),
    mimeType: z.string().max(128).optional(),
  })).max(16).optional(),
});

/** Preserve normal composer options, while bounding the encrypted RPC frame. */
export function parseDevicePrompt(input: unknown) {
  const result = schema.safeParse(input);
  if (!result.success) throw new Error('Invalid device prompt or attachment; linked attachments must fit within 600 KB.');
  const prompt = result.data;
  if (!prompt.content.trim() && !prompt.attachments?.length) throw new Error('Enter a prompt or attach a file.');
  if ((prompt.attachments ?? []).reduce((size, file) => size + file.data.length, 0) > 600_000)
    throw new Error('Linked attachments must fit within 600 KB per message.');
  return prompt;
}
