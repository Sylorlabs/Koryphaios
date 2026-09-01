import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from './helpers/fixture';

interface NotesSidebarRegressionState {
  loadingSeen: boolean;
  missingTitleSeen: boolean;
  samples: string[];
}

function isNotesMutationResponse(
  response: import('@playwright/test').Response,
  method: 'POST' | 'PUT' | 'DELETE',
  noteId?: string,
  suffix = '',
): boolean {
  const request = response.request();
  const path = new URL(response.url()).pathname;
  const expectedPath = noteId ? `/api/notes/${noteId}${suffix}` : '/api/notes';
  return request.method() === method && path === expectedPath;
}

test('Notes quick-create, stable save, history, Trash, and restore work through the real UI', async ({
  authenticatedPage: page,
  api,
}, testInfo) => {
  test.setTimeout(120_000);

  const projectRoot = await mkdtemp(join(tmpdir(), 'kory-notes-e2e-'));
  const noteTitle = `Exact agentic note ${testInfo.workerIndex}-${Date.now()}`;
  const noteContent =
    'This content must remain visible, saved, revisioned, trashed, and restored without blanking the note list.';

  try {
    const selected = await api.post('/api/workspace/select', { path: projectRoot });
    expect(selected.ok(), `Selecting the isolated Notes project failed: ${selected.status()}`).toBe(
      true,
    );

    await page.goto('/');
    await expect(page.locator('#main-content')).not.toBeEmpty({ timeout: 30_000 });

    const openNotes = page.getByRole('button', { name: 'Notes', exact: true });
    await expect(openNotes).toBeVisible({ timeout: 15_000 });
    await openNotes.click();

    const trashTrigger = page.getByRole('button', { name: 'Open Notes Trash' });
    await expect(trashTrigger).toBeVisible({ timeout: 15_000 });
    const notesSidebar = page.locator('aside').filter({ has: trashTrigger });
    await expect(notesSidebar).toBeVisible();

    // The panel-level shortcut must beat Chromium's native Ctrl+O handling and
    // search the complete catalog even while the visible list is filtered.
    await page.keyboard.press('Control+O');
    const switcher = page.getByRole('dialog', { name: 'Open a note' });
    await expect(switcher).toBeVisible();
    const switcherInput = switcher.getByRole('combobox', { name: 'Search notes' });
    await switcherInput.fill(noteTitle);
    await expect(switcher.getByRole('option', { name: `Create “${noteTitle}”` })).toBeVisible();

    const createResponsePromise = page.waitForResponse((response) =>
      isNotesMutationResponse(response, 'POST'),
    );
    await switcherInput.press('Control+Enter');
    const createResponse = await createResponsePromise;
    expect(createResponse.ok(), `Creating a note failed: ${createResponse.status()}`).toBe(true);
    const createBody = (await createResponse.json()) as { data?: { id?: string } };
    const noteId = createBody.data?.id;
    if (!noteId) {
      throw new Error('The create response did not identify the note used by the rest of the flow');
    }

    const titleInput = page.getByPlaceholder('Note title...');
    const contentInput = page.getByPlaceholder(
      'Start writing... Use [[Note Title]] to link notes.',
    );
    await expect(titleInput).toHaveValue(noteTitle);
    await expect(notesSidebar.getByText(noteTitle, { exact: true })).toBeVisible();

    // Record even short-lived list replacement. A normal assertion after the
    // save would miss the loading flash that made the old implementation feel
    // like a strobe on every local mutation.
    await notesSidebar.evaluate((sidebar, expectedTitle) => {
      const state: NotesSidebarRegressionState = {
        loadingSeen: false,
        missingTitleSeen: false,
        samples: [],
      };
      const sample = () => {
        const text = sidebar.textContent ?? '';
        state.loadingSeen ||= text.includes('Loading...');
        state.missingTitleSeen ||= !text.includes(expectedTitle);
        if (state.samples.length < 8 && (state.loadingSeen || state.missingTitleSeen)) {
          state.samples.push(text.replace(/\s+/g, ' ').trim().slice(0, 240));
        }
      };
      sample();
      new MutationObserver(sample).observe(sidebar, {
        childList: true,
        subtree: true,
        characterData: true,
      });
      (
        window as Window & { __koryNotesSidebarRegression?: NotesSidebarRegressionState }
      ).__koryNotesSidebarRegression = state;
    }, noteTitle);

    await contentInput.fill(noteContent);
    const saveButton = page.getByTitle('Save (Ctrl+S)');
    await expect(saveButton).toHaveText('Save');
    const saveResponsePromise = page.waitForResponse((response) =>
      isNotesMutationResponse(response, 'PUT', noteId),
    );
    await contentInput.press('Control+S');
    const saveResponse = await saveResponsePromise;
    expect(saveResponse.ok(), `Saving the note failed: ${saveResponse.status()}`).toBe(true);
    await expect(saveButton).toContainText('Saved');
    await expect(notesSidebar.getByText(noteTitle, { exact: true })).toBeVisible();

    // History is loaded from the backend's immutable snapshots, not inferred
    // from the editor state. Create + save must yield at least two revisions.
    await page.getByRole('button', { name: 'History', exact: true }).click();
    const recoveryDialog = page.getByRole('dialog', { name: 'Recover notes and history' });
    await expect(recoveryDialog).toBeVisible();
    await expect(recoveryDialog.getByRole('tab', { name: /Revision history/ })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    const revisionButtons = recoveryDialog
      .getByRole('region', { name: 'Saved revisions' })
      .getByRole('button', { name: /^Revision \d+,/ });
    await expect.poll(() => revisionButtons.count(), { timeout: 15_000 }).toBeGreaterThanOrEqual(2);

    const sidebarRegression = await page.evaluate(
      () =>
        (window as Window & { __koryNotesSidebarRegression?: NotesSidebarRegressionState })
          .__koryNotesSidebarRegression,
    );
    expect(sidebarRegression, 'The sidebar mutation observer should remain installed').toEqual({
      loadingSeen: false,
      missingTitleSeen: false,
      samples: [],
    });
    await recoveryDialog.getByRole('button', { name: 'Close recovery' }).click();

    const deleteResponsePromise = page.waitForResponse((response) =>
      isNotesMutationResponse(response, 'DELETE', noteId),
    );
    const confirmationPromise = page.waitForEvent('dialog');
    const deleteClick = page.getByRole('button', { name: 'Move note to Trash' }).click();
    const confirmation = await confirmationPromise;
    expect(confirmation.type()).toBe('confirm');
    expect(confirmation.message()).toContain(`Move "${noteTitle}" to Trash?`);
    expect(confirmation.message()).toContain('You can restore it later.');
    await confirmation.accept();
    await deleteClick;
    const deleteResponse = await deleteResponsePromise;
    expect(deleteResponse.ok(), `Moving the note to Trash failed: ${deleteResponse.status()}`).toBe(
      true,
    );
    await expect(notesSidebar.getByText(noteTitle, { exact: true })).toHaveCount(0);

    await trashTrigger.click();
    await expect(recoveryDialog).toBeVisible();
    await expect(recoveryDialog.getByRole('tab', { name: /Trash/ })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    const restoreButton = recoveryDialog.getByRole('button', {
      name: `Restore ${noteTitle} from Trash`,
    });
    await expect(restoreButton).toBeVisible({ timeout: 15_000 });
    const restoreResponsePromise = page.waitForResponse((response) =>
      isNotesMutationResponse(response, 'POST', noteId, '/restore'),
    );
    await restoreButton.click();
    const restoreResponse = await restoreResponsePromise;
    expect(
      restoreResponse.ok(),
      `Restoring the note from Trash failed: ${restoreResponse.status()}`,
    ).toBe(true);
    await expect(recoveryDialog.getByText('Trash is empty', { exact: true })).toBeVisible();
    await recoveryDialog.getByRole('button', { name: 'Close recovery' }).click();
    await expect(notesSidebar.getByText(noteTitle, { exact: true })).toBeVisible();

    // Reopen through the same keyboard retrieval path and prove the saved body
    // survived the complete active -> trash -> restored lifecycle.
    await page.keyboard.press('Control+O');
    await expect(switcher).toBeVisible();
    await switcherInput.fill(noteTitle);
    await switcherInput.press('Enter');
    await expect(contentInput).toHaveValue(noteContent);
  } finally {
    await api.post('/api/workspace/deselect').catch(() => undefined);
    await rm(projectRoot, { recursive: true, force: true });
  }
});
