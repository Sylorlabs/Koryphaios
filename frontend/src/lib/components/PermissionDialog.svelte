<script lang="ts">
  import { onDestroy, tick } from 'svelte';
  import ArrowRight from 'lucide-svelte/icons/arrow-right';
  import Shield from 'lucide-svelte/icons/shield';
  import ShieldAlert from 'lucide-svelte/icons/shield-alert';
  import ShieldCheck from 'lucide-svelte/icons/shield-check';
  import { sessionStore } from '$lib/stores/sessions.svelte';
  import { wsStore } from '$lib/stores/websocket.svelte';

  type RiskLevel = 'low' | 'medium' | 'high';

  const highRisk = new Set([
    'bash',
    'write_file',
    'edit_file',
    'delete_file',
    'move_file',
    'patch',
    'run',
  ]);
  const mediumRisk = new Set(['read_file', 'grep', 'glob', 'web_fetch', 'diff']);

  let dialogEl = $state<HTMLElement | null>(null);
  let previouslyFocused = $state<HTMLElement | null>(null);
  let dialogWasOpen = $state(false);
  let pendingPermissions = $derived(
    wsStore.pendingPermissions.filter(
      (permission) => permission.sessionId === sessionStore.activeSessionId,
    ),
  );
  // Approvals stalled in sessions the user is not looking at. Keep the
  // request visible without opening or granting anything automatically.
  let otherSessionPermissions = $derived(
    wsStore.pendingPermissions.filter(
      (permission) => permission.sessionId && permission.sessionId !== sessionStore.activeSessionId,
    ),
  );

  function determineRiskLevel(toolName: string): RiskLevel {
    if (highRisk.has(toolName)) return 'high';
    if (mediumRisk.has(toolName)) return 'medium';
    return 'low';
  }

  function riskColor(risk: RiskLevel): string {
    if (risk === 'high') return 'var(--color-error)';
    if (risk === 'medium') return 'var(--color-warning)';
    return 'var(--color-success)';
  }

  function riskIcon(risk: RiskLevel) {
    if (risk === 'low') return ShieldCheck;
    if (risk === 'medium') return ShieldAlert;
    return Shield;
  }

  function focusSafeAction() {
    dialogEl?.querySelector<HTMLElement>('[data-permission-deny]')?.focus();
  }

  $effect(() => {
    const isOpen = pendingPermissions.length > 0 && Boolean(dialogEl);
    if (isOpen && !dialogWasOpen) {
      previouslyFocused =
        document.activeElement instanceof HTMLElement ? document.activeElement : null;
      dialogWasOpen = true;
      void tick().then(focusSafeAction);
    } else if (!isOpen && dialogWasOpen) {
      const restoreTarget = previouslyFocused;
      dialogWasOpen = false;
      previouslyFocused = null;
      void tick().then(() => {
        if (restoreTarget?.isConnected) restoreTarget.focus();
      });
    }
  });

  onDestroy(() => {
    if (dialogWasOpen && previouslyFocused?.isConnected) previouslyFocused.focus();
  });

  function jumpToPendingSession() {
    const target = otherSessionPermissions[0];
    if (target?.sessionId) sessionStore.activeSessionId = target.sessionId;
  }

  function pendingSessionTitle(): string {
    const target = otherSessionPermissions[0];
    return (
      sessionStore.sessions.find((session) => session.id === target?.sessionId)?.title ??
      'another session'
    );
  }

  function respond(id: string, approved: boolean) {
    wsStore.respondToPermission(id, approved);
    void tick().then(() => {
      if (pendingPermissions.length > 0) focusSafeAction();
    });
  }

  function approveAll() {
    for (const permission of [...pendingPermissions]) {
      wsStore.respondToPermission(permission.id, true);
    }
  }

  function denyAll() {
    for (const permission of [...pendingPermissions]) {
      wsStore.respondToPermission(permission.id, false);
    }
  }

  function handleDialogKeydown(event: KeyboardEvent) {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      denyAll();
      return;
    }
    if (event.key !== 'Tab' || !dialogEl) return;
    const focusable = [
      ...dialogEl.querySelectorAll<HTMLElement>(
        'button:not([disabled]), [href], input:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
      ),
    ];
    const first = focusable[0];
    const last = focusable.at(-1);
    if (!first || !last) return;
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }
</script>

