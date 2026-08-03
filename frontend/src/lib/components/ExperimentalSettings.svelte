<script lang="ts">
  import { onMount } from 'svelte';
  import {
    Bot,
    Check,
    ChevronDown,
    CircleGauge,
    Database,
    RefreshCw,
    Search,
    ShieldCheck,
    SlidersHorizontal,
    Terminal,
    X,
  } from 'lucide-svelte';
  import {
    DEFAULT_EXPERIMENTAL_FEATURES,
    experimentalStore,
    FEATURE_CATEGORIES,
    FEATURE_METADATA,
    type FeatureMetadata,
  } from '$lib/stores/experimental.svelte';
  import ConfirmDialog from './ConfirmDialog.svelte';
  import SettingsPageIntro from './SettingsPageIntro.svelte';

  let searchInput = $state<HTMLInputElement | null>(null);
  let expandedFeature = $state<string | null>(null);
  let showResetDialog = $state(false);
  let announcement = $state('');

  const categoryIcons: Record<string, typeof Bot> = {
    'Agents & intelligence': Bot,
    'Cost & safety': ShieldCheck,
    'Runtime & recovery': Terminal,
    'Data & performance': Database,
  };

  const filteredGroups = $derived(
    FEATURE_CATEGORIES.map((category) => ({
      ...category,
      features: experimentalStore.filteredFeatures.filter(
        (feature) => feature.category === category.id,
      ),
    })).filter((category) => category.features.length > 0),
  );

  const activeFeatureCount = $derived(
    FEATURE_METADATA.filter((feature) => Boolean(experimentalStore.features[feature.key])).length,
  );
  const experimentalFeatureCount = $derived(
    FEATURE_METADATA.filter((feature) => feature.status === 'alpha' || feature.status === 'beta').length,
  );
  const modifiedFeatureCount = $derived(
    FEATURE_METADATA.filter(
      (feature) =>
        experimentalStore.features[feature.key] !== DEFAULT_EXPERIMENTAL_FEATURES[feature.key],
    ).length,
  );

  onMount(() => void experimentalStore.loadAll());

  function handleWindowKeydown(event: KeyboardEvent) {
    if (
      event.key === '/' &&
      !(event.target instanceof HTMLInputElement) &&
      !(event.target instanceof HTMLTextAreaElement)
    ) {
      event.preventDefault();
      searchInput?.focus();
    }
  }

  function toggleFeature(feature: FeatureMetadata) {
    const wasEnabled = Boolean(experimentalStore.features[feature.key]);
    experimentalStore.toggleFeature(feature.key);
    announcement = `${feature.label} ${wasEnabled ? 'off' : 'on'}. Saved on this device.`;
  }

  function resetToDefaults() {
    experimentalStore.resetToDefaults();
    showResetDialog = false;
    announcement = 'Advanced settings reset to defaults.';
  }

  function clearFilters() {
    experimentalStore.setSearchQuery('');
    experimentalStore.setSelectedCategory('All');
    searchInput?.focus();
  }

  function maturityDescription(status: FeatureMetadata['status']) {
    if (status === 'stable') return 'Supported for regular use.';
    if (status === 'beta') return 'Ready to try, but behavior may still change.';
    if (status === 'alpha') return 'Early behavior intended for careful testing.';
    return 'Not available in this build yet.';
  }

  function statusStyle(status: FeatureMetadata['status']) {
    if (status === 'stable') {
      return 'color: var(--color-success); background: color-mix(in srgb, var(--color-success) 10%, transparent); border-color: color-mix(in srgb, var(--color-success) 24%, transparent);';
    }
    if (status === 'beta') {
      return 'color: var(--color-warning); background: color-mix(in srgb, var(--color-warning) 10%, transparent); border-color: color-mix(in srgb, var(--color-warning) 24%, transparent);';
    }
    if (status === 'alpha') {
      return 'color: var(--color-accent); background: color-mix(in srgb, var(--color-accent) 10%, transparent); border-color: color-mix(in srgb, var(--color-accent) 24%, transparent);';
    }
    return 'color: var(--color-text-muted); background: var(--color-surface-3); border-color: var(--color-border);';
  }
</script>

<svelte:window onkeydown={handleWindowKeydown} />

