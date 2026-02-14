<script lang="ts">
  import { onMount } from 'svelte';
  import { sessionStore } from '$lib/stores/sessions.svelte';
  import { Plus, Search, Pencil, Trash2, Check, X, MessageSquare } from 'lucide-svelte';

  interface Props {
    currentSessionId?: string;
  }

  let { currentSessionId = $bindable('') }: Props = $props();

  let editingId = $state<string>('');
  let editTitle = $state<string>('');
  let confirmDeleteId = $state<string>('');

  onMount(() => {
    sessionStore.fetchSessions();
  });

  $effect(() => {
    if (sessionStore.activeSessionId && sessionStore.activeSessionId !== currentSessionId) {
      currentSessionId = sessionStore.activeSessionId;
    }
  });

  $effect(() => {
    if (currentSessionId && currentSessionId !== sessionStore.activeSessionId) {
      sessionStore.activeSessionId = currentSessionId;
    }
  });

  function startRename(id: string, currentTitle: string) {
    editingId = id;
    editTitle = currentTitle;
  }

  function saveRename(id: string) {
    if (editTitle.trim()) {
      sessionStore.renameSession(id, editTitle.trim());
    }
    editingId = '';
  }

  function cancelRename() {
    editingId = '';
    editTitle = '';
  }

  function confirmDelete(id: string) {
    if (confirmDeleteId === id) {
      sessionStore.deleteSession(id);
      confirmDeleteId = '';
    } else {
      confirmDeleteId = id;
      setTimeout(() => { if (confirmDeleteId === id) confirmDeleteId = ''; }, 3000);
    }
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
    <span class="text-sm font-semibold" style="color: var(--color-text-primary);">Sessions</span>
    <button
      class="p-1.5 rounded-lg transition-colors hover:bg-[var(--color-surface-3)]"
      style="color: var(--color-text-secondary);"
      onclick={() => sessionStore.createSession()}
      title="New session (Ctrl+N)"
    >
      <Plus size={16} />
    </button>
  </div>

  <!-- Search -->
  <div class="px-3 py-2">
    <div class="relative">
      <Search size={14} class="absolute left-2.5 top-1/2 -translate-y-1/2 pointer-events-none" style="color: var(--color-text-muted);" />
      <input
        type="text"
        placeholder="Search sessions..."
        class="input pl-8 text-xs h-8"
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
            class="group flex items-center gap-2 px-2 py-2 mx-1 rounded-lg cursor-pointer transition-colors
                   {sessionStore.activeSessionId === session.id ? 'bg-[var(--color-surface-3)]' : 'hover:bg-[var(--color-surface-2)]'}"
            onclick={() => currentSessionId = session.id}
            onkeydown={(e) => { if (e.key === 'Enter') currentSessionId = session.id; }}
            ondblclick={() => startRename(session.id, session.title)}
          >
            {#if editingId === session.id}
              <div class="flex-1 flex items-center gap-1">
                <input
                  type="text"
                  class="input text-xs h-6 flex-1"
                  bind:value={editTitle}
                  onkeydown={(e) => {
                    if (e.key === 'Enter') saveRename(session.id);
                    if (e.key === 'Escape') cancelRename();
                  }}
                />
                <button class="p-0.5 rounded" style="color: var(--color-success);" onclick={(e) => { e.stopPropagation(); saveRename(session.id); }}>
                  <Check size={12} />
                </button>
                <button class="p-0.5 rounded" style="color: var(--color-text-muted);" onclick={(e) => { e.stopPropagation(); cancelRename(); }}>
                  <X size={12} />
                </button>
              </div>
            {:else}
              <MessageSquare size={14} class="shrink-0" style="color: var(--color-text-muted);" />
              <div class="flex-1 min-w-0">
                <div class="text-xs truncate" style="color: var(--color-text-primary);">{session.title}</div>
                <div class="flex items-center gap-2 mt-0.5">
                  <span class="text-[10px]" style="color: var(--color-text-muted);">{formatTime(session.updatedAt)}</span>
                  {#if session.messageCount > 0}
                    <span class="text-[10px]" style="color: var(--color-text-muted);">{session.messageCount} msgs</span>
                  {/if}
                  {#if session.totalCost > 0}
                    <span class="text-[10px]" style="color: var(--color-text-muted);">${session.totalCost.toFixed(3)}</span>
                  {/if}
                </div>
              </div>
              <div class="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
                <button
                  class="p-1 rounded hover:bg-[var(--color-surface-4)] transition-colors"
                  style="color: var(--color-text-muted);"
                  onclick={(e) => { e.stopPropagation(); startRename(session.id, session.title); }}
                  title="Rename"
                >
                  <Pencil size={12} />
                </button>
                <button
                  class="p-1 rounded hover:bg-[var(--color-surface-4)] transition-colors"
                  style="color: {confirmDeleteId === session.id ? 'var(--color-error)' : 'var(--color-text-muted)'};"
                  onclick={(e) => { e.stopPropagation(); confirmDelete(session.id); }}
                  title={confirmDeleteId === session.id ? 'Click again to confirm' : 'Delete'}
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
      <div class="flex flex-col items-center justify-center py-8" style="color: var(--color-text-muted);">
        <MessageSquare size={24} class="mb-2 opacity-40" />
        <p class="text-xs">{sessionStore.searchQuery ? 'No matching sessions' : 'No sessions yet'}</p>
      </div>
    {/if}
  </div>
</div>
