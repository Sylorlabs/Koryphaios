import { chromium } from 'playwright';

// Fusion slots verification: backend :3011, Vite :3013.
const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1800, height: 1043 } });
const page = await context.newPage();
page.on('pageerror', (e) => console.log('[pageerror]', e.message));

await page.addInitScript(() => {
  localStorage.setItem('koryphaios-onboarding-v1', JSON.stringify({ outcome: 'skipped', finishedAt: Date.now(), version: 1 }));
  localStorage.setItem('koryphaios-navigation-preferences-v1', JSON.stringify({ lastSessionId: 'qSeVO9t_Wg_6', sessionScope: 'project' }));
});

await page.goto('http://127.0.0.1:3013', { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(8000);

async function pickModel(search, nameRe) {
  await page.locator('[data-testid="composer-model-control"] button').first().click();
  await page.waitForTimeout(300);
  await page.getByLabel('Search quick models').fill(search);
  await page.waitForTimeout(700);
  await page.getByRole('button', { name: nameRe }).first().click();
  await page.waitForTimeout(700);
  await page.keyboard.press('Escape');
  await page.mouse.click(20, 20);
  await page.waitForTimeout(400);
}

async function openSlot(n) {
  const chip = page.getByTestId(`fusion-slot-${n}`);
  await chip.locator('button').first().click();
  const dialog = chip.getByRole('dialog');
  await dialog.waitFor({ state: 'visible', timeout: 8000 });
  await page.waitForTimeout(300);
  return dialog;
}

async function closePanels() {
  await page.keyboard.press('Escape');
  await page.mouse.click(20, 20);
  await page.waitForTimeout(300);
}

// 1) Select Devin Fusion → both slot chips, no normal chips.
await pickModel('fusion', /^Fusion Two models/);
const slot1 = page.getByTestId('fusion-slot-1');
const slot2 = page.getByTestId('fusion-slot-2');
await slot1.waitFor({ state: 'visible', timeout: 15000 });
console.log('slot1:', (await slot1.textContent()).trim());
console.log('slot2:', (await slot2.textContent()).trim());
console.log('fast chip visible:', await page.getByTestId('composer-fast-control').isVisible().catch(() => false));
await page.screenshot({ path: 'outputs/ui-critique/fusion-selected.png' });

// 2) Slot 1 panel — efforts + Fast.
const d1 = await openSlot(1);
await page.screenshot({ path: 'outputs/ui-critique/fusion-slot1-panel.png' });
await closePanels();

// 3) Slot 2 panel — SWE-2 Medium/High segmented.
const d2 = await openSlot(2);
await page.screenshot({ path: 'outputs/ui-critique/fusion-slot2-panel.png' });
await closePanels();

// 4) Auto-adjust: lead → Claude Fable 5.2, Fast → On.
const d1b = await openSlot(1);
await d1b.getByRole('menuitemradio', { name: /Claude Fable 5\.2/ }).click();
await page.waitForTimeout(400);
await d1b.getByRole('radiogroup', { name: 'Fusion 1 Fast' }).getByRole('radio', { name: 'On' }).click();
await page.waitForTimeout(600);
console.log('slot2 after fast fable:', (await slot2.textContent()).trim());
await page.screenshot({ path: 'outputs/ui-critique/fusion-auto-adjust.png' });
await closePanels();

// 5) Slot 2 under Fast Fable — dimmed sidekicks + Priority note.
const d2b = await openSlot(2);
await page.screenshot({ path: 'outputs/ui-critique/fusion-slot2-dimmed.png' });
await closePanels();

// 6) Reload → persistence.
await page.reload({ waitUntil: 'domcontentloaded' });
await page.waitForTimeout(7000);
console.log('after reload slot1:', (await slot1.textContent()).trim());
console.log('after reload slot2:', (await slot2.textContent()).trim());
await page.screenshot({ path: 'outputs/ui-critique/fusion-persisted.png' });

await browser.close();
console.log('done');
