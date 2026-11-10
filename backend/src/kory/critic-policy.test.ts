import { expect, test, describe } from 'bun:test';
import { decideCriticReview, isConsequentialCriticTool } from './critic-policy';

describe('Critic Auto policy', () => {
  test('Auto honors a declined review even for consequential work', () => {
    for (const evidence of [
      { changedFiles: ['src/cache.ts'] }, { delegated: true }, { failedTool: true },
      { consequentialToolActivity: true }, { nativeToolActivity: true },
      { purpose: 'worker' as const }, { purpose: 'goal' as const }, { purpose: 'image' as const },
    ]) {
      expect(decideCriticReview('auto', { task: 'Implement caching', ...evidence }).review).toBe(false);
    }
  });

  test('manager decides whether an ordinary response warrants review', () => {
    expect(decideCriticReview('auto', { task: 'test', response: 'I am ready.' }).review).toBe(false);
    expect(decideCriticReview('auto', { task: 'Please verify the migration' }).review).toBe(false);
    expect(decideCriticReview('auto', {
      task: 'Explain caching', managerRequestedReview: true, managerReviewReason: 'The design has a data-loss edge case.',
    })).toEqual({ review: true, reason: 'The design has a data-loss edge case.' });
  });

  test('default manager review reason is safe when missing or blank', () => {
    expect(decideCriticReview('auto', { task: 'Explain caching', managerRequestedReview: true }).reason)
      .toBe('The finishing agent requested a Critic review.');
  });

  test('skips ordinary responses when the manager did not ask for review', () => {
    const decision = decideCriticReview('auto', { task: 'Explain caching', response: 'A cache stores results.' });
    expect(decision.review).toBe(false);
    expect(decision.reason).toContain('Agent declined');
  });

  test('always and off remain explicit overrides', () => {
    expect(decideCriticReview('always', { task: 'Explain caching' }).review).toBe(true);
    expect(decideCriticReview('off', { task: 'Implement a feature', changedFiles: ['src/a.ts'] }).review).toBe(false);
  });

  test('treats unknown tools as consequential', () => {
    expect(isConsequentialCriticTool('read_file')).toBe(false);
    expect(isConsequentialCriticTool('bash')).toBe(true);
    expect(isConsequentialCriticTool('kory__write_file')).toBe(true);
  });
});
