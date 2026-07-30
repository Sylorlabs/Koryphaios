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
import { getDirectBackendUrl, refreshUrls } from '$lib/utils/api-url';
import { setApiHalted } from '$lib/api.svelte';

// ─── Public types ────────────────────────────────────────────────────────────

export type BackendHealthStatus =
  | 'unknown' // haven't checked yet (initial)
  | 'healthy' // last check ok and contract matched
  | 'unhealthy' // last N checks failed
  | 'mismatch'; // backend up but contract (version/hash) rejected us

export type BackendHealthReason =
  | 'unreachable'
  | 'http-error'
  | 'invalid-response'
  | 'not-ok'
  | 'min-frontend'
  | 'bundle-hash'
  | 'supervisor'; // Tauri supervisor reported the backend down (see supervisorReason)

// Mirror of the BackendDownEvent payload emitted by the desktop supervisor
// (desktop/src-tauri/src/lib.rs). Kept loose-typed because the supervisor is
// the source of truth and may add reasons without a frontend redeploy.
export type SupervisorReason =
  | 'initial-timeout'
  | 'exited'
  | 'restart-timeout'
  | 'restart-failed'
  | (string & {}); // forward-compatible with future supervisor codes

export interface BackendHealthSnapshot {
  status: BackendHealthStatus;
  reason: BackendHealthReason | null;
  failureDetail: string | null;
  /** Raw supervisor reason code when the failure originated upstream of the
   *  health-check poller (e.g. the embedded process exited before binding). */
  supervisorReason: SupervisorReason | null;
  /** Human-readable message supplied by the supervisor alongside the code. */
  supervisorMessage: string | null;
  /** The exact URL the sentinel polled when this failure was recorded. */
  healthUrl: string | null;
  /** HTTP status code when the backend answered but with an error status. */
  httpStatus: number | null;
  /** Underlying network error name/message when the fetch threw (e.g.
   *  TypeError: Failed to fetch). Useful for distinguishing a refused port
   *  from a DNS failure from a CORS rejection. */
  networkError: string | null;
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
let _failureDetail = $state<string | null>(null);
let _supervisorReason = $state<SupervisorReason | null>(null);
let _supervisorMessage = $state<string | null>(null);
let _healthUrl = $state<string | null>(null);
let _httpStatus = $state<number | null>(null);
let _networkError = $state<string | null>(null);
let _lastCheckedAt = $state<number | null>(null);
let _lastHealthyAt = $state<number | null>(null);
let _backendVersion = $state<string | null>(null);
let _backendPid = $state<number | null>(null);
let _backendMinFrontend = $state<string | null>(null);
let _backendCurrentFrontend = $state<string | null>(null);
let _backendBundleHash = $state<string | null>(null);
let _consecutiveFailures = $state(0);

// ─── Tunables ───────────────────────────────────────────────────────────────

/** Poll cadence for the health sentinel. Exported so the overlay can drive a
 *  live "retrying in N…" countdown that stays in sync with the actual poll. */
export const POLL_INTERVAL_MS = 5_000;
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

type HealthFetchResult = {
  body: HealthResponse | null;
  reason: BackendHealthReason | null;
  detail: string | null;
  healthUrl: string | null;
  httpStatus: number | null;
  networkError: string | null;
};

async function fetchHealth(): Promise<HealthFetchResult> {
  const base = getDirectBackendUrl();
  if (!base) {
    return {
      body: null,
      reason: 'unreachable',
      detail: 'No backend address is configured.',
      healthUrl: null,
      httpStatus: null,
      networkError: null,
    };
  }
  const healthUrl = `${base}/api/health`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), HEALTH_TIMEOUT_MS);
  try {
    const res = await fetch(healthUrl, {
      signal: controller.signal,
      headers: { Accept: 'application/json' },
    });
    if (!res.ok) {
      return {
        body: null,
        reason: 'http-error',
        detail: `Health endpoint returned HTTP ${res.status}${res.statusText ? ` ${res.statusText}` : ''} from ${healthUrl}.`,
        healthUrl,
        httpStatus: res.status,
        networkError: null,
      };
    }
    try {
      const body = (await res.json()) as HealthResponse;
      // The backend answered with 200 but body.ok !== true — capture what it
      // actually said so the overlay/console can show the real reason instead
      // of a generic "reported unhealthy" with no context.
      if (body.ok !== true) {
        const bodySnippet = JSON.stringify(body).slice(0, 500);
        return {
          body,
          reason: 'not-ok',
          detail: `Backend at ${healthUrl} responded with ok=false. Body: ${bodySnippet}`,
          healthUrl,
          httpStatus: res.status,
          networkError: null,
        };
      }
      return {
        body,
        reason: null,
        detail: null,
        healthUrl,
        httpStatus: res.status,
        networkError: null,
      };
    } catch (err) {
      return {
        body: null,
        reason: 'invalid-response',
        detail: `Health endpoint at ${healthUrl} returned a response that was not valid JSON (${err instanceof Error ? err.message : String(err)}).`,
        healthUrl,
        httpStatus: res.status,
        networkError: err instanceof Error ? `${err.name}: ${err.message}` : String(err),
      };
    }
  } catch (error) {
    const aborted = error instanceof DOMException && error.name === 'AbortError';
    const message = aborted
      ? `Health check to ${healthUrl} timed out after ${HEALTH_TIMEOUT_MS / 1000}s.`
      : `Could not reach ${healthUrl}: ${error instanceof Error ? error.message : String(error)}. The backend process may not be running, may not be listening on this port, or a firewall/cors policy blocked the request.`;
    return {
      body: null,
      reason: 'unreachable',
      detail: message,
      healthUrl,
      httpStatus: null,
      networkError: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
    };
  } finally {
    clearTimeout(timer);
  }
}

