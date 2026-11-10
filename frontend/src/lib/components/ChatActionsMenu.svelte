<script lang="ts">
  import { onMount, tick } from 'svelte';
  import Archive from 'lucide-svelte/icons/archive';
  import Copy from 'lucide-svelte/icons/copy';
  import Pencil from 'lucide-svelte/icons/pencil';
  import Trash2 from 'lucide-svelte/icons/trash-2';
  import { portalToBody } from '$lib/utils/portal';

  interface Props {
    id: string;
    chatTitle: string;
    x: number;
    y: number;
    archiving?: boolean;
    returnFocus?: HTMLElement | null;
    onaction: (action: string) => void;
    onclose: () => void;
  }

  let {
    id,
    chatTitle,
    x,
    y,
    archiving = false,
    returnFocus = null,
    onaction,
    onclose,
  }: Props = $props();

  let menu = $state<HTMLDivElement>();
  let left = $state(0);
  let top = $state(0);

  function choose(action: string) {
    onaction(action);
    onclose();
  }

  function handleKeydown(event: KeyboardEvent) {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      onclose();
      return;
    }
    if (event.key === 'Tab') {
      onclose();
      return;
    }
    const buttons = [
      ...(menu?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? []),
    ];
    const currentIndex = buttons.indexOf(document.activeElement as HTMLButtonElement);
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const step = event.key === 'ArrowUp' ? -1 : 1;
    const nextIndex =
      event.key === 'Home'
        ? 0
        : event.key === 'End'
          ? buttons.length - 1
          : (currentIndex + step + buttons.length) % buttons.length;
    buttons[nextIndex]?.focus();
  }

  onMount(() => {
    const previous = returnFocus ?? (document.activeElement as HTMLElement | null);
    void tick().then(() => {
      const width = menu?.offsetWidth ?? 240;
      const height = menu?.offsetHeight ?? 260;
      left = Math.max(8, Math.min(x, window.innerWidth - width - 8));
      top = Math.max(8, Math.min(y, window.innerHeight - height - 8));
      menu?.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus();
    });

    const dismissOutside = (event: PointerEvent) => {
      if (!menu?.contains(event.target as Node)) onclose();
    };
    window.addEventListener('pointerdown', dismissOutside);
    window.addEventListener('resize', onclose);
    window.addEventListener('scroll', onclose, true);
    return () => {
      window.removeEventListener('pointerdown', dismissOutside);
      window.removeEventListener('resize', onclose);
      window.removeEventListener('scroll', onclose, true);
      if (previous?.isConnected) previous.focus({ preventScroll: true });
    };
  });
</script>

<div
  use:portalToBody
  bind:this={menu}
  {id}
  class="chat-actions-menu"
  style={`left: ${left}px; top: ${top}px;`}
  role="menu"
  tabindex="-1"
  aria-label={`Actions for ${chatTitle}`}
  onkeydown={handleKeydown}
>
  <button type="button" role="menuitem" onclick={() => choose('rename')}>
    <Pencil size={14} />
    <span><strong>Rename</strong></span>
  </button>
  <div class="menu-separator" role="separator"></div>
  <button type="button" role="menuitem" onclick={() => choose('copy_id')}>
    <Copy size={14} />
    <span><strong>Copy chat ID</strong></span>
  </button>
  <div class="menu-separator" role="separator"></div>
  <button
    type="button"
    role="menuitem"
    disabled={archiving}
    onclick={() => choose('archive')}
  >
    <Archive size={14} />
    <span><strong>Archive</strong></span>
  </button>
  <button type="button" role="menuitem" class="menu-danger" onclick={() => choose('delete')}>
    <Trash2 size={14} />
    <span><strong>Delete chat</strong></span>
  </button>
</div>

<style>
  .chat-actions-menu {
    position: fixed;
    z-index: 150;
    width: 240px;
    max-width: calc(100vw - 16px);
    padding: 6px;
    border: 1px solid var(--color-border);
    border-radius: 12px;
    background: var(--color-surface-1);
    color: var(--color-text-primary);
    box-shadow: 0 16px 44px rgb(0 0 0 / 28%);
  }

  button {
    display: flex;
    width: 100%;
    align-items: center;
    gap: 10px;
    min-height: 32px;
    padding: 6px 8px;
    border: 0;
    border-radius: 8px;
    background: transparent;
    color: inherit;
    cursor: pointer;
    text-align: left;
  }

  button:hover:not(:disabled),
  button:focus-visible {
    background: var(--color-surface-3);
  }

  button:disabled {
    opacity: 0.55;
    cursor: default;
  }

  button:focus-visible {
    outline: 2px solid color-mix(in srgb, var(--color-accent) 70%, transparent);
    outline-offset: -2px;
  }

  button > :global(svg) {
    flex: 0 0 auto;
    color: var(--color-text-muted);
  }

  button strong {
    font-size: 12px;
    font-weight: 500;
  }

  .menu-separator {
    height: 1px;
    margin: 5px 4px;
    background: var(--color-border);
  }

  .menu-danger > :global(svg),
  .menu-danger strong {
    color: var(--color-error);
  }
</style>
