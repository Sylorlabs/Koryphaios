<script lang="ts">
  import { onMount } from 'svelte';
  import { invoke } from '@tauri-apps/api/core';
  import { listen } from '@tauri-apps/api/event';
  import Monitor from 'lucide-svelte/icons/monitor';
  import Power from 'lucide-svelte/icons/power';

  type Request = { id: number; reason: 'close' | 'restart' | 'shutdown' | 'signout' };
  type Choice = 'background' | 'proceed' | 'cancel';
  let request = $state<Request | null>(null);
  let busy = $state(false);
  let error = $state('');
  let dialog = $state<HTMLElement | null>(null);
  let cancelButton = $state<HTMLButtonElement | null>(null);
  let previousFocus: HTMLElement | null = null;
  const closing = $derived(request?.reason === 'close');
  const title = $derived(
    closing ? 'Close Koryphaios?' : request?.reason === 'shutdown' ? 'Shut down computer?' :
      request?.reason === 'signout' ? 'Sign out?' : 'Restart computer?',
  );
  const proceedLabel = $derived(
    closing ? 'Quit anyway' : request?.reason === 'shutdown' ? 'Shut down anyway' :
      request?.reason === 'signout' ? 'Sign out anyway' : 'Restart anyway',
  );

  /** The desktop shell decides whether a close needs asking (it counts local
   * agents with the backend and falls back to a native dialog if this window
   * never acknowledges). Here we only present what it sends. */
  async function show(next: Request): Promise<void> {
    // Tell the shell this window owns the request, so it does not show a
    // native fallback on top of this dialog.
    void invoke('acknowledge_desktop_exit', { id: next.id }).catch(() => undefined);
    if (request && next.id < request.id) return;
    if (!request) previousFocus = document.activeElement as HTMLElement | null;
    request = next;
    error = '';
  }

  onMount(() => {
    if (!('__TAURI_INTERNALS__' in window || '__TAURI__' in window)) return;
    let disposed = false;
    const cleanup: Array<() => void> = [];
    void (async () => {
      const unlistenRequest = await listen<Request>('desktop://exit-requested', (event) => {
        void show(event.payload);
      });
      if (disposed) { unlistenRequest(); return; }
      cleanup.push(unlistenRequest);
      const unlistenCancel = await listen('desktop://exit-cancelled', () => {
        request = null;
        error = '';
        previousFocus?.focus();
      });
      if (disposed) { unlistenCancel(); return; }
      cleanup.push(unlistenCancel);
      // A close can arrive during startup, before the WebView subscribed.
      const pending = await invoke<Request | null>('get_desktop_exit_request');
      if (!disposed && pending) await show(pending);
    })().catch((cause) => console.error('Could not initialize close confirmation:', cause));
    return () => { disposed = true; cleanup.forEach((unlisten) => unlisten()); };
  });

  $effect(() => {
    if (request && cancelButton) cancelButton.focus();
  });

  $effect(() => {
    if (!request || !dialog) return;
    const overlay = dialog.parentElement;
    const siblings = Array.from(overlay?.parentElement?.children ?? [])
      .filter((element): element is HTMLElement => element instanceof HTMLElement && element !== overlay);
    const previous = siblings.map((element) => [element, element.inert] as const);
    siblings.forEach((element) => { element.inert = true; });
    return () => previous.forEach(([element, inert]) => { element.inert = inert; });
  });

  async function choose(choice: Choice) {
    if (!request || busy) return;
    const id = request.id;
    busy = true;
    error = '';
    try {
      await invoke('resolve_desktop_exit', { id, choice });
      if (request?.id === id) {
        request = null;
        previousFocus?.focus();
      }
    } catch (cause) {
      error = cause instanceof Error ? cause.message : String(cause);
    } finally {
      busy = false;
    }
  }

  function handleKeydown(event: KeyboardEvent) {
    if (!request) return;
    event.stopPropagation();
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopImmediatePropagation();
      void choose('cancel');
    } else if (event.key === 'Tab') {
      const buttons = dialog?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)');
      if (!buttons?.length) { event.preventDefault(); return; }
      const first = buttons[0];
      const last = buttons[buttons.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    }
  }
