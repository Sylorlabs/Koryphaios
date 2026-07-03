// Verify project-scoped sessions: with a project "open" (localStorage path),
// new sessions carry workingDirectory, the sidebar shows the project header +
// Project/All toggle, and Project scope filters the list down.
import { chromium } from 'playwright';

const URL = process.env.KORY_URL ?? 'http://127.0.0.1:3003/';
const OUT = '/tmp/kory-shots';
const PROJECT = '/home/micah/Desktop/Sylorlabs/Koryphaios';

const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await ctx.newPage();
await ctx.addInitScript((p) => {
  localStorage.setItem('koryphaios-current-project', p);
  localStorage.setItem('koryphaios-session-scope', 'project');
}, PROJECT);

await page.goto(URL, { waitUntil: 'networkidle', timeout: 30_000 });
await page.waitForTimeout(2500);

// Project header + toggle visible?
const header = page.getByTitle(PROJECT).first();
console.log('PROJECT_HEADER_VISIBLE:', await header.isVisible().catch(() => false));
console.log('TOGGLE_PROJECT:', await page.getByTitle('Only chats from this project').isVisible().catch(() => false));

// In project scope, sidebar should show 0 sessions (none scoped yet)
const sessionCountBefore = await page.locator('.session-item').count();
console.log('PROJECT_SCOPE_SESSIONS_BEFORE:', sessionCountBefore);

// Create a session → should carry workingDirectory
await page.getByLabel('New session').click();
await page.waitForTimeout(1500);
const sessionCountAfter = await page.locator('.session-item').count();
console.log('PROJECT_SCOPE_SESSIONS_AFTER_CREATE:', sessionCountAfter);

// Switch to All → legacy sessions reappear, new one has a project tag
await page.getByTitle('Chats from all projects').click();
await page.waitForTimeout(800);
const allCount = await page.locator('.session-item').count();
const tagVisible = await page.locator('span:has-text("Koryphaios")').first().isVisible().catch(() => false);
console.log('ALL_SCOPE_SESSIONS:', allCount, 'PROJECT_TAG_VISIBLE:', tagVisible);
await page.screenshot({ path: `${OUT}/ps-01-all-scope.png` });

// Back to Project scope: only the new session should remain
await page.getByTitle('Only chats from this project').click();
await page.waitForTimeout(800);
console.log('PROJECT_SCOPE_FINAL:', await page.locator('.session-item').count());
await page.screenshot({ path: `${OUT}/ps-02-project-scope.png` });

await browser.close();