{#if pendingPermissions.length === 0 && otherSessionPermissions.length > 0}
  <button
    type="button"
    onclick={jumpToPendingSession}
    class="fixed bottom-24 left-1/2 z-50 flex -translate-x-1/2 items-center gap-2 rounded-full border px-4 py-2 shadow-lg transition-transform hover:scale-[1.02] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)]/60"
    style="background: color-mix(in srgb, var(--color-warning) 12%, var(--color-surface-2)); border-color: color-mix(in srgb, var(--color-warning) 45%, var(--color-border)); color: var(--color-warning); backdrop-filter: blur(8px);"
  >
    <ShieldAlert size={14} aria-hidden="true" />
    <span class="text-xs font-medium">
      {otherSessionPermissions.length === 1
        ? `Approval needed in "${pendingSessionTitle()}"`
        : `${otherSessionPermissions.length} approvals waiting in other sessions`} · review
    </span>
  </button>
{/if}

{#if pendingPermissions.length > 0}
  <div
    class="permission-stack fixed bottom-5 right-5 z-50"
    class:stacked={pendingPermissions.length > 3}
  >
    <div
      bind:this={dialogEl}
      role="dialog"
      tabindex="-1"
      aria-labelledby="permission-dialog-title"
      aria-describedby="permission-dialog-description"
      onkeydown={handleDialogKeydown}
      class="overflow-hidden rounded-2xl border shadow-2xl"
      style="background: var(--color-surface-2); border-color: var(--color-border);"
    >
      <div
        class="flex items-start justify-between gap-4 border-b px-5 py-4"
        style="border-color: var(--color-border);"
      >
        <div class="min-w-0">
          <div class="flex items-center gap-2">
            <span
              class="h-3 w-3 shrink-0 animate-pulse rounded-full bg-[var(--color-warning)]"
              aria-hidden="true"
            ></span>
            <h2
              id="permission-dialog-title"
              class="text-sm font-semibold text-[var(--color-text-primary)]"
            >
              Approval requests
            </h2>
          </div>
          <p
            id="permission-dialog-description"
            class="mt-1.5 text-xs leading-relaxed text-[var(--color-text-secondary)]"
          >
             Review what each agent wants to do. Requests stay queued until you allow or deny them. Escape safely denies every request shown here.
          </p>
        </div>
        <span class="shrink-0 text-xs text-[var(--color-text-secondary)]" aria-live="polite">
          {pendingPermissions.length} pending
        </span>
      </div>

      <div class="permission-list max-h-[min(70vh,38rem)] space-y-3 overflow-y-auto p-4">
        {#each pendingPermissions as permission, index (permission.id)}
          {@const risk = determineRiskLevel(permission.toolName)}
          {@const RiskIcon = riskIcon(risk)}
          <section
            class="permission-card rounded-xl border p-3"
            style={`--stack-index: ${index}; --stack-count: ${pendingPermissions.length}; border-color: color-mix(in srgb, ${riskColor(risk)} 35%, var(--color-border)); background: var(--color-surface-3);`}
            aria-labelledby={`permission-request-${index}`}
          >
            <div class="mb-2 flex items-start justify-between gap-3">
              <div class="min-w-0">
                <div class="mb-1 flex items-center gap-2">
                  <span class="text-xs font-semibold text-[var(--color-text-primary)]">
                    {permission.agentName ?? 'Backend agent'}
                  </span>
                  <ArrowRight size={11} class="shrink-0 text-[var(--color-text-muted)]" aria-hidden="true" />
                  <code class="text-[11px] text-[var(--color-text-secondary)]">{permission.toolName}</code>
                </div>
                <span
                  id={`permission-request-${index}`}
                  class="block min-w-0 break-words text-xs font-medium leading-relaxed text-[var(--color-text-primary)]"
                  >{permission.description}</span
                >
              </div>
              <span
                class="flex shrink-0 items-center gap-1 rounded-md border px-1.5 py-0.5 text-[10px] font-bold uppercase"
                style={`color: var(--color-text-primary); background: color-mix(in srgb, ${riskColor(risk)} 20%, var(--color-surface-4)); border-color: color-mix(in srgb, ${riskColor(risk)} 55%, var(--color-border));`}
              >
                <RiskIcon size={12} aria-hidden="true" />
                {risk}
              </span>
            </div>
            {#if permission.command}
              <pre class="mb-3 max-h-24 overflow-auto rounded-lg border px-2.5 py-2 font-mono text-[11px] leading-relaxed text-[var(--color-text-secondary)]" style="border-color: var(--color-border); background: var(--color-surface-2);">{permission.command}</pre>
            {/if}
            {#if permission.path}
              <p class="mb-3 break-all font-mono text-xs text-[var(--color-text-secondary)]">
                {permission.path}
              </p>
            {/if}
            <div class="flex justify-end gap-2">
              <button
                type="button"
                data-permission-deny
                onclick={() => respond(permission.id, false)}
                aria-label={`Deny ${permission.toolName}`}
                class="rounded-lg border px-3 py-1.5 text-xs font-medium text-[var(--color-text-primary)] transition-colors hover:bg-[var(--color-error-bg)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-error)]/60"
                style="background: var(--color-surface-4); border-color: var(--color-border);"
              >
                Deny
              </button>
              <button
                type="button"
                onclick={() => respond(permission.id, true)}
                aria-label={`Approve ${permission.toolName}`}
                class="rounded-lg px-3 py-1.5 text-xs font-semibold transition-opacity hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)]/60"
                style="background: var(--color-accent); color: var(--color-on-accent);"
              >
                Approve
              </button>
            </div>
          </section>
        {/each}
      </div>

      {#if pendingPermissions.length > 1}
        <div class="flex justify-end border-t px-5 py-3" style="border-color: var(--color-border);">
          <button
            type="button"
            onclick={approveAll}
            class="rounded-lg px-4 py-1.5 text-xs font-semibold transition-opacity hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)]/60"
            style="background: var(--color-accent); color: var(--color-on-accent);"
          >
            Approve all ({pendingPermissions.length})
          </button>
        </div>
      {/if}
    </div>
  </div>
{/if}

<style>
  .permission-stack {
    width: min(25rem, calc(100vw - 2rem));
  }

  .permission-stack > [role='dialog'] {
    animation: permission-dialog-enter 220ms ease-out both;
  }

  .permission-list {
    overflow-x: visible;
  }

  .permission-card {
    position: relative;
    z-index: var(--stack-index);
    transition:
      margin-top 320ms cubic-bezier(0.22, 1, 0.36, 1),
      transform 320ms cubic-bezier(0.22, 1, 0.36, 1),
      box-shadow 220ms ease;
    animation: permission-card-enter 260ms ease-out both;
  }

  .permission-card:nth-child(1) { animation-delay: 20ms; }
  .permission-card:nth-child(2) { animation-delay: 45ms; }
  .permission-card:nth-child(3) { animation-delay: 70ms; }
  .permission-card:nth-child(4) { animation-delay: 95ms; }

  .permission-stack.stacked .permission-card:not(:first-child) {
    margin-top: -9.2rem;
    transform: translateY(0.35rem) scale(0.98);
  }

  .permission-stack.stacked:hover .permission-card:not(:first-child),
  .permission-stack.stacked:focus-within .permission-card:not(:first-child) {
    margin-top: 0.75rem;
    transform: none;
  }

  .permission-stack.stacked:hover .permission-card,
  .permission-stack.stacked:focus-within .permission-card {
    box-shadow: 0 12px 28px color-mix(in srgb, var(--color-surface-0) 20%, transparent);
  }

  @keyframes permission-dialog-enter {
    from { opacity: 0; transform: translateY(0.75rem) scale(0.98); }
    to { opacity: 1; transform: translateY(0) scale(1); }
  }

  @keyframes permission-card-enter {
    from { opacity: 0; transform: translateY(0.5rem); }
    to { opacity: 1; }
  }

  @media (max-width: 640px) {
    .permission-stack {
      right: 0.75rem;
      bottom: 0.75rem;
      width: calc(100vw - 1.5rem);
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .permission-stack > [role='dialog'],
    .permission-card {
      animation: none;
      transition: none;
    }
  }
</style>
