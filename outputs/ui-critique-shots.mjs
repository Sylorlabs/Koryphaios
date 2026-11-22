import { chromium } from 'playwright';

const OUT = '/Users/Shared/micah/Documents/koryphaios/outputs/ui-critique';
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1800, height: 1043 } });
page.on('console', (m) => { if (m.type() === 'error') console.log('[console.error]', m.text()); });

// Seed device-local prefs so a fresh profile skips the walkthrough and
// restores the same chat the Tauri window has open.
await page.addInitScript(() => {
  localStorage.setItem(
    'koryphaios-onboarding-v1',
    JSON.stringify({ outcome: 'skipped', finishedAt: Date.now(), version: 1 }),
  );
  localStorage.setItem(
    'koryphaios-navigation-preferences-v1',
    JSON.stringify({ lastSessionId: 'qSeVO9t_Wg_6', sessionScope: 'project' }),
  );
});

await page.goto('http://127.0.0.1:3003', { waitUntil: 'domcontentloaded' });

const skillRow = page.locator('div[title]:has-text("Used skill")').first();
try {
  await skillRow.waitFor({ state: 'visible', timeout: 20000 });
} catch {
  await page.screenshot({ path: `${OUT}/diag-no-skillrow.png` });
  const chat = page.locator('text=cli: Reply with exactly: ok').first();
  await chat.click();
  await skillRow.waitFor({ state: 'visible', timeout: 15000 });
}
await page.waitForTimeout(1200);

// Report the resolved chrome vars on the feed wrapper.
const vars = await page.evaluate(() => {
  const el = document.querySelector('.relative.flex-1.min-h-0.overflow-hidden');
  if (!el) return null;
  const cs = getComputedStyle(el);
  return {
    fg: cs.getPropertyValue('--feed-chrome-fg'),
    fgHover: cs.getPropertyValue('--feed-chrome-fg-hover'),
    hoverBg: cs.getPropertyValue('--feed-chrome-hover-bg'),
    inline: el.getAttribute('style'),
  };
});
console.log('feed chrome vars:', JSON.stringify(vars));

// (A) Hover the skill-row TEXT, wait for the tooltip, screenshot.
const skillText = skillRow.locator('span', { hasText: 'documents-communication' }).first();
await skillText.scrollIntoViewIfNeeded();
await page.waitForTimeout(300);
await skillText.hover();
await page.locator('#kory-global-tooltip').waitFor({ state: 'visible', timeout: 5000 });
await page.waitForTimeout(400); // let rAF positioning settle
await page.screenshot({ path: `${OUT}/tooltip-skill-row.png` });

// Clipped detail: tooltip + anchor row. Read rects synchronously in page JS —
// the feed re-renders, so a locator re-resolve can race detachment.
const boxes = await page.evaluate(() => {
  const row = [...document.querySelectorAll('div[title]')].find((d) =>
    d.textContent?.includes('Used skill'),
  );
  const tt = document.querySelector('#kory-global-tooltip');
  const r = row?.getBoundingClientRect();
  const t = tt?.getBoundingClientRect();
  return r && t ? { row: r.toJSON(), tip: t.toJSON() } : null;
});
const tt = boxes?.tip;
const row = boxes?.row;
if (tt && row) {
  const x = Math.max(0, Math.min(tt.x, row.x) - 40);
  const y = Math.max(0, Math.min(tt.y, row.y) - 20);
  const r = Math.max(tt.x + tt.width, row.x + row.width) + 40;
  const b = Math.max(tt.y + tt.height, row.y + row.height) + 30;
  await page.screenshot({
    path: `${OUT}/tooltip-skill-row-detail.png`,
    clip: { x, y, width: Math.min(1800 - x, r - x), height: b - y },
  });
}
console.log('tooltip box:', JSON.stringify(tt), 'row box:', JSON.stringify(row));

// Move pointer away to dismiss the tooltip.
await page.mouse.move(900, 60);
await page.waitForTimeout(300);

// (B) Action rows at rest.
const actions = page.locator('.response-actions').last();
await actions.scrollIntoViewIfNeeded();
await page.waitForTimeout(400);
const ab = await actions.boundingBox();
if (ab) {
  await page.screenshot({
    path: `${OUT}/actions-rest.png`,
    clip: { x: Math.max(0, ab.x - 20), y: Math.max(0, ab.y - 30), width: Math.min(900, ab.width + 60), height: ab.height + 60 },
  });
}

// Hover the "Copy response" action.
const copyBtn = actions.locator('button.response-action', { hasText: 'Copy response' }).first();
await copyBtn.hover();
await page.waitForTimeout(400);
if (ab) {
  await page.screenshot({
    path: `${OUT}/actions-hover.png`,
    clip: { x: Math.max(0, ab.x - 20), y: Math.max(0, ab.y - 30), width: Math.min(900, ab.width + 60), height: ab.height + 60 },
  });
}
const hoverStyle = await copyBtn.evaluate((el) => {
  const cs = getComputedStyle(el);
  return { color: cs.color, background: cs.backgroundColor };
});
console.log('hovered action style:', JSON.stringify(hoverStyle));

await browser.close();
console.log('done');
