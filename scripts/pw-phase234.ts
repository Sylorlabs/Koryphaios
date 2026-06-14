import { chromium } from 'playwright';
const URL = process.env.KORY_URL ?? 'http://localhost:5173/';
const OUT = '/tmp/kory-shots';
const log = (...a: unknown[]) => console.log('•', ...a);
const browser = await chromium.launch({ headless: true });
const page = await (await browser.newContext({ viewport: { width: 1440, height: 940 } })).newPage();
page.on('console', (m) => { if (m.type() === 'error') console.log('  [console.error]', m.text()); });
await page.goto(URL, { waitUntil: 'networkidle', timeout: 30_000 });
await page.waitForTimeout(1500);

// Open settings (gear in header).
await page.locator('header button').last().click().catch(() => {});
await page.waitForTimeout(800);

// ── Phase 2: Billing tab → pricing hub ───────────────────────────────────────
const billing = page.getByRole('button', { name: /billing/i }).first();
log('Billing tab present:', await billing.count());
if (await billing.count()) {
  await billing.click();
  await page.waitForTimeout(1200);
  const pricingHdr = await page.getByText(/model pricing/i).count();
  const subUsage = await page.getByText(/subscription usage/i).count();
  log('"Model Pricing" section present:', pricingHdr);
  log('"Subscription Usage" section present:', subUsage);
  await page.screenshot({ path: `${OUT}/p2-billing.png`, fullPage: true });
}

// ── Phase 3: Agent tab → Models & Routing ────────────────────────────────────
const agent = page.getByRole('button', { name: /^agent$/i }).first();
log('Agent tab present:', await agent.count());
if (await agent.count()) {
  await agent.click();
  await page.waitForTimeout(1000);
  const routingTab = page.getByRole('button', { name: /models & routing/i }).first();
  log('"Models & Routing" tab present:', await routingTab.count());
  if (await routingTab.count()) {
    await routingTab.click();
    await page.waitForTimeout(900);
    const smartRouter = await page.getByText(/smart router/i).count();
    const autoBadges = await page.getByText(/^Auto$/).count();
    const selects = await page.locator('select').count();
    log('"Smart Router" header present:', smartRouter);
    log('Auto badges:', autoBadges, '| selects on page:', selects);
    await page.screenshot({ path: `${OUT}/p3-routing.png`, fullPage: true });
  }
  const customInstr = page.getByRole('button', { name: /custom instructions/i }).first();
  log('"Custom Instructions" tab present:', await customInstr.count());
}

await browser.close();
log('done');