<div class="flex h-full min-h-0 flex-col overflow-hidden">
  <SettingsPageIntro
    title="Advanced settings"
    description="Fine-tune Koryphaios runtime behavior. Changes are saved on this device as soon as you make them."
  >
    <span
      class="rounded-full border border-[var(--color-border)] bg-[var(--color-surface-2)] px-2.5 py-1 text-[10px] font-medium text-[var(--color-text-secondary)]"
    >
      {activeFeatureCount} of {FEATURE_METADATA.length} active
    </span>
  </SettingsPageIntro>

  <p class="sr-only" aria-live="polite">{announcement}</p>

  <div class="min-h-0 flex-1 overflow-y-auto p-4 sm:p-6">
    <div class="mx-auto max-w-7xl space-y-5">
      <section
        aria-label="Advanced settings overview"
        class="overflow-hidden rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface-1)]"
      >
        <div class="flex flex-col gap-4 p-4 sm:p-5 lg:flex-row lg:items-center">
          <div class="min-w-0 flex-1">
            <label for="advanced-settings-search" class="sr-only">Search advanced settings</label>
            <div class="relative">
              <Search
                size={17}
                aria-hidden="true"
                class="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-[var(--color-text-muted)]"
              />
              <input
                id="advanced-settings-search"
                bind:this={searchInput}
                type="text"
                role="searchbox"
                value={experimentalStore.searchQuery}
                oninput={(event) =>
                  experimentalStore.setSearchQuery(event.currentTarget.value)}
                placeholder="Search controls, outcomes, or categories"
                class="h-11 w-full rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-0)] pl-10 pr-12 text-sm text-[var(--color-text-primary)] outline-none transition-colors placeholder:text-[var(--color-text-muted)] hover:border-[var(--color-border-bright)] focus:border-[var(--color-accent)] focus:ring-2 focus:ring-[var(--color-accent)]/20"
              />
              <div class="absolute right-2.5 top-1/2 flex -translate-y-1/2 items-center gap-1.5">
                {#if experimentalStore.searchQuery}
                  <button
                    type="button"
                    aria-label="Clear advanced settings search"
                    onclick={() => experimentalStore.setSearchQuery('')}
                    class="flex h-7 w-7 items-center justify-center rounded-md text-[var(--color-text-muted)] hover:bg-[var(--color-surface-3)] hover:text-[var(--color-text-primary)]"
                  >
                    <X size={14} />
                  </button>
                {:else}
                  <kbd
                    class="rounded-md border border-[var(--color-border)] bg-[var(--color-surface-2)] px-1.5 py-0.5 font-mono text-[9px] text-[var(--color-text-muted)]"
                    >/</kbd
                  >
                {/if}
              </div>
            </div>
          </div>

          <div class="grid grid-cols-3 gap-2 lg:w-[430px]">
            <div class="rounded-xl bg-[var(--color-surface-2)] px-3 py-2.5">
              <div class="text-lg font-semibold tabular-nums text-[var(--color-text-primary)]">
                {activeFeatureCount}
              </div>
              <div class="text-[10px] text-[var(--color-text-muted)]">Active</div>
            </div>
            <div class="rounded-xl bg-[var(--color-surface-2)] px-3 py-2.5">
              <div class="text-lg font-semibold tabular-nums text-[var(--color-text-primary)]">
                {experimentalFeatureCount}
              </div>
              <div class="text-[10px] text-[var(--color-text-muted)]">Experimental</div>
            </div>
            <div class="rounded-xl bg-[var(--color-surface-2)] px-3 py-2.5">
              <div class="flex h-7 items-center text-[var(--color-success)]">
                <Check size={17} strokeWidth={2.5} />
              </div>
              <div class="text-[10px] text-[var(--color-text-muted)]">Auto-saved</div>
            </div>
          </div>
        </div>
      </section>

      <div class="grid min-w-0 gap-5 lg:grid-cols-[230px_minmax(0,1fr)]">
        <aside class="min-w-0" aria-label="Advanced settings categories">
          <div
            class="flex gap-2 overflow-x-auto pb-1 lg:sticky lg:top-0 lg:block lg:space-y-1 lg:overflow-visible lg:pb-0"
          >
            <button
              type="button"
              aria-pressed={experimentalStore.selectedCategory === 'All'}
              onclick={() => experimentalStore.setSelectedCategory('All')}
              class="flex min-h-11 shrink-0 items-center gap-3 rounded-xl px-3 text-left text-xs transition-colors lg:w-full {experimentalStore.selectedCategory ===
              'All'
                ? 'bg-[var(--color-surface-3)] text-[var(--color-text-primary)]'
                : 'text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-2)]'}"
            >
              <SlidersHorizontal size={16} class="shrink-0" />
              <span class="font-medium">All controls</span>
              <span class="ml-auto tabular-nums text-[10px] text-[var(--color-text-muted)]"
                >{FEATURE_METADATA.length}</span
              >
            </button>

            {#each FEATURE_CATEGORIES as category (category.id)}
              {@const Icon = categoryIcons[category.id]}
              {@const count = FEATURE_METADATA.filter((feature) => feature.category === category.id).length}
              <button
                type="button"
                aria-pressed={experimentalStore.selectedCategory === category.id}
                onclick={() => experimentalStore.setSelectedCategory(category.id)}
                class="flex min-h-11 shrink-0 items-center gap-3 rounded-xl px-3 text-left text-xs transition-colors lg:w-full {experimentalStore.selectedCategory ===
                category.id
                  ? 'bg-[var(--color-surface-3)] text-[var(--color-text-primary)]'
                  : 'text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-2)]'}"
              >
                <Icon size={16} class="shrink-0" />
                <span class="font-medium">{category.id}</span>
                <span class="ml-auto tabular-nums text-[10px] text-[var(--color-text-muted)]"
                  >{count}</span
                >
              </button>
            {/each}
          </div>
        </aside>

        <main class="min-w-0 space-y-5">
          {#if filteredGroups.length}
            {#each filteredGroups as group (group.id)}
              {@const Icon = categoryIcons[group.id]}
              {@const groupActiveCount = group.features.filter((feature) =>
                Boolean(experimentalStore.features[feature.key]),
              ).length}
              <section aria-labelledby={`advanced-group-${group.id.replaceAll(' ', '-').toLowerCase()}`}>
                <div class="mb-2.5 flex items-end justify-between gap-4 px-1">
                  <div class="flex min-w-0 items-start gap-3">
                    <span
                      class="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-[var(--color-surface-2)] text-[var(--color-text-secondary)]"
                    >
                      <Icon size={16} />
                    </span>
                    <div class="min-w-0">
                      <h4
                        id={`advanced-group-${group.id.replaceAll(' ', '-').toLowerCase()}`}
                        class="text-sm font-semibold text-[var(--color-text-primary)]"
                      >
                        {group.id}
                      </h4>
                      <p class="mt-0.5 text-[11px] leading-relaxed text-[var(--color-text-muted)]">
                        {group.description}
                      </p>
                    </div>
                  </div>
                  <span class="shrink-0 text-[10px] tabular-nums text-[var(--color-text-muted)]">
                    {groupActiveCount} of {group.features.length} on
                  </span>
                </div>

                <div
                  class="divide-y divide-[var(--color-border)] overflow-hidden rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface-1)]"
                >
                  {#each group.features as feature (feature.key)}
                    {@const checked = Boolean(experimentalStore.features[feature.key])}
                    {@const unavailable = feature.status === 'coming-soon'}
                    {@const expanded = expandedFeature === feature.key}
                    <article class:opacity-60={unavailable}>
                      <div class="flex items-start gap-4 p-4 sm:p-5">
                        <div class="min-w-0 flex-1">
                          <div class="flex flex-wrap items-center gap-2">
                            <h5 class="text-sm font-semibold text-[var(--color-text-primary)]">
                              {feature.label}
                            </h5>
                            <span
                              class="rounded-full border px-2 py-0.5 text-[9px] font-semibold uppercase tracking-[0.08em]"
                              style={statusStyle(feature.status)}
                            >
                              {feature.status === 'coming-soon' ? 'Coming soon' : feature.status}
                            </span>
                            {#if feature.requiresRestart}
                              <span
                                class="rounded-full border border-[var(--color-border)] bg-[var(--color-surface-2)] px-2 py-0.5 text-[9px] font-medium text-[var(--color-text-muted)]"
                              >
                                Restart required
                              </span>
                            {/if}
                          </div>
                          <p class="mt-1.5 max-w-3xl text-xs leading-relaxed text-[var(--color-text-secondary)]">
                            {feature.description}
                          </p>
                          <button
                            type="button"
                            aria-expanded={expanded}
                            aria-controls={`advanced-details-${feature.key}`}
                            onclick={() => (expandedFeature = expanded ? null : String(feature.key))}
                            class="mt-2.5 flex min-h-8 items-center gap-1.5 rounded-lg px-2 text-[10px] font-medium text-[var(--color-text-muted)] transition-colors hover:bg-[var(--color-surface-2)] hover:text-[var(--color-text-primary)]"
                          >
                            Details
                            <ChevronDown
                              size={13}
                              class="transition-transform {expanded ? 'rotate-180' : ''}"
                            />
                          </button>
                        </div>

                        <button
                          type="button"
                          role="switch"
                          aria-checked={checked}
                          aria-label={`${feature.label}: ${checked ? 'On' : 'Off'}`}
                          disabled={unavailable}
                          onclick={() => toggleFeature(feature)}
                          class="group flex min-h-11 shrink-0 items-center gap-2.5 rounded-xl px-2 text-xs font-semibold transition-colors focus-visible:ring-2 focus-visible:ring-[var(--color-accent)]/50 disabled:cursor-not-allowed"
                        >
                          <span
                            class="w-6 text-right text-[10px] {checked
                              ? 'text-[var(--color-text-primary)]'
                              : 'text-[var(--color-text-muted)]'}"
                            >{checked ? 'On' : 'Off'}</span
                          >
                          <span
                            aria-hidden="true"
                            class="relative inline-flex h-6 w-11 shrink-0 items-center rounded-full border transition-all duration-200"
                            style="border-color: {checked
                              ? 'var(--color-accent)'
                              : 'var(--color-border-bright)'}; background: {checked
                              ? 'var(--color-accent)'
                              : 'var(--color-surface-4)'};"
                          >
                            <span
                              class="h-4 w-4 rounded-full bg-white shadow-sm transition-transform duration-200"
                              style="transform: translateX({checked ? '22px' : '3px'});"
                            ></span>
                          </span>
                        </button>
                      </div>

                      {#if expanded}
                        <div
                          id={`advanced-details-${feature.key}`}
                          class="border-t border-[var(--color-border)] bg-[var(--color-surface-0)] px-4 py-3 sm:px-5"
                        >
                          <div class="grid gap-3 text-[11px] sm:grid-cols-2">
                            <div class="flex gap-2.5">
                              <CircleGauge
                                size={15}
                                class="mt-0.5 shrink-0 text-[var(--color-text-muted)]"
                              />
                              <div>
                                <div class="font-semibold text-[var(--color-text-secondary)]">What changes</div>
                                <p class="mt-1 leading-relaxed text-[var(--color-text-muted)]">
                                  {feature.impact}
                                </p>
                              </div>
                            </div>
                            <div class="flex gap-2.5">
                              <ShieldCheck
                                size={15}
                                class="mt-0.5 shrink-0 text-[var(--color-text-muted)]"
                              />
                              <div>
                                <div class="font-semibold text-[var(--color-text-secondary)]">Maturity</div>
                                <p class="mt-1 leading-relaxed text-[var(--color-text-muted)]">
                                  {maturityDescription(feature.status)}
                                  {feature.requiresRestart
                                    ? ' Restart Koryphaios after changing this control.'
                                    : ' Changes apply immediately.'}
                                </p>
                              </div>
                            </div>
                          </div>
                        </div>
                      {/if}
                    </article>
                  {/each}
                </div>
              </section>
            {/each}
          {:else}
            <section
              aria-label="No matching advanced settings"
              class="flex min-h-72 flex-col items-center justify-center rounded-2xl border border-dashed border-[var(--color-border)] bg-[var(--color-surface-1)] p-8 text-center"
            >
              <span
                class="flex h-11 w-11 items-center justify-center rounded-xl bg-[var(--color-surface-2)] text-[var(--color-text-muted)]"
              >
                <Search size={20} />
              </span>
              <h4 class="mt-4 text-sm font-semibold text-[var(--color-text-primary)]">No controls found</h4>
              <p class="mt-1 max-w-sm text-xs leading-relaxed text-[var(--color-text-muted)]">
                Try a feature name, outcome, or another category.
              </p>
              <button
                type="button"
                onclick={clearFilters}
                class="mt-4 min-h-10 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-2)] px-4 text-xs font-medium text-[var(--color-text-primary)] hover:border-[var(--color-border-bright)]"
              >
                Clear filters
              </button>
            </section>
          {/if}

          <div
            class="flex flex-col gap-3 border-t border-[var(--color-border)] px-1 pt-4 sm:flex-row sm:items-center sm:justify-between"
          >
            <div>
              <div class="text-xs font-medium text-[var(--color-text-secondary)]">Restore recommended defaults</div>
              <div class="mt-0.5 text-[10px] text-[var(--color-text-muted)]">
                {modifiedFeatureCount
                  ? `${modifiedFeatureCount} setting${modifiedFeatureCount === 1 ? '' : 's'} differ from defaults.`
                  : 'All advanced controls already match their defaults.'}
              </div>
            </div>
            <button
              type="button"
              disabled={modifiedFeatureCount === 0}
              onclick={() => (showResetDialog = true)}
              class="flex min-h-10 shrink-0 items-center justify-center gap-2 rounded-xl border border-[var(--color-border)] px-3 text-xs text-[var(--color-text-secondary)] transition-colors hover:border-[var(--color-error)] hover:bg-[color-mix(in_srgb,var(--color-error)_8%,transparent)] hover:text-[var(--color-error)] disabled:cursor-not-allowed disabled:opacity-40"
            >
              <RefreshCw size={14} /> Reset to defaults
            </button>
          </div>
        </main>
      </div>
    </div>
  </div>
</div>

<ConfirmDialog
  open={showResetDialog}
  title="Reset advanced settings?"
  message={`This will restore ${modifiedFeatureCount} changed setting${modifiedFeatureCount === 1 ? '' : 's'} to the recommended defaults. You can change them again at any time.`}
  confirmLabel="Reset settings"
  variant="warning"
  onConfirm={resetToDefaults}
  onCancel={() => (showResetDialog = false)}
/>