</script>

{#if request}
  <div class="exit-overlay" role="presentation">
    <div
      class="exit-dialog"
      role="alertdialog"
      aria-modal="true"
      aria-labelledby="desktop-exit-title"
      aria-describedby="desktop-exit-description"
      aria-busy={busy}
      tabindex="-1"
      onkeydown={handleKeydown}
      bind:this={dialog}
    >
      <div class="exit-heading">
        <span class="exit-icon" aria-hidden="true">
          {#if closing}<Monitor size={20} />{:else}<Power size={20} />{/if}
        </span>
        <h2 id="desktop-exit-title">{title}</h2>
      </div>
      <p id="desktop-exit-description">
        {#if closing}
          Keep local agents running in the background, or quit and stop them. Work on linked
          computers continues.
        {:else}
          This will interrupt local agents. Work already running on linked computers continues.
          Continue anyway?
        {/if}
      </p>
      {#if error}<p class="exit-error" role="alert">{error}</p>{/if}
      <div class="exit-actions">
        <button class="exit-button" disabled={busy} bind:this={cancelButton} onclick={() => void choose('cancel')}>Cancel</button>
        <button class="exit-button exit-stop" disabled={busy} onclick={() => void choose('proceed')}>{proceedLabel}</button>
        {#if closing}
          <button class="exit-button exit-primary" disabled={busy} onclick={() => void choose('background')}>Run in background</button>
        {/if}
      </div>
    </div>
  </div>
{/if}

<style>
  .exit-overlay {
    position: fixed;
    inset: 0;
    z-index: 12000;
    display: grid;
    place-items: center;
    padding: var(--space-4);
    background: color-mix(in srgb, var(--color-surface-0) 72%, transparent);
    backdrop-filter: blur(5px);
  }
  .exit-dialog {
    width: min(100%, 29rem);
    padding: var(--space-6);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-lg);
    background: var(--color-surface-1);
    box-shadow: 0 16px 48px color-mix(in srgb, var(--color-surface-0) 60%, transparent);
  }
  .exit-heading { display: flex; align-items: center; gap: var(--space-3); }
  .exit-icon { display: grid; place-items: center; flex: none; width: 36px; height: 36px; border-radius: var(--radius-md); background: var(--color-surface-3); color: var(--color-accent); }
  h2 { margin: 0; font-size: var(--text-lg); font-weight: 600; color: var(--color-text-primary); }
  p { margin: var(--space-4) 0 0; font-size: var(--text-sm); line-height: 1.6; color: var(--color-text-secondary); }
  .exit-error { color: var(--color-error); overflow-wrap: anywhere; }
  .exit-actions { display: flex; justify-content: flex-end; flex-wrap: wrap; gap: var(--space-2); margin-top: var(--space-6); }
  .exit-button { min-height: 36px; padding: var(--space-2) var(--space-3); border: 1px solid var(--color-border); border-radius: var(--radius-md); background: var(--color-surface-2); color: var(--color-text-primary); font-size: var(--text-sm); font-weight: 500; cursor: pointer; }
  .exit-button:hover { background: var(--color-surface-3); }
  .exit-button:focus-visible { outline: 2px solid var(--color-accent); outline-offset: 3px; }
  .exit-button:disabled { opacity: 0.6; cursor: wait; }
  .exit-stop { color: var(--color-text-secondary); }
  .exit-primary { background: var(--color-accent); border-color: var(--color-accent); color: var(--color-on-accent); }
  .exit-primary:hover { background: color-mix(in srgb, var(--color-accent) 88%, var(--color-text-primary)); }
  @media (max-width: 480px) {
    .exit-dialog { padding: var(--space-5); }
    .exit-actions { display: grid; grid-template-columns: 1fr; }
    .exit-button { width: 100%; }
  }
</style>
