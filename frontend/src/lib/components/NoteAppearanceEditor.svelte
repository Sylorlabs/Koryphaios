<script module lang="ts">
  /** Folder or tag whose emoji and color are being edited. */
  export type NoteAppearanceTarget =
    | { kind: 'folder'; path: string }
    | { kind: 'tag'; tag: string };

  export interface NoteAppearanceUpdate {
    emoji: string | null;
    color: string | null;
  }
</script>

<script lang="ts">
  import { tick } from 'svelte';
  import X from 'lucide-svelte/icons/x';
  import {
    NOTE_APPEARANCE_PALETTE,
    normalizeNoteAppearanceColor,
    normalizeNoteAppearanceEmoji,
    resolveNoteAppearanceColorCss,
  } from '@koryphaios/shared';

  interface Props {
    target: NoteAppearanceTarget;
    emoji?: string;
    color?: string;
    /** Anchor in viewport pixels, usually the context-menu event position. */
    x: number;
    y: number;
    onSave: (update: NoteAppearanceUpdate) => void | Promise<unknown>;
    onClose: () => void;
  }

  let { target, emoji, color, x, y, onSave, onClose }: Props = $props();

  // Snapshot the stored values once; the editor owns its draft until it closes.
  // svelte-ignore state_referenced_locally
  let draftEmoji = $state<string | undefined>(emoji);
  // svelte-ignore state_referenced_locally
  let draftColor = $state<string | undefined>(color);
  let customColor = $state('');
  let error = $state('');
  let saving = $state(false);
  let popoverEl = $state<HTMLDivElement | undefined>();
  let emojiInputEl = $state<HTMLInputElement | undefined>();

  const SWATCHES = ['accent', ...Object.keys(NOTE_APPEARANCE_PALETTE)] as const;
  const QUICK_EMOJI = ['📁', '📚', '🧭', '🚀', '💡', '🔥', '⭐', '🧪', '🎯', '📝', '🗂️', '🔒'];

  const heading = $derived(
    target.kind === 'folder' ? target.path === '/' ? 'All Notes' : target.path : `#${target.tag}`,
  );
  const previewColor = $derived(resolveNoteAppearanceColorCss(draftColor) ?? 'var(--color-text-secondary)');

  // Keep the popover inside the viewport so right-clicks near the edge stay usable.
  const left = $derived(Math.max(8, Math.min(x, (globalThis.innerWidth || 1024) - 296)));
  const top = $derived(Math.max(8, Math.min(y, (globalThis.innerHeight || 768) - 340)));

  $effect(() => {
    void tick().then(() => emojiInputEl?.focus());
  });

  function pickColor(next: string | undefined): void {
    draftColor = next;
    error = '';
  }

  function applyCustomColor(): void {
    const result = normalizeNoteAppearanceColor(customColor);
    if (!result.ok) {
      error = result.error;
      return;
    }
    draftColor = result.value;
    customColor = '';
    error = '';
  }

  async function save(): Promise<void> {
    const emojiResult = normalizeNoteAppearanceEmoji(draftEmoji ?? '');
    if (!emojiResult.ok) {
      error = emojiResult.error;
      return;
    }
    const colorResult = normalizeNoteAppearanceColor(draftColor ?? '');
    if (!colorResult.ok) {
      error = colorResult.error;
      return;
    }
    saving = true;
    try {
      await onSave({ emoji: emojiResult.value ?? null, color: colorResult.value ?? null });
      onClose();
    } finally {
      saving = false;
    }
  }

  async function clearAll(): Promise<void> {
    saving = true;
    try {
      await onSave({ emoji: null, color: null });
      onClose();
    } finally {
      saving = false;
    }
  }

  function handleKeydown(event: KeyboardEvent): void {
    if (event.key === 'Escape') {
      event.preventDefault();
      onClose();
    } else if (event.key === 'Enter' && (event.target as HTMLElement).tagName === 'INPUT') {
      event.preventDefault();
      if ((event.target as HTMLElement).id === 'note-appearance-custom-color') applyCustomColor();
      else void save();
    }
  }
</script>

<svelte:window onkeydown={handleKeydown} />

<!-- Click-away layer. Clicks inside the popover are stopped below. -->
<div class="fixed inset-0 z-40" role="presentation" onmousedown={onClose} oncontextmenu={(event) => { event.preventDefault(); onClose(); }}></div>

<div
  bind:this={popoverEl}
  class="fixed z-50 w-72 rounded-xl border p-3 shadow-2xl"
  style="left: {left}px; top: {top}px; background: var(--color-surface-2); border-color: var(--color-border); color: var(--color-text);"
  role="dialog"
  tabindex="-1"
  aria-modal="false"
  aria-label="Appearance for {heading}"
  onmousedown={(event) => event.stopPropagation()}
  oncontextmenu={(event) => event.stopPropagation()}
