<script lang="ts">
  import { apiFetch } from '$lib/api.svelte';
  import { apiUrl } from '$lib/utils/api-url';
  import MediaAttachment from './MediaAttachment.svelte';

  let { historyId }: { historyId: string } = $props();
  let clip = $state<{ videoBase64: string; mimeType: string; prompt: string } | null>(null);
  let error = $state('');
  let loading = $state(false);

  $effect(() => {
    const id = historyId;
    const controller = new AbortController();
    clip = null;
    error = '';
    loading = true;
    void (async () => {
      try {
        const response = await apiFetch(apiUrl(`/api/video/history/${encodeURIComponent(id)}`), { signal: controller.signal });
        const result = await response.json();
        if (!response.ok || !result.ok || !result.data?.videoBase64) throw new Error(result.error || 'Video is no longer in the gallery.');
        if (!controller.signal.aborted) clip = result.data;
      } catch (cause) {
        if (!controller.signal.aborted) error = cause instanceof Error ? cause.message : 'Could not load video.';
      } finally {
        if (!controller.signal.aborted) loading = false;
      }
    })();
    return () => controller.abort();
  });
</script>

{#if clip}
  <MediaAttachment data={clip.videoBase64} mimeType={clip.mimeType} name={`Generated video.${clip.mimeType.includes('webm') ? 'webm' : 'mp4'}`} />
  <p class="mt-1 text-xs text-[var(--color-text-muted)]">{clip.prompt}</p>
{:else}
  <p class="text-xs text-[var(--color-text-muted)]" role="status">{loading ? 'Loading generated video…' : error}</p>
{/if}
