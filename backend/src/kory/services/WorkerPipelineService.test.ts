import { describe, expect, test } from 'bun:test';
import { resolveGateStrictness } from './WorkerPipelineService';

describe('resolveGateStrictness', () => {
  test('cannot disable completion-blocking review for repository mutation tasks', () => {
    for (const kind of ['bug', 'mechanical-edit', 'refactor', 'feature', 'ui', 'security-infra'] as const) {
      expect(resolveGateStrictness(kind, 'off')).toBe('strict');
      expect(resolveGateStrictness(kind, 'advisory')).toBe('strict');
    }
  });

  test('preserves user review policy for non-mutating answer and research tasks', () => {
    expect(resolveGateStrictness('question', 'off')).toBe('off');
    expect(resolveGateStrictness('research-docs', 'advisory')).toBe('advisory');
  });
});
