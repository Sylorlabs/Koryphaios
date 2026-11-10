import { test, expect } from '@playwright/test';
import { createAuthSession, injectAuthIntoPage } from './helpers/auth';
import { E2E_BACKEND_URL as BACKEND_URL } from './helpers/urls';
import { chordLabel } from './helpers/shortcut-labels';

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
  await page.keyboard.press('ControlOrMeta+,');
  const settingsDialog = page.getByRole('dialog', { name: 'Settings' });
  await expect(settingsDialog).toBeVisible({ timeout: 10_000 });
  await settingsDialog.getByRole('button', { name: 'Keyboard shortcuts This device' }).click();
  const shortcutsHeading = settingsDialog.getByRole('heading', {
    name: 'Keyboard Shortcuts',
    exact: true,
  });
  await expect(shortcutsHeading).toBeVisible({ timeout: 10_000 });

  // Find the "Open settings" shortcut group and reassign it
  const openSettings = settingsDialog.locator('.group').filter({ hasText: 'Open settings' });
  await openSettings.getByRole('button').click();

  // Press the new shortcut combo
  await page.keyboard.press('Control+Alt+O');

  // Verify the new binding is displayed
  await expect(
    openSettings.getByRole('button', { name: chordLabel('Ctrl', 'Alt', 'O') }),
  ).toBeVisible();

  // Close settings
  await page.keyboard.press('Escape');
  await expect(shortcutsHeading).not.toBeVisible({ timeout: 5_000 });

  // The old shortcut should no longer open settings
  await page.keyboard.press('ControlOrMeta+,');
  await expect(shortcutsHeading).not.toBeVisible({ timeout: 2_000 });

  // The new shortcut should open settings
  await page.keyboard.press('Control+Alt+O');
  await expect(shortcutsHeading).toBeVisible({ timeout: 5_000 });
});

test('voice mode ships a default toggle binding in the shortcuts list', async ({
  page,
  request,
}) => {
  test.setTimeout(60_000);

  const auth = await createAuthSession(request, BACKEND_URL);
  await injectAuthIntoPage(page, auth.bearerToken);

  await page.goto('/');
  await expect(page.locator('#main-content')).not.toBeEmpty({ timeout: 30_000 });

  await page.keyboard.press('ControlOrMeta+,');
  const settingsDialog = page.getByRole('dialog', { name: 'Settings' });
  await expect(settingsDialog).toBeVisible({ timeout: 10_000 });
  await settingsDialog.getByRole('button', { name: 'Keyboard shortcuts This device' }).click();

  const voiceMode = settingsDialog.locator('[data-shortcut-id="voice_mode"]');
  await expect(voiceMode).toBeVisible();
  // Control+Space is the default on every platform: a literal Command would be
  // Spotlight on macOS and could never reach the composer.
  await expect(voiceMode.getByRole('button', { name: chordLabel('Ctrl', ' ') })).toBeVisible();
  await expect(voiceMode).not.toContainText(/Ctrl\s*\+\s*Shift\s*\+\s*M|⌘\s*\+\s*Shift\s*\+\s*M/);
  await expect(voiceMode).toContainText(/press to record/i);
  await expect(voiceMode).not.toContainText(/hold to record/i);
});

test('the voice mode binding can be reassigned and the old chord stops firing', async ({
  page,
  request,
}) => {
  test.setTimeout(60_000);

  const auth = await createAuthSession(request, BACKEND_URL);
  await injectAuthIntoPage(page, auth.bearerToken);

  await page.goto('/');
  await expect(page.locator('#main-content')).not.toBeEmpty({ timeout: 30_000 });

  await page.keyboard.press('ControlOrMeta+,');
  const settingsDialog = page.getByRole('dialog', { name: 'Settings' });
  await expect(settingsDialog).toBeVisible({ timeout: 10_000 });
  await settingsDialog.getByRole('button', { name: 'Keyboard shortcuts This device' }).click();

  const voiceMode = settingsDialog.locator('[data-shortcut-id="voice_mode"]');
  await voiceMode.getByRole('button').click();
  await page.keyboard.press('Control+Alt+G');
  await expect(
    voiceMode.getByRole('button', { name: chordLabel('Ctrl', 'Alt', 'G') }),
  ).toBeVisible();
});
