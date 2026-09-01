<script lang="ts">
  import { onMount, tick } from 'svelte';
  import AlertTriangle from 'lucide-svelte/icons/alert-triangle';
  import Archive from 'lucide-svelte/icons/archive';
  import Check from 'lucide-svelte/icons/check';
  import Clock3 from 'lucide-svelte/icons/clock-3';
  import FolderOpen from 'lucide-svelte/icons/folder-open';
  import LoaderCircle from 'lucide-svelte/icons/loader-circle';
  import MessageSquare from 'lucide-svelte/icons/message-square';
  import Pencil from 'lucide-svelte/icons/pencil';
  import RefreshCw from 'lucide-svelte/icons/refresh-cw';
  import RotateCcw from 'lucide-svelte/icons/rotate-ccw';
  import Search from 'lucide-svelte/icons/search';
  import Trash2 from 'lucide-svelte/icons/trash-2';
  import X from 'lucide-svelte/icons/x';
  import { projectDisplayName } from '$lib/stores/project.svelte';
  import { sessionStore, type LifecycleSession } from '$lib/stores/sessions.svelte';
  import ConfirmDialog from './ConfirmDialog.svelte';
  import SettingsPageIntro from './SettingsPageIntro.svelte';

  type PendingAction = 'restore' | 'rename' | 'delete';

  let query = $state('');
  let editingId = $state('');
  let editTitle = $state('');
  let editError = $state('');
  let renameInput = $state<HTMLInputElement>();
  let deleteTarget = $state<LifecycleSession | null>(null);
  let pending = $state<Record<string, PendingAction | undefined>>({});

  let normalizedQuery = $derived(query.trim().toLocaleLowerCase());
  let filteredChats = $derived(
    normalizedQuery
      ? sessionStore.archivedSessions.filter((session) =>
          [session.title, session.workingDirectory, projectName(session)]
            .filter(Boolean)
            .some((value) => value!.toLocaleLowerCase().includes(normalizedQuery)),
        )
      : sessionStore.archivedSessions,
  );

  onMount(() => {
    void sessionStore.fetchArchivedSessions();
  });

  function projectName(session: LifecycleSession): string {
    return session.workingDirectory
      ? projectDisplayName(session.workingDirectory)
      : 'Workspace-level chat';
  }

  function formatTimestamp(timestamp: number | null | undefined): string {
    if (typeof timestamp !== 'number' || !Number.isFinite(timestamp)) return 'Unavailable';
    return new Intl.DateTimeFormat(undefined, {
      dateStyle: 'medium',
      timeStyle: 'short',
    }).format(new Date(timestamp));
  }

  function setPending(id: string, action: PendingAction | undefined): void {
    pending = { ...pending, [id]: action };
  }

  function beginRename(session: LifecycleSession): void {
    editingId = session.id;
    editTitle = session.title;
    editError = '';
    void tick().then(() => {
      renameInput?.focus();
      renameInput?.select();
    });
  }

  function cancelRename(): void {
    editingId = '';
    editTitle = '';
    editError = '';
  }

  async function saveRename(session: LifecycleSession): Promise<void> {
    const nextTitle = editTitle.trim();
    if (!nextTitle) {
      editError = 'Chat name cannot be empty.';
      return;
    }
    if (nextTitle.length > 80) {
      editError = 'Chat names can be at most 80 characters.';
      return;
    }
    if (nextTitle === session.title) {
      cancelRename();
      return;
    }

    setPending(session.id, 'rename');
    const renamed = await sessionStore.renameSession(session.id, nextTitle);
    setPending(session.id, undefined);
    if (renamed) cancelRename();
    else editError = 'The chat could not be renamed. Try again.';
  }

  async function restoreChat(session: LifecycleSession): Promise<void> {
    if (pending[session.id]) return;
    if (editingId === session.id) cancelRename();
    setPending(session.id, 'restore');
    await sessionStore.restoreSession(session.id);
    setPending(session.id, undefined);
  }

  async function permanentlyDeleteChat(): Promise<void> {
    const target = deleteTarget;
    deleteTarget = null;
    if (!target || pending[target.id]) return;
    if (editingId === target.id) cancelRename();
    setPending(target.id, 'delete');
    await sessionStore.deleteSession(target.id);
    setPending(target.id, undefined);
  }
