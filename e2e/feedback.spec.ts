import { expect, test } from '@playwright/test';

async function mockAppApi(
  page: import('@playwright/test').Page,
  feedback: (body: unknown) => {
    status: number;
    body: Record<string, unknown>;
  },
) {
  await page.route('**/api/**', async (route) => {
    if (route.request().url().includes('/api/feedback')) {
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

test('submits anonymous feedback without opening a mail client', async ({ page }) => {
  let submitted: Record<string, unknown> | null = null;
  await mockAppApi(page, (body) => {
    submitted = body as Record<string, unknown>;
    return { status: 200, body: { ok: true, id: 'feedback_test' } };
  });

  await page.goto('/');
  await page.getByRole('button', { name: /Feedback/ }).click();
  await page.getByRole('button', { name: 'Idea' }).click();
  await page
    .getByPlaceholder('Share the details that would help us act on this.')
    .fill('Add a compact team activity digest.');
  await page.getByRole('button', { name: 'Send feedback' }).click();

  await expect(page.getByText('Feedback delivered')).toBeVisible();
  expect(submitted).toMatchObject({
    category: 'idea',
    message: 'Add a compact team activity digest.',
  });
  expect(submitted).not.toHaveProperty('email');
});

test('honors diagnostic consent and presents delivery errors in-app', async ({ page }) => {
  let submitted: Record<string, unknown> | null = null;
  await mockAppApi(page, (body) => {
    submitted = body as Record<string, unknown>;
    return {
      status: 429,
      body: { ok: false, error: 'Too many feedback reports. Please try again later.' },
    };
  });

  await page.goto('/');
  await page.getByRole('button', { name: /Feedback/ }).click();
  const send = page.getByRole('button', { name: 'Send feedback' });
  await expect(send).toBeDisabled();
  await page.getByRole('switch', { name: /Include basic diagnostics/ }).click();
  await page.getByRole('textbox', { name: 'What should we know?' }).fill('Rate limit test');
  await send.click();

  await expect(page.getByRole('alert')).toContainText('Too many feedback reports');
  expect(submitted).not.toHaveProperty('platform');
  expect(submitted).not.toHaveProperty('context');
});
