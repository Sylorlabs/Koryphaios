import { describe, expect, test } from 'bun:test';
import { PromptCacheMaintenanceController } from '../cache-maintenance';
import type { CacheDispatchDiagnostic } from '../cache-fabric';

function warmDiagnostic(): CacheDispatchDiagnostic {
  return {
    state: 'warm-candidate',
    laneKey: 'lane',
    routingKey: 'route',
    laneKind: 'manager',
    reasons: [],
    details: {
      toolsAdded: [],
      toolsRemoved: [],
      toolSchemasChanged: false,
      stableComponentsChanged: [],
    },
    warmCandidateStreak: 2,
    workspaceReuseCount: 3,
    observedAt: 0,
  };
}

function fakeClock() {
  let now = 0;
  let callback: (() => void) | undefined;
  return {
    clock: {
      now: () => now,
      setTimer: (next: () => void) => {
        callback = next;
        return 1 as unknown as ReturnType<typeof setTimeout>;
      },
      clearTimer: () => {
        callback = undefined;
      },
    },
    advance: (ms: number) => {
      now += ms;
    },
    fire: () => {
      const next = callback;
      callback = undefined;
      next?.();
    },
    hasTimer: () => Boolean(callback),
  };
}

describe('prompt cache maintenance', () => {
  test('never executes a negative-value refresh', () => {
    const fake = fakeClock();
    const controller = new PromptCacheMaintenanceController({ clock: fake.clock });
    let refreshes = 0;
    const decision = controller.observe({
      provider: 'anthropic',
      routingKey: 'route',
      slotKey: 'slot',
      stableTokens: 50_000,
      ttlMs: 300_000,
      diagnostic: warmDiagnostic(),
      pricing: { freshInputPerMillion: 2, cacheReadPerMillion: 1.99, cacheWritePerMillion: 20 },
      refresh: async () => {
        refreshes++;
      },
    });
    expect(decision?.keepWarm).toBe(false);
    expect(fake.hasTimer()).toBe(false);
    expect(refreshes).toBe(0);
    expect(controller.getStats().skippedEconomics).toBe(1);
  });

  test('executes an economical hidden refresh before expiry', async () => {
    const fake = fakeClock();
    const controller = new PromptCacheMaintenanceController({ clock: fake.clock });
    let refreshes = 0;
    const decision = controller.observe({
      provider: 'anthropic',
      routingKey: 'route',
      slotKey: 'slot',
      stableTokens: 100_000,
      ttlMs: 300_000,
      diagnostic: warmDiagnostic(),
      pricing: { freshInputPerMillion: 10, cacheReadPerMillion: 1, cacheWritePerMillion: 2 },
      refresh: async () => {
        refreshes++;
      },
    });
    expect(decision?.keepWarm).toBe(true);
    expect(fake.hasTimer()).toBe(true);
    fake.advance(270_000);
    fake.fire();
    await Promise.resolve();
    await Promise.resolve();
    expect(refreshes).toBe(1);
    expect(controller.getStats().refreshes).toBe(1);
    expect(controller.getStats().estimatedSavingsUsd).toBeGreaterThan(0);
  });

  test('rejects a keepalive when the full replay has an expensive uncached tail', () => {
    const fake = fakeClock();
    const controller = new PromptCacheMaintenanceController({ clock: fake.clock });
    const decision = controller.observe({
      provider: 'anthropic',
      routingKey: 'route',
      slotKey: 'slot',
      stableTokens: 100_000,
      refreshInputTokens: 1_000_000,
      refreshCachedTokens: 100_000,
      ttlMs: 300_000,
      diagnostic: warmDiagnostic(),
      pricing: { freshInputPerMillion: 10, cacheReadPerMillion: 1, cacheWritePerMillion: 2 },
      refresh: async () => {},
    });
    expect(decision?.keepWarm).toBe(false);
    expect(decision?.refreshCostUsd).toBeGreaterThan(decision?.expectedSavingsUsd ?? 0);
    expect(fake.hasTimer()).toBe(false);
  });

  test('values a full replay when most rolling history is already cached', () => {
    const fake = fakeClock();
    const controller = new PromptCacheMaintenanceController({ clock: fake.clock });
    const decision = controller.observe({
      provider: 'anthropic',
      routingKey: 'route',
      slotKey: 'slot',
      stableTokens: 100_000,
      refreshInputTokens: 1_000_000,
      refreshCachedTokens: 900_000,
      ttlMs: 300_000,
      diagnostic: warmDiagnostic(),
      pricing: { freshInputPerMillion: 10, cacheReadPerMillion: 1, cacheWritePerMillion: 2 },
      refresh: async () => {},
    });
    expect(decision?.keepWarm).toBe(true);
    expect(decision?.expectedNetSavingsUsd).toBeGreaterThan(0);
    expect(fake.hasTimer()).toBe(true);
  });

  test('stands down after inactivity', async () => {
    const fake = fakeClock();
    const controller = new PromptCacheMaintenanceController({
      clock: fake.clock,
      maxIdleMs: 1_000,
    });
    let refreshes = 0;
    controller.observe({
      provider: 'anthropic',
      routingKey: 'route',
      slotKey: 'slot',
      stableTokens: 100_000,
      ttlMs: 300_000,
      diagnostic: warmDiagnostic(),
      pricing: { freshInputPerMillion: 10, cacheReadPerMillion: 1, cacheWritePerMillion: 2 },
      refresh: async () => {
        refreshes++;
      },
    });
    fake.advance(331_000);
    fake.fire();
    await Promise.resolve();
    expect(refreshes).toBe(0);
    expect(controller.getStats().skippedInactive).toBe(1);
  });

  test('cancels a pending short-TTL refresh when the lane is promoted', () => {
    const fake = fakeClock();
    const controller = new PromptCacheMaintenanceController({ clock: fake.clock });
    controller.observe({
      provider: 'anthropic',
      routingKey: 'route',
      slotKey: 'slot',
      stableTokens: 100_000,
      ttlMs: 300_000,
      diagnostic: warmDiagnostic(),
      pricing: { freshInputPerMillion: 10, cacheReadPerMillion: 1, cacheWritePerMillion: 2 },
      refresh: async () => {},
    });
    expect(fake.hasTimer()).toBe(true);
    controller.standDown('slot', 'route');
    expect(fake.hasTimer()).toBe(false);
  });

  test('bounds unattended keep-alives instead of refreshing forever', async () => {
    const fake = fakeClock();
    const controller = new PromptCacheMaintenanceController({
      clock: fake.clock,
      maxUnattendedRefreshes: 2,
    });
    let refreshes = 0;
    controller.observe({
      provider: 'anthropic',
      routingKey: 'route',
      slotKey: 'slot',
      stableTokens: 100_000,
      ttlMs: 300_000,
      diagnostic: warmDiagnostic(),
      pricing: { freshInputPerMillion: 10, cacheReadPerMillion: 1, cacheWritePerMillion: 20 },
      refresh: async () => {
        refreshes++;
      },
    });
    fake.advance(270_000);
    fake.fire();
    await Promise.resolve();
    await Promise.resolve();
    expect(refreshes).toBe(1);
    expect(fake.hasTimer()).toBe(true);
    fake.advance(270_000);
    fake.fire();
    await Promise.resolve();
    await Promise.resolve();
    expect(refreshes).toBe(2);
    expect(fake.hasTimer()).toBe(false);
  });

  test('prewarms the active session lane on typing and rate-limits repeats', async () => {
    const fake = fakeClock();
    const controller = new PromptCacheMaintenanceController({
      clock: fake.clock,
      prewarmCooldownMs: 30_000,
    });
    let refreshes = 0;
    controller.observe({
      provider: 'openai',
      sessionId: 'session-a',
      routingKey: 'route',
      slotKey: 'slot',
      stableTokens: 100_000,
      ttlMs: 30 * 60_000,
      diagnostic: warmDiagnostic(),
      pricing: { freshInputPerMillion: 10, cacheReadPerMillion: 1, cacheWritePerMillion: 20 },
      refresh: async () => {
        refreshes++;
      },
    });
    expect((await controller.prewarmSession('session-a')).triggered).toBe(true);
    expect(refreshes).toBe(1);
    expect(controller.getStats().prewarms).toBe(1);
    expect((await controller.prewarmSession('session-a')).reason).toBe('cooldown');
    expect(refreshes).toBe(1);
    fake.advance(31_000);
    expect((await controller.prewarmSession('session-a')).triggered).toBe(true);
    expect(refreshes).toBe(2);
  });

  test('lets a sibling tab prewarm an existing workspace route', async () => {
    const fake = fakeClock();
    const controller = new PromptCacheMaintenanceController({ clock: fake.clock });
    let refreshes = 0;
    controller.observe({
      provider: 'openai',
      sessionId: 'session-a',
      routingKey: 'workspace-route',
      slotKey: 'slot-a',
      stableTokens: 100_000,
      ttlMs: 30 * 60_000,
      diagnostic: warmDiagnostic(),
      pricing: { freshInputPerMillion: 10, cacheReadPerMillion: 1, cacheWritePerMillion: 20 },
      refresh: async () => {
        refreshes++;
      },
    });

    expect((await controller.prewarmSession('session-b')).reason).toBe('no-warm-lane');
    expect((await controller.prewarmRoute('workspace-route')).triggered).toBe(true);
    expect(refreshes).toBe(1);
  });

  test('retains the previous model lane for an economical switch-back', async () => {
    const fake = fakeClock();
    const controller = new PromptCacheMaintenanceController({ clock: fake.clock });
    let sourceRefreshes = 0;
    controller.observe({
      provider: 'openai',
      sessionId: 'session-a',
      routingKey: 'source-route',
      slotKey: 'slot-a',
      stableTokens: 100_000,
      ttlMs: 30 * 60_000,
      diagnostic: warmDiagnostic(),
      pricing: { freshInputPerMillion: 10, cacheReadPerMillion: 1, cacheWritePerMillion: 2 },
      refresh: async () => {
        sourceRefreshes++;
      },
    });
    controller.observe({
      provider: 'openai',
      sessionId: 'session-a',
      routingKey: 'destination-route',
      slotKey: 'slot-a',
      stableTokens: 100_000,
      ttlMs: 30 * 60_000,
      diagnostic: { ...warmDiagnostic(), routingKey: 'destination-route' },
      pricing: { freshInputPerMillion: 10, cacheReadPerMillion: 1, cacheWritePerMillion: 2 },
      refresh: async () => {},
    });

    expect((await controller.prewarmRoute('source-route')).triggered).toBe(true);
    expect(sourceRefreshes).toBe(1);
  });

  test('bounds retained model lanes per slot', async () => {
    const fake = fakeClock();
    const controller = new PromptCacheMaintenanceController({
      clock: fake.clock,
      maxRetainedRoutesPerSlot: 2,
    });
    const observe = (routingKey: string) =>
      controller.observe({
        provider: 'openai',
        routingKey,
        slotKey: 'slot-a',
        stableTokens: 100_000,
        ttlMs: 30 * 60_000,
        diagnostic: { ...warmDiagnostic(), routingKey },
        pricing: { freshInputPerMillion: 10, cacheReadPerMillion: 1, cacheWritePerMillion: 2 },
        refresh: async () => {},
      });
    observe('route-a');
    observe('route-b');
    observe('route-c');
    expect((await controller.prewarmRoute('route-a')).reason).toBe('no-warm-route');
    expect((await controller.prewarmRoute('route-b')).triggered).toBe(true);
  });

  test('does not evict a workspace route still retained by a sibling slot', async () => {
    const fake = fakeClock();
    const controller = new PromptCacheMaintenanceController({
      clock: fake.clock,
      maxRetainedRoutesPerSlot: 1,
    });
    let workspaceRefreshes = 0;
    const observe = (slotKey: string, routingKey: string, refresh: () => void) =>
      controller.observe({
        provider: 'openai',
        routingKey,
        slotKey,
        stableTokens: 100_000,
        ttlMs: 30 * 60_000,
        diagnostic: { ...warmDiagnostic(), routingKey },
        pricing: { freshInputPerMillion: 10, cacheReadPerMillion: 1, cacheWritePerMillion: 2 },
        refresh: async () => refresh(),
      });
    observe('slot-a', 'workspace-route', () => {
      workspaceRefreshes++;
    });
    observe('slot-b', 'workspace-route', () => {
      workspaceRefreshes++;
    });
    observe('slot-a', 'new-route', () => {});

    expect((await controller.prewarmRoute('workspace-route')).triggered).toBe(true);
    expect(workspaceRefreshes).toBe(1);
  });

  test('off policy stands down without scheduling a refresh', () => {
    const fake = fakeClock();
    const controller = new PromptCacheMaintenanceController({ clock: fake.clock });
    const decision = controller.observe({
      provider: 'openai',
      routingKey: 'route',
      slotKey: 'slot',
      stableTokens: 100_000,
      ttlMs: 300_000,
      diagnostic: warmDiagnostic(),
      mode: 'off',
      pricing: { freshInputPerMillion: 10, cacheReadPerMillion: 1, cacheWritePerMillion: 2 },
      refresh: async () => {},
    });
    expect(decision?.keepWarm).toBe(false);
    expect(fake.hasTimer()).toBe(false);
    expect(controller.getStats().skippedDisabled).toBe(1);
  });

  test('always policy can arm a lane even when pricing is unavailable', () => {
    const fake = fakeClock();
    const controller = new PromptCacheMaintenanceController({ clock: fake.clock });
    const decision = controller.observe({
      provider: 'anthropic',
      routingKey: 'route',
      slotKey: 'slot',
      stableTokens: 100_000,
      ttlMs: 300_000,
      diagnostic: warmDiagnostic(),
      mode: 'always',
      pricing: null,
      refresh: async () => {},
    });
    expect(decision?.keepWarm).toBe(true);
    expect(fake.hasTimer()).toBe(true);
    expect(controller.getStats().forcedSchedules).toBe(1);
  });
});
