import { chromium } from 'playwright';
const URL = 'http://localhost:5173/';
const OUT = '/tmp/kory-shots';
const browser = await chromium.launch({ headless: true });
const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
const imgErrors: string[] = [];
page.on('response', (r) => { if (r.url().includes('/provider-icons/') && r.status() >= 400) imgErrors.push(`${r.status()} ${r.url()}`); });
await page.goto(URL, { waitUntil: 'networkidle', timeout: 30_000 });
await page.waitForTimeout(2000);

// Open settings (gear, last header button) → Providers tab is default.
await page.locator('header button').last().click().catch(() => {});
await page.waitForTimeout(800);
const providersTab = page.getByRole('button', { name: /^providers$/i }).first();
if (await providersTab.count()) { await providersTab.click(); await page.waitForTimeout(500); }

const search = page.getByPlaceholder(/search providers/i).first();
for (const q of ['grok', 'cursor', 'xai']) {
  await search.fill(q);
  await page.waitForTimeout(700);
  await page.screenshot({ path: `${OUT}/icon-${q}.png` });
  console.log('• shot icon-' + q);
}
console.log('provider-icon load errors:', imgErrors.length ? JSON.stringify(imgErrors) : 'none');
await browser.close();
