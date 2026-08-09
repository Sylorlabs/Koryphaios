// Playwright probe — drive the running Koryphaios dev app and capture state for inspection.
import { chromium } from 'playwright';

const URL = process.env.KORY_URL ?? 'http://localhost:5173/';
const OUT = '/tmp/kory-shots';

const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await ctx.newPage();

const errors: string[] = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(`console.error: ${m.text()}`); });
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));

await page.goto(URL, { waitUntil: 'networkidle', timeout: 30_000 }).catch((e) => errors.push(`goto: ${e.message}`));
await page.waitForTimeout(2500);

await page.screenshot({ path: `${OUT}/01-initial.png`, fullPage: true });

const title = await page.title();
const bodyText = (await page.locator('body').innerText().catch(() => '')).slice(0, 1200);
// Surface obvious interactive landmarks.
const buttons = await page.locator('button:visible').allInnerTexts().catch(() => []);
const inputs = await page.locator('input:visible, textarea:visible').count().catch(() => 0);

console.log('TITLE:', title);
console.log('VISIBLE_BUTTONS:', JSON.stringify(buttons.slice(0, 40)));
console.log('VISIBLE_INPUTS:', inputs);
console.log('BODY_TEXT_START:\n' + bodyText);
console.log('PAGE_ERRORS:', errors.length ? JSON.stringify(errors.slice(0, 10)) : 'none');

await browser.close();
