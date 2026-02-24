<script lang="ts">
  import { Send, ChevronDown, Sparkles, Square } from 'lucide-svelte';
  import { wsStore } from '$lib/stores/websocket.svelte';
  import { shortcutStore } from '$lib/stores/shortcuts.svelte';
  import { getReasoningConfig, hasReasoningSupport } from '@koryphaios/shared';
  import BrainIcon from '$lib/components/icons/BrainIcon.svelte';

  interface Props {
    onSend: (message: string, model?: string, reasoningLevel?: string) => void;
    /** When true, show Stop instead of Send; clicking stops manager and workers for the session. */
    isRunning?: boolean;
    onStop?: () => void;
    inputRef?: HTMLTextAreaElement;
  }

  let { onSend, isRunning = false, onStop, inputRef = $bindable() }: Props = $props();
  let input = $state('');
  let showModelPicker = $state(false);
  let selectedModel = $state<string>('auto');

  function providerLabel(provider: string): string {
    if (provider === 'openai') return 'OpenAI';
    if (provider === 'codex') return 'Codex';
    if (provider === 'anthropic') return 'Anthropic';
    if (provider === 'google') return 'Google';
    if (provider === 'xai') return 'xAI';
    if (provider === 'openrouter') return 'OpenRouter';
    if (provider === 'vertexai') return 'Vertex AI';
    if (provider === 'copilot') return 'Copilot';
    return provider.charAt(0).toUpperCase() + provider.slice(1);
  }
  
  // Reasoning state - now tracks provider AND model
  let reasoningLevel = $state('medium');
  let showReasoningMenu = $state(false);

  function parseModelSelection(value: string): { provider?: string; model?: string } {
    if (value === 'auto') return {};
    const separator = value.indexOf(':');
    if (separator === -1) return {};
    return {
      provider: value.slice(0, separator),
      model: value.slice(separator + 1),
    };
  }

  let fallbackProvider = $derived(() => {
    const preferred = wsStore.providers.find((p) => p.enabled && p.authenticated);
    return preferred?.name ?? 'anthropic';
  });

  // Extract provider and model from selection. In auto mode, adapt to first available provider.
  let currentProvider = $derived(() => parseModelSelection(selectedModel).provider ?? fallbackProvider());
  let currentModel = $derived(() => parseModelSelection(selectedModel).model);

  // Get reasoning config based on provider + model
  let reasoningConfig = $derived(getReasoningConfig(currentProvider(), currentModel()));
  let reasoningSupported = $derived(hasReasoningSupport(currentProvider(), currentModel()));

  const hasNoProvider = $derived((wsStore.providers ?? []).filter((p) => p.authenticated).length === 0);

  let availableModels = $derived(() => {
    const models: Array<{ label: string; value: string; provider: string; isAuto?: boolean }> = [
      { label: 'Auto (Smart Selection)', value: 'auto', provider: '', isAuto: true },
    ];
    for (const p of wsStore.providers) {
      if (p.authenticated) {
        for (const m of p.models) {
          models.push({ label: `(${providerLabel(p.name)}) ${m}`, value: `${p.name}:${m}`, provider: p.name });
        }
      }
    }
    return models;
  });

  let selectedModelLabel = $derived(() => {
    if (selectedModel === 'auto') return 'Auto';
    const parsed = parseModelSelection(selectedModel);
    if (!parsed.model || !parsed.provider) return selectedModel;
    return `(${providerLabel(parsed.provider)}) ${parsed.model}`;
  });

  // Cooldown to prevent duplicate sends (double Enter, key repeat, double-click)
  const SEND_COOLDOWN_MS = 800;
  let lastSendAt = $state(0);

  function handleKeydown(e: KeyboardEvent) {
    if (e.repeat) return; // ignore key repeat (e.g. holding Enter)
    if (isRunning && shortcutStore.matches('send', e)) {
      e.preventDefault();
      stop();
      return;
    }
    if (shortcutStore.matches('send', e)) {
      e.preventDefault();
      send();
    } else if (e.key === 'Enter' && !e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey) {
      e.preventDefault();
      if (isRunning) stop();
      else send();
    }
  }

  function send() {
    const trimmed = input.trim();
    if (!trimmed) return;
    const now = Date.now();
    if (now - lastSendAt < SEND_COOLDOWN_MS) return; // debounce duplicate sends
    lastSendAt = now;
    onSend(trimmed, selectedModel, reasoningLevel);
    input = '';
    if (inputRef) inputRef.style.height = 'auto';
  }

  function stop() {
    onStop?.();
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
    reasoningLevel = value;
    showReasoningMenu = false;
  }

  function reasoningLabel(value: string): string {
    const config = getReasoningConfig(currentProvider(), currentModel());
    if (config) {
      const opt = config.options.find(o => o.value === value);
      if (opt) return opt.label;
    }
    return value;
  }

  let modelDisplayName = $derived(() => {
    if (selectedModel === 'auto') return 'Auto';
    const modelId = currentModel();
    if (!modelId) return currentProvider().charAt(0).toUpperCase() + currentProvider().slice(1);
    
    // Try to find in wsStore models if they have names, otherwise clean up the ID
    const provider = wsStore.providers.find(p => p.name === currentProvider());
    if (provider) {
      // If we had a model catalog on frontend we'd use it, for now prettify the ID
      return modelId.split('-').map((word: string) => word.charAt(0).toUpperCase() + word.slice(1)).join(' ');
    }
    return modelId;
  });

  function handleClickOutside(e: MouseEvent) {
    const target = e.target as HTMLElement;
    if (!target.closest('.model-picker')) showModelPicker = false;
    if (!target.closest('.reasoning-picker')) showReasoningMenu = false;
  }
