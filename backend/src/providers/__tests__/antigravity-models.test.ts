import { describe, expect, it } from 'bun:test';
import { normalizeReasoningLevel } from '@koryphaios/shared';
import { modelDefFromCliName } from '../antigravity';

describe('Antigravity model capabilities', () => {
  it('uses the CLI model name without inventing limits or reasoning tiers', () => {
    const model = modelDefFromCliName('gemini-3.6-flash-high\tGemini 3.6 Flash (High)');
    expect(model.apiModelId).toBe('gemini-3.6-flash-high');
    expect(model.name).toBe('Gemini 3.6 Flash (High)');
    expect(model.contextWindow).toBe(0);
    expect(model.maxOutputTokens).toBe(0);
    expect(model.reasoningLevels).toBeUndefined();
  });

  it('falls back to cliName when no display name is present', () => {
    const model = modelDefFromCliName('gemini-flash');
    expect(model.apiModelId).toBe('gemini-flash');
    expect(model.name).toBe('gemini-flash');
  });

  it('drops stale reasoning values instead of changing the selected model', () => {
    expect(normalizeReasoningLevel('antigravity', 'antigravity-gemini-flash', 'low')).toBeUndefined();
    expect(normalizeReasoningLevel('antigravity', 'antigravity-gemini-flash', 'auto')).toBeUndefined();
  });
});
