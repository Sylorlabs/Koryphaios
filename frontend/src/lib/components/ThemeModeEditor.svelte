<script lang="ts">
  // Per-scheme theme editor: one card for Light mode and one for Dark mode,
  // each with its own preset + accents, under a shared mode switch. Editing a
  // card for the inactive scheme never flips the mode.
  import { theme, type ThemeScheme } from '$lib/stores/theme.svelte';
  import type { ConcreteThemePreset } from '$lib/theme-palette';
  import ThemeModeSwitcher from './ThemeModeSwitcher.svelte';
  import ThemePreview from './ThemePreview.svelte';
  import Sun from 'lucide-svelte/icons/sun';
  import Moon from 'lucide-svelte/icons/moon';
  import Check from 'lucide-svelte/icons/check';

  let {
    compact = false,
    onChooseAccent,
  }: {
    compact?: boolean;
    onChooseAccent: (scheme: ThemeScheme, which: 'primary' | 'secondary') => void;
  } = $props();

  const schemes: Array<{ scheme: ThemeScheme; title: string; icon: typeof Sun }> = [
    { scheme: 'light', title: 'Light mode', icon: Sun },
    { scheme: 'dark', title: 'Dark mode', icon: Moon },
  ];

  const ACCENT_ROWS = ['primary', 'secondary'] as const;

  function slotStatus(scheme: ThemeScheme): { inUse: boolean; note: string | null } {
    if (theme.activeScheme === scheme) return { inUse: true, note: null };
    if (theme.mode === 'system') {
      return { inUse: false, note: `Used when your system is ${scheme}` };
    }
    return { inUse: false, note: `Not used while Always ${theme.mode}` };
  }

  function presetSwatch(preset: ConcreteThemePreset): {
    bg: string;
    panel: string;
    text: string;
  } {
    const palette = theme.paletteFor(preset) ?? {};
    return {
      bg: palette['--color-surface-1'] ?? '#000',
      panel: palette['--color-surface-3'] ?? '#000',
      text: palette['--color-text-primary'] ?? '#fff',
    };
  }
</script>

<div class="space-y-5">
  <ThemeModeSwitcher {compact} />

  <!-- Each scheme is a plain column: the preview is the only framed surface,
       so no bordered box sits inside another. -->
  <div class="grid grid-cols-1 gap-x-8 gap-y-6 sm:grid-cols-2">
    {#each schemes as entry (entry.scheme)}
      {@const slot = theme.modeAppearance(entry.scheme)}
      {@const status = slotStatus(entry.scheme)}
      {@const Icon = entry.icon}
      {@const palette = theme.paletteFor(slot.preset)}
      <section class="flex min-w-0 flex-col gap-3" aria-label="{entry.title} theme">
        <div class="flex items-center justify-between gap-2">
          <span
            class="flex items-center gap-1.5 text-xs font-bold text-[var(--color-text-primary)]"
          >
            <Icon size={13} class="text-[var(--color-text-secondary)]" />
            {entry.title}
          </span>
          {#if status.inUse}
            <span
              class="rounded-full bg-[var(--color-accent)]/15 px-2 py-0.5 text-[11px] font-semibold text-[var(--color-accent)]"
              >In use</span
            >
          {:else if status.note}
            <span class="text-[11px] text-[var(--color-text-muted)]">{status.note}</span>
          {/if}
        </div>

        {#if palette}
          <ThemePreview
            {palette}
            accent={theme.accentFor(entry.scheme, 'primary').main}
            secondary={theme.accentFor(entry.scheme, 'secondary').main}
            label="{entry.title} preview"
            size={compact ? 'sm' : 'md'}
          />
        {/if}

        <div>
          <div class="mb-1.5 flex items-baseline justify-between gap-2">
            <span class="text-[10px] font-bold uppercase tracking-wider text-[var(--color-text-muted)]"
              >Theme</span
            >
            <span class="text-[11px] font-medium text-[var(--color-text-secondary)]"
              >{theme.presetsFor(entry.scheme).find((p) => p.id === slot.preset)?.label}</span
            >
          </div>
          <div class="grid grid-cols-4 gap-1.5">
            {#each theme.presetsFor(entry.scheme) as option (option.id)}
              {@const swatch = presetSwatch(option.id)}
              {@const selected = slot.preset === option.id}
              <button
                type="button"
                aria-pressed={selected}
                aria-label={option.label}
                title={option.label}
                onclick={() => theme.setModePreset(entry.scheme, option.id)}
                class="relative flex h-7 min-w-0 items-stretch gap-px overflow-hidden rounded-md border outline-none transition-all
                       {selected
                  ? 'border-[var(--color-accent)] ring-1 ring-[var(--color-accent)]/60'
                  : 'border-[var(--color-border)] hover:border-[var(--color-text-muted)]'}
                       focus-visible:ring-2 focus-visible:ring-[var(--color-accent)]/60"
              >
                <span class="h-full flex-1" style="background: {swatch.bg};" aria-hidden="true"
                ></span>
                <span
                  class="h-full w-2.5"
                  style="background: {swatch.panel};"
                  aria-hidden="true"
                ></span>
                <span
                  class="h-full w-1"
                  style="background: {swatch.text};"
                  aria-hidden="true"
                ></span>
                {#if selected}
                  <span
                    class="absolute inset-0 flex items-center justify-center"
                    aria-hidden="true"
                  >
                    <Check size={11} strokeWidth={3} style="color: {swatch.text};" />
                  </span>
                {/if}
              </button>
            {/each}
          </div>
        </div>

        <div class="border-t border-[var(--color-border)]">
          {#each ACCENT_ROWS as which (which)}
            {@const accent = theme.accentFor(entry.scheme, which)}
            <button
              type="button"
              onclick={() => onChooseAccent(entry.scheme, which)}
              class="group flex w-full items-center gap-3 {which === 'secondary'
                ? 'border-t border-[var(--color-border)]'
                : ''} py-2 text-left outline-none transition-colors hover:bg-[var(--color-surface-2)]/55 focus-visible:bg-[var(--color-surface-2)]/55"
              aria-label="Edit {entry.title.toLowerCase()} {which} accent"
            >
              <span
                class="ml-1 h-6 w-6 shrink-0 rounded-md border border-[var(--color-border-bright)] shadow-inner"
                style="background: {accent.main};"
                aria-hidden="true"
              ></span>
              <span class="min-w-0 flex-1">
                <span class="block text-xs font-semibold text-[var(--color-text-primary)]"
                  >{which === 'primary' ? 'Primary' : 'Secondary'} accent</span
                >
              </span>
              <span class="font-mono text-[11px] text-[var(--color-text-secondary)]"
                >{accent.main.toUpperCase()}</span
              >
              <span class="mr-1 text-[11px] font-medium text-[var(--color-accent)]">Choose</span>
            </button>
          {/each}
        </div>
      </section>
    {/each}
  </div>
</div>
