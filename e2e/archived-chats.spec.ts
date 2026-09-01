import { test, expect } from './helpers/fixture';

interface LifecycleSession {
  id: string;
  title: string;
  status?: 'active' | 'archived';
  archivedAt?: number;
}

interface SessionListResponse {
  ok: boolean;
  data: LifecycleSession[];
}

function escaped(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function openSessionName(title: string): RegExp {
  return new RegExp(`^Open session ${escaped(title)}(?:, currently open)?$`);
}

test('archives a chat and manages its complete lifecycle from Settings', async ({
  authenticatedPage: page,
  api,
}, testInfo) => {
  test.setTimeout(90_000);

  const originalTitle = `Archive lifecycle ${testInfo.workerIndex}-${Date.now()}`;
  const renamedTitle = `${originalTitle} renamed`;

  await page.goto('/');
  await expect(page.locator('#main-content')).not.toBeEmpty({ timeout: 30_000 });

  const sidebar = page.getByRole('navigation', { name: 'Session navigation' });
  await expect(sidebar).toBeVisible({ timeout: 10_000 });

  // Create through the same UI control users rely on. This avoids coupling the
  // browser half of the test to a side-channel store refresh after an API write.
  await sidebar.getByRole('button', { name: 'New session', exact: true }).click();
  const draftButton = sidebar.getByRole('button', {
    name: 'Open session New Session, currently open',
    exact: true,
  });
  await expect(draftButton).toBeVisible({ timeout: 15_000 });
  // Keep the row locator stable when Rename swaps the open-session button for
  // an inline textbox.
  const draftRow = sidebar.locator('.session-item.active-session');
  await expect(draftRow).toHaveCount(1);
  await draftRow.hover();
  await draftRow.getByRole('button', { name: 'Rename session' }).click();
  const draftTitle = draftRow.getByRole('textbox');
  await draftTitle.fill(originalTitle);
  await draftTitle.press('Enter');

  const sessionButton = sidebar.getByRole('button', {
    name: openSessionName(originalTitle),
  });
  await expect(sessionButton).toBeVisible({ timeout: 15_000 });
  let sessionId = '';
  await expect
    .poll(async () => {
      const active = await api.getJson<SessionListResponse>('/api/sessions');
      sessionId = active.data.find((session) => session.title === originalTitle)?.id ?? '';
      return sessionId;
    })
    .not.toBe('');
  const sessionRow = sessionButton.locator('..');
  await sessionRow.hover();

  const lifecycleActions = await sessionRow
    .locator('button[aria-label]')
    .evaluateAll((buttons) =>
      buttons
        .map((button) => button.getAttribute('aria-label'))
        .filter((label) =>
          ['Rename session', 'Archive chat', 'Delete session'].includes(label ?? ''),
        ),
    );
  expect(lifecycleActions).toEqual(['Rename session', 'Archive chat', 'Delete session']);

  await sessionRow.getByRole('button', { name: 'Archive chat' }).click();
  await expect(sessionButton).toHaveCount(0);

  await expect
    .poll(async () => {
      const active = await api.getJson<SessionListResponse>('/api/sessions');
      return active.data.some((session) => session.id === sessionId);
    })
    .toBe(false);
  await expect
    .poll(async () => {
      const archived = await api.getJson<SessionListResponse>('/api/sessions/archived');
      return archived.data.find((session) => session.id === sessionId);
    })
    .toMatchObject({
      id: sessionId,
      title: originalTitle,
      status: 'archived',
    });

  // Archiving is a server-enforced lifecycle state, not only a sidebar filter.
  // A stale client must not be able to append work while the chat is archived.
  const rejectedMessage = await api.post('/api/messages', {
    sessionId,
    content: 'This message must not be persisted while archived.',
  });
  expect(rejectedMessage.status()).toBe(409);
  expect(await api.getMessages(sessionId)).toEqual({ ok: true, data: [] });

  await page.keyboard.press('Control+,');
  const settingsDialog = page.getByRole('dialog', { name: 'Settings' });
  await expect(settingsDialog).toBeVisible({ timeout: 10_000 });
  await settingsDialog.getByRole('button', { name: /Archived chats/ }).click();
  await expect(
    settingsDialog.getByRole('heading', { name: 'Archived chats', exact: true }),
  ).toBeVisible();

  let archivedCard = settingsDialog.getByRole('article', { name: originalTitle });
  await expect(archivedCard).toBeVisible();
  await archivedCard.getByRole('button', { name: `Rename ${originalTitle}` }).click();
  const renameInput = settingsDialog.getByRole('textbox', { name: `Rename ${originalTitle}` });
  await renameInput.fill(renamedTitle);
  await settingsDialog.getByRole('button', { name: `Save renamed chat ${originalTitle}` }).click();

  archivedCard = settingsDialog.getByRole('article', { name: renamedTitle });
  await expect(archivedCard).toBeVisible();
  await expect
    .poll(async () => {
      const archived = await api.getJson<SessionListResponse>('/api/sessions/archived');
      return archived.data.find((session) => session.id === sessionId)?.title;
    })
    .toBe(renamedTitle);

  await archivedCard.getByRole('button', { name: `Restore ${renamedTitle}` }).click();
  await expect(archivedCard).toHaveCount(0);
  await expect
    .poll(async () => {
      const active = await api.getJson<SessionListResponse>('/api/sessions');
      const archived = await api.getJson<SessionListResponse>('/api/sessions/archived');
      return {
        activeTitle: active.data.find((session) => session.id === sessionId)?.title,
        stillArchived: archived.data.some((session) => session.id === sessionId),
      };
    })
    .toEqual({ activeTitle: renamedTitle, stillArchived: false });

  await page.keyboard.press('Escape');
  await expect(settingsDialog).toBeHidden();

  const restoredButton = sidebar.getByRole('button', {
    name: openSessionName(renamedTitle),
  });
  await expect(restoredButton).toBeVisible();
  const restoredRow = restoredButton.locator('..');
  await restoredRow.hover();
  await restoredRow.getByRole('button', { name: 'Archive chat' }).click();
  await expect(restoredButton).toHaveCount(0);

  await page.keyboard.press('Control+,');
  await expect(settingsDialog).toBeVisible();
  await settingsDialog.getByRole('button', { name: /Archived chats/ }).click();
  archivedCard = settingsDialog.getByRole('article', { name: renamedTitle });
  await expect(archivedCard).toBeVisible();
  await archivedCard.getByRole('button', { name: `Delete ${renamedTitle} permanently` }).click();

  const confirmation = page.getByRole('alertdialog');
  await expect(confirmation).toContainText('Permanently delete archived chat?');
  await expect(confirmation).toContainText(renamedTitle);
  await confirmation.getByRole('button', { name: 'Delete permanently' }).click();
  await expect(confirmation).toHaveCount(0);
  await expect(
    settingsDialog.getByRole('heading', { name: 'No archived chats', exact: true }),
  ).toBeVisible();

  await expect
    .poll(async () => {
      const archived = await api.getJson<SessionListResponse>('/api/sessions/archived');
      return archived.data;
    })
    .toEqual([]);
  const deleted = await api.get(`/api/sessions/${sessionId}`);
  expect(deleted.status()).toBe(404);
});
