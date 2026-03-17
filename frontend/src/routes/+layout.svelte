<script lang="ts">
	import '../app.css';
	import { onMount } from 'svelte';
	import { loadProvidersFromApi } from '$lib/stores/websocket.svelte';
	import { initUrls } from '$lib/utils/api-url';
	import UpdateDialog from '$lib/components/UpdateDialog.svelte';

	let { children } = $props();
	let showInitialLoad = $state(true);
	let isOffline = $state(false);

	onMount(() => {
		import('$lib/utils/error-monitor').then((m) => m.initErrorMonitoring()).catch(() => {});
		initUrls(); // Initialize backend URLs for desktop app
		loadProvidersFromApi();
		const t = setTimeout(() => { showInitialLoad = false; }, 1500);

		isOffline = !navigator.onLine;
		const goOffline = () => { isOffline = true; };
		const goOnline = () => { isOffline = false; };
		window.addEventListener('offline', goOffline);
		window.addEventListener('online', goOnline);

		// Right-click to open DevTools (Ctrl+Right-click or Cmd+Right-click)
		const handleContextMenu = async (e: MouseEvent) => {
			// Check if Ctrl or Cmd is held during right-click
			if (e.ctrlKey || e.metaKey) {
				e.preventDefault();
				try {
					const win = window as any;
					if (win.__TAURI__?.core?.invoke) {
						await win.__TAURI__.core.invoke('toggle_devtools');
					} else {
						console.log('[DevTools] Tauri API not available');
					}
				} catch (err) {
					// DevTools not available
					console.log('[DevTools] Toggle failed:', err);
				}
			}
		};
		window.addEventListener('contextmenu', handleContextMenu);

		return () => {
			clearTimeout(t);
			window.removeEventListener('offline', goOffline);
			window.removeEventListener('online', goOnline);
			window.removeEventListener('contextmenu', handleContextMenu);
		};
	});
</script>

<svelte:head>
	<title>Koryphaios</title>
</svelte:head>

<div class="layout-root">
	<a href="#main-content" class="skip-link">Skip to main content</a>
	{#if isOffline}
		<div class="offline-banner" role="alert">
			You are offline. Changes may not be saved.
		</div>
	{/if}
	{#if showInitialLoad}
		<div class="initial-load" aria-live="polite">
			<div class="initial-load-dot"></div>
			<span>Loading Koryphaios…</span>
		</div>
	{/if}
	<main id="main-content">
		{@render children()}
	</main>
	
	<!-- Update Dialog - only shown when update is available -->
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
	}
</style>
