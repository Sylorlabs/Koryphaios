<script lang="ts">
	import '../app.css';
	import { onMount } from 'svelte';
	import { wsStore } from '$lib/stores/websocket.svelte';
	import { sessionStore } from '$lib/stores/sessions.svelte';

	let { children } = $props();

	onMount(() => {
		sessionStore.fetchSessions();
		wsStore.connect();
	});
</script>

<svelte:head>
	<title>Koryphaios</title>
</svelte:head>

{@render children()}
