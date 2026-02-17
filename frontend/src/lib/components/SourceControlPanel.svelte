<script lang="ts">
  import { onMount } from 'svelte';
  import { gitStore } from '$lib/stores/git.svelte';
  import { RefreshCw, GitCommit, ArrowUp, ArrowDown, Plus, Minus, Check, Undo, MoreHorizontal, ChevronDown, GitBranch, AlertCircle } from 'lucide-svelte';
  import FileIcon from './icons/FileIcon.svelte';
  import FileDiffModal from './FileDiffModal.svelte';
  import GitConflictDialog from './GitConflictDialog.svelte';

  let message = $state('');
  let showBranchMenu = $state(false);
  let showConflictDialog = $state(false);
  let loading = $derived(gitStore.state.loading);
  let stagedFiles = $derived(gitStore.state.status.filter(f => f.staged));
  let changedFiles = $derived(gitStore.state.status.filter(f => !f.staged));

  let hasConflicts = $derived(gitStore.state.conflicts.length > 0);

  $effect(() => {
    if (hasConflicts) showConflictDialog = true;
  });

  let stats = $derived({
    added: gitStore.state.status.filter(f => f.status === 'added' || f.status === 'untracked').length,
    modified: gitStore.state.status.filter(f => f.status === 'modified' || f.status === 'renamed').length,
    deleted: gitStore.state.status.filter(f => f.status === 'deleted').length,
  });

  let showDiff = $state<{ file: string; staged: boolean } | null>(null);

  onMount(() => {
    gitStore.refreshStatus();
  });

  async function handleCommit() {
    if (!message.trim()) return;
    const success = await gitStore.commit(message);
    if (success) message = '';
  }

  function getStatusIcon(status: string) {
    switch (status) {
      case 'modified': return 'M';
      case 'added': return 'A';
      case 'deleted': return 'D';
      case 'untracked': return 'U';
      case 'renamed': return 'R';
      default: return '?';
    }
  }

  function getStatusColorRaw(status: string) {
    switch (status) {
      case 'modified': return '#fbbf24'; // amber-400
      case 'added': return '#4ade80';    // green-400
      case 'deleted': return '#f87171';  // red-400
      case 'untracked': return '#4ade80'; // green-400
      case 'renamed': return '#60a5fa';  // blue-400
      default: return '#8b8b96';
    }
  }

  function getStatusBg(status: string) {
    return `${getStatusColorRaw(status)}20`; // ~12% opacity
  }

  function stageAll() {
    changedFiles.forEach(f => gitStore.stageFile(f.path));
  }

  function unstageAll() {
    stagedFiles.forEach(f => gitStore.unstageFile(f.path));
  }
</script>

