import { test, expect, type Page } from '@playwright/test';
import { createAuthSession, injectAuthIntoPage } from './helpers/auth';

const models = Array.from({ length: 80 }, (_, index) => ({
  id: `model-${index + 1}`,
  name: `Test Model ${index + 1}`,
  provider: 'openai',
}));

async function openManageModels(page: Page) {
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await page.getByRole('button', { name: 'Open settings', exact: true }).dispatchEvent('click');
  const settings = page.getByRole('dialog', { name: 'Settings', exact: true });
  await expect(settings).toBeVisible();
  await settings.locator('[aria-controls="provider-details-openai"]').click({ force: true });
  await settings.getByRole('button', { name: 'Manage Models', exact: true }).click({ force: true });
  return page.getByRole('dialog', { name: 'openai Models', exact: true });
}

test.beforeEach(async ({ page, request }) => {
  const auth = await createAuthSession(request);
  await injectAuthIntoPage(page, auth.bearerToken);
  await page.route(/\/api\/providers\/available$/, (route) => route.fulfill({ json: {
    ok: true,
    data: [{ name: 'openai', authMode: 'api_key' }],
  } }));
  await page.route(/\/api\/providers(?:\?.*)?$/, (route) => route.fulfill({ json: {
    ok: true,
    data: [{
      name: 'openai', enabled: true, authenticated: true, credentialDetected: true,
      connectionState: 'verified', authMode: 'api_key',
      models: models.map((model) => model.id), allAvailableModels: models,
      selectedModels: ['model-1'], hideModelSelector: false,
    }],
  } }));
});

test('Manage Models displays a scrollable catalog and reopens reliably', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const dialog = await openManageModels(page);
  await expect(dialog).toBeVisible();
  const first = dialog.getByRole('checkbox', { name: 'Test Model 1', exact: true });
  await expect(first).toBeInViewport();
  await first.click();
  await expect(first).toHaveAttribute('aria-checked', 'false');
  const last = dialog.getByRole('checkbox', { name: 'Test Model 80', exact: true });
  await last.scrollIntoViewIfNeeded();
  await expect(last).toBeInViewport();
  const modelList = dialog.getByTestId('model-selection-list');
  const maxScrollTop = await modelList.evaluate((element) => element.scrollHeight - element.clientHeight);
  expect(maxScrollTop).toBeGreaterThan(0);
  await modelList.hover();
  await page.mouse.wheel(0, 2_000);
  await expect
    .poll(() => modelList.evaluate((element) => element.scrollTop))
    .toBeGreaterThanOrEqual(maxScrollTop - 1);
  await last.click();
  await expect(dialog.getByRole('button', { name: 'Done', exact: true })).toBeInViewport();
  await dialog.getByRole('textbox', { name: 'Search models' }).fill('Test Model 42');
  await expect(dialog.getByRole('checkbox')).toHaveCount(1);
  await expect(dialog.getByRole('checkbox')).toBeInViewport();
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(dialog).not.toBeVisible();
  await page.getByRole('button', { name: 'Manage Models', exact: true }).click();
  await expect(first).toBeInViewport();
  await expect(first).toHaveAttribute('aria-checked', 'true');
  expect(errors).toEqual([]);
});
