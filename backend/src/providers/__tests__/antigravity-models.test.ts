import { describe, expect, it } from 'bun:test';
import { normalizeReasoningLevel } from '@koryphaios/shared';
import { AntigravityModels } from '../models/antigravity';

describe('Antigravity model capabilities', () => {
  it('exposes effort variants only as models, never as reasoning tiers', () => {
    expect(AntigravityModels.length).toBeGreaterThan(0);
    for (const model of AntigravityModels) {
      expect(model.reasoningLevels).toEqual([]);
    }
  });

  it('drops stale reasoning values instead of changing the selected model', () => {
    expect(normalizeReasoningLevel('antigravity', 'antigravity-gemini-flash', 'low')).toBeUndefined();
    expect(normalizeReasoningLevel('antigravity', 'antigravity-gemini-flash', 'auto')).toBeUndefined();
  });
});
