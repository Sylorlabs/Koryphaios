import {
  evaluateCacheWarmthEconomics,
  type CacheDispatchDiagnostic,
  type CacheWarmthDecision,
} from './cache-fabric';

export interface CacheMaintenancePricing {
  freshInputPerMillion: number;
  cacheReadPerMillion?: number;
  cacheWritePerMillion?: number;
}

export interface CacheMaintenanceObservation {
  provider: string;
  sessionId?: string;
  routingKey: string;
  slotKey: string;
  stableTokens: number;
  /** Estimated total input tokens replayed by refresh(). */
  refreshInputTokens?: number;
  /** Portion of refreshInputTokens expected to be served as cache reads. */
  refreshCachedTokens?: number;
  ttlMs: number;
  diagnostic: CacheDispatchDiagnostic;
  pricing: CacheMaintenancePricing | null;
  mode?: 'economic' | 'always' | 'off';
  refresh: () => Promise<void>;
  observedAt?: number;
}

export interface CacheMaintenanceStats {
  observations: number;
  scheduled: number;
  refreshes: number;
  skippedEconomics: number;
  skippedInactive: number;
  skippedUnsupported: number;
  skippedUnknownPricing: number;
  skippedDisabled: number;
  forcedSchedules: number;
  cancelledIdentityChanges: number;
  failures: number;
  prewarms: number;
  prewarmSkips: number;
  estimatedSavingsUsd: number;
}

interface PendingMaintenance {
  provider: string;
  sessionId?: string;
  slotKey: string;
  routingKey: string;
  observedAt: number;
  ttlMs: number;
  refreshCount: number;
  timer: ReturnType<typeof setTimeout>;
  refresh: () => Promise<void>;
  decision: CacheWarmthDecision;
}

interface CacheMaintenanceClock {
  now: () => number;
  setTimer: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>;
  clearTimer: (timer: ReturnType<typeof setTimeout>) => void;
}

const defaultClock: CacheMaintenanceClock = {
  now: () => Date.now(),
  setTimer: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimer: (timer) => clearTimeout(timer),
};

function reuseProbability(diagnostic: CacheDispatchDiagnostic): number {
  if (diagnostic.state === 'cold') return 0;
  return Math.min(
    0.95,
    0.45 +
      diagnostic.warmCandidateStreak * 0.12 +
      Math.min(5, diagnostic.workspaceReuseCount) * 0.06,
  );
}

function reuseCount(diagnostic: CacheDispatchDiagnostic): number {
  if (diagnostic.state === 'cold') return 1;
  return Math.min(6, diagnostic.warmCandidateStreak + Math.max(1, diagnostic.workspaceReuseCount));
}

export class PromptCacheMaintenanceController {
  private readonly pendingByRoute = new Map<string, PendingMaintenance>();
  private readonly routeBySlot = new Map<string, string>();
  private readonly routeBySession = new Map<string, string>();
  /** Small LRU portfolio per conversation/role slot. A model switch must not
   * destroy the previous provider-native lane: switch-back can reuse it while
   * its provider TTL is still alive. */
  private readonly retainedRoutesBySlot = new Map<string, string[]>();
  private readonly lastPrewarmAtByRoute = new Map<string, number>();
  private readonly clock: CacheMaintenanceClock;
  private readonly maxIdleMs: number;
  private readonly maxUnattendedRefreshes: number;
  private readonly prewarmCooldownMs: number;
  private readonly maxRetainedRoutesPerSlot: number;
  private stats: CacheMaintenanceStats = this.emptyStats();

  constructor(options?: {
    clock?: CacheMaintenanceClock;
    maxIdleMs?: number;
    maxUnattendedRefreshes?: number;
    prewarmCooldownMs?: number;
    maxRetainedRoutesPerSlot?: number;
  }) {
    this.clock = options?.clock ?? defaultClock;
    this.maxIdleMs = options?.maxIdleMs ?? 10 * 60_000;
    this.maxUnattendedRefreshes = Math.max(0, options?.maxUnattendedRefreshes ?? 2);
    this.prewarmCooldownMs = Math.max(0, options?.prewarmCooldownMs ?? 30_000);
    this.maxRetainedRoutesPerSlot = Math.max(1, options?.maxRetainedRoutesPerSlot ?? 4);
  }

  private retainRoute(slotKey: string, routingKey: string): void {
    const current = this.retainedRoutesBySlot.get(slotKey) ?? [];
    const next = [...current.filter((route) => route !== routingKey), routingKey];
    const evictedRoutes: string[] = [];
    while (next.length > this.maxRetainedRoutesPerSlot) {
      const evicted = next.shift();
      if (evicted) evictedRoutes.push(evicted);
    }
    this.retainedRoutesBySlot.set(slotKey, next);
    for (const evicted of evictedRoutes) {
      if (!this.isRouteRetainedAnywhere(evicted)) {
        this.cancel(evicted);
        this.stats.cancelledIdentityChanges++;
      }
    }
  }

