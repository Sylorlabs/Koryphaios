<script lang="ts">
  import X from 'lucide-svelte/icons/x';
  import Search from 'lucide-svelte/icons/search';
  import Check from 'lucide-svelte/icons/check';
  import { fade, scale } from 'svelte/transition';
  import type { ProviderName, ModelDef } from '@koryphaios/shared';
  import SettingsToggle from './SettingsToggle.svelte';

  interface Props {
    providerName: ProviderName;
    availableModels: ModelDef[];
    selectedModels: string[];
    emptyMessage?: string;
    onSave: (selected: string[], hideSelector: boolean) => void;
    onClose: () => void;
  }

  let {
    providerName,
    availableModels = [],
    selectedModels = [],
    emptyMessage,
    onSave,
    onClose,
  }: Props = $props();

  let searchQuery = $state('');
  let localSelected = $state<string[]>([]);
  let dontAskAgain = $state(false);
  let initialized = $state(false);

  // Snapshot the catalog once when it first arrives. After init, background
  // catalog refreshes must never rewrite the user's in-progress picks — that
  // made selections visibly reset (especially on large custom catalogs where
  // a live refresh can shift the list mid-session). Stale ids are filtered at
  // save/display time by the backend status, so keeping them locally is safe.
  $effect(() => {
    if (initialized) return;
    if ((availableModels || []).length === 0) return;
    const ids = new Set((availableModels || []).map((m) => m.id));
    localSelected =
      (selectedModels || []).length > 0
        ? (selectedModels || []).filter((id) => ids.has(id))
        : [...ids];
    initialized = true;
  });

  let filteredModels = $derived(
    (availableModels || [])
      .filter((m) => m != null && m.id != null)
      .filter((m) => {
        const id = (m.id ?? '').toLowerCase();
        const name = (m.name ?? '').toLowerCase();
        const q = searchQuery.toLowerCase();
        return id.includes(q) || name.includes(q);
      }),
  );
  // Membership checks run once per rendered row. A Set avoids an O(n²)
  // includes() sweep when Select All/None changes a large provider catalog.
  let selectedModelIds = $derived(new Set(localSelected));

  function toggleModel(id: string) {
    if (selectedModelIds.has(id)) {
      localSelected = localSelected.filter((m) => m !== id);
    } else {
      localSelected = [...localSelected, id];
    }
  }

  function selectAll() {
    const allIds = (availableModels || []).map((m) => m.id);
    if (localSelected.length !== allIds.length || allIds.some((id) => !selectedModelIds.has(id))) {
      localSelected = allIds;
    }
  }

  function selectNone() {
    if (localSelected.length > 0) localSelected = [];
  }

  function handleSave() {
    onSave(localSelected || [], dontAskAgain);
  }

  function skip() {
    onSave(
      (availableModels || []).map((m) => m.id),
      dontAskAgain,
    );
  }
</script>

<div
  class="fixed inset-0 z-[100] flex items-center justify-center p-4 bg-black/70 backdrop-blur-md"
  transition:fade={{ duration: 200 }}
