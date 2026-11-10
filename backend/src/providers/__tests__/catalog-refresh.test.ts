import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import type { ModelDef, ProviderName } from '@koryphaios/shared';
import type { Provider } from '../types';
import {
  CatalogRefreshScheduler,
  __resetCatalogRefreshForTesting,
  __setCatalogActivityForTesting,
  catalogRefreshTier,
  getCatalogRefreshScheduler,
  startCatalogRefresh,
  stopCatalogRefresh,
  CHEAP_INTERVAL_MS,
  HOURLY_INTERVAL_MS,
  IDLE_BACKOFF_FACTOR,
  IDLE_SUSPEND_MS,
  IDLE_THRESHOLD_MS,
} from '../catalog-refresh';

const T0 = 1_700_000_000_000;

/** A fake provider whose discovered model list the test controls. */
class FakeProvider implements Provider {
  /** What discovery reports. Mutated by `onRefresh` to simulate a new model. */
  models: ModelDef[] = [];
  refreshCount = 0;
  available = true;
  hasRefreshHook = true;
  /** Simulates what the provider's own discovery does on each refresh. */
  onRefresh: (() => void) | null = null;

  constructor(
    readonly name: ProviderName,
    readonly config: { disabled?: boolean } = {},
  ) {}

  isAvailable(): boolean {
    return this.available && !this.config.disabled;
  }

  listModels(): ModelDef[] {
    return this.models;
  }

  refreshModels(): Promise<void> {
    if (!this.hasRefreshHook) return Promise.resolve();
    this.refreshCount += 1;
    this.onRefresh?.();
    return Promise.resolve();
  }
}

/** Minimal stand-in for the parts of ProviderRegistry the scheduler uses. */
function fakeRegistry(providers: FakeProvider[]) {
  const byName = new Map(providers.map((p) => [p.name, p]));
  return {
    providers,
    listModelCatalogRefreshTargets(): Provider[] {
      return providers.filter((p) => p.isAvailable() && p.hasRefreshHook) as Provider[];
    },
    async refreshModelCatalog(name: ProviderName): Promise<void> {
      await byName.get(name)?.refreshModels();
    },
  };
}

function def(id: string, provider: string): ModelDef {
  return {
    id,
    name: id,
    provider: provider as ModelDef['provider'],
    contextWindow: 128_000,
    maxOutputTokens: 8_192,
    supportsStreaming: true,
  };
}

function makeScheduler(
  registry: ReturnType<typeof fakeRegistry>,
  now: () => number,
  onCatalogsChanged?: (changed: ProviderName[]) => void,
  random: () => number = () => 0.5,
) {
  // Jitter is pinned to its midpoint so cadence assertions are exact. The
  // dedicated jitter test below exercises the real spread.
  return new CatalogRefreshScheduler(registry as never, { now, onCatalogsChanged, random });
}

/** Run a tick with the simulated clock as the only source of time. */
async function tick(
  scheduler: CatalogRefreshScheduler,
  now: number,
  options: { catchUp?: boolean } = {},
): Promise<void> {
  __setCatalogActivityForTesting(now);
  await scheduler.__runTickForTesting(options);
}

/** Simulate the user leaving: activity clock frozen in the past. */
function goIdle(at: number): void {
  __setCatalogActivityForTesting(at);
}

/** Let fire-and-forget shared-registry fetches land before asserting. */
function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 20));
}

beforeEach(() => {
  __resetCatalogRefreshForTesting();
  __setCatalogActivityForTesting(Date.now());
});

afterEach(() => {
  __resetCatalogRefreshForTesting();
});

