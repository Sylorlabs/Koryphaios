import type { ModelDef } from '@koryphaios/shared';

// Jules runs Gemini models in Google's cloud VMs. These are virtual selectors —
// the Jules API does not expose per-request model routing in v1alpha.
export const JulesModels: ModelDef[] = [
  {
    id: 'jules-gemini-3-flash',
    name: 'Jules · Gemini 3 Flash (cloud)',
    provider: 'jules',
    apiModelId: 'gemini-3-flash',
    contextWindow: 1_048_576,
    maxOutputTokens: 65_536,
    canReason: false,
    supportsAttachments: false,
    supportsStreaming: true,
    tier: 'fast',
  },
  {
    id: 'jules-gemini-3.1-pro',
    name: 'Jules · Gemini 3.1 Pro (cloud)',
    provider: 'jules',
    apiModelId: 'gemini-3.1-pro',
    contextWindow: 2_097_152,
    maxOutputTokens: 65_536,
    canReason: true,
    supportsAttachments: false,
    supportsStreaming: true,
    tier: 'reasoning',
  },
];