<script lang="ts">
  import { createEventDispatcher, onMount } from 'svelte';
  import { Button } from '$lib/components/ui/button';
  import { Input } from '$lib/components/ui/input';
  import { Label } from '$lib/components/ui/label';
  import { Tabs, TabsContent, TabsList, TabsTrigger } from '$lib/components/ui/tabs';
  import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '$lib/components/ui/dialog';
  import { Alert, AlertDescription } from '$lib/components/ui/alert';
  import { Loader2, Plus, Check, AlertCircle } from 'lucide-svelte';
  import ProviderPresetCard from './ProviderPresetCard.svelte';
  import CustomProviderForm from './CustomProviderForm.svelte';
  import ReasoningConfigForm from './ReasoningConfigForm.svelte';
  import { getProviderPresets, addDynamicProvider, testDynamicProvider } from '$lib/api';
  import type { ProviderPreset, DynamicProviderConfig, ReasoningConfig } from '@koryphaios/shared';

  // Props
  export let open = false;

  // Events
  const dispatch = createEventDispatcher<{
    close: void;
    success: { provider: string };
  }>();

  // State
  let presets: ProviderPreset[] = [];
  let loading = false;
  let testing = false;
  let error: string | null = null;
  let activeTab = 'presets';
  
  // Selected preset
  let selectedPreset: string | null = null;
  let apiKey = '';
  
  // Custom provider
  let customConfig: Partial<DynamicProviderConfig> = {};
  
  // Reasoning config
  let reasoningConfig: ReasoningConfig = { mode: 'medium' };
  
  // Test result
  let testResult: { success: boolean; message: string; models?: string[] } | null = null;

  onMount(async () => {
    try {
      presets = await getProviderPresets();
    } catch (err: any) {
      error = 'Failed to load provider presets';
      console.error(err);
    }
  });

  function handleClose() {
    dispatch('close');
    resetForm();
  }

  function resetForm() {
    selectedPreset = null;
    apiKey = '';
    customConfig = {};
    reasoningConfig = { mode: 'medium' };
    error = null;
    testResult = null;
    activeTab = 'presets';
  }

  async function handleTestConnection() {
    testing = true;
    error = null;
    testResult = null;

    try {
      const config = activeTab === 'presets' 
        ? { preset: selectedPreset, apiKey }
        : customConfig;

      const result = await testDynamicProvider(
        activeTab === 'presets' ? selectedPreset! : customConfig.name!,
        config
      );

      testResult = {
        success: result.ok,
        message: result.data?.message || result.error || 'Test completed',
        models: result.data?.models,
      };
    } catch (err: any) {
      error = err.message || 'Test failed';
    } finally {
      testing = false;
    }
  }

  async function handleAddProvider() {
    loading = true;
    error = null;

    try {
      let config: DynamicProviderConfig;

      if (activeTab === 'presets' && selectedPreset) {
        const preset = presets.find(p => p.name === selectedPreset);
        if (!preset) throw new Error('Preset not found');

        config = {
          name: preset.name as any,
          preset: preset.name,
          apiKey,
          disabled: false,
          reasoning: reasoningConfig,
        };
      } else {
        config = {
          ...customConfig as DynamicProviderConfig,
          disabled: false,
          reasoning: reasoningConfig,
        };
      }

      const result = await addDynamicProvider(config);
      
      if (result.ok) {
        dispatch('success', { provider: config.name });
        handleClose();
      } else {
        error = result.error || 'Failed to add provider';
      }
    } catch (err: any) {
      error = err.message || 'Failed to add provider';
    } finally {
      loading = false;
    }
  }

  function canSubmit(): boolean {
    if (activeTab === 'presets') {
      return !!selectedPreset && !!apiKey;
    }
    return !!customConfig.name && !!customConfig.baseUrl && !!customConfig.apiKey;
  }

  function canTest(): boolean {
    if (activeTab === 'presets') {
      return !!selectedPreset && !!apiKey;
    }
    return !!customConfig.name && !!customConfig.baseUrl;
  }
</script>

<Dialog {open} onOpenChange={(v) => !v && handleClose()}>
  <DialogContent class="sm:max-w-[800px] max-h-[90vh] overflow-y-auto">
    <DialogHeader>
      <DialogTitle>Add AI Provider</DialogTitle>
      <DialogDescription>
        Add a new OpenAI-compatible provider or select from presets.
      </DialogDescription>
    </DialogHeader>

    {#if error}
      <Alert variant="destructive">
        <AlertCircle class="h-4 w-4" />
        <AlertDescription>{error}</AlertDescription>
      </Alert>
    {/if}

    {#if testResult}
      <Alert variant={testResult.success ? "default" : "destructive"}>
        {#if testResult.success}
          <Check class="h-4 w-4" />
        {:else}
          <AlertCircle class="h-4 w-4" />
        {/if}
        <AlertDescription>
          {testResult.message}
          {#if testResult.models && testResult.models.length > 0}
            <div class="mt-2 text-sm text-muted-foreground">
              Found {testResult.models.length} models: {testResult.models.slice(0, 5).join(', ')}
              {#if testResult.models.length > 5}
                ...and {testResult.models.length - 5} more
              {/if}
            </div>
          {/if}
        </AlertDescription>
      </Alert>
    {/if}

    <Tabs bind:value={activeTab} class="w-full">
      <TabsList class="grid w-full grid-cols-2">
        <TabsTrigger value="presets">Provider Presets</TabsTrigger>
        <TabsTrigger value="custom">Custom Provider</TabsTrigger>
      </TabsList>

      <TabsContent value="presets" class="space-y-4">
        <div class="grid grid-cols-2 gap-4 max-h-[400px] overflow-y-auto p-1">
          {#each presets as preset}
            <ProviderPresetCard
              {preset}
              selected={selectedPreset === preset.name}
              onSelect={() => selectedPreset = preset.name}
            />
          {/each}
        </div>

        {#if selectedPreset}
          <div class="space-y-4 border rounded-lg p-4">
            <div class="space-y-2">
              <Label for="apiKey">API Key</Label>
              <Input
                id="apiKey"
                type="password"
                placeholder="Enter your API key"
                bind:value={apiKey}
              />
              <p class="text-sm text-muted-foreground">
                Your API key is encrypted and stored securely.
              </p>
            </div>

            <ReasoningConfigForm bind:config={reasoningConfig} />
          </div>
        {/if}
      </TabsContent>

      <TabsContent value="custom">
        <CustomProviderForm bind:config={customConfig} />
        
        <div class="mt-4">
          <ReasoningConfigForm bind:config={reasoningConfig} />
        </div>
      </TabsContent>
    </Tabs>

    <div class="flex justify-between gap-4">
      <Button
        variant="outline"
        on:click={handleTestConnection}
        disabled={!canTest() || testing}
      >
        {#if testing}
          <Loader2 class="mr-2 h-4 w-4 animate-spin" />
          Testing...
        {:else}
          Test Connection
        {/if}
      </Button>

      <div class="flex gap-2">
        <Button variant="outline" on:click={handleClose}>
          Cancel
        </Button>
        <Button 
          on:click={handleAddProvider} 
          disabled={!canSubmit() || loading}
        >
          {#if loading}
            <Loader2 class="mr-2 h-4 w-4 animate-spin" />
            Adding...
          {:else}
            <Plus class="mr-2 h-4 w-4" />
            Add Provider
          {/if}
        </Button>
      </div>
    </div>
  </DialogContent>
</Dialog>
