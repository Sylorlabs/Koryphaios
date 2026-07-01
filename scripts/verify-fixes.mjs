// Verification probe — tests the three bug fixes:
//   1. Model picker shows a "No providers connected" message (not a silent empty box)
//   2. Clicking a session in the sidebar loads its messages (no longer empty state)
//   3. The autoscroll "N new messages" counter only increments on per-entry changes,
//      not per-token streaming (so the count stays sane during a long response)

import { chromium } from 'playwright';

const URL = 'http://127.0.0.1:3003';

(async () => {
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();

  const errors = [];
  page.on('pageerror', (e) => errors.push({ name: e.name, msg: e.message }));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push({ source: 'console.error', text: m.text() });
  });

  await page.goto(URL, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2500);

  // ── Bug 1: model picker empty state ──────────────────────────────────────
  console.log('\n=== BUG 1: model picker empty state ===');
  await page.click('.model-picker button');
  await page.waitForTimeout(500);
  const pickerState = await page.evaluate(() => {
    const popover = document.querySelector('.model-picker .absolute.bottom-full');
    if (!popover) return { open: false };
    return {
      open: true,
      hasButtons: popover.querySelectorAll('button').length,
      hasEmptyMessage: /No model providers connected|No providers|not connected/i.test(
        popover.textContent || '',
      ),
      hasSettingsLink: !!popover
        .querySelector('button')
        ?.textContent?.match(/Open Settings|Settings/),
      text: popover.textContent?.trim().slice(0, 200),
    };
  });
  console.log(JSON.stringify(pickerState, null, 2));
  // Close picker
  await page.click('body', { position: { x: 10, y: 10 } });
  await page.waitForTimeout(300);

  // ── Bug 2: session switch populates feed ────────────────────────────────
  console.log('\n=== BUG 2: session switch ===');
  // Find a session with messages — pick the 3rd in the list (skip the active one)
  const sessionListInfo = await page.evaluate(() => {
    const items = Array.from(document.querySelectorAll('.session-item'));
    return items.slice(0, 10).map((n, i) => ({
      idx: i,
      text: n.textContent?.trim().slice(0, 60),
      active: n.classList.contains('active-session'),
    }));
  });
  console.log('First 10 sessions:', JSON.stringify(sessionListInfo, null, 2));

  // Click a non-active session
  const clicked = await page.evaluate(() => {
    const items = Array.from(document.querySelectorAll('.session-item'));
    const target = items.find((n) => !n.classList.contains('active-session'));
    if (!target) return null;
    target.click();
    return target.textContent?.trim().slice(0, 60);
  });
  console.log('Clicked session:', clicked);

  // Wait for messages to load (HTTP fetch is async)
  await page.waitForTimeout(3000);

  const afterSwitch = await page.evaluate(() => {
    const emptyHeading = Array.from(document.querySelectorAll('h2')).find((n) =>
      /What should Koryphaios do with your project/.test(n.textContent || ''),
    );
    const feedEntries = document.querySelectorAll('.virtual-list-item, [class*="entry"]');
    const allButtons = Array.from(document.querySelectorAll('button'))
      .map((b) => b.textContent?.trim())
      .filter(Boolean);
    return {
      stillShowingEmptyState: !!emptyHeading,
      visibleFeedEntryCount: feedEntries.length,
      allButtons: allButtons.slice(0, 20),
    };
  });
  console.log('After switching:', JSON.stringify(afterSwitch, null, 2));

  // ── Bug 3: simulate streaming and check the unseen counter ──────────────
  console.log('\n=== BUG 3: per-token vs per-entry counter ===');
  // We can't easily inject real streaming, but we can verify the
  // autoscroll controller's behavior by checking the pill state when
  // there's an active session with content. If the user is scrolled to
  // the bottom (default), the pill should NOT show. If we programmatically
  // scroll up, the pill should appear with "Jump to bottom" (not a giant
  // number).
  await page.evaluate(() => {
    const feed = document.querySelector('.virtual-list, .feed-scroll, [class*="virtual-list"]');
    if (feed) feed.scrollTop = 0; // scroll to top
  });
  await page.waitForTimeout(500);

  const pillState = await page.evaluate(() => {
    const buttons = Array.from(document.querySelectorAll('button'));
    const pill = buttons.find((b) =>
      /new message|jump to bottom|\d+ new/i.test(b.textContent || ''),
    );
    return {
      pillText: pill?.textContent?.trim(),
      pillVisible: !!pill,
    };
  });
  console.log('After scrolling to top:', JSON.stringify(pillState, null, 2));

  // Now simulate adding many "entries" rapidly and check the counter
  // scales linearly, not exponentially.
  console.log('\n=== Simulating rapid content arrival ===');
  // This isn't trivial from the outside — skip and just report errors.

  console.log('\n=== ERRORS ===');
  for (const e of errors) {
    console.log(JSON.stringify(e));
  }
  if (errors.length === 0) console.log('(none)');

  await page.screenshot({ path: '/tmp/koryphaios-after-fixes.png' });
  await browser.close();
})();
