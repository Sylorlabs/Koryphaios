import { chromium } from 'playwright';
const URL = process.env.KORY_URL ?? 'http://localhost:5173/';
const OUT = '/tmp/kory-shots';
const log = (...a: unknown[]) => console.log('•', ...a);
const browser = await chromium.launch({ headless: true });
const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
await page.goto(URL, { waitUntil: 'networkidle', timeout: 30_000 });
await page.waitForTimeout(2000);

// Composer area — verify there is exactly ONE agent-mode pill (no duplicate selector).
await page.screenshot({ path: `${OUT}/v1-composer.png` });
const modePill = page.locator('button[title^="Agent Mode"]');
log('agent-mode pills found:', await modePill.count());
const soloSegment = await page.getByRole('button', { name: 'Solo', exact: true }).count();
const multiSegment = await page.getByRole('button', { name: 'Multi', exact: true }).count();
log('duplicate segmented control present (Solo/Multi buttons):', soloSegment + multiSegment);

// Click the existing pill twice → should cycle Auto → Single Agent → Multi-Agent.
if (await modePill.count()) {
  await modePill.first().click(); await page.waitForTimeout(300);
  log('after 1 click, pill label:', (await modePill.first().innerText()).trim());
  await page.screenshot({ path: `${OUT}/v2-pill-cycled.png` });
  await modePill.first().click(); await page.waitForTimeout(300);
  log('after 2 clicks, pill label:', (await modePill.first().innerText()).trim());
  await modePill.first().click(); await page.waitForTimeout(200); // back to Auto
}

// Open settings → Advanced tab.
await page.locator('header button').last().click().catch(() => {});
await page.waitForTimeout(800);
const advanced = page.getByRole('button', { name: /advanced/i }).first();
log('"Advanced" tab present:', await advanced.count());
const stillExperimental = await page.getByRole('button', { name: /^experimental$/i }).count();
log('"Experimental" tab still present:', stillExperimental);
if (await advanced.count()) { await advanced.click(); await page.waitForTimeout(700); await page.screenshot({ path: `${OUT}/v3-advanced-tab.png` }); }

await browser.close();
