<script lang="ts">
  import type { ReasoningConfig } from '@koryphaios/shared';
  import { Brain, Zap, Lightbulb, BarChart3, Target, Maximize } from 'lucide-svelte';
  import Switch from '$lib/components/ui/Switch.svelte';
  import Slider from '$lib/components/ui/Slider.svelte';

  interface Props {
    config: ReasoningConfig;
    onChange: (config: ReasoningConfig) => void;
  }

  let { config, onChange }: Props = $props();

  const modes: { value: ReasoningConfig['mode']; label: string; description: string; icon: any }[] = [
    { 
      value: 'disabled', 
      label: 'Disabled', 
      description: 'No reasoning, fastest responses',
      icon: Zap
    },
    { 
      value: 'minimal', 
      label: 'Minimal', 
      description: 'Light internal processing',
      icon: Lightbulb
    },
    { 
      value: 'low', 
      label: 'Low', 
      description: 'Basic chain-of-thought',
      icon: Brain
    },
    { 
      value: 'medium', 
      label: 'Medium', 
      description: 'Balanced reasoning',
      icon: BarChart3
    },
    { 
      value: 'high', 
      label: 'High', 
      description: 'Extended thinking',
      icon: Target
    },
    { 
      value: 'max', 
      label: 'Maximum', 
      description: 'Deep analysis, slowest',
      icon: Maximize
    },
  ];

  function updateMode(mode: ReasoningConfig['mode']) {
    onChange({ ...config, mode });
  }

  function updateIncludeThoughts(value: boolean) {
    onChange({ ...config, includeThoughts: value });
  }

  function updateBudgetTokens(tokens: number) {
    onChange({ ...config, budgetTokens: tokens });
  }
</script>

<div class="space-y-6">
  <!-- Mode Selection -->
  <div class="grid grid-cols-2 gap-2 sm:grid-cols-3">
    {#each modes as mode}
      {@const Icon = mode.icon}
      <button
        class="flex flex-col items-start gap-2 rounded-lg border border-border p-3 text-left transition-all hover:border-primary/50 hover:bg-accent/50 {config.mode === mode.value ? 'border-primary bg-primary/5' : ''}"
        onclick={() => updateMode(mode.value)}
      >
        <Icon class="h-4 w-4 {config.mode === mode.value ? 'text-primary' : 'text-muted-foreground'}" />
        <div>
          <div class="text-sm font-medium">{mode.label}</div>
          <div class="text-xs text-muted-foreground">{mode.description}</div>
        </div>
      </button>
    {/each}
  </div>

  <!-- Advanced Options (only when reasoning is enabled) -->
  {#if config.mode !== 'disabled'}
    <div class="space-y-4 rounded-lg border border-border p-4">
      <h4 class="text-sm font-medium">Advanced Options</h4>
      
      <div class="flex items-center justify-between">
        <div>
          <div class="text-sm">Include Thought Process</div>
          <div class="text-xs text-muted-foreground">Show reasoning steps in response</div>
        </div>
        <Switch 
          checked={config.includeThoughts ?? true} 
          onCheckedChange={updateIncludeThoughts}
        />
      </div>

      {#if config.mode === 'high' || config.mode === 'medium'}
        <div class="space-y-2">
          <div class="flex items-center justify-between">
            <span class="text-sm">Budget Tokens</span>
            <span class="text-xs text-muted-foreground">{config.budgetTokens || 4096}</span>
          </div>
          <Slider
            value={[config.budgetTokens || 4096]}
            min={256}
            max={32768}
            step={256}
            onValueChange={([v]) => updateBudgetTokens(v)}
          />
          <div class="flex justify-between text-xs text-muted-foreground">
            <span>256</span>
            <span>32K</span>
          </div>
        </div>
      {/if}
    </div>
  {/if}

  <!-- Provider-specific mapping info -->
  <div class="rounded-lg bg-muted p-3 text-xs text-muted-foreground">
    <p class="font-medium mb-1">Provider Mapping</p>
    <ul class="space-y-1">
      <li>• <strong>OpenAI o-series:</strong> reasoning_effort parameter</li>
      <li>• <strong>Anthropic Claude:</strong> thinking block with effort level</li>
      <li>• <strong>Google Gemini:</strong> thinking_budget tokens</li>
      <li>• <strong>Others:</strong> Applied as reasoning_level header</li>
    </ul>
  </div>
</div>
