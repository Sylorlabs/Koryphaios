/**
 * Shared API helpers for the local desktop bearer session.
 * Automatically attaches the current Authorization header when present.
 */

import { authStore } from '$lib/stores/auth.svelte';
import { isDemoMode } from '$lib/demo-flags';
import { demoFetch } from '$lib/demo-api';
import { untrack } from 'svelte';

const DEFAULT_TIMEOUT_MS = 30_000;

/** Reactive count of in-flight API requests */
let _inflight = $state(0);
export const apiLoading = {
  get count() {
    return _inflight;
  },
  get active() {
    return _inflight > 0;
  },
};

/**
 * Hard halt flag set by the backend-health sentinel. When the backend is
 * sustained-unhealthy or version-mismatched, all `apiFetch` calls short-circuit
 * to a synthetic 503 so callers fail fast instead of queuing forever against a
 * dead backend. The frontend overlay owns turning this back off once healthy.
 */
let _halted = false;
export function setApiHalted(halted: boolean): void {
  _halted = halted;
}
export function isApiHalted(): boolean {
  return _halted;
}

export function getAuthHeaders(): Record<string, string> {
  return authStore.token ? { Authorization: authStore.token } : {};
}

export function apiFetch(
  url: string,
  init: RequestInit = {},
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<Response> {
  // API bookkeeping must never become a dependency of the caller's $effect.
  // In particular, incrementing the reactive in-flight counter inside an
  // effect made that effect depend on the counter it was itself changing.
  // Settings → Teams consequently re-ran its three status loads until Svelte
  // hit its maximum update depth and Chromium ran out of request resources.
  return untrack(() => apiFetchUntracked(url, init, timeoutMs));
}

async function apiFetchUntracked(
  url: string,
  init: RequestInit = {},
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<Response> {
  if (isDemoMode) {
    // Demo builds have no backend: answer every API call from the in-memory
    // shim so the UI stays fully interactive with zero network dependencies.
    return demoFetch(url, init);
  }
  if (_halted) {
    // Backend is down or version-mismatched: fail fast so callers don't
    // queue against a dead server. Returning a synthetic 503 keeps the
    // Response-shaped contract intact for downstream JSON parsers.
    return new Response(JSON.stringify({ ok: false, error: 'Backend unavailable' }), {
      status: 503,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // The desktop webview can survive a backend restart, but the backend's
  // in-memory local-session registry cannot. Validate the bearer before each
  // protected request so a replacement is issued through the non-error auth
  // endpoint before a route such as /api/processes can produce a browser 401.
  const authenticated = await authStore.ensureSession();
  if (!authenticated) {
    return new Response(JSON.stringify({ ok: false, error: 'Backend authentication unavailable' }), {
      status: 503,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  _inflight++;
  try {
    const headers = new Headers(init.headers);
    for (const [key, value] of Object.entries(getAuthHeaders())) {
      if (!headers.has(key)) headers.set(key, value);
    }
    try {
      const projectPath = localStorage.getItem('koryphaios-current-project');
      if (projectPath && !headers.has('X-Koryphaios-Project'))
        headers.set('X-Koryphaios-Project', projectPath);
    } catch {
      /* SSR/private storage */
    }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await fetch(url, {
        ...init,
        headers,
        credentials: 'include',
        signal: init.signal ?? controller.signal,
      });
    } finally {
      clearTimeout(timeout);
    }
  } finally {
    _inflight--;
  }
}

type LooseApiResponse = {
  ok?: boolean;
  error?: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- callers access varied response shapes without narrowing
  data?: any;
  [key: string]: any;
};

/** Parse response as JSON; on empty or invalid body return { ok: false, error } so callers don't throw. */
export async function parseJsonResponse<T = LooseApiResponse>(res: Response): Promise<T> {
  const text = await res.text();
  if (!text.trim()) {
    const message = res.ok
      ? 'Empty response from server'
      : `Request failed: ${res.status} ${res.statusText}`;
    return { ok: false, error: message } as T;
  }
  try {
    return JSON.parse(text) as T;
  } catch {
    const message = res.ok
      ? 'Invalid JSON from server'
      : `Request failed: ${res.status} ${res.statusText}`;
    return { ok: false, error: message } as T;
  }
}

import { friendlyHttpError as friendlyHttpErrorImpl } from './utils/http-error';
export { friendlyHttpErrorImpl as friendlyHttpError };
