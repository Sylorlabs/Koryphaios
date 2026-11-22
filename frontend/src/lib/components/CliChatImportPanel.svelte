<script lang="ts">
  import { onMount, untrack } from 'svelte';
  import { slide } from 'svelte/transition';
  import ProviderIcon from './icons/ProviderIcon.svelte';
  import {
    cliChatImportStore,
    type DiscoveredCliChat,
    type DiscoveredCliProjectGroup,
  } from '$lib/stores/cli-chat-import.svelte';
  import { sessionStore } from '$lib/stores/sessions.svelte';
  import { toastStore } from '$lib/stores/toast.svelte';
  import ChevronRight from 'lucide-svelte/icons/chevron-right';
  import FolderGit2 from 'lucide-svelte/icons/folder-git-2';
  import Search from 'lucide-svelte/icons/search';
  import RefreshCw from 'lucide-svelte/icons/refresh-cw';
  import Check from 'lucide-svelte/icons/check';
  import Download from 'lucide-svelte/icons/download';
  import Layers from 'lucide-svelte/icons/layers';
  import FolderTree from 'lucide-svelte/icons/folder-tree';
  import MessageSquare from 'lucide-svelte/icons/message-square';

  export interface DiscoveredProviderProject {
    projectPath: string;
    projectName: string;
    latestUpdatedAt: number;
    chats: DiscoveredCliChat[];
  }

  export interface DiscoveredProviderGroup {
    provider: string;
    displayName: string;
    chatCount: number;
    projectCount: number;
    latestUpdatedAt: number;
    projects: DiscoveredProviderProject[];
  }

  interface Props {
    onImportedChange?: (importedTotal: number) => void;
  }

  let { onImportedChange }: Props = $props();

  const INITIAL_VISIBLE_CHATS = 15;

  // Discovery lives in a shared store so the onboarding walkthrough can start
  // the scan long before this step renders. The loading state shows only until
  // the first scan resolves; a Rescan keeps the current list on screen.
  const providers = $derived(cliChatImportStore.providers);
  const projects = $derived(cliChatImportStore.projects);
  const loading = $derived(!cliChatImportStore.hasLoaded && !cliChatImportStore.error);
  const scanning = $derived(cliChatImportStore.loading);

  let importing = $state(false);
  let importError = $state<string | null>(null);
  const error = $derived(importError ?? cliChatImportStore.error);

  // View mode: 'by-provider' (Providers -> Projects -> Chats, default) or 'by-project'
  let viewMode = $state<'by-provider' | 'by-project'>('by-provider');

  let searchQuery = $state('');
  let showZeroChatProviders = $state(false);

  // Expanded state sets
  let expandedProviders = $state<Set<string>>(new Set());
  let expandedProjectsInProvider = $state<Set<string>>(new Set()); // key: `${provider}:${projectPath}`
  let expandedProjectCards = $state<Set<string>>(new Set()); // projectPath for 'by-project' mode
  let expandedChatPreviews = $state<Set<string>>(new Set());
  // Chat lists showing every chat instead of the first INITIAL_VISIBLE_CHATS.
  let expandedChatLists = $state<Set<string>>(new Set());

  // Selected chat IDs to port
  let selectedChatIds = $state<Set<string>>(new Set());
  // Count of chats imported during this session
  let sessionImportedCount = $state(0);

  const providersWithChats = $derived(providers.filter((p) => p.chatCount > 0));
  const providersWithoutChats = $derived(providers.filter((p) => p.chatCount === 0));

  // Compute hierarchical Provider -> Projects -> Chats tree
  const providerTree = $derived.by(() => {
    const q = searchQuery.trim().toLowerCase();
    const map = new Map<
      string,
      {
        provider: string;
        displayName: string;
        chatCount: number;
        latestUpdatedAt: number;
        projectMap: Map<string, DiscoveredProviderProject>;
      }
    >();

    // Seed from providers list to preserve display names
    for (const p of providers) {
      if (!map.has(p.provider)) {
        map.set(p.provider, {
          provider: p.provider,
          displayName: p.displayName,
          chatCount: 0,
          latestUpdatedAt: 0,
          projectMap: new Map(),
        });
      }
    }

    // Populate chats across projects
    for (const group of projects) {
      for (const chat of group.chats) {
        let pEntry = map.get(chat.provider);
        if (!pEntry) {
          pEntry = {
            provider: chat.provider,
            displayName: chat.providerDisplayName || chat.provider,
            chatCount: 0,
            latestUpdatedAt: 0,
            projectMap: new Map(),
          };
          map.set(chat.provider, pEntry);
        }

        const matchesQuery =
          !q ||
          chat.title.toLowerCase().includes(q) ||
          chat.preview.toLowerCase().includes(q) ||
          chat.projectName.toLowerCase().includes(q) ||
          chat.projectPath.toLowerCase().includes(q) ||
          chat.providerDisplayName.toLowerCase().includes(q) ||
          (chat.model?.toLowerCase().includes(q) ?? false);

        if (!matchesQuery) continue;

        pEntry.chatCount += 1;
        pEntry.latestUpdatedAt = Math.max(
          pEntry.latestUpdatedAt,
          chat.updatedAt || chat.createdAt || 0,
        );

        let projEntry = pEntry.projectMap.get(chat.projectPath);
        if (!projEntry) {
          projEntry = {
            projectPath: chat.projectPath,
            projectName: chat.projectName,
            latestUpdatedAt: 0,
            chats: [],
          };
          pEntry.projectMap.set(chat.projectPath, projEntry);
        }
        projEntry.chats.push(chat);
        projEntry.latestUpdatedAt = Math.max(
          projEntry.latestUpdatedAt,
          chat.updatedAt || chat.createdAt || 0,
        );
      }
    }

    const list: DiscoveredProviderGroup[] = [];
    for (const entry of map.values()) {
      if (entry.chatCount === 0 && q) continue; // Skip empty matches when filtering
      const projList = Array.from(entry.projectMap.values())
        .map((pr) => ({
          ...pr,
          chats: [...pr.chats].sort(
            (a, b) => (b.updatedAt || b.createdAt || 0) - (a.updatedAt || a.createdAt || 0),
          ),
        }))
        .sort((a, b) => b.latestUpdatedAt - a.latestUpdatedAt);

      list.push({
        provider: entry.provider,
        displayName: entry.displayName,
        chatCount: entry.chatCount,
        projectCount: projList.length,
        latestUpdatedAt: entry.latestUpdatedAt,
        projects: projList,
      });
    }

    // Sort providers with chats first, then by latestUpdatedAt descending
    return list.sort((a, b) => {
      if ((a.chatCount > 0) !== (b.chatCount > 0)) {
        return a.chatCount > 0 ? -1 : 1;
      }
      return b.latestUpdatedAt - a.latestUpdatedAt;
    });
  });

  // Filtered project list for alternative 'by-project' view
  const filteredProjects = $derived.by(() => {
    const q = searchQuery.trim().toLowerCase();
    const result: Array<{
      group: DiscoveredCliProjectGroup;
      matchingChats: DiscoveredCliChat[];
    }> = [];

    for (const group of projects) {
      const projectMatches =
        !q ||
        group.projectName.toLowerCase().includes(q) ||
        group.projectPath.toLowerCase().includes(q);

      const matchingChats = group.chats.filter((chat) => {
        if (!q || projectMatches) return true;
        return (
          chat.title.toLowerCase().includes(q) ||
          chat.preview.toLowerCase().includes(q) ||
          chat.providerDisplayName.toLowerCase().includes(q) ||
          (chat.model?.toLowerCase().includes(q) ?? false)
        );
      });

      if (matchingChats.length > 0) {
        result.push({ group, matchingChats });
      }
    }
    return result;
  });

  const totalVisibleSelectableIds = $derived.by(() => {
    const ids: string[] = [];
    for (const prov of providerTree) {
      for (const pr of prov.projects) {
        for (const chat of pr.chats) {
          if (!chat.alreadyImported) ids.push(chat.id);
        }
      }
    }
    return ids;
  });

  const selectedCount = $derived(selectedChatIds.size);

  const selectedProjectCount = $derived.by(() => {
    const paths = new Set<string>();
    for (const group of projects) {
      for (const chat of group.chats) {
        if (selectedChatIds.has(chat.id)) {
          paths.add(group.projectPath);
          break;
        }
      }
    }
    return paths.size;
  });

  const selectedProviderCount = $derived.by(() => {
    const provs = new Set<string>();
    for (const group of projects) {
      for (const chat of group.chats) {
        if (selectedChatIds.has(chat.id)) {
          provs.add(chat.provider);
        }
      }
    }
    return provs.size;
  });

  const alreadyImportedTotal = $derived.by(() => {
    let count = 0;
    for (const group of projects) {
      for (const chat of group.chats) {
        if (chat.alreadyImported) count += 1;
      }
    }
    return count;
  });

  onMount(() => {
    void cliChatImportStore.prefetch();
  });

  // Report the ported total whenever a discovery resolves (including one that
  // resolved before this panel mounted).
  $effect(() => {
    if (cliChatImportStore.loadedAt === null) return;
    const total = Math.max(sessionImportedCount, alreadyImportedTotal);
    untrack(() => onImportedChange?.(total));
  });

  /** Forced rescan; kept as the panel's public API for `bind:this` callers. */
  export async function loadDiscovery(): Promise<void> {
    importError = null;
    await cliChatImportStore.refresh();
  }

  export async function importSelectedIfPending(): Promise<number> {
    if (selectedChatIds.size === 0 || importing) return 0;
    return await importSelectedChats();
  }

  export async function importSelectedChats(): Promise<number> {
    const chatIds = [...selectedChatIds];
    if (chatIds.length === 0 || importing) return 0;
    importing = true;
    importError = null;
    try {
      const { importedCount } = await cliChatImportStore.importChats(chatIds);
      selectedChatIds = new Set();
      sessionImportedCount += importedCount;
      await sessionStore.fetchSessions();
      if (importedCount > 0) {
        toastStore.success(
          `Ported ${importedCount} ${importedCount === 1 ? 'chat' : 'chats'} into Koryphaios`,
        );
      }
      return importedCount;
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to import selected chats.';
      importError = msg;
      toastStore.error(msg);
      return 0;
    } finally {
      importing = false;
    }
  }

  // Accordion Expand/Collapse Toggles
  function toggleProviderExpand(provider: string) {
    const next = new Set(expandedProviders);
    if (next.has(provider)) next.delete(provider);
    else next.add(provider);
    expandedProviders = next;
  }

  function toggleProjectInProviderExpand(provider: string, projectPath: string) {
    const key = `${provider}:${projectPath}`;
    const next = new Set(expandedProjectsInProvider);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    expandedProjectsInProvider = next;
  }

  function toggleProjectCardExpand(projectPath: string) {
    const next = new Set(expandedProjectCards);
    if (next.has(projectPath)) next.delete(projectPath);
    else next.add(projectPath);
    expandedProjectCards = next;
  }

  function toggleChatPreview(chatId: string) {
    const next = new Set(expandedChatPreviews);
    if (next.has(chatId)) next.delete(chatId);
    else next.add(chatId);
    expandedChatPreviews = next;
  }

  function toggleChatList(key: string) {
    const next = new Set(expandedChatLists);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    expandedChatLists = next;
  }

  // Selection Logic
  function toggleChatSelection(chatId: string, alreadyImported: boolean) {
    if (alreadyImported) return;
    const next = new Set(selectedChatIds);
    if (next.has(chatId)) next.delete(chatId);
    else next.add(chatId);
    selectedChatIds = next;
  }

  // Level 1: Category Selection (Entire Provider)
  function getProviderSelectableChats(group: DiscoveredProviderGroup): DiscoveredCliChat[] {
    const list: DiscoveredCliChat[] = [];
    for (const pr of group.projects) {
      for (const chat of pr.chats) {
        if (!chat.alreadyImported) list.push(chat);
      }
    }
    return list;
  }

  function getProviderSelectionState(
    group: DiscoveredProviderGroup,
  ): 'none' | 'some' | 'all' {
    const selectable = getProviderSelectableChats(group);
    if (selectable.length === 0) return 'none';
    let count = 0;
    for (const c of selectable) {
      if (selectedChatIds.has(c.id)) count += 1;
    }
    if (count === 0) return 'none';
    if (count === selectable.length) return 'all';
    return 'some';
  }

  function toggleProviderCategory(group: DiscoveredProviderGroup) {
    const selectable = getProviderSelectableChats(group);
    if (selectable.length === 0) return;
    const state = getProviderSelectionState(group);
    const next = new Set(selectedChatIds);
    if (state === 'all') {
      for (const c of selectable) next.delete(c.id);
    } else {
      for (const c of selectable) next.add(c.id);
    }
    selectedChatIds = next;
  }

  // Level 2: Project Selection under a Provider
  function getProjectInProviderSelectableChats(
    project: DiscoveredProviderProject,
  ): DiscoveredCliChat[] {
    return project.chats.filter((c) => !c.alreadyImported);
  }

  function getProjectInProviderSelectionState(
    project: DiscoveredProviderProject,
  ): 'none' | 'some' | 'all' {
    const selectable = getProjectInProviderSelectableChats(project);
    if (selectable.length === 0) return 'none';
    let count = 0;
    for (const c of selectable) {
      if (selectedChatIds.has(c.id)) count += 1;
    }
    if (count === 0) return 'none';
    if (count === selectable.length) return 'all';
    return 'some';
  }

  function toggleProjectInProviderCategory(project: DiscoveredProviderProject) {
    const selectable = getProjectInProviderSelectableChats(project);
    if (selectable.length === 0) return;
    const state = getProjectInProviderSelectionState(project);
    const next = new Set(selectedChatIds);
    if (state === 'all') {
      for (const c of selectable) next.delete(c.id);
    } else {
      for (const c of selectable) next.add(c.id);
    }
    selectedChatIds = next;
  }

  // Level 2 for By-Project view
  function getProjectSelectableChats(
    matchingChats: DiscoveredCliChat[],
  ): DiscoveredCliChat[] {
    return matchingChats.filter((c) => !c.alreadyImported);
  }

  function getProjectSelectionState(
    matchingChats: DiscoveredCliChat[],
  ): 'none' | 'some' | 'all' {
    const selectable = getProjectSelectableChats(matchingChats);
    if (selectable.length === 0) return 'none';
    let count = 0;
    for (const c of selectable) {
      if (selectedChatIds.has(c.id)) count += 1;
    }
    if (count === 0) return 'none';
    if (count === selectable.length) return 'all';
    return 'some';
  }

  function toggleProjectSelection(matchingChats: DiscoveredCliChat[]) {
    const selectable = getProjectSelectableChats(matchingChats);
    if (selectable.length === 0) return;
    const state = getProjectSelectionState(matchingChats);
    const next = new Set(selectedChatIds);
    if (state === 'all') {
      for (const c of selectable) next.delete(c.id);
    } else {
      for (const c of selectable) next.add(c.id);
    }
    selectedChatIds = next;
  }

  function selectAllVisible() {
    const next = new Set(selectedChatIds);
    for (const id of totalVisibleSelectableIds) {
      next.add(id);
    }
    selectedChatIds = next;
  }

  function clearSelection() {
    selectedChatIds = new Set();
  }

  function formatRelativeTime(timestampMs: number): string {
    if (!timestampMs || !Number.isFinite(timestampMs)) return '';
    const diffSec = Math.max(0, Math.floor((Date.now() - timestampMs) / 1000));
    if (diffSec < 60) return 'just now';
    const diffMin = Math.floor(diffSec / 60);
    if (diffMin < 60) return `${diffMin}m ago`;
    const diffHr = Math.floor(diffMin / 60);
    if (diffHr < 24) return `${diffHr}h ago`;
    const diffDays = Math.floor(diffHr / 24);
    if (diffDays < 30) return `${diffDays}d ago`;
    return new Date(timestampMs).toLocaleDateString();
  }
