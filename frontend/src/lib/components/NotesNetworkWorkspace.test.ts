import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import NotesNetworkWorkspace, {
  type NetworkRelationship,
  type QueryActivation,
} from './NotesNetworkWorkspace.svelte';

const { apiFetch } = vi.hoisted(() => ({ apiFetch: vi.fn() }));
vi.mock('$lib/api.svelte', () => ({ apiFetch }));
vi.mock('$lib/utils/api-url', () => ({ apiUrl: (path: string) => `/api${path}` }));
const notes = [
  { id: 'note/a', title: 'Alpha', revision: 3 },
  { id: 'note:b', title: 'Beta', revision: 5 },
];
const index = {
  available: true,
  enabled: false,
  mode: 'not_opted_in',
  eligibleNotes: 10,
  indexedNotes: 0,
  staleNotes: 0,
  coverage: 0,
  cursor: '',
  providerIdentity: 'opaque',
  representationChars: 8000,
};
const relationship: NetworkRelationship = {
  fromId: 'note/a',
  toId: 'note:b',
  fromTitle: 'Alpha',
  toTitle: 'Beta',
  type: 'supports',
  status: 'proposed',
  evidence: '<img src=x onerror=alert(1)> evidence',
  provenance: 'agent',
  revision: 7,
  sourceRevision: 3,
  targetRevision: 5,
  stale: false,
  weight: 1,
  actor: { model: 'test-model' },
  createdAt: new Date(0),
  updatedAt: new Date(0),
};
const activation: QueryActivation = {
  query: 'design',
  results: [
    {
      id: 'note:b',
      title: 'Beta',
      revision: 5,
      excerpt: '<script>bad()</script> excerpt',
      truncated: true,
      score: 0.5,
      sources: ['graph'],
      seedId: 'note/a',
      explanation: 'Selected via accepted support evidence.',
      path: [
        {
          fromId: 'note/a',
          toId: 'note:b',
          direction: 'outgoing',
          kind: 'association',
          type: 'supports',
          status: 'accepted',
          provenance: 'agent',
          fromRevision: 3,
          toRevision: 5,
          relationshipRevision: 8,
          stale: true,
          evidence: 'Observed support',
        },
      ],
    },
  ],
  conflicts: [
    { noteId: 'note/a', reason: 'stale_relationship', expectedRevision: 2, currentRevision: 3 },
  ],
  retrieval: { semantic: 'disabled', index: 'stored_snapshot', exhaustive: false, coverage: index },
  truncation: { truncated: true, reasons: ['max_chars'] },
  budget: {
    limits: {
      maxChars: 6000,
      candidates: 64,
      seeds: 8,
      visited: 48,
      edges: 96,
      outputChars: 65536,
    },
    used: { candidates: 3, seeds: 1, visited: 2, edges: 1, excerptChars: 50, outputChars: 900 },
  },
};
function response(data: unknown, status = 200) {
  return new Response(JSON.stringify({ success: status < 400, data }), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function fallback(url: string, init?: RequestInit): Response {
  if (url.includes('/search?')) return response(notes);
  if (url.endsWith('/semantic-index')) return response(index);
  if (url.endsWith('/semantic-index/rebuild'))
    return response({
      status: { ...index, mode: 'partial', indexedNotes: 2, coverage: 0.2 },
      processed: 2,
      indexed: 2,
      skipped: 0,
      canceled: false,
      hasMore: true,
    });
  if (url.endsWith('/context')) return response(activation);
  if (init?.method === 'PATCH' || init?.method === 'POST') return response(relationship);
  return response([relationship]);
}
async function mount() {
  const onOpenNote = vi.fn();
  const view = render(NotesNetworkWorkspace, { projectPath: '/project-a', onOpenNote });
  await screen.findByRole('button', { name: 'Accept Alpha Supports Beta' });
  await waitFor(() => expect(screen.getByText(/Index mode:/)).toBeTruthy());
  return { ...view, onOpenNote };
}
async function choose(label: string, option: RegExp) {
  await fireEvent.click(screen.getByRole('combobox', { name: label }));
  await fireEvent.click(screen.getByRole('option', { name: option }));
}
async function startQuery() {
  await fireEvent.input(screen.getByRole('textbox', { name: 'Retrieval query' }), {
    target: { value: 'design' },
  });
  await fireEvent.click(screen.getByRole('button', { name: 'Activate query' }));
}
function callsFor(path: string) {
  return apiFetch.mock.calls.filter(([url]) => String(url).endsWith(path));
}

beforeEach(() => {
  apiFetch.mockReset();
  apiFetch.mockImplementation(async (url: string, init?: RequestInit) => fallback(url, init));
});
afterEach(() => {
  cleanup();
  document.body.innerHTML = '';
});

describe('Notes network review', () => {
  it('renders typed, attributed evidence safely and reviews with exact relationship CAS', async () => {
    const view = await mount();
    expect(screen.getByText(relationship.evidence)).toBeTruthy();
    expect(screen.getByText('Origin: model: test-model')).toBeTruthy();
    expect(view.container.querySelector('img')).toBeNull();
    expect(
      view.container.querySelector('select, input[type=checkbox], input[type=number]'),
    ).toBeNull();
    await fireEvent.click(screen.getByRole('button', { name: 'Accept Alpha Supports Beta' }));
    await waitFor(() => expect(callsFor('/relationships/note%2Fa/note%3Ab')).toHaveLength(1));
    const [, init] = callsFor('/relationships/note%2Fa/note%3Ab')[0];
    expect(init.method).toBe('PATCH');
    expect(JSON.parse(init.body)).toEqual({ status: 'accepted', expectedRevision: 7 });
    expect(init.headers['X-Koryphaios-Project']).toBe('/project-a');
  });

  it('blocks accepting stale evidence but allows rejection', async () => {
    apiFetch.mockImplementation(async (url: string, init?: RequestInit) =>
      url.endsWith('/relationships')
        ? response([{ ...relationship, stale: true }])
        : fallback(url, init),
    );
    await mount();
    expect(screen.getByRole('button', { name: 'Accept Alpha Supports Beta' })).toBeDisabled();
    expect(screen.getByText(/Stale evidence —/)).toBeTruthy();
    await fireEvent.click(screen.getByRole('button', { name: 'Reject Alpha Supports Beta' }));
    expect(JSON.parse(callsFor('/relationships/note%2Fa/note%3Ab')[0][1].body)).toEqual({
      status: 'rejected',
      expectedRevision: 7,
    });
  });

  it('shows a revision conflict without optimistic acceptance or replaying the action', async () => {
    apiFetch.mockImplementation(async (url: string, init?: RequestInit) =>
      init?.method === 'PATCH' ? response(null, 409) : fallback(url, init),
    );
    await mount();
    await fireEvent.click(screen.getByRole('button', { name: 'Accept Alpha Supports Beta' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Revision conflict');
    expect(screen.getByRole('button', { name: 'Accept Alpha Supports Beta' })).toBeEnabled();
    expect(callsFor('/relationships/note%2Fa/note%3Ab')).toHaveLength(1);
  });

  it('requires confirmation and exact CAS to remove, then permits a freshly reviewed proposal', async () => {
    let current: NetworkRelationship | null = { ...relationship, stale: true };
    apiFetch.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url.includes('/relationships/')) {
        if (init?.method === 'PATCH')
          current = { ...relationship, status: 'rejected', revision: 8, stale: true };
        if (init?.method === 'DELETE') current = null;
        return response(current);
      }
      if (url.endsWith('/relationships')) {
        if (init?.method === 'POST')
          current = { ...relationship, revision: 10, evidence: 'New evidence' };
        return response(init?.method === 'POST' ? current : current ? [current] : []);
      }
      return fallback(url, init);
    });
    await mount();
    await fireEvent.click(screen.getByRole('button', { name: 'Reject Alpha Supports Beta' }));
    await screen.findByText('rejected');
    await fireEvent.click(screen.getByRole('button', { name: 'Remove Alpha Supports Beta' }));
    expect(screen.getByRole('group', { name: 'Confirm relationship removal' })).toHaveTextContent(
      'Document wikilinks are not removed',
    );
    expect(apiFetch.mock.calls.filter(([, init]) => init.method === 'DELETE')).toHaveLength(0);
    await fireEvent.click(screen.getByRole('button', { name: 'Cancel removal' }));
    expect(screen.queryByRole('button', { name: 'Confirm remove relationship' })).toBeNull();
    await fireEvent.click(screen.getByRole('button', { name: 'Remove Alpha Supports Beta' }));
    await fireEvent.click(screen.getByRole('button', { name: 'Confirm remove relationship' }));
    await screen.findByText('No relationships in this view.');
    const deletion = apiFetch.mock.calls.find(([, init]) => init.method === 'DELETE')!;
    expect(deletion[0]).toBe('/api/notes/relationships/note%2Fa/note%3Ab');
    expect(JSON.parse(deletion[1].body)).toEqual({ expectedRelationshipRevision: 8 });
    expect(deletion[1].headers['X-Koryphaios-Project']).toBe('/project-a');
    await fireEvent.click(screen.getByText('Propose a relationship'));
    await choose('Source note', /Alpha/);
    await choose('Target note', /Beta/);
    await fireEvent.input(screen.getByRole('textbox', { name: 'Evidence' }), {
      target: { value: 'New evidence' },
    });
    await fireEvent.click(screen.getByRole('button', { name: 'Create proposal' }));
    await screen.findByRole('button', { name: 'Accept Alpha Supports Beta' });
    expect(screen.getByText('proposed')).toBeTruthy();
  });

  it('does not remove optimistically or replay stale removal and refresh clears confirmation', async () => {
    apiFetch.mockImplementation(async (url: string, init?: RequestInit) =>
      init?.method === 'DELETE' ? response(null, 409) : fallback(url, init),
    );
    await mount();
    await fireEvent.click(screen.getByRole('button', { name: 'Remove Alpha Supports Beta' }));
    await fireEvent.click(screen.getByRole('button', { name: 'Refresh network' }));
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: 'Confirm remove relationship' })).toBeNull(),
    );
    await fireEvent.click(screen.getByRole('button', { name: 'Remove Alpha Supports Beta' }));
    await fireEvent.click(screen.getByRole('button', { name: 'Confirm remove relationship' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Revision conflict');
    expect(screen.getByText(relationship.evidence)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Confirm remove relationship' })).toBeNull();
    expect(apiFetch.mock.calls.filter(([, init]) => init.method === 'DELETE')).toHaveLength(1);
  });

  it('explains duplicate-pair conflicts rather than suggesting refresh alone fixes rejected proposals', async () => {
    apiFetch.mockImplementation(async (url: string, init?: RequestInit) =>
      init?.method === 'POST' && url.endsWith('/relationships')
        ? new Response(
            JSON.stringify({
              success: false,
              error: {
                message: 'A relationship already exists for this directed pair. Review it instead.',
              },
            }),
            { status: 409 },
          )
        : fallback(url, init),
    );
    await mount();
    await fireEvent.click(screen.getByText('Propose a relationship'));
    await choose('Source note', /Alpha/);
    await choose('Target note', /Beta/);
    await fireEvent.input(screen.getByRole('textbox', { name: 'Evidence' }), {
      target: { value: 'New evidence' },
    });
    await fireEvent.click(screen.getByRole('button', { name: 'Create proposal' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Rejected relationships also reserve the pair',
    );
    expect(screen.getByRole('alert')).not.toHaveTextContent('Revision conflict');
    expect(screen.getByRole('textbox', { name: 'Evidence' })).toHaveValue('New evidence');
  });

  it('creates only real scoped-note proposals with both endpoint revisions and required evidence', async () => {
    await mount();
    await fireEvent.click(screen.getByText('Propose a relationship'));
    expect(screen.getByRole('button', { name: 'Create proposal' })).toBeDisabled();
    await choose('Source note', /Alpha/);
    await choose('Target note', /Beta/);
    await choose('Relationship type', /^Contradicts$/);
    await fireEvent.input(screen.getByRole('textbox', { name: 'Evidence' }), {
      target: { value: '  Conflicting experimental result  ' },
    });
    await fireEvent.click(screen.getByRole('button', { name: 'Create proposal' }));
    await waitFor(() =>
      expect(callsFor('/relationships').filter(([, init]) => init.method === 'POST')).toHaveLength(
        1,
      ),
    );
    const [, init] = callsFor('/relationships').find(([, init]) => init.method === 'POST')!;
    expect(JSON.parse(init.body)).toEqual({
      fromId: 'note/a',
      toId: 'note:b',
      type: 'contradicts',
      evidence: 'Conflicting experimental result',
      expectedSourceRevision: 3,
      expectedTargetRevision: 5,
    });
    expect(init.headers['X-Koryphaios-Project']).toBe('/project-a');
  });
});

describe('Query activation and semantic indexing', () => {
  it('shows seed-to-seed claims and distinguishes unevaluated coverage from an empty vault', async () => {
    apiFetch.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url.endsWith('/semantic-index'))
        return response({ ...index, countsAvailable: false, coverageBasis: 'revision_metadata' });
      if (url.endsWith('/context'))
        return response({
          ...activation,
          connections: [{ ...activation.results[0].path[0], type: 'contradicts' }],
          retrieval: {
            ...activation.retrieval,
            coverage: {
              ...index,
              countsAvailable: false,
              coverageBasis: 'revision_metadata',
              search: {
                exhaustive: false,
                scannedVectors: 512,
                maxVectors: 512,
                reason: 'vector_limit',
              },
            },
          },
        });
      return fallback(url, init);
    });
    await mount();
    expect(screen.getAllByText(/Not evaluated/).length).toBeGreaterThan(0);
    await startQuery();
    const connections = await screen.findByLabelText('Examined note connections');
    expect(within(connections).getByText(/Contradicts/)).toBeTruthy();
    expect(within(connections).getByText(/Stale connection evidence/)).toBeTruthy();
    expect(screen.getByText(/Semantic coverage was not evaluated/)).toBeTruthy();
    expect(screen.getByText(/Semantic vectors examined: 512 \/ 512/)).toBeTruthy();
  });
  it('shows local paths, explanations, scoped excerpts, conflicts, coverage and budgets without rendering HTML', async () => {
    const view = await mount();
    await startQuery();
    const map = await screen.findByLabelText('Local activation paths');
    expect(within(map).getByText('Selected via accepted support evidence.')).toBeTruthy();
    expect(within(map).getByText('Stale path evidence')).toBeTruthy();
    expect(within(map).getByText('<script>bad()</script> excerpt')).toBeTruthy();
    expect(view.container.querySelector('script')).toBeNull();
    expect(screen.getByText(/bounded, non-exhaustive/)).toBeTruthy();
    expect(screen.getByText(/Semantic coverage at activation: 0 \/ 10/)).toBeTruthy();
    expect(screen.getByText('Truncation: max chars')).toBeTruthy();
    expect(screen.getByText(/expected r2, current r3/)).toBeTruthy();
    await fireEvent.click(screen.getByText('Retrieval budget'));
    expect(screen.getByText('50 / 6000')).toBeTruthy();
    await fireEvent.click(within(map).getByRole('button', { name: 'Beta' }));
    expect(view.onOpenNote).toHaveBeenCalledWith('note:b');
    expect(JSON.parse(callsFor('/context')[0][1].body)).toEqual({
      query: 'design',
      semantic: false,
      maxHops: 1,
      maxChars: 6000,
      limit: 6,
      excerptChars: 1000,
    });
  });

  it('requires explicit indexing consent, sends a bounded opt-in batch and reports continuation', async () => {
    await mount();
    const rebuild = screen.getByRole('button', { name: 'Rebuild semantic index' });
    expect(rebuild).toBeDisabled();
    expect(callsFor('/semantic-index/rebuild')).toHaveLength(0);
    await fireEvent.click(
      screen.getByRole('switch', { name: 'Allow explicit indexing for this project' }),
    );
    await fireEvent.click(rebuild);
    await screen.findByText(/More notes remain; rebuild again to continue/);
    const [, init] = callsFor('/semantic-index/rebuild')[0];
    expect(JSON.parse(init.body)).toEqual({ optIn: true, limit: 32, reset: false });
    expect(screen.getByText('2 / 10 notes (20%; revision metadata)')).toBeTruthy();
    await fireEvent.click(screen.getByRole('button', { name: 'Restart index rebuild' }));
    expect(JSON.parse(callsFor('/semantic-index/rebuild')[1][1].body).reset).toBe(true);
  });

  it('does not offer a rebuild when embedding permissions deny it', async () => {
    apiFetch.mockImplementation(async (url: string, init?: RequestInit) =>
      url.endsWith('/semantic-index')
        ? response({ ...index, mode: 'permission_denied' })
        : fallback(url, init),
    );
    await mount();
    await fireEvent.click(
      screen.getByRole('switch', { name: 'Allow explicit indexing for this project' }),
    );
    expect(screen.getByRole('button', { name: 'Rebuild semantic index' })).toBeDisabled();
    expect(screen.getByText(/Notes permissions disallow embedding/)).toBeTruthy();
  });

  it('cancels retrieval and ignores a response from a transport that still resolves', async () => {
    const pending = deferred<Response>();
    apiFetch.mockImplementation((url: string, init?: RequestInit) =>
      url.endsWith('/context') ? pending.promise : Promise.resolve(fallback(url, init)),
    );
    await mount();
    await startQuery();
    const signal = callsFor('/context')[0][1].signal;
    await fireEvent.click(screen.getByRole('button', { name: 'Cancel query' }));
    expect(signal.aborted).toBe(true);
    pending.resolve(response(activation));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(screen.queryByLabelText('Local activation paths')).toBeNull();
    expect(screen.getByRole('button', { name: 'Activate query' })).toBeEnabled();
  });
});

describe('Request scope isolation', () => {
  it('cancels a rebuild without claiming rollback and ignores its late completion', async () => {
    const pending = deferred<Response>();
    apiFetch.mockImplementation((url: string, init?: RequestInit) =>
      url.endsWith('/semantic-index/rebuild')
        ? pending.promise
        : Promise.resolve(fallback(url, init)),
    );
    await mount();
    await fireEvent.click(
      screen.getByRole('switch', { name: 'Allow explicit indexing for this project' }),
    );
    await fireEvent.click(screen.getByRole('button', { name: 'Rebuild semantic index' }));
    const signal = callsFor('/semantic-index/rebuild')[0][1].signal;
    await fireEvent.click(screen.getByRole('button', { name: 'Cancel rebuild' }));
    expect(signal.aborted).toBe(true);
    expect(screen.getByRole('alert')).toHaveTextContent('Completed batches may remain indexed');
    pending.resolve(fallback('/api/notes/semantic-index/rebuild'));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(screen.queryByText(/More notes remain; rebuild again to continue/)).toBeNull();
  });

  it('drops superseded picker responses and cannot propose with a missing selected endpoint', async () => {
    const pending = deferred<Response>();
    const view = await mount();
    await fireEvent.click(screen.getByText('Propose a relationship'));
    await choose('Source note', /Alpha/);
    await choose('Target note', /Beta/);
    await fireEvent.input(screen.getByRole('textbox', { name: 'Evidence' }), {
      target: { value: 'Evidence' },
    });
    apiFetch.mockImplementation((url: string, init?: RequestInit) =>
      url.includes('/search?') ? pending.promise : Promise.resolve(fallback(url, init)),
    );
    await fireEvent.click(screen.getByRole('button', { name: 'Find notes' }));
    const oldSignal = apiFetch.mock.calls.filter(([url]) => url.includes('/search?')).at(-1)![1]
      .signal;
    apiFetch.mockImplementation(async (url: string, init?: RequestInit) =>
      url.includes('/search?') ? response([notes[0]]) : fallback(url, init),
    );
    await fireEvent.click(screen.getByRole('button', { name: 'Refresh network' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Find notes' })).toBeEnabled());
    pending.resolve(response(notes));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(oldSignal.aborted).toBe(true);
    expect(screen.getByRole('button', { name: 'Create proposal' })).toBeDisabled();
    expect(view.container.querySelector('select')).toBeNull();
  });

  it('drops old activation and relationship responses across A → B → A and clears scoped input', async () => {
    const oldContext = deferred<Response>();
    const oldRelationships = deferred<Response>();
    const view = await mount();
    apiFetch.mockImplementation((url: string, init?: RequestInit) => {
      if (url.endsWith('/context')) return oldContext.promise;
      if (url.endsWith('/relationships')) return oldRelationships.promise;
      return Promise.resolve(fallback(url, init));
    });
    await startQuery();
    await fireEvent.click(screen.getByRole('button', { name: 'Refresh network' }));
    const oldSignal = callsFor('/context')[0][1].signal;
    apiFetch.mockImplementation(async (url: string, init?: RequestInit) =>
      url.endsWith('/relationships') ? response([]) : fallback(url, init),
    );
    await view.rerender({ projectPath: '/project-b', onOpenNote: view.onOpenNote });
    await waitFor(() =>
      expect(screen.getByRole('textbox', { name: 'Retrieval query' })).toHaveValue(''),
    );
    await view.rerender({ projectPath: '/project-a', onOpenNote: view.onOpenNote });
    expect(oldSignal.aborted).toBe(true);
    oldContext.resolve(response(activation));
    oldRelationships.resolve(response([relationship]));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(screen.queryByLabelText('Local activation paths')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Accept Alpha Supports Beta' })).toBeNull();
    expect(
      apiFetch.mock.calls.some(([, init]) => init.headers['X-Koryphaios-Project'] === '/project-b'),
    ).toBe(true);
  });

  it('clears removal confirmation on scope changes and ignores an old DELETE completion', async () => {
    const pending = deferred<Response>();
    const view = await mount();
    await fireEvent.click(screen.getByRole('button', { name: 'Remove Alpha Supports Beta' }));
    await view.rerender({ projectPath: '/project-b', onOpenNote: view.onOpenNote });
    await screen.findByRole('button', { name: 'Remove Alpha Supports Beta' });
    expect(screen.queryByRole('button', { name: 'Confirm remove relationship' })).toBeNull();
    apiFetch.mockImplementation((url: string, init?: RequestInit) =>
      init?.method === 'DELETE' ? pending.promise : Promise.resolve(fallback(url, init)),
    );
    await fireEvent.click(screen.getByRole('button', { name: 'Remove Alpha Supports Beta' }));
    await fireEvent.click(screen.getByRole('button', { name: 'Confirm remove relationship' }));
    const [, deletion] = apiFetch.mock.calls.find(([, init]) => init.method === 'DELETE')!;
    expect(deletion.headers['X-Koryphaios-Project']).toBe('/project-b');
    await view.rerender({ projectPath: '/project-a', onOpenNote: view.onOpenNote });
    await screen.findByRole('button', { name: 'Remove Alpha Supports Beta' });
    expect(deletion.signal.aborted).toBe(true);
    const count = apiFetch.mock.calls.length;
    pending.resolve(response({ removed: true }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(apiFetch).toHaveBeenCalledTimes(count);
    expect(screen.getByText(relationship.evidence)).toBeTruthy();
  });

  it('does not refresh a new project from an old review completion and aborts rebuild on unmount', async () => {
    const review = deferred<Response>();
    const rebuild = deferred<Response>();
    apiFetch.mockImplementation((url: string, init?: RequestInit) =>
      init?.method === 'PATCH'
        ? review.promise
        : url.endsWith('/semantic-index/rebuild')
          ? rebuild.promise
          : Promise.resolve(fallback(url, init)),
    );
    const view = await mount();
    await fireEvent.click(screen.getByRole('button', { name: 'Accept Alpha Supports Beta' }));
    await view.rerender({ projectPath: '/project-b', onOpenNote: view.onOpenNote });
    await waitFor(() => expect(screen.getByText(/Index mode:/)).toBeTruthy());
    const count = apiFetch.mock.calls.length;
    review.resolve(response(relationship));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(apiFetch).toHaveBeenCalledTimes(count);
    await fireEvent.click(
      screen.getByRole('switch', { name: 'Allow explicit indexing for this project' }),
    );
    await fireEvent.click(screen.getByRole('button', { name: 'Rebuild semantic index' }));
    const signal = callsFor('/semantic-index/rebuild')[0][1].signal;
    view.unmount();
    expect(signal.aborted).toBe(true);
    rebuild.resolve(fallback('/api/notes/semantic-index/rebuild'));
  });
});
