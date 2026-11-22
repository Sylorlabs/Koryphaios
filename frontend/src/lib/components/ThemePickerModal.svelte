<script lang="ts">
  import { theme, type ThemeScheme } from '$lib/stores/theme.svelte';
  import ThemeModeSwitcher from './ThemeModeSwitcher.svelte';
  import SunMoon from 'lucide-svelte/icons/sun-moon';
  import Check from 'lucide-svelte/icons/check';
  import X from 'lucide-svelte/icons/x';

  interface Props {
    open: boolean;
    onClose: () => void;
  }

  let { open, onClose }: Props = $props();

  const groups: Array<{ scheme: ThemeScheme; label: string }> = [
    { scheme: 'dark', label: 'Dark themes' },
    { scheme: 'light', label: 'Light themes' },
  ];

  function slotPreset(scheme: ThemeScheme) {
    return theme.modeAppearance(scheme).preset;
  }
</script>

{#if open}
  <div
    class="fixed inset-0 z-[95] flex items-start justify-center pt-[12vh] px-4 backdrop-blur-sm"
    data-scrollbar-overlay
    style="background: rgba(0,0,0,0.45);"
    onmousedown={onClose}
    role="presentation"
  >
    <div
      class="w-full max-w-md rounded-xl border shadow-2xl overflow-hidden"
      style="background: var(--color-surface-1); border-color: var(--color-border);"
      onmousedown={e => e.stopPropagation()}
      role="presentation"
    >
      <div class="flex items-center justify-between px-4 py-3 border-b" style="border-color: var(--color-border);">
        <div class="flex items-center gap-2">
          <SunMoon size={15} style="color: var(--color-text-secondary);" />
          <div class="text-sm font-medium" style="color: var(--color-text-primary);">Switch Theme</div>
        </div>
        <button
          class="p-1 rounded transition-colors hover:bg-[var(--color-surface-3)]"
          style="color: var(--color-text-muted);"
          onclick={onClose}
          aria-label="Close theme picker"
        >
          <X size={14} />
        </button>
      </div>

      <div class="p-3 space-y-4">
        <ThemeModeSwitcher compact />

        {#each groups as group (group.scheme)}
          {@const active = theme.activeScheme === group.scheme}
          <div>
            <div class="flex items-center gap-2 mb-2">
              <div
                class="text-[10px] uppercase tracking-wider"
                style="color: var(--color-text-muted);"
              >
                {group.label}
              </div>
              {#if !active && theme.mode === 'system'}
                <div class="text-[10px]" style="color: var(--color-text-muted);">
                  · used when your system is {group.scheme}
                </div>
              {/if}
            </div>
            <div class="grid grid-cols-2 gap-1.5">
              {#each theme.presetsFor(group.scheme) as preset (preset.id)}
                {@const selected = slotPreset(group.scheme) === preset.id}
                <button
                  class="flex items-center justify-between gap-2 px-3 py-2 rounded-lg text-xs transition-all border
                         {selected
                           ? active
                             ? 'border-[var(--color-accent)] bg-[var(--color-accent)]/10 text-[var(--color-text-primary)]'
                             : 'border-[var(--color-border-bright)] bg-[var(--color-surface-2)] text-[var(--color-text-secondary)]'
                           : 'border-transparent bg-[var(--color-surface-2)] text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-3)]'}"
                  onclick={() => {
                    theme.setPreset(preset.id);
                  }}
                >
                  <span>{preset.label}</span>
                  {#if selected}
                    <Check
                      size={12}
                      style="color: {active
                        ? 'var(--color-accent)'
                        : 'var(--color-text-muted)'};"
                    />
                  {/if}
                </button>
              {/each}
            </div>
          </div>
        {/each}
      </div>
    </div>
  </div>
{/if}
