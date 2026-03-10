<script lang="ts">
  import { onMount } from 'svelte';
  import { sessionStore } from '$lib/stores/sessions.svelte';
  import { wsStore } from '$lib/stores/websocket.svelte';
  import { toastStore } from '$lib/stores/toast.svelte';
  import { Plus, Search, Pencil, Trash2, Check, X, MessageSquare, LoaderCircle } from 'lucide-svelte';
  import AnimatedStatusIcon from './AnimatedStatusIcon.svelte';
  import ConfirmDialog from './ConfirmDialog.svelte';

  interface Props {
    currentSessionId?: string;
  }

  let { currentSessionId = $bindable('') }: Props = $props();

  let editingId = $state<string>('');
  let editTitle = $state<string>('');
  let editError = $state<boolean>(false);
  let confirmDeleteId = $state<string>('');
  let showConfirmDialog = $state<boolean>(false);
  let sessionToDeleteId = $state<string>('');
  let creating = $state(false);
  // Track which session we last loaded feed for, so we load when active changes (e.g. new session from +)
  let lastLoadedSessionId = $state<string>('');

  onMount(() => {
    sessionStore.fetchSessions();
  });

  // Whenever the store's active session changes, sync and load its feed (including when + creates a new session)
  $effect(() => {
    const activeId = sessionStore.activeSessionId;
    if (!activeId) {
      // Clear feed when no active session (e.g., all sessions deleted)
      wsStore.clearFeed();
      lastLoadedSessionId = '';
      return;
    }
    if (activeId !== currentSessionId) currentSessionId = activeId;
    if (activeId === lastLoadedSessionId) return;
    lastLoadedSessionId = activeId;
    void loadHistory(activeId);
  });

  async function handleCreateSession() {
    creating = true;
    try { await sessionStore.createSession(); } finally { creating = false; }
  }

  async function loadHistory(id: string) {
    const messages = await sessionStore.fetchMessages(id);
    wsStore.loadSessionMessages(id, messages);
  }

  async function selectSession(id: string) {
    if (sessionStore.activeSessionId === id) return;
    lastLoadedSessionId = id;
    sessionStore.activeSessionId = id;
    wsStore.subscribeToSession(id);
    await loadHistory(id);
  }

  function startRename(id: string, currentTitle: string) {
    editingId = id;
    editTitle = currentTitle;
  }

  function saveRename(id: string) {
    if (editTitle.trim()) {
      sessionStore.renameSession(id, editTitle.trim());
      editError = false;
    } else {
      editError = true;
      return;
    }
    editingId = '';
  }

  function cancelRename() {
    editingId = '';
    editTitle = '';
    editError = false;
  }

  function confirmDelete(e: MouseEvent, id: string) {
    e.stopPropagation();
    
    // Shift-click bypasses all confirmation
    if (e.shiftKey) {
      sessionStore.deleteSession(id);
      return;
    }

    const isRunning = wsStore.isSessionRunning(id);
    
    if (isRunning) {
      sessionToDeleteId = id;
      showConfirmDialog = true;
      return;
    }

    // Standard double-click for idle sessions
    if (confirmDeleteId === id) {
      sessionStore.deleteSession(id);
      confirmDeleteId = '';
    } else {
      confirmDeleteId = id;
      setTimeout(() => { if (confirmDeleteId === id) confirmDeleteId = ''; }, 3000);
    }
  }

  function handleConfirmDelete() {
    if (sessionToDeleteId) {
      sessionStore.deleteSession(sessionToDeleteId);
      sessionToDeleteId = '';
    }
    showConfirmDialog = false;
  }

  function handleCancelDelete() {
    sessionToDeleteId = '';
    showConfirmDialog = false;
  }

  function formatTime(ts: number): string {
    const d = new Date(ts);
    const now = new Date();
    if (d.toDateString() === now.toDateString()) {
      return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    }
    return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
  }
</script>

