import type { ModelDef } from '@koryphaios/shared';

// Grok Build subscription (CLI harness) fallback catalog until `grok models` refresh succeeds.
// Distinct from the `xai` API provider.
// Live model lists come from `grok models`; these entries are used only until/unless the CLI
// refresh succeeds. apiModelId is the exact value for `grok --model`.
// Values match the CLI's own metadata (~/.grok/models_cache.json, 2026-07):
// neither model supports --reasoning-effort, grok-build is 512k context,
// composer-2.5-fast is 200k. The live refresh re-verifies these every run.
export const GrokModels: ModelDef[] = [
  {
    id: 'grok-composer-2.5-fast',
    name: 'Composer 2.5 Fast',
    provider: 'grok',
    apiModelId: 'grok-composer-2.5-fast',
    contextWindow: 200_000,
    maxOutputTokens: 50_000,
    canReason: false,
    supportsAttachments: false,
    supportsStreaming: true,
    tier: 'fast',
  },
  {
    id: 'grok-build',
    name: 'Grok Build',
    provider: 'grok',
    apiModelId: 'grok-build',
    contextWindow: 512_000,
    maxOutputTokens: 50_000,
    canReason: false,
    supportsAttachments: false,
    supportsStreaming: true,
    tier: 'flagship',
  },
];
