import { chromium } from 'playwright';
import { existsSync, readFileSync, rmSync } from 'node:fs';
const URL = 'http://localhost:5173/';
const OUT = '/tmp/kory-shots';
const FILE = '/home/micah/Desktop/Sylorlabs/Koryphaios/PW_AGENTIC_DELETE.txt';
const log = (...a: unknown[]) => console.log('•', ...a);
rmSync(FILE, { force: true });

const browser = await chromium.launch({ headless: true });
const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
await page.goto(URL, { waitUntil: 'networkidle', timeout: 30_000 });
await page.waitForTimeout(2000);

const sendBtn = () => page.getByRole('button', { name: /send message/i }).first();
await page.locator('textarea').first().fill('Create a file named PW_AGENTIC_DELETE.txt in the project root containing exactly the word grape. Then use Edit to change grape to plum. Do nothing else.');
await sendBtn().click();
// approve if asked
for (let i = 0; i < 10; i++) {
  const p = page.getByRole('button', { name: /yes,?\s*proceed|proceed/i }).first();
  if (await p.count().catch(() => 0)) { await p.click().catch(() => {}); log('proceed clicked'); break; }
  await page.waitForTimeout(400);
}

let previewShot = false;
let fileSeen = false;
for (let i = 0; i < 120; i++) {
  // Catch the live preview: the FileEditPreview shows the filename + a NEW/EDIT badge.
  if (!previewShot) {
    const hasBadge = await page.locator('text=/^(NEW|EDIT)$/').count().catch(() => 0);
    const hasName = await page.getByText('PW_AGENTIC_DELETE.txt').count().catch(() => 0);
    if (hasBadge && hasName) { await page.screenshot({ path: `${OUT}/claude-edit-live.png` }); previewShot = true; log('live edit preview captured (frame', i, ')'); }
  }
  if (!fileSeen && existsSync(FILE)) { fileSeen = true; log('file created on disk at frame', i); await page.screenshot({ path: `${OUT}/claude-edit-fileseen.png` }); }
  if (await sendBtn().count()) break; // run finished (Send returned)
  await page.waitForTimeout(500);
}
await page.waitForTimeout(1500);
await page.screenshot({ path: `${OUT}/claude-edit-done.png` });

log('live preview captured:', previewShot);
log('file exists:', existsSync(FILE), '| contents:', existsSync(FILE) ? JSON.stringify(readFileSync(FILE, 'utf-8')) : 'N/A');
await browser.close();