<div class="h-full flex flex-col bg-[var(--color-surface-1)]">
  <!-- Header -->
  <div class="flex items-center justify-between px-3 py-3 border-b border-[var(--color-border)] relative">
    <div class="flex items-center gap-2">
      <GitCommit size={14} class="text-[var(--color-text-secondary)]" />
      <span class="text-sm font-semibold text-[var(--color-text-primary)]">Source Control</span>
      <div class="relative">
        <button
          class="flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded bg-[var(--color-surface-3)] text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)] transition-colors"
          onclick={() => showBranchMenu = !showBranchMenu}
        >
          <GitBranch size={10} />
          {gitStore.state.branch || '...'}
          <ChevronDown size={10} />
        </button>

        {#if showBranchMenu}
          <div class="absolute top-full left-0 mt-1 w-48 bg-[var(--color-surface-2)] border border-[var(--color-border)] rounded-lg shadow-xl z-50 py-1">
            <div class="px-2 py-1 text-[10px] uppercase font-bold text-[var(--color-text-muted)] border-b border-[var(--color-border)] mb-1">Switch Branch</div>
            {#each gitStore.state.branches as branch}
              <button
                class="w-full text-left px-3 py-1.5 text-xs hover:bg-[var(--color-surface-3)] transition-colors {gitStore.state.branch === branch ? 'text-[var(--color-accent)] font-bold' : 'text-[var(--color-text-secondary)]'}"
                onclick={() => { gitStore.checkout(branch); showBranchMenu = false; }}
              >
                {branch}
              </button>
            {/each}
          </div>
        {/if}
      </div>
    </div>
    <div class="flex items-center gap-1">
      <button class="p-1.5 hover:bg-[var(--color-surface-3)] rounded text-[var(--color-text-muted)]" onclick={() => gitStore.refreshStatus()} title="Refresh">
        <RefreshCw size={14} class={loading ? 'animate-spin' : ''} />
      </button>
      <button class="p-1.5 hover:bg-[var(--color-surface-3)] rounded text-[var(--color-text-muted)]" onclick={() => gitStore.pull()} title="Pull (Sync)">
        <ArrowDown size={14} />
      </button>
      <button class="p-1.5 hover:bg-[var(--color-surface-3)] rounded text-[var(--color-text-muted)]" onclick={() => gitStore.push()} title="Push">
        <ArrowUp size={14} />
      </button>
    </div>
  </div>

  <!-- Conflict Indicator -->
  {#if hasConflicts}
    <button
      class="bg-red-500/10 border-b border-red-500/20 px-4 py-2 flex items-center justify-between group"
      onclick={() => showConflictDialog = true}
    >
      <div class="flex items-center gap-2 text-red-500">
        <AlertCircle size={14} />
        <span class="text-[10px] font-bold uppercase tracking-wider">Conflicts Detected</span>
      </div>
      <span class="text-[10px] text-red-400 group-hover:underline">Resolve with Kory →</span>
    </button>
  {/if}

  <!-- Commit Input -->
  <div class="p-3 border-b border-[var(--color-border)]">
    <textarea
      bind:value={message}
      placeholder="Message (Ctrl+Enter to commit)"
      class="input w-full text-xs h-20 resize-none mb-2 bg-[var(--color-surface-2)] font-sans"
      onkeydown={(e) => { if (e.ctrlKey && e.key === 'Enter') handleCommit(); }}
    ></textarea>
    <button
      onclick={handleCommit}
      disabled={!message.trim() || stagedFiles.length === 0}
      class="btn btn-primary w-full text-xs py-1.5 flex items-center justify-center gap-2"
    >
      <Check size={12} /> Commit
    </button>
  </div>

  <!-- Stats Summary -->
  {#if stats.added > 0 || stats.modified > 0 || stats.deleted > 0}
    <div class="flex items-center gap-3 px-4 py-2 border-b border-[var(--color-border)] bg-[var(--color-surface-2)] text-[10px]">
      {#if stats.added > 0}
        <span class="text-green-400 font-medium">{stats.added} added</span>
      {/if}
      {#if stats.modified > 0}
        <span class="text-amber-400 font-medium">{stats.modified} modified</span>
      {/if}
      {#if stats.deleted > 0}
        <span class="text-red-400 font-medium">{stats.deleted} deleted</span>
      {/if}
    </div>
  {/if}

  <!-- Changes List -->
  <div class="flex-1 overflow-y-auto">
    <!-- Staged Changes -->
    {#if stagedFiles.length > 0}
      <div class="px-3 py-1.5 mt-2 text-[10px] font-bold uppercase tracking-wider text-[var(--color-text-muted)] flex items-center justify-between group bg-[var(--color-surface-1)] sticky top-0 z-10">
        <div class="flex items-center gap-1">
          <ArrowUp size={10} />
          <span>Staged Changes ({stagedFiles.length})</span>
        </div>
        <button class="p-1 hover:bg-[var(--color-surface-3)] rounded text-[var(--color-text-primary)]" onclick={unstageAll} title="Unstage All">
          <Minus size={12} />
        </button>
      </div>
      {#each stagedFiles as file}
        <div
          class="flex items-center gap-2 px-3 py-1.5 hover:bg-[var(--color-surface-2)] group text-xs cursor-pointer"
          onclick={() => showDiff = { file: file.path, staged: true }}
        >
          <FileIcon path={file.path} size={14} />
          <div class="flex-1 min-w-0 flex items-center gap-2">
            <span class="truncate text-[var(--color-text-secondary)]">{file.path}</span>
            <div class="flex items-center gap-1 shrink-0 ml-auto mr-1">
              {#if file.additions}
                <span class="text-green-500 font-medium">+{file.additions}</span>
              {/if}
              {#if file.deletions}
                <span class="text-red-500 font-medium">-{file.deletions}</span>
              {/if}
            </div>
          </div>
          <div
            class="w-4 h-4 rounded-full flex items-center justify-center font-bold text-[9px] shrink-0"
            style="background: {getStatusBg(file.status)}; color: {getStatusColorRaw(file.status)};"
          >
            {getStatusIcon(file.status)}
          </div>
          <div class="flex items-center opacity-0 group-hover:opacity-100">
            <button class="p-1 text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)] rounded hover:bg-[var(--color-surface-3)]" onclick={(e) => { e.stopPropagation(); gitStore.unstageFile(file.path); }} title="Unstage">
              <Minus size={12} />
            </button>
          </div>
        </div>
      {/each}
    {/if}

    <!-- Changes -->
    <div class="px-3 py-1.5 mt-2 text-[10px] font-bold uppercase tracking-wider text-[var(--color-text-muted)] flex items-center justify-between group bg-[var(--color-surface-1)] sticky top-0 z-10">
      <div class="flex items-center gap-1">
        <ArrowDown size={10} />
        <span>Changes ({changedFiles.length})</span>
      </div>
      <button class="p-1 hover:bg-[var(--color-surface-3)] rounded text-[var(--color-text-primary)]" onclick={stageAll} title="Stage All">
        <Plus size={12} />
      </button>
    </div>
    {#if changedFiles.length === 0 && stagedFiles.length === 0}
      <div class="p-8 text-center flex flex-col items-center justify-center text-[var(--color-text-muted)] opacity-50">
        <Check size={32} class="mb-2" />
        <span class="text-xs">No pending changes</span>
      </div>
    {/if}
    {#each changedFiles as file}
      <div
        class="flex items-center gap-2 px-3 py-1.5 hover:bg-[var(--color-surface-2)] group text-xs cursor-pointer"
        onclick={() => showDiff = { file: file.path, staged: false }}
      >
        <FileIcon path={file.path} size={14} />
        <div class="flex-1 min-w-0 flex items-center gap-2">
          <span class="truncate text-[var(--color-text-secondary)]">{file.path}</span>
          <div class="flex items-center gap-1 shrink-0 ml-auto mr-1">
            {#if file.additions}
              <span class="text-green-500 font-medium">+{file.additions}</span>
            {/if}
            {#if file.deletions}
              <span class="text-red-500 font-medium">-{file.deletions}</span>
            {/if}
          </div>
        </div>
        <div
          class="w-4 h-4 rounded-full flex items-center justify-center font-bold text-[9px] shrink-0"
          style="background: {getStatusBg(file.status)}; color: {getStatusColorRaw(file.status)};"
        >
          {getStatusIcon(file.status)}
        </div>
        <div class="flex items-center gap-1 opacity-0 group-hover:opacity-100">
          <button class="p-1 text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)] rounded hover:bg-[var(--color-surface-3)]" onclick={(e) => { e.stopPropagation(); gitStore.discardChanges(file.path); }} title="Discard Changes">
            <Undo size={12} />
          </button>
          <button class="p-1 text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)] rounded hover:bg-[var(--color-surface-3)]" onclick={(e) => { e.stopPropagation(); gitStore.stageFile(file.path); }} title="Stage">
            <Plus size={12} />
          </button>
        </div>
      </div>
    {/each}
  </div>
</div>

{#if showDiff}
  <FileDiffModal
    file={showDiff.file}
    staged={showDiff.staged}
    onClose={() => showDiff = null}
  />
{/if}

{#if showConflictDialog && gitStore.state.conflicts.length > 0}
  <GitConflictDialog
    conflicts={gitStore.state.conflicts}
    onClose={() => showConflictDialog = false}
  />
{/if}
