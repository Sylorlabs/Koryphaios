import type { ModelDef } from '@koryphaios/shared';

/**
 * Codex CLI models — accessed via `codex` CLI (ChatGPT/Codex subscription).
 */
export const CodexModels: ModelDef[] = [
  {
    // OpenAI's published Codex model page documents this as a 400k-token
    // window. Subscription plan controls usage allowance, not a different
    // model context window; live CLI metadata still takes precedence.
    id: 'gpt-5.3-codex',
    name: 'GPT-5.3-Codex',
    provider: 'codex',
    apiModelId: 'gpt-5.3-codex',
    contextWindow: 400_000,
    maxOutputTokens: 128_000,
    costPerMInputTokens: 0,
    costPerMOutputTokens: 0,
    canReason: true,
    reasoningLevels: ['low', 'medium', 'high', 'xhigh'],
    supportsAttachments: true,
    supportsStreaming: true,
    tier: 'flagship',
  },
];