</script>

<div class="flex h-full min-h-0 flex-col overflow-hidden">
  <SettingsPageIntro
    title="Archived chats"
    description="Chats removed from the sidebar stay here until you restore or permanently delete them."
  >
    <span
      class="inline-flex min-h-9 items-center rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-2)] px-3 text-xs font-medium text-[var(--color-text-secondary)]"
      aria-live="polite"
    >
      {sessionStore.archivedSessions.length}
      {sessionStore.archivedSessions.length === 1 ? 'chat' : 'chats'}
    </span>
    <button
      type="button"
      class="inline-flex min-h-9 items-center gap-1.5 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-2)] px-3 text-xs font-medium text-[var(--color-text-secondary)] transition-colors hover:border-[var(--color-accent)]/50 hover:text-[var(--color-text-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)]/60 disabled:opacity-50"
      disabled={sessionStore.archivedLoading}
      onclick={() => void sessionStore.fetchArchivedSessions()}
      aria-label="Refresh archived chats"
    >
      <RefreshCw size={13} class={sessionStore.archivedLoading ? 'animate-spin' : ''} />
      Refresh
    </button>
  </SettingsPageIntro>

  <div class="min-h-0 flex-1 overflow-y-auto p-4 sm:p-6">
    <div class="mx-auto max-w-5xl space-y-4">
      <div class="relative">
        <label for="archived-chat-search" class="sr-only">Search archived chats</label>
        <Search
          size={14}
          class="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-[var(--color-text-muted)]"
        />
        <input
          id="archived-chat-search"
          type="text"
          role="searchbox"
          bind:value={query}
          placeholder="Search archived chats or projects"
          class="h-10 w-full rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-1)] pl-9 pr-9 text-sm text-[var(--color-text-primary)] outline-none placeholder:text-[var(--color-text-muted)] hover:border-[var(--color-border-bright)] focus-visible:border-[var(--color-accent)] focus-visible:ring-2 focus-visible:ring-[var(--color-accent)]/35"
        />
        {#if query}
          <button
            type="button"
            class="absolute right-1.5 top-1/2 flex h-7 w-7 -translate-y-1/2 items-center justify-center rounded-lg text-[var(--color-text-muted)] hover:bg-[var(--color-surface-3)] hover:text-[var(--color-text-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)]/60"
            onclick={() => (query = '')}
            aria-label="Clear archived chat search"
          >
            <X size={13} />
          </button>
        {/if}
      </div>

      {#if sessionStore.archivedError}
        <section
          role="alert"
          class="flex flex-col gap-4 rounded-2xl border border-[var(--color-error)] bg-[var(--color-error-bg)] p-4 sm:flex-row sm:items-center"
        >
          <AlertTriangle size={18} class="shrink-0 text-[var(--color-error)]" />
          <div class="min-w-0 flex-1">
            <h4 class="text-sm font-semibold text-[var(--color-text-primary)]">
              {sessionStore.archivedSessions.length === 0
                ? 'Archived chats unavailable'
                : 'Could not refresh archived chats'}
            </h4>
            <p class="mt-1 text-xs leading-relaxed text-[var(--color-text-muted)]">
              {sessionStore.archivedError}{sessionStore.archivedSessions.length > 0
                ? ' The last loaded results are still shown below.'
                : ''}
            </p>
          </div>
          <button
            type="button"
            disabled={sessionStore.archivedLoading}
            onclick={() => void sessionStore.fetchArchivedSessions()}
            class="inline-flex min-h-10 shrink-0 items-center justify-center gap-2 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-1)] px-4 text-xs font-semibold text-[var(--color-text-secondary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)]/60 disabled:opacity-50"
          >
            <RefreshCw size={14} /> Retry
          </button>
        </section>
      {/if}

      {#if sessionStore.archivedLoading && sessionStore.archivedSessions.length === 0}
        <section
          role="status"
          class="flex min-h-44 items-center justify-center gap-2 rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface-1)] text-sm text-[var(--color-text-muted)]"
        >
          <LoaderCircle size={16} class="animate-spin" /> Loading archived chats…
        </section>
      {:else if sessionStore.archivedSessions.length === 0}
        {#if !sessionStore.archivedError}
          <section
            class="rounded-2xl border border-dashed border-[var(--color-border)] bg-[var(--color-surface-1)] px-5 py-12 text-center"
          >
            <Archive size={30} class="mx-auto text-[var(--color-text-muted)]" />
            <h4 class="mt-3 text-sm font-semibold text-[var(--color-text-primary)]">
              No archived chats
            </h4>
            <p class="mx-auto mt-1 max-w-md text-xs leading-relaxed text-[var(--color-text-muted)]">
              Use the archive button between Rename and Delete on a chat in the sidebar. Its history
              stays intact and can be restored here.
            </p>
          </section>
        {/if}
      {:else if filteredChats.length === 0}
        <section
          class="rounded-2xl border border-dashed border-[var(--color-border)] bg-[var(--color-surface-1)] px-5 py-10 text-center"
        >
          <Search size={26} class="mx-auto text-[var(--color-text-muted)]" />
          <h4 class="mt-3 text-sm font-semibold text-[var(--color-text-primary)]">
            No archived chats match “{query.trim()}”
          </h4>
          <button
            type="button"
            class="mt-3 min-h-9 rounded-xl px-3 text-xs font-medium text-[var(--color-accent)] hover:bg-[var(--color-surface-2)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)]/60"
            onclick={() => (query = '')}>Clear search</button
          >
        </section>
      {:else}
        <section
          aria-label="Archived chat list"
          class="divide-y divide-[var(--color-border)] overflow-hidden rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface-1)]"
        >
          {#each filteredChats as session (session.id)}
            <article class="p-4 sm:p-5" aria-labelledby={`archived-chat-${session.id}`}>
              <div class="flex flex-col gap-4 lg:flex-row lg:items-center">
                <div class="min-w-0 flex-1">
                  {#if editingId === session.id}
                    <div class="max-w-xl">
                      <label for={`archived-chat-title-${session.id}`} class="sr-only">
                        Rename {session.title}
                      </label>
                      <div class="flex items-center gap-2">
                        <input
                          bind:this={renameInput}
                          id={`archived-chat-title-${session.id}`}
                          type="text"
                          bind:value={editTitle}
                          maxlength={80}
                          aria-invalid={editError ? 'true' : undefined}
                          aria-describedby={`archived-chat-title-help-${session.id}`}
                          class="h-10 min-w-0 flex-1 rounded-xl border bg-[var(--color-surface-0)] px-3 text-sm text-[var(--color-text-primary)] outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)]/35 {editError
                            ? 'border-[var(--color-error)]'
                            : 'border-[var(--color-border)] focus-visible:border-[var(--color-accent)]'}"
                          oninput={() => {
                            if (editTitle.trim()) editError = '';
                          }}
                          onkeydown={(event) => {
                            if (event.key === 'Enter') void saveRename(session);
                            if (event.key === 'Escape') cancelRename();
                          }}
                        />
                        <button
                          type="button"
                          disabled={pending[session.id] === 'rename'}
                          onclick={() => void saveRename(session)}
                          class="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-[var(--color-accent)] text-[var(--color-surface-0)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)]/60 disabled:opacity-50"
                          aria-label={`Save renamed chat ${session.title}`}
                        >
                          {#if pending[session.id] === 'rename'}<LoaderCircle
                              size={15}
                              class="animate-spin"
                            />{:else}<Check size={15} />{/if}
                        </button>
                        <button
                          type="button"
                          onclick={cancelRename}
                          class="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-[var(--color-border)] text-[var(--color-text-muted)] hover:bg-[var(--color-surface-3)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)]/60"
                          aria-label="Cancel rename"
                        >
                          <X size={15} />
                        </button>
                      </div>
                      <div
                        id={`archived-chat-title-help-${session.id}`}
                        class="mt-1.5 flex items-center justify-between gap-3 text-[10px]"
                      >
                        <span
                          class={editError
                            ? 'text-[var(--color-error)]'
                            : 'text-[var(--color-text-muted)]'}
                        >
                          {editError || 'Press Enter to save or Escape to cancel.'}
                        </span>
                        <span class="shrink-0 text-[var(--color-text-muted)]"
                          >{editTitle.length}/80</span
                        >
                      </div>
                    </div>
                  {:else}
                    <h4
                      id={`archived-chat-${session.id}`}
                      class="truncate text-sm font-semibold text-[var(--color-text-primary)]"
                    >
                      {session.title}
                    </h4>
                    <div
                      class="mt-2 flex flex-wrap items-center gap-x-4 gap-y-2 text-[10px] text-[var(--color-text-muted)]"
                    >
                      <span
                        class="inline-flex min-w-0 items-center gap-1.5"
                        title={session.workingDirectory ?? 'Workspace-level chat'}
                      >
                        <FolderOpen size={12} class="shrink-0" />
                        <span class="max-w-56 truncate">{projectName(session)}</span>
                      </span>
                      <span
                        class="inline-flex items-center gap-1.5"
                        title={formatTimestamp(session.updatedAt)}
                      >
                        <Clock3 size={12} /> Updated {formatTimestamp(session.updatedAt)}
                      </span>
                      <span
                        class="inline-flex items-center gap-1.5"
                        title={formatTimestamp(session.archivedAt)}
                      >
                        <Archive size={12} /> Archived {formatTimestamp(session.archivedAt)}
                      </span>
                      <span class="inline-flex items-center gap-1.5">
                        <MessageSquare size={12} />
                        {session.messageCount}
                        {session.messageCount === 1 ? 'message' : 'messages'}
                      </span>
                    </div>
                  {/if}
                </div>

                <div
                  class="flex shrink-0 flex-wrap items-center gap-2"
                  aria-label={`Actions for ${session.title}`}
                >
                  <button
                    type="button"
                    disabled={Boolean(pending[session.id])}
                    onclick={() => void restoreChat(session)}
                    class="inline-flex min-h-10 items-center justify-center gap-2 rounded-xl border border-[var(--color-accent)]/45 bg-[var(--color-accent)]/10 px-3 text-xs font-semibold text-[var(--color-accent)] transition-colors hover:bg-[var(--color-accent)]/15 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)]/60 disabled:opacity-50"
                    aria-label={`Restore ${session.title}`}
                  >
                    {#if pending[session.id] === 'restore'}<LoaderCircle
                        size={14}
                        class="animate-spin"
                      />{:else}<RotateCcw size={14} />{/if}
                    Restore
                  </button>
                  <button
                    type="button"
                    disabled={Boolean(pending[session.id]) || editingId === session.id}
                    onclick={() => beginRename(session)}
                    class="inline-flex min-h-10 items-center justify-center gap-2 rounded-xl border border-[var(--color-border)] px-3 text-xs font-medium text-[var(--color-text-secondary)] transition-colors hover:bg-[var(--color-surface-3)] hover:text-[var(--color-text-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)]/60 disabled:opacity-50"
                    aria-label={`Rename ${session.title}`}
                  >
                    <Pencil size={14} /> Rename
                  </button>
                  <button
                    type="button"
                    disabled={Boolean(pending[session.id])}
                    onclick={() => (deleteTarget = session)}
                    class="inline-flex min-h-10 items-center justify-center gap-2 rounded-xl border border-[var(--color-error)]/35 bg-[var(--color-error-bg)] px-3 text-xs font-medium text-[var(--color-error)] transition-opacity hover:opacity-85 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-error)]/60 disabled:opacity-50"
                    aria-label={`Delete ${session.title} permanently`}
                  >
                    {#if pending[session.id] === 'delete'}<LoaderCircle
                        size={14}
                        class="animate-spin"
                      />{:else}<Trash2 size={14} />{/if}
                    Delete
                  </button>
                </div>
              </div>
            </article>
          {/each}
        </section>
      {/if}
    </div>
  </div>
</div>

<ConfirmDialog
  open={Boolean(deleteTarget)}
  title="Permanently delete archived chat?"
  message={deleteTarget
    ? `“${deleteTarget.title}” and its complete history will be permanently deleted. This cannot be undone.`
    : ''}
  confirmLabel="Delete permanently"
  cancelLabel="Cancel"
  variant="danger"
  onConfirm={() => void permanentlyDeleteChat()}
  onCancel={() => (deleteTarget = null)}
/>
