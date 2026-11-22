/**
 * Adaptive background refresh for provider model catalogs.
 *
 * New models ship constantly, and a catalog that is only read on demand can sit
 * stale for hours. This scheduler keeps enabled providers' catalogs warm without
 * spending resources the user is not using:
 *
 *   - Cost tiers. Refreshing every provider on one cadence is wrong because
 *     discovery is not equally cheap. A keyless catalog GET or a localhost
 *     endpoint is nearly free; an authenticated `/models` call is metered;
 *     discovering a CLI-backed provider spawns a subprocess and is the most
 *     expensive of all. Cheap sources are polled every
 *     `CHEAP_INTERVAL_MS` (10 minutes), metered ones every
 *     `HOURLY_INTERVAL_MS` (1 hour), and CLI-backed ones only while the user is
 *     actively working.
 *   - Idle adaptation. A provider nobody is using does not need a warm catalog,
 *     so every interval is multiplied by `IDLE_BACKOFF_FACTOR` once no catalog
 *     activity has been recorded for `IDLE_THRESHOLD_MS`, and CLI-backed
 *     providers are skipped entirely while idle.
 *   - Activity catch-up. `noteActivity()` is called from the places a user
 *     touches providers (a real completion, a provider-status read). It resets
 *     the idle multiplier and pulls overdue providers forward, so the first
 *     catalog read after a break is fresh instead of waiting out a backed-off
 *     interval.
 *   - Failure backoff. Adapters deliberately swallow discovery errors and
 *     negative-cache them, so a dead endpoint cannot report a rejection. A
 *     refresh that leaves an available provider with no models is treated as a
 *     soft failure and exponentially backed off, so an unreachable provider
 *     costs one attempt per backoff step rather than one per tick.
 *   - Bounded work. One timer, chained with `setTimeout` so a slow refresh can
 *     never overlap the next tick, jittered so many clients do not hit the same
 *     provider on the same second, and capped per tick so a large provider
 *     configuration cannot burst.
 *
 * The scheduler never authors models. It only asks providers to re-run their
 * own discovery through `refreshModels`, so the "no bundled catalog" and
 * "metadata-only fallback" rules in `models/` and `model-list-cache.ts` hold
 * exactly as they do for a manual refresh.
 */

import type { ProviderName } from '@koryphaios/shared';
import type { Provider } from './types';
import type { ProviderRegistry } from './registry';
import { providerLog } from '../logger';
import { forceModelsDevRefresh } from './models-dev';
import { refreshOpenRouterPricingCatalog } from './openrouter-pricing';

// ─── Cadence tiers ───────────────────────────────────────────────────────────

/**
 * How expensive it is to re-discover one provider's models.
 *
 * `cheap`   — keyless catalog endpoint or localhost. No credential, no quota,
 *             no subprocess: poll often.
 * `hourly`  — authenticated `/models` call, or a large shared registry that
 *             every provider enriches from. Metered or bandwidth-bound: once an
 *             hour is often enough to notice a new model.
 * `cli`     — discovery spawns the provider's own CLI or app-server. The most
 *             expensive kind, so it runs on the hourly cadence *and* only while
 *             the user is actually working.
 */
export type CatalogRefreshTier = 'cheap' | 'hourly' | 'cli';

/** 10 minutes for cheap, keyless/local catalog sources. */
export const CHEAP_INTERVAL_MS = 10 * 60_000;
/** 1 hour for metered catalog calls and large shared registries. */
export const HOURLY_INTERVAL_MS = 60 * 60_000;

/** Subprocess-backed adapters. Discovery starts the provider's own CLI. */
const CLI_BACKED_PROVIDERS: ReadonlySet<ProviderName> = new Set([
  'claude',
  'codex',
  'codex-auth',
  'grok',
  'antigravity',
  'cursor',
  'devin',
  'omnirush',
  'opencode',
]);

/** Keyless public catalog endpoints, localhost servers, and cheap authenticated
 * read-only catalogs (no subprocess or generation). */
