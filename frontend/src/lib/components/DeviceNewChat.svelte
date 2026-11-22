<script lang="ts">
  import { deviceStore } from '$lib/stores/devices.svelte';
  import { sessionStore } from '$lib/stores/sessions.svelte';
  import { collaborationStore } from '$lib/stores/collaboration.svelte';
  import type { DeviceWorkspace, DeviceChat } from '@koryphaios/shared/src/devices';
  import type { CreatorMode } from '$lib/stores/devices.svelte';
  import Monitor from 'lucide-svelte/icons/monitor';
  import FolderOpen from 'lucide-svelte/icons/folder-open';
  import ChevronRight from 'lucide-svelte/icons/chevron-right';
  import ArrowLeft from 'lucide-svelte/icons/arrow-left';
  import X from 'lucide-svelte/icons/x';
  import LoaderCircle from 'lucide-svelte/icons/loader-circle';
  let {
    onAction,
    onSelectFolder,
  }: {
    onAction?: (action: string) => unknown;
    onSelectFolder?: (
      path: string,
      mode: Exclude<CreatorMode, 'chat'>,
    ) => Promise<unknown> | unknown;
  } = $props();
  let dialog = $state<HTMLDialogElement | null>(null);
  let deviceId = $state('');
  let roots = $state<DeviceWorkspace[]>([]);
  let folders = $state<DeviceWorkspace[]>([]);
  let root = $state<DeviceWorkspace | null>(null);
  let browsing = $state(false);
  let parent = $state<DeviceWorkspace | null>(null);
  let chats = $state<DeviceChat[]>([]);
  let search = $state('');
  let loading = $state(false);
  let creating = $state(false);
  let error = $state('');
  let loadSequence = 0;
  const status = $derived(deviceStore.status);
  const folderMode = $derived(
    deviceStore.creatorMode === 'project' || deviceStore.creatorMode === 'workspace',
  );
  const folderModeLabel = $derived(
    deviceStore.creatorMode === 'workspace' ? 'workspace' : 'project',
  );
  const devices = $derived([
    ...(status?.local ? [{ ...status.local, online: true }] : []),
    ...(status?.peers.filter((p) => p.kind === 'desktop') ?? []),
  ]);
  const visibleDevices = $derived(
    folderMode ? devices.filter((device) => device.id === status?.local?.id) : devices,
  );
  const showDeviceChooser = $derived(visibleDevices.length > 1);
  const chosen = $derived(devices.find((d) => d.id === deviceId));
  const local = $derived(deviceId === status?.local?.id);
  const choices = $derived(
    (root || browsing ? folders : roots).filter((folder) =>
      folder.name.toLowerCase().includes(search.toLowerCase()),
    ),
  );
  $effect(() => {
    if (deviceStore.createOpen && dialog && !dialog.open) {
      ++loadSequence;
      dialog.showModal();
      deviceId = '';
      root = null;
      browsing = false;
      parent = null;
      roots = [];
      folders = [];
      chats = [];
      loading = false;
      search = '';
      error = '';
    } else if (!deviceStore.createOpen && dialog?.open) dialog.close();
  });
  $effect(() => {
    const localId = status?.local?.id;
    if (!deviceStore.createOpen || !dialog?.open || showDeviceChooser || deviceId || !localId) return;
    if (folderMode) void browseLocalFolder(undefined, localId);
    else void chooseDevice(localId);
  });
  async function chooseDevice(id: string) {
    const sequence = ++loadSequence;
    deviceId = id;
    root = null;
    browsing = false;
    parent = null;
    search = '';
    error = '';
    loading = true;
    roots = [];
    folders = [];
    chats = [];
    try {
      const [workspaces, sessions] = await Promise.all([
        deviceStore.workspaces(id),
        deviceStore.rpc(id, 'sessions'),
      ]);
      if (sequence !== loadSequence) return;
      roots = workspaces;
      chats = sessions;
    } catch (e) {
      if (sequence === loadSequence)
        error = e instanceof Error ? e.message : 'Could not load this device';
    } finally {
      if (sequence === loadSequence) loading = false;
    }
  }
  async function browse(folder: DeviceWorkspace) {
    const sequence = ++loadSequence;
    search = '';
    loading = true;
    error = '';
    try {
      const result = await deviceStore.folders(deviceId, folder.id);
      if (sequence === loadSequence) {
        root = folder;
        folders = result;
      }
    } catch (e) {
      if (sequence === loadSequence)
        error = e instanceof Error ? e.message : 'Workspace unavailable';
    } finally {
      if (sequence === loadSequence) loading = false;
    }
  }
  async function browseLocalFolder(folder?: DeviceWorkspace, targetDeviceId = deviceId) {
    if (creating) return;
    const sequence = ++loadSequence;
    const switchingDevice = targetDeviceId && deviceId !== targetDeviceId;
    if (switchingDevice) {
      deviceId = targetDeviceId;
      root = null;
      parent = null;
      browsing = false;
      folders = [];
    }
    browsing = true;
    search = '';
    error = '';
    loading = true;
    try {
      const listing = await deviceStore.browseFolders(targetDeviceId, folder?.id);
      if (sequence !== loadSequence) return;
      root = listing.current;
      parent = listing.parent;
      folders = listing.folders;
    } catch (e) {
      if (sequence === loadSequence)
        error = e instanceof Error ? e.message : 'Could not browse folders on this desktop';
    } finally {
      if (sequence === loadSequence) loading = false;
    }
  }
  async function selectFolder() {
    const selected = root;
    const mode = deviceStore.creatorMode;
    if (!selected || !folderMode || mode === 'chat' || !onSelectFolder || creating) return;
    creating = true;
    error = '';
    try {
      await onSelectFolder(selected.displayPath, mode);
      deviceStore.closeCreator();
    } catch (e) {
      error = e instanceof Error ? e.message : `Could not open this ${folderModeLabel}`;
    } finally {
      creating = false;
    }
  }
  function backToWorkspaces() {
    ++loadSequence;
    root = null;
    parent = null;
    browsing = false;
    folders = [];
    search = '';
    error = '';
    loading = false;
  }
  async function create(folder: DeviceWorkspace) {
    if (creating) return;
    creating = true;
    error = '';
    try {
      const chat = await deviceStore.rpc(deviceId, 'create_chat', { workspaceId: folder.id });
      collaborationStore.closeJoinedSession();
      if (local) {
        deviceStore.closeChat();
        await sessionStore.fetchSessions();
        sessionStore.activeSessionId = chat.id;
      } else await deviceStore.openChat(chat);
      deviceStore.closeCreator();
    } catch (e) {
      error = e instanceof Error ? e.message : 'Could not create chat';
    } finally {
      creating = false;
    }
  }
  async function open(chat: DeviceChat) {
    collaborationStore.closeJoinedSession();
    if (local) {
      deviceStore.closeChat();
      sessionStore.activeSessionId = chat.id;
    } else await deviceStore.openChat(chat);
    deviceStore.closeCreator();
  }
