import { expect, test } from '@playwright/test';

async function captureExternalOpen(page: import('@playwright/test').Page) {
  await page.addInitScript(() => {
    (window as Window & { __koryphaiosOpenedUrl?: string }).open = (url?: string | URL) => {
      (window as Window & { __koryphaiosOpenedUrl?: string }).__koryphaiosOpenedUrl = String(url);
      return null;
    };
  });
}

async function openedUrl(page: import('@playwright/test').Page): Promise<string> {
  return page.evaluate(
    () => (window as Window & { __koryphaiosOpenedUrl?: string }).__koryphaiosOpenedUrl ?? '',
  );
}

async function mockAppApi(
  page: import('@playwright/test').Page,
  feedback: (body: unknown) => {
    status: number;
    body: Record<string, unknown>;
  },
) {
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
    if (url.includes('/api/feedback')) {
      const response = feedback(route.request().postDataJSON());
      await route.fulfill({
        status: response.status,
        contentType: 'application/json',
        body: JSON.stringify(response.body),
      });
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ ok: true, data: [] }),
    });
  });
}

test('opens a reviewable public GitHub issue draft without posting feedback from the app', async ({
  page,
}) => {
  await captureExternalOpen(page);
  await mockAppApi(page, () => ({ status: 500, body: { ok: false } }));

  await page.goto('/');
  await page.getByRole('button', { name: /Feedback/ }).click();
  await page.getByRole('button', { name: 'Idea' }).click();
  await page.getByPlaceholder('A concise summary').fill('Team activity digest');
  await page
    .getByPlaceholder('Share the details that would help us act on this.')
    .fill('Add a compact team activity digest.');
  await page.getByRole('button', { name: 'Open GitHub issue' }).click();

  await expect(page.getByText('GitHub issue draft opened')).toBeVisible();
  const url = await openedUrl(page);
  expect(url).toContain('github.com/Sylorlabs/Koryphaios/issues/new');
  const issue = new URL(url);
  expect(issue.searchParams.get('title')).toBe('[idea] Team activity digest');
  const body = issue.searchParams.get('body') ?? '';
  expect(body).toContain('Add a compact team activity digest.');
  expect(body).toMatch(/## App context\n- Koryphaios version: (?!Unknown$).+/m);
  expect(body).toMatch(/- Platform: .+/);
});

test('requires a title and report before opening the public issue draft', async ({ page }) => {
  await captureExternalOpen(page);
  await mockAppApi(page, () => ({ status: 500, body: { ok: false } }));

  await page.goto('/');
  await page.getByRole('button', { name: /Feedback/ }).click();
  const send = page.getByRole('button', { name: 'Open GitHub issue' });
  await expect(send).toBeDisabled();
  await page.getByPlaceholder('A concise summary').fill('Rate limit test');
  await page.getByRole('textbox', { name: 'What should we know?' }).fill('Rate limit test');
  await send.click();

  await expect(page.getByText('GitHub issue draft opened')).toBeVisible();
  const issue = new URL(await openedUrl(page));
  expect(issue.searchParams.get('body')).toContain('Rate limit test');
  expect(issue.searchParams.get('body')).toContain('Do not include private project details');
});
