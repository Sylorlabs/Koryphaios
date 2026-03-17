<script lang="ts">
  import type { DynamicProviderConfig, ProviderPreset, ReasoningConfig } from '@koryphaios/shared';
  import { Trash2, Settings, RefreshCw, Zap, Brain, Info } from 'lucide-svelte';
  import Button from '$lib/components/ui/Button.svelte';
  import Badge from '$lib/components/ui/Badge.svelte';
  import Tooltip from '$lib/components/ui/Tooltip.svelte';

  interface Props {
    provider: DynamicProviderConfig;
    preset?: ProviderPreset | null;
    isTesting?: boolean;
    onEdit?: () => void;
    onTest?: () => void;
    onDelete?: () => void;
  }

  let { 
    provider, 
    preset = null, 
    isTesting = false,
    onEdit = () => {},
    onTest = () => {},
    onDelete = () => {}
  }: Props = $props();

  const reasoningLabels: Record<ReasoningConfig['mode'], string> = {
    disabled: 'Off',
    minimal: 'Min',
    low: 'Low',
    medium: 'Medium',
    high: 'High',
    max: 'Max'
  };

  const reasoningColors: Record<ReasoningConfig['mode'], 'secondary' | 'outline' | 'info' | 'accent' | 'warning' | 'destructive'> = {
    disabled: 'secondary',
    minimal: 'outline',
    low: 'info',
    medium: 'accent',
    high: 'warning',
    max: 'destructive'
  };

  function getProviderIcon(): string {
    return preset?.icon || '🔌';
  }

  function getProviderDescription(): string {
    return preset?.description || 'Custom OpenAI-compatible endpoint';
  }

  function maskApiKey(key: string | undefined): string {
    if (!key) return 'Not set';
    if (key.length <= 8) return '••••••••';
    return key.slice(0, 4) + '••••••••' + key.slice(-4);
  }
</script>

<div class="group relative rounded-lg border border-border bg-card p-4 transition-colors hover:border-border/80">
  <!-- Header -->
  <div class="flex items-start justify-between gap-4">
    <div class="flex items-start gap-3">
      <div class="flex h-10 w-10 items-center justify-center rounded-md bg-muted text-2xl">
        {getProviderIcon()}
      </div>
      <div>
        <h3 class="font-medium">{provider.displayName || provider.name}</h3>
        <p class="text-sm text-muted-foreground">{getProviderDescription()}</p>
        <div class="mt-1 flex items-center gap-2">
          <code class="rounded bg-muted px-1.5 py-0.5 text-xs">{provider.name}</code>
          {#if provider.preset}
            <Badge variant="secondary" size="sm">{provider.preset}</Badge>
          {/if}
        </div>
      </div>
    </div>
    
    <div class="flex items-center gap-1">
      <Tooltip content="Edit provider">
        <Button variant="ghost" size="icon-sm" onclick={onEdit}>
          <Settings class="h-4 w-4" />
        </Button>
      </Tooltip>
      <Tooltip content="Test connection">
        <Button variant="ghost" size="icon-sm" onclick={onTest} disabled={isTesting}>
          <RefreshCw class="h-4 w-4 {isTesting ? 'animate-spin' : ''}" />
        </Button>
      </Tooltip>
      <Tooltip content="Remove provider">
        <Button variant="ghost" size="icon-sm" onclick={onDelete} class="text-destructive hover:text-destructive">
          <Trash2 class="h-4 w-4" />
        </Button>
      </Tooltip>
    </div>
  </div>

  <!-- Details -->
  <div class="mt-4 grid gap-3 text-sm">
    <div class="flex items-center gap-2">
      <span class="text-muted-foreground">Base URL:</span>
      <code class="truncate text-xs">{provider.baseUrl || preset?.baseUrl}</code>
    </div>
    <div class="flex items-center gap-2">
      <span class="text-muted-foreground">API Key:</span>
      <span class="font-mono text-xs">{maskApiKey(provider.apiKey)}</span>
    </div>
    {#if provider.models && provider.models.length > 0}
      <div class="flex items-center gap-2">
        <span class="text-muted-foreground">Models:</span>
        <div class="flex flex-wrap gap-1">
          {#each provider.models.slice(0, 3) as model}
            <Badge variant="outline" size="sm">{model}</Badge>
          {/each}
          {#if provider.models.length > 3}
            <Tooltip content={provider.models.slice(3).join(', ')}>
              <Badge variant="outline" size="sm">+{provider.models.length - 3}</Badge>
            </Tooltip>
          {/if}
        </div>
      </div>
    {/if}
  </div>

  <!-- Reasoning & Capabilities -->
  <div class="mt-4 flex flex-wrap items-center gap-2 border-t border-border pt-3">
    {#if provider.reasoning}
      <Badge variant={reasoningColors[provider.reasoning.mode]} size="sm">
        <Brain class="mr-1 h-3 w-3" />
        Reasoning: {reasoningLabels[provider.reasoning.mode]}
      </Badge>
    {:else}
      <Badge variant="outline" size="sm">
        <Brain class="mr-1 h-3 w-3" />
        Reasoning: Off
      </Badge>
    {/if}
    
    {#if provider.supportsTools !== false}
      <Badge variant="outline" size="sm">
        <Zap class="mr-1 h-3 w-3" />
        Tools
      </Badge>
    {/if}
    
    {#if provider.supportsStreaming !== false}
      <Badge variant="outline" size="sm">
        <RefreshCw class="mr-1 h-3 w-3" />
        Streaming
      </Badge>
    {/if}
    
    {#if provider.modelMappings && Object.keys(provider.modelMappings).length > 0}
      <Tooltip content="{Object.keys(provider.modelMappings).length} model mappings configured">
        <Badge variant="secondary" size="sm">
          <Info class="mr-1 h-3 w-3" />
          {Object.keys(provider.modelMappings).length} mappings
        </Badge>
      </Tooltip>
    {/if}
  </div>
</div>
