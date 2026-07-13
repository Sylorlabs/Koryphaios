// Backend health sentinel.
//
// Continuously polls the backend /api/health endpoint and reacts to Tauri
// supervisor events ("backend://down" / "backend://ready"). When the backend is
// sustained-unhealthy OR its compatibility contract rejects the running
// frontend build, the sentinel:
//
//   - flips status to 'unhealthy' / 'mismatch' for the overlay to consume,
//   - halts all API traffic via setApiHalted(true) so nothing queues against a
//     dead server,
//   - resumes automatically when health returns AND the contract matches.
//
// The goal: a working UI without a working backend is never allowed. The
// overlay is the single place the user sees "the backend isn't working"
// instead of a hundred scattered broken states.

import { browser } from '$app/environment';
import { getApiBaseUrl } from '$lib/utils/api-url';
import { setApiHalted } from '$lib/api.svelte';

// ─── Public types ────────────────────────────────────────────────────────────

export type BackendHealthStatus =
  | 'unknown' // haven't checked yet (initial)
  | 'healthy' // last check ok and contract matched
  | 'unhealthy' // last N checks failed
  | 'mismatch'; // backend up but contract (version/hash) rejected us

export type BackendHealthReason = 'unreachable' | 'not-ok' | 'min-frontend' | 'bundle-hash';

export interface BackendHealthSnapshot {
  status: BackendHealthStatus;
  reason: BackendHealthReason | null;
  lastCheckedAt: number | null;
  lastHealthyAt: number | null;
  backendVersion: string | null;
  backendPid: number | null;
  backendMinFrontend: string | null;
  backendCurrentFrontend: string | null;
  backendBundleHash: string | null;
  consecutiveFailures: number;
}

// ─── Compile-time frontend identity (Vite define; see app.d.ts) ─────────────

function frontendVersion(): string {
  return __KORYPHAIOS_FRONTEND_VERSION__ ?? '0.0.0';
}
function frontendBundleHash(): string | null {
  const v = __KORYPHAIOS_FRONTEND_BUNDLE_HASH__ ?? '';
  const trimmed = v.trim();
  if (!trimmed || trimmed === 'dev' || trimmed === 'null') return null;
  return trimmed;
}

// ─── Tiny semver comparator (x.y.z, numeric) ────────────────────────────────

function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map((n) => Number.parseInt(n, 10) || 0);
  const pb = b.split('.').map((n) => Number.parseInt(n, 10) || 0);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const da = pa[i] ?? 0;
    const db = pb[i] ?? 0;
    if (da !== db) return da < db ? -1 : 1;
  }
  return 0;
}

// ─── Reactive state ─────────────────────────────────────────────────────────

let _status = $state<BackendHealthStatus>('unknown');
let _reason = $state<BackendHealthReason | null>(null);
let _lastCheckedAt = $state<number | null>(null);
let _lastHealthyAt = $state<number | null>(null);
let _backendVersion = $state<string | null>(null);
let _backendPid = $state<number | null>(null);
let _backendMinFrontend = $state<string | null>(null);
let _backendCurrentFrontend = $state<string | null>(null);
let _backendBundleHash = $state<string | null>(null);
let _consecutiveFailures = $state(0);

// ─── Tunables ───────────────────────────────────────────────────────────────

const POLL_INTERVAL_MS = 5_000;
// Need this many consecutive failed checks before flipping to 'unhealthy'.
// At a 5s cadence, 3 failures ~= 15s of sustained regression.
const UNHEALTHY_FAIL_THRESHOLD = 3;
const HEALTH_TIMEOUT_MS = 4_000;

// ─── Internals ──────────────────────────────────────────────────────────────

let pollTimer: ReturnType<typeof setInterval> | null = null;
let started = false;

type HealthResponse = {
  ok?: boolean;
  data?: {
    version?: string;
    pid?: number;
    uptime?: number;
    compat?: {
      minFrontend?: string;
      currentFrontend?: string;
      bundleHash?: string | null;
      bundleHashEnforced?: boolean;
      serverStartedAt?: number;
    };
  };
};

