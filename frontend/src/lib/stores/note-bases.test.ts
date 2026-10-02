import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ apiFetch: vi.fn() }));

vi.mock('$lib/api.svelte', () => ({ apiFetch: mocks.apiFetch }));
vi.mock('$lib/utils/api-url', () => ({ apiUrl: (path: string) => path }));
vi.mock('$lib/demo.svelte', () => ({ isDemoMode: false }));

import { noteBasesStore } from './note-bases.svelte';
import { projectStore } from './project.svelte';

const PROJECT = '/note-bases-store-project';
const BASE_ID = 'base-1';

function jsonResponse(data: unknown): Response {
  return new Response(JSON.stringify(data), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

function emptyResult() {
  return { rows: [], limit: 100, offset: 0, hasMore: false, invalidDocumentCount: 0 };
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

beforeEach(() => {
  mocks.apiFetch.mockReset();
  projectStore.setProject(PROJECT);
  noteBasesStore.beginProjectTransition();
});

afterEach(() => {
  noteBasesStore.beginProjectTransition();
  projectStore.setProject(null);
});

describe('noteBasesStore loading lifecycle', () => {
  it('releases the spinner when the project scope disappears mid-query', async () => {
    let releaseQuery: ((response: Response) => void) | undefined;
    mocks.apiFetch.mockImplementation(async (url: string) => {
      if (url === '/api/notes/bases?includeTrashed=true') {
        return jsonResponse({ ok: true, data: [base()] });
      }
      if (url === '/api/notes/properties/schemas') {
        return jsonResponse({ ok: true, data: [] });
      }
      if (url === `/api/notes/bases/${BASE_ID}/query`) {
        return new Promise<Response>((resolve) => {
          releaseQuery = resolve;
        });
      }
      throw new Error(`Unexpected request: ${url}`);
    });

    await noteBasesStore.refresh();
    expect(noteBasesStore.loading).toBe(false);

    const inFlight = noteBasesStore.query(BASE_ID);
    await Promise.resolve();
    expect(noteBasesStore.loading).toBe(true);

    // The project becomes unavailable while the query is in flight. The
    // response is discarded, but the spinner must not be left on: with no
    // error and no result there is no control left to recover with.
    projectStore.markUnavailable(PROJECT);
    expect(projectStore.currentPath).toBeNull();
    releaseQuery?.(jsonResponse({ ok: true, data: emptyResult() }));
    await inFlight;

    expect(noteBasesStore.loading).toBe(false);
    expect(noteBasesStore.result).toBeNull();
  });

  it('keeps the spinner owned by the newest request when an older one settles', async () => {
    const releases: Array<(response: Response) => void> = [];
    mocks.apiFetch.mockImplementation(async (url: string) => {
      if (url === '/api/notes/bases?includeTrashed=true') {
        return jsonResponse({ ok: true, data: [base()] });
      }
      if (url === '/api/notes/properties/schemas') {
        return jsonResponse({ ok: true, data: [] });
      }
      if (url === `/api/notes/bases/${BASE_ID}/query`) {
        return new Promise<Response>((resolve) => releases.push(resolve));
      }
      throw new Error(`Unexpected request: ${url}`);
    });

    await noteBasesStore.refresh();

    const first = noteBasesStore.query(BASE_ID);
    await Promise.resolve();
    const second = noteBasesStore.query(BASE_ID);
    await Promise.resolve();
    expect(releases).toHaveLength(2);

    // The superseded request settles last: it must not clear the spinner the
    // newer request still owns.
    releases[1]!(jsonResponse({ ok: true, data: emptyResult() }));
    await second;
    expect(noteBasesStore.loading).toBe(false);

    releases[0]!(jsonResponse({ ok: true, data: emptyResult() }));
    await first;
    expect(noteBasesStore.loading).toBe(false);
  });
});
