<script lang="ts">
  import { onMount } from 'svelte';
  import { slide } from 'svelte/transition';
  import ProviderIcon from './icons/ProviderIcon.svelte';
  import { apiFetch } from '$lib/api.svelte';
  import { apiUrl } from '$lib/utils/api-url';
  import { sessionStore } from '$lib/stores/sessions.svelte';
  import { toastStore } from '$lib/stores/toast.svelte';
  import ChevronRight from 'lucide-svelte/icons/chevron-right';
  import FolderGit2 from 'lucide-svelte/icons/folder-git-2';
  import Search from 'lucide-svelte/icons/search';
  import RefreshCw from 'lucide-svelte/icons/refresh-cw';
  import Check from 'lucide-svelte/icons/check';
  import Download from 'lucide-svelte/icons/download';
  import Eye from 'lucide-svelte/icons/eye';
  import Layers from 'lucide-svelte/icons/layers';
  import FolderTree from 'lucide-svelte/icons/folder-tree';
  import MessageSquare from 'lucide-svelte/icons/message-square';

  export interface CliProviderScanSummary {
    id: string;
    provider: string;
    displayName: string;
    checked: boolean;
    storageFound: boolean;
    checkedPaths: string[];
    chatCount: number;
    projectCount: number;
  }

  export interface DiscoveredCliChatMessage {
    role: 'user' | 'assistant';
    content: string;
    createdAt: number;
    model?: string;
  }

  export interface DiscoveredCliChat {
    id: string;
    externalId: string;
    provider: string;
    providerDisplayName: string;
    projectPath: string;
    projectName: string;
    title: string;
    preview: string;
    model?: string;
    messageCount: number;
    createdAt: number;
    updatedAt: number;
    alreadyImported: boolean;
    importedSessionId?: string;
    sampleMessages: DiscoveredCliChatMessage[];
  }

  export interface DiscoveredCliProjectGroup {
    projectPath: string;
    projectName: string;
    chatCount: number;
    providers: Array<{
      provider: string;
      displayName: string;
      chatCount: number;
    }>;
    latestUpdatedAt: number;
    chats: DiscoveredCliChat[];
  }

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

  let loading = $state(true);
  let importing = $state(false);
  let error = $state<string | null>(null);

  let providers = $state<CliProviderScanSummary[]>([]);
  let projects = $state<DiscoveredCliProjectGroup[]>([]);

  // View mode: 'by-provider' (Providers -> Projects -> Chats, default) or 'by-project'
  let viewMode = $state<'by-provider' | 'by-project'>('by-provider');

  let searchQuery = $state('');
  let showZeroChatProviders = $state(false);

  // Expanded state sets
  let expandedProviders = $state<Set<string>>(new Set());
  let expandedProjectsInProvider = $state<Set<string>>(new Set()); // key: `${provider}:${projectPath}`
  let expandedProjectCards = $state<Set<string>>(new Set()); // projectPath for 'by-project' mode
  let expandedChatPreviews = $state<Set<string>>(new Set());

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
    void loadDiscovery();
  });

  export async function loadDiscovery(): Promise<void> {
    loading = true;
    error = null;
    try {
      const res = await apiFetch(apiUrl('/api/cli-chat-import/discover'));
      if (!res.ok) {
        throw new Error(`Discovery failed (${res.status})`);
      }
      const body = (await res.json()) as {
        ok?: boolean;
        data?: {
          providers?: CliProviderScanSummary[];
          projects?: DiscoveredCliProjectGroup[];
        };
      };
      providers = body.data?.providers ?? [];
      projects = body.data?.projects ?? [];

      onImportedChange?.(Math.max(sessionImportedCount, alreadyImportedTotal));
    } catch (err) {
      error = err instanceof Error ? err.message : 'Could not scan local CLI chats.';
    } finally {
      loading = false;
    }
  }

  export async function importSelectedIfPending(): Promise<number> {
    if (selectedChatIds.size === 0 || importing) return 0;
    return await importSelectedChats();
  }

  export async function importSelectedChats(): Promise<number> {
    const chatIds = [...selectedChatIds];
    if (chatIds.length === 0 || importing) return 0;
    importing = true;
    error = null;
    try {
      const res = await apiFetch(apiUrl('/api/cli-chat-import/import'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chatIds }),
      });
      if (!res.ok) {
        throw new Error(`Import failed (${res.status})`);
      }
      const body = (await res.json()) as {
        ok?: boolean;
        data?: {
          importedCount?: number;
          alreadyImportedCount?: number;
          items?: Array<{ chatId: string; sessionId: string }>;
        };
      };
      const importedCount = body.data?.importedCount ?? 0;
      const importedMap = new Map(
        (body.data?.items ?? []).map((item) => [item.chatId, item.sessionId]),
      );

      // Mark imported chats in local state
      projects = projects.map((group) => ({
        ...group,
        chats: group.chats.map((chat) =>
          importedMap.has(chat.id) || selectedChatIds.has(chat.id)
            ? {
                ...chat,
                alreadyImported: true,
                importedSessionId: importedMap.get(chat.id) ?? chat.importedSessionId,
              }
            : chat,
        ),
      }));

      selectedChatIds = new Set();
      sessionImportedCount += importedCount;
      onImportedChange?.(Math.max(sessionImportedCount, alreadyImportedTotal));

      await sessionStore.fetchSessions();

      if (importedCount > 0) {
        toastStore.success(
          `Ported ${importedCount} ${importedCount === 1 ? 'chat' : 'chats'} into Koryphaios`,
        );
      }
      return importedCount;
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to import selected chats.';
      error = msg;
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

