/**
 * Shared API helpers — cookie-based auth (credentials: 'include').
 * No tokens in JS; session is in HttpOnly cookies.
 */

const DEFAULT_TIMEOUT_MS = 30_000;

/** Reactive count of in-flight API requests */
let _inflight = $state(0);
export const apiLoading = {
  get count() { return _inflight; },
  get active() { return _inflight > 0; },
};

export function getAuthHeaders(): Record<string, string> {
  return {};
}

export async function apiFetch(
  url: string,
  init: RequestInit = {},
  timeoutMs: number = DEFAULT_TIMEOUT_MS
): Promise<Response> {
  _inflight++;
  try {
    const headers = new Headers(init.headers);
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
export async function parseJsonResponse<T = LooseApiResponse>(
  res: Response
): Promise<T> {
  const text = await res.text();
  if (!text.trim()) {
    const message = res.ok ? 'Empty response from server' : `Request failed: ${res.status} ${res.statusText}`;
    return { ok: false, error: message } as T;
  }
  try {
    return JSON.parse(text) as T;
  } catch {
    const message = res.ok ? 'Invalid JSON from server' : `Request failed: ${res.status} ${res.statusText}`;
    return { ok: false, error: message } as T;
  }
}

/** Map HTTP status codes to user-friendly messages */
export function friendlyHttpError(status: number, action: string): string {
  switch (status) {
    case 401: return `Please sign in to ${action}`;
    case 403: return `You don't have permission to ${action}`;
    case 404: return `Could not find the requested resource`;
    case 429: return `Too many requests — please wait a moment`;
    case 500: case 502: case 503:
      return `Server error — please try again shortly`;
    default: return `Something went wrong (${status})`;
  }
}
