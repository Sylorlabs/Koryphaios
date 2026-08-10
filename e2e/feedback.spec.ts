import { test, expect } from '@playwright/test';
import { createAuthSession, injectAuthIntoPage } from './helpers/auth';

const BACKEND_URL = 'http://127.0.0.1:3011';

/**
 * Verifies the feedback dialog opens, accepts input, and attempts to open
 * a GitHub issue with the correct URL format.
 *
 * Uses the REAL backend for auth (no mock bypass) and only intercepts
 * window.open to capture the GitHub issue URL.
 */
test('submits feedback by opening a prefilled GitHub issue without a reply email', async ({
  page,
  request,
}) => {
  test.setTimeout(30_000);

  // Create a real auth session
  const auth = await createAuthSession(request, BACKEND_URL);
  await injectAuthIntoPage(page, auth.bearerToken);

  // Intercept window.open to capture the GitHub issue URL
  await page.addInitScript(() => {
    window.open = ((url?: string | URL) => {
      (window as any).__openedUrl = url == null ? '' : String(url);
      return window;
    }) as typeof window.open;
  });

  await page.goto('/');
  await expect(page.locator('#main-content')).not.toBeEmpty({ timeout: 30_000 });

  // Open the feedback dialog
  await page.getByRole('button', { name: /Feedback/ }).click();
  await expect(page.getByTestId('feedback-dialog')).toBeVisible({ timeout: 10_000 });

  // Select "Idea" type
  await page.getByRole('button', { name: 'Idea' }).click();

  // Fill in the feedback details
  await page
    .getByPlaceholder('Share the details that would help us act on this.')
    .fill('Add a compact team activity digest.');

  // Submit
  await page.getByRole('button', { name: 'Create issue' }).click();

  // Verify the GitHub issue URL was opened with the correct format
  await expect(page.getByText('Opening GitHub issue')).toBeVisible({ timeout: 10_000 });
  const openedUrl = (await page.evaluate(() => (window as any).__openedUrl)) as string;
  const issueUrl = new URL(openedUrl);
  expect(`${issueUrl.origin}${issueUrl.pathname}`).toBe(
    'https://github.com/Sylorlabs/Koryphaios/issues/new',
  );
  expect(issueUrl.searchParams.get('body')).toBe('Add a compact team activity digest.');
  expect(issueUrl.searchParams.get('title')).toContain('Add a compact team activity digest.');
  // The URL should not contain a reply email field
  expect([...issueUrl.searchParams.keys()]).not.toContain('email');
});

/**
 * Verifies the feedback dialog shows an error when the issue page cannot be opened.
 */
test('presents an in-app error when the issue page cannot be opened', async ({ page, request }) => {
  test.setTimeout(30_000);

  const auth = await createAuthSession(request, BACKEND_URL);
  await injectAuthIntoPage(page, auth.bearerToken);

  // Make window.open throw to simulate the issue page being unavailable
  await page.addInitScript(() => {
    window.open = (() => {
      throw new Error('Cannot open window');
    }) as typeof window.open;
  });

  await page.goto('/');
  await expect(page.locator('#main-content')).not.toBeEmpty({ timeout: 30_000 });

  await page.getByRole('button', { name: /Feedback/ }).click();
  await expect(page.getByTestId('feedback-dialog')).toBeVisible({ timeout: 10_000 });

  const send = page.getByRole('button', { name: 'Create issue' });
  await page.getByRole('textbox', { name: 'What should we know?' }).fill('Cannot open issue');
  await send.click();

  await expect(page.getByTestId('feedback-dialog').getByRole('alert')).toContainText(
    'Could not open GitHub to create the report',
    { timeout: 10_000 },
  );
  await expect(page.getByText('Opening GitHub issue')).not.toBeVisible();
});
