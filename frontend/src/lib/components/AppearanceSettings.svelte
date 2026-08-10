<script lang="ts">
  // Appearance settings tab — extracted from SettingsDrawer.svelte.
  // Self-contained: depends only on the `theme` store and a bindable
  // showColorPicker flag shared with the drawer-level ColorPickerModal.
  import Palette from 'lucide-svelte/icons/palette';
  import Zap from 'lucide-svelte/icons/zap';
  import Type from 'lucide-svelte/icons/type';
  import Check from 'lucide-svelte/icons/check';
  import Plus from 'lucide-svelte/icons/plus';
  import RotateCcw from 'lucide-svelte/icons/rotate-ccw';
  import {
    theme,
    type ThemePreset,
    type AccentColor,
    type FontFamily,
  } from '$lib/stores/theme.svelte';

  let { showColorPicker = $bindable(false) }: { showColorPicker?: boolean } = $props();

  const fontCategories = $derived([...new Set(theme.fonts.map((f) => f.category))]);
  const usesDefaults = $derived(
    theme.preset === 'kintsugi' && theme.accent === 'gold' && theme.font === 'inter',
  );
</script>

<div class="flex-1 overflow-y-auto px-6 py-5 space-y-10 w-full max-w-7xl mx-auto">
  <div
    class="flex items-center justify-between gap-4 rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface-1)] p-4"
  >
    <div>
      <div class="text-sm font-semibold text-[var(--color-text-primary)]">Device appearance</div>
      <p class="mt-1 text-xs text-[var(--color-text-muted)]">
        Changes apply immediately and are saved only on this device.
      </p>
    </div>
    <button
      type="button"
      disabled={usesDefaults}
      onclick={() => theme.reset()}
      class="flex min-h-10 shrink-0 items-center gap-2 rounded-xl border border-[var(--color-border)] px-3 text-xs text-[var(--color-text-secondary)] transition-colors hover:border-[var(--color-accent)]/50 hover:text-[var(--color-text-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)]/60 disabled:cursor-not-allowed disabled:opacity-40"
    >
      <RotateCcw size={14} /> Restore defaults
    </button>
  </div>
  <section>
    <div class="flex items-center gap-3 mb-6">
      <Palette size={20} class="text-[var(--color-accent)]" />
      <div>
        <h3 class="text-base font-bold text-[var(--color-text-primary)]">Theme Presets</h3>
        <p class="text-xs text-[var(--color-text-muted)]">
          Select your preferred application color scheme
        </p>
      </div>
    </div>
    <div class="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-5 gap-4">
      <!-- Static per-theme preview colors so each card shows its actual palette -->
      {#each theme.presets as t (t.id)}
        {@const previewColors: Record<string, { bg: string; s1: string; s2: string; border: string; accent: string }> = {
          kintsugi:    { bg: '#0D0B0A', s1: '#141210', s2: '#1C1917', border: 'rgba(213, 178, 97, 0.16)', accent: '#D5B261' },
          midnight:    { bg: '#0a0a0b', s1: '#111113', s2: '#1a1a1e', border: '#2a2a30', accent: '#6366f1' },
          nord:        { bg: '#2e3440', s1: '#3b4252', s2: '#434c5e', border: '#4c566a', accent: '#81a1c1' },
          dracula:     { bg: '#1e1f29', s1: '#282a36', s2: '#2d303e', border: '#44475a', accent: '#ff79c6' },
          catppuccin:  { bg: '#1e1e2e', s1: '#24243a', s2: '#2a2a42', border: '#3a3a52', accent: '#cba6f7' },
          gruvbox:     { bg: '#1d2021', s1: '#282828', s2: '#32302f', border: '#504945', accent: '#fabd2f' },
          tokyo:       { bg: '#1a1b26', s1: '#1f2335', s2: '#24283b', border: '#343b58', accent: '#7aa2f7' },
          solarized:   { bg: '#002b36', s1: '#073642', s2: '#0b3f4a', border: '#1a5563', accent: '#268bd2' },
          light:       { bg: '#ffffff', s1: '#f8f9fa', s2: '#f1f3f5', border: '#dee2e6', accent: '#2563eb' },
          system:      { bg: '#f8f9fa', s1: '#141210', s2: '#262220', border: '#dee2e6', accent: '#D5B261' },
        }}
        {@const colors = previewColors[t.id] ?? previewColors.kintsugi}
        <button
          type="button"
          class="group relative flex flex-col gap-3 p-3 rounded-xl border transition-all
                 {theme.preset === t.id
            ? 'border-[var(--color-accent)] bg-[var(--color-surface-2)] shadow-lg'
            : 'border-[var(--color-border)] bg-[var(--color-surface-1)] hover:border-[var(--color-text-muted)]'}"
          onclick={() => theme.setPreset(t.id as ThemePreset)}
        >
          <div
            class="w-full h-20 rounded-lg flex overflow-hidden shadow-inner border border-black/20"
            style="background: {colors.bg};"
          >
            <!-- Mini Sidebar -->
            <div
              class="w-1/4 h-full border-r border-black/20 p-1.5 flex flex-col gap-1.5"
              style="background: {colors.s1}; border-color: {colors.border};"
            >
              <div
                class="w-full h-1.5 rounded-sm opacity-60"
                style="background: {colors.s2};"
              ></div>
              <div class="w-2/3 h-1.5 rounded-sm opacity-60" style="background: {colors.s2};"></div>
              <div class="w-3/4 h-1.5 rounded-sm opacity-60" style="background: {colors.s2};"></div>
            </div>
            <!-- Mini Main Content -->
            <div class="flex-1 flex flex-col">
              <!-- Header -->
              <div
                class="h-4 w-full flex items-center px-2 border-b border-black/20"
                style="background: {colors.bg}; border-color: {colors.border};"
              >
                <div class="w-4 h-1 rounded-full" style="background: {colors.accent};"></div>
              </div>
              <!-- Chat Area -->
              <div
                class="flex-1 p-2 flex flex-col gap-1.5 justify-end"
                style="background: {colors.bg};"
              >
                <!-- User bubble -->
                <div
                  class="self-end w-3/4 rounded shrink-0 p-1 shadow-sm"
                  style="background: {colors.accent};"
                >
                  <div class="h-[3px] w-full bg-white/40 rounded-full"></div>
                </div>
                <!-- Assistant bubble -->
                <div
                  class="self-start w-5/6 rounded shrink-0 border border-black/10 p-1"
                  style="background: {colors.s1}; border-color: {colors.border};"
                >
                  <div
                    class="h-[3px] w-full opacity-50 mb-0.5 rounded-full"
                    style="background: {colors.s2};"
                  ></div>
                  <div
                    class="h-[3px] w-2/3 opacity-50 rounded-full"
                    style="background: {colors.s2};"
                  ></div>
                </div>
              </div>
            </div>
          </div>
          <span
            class="text-xs font-semibold capitalize transition-colors {theme.preset === t.id
              ? 'text-[var(--color-accent)]'
              : 'text-[var(--color-text-secondary)]'}">{t.label}</span
          >
          {#if theme.preset === t.id}
            <div
              class="absolute -top-1 -right-1 w-5 h-5 bg-[var(--color-accent)] rounded-full flex items-center justify-center text-[var(--color-surface-0)] shadow-md"
            >
              <Check size={12} strokeWidth={3} />
            </div>
          {/if}
        </button>
      {/each}
    </div>
  </section>

  <section>
    <div class="flex items-center gap-3 mb-6">
      <Zap size={20} class="text-[var(--color-accent)]" />
      <div>
        <h3 class="text-base font-bold text-[var(--color-text-primary)]">Accent Color</h3>
        <p class="text-xs text-[var(--color-text-muted)]">
          Customize the primary interaction color
        </p>
      </div>
    </div>
    <div
      class="flex flex-wrap gap-4 p-4 rounded-2xl bg-[var(--color-surface-2)] border border-[var(--color-border)]"
    >
      {#each theme.accents as color (color.id)}
        <button
          type="button"
          class="group relative w-12 h-12 rounded-xl transition-all hover:scale-110 active:scale-95 shadow-md
                 {theme.accent === color.id
            ? 'ring-2 ring-[var(--color-text-primary)] ring-offset-4 ring-offset-[var(--color-surface-2)]'
            : 'opacity-80 hover:opacity-100'}"
          style="background-color: {color.color};"
          onclick={() => theme.setAccent(color.id as AccentColor)}
          title={color.label}
        >
          {#if theme.accent === color.id}
            <Check size={20} class="mx-auto text-white drop-shadow-md" strokeWidth={3} />
          {/if}
        </button>
      {/each}
      <!-- Custom accent swatch (only shown when a custom color is active) -->
      {#if theme.accent === 'custom' && theme.customAccent}
        <button
          type="button"
          class="group relative w-12 h-12 rounded-xl transition-all hover:scale-110 active:scale-95 shadow-md ring-2 ring-[var(--color-text-primary)] ring-offset-4 ring-offset-[var(--color-surface-2)]"
          style="background-color: {theme.customAccent.main};"
          onclick={() => (showColorPicker = true)}
          title="Custom color — click to edit"
        >
          <Check size={20} class="mx-auto text-white drop-shadow-md" strokeWidth={3} />
        </button>
      {/if}
      <!-- + button to open the custom color picker -->
      <button
        type="button"
        class="group relative w-12 h-12 rounded-xl transition-all hover:scale-110 active:scale-95 shadow-md border-2 border-dashed flex items-center justify-center
               {theme.accent === 'custom'
          ? 'border-[var(--color-text-primary)]'
          : 'border-[var(--color-text-muted)] hover:border-[var(--color-text-secondary)]'}"
        style="background: var(--color-surface-3);"
        onclick={() => (showColorPicker = true)}
        title="Custom color picker"
        aria-label="Open custom color picker"
      >
        <Plus
          size={20}
          class="text-[var(--color-text-secondary)] group-hover:text-[var(--color-text-primary)]"
        />
      </button>
    </div>
  </section>

  <section>
    <div class="flex items-center gap-3 mb-6">
      <Type size={20} class="text-[var(--color-accent)]" />
      <div>
        <h3 class="text-base font-bold text-[var(--color-text-primary)]">Typography</h3>
        <p class="text-xs text-[var(--color-text-muted)]">
          Choose the font family for the interface
        </p>
      </div>
    </div>
    {#each fontCategories as category (category)}
      <div class="mb-6">
        <p
          class="text-[10px] font-bold uppercase tracking-[0.2em] text-[var(--color-text-muted)] mb-3"
        >
          {category}
        </p>
        <div class="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-3">
          {#each theme.fonts.filter((f) => f.category === category) as f (f.id)}
            <button
              type="button"
              class="flex flex-col gap-2 p-4 rounded-xl border transition-all text-left
                     {theme.font === f.id
                ? 'border-[var(--color-accent)] bg-[var(--color-surface-2)] shadow-lg shadow-[var(--color-accent)]/5'
                : 'border-[var(--color-border)] bg-[var(--color-surface-1)] hover:bg-[var(--color-surface-2)] hover:border-[var(--color-text-muted)]'}"
              onclick={() => theme.setFont(f.id as FontFamily)}
            >
              <span class="text-[10px] font-medium text-[var(--color-text-muted)]">{f.label}</span>
              <span
                class="text-lg leading-tight"
                style="font-family: {theme.getFontFamily(f.id as FontFamily)}">Koryphaios</span
              >
              <span
                class="text-[10px] opacity-50"
                style="font-family: {theme.getFontFamily(f.id as FontFamily)}"
                >The quick brown fox</span
              >
              {#if theme.font === f.id}
                <div
                  class="mt-1 flex items-center gap-1.5 text-[var(--color-accent)] font-bold text-[10px] uppercase tracking-tighter"
                >
                  <Check size={10} strokeWidth={3} /> Active
                </div>
              {/if}
            </button>
          {/each}
        </div>
      </div>
    {/each}
  </section>
</div>
