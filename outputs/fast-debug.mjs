import { chromium } from 'playwright';
const browser = await chromium.launch();
const page = await (await browser.newContext({ viewport: { width: 1800, height: 1043 } })).newPage();
page.on('console', (m) => { if (m.type() === 'error') console.log('[console.error]', m.text().slice(0, 200)); });
page.on('pageerror', (e) => console.log('[pageerror]', e.message));
await page.addInitScript(() => {
  localStorage.setItem('koryphaios-onboarding-v1', JSON.stringify({ outcome: 'skipped', finishedAt: Date.now(), version: 1 }));
  localStorage.setItem('koryphaios-navigation-preferences-v1', JSON.stringify({ lastSessionId: 'qSeVO9t_Wg_6', sessionScope: 'project' }));
});
await page.goto('http://127.0.0.1:3013', { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(8000);
await page.screenshot({ path: 'outputs/ui-critique/fast-debug.png' });
const info = await page.evaluate(() => ({
  testids: [...document.querySelectorAll('[data-testid]')].map((e) => e.dataset.testid).slice(0, 30),
  buttons: [...document.querySelectorAll('button[aria-label]')].map((b) => b.getAttribute('aria-label')).slice(0, 40),
  bodyText: document.body.innerText.slice(0, 400),
}));
console.log(JSON.stringify(info, null, 1));
await browser.close();
