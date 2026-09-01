import { test, expect } from '@playwright/test';
import { createAuthSession, injectAuthIntoPage } from './helpers/auth';
import { E2E_BACKEND_URL as BACKEND_URL } from './helpers/urls';

/**
 * Image studio settings — multi-provider catalog, editing affordances, and
 * the usage/history APIs. Runs against the REAL backend with a fresh data
 * dir, so no provider is configured: the UI must stay honest about that.
 */

async function openImageSettings(page: import('@playwright/test').Page) {
  await page.goto('/');
  await expect(page.locator('#main-content')).not.toBeEmpty({ timeout: 30_000 });
  await page.keyboard.press('Control+,');
  const settingsDialog = page.getByRole('dialog', { name: 'Settings' });
  await expect(settingsDialog).toBeVisible({ timeout: 10_000 });
  await settingsDialog.getByRole('button', { name: /Image capabilities/ }).click();
  await expect(settingsDialog.getByRole('heading', { name: 'Images', exact: true })).toBeVisible();
  return settingsDialog;
}

test.describe('Image settings', () => {
  let bearerToken: string;

  test.beforeEach(async ({ page, request }) => {
    const auth = await createAuthSession(request, BACKEND_URL);
    bearerToken = auth.bearerToken;
    await injectAuthIntoPage(page, auth.bearerToken);
  });

  test('lists the provider catalog and stays disabled without credentials', async ({ page }) => {
    const dialog = await openImageSettings(page);

    await expect(dialog.getByText('Image studio')).toBeVisible();

    // Nothing is configured on a fresh install — the studio says so honestly
    // while still listing the full catalog for discoverability.
    await expect(
      dialog.getByText('No image providers available. Connect OpenAI, Google, xAI, or OpenRouter', {
        exact: false,
      }),
    ).toBeVisible();

    const providerSelect = dialog.getByRole('combobox', { name: 'Provider' });
    await expect(providerSelect).toBeVisible();
    await providerSelect.click();
    const listBox = page.getByRole('listbox', { name: 'Provider' });
    await expect(listBox.getByText('OpenAI (not connected)')).toBeVisible();
    await expect(listBox.getByText('Local endpoint (not connected)')).toBeVisible();
    await expect(listBox.getByText('LM Studio (not connected)')).toBeVisible();
    await page.keyboard.press('Escape');

    // No configured provider → no model picker and generate stays disabled
    // even with a prompt typed.
    await expect(dialog.getByRole('combobox', { name: 'Model' })).toBeDisabled();
    const promptBox = dialog.getByPlaceholder(/Describe the subject, composition/);
    await promptBox.fill('A mountain observatory');
    await expect(dialog.getByRole('button', { name: 'Generate image' })).toBeDisabled();
  });

  test('offers custom model IDs and explains editing availability', async ({ page }) => {
    const dialog = await openImageSettings(page);

    // Without configured providers the model picker is gated, and the edit
    // button explains via its tooltip that editing needs a capable model.
    const modelSelect = dialog.getByRole('combobox', { name: 'Model' });
    await expect(modelSelect).toBeDisabled();
    const editButton = dialog.getByRole('button', { name: 'Edit an image' });
    await expect(editButton).toBeDisabled();
    await expect(editButton).toHaveAttribute(
      'title',
      /Pick a model that supports editing/,
    );
  });

  test('history and usage APIs start empty on a fresh install', async ({ request }) => {
    const history = await request.get(`${BACKEND_URL}/api/images/history`, {
      headers: { Authorization: bearerToken },
    });
    expect(history.ok()).toBe(true);
    expect(((await history.json())?.data ?? []).length).toBe(0);

    const usage = await request.get(`${BACKEND_URL}/api/usage`, {
      headers: { Authorization: bearerToken },
    });
    expect(usage.ok()).toBe(true);
    const usageBody = await usage.json();
    expect(usageBody?.data?.totals?.totalCount).toBe(0);
  });
});