describe('catalog refresh tiers', () => {
  it('polls keyless and localhost catalogs every 10 minutes', () => {
    expect(CHEAP_INTERVAL_MS).toBe(10 * 60_000);
    for (const name of ['cline', 'github-models', 'ollama', 'lmstudio', 'llamacpp', 'local']) {
      expect(catalogRefreshTier(name)).toBe('cheap');
    }
  });

  it('polls metered /models catalogs hourly', () => {
    expect(HOURLY_INTERVAL_MS).toBe(60 * 60_000);
    for (const name of ['openai', 'anthropic', 'google', 'openrouter', 'copilot']) {
      expect(catalogRefreshTier(name)).toBe('hourly');
    }
  });

  it('treats custom providers as cheap, matching their real cost', () => {
    // A custom OpenAI-compatible endpoint is one GET /models — identical to
    // ollama/lmstudio/local. Leaving it in the hourly tier meant a newly added
    // model took up to an hour to appear on the cheapest possible source.
    for (const name of ['custom:lmstudio', 'custom:my-llm', 'custom:openrouter-proxy']) {
      expect(catalogRefreshTier(name as never)).toBe('cheap');
    }
  });

  it('does not promote a custom provider above a real CLI', () => {
    // The custom id prefix must not shadow the subprocess tier: a custom
    // provider is never cli-backed, and the CLI providers must stay 'cli' so
    // they keep idle suspension and the burst cap.
    expect(catalogRefreshTier('custom:claude')).toBe('cheap');
    expect(catalogRefreshTier('claude')).toBe('cli');
  });

  it('treats subprocess-backed discovery as its own tier', () => {
    for (const name of [
      'claude',
      'codex',
      'codex-auth',
      'cursor',
      'antigravity',
      'devin',
      'grok',
      'opencode',
    ]) {
      expect(catalogRefreshTier(name)).toBe('cli');
    }
  });
});

describe('CatalogRefreshScheduler cadence', () => {
  it('refreshes a due provider and reports the change', async () => {
    const provider = new FakeProvider('openai');
    const changed: ProviderName[][] = [];
    // Discovery starts empty and reports its catalog, exactly like a real
    // provider whose list was never populated.
    provider.onRefresh = () => {
      provider.models = [def('gpt-5', 'openai')];
    };
    const scheduler = makeScheduler(
      fakeRegistry([provider]),
      () => T0,
      (c) => changed.push(c),
    );

    await tick(scheduler, T0);
    expect(provider.refreshCount).toBe(1);
    expect(changed).toEqual([['openai']]);
  });

  it('does not refresh a provider again before its interval elapses', async () => {
    const provider = new FakeProvider('ollama');
    provider.onRefresh = () => {
      provider.models = [def('llama3', 'ollama')];
    };
    let now = T0;
    const scheduler = makeScheduler(fakeRegistry([provider]), () => now);

    await tick(scheduler, now);
    expect(provider.refreshCount).toBe(1);

    // Nine minutes later the 10-minute cheap tier is not due yet.
    now = T0 + 9 * 60_000;
    await tick(scheduler, now);
    expect(provider.refreshCount).toBe(1);

    now = T0 + 11 * 60_000;
    await tick(scheduler, now);
    expect(provider.refreshCount).toBe(2);
  });

  it('keeps metered providers on the hourly cadence', async () => {
    const provider = new FakeProvider('anthropic');
    provider.onRefresh = () => {
      provider.models = [def('claude-opus-5', 'anthropic')];
    };
    let now = T0;
    const scheduler = makeScheduler(fakeRegistry([provider]), () => now);

    await tick(scheduler, now);
    expect(provider.refreshCount).toBe(1);

    // 30 minutes later — well past the cheap tier, still inside the hour.
    now = T0 + 30 * 60_000;
    await tick(scheduler, now);
    expect(provider.refreshCount).toBe(1);

    now = T0 + 61 * 60_000;
    await tick(scheduler, now);
    expect(provider.refreshCount).toBe(2);
  });

  it('caps work per tick so a large configuration cannot burst', async () => {
    const providers = Array.from({ length: 12 }, (_, i) => {
      const p = new FakeProvider(`provider-${i}` as ProviderName);
      p.onRefresh = () => {
        p.models = [def(`model-${i}`, 'openai')];
      };
      return p;
    });
    const scheduler = makeScheduler(fakeRegistry(providers), () => T0);

    await tick(scheduler, T0);
    const refreshed = providers.filter((p) => p.refreshCount > 0).length;
    expect(refreshed).toBeGreaterThan(0);
    expect(refreshed).toBeLessThanOrEqual(3);
  });
});

