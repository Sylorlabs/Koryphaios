import type { ModelDef } from '@koryphaios/shared';

// Antigravity CLI harness models. These run through the `agy` CLI (Google subscription),
// not the Gemini REST API. The apiModelId is the exact string passed to `agy --model`.
export const AntigravityModels: ModelDef[] = [
  {
    id: 'antigravity-gemini-flash',
    name: 'Gemini 3.5 Flash',
    provider: 'antigravity',
    apiModelId: 'Gemini 3.5 Flash (Medium)',
    contextWindow: 1_048_576,
    maxOutputTokens: 65_536,
    canReason: false,
    supportsAttachments: false,
    supportsStreaming: true,
    tier: 'fast',
  },
  {
    id: 'antigravity-gemini-flash-high',
    name: 'Gemini 3.5 Flash (High)',
    provider: 'antigravity',
    apiModelId: 'Gemini 3.5 Flash (High)',
    contextWindow: 1_048_576,
    maxOutputTokens: 65_536,
    canReason: true,
    supportsAttachments: false,
    supportsStreaming: true,
    tier: 'reasoning',
  },
  {
    id: 'antigravity-gemini-pro',
    name: 'Gemini 3.1 Pro',
    provider: 'antigravity',
    apiModelId: 'Gemini 3.1 Pro (High)',
    contextWindow: 2_097_152,
    maxOutputTokens: 65_536,
    canReason: true,
    supportsAttachments: false,
    supportsStreaming: true,
    tier: 'flagship',
  },
];
