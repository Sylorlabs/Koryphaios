import type { ModelDef } from '@koryphaios/shared';

// Grok Build subscription (CLI harness) fallback catalog until `grok models` refresh succeeds.
// Distinct from the `xai` API provider.
// Live model lists come from `grok models`; these entries are used only until/unless the CLI
// refresh succeeds. apiModelId is the exact value for `grok --model`.
export const GrokModels: ModelDef[] = [
  {
    id: 'grok-composer-2.5-fast',
    name: 'Grok Composer 2.5 Fast',
    provider: 'grok',
    apiModelId: 'grok-composer-2.5-fast',
    contextWindow: 256_000,
    maxOutputTokens: 50_000,
    canReason: true,
    supportsAttachments: false,
    supportsStreaming: true,
    tier: 'fast',
  },
  {
    id: 'grok-build',
    name: 'Grok Build',
    provider: 'grok',
    apiModelId: 'grok-build',
    contextWindow: 256_000,
    maxOutputTokens: 50_000,
    canReason: true,
    supportsAttachments: false,
    supportsStreaming: true,
    tier: 'flagship',
  },
];
