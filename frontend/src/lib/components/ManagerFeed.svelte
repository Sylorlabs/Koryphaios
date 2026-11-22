<script lang="ts">
  import { wsStore } from '$lib/stores/websocket.svelte';
  import { sessionStore } from '$lib/stores/sessions.svelte';
  import { feedStore } from '$lib/stores/feed.svelte';
  import { toastStore } from '$lib/stores/toast.svelte';
  import { onMount, untrack } from 'svelte';
  import { fade } from 'svelte/transition';
  import { projectStore } from '$lib/stores/project.svelte';
  import ArrowDown from 'lucide-svelte/icons/arrow-down';
  import Paintbrush from 'lucide-svelte/icons/paintbrush';
  import Bug from 'lucide-svelte/icons/bug';
  import Zap from 'lucide-svelte/icons/zap';
  import GitBranch from 'lucide-svelte/icons/git-branch';
  import Pencil from 'lucide-svelte/icons/pencil';
  import Check from 'lucide-svelte/icons/check';
  import X from 'lucide-svelte/icons/x';
  import LoaderCircle from 'lucide-svelte/icons/loader-circle';
  import Bot from 'lucide-svelte/icons/bot';
  import Terminal from 'lucide-svelte/icons/terminal';
  import Layers from 'lucide-svelte/icons/layers';
  import Sparkles from 'lucide-svelte/icons/sparkles';
  import WelcomeCardIcon from './WelcomeCardIcon.svelte';
  import WelcomeBackground from './WelcomeBackground.svelte';
  import CliChatImportPanel from './CliChatImportPanel.svelte';
  import Download from 'lucide-svelte/icons/download';
  import { apiFetch } from '$lib/api.svelte';
  import { apiUrl } from '$lib/utils/api-url';
  import {
    NO_IMPORTABLE_CHATS,
    dismissImportHint,
    fetchImportableSummary,
    importHintText,
    isImportHintDismissed,
    shouldShowImportHint,
    type ImportableSummary,
  } from '$lib/utils/cli-chat-import-hint';
  import FeedEntry from './FeedEntry.svelte';
  import VirtualList from './VirtualList.svelte';
  import ChatLoading from './ChatLoading.svelte';
  import type { FeedEntryLocal } from '$lib/types';
  import { createAutoScroll } from '$lib/utils/autoscroll.svelte';
  import { estimateFeedHeight as estimateRowHeight } from '$lib/utils/estimate-row-height';
  import { welcomePreferencesStore } from '$lib/stores/welcome-preferences.svelte';
  import {
    feedChromeColors,
    type WelcomeTextColor,
  } from '$lib/utils/welcome-background-contrast';

  let virtualList = $state<VirtualList<FeedEntryLocal>>();
  let expandedGroups = $state<Set<string>>(new Set());
  let editingSuggestionId = $state<string | null>(null);
  let editingSuggestionText = $state('');
  let welcomeTextColor = $state<WelcomeTextColor | undefined>();
  const feedChrome = $derived(feedChromeColors(welcomeTextColor));

  interface Props {
    onUseSuggestion?: (prompt: string) => void;
    /** No project or chat exists yet, so the start window owns the whole middle. */
    centered?: boolean;
  }

  let { onUseSuggestion, centered = false }: Props = $props();

  // First-run import hint: one line on the empty start view when CLI chats on
  // disk are not in Koryphaios yet. Its panel is the existing import panel.
  let importSummary = $state<ImportableSummary>(NO_IMPORTABLE_CHATS);
  let importDismissed = $state(isImportHintDismissed());
  let importPanelOpen = $state(false);
  const showImportHint = $derived(shouldShowImportHint(importSummary, importDismissed));

  async function refreshImportHint() {
    importSummary = await fetchImportableSummary(() =>
      apiFetch(apiUrl('/api/cli-chat-import/discover')),
    );
  }

  function dismissImport() {
    importDismissed = true;
    importPanelOpen = false;
    dismissImportHint();
  }

  onMount(() => {
    if (!importDismissed) void refreshImportHint();
  });

  type DashboardSuggestion = {
    id: string;
    label: string;
    icon: typeof Zap;
    iconName: 'sparkles' | 'paintbrush' | 'git-branch' | 'bug' | 'zap' | 'bot' | 'terminal' | 'layers';
    prompt: string;
    provider?: string;
    model?: string;
    reasoning?: string;
    permission?: string;
    skills?: string[];
    iconSource?: string;
  };

  const defaultSuggestions: DashboardSuggestion[] = [
    {
      id: 'map-codebase',
      label: 'Map the codebase',
      icon: Zap,
      iconName: 'zap',
      prompt:
        'Inspect this project and summarize the architecture, key entry points, and the highest-leverage next steps.',
    },
    {
      id: 'critique-ui',
      label: 'Critique the UI',
      icon: Paintbrush,
      iconName: 'paintbrush',
      prompt:
        'Critique the current UI in this project, identify the weakest hierarchy and spacing choices, and recommend the most important visual fixes.',
    },
    {
      id: 'review-changes',
      label: 'Review recent changes',
      icon: GitBranch,
      iconName: 'git-branch',
      prompt:
        'Review the current uncommitted changes in this project and identify the most likely bugs, regressions, or missing tests.',
    },
    {
      id: 'debug-regression',
      label: 'Debug a regression',
      icon: Bug,
      iconName: 'bug',
      prompt:
        'Help me trace a bug in this project. Start by asking for the failing behavior or error, then narrow the likely root cause.',
    },
  ];

  const workspaceSuggestions: DashboardSuggestion[] = [
    {
      id: 'map-workspace',
      label: 'Map the workspace',
      icon: Zap,
      iconName: 'zap',
      prompt:
        'Inspect this workspace and summarize the projects, key entry points, and the highest-leverage next steps.',
    },
    {
      id: 'review-workspace',
      label: 'Review workspace changes',
      icon: GitBranch,
      iconName: 'git-branch',
      prompt:
        'Review the current uncommitted changes across all projects in this workspace and identify the most likely bugs, regressions, or missing tests.',
    },
    {
      id: 'manage-projects',
      label: 'Manage projects',
      icon: Paintbrush,
      iconName: 'paintbrush',
      prompt:
        'Help me manage the projects in this workspace. Add, remove, or organize them, and recommend the most important setup fixes.',
    },
    {
      id: 'debug-workspace',
      label: 'Debug across workspace',
      icon: Bug,
      iconName: 'bug',
      prompt:
        'Help me trace a bug across this workspace. Start by asking for the failing behavior or error, then narrow the likely root cause.',
    },
  ];

  let isWorkspaceReady = $derived(
    !!projectStore.revision || !!projectStore.workspaceRoot || !!projectStore.currentPath,
  );
  let isWorkspace = $derived(
    isWorkspaceReady && !!projectStore.workspaceRoot && !projectStore.currentPath,
  );
  let suggestions = $state<DashboardSuggestion[]>(defaultSuggestions);
  const iconMap = { zap: Zap, paintbrush: Paintbrush, 'git-branch': GitBranch, bug: Bug, sparkles: Sparkles, bot: Bot, terminal: Terminal, layers: Layers } as const;

  $effect(() => {
    const source = isWorkspace ? workspaceSuggestions : defaultSuggestions;
    const savedPrompts = welcomePreferencesStore.preferences.suggestionPrompts;
    const cards = welcomePreferencesStore.preferences.suggestionCards;
    const custom = Object.entries(cards)
      .filter(([id, card]) => !source.some((suggestion) => suggestion.id === id) && card.enabled)
      .map(([id, card]) => ({
         id, label: card.label, icon: iconMap[card.icon] ?? Sparkles, iconName: card.icon,
         prompt: card.prompt, provider: card.provider, model: card.model, iconSource: card.iconSource,
        reasoning: card.reasoning, permission: card.permission, skills: card.skills,
      }));
    suggestions = [...source.filter((suggestion) => isWorkspace || suggestion.id in cards), ...custom]
      .map((suggestion) => {
        const card = cards[suggestion.id];
        return {
          ...suggestion,
           ...(card ? { label: card.label, icon: iconMap[card.icon] ?? suggestion.icon, iconName: card.icon, iconSource: card.iconSource, provider: card.provider, model: card.model, reasoning: card.reasoning, permission: card.permission, skills: card.skills } : {}),
          prompt: savedPrompts[suggestion.id] ?? card?.prompt ?? suggestion.prompt,
        };
      })
      .filter((suggestion) => cards[suggestion.id]?.enabled !== false);
  });

  let filteredFeed = $derived(wsStore.groupedFeed);
  let isManagerStreaming = $derived(
    wsStore.managerStatus === 'streaming' || wsStore.managerStatus === 'thinking',
  );

  // -- Autoscroll ----------------------------------------------------------
  // Welcome suggestions are a document that starts at the top, not a transcript
  // to pin to its latest entry. Only attach autoscroll to actual messages.
  let scrollEl = $derived<HTMLDivElement | undefined>(
    filteredFeed.length === 0 ? undefined : virtualList?.getScrollElement(),
  );
  // VirtualList owns the transcript's measured scroll extent and bottom pin.
  // Do not also watch every DOM mutation here: markdown streaming can produce
  // dozens of character mutations per second, and a second pinning loop made
  // the browser continually reconcile two different scroll heights.
  // Pixels from the bottom that still count as "reading the latest message".
  const FOLLOW_THRESHOLD = 100;
  const autoScrollCtl = createAutoScroll(() => scrollEl, {
    threshold: FOLLOW_THRESHOLD,
    observeMutations: false,
  });

  // Attach the scroll/observer listeners whenever the container element
  // changes (e.g. empty-state ↔ VirtualList). We do this in an effect
  // that reads `scrollEl` and explicitly calls `attach()`. The `attach`
  // call is not tracked, so it cannot cause an update loop.
  $effect(() => {
    void scrollEl;
    if (scrollEl) untrack(() => autoScrollCtl.attach());
    else if (typeof autoScrollCtl.destroy === 'function')
      untrack(() => autoScrollCtl.destroy());
  });

  // `follow` lives in one controller for the life of the feed, but it describes
  // one transcript at a time. Carrying a parked position into the next chat
  // makes its first paint draw the top of the transcript; the restore callback
  // then flips follow back on and the bottom pin walks the whole chat down.
  // Start every session bottom-anchored. A reader who was genuinely parked is
  // restored by onRestoreState as soon as the list lands.
  let landedSessionId = $state('');
  $effect(() => {
    const id = sessionStore.activeSessionId;
    if (!id) return;
    untrack(() => {
      landedSessionId = '';
      // Opening a chat is not following a live agent. The list owns the initial
      // position; autoscroll must not write scrollTop until it has landed.
      autoScrollCtl.setSuspended(true);
      autoScrollCtl.setFollow(true);
    });
  });

  // Rows mount from estimates and are measured over the next few frames. Keep
  // an opaque surface over the list until the landing has stopped moving, so
  // the reader sees a spinner and then the finished chat at the bottom — never
  // the rows converging underneath it.
  let showLoadingSurface = $derived(
    wsStore.isLoadingSession ||
      (filteredFeed.length > 0 && landedSessionId !== sessionStore.activeSessionId),
  );

  function handleTranscriptLanded() {
    landedSessionId = untrack(() => sessionStore.activeSessionId);
    // The transcript is placed. From here autoscroll may follow the agent.
    autoScrollCtl.setSuspended(false);
  }

  // Rows that render as live this tick. Answer text keeps streaming into the
  // row its turn opened even when tool cards were added after it, so the
  // streaming treatment follows the text row, not just the last row.
  let streamingRowIndexes = $derived.by(() => {
    const indexes = new Set<number>();
    if (!isManagerStreaming) return indexes;
    if (filteredFeed.length > 0) indexes.add(filteredFeed.length - 1);
    const lastContent = filteredFeed.findLastIndex((entry) => entry.type === 'content');
    if (lastContent >= 0) indexes.add(lastContent);
    return indexes;
  });

  // Per-token streaming signal: tracks the text length of the streaming rows
  // so we can keep the view pinned during fast streaming.
  let streamingTextSig = $derived.by(() => {
    let length = 0;
    for (const index of streamingRowIndexes) {
      length += filteredFeed[index]?.text?.length ?? 0;
    }
    return length;
  });

  // Pin on per-token text growth (no counter increment).
  $effect(() => {
    void streamingTextSig;
    if (filteredFeed.length > 0) autoScrollCtl.requestPin();
  });

  // Bump the "N new messages" counter only when a *new entry* is added
  // to the feed (not on per-token updates of an existing entry).
  $effect(() => {
    void filteredFeed.length;
    if (filteredFeed.length > 0) autoScrollCtl.notifyNewEntry();
  });

  // Sending a message is the reader's own action, and a chat that was working
  // when they sent should not strand them mid-transcript. Trust the
  // autoscroll controller's tracked follow state (kept honest by reader
  // gestures) rather than a distance-from-bottom sample taken while the
  // transcript is still converging; a streaming row can add well over the
  // threshold in a single frame, which used to release follow on send.
  // A reader who had deliberately parked stays parked; a reader who was
  // following is re-pinned the moment their turn lands.
  $effect(() => {
    void feedStore.userSendRevision;
    if (filteredFeed.length === 0) return;
    if (autoScrollCtl.follow) autoScrollCtl.jumpToBottom('instant');
  });

  function estimateFeedHeight(entry: FeedEntryLocal): number {
    return estimateRowHeight(entry);
  }

  function toggleGroup(id: string) {
    if (expandedGroups.has(id)) {
      expandedGroups.delete(id);
    } else {
      expandedGroups.add(id);
    }
    expandedGroups = new Set(expandedGroups);
  }

  // Row selection removed — per-entry visibility controls (hide-from-agent /
  // hide-from-me / delete) replaced the select-then-bulk-delete flow.
  function handleEntryClick(_entry: FeedEntryLocal, _e: MouseEvent) {}

  async function deleteSingle(entry: FeedEntryLocal, messageId?: string) {
    try {
      await feedStore.deleteEntry(entry, messageId);
    } catch (error) {
      const detail = error instanceof Error ? error.message : 'Message deletion failed.';
      toastStore.error(detail);
    }
  }

  function runSuggestion(prompt: string) {
    onUseSuggestion?.(prompt);
  }

  function runConfiguredSuggestion(suggestion: DashboardSuggestion) {
    const skillHint = suggestion.skills?.length ? `\n\nUse these skills for this task: ${suggestion.skills.join(', ')}.` : '';
    window.dispatchEvent(new CustomEvent('kory:home-preset', {
      detail: { provider: suggestion.provider, model: suggestion.model, reasoning: suggestion.reasoning, permission: suggestion.permission, skills: suggestion.skills ?? [] },
    }));
    runSuggestion(`${suggestion.prompt}${skillHint}`);
  }

  function startEditingSuggestion(suggestion: DashboardSuggestion) {
    editingSuggestionId = suggestion.id;
    editingSuggestionText = suggestion.prompt;
  }

  function cancelEditingSuggestion() {
    editingSuggestionId = null;
    editingSuggestionText = '';
  }

  function saveSuggestionEdit(id: string) {
    const nextText = editingSuggestionText.trim();
    if (!nextText) return;
    welcomePreferencesStore.updateSuggestion(id, nextText);
    suggestions = suggestions.map((suggestion) =>
      suggestion.id === id ? { ...suggestion, prompt: nextText } : suggestion,
    );
    editingSuggestionId = null;
    editingSuggestionText = '';
  }
