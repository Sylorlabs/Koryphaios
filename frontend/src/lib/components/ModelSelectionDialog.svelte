<script lang="ts">
  import X from 'lucide-svelte/icons/x';
  import Search from 'lucide-svelte/icons/search';
  import Check from 'lucide-svelte/icons/check';
  import { fade, scale } from 'svelte/transition';
  import { onDestroy } from 'svelte';
  import type { ModelDef } from '@koryphaios/shared';
  import SettingsToggle from './SettingsToggle.svelte';

  interface Props {
    providerName: string;
    availableModels: (Pick<ModelDef, 'id' | 'name'> & Partial<ModelDef>)[];
    selectedModels: string[];
    mode?: 'provider' | 'sharing';
    emptyMessage?: string;
    onSave: (selected: string[], hideSelector: boolean) => void;
    onClose: () => void;
  }

  let {
    providerName,
    availableModels = [],
    selectedModels = [],
    mode = 'provider',
    emptyMessage,
    onSave,
    onClose,
  }: Props = $props();

  let searchQuery = $state('');
  let localSelected = $state<string[]>([]);
  let dontAskAgain = $state(false);
  let initialized = $state(false);
  let dialogRef = $state<HTMLDivElement>();
  const previouslyFocused = typeof document === 'undefined' ? null : document.activeElement as HTMLElement | null;
  onDestroy(() => {
    if (previouslyFocused?.isConnected) previouslyFocused.focus();
  });
  $effect(() => {
    dialogRef?.querySelector<HTMLInputElement>('input')?.focus();
  });

  function handleKeydown(event: KeyboardEvent) {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      onClose();
      return;
    }
    if (event.key !== 'Tab' || !dialogRef) return;
    const controls = [...dialogRef.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled])')];
    const first = controls[0];
    const last = controls[controls.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last?.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first?.focus();
    }
  }

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
      mode === 'sharing' || (selectedModels || []).length > 0
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

  let hasSearch = $derived(searchQuery.trim().length > 0);
  let visibleSelectedCount = $derived(
    filteredModels.reduce((count, m) => (selectedModelIds.has(m.id) ? count + 1 : count), 0),
  );

  // Select All / Select None always act on what the list is showing. With an
  // active search that means only the matching rows change, so narrowing a
  // query can't silently drop (or enable) models the user never looked at.
  // Rows are walked in catalog order so the saved selection stays stable.
  function selectAll() {
    const visibleIds = new Set(filteredModels.map((m) => m.id));
    const next: string[] = [];
    for (const m of availableModels || []) {
      if (visibleIds.has(m.id) || selectedModelIds.has(m.id)) next.push(m.id);
    }
    localSelected = next;
  }

  function selectNone() {
    if (localSelected.length === 0) return;
    const visibleIds = new Set(filteredModels.map((m) => m.id));
    localSelected = localSelected.filter((id) => !visibleIds.has(id));
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
  class="fixed inset-0 z-[130] flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm"
  role="presentation"
  onmousedown={(event) => { if (event.target === event.currentTarget) onClose(); }}
  transition:fade={{ duration: 200 }}
>
  <div
    bind:this={dialogRef}
    onkeydown={handleKeydown}
    tabindex="-1"
    class="relative w-full max-w-lg max-h-[80vh] flex flex-col rounded-xl shadow-2xl overflow-hidden border"
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
          {mode === 'sharing' ? 'Only selected models are advertised to guests and accepted by the host.' : 'Select which models you want to enable for this provider.'}
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
          aria-label="Search models"
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
          {#if hasSearch}
            {visibleSelectedCount} of {filteredModels.length} shown selected · {localSelected.length} total
          {:else}
            {localSelected.length} of {(availableModels || []).length} selected
          {/if}
        </span>
      </div>
    </div>

    <!-- List -->
    <div class="min-h-0 flex-1 overflow-y-auto px-4 py-2 custom-scrollbar">
      <div>
        {#if (availableModels || []).length === 0}
          <p
            class="px-3 py-8 text-center text-xs flex flex-col items-center gap-2"
            style="color: var(--color-text-muted);"
          >
            <span
              class="inline-block w-4 h-4 border-2 border-[var(--color-border)] border-t-[var(--color-text-secondary)] rounded-full animate-spin"
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
              role="checkbox"
              aria-checked={selectedModelIds.has(model.id)}
              aria-label={model.name}
              class="w-full flex items-center justify-between px-3 py-2.5 rounded-md transition-colors border border-transparent bg-transparent hover:border-[var(--color-border-bright)] hover:bg-[var(--color-surface-2)] focus-visible:outline-none focus-visible:border-[var(--color-accent)]"
              onclick={() => toggleModel(model.id)}
            >
              <div class="flex min-w-0 items-center gap-3">
                <div
                  class="w-5 h-5 shrink-0 rounded border flex items-center justify-center transition-colors
                          {selectedModelIds.has(model.id)
                    ? 'bg-[var(--color-accent)] border-[var(--color-accent)]'
                    : 'border-[var(--color-border-bright)] bg-[var(--color-surface-0)]'}"
                  aria-hidden="true"
                >
                  {#if selectedModelIds.has(model.id)}
                    <Check size={14} class="text-[var(--color-on-accent)]" />
                  {/if}
                </div>
                <div class="flex min-w-0 flex-col items-start text-left">
                  <span
                    class="text-sm font-medium"
                    style="color: {selectedModelIds.has(model.id)
                      ? 'var(--color-text-primary)'
                      : 'var(--color-text-secondary)'};"
                  >
                    {model.name}
                  </span>
                  <span class="max-w-full break-all text-[10px] text-[var(--color-text-muted)]">{model.id}</span>
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
      {#if mode === 'provider'}
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
      {:else}
        <p class="text-xs text-[var(--color-text-muted)]">Changes apply when you save shared providers.</p>
      {/if}

      <div class="flex gap-3">
        <button type="button" class="btn btn-secondary flex-1" onclick={onClose}>Cancel</button>
        <button
          type="button"
          class="btn btn-primary flex-1"
          onclick={handleSave}
          disabled={mode === 'provider' && (localSelected || []).length === 0}
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
