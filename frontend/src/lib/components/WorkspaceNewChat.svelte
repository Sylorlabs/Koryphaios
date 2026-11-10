<script lang="ts">
  /**
   * Workspace new-chat screen.
   *
   * Shown in the feed area when a workspace is open but no chat is selected.
   * Instead of dumping every workspace folder into the sidebar, this screen
   * lets the user pick the folder the new chat should live in. Picking a
   * folder hands the path to the page, which selects the authoritative
   * project and creates a fresh session (same as the `select_project:` menu
   * action).
   */
  import {
    projectIdentityProjection,
    projectStore,
    projectDisplayName,
  } from '$lib/stores/project.svelte';
  import { sessionStore } from '$lib/stores/sessions.svelte';
  import ProjectIcon from './ProjectIcon.svelte';
  import FolderPlus from 'lucide-svelte/icons/folder-plus';
  import FolderTree from 'lucide-svelte/icons/folder-tree';
  import FolderSearch from 'lucide-svelte/icons/folder-search';
  import MessageSquare from 'lucide-svelte/icons/message-square';
  import ArrowRight from 'lucide-svelte/icons/arrow-right';
  import Search from 'lucide-svelte/icons/search';
  import LoaderCircle from 'lucide-svelte/icons/loader-circle';
  import CornerDownRight from 'lucide-svelte/icons/corner-down-right';

  interface Props {
    /** Select the folder and start a new chat in it. */
    onSelectFolder: (path: string) => Promise<unknown> | unknown;
    /** Native folder picker for a folder outside the listed ones. */
    onBrowseFolder: () => void;
    /** Switch to another workspace root. */
    onOpenWorkspace: () => void;
    /** Create a new project folder. */
    onNewProject: () => void;
  }

  let { onSelectFolder, onBrowseFolder, onOpenWorkspace, onNewProject }: Props = $props();

  interface FolderOption {
    path: string;
    name: string;
    chatCount: number;
    lastActivity: number;
    identity: ReturnType<typeof projectIdentityProjection>;
  }

  let query = $state('');
  let selectingPath = $state('');
  let searchInput = $state<HTMLInputElement | null>(null);

  const root = $derived(projectStore.workspaceRoot);
  const rootName = $derived(projectDisplayName(root));

  const allFolders = $derived.by((): FolderOption[] => {
    return (projectStore.workspaceProjects ?? [])
      .filter((project) => project.path !== root)
      .map((project) => {
        const chats = sessionStore.sessionsForProject(project.path);
        const lastChat = chats.reduce((latest, session) => Math.max(latest, session.updatedAt), 0);
        const identity = projectIdentityProjection(project);
        return {
          path: project.path,
          name: project.name || projectDisplayName(project.path),
          chatCount: chats.length,
          lastActivity: Math.max(lastChat, project.modifiedAt),
          identity,
        };
      })
      .sort((left, right) => {
        // Folders you've already chatted in float to the top, then most recent.
        const leftHasChats = left.chatCount > 0 ? 1 : 0;
        const rightHasChats = right.chatCount > 0 ? 1 : 0;
        if (leftHasChats !== rightHasChats) return rightHasChats - leftHasChats;
        return right.lastActivity - left.lastActivity;
      });
  });

  const folders = $derived.by((): FolderOption[] => {
    const needle = query.trim().toLowerCase();
    if (!needle) return allFolders;
    return allFolders.filter((folder) => folder.name.toLowerCase().includes(needle));
  });

  const rootChatCount = $derived(root ? sessionStore.sessionsForProject(root).length : 0);

  function relativeTime(timestamp: number): string {
    if (!timestamp) return '';
    const diff = Date.now() - timestamp;
    const minute = 60_000;
    const hour = 60 * minute;
    const day = 24 * hour;
    if (diff < minute) return 'just now';
    if (diff < hour) return `${Math.floor(diff / minute)}m ago`;
    if (diff < day) return `${Math.floor(diff / hour)}h ago`;
    if (diff < 7 * day) return `${Math.floor(diff / day)}d ago`;
    return new Date(timestamp).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  }

  function chatCountLabel(count: number): string {
    if (count === 0) return 'No chats yet';
    return `${count} ${count === 1 ? 'chat' : 'chats'}`;
  }

  async function choose(path: string) {
    if (selectingPath) return;
    selectingPath = path;
    try {
      await onSelectFolder(path);
    } finally {
      selectingPath = '';
    }
  }

  function handleSearchKeydown(event: KeyboardEvent) {
    if (event.key === 'Enter' && folders.length > 0) {
      event.preventDefault();
      void choose(folders[0].path);
    }
  }

  $effect(() => {
    // Search is the primary affordance on this screen; land the cursor there
    // when there is something to search.
    if (allFolders.length > 0) searchInput?.focus();
  });
