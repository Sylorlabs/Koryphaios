import { chromium } from 'playwright';

// Universal speed-tier chip verification: backend :3011, Vite :3013.
const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1800, height: 1043 } });
const page = await context.newPage();
page.on('pageerror', (e) => console.log('[pageerror]', e.message));

await page.addInitScript(() => {
  localStorage.setItem('koryphaios-onboarding-v1', JSON.stringify({ outcome: 'skipped', finishedAt: Date.now(), version: 1 }));
  localStorage.setItem('koryphaios-navigation-preferences-v1', JSON.stringify({ lastSessionId: 'qSeVO9t_Wg_6', sessionScope: 'project' }));
});

await page.goto('http://127.0.0.1:3013', { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(7000);

async function pickModel(search, groupRe, nameRe) {
  await page.locator('[data-testid="composer-model-control"] button').first().click();
  await page.waitForTimeout(300);
  await page.getByLabel('Search quick models').fill(search);
  await page.waitForTimeout(600);
  // Exact-name rows: group order puts the target provider's row first.
  await page.getByRole('button', { name: nameRe }).first().click();
  await page.waitForTimeout(700);
  await page.keyboard.press('Escape');
  await page.mouse.click(20, 20);
  await page.waitForTimeout(400);
}

const chip = page.getByTestId('composer-fast-control');
const bodyBtn = chip.locator('button').first();

// 1) Devin Claude Opus 5.5 — chip off.
await pickModel('opus 5.5', null, /Claude Opus 5\.5(?! Fast)/);
await bodyBtn.waitFor({ state: 'visible', timeout: 15000 });
console.log('devin off:', await bodyBtn.getAttribute('aria-label'));
await page.screenshot({ path: 'outputs/ui-critique/speed-devin-off.png' });

// 2) Chip body click → Fast on.
await bodyBtn.click();
await page.waitForTimeout(400);
console.log('devin on:', await bodyBtn.getAttribute('aria-label'));
await page.screenshot({ path: 'outputs/ui-critique/speed-devin-on.png' });

// 3) OpenRouter MiMo-V2.6-Pro — UltraSpeed chip.
await pickModel('mimo', /^OpenRouter \(\d+\)/, /^MiMo-V2\.6-Pro$/);
console.log('mimo chip visible:', await chip.isVisible().catch(() => false),
  '| label:', await bodyBtn.getAttribute('aria-label').catch(() => null));
console.log('selected:', (await page.locator('[data-testid="composer-model-control"] button').first().textContent()).replace(/\s+/g, ' ').trim());
await page.screenshot({ path: 'outputs/ui-critique/speed-mimo-ultraspeed.png' });

// 4) Devin SWE-2 Lightning — no tiers → chip absent.
await pickModel('swe-2 lightning', /^Devin \(\d+\)/, /SWE-2.*Lightning/i);
console.log('swe chip visible:', await chip.isVisible().catch(() => false));
await page.screenshot({ path: 'outputs/ui-critique/speed-no-tier.png' });

await browser.close();
console.log('done');
