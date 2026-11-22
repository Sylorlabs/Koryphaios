import { chromium } from 'playwright';

// Model-settings panel cleanup + collapsed-chip spacing, against :3003.
const browser = await chromium.launch();

async function boot(width = 1800, height = 1043) {
  const context = await browser.newContext({ viewport: { width, height } });
  const page = await context.newPage();
  page.on('pageerror', (e) => console.log('[pageerror]', e.message));
  await page.addInitScript(() => {
    localStorage.setItem('koryphaios-onboarding-v1', JSON.stringify({ outcome: 'skipped', finishedAt: Date.now(), version: 1 }));
    localStorage.setItem('koryphaios-navigation-preferences-v1', JSON.stringify({ lastSessionId: 'qSeVO9t_Wg_6', sessionScope: 'project' }));
  });
  await page.goto('http://127.0.0.1:3003', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(8000);
  return { context, page };
}

async function pickModel(page, search, nameRe) {
  await page.locator('[data-testid="composer-model-control"] button').first().click();
  await page.waitForTimeout(400);
  await page.getByLabel('Search quick models').fill(search);
  await page.waitForTimeout(900);
  await page.getByRole('button', { name: nameRe }).first().click();
  await page.waitForTimeout(800);
  const noImg = page.getByRole('button', { name: /Continue without images/ });
  if (await noImg.isVisible().catch(() => false)) {
    await noImg.click();
    await page.waitForTimeout(500);
  }
  await page.keyboard.press('Escape');
  await page.mouse.click(20, 20);
  await page.waitForTimeout(400);
}

// --- Wide: params panel open on mancer/weaver ---
{
  const { context, page } = await boot();
  await pickModel(page, 'weaver', /weaver/i);
  const chip = page.getByTestId('composer-model-params-control');
  await chip.waitFor({ state: 'visible', timeout: 15000 });
  await chip.locator('button').first().click();
  const panel = page.getByRole('dialog');
  await panel.waitFor({ state: 'visible', timeout: 8000 });
  console.log('panel rows:', await panel.locator('[role=slider]').count(), 'sliders;',
    await panel.locator('[role=spinbutton]').count(), 'steppers;',
    await panel.locator('[role=radiogroup]').count(), 'enum groups');
  // One override via keyboard End on the Temperature slider → badge 1.
  const temp = panel.getByRole('slider', { name: 'Temperature' });
  if (await temp.count()) await temp.press('End');
  await page.waitForTimeout(900);
  await page.screenshot({ path: 'outputs/ui-critique/params-panel-clean.png' });
  await page.keyboard.press('Escape');
  await page.mouse.click(20, 20);
  await page.waitForTimeout(400);

  // Fusion slot-1 chip with Fast on.
  await pickModel(page, 'fusion', /^Fusion Two models/);
  const slot1 = page.getByTestId('fusion-slot-1');
  await slot1.waitFor({ state: 'visible', timeout: 15000 });
  await slot1.locator('button').first().click();
  const d1 = slot1.getByRole('dialog');
  await d1.waitFor({ state: 'visible', timeout: 8000 });
  await d1.getByRole('menuitemradio', { name: /Claude Fable 5\.2/ }).click();
  await page.waitForTimeout(400);
  await d1.getByRole('radiogroup', { name: 'Fusion 1 Fast' }).getByRole('radio', { name: 'On' }).click();
  await page.waitForTimeout(900);
  await page.keyboard.press('Escape');
  await page.mouse.click(20, 20);
  await page.waitForTimeout(500);
  await slot1.screenshot({ path: 'outputs/ui-critique/fusion-slot1-fast.png' });
  console.log('slot1 chip:', (await slot1.textContent()).trim());
  await context.close();
}

// --- Narrow: collapsed params chip with badge ---
{
  const { context, page } = await boot(560, 900);
  await pickModel(page, 'weaver', /weaver/i);
  const chip = page.getByTestId('composer-model-params-control');
  await chip.waitFor({ state: 'visible', timeout: 15000 });
  await chip.locator('button').first().click();
  const panel = page.getByRole('dialog');
  await panel.waitFor({ state: 'visible', timeout: 8000 });
  const temp = panel.getByRole('slider', { name: 'Temperature' });
  if (await temp.count()) await temp.press('End');
  await page.waitForTimeout(500);
  await page.keyboard.press('Escape');
  await page.mouse.click(20, 20);
  await page.waitForTimeout(900);
  const row = page.locator('.composer-config-row').last();
  await row.screenshot({ path: 'outputs/ui-critique/params-chip-collapsed.png' });
  console.log('narrow chip text:', JSON.stringify((await chip.textContent())?.trim()));
  await context.close();
}

await browser.close();
console.log('done');