</script>

<div
  class="workspace-new-chat flex-1 min-h-0 overflow-y-auto"
  style="background: var(--color-surface-1);"
  data-testid="workspace-new-chat"
>
  <div class="mx-auto w-full max-w-4xl px-6 py-8 sm:px-10 sm:py-12">
    <!-- Header -->
    <header class="mb-8 flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
      <div class="min-w-0">
        <div
          class="mb-2 flex items-center gap-2 text-[10px] font-semibold uppercase tracking-[0.16em]"
          style="color: var(--color-text-muted);"
        >
          <FolderTree size={12} />
          <span>Workspace</span>
        </div>
        <h2
          class="flex min-w-0 items-center gap-3 text-2xl font-semibold leading-tight"
          style="color: var(--color-text-primary);"
        >
          <span class="truncate">New chat in {rootName}</span>
        </h2>
        <p
          class="mt-1.5 truncate font-mono text-[11px]"
          style="color: var(--color-text-muted);"
          title={root ?? ''}
        >
          {root}
        </p>
      </div>
    </header>

    <!-- Search -->
    <label
      class="search-field mb-5 flex items-center gap-2.5 rounded-xl border px-3.5 py-2.5 transition-colors"
      style="border-color: var(--color-border); background: var(--color-surface-2);"
    >
      <Search size={15} style="color: var(--color-text-muted);" />
      <input
        bind:this={searchInput}
        bind:value={query}
        type="search"
        class="min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-[var(--color-text-muted)]"
        style="color: var(--color-text-primary);"
        placeholder={`Search ${allFolders.length} ${allFolders.length === 1 ? 'folder' : 'folders'}…`}
        aria-label="Search workspace folders"
        onkeydown={handleSearchKeydown}
        autocomplete="off"
        spellcheck="false"
      />
      {#if folders.length > 0 && query.trim()}
        <span
          class="hidden items-center gap-1 text-[10px] sm:flex"
          style="color: var(--color-text-muted);"
        >
          <CornerDownRight size={11} /> opens {folders[0].name}
        </span>
      {/if}
    </label>

    <!-- Folder grid -->
    {#if folders.length > 0}
      <ul class="folder-grid grid gap-2.5" aria-label="Workspace folders">
        {#each folders as folder, index (folder.path)}
          {@const busy = selectingPath === folder.path}
          <!-- The <li> carries the entrance animation so the card's hover lift
               isn't overridden by a retained animation transform. -->
          <li
            class="folder-card-enter min-w-0"
            style="animation-delay: {Math.min(index, 12) * 22}ms;"
          >
            <button
              type="button"
              class="folder-card group relative flex w-full min-w-0 items-center gap-3 rounded-xl border px-3.5 py-3 text-left transition-all duration-150 hover:-translate-y-0.5 disabled:cursor-wait disabled:opacity-70"
              class:has-chats={folder.chatCount > 0}
              style="border-color: var(--color-border); background: var(--color-surface-2);"
              title={folder.path}
              disabled={Boolean(selectingPath)}
              onclick={() => void choose(folder.path)}
              aria-label={`Start a new chat in ${folder.name}. ${chatCountLabel(folder.chatCount)}`}
            >
              <span class="relative flex h-9 w-9 shrink-0 items-center justify-center">
                {#if busy}
                  <ProjectIcon
                    identity={folder.identity.identity}
                    icon={folder.identity.identity.icon}
                    size={36}
                  />
                  <span
                    class="absolute inset-0 flex items-center justify-center rounded-lg"
                    style="background: color-mix(in srgb, var(--color-surface-2) 70%, transparent);"
                  >
                    <LoaderCircle
                      size={16}
                      class="animate-spin"
                      style="color: var(--color-accent);"
                    />
                  </span>
                {:else}
                  <ProjectIcon
                    identity={folder.identity.identity}
                    icon={folder.identity.identity.icon}
                    size={36}
                  />
                {/if}
              </span>
              <span class="min-w-0 flex-1">
                <span
                  class="block truncate text-sm font-semibold"
                  style="color: var(--color-text-primary);"
                >
                  {folder.name}
                </span>
                <span
                  class="mt-0.5 flex items-center gap-1.5 text-[11px]"
                  style="color: var(--color-text-muted);"
                >
                  {#if folder.chatCount > 0}
                    <MessageSquare size={11} />
                    <span>{chatCountLabel(folder.chatCount)}</span>
                    <span aria-hidden="true">·</span>
                    <span>{relativeTime(folder.lastActivity)}</span>
                  {:else}
                    <span>{chatCountLabel(0)}</span>
                  {/if}
                </span>
              </span>
              <span
                class="folder-arrow flex h-6 w-6 shrink-0 items-center justify-center rounded-md opacity-0 transition-all duration-150 group-hover:opacity-100 group-focus-visible:opacity-100"
                style="color: var(--color-accent);"
                aria-hidden="true"
              >
                <ArrowRight size={14} />
              </span>
            </button>
          </li>
        {/each}
      </ul>
    {:else if allFolders.length === 0}
      <div
        class="rounded-xl border border-dashed px-6 py-10 text-center"
        style="border-color: var(--color-border);"
      >
        <FolderSearch size={22} class="mx-auto mb-3" style="color: var(--color-text-muted);" />
        <p class="text-sm font-medium" style="color: var(--color-text-primary);">
          This workspace has no folders yet
        </p>
        <p class="mt-1 text-xs" style="color: var(--color-text-muted);">
          Create a project or chat at the workspace root below.
        </p>
      </div>
    {:else}
      <div
        class="rounded-xl border border-dashed px-6 py-8 text-center"
        style="border-color: var(--color-border);"
      >
        <p class="text-sm" style="color: var(--color-text-secondary);">
          No folders match <strong style="color: var(--color-text-primary);">{query.trim()}</strong>
        </p>
      </div>
    {/if}

    <!-- Workspace root + other entry points -->
    <div
      class="mt-8 flex flex-col gap-2 border-t pt-6 sm:flex-row sm:items-center sm:justify-between"
      style="border-color: var(--color-border);"
    >
      {#if root}
        <button
          type="button"
          class="root-option flex min-w-0 items-center gap-2 rounded-lg px-2.5 py-2 text-left text-xs transition-colors hover:bg-[var(--color-surface-2)] disabled:cursor-wait disabled:opacity-70"
          style="color: var(--color-text-secondary);"
          title={root}
          disabled={Boolean(selectingPath)}
          onclick={() => void choose(root)}
          aria-label={`Start a new chat in ${rootName} itself. ${chatCountLabel(rootChatCount)}`}
        >
          {#if selectingPath === root}
            <LoaderCircle size={13} class="shrink-0 animate-spin" />
          {:else}
            <FolderTree size={13} class="shrink-0" />
          {/if}
          <span class="truncate">
            Chat in <strong style="color: var(--color-text-primary);">{rootName}</strong> itself
            <span style="color: var(--color-text-muted);">· {chatCountLabel(rootChatCount)}</span>
          </span>
        </button>
      {/if}

      <div class="flex flex-wrap items-center gap-1.5">
        <button
          type="button"
          class="secondary-action flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-xs font-medium transition-colors hover:bg-[var(--color-surface-2)]"
          style="border-color: var(--color-border); color: var(--color-text-secondary);"
          onclick={onBrowseFolder}
        >
          <FolderSearch size={13} /> Browse other folder…
        </button>
        <button
          type="button"
          class="secondary-action flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-xs font-medium transition-colors hover:bg-[var(--color-surface-2)]"
          style="border-color: var(--color-border); color: var(--color-text-secondary);"
          onclick={onNewProject}
        >
          <FolderPlus size={13} /> New project
        </button>
        <button
          type="button"
          class="secondary-action flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-medium transition-colors hover:bg-[var(--color-surface-2)]"
          style="color: var(--color-text-muted);"
          onclick={onOpenWorkspace}
        >
          Switch workspace
        </button>
      </div>
    </div>
  </div>
</div>

<style>
  .folder-grid {
    grid-template-columns: repeat(auto-fill, minmax(230px, 1fr));
  }

  .folder-card-enter {
    animation: folder-card-in 260ms cubic-bezier(0.2, 0.7, 0.2, 1) both;
  }

  .folder-card:hover,
  .folder-card:focus-visible {
    border-color: rgba(var(--color-accent-rgb), 0.55) !important;
    box-shadow:
      0 6px 18px -10px rgba(0, 0, 0, 0.6),
      0 0 0 1px rgba(var(--color-accent-rgb), 0.18);
    outline: none;
  }

  .folder-card:hover .folder-arrow {
    transform: translateX(2px);
  }

  .search-field:focus-within {
    border-color: rgba(var(--color-accent-rgb), 0.55) !important;
    box-shadow: 0 0 0 3px rgba(var(--color-accent-rgb), 0.12);
  }

  @keyframes folder-card-in {
    from {
      opacity: 0;
      transform: translateY(6px);
    }
    to {
      opacity: 1;
      transform: translateY(0);
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .folder-card-enter {
      animation: none;
    }
    .folder-card:hover {
      transform: none;
    }
  }
</style>