</script>

<dialog
  bind:this={dialog}
  onclose={() => deviceStore.closeCreator()}
  oncancel={() => deviceStore.closeCreator()}
  aria-labelledby="device-chat-title"
>
  <div class="shell">
    <header>
      <div>
        <span class="eyebrow">{folderMode ? 'FOLDER FINDER' : 'NEW CHAT'}</span>
        <h2 id="device-chat-title">
          {folderMode ? `Choose a ${folderModeLabel}` : 'Where would you like to work?'}
        </h2>
        <p>
          {folderMode
            ? `Browse folders on this desktop to choose a ${folderModeLabel}.`
            : 'Choose a desktop and a project folder. The chat stays on that device.'}
        </p>
      </div>
      <button
        type="button"
        class="icon-button"
        aria-label="Close new chat"
        onclick={() => deviceStore.closeCreator()}><X size={18} /></button
      >
    </header>
    <div class:single-device={!showDeviceChooser} class="body">
      {#if showDeviceChooser}<aside aria-label="Choose a device">
        <span class="section-label">DESKTOPS</span>{#each visibleDevices as device (device.id)}<button
            type="button"
            class:chosen={deviceId === device.id}
            class="device"
            disabled={!device.online || creating}
            onclick={() => void chooseDevice(device.id)}
            ><Monitor size={18} /><span
              ><strong>{device.name}</strong><small
                >{device.id === status?.local?.id
                  ? 'This desktop'
                  : device.online
                    ? 'Connected'
                    : 'Offline'} · {device.os}</small
              ></span
            ></button
          >{/each}<button
          type="button"
          class="link-action"
          disabled={creating}
          onclick={() => {
            deviceStore.closeCreator();
            onAction?.('link_device');
          }}>+ Link another device</button
        >
      </aside>{/if}
      <main aria-busy={loading}>
        <div class="workspace-heading">
          {#if root || browsing}<button
              type="button"
              class="icon-button"
              aria-label="Back to workspaces"
              disabled={creating || loading}
              onclick={backToWorkspaces}><ArrowLeft size={16} /></button
            >{/if}
          <div>
            <h3>{root?.name ?? chosen?.name ?? (folderMode ? 'Choose a folder' : 'Choose a desktop')}</h3>
            {#if chosen && !folderMode}<p>
                {browsing
                  ? `Folders on ${chosen.name}`
                  : `${chosen.os} · ${root ? 'Folders in this workspace' : 'Available workspaces'}`}
              </p>{/if}
          </div>
        </div>
        {#if deviceId}<input
            class="search"
            aria-label="Search device folders"
            placeholder="Find a workspace or folder"
            bind:value={search}
          />{/if}
        {#if deviceId && !root && !browsing}
          <div class="folder-picker">
            <button
              type="button"
              class="secondary"
              disabled={creating || loading}
              onclick={() => void browseLocalFolder()}
              ><FolderOpen size={16} />
              {local ? 'Choose a local folder' : `Choose a local folder on ${chosen?.name}`}</button
            >
            <p>Browse folders on {chosen?.name} to choose where this chat works.</p>
          </div>
        {/if}
        {#if loading && !root && !choices.length && !chats.length && !parent}<div class="empty" role="status">
            <LoaderCircle size={22} class="animate-spin" />
            <p>Loading from {chosen?.name}…</p>
          </div>{:else if !deviceId}<div class="empty">
            <Monitor size={34} />
            <p>Your current desktop and linked desktops appear on the left.</p>
          </div>{:else}
          {#if browsing && parent}<button
              type="button"
              class="parent-folder secondary"
              disabled={creating || loading}
              onclick={() => void browseLocalFolder(parent!)}
              ><ArrowLeft size={15} /> Up one folder</button
            >{/if}
          {#if root}<div class="root-action">
              <div>
                <strong>Selected folder</strong>
                <p class="selected-path">{root.displayPath}</p>
              </div>
              {#if folderMode}
                <button type="button" class="primary" disabled={creating || loading} onclick={() => void selectFolder()}
                  >Choose {folderModeLabel}</button
                >
              {:else}
                <button type="button" class="primary" disabled={creating || loading} onclick={() => void create(root!)}
                  >New chat in {root.name}</button
                >
              {/if}
            </div>{/if}
          <div class="folders">
            {#each choices as folder (folder.id)}<div class="folder">
                <button
                  type="button"
                  class="folder-label"
                  title={folder.displayPath}
                  disabled={creating || loading}
                  onclick={() =>
                    browsing
                      ? void browseLocalFolder(folder)
                      : root
                        ? void create(folder)
                        : void browse(folder)}
                  ><FolderOpen size={18} /><span
                    ><strong>{folder.name}</strong><small>{folder.displayPath}</small></span
                >{#if !root || browsing}<ChevronRight size={15} />{/if}</button
                >{#if !root && !folderMode}<button
                    type="button"
                    class="small-button"
                    disabled={creating || loading}
                    onclick={() => void create(folder)}>New chat</button
                  >{/if}
              </div>{/each}
          </div>
          {#if !choices.length}<p class="empty">
              {search
                ? 'No matching folders.'
                : browsing
                  ? 'No subfolders here. Use the selected folder or go up one level.'
                  : root
                    ? 'No project folders here. Start a chat in the workspace itself.'
                    : 'No workspace is open on this device yet.'}
            </p>{/if}
          {#if chats.length && !root && !browsing && !folderMode}<section
              class="recent-chats"
              aria-label="Recent chats"
            >
              <h4>Recent chats on {chosen?.name}</h4>
              {#each chats.slice(-5).reverse() as chat (chat.id)}<button
                  type="button"
                  class="recent-chat"
                  disabled={creating || loading}
                  onclick={() => void open(chat)}
                  ><span>{chat.title}</span><small>{chat.workspaceName}</small><ChevronRight
                    size={14}
                  /></button
                >{/each}
            </section>{/if}
        {/if}
        {#if error}<p class="error" role="alert">{error}</p>{/if}
      </main>
    </div>
    <footer>
      {#if creating}<LoaderCircle size={14} class="animate-spin" /> {folderMode ? 'Opening folder…' : 'Creating chat…'}{:else}<span
          >{folderMode ? 'Choose a folder to continue.' : 'Device selection is fixed for each chat. Open another chat to work elsewhere.'}</span
        >{/if}
    </footer>
  </div>
</dialog>

<style>
  dialog {
    border: 1px solid var(--color-border);
    border-radius: 20px;
    padding: 0;
    color: var(--color-text-primary);
    background: var(--color-surface-1);
    width: min(780px, calc(100vw - 32px));
    max-height: calc(100dvh - 40px);
    margin: auto;
    box-shadow: 0 24px 80px color-mix(in srgb, var(--color-text-primary) 15%, transparent);
  }
  dialog::backdrop {
    background: color-mix(in srgb, var(--color-surface-1) 65%, transparent);
    backdrop-filter: blur(6px);
  }
  .shell {
    display: flex;
    flex-direction: column;
    max-height: calc(100dvh - 44px);
  }
  header {
    display: flex;
    gap: 20px;
    justify-content: space-between;
    padding: 24px;
    border-bottom: 1px solid var(--color-border);
  }
  h2 {
    font-size: 21px;
    font-weight: 650;
    margin: 6px 0;
  }
  .eyebrow,
  .section-label {
    font-size: 11px;
    color: var(--color-text-muted);
    letter-spacing: 0.12em;
    font-weight: 650;
  }
  p {
    font-size: 12px;
    line-height: 1.6;
    color: var(--color-text-muted);
    margin: 0;
  }
  button {
    cursor: pointer;
    color: inherit;
    font-size: 12px;
    border: 0;
    background: transparent;
  }
  button:disabled {
    opacity: 0.45;
    cursor: not-allowed;
  }
  button:focus-visible {
    outline: 2px solid var(--color-accent);
    outline-offset: 2px;
  }
  .icon-button {
    display: grid;
    place-items: center;
    width: 30px;
    height: 30px;
    flex-shrink: 0;
    border-radius: 7px;
  }
  .icon-button:hover {
    background: var(--color-surface-3);
  }
  .body {
    display: grid;
    grid-template-columns: 210px minmax(0, 1fr);
    min-width: 0;
    min-height: 0;
    overflow: auto;
  }
  .body.single-device {
    grid-template-columns: minmax(0, 1fr);
  }
  aside {
    padding: 24px 14px;
    border-right: 1px solid var(--color-border);
  }
  .section-label {
    display: block;
    margin: 0 10px 12px;
  }
  .device {
    width: 100%;
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 12px 10px;
    border-radius: 10px;
    text-align: left;
    margin-bottom: 6px;
  }
  .device.chosen {
    background: var(--color-surface-3);
    box-shadow: inset 0 0 0 1px var(--color-accent);
  }
  .device span {
    display: grid;
    gap: 4px;
    min-width: 0;
  }
  .device strong {
    font-size: 12px;
    overflow-wrap: anywhere;
  }
  small {
    font-size: 11px;
    color: var(--color-text-muted);
  }
  .link-action {
    display: block;
    color: var(--color-accent);
    padding: 12px 8px;
    text-align: left;
  }
  main {
    padding: 24px;
    min-width: 0;
  }
  .workspace-heading {
    display: flex;
    gap: 8px;
    align-items: center;
    margin-bottom: 16px;
  }
  h3 {
    font-size: 14px;
    font-weight: 600;
    margin: 0 0 4px;
  }
  .search {
    width: 100%;
    border: 1px solid var(--color-border);
    background: var(--color-surface-2);
    padding: 10px;
    border-radius: 8px;
    color: var(--color-text-primary);
    font-size: 12px;
    margin-bottom: 20px;
    box-sizing: border-box;
  }
  .empty {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 12px;
    color: var(--color-text-muted);
    text-align: center;
    padding: 30px 12px;
  }
  .folder {
    display: flex;
    align-items: center;
    border-bottom: 1px solid var(--color-border);
    gap: 8px;
  }
  .folders {
    border: 1px solid var(--color-border);
    border-radius: 10px;
    overflow: hidden;
  }
  .folders:empty {
    display: none;
  }
  .folder:last-child {
    border-bottom: 0;
  }
  .folder {
    padding: 2px 12px;
    min-height: 60px;
  }
  .folder:hover,
  .recent-chat:hover {
    background: var(--color-surface-2);
  }
  .folder-label :global(svg) {
    flex-shrink: 0;
  }
  .folder-label {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 12px 0;
    min-width: 0;
    flex: 1;
    text-align: left;
  }
  .folder-label span {
    display: grid;
    gap: 4px;
    min-width: 0;
    flex: 1;
  }
  .folder-label strong {
    font-size: 12px;
  }
  .folder-label small {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .small-button {
    padding: 7px;
    border-radius: 6px;
    background: var(--color-surface-3);
    white-space: nowrap;
    font-size: 11px;
  }
  .root-action {
    display: grid;
    gap: 8px;
    margin-bottom: 16px;
    font-size: 11px;
    color: var(--color-text-muted);
    padding: 16px;
    border: 1px solid var(--color-border);
    background: var(--color-surface-2);
    border-radius: 10px;
    gap: 14px;
  }
  .selected-path {
    margin-top: 6px;
    overflow-wrap: anywhere;
  }
  .parent-folder {
    margin-bottom: 16px;
  }
  .folder-picker {
    display: grid;
    justify-items: start;
    gap: 8px;
    margin-bottom: 24px;
  }
  .recent-chats {
    margin-top: 24px;
    padding-top: 20px;
    border-top: 1px solid var(--color-border);
  }
  .primary {
    background: var(--color-accent);
    color: var(--color-on-accent);
    padding: 10px 12px;
    border-radius: 8px;
  }
  .secondary {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    background: var(--color-surface-3);
    padding: 10px 12px;
    border-radius: 8px;
  }
  h4 {
    font-size: 11px;
    color: var(--color-text-muted);
    margin: 0 0 10px;
  }
  .recent-chat {
    display: flex;
    width: 100%;
    align-items: center;
    gap: 10px;
    padding: 10px 12px;
    border-radius: 8px;
    text-align: left;
  }
  .recent-chat span {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .error {
    color: var(--color-error);
    margin-top: 16px;
    padding: 12px 14px;
    border: 1px solid color-mix(in srgb, var(--color-error) 35%, transparent);
    background: color-mix(in srgb, var(--color-error) 7%, var(--color-surface-1));
    border-radius: 10px;
    overflow-wrap: anywhere;
  }
  footer {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 14px 24px;
    border-top: 1px solid var(--color-border);
    font-size: 11px;
    color: var(--color-text-muted);
  }
  @media (max-width: 580px) {
    .body {
      grid-template-columns: 1fr;
    }
    aside {
      border-right: 0;
      border-bottom: 1px solid var(--color-border);
      padding: 12px;
    }
    .device {
      display: inline-flex;
      width: auto;
      margin: 4px;
    }
    .section-label {
      margin-bottom: 6px;
    }
    header {
      padding: 18px;
    }
    h2 {
      font-size: 18px;
    }
    main {
      padding: 16px;
    }
  }
</style>
