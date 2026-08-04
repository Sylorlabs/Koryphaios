import { expect, test } from '@playwright/test';

// Skipped in CI: requires a fully authenticated app session with providers
// configured to render the keyboard shortcuts dialog.
test.skip(Boolean(process.env.CI), 'requires interactive app session');
test('a reassigned shortcut takes effect immediately and replaces its old binding', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('#main-content')).not.toBeEmpty({ timeout: 30_000 });

  await page.keyboard.press('Control+,');
  await expect(page.getByText('Keyboard Shortcuts')).toBeVisible();

  const openSettings = page.locator('.group').filter({ hasText: 'Open settings' });
  await openSettings.getByRole('button').click();
  await page.keyboard.press('Control+Alt+O');
  await expect(openSettings.getByText('Ctrl')).toBeVisible();
  await expect(openSettings.getByText('Alt')).toBeVisible();
  await expect(openSettings.getByText('O')).toBeVisible();

  await page.keyboard.press('Escape');
  await expect(page.getByText('Keyboard Shortcuts')).not.toBeVisible();

  await page.keyboard.press('Control+,');
  await expect(page.getByText('Keyboard Shortcuts')).not.toBeVisible();

  await page.keyboard.press('Control+Alt+O');
  await expect(page.getByText('Keyboard Shortcuts')).toBeVisible();
});
