// Backend-health sentinel startup-progress behavior. A packaged backend that
// is still booting reports phases through the desktop's
// `get_backend_startup_status` command and `backend://starting` events; the
// sentinel must render that as 'starting' (progress), never count it toward
// the unhealthy threshold.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const invoke = vi.hoisted(() => vi.fn());
const listeners = vi.hoisted(
  () => new Map<string, (event: { payload: unknown }) => void>(),
);
const setApiHalted = vi.hoisted(() => vi.fn());

vi.mock('@tauri-apps/api/core', () => ({ invoke }));
vi.mock('@tauri-apps/api/event', () => ({
  listen: (name: string, cb: (event: { payload: unknown }) => void) => {
    listeners.set(name, cb);
    return Promise.resolve(() => {
      listeners.delete(name);
    });
  },
}));
vi.mock('$lib/utils/api-url', () => ({
  getDirectBackendUrl: () => 'http://127.0.0.1:3001',
  refreshUrls: vi.fn(async () => {}),
}));
vi.mock('$lib/api.svelte', () => ({ setApiHalted }));

const STARTING = {
  phase: 'database-vacuum',
  detail: 'Compacting the database (one-time)',
  elapsedMs: 5_000,
  startedAt: 1_000,
};

async function loadStore() {
  vi.resetModules();
  (globalThis as Record<string, unknown>).__TAURI_INTERNALS__ = {};
  return import('./backend-health.svelte');
}

beforeEach(() => {
  listeners.clear();
  setApiHalted.mockReset();
  invoke.mockReset().mockResolvedValue(null);
  // Vite `define` globals (see vite.config.ts + app.d.ts) — absent under
  // vitest.config.ts, so healthy-path evaluation needs them stubbed.
  vi.stubGlobal('__KORYPHAIOS_FRONTEND_VERSION__', '0.5.0');
  vi.stubGlobal('__KORYPHAIOS_FRONTEND_BUNDLE_HASH__', 'test-hash');
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')));
});

afterEach(() => {
  delete (globalThis as Record<string, unknown>).__TAURI_INTERNALS__;
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('backend-health starting state', () => {
  it('flips to starting on a backend://starting supervisor event', async () => {
    const store = await loadStore();
    store.startBackendHealthSentinel();
    try {
      await vi.waitFor(() => expect(listeners.has('backend://starting')).toBe(true));

      listeners.get('backend://starting')!({
        payload: { phase: 'database-vacuum', detail: 'Compacting', elapsedMs: 5_000 },
      });

      expect(store.backendHealth.status).toBe('starting');
      expect(store.backendHealth.startupPhase).toBe('database-vacuum');
      expect(store.backendHealth.startupDetail).toBe('Compacting');
      expect(store.backendHealth.startupElapsedMs).toBe(5_000);
      expect(setApiHalted).toHaveBeenCalledWith(true);
    } finally {
      store.stopBackendHealthSentinel();
    }
  });

  it('reports starting — not unhealthy — when a failed poll finds a live startup marker', async () => {
    invoke.mockImplementation((command: string) =>
      command === 'get_backend_startup_status'
        ? Promise.resolve(STARTING)
        : Promise.resolve(null),
    );
    const store = await loadStore();

    store.recheckBackendHealth();
    await vi.waitFor(() => expect(store.backendHealth.status).toBe('starting'));

    expect(store.backendHealth.consecutiveFailures).toBe(0);
    expect(store.backendHealth.startupPhase).toBe('database-vacuum');
    expect(setApiHalted).toHaveBeenCalledWith(true);
  });

  it('still reaches unhealthy through the threshold when no marker exists', async () => {
    const store = await loadStore();

    for (let i = 0; i < 5; i++) {
      store.recheckBackendHealth();
      await vi.waitFor(() =>
        expect(store.backendHealth.consecutiveFailures).toBeGreaterThanOrEqual(i + 1),
      );
    }
    expect(store.backendHealth.status).toBe('unhealthy');
  });

  it('waitForBackendHealthy keeps waiting through reported startup progress', async () => {
    vi.useFakeTimers();
    invoke.mockImplementation((command: string) =>
      command === 'get_backend_startup_status'
        ? Promise.resolve(STARTING)
        : Promise.resolve(null),
    );
    const fetchMock = vi.mocked(fetch);
    const store = await loadStore();

    let settled: 'resolved' | 'rejected' | null = null;
    let rejection: unknown = null;
    const wait = store
      .waitForBackendHealthy(120_000)
      .then(() => {
        settled = 'resolved';
      })
      .catch((err: unknown) => {
        rejection = err;
        settled = 'rejected';
      });

    // Two full no-signal deadlines of clock time pass while every poll sees a
    // live 'starting' marker — the deadline keeps resetting, so no throw.
    await vi.advanceTimersByTimeAsync(120_000);
    expect(settled).toBeNull();
    expect(store.backendHealth.status).toBe('starting');
    await vi.advanceTimersByTimeAsync(120_000);
    expect(settled).toBeNull();

    // The backend finally binds: the next poll is healthy and the gate opens.
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ ok: true, data: { version: '0.5.0' } }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    await vi.advanceTimersByTimeAsync(1_000);
    await wait;
    expect(rejection).toBeNull();
    expect(settled).toBe('resolved');
    expect(store.backendHealth.status).toBe('healthy');
  });
});
