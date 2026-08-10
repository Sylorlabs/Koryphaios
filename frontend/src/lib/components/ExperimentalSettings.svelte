<script lang="ts">
  import AlertTriangle from 'lucide-svelte/icons/alert-triangle';
  import Check from 'lucide-svelte/icons/check';
  import DollarSign from 'lucide-svelte/icons/dollar-sign';
  import PauseCircle from 'lucide-svelte/icons/pause-circle';
  import RefreshCw from 'lucide-svelte/icons/refresh-cw';
  import RotateCcw from 'lucide-svelte/icons/rotate-ccw';
  import ShieldCheck from 'lucide-svelte/icons/shield-check';
  import {
    DEFAULT_SPEND_CAP_CONFIG,
    experimentalStore,
    type SpendCapConfig,
  } from '$lib/stores/experimental.svelte';
  import ConfirmDialog from './ConfirmDialog.svelte';
  import KorySelect from './KorySelect.svelte';
  import NumberStepper from './NumberStepper.svelte';
  import SettingsPageIntro from './SettingsPageIntro.svelte';
  import SettingsSwitch from './SettingsSwitch.svelte';

  let showResetDialog = $state(false);
  let announcement = $state('');

  const config = $derived(experimentalStore.spendCapConfig);
  const differsFromDefaults = $derived(
    JSON.stringify(config) !== JSON.stringify(DEFAULT_SPEND_CAP_CONFIG),
  );

  async function save(patch: Partial<SpendCapConfig>, message: string) {
    if (await experimentalStore.saveSpendCapConfig(patch)) announcement = message;
  }

  async function resetLimits() {
    if (await experimentalStore.saveSpendCapConfig(DEFAULT_SPEND_CAP_CONFIG)) {
      announcement = 'Spend limits restored to recommended defaults.';
      showResetDialog = false;
    }
  }

  function dollars(cents: number) {
    return `$${(cents / 100).toFixed(2)}`;
  }

  const limitControls: Array<{
    key: 'sessionHourlyCents' | 'sessionDailyCents' | 'globalHourlyCents' | 'globalDailyCents';
    label: string;
    description: string;
  }> = [
    {
      key: 'sessionHourlyCents',
      label: 'Per-session · rolling hour',
      description: 'Recorded spend for the current chat during the preceding 60 minutes.',
    },
    {
      key: 'sessionDailyCents',
      label: 'Per-session · rolling day',
      description: 'Recorded spend for the current chat during the preceding 24 hours.',
    },
    {
      key: 'globalHourlyCents',
      label: 'All sessions · rolling hour',
      description: 'Recorded spend across this Koryphaios app during the preceding 60 minutes.',
    },
    {
      key: 'globalDailyCents',
      label: 'All sessions · rolling day',
      description: 'Recorded spend across this Koryphaios app during the preceding 24 hours.',
    },
  ];
</script>

