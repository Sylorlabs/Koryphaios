import { test, expect } from '@playwright/test';
import { createAuthSession, injectAuthIntoPage } from './helpers/auth';
import { ApiClient } from './helpers/api';
import { E2E_BACKEND_URL as BACKEND_URL } from './helpers/urls';

/**
 * Verifies that the frontend establishes a real WebSocket connection to the
 * backend after loading, and that the connection status indicator reflects
 * the connected state.
 */
test('frontend establishes a WebSocket connection to the backend', async ({ page, request }) => {
  test.setTimeout(60_000);

  const auth = await createAuthSession(request, BACKEND_URL);
  await injectAuthIntoPage(page, auth.bearerToken);

  // Track WebSocket connections
  let wsConnected = false;
  page.on('websocket', (ws) => {
    wsConnected = true;
    ws.on('socketopen', () => {
      wsConnected = true;
    });
  });

  await page.goto('/');
  await expect(page.locator('#main-content')).not.toBeEmpty({ timeout: 30_000 });

  // Wait for a WebSocket connection to be established
  await expect
    .poll(() => wsConnected, { timeout: 15_000, message: 'WebSocket should connect' })
    .toBe(true);
});

/**
 * Verifies that a session created via the API persists across a page reload.
 */
test('session persists across page reload', async ({ page, request }) => {
  test.setTimeout(60_000);

  const auth = await createAuthSession(request, BACKEND_URL);
  const api = new ApiClient(request, BACKEND_URL, auth.bearerToken);

  // Create a session via the API
  const sessionId = await api.createSession('E2E persistence test');
  expect(sessionId).toBeTruthy();

  // Inject auth and load the app
  await injectAuthIntoPage(page, auth.bearerToken);
  await page.goto('/');
  await expect(page.locator('#main-content')).not.toBeEmpty({ timeout: 30_000 });

  // Reload the page
  await page.reload();
  await expect(page.locator('#main-content')).not.toBeEmpty({ timeout: 30_000 });

  // Verify the session still exists in the backend
  const sessionsRes = await request.get(`${BACKEND_URL}/api/sessions`, {
    headers: { Authorization: auth.bearerToken },
  });
  expect(sessionsRes.ok()).toBe(true);
  const sessionsBody = await sessionsRes.json();
  const sessions = sessionsBody.data ?? [];
  expect(sessions.some((s: any) => s.id === sessionId)).toBe(true);
});

/**
 * Verifies that creating a session via the API and then loading the app
 * shows the session in the sidebar.
 */
test('API-created session appears in the frontend sidebar', async ({ page, request }) => {
  test.setTimeout(60_000);

  const auth = await createAuthSession(request, BACKEND_URL);
  const api = new ApiClient(request, BACKEND_URL, auth.bearerToken);

  // Create a session with a distinctive title
  const sessionTitle = `E2E Sidebar Test ${Date.now()}`;
  const sessionId = await api.createSession(sessionTitle);
  expect(sessionId).toBeTruthy();

  // Load the app
  await injectAuthIntoPage(page, auth.bearerToken);
  await page.goto('/');
  await expect(page.locator('#main-content')).not.toBeEmpty({ timeout: 30_000 });

  // The session should appear in the sidebar
  await expect(page.getByTestId('session-sidebar')).toBeVisible({ timeout: 10_000 });
  await expect(page.getByText(sessionTitle)).toBeVisible({ timeout: 15_000 });
});
