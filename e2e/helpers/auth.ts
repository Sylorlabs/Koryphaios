/**
 * E2E auth helper — establishes a real local bearer session against the
 * running backend and exposes the token for use in API calls and page
 * localStorage injection.
 *
 * This goes through the real POST /api/auth/session → GET /api/auth/me flow
 * so the actual auth codepath is exercised, not bypassed.
 */

import { expect, type APIRequestContext } from '@playwright/test';
import { E2E_BACKEND_URL } from './urls';

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
  baseUrl = E2E_BACKEND_URL,
): Promise<AuthSession> {
  // 1. Create a local session
  const sessionRes = await request.post(`${baseUrl}/api/auth/session`, {
    headers: { 'Content-Type': 'application/json' },
  });
  expect(sessionRes.ok(), `POST /api/auth/session should succeed: ${sessionRes.status()}`).toBe(
    true,
  );
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
 * Primes the page as a returning user before the app boots: the bearer token so
 * the frontend authStore picks it up on load, and the first-launch walkthrough
 * marked as already finished.
 *
 * The walkthrough seed lives here rather than in the `authenticatedPage`
 * fixture because most specs call this helper directly instead of using the
 * fixture, and every one of them needs the same page state.
 */
export async function injectAuthIntoPage(page: import('@playwright/test').Page, token: string) {
  await page.addInitScript((tokenValue) => {
    localStorage.setItem('koryphaios-local-auth-token', tokenValue);
  }, token);
  await dismissOnboarding(page);
}

/**
 * Marks the first-launch walkthrough as already finished.
 *
 * `OnboardingWalkthrough.svelte` renders a full-screen modal
 * (`data-testid="onboarding-walkthrough"`, `z-[120]`) whenever
 * `onboardingStore.shouldShow` is true, which is `isFirstLaunch()` — i.e. any
 * context with no `koryphaios-onboarding-v1` record. Playwright gives every test
 * a fresh context, so without this seed the modal covers the app and intercepts
 * pointer events, and *every* spec that clicks anything fails with
 * "… intercepts pointer events" regardless of what it is testing.
 *
 * This is not a bypass of product behaviour: these helpers already simulate a
 * returning user, and a returning user has seen the walkthrough.
 *
 * The version is deliberately far ahead of `ONBOARDING_VERSION` in
 * `frontend/src/lib/stores/onboarding.svelte.ts` (currently 1), because
 * `isFirstLaunch()` is `record.version < ONBOARDING_VERSION`. Bumping the real
 * version to re-show the walkthrough to users must not re-break the suite. The
 * constant is duplicated rather than imported: the store is a `.svelte.ts` file
 * using runes, which the Playwright transform cannot compile.
 *
 * A spec that wants to exercise the walkthrough itself should not call this (or
 * should clear the key afterwards) — `onboardingStore.replay()` also forces it
 * back on screen regardless of this record.
 */
export const ONBOARDING_SEED_VERSION = 1_000_000;

export async function dismissOnboarding(page: import('@playwright/test').Page): Promise<void> {
  await page.addInitScript((version) => {
    localStorage.setItem(
      'koryphaios-onboarding-v1',
      JSON.stringify({ outcome: 'skipped', finishedAt: Date.now(), version }),
    );
  }, ONBOARDING_SEED_VERSION);
}
