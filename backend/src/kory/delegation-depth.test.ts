import { describe, expect, test } from 'bun:test';
import {
  MAX_DELEGATION_DEPTH,
  canDelegateAtDepth,
  currentDelegationDepth,
  runAtDelegationDepth,
} from './delegation-depth';

describe('delegation depth', () => {
  test('the manager is depth 0 and workers may delegate one level below the limit', () => {
    expect(currentDelegationDepth()).toBe(0);
    expect(MAX_DELEGATION_DEPTH).toBe(2);
    expect(canDelegateAtDepth(0)).toBe(true);
    expect(canDelegateAtDepth(1)).toBe(true);
    expect(canDelegateAtDepth(2)).toBe(false);
  });

  test('depth follows the async context through awaits and nested runs', async () => {
    await runAtDelegationDepth(1, async () => {
      await Promise.resolve();
      expect(currentDelegationDepth()).toBe(1);
      await runAtDelegationDepth(2, async () => {
        await new Promise((resolve) => setTimeout(resolve, 1));
        expect(currentDelegationDepth()).toBe(2);
        expect(canDelegateAtDepth(currentDelegationDepth())).toBe(false);
      });
      expect(currentDelegationDepth()).toBe(1);
    });
    expect(currentDelegationDepth()).toBe(0);
  });

  test('a detached callback re-entered at depth 0 does not inherit a worker depth', async () => {
    let inner = -1;
    await runAtDelegationDepth(1, async () => {
      await runAtDelegationDepth(0, async () => {
        inner = currentDelegationDepth();
      });
    });
    expect(inner).toBe(0);
  });
});