>
  <div
    class="relative w-full max-w-lg max-h-[80vh] flex flex-col rounded-2xl shadow-2xl overflow-hidden border"
    style="background: var(--color-surface-1); border-color: var(--color-border-bright);"
    role="dialog"
    aria-modal="true"
    aria-labelledby="model-selection-title"
    transition:scale={{ duration: 200, start: 0.95 }}
  >
    <!-- Header -->
    <div
      class="px-6 py-4 border-b flex items-center justify-between"
      style="border-color: var(--color-border);"
    >
      <div>
        <h3
          id="model-selection-title"
          class="text-lg font-bold capitalize"
          style="color: var(--color-text-primary);"
        >
          {providerName} Models
        </h3>
        <p class="text-[11px]" style="color: var(--color-text-muted);">
          Select which models you want to enable for this provider.
        </p>
      </div>
      <button
        type="button"
        class="p-2 rounded-full hover:bg-[var(--color-surface-3)] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)]/60"
        onclick={onClose}
        aria-label="Close model selection"
      >
        <X size={20} />
      </button>
    </div>

    <!-- Search & Selection actions -->
    <div class="px-6 py-3 space-y-3 bg-[var(--color-surface-0)]">
      <div class="relative">
        <Search size={14} class="absolute left-3.5 top-1/2 -translate-y-1/2 opacity-40" />
        <input
          type="text"
          placeholder="Search models..."
          bind:value={searchQuery}
          class="input pl-10 h-10 text-sm"
          style="padding-left: 40px;"
        />
      </div>
      <div class="flex items-center justify-between">
        <div class="flex gap-3">
          <button
            class="text-[10px] uppercase tracking-wider font-bold hover:text-[var(--color-accent)] transition-colors"
            onclick={selectAll}>Select All</button
          >
          <button
            class="text-[10px] font-bold uppercase tracking-wider text-[var(--color-text-secondary)] transition-colors hover:text-[var(--color-accent)]"
            onclick={selectNone}>Select None</button
          >
        </div>
        <span class="text-[10px] font-medium" style="color: var(--color-text-muted);">
          {localSelected.length} of {(availableModels || []).length} selected
        </span>
      </div>
    </div>

    <!-- List -->
    <div class="flex-1 overflow-y-auto px-4 py-2 custom-scrollbar">
      <div class="space-y-1">
        {#if (availableModels || []).length === 0}
          <p
            class="px-3 py-8 text-center text-xs flex flex-col items-center gap-2"
            style="color: var(--color-text-muted);"
          >
            <span
              class="inline-block w-4 h-4 border-2 border-white/20 border-t-white/60 rounded-full animate-spin"
            ></span>
            Loading models...
          </p>
        {:else if filteredModels.length === 0}
          <p class="px-3 py-8 text-center text-xs" style="color: var(--color-text-muted);">
            {emptyMessage ?? 'No provider-reported models are available.'}
          </p>
        {:else}
          {#each filteredModels as model (model.id)}
            <button
              type="button"
              class="w-full flex items-center justify-between p-3 rounded-xl transition-all border
                   {selectedModelIds.has(model.id)
                ? 'bg-[var(--color-accent)]/5 border-[var(--color-accent)]/30'
                : 'bg-transparent border-transparent hover:bg-[var(--color-surface-2)]'}"
              onclick={() => toggleModel(model.id)}
            >
              <div class="flex items-center gap-3">
                <div
                  class="w-5 h-5 rounded-md border flex items-center justify-center transition-colors
                          {selectedModelIds.has(model.id)
                    ? 'bg-[var(--color-accent)] border-[var(--color-accent)]'
                    : 'border-white/10'}"
                >
                  {#if selectedModelIds.has(model.id)}
                    <Check size={14} class="text-white" />
                  {/if}
                </div>
                <div class="flex flex-col items-start">
                  <span
                    class="text-sm font-medium"
                    style="color: {selectedModelIds.has(model.id)
                      ? 'var(--color-text-primary)'
                      : 'var(--color-text-secondary)'};"
                  >
                    {model.name}
                  </span>
                  <span class="text-[10px] opacity-40">{model.id}</span>
                  {#if model.supportsFastMode || (model.reasoningLevels?.length ?? 0) > 0}
                    <!-- Capability chips mirror what Hoplite's own picker exposes:
                         a fast tier only where the model actually has one, and the
                         real reasoning ladder the provider reports. -->
                    <div class="mt-1 flex flex-wrap items-center gap-1 text-left">
                      {#if model.supportsFastMode}
                        <span
                          class="rounded-full border px-1.5 py-px text-[9px] font-bold uppercase tracking-wider"
                          style="border-color: var(--color-warning); color: var(--color-warning);"
                          title="Supports the fast tier. Lower latency at the same reasoning effort."
                          >Fast</span
                        >
                      {/if}
                      {#if (model.reasoningLevels?.length ?? 0) > 0}
                        <span
                          class="rounded-full border px-1.5 py-px text-[9px] font-medium leading-tight tracking-wide"
                          style="border-color: var(--color-border-bright); color: var(--color-text-muted);"
                          title="Reasoning effort levels: {model.reasoningLevels?.join(', ')}"
                          >Reasoning · {model.reasoningLevels?.join(' / ')}</span
                        >
                      {/if}
                    </div>
                  {/if}
                </div>
              </div>
            </button>
          {/each}
        {/if}
      </div>
    </div>

    <!-- Footer -->
    <div
      class="px-6 py-4 border-t bg-[var(--color-surface-0)] flex flex-col gap-4"
      style="border-color: var(--color-border);"
    >
      <div class="flex items-center justify-between gap-4">
        <div class="flex min-h-10 min-w-0 items-center gap-2 px-2">
          <SettingsToggle
            checked={dontAskAgain}
            label="Use this model selection by default"
            onchange={() => (dontAskAgain = !dontAskAgain)}
          />
          <span class="select-none text-xs text-[var(--color-text-muted)]"
            >Use this model selection by default</span
          >
        </div>

        <button
          type="button"
          class="text-xs font-semibold text-[var(--color-text-secondary)] transition-colors hover:text-[var(--color-text-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)]/60"
          onclick={skip}
        >
          Skip & Enable All
        </button>
      </div>

      <div class="flex gap-3">
        <button type="button" class="btn btn-secondary flex-1" onclick={onClose}>Cancel</button>
        <button
          type="button"
          class="btn btn-primary flex-1"
          onclick={handleSave}
          disabled={(localSelected || []).length === 0}
        >
          Done
        </button>
      </div>
    </div>
  </div>
</div>

<style>
  .custom-scrollbar::-webkit-scrollbar {
    width: 4px;
  }
  .custom-scrollbar::-webkit-scrollbar-thumb {
    background: var(--color-border);
    border-radius: 10px;
  }
</style>
