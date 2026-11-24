<script lang="ts">
  import '../app.css';
  import { loadFont, loadMonoFont } from '$lib/fonts';
  import { theme } from '$lib/stores/theme.svelte';
  import { onMount } from 'svelte';
  import { loadProvidersFromApi } from '$lib/stores/providers.svelte';
  import { authStore } from '$lib/stores/auth.svelte';
  import { isDemoMode } from '$lib/demo.svelte';
  import { apiUrl, initUrls } from '$lib/utils/api-url';
  import { apiFetch, parseJsonResponse } from '$lib/api.svelte';
  import { sessionStore } from '$lib/stores/sessions.svelte';
  import { toastStore } from '$lib/stores/toast.svelte';
  import {
    startBackendHealthSentinel,
    waitForBackendHealthy,
  } from '$lib/stores/backend-health.svelte';
  import BackendDownOverlay from '$lib/components/BackendDownOverlay.svelte';
  import UpdateDialog from '$lib/components/UpdateDialog.svelte';
  import LaunchUpdateOverlay from '$lib/components/LaunchUpdateOverlay.svelte';
  import WindowResizeHandles from '$lib/components/WindowResizeHandles.svelte';
  import GlobalTooltip from '$lib/components/GlobalTooltip.svelte';
  import DesktopExitDialog from '$lib/components/DesktopExitDialog.svelte';
  import DOMPurify from 'dompurify';
  import { dispatchNoteLinkClick } from '$lib/utils/kory-link-favicon';

  let { children } = $props();
  let showInitialLoad = $state(true);
  let loadError = $state<string | null>(null);
  let appReady = $state(false);
  let retrying = $state(false);

  onMount(() => {
    // Direct DOM fallback for hiding loading screen
    const hideLoading = () => {
      showInitialLoad = false;
      // Also directly hide via DOM as fallback
      const el = document.querySelector('.initial-load');
      if (el) (el as HTMLElement).style.display = 'none';
    };

    // Lazy-load only the selected UI font + JetBrains Mono (for code blocks).
    // Previously all 13 font packages (60 CSS files) were eagerly imported.
    void loadMonoFont();
    void loadFont(theme.font);

    import('$lib/utils/error-monitor')
      .then((m) => m.initErrorMonitoring())
      .catch((err: unknown) => {
        console.warn(
          'Error monitor init failed:',
          err instanceof Error ? err.message : String(err),
        );
      });

    // Renderer stall monitor: rAF-gap + longtask tracking that reports
    // main-thread freezes through the error monitor above, so a UI freeze
    // leaves backend log + diagnostics evidence instead of no trace.
    import('$lib/utils/error-monitor')
      .then((m) => m.initStallMonitoring())
      .catch((err: unknown) => {
        console.warn(
          'Stall monitor init failed:',
          err instanceof Error ? err.message : String(err),
        );
      });

    // Demo builds have no backend at all: skip the health sentinel (its
    // overlay would block the whole demo after a few failed polls) and seed
    // the in-memory workspace instead.
    if (isDemoMode) {
      void import('$lib/demo.svelte')
        .then((m) => {
          m.seedDemo();
          appReady = true;
          hideLoading();
        })
        .catch((error: unknown) => {
          loadError =
            error instanceof Error
              ? `Koryphaios demo could not start: ${error.message}`
              : 'Koryphaios demo could not start.';
        });
      return;
    }

    // Resolve backend URLs first (in Tauri this discovers the runtime
    // backend), then start the health sentinel so its very first poll hits
    // the real backend rather than a baked dev URL — it surfaces the
    // BackendDownOverlay if the backend goes away or the version contract
    // rejects this frontend. A working UI without a working backend is never
    // allowed.
    void Promise.resolve()
      .then(() => initUrls())
      .then(() => startBackendHealthSentinel())
      .then(() => waitForBackendHealthy())
      .then(() => authStore.initialize())
      .then((authReady) => {
        if (!authReady) throw new Error('Backend authentication did not initialize.');
        // Registry initialization already warms enabled catalogs. Startup only
        // needs the current status; forcing here re-probes every rejected custom
        // credential before the user has asked to retry it.
        return loadProvidersFromApi();
      })
      .then((providersReady) => {
        if (!providersReady) throw new Error('Backend provider catalog failed to load.');
        appReady = true;
        hideLoading();
      })
      .catch((error: unknown) => {
        loadError = error instanceof Error ? error.message : 'Koryphaios could not initialize.';
        showInitialLoad = true;
      });

    // Global link interceptor for workspace file:// links, session links, and external browser links
    const handleExternalLinks = async (e: MouseEvent) => {
      if (dispatchNoteLinkClick(e)) return;
      const target = e.target as HTMLElement | null;
      const anchor = target?.closest('a');
      if (!anchor) return;

      const sessionId = anchor.getAttribute('data-kory-session-id');
      if (sessionId) {
        e.preventDefault();
        sessionStore.activeSessionId = sessionId;
        void sessionStore.fetchMessages(sessionId);
        return;
      }

      const filePath = anchor.getAttribute('data-kory-file-path');
      if (filePath) {
        e.preventDefault();
        const lineAttr = anchor.getAttribute('data-kory-line-start');
        const line = lineAttr ? Number.parseInt(lineAttr, 10) : undefined;
        try {
          const res = await apiFetch(apiUrl('/api/workspace/open-file'), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              path: filePath,
              ...(Number.isFinite(line) ? { line } : {}),
            }),
          });
          const json = await parseJsonResponse<{ ok?: boolean; error?: string }>(res);
          if (!res.ok || !json?.ok) {
            toastStore.error(json?.error ?? `Could not open ${filePath}`);
          }
        } catch {
          toastStore.error(`Could not open ${filePath}`);
        }
        return;
      }

      const href = anchor.getAttribute('href');
      if (!href) return;

      // Check if it's an external link
      const isExternal = href.startsWith('http://') || href.startsWith('https://');
      const isLocalhost = href.includes('localhost:') || href.includes('127.0.0.1:');

      if (isExternal && !isLocalhost) {
        const inTauri =
          typeof window !== 'undefined' &&
          ('__TAURI_INTERNALS__' in window || '__TAURI__' in window);

        if (inTauri) {
          e.preventDefault();
          try {
            const { open } = await import('@tauri-apps/plugin-shell');
            await open(href);
          } catch (err) {
            console.error('Failed to open external link in browser:', err);
          }
        }
      }
    };

    window.addEventListener('click', handleExternalLinks);

    // Global copy handler: the feed uses a virtual list with position:absolute
    // items, which can fragment the browser's native selection → copy pipeline.
    // Intercept every copy event, read the full live selection via
    // getSelection().toString(), and write that to the clipboard so the user
    // always gets exactly what they highlighted — never a partial fragment.
    const handleCopy = (e: ClipboardEvent) => {
      const selection = window.getSelection();
      const text = selection?.toString() ?? '';
      if (!text) return; // Let the default handle empty selections
      e.preventDefault();
      e.clipboardData?.setData('text/plain', text);
      // Best-effort HTML copy for rich-text targets (notes editors, docs)
      try {
        const contents = selection?.getRangeAt(0)?.cloneContents();
        if (contents) {
          const container = document.createElement('div');
          container.append(contents);
          const html = DOMPurify.sanitize(container.innerHTML);
          e.clipboardData?.setData('text/html', html || text);
        } else {
          e.clipboardData?.setData('text/html', text);
        }
      } catch {
        /* range extraction can throw on cross-shadow selections */
      }
    };
    document.addEventListener('copy', handleCopy);

    return () => {
      window.removeEventListener('click', handleExternalLinks);
      document.removeEventListener('copy', handleCopy);
    };
  });

  async function retryStartup() {
    retrying = true;
    loadError = null;
    try {
      await waitForBackendHealthy();
      const authReady = await authStore.initialize();
      if (!authReady || !(await loadProvidersFromApi({ forceRefreshModels: true })))
        throw new Error('Backend initialization is still incomplete.');
      appReady = true;
      showInitialLoad = false;
      const el = document.querySelector('.initial-load');
      if (el) (el as HTMLElement).style.display = 'none';
    } catch (error: unknown) {
      loadError = error instanceof Error ? error.message : 'Koryphaios could not initialize.';
      showInitialLoad = true;
    } finally {
      retrying = false;
    }
  }