const CHEAP_CATALOG_PROVIDERS: ReadonlySet<ProviderName> = new Set([
  // Both buddy adapters discover their catalog by reading the installed
  // product*.json (plus the CLI bundle's effort enum) — plain file reads, no
  // subprocess. Sitting in the cli tier meant a model the vendor shipped
  // today (e.g. hy3) could take an hour to appear, for a refresh that costs
  // one readFileSync.
  'codebuddy',
  'workbuddy-desktop',
  'beam',
  'cline',
  // One authenticated read-only GET each, and the only source of these
  // providers' limits/pricing, so they are polled on the cheap cadence.
  'hundredmillionseek',
  'numes',
  // Coarena's /models is a public read-only GET and the only source of its
  // context/output limits, modalities and reasoning ladder.
  'coarena',
  // CrowLLM's /v1/models is a public read-only GET and the catalog is the only
  // source of its exact ids, publishers and :free / -thinking variants.
  'crowllm',
  // One authenticated read-only GET, and the only source of Token Factory's
  // platform-chosen catalog and its limits.
  'radeon',
  // Runcrate's /v1/models is a public read-only GET and the only source of its
  // per-model limits, modalities and USD prices.
  'runcrate',
  // One authenticated read-only GET, and the only source of Token Harbor's
  // context limits, USD prices and reasoning ladders.
  'tokenharbor',
  'github-models',
  'local',
  'ollama',
  'llamacpp',
  'lmstudio',
  'freebuff',
]);

export function catalogRefreshTier(name: ProviderName): CatalogRefreshTier {
  if (CLI_BACKED_PROVIDERS.has(name)) return 'cli';
  if (CHEAP_CATALOG_PROVIDERS.has(name)) return 'cheap';
  // A user-defined OpenAI-compatible endpoint costs exactly what `local` /
  // `ollama` / `lmstudio` cost: one unauthenticated or bearer GET /models. It
  // is also the catalog most likely to change underneath the user — they are
  // the ones pointing Koryphaios at a new model server. Polling it 6x less
  // often than those identical-cost peers was the wrong trade, and it is why
  // newly added models took up to an hour to appear.
  if (name.startsWith('custom:')) return 'cheap';
  return 'hourly';
}

function baseIntervalMs(tier: CatalogRefreshTier): number {
  return tier === 'cheap' ? CHEAP_INTERVAL_MS : HOURLY_INTERVAL_MS;
}

// ─── Adaptation ──────────────────────────────────────────────────────────────

/** No catalog activity for this long means the user is away, not busy. */
export const IDLE_THRESHOLD_MS = 30 * 60_000;
/** Idle interval multiplier. A provider nobody touches can wait much longer. */
export const IDLE_BACKOFF_FACTOR = 4;
/** Idle past this and CLI-backed discovery is skipped entirely. */
export const IDLE_SUSPEND_MS = 2 * 60 * 60_000;

/** Consecutive soft failures before the interval doubles, and its ceiling. */
const FAILURE_BACKOFF_BASE_MS = 2 * baseIntervalMs('hourly');
const FAILURE_BACKOFF_MAX_MS = 12 * 60 * 60_000;

/** One scheduler tick. The cheapest tier is 10 minutes, so this is fine-grained. */
const TICK_MS = 60_000;
/** Most providers refreshed in a single tick, so a big config cannot burst. */
const MAX_REFRESHES_PER_TICK = 3;
/** Jitter spread, so many clients do not poll a provider on the same second. */
const JITTER_RATIO = 0.1;
/**
 * How stale a cheap catalog may be when the user becomes active.
 *
 * Matches the adapters' own model-list TTL (5 min). Cheap means "one HTTP GET",
 * so this cannot cost meaningful CPU; it exists so a model added to a custom
 * endpoint shows up when the user returns rather than on the next 10-minute tick.
 */
const ACTIVITY_REFRESH_INTERVAL_MS = 5 * 60_000;

/** Coalescing window for activity-driven catch-up refreshes. */
const CATCH_UP_DEBOUNCE_MS = 5_000;

/**
 * Cadence for the shared enrichment registries (models.dev, OpenRouter
 * pricing). One fetch serves every provider, and both are static JSON with no
 * credential, so this tracks the cheapest tier.
 */
const SHARED_REGISTRY_INTERVAL_MS = CHEAP_INTERVAL_MS;

