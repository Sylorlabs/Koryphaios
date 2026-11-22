<script lang="ts">
  import AlertTriangle from 'lucide-svelte/icons/alert-triangle';
  import RefreshCw from 'lucide-svelte/icons/refresh-cw';
  import RotateCcw from 'lucide-svelte/icons/rotate-ccw';
  import {
    DEFAULT_SPEND_CAP_CONFIG,
    experimentalStore,
    type SpendCapConfig,
  } from '$lib/stores/experimental.svelte';
  import ConfirmDialog from './ConfirmDialog.svelte';
  import KorySelect from './KorySelect.svelte';
  import NumberStepper from './NumberStepper.svelte';
  import SettingsSwitch from './SettingsSwitch.svelte';
  import SettingsPage from './settings/SettingsPage.svelte';
  import { SETTINGS_CATALOG } from '$lib/utils/settings-catalog';

  const pageDescription =
    SETTINGS_CATALOG.find((entry) => entry.id === 'experimental')?.description ??
    'Runtime-enforced spend limits and recovery for paused sessions.';

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

  function centsToDollars(cents: number): number {
    return Math.round((cents / 100) * 100) / 100;
  }

  function dollarsToCents(dollarsValue: number): number {
    if (!Number.isFinite(dollarsValue) || dollarsValue <= 0) return 0;
    return Math.round(dollarsValue * 100);
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
  <p class="sr-only" aria-live="polite">{announcement}</p>

  <div class="min-h-0 flex-1 overflow-y-auto">
    <SettingsPage title="Safety limits" description={pageDescription} width="narrow">
      {#if experimentalStore.spendCapError}
        <section
          role="alert"
          class="flex items-start gap-3 rounded-xl border border-[var(--color-error)]/35 bg-[var(--color-error-bg)] p-4"
        >
          <AlertTriangle size={18} class="mt-0.5 shrink-0 text-[var(--color-error)]" />
          <div class="min-w-0 flex-1">
            <h3 class="text-sm font-semibold text-[var(--color-text-primary)]">
              Safety limits unavailable
            </h3>
            <p class="mt-1 text-xs leading-relaxed text-[var(--color-text-muted)]">
              {experimentalStore.spendCapError}
            </p>
          </div>
          <button
            type="button"
            disabled={experimentalStore.isLoading}
            onclick={() => void experimentalStore.loadAll()}
            class="flex min-h-9 shrink-0 items-center gap-2 rounded-lg border border-[var(--color-border)] px-3 text-xs text-[var(--color-text-secondary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)]/60 disabled:cursor-not-allowed disabled:opacity-50"
            ><RefreshCw size={14} /> Retry</button
          >
        </section>
      {:else if experimentalStore.isLoading}
        <p role="status" class="flex items-center gap-2 text-sm text-[var(--color-text-muted)]">
          <RefreshCw size={16} class="animate-spin" /> Loading enforced limits…
        </p>
      {:else}
        <section>
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

        <section class="space-y-3" aria-labelledby="safety-limits-windows">
          <div>
            <h3
              id="safety-limits-windows"
              class="text-sm font-semibold text-[var(--color-text-primary)]"
            >
              Rolling spend windows
            </h3>
            <p class="mt-1 text-xs leading-relaxed text-[var(--color-text-muted)]">
              Values are US dollars. Enter 0 to disable one limit while keeping the others active.
            </p>
          </div>

          <div class="grid items-start gap-3 sm:grid-cols-2">
            {#each limitControls as control (control.key)}
              <div class="rounded-xl bg-[var(--color-surface-2)] p-4">
                <h4 class="text-xs font-semibold text-[var(--color-text-primary)]">
                  {control.label}
                </h4>
                <p class="mt-1 text-xs leading-relaxed text-[var(--color-text-muted)]">
                  {control.description}
                </p>
                <div class="pt-3">
                  <NumberStepper
                    compact
                    quiet
                    value={centsToDollars(config[control.key])}
                    min={0}
                    max={10_000}
                    step={1}
                    decimals={2}
                    label={`${control.label} in dollars`}
                    valueText={config[control.key] === 0
                      ? `${control.label} off`
                      : `${control.label} ${dollars(config[control.key])}`}
                    unit="$"
                    disabled={experimentalStore.isLoading}
                    onchange={(value) =>
                      save({ [control.key]: dollarsToCents(value) }, `${control.label} saved.`)}
                  />
                </div>
              </div>
            {/each}
          </div>
        </section>

        <section class="space-y-3" aria-labelledby="safety-limits-response">
          <div>
            <h3
              id="safety-limits-response"
              class="text-sm font-semibold text-[var(--color-text-primary)]"
            >
              When a limit is reached
            </h3>
            <p class="mt-1 text-xs leading-relaxed text-[var(--color-text-muted)]">
              The selected response is enforced by the backend before provider streaming starts.
            </p>
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
                  'Reject requests until the rolling window falls below its limit. Do not create a durable pause.',
              },
              {
                value: 'warn',
                label: 'Warn and continue',
                description: 'Show a warning but allow the provider request to start.',
              },
              {
                value: 'continue',
                label: 'Continue until work is done',
                description:
                  'Never pause or block for spend. Usage is still recorded against the windows above.',
              },
            ]}
            onchange={(value) =>
              save({ action: value as SpendCapConfig['action'] }, 'Spend-limit response saved.')}
          />
        </section>

        <section class="space-y-3" aria-labelledby="safety-limits-paused">
          <div>
            <h3
              id="safety-limits-paused"
              class="text-sm font-semibold text-[var(--color-text-primary)]"
            >
              Paused sessions
            </h3>
            <p class="mt-1 text-xs leading-relaxed text-[var(--color-text-muted)]">
              Pauses survive backend restarts. Resume only after reviewing the recorded spend and
              limits.
            </p>
          </div>
          {#if experimentalStore.pausedSessions.length}
            <div class="space-y-2">
              {#each experimentalStore.pausedSessions as session (session.sessionId)}
                <div
                  class="flex flex-wrap items-center gap-3 rounded-xl bg-[var(--color-surface-2)] p-3"
                >
                  <div class="min-w-0 flex-1">
                    <div class="truncate font-mono text-xs text-[var(--color-text-primary)]">
                      {session.sessionId}
                    </div>
                    <p class="mt-1 text-[11px] leading-relaxed text-[var(--color-text-muted)]">
                      {session.reason}
                    </p>
                  </div>
                  <button
                    type="button"
                    onclick={() => void experimentalStore.resumeSession(session.sessionId)}
                    class="min-h-9 rounded-lg border border-[var(--color-border)] px-3 text-xs font-semibold text-[var(--color-text-secondary)] hover:border-[var(--color-accent)]/50 hover:text-[var(--color-text-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)]/60"
                    >Resume</button
                  >
                </div>
              {/each}
            </div>
          {:else}
            <p class="text-xs text-[var(--color-text-muted)]">
              No session is paused by a spend limit.
            </p>
          {/if}
        </section>

        <div
          class="flex items-center justify-between gap-4 border-t border-[var(--color-border)] pt-4"
        >
          <div class="text-[11px] text-[var(--color-text-muted)]">
            {differsFromDefaults
              ? 'These limits differ from the recommended defaults.'
              : 'Recommended defaults are active.'}
          </div>
          <button
            type="button"
            disabled={!differsFromDefaults || experimentalStore.isLoading}
            onclick={() => (showResetDialog = true)}
            class="flex min-h-9 items-center gap-2 rounded-lg border border-[var(--color-border)] px-3 text-xs text-[var(--color-text-secondary)] hover:border-[var(--color-accent)]/50 hover:text-[var(--color-text-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)]/60 disabled:cursor-not-allowed disabled:opacity-40"
            ><RotateCcw size={14} /> Restore defaults</button
          >
        </div>
      {/if}
    </SettingsPage>
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
