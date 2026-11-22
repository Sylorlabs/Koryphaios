import { chromium } from 'playwright';
const browser = await chromium.launch();
const page = await (await browser.newContext({ viewport: { width: 1800, height: 1043 } })).newPage();
await page.addInitScript(() => {
  localStorage.setItem('koryphaios-onboarding-v1', JSON.stringify({ outcome: 'skipped', finishedAt: Date.now(), version: 1 }));
  localStorage.setItem('koryphaios-navigation-preferences-v1', JSON.stringify({ lastSessionId: 'qSeVO9t_Wg_6', sessionScope: 'project' }));
});
await page.goto('http://127.0.0.1:3013', { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(9000);
await page.locator('[data-testid="composer-model-control"] button').first().click();
await page.waitForTimeout(500);
await page.getByLabel('Search quick models').fill('mimo');
await page.waitForTimeout(800);
const info = await page.locator('button').evaluateAll(els =>
  els.filter(e => /MiMo-V2\.6/.test(e.textContent)).map(e => {
    const section = e.closest('[data-provider], [data-testid], fieldset, [role="group"]');
    const hdr = section?.querySelector('h1,h2,h3,h4,[class*="header"],[class*="title"],[class*="label"]');
    const anc = e.closest('div')?.parentElement;
    return JSON.stringify({
      t: e.textContent.replace(/\s+/g, ' ').trim(),
      sec: section?.getAttribute('data-provider') || section?.getAttribute('data-testid') || '',
      hdr: hdr?.textContent?.replace(/\s+/g, ' ').trim().slice(0, 60) || '',
      prev: (() => { let p = e.parentElement; while (p && !p.previousElementSibling) p = p.parentElement; return p?.previousElementSibling?.textContent?.replace(/\s+/g,' ').trim().slice(0,60) || ''; })(),
    });
  })
);
console.log(info.join('\n'));
await browser.close();
