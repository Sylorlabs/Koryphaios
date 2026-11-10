import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NoteDraftSummary, NoteRelationship } from '@koryphaios/shared';

const mocks = vi.hoisted(() => ({ apiFetch: vi.fn() }));
vi.mock('$lib/api.svelte', () => ({ apiFetch: mocks.apiFetch }));
vi.mock('$lib/utils/api-url', () => ({ apiUrl: (path: string) => path }));
import NotesChangeReview from './NotesChangeReview.svelte';

const PROJECT = '/review-project';

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify({ success: status < 400, data }), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function relationship(overrides: Partial<NoteRelationship> = {}): NoteRelationship {
  return {
    fromId: 'note-a',
    toId: 'note-b',
    fromTitle: 'Alpha',
    toTitle: 'Beta',
    type: 'supports',
    status: 'proposed',
    evidence: 'Quoted passage',
    weight: 1,
    revision: 7,
    sourceRevision: 1,
    targetRevision: 1,
    stale: false,
    provenance: 'agent',
    actor: {},
    createdAt: new Date(0),
    updatedAt: new Date(0),
    ...overrides,
  };
}

function draft(overrides: Partial<NoteDraftSummary> = {}): NoteDraftSummary {
  return {
    id: 'draft-1',
    noteId: 'note-a',
    baseRevision: 2,
    draftRevision: 1,
    baseTitle: 'Alpha',
    title: 'Alpha (unsaved)',
    contentBytes: 128,
    payloadHash: 'hash',
    createdAt: new Date(0),
    updatedAt: new Date(0),
    state: 'recoverable',
    ...overrides,
  };
}

beforeEach(() => {
  mocks.apiFetch.mockReset();
  mocks.apiFetch.mockImplementation(async (url: string, init?: RequestInit) => {
    if (init?.method === 'PATCH') return jsonResponse(relationship({ status: 'accepted' }));
    if (url.includes('/drafts/') && init?.method === 'POST')
      return jsonResponse({ discarded: true });
    if (url.includes('status=proposed')) return jsonResponse([relationship()]);
    if (url.includes('status=accepted'))
      return jsonResponse([relationship({ status: 'accepted', stale: true })]);
    if (url.endsWith('/drafts')) return jsonResponse([draft()]);
    return jsonResponse({ discarded: true });
  });
});
afterEach(cleanup);

describe('NotesChangeReview', () => {
  it('aggregates proposals, stale evidence and drafts, and reviews with CAS revisions', async () => {
    const onOpenNetwork = vi.fn();
    const onPendingCount = vi.fn();
    render(NotesChangeReview, {
      props: {
        projectPath: PROJECT,
        onOpenNote: vi.fn(),
        onOpenNetwork,
        onPendingCount,
      },
    });

    await waitFor(() => expect(screen.getByText('Proposed relationships (1)')).toBeTruthy());
    expect(screen.getByText('Stale evidence (1)')).toBeTruthy();
    expect(
      screen.getByRole('button', {
        name: 'Open Network to refresh evidence for Alpha supports Beta',
      }),
    ).toBeTruthy();
    expect(
      screen.getByRole('button', { name: 'Review recovery draft of Alpha (unsaved)' }),
    ).toBeTruthy();
    expect(
      screen.getByRole('button', { name: 'Discard recovery draft of Alpha (unsaved)' }),
    ).toBeTruthy();
    expect(await screen.findByText('Recovery drafts (1)')).toBeTruthy();
    await waitFor(() => expect(onPendingCount).toHaveBeenCalledWith(2));

    const proposalCard = screen.getByText('Quoted passage').closest('div')!;
    await fireEvent.click(
      within(proposalCard).getByRole('button', { name: 'Accept Alpha supports Beta' }),
    );
    await waitFor(() => {
      const patch = mocks.apiFetch.mock.calls.find(([, init]) => init?.method === 'PATCH');
      expect(patch).toBeTruthy();
      expect(patch![0]).toBe('/api/notes/relationships/note-a/note-b');
      expect(JSON.parse(patch![1].body as string)).toEqual({
        status: 'accepted',
        expectedRevision: 7,
      });
    });
  });

  it('refuses acceptance of stale proposals and routes stale evidence to Network', async () => {
    mocks.apiFetch.mockImplementation(async (url: string, init?: RequestInit) => {
      if (init?.method === 'PATCH') return jsonResponse(relationship({ status: 'rejected' }));
      if (url.includes('status=proposed'))
        return jsonResponse([relationship({ stale: true, sourceRevision: 9 })]);
      return jsonResponse([relationship({ status: 'accepted', stale: true })]);
    });
    const onOpenNetwork = vi.fn();
    render(NotesChangeReview, {
      props: {
        projectPath: PROJECT,
        onOpenNote: vi.fn(),
        onOpenNetwork,
      },
    });
    await waitFor(() => expect(screen.getByText('Proposed relationships (1)')).toBeTruthy());

    const proposalCard = screen.getByText('Quoted passage').closest('div')!;
    expect(
      within(proposalCard)
        .getByRole('button', { name: 'Accept Alpha supports Beta' })
        .hasAttribute('disabled'),
    ).toBe(true);
    await fireEvent.click(
      within(proposalCard).getByRole('button', { name: 'Reject Alpha supports Beta' }),
    );
    await waitFor(() => {
      const patch = mocks.apiFetch.mock.calls.find(([, init]) => init?.method === 'PATCH');
      expect(JSON.parse(patch![1].body as string)).toEqual({
        status: 'rejected',
        expectedRevision: 7,
      });
    });

    await fireEvent.click(
      screen.getByRole('button', {
        name: 'Open Network to refresh evidence for Alpha supports Beta',
      }),
    );
    expect(onOpenNetwork).toHaveBeenCalled();
  });

  it('discards recovery drafts through the project-scoped revision-checked API', async () => {
    render(NotesChangeReview, {
      props: {
        projectPath: PROJECT,
        onOpenNote: vi.fn(),
        onOpenNetwork: vi.fn(),
      },
    });
    const discard = await screen.findByRole('button', {
      name: 'Discard recovery draft of Alpha (unsaved)',
    });
    await fireEvent.click(discard);
    await waitFor(() => {
      const discard = mocks.apiFetch.mock.calls.find(
        ([url, init]) => url === '/api/notes/drafts/draft-1/discard' && init?.method === 'POST',
      );
      expect(discard).toBeTruthy();
      expect(JSON.parse(discard![1].body as string)).toEqual({ expectedDraftRevision: 1 });
      expect(new Headers(discard![1].headers).get('X-Koryphaios-Project')).toBe(PROJECT);
    });
  });

  it('shows a conflict message instead of retrying when a decision loses a race', async () => {
    mocks.apiFetch.mockImplementation(async (_url: string, init?: RequestInit) => {
      if (init?.method === 'PATCH') return jsonResponse({ error: 'changed' }, 409);
      return jsonResponse([relationship()]);
    });
    render(NotesChangeReview, {
      props: {
        projectPath: PROJECT,
        onOpenNote: vi.fn(),
        onOpenNetwork: vi.fn(),
      },
    });
    await waitFor(() => expect(screen.getByText('Proposed relationships (1)')).toBeTruthy());
    const proposalCard = screen.getByText('Quoted passage').closest('div')!;
    await fireEvent.click(
      within(proposalCard).getByRole('button', { name: 'Accept Alpha supports Beta' }),
    );
    await waitFor(() =>
      expect(screen.getByRole('alert').textContent).toMatch(/moved on while you reviewed it/),
    );
  });
});
