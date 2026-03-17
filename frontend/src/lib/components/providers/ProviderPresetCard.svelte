<script lang="ts">
  import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '$lib/components/ui/card';
  import { Badge } from '$lib/components/ui/badge';
  import { Check } from 'lucide-svelte';
  import type { ProviderPreset } from '@koryphaios/shared';

  export let preset: ProviderPreset;
  export let selected: boolean;
  export let onSelect: () => void;
</script>

<Card
  class="cursor-pointer transition-all hover:border-primary/50 {selected ? 'border-primary ring-1 ring-primary' : ''}"
  on:click={onSelect}
  on:keydown={(e) => e.key === 'Enter' && onSelect()}
  role="button"
  tabindex="0"
>
  <CardHeader class="pb-2">
    <div class="flex items-start justify-between">
      <CardTitle class="text-base">{preset.displayName}</CardTitle>
      {#if selected}
        <Badge variant="default" class="h-6 w-6 p-0 flex items-center justify-center">
          <Check class="h-3 w-3" />
        </Badge>
      {/if}
    </div>
    <CardDescription class="text-xs line-clamp-2">
      {preset.description}
    </CardDescription>
  </CardHeader>
  <CardContent class="pt-0">
    {#if preset.defaultModels && preset.defaultModels.length > 0}
      <div class="text-xs text-muted-foreground">
        <span class="font-medium">{preset.defaultModels.length}</span> models available
      </div>
    {/if}
    {#if preset.docsUrl}
      <a
        href={preset.docsUrl}
        target="_blank"
        rel="noopener noreferrer"
        class="text-xs text-primary hover:underline mt-2 inline-block"
        on:click={(e) => e.stopPropagation()}
      >
        Documentation →
      </a>
    {/if}
  </CardContent>
</Card>
