<script module lang="ts">
  let nextKorySelectId = 0;
</script>

<script lang="ts">
  import ChevronDown from 'lucide-svelte/icons/chevron-down';
  import Check from 'lucide-svelte/icons/check';
  import { onMount, tick, type Snippet } from 'svelte';
  import { portalToBody } from '$lib/utils/portal';

  export interface KorySelectOption {
    value: string;
    label: string;
    description?: string;
    disabled?: boolean;
    provider?: string;
    /** Shown on the trigger instead of `label` when the toolbar collapses it. */
    shortLabel?: string;
  }
  interface Props {
    id?: string;
    value: string;
    options: KorySelectOption[];
    onchange: (value: string) => unknown | Promise<unknown>;
    label?: string;
    description?: string;
    placeholder?: string;
    compact?: boolean;
    dense?: boolean;
    flat?: boolean;
    searchable?: boolean;
    disabled?: boolean;
    allowCustom?: boolean;
    customLabel?: string;
    customPlaceholder?: string;
    leading?: Snippet<[KorySelectOption | undefined]>;
  }
  let {
    id,
    value,
    options,
    onchange,
    label = 'Select option',
    description,
    placeholder = 'Select…',
    compact = false,
    dense = false,
    flat = false,
    searchable = false,
    disabled = false,
    allowCustom = false,
    customLabel = 'Custom',
    customPlaceholder = 'Type your own response…',
    leading,
  }: Props = $props();
  let open = $state(false);
  let activeIndex = $state(0);
  let customMode = $state(false);
  let customValue = $state('');
  let root = $state<HTMLDivElement>();
  let triggerEl = $state<HTMLButtonElement>();
  let menuEl = $state<HTMLDivElement>();
  let menuStyle = $state('');
  let query = $state('');
  const listboxId = `kory-select-${++nextKorySelectId}`;
  const selected = $derived(options.find((option) => option.value === value));
  const triggerShortLabel = $derived(selected?.shortLabel);
  const visibleOptions = $derived(
    searchable && query.trim()
      ? options.filter((option) =>
          `${option.label} ${option.value}`.toLowerCase().includes(query.trim().toLowerCase()),
        )
      : options,
  );

  function updatePosition() {
    if (!triggerEl || !menuEl) return;
    const rect = triggerEl.getBoundingClientRect();
    const gap = 8;
    const maxH = 288;
    const width = Math.max(rect.width, 224);
    let left = rect.left;
    const vw = window.innerWidth;
    if (left + width > vw - 8) left = Math.max(8, vw - width - 8);
    const menuHeight = Math.min(maxH, menuEl.scrollHeight || maxH);
    const spaceBelow = window.innerHeight - rect.bottom - gap;
    const spaceAbove = rect.top - gap;
    const flip = spaceBelow < menuHeight && spaceAbove > spaceBelow;
    const top = flip
      ? Math.max(8, rect.top - menuHeight - gap)
      : Math.min(rect.bottom + gap, Math.max(8, window.innerHeight - menuHeight - 8));
    menuStyle = `position:fixed;left:${left}px;top:${top}px;width:${width}px;`;
  }

  function selectedIndex() {
    const index = visibleOptions.findIndex((option) => option.value === value && !option.disabled);
    return index >= 0
      ? index
      : Math.max(
          0,
          visibleOptions.findIndex((option) => !option.disabled),
        );
  }

  function toggleOpen() {
    if (disabled) return;
    open = !open;
    if (open) {
      query = '';
      activeIndex = selectedIndex();
      void tick().then(() => {
        updatePosition();
        if (searchable) menuEl?.querySelector<HTMLInputElement>('[data-select-search]')?.focus();
      });
    }
  }

  function choose(option: KorySelectOption) {
    if (option.disabled) return;
    open = false;
    customMode = false;
    void onchange(option.value);
    triggerEl?.focus();
  }
  function showCustomInput() {
    customMode = true;
    customValue = '';
  }
  function submitCustom() {
    const next = customValue.trim();
    if (!next) return;
    open = false;
    customMode = false;
    customValue = '';
    void onchange(next);
  }
  function handleKeydown(event: KeyboardEvent) {
    if (disabled) return;
    if (event.key === 'Escape') {
      if (!open) return;
      event.preventDefault();
      event.stopPropagation();
      open = false;
      triggerEl?.focus();
      return;
    }
    if (visibleOptions.length === 0) return;
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      if (!open) {
        open = true;
        activeIndex = selectedIndex();
        void tick().then(updatePosition);
      } else if (visibleOptions[activeIndex]) choose(visibleOptions[activeIndex]);
      return;
    }
    if (event.key === 'Home' || event.key === 'End') {
      event.preventDefault();
      open = true;
      void tick().then(updatePosition);
      const available = visibleOptions
        .map((option, index) => ({ option, index }))
        .filter(({ option }) => !option.disabled);
      activeIndex = (event.key === 'Home' ? available[0] : available.at(-1))?.index ?? 0;
      return;
    }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      open = true;
      void tick().then(updatePosition);
      const delta = event.key === 'ArrowDown' ? 1 : -1;
      let next = activeIndex;
      do {
        next = (next + delta + visibleOptions.length) % visibleOptions.length;
      } while (visibleOptions[next]?.disabled && next !== activeIndex);
      activeIndex = next;
    }
  }
  onMount(() => {
    const close = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!root?.contains(target) && !menuEl?.contains(target)) open = false;
    };
    const onReposition = () => {
      if (open) updatePosition();
    };
    window.addEventListener('pointerdown', close);
    window.addEventListener('scroll', onReposition, true);
    window.addEventListener('resize', onReposition);
    return () => {
      window.removeEventListener('pointerdown', close);
      window.removeEventListener('scroll', onReposition, true);
      window.removeEventListener('resize', onReposition);
    };
  });

  $effect(() => {
    if (open) void tick().then(updatePosition);
  });
