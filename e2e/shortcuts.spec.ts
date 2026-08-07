import { test, expect } from '@playwright/test';
import { createAuthSession, injectAuthIntoPage } from './helpers/auth';

const BACKEND_URL = 'http://127.0.0.1:3011';

/**
 * Verifies that a reassigned keyboard shortcut takes effect immediately and
 * replaces its old binding.
 *
 * Uses the REAL backend for auth — no env-var gating, no skipped tests.
 */
test('a reassigned shortcut takes effect immediately and replaces its old binding', async ({
  page,
  request,
}) => {
  test.setTimeout(60_000);

  const auth = await createAuthSession(request, BACKEND_URL);
  await injectAuthIntoPage(page, auth.bearerToken);

  await page.goto('/');
  await expect(page.locator('#main-content')).not.toBeEmpty({ timeout: 30_000 });

  // Open settings via keyboard shortcut
  await page.keyboard.press('Control+,');
  await expect(page.getByText('Keyboard Shortcuts')).toBeVisible({ timeout: 10_000 });

  // Find the "Open settings" shortcut group and reassign it
  const openSettings = page.locator('.group').filter({ hasText: 'Open settings' });
  await openSettings.getByRole('button').click();

  // Press the new shortcut combo
  await page.keyboard.press('Control+Alt+O');

  // Verify the new binding is displayed
  await expect(openSettings.getByText('Ctrl')).toBeVisible();
  await expect(openSettings.getByText('Alt')).toBeVisible();
  await expect(openSettings.getByText('O')).toBeVisible();

  // Close settings
  await page.keyboard.press('Escape');
  await expect(page.getByText('Keyboard Shortcuts')).not.toBeVisible({ timeout: 5_000 });

  // The old shortcut should no longer open settings
  await page.keyboard.press('Control+,');
  await expect(page.getByText('Keyboard Shortcuts')).not.toBeVisible({ timeout: 2_000 });

  // The new shortcut should open settings
  await page.keyboard.press('Control+Alt+O');
  await expect(page.getByText('Keyboard Shortcuts')).toBeVisible({ timeout: 5_000 });
});
