<script lang="ts">
  import { onMount } from 'svelte';
  import FolderPlus from 'lucide-svelte/icons/folder-plus';
  import PanelLeftClose from 'lucide-svelte/icons/panel-left-close';
  import X from 'lucide-svelte/icons/x';
  import { portalToBody } from '$lib/utils/portal';

  interface Props {
    id: string;
    workspaceName: string;
    workspacePath: string;
    x: number;
    y: number;
    expanded: boolean;
    returnFocus?: HTMLElement | null;
    onaction: (action: string) => void;
    onclose: () => void;
  }

  let {
    id,
    workspaceName,
    workspacePath,
    x,
    y,
    expanded,
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
    const position = () => {
      const width = menu?.offsetWidth ?? 286;
      const height = menu?.offsetHeight ?? 178;
      left = Math.max(8, Math.min(x, window.innerWidth - width - 8));
      top = Math.max(8, Math.min(y, window.innerHeight - height - 8));
    };
    position();
    menu?.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus();

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
  class="workspace-icon-context-menu"
  style={`left: ${left}px; top: ${top}px;`}
  role="menu"
  tabindex="-1"
  aria-label={`Actions for ${workspaceName} workspace`}
  onkeydown={handleKeydown}
>
  <div class="menu-heading">
    <div class="min-w-0">
      <span class="menu-kicker">Workspace actions</span>
      <strong title={workspacePath}>{workspaceName}</strong>
    </div>
    <button type="button" role="menuitem" aria-label="Close workspace actions" onclick={onclose}>
      <X size={13} />
    </button>
  </div>

  <button type="button" role="menuitem" onclick={() => choose('new_project')}>
    <FolderPlus size={14} />
    <span>
      <strong>New project here</strong>
      <small>Create a project folder inside this workspace</small>
    </span>
  </button>
  <button type="button" role="menuitem" onclick={() => choose('workspace_toggle')}>
    <PanelLeftClose size={14} />
    <span>
      <strong>{expanded ? 'Collapse workspace' : 'Expand workspace'}</strong>
      <small>Show or hide the projects in this workspace</small>
    </span>
  </button>
</div>

<style>
  .workspace-icon-context-menu {
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
    font-size: 9px;
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

  .workspace-icon-context-menu > button:not(.menu-heading button) {
    min-height: 48px;
    padding: 8px;
  }

  .workspace-icon-context-menu > button > :global(svg) {
    flex: 0 0 auto;
    color: var(--color-accent);
  }

  .workspace-icon-context-menu > button > span {
    display: flex;
    min-width: 0;
    flex-direction: column;
    gap: 2px;
  }

  .workspace-icon-context-menu > button strong {
    font-size: 12px;
    font-weight: 600;
  }

  .workspace-icon-context-menu > button small {
    color: var(--color-text-muted);
    font-size: 10px;
    line-height: 1.35;
  }
</style>
