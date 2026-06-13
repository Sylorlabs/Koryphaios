<script lang="ts">
  import { experimentalStore, FEATURE_METADATA, FEATURE_CATEGORIES } from "$lib/stores/experimental.svelte";
  import { toastStore } from "$lib/stores/toast.svelte";
  import { 
    FlaskConical, 
    Search,
    RefreshCw,
    AlertTriangle,
    Check,
    X,
    Zap,
    Beaker,
    Clock,
    Shield,
    Cpu,
    Database,
    Layers,
    MessageSquare,
    Lock,
    Terminal,
    Settings2
  } from "lucide-svelte";
  import { onMount } from "svelte";

  // Load data on mount
  onMount(() => {
    void experimentalStore.loadAll();
  });

  // Status badge colors
  const statusColors = {
    stable: { bg: "rgba(34, 197, 94, 0.2)", text: "#22c55e", label: "Stable" },
    beta: { bg: "rgba(245, 158, 11, 0.2)", text: "#f59e0b", label: "Beta" },
    alpha: { bg: "rgba(239, 68, 68, 0.2)", text: "#ef4444", label: "Alpha" },
    "coming-soon": { bg: "rgba(107, 114, 128, 0.2)", text: "#6b7280", label: "Soon" },
  };

  // Category icons
  const categoryIcons: Record<string, any> = {
    Billing: Zap,
    Database: Database,
    Reliability: Shield,
    Processes: Terminal,
    Performance: Cpu,
    UX: Settings2,
    AI: Beaker,
    Integrations: Layers,
    Security: Lock,
  };

  // Group features by category for display
  const groupedFeatures = $derived(experimentalStore.filteredFeatures.reduce((acc, feature) => {
    if (!acc[feature.category]) acc[feature.category] = [];
    acc[feature.category].push(feature);
    return acc;
  }, {} as Record<string, typeof FEATURE_METADATA>));

  const sortedCategories = $derived(Object.keys(groupedFeatures).sort());

  function toggleFeature(key: keyof typeof experimentalStore.features) {
    const meta = FEATURE_METADATA.find(f => f.key === key);
    if (meta?.status === "coming-soon") {
      toastStore.info(`${meta.label} is coming soon!`);
      return;
    }
    experimentalStore.toggleFeature(key);
  }
</script>

