<script lang="ts">
	import { page } from '$app/stores';

	const status = $derived($page.status ?? 500);
	const message = $derived(
		typeof $page.error === 'object' && $page.error !== null && 'message' in $page.error
			? String(($page.error as { message?: string }).message)
			: 'Something went wrong'
	);
</script>

<svelte:head>
	<title>Error — Koryphaios</title>
</svelte:head>

<div
	class="flex min-h-screen w-full flex-col items-center justify-center gap-4 p-6"
	style="background: var(--color-surface-0, #0a0a0b); color: var(--color-text-primary, #e8e8ed); font-family: var(--font-sans);"
>
	<h1 class="text-xl font-semibold" style="color: var(--color-error, #ef4444);">Error {status}</h1>
	<p class="max-w-md text-center text-sm" style="color: var(--color-text-secondary, #8b8b96);">{message}</p>
	<a
		href="/"
		class="mt-4 rounded-lg px-4 py-2 text-sm font-medium transition-colors"
		style="background: var(--color-accent, #6366f1); color: white;"
	>
		Back to app
	</a>
</div>
