// Offline contract tests for the CodeBuddy CLI adapter.
// Deliberately subprocess-free: no live CLI process is started. The catalog
// helpers take pure inputs so a CLI update is picked up by data, not by code.
import { describe, expect, it } from 'bun:test';
import { CodeBuddyProvider, codeBuddySystemPromptArgs, modelsFromProductJson } from '../codebuddy';
import { resolveProductContextBudget } from '../product-context-window';
import type { ProviderConfig } from '@koryphaios/shared';

describe('codebuddy adapter offline contracts', () => {
  it('models come from the CLI product catalog with context from maxInputTokens', () => {
    const models = modelsFromProductJson(
      {
        models: [
          {
            id: 'default-model',
            name: 'Auto',
            maxInputTokens: 176000,
            maxOutputTokens: 24000,
            supportsToolCall: true,
            supportsImages: true,
            isDefault: true,
          },
          { id: 'fast-model', name: 'Fast', maxInputTokens: 200000, supportsReasoning: true },
        ],
      },
      ['low', 'medium', 'high', 'xhigh', 'max', 'ultracode'],
    );
    expect(models.map((m) => m.apiModelId)).toEqual(['default-model', 'fast-model']);
    const def = models.find((m) => m.apiModelId === 'default-model')!;
    expect(def.contextWindow).toBe(176000);
    expect(def.contextVerified).toBe(true);
    expect(def.name.startsWith('Auto')).toBe(true);
    // Reasoning levels are exactly the CLI-data input, never a hardcoded list.
    const fast = models.find((m) => m.apiModelId === 'fast-model')!;
    expect(fast.canReason).toBe(true);
    expect(fast.reasoningLevels).toEqual(['low', 'medium', 'high', 'xhigh', 'max', 'ultracode']);
    expect(def.reasoningLevels).toBeUndefined(); // supportsReasoning absent
  });

  it('never offers two identically named models; the CLI’s own price and id distinguish them', () => {
    // Real shape from the installed CLI's product.json / product.internal.json:
    // reused display names with different raw ids and credit prices.
    const models = modelsFromProductJson(
      {
        models: [
          {
            id: 'deepseek-v4.1-flash',
            name: 'Deepseek-V4.1-Flash',
            credits: 'x0.00 credits',
            maxInputTokens: 1000000,
            maxOutputTokens: 128000,
          },
          {
            id: 'deepseek-v4.1-flash-sg',
            name: 'Deepseek-V4.1-Flash',
            credits: 'x0.03 credits',
            maxInputTokens: 1000000,
            maxOutputTokens: 128000,
          },
          { id: 'hy4-preview', name: 'Hy4 preview', credits: 'x0.29 credits' },
          { id: 'hy4-preview-x', name: 'Hy4 preview', credits: 'x0.29 credits' },
          { id: 'fast-model', name: 'Fast', maxInputTokens: 200000, isDefault: true },
        ],
      },
      ['low', 'high'],
    );
    expect(new Set(models.map((m) => m.name)).size).toBe(models.length);
    expect(models.map((m) => m.name)).toEqual([
      'Deepseek-V4.1-Flash (free)',
      'Deepseek-V4.1-Flash (x0.03 credits)',
      'Hy4 preview (hy4-preview)',
      'Hy4 preview (hy4-preview-x)',
      'Fast (default)',
    ]);
    // Stable ids: a display-name change must not invalidate saved selections.
    expect(models.map((m) => m.id)).toEqual([
      'codebuddy-deepseek-v4.1-flash',
      'codebuddy-deepseek-v4.1-flash-sg',
      'codebuddy-hy4-preview',
      'codebuddy-hy4-preview-x',
      'codebuddy-fast-model',
    ]);
    expect(models.map((m) => m.apiModelId)).toEqual([
      'deepseek-v4.1-flash',
      'deepseek-v4.1-flash-sg',
      'hy4-preview',
      'hy4-preview-x',
      'fast-model',
    ]);
    expect(models[0].creditsLabel).toBe('free');
    expect(models[1].creditsLabel).toBe('x0.03 credits');
  });

  it('shows the CLI’s real context tiers and defaults the budget to the maximum', () => {
    const models = modelsFromProductJson(
      {
        models: [
          {
            id: 'deepseek-v4.1-flash',
            name: 'Deepseek-V4.1-Flash',
            maxInputTokens: 1000000,
            contextWindow: { supportedLengths: [1000000, 300000, 300000], defaultLength: 300000 },
          },
          {
            id: 'no-tiers',
            name: 'No Tiers',
            maxInputTokens: 200000,
            contextWindow: { supportedLengths: [200000, 400000], defaultLength: 200000 },
          },
        ],
      },
      [],
    );
    expect(models[0].contextWindow).toBe(1000000); // hard ceiling, shown as max
    expect(models[0].contextWindowOptions).toEqual([300000, 1000000]);
    expect(models[0].contextWindowVendorDefault).toBe(300000);
    // A tier above the reported ceiling is not a real choice.
    expect(models[1].contextWindowOptions).toBeUndefined();
    expect(models[1].contextWindowVendorDefault).toBeUndefined();

    const tiers = models[0].contextWindowOptions!;
    expect(resolveProductContextBudget(undefined, tiers)).toBe(1000000);
    expect(resolveProductContextBudget(300000, tiers)).toBe(300000);
    expect(resolveProductContextBudget(999999, tiers)).toBe(1000000); // invalid fails closed
    expect(resolveProductContextBudget(tiers[0], [300000])).toBeUndefined(); // no choice
  });

  it('isAvailable requires opt-in or detected CLI login; disabled blocks it', () => {
    const disabled = new CodeBuddyProvider({
      name: 'codebuddy',
      disabled: true,
    } as ProviderConfig);
    expect(disabled.isAvailable()).toBe(false);
  });

  it('uses CodeBuddy’s supported file-backed system prompt flag', () => {
    expect(codeBuddySystemPromptArgs('/private/system-prompt.txt')).toEqual([
      '--system-prompt-file',
      '/private/system-prompt.txt',
    ]);
    expect(codeBuddySystemPromptArgs('/private/system-prompt.txt')).not.toContain(
      '--append-system-prompt-file',
    );
  });
});