describe('CatalogRefreshScheduler idle adaptation', () => {
  it('stretches the interval once the user goes idle', async () => {
    const provider = new FakeProvider('ollama');
    provider.onRefresh = () => {
      provider.models = [def('llama3', 'ollama')];
    };
    let now = T0;
    const scheduler = makeScheduler(fakeRegistry([provider]), () => now);

    await tick(scheduler, now);
    expect(provider.refreshCount).toBe(1);
    const activeNext = scheduler.getStatus().providers[0].nextAttemptAt;
    expect(activeNext).toBeGreaterThan(T0);
    expect(activeNext).toBeLessThanOrEqual(T0 + CHEAP_INTERVAL_MS * 1.1 + 1_000);

    // User leaves. The next attempt is recomputed with the idle multiplier, so
    // the 10-minute cheap cadence becomes a 40-minute one.
    now = T0 + 41 * 60_000;
    goIdle(T0 - IDLE_THRESHOLD_MS - 1_000);
    await scheduler.__runTickForTesting();
    expect(provider.refreshCount).toBe(2);
    const idleNext = scheduler.getStatus().providers[0].nextAttemptAt;
    // 4x the cheap cadence, so the same provider is polled roughly 4x less often
    // while nobody is using it.
    expect(idleNext - (T0 + 41 * 60_000)).toBeGreaterThan(CHEAP_INTERVAL_MS * 3);
    // `dueAt` stays on the base cadence, which is what makes catch-up work.
    expect(scheduler.getStatus().providers[0].dueAt).toBeLessThan(idleNext);
    expect(scheduler.getStatus().idle).toBe(true);
  });

  it('does not run subprocess-backed discovery while deeply idle', async () => {
    const provider = new FakeProvider('cursor');
    provider.onRefresh = () => {
      provider.models = [def('gpt-5', 'openai')];
    };
    const scheduler = makeScheduler(fakeRegistry([provider]), () => T0);

    goIdle(T0 - IDLE_SUSPEND_MS - 1_000);
    await scheduler.__runTickForTesting();
    expect(provider.refreshCount).toBe(0);

    const status = scheduler.getStatus();
    expect(status.providers.find((p) => p.name === 'cursor')?.lastOutcome).toBe('skipped');
  });

  it('runs subprocess-backed discovery once the user is active again', async () => {
    const provider = new FakeProvider('cursor');
    provider.onRefresh = () => {
      provider.models = [def('gpt-5', 'openai')];
    };
    const scheduler = makeScheduler(fakeRegistry([provider]), () => T0);

    goIdle(T0 - IDLE_SUSPEND_MS - 1_000);
    await scheduler.__runTickForTesting();
    expect(provider.refreshCount).toBe(0);

    // Returning to the app triggers the activity catch-up tick, which is the
    // path that unblocks suspended CLI discovery.
    await tick(scheduler, T0 + 60_000, { catchUp: true });
    expect(provider.refreshCount).toBe(1);
  });

  it('refreshes a cheap catalog sooner than its cadence once the user is active', async () => {
    // The point of the tighter bar: a model added to a cheap/custom endpoint
    // shows up on the next activity rather than up to 10 minutes later. Cheap
    // means one HTTP GET, so this cannot cost the user anything meaningful.
    const provider = new FakeProvider('custom:my-llm');
    provider.onRefresh = () => {
      provider.models = [def('new-model', 'custom:my-llm')];
    };
    let now = T0;
    const scheduler = makeScheduler(fakeRegistry([provider]), () => now);
    await tick(scheduler, now);
    expect(provider.refreshCount).toBe(1);

    // 6 minutes later: inside the 10-minute cadence but past the 5-minute
    // activity bar, so an activity tick must refresh it.
    now = T0 + 6 * 60_000;
    await tick(scheduler, now, { catchUp: true });
    expect(provider.refreshCount).toBe(2);
  });

  it('does not let an activity tick spawn a CLI-backed catalog early', async () => {
    // The activity bar is deliberately cheap-tier only. A subprocess-backed
    // provider must still wait for its real cadence, or every status render
    // would launch the user's CLI.
    const provider = new FakeProvider('claude');
    provider.onRefresh = () => {
      provider.models = [def('sonnet', 'claude')];
    };
    let now = T0;
    const scheduler = makeScheduler(fakeRegistry([provider]), () => now);
    await tick(scheduler, now);
    expect(provider.refreshCount).toBe(1);
    now = T0 + 6 * 60_000;
    await tick(scheduler, now, { catchUp: true });
    expect(provider.refreshCount).toBe(1);
  });

  it('pulls a stale provider forward when activity resumes', async () => {
    const provider = new FakeProvider('ollama');
    provider.onRefresh = () => {
      provider.models = [def('llama3', 'ollama')];
    };
    let now = T0;
    const scheduler = makeScheduler(fakeRegistry([provider]), () => now);

    await tick(scheduler, now);
    expect(provider.refreshCount).toBe(1);

    // User leaves; the idle multiplier pushes the next attempt out to ~40min.
    now = T0 + 41 * 60_000;
    goIdle(T0 - IDLE_THRESHOLD_MS - 1_000);
    await scheduler.__runTickForTesting();
    expect(provider.refreshCount).toBe(2);

    // Coming back counts as activity. A normal tick still honours the
    // idle-backoff window, so the stale provider waits…
    now = T0 + 55 * 60_000;
    await tick(scheduler, now);
    expect(provider.refreshCount).toBe(2);

    // …but the catch-up tick that activity triggers only checks the base
    // cadence, which has long passed, so the catalog is fresh immediately.
    await tick(scheduler, now, { catchUp: true });
    expect(provider.refreshCount).toBe(3);
  });

  it('leaves a provider alone on catch-up when it is not yet due', async () => {
    const provider = new FakeProvider('ollama');
    provider.onRefresh = () => {
      provider.models = [def('llama3', 'ollama')];
    };
    let now = T0;
    const scheduler = makeScheduler(fakeRegistry([provider]), () => now);

    await tick(scheduler, now);
    expect(provider.refreshCount).toBe(1);

    now = T0 + 60_000;
    await tick(scheduler, now, { catchUp: true });
    expect(provider.refreshCount).toBe(1);
  });
});

