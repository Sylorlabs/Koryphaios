<script lang="ts">
  import { onDestroy } from 'svelte';
  import { wsStore } from '$lib/stores/websocket.svelte';
  import { theme } from '$lib/stores/theme.svelte';
  import { toastStore } from '$lib/stores/toast.svelte';
  import {
    Key,
    Palette,
    Keyboard,
    Check,
    Copy,
    Zap,
    Server,
    Globe,
    Cpu,
    X,
  } from 'lucide-svelte';
  import ProviderIcon from './icons/ProviderIcon.svelte';
  import ModelSelectionDialog from './ModelSelectionDialog.svelte';

  interface Props {
    open?: boolean;
    onClose?: () => void;
  }

  let { open = false, onClose }: Props = $props();
  let activeTab = $state<'providers' | 'appearance' | 'shortcuts'>('providers');

  let showModelSelector = $state(false);
  let selectorTarget = $state<any>(null);

  function handleKeydown(e: KeyboardEvent) {
    if (e.key === 'Escape' && open && onClose) onClose();
  }

  // ─── Provider Management ──────────────────────────────────────────────
  const providerCategories = [
    {
      label: 'Frontier',
      icon: Zap,
      providers: [
        { key: 'anthropic', label: 'Anthropic', placeholder: 'sk-ant-...' },
        { key: 'openai', label: 'OpenAI', placeholder: 'sk-...' },
        { key: 'google', label: 'Google', placeholder: 'AIza...' },
        { key: 'xai', label: 'xAI', placeholder: 'xai-...' },
      ],
    },
    {
      label: 'Aggregators',
      icon: Globe,
      providers: [
        { key: 'openrouter', label: 'OpenRouter', placeholder: 'sk-or-...' },
        { key: 'copilot', label: 'GitHub Copilot', placeholder: 'gho_...' },
        { key: 'groq', label: 'Groq', placeholder: 'gsk_...' },
      ],
    },
    {
      label: 'Enterprise',
      icon: Server,
      providers: [
        { key: 'azure', label: 'Azure OpenAI', placeholder: 'key...', needsUrl: true },
        { key: 'bedrock', label: 'AWS Bedrock', placeholder: 'AKIA...' },
        { key: 'vertexai', label: 'Vertex AI', placeholder: '/path/to/creds.json' },
      ],
    },
    {
      label: 'Local',
      icon: Cpu,
      providers: [
        { key: 'local', label: 'Local/Ollama', placeholder: 'http://localhost:1234', needsUrl: true },
      ],
    },
  ];

  let expandedProvider = $state<string | null>(null);
  let keyInputs = $state<Record<string, string>>({});
  let tokenInputs = $state<Record<string, string>>({});
  let urlInputs = $state<Record<string, string>>({});
  let saving = $state<string | null>(null);
  let copiedEndpoint = $state(false);
  const authPortalUrls: Record<string, string> = {
    anthropic: 'https://claude.ai/code',
    bedrock: 'https://signin.aws.amazon.com/',
    vertexai: 'https://console.cloud.google.com/',
  };
  let copilotDeviceAuth = $state<{
    deviceCode: string;
    userCode: string;
    verificationUri: string;
    verificationUriComplete?: string;
    expiresAt: number;
    intervalMs: number;
  } | null>(null);
  let copilotAuthStatus = $state<'idle' | 'pending' | 'connected' | 'error'>('idle');
  let copilotAuthMessage = $state<string>('');
  let copilotPollTimer: ReturnType<typeof setTimeout> | null = null;

  // Auth mode for providers with multiple auth options
  let selectedAuthMode = $state<Record<string, string>>({});

  function getProviderCaps(name: string) {
    const status = getProviderStatus(name);
    if (status) return status;
    // Fallback to minimal defaults if not yet loaded
    return { 
      authMode: 'api_key' as string, 
      supportsApiKey: true, 
      supportsAuthToken: false, 
      requiresBaseUrl: false,
      enabled: false,
      authenticated: false,
      models: [] as string[],
      extraAuthModes: undefined as undefined | Array<{id: string; label: string}>,
    };
  }

  function getProviderStatus(name: string) {
    return wsStore.providers.find(p => p.name === name);
  }

  async function connectProvider(name: string) {
    const caps = getProviderCaps(name);
    const apiKey = keyInputs[name]?.trim();
    const authToken = tokenInputs[name]?.trim();
    const baseUrl = urlInputs[name]?.trim();
    const authMode = selectedAuthMode[name];

    // Handle special CLI auth modes
    if (authMode === 'codex' || authMode === 'cli' || authMode === 'claude_code') {
      saving = name;
      try {
        const res = await fetch(`/api/providers/${name}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ authMode }),
        });
        const data = await res.json();
        if (data.ok) {
          expandedProvider = null;
          const label = authMode === 'codex' ? 'Codex' : authMode === 'cli' ? 'Gemini' : 'Claude Code';
          toastStore.success(`${name} connected via ${label} CLI auth`);
        } else {
          toastStore.error(data.error ?? 'Connection failed');
        }
      } catch (err: any) {
        toastStore.error(err.message ?? 'Network error');
      } finally {
        saving = null;
      }
      return;
    }

    if (caps.authMode === 'api_key' && !apiKey) {
      toastStore.error('Enter API key');
      return;
    }
    if (caps.authMode === 'api_key_or_auth' && !apiKey && !authToken) {
      toastStore.error('Enter auth token or API key');
      return;
    }
    if (caps.authMode === 'base_url_only' && !baseUrl) {
      toastStore.error('Enter endpoint URL');
      return;
    }
    if (caps.authMode === 'env_auth') {
      // No typed secret input; backend verifies host environment credentials.
    }

    saving = name;
    try {
      const body: Record<string, string> = {};
      if (apiKey) body.apiKey = apiKey;
      if (authToken) body.authToken = authToken;
      if (baseUrl) body.baseUrl = baseUrl;
      const res = await fetch(`/api/providers/${name}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (data.ok) {
        keyInputs[name] = '';
        tokenInputs[name] = '';
        urlInputs[name] = '';
        expandedProvider = null;
        toastStore.success(`${name} connected`);

        // Wait a small bit for wsStore to update if needed, then check status
        setTimeout(() => {
          const status = getProviderStatus(name);
          if (status && !status.hideModelSelector && (status.allAvailableModels?.length ?? 0) > 0) {
            selectorTarget = status;
            showModelSelector = true;
          }
        }, 100);
      } else {
        toastStore.error(data.error ?? 'Connection failed');
      }
    } catch (err: any) {
      toastStore.error(err.message ?? 'Network error');
    } finally {
      saving = null;
    }
  }

  async function saveSelectedModels(selected: string[], hideSelector: boolean) {
    if (!selectorTarget) return;
    const name = selectorTarget.name;
    
    try {
      const res = await fetch(`/api/providers/${name}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ 
          selectedModels: selected,
          hideModelSelector: hideSelector
        }),
      });
      const data = await res.json();
      if (data.ok) {
        showModelSelector = false;
        selectorTarget = null;
        toastStore.success('Models updated');
      } else {
        toastStore.error(data.error ?? 'Failed to update models');
      }
    } catch (err: any) {
      toastStore.error(err.message ?? 'Network error');
    }
  }

  function openAuthPortal(name: string) {
    const url = authPortalUrls[name];
    if (!url) {
      toastStore.error('No auth portal configured for this provider');
      return;
    }
    window.open(url, '_blank', 'noopener,noreferrer');
  }

  function stopCopilotPolling() {
    if (copilotPollTimer) {
      clearTimeout(copilotPollTimer);
      copilotPollTimer = null;
    }
  }

  function scheduleCopilotPoll(delayMs: number) {
    stopCopilotPolling();
    copilotPollTimer = setTimeout(() => {
      void completeCopilotAuth(false);
    }, delayMs);
  }

  async function startCopilotAuth() {
    try {
      stopCopilotPolling();
      const res = await fetch('/api/providers/copilot/device/start', {
        method: 'POST',
      });
      const data = await res.json();
      if (!data.ok) {
        toastStore.error(data.error ?? 'Failed to start Copilot auth');
        return;
      }

      const p = data.data as {
        deviceCode: string;
        userCode: string;
        verificationUri: string;
        verificationUriComplete?: string;
        expiresIn: number;
        interval?: number;
      };
      copilotDeviceAuth = {
        deviceCode: p.deviceCode,
        userCode: p.userCode,
        verificationUri: p.verificationUri,
        verificationUriComplete: p.verificationUriComplete,
        expiresAt: Date.now() + p.expiresIn * 1000,
        intervalMs: Math.max(3, p.interval ?? 5) * 1000,
      };
      copilotAuthStatus = 'pending';
      copilotAuthMessage = 'Waiting for GitHub authorization...';

      const authUrl = p.verificationUriComplete ?? p.verificationUri;
      window.open(authUrl, '_blank', 'noopener,noreferrer');
      await navigator.clipboard.writeText(p.userCode);
      toastStore.success('Copilot code ready. It has been copied to clipboard.');
      scheduleCopilotPoll(1500);
    } catch (err: any) {
      copilotAuthStatus = 'error';
      copilotAuthMessage = err.message ?? 'Failed to start Copilot auth';
      toastStore.error(err.message ?? 'Failed to start Copilot auth');
    }
  }

  async function completeCopilotAuth(manual = true) {
    if (!copilotDeviceAuth?.deviceCode) {
      toastStore.error('Start Copilot auth first');
      return;
    }
    const pollIntervalMs = copilotDeviceAuth.intervalMs;
    if (Date.now() > copilotDeviceAuth.expiresAt) {
      stopCopilotPolling();
      copilotAuthStatus = 'error';
      copilotAuthMessage = 'Device code expired. Start authorization again.';
      toastStore.error(copilotAuthMessage);
      return;
    }

    saving = 'copilot';
    try {
      const res = await fetch('/api/providers/copilot/device/poll', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ deviceCode: copilotDeviceAuth.deviceCode }),
      });
      const data = await res.json();
      if (!data.ok) {
        toastStore.error(data.error ?? 'Copilot auth failed');
        return;
      }

      const status = data.data?.status as string | undefined;
      if (status && status !== 'connected') {
        if (status === 'authorization_pending') {
          copilotAuthStatus = 'pending';
          copilotAuthMessage = 'Waiting for GitHub authorization...';
          scheduleCopilotPoll(pollIntervalMs);
        } else if (status === 'slow_down') {
          copilotAuthStatus = 'pending';
          copilotAuthMessage = 'GitHub asked to slow down. Retrying...';
          scheduleCopilotPoll(pollIntervalMs + 3000);
        } else if (status === 'expired_token') {
          stopCopilotPolling();
          copilotAuthStatus = 'error';
          copilotAuthMessage = 'Device code expired. Start authorization again.';
          toastStore.error(copilotAuthMessage);
        } else {
          stopCopilotPolling();
          copilotAuthStatus = 'error';
          copilotAuthMessage = data.data?.description ?? status;
          toastStore.error(copilotAuthMessage);
        }
        return;
      }

      stopCopilotPolling();
      copilotAuthStatus = 'connected';
      copilotAuthMessage = 'Authorized successfully.';
      copilotDeviceAuth = null;
      expandedProvider = null;
      toastStore.success('copilot connected');
    } catch (err: any) {
      if (manual) {
        toastStore.error(err.message ?? 'Copilot auth failed');
      } else {
        // keep polling on transient failures
        copilotAuthStatus = 'pending';
        copilotAuthMessage = 'Waiting for GitHub authorization...';
        scheduleCopilotPoll(pollIntervalMs);
      }
    } finally {
      saving = null;
    }
  }

  onDestroy(() => {
    stopCopilotPolling();
  });

  async function disconnectProvider(name: string) {
    try {
      await fetch(`/api/providers/${name}`, { method: 'DELETE' });
      toastStore.info(`${name} disconnected`);
    } catch {}
  }

  function copyEndpoint() {
    navigator.clipboard.writeText(`${window.location.protocol}//${window.location.host}`);
    copiedEndpoint = true;
    setTimeout(() => copiedEndpoint = false, 2000);
  }

  // ─── Keyboard Shortcuts (editable, persisted) ──────────────────────────
  interface Shortcut {
    id: string;
    keys: string[];
    action: string;
  }

  const defaultShortcuts: Shortcut[] = [
    { id: 'send', keys: ['Ctrl', 'Enter'], action: 'Send message' },
    { id: 'settings', keys: ['Ctrl', ','], action: 'Open settings' },
    { id: 'new_session', keys: ['Ctrl', 'N'], action: 'New session' },
    { id: 'focus_input', keys: ['Ctrl', 'K'], action: 'Focus input' },
    { id: 'close', keys: ['Esc'], action: 'Close dialogs' },
  ];

  function loadShortcuts(): Shortcut[] {
    try {
      const stored = localStorage.getItem('koryphaios-shortcuts');
      if (stored) return JSON.parse(stored);
    } catch {}
    return structuredClone(defaultShortcuts);
  }

  let shortcuts = $state<Shortcut[]>(loadShortcuts());
  let editingShortcutId = $state<string | null>(null);
  let capturedKeys = $state<string[]>([]);

  function startEditShortcut(id: string) {
    editingShortcutId = id;
    capturedKeys = [];
  }

  function handleShortcutKeydown(e: KeyboardEvent) {
    if (!editingShortcutId) return;
    e.preventDefault();
    e.stopPropagation();

    const keys: string[] = [];
    if (e.ctrlKey) keys.push('Ctrl');
    if (e.shiftKey) keys.push('Shift');
    if (e.altKey) keys.push('Alt');
    if (e.metaKey) keys.push('Meta');

    const key = e.key;
    if (!['Control', 'Shift', 'Alt', 'Meta'].includes(key)) {
      keys.push(key.length === 1 ? key.toUpperCase() : key);
    }

    if (keys.length === 0) return;
    capturedKeys = keys;

    // If a non-modifier key was pressed, commit the binding
    if (!['Control', 'Shift', 'Alt', 'Meta'].includes(key)) {
      const idx = shortcuts.findIndex(s => s.id === editingShortcutId);
      if (idx >= 0) {
        shortcuts[idx] = { ...shortcuts[idx], keys: capturedKeys };
        shortcuts = [...shortcuts];
        localStorage.setItem('koryphaios-shortcuts', JSON.stringify(shortcuts));
      }
      editingShortcutId = null;
      capturedKeys = [];
    }
  }

  function resetShortcuts() {
    shortcuts = structuredClone(defaultShortcuts);
    localStorage.removeItem('koryphaios-shortcuts');
    toastStore.info('Shortcuts reset to defaults');
  }
</script>

<svelte:window onkeydown={(e) => { if (editingShortcutId) handleShortcutKeydown(e); else handleKeydown(e); }} />

{#if open}
  <!-- Backdrop -->
  <div
    class="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm flex items-center justify-center"
    onclick={onClose}
    onkeydown={(e) => { if (e.key === 'Escape' && onClose) onClose(); }}
    role="presentation"
  >
    <!-- Modal -->
    <div
      class="relative w-[90vw] max-w-3xl max-h-[85vh] rounded-2xl shadow-2xl flex flex-col overflow-hidden"
      style="background: var(--color-surface-1); border: 1px solid var(--color-border);"
      onclick={(e) => e.stopPropagation()}
      onkeydown={(e) => { if (!editingShortcutId) e.stopPropagation(); }}
      role="dialog"
      aria-modal="true"
      aria-labelledby="settings-title"
      tabindex="-1"
    >
      <!-- Header -->
      <div class="flex items-center justify-between px-6 py-4 shrink-0" style="border-bottom: 1px solid var(--color-border);">
        <h2 id="settings-title" class="text-base font-semibold" style="color: var(--color-text-primary);">Settings</h2>
        <button
          class="p-1.5 rounded-lg transition-colors hover:bg-[var(--color-surface-3)]"
          style="color: var(--color-text-muted);"
          onclick={onClose}
          aria-label="Close"
        >
          <X size={18} />
        </button>
      </div>

      <!-- Tab bar -->
      <div class="flex gap-1 mx-6 mt-4 p-1 rounded-lg shrink-0" style="background: var(--color-surface-0);">
        <button
          class="flex-1 flex items-center justify-center gap-1.5 py-2 text-xs rounded-md transition-colors
                 {activeTab === 'providers' ? 'bg-[var(--color-surface-3)] text-[var(--color-text-primary)] font-medium' : 'text-[var(--color-text-muted)] hover:text-[var(--color-text-secondary)]'}"
          onclick={() => activeTab = 'providers'}
        >
          <Key size={13} /> Providers
        </button>
        <button
          class="flex-1 flex items-center justify-center gap-1.5 py-2 text-xs rounded-md transition-colors
                 {activeTab === 'appearance' ? 'bg-[var(--color-surface-3)] text-[var(--color-text-primary)] font-medium' : 'text-[var(--color-text-muted)] hover:text-[var(--color-text-secondary)]'}"
          onclick={() => activeTab = 'appearance'}
        >
          <Palette size={13} /> Theme
        </button>
        <button
          class="flex-1 flex items-center justify-center gap-1.5 py-2 text-xs rounded-md transition-colors
                 {activeTab === 'shortcuts' ? 'bg-[var(--color-surface-3)] text-[var(--color-text-primary)] font-medium' : 'text-[var(--color-text-muted)] hover:text-[var(--color-text-secondary)]'}"
          onclick={() => activeTab = 'shortcuts'}
        >
          <Keyboard size={13} /> Keys
        </button>
      </div>

      <!-- Content (scrollable) -->
      <div class="flex-1 overflow-y-auto px-6 py-5">

  {#if activeTab === 'providers'}
    <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
    {#each providerCategories as category}
      {@const CategoryIcon = category.icon}
      <div>
        <div class="flex items-center gap-1.5 mb-2 px-1">
          <CategoryIcon size={12} style="color: var(--color-text-muted);" />
          <span class="text-[10px] font-medium uppercase tracking-wider" style="color: var(--color-text-muted);">
            {category.label}
          </span>
        </div>
        <div class="space-y-0.5">
          {#each category.providers as prov}
            {@const status = getProviderStatus(prov.key)}
            {@const caps = getProviderCaps(prov.key)}
            <div class="rounded-lg transition-colors {expandedProvider === prov.key ? 'bg-[var(--color-surface-3)]' : 'hover:bg-[var(--color-surface-2)]'}">
              <button
                onclick={() => { expandedProvider = expandedProvider === prov.key ? null : prov.key; }}
                class="w-full flex items-center justify-between py-2 px-2.5 text-left"
              >
                <div class="flex items-center gap-2">
                  <ProviderIcon provider={prov.key} size={16} />
                  <span class="text-xs font-medium" style="color: var(--color-text-primary);">{prov.label}</span>
                </div>
                <div class="flex items-center gap-1.5">
                  {#if status?.authenticated}
                    <span class="w-1.5 h-1.5 rounded-full bg-emerald-500"></span>
                    <span class="text-[10px]" style="color: var(--color-text-muted);">{status.models.length} models</span>
                  {:else if status?.enabled}
                    <span class="w-1.5 h-1.5 rounded-full bg-amber-500"></span>
                    <span class="text-[10px] text-amber-400">needs auth</span>
                  {:else}
                    <span class="w-1.5 h-1.5 rounded-full" style="background: var(--color-surface-4);"></span>
                  {/if}
                </div>
              </button>

              {#if expandedProvider === prov.key}
                <div class="px-2.5 pb-2.5 space-y-2">
                  {#if status?.authenticated}
                    <div class="flex items-center justify-between">
                      <div class="flex items-center gap-2">
                        <span class="text-[10px] text-emerald-400 font-medium flex items-center gap-1"><Check size={10} /> Connected</span>
                        <button 
                          onclick={() => { selectorTarget = status; showModelSelector = true; }}
                          class="text-[10px] opacity-60 hover:opacity-100 underline decoration-dotted underline-offset-2"
                        >
                          Manage Models
                        </button>
                      </div>
                      <button
                        onclick={() => disconnectProvider(prov.key)}
                        class="text-[10px] text-red-400 hover:text-red-300 transition-colors"
                      >
                        Disconnect
                      </button>
                    </div>
                    <!-- Model list -->
                    <div class="space-y-0.5 mt-1">
                      {#each status.models as model}
                        <div class="flex items-center justify-between px-2 py-1 rounded" style="background: var(--color-surface-2);">
                          <span class="text-[11px]" style="color: var(--color-text-secondary);">{model}</span>
                        </div>
                      {/each}
                    </div>
                  {:else}
                    <!-- Auth mode selector for providers with multiple auth options -->
                      {#if caps.extraAuthModes}
                        <div class="flex gap-1 p-0.5 rounded-md mb-2" style="background: var(--color-surface-2);">
                          {#each caps.extraAuthModes as mode}
                            <button
                              class="flex-1 text-[10px] py-1 rounded transition-colors
                                     {(selectedAuthMode[prov.key] ?? caps.extraAuthModes[0].id) === mode.id
                                       ? 'bg-[var(--color-surface-4)] text-[var(--color-text-primary)] font-medium'
                                       : 'text-[var(--color-text-muted)]'}"
                              onclick={() => { selectedAuthMode[prov.key] = mode.id; selectedAuthMode = {...selectedAuthMode}; }}
                            >
                              {mode.label}
                            </button>
                          {/each}
                        </div>
                        {@const currentMode = selectedAuthMode[prov.key] ?? caps.extraAuthModes[0].id}
                        {#if currentMode === 'codex'}
                          <div class="text-[10px] mb-1" style="color: var(--color-text-muted);">
                            Uses existing Codex CLI session. Run <code class="px-1 py-0.5 rounded" style="background: var(--color-surface-3);">codex auth</code> first.
                          </div>
                          <button
                            onclick={() => connectProvider(prov.key)}
                            disabled={saving === prov.key}
                            class="btn btn-primary w-full"
                          >
                            {saving === prov.key ? 'Verifying...' : 'Verify Codex Auth'}
                          </button>
                        {:else if currentMode === 'claude_code'}
                          <div class="text-[10px] mb-1" style="color: var(--color-text-muted);">
                            Uses existing Claude Code session. Run <code class="px-1 py-0.5 rounded" style="background: var(--color-surface-3);">claude auth</code> first.
                          </div>
                          <div class="flex gap-2">
                            <button
                              onclick={() => openAuthPortal(prov.key)}
                              class="btn btn-secondary flex-1"
                            >
                              Claude Website
                            </button>
                            <button
                              onclick={() => connectProvider(prov.key)}
                              disabled={saving === prov.key}
                              class="btn btn-primary flex-1"
                            >
                              {saving === prov.key ? 'Verifying...' : 'Verify'}
                            </button>
                          </div>
                        {:else if currentMode === 'cli'}
                          <div class="text-[10px] mb-1" style="color: var(--color-text-muted);">
                            Uses existing Gemini CLI session. Run <code class="px-1 py-0.5 rounded" style="background: var(--color-surface-3);">gemini auth</code> first.
                          </div>
                          <button
                            onclick={() => connectProvider(prov.key)}
                            disabled={saving === prov.key}
                            class="btn btn-primary w-full"
                          >
                            {saving === prov.key ? 'Verifying...' : 'Verify Gemini CLI Auth'}
                          </button>
                        {:else}
                        <!-- Standard API key input -->
                        <input
                          type="password"
                          placeholder={prov.placeholder}
                          bind:value={keyInputs[prov.key]}
                          onkeydown={(e) => { if (e.key === 'Enter') connectProvider(prov.key); }}
                          class="input"
                          style="font-size: 12px;"
                        />
                        <button
                          onclick={() => connectProvider(prov.key)}
                          disabled={saving === prov.key}
                          class="btn btn-primary w-full"
                        >
                          {saving === prov.key ? 'Connecting...' : 'Connect'}
                        </button>
                      {/if}
                    {:else}
                      <!-- Providers without multi-auth-mode -->
                      {#if caps.supportsApiKey}
                        <input
                          type="password"
                          placeholder={prov.placeholder}
                          bind:value={keyInputs[prov.key]}
                          onkeydown={(e) => { if (e.key === 'Enter') connectProvider(prov.key); }}
                          class="input"
                          style="font-size: 12px;"
                        />
                      {/if}
                      {#if caps.supportsAuthToken}
                        <input
                          type="password"
                          placeholder={caps.authMode === 'api_key_or_auth' ? 'Auth token (or use API key)' : 'Auth token'}
                          bind:value={tokenInputs[prov.key]}
                          onkeydown={(e) => { if (e.key === 'Enter') connectProvider(prov.key); }}
                          class="input"
                          style="font-size: 12px;"
                        />
                      {/if}
                      {#if caps.authMode === 'auth_only'}
                        <div class="text-[10px] mb-1" style="color: var(--color-text-muted);">
                          Authenticate in your browser, then verify the connection.
                        </div>
                        {#if prov.key === 'copilot'}
                          <button
                            onclick={startCopilotAuth}
                            class="btn btn-secondary w-full"
                          >
                            Authorize Copilot in Browser
                          </button>
                          {#if copilotDeviceAuth}
                            <div class="rounded-md px-2 py-2 mt-2" style="background: var(--color-surface-2);">
                              <div class="text-[10px] mb-1" style="color: var(--color-text-muted);">Enter this code on GitHub:</div>
                              <code class="text-xs font-semibold">{copilotDeviceAuth.userCode}</code>
                              {#if copilotAuthStatus !== 'idle'}
                                <div class="text-[10px] mt-2" style="color: var(--color-text-muted);">{copilotAuthMessage}</div>
                              {/if}
                            </div>
                            <button
                              onclick={() => completeCopilotAuth(true)}
                              disabled={saving === 'copilot'}
                              class="btn btn-primary w-full"
                            >
                              {saving === 'copilot' ? 'Checking...' : 'Complete Authorization'}
                            </button>
                          {/if}
                        {:else if authPortalUrls[prov.key]}
                          <button
                            onclick={() => openAuthPortal(prov.key)}
                            class="btn btn-secondary w-full"
                          >
                            Authenticate in Browser
                          </button>
                        {/if}
                      {/if}
                      {#if caps.requiresBaseUrl || prov.needsUrl}
                        <input
                          type="text"
                          placeholder="Endpoint URL"
                          bind:value={urlInputs[prov.key]}
                          class="input"
                          style="font-size: 12px;"
                        />
                      {/if}
                      {#if caps.authMode === 'env_auth'}
                        <div class="text-[10px]" style="color: var(--color-text-muted);">
                          Uses host environment auth ({prov.key === 'bedrock' ? 'AWS credentials/profile' : 'Vertex/Google credentials'}).
                        </div>
                      {/if}
                      {#if !(caps.authMode === 'auth_only' && prov.key === 'copilot')}
                        <button
                          onclick={() => connectProvider(prov.key)}
                          disabled={saving === prov.key}
                          class="btn btn-primary w-full"
                        >
                          {saving === prov.key ? 'Connecting...' : (caps.authMode === 'auth_only' || caps.authMode === 'env_auth' ? 'Verify Connection' : 'Connect')}
                        </button>
                      {/if}
                    {/if}
                  {/if}
                </div>
              {/if}
            </div>
          {/each}
        </div>
      </div>
    {/each}
    </div>

    <div class="pt-4 mt-4" style="border-top: 1px solid var(--color-border);">
      <p class="text-[10px] uppercase tracking-wider mb-2" style="color: var(--color-text-muted);">Server</p>
      <div class="flex items-center gap-2">
        <code class="flex-1 px-2 py-1.5 text-[11px] rounded-md" style="background: var(--color-surface-3);">
          {typeof window !== 'undefined' ? `${window.location.protocol}//${window.location.host}` : ''}
        </code>
        <button class="btn btn-secondary p-1.5" onclick={copyEndpoint}>
          {#if copiedEndpoint}<Check size={13} />{:else}<Copy size={13} />{/if}
        </button>
      </div>
    </div>

  {:else if activeTab === 'appearance'}
    <div class="space-y-6 max-w-lg">
      <div>
        <div class="text-xs font-medium mb-2 block" style="color: var(--color-text-secondary);">Theme Preset</div>
        <div class="grid grid-cols-3 gap-1.5">
          {#each theme.presets as preset}
            <button
              class="flex items-center gap-2 px-3 py-2 rounded-lg text-xs transition-all border
                     {theme.preset === preset.id
                       ? 'border-[var(--color-accent)] bg-[var(--color-accent)]/10 text-[var(--color-text-primary)]'
                       : 'border-transparent bg-[var(--color-surface-2)] text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-3)]'}"
              onclick={() => theme.setPreset(preset.id)}
            >
              {#if theme.preset === preset.id}
                <Check size={12} style="color: var(--color-accent);" />
              {/if}
              {preset.label}
            </button>
          {/each}
        </div>
      </div>

      <div>
        <div class="text-xs font-medium mb-2 block" style="color: var(--color-text-secondary);">Accent Color</div>
        <div class="flex gap-2">
          {#each theme.accents as accent}
            <button
              class="w-8 h-8 rounded-full border-2 transition-all flex items-center justify-center
                     {theme.accent === accent.id ? 'border-[var(--color-text-primary)] scale-110' : 'border-transparent hover:scale-105'}"
              style="background: {accent.color};"
              onclick={() => theme.setAccent(accent.id)}
              title={accent.label}
            >
              {#if theme.accent === accent.id}
                <Check size={14} style="color: var(--color-text-primary); filter: drop-shadow(0 0 2px rgba(0,0,0,0.5));" />
              {/if}
            </button>
          {/each}
        </div>
      </div>

      <div>
        <div class="text-xs font-medium mb-2 block" style="color: var(--color-text-secondary);">Font</div>
        <div class="space-y-1">
          {#each theme.fonts as font}
            <button
              class="w-full flex items-center justify-between px-3 py-2 rounded-lg text-xs transition-colors border
                     {theme.font === font.id
                       ? 'border-[var(--color-accent)] bg-[var(--color-accent)]/10'
                       : 'border-transparent bg-[var(--color-surface-2)] hover:bg-[var(--color-surface-3)]'}"
              onclick={() => theme.setFont(font.id)}
            >
              <span style="color: var(--color-text-primary);">{font.label}</span>
              {#if theme.font === font.id}
                <Check size={12} style="color: var(--color-accent);" />
              {/if}
            </button>
          {/each}
        </div>
      </div>
    </div>

  {:else if activeTab === 'shortcuts'}
    <div class="space-y-1.5 max-w-lg">
      <p class="text-[10px] mb-3" style="color: var(--color-text-muted);">
        Click a shortcut to rebind it. Press the new key combination to save.
      </p>
      {#each shortcuts as shortcut (shortcut.id)}
        <div
          class="flex items-center justify-between py-2 px-3 rounded-lg transition-colors cursor-pointer
                 {editingShortcutId === shortcut.id ? 'ring-1 ring-[var(--color-accent)]' : 'hover:bg-[var(--color-surface-3)]'}"
          style="background: var(--color-surface-2);"
          onclick={() => startEditShortcut(shortcut.id)}
          role="button"
          tabindex="0"
          onkeydown={(e) => { if (e.key === 'Enter') startEditShortcut(shortcut.id); }}
        >
          <span class="text-xs" style="color: var(--color-text-secondary);">{shortcut.action}</span>
          <div class="flex gap-1">
            {#if editingShortcutId === shortcut.id}
              {#if capturedKeys.length > 0}
                {#each capturedKeys as key}
                  <span class="kbd" style="color: var(--color-accent);">{key}</span>
                {/each}
              {:else}
                <span class="text-[10px] animate-pulse" style="color: var(--color-accent);">Press keys...</span>
              {/if}
            {:else}
              {#each shortcut.keys as key}
                <span class="kbd">{key}</span>
              {/each}
            {/if}
          </div>
        </div>
      {/each}
      <div class="pt-3">
        <button
          class="btn btn-secondary text-xs"
          onclick={resetShortcuts}
        >
          Reset to Defaults
        </button>
      </div>
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
    onClose={() => { showModelSelector = false; selectorTarget = null; }}
  />
{/if}
