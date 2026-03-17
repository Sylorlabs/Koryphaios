<script lang="ts">
  import type { DynamicProviderConfig, ProviderPreset } from '@koryphaios/shared';
  import { Plus, Trash2, Key, Globe, Tag, Brain } from 'lucide-svelte';
  import Button from '$lib/components/ui/Button.svelte';
  import Input from '$lib/components/ui/Input.svelte';
  import Select from '$lib/components/ui/Select.svelte';
  import Switch from '$lib/components/ui/Switch.svelte';

  interface Props {
    presets: ProviderPreset[];
    initialConfig?: Partial<DynamicProviderConfig>;
    onSubmit: (config: DynamicProviderConfig) => void;
    onCancel: () => void;
  }

  let { presets, initialConfig, onSubmit, onCancel }: Props = $props();

  // Form state
  let name = $state(initialConfig?.name || '');
  let displayName = $state(initialConfig?.displayName || '');
  let selectedPreset = $state(initialConfig?.preset || '');
  let baseUrl = $state(initialConfig?.baseUrl || '');
  let apiKey = $state(initialConfig?.apiKey || '');
  let models = $state(initialConfig?.models?.join(', ') || '');
  let supportsTools = $state(initialConfig?.supportsTools !== false);
  let supportsStreaming = $state(initialConfig?.supportsStreaming !== false);
  
  // Reasoning config
  let reasoningMode = $state(initialConfig?.reasoning?.mode || 'disabled');
  let includeThoughts = $state(initialConfig?.reasoning?.includeThoughts ?? true);
  let budgetTokens = $state(initialConfig?.reasoning?.budgetTokens || 4096);
  
  // Custom headers
  let headers = $state<Record<string, string>>(initialConfig?.headers || {});
  let newHeaderKey = $state('');
  let newHeaderValue = $state('');
  
  // Model mappings
  let modelMappings = $state<Record<string, string>>(initialConfig?.modelMappings || {});
  let newMappingFrom = $state('');
  let newMappingTo = $state('');

  // Reasoning mode options
  const reasoningModes = [
    { value: 'disabled', label: 'Disabled' },
    { value: 'minimal', label: 'Minimal' },
    { value: 'low', label: 'Low' },
    { value: 'medium', label: 'Medium' },
    { value: 'high', label: 'High' },
    { value: 'max', label: 'Maximum' },
  ];

  // Update base URL when preset changes
  $effect(() => {
    if (selectedPreset) {
      const preset = presets.find(p => p.name === selectedPreset);
      if (preset && !baseUrl) {
        baseUrl = preset.baseUrl;
      }
      if (preset && models === '' && preset.defaultModels) {
        models = preset.defaultModels.join(', ');
      }
    }
  });

  function addHeader() {
    if (newHeaderKey.trim()) {
      headers = { ...headers, [newHeaderKey.trim()]: newHeaderValue.trim() };
      newHeaderKey = '';
      newHeaderValue = '';
    }
  }

  function removeHeader(key: string) {
    const { [key]: _, ...rest } = headers;
    headers = rest;
  }

  function addMapping() {
    if (newMappingFrom.trim() && newMappingTo.trim()) {
      modelMappings = { ...modelMappings, [newMappingFrom.trim()]: newMappingTo.trim() };
      newMappingFrom = '';
      newMappingTo = '';
    }
  }

  function removeMapping(from: string) {
    const { [from]: _, ...rest } = modelMappings;
    modelMappings = rest;
  }

  function handleSubmit() {
    const config: DynamicProviderConfig = {
      name: name.trim().toLowerCase().replace(/[^a-z0-9_-]/g, '-'),
      displayName: displayName.trim() || name.trim(),
      baseUrl: baseUrl.trim(),
      apiKey: apiKey.trim(),
      models: models.split(',').map(m => m.trim()).filter(Boolean),
      supportsTools,
      supportsStreaming,
      preset: selectedPreset || undefined,
      headers: Object.keys(headers).length > 0 ? headers : undefined,
      modelMappings: Object.keys(modelMappings).length > 0 ? modelMappings : undefined,
    };

    if (reasoningMode !== 'disabled') {
      config.reasoning = {
        mode: reasoningMode as DynamicProviderConfig['reasoning']['mode'],
        includeThoughts,
        budgetTokens: reasoningMode === 'max' ? 32768 : budgetTokens,
      };
    }

    onSubmit(config);
  }

  function isValid(): boolean {
    return name.trim().length >= 2 && baseUrl.trim().length > 0;
  }