>
  <div class="mb-2 flex items-center gap-2">
    <span
      class="inline-flex min-w-0 items-center gap-1.5 truncate text-xs font-medium"
      style="color: {previewColor};"
    >
      {#if draftEmoji}<span aria-hidden="true">{draftEmoji}</span>{/if}
      <span class="truncate">{heading}</span>
    </span>
    <button
      type="button"
      class="ml-auto rounded p-1 hover:bg-[var(--color-surface-3)]"
      style="color: var(--color-text-muted);"
      onclick={onClose}
      aria-label="Close appearance editor"
    >
      <X size={12} />
    </button>
  </div>

  <label class="mb-1 block text-[11px] uppercase tracking-wider" style="color: var(--color-text-muted);" for="note-appearance-emoji">
    Emoji
  </label>
  <div class="mb-1 flex items-center gap-1.5">
    <input
      id="note-appearance-emoji"
      bind:this={emojiInputEl}
      type="text"
      maxlength="32"
      placeholder="Pick or paste one emoji"
      class="min-w-0 flex-1 rounded-md border px-2 py-1 text-xs outline-none focus:border-[var(--color-accent)]"
      style="background: var(--color-surface-1); border-color: var(--color-border); color: var(--color-text);"
      value={draftEmoji ?? ''}
      oninput={(event) => {
        draftEmoji = (event.currentTarget as HTMLInputElement).value || undefined;
        error = '';
      }}
    />
    <button
      type="button"
      class="rounded-md px-2 py-1 text-[11px] hover:bg-[var(--color-surface-3)]"
      style="color: var(--color-text-muted);"
      onclick={() => {
        draftEmoji = undefined;
        error = '';
      }}
    >
      None
    </button>
  </div>
  <div class="mb-3 flex flex-wrap gap-1" role="group" aria-label="Quick emoji">
    {#each QUICK_EMOJI as quick (quick)}
      <button
        type="button"
        class="h-6 w-6 rounded text-sm leading-none hover:bg-[var(--color-surface-3)]"
        style={draftEmoji === quick ? 'background: var(--color-surface-3); outline: 1px solid var(--color-accent);' : ''}
        aria-label="Use {quick}"
        aria-pressed={draftEmoji === quick}
        onclick={() => {
          draftEmoji = quick;
          error = '';
        }}
      >
        {quick}
      </button>
    {/each}
  </div>

  <div class="mb-1 text-[11px] uppercase tracking-wider" style="color: var(--color-text-muted);">Color</div>
  <div class="mb-2 flex flex-wrap items-center gap-1.5" role="group" aria-label="Color swatches">
    <button
      type="button"
      class="h-5 w-5 rounded-full border text-[9px] leading-none"
      style="border-color: var(--color-border); color: var(--color-text-muted);"
      aria-label="No color"
      aria-pressed={draftColor === undefined}
      onclick={() => pickColor(undefined)}
    >
      ∅
    </button>
    {#each SWATCHES as swatch (swatch)}
      <button
        type="button"
        class="h-5 w-5 rounded-full border-2"
        style="background: {resolveNoteAppearanceColorCss(swatch)}; border-color: {draftColor === swatch ? 'var(--color-text)' : 'transparent'};"
        aria-label="Color {swatch}"
        aria-pressed={draftColor === swatch}
        title={swatch}
        onclick={() => pickColor(swatch)}
      ></button>
    {/each}
  </div>

  <div class="flex items-center gap-1.5">
    <input
      id="note-appearance-custom-color"
      type="text"
      placeholder="#rrggbb"
      aria-label="Custom hex color"
      class="min-w-0 flex-1 rounded-md border px-2 py-1 font-mono text-xs outline-none focus:border-[var(--color-accent)]"
      style="background: var(--color-surface-1); border-color: var(--color-border); color: var(--color-text);"
      bind:value={customColor}
    />
    <button
      type="button"
      class="rounded-md px-2 py-1 text-[11px] hover:bg-[var(--color-surface-3)]"
      style="color: var(--color-text-secondary);"
      onclick={applyCustomColor}
    >
      Use hex
    </button>
  </div>

  {#if error}
    <p class="mt-2 text-[11px]" role="alert" style="color: var(--color-error);">{error}</p>
  {/if}

  <div class="mt-3 flex items-center gap-2">
    <button
      type="button"
      class="rounded-md px-2 py-1 text-xs hover:bg-[var(--color-surface-3)]"
      style="color: var(--color-text-muted);"
      onclick={() => void clearAll()}
      disabled={saving}
    >
      Reset
    </button>
    <button
      type="button"
      class="ml-auto rounded-md px-2.5 py-1 text-xs hover:bg-[var(--color-surface-3)]"
      style="color: var(--color-text-secondary);"
      onclick={onClose}
    >
      Cancel
    </button>
    <button
      type="button"
      class="rounded-md px-2.5 py-1 text-xs font-medium"
      style="background: var(--color-accent); color: var(--color-on-accent);"
      onclick={() => void save()}
      disabled={saving}
    >
      Save
    </button>
  </div>
</div>
