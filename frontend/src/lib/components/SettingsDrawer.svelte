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
    User,
    Shield,
    MessageCircle,
    Search,
    CreditCard,
    AlertTriangle,
  } from 'lucide-svelte';
  import ModelSelectionDialog from './ModelSelectionDialog.svelte';
  import { apiFetch, parseJsonResponse } from '$lib/api';

  interface Props {
    open?: boolean;
    onClose?: () => void;
  }

  let { open = false, onClose }: Props = $props();
  let activeTab = $state<'providers' | 'appearance' | 'shortcuts' | 'messaging' | 'billing'>('providers');

  let showModelSelector = $state(false);
  let selectorTarget = $state<any>(null);

  function handleKeydown(e: KeyboardEvent) {
    if (e.key === 'Escape' && open && onClose) onClose();
  }

  // ─── Provider Management ──────────────────────────────────────────────
  // Only show providers the user has authenticated (from backend). No hardcoded list.
  // Display labels for provider names (used when a provider appears in the list or in Add dropdown).
  const PROVIDER_LABELS: Record<string, string> = {
    anthropic: 'Anthropic', cline: 'Cline', openai: 'OpenAI', google: 'Google', xai: 'xAI',
    openrouter: 'OpenRouter', groq: 'Groq', copilot: 'GitHub Copilot', azure: 'Azure OpenAI',
    bedrock: 'AWS Bedrock', vertexai: 'Vertex AI', local: 'Local (custom endpoint)', ollama: 'Ollama',
    lmstudio: 'LM Studio', llamacpp: 'Llama.cpp', opencodezen: 'OpenCodeZen',
  };

  let availableProviderTypes = $state<Array<{ name: string; authMode: string }>>([]);

  function getProviderDisplayLabel(name: string): string {
    return PROVIDER_LABELS[name] ?? (name.charAt(0).toUpperCase() + name.slice(1));
  }

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

  // Build one clean list from all provider types (API). Status comes from wsStore per row.
  const providerList = $derived.by(() => {
    const types = availableProviderTypes.length > 0 ? availableProviderTypes : (wsStore.providers ?? []).map((p) => ({ name: p.name, authMode: (p as { authMode?: string }).authMode ?? 'api_key' }));
    
    // Provider label mappings
    const providerLabels: Record<string, string> = {
      anthropic: 'Anthropic',
      cline: 'Cline',
      openai: 'OpenAI',
      google: 'Google',
      xai: 'xAI',
      openrouter: 'OpenRouter',
      groq: 'Groq',
      copilot: 'GitHub Copilot',
      azure: 'Azure OpenAI',
      bedrock: 'AWS Bedrock',
      vertexai: 'Vertex AI',
      local: 'Local (custom endpoint)',
      ollama: 'Ollama',
      lmstudio: 'LM Studio',
      llamacpp: 'Llama.cpp',
      ollamacloud: 'Ollama Cloud',
      deepseek: 'DeepSeek',
      minimax: 'MiniMax',
      moonshot: 'Moonshot AI',
      zai: 'ZAI',
      cortecs: 'Cortecs',
      stepfun: 'StepFun',
      cerebras: 'Cerebras',
      fireworks: 'Fireworks AI',
      deepinfra: 'DeepInfra',
      ionet: 'IO.net',
      hyperbolic: 'Hyperbolic',
      huggingface: 'HuggingFace',
      replicate: 'Replicate',
      modal: 'Modal',
      vercel: 'Vercel',
      cloudflare: 'Cloudflare',
      cloudflareworkers: 'Cloudflare Workers',
      baseten: 'Baseten',
      helicone: 'Helicone',
      portkey: 'Portkey',
      scaleway: 'Scaleway',
      ovhcloud: 'OVHcloud',
      stackit: 'STACKIT',
      nebius: 'Nebius',
      togetherai: 'Together AI',
      venice: 'Venice AI',
      zenmux: 'ZenMux',
      opencodezen: 'OpenCodeZen',
      firmware: 'Firmware',
      '302ai': '302.ai',
      mistralai: 'Mistral AI',
      cohere: 'Cohere',
      perplexity: 'Perplexity',
      luma: 'Luma',
      fal: 'Fal',
      elevenlabs: 'ElevenLabs',
      assemblyai: 'AssemblyAI',
      deepgram: 'Deepgram',
      gladia: 'Gladia',
      lmnt: 'LMNT',
      azurecognitive: 'Azure Cognitive',
      sapai: 'SAP AI',
      gitlab: 'GitLab',
      nvidia: 'NVIDIA',
      nim: 'NIM',
      friendliai: 'FriendliAI',
      voyageai: 'VoyageAI',
      mixedbread: 'Mixedbread',
      mem0: 'Mem0',
      letta: 'Letta',
      qwen: 'Qwen',
      alibaba: 'Alibaba',
      chromeai: 'ChromeAI',
      requesty: 'Requesty',
      aihubmix: 'AIHubMix',
      aimlapi: 'AIMLAPI',
      blackforestlabs: 'Black Forest Labs',
      klingai: 'KlingAI',
      prodia: 'Prodia',

      antigravity: 'Antigravity',
      novita: 'Novita',
      banbri: 'Banbri',
    };

    // Provider placeholder mappings
    const providerPlaceholders: Record<string, string> = {
      anthropic: 'sk-ant-...',
      cline: 'Must have authed with CLI first',
      openai: 'sk-...',
      google: 'AIza...',
      xai: 'xai-...',
      openrouter: 'sk-or-...',

      groq: 'gsk_...',
      copilot: 'gho_...',
      azure: 'key...',
      bedrock: 'AKIA...',
      vertexai: '/path/to/creds.json',
      local: 'http://localhost:1234',
      ollama: 'http://localhost:11434',
      lmstudio: 'http://localhost:1234',
      llamacpp: 'http://localhost:8080',
      ollamacloud: 'sk-...',
      deepseek: 'sk-...',
      minimax: 'sk-...',
      moonshot: 'sk-...',
      zai: 'sk-...',
      cortecs: 'sk-...',
      stepfun: 'sk-...',
      cerebras: 'sk-...',
      fireworks: 'sk-...',
      deepinfra: 'sk-...',
      ionet: 'sk-...',
      hyperbolic: 'sk-...',
      huggingface: 'hf_...',
      replicate: 'r8_...',
      modal: 'md-...',
      vercel: '...',
      cloudflare: '...',
      cloudflareworkers: '...',
      baseten: '...',
      helicone: 'sk-...',
      portkey: 'sk-...',
      scaleway: 'scw_...',
      ovhcloud: 'ovh-...',
      stackit: '...',
      nebius: '',
      togetherai: 'sk-...',
      venice: 'sk-...',
      zenmux: 'sk-...',
      opencodezen: 'Get key at opencode.ai/auth',
      firmware: 'sk-...',
      '302ai': 'sk-...',
      mistralai: 'sk-...',
      cohere: 'sk-...',
      perplexity: 'pplx-...',
      luma: 'lm-...',
      fal: 'sk-...',
      elevenlabs: 'sk-...',
      assemblyai: 'sk-...',
      deepgram: 'sk-...',
      gladia: 'sk-...',
      lmnt: 'sk-...',
      azurecognitive: 'sk-...',
      sapai: 'sk-...',
      gitlab: 'glpat-...',
      nvidia: 'nvapi-...',
      nim: 'nvapi-...',
      friendliai: '',
      voyageai: 'sk-...',
      mixedbread: 'sk-...',
      mem0: 'm0-...',
      letta: 'lt-...',
      qwen: 'sk-...',
      alibaba: 'sk-...',
      chromeai: '',
      requesty: 'sk-...',
      aihubmix: 'sk-...',
      aimlapi: 'sk-...',
      blackforestlabs: 'sk-...',
      klingai: 'sk-...',
      prodia: 'sk-...',
  
      antigravity: 'sk-...',
      novita: 'sk-...',
      banbri: 'sk-...',
    };

    // Providers that require a base URL
    const providersNeedingUrl = new Set([
      'local', 'ollama', 'lmstudio', 'llamacpp', 'azure'
    ]);

    // One list: all provider types (from API), sorted — same nice list as before
    const providers = types.map((type) => ({
      key: type.name,
      label: providerLabels[type.name] || type.name.charAt(0).toUpperCase() + type.name.slice(1),
      placeholder: providerPlaceholders[type.name] || 'API key...',
      needsUrl: providersNeedingUrl.has(type.name),
    }));

    return providers.sort((a, b) => a.label.localeCompare(b.label));
  });

  $effect(() => {
    if (open && activeTab === 'providers' && availableProviderTypes.length === 0) {
      void loadAvailableProviders();
    }
  });

  let providerSearchQuery = $state('');
  const filteredProviderList = $derived.by(() => {
    const q = providerSearchQuery.trim().toLowerCase();
    if (!q) return providerList;
    return providerList.filter(
      (p) =>
        p.label.toLowerCase().includes(q) ||
        p.key.toLowerCase().includes(q)
    );
  });

  let expandedProvider = $state<string | null>(null);
  let keyInputs = $state<Record<string, string>>({});
  let tokenInputs = $state<Record<string, string>>({});
  let urlInputs = $state<Record<string, string>>({});
  let saving = $state<string | null>(null);
  let verifying = $state<string | null>(null);
  let copiedEndpoint = $state(false);
  const authPortalUrls: Record<string, string> = {
    anthropic: 'https://console.anthropic.com',

    bedrock: 'https://signin.aws.amazon.com/',
    vertexai: 'https://console.cloud.google.com/',

    opencodezen: 'https://opencode.ai/auth',
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

  // Antigravity (Google) OAuth: start → open URL → poll until backend saves
  let antigravityAuthId = $state<string | null>(null);
  let antigravityAuthStatus = $state<'idle' | 'pending' | 'connected' | 'error'>('idle');
  let antigravityAuthMessage = $state<string>('');
  let antigravityPollTimer: ReturnType<typeof setTimeout> | null = null;

  // Auth mode for providers with multiple auth options
  let selectedAuthMode = $state<Record<string, string>>({});

  function getProviderCaps(name: string) {
    const status = getProviderStatus(name);
    if (status) return status;
    // Provider not yet connected (e.g. "Add provider"): use type from available list
    const type = availableProviderTypes.find((t) => t.name === name);
    const authMode = type?.authMode ?? 'api_key';
    const extraAuthModes = name === 'google'
      ? [
          { id: 'api_key', label: 'API key' },
          { id: 'cli', label: 'Gemini CLI' },
          { id: 'antigravity', label: 'Antigravity' },
        ]
      : undefined;
    const requiresBaseUrl = authMode === 'base_url_only';
    return {
      authMode,
      supportsApiKey: authMode === 'api_key' || authMode === 'api_key_or_auth',
      supportsAuthToken: authMode === 'api_key_or_auth',
      requiresBaseUrl,
      baseUrlPlaceholder: requiresBaseUrl ? 'e.g. http://localhost:1234/v1' : undefined,
      enabled: false,
      authenticated: false,
      models: [] as string[],
      extraAuthModes: extraAuthModes as undefined | Array<{ id: string; label: string }>,
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

    // Handle Gemini CLI auth mode
    if (authMode === 'cli') {
      saving = name;
      try {
        const body: { authMode: string } = { authMode };
        const res = await apiFetch(`/api/providers/${name}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        const data = await parseJsonResponse(res);
        if (data.ok) {
          expandedProvider = null;
          toastStore.success(`${name} connected via Gemini CLI`);
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
      verifying = name;
      const res = await apiFetch(`/api/providers/${name}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      verifying = null;
      const data = await parseJsonResponse(res);
      if (data.ok) {
        keyInputs[name] = '';
        tokenInputs[name] = '';
        urlInputs[name] = '';
        expandedProvider = null;
        toastStore.success(`${name} connected ✓`);

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
      verifying = null;
    }
  }

  async function saveSelectedModels(selected: string[], hideSelector: boolean) {
    if (!selectorTarget) return;
    const name = selectorTarget.name;
    
    try {
      const res = await apiFetch(`/api/providers/${name}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ 
          selectedModels: selected,
          hideModelSelector: hideSelector
        }),
      });
      const data = await parseJsonResponse(res);
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

  function stopAntigravityPolling() {
    if (antigravityPollTimer) {
      clearTimeout(antigravityPollTimer);
      antigravityPollTimer = null;
    }
  }

  async function pollAntigravityAuth() {
    if (!antigravityAuthId) return;
    try {
      const res = await apiFetch(`/api/providers/google/auth/antigravity/poll?authId=${encodeURIComponent(antigravityAuthId)}`, { method: 'GET' });
      const data = await parseJsonResponse(res);
      if (data.ok && data.data?.success) {
        stopAntigravityPolling();
        antigravityAuthStatus = 'connected';
        antigravityAuthMessage = 'Authorized successfully.';
        antigravityAuthId = null;
        expandedProvider = null;
        toastStore.success('Google (Antigravity) connected');
        return;
      }
      if (!data.ok) {
        stopAntigravityPolling();
        antigravityAuthStatus = 'error';
        antigravityAuthMessage = data.error ?? 'Auth failed';
        toastStore.error(antigravityAuthMessage);
        return;
      }
      antigravityAuthMessage = 'Waiting for you to sign in in the browser...';
      antigravityPollTimer = setTimeout(pollAntigravityAuth, 2500);
    } catch (err: any) {
      antigravityAuthStatus = 'error';
      antigravityAuthMessage = err.message ?? 'Poll failed';
      toastStore.error(antigravityAuthMessage);
    }
  }

  async function startAntigravityAuth() {
    try {
      stopAntigravityPolling();
      antigravityAuthStatus = 'pending';
      antigravityAuthMessage = 'Opening sign-in page...';
      const res = await apiFetch('/api/providers/google/auth/antigravity', { method: 'POST' });
      const data = await parseJsonResponse(res);
      if (!data.ok) {
        antigravityAuthStatus = 'error';
        antigravityAuthMessage = data.error ?? 'Failed to start Antigravity auth';
        toastStore.error(antigravityAuthMessage);
        return;
      }
      const { url, authId } = data.data ?? {};
      if (!url || !authId) {
        antigravityAuthStatus = 'error';
        antigravityAuthMessage = 'No auth URL returned';
        toastStore.error(antigravityAuthMessage);
        return;
      }
      antigravityAuthId = authId;
      window.open(url, '_blank', 'noopener,noreferrer');
      antigravityAuthMessage = 'Waiting for you to sign in in the browser...';
      antigravityPollTimer = setTimeout(pollAntigravityAuth, 2500);
    } catch (err: any) {
      antigravityAuthStatus = 'error';
      antigravityAuthMessage = err.message ?? 'Failed to start auth';
      toastStore.error(antigravityAuthMessage);
    }
  }

  async function startGeminiCLIAuth() {
    try {
      const res = await apiFetch('/api/providers/google/auth/cli', { method: 'POST' });
      const data = await parseJsonResponse(res);
      if (!data.ok) {
        toastStore.error(data.error ?? 'Failed to start Gemini auth');
        return;
      }
      const url = data.data?.url;
      if (url) {
        window.open(url, '_blank', 'noopener,noreferrer');
        toastStore.success('Sign-in page opened. Complete sign-in, then click Verify below.');
      } else {
        toastStore.info(data.data?.message ?? 'Check your terminal for the sign-in link.');
      }
    } catch (err: any) {
      toastStore.error(err.message ?? 'Failed to start Gemini auth');
    }
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
      const res = await apiFetch('/api/providers/copilot/device/start', {
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
      const res = await apiFetch('/api/providers/copilot/device/poll', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ deviceCode: copilotDeviceAuth.deviceCode }),
      });
      const data = await parseJsonResponse(res);
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
    stopAntigravityPolling();
  });

  async function disconnectProvider(name: string) {
    try {
      await apiFetch(`/api/providers/${name}`, { method: 'DELETE' });
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

  // Messaging tab
  let messagingLoading = $state(false);
  let messagingSaving = $state(false);

  let billingLoading = $state(false);
  let billingData = $state<{
    localEstimate: { totalCostUsd: number; tokensIn: number; tokensOut: number; byModel: Array<{ model: string; costUsd: number; tokensIn: number; tokensOut: number }> };
    cloudReality: Array<{ source: string; ts: number; totalUsedUsd: number | null; totalGrantedUsd: number | null; totalAvailableUsd: number | null; payload: string }>;
    driftPercent: number | null;
    highlightDrift: boolean;
  } | null>(null);
  let billingError = $state<string | null>(null);
  let telegramEnabled = $state(false);
  let telegramAdminId = $state('');
  let telegramBotToken = $state('');
  let telegramBotTokenSet = $state(false);

  async function loadMessaging() {
    messagingLoading = true;
    try {
      const res = await apiFetch('/api/messaging');
      const data = await parseJsonResponse(res);
      if (data.ok && data.data) {
        const t = data.data.telegram;
        telegramEnabled = t?.enabled ?? false;
        telegramAdminId = t?.adminId ? String(t.adminId) : '';
        telegramBotTokenSet = t?.botTokenSet ?? false;
        if (!telegramBotTokenSet) telegramBotToken = '';
      }
    } catch {
      toastStore.error('Failed to load messaging config');
    } finally {
      messagingLoading = false;
    }
  }

  async function saveMessaging() {
    const adminId = parseInt(telegramAdminId, 10);
    if (telegramEnabled && !telegramBotToken.trim() && !telegramBotTokenSet) {
      toastStore.error('Bot token is required to enable Telegram');
      return;
    }
    if (telegramEnabled && (!Number.isFinite(adminId) || adminId <= 0)) {
      toastStore.error('Enter a valid Telegram user ID (positive number).');
      return;
    }
    messagingSaving = true;
    try {
      const body = {
        telegram: telegramEnabled && (telegramBotToken.trim() || telegramBotTokenSet) && Number.isFinite(adminId) && adminId > 0
          ? { botToken: telegramBotToken.trim() || undefined, adminId }
          : null,
      };
      if (body.telegram && !body.telegram.botToken && telegramBotTokenSet) {
        (body.telegram as Record<string, unknown>).botToken = undefined;
      }
      const res = await apiFetch('/api/messaging', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await parseJsonResponse(res);
      if (data.ok) {
        toastStore.success('Messaging config saved. Restart the server for Telegram changes to take effect.');
        void loadMessaging();
      } else {
        toastStore.error(data.error ?? 'Failed to save');
      }
    } catch (err: unknown) {
      toastStore.error(err instanceof Error ? err.message : 'Failed to save messaging config');
    } finally {
      messagingSaving = false;
    }
  }

  async function loadBillingCredits() {
    billingLoading = true;
    billingError = null;
    billingData = null;
    try {
      const res = await apiFetch('/api/billing/credits');
      if (!res.ok) {
        const err = await parseJsonResponse<{ error?: string }>(res);
        const msg = err.error ?? `HTTP ${res.status}`;
        billingError = res.status === 404
          ? 'Billing API not available. Start the backend server (e.g. from repo root) and ensure the frontend proxy targets it.'
          : msg;
        return;
      }
      const data = await parseJsonResponse(res);
      billingData = {
        localEstimate: data.localEstimate,
        cloudReality: data.cloudReality ?? [],
        driftPercent: data.driftPercent ?? null,
        highlightDrift: data.highlightDrift === true,
      };
    } catch (e) {
      billingError = e instanceof Error ? e.message : 'Failed to load billing. Ensure the backend is running (e.g. port 3000) and the frontend proxy targets it.';
    } finally {
      billingLoading = false;
    }
  }

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
      <div class="flex gap-1 mx-6 mt-4 p-1 rounded-lg shrink-0 flex-wrap" style="background: var(--color-surface-0);">
        <button
          class="flex-1 min-w-0 flex items-center justify-center gap-1.5 py-2 text-xs rounded-md transition-colors
                 {activeTab === 'providers' ? 'bg-[var(--color-surface-3)] text-[var(--color-text-primary)] font-medium' : 'text-[var(--color-text-muted)] hover:text-[var(--color-text-secondary)]'}"
          onclick={() => activeTab = 'providers'}
        >
          <Key size={13} /> Providers
        </button>
        <button
          class="flex-1 min-w-0 flex items-center justify-center gap-1.5 py-2 text-xs rounded-md transition-colors
                 {activeTab === 'appearance' ? 'bg-[var(--color-surface-3)] text-[var(--color-text-primary)] font-medium' : 'text-[var(--color-text-muted)] hover:text-[var(--color-text-secondary)]'}"
          onclick={() => activeTab = 'appearance'}
        >
          <Palette size={13} /> Theme
        </button>
        <button
          class="flex-1 min-w-0 flex items-center justify-center gap-1.5 py-2 text-xs rounded-md transition-colors
                 {activeTab === 'shortcuts' ? 'bg-[var(--color-surface-3)] text-[var(--color-text-primary)] font-medium' : 'text-[var(--color-text-muted)] hover:text-[var(--color-text-secondary)]'}"
          onclick={() => activeTab = 'shortcuts'}
        >
          <Keyboard size={13} /> Shortcuts
        </button>
        <button
          class="flex-1 min-w-0 flex items-center justify-center gap-1.5 py-2 text-xs rounded-md transition-colors
                 {activeTab === 'messaging' ? 'bg-[var(--color-surface-3)] text-[var(--color-text-primary)] font-medium' : 'text-[var(--color-text-muted)] hover:text-[var(--color-text-secondary)]'}"
          onclick={() => { activeTab = 'messaging'; void loadMessaging(); }}
        >
          <MessageCircle size={13} /> Messaging
        </button>
        <button
          class="flex-1 min-w-0 flex items-center justify-center gap-1.5 py-2 text-xs rounded-md transition-colors
                 {activeTab === 'billing' ? 'bg-[var(--color-surface-3)] text-[var(--color-text-primary)] font-medium' : 'text-[var(--color-text-muted)] hover:text-[var(--color-text-secondary)]'}"
          onclick={() => { activeTab = 'billing'; void loadBillingCredits(); }}
        >
          <CreditCard size={13} /> Billing
        </button>
      </div>

      <!-- Content (scrollable) -->
      <div class="flex-1 overflow-y-auto px-6 py-5">

  {#if activeTab === 'providers'}
    <div class="space-y-0.5">
      <div class="sticky top-0 z-10 -mx-1 px-1 py-2 mb-1" style="background: var(--color-surface-1);">
        <div class="relative">
          <Search size={14} class="absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none shrink-0" style="color: var(--color-text-muted);" />
          <input
            type="text"
            placeholder="Search providers..."
            bind:value={providerSearchQuery}
            class="input w-full pr-3 py-2 text-sm"
            style="font-size: 12px; padding-left: 2.75rem;"
          />
        </div>
        {#if providerSearchQuery.trim()}
          <p class="text-[10px] mt-1" style="color: var(--color-text-muted);">
            {filteredProviderList.length} provider{filteredProviderList.length !== 1 ? 's' : ''}
          </p>
        {/if}
      </div>
      {#each filteredProviderList as prov}
            {@const status = getProviderStatus(prov.key)}
            {@const caps = getProviderCaps(prov.key)}
            <div class={`rounded-lg transition-colors ${expandedProvider === prov.key ? 'bg-[var(--color-surface-3)]' : 'hover:bg-[var(--color-surface-2)]'}`}>
              <button
                onclick={() => { expandedProvider = expandedProvider === prov.key ? null : prov.key; }}
                class="w-full flex items-center justify-between py-2 px-2.5 text-left"
              >
                <span class="text-xs font-medium" style="color: var(--color-text-primary);">{prov.label}</span>
                <div class="flex items-center gap-1.5">
                  {#if status?.authenticated}
                    <span class="w-1.5 h-1.5 rounded-full bg-green-500" title="Connected"></span>
                    <span class="text-[10px]" style="color: var(--color-text-muted);">{status.models.length} models</span>
                  {:else}
                    <span class="w-1.5 h-1.5 rounded-full bg-yellow-500" title="Auth needed"></span>
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
                        {#if currentMode === 'cli'}
                          <div class="text-[10px] mb-1" style="color: var(--color-text-muted);">
                            Use an existing Gemini CLI session, or sign in in the browser and then verify.
                          </div>
                          <button
                            type="button"
                            onclick={startGeminiCLIAuth}
                            class="btn btn-secondary w-full"
                          >
                            Sign in with Gemini (open browser)
                          </button>
                          <button
                            onclick={() => connectProvider(prov.key)}
                            disabled={saving === prov.key}
                            class="btn btn-primary w-full mt-1"
                          >
                            {verifying === prov.key ? 'Testing connection...' : saving === prov.key ? 'Saving...' : 'Verify Gemini CLI Auth'}
                          </button>
                        {:else if currentMode === 'antigravity'}
                          <div class="text-[10px] mb-1" style="color: var(--color-text-muted);">
                            Sign in with Google in your browser. No CLI required.
                          </div>
                          <button
                            type="button"
                            onclick={startAntigravityAuth}
                            disabled={antigravityAuthStatus === 'pending'}
                            class="btn btn-secondary w-full"
                          >
                            Authorize Antigravity in Browser
                          </button>
                          {#if antigravityAuthId || antigravityAuthStatus !== 'idle'}
                            <div class="rounded-md px-2 py-2 mt-2" style="background: var(--color-surface-2);">
                              <div class="text-[10px]" style="color: var(--color-text-muted);">{antigravityAuthMessage}</div>
                            </div>
                          {/if}
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
                          {verifying === prov.key ? 'Testing connection...' : saving === prov.key ? 'Saving...' : 'Connect'}
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
                          {#if prov.key === 'cline'}
                            Must have authed with CLI first (run <code>cline auth</code> in your terminal), then verify the connection.
                          {:else}
                            Authenticate in your browser, then verify the connection.
                          {/if}
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
                          placeholder={caps.baseUrlPlaceholder ?? 'Endpoint URL'}
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
                          {verifying === prov.key ? 'Testing connection...' : saving === prov.key ? 'Saving...' : (caps.authMode === 'auth_only' || caps.authMode === 'env_auth' ? 'Verify Connection' : 'Connect')}
                        </button>
                      {/if}
                    {/if}
                  {/if}
                </div>
              {/if}
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
              <span style="color: var(--color-text-primary); font-family: {theme.getFontFamily(font.id)};">{font.label}</span>
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

  {:else if activeTab === 'messaging'}
    <div class="space-y-6 max-w-lg">
      <p class="text-[10px] uppercase tracking-wider mb-2" style="color: var(--color-text-muted);">
        Talk to the manager agent via messaging apps. Replies stream back automatically.
      </p>
      {#if messagingLoading}
        <p class="text-xs" style="color: var(--color-text-muted);">Loading…</p>
      {:else}
        <!-- Telegram -->
        <div class="rounded-lg p-4" style="background: var(--color-surface-2); border: 1px solid var(--color-border);">
          <div class="flex items-center justify-between mb-3">
            <span class="text-xs font-medium" style="color: var(--color-text-primary);">Telegram</span>
            {#if telegramEnabled}
              <span class="flex items-center gap-1.5 text-[10px]" style="color: var(--color-text-muted);">
                <span class="w-1.5 h-1.5 rounded-full bg-green-500"></span>
                Connected
              </span>
            {:else}
              <span class="text-[10px]" style="color: var(--color-text-muted);">Not configured</span>
            {/if}
          </div>
          <label class="flex items-center gap-2 mb-2">
            <input
              type="checkbox"
              bind:checked={telegramEnabled}
              class="rounded"
            />
            <span class="text-xs" style="color: var(--color-text-secondary);">Enable Telegram bridge</span>
          </label>
          {#if telegramEnabled}
            <input
              type="password"
              placeholder={telegramBotTokenSet ? 'Bot token (leave blank to keep current)' : 'Bot token (from @BotFather)'}
              bind:value={telegramBotToken}
              class="input mb-2"
              style="font-size: 12px;"
            />
            <input
              type="text"
              placeholder="Your Telegram user ID (admin)"
              bind:value={telegramAdminId}
              class="input mb-3"
              style="font-size: 12px;"
            />
            <p class="text-[10px] mb-3" style="color: var(--color-text-muted);">
              Get your ID from @userinfobot. Only this user can send tasks; replies stream to the same chat.
            </p>
          {/if}
        </div>

        <!-- iMessage -->
        <div class="rounded-lg p-4" style="background: var(--color-surface-2); border: 1px solid var(--color-border);">
          <div class="flex items-center justify-between mb-3">
            <span class="text-xs font-medium" style="color: var(--color-text-primary);">iMessage</span>
            <span class="text-[10px]" style="color: var(--color-text-muted);">Bridge required</span>
          </div>
          <p class="text-[10px] mb-2" style="color: var(--color-text-secondary);">
            Use your Mac as a bridge: run a small bridge app that forwards iMessage to this server and sends replies back. No server API for iMessage; the bridge runs on your Mac.
          </p>
          <p class="text-[10px]" style="color: var(--color-text-muted);">
            Bridge app: connect to this server, then message the configured number from iMessage to talk to the manager agent.
          </p>
        </div>

        <!-- Android Messages -->
        <div class="rounded-lg p-4" style="background: var(--color-surface-2); border: 1px solid var(--color-border);">
          <div class="flex items-center justify-between mb-3">
            <span class="text-xs font-medium" style="color: var(--color-text-primary);">Android Messages</span>
            <span class="text-[10px]" style="color: var(--color-text-muted);">Bridge required</span>
          </div>
          <p class="text-[10px] mb-2" style="color: var(--color-text-secondary);">
            Use your Android phone as a bridge: run a small bridge app that forwards Messages to this server and sends replies back. No server API for Android Messages; the bridge runs on your device.
          </p>
          <p class="text-[10px]" style="color: var(--color-text-muted);">
            Bridge app: connect to this server, then message the configured number from Android Messages to talk to the manager agent.
          </p>
        </div>

        <button
          class="btn btn-primary"
          disabled={messagingSaving}
          onclick={() => saveMessaging()}
        >
          {messagingSaving ? 'Saving…' : 'Save messaging config'}
        </button>
        <p class="text-[10px]" style="color: var(--color-text-muted);">
          Restart the server after saving for Telegram changes to take effect.
        </p>
      {/if}
    </div>
  {:else if activeTab === 'billing'}
    <div class="space-y-4">
      <p class="text-sm" style="color: var(--color-text-secondary);">
        Local estimate (from token usage) vs cloud reality (OpenAI / GitHub Copilot). Drift &gt; 5% is highlighted.
      </p>
      {#if billingLoading}
        <p class="text-sm" style="color: var(--color-text-muted);">Loading…</p>
      {:else if billingError}
        <p class="text-sm" style="color: var(--color-error, #dc2626);">{billingError}</p>
      {:else if billingData}
        {#if billingData.highlightDrift}
          <div
            class="flex items-center gap-2 p-3 rounded-lg border"
            style="background: var(--color-surface-2); border-color: var(--color-warning, #f59e0b);"
          >
            <AlertTriangle size={18} style="color: var(--color-warning, #f59e0b);" />
            <span class="text-sm font-medium">Drift &gt; 5% — Local estimate and cloud usage differ by {billingData.driftPercent?.toFixed(1) ?? '?'}%.</span>
          </div>
        {/if}
        <div class="grid gap-4 sm:grid-cols-2">
          <div class="p-4 rounded-lg" style="background: var(--color-surface-2);">
            <h3 class="text-xs font-semibold uppercase tracking-wider mb-2" style="color: var(--color-text-muted);">Local estimate</h3>
            <p class="text-lg font-semibold" style="color: var(--color-text-primary);">${billingData.localEstimate.totalCostUsd.toFixed(4)}</p>
            <p class="text-[10px] mt-1" style="color: var(--color-text-muted);">
              {billingData.localEstimate.tokensIn.toLocaleString()} in / {billingData.localEstimate.tokensOut.toLocaleString()} out tokens
            </p>
            {#if billingData.localEstimate.byModel.length > 0}
              <ul class="mt-2 space-y-1 text-[10px]" style="color: var(--color-text-muted);">
                {#each billingData.localEstimate.byModel as row}
                  <li>{row.model}: ${row.costUsd.toFixed(4)}</li>
                {/each}
              </ul>
            {/if}
          </div>
          <div class="p-4 rounded-lg" style="background: var(--color-surface-2);">
            <h3 class="text-xs font-semibold uppercase tracking-wider mb-2" style="color: var(--color-text-muted);">Cloud reality</h3>
            {#if billingData.cloudReality.length === 0}
              <p class="text-sm" style="color: var(--color-text-muted);">No cloud snapshots yet (poll every 15 min).</p>
            {:else}
              {#each billingData.cloudReality as cloud}
                <div class="mb-2 last:mb-0">
                  <span class="text-xs font-medium" style="color: var(--color-text-secondary);">{cloud.source}</span>
                  {#if cloud.totalUsedUsd != null}
                    <p class="text-sm" style="color: var(--color-text-primary);">Used: ${cloud.totalUsedUsd.toFixed(4)}</p>
                  {/if}
                  {#if cloud.totalAvailableUsd != null}
                    <p class="text-[10px]" style="color: var(--color-text-muted);">Available: ${cloud.totalAvailableUsd.toFixed(4)}</p>
                  {/if}
                </div>
              {/each}
            {/if}
          </div>
        </div>
      {/if}
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
