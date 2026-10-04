<script lang="ts">
  // Available in every chat, with or without a Goal, but hidden until the
  // composer asks for it: the panel lives behind the composer's more-actions
  // menu so an unused list never costs the user composer space.
  import { checklistStore } from '$lib/stores/checklists.svelte';
  import { onMount } from 'svelte';
  import { browser } from '$app/environment';
  import ChecklistList from './ChecklistList.svelte';
  import ListChecks from 'lucide-svelte/icons/list-checks';
  import Plus from 'lucide-svelte/icons/plus';
  import X from 'lucide-svelte/icons/x';

  interface Props {
    /** Composer-owned visibility, toggled from the more-actions menu. */
    open?: boolean;
    /** Closes the panel without routing through the more-actions menu again. */
    onDismiss?: () => void;
  }

  let { open = false, onDismiss }: Props = $props();

  let openId = $state('');
  let creating = $state(false);
  let newTitle = $state('');

  let active = $derived(checklistStore.active);

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

  async function create() {
    const title = newTitle.trim();
    if (!title) return;
    newTitle = '';
    creating = false;
    const created = await checklistStore.create({ title });
    if (created) openId = created.id;
  }
</script>

{#if open && checklistStore.loaded}
  <section
    aria-label="Checklists"
    class="mb-3 rounded-lg border px-3 py-2"
    style="border-color: var(--color-border); background: var(--color-surface-2);"
  >
    {#if active.length > 0}
      <div class="mb-1 flex items-center gap-2 px-2">
        <ListChecks size={12} class="shrink-0 text-[var(--color-accent)]" />
        <span class="min-w-0 flex-1 text-[11px] font-semibold text-[var(--color-text-secondary)]"
          >Checklists</span
        >
        {#if onDismiss}
          <button
            type="button"
            class="shrink-0 rounded-md p-1 text-[var(--color-text-muted)] transition-colors hover:bg-[var(--color-surface-3)] hover:text-[var(--color-text-primary)]"
            aria-label="Hide checklists"
            onclick={onDismiss}
          >
            <X size={12} />
          </button>
        {/if}
      </div>
    {/if}

    {#each active as checklist (checklist.id)}
      <div class="{active.length > 1 ? 'mb-1.5 last:mb-0' : ''}">
        {#if openId === checklist.id}
          <ChecklistList {checklist} onDismiss={() => (openId = '')} />
        {:else}
          <button
            type="button"
            class="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-[var(--color-surface-3)]"
            aria-expanded="false"
            aria-label="Open checklist: {checklist.title}"
            onclick={() => (openId = checklist.id)}
          >
            <ListChecks size={13} class="shrink-0 text-[var(--color-accent)]" />
            <span class="min-w-0 flex-1 truncate text-[11px] text-[var(--color-text-secondary)]">
              {checklist.title}
            </span>
            <span class="h-1.5 w-16 shrink-0 overflow-hidden rounded-full bg-[var(--color-surface-3)]">
              <span
                class="block h-full bg-[var(--color-accent)]"
                style="width: {checklistStore.progress(checklist)}%;"
              ></span>
            </span>
            <span class="shrink-0 text-[11px] tabular-nums text-[var(--color-text-muted)]">
              {checklist.items.filter((item) => item.status === 'done').length}/{checklist.items.length}
            </span>
          </button>
        {/if}
      </div>
    {/each}

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
        class="mt-2 flex items-center gap-1 rounded-md px-1 py-1 text-[11px] text-[var(--color-text-muted)]
          transition-colors hover:bg-[var(--color-surface-3)] hover:text-[var(--color-text-primary)]"
        onclick={() => (creating = true)}
      >
        <Plus size={11} /> New checklist
      </button>
    {/if}
  </section>
{/if}
