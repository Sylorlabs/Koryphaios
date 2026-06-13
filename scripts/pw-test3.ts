import { chromium } from 'playwright';
const URL = process.env.KORY_URL ?? 'http://localhost:5173/';
const OUT = '/tmp/kory-shots';
const log = (...a: unknown[]) => console.log('•', ...a);
const browser = await chromium.launch({ headless: true });
const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
const shot = async (n: string) => { await page.screenshot({ path: `${OUT}/${n}.png` }); };
await page.goto(URL, { waitUntil: 'networkidle', timeout: 30_000 });
await page.waitForTimeout(2000);

const sendBtn = () => page.getByRole('button', { name: /send message/i }).first();
const composer = () => page.locator('textarea').first();
async function maybeProceed() {
  for (let i = 0; i < 12; i++) {
    const p = page.getByRole('button', { name: /yes,?\s*proceed|proceed/i }).first();
    if (await p.count().catch(() => 0)) { await p.click().catch(() => {}); log('clicked proceed'); return; }
    await page.waitForTimeout(400);
  }
}

// TEST A: a real reply (no "No provider")
await composer().fill('Reply with only this exact token and nothing else: ZQX42TOKEN');
await sendBtn().click();
await maybeProceed();
await sendBtn().waitFor({ state: 'visible', timeout: 90_000 }).catch(() => {});
await page.waitForTimeout(1500);
await shot('t3-a-reply');
const bodyA = await page.locator('body').innerText();
const tokenCount = (bodyA.match(/ZQX42TOKEN/g) || []).length;
log('A: "No provider" present:', /no provider/i.test(bodyA));
log('A: token occurrences (>=2 means a real reply, not just the echo):', tokenCount);

// TEST B: live edit view
await composer().fill('Use the write_file tool to create a file named PW_DELETE_ME.txt in the project root containing exactly the single word: banana. Then stop.');
await sendBtn().click();
await maybeProceed();
let previewSeen = false;
for (let i = 0; i < 100; i++) {
  const body = await page.locator('body').innerText().catch(() => '');
  if (/PW_DELETE_ME\.txt/.test(body)) { previewSeen = true; await shot('t3-b-edit-live'); break; }
  await page.waitForTimeout(250);
}
log('B: file-edit preview appeared:', previewSeen);
await maybeProceed();
await sendBtn().waitFor({ state: 'visible', timeout: 90_000 }).catch(() => {});
await page.waitForTimeout(1000);
await shot('t3-b-edit-done');
await browser.close();
