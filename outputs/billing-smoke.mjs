import { chromium } from 'playwright';

const TOKEN = process.env.BILLING_TOKEN;
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1800, height: 1043 } });
page.on('console', (m) => { if (m.type() === 'error') console.log('[console.error]', m.text()); });
page.on('pageerror', (e) => console.log('[pageerror]', e.message));

// Forward billing API calls to the source backend on :3011 (the running
// eval backend on :3001 is the packaged build without the split routes).
await page.route('**/api/billing/**', async (route) => {
  const url = new URL(route.request().url());
  const target = `http://127.0.0.1:3011${url.pathname}${url.search}`;
  const resp = await fetch(target, { headers: { Authorization: TOKEN } });
  const body = await resp.text();
  await route.fulfill({ status: resp.status, body, contentType: 'application/json' });
});

await page.addInitScript(() => {
  localStorage.setItem('koryphaios-onboarding-v1',
    JSON.stringify({ outcome: 'skipped', finishedAt: Date.now(), version: 1 }));
  localStorage.setItem('koryphaios-navigation-preferences-v1',
    JSON.stringify({ lastSessionId: 'qSeVO9t_Wg_6', sessionScope: 'project' }));
});
await page.goto('http://127.0.0.1:3003', { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(4000);

// Open the settings drawer → billing tab.
const settingsBtn = page.locator('button[aria-label*="Settings" i], [title*="Settings" i]').first();
await settingsBtn.click().catch(() => {});
await page.waitForTimeout(800);
const billingTab = page.locator('button:has-text("Billing"), button:has-text("Usage")').first();
await billingTab.click().catch(() => {});
await page.waitForTimeout(1200);
await page.screenshot({ path: 'outputs/ui-critique/billing-panel-mid.png' });
await page.waitForTimeout(3000);
await page.screenshot({ path: 'outputs/ui-critique/billing-panel.png' });
const state = await page.evaluate(() => ({
  hasCliUsage: document.body.innerText.includes('CLI subscriptions'),
  hasBalances: document.body.innerText.includes('API account balances'),
  hasError: /Billing (live )?data unavailable|Billing API not available/.test(document.body.innerText),
  loadingText: /Loading (subscription|provider)/.test(document.body.innerText),
}));
console.log('panel state:', JSON.stringify(state));
await browser.close();
console.log('done');
