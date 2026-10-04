<script lang="ts">
  // A checklist stays compact inside the composer while keeping each item
  // visually actionable. Rows use spacing and hover states instead of a wall
  // of separator lines.
  import { checklistStore } from '$lib/stores/checklists.svelte';
  import type { Checklist, ChecklistItemStatus } from '@koryphaios/shared';
  import Plus from 'lucide-svelte/icons/plus';
  import Trash2 from 'lucide-svelte/icons/trash-2';
  import X from 'lucide-svelte/icons/x';
  import Check from 'lucide-svelte/icons/check';
  import Minus from 'lucide-svelte/icons/minus';

  interface Props {
    checklist: Checklist;
    /** Inline transcript rendering has no room for row controls. */
    compact?: boolean;
    onDismiss?: () => void;
  }

  let { checklist, compact = false, onDismiss }: Props = $props();

  let draft = $state('');
  let pending = $state(false);

  let done = $derived(checklist.items.filter((item) => item.status === 'done').length);
  let settled = $derived(
    checklist.items.filter((item) => item.status !== 'pending').length,
  );
  let progress = $derived(
    checklist.items.length === 0
      ? 0
      : Math.round((settled / checklist.items.length) * 100),
  );

  async function toggle(itemId: string, status: ChecklistItemStatus) {
    pending = true;
    // Clicking a settled row reopens it, so the same control both ticks and
    // unticks without a second affordance.
    await checklistStore.setItemStatus(checklist.id, itemId, status === 'pending' ? 'done' : 'pending');
    pending = false;
  }

  async function submit() {
    const title = draft.trim();
    if (!title) return;
    draft = '';
    pending = true;
    await checklistStore.addItems(checklist.id, [title]);
    pending = false;
  }

  async function removeItem(itemId: string) {
    pending = true;
    await checklistStore.editItems(
      checklist.id,
      checklist.items
        .filter((item) => item.id !== itemId)
        .map((item, index) => ({ id: item.id, title: item.title, order: index })),
    );
    pending = false;
  }
</script>

<section aria-label="Checklist: {checklist.title}" class="text-[11px]">
  <header class="mb-2 flex items-center gap-2">
    <span class="truncate font-medium text-[var(--color-text-primary)]">
      {checklist.title}
    </span>
    <span class="ml-auto shrink-0 tabular-nums text-[var(--color-text-muted)]">
      {done}/{checklist.items.length} done
    </span>
    {#if onDismiss}
      <button
        type="button"
        class="shrink-0 rounded-md p-1 text-[var(--color-text-muted)] transition-colors hover:bg-[var(--color-surface-3)] hover:text-[var(--color-text-primary)]"
        aria-label="Hide checklist"
        title="Hide"
        onclick={onDismiss}
      >
        <X size={12} />
      </button>
    {/if}
  </header>

  <div
    class="mb-2 h-1.5 w-full overflow-hidden rounded-full bg-[var(--color-surface-3)]"
    role="progressbar"
    aria-valuenow={progress}
    aria-valuemin="0"
    aria-valuemax="100"
    aria-label="Checklist progress"
  >
    <div
      class="h-full rounded-full transition-[width] duration-300"
      style="width: {progress}%; background: {progress === 100
        ? 'var(--color-success)'
        : 'var(--color-accent)'};"
    ></div>
  </div>

  {#if checklist.items.length}
    <ul aria-label="Checklist items">
      {#each checklist.items as item (item.id)}
        <li
          class="group flex items-start gap-2 rounded-md px-1.5 py-1.5 transition-colors hover:bg-[var(--color-surface-3)]
            {item.status === 'pending'
            ? 'text-[var(--color-text-secondary)]'
            : 'text-[var(--color-text-muted)]'}"
        >
          <button
            type="button"
            class="group/check mt-px flex size-5 shrink-0 items-center justify-center rounded-md
              disabled:opacity-50"
            aria-label={item.status === 'pending'
              ? `Mark done: ${item.title}`
              : `Reopen: ${item.title}`}
            role="checkbox"
            aria-checked={item.status === 'done'}
            disabled={pending}
            onclick={() => toggle(item.id, item.status)}
          >
            <span
              class="flex size-4 items-center justify-center rounded-[4px] border
                {item.status === 'done'
                ? 'border-[var(--color-success)] bg-[var(--color-success)]/15 text-[var(--color-success)]'
                : item.status === 'skipped'
                  ? 'border-[var(--color-text-muted)] bg-[var(--color-surface-3)] text-[var(--color-text-muted)]'
                  : 'border-[var(--color-border-bright)] bg-[var(--color-surface-1)] text-transparent group-hover/check:border-[var(--color-accent)]'}"
            >
              {#if item.status === 'done'}
                <Check size={10} strokeWidth={3} />
              {:else if item.status === 'skipped'}
                <Minus size={10} strokeWidth={3} />
              {/if}
            </span>
          </button>
          <span
            class="min-w-0 flex-1 break-words
              {item.status !== 'pending' ? 'line-through' : ''}"
          >
            {item.title}
          </span>
          {#if !compact}
            <button
              type="button"
              class="-mr-1 flex size-6 shrink-0 items-center justify-center rounded-md text-[var(--color-text-muted)]
                opacity-40 transition-all hover:bg-[var(--color-error-bg)] hover:opacity-100 hover:text-[var(--color-error)]
                focus-visible:opacity-100"
              aria-label="Remove item: {item.title}"
              title="Remove"
              disabled={pending}
              onclick={() => removeItem(item.id)}
            >
              <Trash2 size={11} />
            </button>
          {/if}
        </li>
      {/each}
    </ul>
  {:else}
    <p class="rounded-md bg-[var(--color-surface-1)] px-2 py-2 text-[var(--color-text-muted)]">
      No items yet.
    </p>
  {/if}

  {#if !compact}
    <form
      class="mt-2 flex items-center gap-1.5"
      onsubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <!--  type="button" explicitly: this form also has an onsubmit handler, and
            a submit-typed button here would fire addItems twice.  -->
      <input
        class="min-w-0 flex-1 rounded-md border bg-[var(--color-surface-1)] px-2 py-1.5
          text-[11px] text-[var(--color-text-primary)] outline-none placeholder:text-[var(--color-text-muted)]
          focus:border-[var(--color-accent)]"
        style="border-color: var(--color-border);"
        aria-label="New checklist item"
        placeholder="Add an item"
        bind:value={draft}
      />
      <button
        type="button"
        class="flex shrink-0 items-center gap-1 rounded-md px-2 py-1.5 text-[var(--color-text-muted)] transition-colors
          hover:bg-[var(--color-surface-3)] hover:text-[var(--color-text-primary)] disabled:opacity-40"
        disabled={pending || !draft.trim()}
        onclick={() => submit()}
      >
        <Plus size={11} /> Add
      </button>
    </form>
  {/if}

  {#if checklistStore.error}
    <p class="mt-1 text-[10px] text-[var(--color-error)]" role="alert">
      {checklistStore.error}
    </p>
  {/if}
</section>
