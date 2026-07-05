<script lang="ts">
  import { untrack } from 'svelte';
  import { sessionStore } from '$lib/stores/sessions.svelte';
  import { wsStore } from '$lib/stores/websocket.svelte';
  import { toastStore } from '$lib/stores/toast.svelte';
  import { projectStore, projectDisplayName } from '$lib/stores/project.svelte';
  import { collaborationStore } from '$lib/stores/collaboration.svelte';
  import { Plus, Search, Pencil, Trash2, Check, X, MessageSquare, LoaderCircle, FolderOpen, Users, LogOut, UserPlus } from 'lucide-svelte';
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

  $effect(() => {
    // Keep currentSessionId in sync if needed by other parts of the sidebar
    if (sessionStore.activeSessionId && sessionStore.activeSessionId !== currentSessionId) {
      currentSessionId = sessionStore.activeSessionId;
    }
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
    collaborationStore.closeJoinedSession();
    if (sessionStore.activeSessionId === id) return;
    sessionStore.activeSessionId = id;
    // Note: loadHistory is now handled globally in +page.svelte based on activeSessionId changes
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
    // Deleting a row that's mid-rename must not leave the editor open.
    if (editingId === id) cancelRename();

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
  <div class="flex items-start justify-between px-4 py-4 border-b" style="border-color: var(--color-border);">
    <div class="min-w-0">
      <div class="text-sm font-semibold leading-none" style="color: var(--color-text-primary);">Sessions</div>
      <div class="mt-1 text-xs" style="color: var(--color-text-muted);">Recent workspaces and agent runs</div>
    </div>
    <button
      type="button"
      class="p-2 rounded-lg transition-colors hover:bg-[var(--color-surface-3)] flex items-center justify-center"
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

  <!-- Project scope -->
  {#if projectStore.currentPath}
    <div class="px-4 pt-3 flex items-center gap-2">
      <span
        class="flex items-center gap-1.5 min-w-0 text-xs font-medium"
        style="color: var(--color-text-secondary);"
        title={projectStore.currentPath}
      >
        <FolderOpen size={13} class="shrink-0" style="color: var(--color-accent);" />
        <span class="truncate">{projectStore.displayName}</span>
      </span>
      <div class="ml-auto flex rounded-lg overflow-hidden border" style="border-color: var(--color-border);">
        <button
          type="button"
          class="px-2 py-1 text-xs transition-colors"
          style="background: {projectStore.scope === 'project' ? 'var(--color-surface-3)' : 'transparent'}; color: {projectStore.scope === 'project' ? 'var(--color-text-primary)' : 'var(--color-text-muted)'};"
          onclick={() => projectStore.setScope('project')}
          title="Only chats from this project"
        >
          Project
        </button>
        <button
          type="button"
          class="px-2 py-1 text-xs transition-colors"
          style="background: {projectStore.scope === 'all' ? 'var(--color-surface-3)' : 'transparent'}; color: {projectStore.scope === 'all' ? 'var(--color-text-primary)' : 'var(--color-text-muted)'};"
          onclick={() => projectStore.setScope('all')}
          title="Chats from all projects"
        >
          All
        </button>
      </div>
    </div>
  {/if}

  <!-- Search -->
  <div class="px-4 py-3">
    <div class="relative flex items-center">
      <Search size={14} class="absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" style="color: var(--color-text-muted);" />
      <input
        type="text"
        placeholder="Search sessions..."
        class="input text-sm h-9 w-full"
        style="padding-left: 36px;"
        bind:value={sessionStore.searchQuery}
      />
    </div>
  </div>

  <!-- Session List -->
  <div class="flex-1 overflow-y-auto px-2 pb-3">
    <button type="button" onclick={() => window.dispatchEvent(new CustomEvent('open-team-settings'))} class="mx-1 mb-2 flex items-center gap-3 rounded-xl border border-dashed px-3 py-2.5 text-left transition-colors hover:bg-[var(--color-surface-2)]" style="width:calc(100% - 0.5rem);border-color:var(--color-border);color:var(--color-text-secondary)"><span class="flex h-[22px] w-[22px] items-center justify-center rounded-lg" style="background:var(--color-surface-3);color:var(--color-accent)"><UserPlus size={12}/></span><span class="text-xs font-medium">Join or host a team workspace</span></button>
    {#if collaborationStore.joinedSessions.length > 0}
      <div class="mb-3">
        <div class="flex items-center justify-between px-3 py-2"><span class="text-xs font-semibold uppercase tracking-[0.14em]" style="color:var(--color-text-muted)">Team workspaces</span><span class="rounded-full px-2 py-0.5 text-[9px]" style="background:var(--color-surface-3);color:var(--color-text-muted)">{collaborationStore.joinedSessions.length}</span></div>
        {#each collaborationStore.joinedSessions as team (team.sessionId)}
          <div role="button" tabindex="0" onclick={() => collaborationStore.openJoinedSession(team.sessionId)} onkeydown={(e) => { if(e.key==='Enter') collaborationStore.openJoinedSession(team.sessionId); }} class="group mx-1 flex cursor-pointer items-center gap-3 rounded-xl border px-3 py-3 transition-colors {collaborationStore.activeJoinedSession?.sessionId === team.sessionId ? 'border-[var(--color-accent)]/40 bg-[var(--color-accent)]/10' : 'border-transparent hover:border-[var(--color-border)] hover:bg-[var(--color-surface-2)]'}">
            <div class="flex h-[22px] w-[22px] shrink-0 items-center justify-center rounded-lg" style="background:color-mix(in srgb,var(--color-accent) 14%,transparent);color:var(--color-accent)"><Users size={12}/></div>
            <div class="min-w-0 flex-1"><div class="truncate text-sm font-medium" style="color:var(--color-text-primary)">{team.sessionName}</div><div class="mt-1 flex items-center gap-1.5 text-[10px]" style="color:var(--color-text-muted)"><span class="h-1.5 w-1.5 rounded-full bg-emerald-400"></span>{team.tierId} · hosted</div></div>
            <button type="button" onclick={(e) => { e.stopPropagation(); collaborationStore.leaveJoinedSession(team.sessionId); }} class="rounded-lg p-1.5 text-red-400 opacity-0 transition-all hover:bg-red-500/10 group-hover:opacity-100" title="Leave team workspace"><LogOut size={12}/></button>
          </div>
        {/each}
      </div>
      <div class="mx-3 mb-3 border-t" style="border-color:var(--color-border)"></div>
    {/if}
    <div class="px-3 py-2 text-xs font-semibold uppercase tracking-[0.14em]" style="color:var(--color-text-muted)">Personal sessions</div>
    {#each sessionStore.groupedSessions as group (group.label)}
      <div class="mb-2">
        <div class="px-3 py-2 text-xs font-semibold uppercase tracking-[0.14em]" style="color: var(--color-text-muted);">
          {group.label}
        </div>
        {#each group.sessions as session (session.id)}
          <div
            role="button"
            tabindex="0"
            class="session-item group flex items-center gap-3 px-3 py-3 mx-1 rounded-xl cursor-pointer transition-colors border border-transparent {sessionStore.activeSessionId === session.id && !collaborationStore.activeJoinedSession ? 'active-session' : 'hover:bg-[var(--color-surface-2)] hover:border-[var(--color-border)]'}"
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
                    onclick={(e) => e.stopPropagation()}
                    ondblclick={(e) => e.stopPropagation()}
                    onkeydown={(e) => {
                      e.stopPropagation();
                      if (e.key === 'Enter') saveRename(session.id);
                      if (e.key === 'Escape') cancelRename();
                    }}
                  />
                  <button type="button" class="p-0.5 rounded" style="color: var(--color-success);" onclick={(e) => { e.stopPropagation(); saveRename(session.id); }} aria-label="Save rename">
                    <Check size={12} />
                  </button>
                  <button type="button" class="p-0.5 rounded" style="color: var(--color-text-muted);" onclick={(e) => { e.stopPropagation(); cancelRename(); }} aria-label="Cancel rename">
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
                <div class="shrink-0 flex items-center justify-center rounded-lg" style="width: 18px; height: 18px; background: rgba(213, 178, 97, 0.08);">
                  <AnimatedStatusIcon status={wsStore.managerStatus} size={14} isManager={true} phase={wsStore.koryPhase} />
                </div>
              {:else}
                <div class="shrink-0 flex items-center justify-center rounded-lg" style="width: 18px; height: 18px; background: var(--color-surface-3);">
                  <MessageSquare size={12} style="color: var(--color-text-muted);" />
                </div>
              {/if}
              <div class="flex-1 min-w-0">
                <div class="text-sm font-medium truncate" style="color: var(--color-text-primary);">{session.title}</div>
                <div class="flex items-center gap-2.5 flex-wrap" style="margin-top: 6px;">
                  <span style="font-size: var(--text-xs); color: var(--color-text-muted);">{formatTime(session.updatedAt)}</span>
                  {#if projectStore.scope === 'all' && session.workingDirectory}
                    <span
                      class="inline-flex items-center gap-1 px-1.5 rounded truncate"
                      style="font-size: var(--text-xs); max-width: 120px; color: var(--color-accent); background: var(--color-surface-3);"
                      title={session.workingDirectory}
                    >
                      <FolderOpen size={9} class="shrink-0" />{projectDisplayName(session.workingDirectory)}
                    </span>
                  {/if}
                  {#if session.messageCount > 0}
                    <span style="font-size: var(--text-xs); color: var(--color-text-muted);">{session.messageCount} msgs</span>
                  {/if}
                  {#if session.totalCost > 0}
                    <span style="font-size: var(--text-xs); color: var(--color-text-muted);">${session.totalCost.toFixed(3)}</span>
                  {/if}
                </div>
              </div>
              <div class="flex items-center gap-1 transition-opacity {sessionStore.activeSessionId === session.id ? 'opacity-70 group-hover:opacity-100 group-focus-within:opacity-100' : 'opacity-0 group-hover:opacity-100 group-focus-within:opacity-100'}">
                <button
                  type="button"
                  class="p-1.5 rounded-lg hover:bg-[var(--color-surface-4)] transition-colors"
                  style="color: var(--color-text-muted);"
                  onclick={(e) => { e.stopPropagation(); startRename(session.id, session.title); }}
                  ondblclick={(e) => e.stopPropagation()}
                  title="Rename"
                  aria-label="Rename session"
                >
                  <Pencil size={12} />
                </button>
                <button
                  type="button"
                  class="p-1.5 rounded-lg hover:bg-[var(--color-surface-4)] transition-colors"
                  style="color: {confirmDeleteId === session.id ? 'var(--color-error)' : 'var(--color-text-muted)'};"
                  onclick={(e) => confirmDelete(e, session.id)}
                  ondblclick={(e) => e.stopPropagation()}
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
