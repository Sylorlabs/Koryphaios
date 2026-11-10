<script lang="ts">
  import { untrack } from 'svelte';
  import X from 'lucide-svelte/icons/x';
  import BookmarkPlus from 'lucide-svelte/icons/bookmark-plus';
  import type { ChatFindingInput, Note } from '@koryphaios/shared';
  import { notesStore } from '$lib/stores/notes.svelte';

  let {
    finding,
    onClose,
  }: {
    finding: ChatFindingInput;
    onClose: () => void;
  } = $props();

  // The dialog is mounted fresh per finding, so the editable draft captures
  // the initial payload once instead of tracking later prop identity.
  let title = $state(untrack(() => finding.title));
  let body = $state(untrack(() => finding.body));
  let saving = $state(false);
  let error = $state('');
  let saved = $state<Note | null>(null);

  const canSave = $derived(Boolean(title.trim() && body.trim()) && !saving);

  async function save() {
    if (!canSave) return;
    saving = true;
    error = '';
    const note = await notesStore.createChatFinding({
      title: title.trim(),
      body: body.trim(),
      source: finding.source,
    });
    saving = false;
    if (!note) {
      error = notesStore.error || 'Failed to save the chat finding.';
      return;
    }
    saved = note;
  }

  function openSaved() {
    if (!saved) return;
    window.dispatchEvent(new CustomEvent('open-note', { detail: { title: saved.title } }));
    onClose();
  }

  function handleKeydown(event: KeyboardEvent) {
    if (event.key === 'Escape') {
      event.stopPropagation();
      onClose();
    }
  }
</script>

<div
  class="fixed inset-0 z-50 flex items-center justify-center p-4"
  style="background: rgba(0, 0, 0, 0.5);"
  onkeydown={handleKeydown}
  role="presentation"
>
  <div
    class="w-full max-w-lg rounded-xl border p-5 shadow-2xl"
    style="background: var(--color-surface-2); border-color: var(--color-border);"
    role="dialog"
    aria-modal="true"
    aria-labelledby="save-finding-title"
  >
    <div class="flex items-start justify-between gap-3">
      <div>
        <h3 id="save-finding-title" class="text-sm font-semibold" style="color: var(--color-text-primary);">
          Save this chat finding as a sourced note
        </h3>
        <p class="mt-1 text-xs leading-5" style="color: var(--color-text-muted);">
          The note records the chat session and message it came from as provenance, so it can be
          cited later without pretending to be more than the chat actually said.
        </p>
      </div>
      <button
        type="button"
        class="rounded-lg p-1.5 transition-colors hover:bg-[var(--color-surface-3)]"
        style="color: var(--color-text-muted);"
        onclick={onClose}
        aria-label="Close save finding dialog"
      >
        <X size={16} />
      </button>
    </div>

    {#if saved}
      <div class="mt-4 space-y-3">
        <p class="text-xs" style="color: var(--color-text-secondary);">
          Saved “<span class="font-medium">{saved.title}</span>” to
          <span class="font-mono">{saved.folderPath}</span> with source provenance.
        </p>
        <div class="flex items-center gap-2">
          <button
            type="button"
            class="rounded-lg px-3 py-1.5 text-xs font-semibold transition-colors"
            style="background: rgba(var(--color-accent-rgb), 0.12); color: var(--color-accent); border: 1px solid rgba(var(--color-accent-rgb), 0.25);"
            onclick={openSaved}
          >
            Open in Notes
          </button>
          <button
            type="button"
            class="rounded-lg px-3 py-1.5 text-xs transition-colors hover:bg-[var(--color-surface-3)]"
            style="color: var(--color-text-secondary);"
            onclick={onClose}
          >
            Done
          </button>
        </div>
      </div>
    {:else}
      <div class="mt-4 space-y-3">
        <div>
          <label class="block text-xs font-medium mb-1" style="color: var(--color-text-secondary);" for="finding-note-title">
            Title
          </label>
          <input
            id="finding-note-title"
            type="text"
            class="w-full rounded-lg border px-3 py-2 text-sm outline-none focus:border-[var(--color-accent)]"
            style="background: var(--color-surface-1); border-color: var(--color-border); color: var(--color-text-primary);"
            bind:value={title}
            maxlength="240"
          />
        </div>
        <div>
          <label class="block text-xs font-medium mb-1" style="color: var(--color-text-secondary);" for="finding-note-body">
            Finding
          </label>
          <textarea
            id="finding-note-body"
            class="w-full rounded-lg border px-3 py-2 text-sm outline-none focus:border-[var(--color-accent)]"
            style="background: var(--color-surface-1); border-color: var(--color-border); color: var(--color-text-primary); min-height: 9rem;"
            bind:value={body}
            maxlength="8000"
          ></textarea>
        </div>
        {#if error}
          <p class="text-xs" style="color: var(--color-error);" role="alert">{error}</p>
        {/if}
        <div class="flex items-center justify-end gap-2">
          <button
            type="button"
            class="rounded-lg px-3 py-1.5 text-xs transition-colors hover:bg-[var(--color-surface-3)]"
            style="color: var(--color-text-secondary);"
            onclick={onClose}
          >
            Cancel
          </button>
          <button
            type="button"
            class="flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-semibold transition-colors disabled:opacity-40"
            style="background: rgba(var(--color-accent-rgb), 0.12); color: var(--color-accent); border: 1px solid rgba(var(--color-accent-rgb), 0.25);"
            onclick={() => void save()}
            disabled={!canSave}
          >
            <BookmarkPlus size={13} />
            {saving ? 'Saving…' : 'Save as sourced note'}
          </button>
        </div>
      </div>
    {/if}
  </div>
</div>