/** A manual/connect-time refresh suppresses the scheduler briefly. */
const MANUAL_REFRESH_SUPPRESSION_MS = 60_000;

export type CatalogRefreshOutcome = 'refreshed' | 'unchanged' | 'failed' | 'skipped';

export interface CatalogRefreshState {
  tier: CatalogRefreshTier;
  /** Base cadence for this tier, before idle/failure adaptation. */
  baseIntervalMs: number;
  /** Next time this provider is due at its base cadence. Idle and failure
   *  backoff never move this, so returning from idle cannot skip a refresh. */
  dueAt: number;
  /** Next time the scheduler will actually attempt, after idle backoff. */
  nextAttemptAt: number;
  lastAttemptAt: number;
  lastRefreshAt: number;
  lastOutcome: CatalogRefreshOutcome;
  consecutiveFailures: number;
  modelCount: number;
}

export interface CatalogRefreshStatus {
  running: boolean;
  lastActivityAt: number;
  idle: boolean;
  idleForMs: number;
  lastTickAt: number;
  tickCount: number;
  lastCatchUpAt: number;
  providers: Array<{ name: ProviderName } & CatalogRefreshState>;
}

interface ProviderSchedule {
  tier: CatalogRefreshTier;
  /** Due at base cadence — unaffected by idle adaptation. */
  dueAt: number;
  /** Due after idle adaptation and failure backoff. */
  nextAttemptAt: number;
  lastAttemptAt: number;
  lastRefreshAt: number;
  lastOutcome: CatalogRefreshOutcome;
  consecutiveFailures: number;
  failureBackoffMs: number;
  modelCount: number;
  inFlight: boolean;
}

/**
 * Stable ordering key for a discovered catalog. Used only to decide whether the
 * scheduler should tell the UI something changed — the models themselves always
 * come from the provider.
 */
function catalogSignature(models: ReturnType<Provider['listModels']>): string {
  return models
    .map((m) => `${m.apiModelId ?? m.id}:${m.contextWindow}:${m.maxOutputTokens}`)
    .sort()
    .join('|');
}

/**
 * When a user last touched the provider surface. Module-level rather than
 * per-instance because "is anyone here" is a property of the process, and it
 * lets `catalog-refresh.ts` avoid importing the registry at runtime.
 */
let lastActivityAt = Date.now();

function isCatalogIdle(now: number): boolean {
  return now - lastActivityAt > IDLE_THRESHOLD_MS;
}

/** Test-only: reset the activity clock so idle behaviour is deterministic. */
export function __setCatalogActivityForTesting(at: number): void {
  lastActivityAt = at;
}

export interface CatalogRefreshSchedulerOptions {
  /**
   * Called after a tick changed at least one provider's catalog, so the caller
   * can push a fresh provider projection to connected clients.
   */
  onCatalogsChanged?: (changed: ProviderName[]) => void;
  /** Test-only clock injection. */
  now?: () => number;
  /** Test-only jitter source. Defaults to `Math.random`. */
  random?: () => number;
}

export class CatalogRefreshScheduler {
  private readonly registry: ProviderRegistry;
  private readonly onCatalogsChanged: ((changed: ProviderName[]) => void) | undefined;
  private readonly now: () => number;
  private readonly random: () => number;

  private readonly schedules = new Map<ProviderName, ProviderSchedule>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private catchUpTimer: ReturnType<typeof setTimeout> | null = null;
  private tickInFlight = false;

  private running = false;
  private lastTickAt = 0;
  private tickCount = 0;
  private lastCatchUpAt = 0;
  private lastManualRefreshAt = 0;
  private sharedRegistriesDueAt = 0;

  constructor(registry: ProviderRegistry, options: CatalogRefreshSchedulerOptions = {}) {
    this.registry = registry;
    this.onCatalogsChanged = options.onCatalogsChanged;
    this.now = options.now ?? Date.now;
    this.random = options.random ?? Math.random;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    lastActivityAt = this.now();
    providerLog.info(
      { tickSeconds: TICK_MS / 1000, cheapMinutes: CHEAP_INTERVAL_MS / 60_000 },
      'Adaptive provider catalog refresh started',
    );
    this.scheduleTick(0);
  }

