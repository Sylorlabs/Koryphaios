// Detailed network probe — check whether fetchMessages returns data
// and whether loadSessionMessages is called.
import { chromium } from 'playwright';

const URL = 'http://127.0.0.1:3003';

(async () => {
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();

  const requests = [];
  const responses = [];

  page.on('request', (r) => {
    if (r.url().includes('/api/')) {
      requests.push({ method: r.method(), url: r.url() });
    }
  });
  page.on('response', async (r) => {
    if (r.url().includes('/api/messages') || r.url().includes('/api/sessions/')) {
      try {
        const body = await r.text();
        responses.push({ status: r.status(), url: r.url(), bodyPreview: body.slice(0, 400) });
      } catch (e) {
        responses.push({ status: r.status(), url: r.url(), error: e.message });
      }
    }
  });

  page.on('pageerror', (e) => console.log('PAGE ERROR:', e.name, e.message));
  page.on('console', (m) => {
    const t = m.text();
    if (m.type() === 'error' || /loop|depth|exceeded/i.test(t)) {
      console.log(`[${m.type()}]`, t);
    }
  });

  await page.goto(URL, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2500);

  // Click a session that's NOT the first one
  const clicked = await page.evaluate(() => {
    const items = Array.from(document.querySelectorAll('.session-item'));
    // Pick a session that has "Test" in its name (likely has messages)
    const target = items.find((n) => /Test|Session \d/i.test(n.textContent || ''));
    if (target) {
      target.click();
      return target.textContent?.trim().slice(0, 60);
    }
    return null;
  });
  console.log('Clicked session:', clicked);

  await page.waitForTimeout(4000);

  // Snapshot
  const state = await page.evaluate(() => {
    const emptyH2 = Array.from(document.querySelectorAll('h2')).find((n) =>
      /What should Koryphaios do with your project/.test(n.textContent || ''),
    );
    const virtualItems = document.querySelectorAll('.virtual-list-item').length;
    const feedEls = document.querySelectorAll('[class*="feed" i]').length;
    return {
      stillEmptyState: !!emptyH2,
      virtualListItems: virtualItems,
      feedElements: feedEls,
    };
  });
  console.log('State after click:', JSON.stringify(state, null, 2));

  console.log('\n=== /api/messages + /api/sessions/* responses ===');
  for (const r of responses) {
    console.log(`[${r.status}] ${r.url}`);
    console.log(`  body: ${r.bodyPreview}`);
  }

  console.log('\n=== all /api/ requests ===');
  for (const r of requests) {
    console.log(`${r.method} ${r.url}`);
  }

  await browser.close();
})();
