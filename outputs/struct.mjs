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
const dump = await page.evaluate(() => {
  const btn = [...document.querySelectorAll('button')].find(b => /^MiMo-V2\.6-Pro/.test(b.textContent.trim()));
  if (!btn) return 'no mimo button';
  let out = [];
  let n = btn;
  for (let i = 0; i < 7 && n; i++) { out.push(`${i}: <${n.tagName}> ${n.className?.slice?.(0,60) || n.className} kids=${n.children?.length}`); n = n.parentElement; }
  return out.join('\n');
});
console.log(dump);
const headers = await page.locator('button').evaluateAll(els => els.filter(e => /\(\d+\)/.test(e.textContent)).map(e => e.textContent.replace(/\s+/g,' ').trim()));
console.log('group headers:', headers);
await browser.close();
