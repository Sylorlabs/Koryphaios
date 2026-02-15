<script lang="ts">
  import { Send, ChevronDown, Brain, Sparkles } from 'lucide-svelte';
  import { wsStore } from '$lib/stores/websocket.svelte';
  import { getReasoningConfig, hasReasoningSupport, getDefaultReasoning } from '@koryphaios/shared';

  interface Props {
    onSend: (message: string) => void;
    inputRef?: HTMLTextAreaElement;
  }

  let { onSend, inputRef = $bindable() }: Props = $props();
  let input = $state('');
  let showModelPicker = $state(false);
  let selectedModel = $state<string>('auto');
  
  // Reasoning state - now tracks provider AND model
  let reasoningEffort = $state('medium');
  let showReasoningMenu = $state(false);

  // Extract provider and model from selection
  let currentProvider = $derived(() => {
    if (selectedModel === 'auto') return 'anthropic';
    const parts = selectedModel.split(':');
    return parts[0] || 'anthropic';
  });

  let currentModel = $derived(() => {
    if (selectedModel === 'auto') return undefined;
    const parts = selectedModel.split(':');
    return parts[1];
  });

  // Get reasoning config based on provider + model
  let reasoningConfig = $derived(getReasoningConfig(currentProvider(), currentModel()));
  let reasoningSupported = $derived(hasReasoningSupport(currentProvider(), currentModel()));

  // Update reasoning when model changes
  $effect(() => {
    const config = getReasoningConfig(currentProvider(), currentModel());
    if (config) {
      reasoningEffort = config.defaultValue;
    }
  });

  let availableModels = $derived(() => {
    const models: Array<{ label: string; value: string; provider: string }> = [
      { label: 'Auto (Kory decides)', value: 'auto', provider: '' },
    ];
    for (const p of wsStore.providers) {
      if (p.authenticated) {
        for (const m of p.models) {
          models.push({ label: m, value: `${p.name}:${m}`, provider: p.name });
        }
      }
    }
    return models;
  });

  function handleKeydown(e: KeyboardEvent) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  }

  function send() {
    const trimmed = input.trim();
    if (!trimmed) return;
    onSend(trimmed);
    input = '';
    if (inputRef) inputRef.style.height = 'auto';
  }

  function autoResize() {
    if (!inputRef) return;
    inputRef.style.height = 'auto';
    inputRef.style.height = Math.min(inputRef.scrollHeight, 200) + 'px';
  }

  function selectModel(value: string) {
    selectedModel = value;
    showModelPicker = false;
    // Reasoning will auto-update via $effect
  }

  function selectReasoning(value: string) {
    reasoningEffort = value;
    showReasoningMenu = false;
  }

  function linesFor(value: string) {
    switch (value) {
      case 'low': return 1;
      case 'medium': return 3;
      case 'high': return 5;
      default: return 3;
    }
  }

  function handleClickOutside(e: MouseEvent) {
    const target = e.target as HTMLElement;
    if (!target.closest('.model-picker')) showModelPicker = false;
    if (!target.closest('.reasoning-picker')) showReasoningMenu = false;
  }
</script>

<svelte:window onclick={handleClickOutside} />

