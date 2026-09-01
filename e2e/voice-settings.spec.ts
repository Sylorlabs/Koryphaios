import { test, expect } from '@playwright/test';
import { createAuthSession, injectAuthIntoPage } from './helpers/auth';
import { E2E_BACKEND_URL as BACKEND_URL } from './helpers/urls';

/**
 * Voice settings — multi-provider speech input/output catalog with local
 * endpoint support. Runs against the REAL backend with a fresh data dir, so
 * only the system providers are available out of the box.
 */

async function openVoiceSettings(page: import('@playwright/test').Page) {
  await page.goto('/');
  await expect(page.locator('#main-content')).not.toBeEmpty({ timeout: 30_000 });
  await page.keyboard.press('Control+,');
  const settingsDialog = page.getByRole('dialog', { name: 'Settings' });
  await expect(settingsDialog).toBeVisible({ timeout: 10_000 });
  await settingsDialog.getByRole('button', { name: /Voice/ }).click();
  await expect(
    settingsDialog.locator('header').getByRole('heading', { name: 'Voice', exact: true }),
  ).toBeVisible();
  return settingsDialog;
}

test.describe('Voice settings', () => {
  test.beforeEach(async ({ page, request }) => {
    const auth = await createAuthSession(request, BACKEND_URL);
    await injectAuthIntoPage(page, auth.bearerToken);
  });

  test('exposes speech-to-text and text-to-speech provider catalogs', async ({ page }) => {
    const dialog = await openVoiceSettings(page);

    await expect(dialog.getByRole('heading', { name: 'Speech to text' })).toBeVisible();
    await expect(dialog.getByRole('heading', { name: 'Text to speech' })).toBeVisible();

    // Dropdowns only offer usable providers: system plus configured ones.
    // With no credentials on a fresh install, cloud providers stay hidden.
    const inputProvider = dialog.getByRole('combobox', { name: 'Transcription provider' });
    await expect(inputProvider).toBeVisible();
    await inputProvider.click();
    const inputList = page.getByRole('listbox', { name: 'Transcription provider' });
    await expect(inputList.getByText('Browser / operating system')).toBeVisible();
    await expect(inputList.getByText('OpenAI Audio')).toBeHidden();
    await expect(inputList.getByText('Deepgram')).toBeHidden();
    await page.keyboard.press('Escape');

    const outputProvider = dialog.getByRole('combobox', { name: 'Speech provider' });
    await expect(outputProvider).toBeVisible();
    await outputProvider.click();
    const outputList = page.getByRole('listbox', { name: 'Speech provider' });
    await expect(outputList.getByText('OpenAI Audio')).toBeHidden();
    await expect(outputList.getByText('Groq Audio')).toBeHidden();
    await page.keyboard.press('Escape');

    await expect(dialog.getByRole('combobox', { name: 'Voice' })).toBeVisible();
    await expect(dialog.getByText('System default')).toBeVisible();
  });

  test('guides local model setup without downloaded-pack claims', async ({ page }) => {
    const dialog = await openVoiceSettings(page);

    await expect(dialog.getByRole('heading', { name: 'Run local speech models' })).toBeVisible();
    await expect(dialog.getByText('Audio stays on your machine', { exact: false })).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'Save voice settings' })).toBeVisible();
  });
});
