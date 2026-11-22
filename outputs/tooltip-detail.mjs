import { chromium } from 'playwright';
const OUT = '/Users/Shared/micah/Documents/koryphaios/outputs/ui-critique';
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1800, height: 1043 } });
await page.addInitScript(() => {
  localStorage.setItem('koryphaios-onboarding-v1',
    JSON.stringify({ outcome: 'skipped', finishedAt: Date.now(), version: 1 }));
  localStorage.setItem('koryphaios-navigation-preferences-v1',
    JSON.stringify({ lastSessionId: 'qSeVO9t_Wg_6', sessionScope: 'project' }));
});
await page.goto('http://127.0.0.1:3003', { waitUntil: 'domcontentloaded' });
const skillText = page.locator('div[title] span:has-text("documents-communication")').first();
await skillText.waitFor({ state: 'visible', timeout: 20000 });
await page.waitForTimeout(800);
await skillText.hover();
await page.locator('#kory-global-tooltip').waitFor({ state: 'visible', timeout: 5000 });
await page.waitForTimeout(400);
const boxes = await page.evaluate(() => {
  const row = [...document.querySelectorAll('div[data-kory-tooltip],div[title]')]
    .find((d) => d.textContent?.includes('Used skill'));
  const tt = document.querySelector('#kory-global-tooltip');
  const r = row?.getBoundingClientRect();
  const t = tt?.getBoundingClientRect();
  return r && t ? { row: r.toJSON(), tip: t.toJSON() } : null;
});
console.log('boxes:', JSON.stringify(boxes));
if (boxes) {
  const { row, tip } = boxes;
  const x = Math.max(0, Math.min(tip.x, row.x) - 40);
  const y = Math.max(0, Math.min(tip.y, row.y) - 20);
  const r = Math.max(tip.x + tip.width, row.x + 620) + 40;
  const b = Math.max(tip.y + tip.height, row.y + row.height) + 30;
  await page.screenshot({
    path: `${OUT}/tooltip-skill-row-detail.png`,
    clip: { x, y, width: Math.min(1800 - x, r - x), height: b - y },
  });
}
await browser.close();
console.log('done');