  stop(): void {
    this.running = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.catchUpTimer) {
      clearTimeout(this.catchUpTimer);
      this.catchUpTimer = null;
    }
  }

  /**
   * Record that a user touched the provider surface (a completion ran, or
   * provider status was read). Resets the idle multiplier and schedules a
   * debounced catch-up so an overdue catalog is refreshed promptly instead of
   * waiting out a backed-off interval.
   */
  noteActivity(): void {
    // Uses the injected clock so a test can simulate activity deterministically
    // rather than depending on wall time.
    lastActivityAt = this.now();
    if (!this.running || this.catchUpTimer) return;
    this.catchUpTimer = setTimeout(() => {
      this.catchUpTimer = null;
      this.lastCatchUpAt = this.now();
      void this.runTick({ catchUp: true });
    }, CATCH_UP_DEBOUNCE_MS);
    this.catchUpTimer.unref?.();
  }

  /**
   * A manual or connect-time refresh just ran. Suppress the scheduler briefly
   * so it does not immediately repeat work the user already paid for.
   */
  noteManualRefresh(): void {
    this.lastManualRefreshAt = this.now();
  }

  /**
   * Test/diagnostic hook: run one tick synchronously without arming the timer.
   * `catchUp` bypasses idle adaptation for providers already past their base
   * cadence.
   */
  async __runTickForTesting(options: { catchUp?: boolean } = {}): Promise<void> {
    this.running = true;
    await this.runTick(options);
  }

  getStatus(): CatalogRefreshStatus {
    const now = this.now();
    return {
      running: this.running,
      lastActivityAt: lastActivityAt,
      idle: isCatalogIdle(now),
      idleForMs: now - lastActivityAt,
      lastTickAt: this.lastTickAt,
      tickCount: this.tickCount,
      lastCatchUpAt: this.lastCatchUpAt,
      providers: [...this.schedules.entries()].map(([name, s]) => ({
        name,
        tier: s.tier,
        baseIntervalMs: baseIntervalMs(s.tier),
        dueAt: s.dueAt,
        nextAttemptAt: s.nextAttemptAt,
        lastAttemptAt: s.lastAttemptAt,
        lastRefreshAt: s.lastRefreshAt,
        lastOutcome: s.lastOutcome,
        consecutiveFailures: s.consecutiveFailures,
        modelCount: s.modelCount,
      })),
    };
  }

  /** Test-only: drop all per-provider state. */
  __resetForTesting(): void {
    this.schedules.clear();
    this.lastManualRefreshAt = 0;
  }

  // ─── Internals ─────────────────────────────────────────────────────────────

  private scheduleTick(delayMs: number): void {
    if (!this.running) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.runTick({}).finally(() => this.scheduleTick(TICK_MS));
    }, delayMs);
    // Never hold the process open just to poll a catalog.
    this.timer.unref?.();
  }

  private scheduleFor(name: ProviderName, previous?: ProviderSchedule): ProviderSchedule {
    const tier = catalogRefreshTier(name);
    const now = this.now();
    const schedule: ProviderSchedule = previous ?? {
      tier,
      dueAt: now,
      nextAttemptAt: now,
      lastAttemptAt: 0,
      lastRefreshAt: 0,
      lastOutcome: 'skipped',
      consecutiveFailures: 0,
      failureBackoffMs: 0,
      modelCount: 0,
      inFlight: false,
    };
    schedule.tier = tier;
    return schedule;
  }

  /** Base cadence for this tier, before idle adaptation and failure backoff. */
  private baseIntervalMs(schedule: ProviderSchedule): number {
    return baseIntervalMs(schedule.tier);
  }

  /** Interval after idle adaptation and failure backoff, plus jitter. */
  private adaptedIntervalMs(schedule: ProviderSchedule, now: number): number {
    let interval = this.baseIntervalMs(schedule);
    if (now - lastActivityAt > IDLE_THRESHOLD_MS) interval *= IDLE_BACKOFF_FACTOR;
    if (schedule.failureBackoffMs > 0) interval = Math.max(interval, schedule.failureBackoffMs);
    return Math.round(jitter(interval, this.random));
  }

  /** True when the process has been idle long enough to stop subprocess work. */
  private cliSuspended(now: number): boolean {
    return now - lastActivityAt > IDLE_SUSPEND_MS;
  }

  private async runTick(options: { catchUp?: boolean }): Promise<void> {
    if (!this.running || this.tickInFlight) return;
    this.tickInFlight = true;
    const now = this.now();
    this.lastTickAt = now;
    this.tickCount += 1;

    try {
      const targets = this.registry.listModelCatalogRefreshTargets();
      const eligible = new Set(targets.map((p) => p.name));
      // Drop providers that were disabled or disconnected so their backoff and
      // count state cannot resurrect when they come back.
      for (const name of [...this.schedules.keys()]) {
        if (!eligible.has(name)) this.schedules.delete(name);
      }

      const suppressed = now - this.lastManualRefreshAt < MANUAL_REFRESH_SUPPRESSION_MS;
      const catchUp = options.catchUp === true;

      // The shared enrichment registries are a single fetch regardless of how
      // many providers are enabled, so they are cheap enough to keep closer than
      // the metered tier — and they are what gives a brand-new model its real
      // context window and price before anyone uses it.
      this.refreshSharedRegistries(now, suppressed);

      let budget = MAX_REFRESHES_PER_TICK;
      const changed: ProviderName[] = [];

      for (const provider of targets) {
        if (budget <= 0) break;
        const schedule = this.scheduleFor(provider.name, this.schedules.get(provider.name));
        this.schedules.set(provider.name, schedule);

        if (schedule.inFlight) continue;
        // Normal ticks honour idle adaptation. A catch-up tick fires only for
        // providers already past their base cadence, so returning from a long
        // idle period refreshes what is genuinely stale and nothing else.
        //
        // Cheap sources get a tighter bar because their own adapter TTL is 5
        // minutes: if the user just became active and a cheap catalog is older
        // than that, refreshing costs one HTTP GET and makes the new model
        // visible now instead of up to ten minutes from now. Deliberately not
        // extended to the cli tier, where a catch-up would spawn a process.
        const due = catchUp
          ? schedule.dueAt <= now ||
            (schedule.tier === 'cheap' &&
              schedule.lastAttemptAt + ACTIVITY_REFRESH_INTERVAL_MS <= now)
          : schedule.nextAttemptAt <= now;
        if (!due) continue;
        if (suppressed) continue;

        if (schedule.tier === 'cli' && this.cliSuspended(now)) {
          schedule.lastOutcome = 'skipped';
          schedule.nextAttemptAt = now + HOURLY_INTERVAL_MS;
          continue;
        }

        budget -= 1;
        const outcome = await this.refreshOne(provider, schedule, now);
        if (outcome === 'refreshed') changed.push(provider.name);
        this.reschedule(schedule);
      }

      if (changed.length > 0) {
        providerLog.debug({ changed }, 'Background catalog refresh updated provider models');
        this.onCatalogsChanged?.(changed);
      }
    } catch (err: unknown) {
      providerLog.warn(
        { err: err instanceof Error ? err.message : String(err) },
        'Catalog refresh tick failed (non-fatal)',
      );
    } finally {
      this.tickInFlight = false;
    }
  }

  /**
   * Set the provider's next due times from its base cadence. `dueAt` never
   * includes idle adaptation, so `nextAttemptAt` can be recomputed from scratch
   * once activity returns instead of drifting further out on every tick.
   */
  private reschedule(schedule: ProviderSchedule): void {
    const now = this.now();
    const base = this.baseIntervalMs(schedule);
    schedule.dueAt = now + Math.round(jitter(base, this.random));
    schedule.nextAttemptAt = now + this.adaptedIntervalMs(schedule, now);
  }

  /**
   * Re-pull models.dev and OpenRouter's pricing catalog on their own cadence.
   * One fetch covers every provider, so it does not belong in the per-tick
   * provider budget, but it is large enough that re-fetching it on every
   * provider's schedule would be wasteful.
   */
  private refreshSharedRegistries(now: number, suppressed: boolean): void {
    if (suppressed || now < this.sharedRegistriesDueAt) return;
    refreshSharedCatalogs();
    this.sharedRegistriesDueAt = now + Math.round(jitter(SHARED_REGISTRY_INTERVAL_MS, this.random));
  }

  private async refreshOne(
    provider: Provider,
    schedule: ProviderSchedule,
    now: number,
  ): Promise<CatalogRefreshOutcome> {
    schedule.inFlight = true;
    schedule.lastAttemptAt = now;
    const beforeSignature = catalogSignature(provider.listModels());

    try {
      await this.registry.refreshModelCatalog(provider.name);
    } catch (err: unknown) {
      // refreshModelCatalog already swallows per-provider failures; this only
      // catches a defect in the scheduler itself.
      providerLog.debug(
        { provider: provider.name, err: err instanceof Error ? err.message : String(err) },
        'Scheduled catalog refresh threw (non-fatal)',
      );
    } finally {
      schedule.inFlight = false;
    }

    const after = provider.listModels();
    const afterSignature = catalogSignature(after);
    schedule.lastRefreshAt = this.now();
    schedule.modelCount = after.length;

    if (schedule.modelCount === 0 && provider.isAvailable()) {
      // Adapters negative-cache a failed discovery instead of throwing, so an
      // available provider that still has no models is the only honest failure
      // signal available here.
      schedule.consecutiveFailures += 1;
      schedule.failureBackoffMs = Math.min(
        schedule.failureBackoffMs > 0 ? schedule.failureBackoffMs * 2 : FAILURE_BACKOFF_BASE_MS,
        FAILURE_BACKOFF_MAX_MS,
      );
      schedule.lastOutcome = 'failed';
      providerLog.debug(
        {
          provider: provider.name,
          consecutiveFailures: schedule.consecutiveFailures,
          backoffMs: schedule.failureBackoffMs,
        },
        'Catalog refresh left no models; backing off',
      );
      return 'failed';
    }

    schedule.consecutiveFailures = 0;
    schedule.failureBackoffMs = 0;
    schedule.lastOutcome = afterSignature === beforeSignature ? 'unchanged' : 'refreshed';
    return schedule.lastOutcome;
  }
}

