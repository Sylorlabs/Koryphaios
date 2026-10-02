<script lang="ts">
  /**
   * Folder icon that reflects its container's state: closed when collapsed,
   * open when expanded (or hovered, when the caller wires that in). The two
   * lucide glyphs are stacked and crossfaded so the swap feels like the folder
   * actually opening rather than an icon replacement.
   */
  import Folder from 'lucide-svelte/icons/folder';
  import FolderOpen from 'lucide-svelte/icons/folder-open';

  interface Props {
    open: boolean;
    size?: number;
    class?: string;
  }

  let { open, size = 14, class: className = '' }: Props = $props();
</script>

<span
  class="folder-toggle-icon {className}"
  class:is-open={open}
  style="width: {size}px; height: {size}px;"
  aria-hidden="true"
  data-open={open}
>
  <span class="folder-glyph folder-glyph-closed"><Folder {size} /></span>
  <span class="folder-glyph folder-glyph-open"><FolderOpen {size} /></span>
</span>

<style>
  .folder-toggle-icon {
    position: relative;
    display: inline-flex;
    flex-shrink: 0;
    align-items: center;
    justify-content: center;
  }

  .folder-glyph {
    position: absolute;
    inset: 0;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    transition:
      opacity 160ms var(--ease-out, ease-out),
      transform 220ms cubic-bezier(0.2, 0.8, 0.2, 1);
    will-change: opacity, transform;
  }

  /* Closed: the shut folder sits still; the open one waits slightly "lifted". */
  .folder-glyph-closed {
    opacity: 1;
    transform: translateY(0) scale(1);
  }

  .folder-glyph-open {
    opacity: 0;
    transform: translateY(1px) scale(0.9);
  }

  .is-open .folder-glyph-closed {
    opacity: 0;
    transform: translateY(-1px) scale(0.9);
  }

  .is-open .folder-glyph-open {
    opacity: 1;
    transform: translateY(0) scale(1);
  }

  @media (prefers-reduced-motion: reduce) {
    .folder-glyph {
      transition: opacity 120ms linear;
      transform: none !important;
    }
  }
</style>
