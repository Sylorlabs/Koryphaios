<script lang="ts">
  // Segmented Always light / Always dark / Adaptive control — the single
  // radiogroup shared by the theme editor and the quick theme picker.
  import { theme, type ThemeMode } from '$lib/stores/theme.svelte';
  import Sun from 'lucide-svelte/icons/sun';
  import Moon from 'lucide-svelte/icons/moon';
  import SunMoon from 'lucide-svelte/icons/sun-moon';

  let { compact = false }: { compact?: boolean } = $props();

  const options: Array<{ id: ThemeMode; label: string; icon: typeof Sun }> = [
    { id: 'light', label: 'Always light', icon: Sun },
    { id: 'dark', label: 'Always dark', icon: Moon },
    { id: 'system', label: 'Adaptive', icon: SunMoon },
  ];

  let group = $state<HTMLDivElement | null>(null);

  function handleKeydown(event: KeyboardEvent) {
    const dir =
      event.key === 'ArrowRight' || event.key === 'ArrowDown'
        ? 1
        : event.key === 'ArrowLeft' || event.key === 'ArrowUp'
          ? -1
          : 0;
    if (dir === 0) return;
    event.preventDefault();
    const index = options.findIndex((option) => option.id === theme.mode);
    const next = options[(index + dir + options.length) % options.length];
    theme.setMode(next.id);
    group?.querySelector<HTMLElement>(`[data-mode="${next.id}"]`)?.focus();
  }
</script>

<!-- svelte-ignore a11y_interactive_supports_focus (focus lives on the child radios via roving tabindex) -->
<div
  role="radiogroup"
  aria-label="Appearance mode"
  class="grid grid-cols-3 gap-1 rounded-xl bg-[var(--color-surface-1)] p-1"
  bind:this={group}
  onkeydown={handleKeydown}
>
  {#each options as option (option.id)}
    {@const selected = theme.mode === option.id}
    {@const Icon = option.icon}
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      tabindex={selected ? 0 : -1}
      data-mode={option.id}
      onclick={() => theme.setMode(option.id)}
      class="flex min-w-0 flex-col items-center justify-center gap-0.5 rounded-lg border transition-colors outline-none
             {compact ? 'px-2 py-1.5' : 'px-3 py-2'}
             {selected
        ? 'border-[var(--color-accent)] bg-[var(--color-surface-2)] text-[var(--color-text-primary)] shadow-sm'
        : 'border-transparent text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-2)]/60 hover:text-[var(--color-text-primary)]'}
             focus-visible:ring-2 focus-visible:ring-[var(--color-accent)]/60"
    >
      <span class="flex items-center gap-1.5">
        <Icon size={compact ? 12 : 14} class="shrink-0" />
        <span class="truncate {compact ? 'text-[11px]' : 'text-xs'} font-semibold"
          >{option.label}</span
        >
      </span>
    </button>
  {/each}
</div>
