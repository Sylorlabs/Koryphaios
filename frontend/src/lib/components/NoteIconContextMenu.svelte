<script lang="ts">
  import { onMount, tick } from 'svelte';
  import Check from 'lucide-svelte/icons/check';
  import ImagePlus from 'lucide-svelte/icons/image-plus';
  import X from 'lucide-svelte/icons/x';
  import { notesStore } from '$lib/stores/notes.svelte';
  import { projectStore } from '$lib/stores/project.svelte';
  import { NOTE_ICON_CHOICES, type NoteIcon } from '@koryphaios/shared';

  let { noteId, x, y, icon, onclose }: {
    noteId: string;
    x: number;
    y: number;
    icon?: NoteIcon;
    onclose: () => void;
  } = $props();
  let fileInput = $state<HTMLInputElement>();
  let menu = $state<HTMLDivElement>();
  let busy = $state(false);
  let error = $state('');
  let left = $state(0);
  let top = $state(0);
  let alive = true;
  const projectAtOpen = projectStore.currentPath;

  async function choose(next: NoteIcon | null): Promise<void> {
    if (!alive || busy || projectStore.currentPath !== projectAtOpen) return;
    busy = true;
    error = '';
    if (await notesStore.setNoteIcon(noteId, next)) { if (alive) onclose(); }
    else error = 'Could not save this icon. Try again.';
    busy = false;
  }

  async function upload(event: Event): Promise<void> {
    const input = event.currentTarget as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';
    if (!file) return;
    if (!['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/svg+xml'].includes(file.type)) {
      error = 'Choose a PNG, JPEG, GIF, WebP, or SVG image.';
      return;
    }
    if (file.size > 5 * 1024 * 1024) {
      error = 'Choose an image smaller than 5 MB.';
      return;
    }
    busy = true;
    error = '';
    const url = URL.createObjectURL(file);
    try {
      // Flatten uploads into a small PNG. SVG never reaches a document/iframe,
      // animated images use their first frame, and huge originals stay off the graph.
      const image = new globalThis.Image();
      image.src = url;
      await image.decode();
      const canvas = document.createElement('canvas');
      canvas.width = canvas.height = 96;
      const ctx = canvas.getContext('2d');
      if (!ctx || !image.naturalWidth || !image.naturalHeight) throw new Error('Invalid image');
      const ratio = Math.min(96 / image.naturalWidth, 96 / image.naturalHeight);
      const width = image.naturalWidth * ratio;
      const height = image.naturalHeight * ratio;
      ctx.drawImage(image, (96 - width) / 2, (96 - height) / 2, width, height);
      busy = false;
      await choose({ kind: 'image', value: canvas.toDataURL('image/png') });
    } catch {
      error = 'This image could not be read. Try another file.';
      busy = false;
    } finally {
      URL.revokeObjectURL(url);
    }
  }

  function keydown(event: KeyboardEvent): void {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      onclose();
      return;
    }
    const buttons = [...(menu?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? [])];
    const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
    if (['ArrowRight', 'ArrowDown', 'ArrowLeft', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
      event.preventDefault();
      const step = ['ArrowLeft', 'ArrowUp'].includes(event.key) ? -1 : 1;
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1
        : (index + step + buttons.length) % buttons.length;
      buttons[next]?.focus();
    } else if (event.key === 'Tab') onclose();
  }

  onMount(() => {
    const previous = document.activeElement as HTMLElement | null;
    void tick().then(() => {
      left = Math.max(8, Math.min(x, window.innerWidth - (menu?.offsetWidth ?? 240) - 8));
      top = Math.max(8, Math.min(y, window.innerHeight - (menu?.offsetHeight ?? 260) - 8));
      menu?.querySelector<HTMLButtonElement>('button')?.focus();
    });
    const outside = (event: PointerEvent) => {
      if (!menu?.contains(event.target as Node)) onclose();
    };
    const dismiss = () => onclose();
    window.addEventListener('pointerdown', outside);
    window.addEventListener('resize', dismiss);
    window.addEventListener('scroll', dismiss, true);
    return () => {
      alive = false;
      window.removeEventListener('pointerdown', outside);
      window.removeEventListener('resize', dismiss);
      window.removeEventListener('scroll', dismiss, true);
      if (previous?.isConnected) previous.focus({ preventScroll: true });
    };
  });
</script>

<div bind:this={menu} class="note-icon-menu" style:left={`${left}px`} style:top={`${top}px`}
  role="menu" tabindex="-1" aria-label="Note icon" aria-busy={busy} onkeydown={keydown}>
  <div class="menu-heading">
    <span>Note icon</span>
    <button type="button" role="menuitem" aria-label="Close note icon menu" onclick={onclose}><X size={13} /></button>
  </div>
  <div class="icon-grid">
    {#each NOTE_ICON_CHOICES as choice}
      <button type="button" role="menuitemradio" aria-checked={icon?.kind === 'builtin' && icon.value === choice.value}
        aria-label={choice.label} title={choice.label} disabled={busy}
        onclick={() => void choose({ kind: 'builtin', value: choice.value })}>
        {choice.value}
        {#if icon?.kind === 'builtin' && icon.value === choice.value}<Check size={10} class="chosen" />{/if}
      </button>
    {/each}
  </div>
  <button type="button" role="menuitem" class="menu-action" disabled={busy} onclick={() => fileInput?.click()}>
    <ImagePlus size={14} /> Upload your own icon
  </button>
  {#if icon}<button type="button" role="menuitem" class="menu-action" disabled={busy}
    onclick={() => void choose(null)}><X size={14} /> Reset to default</button>{/if}
  <input bind:this={fileInput} hidden type="file" accept="image/png,image/jpeg,image/gif,image/webp,image/svg+xml"
    aria-label="Upload a note icon" onchange={(event) => void upload(event)} />
  {#if error}<p class="error" role="alert">{error}</p>{:else}<p class="hint">{busy ? 'Saving icon…' : 'PNG, JPEG, GIF, WebP or SVG · up to 5 MB'}</p>{/if}
</div>

<style>
  .note-icon-menu { position: fixed; z-index: 140; width: 244px; max-width: calc(100vw - 16px); padding: 10px; border-radius: 14px; background: var(--color-surface-2); color: var(--color-text-primary); box-shadow: 0 12px 40px rgb(0 0 0 / 28%); }
  .menu-heading { display: flex; align-items: center; justify-content: space-between; padding: 0 6px 8px; color: var(--color-text-muted); font-size: 11px; font-weight: 600; }
  button { border: 0; background: transparent; color: inherit; border-radius: 7px; cursor: pointer; }
  button:hover:not(:disabled) { background: var(--color-surface-3); }
  button:disabled { opacity: 0.45; cursor: wait; }
  .menu-heading button { padding: 4px; }
  .icon-grid { display: grid; grid-template-columns: repeat(6, 1fr); gap: 2px; margin-bottom: 8px; }
  .icon-grid button { position: relative; height: 34px; font-size: 20px; }
  .icon-grid button[aria-checked='true'] { background: var(--color-accent-transparent); }
  .icon-grid :global(.chosen) { position: absolute; bottom: 2px; right: 2px; color: var(--color-accent); }
  .menu-action { display: flex; align-items: center; gap: 8px; width: 100%; padding: 9px 7px; text-align: left; font-size: 12px; }
  .hint, .error { margin: 6px 6px 2px; font-size: 10px; line-height: 1.5; color: var(--color-text-muted); }
  .error { color: var(--color-error); }
</style>
