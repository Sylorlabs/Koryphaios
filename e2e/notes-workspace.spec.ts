import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, expect } from './helpers/fixture';

test('Notes is a dedicated workspace with compound Bases, Canvas and per-operation settings', async ({
  authenticatedPage: page,
  api,
}, testInfo) => {
  test.setTimeout(120000);
  const root = await mkdtemp(join(tmpdir(), 'kory-workspace-e2e-'));
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  try {
    await writeFile(
      join(root, 'finding.md'),
      '---\nstatus: open\npriority: 3\n---\n# Finding\nMeasured evidence.',
    );
    expect((await api.post('/api/workspace/select', { path: root })).ok()).toBe(true);
    await page.goto('/');
    await page.getByRole('button', { name: 'Notes', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Close notes' })).toBeVisible();
    await expect(page.getByTestId('chat-feed')).toHaveCount(0);
    await page.getByRole('tab', { name: 'Bases', exact: true }).click();
    await page.getByRole('button', { name: 'Create your first Base' }).click();
    await expect(page.getByRole('button', { name: /^Open / }).first()).toBeVisible();
    await page.getByRole('button', { name: 'Add condition', exact: true }).click();
    await page.getByRole('button', { name: 'Add another condition' }).click();
    await expect(page.getByRole('combobox', { name: 'Match conditions' })).toBeVisible();
    await page.getByRole('button', { name: 'Add sort', exact: true }).click();
    await expect(page.getByRole('combobox', { name: 'Sort field 2', exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Save Base', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Create Canvas from this page' })).toBeEnabled();
    await page.getByRole('button', { name: 'Create Canvas from this page' }).click();
    await expect(page.getByRole('tab', { name: 'Canvas', exact: true })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    await expect(page.getByRole('textbox', { name: 'Canvas name' })).toHaveValue('New Base canvas');
    await expect(page.getByRole('button', { name: /^Move canvas card:/ })).toHaveCount(1);
    await page.screenshot({ path: testInfo.outputPath('notes-canvas.png'), fullPage: true });
    await page.setViewportSize({ width: 768, height: 900 });
    await expect(page.getByRole('tab', { name: 'Canvas', exact: true })).toBeVisible();
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth > window.innerWidth,
    );
    expect(overflow).toBe(false);
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.getByRole('combobox', { name: 'Create from template' }).click();
    await page.getByRole('option', { name: 'Bug investigation', exact: true }).click();
    await expect(page.getByPlaceholder('Note title...')).toHaveValue('Bug investigation');
    await expect(page.getByRole('combobox', { name: 'Note content' })).toHaveValue(
      /## Verification/,
    );
    await page.getByRole('button', { name: 'Ask agent', exact: true }).click();
    await expect(page.getByTestId('chat-feed')).toBeVisible();
    await expect(page.locator('textarea').first()).toHaveValue(
      /Investigate note "Bug investigation"/,
    );
    await page.getByRole('button', { name: 'Notes', exact: true }).click();
    await page.getByRole('button', { name: 'Close notes' }).click();
    await expect(page.getByTestId('chat-feed')).toBeVisible();
    await page.getByRole('button', { name: 'Open settings', exact: true }).click();
    await page
      .getByRole('navigation', { name: 'Settings sections' })
      .getByRole('button', { name: /^Notes Current project$/ })
      .click();
    // Tool access is configured in Agent behavior; Notes no longer duplicates
    // the permission profile or per-action overrides.
    await expect(page.getByRole('heading', { name: 'Agent access' })).toHaveCount(0);
    await expect(page.getByRole('combobox', { name: 'Notes permission profile' })).toHaveCount(0);
    expect(errors).toEqual([]);
  } finally {
    try {
      await api.post('/api/workspace/deselect');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
});

test('relationship proposals can be accepted, rejected, and refreshed after evidence goes stale', async ({
  authenticatedPage: page,
  api,
}) => {
  test.setTimeout(120000);
  const root = await mkdtemp(join(tmpdir(), 'kory-relationship-review-e2e-'));
  const project = { 'x-koryphaios-project': root };
  try {
    expect((await api.post('/api/workspace/select', { path: root })).ok()).toBe(true);
    const makeNote = async (title: string) => {
      const response = await api.post(
        '/api/notes',
        { title, content: `${title} evidence.` },
        project,
      );
      expect(response.ok(), `Creating ${title} failed: ${response.status()}`).toBe(true);
      return ((await response.json()) as { data: { id: string; revision: number } }).data;
    };
    const alpha = await makeNote('Relationship Alpha');
    const beta = await makeNote('Relationship Beta');
    const gamma = await makeNote('Relationship Gamma');
    const delta = await makeNote('Relationship Delta');

    const propose = async (from: typeof alpha, to: typeof beta, evidence: string) => {
      const response = await api.post(
        '/api/notes/relationships',
        {
          fromId: from.id,
          toId: to.id,
          type: 'supports',
          evidence,
          expectedSourceRevision: from.revision,
          expectedTargetRevision: to.revision,
        },
        project,
      );
      expect(response.ok(), `Creating relationship proposal failed: ${response.status()}`).toBe(
        true,
      );
      return ((await response.json()) as { data: { revision: number } }).data;
    };
    await propose(alpha, beta, 'Alpha measurements support Beta.');
    await propose(gamma, delta, 'Gamma observations support Delta.');

    await page.goto('/');
    await page.getByRole('button', { name: 'Notes', exact: true }).click();
    await page.getByRole('tab', { name: 'Review', exact: true }).click();
    const review = page.getByRole('region', { name: 'Change review' });
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(review).toBeVisible();
    expect(await review.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(
      true,
    );
    await page.setViewportSize({ width: 1280, height: 900 });
    const acceptAlpha = review.getByRole('button', {
      name: 'Accept Relationship Alpha supports Relationship Beta',
    });
    await expect(acceptAlpha).toBeVisible();
    const acceptResponse = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === `/api/notes/relationships/${alpha.id}/${beta.id}` &&
        response.request().method() === 'PATCH',
    );
    await acceptAlpha.click();
    expect((await acceptResponse).ok()).toBe(true);
    await expect(
      review.getByRole('button', {
        name: 'Reject Relationship Gamma supports Relationship Delta',
      }),
    ).toBeVisible();
    const rejectResponse = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === `/api/notes/relationships/${gamma.id}/${delta.id}` &&
        response.request().method() === 'PATCH',
    );
    await review
      .getByRole('button', {
        name: 'Reject Relationship Gamma supports Relationship Delta',
      })
      .click();
    expect((await rejectResponse).ok()).toBe(true);

    // Editing an endpoint invalidates the accepted evidence, and the review
    // queue exposes the deliberate Network workflow rather than reaccepting it.
    const changed = await api.put(
      `/api/notes/${alpha.id}`,
      {
        content: 'Relationship Alpha evidence changed after review.',
        expectedRevision: alpha.revision,
      },
      project,
    );
    expect(changed.ok()).toBe(true);
    await page.getByRole('button', { name: 'Refresh' }).click();
    await expect(review.getByText('Stale evidence (1)')).toBeVisible();
    const refreshEvidence = review.getByRole('button', {
      name: 'Open Network to refresh evidence for Relationship Alpha supports Relationship Beta',
    });
    await refreshEvidence.click();

    await page.getByRole('tab', { name: 'Network', exact: true }).click();
    await page
      .getByRole('button', {
        name: 'Refresh evidence for Relationship Alpha and Relationship Beta',
      })
      .click();
    await expect(
      page.getByText('Refresh evidence as a new proposal', { exact: true }),
    ).toBeVisible();
    const evidence = page.getByRole('textbox', { name: 'Evidence' });
    await expect(evidence).toHaveValue('Alpha measurements support Beta.');
    await evidence.fill('Updated Alpha evidence supports Beta at the current revisions.');
    const refreshedResponse = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname ===
          `/api/notes/relationships/${alpha.id}/${beta.id}/refresh` &&
        response.request().method() === 'POST',
    );
    await page.getByRole('button', { name: 'Save refreshed proposal' }).click();
    const refreshed = await refreshedResponse;
    expect(refreshed.ok()).toBe(true);
    expect(
      ((await refreshed.json()) as { data: { status: string; stale: boolean } }).data,
    ).toMatchObject({ status: 'proposed', stale: false });

    await page.getByRole('tab', { name: 'Review', exact: true }).click();
    const refreshedAccept = review.getByRole('button', {
      name: 'Accept Relationship Alpha supports Relationship Beta',
    });
    await expect(refreshedAccept).toBeEnabled();
    const finalAcceptResponse = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === `/api/notes/relationships/${alpha.id}/${beta.id}` &&
        response.request().method() === 'PATCH',
    );
    await refreshedAccept.click();
    expect((await finalAcceptResponse).ok()).toBe(true);
  } finally {
    try {
      await page
        .getByRole('button', { name: 'Close notes' })
        .click()
        .catch(() => undefined);
      await api.post('/api/workspace/deselect');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
});

test('note appearances, unified change review and chat-finding capture', async ({
  authenticatedPage: page,
  api,
}, testInfo) => {
  test.setTimeout(120000);
  const root = await mkdtemp(join(tmpdir(), 'kory-notes-flows-e2e-'));
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const project = { 'x-koryphaios-project': root };
  try {
    expect((await api.post('/api/workspace/select', { path: root })).ok()).toBe(true);
    await api.post(
      '/api/notes',
      { title: 'Appearance target', content: 'Measured evidence.' },
      project,
    );
    await api.post(
      '/api/notes',
      { title: 'Appearance linker', content: 'See [[Appearance target]] for context.' },
      project,
    );
    await page.goto('/');
    await page.getByRole('button', { name: 'Notes', exact: true }).click();
    await page.getByRole('button', { name: /^Appearance target/ }).click();

    // "Where this note appears" discovers the inbound document link.
    const appearances = page.getByRole('region', { name: 'Where this note appears' });
    await expect(appearances).toBeVisible();
    await expect(appearances.getByRole('button', { name: /Appearance linker/ })).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath('note-appearances.png'), fullPage: true });

    // The unified review queue renders even when nothing is pending.
    await page.getByRole('tab', { name: /^Review/ }).click();
    const review = page.getByRole('region', { name: 'Change review' });
    await expect(review).toBeVisible();
    await expect(review.getByText('Proposed relationships (0)')).toBeVisible();
    await expect(review.getByText('Recovery drafts (0)')).toBeVisible();

    // A chat finding saves as a sourced note and opens in the workspace. This
    // isolated UI test verifies the session provenance; backend tests exercise
    // stricter per-message verification against persisted assistant messages.
    const sourceSessionId = await api.createSession('E2E source chat', root);
    await page.evaluate(
      ({ title, body, sessionId }) => {
        window.dispatchEvent(
          new CustomEvent('kory-notes-save-finding', {
            detail: { title, body, source: { sessionId } },
          }),
        );
      },
      {
        title: 'E2E sourced finding',
        body: 'The chat established the cache key includes the locale.',
        sessionId: sourceSessionId,
      },
    );
    const dialog = page.getByRole('dialog', {
      name: 'Save this chat finding as a sourced note',
    });
    await expect(dialog).toBeVisible();
    await dialog.getByRole('button', { name: /Save as sourced note/ }).click();
    await expect(dialog.getByRole('button', { name: 'Open in Notes' })).toBeVisible();
    await dialog.getByRole('button', { name: 'Open in Notes' }).click();
    await expect(page.getByPlaceholder('Note title...')).toHaveValue('E2E sourced finding');

    // The saved note carries its host-recorded provenance on disk.
    const findings = await api.getJson<{ data: Array<{ title: string }> }>(
      '/api/notes?search=E2E%20sourced%20finding',
      project,
    );
    expect(findings.data.some((note) => note.title === 'E2E sourced finding')).toBe(true);
    expect(errors).toEqual([]);
  } finally {
    try {
      await api.post('/api/workspace/deselect');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
});

test('chat note links open encoded paths and protect unsaved drafts', async ({
  authenticatedPage: page,
  api,
}) => {
  test.setTimeout(120000);
  const root = await mkdtemp(join(tmpdir(), 'kory-note-links-e2e-'));
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const project = { 'x-koryphaios-project': root };
  try {
    expect((await api.post('/api/workspace/select', { path: root })).ok()).toBe(true);
    expect(
      (
        await api.post(
          '/api/notes',
          {
            title: 'Café & Links',
            folderPath: '/Findings',
            content: 'Original finding.',
          },
          project,
        )
      ).ok(),
    ).toBe(true);
    expect(
      (
        await api.post(
          '/api/notes',
          {
            title: 'Café & Links',
            folderPath: '/Research',
            content: 'Research destination.',
          },
          project,
        )
      ).ok(),
    ).toBe(true);
    await page.goto('/');
    await expect(page.getByRole('button', { name: 'Notes', exact: true })).toBeVisible();

    // Render actual chat Markdown and exercise the application click interceptor.
    // This avoids a live provider call while testing the same sanitized anchors.
    await page.evaluate(async () => {
      const modulePath = '/src/lib/utils/chat-markdown.ts';
      const { renderChatMarkdown } = await import(/* @vite-ignore */ modulePath);
      const fixture = document.createElement('div');
      fixture.id = 'note-link-browser-fixture';
      fixture.innerHTML = renderChatMarkdown(
        '[[/Findings/Café & Links|Open finding]] [Open research](kory-note://path/%2FResearch%2FCaf%C3%A9%20%26%20Links) [[Missing destination]]',
      );
      document.body.append(fixture);
    });
    await page.getByRole('link', { name: 'Open finding', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Close notes' })).toBeVisible();
    await expect(page.getByPlaceholder('Note title...')).toHaveValue('Café & Links');
    const editor = page.getByRole('combobox', { name: 'Note content' });
    await expect(editor).toHaveValue('Original finding.');
    await editor.fill('Finding edited before following a link.');
    await page.getByRole('link', { name: 'Open research', exact: true }).click();
    await expect(editor).toHaveValue('Research destination.');
    await page.getByRole('link', { name: 'Open finding', exact: true }).click();
    await expect(editor).toHaveValue('Finding edited before following a link.');
    await page.getByRole('link', { name: 'Missing destination', exact: true }).click();
    await expect(
      page.getByText('The linked note was not found in this project.', { exact: true }),
    ).toBeVisible();
    await expect(editor).toHaveValue('Finding edited before following a link.');
    expect(errors).toEqual([]);
  } finally {
    await api.post('/api/workspace/deselect');
    await rm(root, { recursive: true, force: true });
  }
});
