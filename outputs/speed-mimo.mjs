import { chromium } from 'playwright';
const browser = await chromium.launch();
const page = await (await browser.newContext({ viewport: { width: 1800, height: 1043 } })).newPage();
page.on('pageerror', (e) => console.log('[pageerror]', e.message));
await page.addInitScript(() => {
  localStorage.setItem('koryphaios-onboarding-v1', JSON.stringify({ outcome: 'skipped', finishedAt: Date.now(), version: 1 }));
  localStorage.setItem('koryphaios-navigation-preferences-v1', JSON.stringify({ lastSessionId: 'qSeVO9t_Wg_6', sessionScope: 'project' }));
  localStorage.setItem('koryphaios-composer-session-state-v1', JSON.stringify({
    'qSeVO9t_Wg_6': { model: 'openrouter:xiaomi/mimo-v2.6-pro' },
  }));
});
await page.goto('http://127.0.0.1:3013', { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(8000);
const chip = page.getByTestId('composer-fast-control');
const bodyBtn = chip.locator('button').first();
console.log('visible:', await chip.isVisible().catch(() => false));
console.log('label:', await bodyBtn.getAttribute('aria-label').catch(() => null));
console.log('selectedModel:', await page.locator('[data-testid="composer-model-control"] button').first().textContent());
await page.screenshot({ path: 'outputs/ui-critique/speed-mimo-ultraspeed.png' });
await browser.close();
console.log('done');
