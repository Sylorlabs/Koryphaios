<script lang="ts">
  // Docked checklist surface for every chat, with or without a Goal.
  //
  // Visibility belongs to the composer, which reveals this panel when the chat
  // has lists and toggles it from the more-actions menu and `/checklist`. The
  // panel renders only while `open`, so the same command that opened it can
  // take it back down instead of leaving a surface that has to be emptied
  // before it disappears.
  import { checklistStore } from '$lib/stores/checklists.svelte';
  import { onMount } from 'svelte';
  import { browser } from '$app/environment';
  import ChecklistList from './ChecklistList.svelte';
  import ListChecks from 'lucide-svelte/icons/list-checks';
  import Plus from 'lucide-svelte/icons/plus';
  import X from 'lucide-svelte/icons/x';
  import ChevronRight from 'lucide-svelte/icons/chevron-right';

  interface Props {
    /** Composer-owned visibility, toggled from the more-actions menu. */
    open?: boolean;
    /** Closes the panel without routing through the more-actions menu again. */
    onDismiss?: () => void;
  }

  let { open = false, onDismiss }: Props = $props();

  // Only the most recent list opens by itself. A chat that has accumulated
  // several lists must not render every list body above the composer, so the
  // rest start as one-line rows. A user's explicit toggle always wins, whether
  // that means opening an older list or closing the newest one.
  let expandedIds = $state<Set<string>>(new Set());
  let collapsedIds = $state<Set<string>>(new Set());
  let creating = $state(false);
  let newTitle = $state('');
  // The docked panel folds down to its header line, so a chat with plans in
  // progress can hide them entirely without dismissing the section.
  let panelCollapsed = $state(false);

  let active = $derived(checklistStore.active);
  // Newest first, and only a few rows by default: a project accumulates plans
  // over time, and every one of them being docked above the composer would
  // push the conversation off the screen.
  const VISIBLE_LIMIT = 3;
  let showAll = $state(false);
  let ordered = $derived([...active].sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0)));
  let newestId = $derived(ordered[0]?.id ?? null);
  let hiddenCount = $derived(Math.max(0, ordered.length - VISIBLE_LIMIT));
  let rendered = $derived(showAll ? ordered : ordered.slice(0, VISIBLE_LIMIT));

  onMount(() => {
    if (browser) void checklistStore.refresh();
  });

  // A dismissed draft must not come back the next time the panel opens.
  $effect(() => {
    if (!open) {
      creating = false;
      newTitle = '';
    }
  });

  // Composer-driven opening always reveals the lists, so "New checklist" from
  // the more-actions menu never lands on a folded panel.
  $effect(() => {
    if (open) panelCollapsed = false;
  });

  function isExpanded(id: string): boolean {
    if (collapsedIds.has(id)) return false;
    if (expandedIds.has(id)) return true;
    return id === newestId;
  }

  function toggleCollapsed(id: string) {
    const wasExpanded = isExpanded(id);
    const nextExpanded = new Set(expandedIds);
    const nextCollapsed = new Set(collapsedIds);
    if (wasExpanded) {
      nextExpanded.delete(id);
      nextCollapsed.add(id);
    } else {
      nextCollapsed.delete(id);
      nextExpanded.add(id);
    }
    expandedIds = nextExpanded;
    collapsedIds = nextCollapsed;
  }

  function doneCount(items: { status: string }[]): number {
    return items.filter((item) => item.status === 'done').length;
  }

  async function create() {
    const title = newTitle.trim();
    if (!title) return;
    newTitle = '';
    creating = false;
    await checklistStore.create({ title });
  }

  async function deleteChecklist(id: string) {
    await checklistStore.remove(id);
    if (checklistStore.get(id)) return;
    const nextExpanded = new Set(expandedIds);
    const nextCollapsed = new Set(collapsedIds);
    nextExpanded.delete(id);
    nextCollapsed.delete(id);
    expandedIds = nextExpanded;
    collapsedIds = nextCollapsed;
  }

  /** Closing finishes a list without destroying it; it stays readable. */
  async function closeChecklist(id: string) {
    await checklistStore.setArchived(id, true);
  }