<div class="flex h-full min-h-0 min-w-0 flex-col gap-4">
  <!-- Intro Banner -->
  <div class="flex items-start gap-3 p-3 rounded-lg" style="background: var(--color-surface-1); border: 1px solid var(--color-border);">
    <Beaker size={16} class="shrink-0 mt-0.5" style="color: var(--color-accent);" />
    <div class="flex-1 min-w-0">
      <p class="text-[11px] font-medium" style="color: var(--color-text-primary);">Advanced Settings</p>
      <p class="text-[10px] mt-0.5" style="color: var(--color-text-muted);">
        <span style="color: #22c55e;">Stable</span> features are production-ready and on by default.
        <span style="color: #f59e0b;">Beta</span>/<span style="color: #ef4444;">Alpha</span> are experimental — enable at your own risk.
      </p>
    </div>
  </div>

  <!-- Search & Filter Bar -->
  <div class="flex flex-col gap-2">
    <!-- Search -->
    <div class="relative">
      <Search size={14} class="absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" style="color: var(--color-text-muted);" />
      <input
        type="text"
        placeholder="Search advanced settings..."
        value={experimentalStore.searchQuery}
        oninput={(e) => experimentalStore.setSearchQuery(e.currentTarget.value)}
        class="w-full pl-9 pr-3 py-2 text-xs rounded-lg border"
        style="background: var(--color-surface-0); border-color: var(--color-border); color: var(--color-text-primary);"
      />
      {#if experimentalStore.searchQuery}
        <button
          class="absolute right-2 top-1/2 -translate-y-1/2 p-1 rounded"
          style="color: var(--color-text-muted);"
          onclick={() => experimentalStore.setSearchQuery("")}
        >
          <X size={12} />
        </button>
      {/if}
    </div>

    <!-- Category Pills -->
    <div class="flex flex-wrap gap-1">
      <button
        class="px-2 py-1 text-[10px] rounded-full transition-colors"
        style="background: {experimentalStore.selectedCategory === 'All' ? 'var(--color-accent)' : 'var(--color-surface-0)'};
               color: {experimentalStore.selectedCategory === 'All' ? 'white' : 'var(--color-text-muted)'};
               border: 1px solid {experimentalStore.selectedCategory === 'All' ? 'var(--color-accent)' : 'var(--color-border)'};"
        onclick={() => experimentalStore.setSelectedCategory("All")}
      >
        All ({FEATURE_METADATA.length})
      </button>
      {#each FEATURE_CATEGORIES as category}
        {@const count = FEATURE_METADATA.filter(f => f.category === category).length}
        <button
          class="px-2 py-1 text-[10px] rounded-full transition-colors"
          style="background: {experimentalStore.selectedCategory === category ? 'var(--color-accent)' : 'var(--color-surface-0)'};
                 color: {experimentalStore.selectedCategory === category ? 'white' : 'var(--color-text-muted)'};
                 border: 1px solid {experimentalStore.selectedCategory === category ? 'var(--color-accent)' : 'var(--color-border)'};"
          onclick={() => experimentalStore.setSelectedCategory(category)}
        >
          {category} ({count})
        </button>
      {/each}
    </div>
  </div>

  <!-- Stats -->
  <div class="flex items-center justify-between text-[10px]" style="color: var(--color-text-muted);">
    <span>
      {experimentalStore.enabledCount} of {FEATURE_METADATA.length} enabled
    </span>
    {#if experimentalStore.searchQuery}
      <span>
        {experimentalStore.filteredFeatures.length} results
      </span>
    {/if}
  </div>

  <!-- Feature List -->
  <div class="flex-1 min-h-0 space-y-4 overflow-y-auto pr-1">
    {#if experimentalStore.filteredFeatures.length === 0}
      <div class="text-center py-8">
        <FlaskConical size={32} class="mx-auto mb-2 opacity-30" style="color: var(--color-text-muted);" />
        <p class="text-xs" style="color: var(--color-text-muted);">No features found</p>
        <p class="text-[10px] mt-1" style="color: var(--color-text-muted);">Try a different search term</p>
      </div>
    {:else}
      {#each sortedCategories as category}
        {@const features = groupedFeatures[category]}
        {@const Icon = categoryIcons[category] || FlaskConical}
        <div class="space-y-2">
          <!-- Category Header -->
          <div class="flex items-center gap-2 sticky top-0 py-1" style="background: var(--color-surface-1);">
            <Icon size={12} style="color: var(--color-text-muted);" />
            <span class="text-[10px] font-medium uppercase tracking-wide" style="color: var(--color-text-muted);">
              {category}
            </span>
            <span class="text-[9px] px-1.5 rounded-full" style="background: var(--color-surface-0); color: var(--color-text-muted);">
              {features.length}
            </span>
          </div>

          <!-- Features -->
          <div class="grid gap-3 xl:grid-cols-2">
            {#each features as feature}
              {@const isEnabled = experimentalStore.features[feature.key]}
              {@const status = statusColors[feature.status]}
              <div 
                class="flex h-full items-start gap-3 rounded-xl p-3 transition-colors"
                style="background: var(--color-surface-0); border: 1px solid {isEnabled ? 'var(--color-accent)' : 'var(--color-border)'};
                         opacity: {feature.status === 'coming-soon' ? 0.6 : 1};"
              >
                <!-- Checkbox -->
                <button
                  class="shrink-0 w-5 h-5 rounded border flex items-center justify-center transition-colors mt-0.5"
                  style="background: {isEnabled ? 'var(--color-accent)' : 'transparent'};
                             border-color: {isEnabled ? 'var(--color-accent)' : 'var(--color-border)'};"
                  onclick={() => toggleFeature(feature.key)}
                  disabled={feature.status === "coming-soon"}
                  aria-label="Toggle {feature.label}"
                >
                  {#if isEnabled}
                    <Check size={12} color="white" />
                  {/if}
                </button>

                <!-- Content -->
                <div class="flex-1 min-w-0">
                  <div class="flex items-center gap-2 flex-wrap">
                    <span class="text-xs font-medium" style="color: var(--color-text-primary);">
                      {feature.label}
                    </span>
                    <span 
                      class="text-[9px] px-1.5 py-0.5 rounded-full font-medium"
                      style="background: {status.bg}; color: {status.text};"
                    >
                      {status.label}
                    </span>
                    {#if feature.requiresRestart}
                      <span 
                        class="text-[9px] px-1.5 py-0.5 rounded-full"
                        style="background: rgba(59, 130, 246, 0.2); color: #3b82f6;"
                      >
                        Requires restart
                      </span>
                    {/if}
                  </div>
                  <p class="text-[10px] mt-1" style="color: var(--color-text-muted); line-height: 1.4;">
                    {feature.description}
                  </p>
                </div>
              </div>
            {/each}
          </div>
        </div>
      {/each}
    {/if}
  </div>

  <!-- Footer -->
  <div class="shrink-0 pt-3 border-t flex flex-wrap items-center justify-between gap-2" style="border-color: var(--color-border);">
    <button
      class="flex items-center gap-1.5 text-[10px] transition-colors hover:opacity-80"
      style="color: var(--color-text-muted);"
      onclick={() => experimentalStore.resetToDefaults()}
    >
      <RefreshCw size={11} /> Reset to defaults
    </button>
    
    <div class="flex items-center gap-3 text-[9px]" style="color: var(--color-text-muted);">
      <span class="flex items-center gap-1">
        <span class="w-2 h-2 rounded-full" style="background: #22c55e;"></span> Stable
      </span>
      <span class="flex items-center gap-1">
        <span class="w-2 h-2 rounded-full" style="background: #f59e0b;"></span> Beta
      </span>
      <span class="flex items-center gap-1">
        <span class="w-2 h-2 rounded-full" style="background: #ef4444;"></span> Alpha
      </span>
      <span class="flex items-center gap-1">
        <span class="w-2 h-2 rounded-full" style="background: #6b7280;"></span> Soon
      </span>
    </div>
  </div>
</div>
