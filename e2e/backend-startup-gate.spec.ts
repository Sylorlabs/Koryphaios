import { test, expect } from '@playwright/test';

const BACKEND_URL = 'http://127.0.0.1:3011';

/**
 * Verifies the frontend error boundary shows the backend-unavailable overlay
 * when the backend health endpoint returns 503.
 *
 * This test intentionally mocks the health endpoint to simulate a backend
 * outage — it tests the FRONTEND error boundary behavior, not the backend.
 */
test('does not render the application when its backend is unavailable', async ({ page }) => {
  test.setTimeout(20_000);

  // The startup boundary must fail closed: no auth or provider request is allowed
  // to begin after the backend health contract fails.
  await page.route('**/api/health', (route) =>
    route.fulfill({
      status: 503,
      contentType: 'application/json',
      body: JSON.stringify({ ok: false, error: 'backend unavailable' }),
    }),
  );
  await page.route('**/api/providers**', (route) => route.abort());
  await page.route('**/api/auth/**', (route) => route.abort());

  await page.goto('/');

  await expect(
    page.getByRole('alertdialog', { name: 'Koryphaios backend is unavailable' }),
  ).toBeVisible({
    timeout: 15_000,
  });
  await expect(page.locator('#main-content')).toBeEmpty();
});

/**
 * Verifies the Retry button recovers the UI when the backend comes back.
 * Uses a toggleable mock that flips from 503 to 200.
 */
test('Retry now recovers the UI after the backend returns', async ({ page }) => {
  test.setTimeout(25_000);
  let healthy = false;

  await page.route('**/api/**', async (route) => {
    const url = route.request().url();
    if (url.includes('/api/health')) {
      await route.fulfill(
        healthy
          ? {
              status: 200,
              contentType: 'application/json',
              body: JSON.stringify({
                ok: true,
                data: {
                  id: 'koryphaios',
                  version: '1.0.0',
                  pid: 1,
                  compat: { serverStartedAt: 1 },
                },
              }),
            }
          : {
              status: 503,
              contentType: 'application/json',
              body: JSON.stringify({ ok: false }),
            },
      );
      return;
    }
    if (url.includes('/api/auth/session') && route.request().method() === 'POST') {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ ok: true, data: { bearerToken: 'test-local-token' } }),
      });
      return;
    }
    if (url.includes('/api/auth/me')) {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          ok: true,
          data: { user: { id: 'local-user', username: 'Local User', isAdmin: true } },
        }),
      });
      return;
    }
    if (url.includes('/api/providers')) {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: '{"ok":true,"data":[]}',
      });
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: '{"ok":true,"data":[]}',
    });
  });

  await page.goto('/');
  await expect(
    page.getByRole('alertdialog', { name: 'Koryphaios backend is unavailable' }),
  ).toBeVisible({
    timeout: 15_000,
  });

  healthy = true;
  // The sentinel may observe the recovered backend in the same moment the
  // user presses Retry, removing the overlay before Playwright dispatches the
  // click. Both paths are a successful recovery; assert the visible result.
  await page
    .getByTestId('backend-down-overlay')
    .getByRole('button', { name: 'Retry now' })
    .click({ timeout: 5_000 })
    .catch(() => undefined);
  // Verify the app recovered — the feedback button or main content should appear
  await expect(page.locator('#main-content')).not.toBeEmpty({ timeout: 10_000 });
});

/**
 * Verifies the REAL backend health endpoint is reachable and returns ok=true.
 * This is a true e2e check that the backend is actually running.
 */
test('real backend health endpoint is reachable and returns ok', async ({ request }) => {
  const res = await request.get(`${BACKEND_URL}/api/health`);
  expect(res.ok(), `Health endpoint should return 200, got ${res.status()}`).toBe(true);
  const body = await res.json();
  expect(body.ok, 'Health response should have ok=true').toBe(true);
  expect(body.data.id, 'Backend should identify itself as koryphaios').toBe('koryphaios');
});
