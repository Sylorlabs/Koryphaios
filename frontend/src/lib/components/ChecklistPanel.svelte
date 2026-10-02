<script lang="ts">
  // Available in every chat, with or without a Goal. The panel is a flat strip
  // pinned above the composer: a single line per list showing how far along it
  // is, expanding into the full list on demand. No card, no rounded container.
  import { checklistStore } from '$lib/stores/checklists.svelte';
  import { onMount } from 'svelte';
  import { browser } from '$app/environment';
  import ChecklistList from './ChecklistList.svelte';
  import ListChecks from 'lucide-svelte/icons/list-checks';
  import Plus from 'lucide-svelte/icons/plus';
  import X from 'lucide-svelte/icons/x';

  let openId = $state('');
  let creating = $state(false);
  let newTitle = $state('');

  let active = $derived(checklistStore.active);

  onMount(() => {
    if (browser) void checklistStore.refresh();
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

{#if checklistStore.loaded}
  <section aria-label="Checklists" class="mb-3">
    {#each active as checklist (checklist.id)}
      <div class="border-t border-[var(--color-border)] py-1.5 first:border-t-0">
        {#if openId === checklist.id}
          <ChecklistList {checklist} onDismiss={() => (openId = '')} />
        {:else}
          <!-- Collapsed row: text on the surface, a 2px rule for progress, no
               pill and no fill behind it. -->
          <button
            type="button"
            class="flex w-full items-center gap-2 py-1 text-left"
            style="border-radius: 0;"
            aria-expanded="false"
            aria-label="Open checklist: {checklist.title}"
            onclick={() => (openId = checklist.id)}
          >
            <ListChecks size={13} class="shrink-0 text-[var(--color-accent)]" />
            <span class="min-w-0 flex-1 truncate text-[11px] text-[var(--color-text-secondary)]">
              {checklist.title}
            </span>
            <span class="h-[2px] w-16 shrink-0 bg-[var(--color-surface-3)]">
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
        class="mt-1 flex items-center gap-1.5 border-t border-[var(--color-border)] pt-1.5"
        onsubmit={(event) => {
          event.preventDefault();
          void create();
        }}
      >
        <input
          class="min-w-0 flex-1 border-b border-[var(--color-border)] bg-transparent px-0 py-0.5
            text-[11px] text-[var(--color-text-primary)] outline-none
            focus:border-[var(--color-accent)]"
          style="border-radius: 0;"
          aria-label="New checklist title"
          placeholder="Checklist title"
          bind:value={newTitle}
        />
        <button
          type="button"
          class="shrink-0 text-[11px] text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)]"
          style="border-radius: 0;"
          disabled={!newTitle.trim()}
          onclick={() => create()}
        >
          Add
        </button>
        <button
          type="button"
          class="shrink-0 text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)]"
          style="border-radius: 0;"
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
        class="mt-1 flex items-center gap-1 text-[11px] text-[var(--color-text-muted)]
          underline-offset-2 transition-colors hover:text-[var(--color-text-primary)] hover:underline"
        style="border-radius: 0;"
        onclick={() => (creating = true)}
      >
        <Plus size={11} /> New checklist
      </button>
    {/if}
  </section>
{/if}
