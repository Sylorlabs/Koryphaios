#!/usr/bin/env bun
/**
 * Opens the running Koryphaios app in a headless Playwright browser, captures
 * every console message, and reports errors / warnings. Useful for verifying
 * that the frontend boots cleanly against the production backend.
 */

import { chromium } from 'playwright';

const TARGET = process.env.KORYPHAIOS_TARGET ?? 'http://127.0.0.1:3001';
const TIMEOUT_MS = Number(process.env.KORYPHAIOS_TIMEOUT_MS ?? 30_000);

interface CapturedMessage {
  type: string;
  text: string;
  url: string;
}

async function main() {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    ignoreHTTPSErrors: true,
    bypassCSP: true,
  });
  const page = await context.newPage();

  const captured: CapturedMessage[] = [];

  page.on('console', (msg) => {
    const text = msg.text();
    const type = msg.type();
    // Filter out benign noise from SvelteKit / Vite dev
    if (
      text.includes('sveltekit:event') ||
      text.includes('[HMR]') ||
      text.includes('[vite]') ||
      text.startsWith('data:') ||
      text.includes('service worker')
    ) {
      return;
    }
    captured.push({ type, text, url: msg.location().url ?? '' });
  });

  page.on('pageerror', (err) => {
    captured.push({ type: 'pageerror', text: err.message, url: err.stack ?? '' });
  });

  try {
    await page.goto(TARGET, { waitUntil: 'networkidle', timeout: TIMEOUT_MS });
  } catch (e) {
    // navigation might timeout if the app is in the overlay — still capture errors
    console.error(`[capture] Navigation timed out or failed: ${e}`);
  }

  // Wait a moment for late-initialization errors
  await page.waitForTimeout(3000);

  // Also run a quick sniff of what's visible
  const title = await page.title().catch(() => '(unknown)');
  const visibleText = await page
    .locator('body')
    .innerText()
    .catch(() => '(unreachable)');

  await browser.close();

  // ─── Report ────────────────────────────────────────────────────────────────
  const errors = captured.filter((m) => m.type === 'error' || m.type === 'pageerror');
  const warnings = captured.filter((m) => m.type === 'warning');

  console.log('═══════════════════════════════════════════════════');
  console.log(`Page title : ${title}`);
  console.log(`Messages   : ${captured.length} total`);
  console.log(`Errors     : ${errors.length}`);
  console.log(`Warnings   : ${warnings.length}`);
  console.log('═══════════════════════════════════════════════════');

  if (captured.length > 0) {
    console.log('\nAll captured console messages:');
    for (const m of captured) {
      const icon =
        m.type === 'error' || m.type === 'pageerror' ? '✖' : m.type === 'warning' ? '⚠' : '·';
      console.log(`  ${icon} [${m.type}] ${m.text.slice(0, 500)}`);
    }
  }

  if (errors.length > 0) {
    console.log('\n✖ ERRORS (need fixing):');
    for (const e of errors) {
      console.log(`  [${e.type}] ${e.text}`);
      if (e.url) console.log(`       ${e.url}`);
    }
    process.exit(1);
  } else if (warnings.length > 0) {
    console.log('\n⚠ Warnings present (review if actionable):');
    for (const w of warnings) {
      console.log(`  ${w.text.slice(0, 500)}`);
      if (w.url) console.log(`    ${w.url}`);
    }
    process.exit(0);
  } else {
    console.log('\n✓ Clean boot — no errors or warnings.');
    process.exit(0);
  }
}

main().catch((err) => {
  console.error('[capture] Fatal:', err);
  process.exit(1);
});
