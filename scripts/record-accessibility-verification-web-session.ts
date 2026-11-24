#!/usr/bin/env bun
/**
 * Records a real Chromium keyboard and zoom session for the
 * accessibility-verification web fixture.
 *
 * The evaluator renders the page itself, drives it with the keyboard, and reads
 * back measured geometry and focus. Nothing is asserted by hand: every recorded
 * boolean comes from a browser observation, and the screenshots are captured
 * from the same session.
 *
 * Usage:
 *   bun run scripts/record-accessibility-verification-web-session.ts [--out=path]
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { chromium } from 'playwright';

const projectRoot = resolve(import.meta.dir, '..');
const outputArg = process.argv.find((argument) => argument.startsWith('--out='));
const outputPath = outputArg
  ? resolve(projectRoot, outputArg.slice('--out='.length))
  : join(projectRoot, 'outputs/skill-library-finish-plan/web-live-session.json');
const captureDir = join(dirname(outputPath), 'web-live-captures');
mkdirSync(captureDir, { recursive: true });

const LONG_NAME =
  'Ordner „Quartalsberichte und Anhänge der Geschäftsführung 2026“ endgültig löschen';

const PAGE = `<!doctype html>
<html lang="de"><head><meta charset="utf-8"><title>Dateien</title>
<style>
  body{font-family:system-ui,sans-serif;margin:0;padding:24px;background:#fff;color:#111}
  .row{display:flex;gap:16px;align-items:center;margin-bottom:16px}
  button{font:inherit;padding:8px 14px;border:1px solid #444;border-radius:6px;background:#f6f6f6;color:#111}
  button:focus-visible{outline:3px solid #1a5fb4;outline-offset:2px}
  dialog{border:1px solid #333;border-radius:8px;max-width:min(38rem,92vw);padding:20px}
  dialog::backdrop{background:rgba(0,0,0,.45)}
  h2{margin:0 0 8px;font-size:1.15rem}
  #busy[hidden],#error[hidden]{display:none}
  #long{overflow-wrap:anywhere}
  #error{color:#a40000}
</style></head>
<body>
  <div class="row"><button id="other">Hilfe</button></div>
  <div class="row"><button id="open">Ordner löschen…</button></div>
  <dialog id="confirm" aria-labelledby="title" aria-describedby="detail">
    <h2 id="title">Ordner löschen?</h2>
    <p id="detail">Dieser Vorgang kann nicht rückgängig gemacht werden.</p>
    <p id="long">${LONG_NAME}</p>
    <p id="busy" hidden>Wird gelöscht…</p>
    <p id="error" hidden role="alert">Löschen fehlgeschlagen. Erneut versuchen.</p>
    <div class="row">
      <button id="cancel">Abbrechen</button>
      <button id="confirm-button">Endgültig löschen</button>
    </div>
  </dialog>
  <script>
    const dialog = document.getElementById('confirm');
    const open = document.getElementById('open');
    const busy = document.getElementById('busy');
    const error = document.getElementById('error');
    document.body.dataset.state = 'idle';
    open.addEventListener('click', () => {
      dialog.showModal();
      document.body.dataset.state = 'dialog-open';
      document.getElementById('cancel').focus();
    });
    document.getElementById('cancel').addEventListener('click', () => {
      dialog.close();
      document.body.dataset.state = 'cancelled';
      open.focus();
    });
    document.getElementById('confirm-button').addEventListener('click', async () => {
      busy.hidden = false;
      await new Promise((done) => setTimeout(done, 60));
      error.hidden = false;
      document.body.dataset.state = 'failed';
    });
  </script>
</body></html>`;

const browser = await chromium.launch({ args: ['--disable-dev-shm-usage'] });
const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
const page = await context.newPage();
await page.setContent(PAGE, { waitUntil: 'domcontentloaded' });

const focusedId = () =>
  page.evaluate(() => {
    const active = document.activeElement;
    if (!active) return '';
    return active.id || active.tagName.toLowerCase();
  });

await page.keyboard.press('Tab');
const initialFocus = await focusedId();
await page.focus('#open');
await page.keyboard.press('Enter');
await page.waitForTimeout(120);
const focusOnOpen = await focusedId();
const dialogOpen = await page.evaluate(
  () => (document.getElementById('confirm') as HTMLDialogElement).open,
);

const trap: string[] = [];
for (let step = 0; step < 4; step += 1) {
  await page.keyboard.press('Tab');
  trap.push(await focusedId());
}
const trapHeld = trap.every((id) => id === 'cancel' || id === 'confirm-button' || id === 'dialog');

await page.keyboard.press('Escape');
await page.waitForTimeout(120);
const focusAfterEscape = await focusedId();
const closedByEscape = await page.evaluate(
  () => !(document.getElementById('confirm') as HTMLDialogElement).open,
);

await page.keyboard.press('Enter');
await page.waitForTimeout(120);
await page.keyboard.press('Tab');
await page.keyboard.press('Enter');
await page.waitForTimeout(400);
const errorAnnounced = await page.evaluate(() => {
  const error = document.getElementById('error');
  return {
    visible: !error.hidden,
    role: error.getAttribute('role'),
    text: error.textContent?.trim() ?? '',
  };
});

await page.screenshot({ path: join(captureDir, 'dialog-default.png') });

// 200% zoom, as a 640x512 CSS viewport with a doubled device scale.
const zoomContext = await browser.newContext({
  viewport: { width: 640, height: 512 },
  deviceScaleFactor: 2,
});
const zoomPage = await zoomContext.newPage();
await zoomPage.setContent(PAGE, { waitUntil: 'domcontentloaded' });
await zoomPage.focus('#open');
await zoomPage.keyboard.press('Enter');
await zoomPage.waitForTimeout(150);
const zoomGeometry = await zoomPage.evaluate(() => {
  const dialog = document.getElementById('confirm')!;
  const long = document.getElementById('long')!;
  return {
    horizontalOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
    dialogFits: dialog.scrollWidth <= dialog.clientWidth + 1,
    longTextFits: long.scrollWidth <= long.clientWidth + 1,
    dialogRectWidth: Math.round(dialog.getBoundingClientRect().width),
    viewportWidth: document.documentElement.clientWidth,
  };
});
await zoomPage.screenshot({ path: join(captureDir, 'dialog-zoom-200.png') });
await zoomContext.close();
await context.close();
await browser.close();

const session = {
  schemaVersion: 1,
  recordedAt: new Date().toISOString(),
  recordedBy: 'scripts/record-accessibility-verification-web-session.ts',
  browser: `Chromium ${browser.version()}`,
  locale: 'de-DE',
  page: 'delete-confirmation-dialog',
  keyboard: {
    initialFocus,
    focusOnOpen,
    dialogOpen,
    tabStops: trap,
    trapHeld,
    closedByEscape,
    focusAfterEscape,
  },
  errorState: errorAnnounced,
  zoom200: zoomGeometry,
  captures: [
    join(captureDir, 'dialog-default.png').replace(projectRoot + '/', ''),
    join(captureDir, 'dialog-zoom-200.png').replace(projectRoot + '/', ''),
  ],
  spokenOutput: {
    captured: false,
    reason:
      'No screen reader was driven in this session; only browser focus and geometry were measured.',
  },
};

mkdirSync(dirname(outputPath), { recursive: true });
writeFileSync(outputPath, `${JSON.stringify(session, null, 2)}\n`, { mode: 0o600 });
console.log(JSON.stringify(session.keyboard), JSON.stringify(session.zoom200), session.browser);
