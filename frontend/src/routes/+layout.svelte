<script lang="ts">
	import '../app.css';
	import { initErrorMonitoring } from '$lib/utils/error-monitor';
	import { onMount } from 'svelte';
	import ErrorBoundary from '$lib/components/ErrorBoundary.svelte';

	let { children } = $props();
	let mounted = $state(false);

	onMount(() => {
		mounted = true;
		// Error monitoring disabled by default — was causing "Aw Snap" via console patching
		// initErrorMonitoring();
	});
</script>

<svelte:head>
	<title>Koryphaios</title>
</svelte:head>

{#if !mounted}
	<div
		class="flex h-screen w-full items-center justify-center"
		style="background: var(--color-surface-0, #0a0a0b); color: var(--color-text-muted, #5a5a66); font-family: var(--font-sans);"
	>
		<p>Loading Koryphaios…</p>
	</div>
{:else}
	<ErrorBoundary>
		{@render children()}
	</ErrorBoundary>
{/if}