</script>

{#snippet selectBox(state: 'none' | 'some' | 'all', label: string, onToggle: () => void, disabled = false)}
  <button
    type="button"
    role="checkbox"
    aria-checked={state === 'all' ? 'true' : state === 'some' ? 'mixed' : 'false'}
    aria-label={label}
    {disabled}
    class="checkbox-btn"
    class:is-checked={state !== 'none'}
    onclick={onToggle}
  >
    {#if state === 'all'}
      <Check size={10} strokeWidth={3} />
    {:else if state === 'some'}
      <span class="h-0.5 w-1.5 rounded-full bg-current"></span>
    {/if}
  </button>
{/snippet}

{#snippet chatRow(chat: DiscoveredCliChat, showProvider: boolean)}
  {@const isSelected = selectedChatIds.has(chat.id)}
  {@const isPreviewOpen = expandedChatPreviews.has(chat.id)}
  <div class="tree-row chat-row" data-testid="cli-import-chat-row">
    <div class="flex items-start gap-2.5">
      <span class="mt-0.5 flex">
        {@render selectBox(
          chat.alreadyImported || isSelected ? 'all' : 'none',
          `Select chat ${chat.title}`,
          () => toggleChatSelection(chat.id, chat.alreadyImported),
          chat.alreadyImported,
        )}
      </span>
      <button
        type="button"
        class="min-w-0 flex-1 text-left"
        onclick={() => toggleChatSelection(chat.id, chat.alreadyImported)}
        disabled={chat.alreadyImported}
      >
        <span class="flex min-w-0 items-baseline gap-2">
          {#if showProvider}
            <ProviderIcon provider={chat.provider} size={14} class="shrink-0 self-center" />
          {/if}
          <span class="truncate text-[12px] font-medium" style="color: var(--color-text-primary);">
            {chat.title}
          </span>
          {#if chat.alreadyImported}
            <span class="shrink-0 text-[11px] font-medium" style="color: var(--setup-accent, var(--color-accent));">
              Ported
            </span>
          {/if}
        </span>
        <span class="mt-0.5 block truncate text-[11px]" style="color: var(--color-text-muted);">
          {#if chat.model}<span class="font-mono">{chat.model}</span> · {/if}{chat.preview}
        </span>
      </button>
      <div class="flex shrink-0 items-center gap-1.5 text-[11px]" style="color: var(--color-text-muted);">
        <span>{chat.messageCount} msgs</span>
        {#if chat.updatedAt}
          <span>· {formatRelativeTime(chat.updatedAt)}</span>
        {/if}
        {#if chat.sampleMessages.length > 0}
          <button
            type="button"
            class="ghost-btn"
            onclick={() => toggleChatPreview(chat.id)}
            aria-expanded={isPreviewOpen}
            aria-label={`Preview messages for ${chat.title}`}
          >
            {isPreviewOpen ? 'Hide' : 'Preview'}
          </button>
        {/if}
      </div>
    </div>
    {#if isPreviewOpen && chat.sampleMessages.length > 0}
      <div
        transition:slide={{ duration: 160 }}
        class="mt-1.5 ml-6 space-y-1.5 rounded-lg px-2.5 py-2 text-[11px]"
        style="background: var(--color-surface-2);"
      >
        {#each chat.sampleMessages as msg, idx (idx)}
          <div class="flex gap-2">
            <span
              class="w-11 shrink-0 pt-px text-[10px] font-semibold tracking-wide uppercase"
              style="color: {msg.role === 'user'
                ? 'var(--setup-accent, var(--color-accent))'
                : 'var(--color-text-muted)'};"
            >
              {msg.role === 'user' ? 'User' : 'Agent'}
            </span>
            <p class="line-clamp-3 flex-1 break-words whitespace-pre-wrap" style="color: var(--color-text-secondary);">
              {msg.content}
            </p>
          </div>
        {/each}
      </div>
    {/if}
  </div>
{/snippet}

{#snippet chatList(chats: DiscoveredCliChat[], listKey: string, showProvider: boolean)}
  {@const showAll = expandedChatLists.has(listKey)}
  {#each showAll ? chats : chats.slice(0, INITIAL_VISIBLE_CHATS) as chat (chat.id)}
    {@render chatRow(chat, showProvider)}
  {/each}
  {#if chats.length > INITIAL_VISIBLE_CHATS}
    <button type="button" class="ghost-btn ml-8 mt-0.5" onclick={() => toggleChatList(listKey)}>
      {showAll ? 'Show fewer' : `Show all ${chats.length} chats`}
    </button>
  {/if}
{/snippet}

<div class="cli-import-panel flex w-full min-w-0 flex-col gap-3" data-testid="cli-chat-import-panel">
  <!-- Scan summary: one quiet line -->
  <div class="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
    <p class="min-w-0 text-[12px]" style="color: var(--color-text-muted);">
      {#if loading}
        <span style="color: var(--color-text-secondary);">Scanning all CLI providers on disk…</span>
      {:else}
        <span style="color: var(--color-text-secondary);">Checked all {providers.length} CLI providers</span>
        · {providersWithChats.length} with chats · {projects.length}
        {projects.length === 1 ? 'project' : 'projects'}
        {#if providersWithoutChats.length > 0}
          ·
          <button
            type="button"
            class="text-link"
            aria-expanded={showZeroChatProviders}
            onclick={() => {
              showZeroChatProviders = !showZeroChatProviders;
            }}
          >
            {showZeroChatProviders
              ? 'hide empty CLIs'
              : `${providersWithoutChats.length} checked CLIs had no chats`}
          </button>
        {/if}
      {/if}
    </p>
    <button
      type="button"
      class="ghost-btn"
      onclick={() => void loadDiscovery()}
      disabled={scanning}
      aria-label="Rescan CLI providers"
    >
      <RefreshCw size={12} class={scanning ? 'animate-spin' : ''} />
      {scanning && !loading ? 'Rescanning…' : 'Rescan'}
    </button>
  </div>

  {#if showZeroChatProviders && providersWithoutChats.length > 0}
    <div
      transition:slide={{ duration: 160 }}
      class="-mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px]"
      style="color: var(--color-text-muted);"
    >
      {#each providersWithoutChats as p (p.id)}
        <span class="inline-flex items-center gap-1.5" title={`Checked paths: ${p.checkedPaths.join(', ')}`}>
          <ProviderIcon provider={p.provider} size={14} />
          {p.displayName}
        </span>
      {/each}
    </div>
  {/if}

  <!-- Filter + view + bulk selection -->
  <div class="flex flex-wrap items-center gap-2">
    <div class="relative min-w-[200px] flex-1">
      <Search
        size={13}
        class="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2"
        style="color: var(--color-text-muted);"
      />
      <input
        type="text"
        bind:value={searchQuery}
        placeholder="Filter by provider, project, chat title, or model…"
        aria-label="Filter projects and chats"
        class="filter-input w-full rounded-lg border py-1.5 pr-3 pl-8 text-[12px] outline-none transition-colors"
      />
    </div>

    <div class="view-switch" role="radiogroup" aria-label="Display hierarchy view">
      <button
        type="button"
        role="radio"
        aria-checked={viewMode === 'by-provider'}
        class="view-switch-btn"
        class:is-active={viewMode === 'by-provider'}
        onclick={() => (viewMode = 'by-provider')}
        title="Show providers first, expand to see projects, open to see chats"
      >
        <FolderTree size={12} />
        <span>By Provider</span>
      </button>
      <button
        type="button"
        role="radio"
        aria-checked={viewMode === 'by-project'}
        class="view-switch-btn"
        class:is-active={viewMode === 'by-project'}
        onclick={() => (viewMode = 'by-project')}
        title="Group directly by project directory"
      >
        <Layers size={12} />
        <span>By Project</span>
      </button>
    </div>

    {#if totalVisibleSelectableIds.length > 0}
      <button type="button" class="ghost-btn" onclick={selectAllVisible}>
        Select visible ({totalVisibleSelectableIds.length})
      </button>
    {/if}
    {#if selectedCount > 0}
      <button type="button" class="ghost-btn" onclick={clearSelection}>
        Clear ({selectedCount})
      </button>
    {/if}
  </div>

  {#if error}
    <p
      class="rounded-lg px-3 py-2 text-[12px]"
      role="alert"
      style="color: var(--color-error); background: var(--color-error-bg);"
    >
      {error}
    </p>
  {/if}

  <!-- Hierarchy list -->
  <div class="tree-list max-h-[300px] overflow-y-auto pr-1">
    {#if loading}
      <div class="flex items-center justify-center gap-2 py-12 text-[12px]" style="color: var(--color-text-muted);">
        <RefreshCw size={13} class="animate-spin" />
        Scanning CLI chat histories across providers and projects…
      </div>
    {:else if viewMode === 'by-provider'}
      {@const visibleProviders = providerTree.filter((p) => p.chatCount > 0)}
      {#if visibleProviders.length === 0}
        <div
          class="flex flex-col items-center justify-center gap-1.5 py-10 text-center text-[12px]"
          style="color: var(--color-text-muted);"
        >
          <MessageSquare size={18} />
          <span>
            {providers.length === 0
              ? 'No existing CLI chats were found on this machine.'
              : 'No chats match your current filter.'}
          </span>
        </div>
      {:else}
        {#each visibleProviders as provGroup (provGroup.provider)}
          {@const isProvExpanded = expandedProviders.has(provGroup.provider)}
          {@const selectedInProv = provGroup.projects.reduce(
            (acc, pr) => acc + pr.chats.filter((c) => selectedChatIds.has(c.id)).length,
            0,
          )}
          <div class="tree-group" data-testid="cli-provider-card">
            <div class="tree-row">
              {@render selectBox(
                getProviderSelectionState(provGroup),
                `Select entire ${provGroup.displayName} category`,
                () => toggleProviderCategory(provGroup),
              )}
              <button
                type="button"
                class="flex min-w-0 flex-1 items-center gap-2.5 text-left"
                onclick={() => toggleProviderExpand(provGroup.provider)}
                aria-expanded={isProvExpanded}
                aria-label={`Toggle provider ${provGroup.displayName}`}
              >
                <span class="chevron-arrow" class:is-open={isProvExpanded}>
                  <ChevronRight size={14} />
                </span>
                <ProviderIcon provider={provGroup.provider} size={20} class="shrink-0" />
                <span class="flex min-w-0 flex-1 items-baseline gap-2">
                  <span class="truncate text-[13px] font-medium" style="color: var(--color-text-primary);">
                    {provGroup.displayName}
                  </span>
                  <span class="shrink-0 text-[11px]" style="color: var(--color-text-muted);">
                    {provGroup.projectCount} {provGroup.projectCount === 1 ? 'project' : 'projects'}
                  </span>
                  {#if selectedInProv > 0}
                    <span class="shrink-0 text-[11px] font-medium" style="color: var(--setup-accent, var(--color-accent));">
                      {selectedInProv} selected
                    </span>
                  {/if}
                </span>
                <span class="shrink-0 text-[11px]" style="color: var(--color-text-muted);">
                  {provGroup.chatCount} {provGroup.chatCount === 1 ? 'chat' : 'chats'}
                </span>
              </button>
            </div>

            {#if isProvExpanded}
              <div transition:slide={{ duration: 200 }} class="tree-children">
                {#each provGroup.projects as pr (pr.projectPath)}
                  {@const prKey = `${provGroup.provider}:${pr.projectPath}`}
                  {@const isPrExpanded = expandedProjectsInProvider.has(prKey)}
                  {@const selectedInPr = pr.chats.filter((c) => selectedChatIds.has(c.id)).length}
                  <div class="tree-row">
                    {@render selectBox(
                      getProjectInProviderSelectionState(pr),
                      `Select all ${provGroup.displayName} chats in ${pr.projectName}`,
                      () => toggleProjectInProviderCategory(pr),
                    )}
                    <button
                      type="button"
                      class="flex min-w-0 flex-1 items-center gap-2 text-left"
                      onclick={() => toggleProjectInProviderExpand(provGroup.provider, pr.projectPath)}
                      aria-expanded={isPrExpanded}
                      aria-label={`Toggle project ${pr.projectName}`}
                    >
                      <span class="chevron-arrow" class:is-open={isPrExpanded}>
                        <ChevronRight size={13} />
                      </span>
                      <FolderGit2 size={14} class="shrink-0" style="color: var(--color-text-muted);" />
                      <span class="flex min-w-0 flex-1 items-baseline gap-2">
                        <span class="shrink-0 text-[12px] font-medium" style="color: var(--color-text-primary);">
                          {pr.projectName}
                        </span>
                        <span class="truncate font-mono text-[11px]" style="color: var(--color-text-muted);" title={pr.projectPath}>
                          {pr.projectPath}
                        </span>
                        {#if selectedInPr > 0}
                          <span class="shrink-0 text-[11px] font-medium" style="color: var(--setup-accent, var(--color-accent));">
                            {selectedInPr} selected
                          </span>
                        {/if}
                      </span>
                      <span class="shrink-0 text-[11px]" style="color: var(--color-text-muted);">
                        {pr.chats.length} {pr.chats.length === 1 ? 'chat' : 'chats'}
                      </span>
                    </button>
                  </div>
                  {#if isPrExpanded}
                    <div transition:slide={{ duration: 180 }} class="tree-children">
                      {@render chatList(pr.chats, prKey, false)}
                    </div>
                  {/if}
                {/each}
              </div>
            {/if}
          </div>
        {/each}
      {/if}
    {:else}
      {#if filteredProjects.length === 0}
        <div
          class="flex flex-col items-center justify-center gap-1.5 py-10 text-center text-[12px]"
          style="color: var(--color-text-muted);"
        >
          <MessageSquare size={18} />
          <span>No projects match your filter.</span>
        </div>
      {:else}
        {#each filteredProjects as { group, matchingChats } (group.projectPath)}
          {@const isExpanded = expandedProjectCards.has(group.projectPath)}
          {@const selectedInProject = matchingChats.filter((c) => selectedChatIds.has(c.id)).length}
          <div class="tree-group" data-testid="cli-import-project-card">
            <div class="tree-row">
              {@render selectBox(
                getProjectSelectionState(matchingChats),
                `Select all chats in ${group.projectName}`,
                () => toggleProjectSelection(matchingChats),
              )}
              <button
                type="button"
                class="flex min-w-0 flex-1 items-center gap-2.5 text-left"
                onclick={() => toggleProjectCardExpand(group.projectPath)}
                aria-expanded={isExpanded}
                aria-label={`Toggle project ${group.projectName}`}
              >
                <span class="chevron-arrow" class:is-open={isExpanded}>
                  <ChevronRight size={14} />
                </span>
                <FolderGit2 size={16} class="shrink-0" style="color: var(--color-text-muted);" />
                <span class="flex min-w-0 flex-1 items-baseline gap-2">
                  <span class="shrink-0 text-[13px] font-medium" style="color: var(--color-text-primary);">
                    {group.projectName}
                  </span>
                  <span class="truncate font-mono text-[11px]" style="color: var(--color-text-muted);" title={group.projectPath}>
                    {group.projectPath}
                  </span>
                  {#if selectedInProject > 0}
                    <span class="shrink-0 text-[11px] font-medium" style="color: var(--setup-accent, var(--color-accent));">
                      {selectedInProject} selected
                    </span>
                  {/if}
                </span>
                <span class="flex shrink-0 items-center gap-2.5 text-[11px]" style="color: var(--color-text-muted);">
                  {#each group.providers.slice(0, 4) as prov (prov.provider)}
                    <span class="inline-flex items-center gap-1" title={prov.displayName}>
                      <ProviderIcon provider={prov.provider} size={14} />
                      {prov.chatCount}
                    </span>
                  {/each}
                  <span>{matchingChats.length} {matchingChats.length === 1 ? 'chat' : 'chats'}</span>
                </span>
              </button>
            </div>
            {#if isExpanded}
              <div transition:slide={{ duration: 200 }} class="tree-children">
                {@render chatList(matchingChats, `project:${group.projectPath}`, true)}
              </div>
            {/if}
          </div>
        {/each}
      {/if}
    {/if}
  </div>

  <!-- Selection summary + port action -->
  <div class="flex flex-wrap items-center justify-between gap-3">
    <p class="min-w-0 text-[12px]" style="color: var(--color-text-muted);">
      {#if selectedCount > 0}
        <span class="font-medium" style="color: var(--color-text-primary);">
          {selectedCount} {selectedCount === 1 ? 'chat' : 'chats'} selected
        </span>
        <span>
          across {selectedProjectCount} {selectedProjectCount === 1 ? 'project' : 'projects'}
          and {selectedProviderCount} {selectedProviderCount === 1 ? 'provider' : 'providers'}
        </span>
      {:else if alreadyImportedTotal > 0 || sessionImportedCount > 0}
        <span class="font-medium" style="color: var(--setup-accent, var(--color-accent));">
          {Math.max(sessionImportedCount, alreadyImportedTotal)}
          {Math.max(sessionImportedCount, alreadyImportedTotal) === 1 ? 'chat' : 'chats'} ported to Koryphaios
        </span>
      {:else}
        <span>Expand any provider above to cherry-pick chats or select an entire category.</span>
      {/if}
    </p>
    <button
      type="button"
      class="port-action-btn"
      onclick={() => void importSelectedChats()}
      disabled={selectedCount === 0 || importing}
    >
      <Download size={13} />
      {#if importing}
        Porting chats…
      {:else if selectedCount > 0}
        Port {selectedCount} selected {selectedCount === 1 ? 'chat' : 'chats'}
      {:else}
        Port selected chats
      {/if}
    </button>
  </div>
</div>

<style>
  /* Chat titles, previews and paths truncate on one line. Without inline-size
     containment their nowrap width becomes the panel's min-content width and
     widens a flex host (the walkthrough slide) past its card. */
  .cli-import-panel {
    contain: inline-size;
  }

  .chevron-arrow {
    display: inline-flex;
    flex-shrink: 0;
    color: var(--color-text-muted);
    transition: transform 0.2s cubic-bezier(0.16, 1, 0.3, 1);
  }
  .chevron-arrow.is-open {
    transform: rotate(90deg);
  }

  /* One quiet list: rows are separated by spacing and lift on hover, never boxed. */
  .tree-row {
    display: flex;
    align-items: center;
    gap: 0.625rem;
    border-radius: 0.5rem;
    padding: 0.375rem 0.5rem;
    transition: background-color 0.12s ease;
  }
  .tree-row:hover {
    background: var(--color-surface-2);
  }
  .chat-row {
    display: block;
  }
  .tree-children {
    padding-left: 1.5rem;
  }

  .filter-input {
    background: var(--color-surface-1);
    border-color: var(--color-border);
    color: var(--color-text-primary);
  }
  .filter-input:focus {
    border-color: var(--setup-accent, var(--color-accent));
  }

  .view-switch {
    display: inline-flex;
    align-items: center;
    gap: 0.125rem;
    border-radius: 0.5rem;
    padding: 0.125rem;
    background: var(--color-surface-2);
  }
  .view-switch-btn {
    display: inline-flex;
    align-items: center;
    gap: 0.375rem;
    border-radius: 0.375rem;
    padding: 0.25rem 0.625rem;
    font-size: 11px;
    font-weight: 500;
    color: var(--color-text-muted);
    transition:
      background-color 0.12s ease,
      color 0.12s ease;
  }
  .view-switch-btn:hover {
    color: var(--color-text-primary);
  }
  .view-switch-btn.is-active {
    background: var(--color-surface-4);
    color: var(--color-text-primary);
  }

  .ghost-btn {
    display: inline-flex;
    align-items: center;
    gap: 0.375rem;
    border-radius: 0.375rem;
    padding: 0.25rem 0.5rem;
    font-size: 11px;
    font-weight: 500;
    color: var(--color-text-secondary);
    background: transparent;
    transition:
      background-color 0.12s ease,
      color 0.12s ease;
  }
  .ghost-btn:hover:not(:disabled) {
    background: var(--color-surface-2);
    color: var(--color-text-primary);
  }
  .ghost-btn:disabled {
    color: var(--color-text-muted);
    cursor: default;
  }

  .text-link {
    color: var(--color-text-muted);
    text-decoration: underline;
    text-decoration-color: transparent;
    text-underline-offset: 2px;
    transition:
      color 0.12s ease,
      text-decoration-color 0.12s ease;
  }
  .text-link:hover {
    color: var(--color-text-secondary);
    text-decoration-color: currentColor;
  }

  .checkbox-btn {
    display: inline-flex;
    flex-shrink: 0;
    align-items: center;
    justify-content: center;
    width: 14px;
    height: 14px;
    border-radius: 4px;
    border: 1px solid var(--color-border);
    background: var(--color-surface-1);
    color: transparent;
    transition:
      background-color 0.12s ease,
      border-color 0.12s ease;
  }
  .checkbox-btn:hover:not(:disabled) {
    border-color: var(--color-text-muted);
  }
  .checkbox-btn.is-checked {
    border-color: var(--setup-accent, var(--color-accent));
    background: var(--setup-accent, var(--color-accent));
    color: var(--setup-on-accent, var(--color-on-accent));
  }
  .checkbox-btn:disabled {
    cursor: default;
  }
  .checkbox-btn:disabled.is-checked {
    border-color: var(--color-surface-4);
    background: var(--color-surface-4);
    color: var(--color-text-muted);
  }

  .port-action-btn {
    display: inline-flex;
    align-items: center;
    gap: 0.375rem;
    margin-left: auto;
    border-radius: 0.5rem;
    padding: 0.375rem 0.75rem;
    font-size: 12px;
    font-weight: 600;
    background: var(--setup-accent, var(--color-accent));
    color: var(--setup-on-accent, var(--color-on-accent));
    transition: background-color 0.12s ease;
  }
  .port-action-btn:hover:not(:disabled) {
    background: var(--setup-accent-hover, var(--color-accent));
  }
  .port-action-btn:disabled {
    background: var(--color-surface-3);
    color: var(--color-text-muted);
    cursor: default;
  }
</style>
