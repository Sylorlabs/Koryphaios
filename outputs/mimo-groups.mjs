import { chromium } from 'playwright';
const browser = await chromium.launch();
const page = await (await browser.newContext({ viewport: { width: 1800, height: 1043 } })).newPage();
await page.addInitScript(() => {
  localStorage.setItem('koryphaios-onboarding-v1', JSON.stringify({ outcome: 'skipped', finishedAt: Date.now(), version: 1 }));
  localStorage.setItem('koryphaios-navigation-preferences-v1', JSON.stringify({ lastSessionId: 'qSeVO9t_Wg_6', sessionScope: 'project' }));
});
await page.goto('http://127.0.0.1:3013', { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(8000);
await page.locator('[data-testid="composer-model-control"] button').first().click();
await page.waitForTimeout(400);
await page.getByLabel('Search quick models').fill('mimo');
await page.waitForTimeout(700);
const rows = await page.locator('button').evaluateAll(els =>
  els.filter(e => /mimo/i.test(e.textContent) && !/\(\d+\)/.test(e.textContent)).map(e => {
    let anc = e.parentElement, group = '?';
    for (let i = 0; i < 6 && anc; i++) {
      const hdr = [...anc.querySelectorAll(':scope > button')].find(b => /\(\d+\)/.test(b.textContent));
      if (hdr) { group = hdr.textContent.replace(/\s+/g,' ').trim(); break; }
      anc = anc.parentElement;
    }
    return `[${group}] ${e.textContent.replace(/\s+/g,' ').trim()}`;
  })
);
console.log(rows.join('\n'));
await browser.close();
