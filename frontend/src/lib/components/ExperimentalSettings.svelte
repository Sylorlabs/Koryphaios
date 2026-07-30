<script lang="ts">
  import { onMount } from 'svelte';
  import { experimentalStore, FEATURE_METADATA } from '$lib/stores/experimental.svelte';
  import SettingsSwitch from './SettingsSwitch.svelte';
  import SettingsPageIntro from './SettingsPageIntro.svelte';
  import { RefreshCw, FlaskConical, Shield, Terminal, Cpu, Beaker, Zap } from 'lucide-svelte';

  onMount(() => void experimentalStore.loadAll());

  const categoryIcons: Record<string, any> = {
    Billing: Zap,
    Processes: Terminal,
    Performance: Cpu,
    AI: Beaker,
  };
  const groupedFeatures = $derived(FEATURE_METADATA.reduce((groups, feature) => {
    (groups[feature.category] ??= []).push(feature);
    return groups;
  }, {} as Record<string, typeof FEATURE_METADATA>));
  const categories = $derived(Object.keys(groupedFeatures).sort());

  function toggleFeature(key: keyof typeof experimentalStore.features) {
    experimentalStore.toggleFeature(key);
  }
</script>

<div class="flex h-full min-h-0 flex-col overflow-hidden">
  <SettingsPageIntro title="Advanced controls" description="Power controls for runtime behavior. Changes are saved immediately.">
    <span class="rounded-full bg-[var(--color-surface-3)] px-2.5 py-1 text-[10px] text-[var(--color-text-muted)]">
      {experimentalStore.enabledCount} active
    </span>
  </SettingsPageIntro>

  <div class="min-h-0 flex-1 overflow-y-auto p-5">
    <div class="mx-auto max-w-5xl space-y-6">
      {#each categories as category}
        {@const Icon = categoryIcons[category] ?? Shield}
        <section>
          <div class="mb-2 flex items-center gap-2 px-1">
            <Icon size={14} style="color: var(--color-text-muted);" />
            <h4 class="text-xs font-semibold uppercase tracking-wide text-[var(--color-text-muted)]">{category}</h4>
          </div>
          <div class="divide-y divide-[var(--color-border)] rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-1)] px-4">
            {#each groupedFeatures[category] as feature (feature.key)}
              {@const unavailable = feature.status === 'coming-soon'}
              <div class:opacity-50={unavailable}>
                <SettingsSwitch
                  checked={Boolean(experimentalStore.features[feature.key])}
                  label={feature.label}
                  description={`${feature.description}${feature.requiresRestart ? ' Restart Koryphaios to apply.' : ''}${unavailable ? ' This control is not available yet.' : ''}`}
                  disabled={unavailable}
                  onchange={() => toggleFeature(feature.key)}
                  compact
                />
              </div>
            {/each}
          </div>
        </section>
      {/each}

      <div class="flex justify-end border-t border-[var(--color-border)] pt-4">
        <button type="button" onclick={() => experimentalStore.resetToDefaults()} class="flex items-center gap-2 rounded-lg px-3 py-2 text-xs text-[var(--color-text-muted)] transition-colors hover:bg-red-500/10 hover:text-red-400">
          <RefreshCw size={14} /> Reset to defaults
        </button>
      </div>
    </div>
  </div>
</div>
