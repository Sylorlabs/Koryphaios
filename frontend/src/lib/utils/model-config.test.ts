import { describe, expect, it } from 'vitest';
import type { ProviderInfo } from '@koryphaios/shared';
import { getModelConfigurationWarning, isEnabledModelSelection } from './model-config';

const provider = (overrides: Partial<ProviderInfo> = {}): ProviderInfo => ({
  name: 'devin',
  enabled: true,
  authenticated: true,
  models: ['glm-5-2'],
  allAvailableModels: [],
  selectedModels: ['glm-5-2'],
  hideModelSelector: false,
  authMode: 'auth_only',
  supportsApiKey: false,
  supportsAuthToken: true,
  requiresBaseUrl: false,
  ...overrides,
});

describe('manual model selection', () => {
  it('accepts only a model currently enabled by an authenticated provider', () => {
    expect(isEnabledModelSelection([provider()], 'devin:glm-5-2')).toBe(true);
    expect(isEnabledModelSelection([provider()], 'devin:missing-model')).toBe(false);
    expect(isEnabledModelSelection([provider({ authenticated: false })], 'devin:glm-5-2')).toBe(false);
  });

  it('explains a stale selection without suggesting Auto', () => {
    expect(getModelConfigurationWarning([provider()], 'devin:missing-model')).toBe(
      'missing-model is no longer available for Devin. Select another model in the composer.',
    );
  });
});
