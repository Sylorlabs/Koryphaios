<script lang="ts">
  /**
   * `cover` is used while the transcript is already mounted underneath but its
   * rows are still being measured. It must be fully opaque and sit above the
   * list: the reader should see a spinner, then the finished chat, with no
   * intermediate scroll settling in between.
   */
  let { transparent = false, cover = false }: { transparent?: boolean; cover?: boolean } = $props();
</script>

<div class="chat-loading" class:transparent={transparent && !cover} class:cover role="status" aria-live="polite">
  <span class="chat-loading-circle" aria-hidden="true"></span>
  <span>Loading chat</span>
</div>

<style>
  .chat-loading {
    position: absolute;
    inset: 0;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: var(--space-4);
    background: var(--color-surface-1);
    color: var(--color-text-secondary);
    font-size: var(--text-sm);
  }

  .chat-loading-circle {
    width: 32px;
    height: 32px;
    border: 3px solid color-mix(in srgb, var(--color-accent) 20%, transparent);
    border-top-color: var(--color-accent);
    border-radius: 50%;
    animation: chat-loading-spin 0.8s linear infinite;
  }

  .chat-loading.transparent {
    background: transparent;
  }

  /* Above the transcript while it measures (VirtualList roots at z-index 0). */
  .chat-loading.cover {
    z-index: 20;
  }

  @keyframes chat-loading-spin {
    to { transform: rotate(360deg); }
  }

  @media (prefers-reduced-motion: reduce) {
    .chat-loading-circle { animation: none; }
  }
</style>
