<script lang="ts">
	import '../app.css';
	import { onMount } from 'svelte';
	import { loadProvidersFromApi } from '$lib/stores/websocket.svelte';

	let { children } = $props();
	let showInitialLoad = $state(true);

	onMount(() => {
		import('$lib/utils/error-monitor').then((m) => m.initErrorMonitoring()).catch(() => {});
		loadProvidersFromApi();
		const t = setTimeout(() => { showInitialLoad = false; }, 1500);
		return () => clearTimeout(t);
	});
</script>

<svelte:head>
	<title>Koryphaios</title>
</svelte:head>

<div class="layout-root">
	{#if showInitialLoad}
		<div class="initial-load" aria-live="polite">
			<div class="initial-load-dot"></div>
			<span>Loading Koryphaios…</span>
		</div>
	{/if}
	{@render children()}
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
		gap: 12px;
		background: var(--color-surface-0);
		color: var(--color-text-muted);
		font-size: 14px;
		z-index: 10000;
		pointer-events: none;
	}
	.initial-load-dot {
		width: 8px;
		height: 8px;
		border-radius: 50%;
		background: var(--color-accent);
		animation: pulse 1s ease-in-out infinite;
	}
	@keyframes pulse {
		0%, 100% { opacity: 1; }
		50% { opacity: 0.4; }
	}
</style>
