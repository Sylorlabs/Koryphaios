<script lang="ts">
	import '../app.css';

	let { children } = $props();
</script>

<svelte:head>
	<title>Koryphaios</title>
</svelte:head>

{@render children()}
