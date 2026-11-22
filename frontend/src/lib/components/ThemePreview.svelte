<script lang="ts">
  // Miniature app render for theme previews. Intentionally draws with the
  // passed palette values — not live theme tokens — so it always shows the
  // scheme it previews, never the active one.
  import type { ThemePalette } from '$lib/theme-palette';
  import { readableForeground } from '$lib/theme-contrast';

  let {
    palette,
    accent,
    secondary,
    label,
    size = 'md',
  }: {
    palette: ThemePalette;
    accent: string;
    secondary: string;
    label?: string;
    size?: 'sm' | 'md';
  } = $props();

  const onAccent = $derived(readableForeground(accent));
  const onSecondary = $derived(readableForeground(secondary));
  const compact = $derived(size === 'sm');
</script>

<div
  class="w-full overflow-hidden rounded-lg shadow-inner"
  class:h-16={compact}
  class:h-28={!compact}
  role="img"
  aria-label={label}
  style="background: {palette['--color-surface-0']}; border: 1px solid {palette['--color-border']};"
>
  <div class="flex h-full">
    <!-- Mini sidebar -->
    <div
      class="flex w-1/4 min-w-0 flex-col gap-1.5 border-r p-1.5"
      style="background: {palette['--color-surface-1']}; border-color: {palette['--color-border']};"
    >
      <div class="mb-0.5 h-1.5 w-1.5 rounded-full" style="background: {accent};"></div>
      <div class="h-1 w-full rounded-sm" style="background: {palette['--color-surface-3']};"></div>
      <div class="h-1 w-2/3 rounded-sm" style="background: {palette['--color-surface-3']};"></div>
      <div
        class="h-1 w-3/4 rounded-sm"
        style="background: {secondary}; opacity: 0.75;"
      ></div>
    </div>
    <!-- Mini main content -->
    <div class="flex min-w-0 flex-1 flex-col">
      <!-- Header -->
      <div
        class="flex h-5 items-center justify-between border-b px-2"
        style="background: {palette['--color-surface-1']}; border-color: {palette['--color-border']};"
      >
        <div class="h-1 w-8 rounded-full" style="background: {palette['--color-text-primary']};"></div>
        <div
          class="flex h-2.5 items-center rounded-full px-1.5"
          style="background: {secondary};"
        >
          <div
            class="h-0.5 w-4 rounded-full"
            style="background: {onSecondary}; opacity: 0.85;"
          ></div>
        </div>
      </div>
      <!-- Chat area -->
      <div
        class="flex flex-1 flex-col justify-end gap-1.5 p-2"
        style="background: {palette['--color-surface-0']};"
      >
        <!-- User bubble -->
        <div class="w-3/4 shrink-0 self-end rounded p-1 shadow-sm" style="background: {accent};">
          <div class="h-[3px] w-full rounded-full" style="background: {onAccent}; opacity: 0.7;"></div>
        </div>
        <!-- Assistant bubble -->
        <div
          class="w-5/6 shrink-0 self-start rounded border p-1"
          style="background: {palette['--color-surface-2']}; border-color: {palette['--color-border']};"
        >
          <div
            class="mb-0.5 h-[3px] w-full rounded-full"
            style="background: {palette['--color-text-secondary']}; opacity: 0.6;"
          ></div>
          <div
            class="h-[3px] w-2/3 rounded-full"
            style="background: {palette['--color-text-muted']}; opacity: 0.6;"
          ></div>
        </div>
        {#if !compact}
          <!-- Text ramp: primary / secondary / muted -->
          <div class="mt-0.5 flex items-center gap-1.5">
            <div
              class="h-[3px] w-8 rounded-full"
              style="background: {palette['--color-text-primary']};"
            ></div>
            <div
              class="h-[3px] w-6 rounded-full"
              style="background: {palette['--color-text-secondary']};"
            ></div>
            <div
              class="h-[3px] w-4 rounded-full"
              style="background: {palette['--color-text-muted']};"
            ></div>
          </div>
        {/if}
      </div>
    </div>
  </div>
</div>
