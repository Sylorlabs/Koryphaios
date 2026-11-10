import { test, expect } from '@playwright/test';
import { createAuthSession, injectAuthIntoPage } from './helpers/auth';
import { E2E_BACKEND_URL as BACKEND_URL } from './helpers/urls';

/**
 * Settings loading — the drawer lands on a populated pane and mounts the panes
 * that fetch on mount only when the user opens them.
 *
 * These specs deliberately do not gate on `#main-content`: the flattened shell
 * no longer renders that wrapper, so the older precondition never resolves.
 */

test.describe('Settings drawer loading', () => {
  test.beforeEach(async ({ page, request }) => {
    const auth = await createAuthSession(request, BACKEND_URL);
    await injectAuthIntoPage(page, auth.bearerToken);
  });

  test('lands on a populated provider pane without flashing an empty state', async ({ page }) => {
    const pageErrors: string[] = [];
    page.on('pageerror', (error) => pageErrors.push(error.message));
    page.on('console', (message) => {
      if (message.type() === 'error') pageErrors.push(message.text());
    });

    await page.goto('/');
    await page.getByRole('button', { name: 'Open settings' }).click();

    const settings = page.getByRole('dialog', { name: 'Settings' });
    await expect(settings).toBeVisible({ timeout: 10_000 });

    // The app bootstraps the provider catalog before the shell renders, so the
    // landing pane shows the real catalog rather than an empty state that is
    // then replaced.
    await expect(settings.getByText('No providers found')).toHaveCount(0);
    await expect(settings.getByRole('button', { name: /openai logo OpenAI/ })).toBeVisible({
      timeout: 15_000,
    });

    await settings.getByRole('button', { name: 'Close settings' }).click();
    await expect(settings).toBeHidden();
    expect(pageErrors).toEqual([]);
  });

  test('mounts a pane that fetches on mount when it is opened, and keeps it mounted', async ({
    page,
  }) => {
    const pageErrors: string[] = [];
    page.on('pageerror', (error) => pageErrors.push(error.message));
    page.on('console', (message) => {
      if (message.type() === 'error') pageErrors.push(message.text());
    });

    await page.goto('/');
    await page.getByRole('button', { name: 'Open settings' }).click();

    const settings = page.getByRole('dialog', { name: 'Settings' });
    await expect(settings).toBeVisible({ timeout: 10_000 });

    // Images requests its catalog on mount. Rendering every pane with the
    // drawer fired that request before the pane was ever opened.
    await expect(settings.getByRole('heading', { name: 'Images', exact: true })).toHaveCount(0);
    await settings.getByRole('button', { name: /Image capabilities/ }).click();
    await expect(settings.getByRole('heading', { name: 'Images', exact: true })).toBeVisible();

    // Leaving and returning must not rebuild the pane and repeat its work.
    await settings.getByRole('button', { name: /Providers & models/ }).click();
    await settings.getByRole('button', { name: /Image capabilities/ }).click();
    await expect(settings.getByRole('heading', { name: 'Images', exact: true })).toBeVisible();

    // Exactly one pane is un-hidden at a time: the incoming one.
    await expect(settings.locator('.settings-content > div:not(.hidden)')).toHaveCount(1);

    await settings.getByRole('button', { name: 'Close settings' }).click();
    await expect(settings).toBeHidden();
    expect(pageErrors).toEqual([]);
  });
});