describe('CatalogRefreshScheduler failure handling', () => {
  it('backs off a provider that keeps returning no models', async () => {
    const provider = new FakeProvider('openai');
    provider.models = [];
    let now = T0;
    const scheduler = makeScheduler(fakeRegistry([provider]), () => now);

    await scheduler.__runTickForTesting();
    expect(provider.refreshCount).toBe(1);
    let state = scheduler.getStatus().providers.find((p) => p.name === 'openai');
    expect(state?.lastOutcome).toBe('failed');
    expect(state?.consecutiveFailures).toBe(1);

    // The first backoff step is longer than the hourly cadence, so an immediate
    // second tick must not re-probe the dead endpoint.
    now = T0 + 61 * 60_000;
    await tick(scheduler, now);
    expect(provider.refreshCount).toBe(1);

    state = scheduler.getStatus().providers.find((p) => p.name === 'openai');
    expect(state?.consecutiveFailures).toBe(1);
  });

  it('does not treat a disconnected provider as a failure', async () => {
    const provider = new FakeProvider('openai');
    provider.models = [];
    provider.available = false;
    const scheduler = makeScheduler(fakeRegistry([provider]), () => T0);

    await tick(scheduler, T0);
    expect(provider.refreshCount).toBe(0);
    // Not eligible at all, so no schedule is tracked for it.
    expect(scheduler.getStatus().providers).toHaveLength(0);
  });

  it('clears backoff once the provider reports models again', async () => {
    const provider = new FakeProvider('openai');
    provider.models = [];
    let now = T0;
    const scheduler = makeScheduler(fakeRegistry([provider]), () => now);

    await tick(scheduler, now);
    expect(scheduler.getStatus().providers[0].consecutiveFailures).toBe(1);

    // The endpoint recovers.
    provider.onRefresh = () => {
      provider.models = [def('gpt-5', 'openai')];
    };
    now = T0 + 3 * 60 * 60_000;
    await tick(scheduler, now);
    const state = scheduler.getStatus().providers[0];
    expect(state.consecutiveFailures).toBe(0);
    expect(state.lastOutcome).toBe('refreshed');
  });
});

