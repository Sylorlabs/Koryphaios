// Playwright: test Stop button, live streaming (weird-stop fixes), and the live edit view.
import { chromium } from 'playwright';

const URL = process.env.KORY_URL ?? 'http://localhost:5173/';
const OUT = '/tmp/kory-shots';
const log = (...a: unknown[]) => console.log('•', ...a);

const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await ctx.newPage();
const errors: string[] = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
const shot = async (n: string) => { await page.screenshot({ path: `${OUT}/${n}.png` }); log('shot', n); };

await page.goto(URL, { waitUntil: 'networkidle', timeout: 30_000 });
await page.waitForTimeout(2000);

const sendBtn = () => page.getByRole('button', { name: /send message/i }).first();
const stopBtn = () => page.getByRole('button', { name: /stop the running model|^stop$/i }).first();
const composer = () => page.locator('textarea').first();

async function maybeProceed() {
  const p = page.getByRole('button', { name: /yes,?\s*proceed|proceed/i }).first();
  for (let i = 0; i < 10; i++) {
    if (await p.count().catch(() => 0)) { await p.click().catch(() => {}); log('clicked proceed'); return; }
    await page.waitForTimeout(400);
  }
}

// Ensure Auto agent mode.
await page.getByRole('button', { name: 'Auto', exact: true }).first().click().catch(() => {});

// ── TEST A: short message → Stop appears → streams → completes (no weird stop) ──
let stopSeen = false;
try {
  await composer().fill('Reply with exactly one word: pong');
  await sendBtn().click();
  for (let i = 0; i < 25; i++) {
    if (await stopBtn().count()) { stopSeen = true; break; }
    await page.waitForTimeout(120);
  }
  log('A: Stop button appeared:', stopSeen);
  if (stopSeen) await shot('a1-stop-visible');
  await sendBtn().waitFor({ state: 'visible', timeout: 70_000 }).catch(() => {});
  await page.waitForTimeout(1200);
  await shot('a2-done');
  const txt = await page.locator('body').innerText();
  log('A: reply has "pong":', /pong/i.test(txt));
  log('A: empty-response notice:', /empty response/i.test(txt));
} catch (e) { log('A ERROR:', (e as Error).message); await shot('a-error'); }

// ── TEST B: edit task → live FileEditPreview (spinner + code) ──
try {
  await composer().fill('Use the write_file tool to create a file named PW_DELETE_ME.txt in the project root containing exactly the single word: banana. Do nothing else.');
  await sendBtn().click();
  await maybeProceed();
  // Poll for the live edit preview (filename or NEW badge) and grab a shot mid-stream.
  let previewSeen = false;
  for (let i = 0; i < 80; i++) {
    const body = await page.locator('body').innerText().catch(() => '');
    if (/PW_DELETE_ME\.txt/.test(body)) { previewSeen = true; await shot(`b1-edit-preview-${i}`); break; }
    await page.waitForTimeout(250);
  }
  log('B: file-edit preview shown:', previewSeen);
  await maybeProceed();
  await sendBtn().waitFor({ state: 'visible', timeout: 90_000 }).catch(() => {});
  await page.waitForTimeout(1000);
  await shot('b2-edit-done');
} catch (e) { log('B ERROR:', (e as Error).message); await shot('b-error'); }

log('PAGE_ERRORS:', errors.length ? JSON.stringify([...new Set(errors)].slice(0, 8)) : 'none');
await browser.close();
