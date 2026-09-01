<script module lang="ts">
  export const NOTES_QUICK_SWITCHER_RESULT_LIMIT = 50;
  let nextNotesQuickSwitcherId = 0;

  export interface NotesQuickSwitcherNote {
    id: string;
    title: string;
    folderPath?: string | null;
    tags?: readonly string[];
    aliases?: readonly string[];
    updatedAt?: string | number | Date | null;
  }

  interface RankedQuickSwitcherNote {
    note: NotesQuickSwitcherNote;
    score: number;
    updatedAt: number;
    originalIndex: number;
  }

  function normalized(value: string | null | undefined): string {
    return (value ?? '').trim().replace(/\s+/g, ' ').toLocaleLowerCase('en');
  }

  function compareText(left: string, right: string): number {
    if (left === right) return 0;
    return left < right ? -1 : 1;
  }

  function subsequenceScore(value: string, query: string): number | null {
    let queryIndex = 0;
    let firstMatch = -1;
    let previousMatch = -1;
    let gapCost = 0;

    for (let valueIndex = 0; valueIndex < value.length && queryIndex < query.length; valueIndex++) {
      if (value[valueIndex] !== query[queryIndex]) continue;
      if (firstMatch < 0) firstMatch = valueIndex;
      if (previousMatch >= 0) gapCost += valueIndex - previousMatch - 1;
      previousMatch = valueIndex;
      queryIndex += 1;
    }

    if (queryIndex !== query.length) return null;
    return Math.max(0, 4_000 - firstMatch * 20 - gapCost * 30 - (value.length - query.length));
  }

  function matchScore(note: NotesQuickSwitcherNote, query: string): number | null {
    if (!query) return 0;

    const title = normalized(note.title);
    const folder = normalized(note.folderPath);
    const tags = (note.tags ?? []).map(normalized);
    const aliases = (note.aliases ?? []).map(normalized);
    const terms = query.split(' ');
    const searchable = [title, folder, ...tags, ...aliases].join(' ');

    let score: number;
    if (title === query) score = 1_000_000;
    else if (title.startsWith(query)) score = 900_000;
    else if (title.includes(` ${query}`)) score = 820_000;
    else if (title.includes(query)) score = 760_000;
    else if (aliases.some((alias) => alias === query)) score = 720_000;
    else if (aliases.some((alias) => alias.startsWith(query))) score = 680_000;
    else if (tags.some((tag) => tag === query)) score = 640_000;
    else if (terms.every((term) => searchable.includes(term))) score = 560_000;
    else {
      const fuzzy = subsequenceScore(title, query);
      if (fuzzy === null) return null;
      score = 400_000 + fuzzy;
    }

    score += Math.max(0, 2_000 - Math.abs(title.length - query.length) * 10);
    return score;
  }

  function updatedAtValue(value: NotesQuickSwitcherNote['updatedAt']): number {
    if (value instanceof Date) return Number.isFinite(value.getTime()) ? value.getTime() : 0;
    if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
    if (typeof value === 'string') {
      const timestamp = Date.parse(value);
      return Number.isFinite(timestamp) ? timestamp : 0;
    }
    return 0;
  }

  export function rankNotesForQuickSwitcher(
    notes: readonly NotesQuickSwitcherNote[],
    query: string,
    recentIds: readonly string[] = [],
    favoriteIds: readonly string[] = [],
    limit = NOTES_QUICK_SWITCHER_RESULT_LIMIT,
  ): NotesQuickSwitcherNote[] {
    const search = normalized(query);
    const favorites = new Set(favoriteIds);
    const recents = new Map(recentIds.map((id, index) => [id, index]));
    const boundedLimit = Math.max(0, Math.min(NOTES_QUICK_SWITCHER_RESULT_LIMIT, limit));
    const ranked: RankedQuickSwitcherNote[] = [];

    for (let index = 0; index < notes.length; index += 1) {
      const note = notes[index];
      const match = matchScore(note, search);
      if (match === null) continue;

      const recentIndex = recents.get(note.id);
      let score = match;
      if (favorites.has(note.id)) score += search ? 20_000 : 2_000_000;
      if (recentIndex !== undefined) {
        score += search ? Math.max(0, 10_000 - recentIndex * 25) : 1_000_000 - recentIndex;
      }

      ranked.push({
        note,
        score,
        updatedAt: updatedAtValue(note.updatedAt),
        originalIndex: index,
      });
    }

    ranked.sort((left, right) => {
      if (left.score !== right.score) return right.score - left.score;
      if (!search && left.updatedAt !== right.updatedAt) return right.updatedAt - left.updatedAt;
      const titleOrder = compareText(normalized(left.note.title), normalized(right.note.title));
      if (titleOrder !== 0) return titleOrder;
      const folderOrder = compareText(
        normalized(left.note.folderPath),
        normalized(right.note.folderPath),
      );
      if (folderOrder !== 0) return folderOrder;
      const idOrder = compareText(left.note.id, right.note.id);
      return idOrder || left.originalIndex - right.originalIndex;
    });

    return ranked.slice(0, boundedLimit).map(({ note }) => note);
  }
