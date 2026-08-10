import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ apiFetch: vi.fn() }));

vi.mock('$lib/api.svelte', () => ({ apiFetch: mocks.apiFetch }));
vi.mock('$lib/utils/api-url', () => ({ apiUrl: (path: string) => path }));
vi.mock('$lib/demo.svelte', () => ({ isDemoMode: false }));

import { notesStore } from './notes.svelte';
import { projectStore } from './project.svelte';

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function note(id: string, title: string) {
  return {
    id,
    title,
    content: `${title} body`,
    folderPath: '/',
    tags: [],
    pinned: false,
    includeInContext: false,
    format: 'markdown',
    revision: 1,
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
    outlinks: [],
    backlinks: [],
    attachments: [],
  };
}

beforeEach(() => {
  projectStore.setProject('/notes-project-a');
  notesStore.beginProjectTransition();
  mocks.apiFetch.mockReset();
});

afterEach(() => {
  projectStore.setProject(null);
  notesStore.beginProjectTransition();
});

describe('Notes request identity guards', () => {
  it('does not let a slow note response replace the newer editor selection', async () => {
    let resolveSlow!: (response: Response) => void;
    const slowResponse = new Promise<Response>((resolve) => {
      resolveSlow = resolve;
    });
    mocks.apiFetch
      .mockImplementationOnce(() => slowResponse)
      .mockResolvedValueOnce(jsonResponse({ ok: true, data: note('new', 'Newest') }));

    const slow = notesStore.fetchNote('old');
    const latest = notesStore.fetchNote('new');
    expect(await latest).toBe(true);
    resolveSlow(jsonResponse({ ok: true, data: note('old', 'Stale') }));
    expect(await slow).toBe(false);

    expect(notesStore.currentNote?.id).toBe('new');
    expect(notesStore.currentNote?.title).toBe('Newest');
  });

  it('invalidates an in-flight list when the project changes', async () => {
    let resolveOldProject!: (response: Response) => void;
    const oldProjectResponse = new Promise<Response>((resolve) => {
      resolveOldProject = resolve;
    });
    mocks.apiFetch
      .mockImplementationOnce(() => oldProjectResponse)
      .mockResolvedValueOnce(
        jsonResponse({ ok: true, data: [note('project-b', 'Project B')], meta: {} }),
      );

    const oldLoad = notesStore.fetchNotes();
    projectStore.setProject('/notes-project-b');
    notesStore.beginProjectTransition();
    expect(await notesStore.fetchNotes()).toBe(true);
    resolveOldProject(jsonResponse({ ok: true, data: [note('project-a', 'Project A')], meta: {} }));
    expect(await oldLoad).toBe(false);

    expect(notesStore.notes.map((entry) => entry.id)).toEqual(['project-b']);
  });

  it('preserves the authoritative deleted-source reason for conflict recovery', async () => {
    mocks.apiFetch.mockResolvedValueOnce(
      jsonResponse({ ok: true, data: note('source-note', 'Source note') }),
    );
    expect(await notesStore.fetchNote('source-note')).toBe(true);

    mocks.apiFetch.mockResolvedValueOnce(
      jsonResponse(
        {
          ok: false,
          code: 'CONFLICT',
          error: 'Source document removed',
          details: { sourceDeleted: true, currentRevision: 1 },
        },
        409,
      ),
    );
    mocks.apiFetch.mockResolvedValueOnce(
      jsonResponse({ ok: true, data: note('source-note', 'Source note') }),
    );

    expect(
      await notesStore.updateNote('source-note', {
        content: 'Local recovery draft',
        expectedRevision: 1,
      }),
    ).toBeNull();
    expect(notesStore.conflict).toMatchObject({
      noteId: 'source-note',
      sourceDeleted: true,
      remote: { revision: 1 },
    });
  });
});