type CheckOutcome = {
  status: BackendHealthStatus;
  reason: BackendHealthReason | null;
};

function evaluate(
  body: HealthResponse | null,
  fetchReason: BackendHealthReason | null,
): CheckOutcome {
  if (!body || body.ok !== true) {
    return { status: 'unhealthy', reason: body ? 'not-ok' : (fetchReason ?? 'unreachable') };
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

function publish(
  outcome: CheckOutcome,
  body: HealthResponse | null,
  failureDetail: string | null = null,
  diagnostics: {
    healthUrl?: string | null;
    httpStatus?: number | null;
    networkError?: string | null;
  } = {},
) {
  _lastCheckedAt = Date.now();
  _backendVersion = body?.data?.version ?? _backendVersion;
  _backendPid = body?.data?.pid ?? _backendPid;
  _backendMinFrontend = body?.data?.compat?.minFrontend ?? _backendMinFrontend;
  _backendCurrentFrontend = body?.data?.compat?.currentFrontend ?? _backendCurrentFrontend;
  _backendBundleHash = body?.data?.compat?.bundleHash ?? _backendBundleHash;

  if (outcome.status === 'healthy') {
    _consecutiveFailures = 0;
    _failureDetail = null;
    _supervisorReason = null;
    _supervisorMessage = null;
    _httpStatus = null;
    _networkError = null;
    _healthUrl = diagnostics.healthUrl ?? _healthUrl;
    _lastHealthyAt = Date.now();
    if (_status !== 'healthy') {
      console.info('[Koryphaios] Backend is healthy again', {
        backendVersion: _backendVersion,
        backendPid: _backendPid,
        healthUrl: _healthUrl,
      });
    }
    setApiHalted(false);
  } else if (outcome.status === 'mismatch') {
    _consecutiveFailures = 0; // mismatch isn't a flaky-network signal
    _failureDetail = null;
    _supervisorReason = null;
    _supervisorMessage = null;
    _httpStatus = diagnostics.httpStatus ?? null;
    _networkError = diagnostics.networkError ?? null;
    _healthUrl = diagnostics.healthUrl ?? _healthUrl;
    if (_status !== 'mismatch') {
      console.error('[Koryphaios] Backend/frontend compatibility mismatch', {
        reason: outcome.reason,
        frontendVersion: frontendVersion(),
        frontendBundleHash: frontendBundleHash(),
        backendVersion: _backendVersion,
        backendMinFrontend: _backendMinFrontend,
        backendCurrentFrontend: _backendCurrentFrontend,
        backendBundleHash: _backendBundleHash,
        healthUrl: _healthUrl,
      });
    }
    setApiHalted(true);
  } else {
    _consecutiveFailures++;
    _failureDetail = failureDetail;
    _healthUrl = diagnostics.healthUrl ?? _healthUrl;
    _httpStatus = diagnostics.httpStatus ?? null;
    _networkError = diagnostics.networkError ?? null;
    // Don't flap to 'unhealthy' on a single blip — stay 'healthy' until
    // the threshold is reached.
    if (_consecutiveFailures < UNHEALTHY_FAIL_THRESHOLD && _status === 'healthy') {
      console.warn('[Koryphaios] Backend health check failed (transient)', {
        reason: outcome.reason,
        detail: failureDetail,
        healthUrl: _healthUrl,
        httpStatus: _httpStatus,
        networkError: _networkError,
        consecutiveFailures: _consecutiveFailures,
      });
      return;
    }
    if (_consecutiveFailures >= UNHEALTHY_FAIL_THRESHOLD) {
      setApiHalted(true);
    }
    console.error('[Koryphaios] Backend health check failed', {
      reason: outcome.reason,
      detail: failureDetail,
      healthUrl: _healthUrl,
      httpStatus: _httpStatus,
      networkError: _networkError,
      consecutiveFailures: _consecutiveFailures,
      supervisorReason: _supervisorReason,
      supervisorMessage: _supervisorMessage,
    });
  }

  _status = outcome.status;
  _reason = outcome.reason;
}

async function tick() {
  // After several consecutive failures, the backend may have restarted on a
  // different port. Refresh the URL discovery so we don't keep polling a
  // dead port forever.
  if (_consecutiveFailures > 0 && _consecutiveFailures % 5 === 0) {
    await refreshUrls();
  }
  const result = await fetchHealth();
  publish(evaluate(result.body, result.reason), result.body, result.detail, {
    healthUrl: result.healthUrl,
    httpStatus: result.httpStatus,
    networkError: result.networkError,
  });
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

    // Payload mirror of BackendDownEvent in desktop/src-tauri/src/lib.rs.
    type BackendDownPayload = {
      reason: SupervisorReason;
      pid: number | null;
      message: string;
    };

    const unDown = await listen<BackendDownPayload>('backend://down', (event) => {
      const payload = event.payload;
      _lastCheckedAt = Date.now();
      _consecutiveFailures++;
      _status = 'unhealthy';
      _reason = 'supervisor';
      _supervisorReason = payload?.reason ?? null;
      _supervisorMessage = payload?.message ?? null;
      _failureDetail = payload?.message ?? null;
      if (typeof payload?.pid === 'number') _backendPid = payload.pid;
      console.error('[Koryphaios] Supervisor reported backend down', {
        supervisorReason: _supervisorReason,
        supervisorMessage: _supervisorMessage,
        pid: _backendPid,
        consecutiveFailures: _consecutiveFailures,
      });
      setApiHalted(true);
    });
    const unReady = await listen('backend://ready', () => {
      // The backend may have restarted on a different port (EADDRINUSE
      // fallback). Re-fetch the URL from Tauri before health-checking.
      console.info('[Koryphaios] Supervisor reported backend ready — re-checking health');
      void refreshUrls().then(() => tick());
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
export async function waitForBackendHealthy(timeoutMs = 10_000): Promise<void> {
  if (!browser) return;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await fetchHealth();
    const outcome = evaluate(result.body, result.reason);
    publish(outcome, result.body, result.detail);
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
  get failureDetail() {
    return _failureDetail;
  },
  get supervisorReason() {
    return _supervisorReason;
  },
  get supervisorMessage() {
    return _supervisorMessage;
  },
  get healthUrl() {
    return _healthUrl;
  },
  get httpStatus() {
    return _httpStatus;
  },
  get networkError() {
    return _networkError;
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
      failureDetail: _failureDetail,
      supervisorReason: _supervisorReason,
      supervisorMessage: _supervisorMessage,
      healthUrl: _healthUrl,
      httpStatus: _httpStatus,
      networkError: _networkError,
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