</script>

<svelte:window onclick={handleClickOutside} />

<div class="command-input px-4 py-3">
  <!-- No provider: show error (Send still works; backend will return the same error) -->
  {#if hasNoProvider}
    <div class="mb-3 px-3 py-2.5 rounded-lg text-sm font-medium flex items-center gap-2" style="background: rgba(239, 68, 68, 0.12); border: 1px solid rgba(239, 68, 68, 0.35); color: var(--color-text-primary);">
      <span class="text-red-400">Error:</span>
      <span>No provider. No analyzing request. Add a provider in Settings.</span>
    </div>
  {/if}

  <!-- Controls row: Model picker + Reasoning toggle -->
  <div class="flex items-center gap-3 mb-3">
    <!-- Model selector -->
    <div class="relative model-picker">
      <button
        class="flex items-center gap-2 px-3 h-9 rounded-lg text-sm font-medium transition-all hover:brightness-110 active:scale-[0.98]"
        style="background: var(--color-surface-3); color: var(--color-text-primary); border: 1px solid var(--color-border);"
        onclick={() => showModelPicker = !showModelPicker}
      >
        <Sparkles size={16} class="text-amber-400" />
        <span>{selectedModelLabel()}</span>
        <ChevronDown size={14} class="text-text-muted" />
      </button>

      {#if showModelPicker}
        <div
          class="absolute bottom-full left-0 mb-2 w-72 max-h-60 overflow-y-auto rounded-lg border shadow-2xl z-50"
          style="background: var(--color-surface-2); border-color: var(--color-border);"
        >
          {#each availableModels() as model}
            <button
              class="w-full text-left px-4 py-2.5 text-sm transition-colors hover:bg-[var(--color-surface-3)] flex items-center gap-2 {selectedModel === model.value ? 'text-[var(--color-accent)]' : ''}"
              style="color: {selectedModel === model.value ? 'var(--color-accent)' : 'var(--color-text-secondary)'};"
              onclick={() => selectModel(model.value)}
            >
              {#if model.isAuto}
                <Sparkles size={14} class="text-amber-400 shrink-0" />
              {/if}
              <span>{model.label}</span>
            </button>
          {/each}
        </div>
      {/if}
    </div>

    <!-- Reasoning toggle - shows/hides based on provider+model -->
    {#if reasoningSupported && reasoningConfig}
      <div class="relative reasoning-picker">
        <button
          class="flex items-center gap-2 px-3 h-9 rounded-lg text-sm font-medium transition-all hover:brightness-110 active:scale-[0.98]"
          style="background: var(--color-surface-3); color: var(--color-text-primary); border: 1px solid var(--color-border);"
          onclick={() => showReasoningMenu = !showReasoningMenu}
          title="Set auto effort"
        >
          <BrainIcon {reasoningLevel} size={20} class="text-[#c890ab]" />
          <span>{reasoningLabel(reasoningLevel)}</span>
          <ChevronDown size={14} class="text-text-muted" />
        </button>

        {#if showReasoningMenu}
          <div
            class="absolute bottom-full left-0 mb-2 w-72 rounded-xl border shadow-2xl z-50 overflow-hidden backdrop-blur-md"
            style="background: var(--color-surface-2-alpha, rgba(30, 30, 35, 0.9)); border-color: var(--color-border);"
          >
            <div class="px-4 py-3 text-xs font-bold uppercase tracking-widest opacity-70" style="color: var(--color-text-muted); border-bottom: 1px solid var(--color-border); background: rgba(255,255,255,0.03);">
              {selectedModel === 'auto' ? 'Reasoning' : `${modelDisplayName()} · ${reasoningLabel(reasoningLevel)}`}
            </div>
            <div class="py-1">
              {#each reasoningConfig.options as opt}
                <button
                  class="w-full text-left px-4 py-3 transition-all hover:bg-[var(--color-surface-3)] group"
                  onclick={() => selectReasoning(opt.value)}
                >
                  <div class="flex items-center justify-between mb-0.5">
                    <span class="text-sm font-semibold {reasoningLevel === opt.value ? 'text-[var(--color-accent)]' : 'text-[var(--color-text-primary)]'}">
                      {opt.label}
                    </span>
                    {#if reasoningLevel === opt.value}
                      <div class="w-1.5 h-1.5 rounded-full bg-[var(--color-accent)] shadow-[0_0_8px_var(--color-accent)]"></div>
                    {/if}
                  </div>
                  <div class="text-[11px] leading-relaxed opacity-60 group-hover:opacity-100 transition-opacity" style="color: var(--color-text-muted);">
                    {opt.description}
                  </div>
                </button>
              {/each}
            </div>
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
      class:yolo-active={wsStore.isYoloMode}
      style="resize: none; min-height: 52px; max-height: 200px; font-size: 15px; padding: 14px 16px;"
    ></textarea>
    <button
      onclick={isRunning ? stop : send}
      disabled={!isRunning && !input.trim()}
      class="btn self-end flex items-center justify-center gap-2 {isRunning ? 'bg-red-500/90 hover:bg-red-500' : 'btn-primary'}"
      style="min-width: 80px; height: 52px; padding: 0 20px; font-size: 14px; font-weight: 600; {isRunning ? 'border: none; color: white;' : ''}"
    >
      {#if isRunning}
        <Square size={18} fill="currentColor" />
        Stop
      {:else}
        <Send size={18} />
        Send
      {/if}
    </button>
  </div>

  <div class="flex items-center justify-between mt-2">
    <span class="text-xs" style="color: var(--color-text-muted);">Enter to send · Shift+Enter for new line</span>
    {#if input.length > 0}
      <span class="text-xs" style="color: var(--color-text-muted);">{input.length} chars</span>
    {/if}
  </div>
</div>

<style>
  .yolo-active {
    border-color: #ef4444 !important;
    box-shadow: 0 0 0 1px #ef4444;
  }
</style>