async function fetchHealth(): Promise<HealthResponse | null> {
  const base = getApiBaseUrl();
  if (!base) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), HEALTH_TIMEOUT_MS);
  try {
    const res = await fetch(`${base}/api/health`, {
      signal: controller.signal,
      headers: { Accept: 'application/json' },
    });
    if (!res.ok) return null;
    return (await res.json()) as HealthResponse;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

type CheckOutcome = {
  status: BackendHealthStatus;
  reason: BackendHealthReason | null;
};

function evaluate(body: HealthResponse | null): CheckOutcome {
  if (!body || body.ok !== true) {
    return { status: 'unhealthy', reason: body ? 'not-ok' : 'unreachable' };
  }
  const minFrontend = body.data?.compat?.minFrontend ?? null;
  const currentFrontend = body.data?.compat?.currentFrontend ?? null;
  const bundleHash = body.data?.compat?.bundleHash ?? null;
  const enforced = body.data?.compat?.bundleHashEnforced === true;

  // 1. minFrontend gate: frontend must be >= minFrontend.
  if (minFrontend && compareVersions(frontendVersion(), minFrontend) < 0) {
    return { status: 'mismatch', reason: 'min-frontend' };
  }
  // 2. bundle-hash gate: only enforced in production when both sides report
  //    a real (non-null, non-'dev') hash.
  const feHash = frontendBundleHash();
  if (enforced && bundleHash && feHash && bundleHash !== feHash) {
    return { status: 'mismatch', reason: 'bundle-hash' };
  }
  return { status: 'healthy', reason: null };
}

function publish(outcome: CheckOutcome, body: HealthResponse | null) {
  _lastCheckedAt = Date.now();
  _backendVersion = body?.data?.version ?? _backendVersion;
  _backendPid = body?.data?.pid ?? _backendPid;
  _backendMinFrontend = body?.data?.compat?.minFrontend ?? _backendMinFrontend;
  _backendCurrentFrontend = body?.data?.compat?.currentFrontend ?? _backendCurrentFrontend;
  _backendBundleHash = body?.data?.compat?.bundleHash ?? _backendBundleHash;

  if (outcome.status === 'healthy') {
    _consecutiveFailures = 0;
    _lastHealthyAt = Date.now();
    setApiHalted(false);
  } else if (outcome.status === 'mismatch') {
    _consecutiveFailures = 0; // mismatch isn't a flaky-network signal
    setApiHalted(true);
  } else {
    _consecutiveFailures++;
    if (_consecutiveFailures >= UNHEALTHY_FAIL_THRESHOLD) {
      setApiHalted(true);
    } else if (_status === 'healthy') {
      // Don't flap to 'unhealthy' on a single blip — stay 'healthy' until
      // the threshold is reached.
      return;
    }
  }

  _status = outcome.status;
  _reason = outcome.reason;
}

async function tick() {
  const body = await fetchHealth();
  publish(evaluate(body), body);
}

// ─── Tauri event fast-path (Step 4) ──────────────────────────────────────────

type TauriUnlisten = () => void;
let tauriUnlistens: TauriUnlisten[] = [];

async function attachTauriListeners() {
  if (!browser) return;
  const inTauri = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
  if (!inTauri) return;
  try {
    const { listen } = await import('@tauri-apps/api/event');
    const unDown = await listen('backend://down', () => {
      _lastCheckedAt = Date.now();
      _consecutiveFailures++;
      _status = 'unhealthy';
      _reason = 'unreachable';
      setApiHalted(true);
    });
    const unReady = await listen('backend://ready', () => {
      // Trigger an immediate poll to confirm and re-evaluate the contract.
      void tick();
    });
    tauriUnlistens.push(unDown, unReady);
  } catch {
    // Not in Tauri or event plugin unavailable — fall back to polling only.
  }
}

function detachTauriListeners() {
  for (const un of tauriUnlistens) {
    try {
      un();
    } catch {
      /* ignore */
    }
  }
  tauriUnlistens = [];
}

// ─── Public lifecycle ───────────────────────────────────────────────────────

export function startBackendHealthSentinel(): void {
  if (!browser || started) return;
  started = true;
  void attachTauriListeners();
  // Immediate first check so the overlay has data without waiting 5s.
  void tick();
  pollTimer = setInterval(() => void tick(), POLL_INTERVAL_MS);
}

export function stopBackendHealthSentinel(): void {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
  detachTauriListeners();
  started = false;
}

/** Force an immediate health re-check (used by the overlay Retry button). */
export function recheckBackendHealth(): void {
  if (!browser) return;
  void tick();
}

/**
 * Startup gate: resolve only after the backend has passed its health and
 * compatibility checks. The app must not render a partially initialized UI.
 */
export async function waitForBackendHealthy(timeoutMs = 30_000): Promise<void> {
  if (!browser) return;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const body = await fetchHealth();
    const outcome = evaluate(body);
    publish(outcome, body);
    if (outcome.status === 'healthy') return;
    if (outcome.status === 'mismatch') {
      throw new Error('Frontend and backend are incompatible. Restart Koryphaios.');
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error('The Koryphaios backend did not become ready in time.');
}

export const backendHealth = {
  get status() {
    return _status;
  },
  get reason() {
    return _reason;
  },
  get lastCheckedAt() {
    return _lastCheckedAt;
  },
  get lastHealthyAt() {
    return _lastHealthyAt;
  },
  get backendVersion() {
    return _backendVersion;
  },
  get backendPid() {
    return _backendPid;
  },
  get backendMinFrontend() {
    return _backendMinFrontend;
  },
  get backendCurrentFrontend() {
    return _backendCurrentFrontend;
  },
  get backendBundleHash() {
    return _backendBundleHash;
  },
  get consecutiveFailures() {
    return _consecutiveFailures;
  },
  get frontendVersion() {
    return frontendVersion();
  },
  get frontendBundleHash() {
    return frontendBundleHash();
  },
  get snapshot(): BackendHealthSnapshot {
    return {
      status: _status,
      reason: _reason,
      lastCheckedAt: _lastCheckedAt,
      lastHealthyAt: _lastHealthyAt,
      backendVersion: _backendVersion,
      backendPid: _backendPid,
      backendMinFrontend: _backendMinFrontend,
      backendCurrentFrontend: _backendCurrentFrontend,
      backendBundleHash: _backendBundleHash,
      consecutiveFailures: _consecutiveFailures,
    };
  },
};
