<script lang="ts">
  import { ChevronDown, Check } from 'lucide-svelte';
  import { onMount } from 'svelte';

  export interface KorySelectOption { value: string; label: string; description?: string; disabled?: boolean }
  interface Props {
    value: string;
    options: KorySelectOption[];
    onchange: (value: string) => unknown | Promise<unknown>;
    label?: string;
    placeholder?: string;
    compact?: boolean;
    disabled?: boolean;
  }
  let { value, options, onchange, label = 'Select option', placeholder = 'Select…', compact = false, disabled = false }: Props = $props();
  let open = $state(false);
  let activeIndex = $state(0);
  let root = $state<HTMLDivElement>();
  const selected = $derived(options.find(option => option.value === value));

  function choose(option: KorySelectOption) {
    if (option.disabled) return;
    open = false;
    void onchange(option.value);
  }
  function handleKeydown(event: KeyboardEvent) {
    if (disabled || options.length === 0) return;
    if (event.key === 'Escape') { open = false; return; }
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      if (!open) { open = true; activeIndex = Math.max(0, options.findIndex(option => option.value === value)); }
      else if (options[activeIndex]) choose(options[activeIndex]);
      return;
    }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault(); open = true;
      const delta = event.key === 'ArrowDown' ? 1 : -1;
      let next = activeIndex;
      do { next = (next + delta + options.length) % options.length; } while (options[next]?.disabled && next !== activeIndex);
      activeIndex = next;
    }
  }
  onMount(() => {
    const close = (event: PointerEvent) => { if (!root?.contains(event.target as Node)) open = false; };
    window.addEventListener('pointerdown', close);
    return () => window.removeEventListener('pointerdown', close);
  });
</script>

<div class="relative w-full" bind:this={root}>
  <button type="button" {disabled} aria-label={label} aria-haspopup="listbox" aria-expanded={open} onkeydown={handleKeydown} onclick={() => !disabled && (open = !open)} class="flex w-full items-center justify-between gap-3 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-1)] text-left text-[var(--color-text-primary)] outline-none transition-all hover:border-[var(--color-accent)]/50 focus-visible:ring-2 focus-visible:ring-[var(--color-accent)]/40 disabled:opacity-50 {compact ? 'min-h-9 px-3 py-2 text-xs' : 'min-h-11 px-4 py-3 text-sm'}">
    <span class="min-w-0 flex-1 truncate">{selected?.label ?? placeholder}</span>
    <ChevronDown size={15} class="shrink-0 text-[var(--color-text-muted)] transition-transform {open ? 'rotate-180' : ''}" />
  </button>
  {#if open}
    <div role="listbox" aria-label={label} class="absolute z-[120] mt-2 max-h-72 w-full min-w-56 overflow-y-auto rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-2)] p-1.5 shadow-2xl shadow-black/40">
      {#each options as option, index (option.value)}
        <button type="button" role="option" aria-selected={option.value === value} disabled={option.disabled} onmouseenter={() => activeIndex = index} onclick={() => choose(option)} class="flex w-full items-start gap-3 rounded-lg px-3 py-2.5 text-left transition-colors disabled:opacity-40 {index === activeIndex ? 'bg-[var(--color-surface-3)]' : ''}">
          <span class="mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center text-[var(--color-accent)]">{#if option.value === value}<Check size={14} />{/if}</span>
          <span class="min-w-0"><span class="block truncate text-xs font-medium text-[var(--color-text-primary)]">{option.label}</span>{#if option.description}<span class="mt-0.5 block text-[10px] leading-relaxed text-[var(--color-text-muted)]">{option.description}</span>{/if}</span>
        </button>
      {/each}
    </div>
  {/if}
</div>
