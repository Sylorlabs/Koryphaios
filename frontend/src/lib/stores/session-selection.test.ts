import { describe, expect, test } from 'vitest';
import { resolveSessionSelection } from './session-selection';

describe('resolveSessionSelection', () => {
  const ids = ['a', 'b', 'c'];

  test('restores the stored session when it still exists', () => {
    expect(
      resolveSessionSelection({ storedSessionId: 'b', currentActiveId: '', sessionIds: ids }),
    ).toBe('b');
  });

  test('keeps the active session on unrelated refreshes', () => {
    expect(
      resolveSessionSelection({ storedSessionId: '', currentActiveId: 'c', sessionIds: ids }),
    ).toBe('c');
  });

  test('clears an active session that vanished instead of jumping to another chat', () => {
    expect(
      resolveSessionSelection({ storedSessionId: '', currentActiveId: 'gone', sessionIds: ids }),
    ).toBe('');
  });

  test('prefers the stored session over the active one when both exist', () => {
    expect(
      resolveSessionSelection({ storedSessionId: 'a', currentActiveId: 'c', sessionIds: ids }),
    ).toBe('a');
  });

  test('keeps the active session when the stored one is gone', () => {
    expect(
      resolveSessionSelection({ storedSessionId: 'gone', currentActiveId: 'b', sessionIds: ids }),
    ).toBe('b');
  });

  test('an empty selection stays empty — never auto-activates sessions[0]', () => {
    expect(
      resolveSessionSelection({ storedSessionId: '', currentActiveId: '', sessionIds: ids }),
    ).toBe('');
    expect(
      resolveSessionSelection({ storedSessionId: 'x', currentActiveId: '', sessionIds: [] }),
    ).toBe('');
  });

  test('ignores empty-string stored ids', () => {
    expect(
      resolveSessionSelection({ storedSessionId: '', currentActiveId: 'a', sessionIds: ids }),
    ).toBe('a');
  });
});
