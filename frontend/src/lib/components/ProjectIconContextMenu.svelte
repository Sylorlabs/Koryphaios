<script lang="ts">
  import { onMount, tick } from 'svelte';
  import Archive from 'lucide-svelte/icons/archive';
  import FolderOpen from 'lucide-svelte/icons/folder-open';
  import Pin from 'lucide-svelte/icons/pin';
  import Settings from 'lucide-svelte/icons/settings';
  import Trash2 from 'lucide-svelte/icons/trash-2';
  import X from 'lucide-svelte/icons/x';
  import { portalToBody } from '$lib/utils/portal';

  interface Props {
    id: string;
    projectName: string;
    projectPath: string;
    x: number;
    y: number;
    returnFocus?: HTMLElement | null;
    /** Whether the project currently sorts to the top of the sidebar. */
    pinned?: boolean;
    /** A workspace child cannot be removed: it is discovered from the folder,
     *  not stored, so removal would reappear on the next scan. */
    canRemove?: boolean;
    /** One unnamed chat at a time per folder. */
    newChatDisabled?: boolean;
    onaction: (action: string) => void | Promise<void>;
    onclose: () => void;
  }

  let {
    id,
    projectName,
    projectPath,
    x,
    y,
    returnFocus = null,
    pinned = false,
    canRemove = false,
    newChatDisabled = false,
    onaction,
    onclose,
  }: Props = $props();

  let menu = $state<HTMLDivElement>();
  let left = $state(0);
  let top = $state(0);

  const action = (name: string) => `${name}:${encodeURIComponent(projectPath)}`;

  function choose(name: string) {
    void onaction(action(name));
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
      const height = menu?.offsetHeight ?? 170;
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
  id={id}
  class="project-icon-context-menu"
  style={`left: ${left}px; top: ${top}px;`}
  role="menu"
  tabindex="-1"
  aria-label={`Actions for ${projectName}`}
  onkeydown={handleKeydown}
>
  <div class="menu-heading">
    <div class="min-w-0">
      <span class="menu-kicker">Project actions</span>
      <strong title={projectPath}>{projectName}</strong>
    </div>
    <button type="button" role="menuitem" aria-label="Close menu" onclick={onclose}>
      <X size={13} />
    </button>
  </div>

  <button type="button" role="menuitem" onclick={() => void choose('pin_project')}>
    <Pin size={14} />
    <span>
      <strong>{pinned ? 'Unpin project' : 'Pin project'}</strong>
      <small>{pinned ? 'Return it to recent order' : 'Keep it at the top of the sidebar'}</small>
    </span>
  </button>
  <button type="button" role="menuitem" onclick={() => void choose('open_project_identity')}>
    <Settings size={14} />
    <span>
      <strong>Edit</strong>
      <small>Change the name, icon, color, or image</small>
    </span>
  </button>
  <div class="menu-separator" role="separator"></div>
  <button type="button" role="menuitem" onclick={() => void choose('open_project_folder')}>
    <FolderOpen size={14} />
    <span>
      <strong>Open project in workspace</strong>
      <small>Switch to this project in the workspace</small>
    </span>
  </button>
  <button type="button" role="menuitem" onclick={() => void choose('archive_project_chats')}>
    <Archive size={14} />
    <span>
      <strong>Archive chats</strong>
      <small>Move this project's chats to the archive</small>
    </span>
  </button>
  <button
    type="button"
    role="menuitem"
    class="menu-danger"
    onclick={() => void choose('delete_project_chats')}
  >
    <Trash2 size={14} />
    <span>
      <strong>Delete chats</strong>
      <small>Permanently delete this project's chats</small>
    </span>
  </button>
  <div class="menu-separator" role="separator"></div>
  <button type="button" role="menuitem" onclick={() => void choose('close_project')}>
    <X size={14} />
    <span>
      <strong>Close project</strong>
      <small>Close this project in the sidebar</small>
    </span>
  </button>
  {#if canRemove}
    <div class="menu-separator" role="separator"></div>
    <button
      type="button"
      role="menuitem"
      class="menu-danger"
      onclick={() => void choose('remove_project')}
    >
      <X size={14} />
      <span>
        <strong>Remove project</strong>
        <small>The folder and its files are never touched</small>
      </span>
    </button>
  {/if}
</div>

<style>
  .project-icon-context-menu {
    position: fixed;
    z-index: 140;
    width: 286px;
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

  .menu-separator {
    height: 1px;
    margin: 6px 4px;
    background: var(--color-border);
  }

  .menu-danger > :global(svg),
  .menu-danger strong {
    color: var(--color-error);
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

  .project-icon-context-menu > button:not(.menu-heading button) {
    min-height: 48px;
    padding: 8px;
  }

  .project-icon-context-menu > button > :global(svg) {
    flex: 0 0 auto;
    color: var(--color-accent);
  }

  .project-icon-context-menu > button > span {
    display: flex;
    min-width: 0;
    flex-direction: column;
    gap: 2px;
  }

  .project-icon-context-menu > button strong {
    font-size: 12px;
    font-weight: 600;
  }

  .project-icon-context-menu > button small {
    color: var(--color-text-muted);
    font-size: 10px;
    line-height: 1.35;
  }
</style>
