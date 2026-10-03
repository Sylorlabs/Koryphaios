import { test, expect } from '@playwright/test';
import { createAuthSession, injectAuthIntoPage } from './helpers/auth';
import { E2E_BACKEND_URL } from './helpers/urls';
import { ApiClient } from './helpers/api';

// Real application/auth; no live provider or user workspace is required.
test('transcript details expand without flooding the workbench', async ({ page }, testInfo) => {
  const auth = await createAuthSession(page.request, E2E_BACKEND_URL);
  const api = new ApiClient(page.request, E2E_BACKEND_URL, auth.bearerToken);
  const sessionId = await api.createSession('UI detail verification');
  await injectAuthIntoPage(page, auth.bearerToken);
  await page.goto('/');
  await expect(page.locator('#main-content')).not.toBeEmpty({ timeout: 30000 });
  await expect
    .poll(() =>
      page.evaluate(async (sid) => {
        const { sessionStore } = await import('/src/lib/stores/sessions.svelte.ts');
        return sessionStore.sessions.some((session) => session.id === sid);
      }, sessionId),
    )
    .toBe(true);
  await page.evaluate(async (sid) => {
    const { sessionStore } = await import('/src/lib/stores/sessions.svelte.ts');
    sessionStore.activeSessionId = sid;
  }, sessionId);
  await expect
    .poll(() =>
      page.evaluate(async (sid) => {
        const { feedStore } = await import('/src/lib/stores/feed.svelte.ts');
        return feedStore.sessionId === sid && !feedStore.isLoadingSession;
      }, sessionId),
    )
    .toBe(true);
  await page.evaluate(async (sid) => {
    const { feedStore } = await import('/src/lib/stores/feed.svelte.ts');
    const common = {
      agentId: 'kory-manager',
      agentName: 'Kory',
      timestamp: Date.now(),
      sessionId: sid,
    };
    feedStore.addFeedEntryForSession(sid, {
      ...common,
      type: 'content',
      text: 'Updated the layout. The transcript now keeps details inline.',
    });
    feedStore.addFeedEntryForSession(sid, {
      ...common,
      timestamp: Date.now() + 1,
      type: 'compaction',
      text: 'Archived earlier tool output.',
      metadata: { phase: 'complete', progress: 100, sourceMessages: 12 },
    });
  }, sessionId);
  await expect(page.getByText('Updated the layout.', { exact: false })).toBeVisible();
  const details = page.getByRole('button', { name: /Context compacted/ });
  await expect(details).toHaveAttribute('aria-expanded', 'false');
  await details.click();
  await expect(details).toHaveAttribute('aria-expanded', 'true');
  await expect(page.getByText('Archived earlier tool output.')).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('transcript-expanded.png') });
  await details.click();
  await expect(details).toHaveAttribute('aria-expanded', 'false');
});
for (const width of [1280, 700]) {
  test(`workbench settings and welcome remain usable at ${width}px`, async ({ page }, testInfo) => {
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.setViewportSize({ width, height: 800 });
    const auth = await createAuthSession(page.request, E2E_BACKEND_URL);
    await injectAuthIntoPage(page, auth.bearerToken);
    await page.goto('/');
    await expect(page.locator('#main-content')).not.toBeEmpty({ timeout: 30000 });
    await page.screenshot({ path: testInfo.outputPath('welcome.png') });
    await page.getByRole('button', { name: 'Open settings', exact: true }).first().click();
    const dialog = page.getByRole('dialog', { name: 'Settings' });
    await expect(dialog).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath('settings.png') });
    const mcp = dialog.getByRole('button', { name: /^MCP servers/ });
    await mcp.click();
    await expect(dialog.getByRole('heading', { name: 'MCP servers', exact: true })).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath('mcp.png') });
    await dialog.getByRole('button', { name: 'Add manually' }).first().click();
    await expect(dialog.getByRole('heading', { name: 'Add MCP server' })).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath('mcp-form.png') });
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
    await page.keyboard.press('Escape');
    await expect(dialog).not.toBeVisible();
    await page.evaluate(async () => {
      const { theme } = await import('/src/lib/stores/theme.svelte.ts');
      theme.setPreset('light');
    });
    await page.screenshot({ path: testInfo.outputPath('light-workbench.png') });
    await page.getByRole('button', { name: 'Open settings', exact: true }).first().click();
    await expect(dialog).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath('light-settings.png') });
    expect(errors).toEqual([]);
  });
}
