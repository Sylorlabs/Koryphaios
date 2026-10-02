<script lang="ts">
  // A checklist renders as a flat column of rules, not a stack of bubbles.
  // Every element here deliberately has zero corner radius and no filled
  // container: rows are separated by hairlines, the progress meter is a
  // square-edged bar, and the checkbox is a square. Text sits directly on the
  // surface. Anything that needs grouping is separated by a line, never by a
  // rounded card floating on top of it.
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
  <header class="flex items-baseline justify-between gap-2 pb-1">
    <span class="truncate font-medium text-[var(--color-text-primary)]">
      {checklist.title}
    </span>
    <span class="shrink-0 tabular-nums text-[var(--color-text-muted)]">
      {done}/{checklist.items.length} done
    </span>
    {#if onDismiss}
      <button
        type="button"
        class="shrink-0 text-[var(--color-text-muted)] transition-colors hover:text-[var(--color-text-primary)]"
        aria-label="Hide checklist"
        title="Hide"
        onclick={onDismiss}
      >
        <X size={12} />
      </button>
    {/if}
  </header>

  <!-- Square-edged meter: a 2px rule, not a pill. -->
  <div
    class="mb-1.5 h-[2px] w-full bg-[var(--color-surface-3)]"
    role="progressbar"
    aria-valuenow={progress}
    aria-valuemin="0"
    aria-valuemax="100"
    aria-label="Checklist progress"
  >
    <div
      class="h-full transition-[width] duration-300"
      style="width: {progress}%; background: {progress === 100
        ? 'var(--color-success)'
        : 'var(--color-accent)'};"
    ></div>
  </div>

  {#if checklist.items.length}
    <ul aria-label="Checklist items">
      {#each checklist.items as item (item.id)}
        <li
          class="flex items-start gap-2 border-t border-[var(--color-border)] py-1.5 first:border-t-0
            {item.status === 'pending'
            ? 'text-[var(--color-text-secondary)]'
            : 'text-[var(--color-text-muted)]'}"
        >
          <button
            type="button"
            class="group/check -ml-[3px] mt-px flex size-5 shrink-0 items-center justify-center
              disabled:opacity-50"
            style="border-radius: 0;"
            aria-label={item.status === 'pending'
              ? `Mark done: ${item.title}`
              : `Reopen: ${item.title}`}
            aria-pressed={item.status === 'done'}
            disabled={pending}
            onclick={() => toggle(item.id, item.status)}
          >
            <!-- Hit area is 20px (the app's h-5 w-5 row-button standard, and
                 close to the 24px AA target); the visible box stays 13px so the
                 list keeps its density. A glyph-sized control is not a target. -->
            <span
              class="flex size-[13px] items-center justify-center border
                {item.status === 'done'
                ? 'border-[var(--color-success)] text-[var(--color-success)]'
                : item.status === 'skipped'
                  ? 'border-[var(--color-text-muted)] text-[var(--color-text-muted)]'
                  : 'border-[var(--color-border-bright)] text-transparent group-hover/check:border-[var(--color-accent)]'}"
              style="border-radius: 0;"
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
            <!-- 24px, matching the app's .icon-button standard. Always faintly
                 visible rather than opacity-0: an affordance nobody can see is
                 not a control, and hover-only reveal is unreachable on touch. -->
            <button
              type="button"
              class="-mr-1 flex size-6 shrink-0 items-center justify-center text-[var(--color-text-muted)]
                opacity-40 transition-opacity hover:opacity-100 hover:text-[var(--color-error)]
                focus-visible:opacity-100"
              style="border-radius: 0;"
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
    <p class="border-t border-[var(--color-border)] py-1.5 text-[var(--color-text-muted)]">
      No items yet.
    </p>
  {/if}

  {#if !compact}
    <form
      class="mt-1.5 flex items-center gap-1.5 border-t border-[var(--color-border)] pt-1.5"
      onsubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <!--  type="button" explicitly: this form also has an onsubmit handler, and
            a submit-typed button here would fire addItems twice.  -->
      <input
        class="min-w-0 flex-1 border-b border-[var(--color-border)] bg-transparent px-0 py-0.5
          text-[11px] text-[var(--color-text-primary)] outline-none
          focus:border-[var(--color-accent)]"
        style="border-radius: 0;"
        aria-label="New checklist item"
        placeholder="Add an item"
        bind:value={draft}
      />
      <button
        type="button"
        class="flex shrink-0 items-center gap-1 text-[var(--color-text-muted)] transition-colors
          hover:text-[var(--color-text-primary)] disabled:opacity-40"
        style="border-radius: 0;"
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