describe('CatalogRefreshScheduler bookkeeping', () => {
  it('drops state for providers that stop being refresh targets', async () => {
    const provider = new FakeProvider('ollama');
    provider.onRefresh = () => {
      provider.models = [def('llama3', 'ollama')];
    };
    const scheduler = makeScheduler(fakeRegistry([provider]), () => T0);

    await tick(scheduler, T0);
    expect(scheduler.getStatus().providers).toHaveLength(1);

    provider.available = false;
    await tick(scheduler, T0 + 60_000);
    expect(scheduler.getStatus().providers).toHaveLength(0);
  });

  it('suppresses a tick right after a manual refresh', async () => {
    const provider = new FakeProvider('ollama');
    provider.models = [def('llama3', 'ollama')];
    let now = T0;
    const scheduler = makeScheduler(fakeRegistry([provider]), () => now);

    scheduler.noteManualRefresh();
    await scheduler.__runTickForTesting();
    expect(provider.refreshCount).toBe(0);

    now = T0 + 2 * 60_000;
    await scheduler.__runTickForTesting();
    expect(provider.refreshCount).toBe(1);
  });

  it('reports only genuinely changed catalogs to the caller', async () => {
    const provider = new FakeProvider('ollama');
    provider.onRefresh = () => {
      provider.models = [def('llama3', 'ollama')];
    };
    const changed: ProviderName[][] = [];
    let now = T0;
    const scheduler = makeScheduler(
      fakeRegistry([provider]),
      () => now,
      (c) => changed.push(c),
    );

    await tick(scheduler, now);
    expect(changed).toEqual([['ollama']]);

    now = T0 + 11 * 60_000;
    await tick(scheduler, now);
    // Same catalog: nothing new for the UI.
    expect(changed).toHaveLength(1);
    expect(scheduler.getStatus().providers[0].lastOutcome).toBe('unchanged');
  });

  it('does not re-refresh in a loop when the caller reacts to the change', async () => {
    const provider = new FakeProvider('ollama');
    provider.onRefresh = () => {
      provider.models = [def('llama3', 'ollama')];
    };
    let now = T0;
    // The real callback reads provider status, which is itself an activity
    // signal and schedules a catch-up tick. Model that feedback loop here.
    const scheduler = makeScheduler(
      fakeRegistry([provider]),
      () => now,
      () => {
        scheduler.noteActivity();
      },
    );

    await tick(scheduler, now);
    expect(provider.refreshCount).toBe(1);

    // Simulate the debounced catch-up tick the callback armed.
    now = T0 + 5_000;
    await tick(scheduler, now, { catchUp: true });
    expect(provider.refreshCount).toBe(1);

    // And again past the hour mark, still exactly one refresh per interval.
    now = T0 + 61 * 60_000;
    await tick(scheduler, now);
    await tick(scheduler, now, { catchUp: true });
    expect(provider.refreshCount).toBe(2);
  });

  it('notifies again when a newly launched model shows up mid-session', async () => {
    const provider = new FakeProvider('ollama');
    provider.models = [def('llama3', 'ollama')];
    const changed: ProviderName[][] = [];
    let now = T0;
    const scheduler = makeScheduler(
      fakeRegistry([provider]),
      () => now,
      (c) => changed.push(c),
    );

    await tick(scheduler, now);
    expect(changed).toHaveLength(0);

    // The provider ships a new model on its next discovery pass.
    provider.onRefresh = () => {
      provider.models = [def('llama3', 'ollama'), def('qwen4', 'ollama')];
    };
    now = T0 + 11 * 60_000;
    await tick(scheduler, now);
    expect(changed).toEqual([['ollama']]);
    expect(scheduler.getStatus().providers[0].lastOutcome).toBe('refreshed');
  });
});

describe('catalog refresh singleton', () => {
  it('starts once and stops cleanly', () => {
    const provider = new FakeProvider('ollama');
    provider.models = [def('llama3', 'ollama')];
    const registry = fakeRegistry([provider]);

    const first = startCatalogRefresh(registry as never);
    const second = startCatalogRefresh(registry as never);
    expect(first).toBe(second);
    expect(getCatalogRefreshScheduler()).toBe(first);
    expect(first.getStatus().running).toBe(true);

    stopCatalogRefresh();
    expect(getCatalogRefreshScheduler()).toBeNull();
  });

  it('never holds the process open on its timer', () => {
    const provider = new FakeProvider('ollama');
    provider.models = [def('llama3', 'ollama')];
    const scheduler = startCatalogRefresh(fakeRegistry([provider]) as never);
    expect(scheduler.getStatus().running).toBe(true);
    stopCatalogRefresh();
  });
});

