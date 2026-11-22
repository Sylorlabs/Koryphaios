<script lang="ts">
  import { onMount, tick } from 'svelte';
  import ImagePlus from 'lucide-svelte/icons/image-plus';
  import Settings2 from 'lucide-svelte/icons/settings-2';
  import Trash2 from 'lucide-svelte/icons/trash-2';
  import X from 'lucide-svelte/icons/x';
  import { portalToBody } from '$lib/utils/portal';

  interface Props {
    id: string;
    providerLabel: string;
    hasCustomIcon: boolean;
    x: number;
    y: number;
    returnFocus?: HTMLElement | null;
    onedit: () => void | Promise<void>;
    onremove: () => void | Promise<void>;
    onsettings: () => void | Promise<void>;
    onclose: () => void;
  }

  let {
    id,
    providerLabel,
    hasCustomIcon,
    x,
    y,
    returnFocus = null,
    onedit,
    onremove,
    onsettings,
    onclose,
  }: Props = $props();

  let menu = $state<HTMLDivElement>();
  let left = $state(0);
  let top = $state(0);

  function choose(callback: () => void | Promise<void>) {
    void callback();
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
      const width = menu?.offsetWidth ?? 260;
      const height = menu?.offsetHeight ?? 180;
      left = Math.max(8, Math.min(x, window.innerWidth - width - 8));
      top = Math.max(8, Math.min(y, window.innerHeight - height - 8));
      menu?.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus();
    });

    const dismissOutside = (event: PointerEvent) => {
      if (!menu?.contains(event.target as Node)) onclose();
    };
    const dismiss = () => onclose();
    window.addEventListener('pointerdown', dismissOutside);
    window.addEventListener('resize', dismiss);
    window.addEventListener('scroll', dismiss, true);

    return () => {
      window.removeEventListener('pointerdown', dismissOutside);
      window.removeEventListener('resize', dismiss);
      window.removeEventListener('scroll', dismiss, true);
      if (previous?.isConnected) previous.focus({ preventScroll: true });
    };
  });
</script>

<div
  use:portalToBody
  bind:this={menu}
  {id}
  class="provider-icon-context-menu"
  style={`left: ${left}px; top: ${top}px;`}
  role="menu"
  tabindex="-1"
  aria-label={`Actions for ${providerLabel}`}
  onkeydown={handleKeydown}
>
  <div class="menu-heading">
    <div class="min-w-0">
      <span class="menu-kicker">Provider logo</span>
      <strong>{providerLabel}</strong>
    </div>
    <button type="button" role="menuitem" aria-label="Close provider logo actions" onclick={onclose}>
      <X size={13} />
    </button>
  </div>

  <button type="button" role="menuitem" onclick={() => void choose(onedit)}>
    <ImagePlus size={14} />
    <span>
      <strong>{hasCustomIcon ? 'Edit provider logo' : 'Add provider logo'}</strong>
      <small>Upload, crop, and shape the logo used in provider lists</small>
    </span>
  </button>
  {#if hasCustomIcon}
    <button type="button" role="menuitem" onclick={() => void choose(onremove)}>
      <Trash2 size={14} />
      <span>
        <strong>Remove provider logo</strong>
        <small>Return to the default provider artwork</small>
      </span>
    </button>
  {/if}
  <button type="button" role="menuitem" onclick={() => void choose(onsettings)}>
    <Settings2 size={14} />
    <span>
      <strong>Open provider settings</strong>
      <small>Manage connection, models, and credentials</small>
    </span>
  </button>
</div>

<style>
  .provider-icon-context-menu {
    position: fixed;
    z-index: 140;
    width: 300px;
    max-width: calc(100vw - 16px);
    padding: 8px;
    border: 1px solid var(--color-border);
    border-radius: 14px;
    background: var(--color-surface-1);
    color: var(--color-text-primary);
    box-shadow: 0 16px 44px rgb(0 0 0 / 28%);
  }

  .menu-heading {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    padding: 5px 6px 8px;
    border-bottom: 1px solid var(--color-border);
  }

  .menu-heading > div {
    display: flex;
    min-width: 0;
    flex-direction: column;
    gap: 2px;
  }

  .menu-kicker {
    color: var(--color-accent);
    font-size: 10px;
    font-weight: 700;
    letter-spacing: 0.12em;
    text-transform: uppercase;
  }

  .menu-heading strong {
    overflow: hidden;
    color: var(--color-text-primary);
    font-size: 12px;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  button {
    display: flex;
    width: 100%;
    align-items: center;
    gap: 10px;
    border: 0;
    border-radius: 9px;
    background: transparent;
    color: inherit;
    cursor: pointer;
    text-align: left;
  }

  button:hover,
  button:focus-visible {
    background: var(--color-surface-3);
  }

  button:focus-visible {
    outline: 2px solid color-mix(in srgb, var(--color-accent) 70%, transparent);
    outline-offset: -2px;
  }

  .menu-heading button {
    width: auto;
    padding: 5px;
    color: var(--color-text-muted);
  }

  .provider-icon-context-menu > button:not(.menu-heading button) {
    min-height: 48px;
    padding: 8px;
  }

  .provider-icon-context-menu > button > :global(svg) {
    flex: 0 0 auto;
    color: var(--color-accent);
  }

  .provider-icon-context-menu > button > span {
    display: flex;
    min-width: 0;
    flex-direction: column;
    gap: 2px;
  }

  .provider-icon-context-menu > button strong {
    font-size: 12px;
    font-weight: 600;
  }

  .provider-icon-context-menu > button small {
    color: var(--color-text-muted);
    font-size: 11px;
    line-height: 1.35;
  }
</style>