<div class="command-input px-4 py-3">
  <!-- Controls row: Model picker + Reasoning toggle -->
  <div class="flex items-center gap-3 mb-3">
    <!-- Model selector -->
    <div class="relative model-picker">
      <button
        class="flex items-center gap-2 px-3 py-2 rounded-lg text-sm font-medium transition-all hover:brightness-110 active:scale-[0.98]"
        style="background: var(--color-surface-3); color: var(--color-text-primary); border: 1px solid var(--color-border);"
        onclick={() => showModelPicker = !showModelPicker}
      >
        <Sparkles size={16} class="text-amber-400" />
        <span>{selectedModel === 'auto' ? 'Auto' : selectedModel.split(':').pop()}</span>
        <ChevronDown size={14} class="text-text-muted" />
      </button>

      {#if showModelPicker}
        <div
          class="absolute bottom-full left-0 mb-2 w-72 max-h-60 overflow-y-auto rounded-lg border shadow-2xl z-50"
          style="background: var(--color-surface-2); border-color: var(--color-border);"
        >
          {#each availableModels() as model}
            <button
              class="w-full text-left px-4 py-2.5 text-sm transition-colors hover:bg-[var(--color-surface-3)] {selectedModel === model.value ? 'text-[var(--color-accent)]' : ''}"
              style="color: {selectedModel === model.value ? 'var(--color-accent)' : 'var(--color-text-secondary)'};"
              onclick={() => selectModel(model.value)}
            >
              <span>{model.label}</span>
              {#if model.provider}
                <span class="text-xs ml-2 opacity-60" style="color: var(--color-text-muted);">({model.provider})</span>
              {/if}
            </button>
          {/each}
        </div>
      {/if}
    </div>

    <!-- Reasoning toggle - shows/hides based on provider+model -->
    {#if reasoningSupported && reasoningConfig}
      <div class="relative reasoning-picker">
        <button
          class="flex items-center gap-2 px-3 py-2 rounded-lg text-sm font-medium transition-all hover:brightness-110 active:scale-[0.98]"
          style="background: var(--color-surface-3); color: var(--color-text-primary); border: 1px solid var(--color-border);"
          onclick={() => showReasoningMenu = !showReasoningMenu}
          title="Set reasoning effort"
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" class="text-purple-400">
            <circle cx="12" cy="12" r="7" />
            {#each Array(linesFor(reasoningEffort)) as _, i}
              <line x1="7.5" x2="16.5" y1={12 + (i - (linesFor(reasoningEffort)-1)/2)*2.6} y2={12 + (i - (linesFor(reasoningEffort)-1)/2)*2.6} />
            {/each}
          </svg>
          <span class="capitalize">{reasoningEffort}</span>
          <ChevronDown size={14} class="text-text-muted" />
        </button>

        {#if showReasoningMenu}
          <div
            class="absolute bottom-full left-0 mb-2 w-64 rounded-lg border shadow-2xl z-50 overflow-hidden"
            style="background: var(--color-surface-2); border-color: var(--color-border);"
          >
            <div class="px-4 py-2.5 text-xs font-semibold uppercase tracking-wide" style="color: var(--color-text-muted); border-bottom: 1px solid var(--color-border);">
              {currentModel() || currentProvider()} · Reasoning
            </div>
            {#each reasoningConfig.options as opt}
              <button
                class="w-full text-left px-4 py-2.5 text-sm transition-colors hover:bg-[var(--color-surface-3)] {reasoningEffort === opt.value ? 'text-[var(--color-accent)]' : ''}"
                style="color: {reasoningEffort === opt.value ? 'var(--color-accent)' : 'var(--color-text-secondary)'};"
                onclick={() => selectReasoning(opt.value)}
              >
                <span class="font-semibold">{opt.label}</span>
                <span class="ml-2 opacity-70" style="color: var(--color-text-muted);">— {opt.description}</span>
              </button>
            {/each}
          </div>
        {/if}
      </div>
    {/if}
  </div>

  <!-- Input area -->
  <div class="flex gap-3">
    <textarea
      bind:this={inputRef}
      bind:value={input}
      oninput={autoResize}
      onkeydown={handleKeydown}
      placeholder="Describe what you want to build..."
      rows="1"
      class="input flex-1"
      style="resize: none; min-height: 52px; max-height: 200px; font-size: 15px; padding: 14px 16px;"
    ></textarea>
    <button
      onclick={send}
      disabled={!input.trim()}
      class="btn btn-primary self-end flex items-center justify-center gap-2"
      style="min-width: 80px; height: 52px; padding: 0 20px; font-size: 14px; font-semibold;"
    >
      <Send size={18} />
      Send
    </button>
  </div>

  <div class="flex items-center justify-between mt-2">
    <span class="text-xs" style="color: var(--color-text-muted);">Enter to send · Shift+Enter for new line</span>
    {#if input.length > 0}
      <span class="text-xs" style="color: var(--color-text-muted);">{input.length} chars</span>
    {/if}
  </div>
</div>
