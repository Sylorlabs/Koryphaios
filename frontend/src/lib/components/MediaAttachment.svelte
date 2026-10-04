<script lang="ts">
  import { chatMediaKind, chatMediaMimeType } from '@koryphaios/shared';

  let { data, name, mimeType }: { data: string; name: string; mimeType?: string } = $props();
  let mime = $derived(chatMediaMimeType(name, mimeType));
  let kind = $derived(chatMediaKind(mime));
  let source = $state('');
  let playbackError = $state(false);

  // Blob URLs let players seek and avoid copying a large base64 URL into the
  // DOM. Every URL belongs to this view and is released on replacement/unmount.
  $effect(() => {
    const currentData = data;
    const currentMime = mime;
    playbackError = false;
    if (!currentMime || !currentData) { source = ''; return; }
    try {
      const bytes = Uint8Array.from(atob(currentData), (char) => char.charCodeAt(0));
      const url = URL.createObjectURL(new Blob([bytes], { type: currentMime }));
      source = url;
      return () => URL.revokeObjectURL(url);
    } catch {
      source = '';
      playbackError = true;
    }
  });
</script>

<figure class="w-full max-w-xl space-y-2 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-2)] p-3">
  <figcaption class="truncate text-xs text-[var(--color-text-secondary)]" title={name}>{name}</figcaption>
  {#if source && kind === 'video'}
    <!-- Source media has no caption track; do not invent speech captions. -->
    <!-- svelte-ignore a11y_media_has_caption -->
    <video src={source} controls playsinline preload="metadata" aria-label={name}
      class="max-h-[70vh] w-full rounded-lg bg-[var(--color-surface-1)]"
      onerror={() => (playbackError = true)}></video>
  {:else if source && kind === 'audio'}
    <audio src={source} controls preload="metadata" aria-label={name} class="w-full"
      onerror={() => (playbackError = true)}></audio>
  {/if}
  {#if playbackError}
    <p class="text-xs text-[var(--color-text-muted)]">This runtime could not play the media format. Download it to open in another player.</p>
  {/if}
  {#if source}
    <a href={source} download={name} class="text-xs text-[var(--color-accent)]">Download {kind ?? 'media'}</a>
  {/if}
</figure>
