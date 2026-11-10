/**
 * Shared API helpers for the local desktop bearer session.
 * Automatically attaches the current Authorization header when present.
 */

import { authStore, invalidateLocalSession } from '$lib/stores/auth.svelte';
import { isDemoMode } from '$lib/demo-flags';
import { demoFetch } from '$lib/demo-api';
import { untrack } from 'svelte';
import { projectStore } from '$lib/stores/project.svelte';
import { sessionStore } from '$lib/stores/sessions.svelte';
import {
  deviceRouting,
  deviceSessionKey,
  deviceWorkbenchPath,
  isDeviceWorkbenchPath,
  mapDeviceSessionIds,
} from '$lib/stores/device-routing.svelte';
import { apiUrl } from '$lib/utils/api-url';
import { remoteRouteDescriptor } from '@koryphaios/shared';

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

  // Capture routing before authentication yields: switching chats while auth
  // refreshes must not redirect an already-started read or mutation.
  const sessionId = sessionStore.activeSessionId;
  const target = deviceRouting.chat;
  const originalUrl = new URL(
    url,
    typeof window !== 'undefined' ? window.location.origin : 'http://127.0.0.1',
  );
  const method = (init.method ?? 'GET').toUpperCase();
  const remote =
    target &&
    sessionId === deviceSessionKey(target) &&
    isDeviceWorkbenchPath(originalUrl.pathname, method);
  const session = sessionStore.sessions.find((item) => item.id === sessionId);
  // `||`, not `??`: a session with an empty workingDirectory must still fall
  // back to the selected project instead of sending no project header at all.
  const projectPath =
    target && sessionId === deviceSessionKey(target)
      ? projectStore.requestPath
      : session?.workingDirectory || projectStore.requestPath;
  const headers = new Headers(init.headers);
  if (remote) {
    headers.delete('X-Koryphaios-Project');
    headers.delete('X-Koryphaios-Session');
  }
  // Session-scoped routes resolve their workspace from the session header. Do
  // not also synthesize a raw filesystem path into an HTTP header when a
  // caller has explicitly pinned the session: Fetch's ByteString header
  // conversion rejects Unicode paths before the request reaches the backend.
  // An explicitly supplied project header remains untouched for callers that
  // intentionally need both routing dimensions.
  const callerPinnedSession = headers.has('X-Koryphaios-Session');
  if (
    !remote &&
    !callerPinnedSession &&
    !originalUrl.pathname.startsWith('/api/devices') &&
    projectPath &&
    !headers.has('X-Koryphaios-Project')
  ) {
    headers.set('X-Koryphaios-Project', projectPath);
  }
  if (
    !remote &&
    !sessionId.startsWith('linked-') &&
    !originalUrl.pathname.startsWith('/api/devices') &&
    sessionId &&
    !headers.has('X-Koryphaios-Session')
  ) {
    headers.set('X-Koryphaios-Session', sessionId);
  }

  // The desktop webview can survive a backend restart, but the backend's
  // in-memory local-session registry cannot. Validate the bearer before each
  // protected request so a replacement is issued through the non-error auth
  // endpoint before a route such as /api/processes can produce a browser 401.
  const authenticated = await authStore.ensureSession();
  if (!authenticated) {
    return new Response(
      JSON.stringify({ ok: false, error: 'Backend authentication unavailable' }),
      {
        status: 503,
        headers: { 'Content-Type': 'application/json' },
      },
    );
  }

  _inflight++;
  try {
    for (const [key, value] of Object.entries(getAuthHeaders())) {
      if (!headers.has(key)) headers.set(key, value);
    }
    // A string body without a Content-Type reaches the backend as an
    // unparsed payload, so every route that validates its body with a schema
    // rejects it with 400 "Request does not match the required schema" while
    // the caller only sees a generic failure. Default plain string bodies to
    // JSON. FormData/Blob/URLSearchParams/stream bodies are left alone because
    // the runtime sets their own (often boundary-delimited) content type.
    if (init.body != null && !headers.has('Content-Type') && typeof init.body === 'string') {
      headers.set('Content-Type', 'application/json');
    }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      let requestUrl = url;
      let requestInit = init;
      if (remote && target) {
        if (init.body != null && typeof init.body !== 'string')
          throw new Error('This device control requires a JSON request.');
        const body =
          typeof init.body === 'string'
            ? mapDeviceSessionIds(JSON.parse(init.body), target, false)
            : undefined;
        const path = deviceWorkbenchPath(originalUrl.pathname + originalUrl.search, target);
         const descriptor = remoteRouteDescriptor(originalUrl.pathname, method);
        const prompt = path === '/api/messages' && (init.method ?? 'GET').toUpperCase() === 'POST';
        const cancel =
          path === `/api/sessions/${target.id}/cancel` &&
          (init.method ?? 'GET').toUpperCase() === 'POST';
        const generationControl =
          (init.method ?? 'GET').toUpperCase() === 'POST' &&
          (path === '/api/messages/regenerate' ||
            /^\/api\/agent\/[^/]+\/message$/.test(originalUrl.pathname));
        requestUrl = apiUrl(`/api/devices/${target.deviceId}/rpc`);
        requestInit = {
          ...init,
          method: 'POST',
          body: JSON.stringify({
            operation: prompt ? 'prompt' : cancel ? 'cancel' : 'workbench',
            input: prompt
              ? { ...body, sessionId: target.id, useLocalProviders: true }
              : cancel
                ? { sessionId: target.id }
                : {
                    sessionId: target.id,
                    path,
                    method,
                    body,
                    target: {
                      kind: 'linked-device',
                      deviceId: target.deviceId,
                      sessionId: target.id,
                    },
                    ...(descriptor
                      ? { routeId: descriptor.id, capability: descriptor.capability }
                      : {}),
                    ...(generationControl ? { useLocalProviders: true } : {}),
                  },
          }),
        };
        headers.set('Content-Type', 'application/json');
      }
      let response = await fetch(requestUrl, {
        ...requestInit,
        headers,
        credentials: 'include',
        signal: init.signal ?? controller.signal,
      });
      if (remote && target && response.ok) {
        const result = await response.json();
        if (!result.ok) response = new Response(JSON.stringify(result), { status: 400 });
        else if (result.data?.body !== undefined) {
          const projected = result.data.contentType?.includes('json')
            ? JSON.stringify(mapDeviceSessionIds(JSON.parse(result.data.body), target, true))
            : result.data.body;
          response = new Response(projected, {
            status: result.data.status,
            headers: { 'Content-Type': result.data.contentType },
          });
        } else
          response = new Response(
            JSON.stringify({
              ok: result.data?.accepted !== false,
              data: result.data,
              ...(result.data?.accepted === false ? { error: 'The target chat is busy.' } : {}),
            }),
            {
              status: result.data?.accepted === false ? 409 : 200,
              headers: { 'Content-Type': 'application/json' },
            },
          );
      }
      if (response.status === 400 && projectPath) {
        try {
          const body = (await response.clone().json()) as { error?: string };
          if (body.error?.includes('selected project directory is unavailable')) {
            projectStore.markUnavailable(projectPath);
            window.dispatchEvent(
              new CustomEvent('kory-project-unavailable', { detail: { path: projectPath } }),
            );
          }
        } catch {
          // Non-JSON 400 responses are unrelated to project reconciliation.
        }
      }
      // An unexpected 401 means the backend's in-memory session registry was
      // reset (a restart, or an eviction). Drop the validated-session window so
      // the next request revalidates and mints a replacement before it goes out.
      if (response.status === 401) invalidateLocalSession();
      return response;
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
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- compatibility boundary for legacy untyped API responses
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
  } catch (err: unknown) {
    console.debug(
      'Failed to parse JSON response:',
      err instanceof Error ? err.message : String(err),
    );
    const message = res.ok
      ? 'Invalid JSON from server'
      : `Request failed: ${res.status} ${res.statusText}`;
    return { ok: false, error: message } as T;
  }
}

import { friendlyHttpError as friendlyHttpErrorImpl } from './utils/http-error';
export { friendlyHttpErrorImpl as friendlyHttpError };