<div class="h-full flex flex-col" style="background: var(--color-surface-1);">
  <!-- Header -->
  <div class="flex items-center justify-between px-3 py-3 border-b" style="border-color: var(--color-border);">
    <span class="text-sm font-semibold leading-none" style="color: var(--color-text-primary);">Sessions</span>
    <button
      class="p-1.5 rounded-lg transition-colors hover:bg-[var(--color-surface-3)] flex items-center justify-center"
      style="color: var(--color-text-secondary);"
      disabled={creating}
      onclick={handleCreateSession}
      title="New session (Ctrl+N)"
      aria-label="New session"
    >
      {#if creating}
        <LoaderCircle size={16} class="animate-spin" />
      {:else}
        <Plus size={16} />
      {/if}
    </button>
  </div>

  <!-- Search -->
  <div class="px-3 py-2">
    <div class="relative flex items-center">
      <Search size={14} class="absolute left-2.5 top-1/2 -translate-y-1/2 pointer-events-none" style="color: var(--color-text-muted);" />
      <input
        type="text"
        placeholder="Search sessions..."
        class="input text-xs h-8 w-full"
        style="padding-left: 32px;"
        bind:value={sessionStore.searchQuery}
      />
    </div>
  </div>

  <!-- Session List -->
  <div class="flex-1 overflow-y-auto px-1.5">
    {#each sessionStore.groupedSessions as group (group.label)}
      <div class="mb-1">
        <div class="px-2 py-1.5 text-[10px] font-medium uppercase tracking-wider" style="color: var(--color-text-muted);">
          {group.label}
        </div>
        {#each group.sessions as session (session.id)}
          <div
            role="button"
            tabindex="0"
            class="session-item group flex items-center gap-2.5 px-2.5 py-2.5 mx-1 rounded-lg cursor-pointer transition-colors {sessionStore.activeSessionId === session.id ? 'active-session' : 'hover:bg-[var(--color-surface-2)]'}"
            onclick={() => selectSession(session.id)}
            onkeydown={(e) => { if (e.key === 'Enter') selectSession(session.id); }}
            ondblclick={() => startRename(session.id, session.title)}
          >
            {#if editingId === session.id}
              <div class="flex-1 flex flex-col gap-0.5">
                <div class="flex items-center gap-1">
                  <input
                    type="text"
                    class="input text-xs h-6 flex-1 {editError ? 'border-red-500' : ''}"
                    bind:value={editTitle}
                    maxlength={80}
                    oninput={() => { if (editTitle.trim()) editError = false; }}
                    onkeydown={(e) => {
                      if (e.key === 'Enter') saveRename(session.id);
                      if (e.key === 'Escape') cancelRename();
                    }}
                  />
                  <button class="p-0.5 rounded" style="color: var(--color-success);" onclick={(e) => { e.stopPropagation(); saveRename(session.id); }} aria-label="Save rename">
                    <Check size={12} />
                  </button>
                  <button class="p-0.5 rounded" style="color: var(--color-text-muted);" onclick={(e) => { e.stopPropagation(); cancelRename(); }} aria-label="Cancel rename">
                    <X size={12} />
                  </button>
                </div>
                {#if editError}
                  <span class="text-[10px] text-red-400 px-0.5">Name cannot be empty</span>
                {:else}
                  <span class="text-[10px] px-0.5" style="color: var(--color-text-muted);">{editTitle.length}/80</span>
                {/if}
              </div>
            {:else}
              {#if sessionStore.activeSessionId === session.id && wsStore.managerStatus !== 'idle'}
                <div class="shrink-0 flex items-center justify-center" style="width: 16px; height: 16px;">
                  <AnimatedStatusIcon status={wsStore.managerStatus} size={14} isManager={true} phase={wsStore.koryPhase} />
                </div>
              {:else}
                <MessageSquare size={14} class="shrink-0 relative top-[-2px]" style="color: var(--color-text-muted);" />
              {/if}
              <div class="flex-1 min-w-0">
                <div class="text-xs truncate" style="color: var(--color-text-primary);">{session.title}</div>
                <div class="flex items-center gap-2" style="margin-top: var(--space-1);">
                  <span style="font-size: var(--text-xs); color: var(--color-text-muted);">{formatTime(session.updatedAt)}</span>
                  {#if session.messageCount > 0}
                    <span style="font-size: var(--text-xs); color: var(--color-text-muted);">{session.messageCount} msgs</span>
                  {/if}
                  {#if session.totalCost > 0}
                    <span style="font-size: var(--text-xs); color: var(--color-text-muted);">${session.totalCost.toFixed(3)}</span>
                  {/if}
                </div>
              </div>
              <div class="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
                <button
                  class="p-1 rounded hover:bg-[var(--color-surface-4)] transition-colors"
                  style="color: var(--color-text-muted);"
                  onclick={(e) => { e.stopPropagation(); startRename(session.id, session.title); }}
                  title="Rename"
                  aria-label="Rename session"
                >
                  <Pencil size={12} />
                </button>
                <button
                  class="p-1 rounded hover:bg-[var(--color-surface-4)] transition-colors"
                  style="color: {confirmDeleteId === session.id ? 'var(--color-error)' : 'var(--color-text-muted)'};"
                  onclick={(e) => confirmDelete(e, session.id)}
                  title={confirmDeleteId === session.id ? 'Click again to confirm' : 'Delete (Shift+Click to skip confirmation)'}
                  aria-label="Delete session"
                >
                  <Trash2 size={12} />
                </button>
              </div>
            {/if}
          </div>
        {/each}
      </div>
    {/each}

    {#if sessionStore.filteredSessions.length === 0}
      <div class="flex flex-col items-center justify-center" style="padding-top: var(--space-8); padding-bottom: var(--space-8); color: var(--color-text-muted);">
        <MessageSquare size={24} class="opacity-40" style="margin-bottom: var(--space-sm);" />
        <p class="text-xs">{sessionStore.searchQuery ? 'No matching sessions' : 'No sessions yet'}</p>
      </div>
    {/if}
  </div>
</div>

<ConfirmDialog
  open={showConfirmDialog}
  title="Delete Active Session?"
  message="This session is currently running. Deleting it will cancel all active workers and their progress. Are you sure you want to continue?"
  confirmLabel="Delete Session"
  cancelLabel="Cancel"
  variant="danger"
  onConfirm={handleConfirmDelete}
  onCancel={handleCancelDelete}
/>
