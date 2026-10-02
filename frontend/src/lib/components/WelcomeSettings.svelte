<script lang="ts">
  import RotateCcw from 'lucide-svelte/icons/rotate-ccw';
  import Sparkles from 'lucide-svelte/icons/sparkles';
  import SettingsSwitch from './SettingsSwitch.svelte';
  import {
    welcomePreferencesStore,
    type WelcomePanelId,
  } from '$lib/stores/welcome-preferences.svelte';
  import { onboardingStore } from '$lib/stores/onboarding.svelte';

  interface Props {
    /** Close the settings drawer so the walkthrough has the stage to itself. */
    onReplayWalkthrough?: () => void;
  }

  let { onReplayWalkthrough }: Props = $props();

  const panels: Array<{
    id: WelcomePanelId;
    label: string;
    description: string;
  }> = [
    {
      id: 'suggestions',
      label: 'Starting suggestions',
      description: 'Show the editable project starting-point cards in an empty agent feed.',
    },
  ];

  const walkthroughStatus = $derived.by(() => {
    const record = onboardingStore.record;
    if (!record) return 'Not completed yet on this device.';
    const when = new Date(record.finishedAt).toLocaleDateString(undefined, {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
    });
    return record.outcome === 'completed'
      ? `Completed on ${when}.`
      : `Skipped on ${when}. Koryphaios defaults are in use.`;
  });

  function replayWalkthrough() {
    onboardingStore.replay();
    onReplayWalkthrough?.();
  }
</script>

<div class="mx-auto w-full max-w-4xl space-y-6 p-6">
  <header>
    <h3 class="text-lg font-semibold text-[var(--color-text-primary)]">Home screen</h3>
    <p class="mt-1 max-w-2xl text-sm leading-relaxed text-[var(--color-text-muted)]">
      Choose what appears in an empty agent feed, and revisit the first-launch walkthrough whenever
      you want a refresher.
    </p>
  </header>

  <section
    class="flex flex-col gap-4 rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface-2)] p-4 sm:flex-row sm:items-center sm:justify-between"
  >
    <div class="flex min-w-0 items-start gap-3">
      <span
        class="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl"
        style="background: color-mix(in srgb, var(--color-accent) 14%, transparent); color: var(--color-accent);"
      >
        <Sparkles size={16} />
      </span>
      <span class="min-w-0">
        <span class="block text-sm font-medium text-[var(--color-text-primary)]"
          >Welcome walkthrough</span
        >
        <span class="mt-1 block text-xs leading-relaxed text-[var(--color-text-muted)]">
          A short guided setup for appearance, response style, autonomy, and providers.
          {walkthroughStatus}
        </span>
      </span>
    </div>
    <button type="button" class="btn shrink-0" onclick={replayWalkthrough}>
      <Sparkles size={14} /> Replay walkthrough
    </button>
  </section>

  <section class="space-y-3">
    {#each panels as panel (panel.id)}
      <div class="rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface-2)] p-4">
        <SettingsSwitch
          checked={welcomePreferencesStore.preferences.enabled[panel.id]}
          label={panel.label}
          description={panel.description}
          flat
          onchange={() =>
            welcomePreferencesStore.setPanelEnabled(
              panel.id,
              !welcomePreferencesStore.preferences.enabled[panel.id],
            )}
        />
        <div class="mt-2 flex justify-end border-t border-[var(--color-border)] pt-3">
          <button
            type="button"
            class="btn"
            onclick={() => welcomePreferencesStore.resetPanel(panel.id)}
          >
            <RotateCcw size={14} /> Reset content
          </button>
        </div>
      </div>
    {/each}
  </section>
</div>
