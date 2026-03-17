<script lang="ts">
  import { Input } from '$lib/components/ui/input';
  import { Label } from '$lib/components/ui/label';
  import { Textarea } from '$lib/components/ui/textarea';
  import { Alert, AlertDescription } from '$lib/components/ui/alert';
  import { AlertCircle } from 'lucide-svelte';
  import type { DynamicProviderConfig } from '@koryphaios/shared';

  export let config: Partial<DynamicProviderConfig> = {};

  let headersText = '';
  let headerError: string | null = null;

  $: {
    // Sync headersText with config.headers
    if (config.headers && Object.keys(config.headers).length > 0) {
      const currentText = Object.entries(config.headers)
        .map(([k, v]) => `${k}: ${v}`)
        .join('\n');
      if (currentText !== headersText && headersText === '') {
        headersText = currentText;
      }
    }
  }

  function parseHeaders(text: string): Record<string, string> | null {
    if (!text.trim()) return {};
    
    const headers: Record<string, string> = {};
    const lines = text.split('\n');
    
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line) continue;
      
      const colonIndex = line.indexOf(':');
      if (colonIndex === -1) {
        headerError = `Line ${i + 1} is missing a colon separator`;
        return null;
      }
      
      const key = line.slice(0, colonIndex).trim();
      const value = line.slice(colonIndex + 1).trim();
      
      if (!key) {
        headerError = `Line ${i + 1} has an empty key`;
        return null;
      }
      
      headers[key] = value;
    }
    
    headerError = null;
    return headers;
  }

  function handleHeadersChange(e: Event) {
    const text = (e.target as HTMLTextAreaElement).value;
    headersText = text;
    const parsed = parseHeaders(text);
    if (parsed !== null) {
      config = { ...config, headers: parsed };
    }
  }
</script>

<div class="space-y-4">
  <div class="space-y-2">
    <Label for="providerName">Provider Name *</Label>
    <Input
      id="providerName"
      placeholder="e.g., my-custom-llm"
      bind:value={config.name}
    />
    <p class="text-xs text-muted-foreground">
      Unique identifier for this provider (lowercase, no spaces).
    </p>
  </div>

  <div class="space-y-2">
    <Label for="displayName">Display Name</Label>
    <Input
      id="displayName"
      placeholder="e.g., My Custom LLM"
      bind:value={config.displayName}
    />
    <p class="text-xs text-muted-foreground">
      Human-readable name shown in the UI.
    </p>
  </div>

  <div class="space-y-2">
    <Label for="baseUrl">Base URL *</Label>
    <Input
      id="baseUrl"
      type="url"
      placeholder="https://api.example.com/v1"
      bind:value={config.baseUrl}
    />
    <p class="text-xs text-muted-foreground">
      The base URL for the OpenAI-compatible API endpoint.
    </p>
  </div>

  <div class="space-y-2">
    <Label for="apiKey">API Key *</Label>
    <Input
      id="apiKey"
      type="password"
      placeholder="sk-..."
      bind:value={config.apiKey}
    />
    <p class="text-xs text-muted-foreground">
      Your API key is encrypted and stored securely.
    </p>
  </div>

  <div class="space-y-2">
    <Label for="customHeaders">Custom Headers (Optional)</Label>
    <Textarea
      id="customHeaders"
      placeholder="X-Custom-Header: value&#10;Another-Header: value"
      rows={4}
      value={headersText}
      on:input={handleHeadersChange}
    />
    {#if headerError}
      <Alert variant="destructive" class="py-2">
        <AlertCircle class="h-4 w-4" />
        <AlertDescription class="text-xs">{headerError}</AlertDescription>
      </Alert>
    {/if}
    <p class="text-xs text-muted-foreground">
      Additional headers to send with each request. Format: <code>Key: Value</code> (one per line).
    </p>
  </div>

  <div class="space-y-2">
    <Label for="selectedModels">Default Models (Optional)</Label>
    <Textarea
      id="selectedModels"
      placeholder="model-name-1&#10;model-name-2"
      rows={3}
      value={config.selectedModels?.join('\n') ?? ''}
      on:input={(e) => {
        const models = e.currentTarget.value
          .split('\n')
          .map(s => s.trim())
          .filter(Boolean);
        config = { ...config, selectedModels: models.length > 0 ? models : undefined };
      }}
    />
    <p class="text-xs text-muted-foreground">
      List of model IDs to show by default (one per line). Leave empty to fetch from API.
    </p>
  </div>
</div>