</script>

<LaunchUpdateOverlay />

{#if showInitialLoad}
  <div class="initial-load" aria-live="polite" data-tauri-drag-region>
    {#if loadError}
      <div class="startup-error" data-tauri-drag-region="false">
        <h1>Koryphaios needs its backend</h1>
        <p>{loadError}</p>
        <button type="button" onclick={retryStartup} disabled={retrying}>
          {retrying ? 'Reconnecting…' : 'Retry connection'}
        </button>
      </div>
    {:else}
      <span data-tauri-drag-region>Starting backend services…</span>
    {/if}
  </div>
{/if}

{#if appReady}
  <WindowResizeHandles />
  <GlobalTooltip />
  <BackendDownOverlay />
  <UpdateDialog />
  <DesktopExitDialog />
  <svelte:boundary>
    {@render children()}
    {#snippet failed(error, reset)}
      <div class="app-render-error" role="alert">
        <h1>Koryphaios hit a rendering error</h1>
        <p>Reload the window to restore the workspace.</p>
        <button type="button" onclick={reset}>Retry</button>
      </div>
    {/snippet}
  </svelte:boundary>
{/if}

<style>
  .initial-load {
    position: fixed;
    inset: 0;
    z-index: 99999;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 24px;
    background: var(--color-surface-0, #09090b);
    color: var(--color-text-muted, #a1a1aa);
    font-family: var(--font-sans, system-ui, sans-serif);
    font-size: 13px;
    letter-spacing: 0.02em;
  }

  .startup-error {
    max-width: 440px;
    border: 1px solid var(--color-border, #27272a);
    border-radius: 14px;
    padding: 20px;
    background: var(--color-surface-1, #111113);
    color: var(--color-text-primary, #f4f4f5);
  }

  .startup-error h1 {
    margin: 0 0 8px;
    font-size: 16px;
    font-weight: 600;
  }

  .startup-error p {
    margin: 0 0 14px;
    color: var(--color-text-secondary, #a1a1aa);
    line-height: 1.5;
  }

  .startup-error button {
    min-height: 36px;
    border: 1px solid var(--color-border, #3f3f46);
    border-radius: 9px;
    padding: 0 14px;
    background: var(--color-surface-2, #18181b);
    color: var(--color-text-primary, #f4f4f5);
    font-size: 12px;
    font-weight: 600;
    cursor: pointer;
  }

  .startup-error button:disabled {
    opacity: 0.6;
    cursor: default;
  }

  .app-render-error {
    position: fixed;
    inset: 0;
    z-index: 99998;
    display: grid;
    place-content: center;
    gap: 8px;
    padding: 24px;
    background: var(--color-surface-0, #09090b);
    color: var(--color-text-primary, #f4f4f5);
    text-align: center;
  }

  .app-render-error h1 {
    margin: 0;
    font-size: 16px;
  }

  .app-render-error p {
    margin: 0 0 8px;
    color: var(--color-text-secondary, #a1a1aa);
  }

  .app-render-error button {
    justify-self: center;
    min-height: 34px;
    border: 1px solid var(--color-border, #3f3f46);
    border-radius: 8px;
    padding: 0 14px;
    background: var(--color-surface-2, #18181b);
    color: var(--color-text-primary, #f4f4f5);
    cursor: pointer;
  }
</style>
