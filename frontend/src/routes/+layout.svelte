<script lang="ts">
	import '../app.css';
	import '$lib/fonts';
	import { onMount } from 'svelte';
	import { loadProvidersFromApi } from '$lib/stores/providers.svelte';
	import { authStore } from '$lib/stores/auth.svelte';
	import { initUrls } from '$lib/utils/api-url';
	import UpdateBanner from '$lib/components/UpdateBanner.svelte';
	import UpdateDialog from '$lib/components/UpdateDialog.svelte';

	let { children } = $props();
	let showInitialLoad = $state(true);
	let isOffline = $state(false);
	let loadError = $state<string | null>(null);

	onMount(() => {
		// Direct DOM fallback for hiding loading screen
		const hideLoading = () => {
			showInitialLoad = false;
			// Also directly hide via DOM as fallback
			const el = document.querySelector('.initial-load');
			if (el) (el as HTMLElement).style.display = 'none';
		};

		import('$lib/utils/error-monitor').then((m) => m.initErrorMonitoring()).catch(() => {});
		
		// Resolve backend URLs first, then wait for auth before requesting protected data.
		Promise.resolve()
			.then(() => initUrls())
			.then(() => authStore.initialize())
			.then((authReady) => {
				if (authReady) {
					return loadProvidersFromApi();
				}
			})
			.catch(() => {})
			.finally(() => {
			// Hide loading screen after init or on error
			setTimeout(hideLoading, 500);
		});

		// Fallback: always hide after max 3 seconds
		const fallbackTimer = setTimeout(hideLoading, 3000);

		isOffline = !navigator.onLine;
		const goOffline = () => { isOffline = true; };
		const goOnline = () => { isOffline = false; };
		window.addEventListener('offline', goOffline);
		window.addEventListener('online', goOnline);

		return () => {
			clearTimeout(fallbackTimer);
			window.removeEventListener('offline', goOffline);
			window.removeEventListener('online', goOnline);
		};
	});
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
	{#if showInitialLoad}
		<div class="initial-load" aria-live="polite" data-tauri-drag-region>
			<div class="initial-load-dot"></div>
			<span data-tauri-drag-region>Loading Koryphaios…</span>
		</div>
	{/if}
	<main id="main-content">
		{@render children()}
	</main>
	
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