</script>

<div class="relative w-full" bind:this={root}>
  <button
    bind:this={triggerEl}
    {id}
    type="button"
    role="combobox"
    {disabled}
    aria-label={label}
    aria-haspopup="listbox"
    aria-expanded={open}
    aria-controls={open ? listboxId : undefined}
    aria-describedby={description ? `${listboxId}-description` : undefined}
    aria-activedescendant={open && visibleOptions[activeIndex]
      ? `${listboxId}-option-${activeIndex}`
      : undefined}
    title={triggerShortLabel ? selected?.label : undefined}
    onkeydown={handleKeydown}
    onclick={toggleOpen}
    class="flex w-full items-center justify-between gap-3 border {flat ? 'border-transparent bg-transparent hover:bg-[var(--color-surface-3)]' : 'border-[var(--color-border)] bg-[var(--color-surface-1)] hover:border-[var(--color-accent)]/50'} text-left text-[var(--color-text-primary)] outline-none transition-all focus-visible:ring-2 focus-visible:ring-[var(--color-accent)]/60 focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--color-surface-1)] disabled:opacity-50 {dense
      ? 'rounded min-h-7 px-2 py-1 text-xs'
      : compact
        ? 'rounded-lg'
        : 'rounded-xl'} {!dense && compact
      ? 'min-h-9 px-3 py-2 text-xs'
      : !dense
        ? 'min-h-11 px-4 py-3 text-sm'
        : ''}"
  >
    <span class="flex min-w-0 flex-1 items-center gap-2">
      {@render leading?.(selected)}
      {#if triggerShortLabel}
        <span class="min-w-0 truncate"
          ><span class="kory-select-label-full">{selected?.label}</span><span
            class="kory-select-label-short">{triggerShortLabel}</span
          ></span
        >
      {:else}
        <span class="min-w-0 truncate">{selected?.label ?? (allowCustom && value ? value : placeholder)}</span>
      {/if}
    </span>
    <ChevronDown
      size={15}
      class="kory-select-chevron shrink-0 text-[var(--color-text-muted)] transition-transform {open
        ? 'rotate-180'
        : ''}"
    />
  </button>
  {#if description}
    <p
      id={`${listboxId}-description`}
      class="mt-1.5 text-xs leading-relaxed text-[var(--color-text-muted)]"
    >
      {description}
    </p>
  {/if}
  {#if open}
    <div
      bind:this={menuEl}
      use:portalToBody
      id={listboxId}
      role="listbox"
      aria-label={label}
      style={menuStyle}
       class="fixed z-[var(--z-popover)] max-h-72 min-w-56 overflow-y-auto border border-[var(--color-border)] bg-[var(--color-surface-2)] {dense
        ? 'rounded p-1 shadow-lg'
        : 'rounded-xl p-1.5 shadow-2xl shadow-black/40'}"
    >
      {#if searchable}
        <div class="sticky top-0 bg-[var(--color-surface-2)] p-1">
          <input
            data-select-search
            aria-label={`Search ${label}`}
            placeholder="Search…"
            bind:value={query}
            oninput={() => (activeIndex = 0)}
            onkeydown={(event) => {
              if (['ArrowDown', 'ArrowUp', 'Enter', 'Escape'].includes(event.key))
                handleKeydown(event);
            }}
            class="w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-1)] px-2 py-1.5 text-xs text-[var(--color-text-primary)] outline-none focus:border-[var(--color-accent)]"
          />
        </div>
        {#if !visibleOptions.length}<p class="px-2 py-2 text-xs text-[var(--color-text-muted)]">
            No matches
          </p>{/if}
      {/if}
      {#each visibleOptions as option, index (option.value)}
        <button
          id={`${listboxId}-option-${index}`}
          type="button"
          role="option"
          tabindex="-1"
          aria-selected={option.value === value}
          disabled={option.disabled}
          onmouseenter={() => (activeIndex = index)}
          onclick={() => choose(option)}
          class="flex w-full items-start gap-3 text-left transition-colors disabled:opacity-40 {dense
            ? 'rounded-sm px-2 py-1.5'
            : 'rounded-lg px-3 py-2.5'} {index === activeIndex
            ? 'bg-[var(--color-surface-3)]'
            : ''}"
        >
          {@render leading?.(option)}
          <span
            class="mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center text-[var(--color-accent)]"
            >{#if option.value === value}<Check size={14} />{/if}</span
          >
          <span class="min-w-0"
            ><span class="block truncate text-xs font-medium text-[var(--color-text-primary)]"
              >{option.label}</span
            >{#if option.description}<span
                class="mt-0.5 block text-[11px] leading-relaxed text-[var(--color-text-muted)]"
                >{option.description}</span
              >{/if}</span
          >
        </button>
      {/each}
      {#if allowCustom}
        <div class="mt-1 border-t border-[var(--color-border)] pt-1">
          {#if customMode}
            <div class="flex gap-1.5 p-1">
              <input
                bind:value={customValue}
                aria-label={customPlaceholder}
                placeholder={customPlaceholder}
                onkeydown={(event) => {
                  if (event.key === 'Enter') {
                    event.preventDefault();
                    submitCustom();
                  } else if (event.key === 'Escape') {
                    event.preventDefault();
                    customMode = false;
                  }
                }}
                class="min-w-0 flex-1 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-1)] px-2.5 py-2 text-xs text-[var(--color-text-primary)] outline-none focus:border-[var(--color-accent)]"
              />
              <button
                type="button"
                disabled={!customValue.trim()}
                onclick={submitCustom}
                class="rounded-lg bg-[var(--color-accent)] px-2.5 py-2 text-xs font-medium text-[var(--color-on-accent)] disabled:opacity-40"
                >Add</button
              >
            </div>
          {:else}
            <button
              type="button"
              onclick={showCustomInput}
              class="w-full rounded-lg px-3 py-2.5 text-left text-xs font-medium text-[var(--color-accent)] transition-colors hover:bg-[var(--color-surface-3)]"
              >{customLabel}…</button
            >
          {/if}
        </div>
      {/if}
    </div>
  {/if}
</div>

<style>
  /* Hidden until a toolbar collapses the trigger label (CommandInput sets it). */
  .kory-select-label-short {
    display: none;
  }
</style>
