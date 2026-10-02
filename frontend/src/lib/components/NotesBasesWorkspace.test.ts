import { cleanup, render, screen, waitFor } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ apiFetch: vi.fn() }));

vi.mock('$lib/api.svelte', () => ({ apiFetch: mocks.apiFetch }));
vi.mock('$lib/utils/api-url', () => ({ apiUrl: (path: string) => path }));
vi.mock('$lib/demo.svelte', () => ({ isDemoMode: false }));

import NotesBasesWorkspace from './NotesBasesWorkspace.svelte';
import { noteBasesStore } from '$lib/stores/note-bases.svelte';
import { projectStore } from '$lib/stores/project.svelte';

const PROJECT = '/notes-bases-project';
const BASE_ID = 'base-1';

function jsonResponse(data: unknown): Response {
  return new Response(JSON.stringify(data), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

function base() {
  return {
    id: BASE_ID,
    name: 'New Base',
    revision: 1,
    definition: {
      version: 1,
      sort: [{ field: { source: 'system', field: 'updated' }, direction: 'desc' }],
      view: { kind: 'table', fields: [{ source: 'system', field: 'title' }] },
    },
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
  };
}

function row(id: string, title: string) {
  return {
    id,
    title,
    folderPath: '/',
    tags: [],
    pinned: false,
    includeInContext: false,
    format: 'markdown',
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
    properties: {},
  };
}

beforeEach(() => {
  mocks.apiFetch.mockReset();
  mocks.apiFetch.mockImplementation(async (url: string, init?: RequestInit) => {
    if (url === '/api/notes/bases?includeTrashed=true') {
      return jsonResponse({ ok: true, data: [base()] });
    }
    if (url === '/api/notes/properties/schemas') {
      return jsonResponse({ ok: true, data: [] });
    }
    if (url === `/api/notes/bases/${BASE_ID}/query`) {
      expect(init?.method).toBe('POST');
      return jsonResponse({
        ok: true,
        data: {
          rows: [row('note-1', 'Alpha note')],
          limit: 100,
          offset: 0,
          hasMore: false,
          invalidDocumentCount: 0,
        },
      });
    }
    throw new Error(`Unexpected request in NotesBasesWorkspace test: ${url}`);
  });
  projectStore.setProject(PROJECT);
  noteBasesStore.beginProjectTransition();
});

afterEach(() => {
  cleanup();
  document.body.innerHTML = '';
});

describe('NotesBasesWorkspace', () => {
  it('resolves the auto-selected Base query instead of spinning forever', async () => {
    render(NotesBasesWorkspace, { props: { onOpenNote: vi.fn() } });

    // The first Base is auto-selected and must render its rows. Cloning the
    // active Base definition out of the reactive store used to throw, which
    // aborted the reactive flush and left this spinner on screen with no
    // reachable control.
    await waitFor(
      () => {
        expect(screen.getByText('Alpha note')).toBeTruthy();
      },
      { timeout: 5_000 },
    );
    expect(screen.queryByText(/Indexing and querying this Base/)).toBeNull();
    expect(noteBasesStore.loading).toBe(false);
    expect(noteBasesStore.result?.rows).toHaveLength(1);
  });
});
