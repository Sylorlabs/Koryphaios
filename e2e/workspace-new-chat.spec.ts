import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { test, expect } from '@playwright/test';
import { createAuthSession, injectAuthIntoPage } from './helpers/auth';
import { ApiClient } from './helpers/api';
import { E2E_BACKEND_URL } from './helpers/urls';

test('workspace new chat opens the animated folder picker and creates chats in the chosen folder', async ({
  page,
  request,
}) => {
  test.setTimeout(180_000);
  const fixture = mkdtempSync(join(tmpdir(), 'kory-workspace-new-chat-'));
  mkdirSync(join(fixture, 'alpha'), { recursive: true });
  mkdirSync(join(fixture, 'empty-folder'), { recursive: true });
  const root = realpathSync(fixture);
  const auth = await createAuthSession(request, E2E_BACKEND_URL);
  const api = new ApiClient(request, E2E_BACKEND_URL, auth.bearerToken);
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));

  try {
    const opened = await api.post('/api/workspace/open', { root });
    expect(opened.ok()).toBe(true);
    await injectAuthIntoPage(page, auth.bearerToken);
    await page.goto('/');

    const picker = page.getByTestId('workspace-new-chat');
    await expect(picker).toBeVisible({ timeout: 120_000 });
    await expect(
      picker.getByRole('heading', { name: `New chat in ${basename(root)}` }),
    ).toBeVisible();
    const cards = picker.getByRole('list', { name: 'Workspace folders' }).getByRole('button');
    await expect(cards).toHaveCount(2);
    const emptyFolder = picker.getByRole('button', { name: /Start a new chat in empty-folder/ });
    await emptyFolder.hover();
    await expect(emptyFolder.locator('.folder-toggle-icon')).toHaveAttribute('data-open', 'true');
    expect(
      await emptyFolder.locator('..').evaluate((node) => getComputedStyle(node).animationName),
    ).not.toBe('none');

    const search = picker.getByRole('searchbox', { name: 'Search workspace folders' });
    await search.fill('empty');
    await expect(cards).toHaveCount(1);
    const createdResponse = page.waitForResponse(
      (response) =>
        response.url().endsWith('/api/sessions') && response.request().method() === 'POST',
    );
    await search.press('Enter');
    const response = await createdResponse;
    expect(response.ok()).toBe(true);
    const created = await response.json();
    expect(created.data.workingDirectory).toBe(join(root, 'empty-folder'));
    await expect(picker).not.toBeVisible();

    const workspacePlus = page.getByRole('button', {
      name: `New chat in workspace ${basename(root)}`,
      exact: true,
    });
    await workspacePlus.click();
    await expect(picker).toBeVisible();
    await expect(cards).toHaveCount(2);
    const sessions = await api.getJson<{ data: Array<{ id: string; workingDirectory: string }> }>(
      '/api/sessions',
    );
    expect(
      sessions.data.filter((session) => session.workingDirectory?.startsWith(root)),
    ).toHaveLength(1);

    // The root option must create a fresh chat even after a project was selected.
    const rootResponse = page.waitForResponse(
      (response) =>
        response.url().endsWith('/api/sessions') && response.request().method() === 'POST',
    );
    await picker
      .getByRole('button', { name: `Start a new chat in ${basename(root)} itself. No chats yet` })
      .click();
    const rootResult = await rootResponse;
    expect(rootResult.ok()).toBe(true);
    const rootChat = await rootResult.json();
    expect(rootChat.data.workingDirectory).toBe(root);
    expect(rootChat.data.id).not.toBe(created.data.id);
    await expect(picker).not.toBeVisible();
    await workspacePlus.click();
    await expect(picker).toBeVisible();
    expect(errors).toEqual([]);
  } finally {
    await api.delete('/api/workspace/state');
    rmSync(fixture, { recursive: true, force: true });
  }
});
