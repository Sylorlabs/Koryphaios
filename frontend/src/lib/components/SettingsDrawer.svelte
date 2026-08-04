<script lang="ts">
  import { onMount, tick } from 'svelte';
  import { slide, fade } from 'svelte/transition';
  import { wsStore } from '$lib/stores/websocket.svelte';
  import { theme } from '$lib/stores/theme.svelte';
  import { toastStore } from '$lib/stores/toast.svelte';
  import { autoInitStore } from '$lib/stores/auto-init.svelte';
  import { memoryStore } from '$lib/stores/memory.svelte';
  import { agentSettingsStore } from '$lib/stores/agent-settings.svelte';
  import { apiFetch, parseJsonResponse } from '$lib/api.svelte';
  import type { ProviderInfo } from '@koryphaios/shared';
  import type { ThemePreset } from '$lib/stores/theme.svelte';

  // Refresh providers from API when settings drawer opens
  $effect(() => {
    if (open) {
      wsStore.loadProvidersFromApi();
    }
  });
  import RulesBubble from './RulesBubble.svelte';
  import MemoryEditor from './MemoryEditor.svelte';
  import AgentSettings from './AgentSettings.svelte';
  import ModelSelectionDialog from './ModelSelectionDialog.svelte';
  import {
    Key, Palette, Keyboard, Check, Zap, Server, Globe, X, Brain, Bot,
    ChevronRight, Shield, Sparkles, ChevronDown, Loader2, Info
  } from 'lucide-svelte';

  interface Props {
    open?: boolean;
    onClose?: () => void;
  }

  let { open = false, onClose }: Props = $props();

  // Auto-initialization on mount
  onMount(() => {
    if (!autoInitStore.isInitialized && !autoInitStore.isLoading) {
      autoInitStore.initialize();
    }
  });

  // Tabs with rules as first-class section
  type TabId = 'rules' | 'providers' | 'appearance' | 'shortcuts' | 'memory' | 'agent';
  let activeTab = $state<TabId>('rules');

  const tabs = [
    { id: 'rules' as TabId, label: 'Rules', icon: Shield },
    { id: 'providers' as TabId, label: 'Providers', icon: Key },
    { id: 'appearance' as TabId, label: 'Appearance', icon: Palette },
    { id: 'shortcuts' as TabId, label: 'Shortcuts', icon: Keyboard },
    { id: 'memory' as TabId, label: 'Memory', icon: Brain },
    { id: 'agent' as TabId, label: 'Agent', icon: Bot },
  ];

  // Provider state
  let availableProviderTypes = $state<Array<{ name: string; authMode: string }>>([]);
  let expandedProvider = $state<string | null>(null);
  let showModelSelector = $state(false);
  let selectorTarget = $state<ProviderInfo | null>(null);
  let keyInputs: Record<string, string> = $state({});
  let saving = $state<string | null>(null);

  // Derive provider list from backend status
  const providerList = $derived.by(() => {
    const types = availableProviderTypes.length > 0 
      ? availableProviderTypes 
      : (wsStore.providers ?? []).map((p: any) => ({ 
          name: p.name, 
          authMode: p.authMode ?? 'api_key' 
        }));
    
    const labels: Record<string, string> = {
      anthropic: 'Anthropic', openai: 'OpenAI', google: 'Google',
      xai: 'xAI', groq: 'Groq', copilot: 'GitHub Copilot',
      azure: 'Azure', bedrock: 'AWS Bedrock', ollama: 'Ollama',
      deepseek: 'DeepSeek', openrouter: 'OpenRouter',
      opencodezen: 'OpenCode Zen'
    };

    return types.map((t: any) => ({
      key: t.name,
      label: labels[t.name] || t.name,
      authMode: t.authMode
    }));
  });

  $effect(() => {
    if (open && availableProviderTypes.length === 0) {
      loadAvailableProviders();
    }
  });

  async function loadAvailableProviders() {
    try {
      const res = await apiFetch('/api/providers/available');
      const data = await parseJsonResponse(res);
      if (data?.ok && Array.isArray(data.data)) {
        availableProviderTypes = data.data;
      }
    } catch {
      availableProviderTypes = [];
    }
  }

  async function connectProvider(name: string) {
    const key = keyInputs[name]?.trim();
    if (!key) {
      toastStore.error('Please enter an API key');
      return;
    }

    saving = name;
    try {
      const res = await apiFetch('/api/providers', {
        method: 'POST',
        body: JSON.stringify({ name, apiKey: key })
      });
      const data = await parseJsonResponse(res);
      
      if (data?.ok) {
        toastStore.success(`${name} connected successfully`);
        keyInputs[name] = '';
        expandedProvider = null;
        // Force refresh providers from API
        await wsStore.loadProvidersFromApi();
        const status = getProviderStatus(name);
        if (status && !status.hideModelSelector && status.allAvailableModels.length > 0) {
          selectorTarget = status;
          showModelSelector = true;
        }
      } else {
        throw new Error(data?.error || 'Connection failed');
      }
    } catch (err) {
      toastStore.error(err instanceof Error ? err.message : 'Failed to connect');
    } finally {
      saving = null;
    }
  }

  function getProviderStatus(name: string) {
    return wsStore.providers.find((p: any) => p.name === name);
  }

  function manageModels(provider: ProviderInfo) {
    selectorTarget = provider;
    showModelSelector = true;
  }

  async function saveSelectedModels(selectedModels: string[], hideModelSelector: boolean) {
    if (!selectorTarget) return;

    try {
      const res = await apiFetch(`/api/providers/${encodeURIComponent(selectorTarget.name)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ selectedModels, hideModelSelector })
      });
      const data = await parseJsonResponse(res);
      if (!data?.ok) throw new Error(data?.error || 'Failed to update models');

      showModelSelector = false;
      selectorTarget = null;
      await wsStore.loadProvidersFromApi();
      toastStore.success('Models updated');
    } catch (err) {
      toastStore.error(err instanceof Error ? err.message : 'Failed to update models');
    }
  }

  // Click outside to close
  function handleBackdropClick(e: MouseEvent) {
    if (e.target === e.currentTarget && onClose) {
      onClose();
    }
  }
</script>

{#if open}
  <!-- Backdrop -->
  <div
    class="fixed inset-0 bg-black/50 z-40 backdrop-blur-sm"
    onclick={handleBackdropClick}
    onkeydown={(e) => e.key === 'Escape' && onClose?.()}
    transition:fade={{ duration: 150 }}
    role="button"
    tabindex="-1"
    aria-label="Close settings"
  ></div>

  <!-- Drawer - Fixed size with internal scrolling -->
  <div
    class="fixed inset-y-4 right-4 w-full max-w-2xl z-50 flex flex-col rounded-2xl shadow-2xl overflow-hidden"
    style="background: var(--color-surface-0); border: 1px solid var(--color-border); max-height: calc(100vh - 2rem);"
    transition:slide={{ duration: 200, axis: 'x' }}
  >
    <!-- Header - Fixed -->
    <div 
      class="flex items-center justify-between px-6 py-4 border-b shrink-0"
      style="border-color: var(--color-border); background: var(--color-surface-1);"
    >
      <div class="flex items-center gap-3">
        <div 
          class="w-10 h-10 rounded-xl flex items-center justify-center"
          style="background: linear-gradient(135deg, var(--color-accent), var(--color-purple));"
        >
          <Sparkles size={20} class="text-white" />
        </div>
        <div>
          <h2 class="text-lg font-semibold" style="color: var(--color-text-primary);">Settings</h2>
          <p class="text-xs" style="color: var(--color-text-muted);">Configure Koryphaios your way</p>
        </div>
      </div>
      <button
        onclick={onClose}
        class="w-8 h-8 rounded-lg flex items-center justify-center transition-colors hover:bg-[var(--color-surface-3)]"
        style="color: var(--color-text-muted);"
      >
        <X size={18} />
      </button>
    </div>

    <!-- Auto-init Status - Fixed (collapsible) -->
    {#if autoInitStore.isLoading || autoInitStore.error}
      <div class="px-6 py-3 border-b shrink-0" style="border-color: var(--color-border); background: var(--color-surface-1);">
        <div class="flex items-center gap-3">
          {#if autoInitStore.isLoading}
            <Loader2 size={16} class="animate-spin" style="color: var(--color-accent);" />
            <span class="text-sm" style="color: var(--color-text-secondary);">
              {autoInitStore.steps.find(s => s.status === 'loading')?.name || 'Initializing...'}
            </span>
          {:else if autoInitStore.error}
            <Info size={16} style="color: var(--color-error);" />
            <span class="text-sm" style="color: var(--color-error);">{autoInitStore.error}</span>
            <button 
              onclick={() => autoInitStore.initialize()}
              class="text-xs px-2 py-1 rounded bg-[var(--color-surface-3)] hover:bg-[var(--color-surface-4)]"
            >
              Retry
            </button>
          {/if}
        </div>
        
        <!-- Progress dots -->
        {#if autoInitStore.isLoading}
          <div class="flex gap-1 mt-2">
            {#each autoInitStore.steps as step}
              <div 
                class="h-1 flex-1 rounded-full transition-colors"
                style="background: {step.status === 'complete' ? 'var(--color-success)' : step.status === 'loading' ? 'var(--color-accent)' : 'var(--color-surface-3)'};"
              ></div>
            {/each}
          </div>
        {/if}
      </div>
    {/if}

    <!-- Tabs - Fixed -->
    <div 
      class="flex gap-1 px-4 py-2 border-b overflow-x-auto shrink-0"
      style="border-color: var(--color-border); background: var(--color-surface-1);"
    >
      {#each tabs as tab}
        <button
          class="flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-all whitespace-nowrap"
          class:active={activeTab === tab.id}
          onclick={() => activeTab = tab.id}
        >
          <tab.icon size={16} />
          {tab.label}
        </button>
      {/each}
    </div>

    <!-- Content - Scrollable with fixed max-height -->
    <div class="flex-1 overflow-y-auto min-h-0">
      <div class="p-6">
        <!-- RULES TAB -->
        {#if activeTab === 'rules'}
          <div class="space-y-6" in:fade={{ duration: 150 }}>
            <div class="text-center mb-6">
              <h3 class="text-xl font-semibold mb-2" style="color: var(--color-text-primary);">
                How Koryphaios Works
              </h3>
              <p class="text-sm" style="color: var(--color-text-muted);">
                Click any bubble to learn more
              </p>
            </div>
            
            <RulesBubble />
            
            <!-- Quick tips -->
            <div 
              class="mt-8 p-4 rounded-xl border"
              style="border-color: var(--color-border); background: var(--color-surface-1);"
            >
              <h4 class="font-medium mb-3 flex items-center gap-2" style="color: var(--color-text-primary);">
                <Zap size={16} style="color: var(--color-accent);" />
                Quick Tips
              </h4>
              <ul class="space-y-2 text-sm" style="color: var(--color-text-secondary);">
                <li class="flex items-start gap-2">
                  <ChevronRight size={14} class="mt-0.5 shrink-0" />
                  <span>Start typing - no setup required</span>
                </li>
                <li class="flex items-start gap-2">
                  <ChevronRight size={14} class="mt-0.5 shrink-0" />
                  <span>Use @ to mention files or symbols</span>
                </li>
                <li class="flex items-start gap-2">
                  <ChevronRight size={14} class="mt-0.5 shrink-0" />
                  <span>Press Cmd/Ctrl+K for command palette</span>
                </li>
                <li class="flex items-start gap-2">
                  <ChevronRight size={14} class="mt-0.5 shrink-0" />
                  <span>YOLO mode skips confirmations (Cmd/Ctrl+Y)</span>
                </li>
              </ul>
            </div>
          </div>
        {/if}

        <!-- PROVIDERS TAB -->
        {#if activeTab === 'providers'}
          <div class="space-y-4" in:fade={{ duration: 150 }}>
            <div class="flex items-center justify-between">
              <h3 class="text-lg font-semibold" style="color: var(--color-text-primary);">AI Providers</h3>
              <span class="text-xs px-2 py-1 rounded-full" style="background: var(--color-surface-2); color: var(--color-text-muted);">
                {wsStore.providers.filter((p: any) => p.authenticated).length} connected
              </span>
            </div>

            <div class="space-y-2">
              {#each providerList as prov}
                {@const status = getProviderStatus(prov.key)}
                <div 
                  class="rounded-xl border overflow-hidden transition-all"
                  class:border-color-accent={expandedProvider === prov.key}
                  style="border-color: {expandedProvider === prov.key ? 'var(--color-accent)' : 'var(--color-border)'}; background: var(--color-surface-1);"
                >
                  <button
                    onclick={() => expandedProvider = expandedProvider === prov.key ? null : prov.key}
                    class="w-full flex items-center justify-between p-4 text-left hover:bg-[var(--color-surface-2)] transition-colors"
                  >
                    <div class="flex items-center gap-3">
                      <div 
                        class="w-2 h-2 rounded-full"
                        style="background: {status?.authenticated ? 'var(--color-success)' : 'var(--color-warning)'};"
                      ></div>
                      <span class="font-medium" style="color: var(--color-text-primary);">{prov.label}</span>
                    </div>
                    <ChevronDown 
                      size={18} 
                      style="color: var(--color-text-muted); transform: rotate({expandedProvider === prov.key ? '180deg' : '0deg'}); transition: transform 0.2s;"
                    />
                  </button>

                  {#if expandedProvider === prov.key}
                    <div class="px-4 pb-4 border-t" style="border-color: var(--color-border);" transition:slide={{ duration: 200 }}>
                      {#if status?.authenticated}
                        <div class="pt-4 flex items-center justify-between gap-3">
                          <div class="flex items-center gap-2">
                            <Check size={16} style="color: var(--color-success);" />
                            <span class="text-sm" style="color: var(--color-success);">Connected</span>
                            <span class="text-xs" style="color: var(--color-text-muted);">({status.models?.length || 0} models)</span>
                          </div>
                          <div class="flex items-center gap-2">
                            {#if status.allAvailableModels.length > 0}
                              <button
                                onclick={() => manageModels(status)}
                                class="text-xs px-3 py-1.5 rounded-lg transition-colors"
                                style="background: var(--color-surface-2); color: var(--color-text-secondary);"
                              >
                                Manage models
                              </button>
                            {/if}
                            <button
                              onclick={() => {/* disconnect */}}
                              class="text-xs px-3 py-1.5 rounded-lg text-red-400 hover:bg-red-400/10 transition-colors"
                            >
                              Disconnect
                            </button>
                          </div>
                        </div>
                      {:else}
                        <div class="pt-4 space-y-3">
                          <input
                            type="password"
                            placeholder="Enter API key..."
                            bind:value={keyInputs[prov.key]}
                            class="w-full px-3 py-2 rounded-lg border text-sm"
                            style="border-color: var(--color-border); background: var(--color-surface-0); color: var(--color-text-primary);"
                          />
                          <button
                            onclick={() => connectProvider(prov.key)}
                            disabled={saving === prov.key || !keyInputs[prov.key]?.trim()}
                            class="w-full py-2 rounded-lg text-sm font-medium transition-all"
                            style="background: var(--color-accent); color: white; opacity: {saving === prov.key || !keyInputs[prov.key]?.trim() ? '0.5' : '1'};"
                          >
                            {saving === prov.key ? 'Connecting...' : 'Connect'}
                          </button>
                        </div>
                      {/if}
                    </div>
                  {/if}
                </div>
              {/each}
            </div>
          </div>
        {/if}

        <!-- APPEARANCE TAB -->
        {#if activeTab === 'appearance'}
          <div class="space-y-6" in:fade={{ duration: 150 }}>
            <h3 class="text-lg font-semibold" style="color: var(--color-text-primary);">Appearance</h3>
            
            <div class="space-y-4">
              <div 
                class="p-4 rounded-xl border"
                style="border-color: var(--color-border); background: var(--color-surface-1);"
              >
                <span class="block text-sm font-medium mb-3" style="color: var(--color-text-primary);">Theme</span>
                <div class="grid grid-cols-3 gap-2">
                  {#each [
                    { id: 'light' as ThemePreset, label: 'Light' },
                    { id: 'kintsugi' as ThemePreset, label: 'Dark' },
                    { id: 'system' as ThemePreset, label: 'System' }
                  ] as option}
                    <button
                      class="px-4 py-2 rounded-lg text-sm border transition-all"
                      class:active={theme.preset === option.id}
                      style="border-color: {theme.preset === option.id ? 'var(--color-accent)' : 'var(--color-border)'}; background: {theme.preset === option.id ? 'var(--color-surface-3)' : 'var(--color-surface-0)'};"
                      onclick={() => theme.setPreset(option.id)}
                    >
                      {option.label}
                    </button>
                  {/each}
                </div>
              </div>
            </div>
          </div>
        {/if}

        <!-- SHORTCUTS TAB -->
        {#if activeTab === 'shortcuts'}
          <div class="space-y-6" in:fade={{ duration: 150 }}>
            <h3 class="text-lg font-semibold" style="color: var(--color-text-primary);">Keyboard Shortcuts</h3>
            
            <div class="grid gap-2">
              {#each [
                { key: 'Cmd/Ctrl + K', action: 'Command Palette' },
                { key: 'Cmd/Ctrl + ,', action: 'Settings' },
                { key: 'Cmd/Ctrl + N', action: 'New Session' },
                { key: 'Cmd/Ctrl + Y', action: 'Toggle YOLO Mode' },
                { key: 'Cmd/Ctrl + \\', action: 'Toggle Sidebar' },
                { key: 'Cmd/Ctrl + Shift + F', action: 'Focus Input' },
              ] as shortcut}
                <div 
                  class="flex items-center justify-between p-3 rounded-lg"
                  style="background: var(--color-surface-1);"
                >
                  <span class="text-sm" style="color: var(--color-text-secondary);">{shortcut.action}</span>
                  <kbd 
                    class="px-2 py-1 rounded text-xs font-mono"
                    style="background: var(--color-surface-3); color: var(--color-text-primary);"
                  >
                    {shortcut.key}
                  </kbd>
                </div>
              {/each}
            </div>
          </div>
        {/if}

        <!-- MEMORY TAB -->
        {#if activeTab === 'memory'}
          <div in:fade={{ duration: 150 }}>
            <MemoryEditor />
          </div>
        {/if}

        <!-- AGENT TAB -->
        {#if activeTab === 'agent'}
          <div in:fade={{ duration: 150 }}>
            <AgentSettings />
          </div>
        {/if}
      </div>
    </div>
  </div>
{/if}

{#if showModelSelector && selectorTarget}
  <ModelSelectionDialog
    providerName={selectorTarget.name}
    availableModels={selectorTarget.allAvailableModels}
    selectedModels={selectorTarget.selectedModels}
    onSave={saveSelectedModels}
    onClose={() => {
      showModelSelector = false;
      selectorTarget = null;
    }}
  />
{/if}

<style>
  button.active {
    background: var(--color-surface-3);
    color: var(--color-text-primary);
  }
  
  button:not(.active) {
    color: var(--color-text-muted);
  }
  
  button:not(.active):hover {
    background: var(--color-surface-2);
    color: var(--color-text-secondary);
  }

  /* Smooth scrollbar */
  .overflow-y-auto {
    scrollbar-width: thin;
    scrollbar-color: var(--color-surface-3) transparent;
  }
  
  .overflow-y-auto::-webkit-scrollbar {
    width: 6px;
  }
  
  .overflow-y-auto::-webkit-scrollbar-track {
    background: transparent;
  }
  
  .overflow-y-auto::-webkit-scrollbar-thumb {
    background: var(--color-surface-3);
    border-radius: 3px;
  }
  
  .overflow-y-auto::-webkit-scrollbar-thumb:hover {
    background: var(--color-surface-4);
  }
</style>
