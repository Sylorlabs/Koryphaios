<script lang="ts">
  // Appearance settings tab — extracted from SettingsDrawer.svelte.
  // Self-contained: depends only on the `theme` store and bindable color-picker
  // state shared with the drawer-level ColorPickerModal.
  import Check from 'lucide-svelte/icons/check';
  import RotateCcw from 'lucide-svelte/icons/rotate-ccw';
  import {
    theme,
    THEME_DEFAULTS,
    type FontFamily,
    type ModeAppearance,
    type ThemeScheme,
  } from '$lib/stores/theme.svelte';
  import ThemeModeEditor from './ThemeModeEditor.svelte';
  import SettingsPage from './settings/SettingsPage.svelte';

  let {
    showColorPicker = $bindable(false),
    colorPickerTarget = $bindable<'primary' | 'secondary'>('primary'),
    colorPickerScheme = $bindable<ThemeScheme>('dark'),
  }: {
    showColorPicker?: boolean;
    colorPickerTarget?: 'primary' | 'secondary';
    colorPickerScheme?: ThemeScheme;
  } = $props();

  const fontCategories = $derived([...new Set(theme.fonts.map((f) => f.category))]);

  function slotEquals(a: ModeAppearance, b: ModeAppearance): boolean {
    return (
      a.preset === b.preset &&
      a.accent === b.accent &&
      a.secondaryAccent === b.secondaryAccent &&
      a.customAccent?.main === b.customAccent?.main &&
      a.customAccent?.hover === b.customAccent?.hover &&
      a.customSecondaryAccent?.main === b.customSecondaryAccent?.main &&
      a.customSecondaryAccent?.hover === b.customSecondaryAccent?.hover
    );
  }

  const usesDefaults = $derived(
    theme.mode === THEME_DEFAULTS.mode &&
      theme.font === THEME_DEFAULTS.font &&
      slotEquals(theme.dark, THEME_DEFAULTS.dark) &&
      slotEquals(theme.light, THEME_DEFAULTS.light),
  );

  function openColorPicker(scheme: ThemeScheme, target: 'primary' | 'secondary') {
    colorPickerScheme = scheme;
    colorPickerTarget = target;
    showColorPicker = true;
  }
</script>

<SettingsPage
  title="Appearance"
  description="Changes apply immediately and are saved for this device."
  width="wide"
>
  {#snippet actions()}
    <button
      type="button"
      disabled={usesDefaults}
      onclick={() => theme.reset()}
      class="inline-flex shrink-0 items-center gap-1.5 rounded-lg border border-[var(--color-border)] px-3 py-1.5 text-xs font-medium text-[var(--color-text-secondary)] transition-colors hover:bg-[var(--color-surface-3)] hover:text-[var(--color-text-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)]/60 disabled:cursor-not-allowed disabled:opacity-40"
    >
      <RotateCcw size={12} /> Restore defaults
    </button>
  {/snippet}

  <section aria-labelledby="appearance-theme-heading">
    <div class="mb-4">
      <h3
        id="appearance-theme-heading"
        class="text-sm font-semibold text-[var(--color-text-primary)]"
      >
        Theme
      </h3>
      <p class="mt-1 text-[13px] text-[var(--color-text-muted)]">
        Pick a mode, then give light and dark their own theme and accents.
      </p>
    </div>
    <ThemeModeEditor onChooseAccent={openColorPicker} />
  </section>

  <section aria-labelledby="appearance-typography-heading">
    <div class="mb-4">
      <h3
        id="appearance-typography-heading"
        class="text-sm font-semibold text-[var(--color-text-primary)]"
      >
        Typography
      </h3>
      <p class="mt-1 text-[13px] text-[var(--color-text-muted)]">
        Choose the font family for the interface.
      </p>
    </div>
    <div class="space-y-6">
      {#each fontCategories as category (category)}
        <div>
          <p
            class="mb-3 text-[10px] font-bold uppercase tracking-[0.2em] text-[var(--color-text-muted)]"
          >
            {category}
          </p>
          <div class="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4">
            {#each theme.fonts.filter((f) => f.category === category) as f (f.id)}
              <button
                type="button"
                aria-pressed={theme.font === f.id}
                class="flex flex-col gap-2 rounded-xl border p-4 text-left transition-colors
                       {theme.font === f.id
                  ? 'border-[var(--color-accent)] bg-[var(--color-surface-2)]'
                  : 'border-[var(--color-border)] bg-[var(--color-surface-1)] hover:border-[var(--color-text-muted)] hover:bg-[var(--color-surface-2)]'}"
                onclick={() => theme.setFont(f.id as FontFamily)}
              >
                <span class="text-[11px] font-medium text-[var(--color-text-muted)]">{f.label}</span>
                <span
                  class="text-lg leading-tight text-[var(--color-text-primary)]"
                  style="font-family: {theme.getFontFamily(f.id as FontFamily)}">Koryphaios</span
                >
                <span
                  class="text-[11px] text-[var(--color-text-secondary)]"
                  style="font-family: {theme.getFontFamily(f.id as FontFamily)}"
                  >The quick brown fox</span
                >
                {#if theme.font === f.id}
                  <span
                    class="mt-1 flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-wider text-[var(--color-accent)]"
                  >
                    <Check size={10} strokeWidth={3} /> Active
                  </span>
                {/if}
              </button>
            {/each}
          </div>
        </div>
      {/each}
    </div>
  </section>
</SettingsPage>
