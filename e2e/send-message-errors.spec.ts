import { test, expect } from '@playwright/test';
import { createAuthSession, injectAuthIntoPage } from './helpers/auth';
import { ApiClient } from './helpers/api';
import { E2E_BACKEND_URL as BACKEND_URL } from './helpers/urls';

/**
 * Verifies that sending a message through the real backend produces no
 * backend errors, no 5xx responses, and no unhandled console errors.
 *
 * This is a REAL e2e test: it creates a real auth session, creates a real
 * session via the API, sends a real message, and verifies the response.
 * No mocks, no bypasses, no arbitrary sleeps.
 */
test('sending a message through the real backend produces no errors', async ({ page, request }) => {
  test.setTimeout(60_000);

  // ─── 1. Create a real auth session ──────────────────────────────────────
  const auth = await createAuthSession(request, BACKEND_URL);
  expect(auth.bearerToken).toBeTruthy();
  expect(auth.user.id).toBe('local-user');

  // ─── 2. Inject auth into the page and load the app ──────────────────────
  await injectAuthIntoPage(page, auth.bearerToken);
  await page.goto('/');

  // Wait for the app to render (real content, not loading state)
  await expect(page.locator('#main-content')).not.toBeEmpty({ timeout: 30_000 });

  // ─── 3. Collect console errors and network failures ─────────────────────
  const consoleErrors: string[] = [];
  const networkFailures: string[] = [];
  const serverErrors: string[] = [];

  page.on('console', (msg) => {
    if (msg.type() === 'error') {
      consoleErrors.push(msg.text());
    }
  });

  page.on('requestfailed', (req) => {
    // Ignore favicon and source map failures
    const url = req.url();
    if (!url.includes('favicon') && !url.endsWith('.map')) {
      networkFailures.push(`${req.method()} ${url}: ${req.failure()?.errorText ?? 'unknown'}`);
    }
  });

  page.on('response', (res) => {
    if (res.status() >= 500) {
      serverErrors.push(`HTTP ${res.status()} ${res.request().method()} ${res.url()}`);
    }
  });

  // ─── 4. Create a session and send a message via the API ─────────────────
  const api = new ApiClient(request, BACKEND_URL, auth.bearerToken);

  const sessionId = await api.createSession('E2E message test');
  expect(sessionId).toBeTruthy();

  const sendRes = await api.sendMessage(
    sessionId,
    'Hello, this is a test message from Playwright e2e.',
  );
  expect(sendRes.ok(), `POST /api/messages should succeed: ${sendRes.status()}`).toBe(true);

  // ─── 5. Verify the message was persisted ────────────────────────────────
  const messages = await api.getMessages(sessionId);
  expect(messages.data).toBeDefined();
  expect(Array.isArray(messages.data)).toBe(true);
  // The message should appear in the session's message history
  const userMessages = (messages.data as any[]).filter((m) => m.role === 'user');
  expect(userMessages.length).toBeGreaterThan(0);
  expect(userMessages.some((m) => m.content?.includes('test message from Playwright e2e'))).toBe(
    true,
  );

  // ─── 6. Verify backend health after the message ─────────────────────────
  const health = await api.health();
  expect(health.ok).toBe(true);

  // ─── 7. Assert zero tolerance for errors ────────────────────────────────
  // Filter out known-benign patterns (favicon, source maps, Tauri internals)
  const benignPatterns = [
    /favicon/i,
    /\.map$/i,
    /__TAURI/i,
    /websocket.*close/i,
    /\/api\/auth\/me.*401/i,
  ];
  const realConsoleErrors = consoleErrors.filter(
    (text) => !benignPatterns.some((re) => re.test(text)),
  );

  expect(realConsoleErrors, `Console errors: ${realConsoleErrors.join('; ')}`).toEqual([]);
  expect(networkFailures, `Network failures: ${networkFailures.join('; ')}`).toEqual([]);
  expect(serverErrors, `Server errors: ${serverErrors.join('; ')}`).toEqual([]);
});

/**
 * Verifies that the backend health endpoint returns a valid response
 * with the expected contract fields.
 */
test('backend health endpoint returns a valid contract', async ({ request }) => {
  const res = await request.get(`${BACKEND_URL}/api/health`);
  expect(res.ok()).toBe(true);
  const body = await res.json();
  expect(body.ok).toBe(true);
  expect(body.data).toBeDefined();
  expect(body.data.id).toBe('koryphaios');
  expect(body.data.version).toBeDefined();
  expect(body.data.pid).toBeDefined();
  expect(body.data.compat).toBeDefined();
  expect(body.data.compat.serverStartedAt).toBeDefined();
});

/**
 * Verifies that the auth session lifecycle works end-to-end:
 * create session → validate token → use protected endpoint → logout.
 */
test('auth session lifecycle works end-to-end', async ({ request }) => {
  // 1. Create a session
  const sessionRes = await request.post(`${BACKEND_URL}/api/auth/session`, {
    headers: { 'Content-Type': 'application/json' },
  });
  expect(sessionRes.ok()).toBe(true);
  const sessionBody = await sessionRes.json();
  const token = sessionBody.data.bearerToken;
  expect(token).toBeTruthy();

  // 2. Validate the token
  const meRes = await request.get(`${BACKEND_URL}/api/auth/me`, {
    headers: { Authorization: token },
  });
  expect(meRes.ok()).toBe(true);
  const meBody = await meRes.json();
  expect(meBody.data.user).toBeTruthy();
  expect(meBody.data.user.id).toBe('local-user');

  // 3. Use a protected endpoint
  const providersRes = await request.get(`${BACKEND_URL}/api/providers`, {
    headers: { Authorization: token },
  });
  expect(providersRes.ok()).toBe(true);

  // 4. Logout
  const logoutRes = await request.delete(`${BACKEND_URL}/api/auth/session`, {
    headers: { Authorization: token },
  });
  expect(logoutRes.ok()).toBe(true);

  // 5. Verify the token is now invalid
  const postLogoutRes = await request.get(`${BACKEND_URL}/api/auth/me`, {
    headers: { Authorization: token },
  });
  const postLogoutBody = await postLogoutRes.json();
  expect(postLogoutBody.data.user).toBeNull();
});
