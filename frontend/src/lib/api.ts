/**
 * Shared API helpers — cookie-based auth (credentials: 'include').
 * No tokens in JS; session is in HttpOnly cookies.
 */

export function getAuthHeaders(): Record<string, string> {
  return {};
}

export async function apiFetch(
  url: string,
  init: RequestInit = {}
): Promise<Response> {
  const headers = new Headers(init.headers);
  return fetch(url, { ...init, headers, credentials: 'include' });
}

type LooseApiResponse = {
  ok?: boolean;
  error?: string;
  data?: any;
  [key: string]: any;
};

/** Parse response as JSON; on empty or invalid body return { ok: false, error: message } so callers don't throw. */
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
