import { chromium } from 'playwright';
const browser = await chromium.launch();
const page = await (await browser.newContext({ viewport: { width: 1800, height: 1043 } })).newPage();
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
  await page.waitForTimeout(600);
  await page.getByRole('button', { name: nameRe }).first().click();
  await page.waitForTimeout(700);
  await page.keyboard.press('Escape');
  await page.mouse.click(20, 20);
  await page.waitForTimeout(400);
}

const chip = page.getByTestId('composer-fast-control');
const bodyBtn = chip.locator('button').first();

// OpenRouter MiMo-V2.6-Pro — UltraSpeed chip.
await pickModel('mimo', /^Xiaomi: MiMo-V2\.6-Pro/);
console.log('stored:', await page.evaluate(() => localStorage.getItem('koryphaios-selected-model')));
console.log('mimo chip visible:', await chip.isVisible().catch(() => false),
  '| label:', await bodyBtn.getAttribute('aria-label').catch(() => null));
await page.screenshot({ path: 'outputs/ui-critique/speed-mimo-ultraspeed.png' });

// Devin SWE-2 Lightning — no tiers → chip absent.
await pickModel('swe-2 lightning', /SWE-2.*Lightning/i);
console.log('swe chip visible:', await chip.isVisible().catch(() => false));
await page.screenshot({ path: 'outputs/ui-critique/speed-no-tier.png' });

await browser.close();
console.log('done');
