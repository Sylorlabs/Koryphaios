import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { NoteAppearances as NoteAppearancesPayload } from '@koryphaios/shared';

const mocks = vi.hoisted(() => ({ loadNoteAppearances: vi.fn() }));
vi.mock('$lib/stores/notes.svelte', () => ({
  notesStore: { loadNoteAppearances: mocks.loadNoteAppearances },
}));

import NoteAppearances from './NoteAppearances.svelte';

function payload(overrides: Partial<NoteAppearancesPayload> = {}): NoteAppearancesPayload {
  return {
    noteId: 'n1',
    title: 'Target',
    revision: 3,
    backlinks: [
      { noteId: 'doc-linker', title: 'Doc linker', folderPath: '/' },
      { noteId: 'rel-source', title: 'Rel source', folderPath: '/' },
    ],
    relationships: [
      {
        fromId: 'rel-source',
        toId: 'n1',
        fromTitle: 'Rel source',
        toTitle: 'Target',
        type: 'supports',
        status: 'accepted',
        stale: false,
        revision: 2,
        direction: 'incoming',
        counterpartyId: 'rel-source',
        counterpartyTitle: 'Rel source',
      },
    ],
    canvases: [{ noteId: 'canvas-1', title: 'Board', cardId: 'c1', cardText: 'Key claim' }],
    bases: [{ baseId: 'base-1', name: 'Open findings', revision: 4 }],
    counts: { backlinks: 2, relationships: 1, canvases: 1, bases: 1 },
    truncated: false,
    ...overrides,
  };
}

afterEach(() => {
  cleanup();
  mocks.loadNoteAppearances.mockReset();
});

describe('NoteAppearances', () => {
  it('shows every place the note appears with working navigation', async () => {
    mocks.loadNoteAppearances.mockResolvedValue(payload());
    const onOpenNote = vi.fn();
    const onOpenCanvas = vi.fn();
    const onShowBases = vi.fn();
    render(NoteAppearances, {
      props: {
        noteId: 'n1',
        onOpenNote,
        onOpenCanvas,
        onShowBases,
      },
    });

    await waitFor(() => expect(screen.getByText(/Where this note appears/)).toBeTruthy());
    expect(mocks.loadNoteAppearances).toHaveBeenCalledWith('n1');

    // Relationship row: counterparty plus typed pair context.
    const relRow = screen.getByRole('button', {
      name: 'Rel source · Supports · accepted',
    });
    expect(relRow.textContent).toContain('Supports · accepted');
    await fireEvent.click(relRow);
    expect(onOpenNote).toHaveBeenCalledWith('rel-source');

    // Document links dedupe the relationship counterparty.
    expect(screen.getByText(/Document links \(1\)/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Doc linker · document link' })).toBeTruthy();
    expect(screen.queryByText(/Document links \(2\)/)).toBeNull();

    const canvasRow = screen.getByRole('button', { name: 'Board · Key claim · Canvas' });
    expect(canvasRow.textContent).toContain('Key claim');
    await fireEvent.click(canvasRow);
    expect(onOpenCanvas).toHaveBeenCalledWith('canvas-1');

    await fireEvent.click(screen.getByRole('button', { name: 'Open findings · saved Base' }));
    expect(onShowBases).toHaveBeenCalled();

    expect(screen.getByText('4 places')).toBeTruthy();
    expect(screen.queryByText(/safety scan limit/)).toBeNull();
  });

  it('reports empty and truncated scans honestly', async () => {
    mocks.loadNoteAppearances.mockResolvedValue(
      payload({
        backlinks: [],
        relationships: [],
        canvases: [],
        bases: [],
        counts: { backlinks: 0, relationships: 0, canvases: 0, bases: 0 },
        truncated: true,
      }),
    );
    render(NoteAppearances, {
      props: { noteId: 'n1', onOpenNote: vi.fn(), onOpenCanvas: vi.fn(), onShowBases: vi.fn() },
    });
    await waitFor(() => expect(screen.getByText(/does not appear anywhere else yet/)).toBeTruthy());
    expect(screen.getByText(/safety scan limit/)).toBeTruthy();
  });

  it('surfaces load failures instead of a silent empty list', async () => {
    mocks.loadNoteAppearances.mockResolvedValue(null);
    render(NoteAppearances, {
      props: { noteId: 'n1', onOpenNote: vi.fn(), onOpenCanvas: vi.fn(), onShowBases: vi.fn() },
    });
    await waitFor(() => expect(screen.getByRole('alert').textContent).toMatch(/Could not load/));
  });
});
