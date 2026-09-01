import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Note, NoteRevision, NoteRevisionSummary, TrashedNote } from '@koryphaios/shared';
import NotesRecoveryDialog, { NOTES_REVISION_PREVIEW_LIMIT } from './NotesRecoveryDialog.svelte';

const createdAt = new Date('2026-08-29T17:00:00.000Z');
const updatedAt = new Date('2026-08-30T18:30:00.000Z');

function currentNote(overrides: Partial<Note> = {}): Note {
  return {
    id: 'note-1',
    title: 'Agent architecture',
    content: '# Current\n\nCurrent plan.',
    folderPath: '/Architecture',
    tags: ['agent'],
    pinned: false,
    includeInContext: true,
    createdAt,
    updatedAt,
    revision: 3,
    format: 'markdown',
    ...overrides,
  };
}

function revision(
  revisionNumber: number,
  overrides: Partial<NoteRevisionSummary> = {},
): NoteRevisionSummary {
  return {
    noteId: 'note-1',
    revision: revisionNumber,
    operation: revisionNumber === 1 ? 'create' : 'update',
    title: 'Agent architecture',
    folderPath: '/Architecture',
    tags: ['agent'],
    pinned: false,
    includeInContext: true,
    format: 'markdown',
    contentBytes: revisionNumber === 1 ? 21 : 26,
    noteCreatedAt: createdAt,
    noteUpdatedAt: updatedAt,
    createdAt: new Date(`2026-08-${27 + revisionNumber}T18:30:00.000Z`),
    ...overrides,
  };
}

function revisionWithContent(
  revisionNumber: number,
  content: string,
  overrides: Partial<NoteRevision> = {},
): NoteRevision {
  return {
    ...revision(revisionNumber),
    content,
    ...overrides,
  };
}

function trashedNote(overrides: Partial<TrashedNote> = {}): TrashedNote {
  return {
    ...currentNote({
      id: 'trashed-1',
      title: 'Discarded research',
      content: '# Evidence\n\nStill recoverable.',
      folderPath: '/Research',
      sourcePath: 'docs/research.md',
      revision: 4,
    }),
    trashedAt: new Date('2026-08-30T19:15:00.000Z'),
    trashReason: 'source_removed',
    ...overrides,
  };
}

function callbacks() {
  return {
    onSelectRevision: vi.fn(),
    onRestoreRevision: vi.fn(),
    onRestoreTrash: vi.fn(),
    onClose: vi.fn(),
  };
}

afterEach(() => {
  cleanup();
  document.body.innerHTML = '';
});

