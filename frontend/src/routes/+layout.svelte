<script lang="ts">
	import '../app.css';
	import { initErrorMonitoring } from '$lib/utils/error-monitor';
	import { onMount } from 'svelte';

	let { children } = $props();

	onMount(() => {
		initErrorMonitoring();
	});
</script>

<svelte:head>
	<title>Koryphaios</title>
</svelte:head>

{@render children()}