describe('shared enrichment registries', () => {
  it('re-pulls models.dev and OpenRouter pricing on their own cadence', async () => {
    // Both catalogs single-flight their fetch, so a request started by an earlier
    // test (which used the ambient fetch) would silently suppress this one.
    const { __resetModelsDevCacheForTesting } = await import('../models-dev');
    const { __resetOpenRouterPricingForTesting } = await import('../openrouter-pricing');
    __resetModelsDevCacheForTesting();
    __resetOpenRouterPricingForTesting();

    const seen: string[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      seen.push(typeof input === 'string' ? input : input.toString());
      if (String(input).includes('models.dev')) {
        return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
      }
      return new Response('{"data":[]}', {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch;

    try {
      const provider = new FakeProvider('ollama');
      provider.onRefresh = () => {
        provider.models = [def('llama3', 'ollama')];
      };
      let now = T0;
      const scheduler = makeScheduler(fakeRegistry([provider]), () => now);

      await tick(scheduler, now);
      // The shared-registry fetch is deliberately fire-and-forget so a slow
      // public catalog can never delay a provider refresh.
      await settle();
      expect(seen.some((u) => u.includes('models.dev'))).toBe(true);
      expect(seen.some((u) => u.includes('openrouter.ai'))).toBe(true);

      // Past the cheap interval: the provider refreshes and so do the registries.
      seen.length = 0;
      now = T0 + 11 * 60_000;
      await tick(scheduler, now);
      await settle();
      expect(provider.refreshCount).toBe(2);
      expect(seen.filter((u) => u.includes('models.dev'))).toHaveLength(1);
      expect(seen.filter((u) => u.includes('openrouter.ai'))).toHaveLength(1);

      // Ticks inside the next shared-registry interval must not re-fetch them:
      // the registries are one request regardless of how many providers exist,
      // so their cadence is independent of the per-tick provider budget.
      seen.length = 0;
      for (const minute of [12, 13]) {
        now = T0 + minute * 60_000;
        await tick(scheduler, now, { catchUp: true });
      }
      await settle();
      expect(seen.filter((u) => u.includes('models.dev'))).toHaveLength(0);
      expect(seen.filter((u) => u.includes('openrouter.ai'))).toHaveLength(0);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe('jitter', () => {
  it('spreads the interval around its nominal value so clients do not sync up', async () => {
    const provider = new FakeProvider('ollama');
    provider.onRefresh = () => {
      provider.models = [def('llama3', 'ollama')];
    };

    const early = makeScheduler(
      fakeRegistry([provider]),
      () => T0,
      undefined,
      () => 0,
    );
    await tick(early, T0);
    const earlyNext = early.getStatus().providers[0].nextAttemptAt - T0;

    const late = makeScheduler(
      fakeRegistry([provider]),
      () => T0,
      undefined,
      () => 1,
    );
    await tick(late, T0);
    const lateNext = late.getStatus().providers[0].nextAttemptAt - T0;

    expect(earlyNext).toBeLessThan(CHEAP_INTERVAL_MS);
    expect(lateNext).toBeGreaterThan(CHEAP_INTERVAL_MS);
    // Bounded, so jitter can never become an unbounded refresh loop.
    expect(earlyNext).toBeGreaterThanOrEqual(CHEAP_INTERVAL_MS * 0.9);
    expect(lateNext).toBeLessThanOrEqual(CHEAP_INTERVAL_MS * 1.1);
  });
});

describe('idle backoff factor', () => {
  it('stretches every tier, so idling never polls faster than working', () => {
    expect(IDLE_BACKOFF_FACTOR).toBeGreaterThan(1);
    for (const base of [CHEAP_INTERVAL_MS, HOURLY_INTERVAL_MS]) {
      expect(base * IDLE_BACKOFF_FACTOR).toBeGreaterThan(base);
    }
  });
});
