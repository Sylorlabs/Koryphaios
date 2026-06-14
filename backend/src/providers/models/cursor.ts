import type { ModelDef } from '@koryphaios/shared';

// Cursor CLI (cursor-agent) — a full coding agent driven via the headless CLI. It picks the
// underlying model itself ("Auto"), so we expose a single agent entry.
export const CursorModels: ModelDef[] = [
  {
    id: 'cursor-agent',
    name: 'Cursor Agent',
    provider: 'cursor',
    apiModelId: 'auto',
    contextWindow: 200_000,
    maxOutputTokens: 32_000,
    canReason: true,
    // cursor-agent has NO reasoning-effort flag — reasoning is chosen via model variants
    // (e.g. sonnet-4 vs sonnet-4-thinking), so there is no separate level to pick here.
    reasoningLevels: [],
    supportsAttachments: false,
    supportsStreaming: true,
    tier: 'flagship',
  },
];
