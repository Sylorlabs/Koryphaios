<script lang="ts">
  import { Plus, AlertCircle, RefreshCw, Server } from 'lucide-svelte';
  import { useDynamicProviders } from '$lib/stores/dynamicProviders.svelte';
  import { DynamicProviderCard, DynamicProviderModal, PresetSelector } from '$lib/components/providers';
  import Button from '$lib/components/ui/Button.svelte';
  import type { DynamicProviderConfig, ProviderPreset } from '@koryphaios/shared';

  // Store
  const store = useDynamicProviders();

  // Modal state
  let showModal = $state(false);
  let editingProvider = $state<Partial<DynamicProviderConfig> | undefined>(undefined);
  let showPresetSelector = $state(true);

  function handleAddFromPreset(preset: ProviderPreset) {
    editingProvider = { preset: preset.name };
    showPresetSelector = false;
    showModal = true;
  }

  function handleAddCustom() {
    editingProvider = {};
    showPresetSelector = false;
    showModal = true;
  }

  function handleEdit(provider: DynamicProviderConfig) {
    editingProvider = { ...provider };
    showPresetSelector = false;
    showModal = true;
  }

  function handleCloseModal() {
    showModal = false;
    editingProvider = undefined;
    showPresetSelector = true;
  }

  async function handleSubmit(config: DynamicProviderConfig) {
    let result;
    if (editingProvider?.name) {
      result = await store.update(editingProvider.name, config);
    } else {
      result = await store.add(config);
    }
    
    if (result.ok) {
      handleCloseModal();
    }
    return result;
  }

  async function handleTest(provider: DynamicProviderConfig) {
    return store.test(provider.name, provider);
  }

  async function handleDelete(provider: DynamicProviderConfig) {
    if (confirm(`Are you sure you want to remove "${provider.displayName || provider.name}"?`)) {
      await store.remove(provider.name);
    }
  }
</script>

<svelte:head>
  <title>AI Providers - Koryphaios</title>
</svelte:head>

<div class="mx-auto max-w-6xl space-y-6">
  <!-- Header -->
  <div class="flex items-center justify-between">
    <div>
      <h1 class="text-2xl font-bold">AI Providers</h1>
      <p class="text-muted-foreground">Manage your AI model providers and reasoning settings</p>
    </div>
    <div class="flex items-center gap-2">
      <Button variant="outline" onclick={() => store.refresh()} loading={store.loading.providers}>
        <RefreshCw class="h-4 w-4" />
        Refresh
      </Button>
      <Button onclick={() => { showPresetSelector = true; showModal = true; }}>
        <Plus class="h-4 w-4" />
        Add Provider
      </Button>
    </div>
  </div>

  <!-- Error alert -->
  {#if store.error}
    <div class="flex items-center gap-3 rounded-lg border border-destructive/50 bg-destructive/10 px-4 py-3 text-destructive">
      <AlertCircle class="h-5 w-5" />
      <p class="text-sm">{store.error}</p>
    </div>
  {/if}

  <!-- Empty state -->
  {#if !store.isLoading && store.providers.length === 0}
    <div class="flex flex-col items-center justify-center rounded-lg border border-dashed border-border bg-card/50 py-16">
      <Server class="h-12 w-12 text-muted-foreground/50" />
      <h3 class="mt-4 text-lg font-medium">No providers configured</h3>
      <p class="mt-1 text-sm text-muted-foreground">Add your first AI provider to get started</p>
      <Button class="mt-4" onclick={() => { showPresetSelector = true; showModal = true; }}>
        <Plus class="mr-2 h-4 w-4" />
        Add Provider
      </Button>
    </div>
  {:else}
    <!-- Provider grid -->
    <div class="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
      {#each store.providers as provider (provider.name)}
        <DynamicProviderCard
          {provider}
          preset={store.getPreset(provider.preset || '')}
          isTesting={store.loading.testing.has(provider.name)}
          onEdit={() => handleEdit(provider)}
          onTest={() => handleTest(provider)}
          onDelete={() => handleDelete(provider)}
        />
      {/each}
    </div>
  {/if}
</div>

<!-- Add/Edit Modal -->
{#if showModal}
  {#if showPresetSelector}
    <!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
    <div 
      class="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
      onclick={(e) => e.target === e.currentTarget && handleCloseModal()}
    >
    <dialog 
      class="m-auto max-h-[90vh] w-full max-w-3xl overflow-hidden rounded-lg border border-border bg-background p-0 shadow-lg" 
      open
    >
      <div class="flex flex-col max-h-[90vh]">
        <div class="flex items-center justify-between border-b border-border px-6 py-4">
          <h2 class="text-lg font-semibold">Add AI Provider</h2>
          <Button variant="ghost" size="icon-sm" onclick={handleCloseModal}>
            <Plus class="h-4 w-4 rotate-45" />
          </Button>
        </div>
        <div class="flex-1 overflow-y-auto p-6">
          <PresetSelector
            presets={store.presets}
            selectedPreset={null}
            onSelect={handleAddFromPreset}
            onCustom={handleAddCustom}
          />
        </div>
      </div>
    </dialog>
    </div>
  {:else}
    <DynamicProviderModal
      open={true}
      presets={store.presets}
      initialConfig={editingProvider}
      isLoading={store.isSaving}
      onSubmit={handleSubmit}
      onClose={handleCloseModal}
    />
  {/if}
{/if}