<div class="cli-import-panel flex flex-col gap-3.5" data-testid="cli-chat-import-panel">
  <!-- All CLI Providers Checked Banner & Filter Strip -->
  <div
    class="rounded-xl border px-3.5 py-3"
    style="border-color: var(--color-border); background: var(--color-surface-2);"
  >
    <div class="flex flex-wrap items-center justify-between gap-2">
      <div class="flex items-center gap-2 text-xs">
        <span class="font-semibold" style="color: var(--color-text-primary);">
          {#if loading}
            Scanning all CLI providers on disk…
          {:else}
            Checked all {providers.length} CLI providers
          {/if}
        </span>
        {#if !loading}
          <span style="color: var(--color-text-muted);">
            · {providersWithChats.length} with chats · {projects.length}
            {projects.length === 1 ? 'project' : 'projects'}
          </span>
        {/if}
      </div>
      <div class="flex items-center gap-2">
        {#if providersWithoutChats.length > 0 && !loading}
          <button
            type="button"
            class="rounded-md px-2 py-1 text-[11px] font-medium transition-colors"
            style="color: var(--color-text-muted); background: var(--color-surface-3);"
            onclick={() => {
              showZeroChatProviders = !showZeroChatProviders;
            }}
          >
            {showZeroChatProviders
              ? 'Hide empty CLIs'
              : `+${providersWithoutChats.length} checked CLIs (0 chats)`}
          </button>
        {/if}
        <button
          type="button"
          class="flex items-center gap-1 rounded-md px-2 py-1 text-[11px] font-medium transition-colors"
          style="color: var(--color-text-secondary); background: var(--color-surface-3);"
          onclick={() => void loadDiscovery()}
          disabled={loading}
          aria-label="Rescan CLI providers"
        >
          <RefreshCw size={11} class={loading ? 'animate-spin' : ''} />
          Rescan
        </button>
      </div>
    </div>

    {#if showZeroChatProviders && providersWithoutChats.length > 0}
      <div
        transition:slide={{ duration: 180 }}
        class="mt-2.5 flex flex-wrap items-center gap-1.5 border-t pt-2"
        style="border-color: var(--color-border);"
      >
        {#each providersWithoutChats as p (p.id)}
          <span
            class="flex items-center gap-1.5 rounded-lg border px-2 py-0.5 text-[11px] opacity-65"
            style="border-color: var(--color-border); background: var(--color-surface-1); color: var(--color-text-muted);"
            title={`Checked paths: ${p.checkedPaths.join(', ')}`}
          >
            <ProviderIcon provider={p.provider} size={13} />
            <span>{p.displayName}</span>
            <span class="text-[10px]">0</span>
          </span>
        {/each}
      </div>
    {/if}
  </div>

  <!-- Search + View Switcher + Bulk Selection Toolbar -->
  <div class="flex flex-wrap items-center justify-between gap-2.5">
    <div class="relative min-w-[200px] flex-1">
      <Search
        size={13}
        class="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2"
        style="color: var(--color-text-muted);"
      />
      <input
        type="text"
        bind:value={searchQuery}
        placeholder="Filter by provider, project, chat title, or model…"
        aria-label="Filter projects and chats"
        class="w-full rounded-lg border py-1.5 pl-8 pr-3 text-xs outline-none transition-colors"
        style="background: var(--color-surface-2); border-color: var(--color-border); color: var(--color-text-primary);"
      />
    </div>

    <!-- View Mode Switcher -->
    <div
      class="flex items-center rounded-lg border p-0.5 text-[11px] font-medium"
      style="border-color: var(--color-border); background: var(--color-surface-2);"
      role="radiogroup"
      aria-label="Display hierarchy view"
    >
      <button
        type="button"
        role="radio"
        aria-checked={viewMode === 'by-provider'}
        class="view-switch-btn flex items-center gap-1.5 rounded-md px-2.5 py-1 transition-all"
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
        class="view-switch-btn flex items-center gap-1.5 rounded-md px-2.5 py-1 transition-all"
        class:is-active={viewMode === 'by-project'}
        onclick={() => (viewMode = 'by-project')}
        title="Group directly by project directory"
      >
        <Layers size={12} />
        <span>By Project</span>
      </button>
    </div>

    <!-- Bulk Select Actions -->
    <div class="flex items-center gap-2 text-xs">
      {#if totalVisibleSelectableIds.length > 0}
        <button
          type="button"
          class="rounded-md px-2 py-1 text-[11px] font-medium transition-colors"
          style="color: var(--color-text-secondary); background: var(--color-surface-2);"
          onclick={selectAllVisible}
        >
          Select visible ({totalVisibleSelectableIds.length})
        </button>
      {/if}
      {#if selectedCount > 0}
        <button
          type="button"
          class="rounded-md px-2 py-1 text-[11px] font-medium transition-colors"
          style="color: var(--color-text-muted); background: var(--color-surface-2);"
          onclick={clearSelection}
        >
          Clear ({selectedCount})
        </button>
      {/if}
    </div>
  </div>

  {#if error}
    <div
      class="rounded-lg border px-3 py-2 text-xs"
      style="border-color: var(--color-error, #ef4444); color: var(--color-error, #ef4444); background: color-mix(in srgb, var(--color-error, #ef4444) 10%, transparent);"
    >
      {error}
    </div>
  {/if}

  <!-- HIERARCHY TREE LIST -->
  <div class="tree-list max-h-[300px] space-y-2.5 overflow-y-auto pr-1">
    {#if loading}
      <div
        class="flex items-center justify-center rounded-xl border py-12 text-xs"
        style="border-color: var(--color-border); color: var(--color-text-muted);"
      >
        Scanning CLI chat histories across providers and projects…
      </div>
    {:else if viewMode === 'by-provider'}
      <!-- MODE 1: PROVIDERS FIRST (Level 1: Provider -> Level 2: Project -> Level 3: Chats) -->
      {#if providerTree.filter((p) => p.chatCount > 0).length === 0}
        <div
          class="flex flex-col items-center justify-center gap-1.5 rounded-xl border py-10 text-center text-xs"
          style="border-color: var(--color-border); color: var(--color-text-muted);"
        >
          <MessageSquare size={18} />
          <span>
            {providers.length === 0
              ? 'No existing CLI chats were found on this machine.'
              : 'No chats match your current filter.'}
          </span>
        </div>
      {:else}
        {#each providerTree.filter((p) => p.chatCount > 0) as provGroup (provGroup.provider)}
          {@const isProvExpanded = expandedProviders.has(provGroup.provider)}
          {@const provState = getProviderSelectionState(provGroup)}
          {@const selectedInProv = provGroup.projects.reduce(
            (acc, pr) => acc + pr.chats.filter((c) => selectedChatIds.has(c.id)).length,
            0,
          )}

          <!-- LEVEL 1: PROVIDER CARD -->
          <div
            class="provider-card overflow-hidden rounded-xl border transition-all duration-200"
            style="border-color: {selectedInProv > 0
              ? 'var(--setup-accent, var(--color-accent))'
              : 'var(--color-border)'}; background: var(--color-surface-2);"
            data-testid="cli-provider-card"
          >
            <!-- Provider Header Row -->
            <div class="flex items-center gap-2.5 px-3 py-2.5">
              <!-- Provider category checkbox: Select/Deselect entire category -->
              <button
                type="button"
                role="checkbox"
                aria-checked={provState === 'all'
                  ? 'true'
                  : provState === 'some'
                    ? 'mixed'
                    : 'false'}
                aria-label={`Select entire ${provGroup.displayName} category`}
                class="checkbox-btn flex h-4 w-4 shrink-0 items-center justify-center rounded border transition-colors"
                class:is-checked={provState === 'all' || provState === 'some'}
                onclick={() => toggleProviderCategory(provGroup)}
                title="Select or deselect all chats in this provider category"
              >
                {#if provState === 'all'}
                  <Check size={11} />
                {:else if provState === 'some'}
                  <span class="h-0.5 w-2 rounded-full bg-current"></span>
                {/if}
              </button>

              <!-- Expand / collapse trigger for this provider -->
              <button
                type="button"
                class="flex min-w-0 flex-1 items-center justify-between gap-3 text-left"
                onclick={() => toggleProviderExpand(provGroup.provider)}
                aria-expanded={isProvExpanded}
                aria-label={`Toggle provider ${provGroup.displayName}`}
              >
                <div class="flex min-w-0 items-center gap-2.5">
                  <div
                    class="chevron-arrow shrink-0"
                    class:is-open={isProvExpanded}
                    style="color: var(--color-text-muted);"
                  >
                    <ChevronRight size={14} />
                  </div>

                  <!-- Provider Logo with Container Badge -->
                  <div
                    class="provider-icon-badge flex h-7 w-7 shrink-0 items-center justify-center rounded-lg border transition-transform"
                    style="border-color: var(--color-border); background: var(--color-surface-1);"
                  >
                    <ProviderIcon provider={provGroup.provider} size={18} />
                  </div>

                  <div class="min-w-0">
                    <div class="flex items-center gap-2">
                      <span
                        class="truncate text-xs font-semibold"
                        style="color: var(--color-text-primary);"
                      >
                        {provGroup.displayName}
                      </span>
                      {#if selectedInProv > 0}
                        <span
                          class="rounded-full px-1.5 py-0.5 text-[10px] font-semibold"
                          style="background: var(--setup-accent); color: var(--setup-on-accent, #17130c);"
                        >
                          {selectedInProv} selected
                        </span>
                      {/if}
                    </div>
                    <span
                      class="text-[10px]"
                      style="color: var(--color-text-muted);"
                    >
                      {provGroup.projectCount} {provGroup.projectCount === 1 ? 'project' : 'projects'}
                    </span>
                  </div>
                </div>

                <div class="flex shrink-0 items-center gap-2">
                  <span
                    class="rounded-full border px-2 py-0.5 text-[11px] font-medium"
                    style="border-color: var(--color-border); background: var(--color-surface-1); color: var(--color-text-secondary);"
                  >
                    {provGroup.chatCount} {provGroup.chatCount === 1 ? 'chat' : 'chats'}
                  </span>
                </div>
              </button>
            </div>

            <!-- LEVEL 2: EXPANDED PROVIDER BODY (PROJECTS) -->
            {#if isProvExpanded}
              <div
                transition:slide={{ duration: 220 }}
                class="space-y-2 border-t p-2.5"
                style="border-color: var(--color-border); background: var(--color-surface-1);"
              >
                {#each provGroup.projects as pr (pr.projectPath)}
                  {@const isPrExpanded = expandedProjectsInProvider.has(
                    `${provGroup.provider}:${pr.projectPath}`,
                  )}
                  {@const prState = getProjectInProviderSelectionState(pr)}
                  {@const selectedInPr = pr.chats.filter((c) =>
                    selectedChatIds.has(c.id),
                  ).length}

                  <!-- LEVEL 2: PROJECT CARD UNDER PROVIDER -->
                  <div
                    class="project-subcard overflow-hidden rounded-lg border transition-colors"
                    style="border-color: {selectedInPr > 0
                      ? 'var(--setup-accent, var(--color-accent))'
                      : 'var(--color-border)'}; background: var(--color-surface-2);"
                  >
                    <!-- Project Header Row -->
                    <div class="flex items-center gap-2 px-2.5 py-2">
                      <!-- Project Checkbox under Provider -->
                      <button
                        type="button"
                        role="checkbox"
                        aria-checked={prState === 'all'
                          ? 'true'
                          : prState === 'some'
                            ? 'mixed'
                            : 'false'}
                        aria-label={`Select all ${provGroup.displayName} chats in ${pr.projectName}`}
                        class="checkbox-btn flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded border transition-colors"
                        class:is-checked={prState === 'all' || prState === 'some'}
                        onclick={() => toggleProjectInProviderCategory(pr)}
                        title="Select or deselect all chats in this project"
                      >
                        {#if prState === 'all'}
                          <Check size={10} />
                        {:else if prState === 'some'}
                          <span class="h-0.5 w-1.5 rounded-full bg-current"></span>
                        {/if}
                      </button>

                      <!-- Expand / collapse trigger for this project -->
                      <button
                        type="button"
                        class="flex min-w-0 flex-1 items-center justify-between gap-2 text-left"
                        onclick={() =>
                          toggleProjectInProviderExpand(
                            provGroup.provider,
                            pr.projectPath,
                          )}
                        aria-expanded={isPrExpanded}
                        aria-label={`Toggle project ${pr.projectName}`}
                      >
                        <div class="flex min-w-0 items-center gap-2">
                          <div
                            class="chevron-arrow shrink-0"
                            class:is-open={isPrExpanded}
                            style="color: var(--color-text-muted);"
                          >
                            <ChevronRight size={13} />
                          </div>
                          <FolderGit2
                            size={14}
                            class="shrink-0"
                            style="color: var(--setup-accent);"
                          />
                          <div class="min-w-0">
                            <div class="flex items-center gap-1.5">
                              <span
                                class="truncate text-xs font-medium"
                                style="color: var(--color-text-primary);"
                              >
                                {pr.projectName}
                              </span>
                              {#if selectedInPr > 0}
                                <span
                                  class="rounded-full px-1.5 py-0.2 text-[9px] font-semibold"
                                  style="background: var(--setup-accent); color: var(--setup-on-accent, #17130c);"
                                >
                                  {selectedInPr}
                                </span>
                              {/if}
                            </div>
                            <span
                              class="block truncate font-mono text-[9px]"
                              style="color: var(--color-text-muted);"
                              title={pr.projectPath}
                            >
                              {pr.projectPath}
                            </span>
                          </div>
                        </div>

                        <span
                          class="shrink-0 text-[10px] font-medium"
                          style="color: var(--color-text-muted);"
                        >
                          {pr.chats.length} {pr.chats.length === 1 ? 'chat' : 'chats'}
                        </span>
                      </button>
                    </div>

                    <!-- LEVEL 3: CHATS LIST INSIDE PROJECT -->
                    {#if isPrExpanded}
                      <div
                        transition:slide={{ duration: 180 }}
                        class="divide-y border-t px-2.5 pb-2 pt-1"
                        style="border-color: var(--color-border); background: var(--color-surface-1);"
                      >
                        {#each pr.chats.slice(0, INITIAL_VISIBLE_CHATS) as chat (chat.id)}
                          {@const isSelected = selectedChatIds.has(chat.id)}
                          {@const isPreviewOpen = expandedChatPreviews.has(chat.id)}

                          <div class="py-2 first:pt-1 last:pb-1" data-testid="cli-import-chat-row">
                            <div class="flex items-start gap-2">
                              <!-- Individual Chat Checkbox: Cherry-pick -->
                              <button
                                type="button"
                                role="checkbox"
                                aria-checked={chat.alreadyImported || isSelected ? 'true' : 'false'}
                                disabled={chat.alreadyImported}
                                aria-label={`Select chat ${chat.title}`}
                                class="checkbox-btn mt-0.5 flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded border transition-colors"
                                class:is-checked={chat.alreadyImported || isSelected}
                                class:opacity-50={chat.alreadyImported}
                                onclick={() => toggleChatSelection(chat.id, chat.alreadyImported)}
                              >
                                {#if chat.alreadyImported || isSelected}
                                  <Check size={10} />
                                {/if}
                              </button>

                              <button
                                type="button"
                                class="min-w-0 flex-1 text-left"
                                onclick={() => toggleChatSelection(chat.id, chat.alreadyImported)}
                                disabled={chat.alreadyImported}
                              >
                                <div class="flex flex-wrap items-center gap-1.5">
                                  <span
                                    class="truncate text-xs font-medium"
                                    style="color: var(--color-text-primary);"
                                  >
                                    {chat.title}
                                  </span>
                                  {#if chat.model}
                                    <span
                                      class="rounded px-1.5 py-0.2 font-mono text-[9px]"
                                      style="background: var(--color-surface-2); color: var(--color-text-muted);"
                                    >
                                      {chat.model}
                                    </span>
                                  {/if}
                                  {#if chat.alreadyImported}
                                    <span
                                      class="rounded px-1.5 py-0.2 text-[9px] font-semibold"
                                      style="background: var(--color-surface-3); color: var(--setup-accent);"
                                    >
                                      Ported
                                    </span>
                                  {/if}
                                </div>
                                <p
                                  class="mt-0.5 line-clamp-1 text-[11px]"
                                  style="color: var(--color-text-muted);"
                                >
                                  {chat.preview}
                                </p>
                              </button>

                              <div
                                class="flex shrink-0 items-center gap-1.5 text-[10px]"
                                style="color: var(--color-text-muted);"
                              >
                                <span>{chat.messageCount} msgs</span>
                                {#if chat.updatedAt}
                                  <span>· {formatRelativeTime(chat.updatedAt)}</span>
                                {/if}
                                {#if chat.sampleMessages.length > 0}
                                  <button
                                    type="button"
                                    class="flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-medium transition-colors"
                                    style="background: var(--color-surface-2); color: var(--color-text-secondary);"
                                    onclick={() => toggleChatPreview(chat.id)}
                                    aria-expanded={isPreviewOpen}
                                    aria-label={`Preview messages for ${chat.title}`}
                                  >
                                    <Eye size={10} />
                                    {isPreviewOpen ? 'Hide' : 'Preview'}
                                  </button>
                                {/if}
                              </div>
                            </div>

                            <!-- Sample Turn Preview Accordion -->
                            {#if isPreviewOpen && chat.sampleMessages.length > 0}
                              <div
                                transition:slide={{ duration: 160 }}
                                class="mt-2 ml-5 space-y-1.5 rounded-lg border p-2 text-[11px]"
                                style="border-color: var(--color-border); background: var(--color-surface-2);"
                              >
                                {#each chat.sampleMessages as msg, idx (idx)}
                                  <div class="flex gap-2">
                                    <span
                                      class="w-12 shrink-0 font-mono text-[9px] font-semibold uppercase"
                                      style="color: {msg.role === 'user'
                                        ? 'var(--setup-accent)'
                                        : 'var(--color-text-secondary)'};"
                                    >
                                      {msg.role === 'user' ? 'User' : 'Agent'}
                                    </span>
                                    <p
                                      class="line-clamp-3 flex-1 whitespace-pre-wrap break-words"
                                      style="color: var(--color-text-primary);"
                                    >
                                      {msg.content}
                                    </p>
                                  </div>
                                {/each}
                              </div>
                            {/if}
                          </div>
                        {/each}
                      </div>
                    {/if}
                  </div>
                {/each}
              </div>
            {/if}
          </div>
        {/each}
      {/if}
    {:else}
      <!-- MODE 2: BY-PROJECT DIRECT VIEW -->
      {#if filteredProjects.length === 0}
        <div
          class="flex flex-col items-center justify-center gap-1.5 rounded-xl border py-10 text-center text-xs"
          style="border-color: var(--color-border); color: var(--color-text-muted);"
        >
          <MessageSquare size={18} />
          <span>No projects match your filter.</span>
        </div>
      {:else}
        {#each filteredProjects as { group, matchingChats } (group.projectPath)}
          {@const isExpanded = expandedProjectCards.has(group.projectPath)}
          {@const selectionState = getProjectSelectionState(matchingChats)}
          {@const selectedInProject = matchingChats.filter((c) =>
            selectedChatIds.has(c.id),
          ).length}

          <div
            class="project-card overflow-hidden rounded-xl border transition-colors"
            style="border-color: {selectedInProject > 0
              ? 'var(--setup-accent, var(--color-accent))'
              : 'var(--color-border)'}; background: var(--color-surface-2);"
            data-testid="cli-import-project-card"
          >
            <!-- Project Header -->
            <div class="flex items-center gap-2.5 px-3 py-2.5">
              <button
                type="button"
                role="checkbox"
                aria-checked={selectionState === 'all'
                  ? 'true'
                  : selectionState === 'some'
                    ? 'mixed'
                    : 'false'}
                aria-label={`Select all chats in ${group.projectName}`}
                class="checkbox-btn flex h-4 w-4 shrink-0 items-center justify-center rounded border transition-colors"
                class:is-checked={selectionState === 'all' || selectionState === 'some'}
                onclick={() => toggleProjectSelection(matchingChats)}
              >
                {#if selectionState === 'all'}
                  <Check size={11} />
                {:else if selectionState === 'some'}
                  <span class="h-0.5 w-2 rounded-full bg-current"></span>
                {/if}
              </button>

              <button
                type="button"
                class="flex min-w-0 flex-1 items-center justify-between gap-3 text-left"
                onclick={() => toggleProjectCardExpand(group.projectPath)}
                aria-expanded={isExpanded}
                aria-label={`Toggle project ${group.projectName}`}
              >
                <div class="flex min-w-0 items-center gap-2">
                  <div
                    class="chevron-arrow shrink-0"
                    class:is-open={isExpanded}
                    style="color: var(--color-text-muted);"
                  >
                    <ChevronRight size={14} />
                  </div>
                  <FolderGit2 size={14} class="shrink-0" style="color: var(--setup-accent);" />
                  <div class="min-w-0">
                    <div class="flex items-center gap-2">
                      <span
                        class="truncate text-xs font-semibold"
                        style="color: var(--color-text-primary);"
                      >
                        {group.projectName}
                      </span>
                      {#if selectedInProject > 0}
                        <span
                          class="rounded-full px-1.5 py-0.5 text-[10px] font-semibold"
                          style="background: var(--setup-accent); color: var(--setup-on-accent, #17130c);"
                        >
                          {selectedInProject} selected
                        </span>
                      {/if}
                    </div>
                    <span
                      class="block truncate font-mono text-[10px]"
                      style="color: var(--color-text-muted);"
                      title={group.projectPath}
                    >
                      {group.projectPath}
                    </span>
                  </div>
                </div>

                <div class="flex shrink-0 items-center gap-1.5">
                  <div class="flex items-center gap-1">
                    {#each group.providers.slice(0, 4) as prov (prov.provider)}
                      <span
                        class="flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-[10px]"
                        style="border-color: var(--color-border); background: var(--color-surface-1); color: var(--color-text-secondary);"
                      >
                        <ProviderIcon provider={prov.provider} size={11} />
                        <span>{prov.chatCount}</span>
                      </span>
                    {/each}
                  </div>
                  <span class="text-[11px] font-medium" style="color: var(--color-text-muted);">
                    {matchingChats.length} {matchingChats.length === 1 ? 'chat' : 'chats'}
                  </span>
                </div>
              </button>
            </div>

            <!-- Expanded Project Chats -->
            {#if isExpanded}
              <div
                transition:slide={{ duration: 200 }}
                class="divide-y border-t px-3 pb-2.5 pt-2"
                style="border-color: var(--color-border); background: var(--color-surface-1);"
              >
                {#each matchingChats.slice(0, INITIAL_VISIBLE_CHATS) as chat (chat.id)}
                  {@const isSelected = selectedChatIds.has(chat.id)}
                  {@const isPreviewOpen = expandedChatPreviews.has(chat.id)}
                  <div class="py-2 first:pt-0.5 last:pb-0.5">
                    <div class="flex items-start gap-2.5">
                      <button
                        type="button"
                        role="checkbox"
                        aria-checked={chat.alreadyImported || isSelected ? 'true' : 'false'}
                        disabled={chat.alreadyImported}
                        aria-label={`Select chat ${chat.title}`}
                        class="checkbox-btn mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded border transition-colors"
                        class:is-checked={chat.alreadyImported || isSelected}
                        class:opacity-50={chat.alreadyImported}
                        onclick={() => toggleChatSelection(chat.id, chat.alreadyImported)}
                      >
                        {#if chat.alreadyImported || isSelected}
                          <Check size={11} />
                        {/if}
                      </button>

                      <button
                        type="button"
                        class="min-w-0 flex-1 text-left"
                        onclick={() => toggleChatSelection(chat.id, chat.alreadyImported)}
                        disabled={chat.alreadyImported}
                      >
                        <div class="flex flex-wrap items-center gap-1.5">
                          <span
                            class="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-medium"
                            style="background: var(--color-surface-3); color: var(--color-text-secondary);"
                          >
                            <ProviderIcon provider={chat.provider} size={10} />
                            <span>{chat.providerDisplayName}</span>
                          </span>
                          <span
                            class="truncate text-xs font-medium"
                            style="color: var(--color-text-primary);"
                          >
                            {chat.title}
                          </span>
                          {#if chat.model}
                            <span
                              class="rounded px-1.5 py-0.5 font-mono text-[10px]"
                              style="background: var(--color-surface-2); color: var(--color-text-muted);"
                            >
                              {chat.model}
                            </span>
                          {/if}
                          {#if chat.alreadyImported}
                            <span
                              class="rounded px-1.5 py-0.5 text-[10px] font-semibold"
                              style="background: var(--color-surface-3); color: var(--setup-accent);"
                            >
                              Ported
                            </span>
                          {/if}
                        </div>
                        <p
                          class="mt-0.5 line-clamp-1 text-[11px]"
                          style="color: var(--color-text-muted);"
                        >
                          {chat.preview}
                        </p>
                      </button>

                      <div
                        class="flex shrink-0 items-center gap-2 text-[10px]"
                        style="color: var(--color-text-muted);"
                      >
                        <span>{chat.messageCount} msgs</span>
                        {#if chat.updatedAt}
                          <span>· {formatRelativeTime(chat.updatedAt)}</span>
                        {/if}
                      </div>
                    </div>
                  </div>
                {/each}
              </div>
            {/if}
          </div>
        {/each}
      {/if}
    {/if}
  </div>

  <!-- Selection Summary & Port Action Bar -->
  <div
    class="flex flex-wrap items-center justify-between gap-3 rounded-xl border px-3.5 py-2.5"
    style="border-color: var(--color-border); background: var(--color-surface-2);"
  >
    <div class="text-xs" style="color: var(--color-text-secondary);">
      {#if selectedCount > 0}
        <span class="font-semibold" style="color: var(--color-text-primary);">
          {selectedCount} {selectedCount === 1 ? 'chat' : 'chats'} selected
        </span>
        <span>
          across {selectedProjectCount} {selectedProjectCount === 1 ? 'project' : 'projects'}
          and {selectedProviderCount} {selectedProviderCount === 1 ? 'provider' : 'providers'}
        </span>
      {:else if alreadyImportedTotal > 0 || sessionImportedCount > 0}
        <span class="font-medium" style="color: var(--setup-accent);">
          {Math.max(sessionImportedCount, alreadyImportedTotal)}
          {Math.max(sessionImportedCount, alreadyImportedTotal) === 1 ? 'chat' : 'chats'} ported to Koryphaios
        </span>
      {:else}
        <span>Expand any provider above to cherry-pick chats or select an entire category.</span>
      {/if}
    </div>

    <button
      type="button"
      class="port-action-btn inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-semibold transition-colors disabled:opacity-40"
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
  .chevron-arrow {
    display: inline-flex;
    transition: transform 0.2s cubic-bezier(0.16, 1, 0.3, 1);
  }
  .chevron-arrow.is-open {
    transform: rotate(90deg);
  }

  .view-switch-btn {
    color: var(--color-text-muted);
  }
  .view-switch-btn:hover {
    color: var(--color-text-primary);
  }
  .view-switch-btn.is-active {
    background: var(--color-surface-1);
    color: var(--color-text-primary);
    box-shadow: 0 1px 2px rgba(0, 0, 0, 0.08);
  }

  .checkbox-btn {
    border-color: var(--color-border-bright, var(--color-border));
    background: var(--color-surface-1);
    color: transparent;
  }
  .checkbox-btn.is-checked {
    border-color: var(--setup-accent, var(--color-accent));
    background: var(--setup-accent, var(--color-accent));
    color: var(--setup-on-accent, #17130c);
  }

  .port-action-btn {
    background: var(--setup-accent, var(--color-accent));
    color: var(--setup-on-accent, #17130c);
  }
  .port-action-btn:hover:not(:disabled) {
    background: var(--setup-accent-hover, var(--color-accent));
  }
</style>