  private isRouteRetainedAnywhere(routingKey: string): boolean {
    for (const routes of this.retainedRoutesBySlot.values()) {
      if (routes.includes(routingKey)) return true;
    }
    return false;
  }

  private forgetRetainedRoute(slotKey: string, routingKey: string): void {
    const current = this.retainedRoutesBySlot.get(slotKey);
    if (!current) return;
    const next = current.filter((route) => route !== routingKey);
    if (next.length === 0) this.retainedRoutesBySlot.delete(slotKey);
    else this.retainedRoutesBySlot.set(slotKey, next);
  }

  observe(input: CacheMaintenanceObservation): CacheWarmthDecision | null {
    this.stats.observations++;
    const now = input.observedAt ?? this.clock.now();
    this.routeBySlot.set(input.slotKey, input.routingKey);
    this.retainRoute(input.slotKey, input.routingKey);
    if (input.sessionId) this.routeBySession.set(input.sessionId, input.routingKey);
    if (input.provider !== 'anthropic' && input.provider !== 'openai') {
      this.stats.skippedUnsupported++;
      return null;
    }
    if (input.mode === 'off') {
      this.forgetRetainedRoute(input.slotKey, input.routingKey);
      if (!this.isRouteRetainedAnywhere(input.routingKey)) this.cancel(input.routingKey);
      this.stats.skippedDisabled++;
      return {
        keepWarm: false,
        expectedSavingsUsd: 0,
        refreshCostUsd: 0,
        expectedNetSavingsUsd: 0,
      };
    }
    const pricing = input.pricing;
    if (
      input.mode !== 'always' &&
      (!pricing ||
        pricing.cacheReadPerMillion === undefined ||
        pricing.cacheWritePerMillion === undefined)
    ) {
      this.stats.skippedUnknownPricing++;
      return null;
    }
    const refreshInputTokens = Math.max(
      input.stableTokens,
      input.refreshInputTokens ?? input.stableTokens,
    );
    const refreshCachedTokens = Math.min(
      refreshInputTokens,
      Math.max(0, input.refreshCachedTokens ?? input.stableTokens),
    );
    const refreshFreshTokens = Math.max(0, refreshInputTokens - refreshCachedTokens);
    // A full-lane keepalive preserves everything already cached in the replay,
    // not just the static prefix. Count those tokens when estimating the value
    // of the next likely reuse, while charging uncached tail tokens at fresh
    // input price for the maintenance request itself.
    const reusableTokens = Math.max(input.stableTokens, refreshCachedTokens);
    const decision =
      pricing &&
      pricing.cacheReadPerMillion !== undefined &&
      pricing.cacheWritePerMillion !== undefined
        ? evaluateCacheWarmthEconomics({
            stableTokens: reusableTokens,
            freshInputPerMillion: pricing.freshInputPerMillion,
            cacheReadPerMillion: pricing.cacheReadPerMillion,
            cacheWritePerMillion: pricing.cacheWritePerMillion,
            refreshCachedTokens,
            refreshFreshTokens,
            expectedReuseProbability: reuseProbability(input.diagnostic),
            expectedReuseCount: reuseCount(input.diagnostic),
            refreshOverheadTokens: 1,
            minimumNetSavingsUsd: 0.000_001,
          })
        : {
            keepWarm: false,
            expectedSavingsUsd: 0,
            refreshCostUsd: 0,
            expectedNetSavingsUsd: 0,
          };
    if (input.mode === 'always') {
      decision.keepWarm = true;
      this.stats.forcedSchedules++;
    }
    if (!decision.keepWarm) {
      this.stats.skippedEconomics++;
      this.cancel(input.routingKey);
      return decision;
    }
    this.cancel(input.routingKey);
    const leadMs = Math.min(30_000, Math.max(5_000, Math.floor(input.ttlMs * 0.1)));
    const pending: PendingMaintenance = {
      provider: input.provider,
      sessionId: input.sessionId,
      slotKey: input.slotKey,
      routingKey: input.routingKey,
      observedAt: now,
      ttlMs: input.ttlMs,
      refreshCount: 0,
      refresh: input.refresh,
      decision,
      timer: undefined as unknown as ReturnType<typeof setTimeout>,
    };
    pending.timer = this.clock.setTimer(
      () => void this.run(pending),
      Math.max(1_000, input.ttlMs - leadMs),
    );
    this.pendingByRoute.set(input.routingKey, pending);
    this.stats.scheduled++;
    return decision;
  }

