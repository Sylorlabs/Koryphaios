// Playwright functional test of the running Koryphaios dev app.
import { chromium, type Page } from 'playwright';

const URL = process.env.KORY_URL ?? 'http://localhost:5173/';
const OUT = '/tmp/kory-shots';
const log = (...a: unknown[]) => console.log('•', ...a);

const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await ctx.newPage();
const errors: string[] = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));

async function shot(name: string) { await page.screenshot({ path: `${OUT}/${name}.png`, fullPage: false }); log('shot', name); }

await page.goto(URL, { waitUntil: 'networkidle', timeout: 30_000 });
await page.waitForTimeout(2000);

// ── 1. Agent-mode selector toggles ──
try {
  for (const mode of ['Multi', 'Solo', 'Auto']) {
    await page.getByRole('button', { name: mode, exact: true }).first().click({ timeout: 4000 });
    await page.waitForTimeout(250);
  }
  await page.getByRole('button', { name: 'Multi', exact: true }).first().click();
  await page.waitForTimeout(300);
  await shot('02-agentmode-multi');
  log('agent-mode selector: OK');
} catch (e) { log('agent-mode ERROR:', (e as Error).message); }

// ── 2. Send a short message → verify Stop button appears + streams + completes ──
let stopSeen = false;
try {
  const composer = page.locator('textarea').first();
  await composer.click();
  await composer.fill('Reply with exactly one word: pong');
  await page.waitForTimeout(150);
  await page.getByRole('button', { name: /^Send$/i }).first().click();
  // Poll briefly for the Stop button (busy-bridge should show it immediately).
  for (let i = 0; i < 20; i++) {
    if (await page.getByRole('button', { name: /^Stop$/i }).count()) { stopSeen = true; break; }
    await page.waitForTimeout(150);
  }
  log('Stop button appeared after send:', stopSeen);
  if (stopSeen) await shot('03-stop-visible');
  // Handle the tool-approval prompt if it appears.
  const proceed = page.getByRole('button', { name: /proceed/i }).first();
  if (await proceed.count().catch(() => 0)) { await proceed.click().catch(() => {}); log('clicked proceed'); }
  // Wait for completion (Stop disappears → Send returns), up to 60s.
  await page.getByRole('button', { name: /^Send$/i }).first().waitFor({ state: 'visible', timeout: 60_000 }).catch(() => {});
  await page.waitForTimeout(1000);
  await shot('04-after-response');
  const feed = await page.locator('body').innerText();
  log('response contains "pong":', /pong/i.test(feed));
  log('empty-response notice present:', /empty response/i.test(feed));
} catch (e) { log('send/stream ERROR:', (e as Error).message); await shot('04-error'); }

// ── 3. Settings → Appearance (fonts) + Experimental ──
try {
  // Open settings: the gear button (top-right). Try a few strategies.
  const gear = page.locator('header button, [class*="header"] button').last();
  await gear.click({ timeout: 3000 }).catch(async () => {
    await page.keyboard.press('Control+,').catch(() => {});
  });
  await page.waitForTimeout(800);
  // Appearance tab
  const appearance = page.getByRole('button', { name: /appearance/i }).first();
  if (await appearance.count()) { await appearance.click(); await page.waitForTimeout(600); await shot('05-appearance-fonts'); log('appearance: OK'); }
  const experimental = page.getByRole('button', { name: /experimental/i }).first();
  if (await experimental.count()) { await experimental.click(); await page.waitForTimeout(600); await shot('06-experimental'); log('experimental: OK'); }
} catch (e) { log('settings ERROR:', (e as Error).message); }

log('PAGE_ERRORS:', errors.length ? JSON.stringify([...new Set(errors)].slice(0, 8)) : 'none');
await browser.close();
