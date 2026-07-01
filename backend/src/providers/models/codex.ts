import type { ModelDef } from '@koryphaios/shared';

/**
 * Codex CLI models — accessed via `codex` CLI (ChatGPT/Codex subscription).
 */
export const CodexModels: ModelDef[] = [
  {
    id: 'gpt-5.5',
    name: 'GPT 5.5',
    provider: 'codex',
    apiModelId: 'gpt-5.5',
    contextWindow: 272_000,
    maxOutputTokens: 128_000,
    costPerMInputTokens: 0,
    costPerMOutputTokens: 0,
    canReason: true,
    reasoningLevels: ['low', 'medium', 'high', 'xhigh'],
    supportsAttachments: true,
    supportsStreaming: true,
    tier: 'flagship',
  },
  {
    id: 'gpt-5.4',
    name: 'GPT 5.4',
    provider: 'codex',
    apiModelId: 'gpt-5.4',
    contextWindow: 272_000,
    maxOutputTokens: 128_000,
    costPerMInputTokens: 0,
    costPerMOutputTokens: 0,
    canReason: true,
    reasoningLevels: ['low', 'medium', 'high', 'xhigh'],
    supportsAttachments: true,
    supportsStreaming: true,
    tier: 'flagship',
  },
  {
    id: 'gpt-5.4-mini',
    name: 'GPT 5.4 Mini',
    provider: 'codex',
    apiModelId: 'gpt-5.4-mini',
    contextWindow: 272_000,
    maxOutputTokens: 64_000,
    costPerMInputTokens: 0,
    costPerMOutputTokens: 0,
    canReason: true,
    reasoningLevels: ['low', 'medium', 'high', 'xhigh'],
    supportsAttachments: true,
    supportsStreaming: true,
    tier: 'fast',
  },
];
