<script lang="ts">
  import type { ProviderPreset } from '@koryphaios/shared';
  import { Check, Sparkles, ExternalLink } from 'lucide-svelte';
  import Button from '$lib/components/ui/Button.svelte';
  import Tooltip from '$lib/components/ui/Tooltip.svelte';

  interface Props {
    presets: ProviderPreset[];
    selectedPreset: string | null;
    onSelect: (preset: ProviderPreset) => void;
    onCustom: () => void;
  }

  let { presets, selectedPreset, onSelect, onCustom }: Props = $props();

  // Group presets by category if available, or use default grouping
  const popularPresets = ['fireworks', 'together', 'perplexity', 'cerebras'];
  
  function getPresetIcon(preset: ProviderPreset): string {
    return preset.icon || '🔌';
  }

  function isPopular(preset: ProviderPreset): boolean {
    return popularPresets.includes(preset.name);
  }
</script>

<div class="space-y-4">
  <div class="flex items-center justify-between">
    <h3 class="text-sm font-medium">Quick Start with Presets</h3>
    <Button variant="ghost" size="sm" onclick={onCustom}>
      <Sparkles class="mr-1 h-3 w-3" />
      Custom Endpoint
    </Button>
  </div>

  <div class="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
    {#each presets as preset}
      <button
        class="group relative flex flex-col items-start gap-2 rounded-lg border border-border bg-card p-4 text-left transition-all hover:border-primary/50 hover:bg-accent/50 focus:outline-none focus:ring-2 focus:ring-primary {selectedPreset === preset.name ? 'border-primary bg-primary/5' : ''}"
        onclick={() => onSelect(preset)}
      >
        {#if isPopular(preset)}
          <span class="absolute right-2 top-2 rounded-full bg-yellow-500/10 px-1.5 py-0.5 text-xs text-yellow-600 dark:text-yellow-400">
            Popular
          </span>
        {/if}
        
        <div class="flex h-10 w-10 items-center justify-center rounded-md bg-muted text-2xl">
          {getPresetIcon(preset)}
        </div>
        
        <div class="w-full">
          <div class="flex items-center gap-2">
            <span class="font-medium">{preset.displayName}</span>
            {#if selectedPreset === preset.name}
              <Check class="h-4 w-4 text-primary" />
            {/if}
          </div>
          <p class="mt-1 text-xs text-muted-foreground line-clamp-2">{preset.description}</p>
        </div>

        {#if preset.docsUrl}
          <Tooltip content="View documentation">
            <a 
              href={preset.docsUrl} 
              target="_blank" 
              rel="noopener noreferrer"
              class="absolute bottom-2 right-2 opacity-0 transition-opacity group-hover:opacity-100"
              onclick={(e) => e.stopPropagation()}
            >
              <ExternalLink class="h-3 w-3 text-muted-foreground hover:text-primary" />
            </a>
          </Tooltip>
        {/if}
      </button>
    {/each}
  </div>

  <!-- Custom endpoint option -->
  <button
    class="flex w-full items-center justify-center gap-2 rounded-lg border border-dashed border-border bg-card/50 p-4 text-muted-foreground transition-colors hover:border-primary/50 hover:bg-accent/50 hover:text-foreground"
    onclick={onCustom}
  >
    <Sparkles class="h-4 w-4" />
    <span>Add Custom OpenAI-Compatible Endpoint</span>
  </button>
</div>