</script>

<div class="flex flex-col flex-1 overflow-hidden">
  <div
    class="relative flex-1 min-h-0 overflow-hidden"
    style:--feed-chrome-fg={feedChrome.fg}
    style:--feed-chrome-fg-hover={feedChrome.fgHover}
    style:--feed-chrome-hover-bg={feedChrome.hoverBg}
  >
    <!-- Keep the selected home background mounted while the chat is active,
      too. Starting a prompt changes the feed, not the user's appearance choice. -->
    <div class="welcome-background-layer" aria-hidden="true">
      <WelcomeBackground
        background={welcomePreferencesStore.preferences.background}
        baseSurface="surface-0"
        onTextColor={(color) => (welcomeTextColor = color)}
      />
    </div>
    {#if wsStore.isLoadingSession}
      <ChatLoading transparent={!!welcomePreferencesStore.preferences.background?.source} />
    {:else if !isWorkspaceReady && filteredFeed.length === 0}
      <div class="absolute inset-0 flex items-center justify-center p-6">
        <div
          class="flex items-center gap-3 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-2)] px-4 py-3 text-sm text-[var(--color-text-secondary)] shadow-lg"
        >
          <LoaderCircle size={18} class="animate-spin text-[var(--color-accent)]" />
          <span>Loading workspace…</span>
        </div>
      </div>
    {:else if filteredFeed.length === 0}
      <div
        class="absolute inset-0 overflow-y-auto p-4 feed-scroll"
        class:items-center={centered}
        class:justify-center={centered}
        class:flex={centered}
      >
        {#if showImportHint}
          <div class="relative mx-auto mb-4 max-w-3xl px-2 sm:px-4">
            <div
              class="flex items-center gap-3 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-1)] px-3 py-2 text-sm text-[var(--color-text-secondary)]"
            >
              <Download size={14} class="shrink-0 text-[var(--color-accent)]" />
              <span class="min-w-0 flex-1 truncate">{importHintText(importSummary)}</span>
              <button
                type="button"
                class="shrink-0 rounded-md px-2 py-1 text-xs font-medium text-[var(--color-accent)] hover:bg-[var(--color-surface-3)]"
                aria-expanded={importPanelOpen}
                onclick={() => (importPanelOpen = !importPanelOpen)}
              >
                {importPanelOpen ? 'Hide' : 'Review'}
              </button>
              <button
                type="button"
                class="shrink-0 rounded-md p-1 opacity-70 hover:bg-[var(--color-surface-3)] hover:opacity-100"
                aria-label="Dismiss import suggestion"
                onclick={dismissImport}
              >
                <X size={14} />
              </button>
            </div>
            {#if importPanelOpen}
              <!-- The panel is borderless; this wrapper only spaces and bounds it. -->
              <div class="mt-4 max-h-[60vh] overflow-y-auto px-1">
                <CliChatImportPanel onImportedChange={() => void refreshImportHint()} />
              </div>
            {/if}
          </div>
        {/if}

        {#if welcomePreferencesStore.preferences.enabled.suggestions}
          <div class="relative mx-auto max-w-3xl px-2 py-4 sm:px-4">
            <div class="animate-in fade-in slide-in-from-bottom-2 duration-300">
              <div class="min-w-0">
                <h2
                  class="mb-2 text-lg font-semibold leading-tight tracking-tight"
                  style:color={welcomeTextColor ?? 'var(--color-text-primary)'}
                >
                  {welcomePreferencesStore.preferences.homeTitle}
                </h2>

                <p
                  class="mb-8 max-w-2xl text-sm leading-relaxed"
                  style:color={welcomeTextColor ?? 'var(--color-text-secondary)'}
                >
                  {welcomePreferencesStore.preferences.homeSubtitle}
                </p>

                 <div class="grid w-full gap-3 sm:grid-cols-2">
                   {#each suggestions as suggestion (suggestion.id)}
                      <div
                       class="zen-suggestion-card group relative flex min-h-32 flex-col items-start rounded-lg border px-4 py-4 text-left transition-all duration-200"
                       style="background: var(--color-surface-1); border-color: var(--color-border);"
                     >
                       {#if editingSuggestionId !== suggestion.id}
                         <button
                           type="button"
                           class="absolute inset-0 z-0 rounded-lg bg-transparent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--color-accent)]/70"
                           aria-label={`Load ${suggestion.label} into composer`}
                           onclick={() => runConfiguredSuggestion(suggestion)}
                         ></button>
                      {/if}
                      <button
                           type="button"
                           class="absolute right-2 top-2 z-10 flex h-7 w-7 items-center justify-center rounded-md opacity-60 transition-all group-hover:opacity-100 group-focus-within:opacity-100 hover:bg-[var(--color-surface-3)] hover:text-[var(--color-accent)]"
                           style="color: var(--color-text-muted);"
                        onclick={(e) => {
                          e.stopPropagation();
                          startEditingSuggestion(suggestion);
                        }}
                        title="Edit suggestion"
                        aria-label={`Edit ${suggestion.label}`}
                      >
                        <Pencil size={14} />
                      </button>

                      <div
                        class="relative z-[1] w-full text-left {editingSuggestionId ===
                        suggestion.id
                          ? ''
                          : 'pointer-events-none'}"
                      >
                         <div class="mb-2 flex items-center gap-2 pr-8">
                           <span class="flex shrink-0 items-center text-[var(--color-accent)]">
                              <WelcomeCardIcon icon={suggestion.iconName} source={suggestion.iconSource} size={16} />
                           </span>
                           <span class="text-sm font-medium text-[var(--color-text-primary)]">
                             {suggestion.label}
                           </span>
                        </div>

                        {#if suggestion.provider || suggestion.model || suggestion.reasoning || suggestion.permission || suggestion.skills?.length}
                           <div class="relative z-[1] mb-2 flex flex-wrap gap-1.5 pr-8">
                            {#each [suggestion.provider, suggestion.model, suggestion.reasoning, suggestion.permission, ...(suggestion.skills ?? []).map((skill) => `skill · ${skill}`)] as chip (chip)}
                              {#if chip}<span class="rounded-full border px-2 py-0.5 text-[11px]" style="border-color: var(--color-border); color: var(--color-text-muted); background: color-mix(in srgb, var(--color-surface-3) 70%, transparent);">{chip}</span>{/if}
                            {/each}
                          </div>
                        {/if}

                        {#if editingSuggestionId === suggestion.id}
                          <textarea
                            bind:value={editingSuggestionText}
                            aria-label={`${suggestion.label} prompt`}
                            class="min-h-24 w-full rounded-md border px-3 py-2 text-xs leading-relaxed outline-none focus:ring-1 focus:ring-[var(--color-accent)]/30"
                            style="background: var(--color-surface-2); border-color: var(--color-border); color: var(--color-text-primary); resize: vertical;"
                            onclick={(e) => e.stopPropagation()}
                          ></textarea>
                        {:else}
                          <span
                             class="line-clamp-3 pr-8 text-xs leading-relaxed transition-colors group-hover:text-[var(--color-text-secondary)]"
                             style="color: var(--color-text-muted);">{suggestion.prompt}</span
                          >
                        {/if}
                      </div>

                      {#if editingSuggestionId === suggestion.id}
                        <div class="relative mt-2 flex items-center gap-2">
                          <button
                            type="button"
                            class="flex items-center gap-1.5 rounded-md bg-[var(--color-accent)]/10 px-3 py-1.5 text-[11px] font-medium text-[var(--color-accent)] transition-colors hover:bg-[var(--color-accent)]/20"
                            onclick={(e) => {
                              e.stopPropagation();
                              saveSuggestionEdit(suggestion.id);
                            }}
                          >
                            <Check size={12} />
                            Save prompt
                          </button>
                          <button
                            type="button"
                            class="flex items-center gap-1.5 rounded-md px-3 py-1.5 text-[11px] font-medium text-[var(--color-text-muted)] transition-colors hover:bg-[var(--color-surface-3)]"
                            onclick={(e) => {
                              e.stopPropagation();
                              cancelEditingSuggestion();
                            }}
                          >
                            <X size={12} />
                            Cancel
                          </button>
                        </div>
                      {/if}
                    </div>
                  {/each}
                </div>
              </div>
            </div>
          </div>
        {/if}
      </div>
    {:else}
      <div class="absolute inset-0">
        <VirtualList
          bind:this={virtualList}
          items={filteredFeed}
          estimateHeight={estimateFeedHeight}
          follow={autoScrollCtl.follow}
          resetKey={sessionStore.activeSessionId}
          ready={!wsStore.isLoadingSession}
          onScrollNearTop={() => {
            if (!wsStore.isLoadingSession) void feedStore.loadOlderSessionMessages(feedStore.sessionId);
          }}
          onLanded={handleTranscriptLanded}
          onRestoreState={(state) => autoScrollCtl.setFollow(state.follow)}
          class="h-full p-4 feed-scroll"
        >
          {#snippet row(entry, i)}
            <div class="pb-3">
              <FeedEntry
                {entry}
                isSelected={false}
                isExpanded={expandedGroups.has(entry.id)}
                isStreaming={streamingRowIndexes.has(i)}
                onSelect={(e) => handleEntryClick(entry, e)}
                onToggleGroup={() => toggleGroup(entry.id)}
                onDelete={(_event, target) => deleteSingle(entry, target?.messageId)}
              />
            </div>
          {/snippet}
        </VirtualList>
      </div>
    {/if}

    <!-- The transcript is mounted but still measuring. Cover it completely so
         the first visible frame is the settled bottom of the chat. -->
    {#if !wsStore.isLoadingSession && showLoadingSurface && filteredFeed.length > 0}
      <ChatLoading cover />
    {/if}

    {#if !showLoadingSurface && filteredFeed.length > 0 && !autoScrollCtl.follow && autoScrollCtl.hasContentBelow}
      <div
        transition:fade={{ duration: 150 }}
        class="absolute bottom-4 left-1/2 z-10 -translate-x-1/2 pointer-events-none"
      >
        <button
          onclick={() => autoScrollCtl.jumpToBottom('instant')}
          class="pointer-events-auto flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs font-medium shadow-lg backdrop-blur-sm transition-transform hover:scale-105 active:scale-95"
          style="background: var(--color-surface-2); border-color: var(--color-border); color: var(--color-text-secondary); box-shadow: 0 4px 16px rgba(0,0,0,0.35);"
          aria-label="Scroll to bottom"
        >
          <ArrowDown size={12} />
          <span>
            {#if autoScrollCtl.unseenCount > 0}
              {autoScrollCtl.unseenCount} new {autoScrollCtl.unseenCount === 1
                ? 'message'
                : 'messages'}
            {:else}
              Jump to bottom
            {/if}
          </span>
        </button>
      </div>
    {/if}
  </div>
  <!-- /relative wrapper -->
</div>

<!-- /outer -->

<style>
  .welcome-background-layer {
    position: absolute;
    z-index: 0;
    inset: 0;
    overflow: hidden;
    pointer-events: none;
  }

  :global(.markdown-content) {
    font-size: 14px;
    line-height: 1.7;
  }
  :global(.markdown-content p) {
    margin-bottom: 0.75em;
  }
  :global(.markdown-content p:last-child) {
    margin-bottom: 0;
  }
  :global(.markdown-content pre) {
    margin: 1em 0;
  }
  :global(.markdown-content code) {
    font-family: 'JetBrains Mono', monospace;
    font-size: 13px;
  }
  :global(.markdown-content :not(pre) > code) {
    background: var(--color-surface-2);
    padding: 0.2em 0.4em;
    border-radius: 4px;
    color: var(--color-accent);
    font-size: 0.9em;
  }
  :global(.markdown-content ul, :global(.markdown-content ol)) {
    margin-left: 1.5em;
    margin-bottom: 0.75em;
    list-style: disc;
  }
  :global(.markdown-content ol) {
    list-style: decimal;
  }
  :global(.markdown-content blockquote) {
    border-left: 4px solid var(--color-border);
    padding-left: 1em;
    color: var(--color-text-muted);
    font-style: italic;
    margin: 1em 0;
  }
  :global(.markdown-content a) {
    color: var(--color-accent);
    text-decoration: underline;
    text-underline-offset: 2px;
  }
  :global(.markdown-content .kory-inline) {
    font-size: inherit;
  }
  :global(.markdown-content .kory-mark) {
    background: color-mix(in srgb, var(--color-accent) 24%, transparent);
    color: inherit;
    border-radius: 4px;
    padding: 0.05em 0.25em;
  }
  :global(.markdown-content .kory-underline) {
    text-decoration: underline;
    text-underline-offset: 2px;
  }
  :global(.markdown-content .kory-external-link) {
    color: var(--color-info);
    text-decoration: underline;
    text-underline-offset: 2px;
  }
  :global(.markdown-content .kory-external-link:hover) {
    opacity: 0.85;
  }
  :global(.markdown-content .kory-link-favicon) {
    display: inline-block;
    width: 14px;
    height: 14px;
    margin-right: 4px;
    border-radius: 3px;
    vertical-align: text-bottom;
  }
  :global(:root[data-theme='dark'] .markdown-content .kory-link-favicon) {
    mix-blend-mode: multiply;
  }
  :global(.markdown-content .kory-file-link),
  :global(.markdown-content .kory-session-link) {
    display: inline-flex;
    align-items: baseline;
    gap: 3px;
    color: var(--color-text-primary);
    font-weight: 500;
    text-decoration: none;
    border-bottom: 1.5px dotted color-mix(in srgb, var(--color-text-secondary) 65%, transparent);
    padding-bottom: 1px;
    cursor: pointer;
  }
  :global(.markdown-content .kory-file-link:hover),
  :global(.markdown-content .kory-session-link:hover) {
    color: var(--color-accent);
    border-bottom-color: var(--color-accent);
  }
  :global(.markdown-content .kory-file-link-lines) {
    font-family: 'JetBrains Mono', monospace;
    font-size: 0.85em;
    color: var(--color-text-muted);
  }
  :global(.markdown-content h1, :global(.markdown-content h2), :global(.markdown-content h3)) {
    font-weight: 600;
    margin-top: 1.5em;
    margin-bottom: 0.75em;
    color: var(--color-text-primary);
  }
  .feed-scroll {
    overscroll-behavior: contain;
  }

  .zen-suggestion-card:hover,
  .zen-suggestion-card:focus-within {
    border-color: color-mix(in srgb, var(--color-accent) 55%, var(--color-border)) !important;
    background: var(--color-surface-2) !important;
    box-shadow:
      0 8px 20px -14px rgba(0, 0, 0, 0.8),
      0 0 0 1px color-mix(in srgb, var(--color-accent) 18%, transparent);
    transform: translateY(-1px);
  }

  @media (prefers-reduced-motion: reduce) {
    .zen-suggestion-card {
      transition: none;
    }

    .zen-suggestion-card:hover,
    .zen-suggestion-card:focus-within {
      transform: none;
    }
  }
</style>
