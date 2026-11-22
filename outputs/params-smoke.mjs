import { chromium } from 'playwright';

// Model settings chip verification: backend :3011, Vite :3013.
const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1800, height: 1043 } });
const page = await context.newPage();
page.on('pageerror', (e) => console.log('[pageerror]', e.message));

await page.addInitScript(() => {
  localStorage.setItem('koryphaios-onboarding-v1', JSON.stringify({ outcome: 'skipped', finishedAt: Date.now(), version: 1 }));
  localStorage.removeItem('koryphaios-composer-preferences-v1');
  localStorage.removeItem('koryphaios-composer-session-state-v1');
});

await page.goto('http://127.0.0.1:3013', { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(7000);

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

const chip = page.getByTestId('composer-model-params-control');

// 1) OpenRouter mancer/weaver — chip closed.
await pickModel('weaver', /Weaver|mancer/i);
await chip.waitFor({ state: 'visible', timeout: 15000 });
console.log('params chip visible:', await chip.isVisible());
await page.screenshot({ path: 'outputs/ui-critique/params-chip-closed.png' });

// 2) Panel open.
await page.getByLabel('Model settings').click();
await page.waitForTimeout(500);
await page.screenshot({ path: 'outputs/ui-critique/params-panel-open.png' });
const panel = await page.locator('[role="dialog"]').textContent();
console.log('panel has Temperature:', panel.includes('Temperature'), '| has Seed:', panel.includes('Seed'),
  '| has Default:', panel.includes('Default'));

// 3) Increase Temperature once → override + badge 1.
await page.getByRole('button', { name: 'Increase Temperature' }).click();
await page.waitForTimeout(500);
const chipText = (await chip.textContent()).replace(/\s+/g, ' ').trim();
console.log('chip after change:', chipText);
await page.screenshot({ path: 'outputs/ui-critique/params-changed.png' });
await page.keyboard.press('Escape');
await page.mouse.click(20, 20);

// 4) Devin model — no adapter-forwarded params → chip absent.
await pickModel('opus 5.5', /Claude Opus 5\.5(?! Fast)/);
console.log('devin params chip visible:', await chip.isVisible().catch(() => false));
await page.screenshot({ path: 'outputs/ui-critique/params-devin-absent.png' });

await browser.close();
console.log('done');
