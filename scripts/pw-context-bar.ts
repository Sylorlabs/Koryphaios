// Verify: (1) per-model reasoning picker (Haiku = none, Opus = low..max),
// (2) segmented context bar appears after a real reply and carries a breakdown.
import { chromium } from 'playwright';

const URL = process.env.KORY_URL ?? 'http://127.0.0.1:3003/';
const OUT = '/tmp/kory-shots';

const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await ctx.newPage();

const usageEvents: any[] = [];
page.on('websocket', (ws) => {
  ws.on('framereceived', (frame) => {
    try {
      const data = JSON.parse(String(frame.payload));
      if (data?.type === 'stream.usage') usageEvents.push(data.payload);
    } catch { /* not json */ }
  });
});

// Advanced mode enables cost tracking (and thus the context bar).
await ctx.addInitScript(() => localStorage.setItem('koryphaios-mode', 'advanced'));
await page.goto(URL, { waitUntil: 'networkidle', timeout: 30_000 });
await page.waitForTimeout(2500);

// Fresh session so we don't collide with a busy one.
await page.locator('aside button, [class*=sidebar] button').filter({ hasText: /^\+?$/ }).first().click().catch(() => {});
await page.waitForTimeout(1000);

async function selectModel(name: RegExp) {
  await page.locator('button', { hasText: /Select model|Claude|GPT|Grok|Composer/i }).first().click();
  await page.waitForTimeout(800);
  const option = page.getByText(name).first();
  await option.click({ timeout: 5000 });
  await page.waitForTimeout(600);
}

// ── 1. Haiku: expect NO reasoning control ──
await selectModel(/Claude Haiku 4\.5/);
await page.screenshot({ path: `${OUT}/cb-02-haiku.png` });
const composerHtmlHaiku = await page.locator('form, [class*=composer]').last().innerHTML().catch(() => '');
const haikuHasReasoning = /reasoning|effort|brain/i.test(composerHtmlHaiku);
console.log('HAIKU_REASONING_CONTROL:', haikuHasReasoning);

// ── 2. Opus: expect reasoning control with xhigh/max ──
await selectModel(/Claude Opus 4\.8/);
await page.screenshot({ path: `${OUT}/cb-03-opus.png` });
const composerHtmlOpus = await page.locator('form, [class*=composer]').last().innerHTML().catch(() => '');
console.log('OPUS_REASONING_CONTROL:', /reasoning|effort|brain/i.test(composerHtmlOpus));

// ── 3. Switch back to Haiku (cheap+fast) and send a message ──
await selectModel(/Claude Haiku 4\.5/);
await page.locator('textarea').first().fill('Reply with exactly: hello context bar');
await page.keyboard.press('Enter');
console.log('SENT — waiting for reply...');

// wait for a stream.usage event with breakdown or 120s
const deadline = Date.now() + 120_000;
while (Date.now() < deadline) {
  await page.waitForTimeout(2000);
  if (usageEvents.some((u) => u?.breakdown)) break;
}
console.log('USAGE_EVENTS:', usageEvents.length);
const withBreakdown = usageEvents.filter((u) => u?.breakdown);
console.log('WITH_BREAKDOWN:', withBreakdown.length,
  withBreakdown.length ? JSON.stringify(withBreakdown[withBreakdown.length - 1]) : '');

await page.waitForTimeout(3000);
await page.screenshot({ path: `${OUT}/cb-04-after-reply.png` });

// ── 4. Context bar visible? hover for legend ──
const bar = page.getByText('Context', { exact: true }).first();
const barVisible = await bar.isVisible().catch(() => false);
console.log('CONTEXT_BAR_VISIBLE:', barVisible);
if (barVisible) {
  await bar.hover();
  await page.waitForTimeout(600);
  await page.screenshot({ path: `${OUT}/cb-05-hover-legend.png` });
  const legend = await bar.locator('..').locator('..').innerText().catch(() => '');
  console.log('LEGEND_TEXT:', JSON.stringify(legend));
}

await browser.close();
