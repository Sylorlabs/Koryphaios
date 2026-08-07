/**
 * E2E auth helper — establishes a real local bearer session against the
 * running backend and exposes the token for use in API calls and page
 * localStorage injection.
 *
 * This goes through the real POST /api/auth/session → GET /api/auth/me flow
 * so the actual auth codepath is exercised, not bypassed.
 */

import { expect, type APIRequestContext } from '@playwright/test';

export interface AuthSession {
  bearerToken: string;
  user: {
    id: string;
    username: string;
    isAdmin: boolean;
  };
}

/**
 * Creates a real local auth session via the backend API.
 * Returns the bearer token and validated user.
 */
export async function createAuthSession(
  request: APIRequestContext,
  baseUrl = 'http://127.0.0.1:3011',
): Promise<AuthSession> {
  // 1. Create a local session
  const sessionRes = await request.post(`${baseUrl}/api/auth/session`, {
    headers: { 'Content-Type': 'application/json' },
  });
  expect(sessionRes.ok(), `POST /api/auth/session should succeed: ${sessionRes.status()}`).toBe(true);
  const sessionBody = await sessionRes.json();
  const bearerToken = sessionBody?.data?.bearerToken;
  expect(bearerToken, 'Session response should contain a bearer token').toBeTruthy();

  // 2. Validate the token via /api/auth/me
  const meRes = await request.get(`${baseUrl}/api/auth/me`, {
    headers: { Authorization: bearerToken },
  });
  expect(meRes.ok(), `GET /api/auth/me should succeed: ${meRes.status()}`).toBe(true);
  const meBody = await meRes.json();
  const user = meBody?.data?.user;
  expect(user, 'Auth/me should return a user object').toBeTruthy();
  expect(user.id, 'User should have an id').toBeTruthy();

  return { bearerToken, user };
}

/**
 * Injects the bearer token into the page's localStorage so the frontend
 * authStore picks it up on load, simulating a returning user.
 */
export async function injectAuthIntoPage(page: import('@playwright/test').Page, token: string) {
  await page.addInitScript((tokenValue) => {
    localStorage.setItem('koryphaios-local-auth-token', tokenValue);
  }, token);
}