</script>

{#if open}
  <section
    aria-label="Checklists"
    class="mb-3 max-h-[45vh] overflow-y-auto rounded-lg px-1.5 py-1.5"
    style="background: color-mix(in srgb, var(--color-surface-2) 42%, transparent);"
  >
    {#if !checklistStore.loaded}
      <p class="px-2 py-2 text-[11px] text-[var(--color-text-muted)]">{checklistStore.error || 'Loading checklists...'}</p>
      {#if checklistStore.error}
        <button type="button" class="px-2 py-1 text-[11px] text-[var(--color-accent)]" onclick={() => void checklistStore.refresh()}>Retry</button>
      {/if}
    {:else}
      <!-- The header row uses the same trailing geometry as a checklist row, so
           its dismiss control shares one column with every row's close
           control instead of sitting on its own ragged edge. It renders even
           with no lists: `/checklist` opens this panel on its own, and the
           dismiss control is the only way out of it short of creating a
           checklist and closing it again. -->
      <div class="flex items-center rounded-lg pr-0.5 transition-colors hover:bg-[var(--color-surface-3)]/70">
        <button
          type="button"
          class="flex min-w-0 flex-1 items-center gap-1.5 py-1 pl-1.5 pr-1 text-left"
          aria-expanded={!panelCollapsed}
          aria-label={panelCollapsed ? 'Expand checklists' : 'Collapse checklists'}
          onclick={() => (panelCollapsed = !panelCollapsed)}
        >
          <ChevronRight
            size={11}
            class="shrink-0 text-[var(--color-text-muted)] transition-transform duration-150 ease-out {panelCollapsed
              ? ''
              : 'rotate-90'}"
          />
          <ListChecks size={11} class="shrink-0 text-[var(--color-accent)]" />
          <span
            class="min-w-0 flex-1 text-[10px] font-semibold uppercase tracking-[0.08em] text-[var(--color-text-muted)]"
            >Checklists</span
          >
          <span class="shrink-0 text-[11px] tabular-nums text-[var(--color-text-muted)]">
            {ordered.length}
          </span>
        </button>
        {#if onDismiss}
          <button
            type="button"
            class="flex size-5 shrink-0 items-center justify-center rounded text-[var(--color-text-muted)] transition-colors hover:text-[var(--color-text-primary)]"
            aria-label="Hide checklists"
            onclick={onDismiss}
          >
            <X size={11} />
          </button>
        {/if}
      </div>
    {/if}

    {#if !panelCollapsed}
      {#each rendered as checklist (checklist.id)}
      {@const expanded = isExpanded(checklist.id)}
      <div class="{rendered.length > 1 ? 'mb-1.5 last:mb-0' : ''}">
        <!-- The hover surface is the whole row, so the close affordance belongs
             to the row it closes instead of floating at the panel edge. -->
        <div class="group/row flex items-center rounded-lg pr-0.5 transition-colors hover:bg-[var(--color-surface-3)]/70">
          <button
            type="button"
            class="flex min-w-0 flex-1 items-center gap-1.5 py-[7px] pl-1.5 pr-1 text-left"
            aria-expanded={expanded}
            aria-label="{expanded ? 'Collapse' : 'Expand'} checklist: {checklist.title}"
            onclick={() => toggleCollapsed(checklist.id)}
          >
            <!-- One chevron that turns, rather than swapping glyphs: the row
                 itself is the control, so the motion is the whole affordance. -->
            <ChevronRight
              size={11}
              class="shrink-0 text-[var(--color-text-muted)] transition-transform duration-150 ease-out {expanded
                ? 'rotate-90'
                : ''}"
            />
            <span class="min-w-0 flex-1 truncate text-[12px] leading-5 text-[var(--color-text-secondary)]">
              {checklist.title}
            </span>
            <span class="h-[3px] w-9 shrink-0 overflow-hidden rounded-full bg-[var(--color-surface-3)]">
              <span
                class="block h-full rounded-full bg-[var(--color-accent)] transition-[width] duration-300 ease-out"
                style="width: {checklistStore.progress(checklist)}%;"
              ></span>
            </span>
            <span class="shrink-0 text-[11px] tabular-nums text-[var(--color-text-muted)]">
              {doneCount(checklist.items)}/{checklist.items.length}
            </span>
          </button>
          <button
            type="button"
            class="flex size-5 shrink-0 items-center justify-center rounded text-[var(--color-text-muted)] opacity-0 transition-opacity hover:text-[var(--color-text-primary)] focus-visible:opacity-100 group-hover/row:opacity-100"
            aria-label="Close checklist: {checklist.title}"
            title="Close checklist"
            onclick={() => void closeChecklist(checklist.id)}
          >
            <X size={11} />
          </button>
        </div>
        {#if expanded}
          <div class="checklist-body pb-1.5 pl-[22px] pr-0.5">
            <ChecklistList
              {checklist}
              showTitle={false}
              onDelete={() => void deleteChecklist(checklist.id)}
            />
          </div>
        {/if}
      </div>
    {/each}

    {#if hiddenCount > 0}
      <button
        type="button"
        class="mt-1 rounded-md px-2 py-1 text-[11px] text-[var(--color-text-muted)] transition-colors hover:bg-[var(--color-surface-3)] hover:text-[var(--color-text-primary)]"
        aria-expanded={showAll}
        onclick={() => (showAll = !showAll)}
      >
        {showAll ? 'Show fewer checklists' : `Show all ${ordered.length} checklists`}
      </button>
    {/if}

    {#if creating}
      <form
        class="mt-2 flex items-center gap-1.5"
        onsubmit={(event) => {
          event.preventDefault();
          void create();
        }}
      >
        <input
          class="min-w-0 flex-1 rounded-md border bg-[var(--color-surface-1)] px-2 py-1.5
            text-[11px] text-[var(--color-text-primary)] outline-none placeholder:text-[var(--color-text-muted)]
            focus:border-[var(--color-accent)]"
          style="border-color: var(--color-border);"
          aria-label="New checklist title"
          placeholder="Checklist title"
          bind:value={newTitle}
        />
        <button
          type="button"
          class="shrink-0 rounded-md px-2 py-1.5 text-[11px] text-[var(--color-text-muted)] transition-colors hover:bg-[var(--color-surface-3)] hover:text-[var(--color-text-primary)]"
          disabled={!newTitle.trim()}
          onclick={() => create()}
        >
          Add
        </button>
        <button
          type="button"
          class="shrink-0 rounded-md p-1.5 text-[var(--color-text-muted)] transition-colors hover:bg-[var(--color-surface-3)] hover:text-[var(--color-text-primary)]"
          aria-label="Cancel new checklist"
          onclick={() => {
            creating = false;
            newTitle = '';
          }}
        >
          <X size={12} />
        </button>
      </form>
    {:else}
      <button
        type="button"
        class="mt-1 flex items-center gap-1 rounded-md py-1 pl-1.5 pr-2 text-[11px] text-[var(--color-text-muted)]
          transition-colors hover:bg-[var(--color-surface-3)] hover:text-[var(--color-text-primary)]"
        onclick={() => (creating = true)}
      >
        <Plus size={11} /> New checklist
      </button>
    {/if}
    {/if}
  </section>
{/if}

<style>
  /* Disclosure motion on mount only. The collapsed body is removed from the
     DOM (so its controls are never tabbable), which means there is nothing to
     animate on the way out; a short reveal is the part that reads as motion. */
  .checklist-body {
    animation: kory-disclosure 170ms cubic-bezier(0.2, 0.8, 0.2, 1);
  }
  @keyframes kory-disclosure {
    from {
      opacity: 0;
      transform: translateY(-2px);
    }
    to {
      opacity: 1;
      transform: none;
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .checklist-body {
      animation: none;
    }
  }
</style>
