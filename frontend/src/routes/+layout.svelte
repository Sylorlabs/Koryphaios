<script lang="ts">
	import '../app.css';
	import '$lib/fonts';
	import { onMount } from 'svelte';
	import { loadProvidersFromApi } from '$lib/stores/providers.svelte';
	import { authStore } from '$lib/stores/auth.svelte';
	import { isDemoMode } from '$lib/demo.svelte';
	import { initUrls } from '$lib/utils/api-url';
	import { startBackendHealthSentinel, waitForBackendHealthy } from '$lib/stores/backend-health.svelte';
	import BackendDownOverlay from '$lib/components/BackendDownOverlay.svelte';
	import UpdateBanner from '$lib/components/UpdateBanner.svelte';
	import UpdateDialog from '$lib/components/UpdateDialog.svelte';

	let { children } = $props();
	let showInitialLoad = $state(true);
	let isOffline = $state(false);
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

		import('$lib/utils/error-monitor').then((m) => m.initErrorMonitoring()).catch(() => {});

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

		isOffline = !navigator.onLine;
		const goOffline = () => { isOffline = true; };
		const goOnline = () => { isOffline = false; };
		window.addEventListener('offline', goOffline);
		window.addEventListener('online', goOnline);

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

		return () => {
			window.removeEventListener('offline', goOffline);
			window.removeEventListener('online', goOnline);
			window.removeEventListener('click', handleExternalLinks);
		};
	});

	async function retryStartup() {
		retrying = true;
		loadError = null;
		try {
			await waitForBackendHealthy();
			const authReady = await authStore.initialize();
			if (!authReady || !(await loadProvidersFromApi())) throw new Error('Backend initialization is still incomplete.');
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
	<a href="#main-content" class="skip-link">Skip to main content</a>
	{#if isOffline}
		<div class="offline-banner" role="alert" data-tauri-drag-region>
			You are offline. Changes may not be saved.
		</div>
	{/if}
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
		{#if appReady}{@render children()}{/if}
	</main>

	<!-- Backend unavailable / version-skew overlay. Mounted only when the
	     backend is sustained-unhealthy or rejects this frontend build. -->
	<BackendDownOverlay />

	<!-- Update Banner - shows at top when update is available -->
	<UpdateBanner />

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
	.startup-error { display: flex; flex-direction: column; align-items: center; gap: var(--space-md); max-width: 32rem; padding: var(--space-xl); text-align: center; }
	.startup-error strong { color: var(--color-text-primary); font-size: var(--text-lg); }
	.startup-error span { color: var(--color-text-secondary); font-size: var(--text-sm); }
	.startup-error button { padding: var(--space-sm) var(--space-lg); border: 1px solid var(--color-accent); border-radius: var(--radius-md); background: var(--color-accent); color: var(--color-surface-0); cursor: pointer; }
	.startup-error button:disabled { opacity: 0.6; cursor: wait; }
	@keyframes pulse {
		0%, 100% { opacity: 1; }
		50% { opacity: 0.4; }
	}
	.offline-banner {
		position: sticky;
		top: 0;
		z-index: 9999;
		padding: var(--space-2) var(--space-lg);
		text-align: center;
		font-size: var(--text-sm);
		font-weight: var(--font-medium);
		background: var(--color-warning);
		color: #000;
		-webkit-app-region: drag;
	}
</style>