describe('NotesRecoveryDialog accessibility', () => {
  it('labels the modal, focuses the requested tab, traps focus, closes, and restores focus', async () => {
    const trigger = document.createElement('button');
    trigger.textContent = 'Open recovery';
    document.body.appendChild(trigger);
    trigger.focus();

    const handlers = callbacks();
    const props = {
      open: true,
      initialTab: 'trash' as const,
      currentNote: currentNote(),
      trash: [trashedNote()],
      revisions: [revision(3)],
      selectedRevision: null,
      loading: false,
      error: null,
      ...handlers,
    };
    const view = render(NotesRecoveryDialog, { props });

    const dialog = screen.getByRole('dialog', { name: 'Recover notes and history' });
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(dialog).toHaveAccessibleDescription(/Restore a saved snapshot without erasing history/i);

    const trashTab = screen.getByRole('tab', { name: /Trash/ });
    await waitFor(() => expect(document.activeElement).toBe(trashTab));
    expect(trashTab).toHaveAttribute('aria-selected', 'true');

    const closeButton = screen.getByRole('button', { name: 'Close recovery' });
    const focusable = Array.from(
      dialog.querySelectorAll<HTMLElement>(
        'button:not([disabled]), [href], input:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
      ),
    );
    closeButton.focus();
    await fireEvent.keyDown(closeButton, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(focusable.at(-1));

    await fireEvent.keyDown(dialog, { key: 'Escape' });
    expect(handlers.onClose).toHaveBeenCalledOnce();
    await view.rerender({ ...props, open: false });
    await waitFor(() => expect(document.activeElement).toBe(trigger));
  });

  it('supports arrow, Home, and End navigation across the tablist', async () => {
    render(NotesRecoveryDialog, {
      props: {
        open: true,
        initialTab: 'history',
        currentNote: currentNote(),
        trash: [trashedNote()],
        revisions: [revision(3)],
        selectedRevision: null,
        ...callbacks(),
      },
    });

    const historyTab = screen.getByRole('tab', { name: /Revision history/ });
    const trashTab = screen.getByRole('tab', { name: /Trash/ });
    await waitFor(() => expect(document.activeElement).toBe(historyTab));

    await fireEvent.keyDown(historyTab, { key: 'ArrowRight' });
    expect(trashTab).toHaveAttribute('aria-selected', 'true');
    await waitFor(() => expect(document.activeElement).toBe(trashTab));

    await fireEvent.keyDown(trashTab, { key: 'Home' });
    expect(historyTab).toHaveAttribute('aria-selected', 'true');
    await fireEvent.keyDown(historyTab, { key: 'End' });
    expect(trashTab).toHaveAttribute('aria-selected', 'true');
  });
});

describe('NotesRecoveryDialog revision history', () => {
  it('shows operation, source, date, and size, then requires confirmation before restore', async () => {
    const handlers = callbacks();
    const historical = revision(1, {
      sourcePath: 'docs/architecture.md',
      contentBytes: 1536,
      operation: 'external_sync',
    });
    const current = revision(3);
    const baseProps = {
      open: true,
      initialTab: 'history' as const,
      currentNote: currentNote(),
      trash: [],
      revisions: [current, historical],
      loading: false,
      error: null,
      ...handlers,
    };
    const view = render(NotesRecoveryDialog, {
      props: { ...baseProps, selectedRevision: null },
    });

    const historicalButton = screen.getByRole('button', {
      name: /Revision 1, Synced from project/i,
    });
    expect(historicalButton).toHaveTextContent('1.5 KB');
    expect(historicalButton).toHaveTextContent('Project file · docs/architecture.md');

    await fireEvent.click(historicalButton);
    expect(handlers.onSelectRevision).toHaveBeenCalledWith(historical);

    const loadedRevision = revisionWithContent(1, '# Original\n\nVerified evidence.', {
      ...historical,
    });
    await view.rerender({ ...baseProps, selectedRevision: loadedRevision });

    expect(screen.getByLabelText('Revision content preview')).toHaveTextContent(
      '# Original Verified evidence.',
    );
    expect(screen.getByText('Historical')).toBeTruthy();
    expect(screen.getByText('Synced from project', { selector: 'p' })).toBeTruthy();

    await fireEvent.click(screen.getByRole('button', { name: 'Restore this revision' }));
    expect(handlers.onRestoreRevision).not.toHaveBeenCalled();
    expect(screen.getByRole('alert')).toHaveTextContent('Newer history remains recoverable');

    await fireEvent.click(screen.getByRole('button', { name: 'Confirm restore revision 1' }));
    expect(handlers.onRestoreRevision).toHaveBeenCalledOnce();
    expect(handlers.onRestoreRevision).toHaveBeenCalledWith(historical);
  });

  it('bounds very large revision previews without changing the restore snapshot', async () => {
    const longContent = 'x'.repeat(NOTES_REVISION_PREVIEW_LIMIT + 25);
    const selected = revisionWithContent(1, longContent, {
      contentBytes: longContent.length,
    });
    render(NotesRecoveryDialog, {
      props: {
        open: true,
        currentNote: currentNote(),
        trash: [],
        revisions: [selected],
        selectedRevision: selected,
        ...callbacks(),
      },
    });

    expect(screen.getByLabelText('Revision content preview').textContent).toHaveLength(
      NOTES_REVISION_PREVIEW_LIMIT,
    );
    expect(screen.getByText(/Preview limited to/)).toHaveTextContent(
      'Restore still uses the complete saved snapshot',
    );
  });
});

describe('NotesRecoveryDialog Trash', () => {
  it('explains recoverability and restores the complete note from Trash', async () => {
    const handlers = callbacks();
    const note = trashedNote();
    const view = render(NotesRecoveryDialog, {
      props: {
        open: true,
        initialTab: 'trash',
        currentNote: currentNote(),
        trash: [note],
        revisions: [],
        selectedRevision: null,
        ...handlers,
      },
    });

    const trashPanel = screen.getByRole('tabpanel', { name: /Trash/ });
    expect(within(trashPanel).getByText('Discarded research')).toBeTruthy();
    expect(trashPanel).toHaveTextContent('Recoverable · Project source removed');
    expect(trashPanel).toHaveTextContent('Project file · docs/research.md');
    expect(trashPanel).toHaveTextContent('/Research');
    expect(view.container.querySelector('select')).toBeNull();

    await fireEvent.click(
      within(trashPanel).getByRole('button', { name: 'Restore Discarded research from Trash' }),
    );
    expect(handlers.onRestoreTrash).toHaveBeenCalledOnce();
    expect(handlers.onRestoreTrash).toHaveBeenCalledWith(note);
  });
});