</script>

<script lang="ts">
  import { onDestroy, tick } from 'svelte';
  import Clock3 from 'lucide-svelte/icons/clock-3';
  import FileText from 'lucide-svelte/icons/file-text';
  import Plus from 'lucide-svelte/icons/plus';
  import Search from 'lucide-svelte/icons/search';
  import Star from 'lucide-svelte/icons/star';
  import X from 'lucide-svelte/icons/x';
  import { getModKeyName } from '$lib/utils/platform';

  interface Props {
    open: boolean;
    notes: readonly NotesQuickSwitcherNote[];
    recentIds?: readonly string[];
    favoriteIds?: readonly string[];
    onOpen: (noteId: string) => void;
    onCreate: (exactTitle: string) => void;
    onToggleFavorite: (noteId: string) => void;
    onClose: () => void;
  }

  let {
    open,
    notes,
    recentIds = [],
    favoriteIds = [],
    onOpen,
    onCreate,
    onToggleFavorite,
    onClose,
  }: Props = $props();

  type QuickSwitcherRow =
    | { kind: 'note'; key: string; note: NotesQuickSwitcherNote }
    | { kind: 'create'; key: 'create'; title: string };

  const dialogId = `notes-quick-switcher-${++nextNotesQuickSwitcherId}`;
  const titleId = `${dialogId}-title`;
  const descriptionId = `${dialogId}-description`;
  const listboxId = `${dialogId}-results`;
  const statusId = `${dialogId}-status`;

  let query = $state('');
  let selectedIndex = $state(0);
  let inputElement = $state<HTMLInputElement>();
  let dialogElement = $state<HTMLDivElement>();
  let previouslyFocused: HTMLElement | null = null;
  let wasOpen = false;
  let rankedQuery = '';

  const favoriteIdSet = $derived(new Set(favoriteIds));
  const recentIdSet = $derived(new Set(recentIds));
  const exactTitle = $derived(query.trim());
  const canCreate = $derived(
    Boolean(exactTitle) && !notes.some((note) => normalized(note.title) === normalized(exactTitle)),
  );
  const noteResultLimit = $derived(
    canCreate ? NOTES_QUICK_SWITCHER_RESULT_LIMIT - 1 : NOTES_QUICK_SWITCHER_RESULT_LIMIT,
  );
  const rankedNotes = $derived(
    rankNotesForQuickSwitcher(notes, query, recentIds, favoriteIds, noteResultLimit),
  );
  const rows = $derived.by<QuickSwitcherRow[]>(() => {
    const result: QuickSwitcherRow[] = rankedNotes.map((note) => ({
      kind: 'note',
      key: `note:${note.id}`,
      note,
    }));
    if (canCreate) result.push({ kind: 'create', key: 'create', title: exactTitle });
    return result;
  });
  const activeDescendant = $derived(
    rows[selectedIndex] ? `${listboxId}-option-${selectedIndex}` : undefined,
  );

  function close() {
    onClose();
  }

  function activate(row: QuickSwitcherRow | undefined) {
    if (!row) return;
    if (row.kind === 'create') onCreate(row.title);
    else onOpen(row.note.id);
    onClose();
  }

  function moveSelection(nextIndex: number) {
    if (rows.length === 0) return;
    selectedIndex = (nextIndex + rows.length) % rows.length;
    void tick().then(() => {
      const option = dialogElement?.querySelector<HTMLElement>(`#${activeDescendant}`);
      option?.scrollIntoView?.({ block: 'nearest' });
    });
  }

  function toggleSelectedFavorite() {
    const row = rows[selectedIndex];
    if (row?.kind === 'note') onToggleFavorite(row.note.id);
  }

  function focusableElements(): HTMLElement[] {
    if (!dialogElement) return [];
    return Array.from(
      dialogElement.querySelectorAll<HTMLElement>(
        'button:not([disabled]), input:not([disabled]), [href], [tabindex]:not([tabindex="-1"])',
      ),
    ).filter((element) => element.getAttribute('aria-hidden') !== 'true');
  }

  function handleDialogKeydown(event: KeyboardEvent) {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      close();
      return;
    }

    if (event.key === 'Tab') {
      const focusable = focusableElements();
      const first = focusable[0];
      const last = focusable.at(-1);
      if (!first || !last) {
        event.preventDefault();
        dialogElement?.focus();
        return;
      }
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
      return;
    }

    if (event.target !== inputElement) return;

    if (event.key === 'ArrowDown') {
      event.preventDefault();
      moveSelection(selectedIndex + 1);
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      moveSelection(selectedIndex - 1);
    } else if (event.key === 'Home') {
      event.preventDefault();
      moveSelection(0);
    } else if (event.key === 'End') {
      event.preventDefault();
      moveSelection(rows.length - 1);
    } else if (event.key === 'PageDown') {
      event.preventDefault();
      moveSelection(Math.min(rows.length - 1, selectedIndex + 8));
    } else if (event.key === 'PageUp') {
      event.preventDefault();
      moveSelection(Math.max(0, selectedIndex - 8));
    } else if (event.key === 'Enter' && (event.metaKey || event.ctrlKey) && canCreate) {
      event.preventDefault();
      onCreate(exactTitle);
      onClose();
    } else if (event.key === 'Enter') {
      event.preventDefault();
      activate(rows[selectedIndex]);
    } else if (event.key.toLocaleLowerCase('en') === 'f' && event.altKey) {
      event.preventDefault();
      toggleSelectedFavorite();
    }
  }

  function handleOverlayPointerDown(event: PointerEvent) {
    if (event.target === event.currentTarget) close();
  }

  $effect(() => {
    if (open && !wasOpen) {
      wasOpen = true;
      previouslyFocused =
        typeof document !== 'undefined' ? (document.activeElement as HTMLElement | null) : null;
      query = '';
      selectedIndex = 0;
      void tick().then(() => inputElement?.focus());
    } else if (!open && wasOpen) {
      wasOpen = false;
      const restoreFocus = previouslyFocused;
      previouslyFocused = null;
      void tick().then(() => restoreFocus?.focus());
    }
  });

  $effect(() => {
    if (query !== rankedQuery) {
      rankedQuery = query;
      selectedIndex = 0;
    }
  });

  $effect(() => {
    rows;
    if (selectedIndex >= rows.length) selectedIndex = Math.max(0, rows.length - 1);
  });

  onDestroy(() => {
    if (wasOpen) previouslyFocused?.focus();
  });
