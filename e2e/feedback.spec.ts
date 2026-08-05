import { expect, test } from '@playwright/test';

test('submits feedback by opening a prefilled GitHub issue without a reply email', async ({
  page,
}) => {
  await page.route('**/api/**', async (route) => {
    const url = route.request().url();
    if (url.includes('/api/health')) {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          ok: true,
          data: { id: 'koryphaios', version: '1.0.0', pid: 1, compat: { serverStartedAt: 1 } },
        }),
      });
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
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ ok: true, data: [] }),
    });
  });

  await page.goto('/');
  await page.addInitScript(() => {
    window.open = ((url?: string | URL) => {
      (window as any).__openedUrl = url == null ? '' : String(url);
      return null;
    }) as typeof window.open;
  });
  await page.getByRole('button', { name: /Feedback/ }).click();
  await page.getByRole('button', { name: 'Idea' }).click();
  await page
    .getByPlaceholder('Share the details that would help us act on this.')
    .fill('Add a compact team activity digest.');
  await page.getByRole('button', { name: 'Create issue' }).click();

  await expect(page.getByText('Opening GitHub issue')).toBeVisible();
  const openedUrl = (await page.evaluate(() => (window as any).__openedUrl)) as string;
  expect(openedUrl).toContain('https://github.com/Sylorlabs/Koryphaios/issues/new');
  expect(openedUrl).toContain('Add a compact team activity digest.');
  expect(openedUrl).not.toContain('email');
});

test('presents an in-app error when the issue page cannot be opened', async ({ page }) => {
  await page.route('**/api/**', async (route) => {
    const url = route.request().url();
    if (url.includes('/api/health')) {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          ok: true,
          data: { id: 'koryphaios', version: '1.0.0', pid: 1, compat: { serverStartedAt: 1 } },
        }),
      });
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
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ ok: true, data: [] }),
    });
  });

  await page.goto('/');
  await page.getByRole('button', { name: /Feedback/ }).click();
  const send = page.getByRole('button', { name: 'Create issue' });
  await page.getByRole('textbox', { name: 'What should we know?' }).fill('Cannot open issue');
  await send.click();

  await expect(page.getByText('Opening GitHub issue')).toBeVisible();
});
