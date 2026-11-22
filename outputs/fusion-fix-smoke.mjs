import { chromium } from 'playwright';

// Fusion visual-fix verification against :3003 (HMR dev frontend on :3001).
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
  await page.waitForTimeout(800);
  await page.getByRole('button', { name: nameRe }).first().click();
  await page.waitForTimeout(700);
  // Chats containing images trigger the image-support consent dialog for a
  // model that reports no image transport — accept text-only and continue.
  const noImg = page.getByRole('button', { name: /Continue without images/ });
  if (await noImg.isVisible().catch(() => false)) {
    await noImg.click();
    await page.waitForTimeout(500);
  }
  await page.keyboard.press('Escape');
  await page.mouse.click(20, 20);
  await page.waitForTimeout(400);
}

async function openSlot(page, n) {
  const chip = page.getByTestId(`fusion-slot-${n}`);
  await chip.locator('button').first().click();
  const dialog = chip.getByRole('dialog');
  await dialog.waitFor({ state: 'visible', timeout: 8000 });
  await page.waitForTimeout(300);
  return dialog;
}

// --- Run 1: full width, auto-adjust note + toast, dimmed slot 2 ---
{
  const { context, page } = await boot();
  await pickModel(page, 'fusion', /^Fusion Two models/);
  await page.getByTestId('fusion-slot-1').waitFor({ state: 'visible', timeout: 15000 });

  const d1 = await openSlot(page, 1);
  await d1.getByRole('menuitemradio', { name: /Claude Fable 5\.2/ }).click();
  await page.waitForTimeout(400);
  await d1.getByRole('radiogroup', { name: 'Fusion 1 Fast' }).getByRole('radio', { name: 'On' }).click();
  // Let the state flush and both compositor layers repaint before shooting;
  // the toast lives long enough to still be visible.
  await page.waitForTimeout(900);
  const onRadio = d1.getByRole('radio', { name: 'On' });
  console.log('On aria-checked:', await onRadio.getAttribute('aria-checked'));
  console.log('Off aria-checked:', await d1.getByRole('radio', { name: 'Off' }).getAttribute('aria-checked'));
  await page.screenshot({ path: 'outputs/ui-critique/fusion-auto-adjust.png' });
  await page.keyboard.press('Escape');
  await page.mouse.click(20, 20);
  await page.waitForTimeout(300);

  const d2 = await openSlot(page, 2);
  await page.screenshot({ path: 'outputs/ui-critique/fusion-slot2-dimmed.png' });
  console.log('slot2 chip:', (await page.getByTestId('fusion-slot-2').textContent()).trim());
  await context.close();
}

// --- Run 2: narrow width, collapsed slot chips ---
{
  const { context, page } = await boot(620, 900);
  await pickModel(page, 'fusion', /^Fusion Two models/);
  await page.getByTestId('fusion-slot-1').waitFor({ state: 'visible', timeout: 15000 });
  await page.waitForTimeout(800);
  const chip = page.locator('.composer-config-row').last();
  await chip.screenshot({ path: 'outputs/ui-critique/fusion-collapsed.png' });
  await page.screenshot({ path: 'outputs/ui-critique/fusion-collapsed-full.png' });
  console.log('narrow slot1 text:', (await page.getByTestId('fusion-slot-1').textContent()).trim());
  await context.close();
}

await browser.close();
console.log('done');
