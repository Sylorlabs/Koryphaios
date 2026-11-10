import { describe, expect, test } from 'bun:test';
import { SessionRuntime, SessionRuntimeRegistry } from './SessionRuntime';

describe('SessionRuntimeRegistry', () => {
  test('get creates a runtime once and returns the same object afterwards', () => {
    const registry = new SessionRuntimeRegistry();
    const first = registry.get('s1');
    expect(first).toBeInstanceOf(SessionRuntime);
    expect(registry.get('s1')).toBe(first);
    expect(registry.has('s1')).toBe(true);
  });

  test('peek never creates a runtime', () => {
    const registry = new SessionRuntimeRegistry();
    expect(registry.peek('missing')).toBeUndefined();
    expect(registry.has('missing')).toBe(false);
    expect(registry.sessionIds()).toEqual([]);
    const created = registry.get('s1');
    expect(registry.peek('s1')).toBe(created);
  });

  test('sessionIds lists only sessions with a runtime', () => {
    const registry = new SessionRuntimeRegistry();
    registry.get('a');
    registry.get('b');
    registry.peek('c');
    expect(registry.sessionIds().sort()).toEqual(['a', 'b']);
  });

  test('dispose then peek is undefined and a later get starts from a clean runtime', () => {
    const registry = new SessionRuntimeRegistry();
    const before = registry.get('s1');
    before.runClaimed = true;
    before.contextWindowOverride = 8192;
    registry.dispose('s1');
    expect(registry.peek('s1')).toBeUndefined();
    expect(registry.has('s1')).toBe(false);
    const after = registry.get('s1');
    expect(after).not.toBe(before);
    expect(after.runClaimed).toBe(false);
    expect(after.contextWindowOverride).toBeUndefined();
  });

  test('dispose of an unknown session is a no-op', () => {
    const registry = new SessionRuntimeRegistry();
    expect(() => registry.dispose('nobody')).not.toThrow();
  });
});

describe('SessionRuntime.dispose', () => {
  test('clears the heartbeat interval so it never fires again', async () => {
    const runtime = new SessionRuntime();
    let ticks = 0;
    runtime.heartbeat = setInterval(() => {
      ticks++;
    }, 5);
    await new Promise((resolve) => setTimeout(resolve, 20));
    const ticksBeforeDispose = ticks;
    expect(ticksBeforeDispose).toBeGreaterThan(0);
    runtime.dispose();
    expect(runtime.heartbeat).toBeUndefined();
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(ticks).toBe(ticksBeforeDispose);
  });

  test('clears pending usage-retry timers', async () => {
    const runtime = new SessionRuntime();
    let fired = false;
    runtime.usageRetryTimers.add(
      setTimeout(() => {
        fired = true;
      }, 5),
    );
    runtime.dispose();
    expect(runtime.usageRetryTimers.size).toBe(0);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(fired).toBe(false);
  });

  test('aborts nothing: controllers owned by an operation are left as they are', () => {
    const runtime = new SessionRuntime();
    const run = new AbortController();
    const compaction = new AbortController();
    runtime.abort = run;
    runtime.compacting = compaction;
    runtime.dispose();
    expect(run.signal.aborted).toBe(false);
    expect(compaction.signal.aborted).toBe(false);
    expect(runtime.abort).toBeUndefined();
    expect(runtime.compacting).toBeUndefined();
  });
});
