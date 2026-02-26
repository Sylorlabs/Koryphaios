<script lang="ts">
  import { theme } from '$lib/stores/theme.svelte';
  import { SunMoon, Check, X } from 'lucide-svelte';

  interface Props {
    open: boolean;
    onClose: () => void;
  }

  let { open, onClose }: Props = $props();
</script>

{#if open}
  <div
    class="fixed inset-0 z-[95] flex items-start justify-center pt-[12vh] px-4 backdrop-blur-sm"
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

      <div class="p-3">
        <div class="text-[10px] uppercase tracking-wider mb-2" style="color: var(--color-text-muted);">Theme Preset</div>
        <div class="grid grid-cols-2 gap-1.5">
          {#each theme.presets as preset}
            <button
              class="flex items-center justify-between gap-2 px-3 py-2 rounded-lg text-xs transition-all border
                     {theme.preset === preset.id
                       ? 'border-[var(--color-accent)] bg-[var(--color-accent)]/10 text-[var(--color-text-primary)]'
                       : 'border-transparent bg-[var(--color-surface-2)] text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-3)]'}"
              onclick={() => {
                theme.setPreset(preset.id);
              }}
            >
              <span>{preset.label}</span>
              {#if theme.preset === preset.id}
                <Check size={12} style="color: var(--color-accent);" />
              {/if}
            </button>
          {/each}
        </div>
      </div>
    </div>
  </div>
{/if}