  private async run(pending: PendingMaintenance): Promise<void> {
    if (this.pendingByRoute.get(pending.routingKey) !== pending) return;
    this.pendingByRoute.delete(pending.routingKey);
    if (!this.isRouteRetainedAnywhere(pending.routingKey)) return;
    const idleLimit = Math.max(this.maxIdleMs, Math.ceil(pending.ttlMs * 1.1));
    if (this.clock.now() - pending.observedAt > idleLimit) {
      this.stats.skippedInactive++;
      return;
    }
    try {
      await pending.refresh();
      this.stats.refreshes++;
      this.stats.estimatedSavingsUsd += Math.max(0, pending.decision.expectedNetSavingsUsd);
      pending.refreshCount++;
      if (pending.refreshCount >= this.maxUnattendedRefreshes) return;
      const leadMs = Math.min(30_000, Math.max(5_000, Math.floor(pending.ttlMs * 0.1)));
      pending.timer = this.clock.setTimer(
        () => void this.run(pending),
        Math.max(1_000, pending.ttlMs - leadMs),
      );
      this.pendingByRoute.set(pending.routingKey, pending);
    } catch {
      this.stats.failures++;
    }
  }

  async prewarmSession(sessionId: string): Promise<{ triggered: boolean; reason?: string }> {
    const routingKey = this.routeBySession.get(sessionId);
    if (!routingKey) {
      this.stats.prewarmSkips++;
      return { triggered: false, reason: 'no-warm-lane' };
    }
    return this.prewarmRoute(routingKey);
  }

  /** Refresh an already-observed provider route regardless of which chat first
   * warmed it. Provider routing is workspace-wide, so a sibling tab can reuse
   * the existing lane without paying for a separate cold prewarm. */
  async prewarmRoute(routingKey: string): Promise<{ triggered: boolean; reason?: string }> {
    const pending = this.pendingByRoute.get(routingKey);
    if (!pending) {
      this.stats.prewarmSkips++;
      return { triggered: false, reason: 'no-warm-route' };
    }
    if (!this.isRouteRetainedAnywhere(pending.routingKey)) {
      this.stats.prewarmSkips++;
      return { triggered: false, reason: 'stale-lane' };
    }
    const now = this.clock.now();
    const lastPrewarmAt = this.lastPrewarmAtByRoute.get(routingKey);
    if (lastPrewarmAt !== undefined && now - lastPrewarmAt < this.prewarmCooldownMs) {
      this.stats.prewarmSkips++;
      return { triggered: false, reason: 'cooldown' };
    }
    this.cancel(routingKey);
    try {
      await pending.refresh();
      this.stats.prewarms++;
      this.lastPrewarmAtByRoute.set(routingKey, now);
      pending.refreshCount = 0;
      pending.observedAt = now;
      const leadMs = Math.min(30_000, Math.max(5_000, Math.floor(pending.ttlMs * 0.1)));
      pending.timer = this.clock.setTimer(
        () => void this.run(pending),
        Math.max(1_000, pending.ttlMs - leadMs),
      );
      this.pendingByRoute.set(routingKey, pending);
      return { triggered: true };
    } catch {
      this.stats.failures++;
      return { triggered: false, reason: 'refresh-failed' };
    }
  }

  private cancel(routingKey: string): void {
    const pending = this.pendingByRoute.get(routingKey);
    if (!pending) return;
    this.clock.clearTimer(pending.timer);
    this.pendingByRoute.delete(routingKey);
  }

  getStats(): CacheMaintenanceStats {
    return { ...this.stats };
  }

  recordExternalPrewarm(): void {
    this.stats.prewarms++;
  }

  standDown(slotKey: string, routingKey: string): void {
    this.forgetRetainedRoute(slotKey, routingKey);
    if (!this.isRouteRetainedAnywhere(routingKey)) this.cancel(routingKey);
    if (this.routeBySlot.get(slotKey) === routingKey) this.routeBySlot.delete(slotKey);
  }

  clear(): void {
    for (const pending of this.pendingByRoute.values()) this.clock.clearTimer(pending.timer);
    this.pendingByRoute.clear();
    this.routeBySlot.clear();
    this.routeBySession.clear();
    this.retainedRoutesBySlot.clear();
    this.lastPrewarmAtByRoute.clear();
    this.stats = this.emptyStats();
  }

  private emptyStats(): CacheMaintenanceStats {
    return {
      observations: 0,
      scheduled: 0,
      refreshes: 0,
      skippedEconomics: 0,
      skippedInactive: 0,
      skippedUnsupported: 0,
      skippedUnknownPricing: 0,
      skippedDisabled: 0,
      forcedSchedules: 0,
      cancelledIdentityChanges: 0,
      failures: 0,
      prewarms: 0,
      prewarmSkips: 0,
      estimatedSavingsUsd: 0,
    };
  }
}

export const promptCacheMaintenance = new PromptCacheMaintenanceController();
