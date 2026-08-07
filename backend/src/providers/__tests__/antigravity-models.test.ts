import { describe, expect, it } from 'bun:test';
import { normalizeReasoningLevel } from '@koryphaios/shared';
import { modelDefFromCliName } from '../antigravity';

describe('Antigravity model capabilities', () => {
  it('uses the CLI model name without inventing limits or reasoning tiers', () => {
    const model = modelDefFromCliName('Provider Returned Model');
    expect(model.apiModelId).toBe('Provider Returned Model');
    expect(model.contextWindow).toBe(0);
    expect(model.maxOutputTokens).toBe(0);
    expect(model.reasoningLevels).toBeUndefined();
  });

  it('drops stale reasoning values instead of changing the selected model', () => {
    expect(normalizeReasoningLevel('antigravity', 'antigravity-gemini-flash', 'low')).toBeUndefined();
    expect(normalizeReasoningLevel('antigravity', 'antigravity-gemini-flash', 'auto')).toBeUndefined();
  });
});
