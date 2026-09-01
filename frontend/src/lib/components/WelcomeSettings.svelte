<script lang="ts">
  import RotateCcw from 'lucide-svelte/icons/rotate-ccw';
  import SettingsSwitch from './SettingsSwitch.svelte';
  import {
    welcomePreferencesStore,
    type WelcomePanelId,
  } from '$lib/stores/welcome-preferences.svelte';

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
    {
      id: 'proTips',
      label: 'Pro tips',
      description: 'Show the editable guidance panel below the starting suggestions.',
    },
    {
      id: 'workflow',
      label: 'Workflow',
      description: 'Show the editable workflow guidance panel in an empty agent feed.',
    },
  ];
</script>

<div class="mx-auto w-full max-w-4xl space-y-6 p-6">
  <header>
    <h3 class="text-lg font-semibold text-[var(--color-text-primary)]">Home screen</h3>
    <p class="mt-1 max-w-2xl text-sm leading-relaxed text-[var(--color-text-muted)]">
      Choose which empty-feed guidance panels appear. Closing a panel in the agent feed disables it
      here until you turn it back on.
    </p>
  </header>

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
