import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import NotesQuickSwitcher, {
  NOTES_QUICK_SWITCHER_RESULT_LIMIT,
  rankNotesForQuickSwitcher,
  type NotesQuickSwitcherNote,
} from './NotesQuickSwitcher.svelte';

function note(
  id: string,
  title: string,
  overrides: Partial<NotesQuickSwitcherNote> = {},
): NotesQuickSwitcherNote {
  return {
    id,
    title,
    folderPath: '/',
    tags: [],
    updatedAt: 0,
    ...overrides,
  };
}

function callbacks() {
  return {
    onOpen: vi.fn(),
    onCreate: vi.fn(),
    onToggleFavorite: vi.fn(),
    onClose: vi.fn(),
  };
}

afterEach(() => {
  cleanup();
  document.body.innerHTML = '';
});

describe('NotesQuickSwitcher ranking', () => {
  it('uses deterministic title, alias, favorite, and recent scoring', () => {
    const catalog = [
      note('architecture', 'Architecture'),
      note('project', 'Project map', { aliases: ['Architecture decision map'] }),
      note('alpha', 'Alpha'),
      note('beta', 'Beta'),
    ];

    expect(rankNotesForQuickSwitcher(catalog, 'arch').map(({ id }) => id)).toEqual([
      'architecture',
      'project',
    ]);
    expect(rankNotesForQuickSwitcher(catalog, '', ['beta'], ['alpha']).map(({ id }) => id)).toEqual(
      ['alpha', 'beta', 'architecture', 'project'],
    );

    const tied = [note('z', 'Same'), note('a', 'Same')];
    expect(rankNotesForQuickSwitcher(tied, 'same').map(({ id }) => id)).toEqual(['a', 'z']);
    expect(rankNotesForQuickSwitcher(tied.toReversed(), 'same').map(({ id }) => id)).toEqual([
      'a',
      'z',
    ]);
  });

  it('bounds a 10k-note catalog before anything reaches the DOM', () => {
    const catalog = Array.from({ length: 10_000 }, (_, index) =>
      note(`note-${index}`, `Note ${String(index).padStart(5, '0')}`),
    );

    const ranked = rankNotesForQuickSwitcher(catalog, '', [], []);
    expect(ranked).toHaveLength(NOTES_QUICK_SWITCHER_RESULT_LIMIT);
    expect(rankNotesForQuickSwitcher(catalog, 'Note 09999').map(({ id }) => id)).toEqual([
      'note-9999',
    ]);
  });
});

describe('NotesQuickSwitcher interaction', () => {
  it('exposes a labelled modal, traps focus, closes safely, and restores prior focus', async () => {
    const trigger = document.createElement('button');
    trigger.textContent = 'Open notes';
    document.body.appendChild(trigger);
    trigger.focus();

    const handlers = callbacks();
    const props = {
      open: true,
      notes: [note('alpha', 'Alpha')],
      recentIds: [],
      favoriteIds: [],
      ...handlers,
    };
    const view = render(NotesQuickSwitcher, { props });

    const dialog = screen.getByRole('dialog', { name: 'Open a note' });
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(dialog).toHaveAccessibleDescription(/Search the complete note catalog/i);

    const input = screen.getByRole('combobox', { name: 'Search notes' });
    await waitFor(() => expect(document.activeElement).toBe(input));
    expect(input).toHaveAttribute('aria-controls');
    expect(input).toHaveAttribute('aria-activedescendant');

    const focusable = Array.from(
      dialog.querySelectorAll<HTMLElement>(
        'button:not([disabled]), input:not([disabled]), [href], [tabindex]:not([tabindex="-1"])',
      ),
    );
    const last = focusable.at(-1)!;
    await fireEvent.keyDown(input, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(last);
    await fireEvent.keyDown(last, { key: 'Tab' });
    expect(document.activeElement).toBe(input);

    await fireEvent.keyDown(input, { key: 'Escape' });
    expect(handlers.onClose).toHaveBeenCalledOnce();

    await view.rerender({ ...props, open: false });
    await waitFor(() => expect(document.activeElement).toBe(trigger));
  });

  it('opens keyboard-selected notes and toggles favorites without closing', async () => {
    const handlers = callbacks();
    render(NotesQuickSwitcher, {
      props: {
        open: true,
        notes: [note('alpha', 'Alpha'), note('alpine', 'Alpine')],
        recentIds: [],
        favoriteIds: [],
        ...handlers,
      },
    });

    const input = screen.getByRole('combobox', { name: 'Search notes' });
    await fireEvent.input(input, { target: { value: 'alp' } });
    await waitFor(() => expect(screen.getByRole('option', { name: /Alpha/ })).toBeTruthy());

    await fireEvent.click(screen.getByRole('button', { name: 'Add Alpha to favorites' }));
    expect(handlers.onToggleFavorite).toHaveBeenCalledWith('alpha');
    expect(handlers.onClose).not.toHaveBeenCalled();

    await fireEvent.keyDown(input, { key: 'ArrowDown' });
    expect(screen.getByRole('option', { name: /Alpine/ })).toHaveAttribute('aria-selected', 'true');
    await fireEvent.keyDown(input, { key: 'Enter' });
    expect(handlers.onOpen).toHaveBeenCalledWith('alpine');
    expect(handlers.onClose).toHaveBeenCalledOnce();
  });

  it('creates the exact typed title and never renders more than the hard result cap', async () => {
    const handlers = callbacks();
    const catalog = Array.from({ length: 10_000 }, (_, index) =>
      note(`note-${index}`, `Note ${String(index).padStart(5, '0')}`),
    );
    const view = render(NotesQuickSwitcher, {
      props: {
        open: true,
        notes: catalog,
        recentIds: [],
        favoriteIds: [],
        ...handlers,
      },
    });

    expect(screen.getAllByRole('option')).toHaveLength(NOTES_QUICK_SWITCHER_RESULT_LIMIT);
    expect(view.container.querySelector('select')).toBeNull();

    const input = screen.getByRole('combobox', { name: 'Search notes' });
    await fireEvent.input(input, { target: { value: '  Exact Agent Memory  ' } });
    await waitFor(() =>
      expect(screen.getByRole('option', { name: /Create “Exact Agent Memory”/ })).toBeTruthy(),
    );
    expect(screen.getAllByRole('option').length).toBeLessThanOrEqual(
      NOTES_QUICK_SWITCHER_RESULT_LIMIT,
    );

    await fireEvent.keyDown(input, { key: 'Enter', metaKey: true });
    expect(handlers.onCreate).toHaveBeenCalledWith('Exact Agent Memory');
    expect(handlers.onClose).toHaveBeenCalledOnce();
  });
});
