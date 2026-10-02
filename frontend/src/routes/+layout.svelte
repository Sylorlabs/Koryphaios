<script lang="ts">
	import '../app.css';
	import { loadFont, loadMonoFont } from '$lib/fonts';
	import { theme } from '$lib/stores/theme.svelte';
	import { onMount } from 'svelte';
	import { loadProvidersFromApi } from '$lib/stores/providers.svelte';
	import { authStore } from '$lib/stores/auth.svelte';
	import { isDemoMode } from '$lib/demo.svelte';
	import { initUrls } from '$lib/utils/api-url';
	import { startBackendHealthSentinel, waitForBackendHealthy } from '$lib/stores/backend-health.svelte';
	import BackendDownOverlay from '$lib/components/BackendDownOverlay.svelte';
	import UpdateDialog from '$lib/components/UpdateDialog.svelte';
	import WindowResizeHandles from '$lib/components/WindowResizeHandles.svelte';
	import GlobalTooltip from '$lib/components/GlobalTooltip.svelte';

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

		import('$lib/utils/error-monitor').then((m) => m.initErrorMonitoring()).catch((err: unknown) => {
			console.warn('Error monitor init failed:', err instanceof Error ? err.message : String(err));
		});

		// Renderer stall monitor: rAF-gap + longtask tracking that reports
		// main-thread freezes through the error monitor above, so a UI freeze
		// leaves backend log + diagnostics evidence instead of no trace.
		import('$lib/utils/error-monitor').then((m) => m.initStallMonitoring()).catch((err: unknown) => {
			console.warn('Stall monitor init failed:', err instanceof Error ? err.message : String(err));
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
					loadError = error instanceof Error
						? `Koryphaios demo could not start: ${error.message}`
						: 'Koryphaios demo could not start.';
				});
			return;
		}

		// Start the backend health sentinel immediately — it polls /api/health
		// and surfaces the BackendDownOverlay if the backend goes away or the
		// version contract rejects this frontend. A working UI without a
		// working backend is never allowed.
		startBackendHealthSentinel();

		// Resolve backend URLs first, then wait for auth before requesting protected data.
		void Promise.resolve()
			.then(() => initUrls())
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

		// Global link interceptor to open external links in default browser when in Tauri
		const handleExternalLinks = async (e: MouseEvent) => {
			const target = e.target as HTMLElement | null;
			const anchor = target?.closest('a');
			if (!anchor) return;

			const href = anchor.getAttribute('href');
			if (!href) return;

			// Check if it's an external link
			const isExternal = href.startsWith('http://') || href.startsWith('https://');
			const isLocalhost = href.includes('localhost:') || href.includes('127.0.0.1:');

			if (isExternal && !isLocalhost) {
				const inTauri = typeof window !== 'undefined' && 
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
				const html = selection?.getRangeAt(0)?.cloneContents()?.textContent ?? text;
				e.clipboardData?.setData('text/html', html);
			} catch { /* range extraction can throw on cross-shadow selections */ }
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
			if (!authReady || !(await loadProvidersFromApi({ forceRefreshModels: true }))) throw new Error('Backend initialization is still incomplete.');
			appReady = true;
			showInitialLoad = false;
		} catch (error: unknown) {
			loadError = error instanceof Error ? error.message : 'Koryphaios could not initialize.';
		} finally {
			retrying = false;
		}
	}
</script>

<svelte:head>
	<title>Koryphaios</title>
</svelte:head>

