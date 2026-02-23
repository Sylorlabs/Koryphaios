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
