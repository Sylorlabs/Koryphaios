import { chromium } from 'playwright';

// Verifies the Devin Fast dropdown chip against the source backend on :3011,
// reached through a second Vite dev server on :3013 (KORYPHAIOS_PORT=3011).
const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1800, height: 1043 } });
const page = await context.newPage();
page.on('pageerror', (e) => console.log('[pageerror]', e.message));

await page.addInitScript(() => {
  localStorage.setItem(
    'koryphaios-onboarding-v1',
    JSON.stringify({ outcome: 'skipped', finishedAt: Date.now(), version: 1 }),
  );
  localStorage.setItem(
    'koryphaios-navigation-preferences-v1',
    JSON.stringify({ lastSessionId: 'qSeVO9t_Wg_6', sessionScope: 'project' }),
  );
});

const base = 'http://127.0.0.1:3013';
await page.goto(base, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(6000);

// Open the model picker and select Devin Claude Opus 5.5 via search.
const modelTrigger = page.locator('[data-testid="composer-model-control"] button').first();
await modelTrigger.click();
await page.getByLabel('Search quick models').fill('opus 5.5');
await page.waitForTimeout(400);
await page.getByRole('button', { name: /Claude Opus 5\.5(?! Fast)/ }).first().click();
await page.waitForTimeout(600);

// The model picker may stay open for image-admission prompts etc; close anything covering the chip.
await page.keyboard.press('Escape');
await page.mouse.click(20, 20);
await page.waitForTimeout(400);

const chip = page.getByTestId('composer-fast-control');
console.log('chip visible:', await chip.isVisible().catch(() => false));
const triggerLabel = await chip.locator('button').first().getAttribute('aria-label');
console.log('chip label:', triggerLabel);
await page.screenshot({ path: 'outputs/ui-critique/fast-chip-closed.png' });

// Open the Fast menu.
await chip.locator('button').first().click();
await page.waitForTimeout(400);
await page.screenshot({ path: 'outputs/ui-critique/fast-menu-open.png' });

// Choose On.
await page.getByRole('menuitemradio', { name: 'On' }).click();
await page.waitForTimeout(400);
await page.screenshot({ path: 'outputs/ui-critique/fast-on.png' });
console.log('after On, chip label:', await chip.locator('button').first().getAttribute('aria-label'));

// Reload and confirm the sticky default comes back On.
await page.reload({ waitUntil: 'domcontentloaded' });
await page.waitForTimeout(6000);
const chip2 = page.getByTestId('composer-fast-control');
await chip2.locator('button').first().waitFor({ state: 'visible', timeout: 15000 });
console.log('after reload, chip label:', await chip2.locator('button').first().getAttribute('aria-label'));
await page.screenshot({ path: 'outputs/ui-critique/fast-on-reloaded.png' });

await browser.close();
console.log('done');
