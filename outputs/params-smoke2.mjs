import { chromium } from 'playwright';

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

await page.locator('[data-testid="composer-model-control"] button').first().click();
await page.waitForTimeout(300);
await page.getByLabel('Search quick models').fill('weaver');
await page.waitForTimeout(600);
await page.getByRole('button', { name: /Weaver|mancer/i }).first().click();
await page.waitForTimeout(700);
await page.keyboard.press('Escape');
await page.mouse.click(20, 20);
await page.waitForTimeout(400);

const chip = page.getByTestId('composer-model-params-control');
await chip.waitFor({ state: 'visible', timeout: 15000 });
await page.getByLabel('Model settings').click();
await page.waitForTimeout(500);
await page.screenshot({ path: 'outputs/ui-critique/params-panel-open.png' });

// Zoom: clip the temperature row (first row in the panel).
const slider = page.locator('[role="dialog"] [role="slider"]').first();
const box = await slider.boundingBox();
const rowBox = await page.locator('[role="dialog"] > div:nth-child(2) > div').first().boundingBox();
if (rowBox) {
  await page.screenshot({
    path: 'outputs/ui-critique/params-row-zoom.png',
    clip: { x: rowBox.x - 6, y: rowBox.y - 4, width: rowBox.width + 12, height: rowBox.height + 8 },
  });
}
console.log('slider width:', box?.width);

await page.getByRole('button', { name: 'Increase Temperature' }).click();
await page.waitForTimeout(500);
const chipText = (await chip.textContent()).replace(/\s+/g, ' ').trim();
console.log('chip after change:', chipText.slice(0, 60));
await page.screenshot({ path: 'outputs/ui-critique/params-changed.png' });
const rowBox2 = await page.locator('[role="dialog"] > div:nth-child(2) > div').first().boundingBox();
if (rowBox2) {
  await page.screenshot({
    path: 'outputs/ui-critique/params-row-zoom-changed.png',
    clip: { x: rowBox2.x - 6, y: rowBox2.y - 4, width: rowBox2.width + 12, height: rowBox2.height + 8 },
  });
}
await browser.close();
console.log('done');