<div class="layout-root">
	<WindowResizeHandles />
	<GlobalTooltip />
	<a href="#main-content" class="skip-link">Skip to main content</a>
	{#if showInitialLoad || !appReady}
		<div class="initial-load" aria-live="polite" data-tauri-drag-region>
			{#if loadError}
				<div class="startup-error" data-tauri-drag-region="false">
					<strong>Koryphaios is waiting for its backend</strong>
					<span>{loadError}</span>
					<button type="button" onclick={retryStartup} disabled={retrying}>{retrying ? 'Retrying…' : 'Retry now'}</button>
				</div>
			{:else}
				<div class="initial-load-dot"></div>
				<span data-tauri-drag-region>Starting backend services…</span>
			{/if}
		</div>
	{/if}
	<main id="main-content">
		<!-- Last-resort error boundary. Without one, an exception thrown inside an
		     `$effect` is rethrown out of Svelte's reactive flush, the remaining
		     queued effects never run, and the whole UI freezes with every control
		     dead — the window frame, overlays and recovery UI must outlive the app
		     content so the user is never trapped. A boundary also routes the error
		     through SvelteKit's `handleError` hook instead of straight to
		     `window.onerror`. -->
		<svelte:boundary>
			{#if appReady}{@render children()}{/if}

			{#snippet failed(error, reset)}
				<div class="app-crash" role="alert">
					<strong>Koryphaios hit an unexpected error</strong>
					<span class="app-crash-detail"
						>{error instanceof Error ? error.message : String(error)}</span
					>
					<div class="app-crash-actions">
						<button type="button" onclick={reset}>Try again</button>
						<button
							type="button"
							class="app-crash-reload"
							onclick={() => window.location.reload()}>Reload Koryphaios</button
						>
					</div>
				</div>
			{/snippet}
		</svelte:boundary>
	</main>

	<!-- Backend unavailable / version-skew overlay. Mounted only when the
	     backend is sustained-unhealthy or rejects this frontend build. -->
	<BackendDownOverlay />

	<!-- Update Dialog - modal for detailed update info -->
	<UpdateDialog />
</div>

<style>
	.layout-root {
		min-height: 100vh;
		background: var(--color-surface-0);
		color: var(--color-text-primary);
	}
	.initial-load {
		position: fixed;
		inset: 0;
		display: flex;
		align-items: center;
		justify-content: center;
		gap: var(--space-md);
		background: var(--color-surface-0);
		color: var(--color-text-muted);
		font-size: var(--text-base);
		z-index: 10000;
		pointer-events: none;
	}
	.initial-load-dot {
		width: var(--size-2);
		height: var(--size-2);
		border-radius: var(--radius-full);
		background: var(--color-accent);
		animation: pulse 1s ease-in-out infinite;
	}
	.startup-error { display: flex; flex-direction: column; align-items: center; gap: var(--space-md); max-width: 32rem; padding: var(--space-xl); text-align: center; pointer-events: auto; }
	.startup-error strong { color: var(--color-text-primary); font-size: var(--text-lg); }
	.startup-error span { color: var(--color-text-secondary); font-size: var(--text-sm); }
	.startup-error button { padding: var(--space-sm) var(--space-lg); border: 1px solid var(--color-accent); border-radius: var(--radius-md); background: var(--color-accent); color: var(--color-surface-0); cursor: pointer; }
	.startup-error button:disabled { opacity: 0.6; cursor: wait; }
	.app-crash {
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		gap: var(--space-md);
		min-height: 100vh;
		max-width: 36rem;
		margin: 0 auto;
		padding: var(--space-xl);
		text-align: center;
	}
	.app-crash strong { color: var(--color-text-primary); font-size: var(--text-lg); }
	.app-crash-detail {
		color: var(--color-text-secondary);
		font-size: var(--text-sm);
		font-family: var(--font-mono, monospace);
		overflow-wrap: anywhere;
	}
	.app-crash-actions { display: flex; flex-wrap: wrap; gap: var(--space-md); justify-content: center; }
	.app-crash-actions button {
		padding: var(--space-sm) var(--space-lg);
		border: 1px solid var(--color-border);
		border-radius: var(--radius-md);
		background: var(--color-surface-2);
		color: var(--color-text-primary);
		cursor: pointer;
	}
	.app-crash-actions .app-crash-reload {
		border-color: var(--color-accent);
		background: var(--color-accent);
		color: var(--color-on-accent);
	}
	@keyframes pulse {
		0%, 100% { opacity: 1; }
		50% { opacity: 0.4; }
	}
</style>
