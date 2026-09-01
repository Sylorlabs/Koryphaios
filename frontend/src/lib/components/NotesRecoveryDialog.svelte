<script module lang="ts">
  export type NotesRecoveryTab = 'history' | 'trash';

  export const NOTES_REVISION_PREVIEW_LIMIT = 100_000;

  let nextNotesRecoveryDialogId = 0;
</script>

<script lang="ts">
  import { onDestroy, tick } from 'svelte';
  import AlertCircle from 'lucide-svelte/icons/alert-circle';
  import Clock3 from 'lucide-svelte/icons/clock-3';
  import FileText from 'lucide-svelte/icons/file-text';
  import FolderOpen from 'lucide-svelte/icons/folder-open';
  import History from 'lucide-svelte/icons/history';
  import RotateCcw from 'lucide-svelte/icons/rotate-ccw';
  import Trash2 from 'lucide-svelte/icons/trash-2';
  import X from 'lucide-svelte/icons/x';
  import type {
    Note,
    NoteRevision,
    NoteRevisionOperation,
    NoteRevisionSummary,
    TrashedNote,
  } from '@koryphaios/shared';

  interface Props {
    open: boolean;
    initialTab?: NotesRecoveryTab;
    currentNote?: Note | null;
    trash?: readonly TrashedNote[];
    revisions?: readonly NoteRevisionSummary[];
    loading?: boolean;
    error?: string | null;
    selectedRevision?: NoteRevision | null;
    onSelectRevision: (revision: NoteRevisionSummary) => void;
    onRestoreRevision: (revision: NoteRevisionSummary) => void;
    onRestoreTrash: (note: TrashedNote) => void;
    onClose: () => void;
  }

  let {
    open,
    initialTab = 'history',
    currentNote = null,
    trash = [],
    revisions = [],
    loading = false,
    error = null,
    selectedRevision = null,
    onSelectRevision,
    onRestoreRevision,
    onRestoreTrash,
    onClose,
  }: Props = $props();

  const dialogId = `notes-recovery-${++nextNotesRecoveryDialogId}`;
  const titleId = `${dialogId}-title`;
  const descriptionId = `${dialogId}-description`;
  const historyTabId = `${dialogId}-history-tab`;
  const trashTabId = `${dialogId}-trash-tab`;
  const historyPanelId = `${dialogId}-history-panel`;
  const trashPanelId = `${dialogId}-trash-panel`;

  let dialogElement = $state<HTMLDivElement>();
  let activeTab = $state<NotesRecoveryTab>('history');
  let confirmation = $state<NoteRevisionSummary | null>(null);
  let previouslyFocused: HTMLElement | null = null;
  let wasOpen = false;

  const currentSelectedRevision = $derived(
    selectedRevision?.noteId === currentNote?.id ? selectedRevision : null,
  );
  const selectedSummary = $derived.by<NoteRevisionSummary | null>(() => {
    if (!currentSelectedRevision) return null;
    return (
      revisions.find(
        (revision) =>
          revision.noteId === currentSelectedRevision.noteId &&
          revision.revision === currentSelectedRevision.revision,
      ) ?? currentSelectedRevision
    );
  });
  const selectedIsCurrent = $derived(
    Boolean(
      selectedSummary &&
      currentNote &&
      selectedSummary.noteId === currentNote.id &&
      selectedSummary.revision === currentNote.revision,
    ),
  );
  const previewContent = $derived(
    (currentSelectedRevision?.content ?? '').slice(0, NOTES_REVISION_PREVIEW_LIMIT),
  );
  const previewIsLimited = $derived(
    (currentSelectedRevision?.content.length ?? 0) > NOTES_REVISION_PREVIEW_LIMIT,
  );

  const operationLabels: Record<NoteRevisionOperation, string> = {
    create: 'Created',
    update: 'Saved',
    external_sync: 'Synced from project',
    trash: 'Moved to Trash',
    source_removed: 'Project source removed',
    restore: 'Restored from Trash',
    revision_restore: 'Restored revision',
  };

  function asDate(value: Date | string | number | undefined): Date | null {
    if (value === undefined) return null;
    const date = value instanceof Date ? value : new Date(value);
    return Number.isFinite(date.getTime()) ? date : null;
  }

  function dateTime(value: Date | string | number | undefined): string {
    return asDate(value)?.toISOString() ?? '';
  }

  function formatDate(value: Date | string | number | undefined): string {
    const date = asDate(value);
    if (!date) return 'Unknown date';
    return new Intl.DateTimeFormat(undefined, {
      dateStyle: 'medium',
      timeStyle: 'short',
    }).format(date);
  }

  function formatBytes(bytes: number): string {
    if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB'];
    const unitIndex = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
    const value = bytes / 1024 ** unitIndex;
    return `${value >= 10 || unitIndex === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[unitIndex]}`;
  }

  function contentBytes(content: string): number {
    return new TextEncoder().encode(content).byteLength;
  }

  function sourceLabel(sourcePath: string | undefined): string {
    return sourcePath ? `Project file · ${sourcePath}` : 'Koryphaios vault';
  }

  function formatLabel(format: NoteRevisionSummary['format'] | Note['format']): string {
    return format === 'html' ? 'HTML' : 'Markdown';
  }

  function trashReasonLabel(reason: TrashedNote['trashReason']): string {
    return reason === 'source_removed' ? 'Project source removed' : 'Moved to Trash';
  }

  function tabElement(tab: NotesRecoveryTab): HTMLButtonElement | null {
    return (
      dialogElement?.querySelector<HTMLButtonElement>(
        `#${tab === 'history' ? historyTabId : trashTabId}`,
      ) ?? null
    );
  }

  function selectTab(tab: NotesRecoveryTab, focus = false) {
    activeTab = tab;
    confirmation = null;
    if (focus) void tick().then(() => tabElement(tab)?.focus());
  }

  function handleTabKeydown(event: KeyboardEvent, tab: NotesRecoveryTab) {
    let next: NotesRecoveryTab | null = null;
    if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
      next = tab === 'history' ? 'trash' : 'history';
    } else if (event.key === 'Home') {
      next = 'history';
    } else if (event.key === 'End') {
      next = 'trash';
    }
    if (!next) return;
    event.preventDefault();
    selectTab(next, true);
  }

  function focusableElements(): HTMLElement[] {
    if (!dialogElement) return [];
    return Array.from(
      dialogElement.querySelectorAll<HTMLElement>(
        'button:not([disabled]), [href], input:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
      ),
    ).filter((element) => !element.hasAttribute('hidden'));
  }

  function close() {
    confirmation = null;
    onClose();
  }

  function handleDialogKeydown(event: KeyboardEvent) {
    if (event.key === 'Escape') {
      event.preventDefault();
      if (confirmation) confirmation = null;
      else close();
      return;
    }
    if (event.key !== 'Tab') return;

    const focusable = focusableElements();
    if (focusable.length === 0) {
      event.preventDefault();
      dialogElement?.focus();
      return;
    }
    const first = focusable[0];
    const last = focusable.at(-1)!;
    if (
      event.shiftKey &&
      (document.activeElement === first || document.activeElement === dialogElement)
    ) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  function handleOverlayPointerDown(event: PointerEvent) {
    if (event.target === event.currentTarget && !confirmation) close();
  }

  function chooseRevision(revision: NoteRevisionSummary) {
    confirmation = null;
    onSelectRevision(revision);
  }

  function confirmRevisionRestore() {
    if (!confirmation) return;
    const revision = confirmation;
    confirmation = null;
    onRestoreRevision(revision);
  }

  $effect(() => {
    if (open && !wasOpen) {
      wasOpen = true;
      previouslyFocused =
        typeof document !== 'undefined' ? (document.activeElement as HTMLElement | null) : null;
      activeTab = initialTab;
      confirmation = null;
      void tick().then(() => tabElement(activeTab)?.focus());
    } else if (!open && wasOpen) {
      wasOpen = false;
      confirmation = null;
      const restoreFocus = previouslyFocused;
      previouslyFocused = null;
      void tick().then(() => restoreFocus?.focus());
    }
  });

  $effect(() => {
    if (
      confirmation &&
      (!currentNote ||
        confirmation.noteId !== currentNote.id ||
        !revisions.some(
          (revision) =>
            revision.noteId === confirmation?.noteId &&
            revision.revision === confirmation?.revision,
        ))
    ) {
      confirmation = null;
    }
  });

  onDestroy(() => {
    if (wasOpen) previouslyFocused?.focus();
  });
</script>

{#if open}
  <div
    class="notes-recovery-overlay fixed inset-0 z-[120] flex items-center justify-center p-4 backdrop-blur-sm"
    role="presentation"
    onpointerdown={handleOverlayPointerDown}
  >
    <div
      bind:this={dialogElement}
      class="flex max-h-[min(820px,calc(100vh-2rem))] w-full max-w-5xl flex-col overflow-hidden rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface-1)] shadow-2xl"
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      aria-describedby={descriptionId}
      tabindex="-1"
      onkeydown={handleDialogKeydown}
    >
      <header
        class="flex items-start gap-3 border-b border-[var(--color-border)] bg-[var(--color-surface-2)] px-5 py-4"
      >
        <span
          class="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-[var(--color-accent-transparent)] text-[var(--color-accent)]"
        >
          <History size={18} aria-hidden="true" />
        </span>
        <div class="min-w-0 flex-1">
          <h2 id={titleId} class="text-sm font-semibold text-[var(--color-text-primary)]">
            Recover notes and history
          </h2>
          <p
            id={descriptionId}
            class="mt-1 text-xs leading-relaxed text-[var(--color-text-secondary)]"
          >
            Restore a saved snapshot without erasing history, or return a recoverable note from
            Trash.
          </p>
        </div>
        <button
          type="button"
          class="rounded-lg p-1.5 text-[var(--color-text-muted)] transition-colors hover:bg-[var(--color-surface-3)] hover:text-[var(--color-text-primary)]"
          aria-label="Close recovery"
          onclick={close}
        >
          <X size={16} aria-hidden="true" />
        </button>
      </header>

      <div
        class="flex items-center gap-1 border-b border-[var(--color-border)] bg-[var(--color-surface-1)] px-4 pt-2"
        role="tablist"
        aria-label="Recovery views"
      >
        <button
          id={historyTabId}
          type="button"
          role="tab"
          aria-selected={activeTab === 'history'}
          aria-controls={historyPanelId}
          tabindex={activeTab === 'history' ? 0 : -1}
          class="flex items-center gap-2 rounded-t-lg border-b-2 px-3 py-2 text-xs font-medium transition-colors"
          class:border-[var(--color-accent)]={activeTab === 'history'}
          class:border-transparent={activeTab !== 'history'}
          class:text-[var(--color-accent)]={activeTab === 'history'}
          class:text-[var(--color-text-muted)]={activeTab !== 'history'}
          onclick={() => selectTab('history')}
          onkeydown={(event) => handleTabKeydown(event, 'history')}
        >
          <Clock3 size={14} aria-hidden="true" />
          Revision history
          <span
            class="rounded-full bg-[var(--color-surface-3)] px-1.5 py-0.5 text-[9px] tabular-nums text-[var(--color-text-muted)]"
            >{revisions.length}</span
          >
        </button>
        <button
          id={trashTabId}
          type="button"
          role="tab"
          aria-selected={activeTab === 'trash'}
          aria-controls={trashPanelId}
          tabindex={activeTab === 'trash' ? 0 : -1}
          class="flex items-center gap-2 rounded-t-lg border-b-2 px-3 py-2 text-xs font-medium transition-colors"
          class:border-[var(--color-accent)]={activeTab === 'trash'}
          class:border-transparent={activeTab !== 'trash'}
          class:text-[var(--color-accent)]={activeTab === 'trash'}
          class:text-[var(--color-text-muted)]={activeTab !== 'trash'}
          onclick={() => selectTab('trash')}
          onkeydown={(event) => handleTabKeydown(event, 'trash')}
        >
          <Trash2 size={14} aria-hidden="true" />
          Trash
          <span
            class="rounded-full bg-[var(--color-surface-3)] px-1.5 py-0.5 text-[9px] tabular-nums text-[var(--color-text-muted)]"
            >{trash.length}</span
          >
        </button>
      </div>

      {#if error}
        <div
          class="mx-4 mt-4 flex items-start gap-2 rounded-xl border border-[var(--color-error)]/35 bg-[var(--color-error)]/10 px-3 py-2.5 text-xs text-[var(--color-error)]"
          role="alert"
        >
          <AlertCircle size={15} class="mt-0.5 shrink-0" aria-hidden="true" />
          <span>{error}</span>
        </div>
      {/if}

      <p class="sr-only" aria-live="polite">
        {loading ? 'Loading recovery data' : 'Recovery data loaded'}
      </p>

      {#if activeTab === 'history'}
        <div
          id={historyPanelId}
          role="tabpanel"
          aria-labelledby={historyTabId}
          class="grid min-h-0 flex-1 grid-cols-1 overflow-hidden md:grid-cols-[minmax(250px,0.8fr)_minmax(0,1.5fr)]"
        >
          <section
            class="min-h-0 overflow-y-auto border-b border-[var(--color-border)] p-3 md:border-b-0 md:border-r"
            aria-label="Saved revisions"
          >
            {#if currentNote}
              <div class="mb-3 px-1">
                <p class="truncate text-xs font-medium text-[var(--color-text-primary)]">
                  {currentNote.title || 'Untitled'}
                </p>
                <p class="mt-0.5 text-[10px] text-[var(--color-text-muted)]">
                  Current revision {currentNote.revision}
                </p>
              </div>
            {/if}

            {#if loading && revisions.length === 0}
              <div class="space-y-2" aria-hidden="true">
                {#each Array(4) as _}
                  <div class="h-20 animate-pulse rounded-xl bg-[var(--color-surface-2)]"></div>
                {/each}
              </div>
            {:else if !currentNote}
              <div class="flex min-h-44 flex-col items-center justify-center px-4 text-center">
                <FileText
                  size={28}
                  class="mb-3 text-[var(--color-text-muted)]"
                  aria-hidden="true"
                />
                <p class="text-xs font-medium text-[var(--color-text-primary)]">No note selected</p>
                <p class="mt-1 text-[11px] leading-relaxed text-[var(--color-text-muted)]">
                  Open a note to inspect its immutable saved revisions.
                </p>
              </div>
            {:else if revisions.length === 0}
              <div class="flex min-h-44 flex-col items-center justify-center px-4 text-center">
                <Clock3 size={28} class="mb-3 text-[var(--color-text-muted)]" aria-hidden="true" />
                <p class="text-xs font-medium text-[var(--color-text-primary)]">
                  No saved revisions yet
                </p>
                <p class="mt-1 text-[11px] leading-relaxed text-[var(--color-text-muted)]">
                  Saved changes will appear here with their source and operation.
                </p>
              </div>
            {:else}
              <div class="space-y-1.5">
                {#each revisions as revision (`${revision.noteId}:${revision.revision}`)}
                  {@const selected =
                    currentSelectedRevision?.noteId === revision.noteId &&
                    currentSelectedRevision.revision === revision.revision}
                  {@const current = revision.revision === currentNote.revision}
                  <button
                    type="button"
                    class="w-full rounded-xl border px-3 py-2.5 text-left transition-colors"
                    class:border-[var(--color-border-bright)]={selected}
                    class:border-[var(--color-border)]={!selected}
                    class:bg-[var(--color-surface-3)]={selected}
                    class:bg-[var(--color-surface-2)]={!selected}
                    aria-pressed={selected}
                    aria-label={`Revision ${revision.revision}, ${operationLabels[revision.operation]}, ${formatDate(revision.createdAt)}${current ? ', current' : ''}`}
                    onclick={() => chooseRevision(revision)}
                  >
                    <span class="flex items-center justify-between gap-2">
                      <span class="text-xs font-medium text-[var(--color-text-primary)]">
                        Revision {revision.revision}
                      </span>
                      {#if current}
                        <span
                          class="rounded-full bg-[var(--color-accent-transparent)] px-1.5 py-0.5 text-[9px] font-medium text-[var(--color-accent)]"
                          >Current</span
                        >
                      {/if}
                    </span>
                    <span class="mt-1 block text-[10px] text-[var(--color-text-secondary)]">
                      {operationLabels[revision.operation]}
                    </span>
                    <span
                      class="mt-1 flex items-center justify-between gap-2 text-[9px] text-[var(--color-text-muted)]"
                    >
                      <time datetime={dateTime(revision.createdAt)}
                        >{formatDate(revision.createdAt)}</time
                      >
                      <span class="shrink-0">{formatBytes(revision.contentBytes)}</span>
                    </span>
                    <span class="mt-1 block truncate text-[9px] text-[var(--color-text-muted)]">
                      {sourceLabel(revision.sourcePath)} · {formatLabel(revision.format)}
                    </span>
                  </button>
                {/each}
              </div>
            {/if}
          </section>

          <section class="flex min-h-0 flex-col overflow-hidden" aria-label="Revision preview">
            {#if currentSelectedRevision && selectedSummary}
              <div
                class="flex flex-wrap items-start justify-between gap-3 border-b border-[var(--color-border)] bg-[var(--color-surface-2)] px-4 py-3"
              >
                <div class="min-w-0">
                  <div class="flex flex-wrap items-center gap-2">
                    <h3 class="text-xs font-semibold text-[var(--color-text-primary)]">
                      Revision {currentSelectedRevision.revision}
                    </h3>
                    <span
                      class="rounded bg-[var(--color-surface-3)] px-1.5 py-0.5 text-[9px] text-[var(--color-text-secondary)]"
                    >
                      {operationLabels[currentSelectedRevision.operation]}
                    </span>
                    {#if selectedIsCurrent}
                      <span
                        class="rounded bg-[var(--color-accent-transparent)] px-1.5 py-0.5 text-[9px] text-[var(--color-accent)]"
                        >Current</span
                      >
                    {/if}
                  </div>
                  <p class="mt-1 truncate text-[10px] text-[var(--color-text-muted)]">
                    {formatDate(currentSelectedRevision.createdAt)} · {formatBytes(
                      currentSelectedRevision.contentBytes,
                    )} · {sourceLabel(currentSelectedRevision.sourcePath)}
                  </p>
                </div>
                {#if !selectedIsCurrent && !confirmation}
                  <button
                    type="button"
                    class="flex shrink-0 items-center gap-1.5 rounded-lg bg-[var(--color-accent)] px-3 py-1.5 text-[11px] font-medium text-[var(--color-accent-foreground)] transition-opacity hover:opacity-90 disabled:opacity-50"
                    disabled={loading}
                    onclick={() => (confirmation = selectedSummary)}
                  >
                    <RotateCcw size={13} aria-hidden="true" />
                    Restore this revision
                  </button>
                {/if}
              </div>

              {#if confirmation}
                <div
                  class="m-4 rounded-xl border border-[var(--color-warning)]/40 bg-[var(--color-warning)]/10 p-3"
                  role="alert"
                >
                  <p class="text-xs font-medium text-[var(--color-text-primary)]">
                    Restore revision {confirmation.revision}?
                  </p>
                  <p class="mt-1 text-[10px] leading-relaxed text-[var(--color-text-secondary)]">
                    Koryphaios will create a new revision from this snapshot. Newer history remains
                    recoverable.
                  </p>
                  <div class="mt-3 flex flex-wrap justify-end gap-2">
                    <button
                      type="button"
                      class="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-2)] px-3 py-1.5 text-[10px] font-medium text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-3)]"
                      onclick={() => (confirmation = null)}
                    >
                      Keep current note
                    </button>
                    <button
                      type="button"
                      class="rounded-lg bg-[var(--color-accent)] px-3 py-1.5 text-[10px] font-medium text-[var(--color-accent-foreground)] hover:opacity-90"
                      onclick={confirmRevisionRestore}
                    >
                      Confirm restore revision {confirmation.revision}
                    </button>
                  </div>
                </div>
              {/if}

              <div class="min-h-0 flex-1 overflow-auto bg-[var(--color-surface-0)] p-4">
                <div
                  class="mb-3 grid grid-cols-2 gap-2 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-1)] p-3 text-[9px] sm:grid-cols-4"
                >
                  <div>
                    <p class="uppercase tracking-wider text-[var(--color-text-muted)]">Status</p>
                    <p class="mt-1 text-[var(--color-text-primary)]">
                      {selectedIsCurrent ? 'Current' : 'Historical'}
                    </p>
                  </div>
                  <div>
                    <p class="uppercase tracking-wider text-[var(--color-text-muted)]">Operation</p>
                    <p class="mt-1 text-[var(--color-text-primary)]">
                      {operationLabels[currentSelectedRevision.operation]}
                    </p>
                  </div>
                  <div>
                    <p class="uppercase tracking-wider text-[var(--color-text-muted)]">Format</p>
                    <p class="mt-1 text-[var(--color-text-primary)]">
                      {formatLabel(currentSelectedRevision.format)}
                    </p>
                  </div>
                  <div>
                    <p class="uppercase tracking-wider text-[var(--color-text-muted)]">Size</p>
                    <p class="mt-1 text-[var(--color-text-primary)]">
                      {formatBytes(currentSelectedRevision.contentBytes)}
                    </p>
                  </div>
                </div>
                <pre
                  class="min-h-44 whitespace-pre-wrap break-words rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-1)] p-4 font-mono text-[11px] leading-relaxed text-[var(--color-text-primary)]"
                  aria-label="Revision content preview">{previewContent ||
                    'This revision is empty.'}</pre>
                {#if previewIsLimited}
                  <p class="mt-2 text-[10px] text-[var(--color-text-muted)]">
                    Preview limited to {formatBytes(NOTES_REVISION_PREVIEW_LIMIT)} for responsiveness.
                    Restore still uses the complete saved snapshot.
                  </p>
                {/if}
              </div>
            {:else}
              <div
                class="flex min-h-64 flex-1 flex-col items-center justify-center px-8 text-center"
              >
                <History size={32} class="mb-3 text-[var(--color-text-muted)]" aria-hidden="true" />
                <p class="text-xs font-medium text-[var(--color-text-primary)]">
                  Select a revision to preview
                </p>
                <p class="mt-1 max-w-sm text-[11px] leading-relaxed text-[var(--color-text-muted)]">
                  Content loads on demand. Restoring a snapshot creates a new revision, so later
                  work is never erased from history.
                </p>
              </div>
            {/if}
          </section>
        </div>
      {:else}
        <div
          id={trashPanelId}
          role="tabpanel"
          aria-labelledby={trashTabId}
          class="min-h-0 flex-1 overflow-y-auto p-4"
        >
          {#if loading && trash.length === 0}
            <div class="grid gap-2 sm:grid-cols-2" aria-hidden="true">
              {#each Array(4) as _}
                <div class="h-32 animate-pulse rounded-xl bg-[var(--color-surface-2)]"></div>
              {/each}
            </div>
          {:else if trash.length === 0}
            <div class="flex min-h-64 flex-col items-center justify-center px-6 text-center">
              <Trash2 size={32} class="mb-3 text-[var(--color-text-muted)]" aria-hidden="true" />
              <p class="text-xs font-medium text-[var(--color-text-primary)]">Trash is empty</p>
              <p class="mt-1 max-w-sm text-[11px] leading-relaxed text-[var(--color-text-muted)]">
                Notes moved to Trash remain recoverable here with their content and source metadata.
              </p>
            </div>
          {:else}
            <div class="mb-3 flex items-center justify-between gap-3">
              <div>
                <h3 class="text-xs font-medium text-[var(--color-text-primary)]">
                  Recoverable notes
                </h3>
                <p class="mt-0.5 text-[10px] text-[var(--color-text-muted)]">
                  Restoring returns the complete note to the active vault.
                </p>
              </div>
              <span class="text-[10px] tabular-nums text-[var(--color-text-muted)]">
                {trash.length} note{trash.length === 1 ? '' : 's'}
              </span>
            </div>
            <div class="grid gap-2 sm:grid-cols-2">
              {#each trash as note (note.id)}
                <article
                  class="flex min-w-0 flex-col rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-2)] p-3"
                >
                  <div class="flex min-w-0 items-start gap-2.5">
                    <span
                      class="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-[var(--color-surface-3)] text-[var(--color-text-muted)]"
                    >
                      <FileText size={15} aria-hidden="true" />
                    </span>
                    <div class="min-w-0 flex-1">
                      <h4 class="truncate text-xs font-medium text-[var(--color-text-primary)]">
                        {note.title || 'Untitled'}
                      </h4>
                      <p class="mt-0.5 text-[9px] font-medium text-[var(--color-warning)]">
                        Recoverable · {trashReasonLabel(note.trashReason)}
                      </p>
                    </div>
                  </div>
                  <dl class="mt-3 space-y-1.5 text-[9px] text-[var(--color-text-muted)]">
                    <div class="flex items-center justify-between gap-3">
                      <dt>Trashed</dt>
                      <dd>
                        <time datetime={dateTime(note.trashedAt)}>{formatDate(note.trashedAt)}</time
                        >
                      </dd>
                    </div>
                    <div class="flex items-center justify-between gap-3">
                      <dt>Size</dt>
                      <dd>{formatBytes(contentBytes(note.content))}</dd>
                    </div>
                    <div class="flex min-w-0 items-center justify-between gap-3">
                      <dt class="shrink-0">Source</dt>
                      <dd class="truncate" title={sourceLabel(note.sourcePath)}>
                        {sourceLabel(note.sourcePath)}
                      </dd>
                    </div>
                    <div class="flex min-w-0 items-center justify-between gap-3">
                      <dt class="shrink-0">Folder</dt>
                      <dd class="flex min-w-0 items-center gap-1 truncate">
                        <FolderOpen size={10} class="shrink-0" aria-hidden="true" />
                        <span class="truncate">{note.folderPath || '/'}</span>
                      </dd>
                    </div>
                  </dl>
                  <button
                    type="button"
                    class="mt-3 flex w-full items-center justify-center gap-1.5 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-1)] px-3 py-2 text-[10px] font-medium text-[var(--color-text-primary)] transition-colors hover:border-[var(--color-border-bright)] hover:bg-[var(--color-surface-3)] disabled:opacity-50"
                    disabled={loading}
                    aria-label={`Restore ${note.title || 'Untitled'} from Trash`}
                    onclick={() => onRestoreTrash(note)}
                  >
                    <RotateCcw size={12} aria-hidden="true" />
                    Restore to active vault
                  </button>
                </article>
              {/each}
            </div>
          {/if}
        </div>
      {/if}
    </div>
  </div>
{/if}

<style>
  .notes-recovery-overlay {
    background: color-mix(in srgb, var(--color-surface-0) 78%, transparent);
  }
</style>
