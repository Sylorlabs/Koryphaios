<script lang="ts">
  import type { DynamicProviderConfig, ProviderPreset } from '@koryphaios/shared';
  import { X, Loader2 } from 'lucide-svelte';
  import DynamicProviderForm from './DynamicProviderForm.svelte';
  import Button from '$lib/components/ui/Button.svelte';

  interface Props {
    open: boolean;
    presets: ProviderPreset[];
    initialConfig?: Partial<DynamicProviderConfig>;
    isLoading?: boolean;
    onSubmit: (config: DynamicProviderConfig) => void;
    onClose: () => void;
  }

  let { 
    open, 
    presets, 
    initialConfig,
    isLoading = false,
    onSubmit, 
    onClose 
  }: Props = $props();

  let dialogEl: HTMLDialogElement | undefined = $state();

  $effect(() => {
    if (open) {
      dialogEl?.showModal();
    } else {
      dialogEl?.close();
    }
  });

  function handleClose() {
    if (!isLoading) {
      onClose();
    }
  }
</script>

<!-- svelte-ignore a11y_click_events_have_key_events -->
<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
<dialog 
  bind:this={dialogEl} 
  class="m-auto max-h-[90vh] w-full max-w-2xl overflow-hidden rounded-lg border border-border bg-background p-0 shadow-lg backdrop:bg-black/50"
  onclick={(e) => {
    if (e.target === dialogEl) handleClose();
  }}
>
  <div class="flex flex-col max-h-[90vh]">
    <!-- Header -->
    <div class="flex items-center justify-between border-b border-border px-6 py-4">
      <h2 class="text-lg font-semibold">
        {initialConfig?.name ? 'Edit Provider' : 'Add Dynamic Provider'}
      </h2>
      <Button variant="ghost" size="icon-sm" onclick={handleClose} disabled={isLoading}>
        <X class="h-4 w-4" />
      </Button>
    </div>

    <!-- Content -->
    <div class="flex-1 overflow-y-auto p-6">
      {#if isLoading}
        <div class="flex flex-col items-center justify-center py-12 gap-4">
          <Loader2 class="h-8 w-8 animate-spin text-primary" />
          <p class="text-sm text-muted-foreground">Saving provider...</p>
        </div>
      {:else}
        <DynamicProviderForm
          {presets}
          {initialConfig}
          onSubmit={onSubmit}
          onCancel={handleClose}
        />
      {/if}
    </div>
  </div>
</dialog>
