import type { ModelDef } from '@koryphaios/shared';

// Grok Build subscription (CLI harness) models. Distinct from the `xai` API provider:
// these run through the `grok` CLI (SuperGrok / X Premium+), so the id is namespaced to
// avoid colliding with xai's `grok-build-0.1` API model. apiModelId is the CLI --model value.
export const GrokModels: ModelDef[] = [
  {
    id: 'grok-build',
    name: 'Grok Build',
    provider: 'grok',
    apiModelId: 'grok-build-0.1',
    contextWindow: 256_000,
    maxOutputTokens: 50_000,
    canReason: true,
    supportsAttachments: false, // CLI harness is text-only (like Claude Code)
    supportsStreaming: true,
    tier: 'flagship',
  },
];
