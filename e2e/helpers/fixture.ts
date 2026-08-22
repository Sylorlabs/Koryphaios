/**
 * E2E test fixture — provides authenticated API client and page setup.
 *
 * Usage in specs:
 *   import { test, expect } from './helpers/fixture';
 *   test('my test', async ({ page, api, auth }) => { ... });
 */

import { test as base, expect, type APIRequestContext, type Page } from '@playwright/test';
import { createAuthSession, injectAuthIntoPage, type AuthSession } from './auth';
import { ApiClient } from './api';
import { E2E_BACKEND_URL as BACKEND_URL } from './urls';

interface E2EFixtures {
  auth: AuthSession;
  api: ApiClient;
  authenticatedPage: Page;
}

/**
 * Extended test fixture that provides:
 * - `auth`: a real AuthSession (bearer token + user) created via the backend API
 * - `api`: an authenticated ApiClient for direct backend calls
 * - `authenticatedPage`: a Page with the auth token pre-injected into localStorage
 */
export const test = base.extend<E2EFixtures>({
  auth: async ({ request }, use) => {
    const session = await createAuthSession(request, BACKEND_URL);
    await use(session);
  },
  api: async ({ request, auth }, use) => {
    const client = new ApiClient(request, BACKEND_URL, auth.bearerToken);
    await use(client);
  },
  authenticatedPage: async ({ page, auth }, use) => {
    await injectAuthIntoPage(page, auth.bearerToken);
    await use(page);
  },
});

export { expect };