/**
 * Spread refreshes around the nominal interval so many Koryphaios clients do not
 * all hit the same provider on the same second.
 */
function jitter(intervalMs: number, random: () => number): number {
  const spread = intervalMs * JITTER_RATIO;
  return intervalMs - spread + random() * spread * 2;
}

// ─── Shared enrichment registries ────────────────────────────────────────────

/**
 * models.dev and OpenRouter's pricing catalog enrich every provider's models
 * (context windows, output limits, reasoning tiers, prices). Left on their own
 * 24-hour TTLs a newly discovered model can sit without metadata for a day, so
 * the scheduler re-pulls them on the cheap cadence. Both are unauthenticated
 * static JSON, and each is one fetch no matter how many providers are enabled.
 */
export function refreshSharedCatalogs(): void {
  forceModelsDevRefresh();
  void refreshOpenRouterPricingCatalog();
}

// ─── Singleton wiring ────────────────────────────────────────────────────────

let activeScheduler: CatalogRefreshScheduler | null = null;

/**
 * Start the adaptive catalog refresh for this process. Idempotent.
 *
 * The `onCatalogsChanged` callback pushes a fresh provider projection so a model
 * that appears while nobody is looking still shows up in the picker the moment
 * the app is next viewed, instead of waiting for a manual refresh.
 */
export function startCatalogRefresh(
  registry: ProviderRegistry,
  options: CatalogRefreshSchedulerOptions = {},
): CatalogRefreshScheduler {
  if (activeScheduler) return activeScheduler;
  const scheduler = new CatalogRefreshScheduler(registry, options);
  activeScheduler = scheduler;
  scheduler.start();
  return scheduler;
}

export function stopCatalogRefresh(): void {
  activeScheduler?.stop();
  activeScheduler = null;
}

export function getCatalogRefreshScheduler(): CatalogRefreshScheduler | null {
  return activeScheduler;
}

/** Test-only: forget the singleton without touching a live timer. */
export function __resetCatalogRefreshForTesting(): void {
  activeScheduler?.stop();
  activeScheduler = null;
}
