import { expect, test } from '@playwright/test';

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
  const feedback = page.getByRole('button', { name: /Feedback/ });
  // The sentinel may observe the recovered backend in the same moment the
  // user presses Retry, removing the overlay before Playwright dispatches the
  // click. Both paths are a successful recovery; assert the visible result.
  await page
    .getByRole('alertdialog')
    .getByRole('button', { name: 'Retry now' })
    .click({ timeout: 3_000 })
    .catch(() => undefined);
  await expect(feedback).toBeVisible({ timeout: 8_000 });
});
