// Hoplite platform model catalog.
//
// Hoplite is an async coding-agent control plane, not an inference API. These
// entries describe the models a *thread* can be delegated to, so they are
// informational selectors rather than chat targets.
//
// Source of truth: the model table Hoplite ships in its own app bundle
// (id / displayName / provider / contextWindowTokens / reasoning.levels /
// speed.fast / maxOutputTokens / aliases / providerDefault), cross-checked
// against https://hoplite.sh/docs/agent/models.
//
// The bundle wins where the two disagree: it is what Hoplite's own picker
// enforces. The docs page currently overstates two entries — it lists
// `none → xhigh` for Haiku 4.5 (bundle: no levels) and a `none` level for
// Fable 5 (bundle: low → xhigh).
//
// `maxOutputTokens: 0` follows the repo convention for "the provider reports no
// explicit cap" — every consumer guards with `> 0`.

import type { ModelDef } from '@koryphaios/shared';
import { SPEED_TIER_FAST_HOPLITE } from './speed-tiers';

/** Hoplite ships one model list; there are no separate vendor copies. */
export const HOPLITE_MODELS: ModelDef[] = [
  {
    // vendor: anthropic
    id: 'claude-fable-5-1',
    name: 'Fable 5.1',
    provider: 'hoplite',
    contextWindow: 1_000_000,
    maxOutputTokens: 128_000,
    canReason: true,
    reasoningLevels: ['low', 'medium', 'high', 'xhigh', 'max'],
    supportsAttachments: true,
    costPerMInputTokens: 10,
    costPerMOutputTokens: 50,
    costPerMInputCached: 0.25,
  },
  {
    // vendor: anthropic
    id: 'claude-fable-5',
    name: 'Fable 5',
    provider: 'hoplite',
    contextWindow: 200_000,
    maxOutputTokens: 64_000,
    canReason: true,
    reasoningLevels: ['low', 'medium', 'high', 'xhigh'],
    supportsAttachments: true,
    costPerMInputTokens: 10,
    costPerMOutputTokens: 50,
    costPerMInputCached: 1,
  },
  {
    // vendor: anthropic
    id: 'claude-opus-5',
    name: 'Opus 5',
    provider: 'hoplite',
    contextWindow: 1_000_000,
    maxOutputTokens: 128_000,
    canReason: true,
    reasoningLevels: ['none', 'low', 'medium', 'high', 'xhigh', 'max'],
    supportsAttachments: true,
    costPerMInputTokens: 5,
    costPerMOutputTokens: 25,
    costPerMInputCached: 0.5,
  },
  {
    // vendor: anthropic
    id: 'claude-opus-4-8',
    name: 'Opus 4.8',
    provider: 'hoplite',
    contextWindow: 200_000,
    maxOutputTokens: 32_000,
    canReason: true,
    reasoningLevels: ['none', 'low', 'medium', 'high', 'xhigh'],
    supportsAttachments: true,
    costPerMInputTokens: 5,
    costPerMOutputTokens: 25,
    costPerMInputCached: 0.5,
  },
  {
    // vendor: anthropic
    id: 'claude-sonnet-5',
    name: 'Sonnet 5',
    provider: 'hoplite',
    contextWindow: 1_000_000,
    maxOutputTokens: 128_000,
    canReason: true,
    reasoningLevels: ['none', 'low', 'medium', 'high', 'xhigh', 'max'],
    supportsAttachments: true,
    costPerMInputTokens: 3,
    costPerMOutputTokens: 15,
    costPerMInputCached: 0.3,
    // aliases: claude-sonnet-4-6
  },
  {
    // vendor: anthropic
    id: 'claude-haiku-4-5',
    name: 'Haiku 4.5',
    provider: 'hoplite',
    contextWindow: 200_000,
    maxOutputTokens: 64_000,
    canReason: false,
    supportsAttachments: true,
    costPerMInputTokens: 1,
    costPerMOutputTokens: 5,
    costPerMInputCached: 0.1,
  },
  {
    // vendor: openai
    id: 'gpt-6-astra',
    name: 'GPT-6 Astra',
    provider: 'hoplite',
    contextWindow: 272_000,
    maxOutputTokens: 0,
    canReason: true,
    reasoningLevels: ['low', 'medium', 'high', 'xhigh', 'max'],
    supportsFastMode: true,
    speedTiers: [SPEED_TIER_FAST_HOPLITE],
    supportsAttachments: true,
    costPerMInputTokens: 10,
    costPerMOutputTokens: 50,
    costPerMInputCached: 1,
  },
  {
    // vendor: openai
    id: 'gpt-5.6-sol',
    name: 'GPT-5.6 Sol',
    provider: 'hoplite',
    contextWindow: 200_000,
    maxOutputTokens: 0,
    canReason: true,
    reasoningLevels: ['none', 'low', 'medium', 'high', 'xhigh', 'max'],
    supportsFastMode: true,
    speedTiers: [SPEED_TIER_FAST_HOPLITE],
    supportsAttachments: true,
    costPerMInputTokens: 5,
    costPerMOutputTokens: 30,
    costPerMInputCached: 0.5,
  },
  {
    // vendor: openai
    id: 'gpt-5.6-terra',
    name: 'GPT-5.6 Terra',
    provider: 'hoplite',
    contextWindow: 200_000,
    maxOutputTokens: 0,
    canReason: true,
    reasoningLevels: ['none', 'low', 'medium', 'high', 'xhigh', 'max'],
    supportsFastMode: true,
    speedTiers: [SPEED_TIER_FAST_HOPLITE],
    supportsAttachments: true,
    costPerMInputTokens: 2,
    costPerMOutputTokens: 12,
    costPerMInputCached: 0.2,
    // aliases: gpt-5.6
  },
  {
    // vendor: openai
    id: 'gpt-5.6-luna',
    name: 'GPT-5.6 Luna',
    provider: 'hoplite',
    contextWindow: 200_000,
    maxOutputTokens: 0,
    canReason: true,
    reasoningLevels: ['none', 'low', 'medium', 'high', 'xhigh', 'max'],
    supportsFastMode: true,
    speedTiers: [SPEED_TIER_FAST_HOPLITE],
    supportsAttachments: true,
    costPerMInputTokens: 0.2,
    costPerMOutputTokens: 1.2,
    costPerMInputCached: 0.02,
  },
  {
    // vendor: openai
    id: 'gpt-5.5',
    name: 'GPT-5.5',
    provider: 'hoplite',
    contextWindow: 200_000,
    maxOutputTokens: 0,
    canReason: true,
    reasoningLevels: ['none', 'low', 'medium', 'high', 'xhigh'],
    supportsFastMode: true,
    speedTiers: [SPEED_TIER_FAST_HOPLITE],
    supportsAttachments: true,
    costPerMInputTokens: 5,
    costPerMOutputTokens: 30,
    costPerMInputCached: 0.5,
  },
  {
    // vendor: openai
    id: 'gpt-5.3-codex',
    name: 'GPT-5.3 Codex',
    provider: 'hoplite',
    contextWindow: 400_000,
    maxOutputTokens: 0,
    canReason: true,
    reasoningLevels: ['low', 'medium', 'high'],
    supportsAttachments: true,
    costPerMInputTokens: 1.75,
    costPerMOutputTokens: 14,
    costPerMInputCached: 0.175,
  },
  {
    // vendor: openrouter
    id: 'meta/muse-spark-1.3',
    name: 'Muse Spark 1.3',
    provider: 'hoplite',
    contextWindow: 1_048_576,
    maxOutputTokens: 943_718,
    canReason: true,
    reasoningLevels: ['minimal', 'low', 'medium', 'high', 'xhigh'],
    // default reasoning level: medium
    supportsAttachments: true,
    costPerMInputTokens: 1.25,
    costPerMOutputTokens: 4.25,
    costPerMInputCached: 0.15,
  },
  {
    // vendor: openrouter
    id: 'moonshotai/kimi-k3',
    name: 'Kimi K3',
    provider: 'hoplite',
    contextWindow: 1_048_576,
    maxOutputTokens: 0,
    canReason: true,
    reasoningLevels: ['low', 'high', 'max'],
    // default reasoning level: max
    supportsAttachments: false,
    costPerMInputTokens: 3,
    costPerMOutputTokens: 15,
    costPerMInputCached: 0.3,
  },
  {
    // vendor: openrouter
    id: 'z-ai/glm-5.3',
    name: 'GLM 5.3',
    provider: 'hoplite',
    contextWindow: 1_048_576,
    maxOutputTokens: 0,
    canReason: true,
    reasoningLevels: ['low', 'high', 'max'],
    // default reasoning level: max
    supportsAttachments: false,
    costPerMInputTokens: 1.4,
    costPerMOutputTokens: 4.4,
    costPerMInputCached: 0.26,
  },
  {
    // vendor: openrouter
    id: 'z-ai/glm-5.3-flash',
    name: 'GLM 5.3 Flash',
    provider: 'hoplite',
    contextWindow: 1_048_576,
    maxOutputTokens: 0,
    canReason: true,
    reasoningLevels: ['low', 'high', 'max'],
    // default reasoning level: max
    supportsAttachments: false,
    costPerMInputTokens: 0.15,
    costPerMOutputTokens: 0.5,
    costPerMInputCached: 0.03,
  },
  {
    // vendor: openrouter
    id: 'deepseek/deepseek-v4-flash-0731',
    name: 'DeepSeek V4 Flash 0731',
    provider: 'hoplite',
    contextWindow: 1_048_576,
    maxOutputTokens: 0,
    canReason: true,
    reasoningLevels: ['none', 'low', 'high', 'max'],
    // default reasoning level: high
    supportsAttachments: false,
    costPerMInputTokens: 0.22,
    costPerMOutputTokens: 0.66,
    costPerMInputCached: 0.028,
  },
];

/** Provider-wide default. Hoplite docs: "GPT-5.6 Terra (default)". */
export const HOPLITE_DEFAULT_MODEL_ID = 'gpt-5.6-terra';

/** Models that expose Hoplite's fast (priority) service tier. */
export const HOPLITE_FAST_TIER_MODEL_IDS: string[] = HOPLITE_MODELS.filter(
  (model) => model.supportsFastMode === true,
).map((model) => model.id);

// Withheld: Hoplite ships two further entries with `offeredByDefault: false`, so
// they stay out of its own picker and out of this catalog:
//   - meta/muse-spark-1.3-contributor (Muse Spark 1.3 Contributor)
//   - google/gemini-2.5-flash-lite (Gemini 2.5 Flash-Lite)