<div class="flex h-full min-h-0 flex-col overflow-hidden">
  <SettingsPageIntro
    title="Safety limits"
    description="Set server-enforced limits for provider spend recorded by Koryphaios. These settings apply to this local app."
  >
    <span
      class="inline-flex items-center gap-1.5 rounded-full border border-[var(--color-border)] bg-[var(--color-surface-2)] px-2.5 py-1 text-[10px] font-medium {config.enabled
        ? 'text-[var(--color-success)]'
        : 'text-[var(--color-text-muted)]'}"
    >
      {#if config.enabled}<Check size={11} /> Enforcing{:else}Limits off{/if}
    </span>
  </SettingsPageIntro>

  <p class="sr-only" aria-live="polite">{announcement}</p>

  <div class="min-h-0 flex-1 overflow-y-auto p-4 sm:p-6">
    <div class="mx-auto max-w-5xl space-y-5">
      {#if experimentalStore.spendCapError}
        <section
          role="alert"
          class="flex items-start gap-3 rounded-2xl border border-[var(--color-error)]/35 bg-[var(--color-error-bg)] p-4"
        >
          <AlertTriangle size={18} class="mt-0.5 shrink-0 text-[var(--color-error)]" />
          <div class="min-w-0 flex-1">
            <h4 class="text-sm font-semibold text-[var(--color-text-primary)]">
              Safety limits unavailable
            </h4>
            <p class="mt-1 text-xs leading-relaxed text-[var(--color-text-muted)]">
              {experimentalStore.spendCapError}
            </p>
          </div>
          <button
            type="button"
            disabled={experimentalStore.isLoading}
            onclick={() => void experimentalStore.loadAll()}
            class="flex min-h-10 shrink-0 items-center gap-2 rounded-xl border border-[var(--color-border)] px-3 text-xs text-[var(--color-text-secondary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)]/60 disabled:opacity-50"
            ><RefreshCw size={14} /> Retry</button
          >
        </section>
      {:else if experimentalStore.isLoading}
        <section
          role="status"
          class="flex min-h-40 items-center justify-center gap-2 rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface-1)] text-sm text-[var(--color-text-muted)]"
        >
          <RefreshCw size={16} class="animate-spin" /> Loading enforced limits…
        </section>
      {:else}
        <section
          class="rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface-1)] p-5"
        >
          <SettingsSwitch
            checked={config.enabled}
            label="Enforce recorded-spend limits"
            description="Check recorded provider spend immediately before each new provider request. Turning this off does not erase usage or paused-session history."
            disabled={experimentalStore.isLoading}
            onchange={() =>
              save(
                { enabled: !config.enabled },
                config.enabled ? 'Spend limits disabled.' : 'Spend limits enabled.',
              )}
            flat
            large
          />
        </section>

        <section
          class="space-y-4 rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface-1)] p-5 {config.enabled
            ? ''
            : 'opacity-60'}"
        >
          <div class="flex items-start gap-3">
            <span
              class="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-[var(--color-surface-2)] text-[var(--color-accent)]"
              ><DollarSign size={17} /></span
            >
            <div>
              <h4 class="text-sm font-semibold text-[var(--color-text-primary)]">
                Rolling spend windows
              </h4>
              <p class="mt-1 text-xs leading-relaxed text-[var(--color-text-muted)]">
                Values are US cents. Enter 0 to disable one limit while keeping the others active.
              </p>
            </div>
          </div>

          <div class="grid gap-3 sm:grid-cols-2">
            {#each limitControls as control (control.key)}
              <div
                class="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-2)] p-4"
              >
                <div class="flex items-start justify-between gap-3">
                  <div>
                    <h5 class="text-xs font-semibold text-[var(--color-text-primary)]">
                      {control.label}
                    </h5>
                    <p class="mt-1 text-[10px] leading-relaxed text-[var(--color-text-muted)]">
                      {control.description}
                    </p>
                  </div>
                  <span class="shrink-0 font-mono text-xs text-[var(--color-accent)]"
                    >{config[control.key] === 0 ? 'Off' : dollars(config[control.key])}</span
                  >
                </div>
                <div class="mt-3">
                  <NumberStepper
                    compact
                    value={config[control.key]}
                    min={0}
                    max={1_000_000}
                    step={50}
                    label={`${control.label} in cents`}
                    disabled={experimentalStore.isLoading}
                    onchange={(value) => save({ [control.key]: value }, `${control.label} saved.`)}
                  />
                </div>
              </div>
            {/each}
          </div>
        </section>

        <section
          class="space-y-4 rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface-1)] p-5 {config.enabled
            ? ''
            : 'opacity-60'}"
        >
          <div class="flex items-start gap-3">
            <span
              class="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-[var(--color-surface-2)] text-[var(--color-warning)]"
              ><ShieldCheck size={17} /></span
            >
            <div>
              <h4 class="text-sm font-semibold text-[var(--color-text-primary)]">
                When a limit is reached
              </h4>
              <p class="mt-1 text-xs leading-relaxed text-[var(--color-text-muted)]">
                The selected response is enforced by the backend before provider streaming starts.
              </p>
            </div>
          </div>
          <KorySelect
            value={config.action}
            label="Spend-limit response"
            disabled={experimentalStore.isLoading}
            options={[
              {
                value: 'pause',
                label: 'Pause the session',
                description: 'Reject the request and require an explicit resume from this pane.',
              },
              {
                value: 'block',
                label: 'Block while over limit',
                description:
                  'Reject requests until the rolling window falls below its limit; do not create a durable pause.',
              },
              {
                value: 'warn',
                label: 'Warn and continue',
                description: 'Show a warning but allow the provider request to start.',
              },
            ]}
            onchange={(value) =>
              save({ action: value as SpendCapConfig['action'] }, 'Spend-limit response saved.')}
          />
        </section>

        <section
          class="flex items-start gap-3 rounded-2xl border border-[var(--color-warning)] bg-[var(--color-warning-bg)] p-5"
        >
          <AlertTriangle size={18} class="mt-0.5 shrink-0 text-[var(--color-warning)]" />
          <div>
            <h4 class="text-sm font-semibold text-[var(--color-text-primary)]">
              What the limit can prove
            </h4>
            <p class="mt-1 text-xs leading-relaxed text-[var(--color-text-muted)]">
              Koryphaios evaluates provider-reported cost already persisted with assistant messages.
              It does not invent a cost estimate before a provider responds, so the final request in
              a window can cross a limit; the next request is stopped. The per-request field remains
              stored for API clients that can supply an authoritative estimate, but this UI does not
              present it as active protection.
            </p>
          </div>
        </section>

        <section
          class="space-y-3 rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface-1)] p-5"
        >
          <div class="flex items-start gap-3">
            <PauseCircle size={18} class="mt-0.5 shrink-0 text-[var(--color-text-secondary)]" />
            <div>
              <h4 class="text-sm font-semibold text-[var(--color-text-primary)]">
                Paused sessions
              </h4>
              <p class="mt-1 text-xs text-[var(--color-text-muted)]">
                Pauses survive backend restarts. Resume only after reviewing the recorded spend and
                limits.
              </p>
            </div>
          </div>
          {#if experimentalStore.pausedSessions.length}
            <div class="space-y-2">
              {#each experimentalStore.pausedSessions as session (session.sessionId)}
                <div
                  class="flex flex-wrap items-center gap-3 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-2)] p-3"
                >
                  <div class="min-w-0 flex-1">
                    <div class="truncate font-mono text-xs text-[var(--color-text-primary)]">
                      {session.sessionId}
                    </div>
                    <p class="mt-1 text-[10px] leading-relaxed text-[var(--color-text-muted)]">
                      {session.reason}
                    </p>
                  </div>
                  <button
                    type="button"
                    onclick={() => void experimentalStore.resumeSession(session.sessionId)}
                    class="min-h-10 rounded-xl border border-[var(--color-border)] px-3 text-xs font-semibold text-[var(--color-text-secondary)] hover:border-[var(--color-accent)]/50 hover:text-[var(--color-text-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)]/60"
                    >Resume</button
                  >
                </div>
              {/each}
            </div>
          {:else}
            <div
              class="rounded-xl border border-dashed border-[var(--color-border)] bg-[var(--color-surface-2)] px-4 py-5 text-center text-xs text-[var(--color-text-muted)]"
            >
              No session is paused by a spend limit.
            </div>
          {/if}
        </section>

        <div
          class="flex items-center justify-between gap-4 border-t border-[var(--color-border)] pt-4"
        >
          <div class="text-[10px] text-[var(--color-text-muted)]">
            {differsFromDefaults
              ? 'These limits differ from the recommended defaults.'
              : 'Recommended defaults are active.'}
          </div>
          <button
            type="button"
            disabled={!differsFromDefaults || experimentalStore.isLoading}
            onclick={() => (showResetDialog = true)}
            class="flex min-h-10 items-center gap-2 rounded-xl border border-[var(--color-border)] px-3 text-xs text-[var(--color-text-secondary)] hover:border-[var(--color-accent)]/50 hover:text-[var(--color-text-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)]/60 disabled:cursor-not-allowed disabled:opacity-40"
            ><RotateCcw size={14} /> Restore defaults</button
          >
        </div>
      {/if}
    </div>
  </div>
</div>

<ConfirmDialog
  open={showResetDialog}
  title="Restore recommended spend limits?"
  message="This replaces the current app-wide spend-limit values and response with the recommended defaults. Existing usage and pause history are preserved."
  confirmLabel="Restore defaults"
  variant="warning"
  onConfirm={resetLimits}
  onCancel={() => (showResetDialog = false)}
/>
