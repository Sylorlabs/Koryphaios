<script lang="ts">
	import { slide } from 'svelte/transition';
	import {
		backendHealth,
		recheckBackendHealth,
		POLL_INTERVAL_MS,
		type BackendHealthReason,
	} from '$lib/stores/backend-health.svelte';
	import { isDemoMode } from '$lib/demo-flags';

	let { } = $props();

	const status = $derived(backendHealth.status);
	// Demo builds intentionally run without a backend — the overlay must never
	// trap a demo visitor behind a "backend unavailable" wall.
	const visible = $derived(!isDemoMode && (status === 'unhealthy' || status === 'mismatch'));
	const reason = $derived(backendHealth.reason);

	// Advanced diagnostics disclosure — collapsed by default so the casual user
	// sees a clean reason + retry, while someone filing a bug report can expand
	// for the full picture (and copy it to clipboard).
	let advancedOpen = $state(false);
	let copyState = $state<'idle' | 'copied' | 'failed'>('idle');

	// ─── Live retry countdown ────────────────────────────────────────────────
	// The sentinel polls every POLL_INTERVAL_MS. We mirror that cadence in the
	// UI with a per-second countdown that resets whenever a new poll lands
	// (lastCheckedAt changes), so the number the user sees matches reality.
	const POLL_SECONDS = Math.max(1, Math.round(POLL_INTERVAL_MS / 1000));
	let secondsLeft = $state(POLL_SECONDS);

	$effect(() => {
		// Re-run whenever a fresh poll timestamp arrives.
		const last = backendHealth.lastCheckedAt;
		if (!visible || status !== 'unhealthy') return;
		secondsLeft = POLL_SECONDS;
		const timer = setInterval(() => {
			secondsLeft = Math.max(0, secondsLeft - 1);
		}, 1000);
		return () => clearInterval(timer);
	});

	// Attempt counter — total consecutive failed checks since the backend last
	// reported healthy. Shown as "Attempt N" so the user knows how long the
	// supervisor has been fighting to bring the backend back.
	const attemptNumber = $derived(backendHealth.consecutiveFailures);

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
			case 'http-error': return 'The backend responded, but its health endpoint returned an error.';
			case 'invalid-response': return 'The backend responded with an invalid health-check payload.';
			case 'not-ok': return 'Backend responded but reported unhealthy.';
			case 'supervisor':
				return 'The desktop supervisor reported the backend process is not responding.';
			case 'min-frontend':
				return `This frontend is older than the backend's minimum supported build (frontend ${backendHealth.frontendVersion} < backend min ${backendHealth.backendMinFrontend ?? '?'}).`;
			case 'bundle-hash':
				return `Backend/frontend bundle hashes differ (frontend ${backendHealth.frontendBundleHash ?? 'dev'} ≠ backend ${backendHealth.backendBundleHash ?? 'dev'}).`;
			default: return '';
		}
	}

	// Short, machine-stable code shown as a chip next to the human explanation.
	// Falls back to the raw supervisor reason when the failure originated there.
	const errorCode = $derived(
		reason === 'supervisor' && backendHealth.supervisorReason
			? backendHealth.supervisorReason
			: reason ?? 'unknown'
	);

	function retry() {
		recheckBackendHealth();
	}

	function fmtTime(ts: number | null): string {
		if (!ts) return '—';
		try {
			return new Date(ts).toLocaleString();
		} catch {
			return '—';
		}
	}

	// Build a plain-text diagnostics block for "Copy to clipboard" / bug reports.
	const diagnosticsText = $derived.by(() => {
		const lines: string[] = [];
		lines.push('Koryphaios backend diagnostics');
		lines.push('================================');
		lines.push(`Timestamp: ${new Date().toISOString()}`);
		lines.push(`Status: ${status}`);
		lines.push(`Error code: ${errorCode}`);
		lines.push(`Reason (human): ${reasonText(reason) || '—'}`);
		if (backendHealth.failureDetail) lines.push(`Detail: ${backendHealth.failureDetail}`);
		if (backendHealth.supervisorReason) lines.push(`Supervisor reason: ${backendHealth.supervisorReason}`);
		if (backendHealth.supervisorMessage) lines.push(`Supervisor message: ${backendHealth.supervisorMessage}`);
		if (backendHealth.healthUrl) lines.push(`Health URL: ${backendHealth.healthUrl}`);
		if (backendHealth.httpStatus !== null) lines.push(`HTTP status: ${backendHealth.httpStatus}`);
		if (backendHealth.networkError) lines.push(`Network error: ${backendHealth.networkError}`);
		lines.push(`Consecutive failures: ${backendHealth.consecutiveFailures}`);
		lines.push(`Last checked: ${fmtTime(backendHealth.lastCheckedAt)}`);
		lines.push(`Last healthy: ${fmtTime(backendHealth.lastHealthyAt)}`);
		lines.push('');
		lines.push('Versions');
		lines.push('--------');
		lines.push(`Frontend version: ${backendHealth.frontendVersion}`);
		lines.push(`Frontend bundle hash: ${backendHealth.frontendBundleHash ?? 'dev'}`);
		lines.push(`Backend version: ${backendHealth.backendVersion ?? '—'}`);
		lines.push(`Backend PID: ${backendHealth.backendPid ?? '—'}`);
		lines.push(`Backend min frontend: ${backendHealth.backendMinFrontend ?? '—'}`);
		lines.push(`Backend current frontend: ${backendHealth.backendCurrentFrontend ?? '—'}`);
		lines.push(`Backend bundle hash: ${backendHealth.backendBundleHash ?? 'dev'}`);
		return lines.join('\n');
	});

	async function copyDiagnostics() {
		try {
			await navigator.clipboard.writeText(diagnosticsText);
			copyState = 'copied';
		} catch {
			copyState = 'failed';
		}
		setTimeout(() => (copyState = 'idle'), 2000);
	}

	// Opens the GitHub "new issue" page in the user's browser. In the Tauri
	// desktop shell we route through the shell plugin so the URL opens in the
	// system browser (not the webview); in a plain browser we fall back to
	// window.open.
	const ISSUE_URL = 'https://github.com/Sylorlabs/Koryphaios/issues/new';
	async function openIssue() {
		const inTauri =
			typeof window !== 'undefined' &&
			('__TAURI_INTERNALS__' in window || '__TAURI__' in window);
		if (inTauri) {
			try {
				const { open } = await import('@tauri-apps/plugin-shell');
				await open(ISSUE_URL);
				return;
			} catch (err) {
				console.error('[Koryphaios] Failed to open issue page via shell:', err);
			}
		}
		try {
			window.open(ISSUE_URL, '_blank', 'noopener,noreferrer');
		} catch (err) {
			console.error('[Koryphaios] Failed to open issue page:', err);
		}
	}

	// Release builds own their embedded backend, so relaunching the Tauri app is
	// the right recovery action. In desktop development the outer launcher owns
	// the backend and Vite server; relaunching only the Tauri child disconnects
	// it from that lifecycle and can reopen to a refused 127.0.0.1 connection.
	// Keep the dev launcher alive and let its recovery watchdog restore the
	// backend while this webview reloads.
	let restarting = $state(false);
	async function restartApp() {
		if (restarting) return;
		restarting = true;
		if (import.meta.env.DEV) {
			console.info('[Koryphaios] Reloading development webview; launcher retains backend recovery');
			window.location.reload();
			return;
		}
		const inTauri =
			typeof window !== 'undefined' &&
			('__TAURI_INTERNALS__' in window || '__TAURI__' in window);
		if (inTauri) {
			try {
				const { relaunch } = await import('@tauri-apps/plugin-process');
				console.info('[Koryphaios] User requested app restart via plugin-process');
				await relaunch();
				return; // process exits here
			} catch (err) {
				console.error('[Koryphaios] Failed to restart app via plugin-process:', err);
			}
		}
		// Browser fallback — reload the page, which re-runs the health sentinel.
		console.info('[Koryphaios] Reloading page (no Tauri process plugin available)');
		window.location.reload();
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
				<div class="reason-row">
					<span class="code-chip" title="Error code — include this in bug reports">{errorCode}</span>
					<span class="reason">{reasonText(reason)}</span>
				</div>
			{/if}
			{#if backendHealth.failureDetail}
				<p class="failure-detail">{backendHealth.failureDetail}</p>
			{/if}

			{#if status === 'unhealthy'}
				<div class="actions">
					<div class="button-row">
						<button class="primary" onclick={retry}>Retry now</button>
						<button class="secondary" onclick={restartApp} disabled={restarting} title="Restart the Koryphaios app and its backend">
							<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" class="issue-icon">
								<polyline points="23 4 23 10 17 10" />
								<path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" />
							</svg>
							{restarting ? 'Restarting…' : 'Restart app'}
						</button>
						<button class="secondary" onclick={openIssue} title="Open a new issue on GitHub">
							<svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor" aria-hidden="true" class="issue-icon">
								<path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z" />
							</svg>
							Open issue
						</button>
					</div>
					<span class="hint">
						Attempt {attemptNumber} · trying again in {secondsLeft}{secondsLeft === 1 ? '…' : 's…'}
					</span>
				</div>
			{:else}
				<div class="actions">
					<div class="button-row">
						<button class="primary" onclick={retry}>Re-check</button>
						<button class="secondary" onclick={restartApp} disabled={restarting} title="Restart the Koryphaios app and its backend">
							<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" class="issue-icon">
								<polyline points="23 4 23 10 17 10" />
								<path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" />
							</svg>
							{restarting ? 'Restarting…' : 'Restart app'}
						</button>
						<button class="secondary" onclick={openIssue} title="Open a new issue on GitHub">
							<svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor" aria-hidden="true" class="issue-icon">
								<path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z" />
							</svg>
							Open issue
						</button>
					</div>
					<span class="hint">Restart the app to load the matching frontend.</span>
				</div>
			{/if}

			<button
				class="advanced-toggle"
				onclick={() => (advancedOpen = !advancedOpen)}
				aria-expanded={advancedOpen}
				aria-controls="bdo-advanced"
				title={advancedOpen ? 'Hide diagnostics' : 'Show diagnostics'}
			>
				<span class="advanced-label">Advanced</span>
				<span class="expand-cue {advancedOpen ? 'rotated' : ''}" aria-hidden="true">▸</span>
			</button>

			{#if advancedOpen}
				<div id="bdo-advanced" class="advanced" transition:slide={{ duration: 180 }}>
					<div class="advanced-head">
						<span class="advanced-title">Diagnostics</span>
						<button
							class="copy-btn"
							onclick={copyDiagnostics}
							title="Copy diagnostics to clipboard"
						>
							{#if copyState === 'copied'}Copied!{:else if copyState === 'failed'}Failed{:else}Copy{/if}
						</button>
					</div>

					<dl class="meta">
						<div><dt>Error code</dt><dd>{errorCode}</dd></div>
						{#if backendHealth.supervisorReason}
							<div><dt>Supervisor reason</dt><dd>{backendHealth.supervisorReason}</dd></div>
						{/if}
						{#if backendHealth.supervisorMessage}
							<div><dt>Supervisor message</dt><dd>{backendHealth.supervisorMessage}</dd></div>
						{/if}
						{#if backendHealth.healthUrl}
							<div><dt>Health URL</dt><dd>{backendHealth.healthUrl}</dd></div>
						{/if}
						{#if backendHealth.httpStatus !== null}
							<div><dt>HTTP status</dt><dd>{backendHealth.httpStatus}</dd></div>
						{/if}
						{#if backendHealth.networkError}
							<div><dt>Network error</dt><dd>{backendHealth.networkError}</dd></div>
						{/if}
						<div><dt>Consecutive failures</dt><dd>{backendHealth.consecutiveFailures}</dd></div>
						<div><dt>Last checked</dt><dd>{fmtTime(backendHealth.lastCheckedAt)}</dd></div>
						<div><dt>Last healthy</dt><dd>{fmtTime(backendHealth.lastHealthyAt)}</dd></div>
						<div><dt>Frontend version</dt><dd>{backendHealth.frontendVersion}</dd></div>
						<div><dt>Frontend bundle hash</dt><dd>{backendHealth.frontendBundleHash ?? 'dev'}</dd></div>
						<div><dt>Backend version</dt><dd>{backendHealth.backendVersion ?? '—'}</dd></div>
						<div><dt>Backend PID</dt><dd>{backendHealth.backendPid ?? '—'}</dd></div>
						<div><dt>Backend min frontend</dt><dd>{backendHealth.backendMinFrontend ?? '—'}</dd></div>
						<div><dt>Backend current frontend</dt><dd>{backendHealth.backendCurrentFrontend ?? '—'}</dd></div>
						<div><dt>Backend bundle hash</dt><dd>{backendHealth.backendBundleHash ?? 'dev'}</dd></div>
					</dl>
					<p class="console-hint">The same details are printed to the developer console (F12).</p>
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
	.reason-row {
		display: flex;
		align-items: center;
		gap: var(--space-sm);
		background: var(--color-surface-2);
		border-radius: var(--radius-md);
		padding: var(--space-2) var(--space-md);
	}
	.code-chip {
		flex: 0 0 auto;
		font-family: var(--font-mono, monospace);
		font-size: var(--text-xs);
		font-weight: var(--font-semibold, 600);
		color: var(--color-surface-0);
		background: var(--color-warning, var(--color-accent));
		border-radius: var(--radius-sm);
		padding: 0.125rem 0.5rem;
		letter-spacing: 0.02em;
		text-transform: lowercase;
	}
	.reason {
		color: var(--color-text-muted);
		font-size: var(--text-xs);
		font-family: var(--font-mono, monospace);
		text-align: left;
		white-space: pre-wrap;
		word-break: break-word;
	}
	.failure-detail {
		color: var(--color-text-secondary);
		font-size: var(--text-xs);
		background: var(--color-surface-2);
		border-radius: var(--radius-md);
		padding: var(--space-2) var(--space-md);
		text-align: left;
		line-height: 1.45;
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
	.button-row {
		display: flex;
		align-items: center;
		justify-content: center;
		gap: var(--space-sm);
		flex-wrap: wrap;
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
	.secondary {
		display: inline-flex;
		align-items: center;
		gap: 0.375rem;
		padding: var(--space-sm) var(--space-md);
		border-radius: var(--radius-md);
		border: 1px solid var(--color-surface-3);
		background: var(--color-surface-1);
		color: var(--color-text-secondary);
		font-weight: var(--font-medium, 500);
		font-size: var(--text-sm);
		cursor: pointer;
		transition: background 120ms ease, color 120ms ease, border-color 120ms ease;
	}
	.secondary:hover {
		background: var(--color-surface-2);
		color: var(--color-text-primary);
		border-color: var(--color-accent);
	}
	.issue-icon {
		flex: 0 0 auto;
	}
	.hint {
		font-size: var(--text-xs);
		color: var(--color-text-muted);
		font-variant-numeric: tabular-nums;
	}
	.advanced-toggle {
		display: flex;
		align-items: center;
		justify-content: center;
		gap: var(--space-xs);
		align-self: center;
		background: transparent;
		border: none;
		color: var(--color-text-muted);
		font-size: var(--text-xs);
		font-weight: var(--font-medium, 500);
		cursor: pointer;
		padding: var(--space-2) var(--space-md);
		border-radius: var(--radius-sm);
		transition: color 120ms ease, background 120ms ease;
	}
	.advanced-toggle:hover {
		color: var(--color-text-primary);
		background: var(--color-surface-2);
	}
	.expand-cue {
		transition: transform 160ms ease;
		font-size: 0.7em;
	}
	.expand-cue.rotated {
		transform: rotate(90deg);
	}
	.advanced {
		display: flex;
		flex-direction: column;
		gap: var(--space-sm);
		background: var(--color-surface-2);
		border: 1px solid var(--color-surface-3);
		border-radius: var(--radius-md);
		padding: var(--space-md);
	}
	.advanced-head {
		display: flex;
		align-items: center;
		justify-content: space-between;
	}
	.advanced-title {
		font-size: var(--text-xs);
		font-weight: var(--font-semibold, 600);
		color: var(--color-text-secondary);
		text-transform: uppercase;
		letter-spacing: 0.04em;
	}
	.copy-btn {
		font-size: var(--text-xs);
		padding: 0.125rem var(--space-sm);
		border-radius: var(--radius-sm);
		border: 1px solid var(--color-surface-3);
		background: var(--color-surface-1);
		color: var(--color-text-secondary);
		cursor: pointer;
		transition: background 120ms ease, color 120ms ease;
	}
	.copy-btn:hover {
		background: var(--color-accent);
		color: var(--color-surface-0);
		border-color: var(--color-accent);
	}
	.console-hint {
		font-size: var(--text-xs);
		color: var(--color-text-muted);
		text-align: left;
		font-style: italic;
	}
</style>