</script>

<form class="space-y-6" onsubmit={(e) => { e.preventDefault(); handleSubmit(); }}>
  <!-- Basic Info -->
  <div class="space-y-4">
    <h3 class="text-sm font-medium">Basic Information</h3>
    
    <div class="grid gap-4 sm:grid-cols-2">
      <div class="space-y-2">
        <label class="text-sm font-medium">Provider ID</label>
        <Input
          bind:value={name}
          placeholder="my-provider"
          disabled={!!initialConfig?.name}
          required
          minlength={2}
        />
        <p class="text-xs text-muted-foreground">Unique identifier, lowercase with dashes</p>
      </div>
      
      <div class="space-y-2">
        <label class="text-sm font-medium">Display Name</label>
        <Input
          bind:value={displayName}
          placeholder="My Provider"
        />
      </div>
    </div>

    <div class="space-y-2">
      <label class="text-sm font-medium">Preset</label>
      <Select bind:value={selectedPreset}>
        <option value="">Custom (manual configuration)</option>
        {#each presets as preset}
          <option value={preset.name}>{preset.displayName} — {preset.description}</option>
        {/each}
      </Select>
      {#if selectedPreset}
        {@const preset = presets.find(p => p.name === selectedPreset)}
        <p class="text-xs text-muted-foreground">{preset?.description}</p>
      {/if}
    </div>
  </div>

  <!-- Connection -->
  <div class="space-y-4">
    <h3 class="text-sm font-medium">Connection</h3>
    
    <div class="space-y-2">
      <label class="text-sm font-medium flex items-center gap-2">
        <Globe class="h-4 w-4" />
        Base URL
      </label>
      <Input
        bind:value={baseUrl}
        placeholder="https://api.example.com/v1"
        required
      />
    </div>
    
    <div class="space-y-2">
      <label class="text-sm font-medium flex items-center gap-2">
        <Key class="h-4 w-4" />
        API Key
      </label>
      <Input
        bind:value={apiKey}
        type="password"
        placeholder="sk-..."
      />
      <p class="text-xs text-muted-foreground">Leave empty to use environment variable KORY_PROVIDER_{name.toUpperCase()}_API_KEY</p>
    </div>
  </div>

  <!-- Models -->
  <div class="space-y-4">
    <h3 class="text-sm font-medium">Models</h3>
    
    <div class="space-y-2">
      <label class="text-sm font-medium flex items-center gap-2">
        <Tag class="h-4 w-4" />
        Available Models
      </label>
      <Input
        bind:value={models}
        placeholder="gpt-4, gpt-3.5-turbo, claude-3-opus"
      />
      <p class="text-xs text-muted-foreground">Comma-separated list of model IDs</p>
    </div>
  </div>

  <!-- Reasoning -->
  <div class="space-y-4">
    <h3 class="text-sm font-medium flex items-center gap-2">
      <Brain class="h-4 w-4" />
      Reasoning Configuration
    </h3>
    
    <div class="space-y-4 rounded-lg border border-border p-4">
      <div class="space-y-2">
        <label class="text-sm font-medium">Reasoning Mode</label>
        <Select bind:value={reasoningMode}>
          {#each reasoningModes as mode}
            <option value={mode.value}>{mode.label}</option>
          {/each}
        </Select>
      </div>
      
      {#if reasoningMode !== 'disabled'}
        <div class="flex items-center justify-between">
          <label class="text-sm">Include Thought Process</label>
          <Switch bind:checked={includeThoughts} />
        </div>
        
        {#if reasoningMode === 'high' || reasoningMode === 'medium'}
          <div class="space-y-2">
            <label class="text-sm font-medium">Budget Tokens</label>
            <Input
              bind:value={budgetTokens}
              type="number"
              min={256}
              max={32768}
              step={256}
            />
            <p class="text-xs text-muted-foreground">Tokens allocated for reasoning (256-32768)</p>
          </div>
        {/if}
      {/if}
    </div>
  </div>

  <!-- Capabilities -->
  <div class="space-y-4">
    <h3 class="text-sm font-medium">Capabilities</h3>
    
    <div class="flex items-center justify-between rounded-lg border border-border p-4">
      <div>
        <label class="text-sm font-medium">Tool Support</label>
        <p class="text-xs text-muted-foreground">Provider supports function calling</p>
      </div>
      <Switch bind:checked={supportsTools} />
    </div>
    
    <div class="flex items-center justify-between rounded-lg border border-border p-4">
      <div>
        <label class="text-sm font-medium">Streaming</label>
        <p class="text-xs text-muted-foreground">Provider supports streaming responses</p>
      </div>
      <Switch bind:checked={supportsStreaming} />
    </div>
  </div>

  <!-- Custom Headers -->
  <div class="space-y-4">
    <h3 class="text-sm font-medium">Custom Headers</h3>
    
    <div class="space-y-2">
      {#each Object.entries(headers) as [key, value]}
        <div class="flex items-center gap-2">
          <code class="flex-1 rounded bg-muted px-2 py-1 text-xs">{key}: {value}</code>
          <Button type="button" variant="ghost" size="icon-sm" onclick={() => removeHeader(key)}>
            <Trash2 class="h-4 w-4 text-destructive" />
          </Button>
        </div>
      {/each}
      
      <div class="flex gap-2">
        <Input
          bind:value={newHeaderKey}
          placeholder="Header name"
          class="flex-1"
        />
        <Input
          bind:value={newHeaderValue}
          placeholder="Value"
          class="flex-1"
        />
        <Button type="button" variant="outline" onclick={addHeader}>
          <Plus class="h-4 w-4" />
        </Button>
      </div>
    </div>
  </div>

  <!-- Model Mappings -->
  <div class="space-y-4">
    <h3 class="text-sm font-medium">Model Mappings</h3>
    <p class="text-xs text-muted-foreground">Map standard model IDs to provider-specific names</p>
    
    <div class="space-y-2">
      {#each Object.entries(modelMappings) as [from, to]}
        <div class="flex items-center gap-2">
          <code class="flex-1 rounded bg-muted px-2 py-1 text-xs">{from} → {to}</code>
          <Button type="button" variant="ghost" size="icon-sm" onclick={() => removeMapping(from)}>
            <Trash2 class="h-4 w-4 text-destructive" />
          </Button>
        </div>
      {/each}
      
      <div class="flex gap-2">
        <Input
          bind:value={newMappingFrom}
          placeholder="Standard model (e.g., gpt-4)"
          class="flex-1"
        />
        <span class="flex items-center text-muted-foreground">→</span>
        <Input
          bind:value={newMappingTo}
          placeholder="Provider model (e.g., accounts/fireworks/models/llama-v3p1-405b)"
          class="flex-1"
        />
        <Button type="button" variant="outline" onclick={addMapping}>
          <Plus class="h-4 w-4" />
        </Button>
      </div>
    </div>
  </div>

  <!-- Actions -->
  <div class="flex justify-end gap-2 pt-4 border-t border-border">
    <Button type="button" variant="ghost" onclick={onCancel}>
      Cancel
    </Button>
    <Button type="submit" disabled={!isValid()}>
      {initialConfig?.name ? 'Update Provider' : 'Add Provider'}
    </Button>
  </div>
</form>
