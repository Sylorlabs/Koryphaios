<script lang="ts">
  import X from 'lucide-svelte/icons/x';
  import Search from 'lucide-svelte/icons/search';
  import Check from 'lucide-svelte/icons/check';
  import { fade, scale } from 'svelte/transition';
  import { onDestroy } from 'svelte';
  import type { ModelDef } from '@koryphaios/shared';
  import SettingsToggle from './SettingsToggle.svelte';
  import { portalToBody } from '$lib/utils/portal';

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
  let modelListRef = $state<HTMLDivElement>();
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

  function formatTokenCount(value: number): string {
    if (!Number.isFinite(value) || value <= 0) return '';
    if (value >= 1_000_000) return `${Math.round(value / 100_000) / 10}M`;
    if (value >= 1_000) return `${Math.round(value / 1_000)}K`;
    return String(value);
  }

  // Render only facts the provider actually reported. An unverified context
  // window is deliberately absent: showing a guessed number would look like a
  // real limit. The credit multiplier is not part of this line — it renders as
  // a badge beside the name, where it cannot be truncated away.
  function modelDetailLine(model: Pick<ModelDef, 'id' | 'name'> & Partial<ModelDef>): string {
    const parts: string[] = [];
    const rawId = model.apiModelId ?? model.id;
    if (rawId && rawId !== model.name) parts.push(rawId);
    if (model.contextVerified === true && typeof model.contextWindow === 'number') {
      const context = formatTokenCount(model.contextWindow);
      if (context) parts.push(`${context} context`);
    }
    if (typeof model.maxOutputTokens === 'number') {
      const output = formatTokenCount(model.maxOutputTokens);
      if (output) parts.push(`${output} output`);
    }
    if (model.contextWindowOptions && model.contextWindowOptions.length >= 2) {
      parts.push(`tiers ${model.contextWindowOptions.map(formatTokenCount).join('/')}`);
    }
    if (typeof model.contextWindowVendorDefault === 'number') {
      parts.push(`CLI default ${formatTokenCount(model.contextWindowVendorDefault)}`);
    }
    if (model.vision === true) parts.push('vision');
    if (model.canReason === true) parts.push('reasoning');
    // Vendor-reported quota factor. `1` is the baseline and adds no information.
    if (typeof model.quotaMultiplier === 'number' && model.quotaMultiplier !== 1) {
      parts.push(`${model.quotaMultiplier}× quota`);
    }
    return parts.join(' · ');
  }

  let filteredModels = $derived(
    (availableModels || [])
      .filter((m) => m != null && m.id != null)
      .filter((m) => {
        const id = (m.id ?? '').toLowerCase();
        const name = (m.name ?? '').toLowerCase();
        const apiId = (m.apiModelId ?? '').toLowerCase();
        const q = searchQuery.toLowerCase();
        return id.includes(q) || name.includes(q) || apiId.includes(q);
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
    // Provider configs use an empty selectedModels array to mean "all models".
    // Keep Done actionable when the user deselects the last row instead of
    // leaving them with a button that appears broken. Sharing mode has
    // different semantics and intentionally preserves an empty selection.
    const selected =
      mode === 'provider' && (localSelected || []).length === 0
        ? (availableModels || []).map((m) => m.id)
        : localSelected || [];
    onSave(selected, dontAskAgain);
  }

  function skip() {
    onSave(
      (availableModels || []).map((m) => m.id),
      dontAskAgain,
    );
  }

  // Keep wheel/touch overscroll inside the picker. In particular, Safari's
  // elastic scrolling can otherwise reveal the dialog surface after the last
  // model, making the list look as though it has an extra blank page.
  function clampModelListScroll() {
    const list = modelListRef;
    if (!list) return;
    const maxScrollTop = Math.max(0, list.scrollHeight - list.clientHeight);
    if (list.scrollTop < 0) list.scrollTop = 0;
    else if (list.scrollTop > maxScrollTop) list.scrollTop = maxScrollTop;
  }
</script>

<div
  use:portalToBody
  class="fixed inset-0 z-[var(--z-modal)] flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm"
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
        <span class="text-[11px] font-medium" style="color: var(--color-text-muted);">
          {#if hasSearch}
            {visibleSelectedCount} of {filteredModels.length} shown selected · {localSelected.length} total
          {:else}
            {localSelected.length} of {(availableModels || []).length} selected
          {/if}
        </span>
      </div>
    </div>

    <!-- List -->
    <div
      bind:this={modelListRef}
      data-testid="model-selection-list"
      class="model-selection-list min-h-0 flex-1 overflow-y-auto px-4 py-2 custom-scrollbar"
      onscroll={clampModelListScroll}
    >
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
                  <span class="flex min-w-0 items-center gap-2">
                    <span
                      class="truncate text-sm font-medium"
                      style="color: {selectedModelIds.has(model.id)
                        ? 'var(--color-text-primary)'
                        : 'var(--color-text-secondary)'};"
                    >
                      {model.name}
                    </span>
                    {#if model.creditsLabel}
                      <!-- The provider's own per-request credit multiplier
                           (e.g. 0.29x) or "free". Shown on every row so the
                           cost is visible before selecting, not only for the
                           duplicate names that carry a price suffix. -->
                      <span
                        data-testid="model-credit-badge"
                        class="shrink-0 rounded px-1.5 py-0.5 text-[11px] font-semibold tabular-nums"
                        style="background: var(--color-surface-3); color: var(--color-text-secondary);"
                      >
                        {model.creditsLabel}
                      </span>
                    {/if}
                  </span>
                  {#if modelDetailLine(model)}
                    <span
                      class="max-w-full truncate text-[11px] leading-tight"
                      style="color: var(--color-text-muted);"
                      aria-hidden="true"
                    >
                      {modelDetailLine(model)}
                    </span>
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
            label="Automatically show new models exposed by this provider by default"
            onchange={() => (dontAskAgain = !dontAskAgain)}
          />
          <span class="select-none text-xs text-[var(--color-text-muted)]"
            >Automatically show new models exposed by this provider by default</span
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
        >
          Done
        </button>
      </div>
    </div>
  </div>
</div>

<style>
  .model-selection-list {
    /* Do not chain at either edge or show the browser's elastic blank tail. */
    overscroll-behavior: none;
    scrollbar-gutter: stable;
  }

  .custom-scrollbar::-webkit-scrollbar {
    width: 4px;
  }
  .custom-scrollbar::-webkit-scrollbar-thumb {
    background: var(--color-border);
    border-radius: 10px;
  }
</style>