</script>

{#if open}
  <div
    class="notes-quick-switcher-overlay fixed inset-0 z-[120] flex items-start justify-center px-4 pt-[12vh] backdrop-blur-sm"
    role="presentation"
    onpointerdown={handleOverlayPointerDown}
  >
    <div
      bind:this={dialogElement}
      class="flex max-h-[72vh] w-full max-w-2xl flex-col overflow-hidden rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface-1)] shadow-2xl"
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      aria-describedby={descriptionId}
      tabindex="-1"
      onkeydown={handleDialogKeydown}
    >
      <div class="sr-only">
        <h2 id={titleId}>Open a note</h2>
        <p id={descriptionId}>
          Search the complete note catalog. Use the arrow keys to move, Enter to open, Alt+F to
          favorite, and Escape to close.
        </p>
      </div>

      <div class="flex items-center gap-3 border-b border-[var(--color-border)] px-4 py-3">
        <Search size={18} class="shrink-0 text-[var(--color-text-muted)]" aria-hidden="true" />
        <label class="sr-only" for={`${dialogId}-input`}>Search notes</label>
        <input
          bind:this={inputElement}
          bind:value={query}
          id={`${dialogId}-input`}
          type="search"
          role="combobox"
          aria-autocomplete="list"
          aria-haspopup="listbox"
          aria-expanded="true"
          aria-controls={listboxId}
          aria-activedescendant={activeDescendant}
          aria-describedby={statusId}
          autocomplete="off"
          spellcheck="false"
          placeholder="Open a note by title, path, tag, or alias…"
          class="min-w-0 flex-1 border-none bg-transparent text-sm text-[var(--color-text-primary)] outline-none placeholder:text-[var(--color-text-muted)]"
        />
        <kbd
          class="hidden rounded-md border border-[var(--color-border)] bg-[var(--color-surface-2)] px-1.5 py-0.5 text-[10px] text-[var(--color-text-muted)] sm:block"
          >Esc</kbd
        >
        <button
          type="button"
          class="rounded-lg p-1.5 text-[var(--color-text-muted)] transition-colors hover:bg-[var(--color-surface-3)] hover:text-[var(--color-text-primary)]"
          aria-label="Close note switcher"
          onclick={close}
        >
          <X size={16} aria-hidden="true" />
        </button>
      </div>

      <p id={statusId} class="sr-only" aria-live="polite">
        {rows.length} result{rows.length === 1 ? '' : 's'} shown
      </p>

      <div
        id={listboxId}
        class="min-h-24 flex-1 overflow-y-auto p-2"
        role="listbox"
        aria-label="Notes"
      >
        {#if rows.length === 0}
          <div class="flex min-h-36 flex-col items-center justify-center px-6 text-center">
            <FileText size={30} class="mb-3 text-[var(--color-text-muted)]" aria-hidden="true" />
            <p class="text-sm font-medium text-[var(--color-text-primary)]">No matching notes</p>
            <p class="mt-1 text-xs text-[var(--color-text-muted)]">
              Try a title, folder, tag, or alias.
            </p>
          </div>
        {:else}
          {#each rows as row, index (row.key)}
            {@const selected = index === selectedIndex}
            {#if row.kind === 'note'}
              {@const favorite = favoriteIdSet.has(row.note.id)}
              <div
                class="mb-0.5 flex items-center gap-1 rounded-xl border"
                class:border-[var(--color-border-bright)]={selected}
                class:border-transparent={!selected}
                class:bg-[var(--color-surface-3)]={selected}
                role="presentation"
                onpointermove={() => (selectedIndex = index)}
              >
                <button
                  id={`${listboxId}-option-${index}`}
                  type="button"
                  role="option"
                  aria-selected={selected}
                  class="flex min-w-0 flex-1 items-center gap-3 rounded-xl px-3 py-2.5 text-left outline-none"
                  onclick={() => activate(row)}
                >
                  <span
                    class="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-[var(--color-surface-2)] text-[var(--color-text-secondary)]"
                  >
                    <FileText size={16} aria-hidden="true" />
                  </span>
                  <span class="min-w-0 flex-1">
                    <span
                      class="block truncate text-sm font-medium text-[var(--color-text-primary)]"
                    >
                      {row.note.title || 'Untitled'}
                    </span>
                    <span
                      class="flex min-w-0 items-center gap-1.5 text-[11px] text-[var(--color-text-muted)]"
                    >
                      {#if recentIdSet.has(row.note.id)}
                        <Clock3 size={11} class="shrink-0" aria-hidden="true" />
                        <span class="shrink-0">Recent</span>
                      {/if}
                      {#if row.note.folderPath && row.note.folderPath !== '/'}
                        <span aria-hidden="true">·</span>
                        <span class="truncate">{row.note.folderPath}</span>
                      {/if}
                      {#if row.note.tags?.length}
                        <span aria-hidden="true">·</span>
                        <span class="truncate">#{row.note.tags.slice(0, 2).join(' #')}</span>
                      {/if}
                    </span>
                  </span>
                </button>
                <button
                  type="button"
                  class="mr-2 rounded-lg p-2 text-[var(--color-text-muted)] transition-colors hover:bg-[var(--color-surface-4)] hover:text-[var(--color-accent)]"
                  class:text-[var(--color-accent)]={favorite}
                  aria-label={`${favorite ? 'Remove' : 'Add'} ${row.note.title || 'Untitled'} ${favorite ? 'from' : 'to'} favorites`}
                  aria-pressed={favorite}
                  onclick={() => onToggleFavorite(row.note.id)}
                >
                  <Star size={15} fill={favorite ? 'currentColor' : 'none'} aria-hidden="true" />
                </button>
              </div>
            {:else}
              <button
                id={`${listboxId}-option-${index}`}
                type="button"
                role="option"
                aria-selected={selected}
                class="mb-0.5 flex w-full items-center gap-3 rounded-xl border px-3 py-2.5 text-left outline-none"
                class:border-[var(--color-border-bright)]={selected}
                class:border-transparent={!selected}
                class:bg-[var(--color-surface-3)]={selected}
                onpointermove={() => (selectedIndex = index)}
                onclick={() => activate(row)}
              >
                <span
                  class="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-[var(--color-accent-transparent)] text-[var(--color-accent)]"
                >
                  <Plus size={16} aria-hidden="true" />
                </span>
                <span class="min-w-0 flex-1">
                  <span class="block truncate text-sm font-medium text-[var(--color-text-primary)]">
                    Create “{row.title}”
                  </span>
                  <span class="block text-[11px] text-[var(--color-text-muted)]">
                    Create this exact title
                  </span>
                </span>
                <kbd
                  class="rounded-md border border-[var(--color-border)] bg-[var(--color-surface-2)] px-1.5 py-0.5 text-[10px] text-[var(--color-text-muted)]"
                  >{getModKeyName()}↵</kbd
                >
              </button>
            {/if}
          {/each}
        {/if}
      </div>

      <div
        class="flex items-center justify-between gap-4 border-t border-[var(--color-border)] bg-[var(--color-surface-2)] px-4 py-2 text-[10px] text-[var(--color-text-muted)]"
      >
        <span>
          <kbd>↑↓</kbd> move · <kbd>↵</kbd> open · <kbd>Alt F</kbd> favorite
        </span>
        <span class="shrink-0">
          {Math.min(rows.length, NOTES_QUICK_SWITCHER_RESULT_LIMIT)} of {notes.length}
        </span>
      </div>
    </div>
  </div>
{/if}

<style>
  .notes-quick-switcher-overlay {
    background: color-mix(in srgb, var(--color-surface-0) 78%, transparent);
  }

  [role='option'][aria-selected='true'] {
    outline: none;
  }

  kbd {
    font-family: inherit;
  }
</style>
