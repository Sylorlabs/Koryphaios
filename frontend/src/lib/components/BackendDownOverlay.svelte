<script lang="ts">
	import { backendHealth, recheckBackendHealth, type BackendHealthReason } from '$lib/stores/backend-health.svelte';
	import { isDemoMode } from '$lib/demo-flags';

	let { } = $props();

	const status = $derived(backendHealth.status);
	// Demo builds intentionally run without a backend — the overlay must never
	// trap a demo visitor behind a "backend unavailable" wall.
	const visible = $derived(!isDemoMode && (status === 'unhealthy' || status === 'mismatch'));
	const reason = $derived(backendHealth.reason);

	const title = $derived(
		status === 'mismatch'
			? 'Backend and frontend are out of sync'
			: 'Koryphaios backend is unavailable'
	);

	const subtitle = $derived(
		status === 'mismatch'
			? 'This frontend build cannot safely run against the running backend. Restart Koryphaios to update.'
			: 'The local backend stopped responding. The UI is paused until it comes back.'
	);

	function reasonText(r: BackendHealthReason | null): string {
		switch (r) {
			case 'unreachable': return 'Cannot reach the backend at the configured address.';
			case 'not-ok': return 'Backend responded but reported unhealthy.';
			case 'min-frontend':
				return `This frontend is older than the backend's minimum supported build (frontend ${backendHealth.frontendVersion} < backend min ${backendHealth.backendMinFrontend ?? '?'}).`;
			case 'bundle-hash':
				return `Backend/frontend bundle hashes differ (frontend ${backendHealth.frontendBundleHash ?? 'dev'} ≠ backend ${backendHealth.backendBundleHash ?? 'dev'}).`;
			default: return '';
		}
	}

	function retry() {
		recheckBackendHealth();
	}
</script>

{#if visible}
	<div class="backend-down-overlay" role="alertdialog" aria-labelledby="bdo-title" aria-describedby="bdo-sub" data-tauri-drag-region>
		<div class="card" data-tauri-drag-region="false">
			<div class="icon" aria-hidden="true">
				{#if status === 'mismatch'}
					<svg viewBox="0 0 24 24" width="32" height="32" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
						<path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
						<line x1="12" y1="9" x2="12" y2="13" />
						<line x1="12" y1="17" x2="12.01" y2="17" />
					</svg>
				{:else}
					<svg viewBox="0 0 24 24" width="32" height="32" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
						<circle cx="12" cy="12" r="10" />
						<line x1="12" y1="8" x2="12" y2="12" />
						<line x1="12" y1="16" x2="12.01" y2="16" />
					</svg>
				{/if}
			</div>
			<h1 id="bdo-title">{title}</h1>
			<p id="bdo-sub">{subtitle}</p>

			{#if reason}
				<p class="reason">{reasonText(reason)}</p>
			{/if}

			<dl class="meta">
				<div><dt>Backend version</dt><dd>{backendHealth.backendVersion ?? '—'}</dd></div>
				<div><dt>Backend PID</dt><dd>{backendHealth.backendPid ?? '—'}</dd></div>
				<div><dt>Frontend version</dt><dd>{backendHealth.frontendVersion}</dd></div>
				<div><dt>Last checked</dt><dd>{backendHealth.lastCheckedAt ? new Date(backendHealth.lastCheckedAt).toLocaleTimeString() : '—'}</dd></div>
			</dl>

			{#if status === 'unhealthy'}
				<div class="actions">
					<button class="primary" onclick={retry}>Retry now</button>
					<span class="hint">Retrying automatically every few seconds…</span>
				</div>
			{:else}
				<div class="actions">
					<button class="primary" onclick={retry}>Re-check</button>
					<span class="hint">Restart the app to load the matching frontend.</span>
				</div>
			{/if}
		</div>
	</div>
{/if}

<style>
	.backend-down-overlay {
		position: fixed;
		inset: 0;
		z-index: 100000;
		display: flex;
		align-items: center;
		justify-content: center;
		background: color-mix(in srgb, var(--color-surface-0) 92%, transparent);
		backdrop-filter: blur(6px);
		-webkit-backdrop-filter: blur(6px);
	}
	.card {
		max-width: 32rem;
		width: calc(100% - 2 * var(--space-lg));
		padding: var(--space-xl) var(--space-lg);
		background: var(--color-surface-1);
		border: 1px solid var(--color-surface-3);
		border-radius: var(--radius-lg);
		box-shadow: var(--shadow-lg, 0 10px 40px rgba(0, 0, 0, 0.35));
		display: flex;
		flex-direction: column;
		gap: var(--space-md);
		text-align: left;
	}
	.icon {
		display: flex;
		justify-content: center;
		color: var(--color-warning, var(--color-accent));
		margin-bottom: var(--space-xs);
	}
	h1 {
		font-size: var(--text-lg, 1.125rem);
		font-weight: var(--font-semibold, 600);
		color: var(--color-text-primary);
		margin: 0;
		text-align: center;
	}
	p {
		margin: 0;
		color: var(--color-text-secondary);
		font-size: var(--text-sm);
		text-align: center;
		line-height: 1.5;
	}
	.reason {
		color: var(--color-text-muted);
		font-size: var(--text-xs);
		font-family: var(--font-mono, monospace);
		background: var(--color-surface-2);
		border-radius: var(--radius-md);
		padding: var(--space-2) var(--space-md);
		text-align: left;
		white-space: pre-wrap;
		word-break: break-word;
	}
	.meta {
		display: grid;
		grid-template-columns: 1fr 1fr;
		gap: var(--space-2) var(--space-md);
		margin: 0;
		font-size: var(--text-xs);
	}
	.meta > div {
		display: flex;
		justify-content: space-between;
		gap: var(--space-2);
		min-width: 0;
	}
	.meta dt {
		color: var(--color-text-muted);
	}
	.meta dd {
		margin: 0;
		color: var(--color-text-primary);
		font-family: var(--font-mono, monospace);
		text-align: right;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.actions {
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: var(--space-sm);
		margin-top: var(--space-sm);
	}
	.primary {
		min-width: 10rem;
		padding: var(--space-sm) var(--space-lg);
		border-radius: var(--radius-md);
		border: 1px solid var(--color-accent);
		background: var(--color-accent);
		color: var(--color-surface-0);
		font-weight: var(--font-medium, 500);
		font-size: var(--text-sm);
		cursor: pointer;
		transition: background 120ms ease, border-color 120ms ease;
	}
	.primary:hover {
		background: var(--color-accent-hover, var(--color-accent));
	}
	.hint {
		font-size: var(--text-xs);
		color: var(--color-text-muted);
	}
</style>