/**
 * Providers Store
 *
 * Centralizes provider API calls, connection/auth flows, account management,
 * and provider status state (synced from API + WebSocket).
 */

import { browser } from '$app/environment';
import { tick } from 'svelte';
import { open as openExternal } from '@tauri-apps/plugin-shell';
import type { ProviderInfo } from '@koryphaios/shared';
import { apiUrl } from '$lib/utils/api-url';
import { apiFetch, parseJsonResponse } from '$lib/api.svelte';
import { toastStore } from './toast.svelte';

// ============================================================================
// Types
// ============================================================================

export interface StoredProviderAccount {
  id: string;
  provider: string;
  label: string;
  createdAt: number;
  updatedAt: number;
  hasApiKey: boolean;
  hasAuthToken: boolean;
  hasBaseUrl: boolean;
}

export type SavedAccountSummary = {
  id: string;
  provider: string;
  label: string;
};

export type DetectedCli = {
  id: string;
  displayName: string;
  installed: boolean;
  loggedIn: boolean;
  autoEnabled: boolean;
  provider: string | null;
  authSource: string | null;
  note: string;
  docsUrl: string;
};

export type ProviderListItem = {
  key: string;
  label: string;
  placeholder: string;
  needsUrl: boolean;
};

export type ProviderCaps = {
  authMode: string;
  supportsApiKey: boolean;
  supportsAuthToken: boolean;
  requiresBaseUrl: boolean;
  baseUrlPlaceholder?: string;
  enabled: boolean;
  authenticated: boolean;
  models: string[];
};

export type DeviceAuthInfo = {
  deviceAuthId?: string;
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  verificationUriComplete?: string;
  expiresAt: number;
  intervalMs: number;
};

export type CodexDeviceAuthInfo = {
  deviceAuthId?: string;
  userCode: string;
  verificationUri: string;
  verificationUriComplete?: string;
  expiresAt: number;
  intervalMs: number;
};

export type BrowserAuthStartResult =
  | { kind: 'connected'; name: string; openModelSelector: boolean; status?: ProviderInfo }
  | { kind: 'started' }
  | { kind: 'needs_codex_profile'; options: { saveAccount?: boolean; label?: string } }
  | { kind: 'error' };

export type ConnectProviderResult = {
  ok: boolean;
  openModelSelector?: boolean;
  status?: ProviderInfo;
};

export type SyncProviderUiResult = {
  status?: ProviderInfo;
  openModelSelector: boolean;
  modelCount: number;
};

export const browserAuthProviders = new Set([
  'copilot',
  'kimicode',
  'codex',
  'claude',
  'grok',
  'antigravity',
  // NOTE: 'google-subscription' (the Gemini CLI) is RETIRED — never re-add
  // it. Gemini models are served by the plain 'google' (API-key) provider.
]);

const PROVIDER_LABELS: Record<string, string> = {
  anthropic: 'Anthropic',
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
  opencodezen: 'OpenCodeZen',
  claude: 'Claude Code',
  codex: 'OpenAI Codex',
  grok: 'Grok Build',
  jules: 'Google Jules (cloud)',
  kimicode: 'Kimi Code',
  moonshot: 'Moonshot AI / Kimi API',
  mistral: 'Mistral AI',
};

const TOKEN_PLACEHOLDERS: Record<string, string> = {
  jules: 'Jules API key (jules.google.com/settings)',
  anthropic: 'Anthropic auth token',
  copilot: 'GitHub token or Copilot auth token',
  google: 'OAuth or access token',
  kimicode: 'Auth with Kimi Code',
  azure: 'Bearer token',
};

const isTauri = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

// ============================================================================
// Store Factory
// ============================================================================

function createProvidersStore() {
  let statusList = $state<ProviderInfo[]>([]);
  let availableProviderTypes = $state<Array<{ name: string; authMode: string }>>([]);
  let detectedClis = $state<DetectedCli[]>([]);

  let keyInputs = $state<Record<string, string>>({});
  let tokenInputs = $state<Record<string, string>>({});
  let urlInputs = $state<Record<string, string>>({});
  let accountLabelInputs = $state<Record<string, string>>({});
  let accountKeyInputs = $state<Record<string, string>>({});
  let accountTokenInputs = $state<Record<string, string>>({});
  let accountUrlInputs = $state<Record<string, string>>({});
  let providerAccounts = $state<Record<string, StoredProviderAccount[]>>({});
  let accountsLoading = $state<Record<string, boolean>>({});
  let accountBusy = $state<string | null>(null);
  let fallbackOrders = $state<Record<string, string[]>>({});
  let fallbackItems = $state<Record<string, StoredProviderAccount[]>>({});
  let fallbackSaving = $state<string | null>(null);
  let saving = $state<string | null>(null);
  let verifying = $state<string | null>(null);
  let browserAuthBusy = $state<string | null>(null);
  let browserAuthPending = $state<Record<string, boolean>>({});
  let browserAuthMessages = $state<Record<string, string>>({});
  let copiedDeviceCode = $state<string | null>(null);
  let copiedDeviceUrl = $state<string | null>(null);
  let addingCustom = $state(false);
  let accountManagerRequest = $state<{
    provider: string;
    account: StoredProviderAccount | SavedAccountSummary;
  } | null>(null);
  let modelSelectorRequest = $state<ProviderInfo | null>(null);

  let copilotDeviceAuth = $state<DeviceAuthInfo | null>(null);
  let copilotAuthStatus = $state<'idle' | 'pending' | 'connected' | 'error'>('idle');
  let copilotAuthMessage = $state<string>('');
  let copilotPollTimer: ReturnType<typeof setTimeout> | null = null;

  let kimicodeDeviceAuth = $state<DeviceAuthInfo | null>(null);
  let kimicodeAuthStatus = $state<'idle' | 'pending' | 'connected' | 'error'>('idle');
  let kimicodeAuthMessage = $state<string>('');
  let kimicodePollTimer: ReturnType<typeof setTimeout> | null = null;

  let codexDeviceAuth = $state<CodexDeviceAuthInfo | null>(null);
  let codexAuthStatus = $state<'idle' | 'pending' | 'connected' | 'error'>('idle');
  let codexAuthMessage = $state<string>('');
  let codexPollTimer: ReturnType<typeof setTimeout> | null = null;


  // ─── Helpers ───────────────────────────────────────────────────────────

  function getKnownAuthMode(name: string, fallback: string): string {
    if (
      name === 'copilot' ||
      name === 'codex' ||
      name === 'kimicode' ||
      name === 'claude' ||
      name === 'grok' ||
      name === 'antigravity'
    ) {
      return 'auth_only';
    }
    return fallback;
  }

  function getProviderDisplayLabel(name: string): string {
    return PROVIDER_LABELS[name] ?? name.charAt(0).toUpperCase() + name.slice(1);
  }

  function usesBrowserAuth(name: string): boolean {
    return browserAuthProviders.has(name);
  }

  function getProviderStatus(name: string): ProviderInfo | undefined {
    return statusList.find((p) => p.name === name);
  }

  function getProviderCaps(name: string): ProviderCaps {
    const status = getProviderStatus(name);
    if (status) {
      const authMode =
        typeof status.authMode === 'string' ? status.authMode : (status.authMode?.id ?? 'api_key');
      return {
        authMode: getKnownAuthMode(name, authMode),
        supportsApiKey: status.supportsApiKey,
        supportsAuthToken: status.supportsAuthToken,
        requiresBaseUrl: status.requiresBaseUrl,
        baseUrlPlaceholder: status.baseUrlPlaceholder,
        enabled: status.enabled,
        authenticated: status.authenticated,
        models: status.models ?? [],
      };
    }
    const type = availableProviderTypes.find((t) => t.name === name);
    const authMode = getKnownAuthMode(name, type?.authMode ?? 'api_key');
    const requiresBaseUrl = authMode === 'base_url_only';
    return {
      authMode,
      supportsApiKey: authMode === 'api_key' || authMode === 'api_key_or_auth',
      supportsAuthToken: authMode === 'api_key_or_auth' || authMode === 'auth_only',
      requiresBaseUrl,
      baseUrlPlaceholder: requiresBaseUrl ? 'e.g. http://localhost:1234/v1' : undefined,
      enabled: false,
      authenticated: false,
      models: [],
    };
  }

  function getProviderAccounts(name: string): StoredProviderAccount[] {
    return providerAccounts[name] ?? [];
  }

  function setProviderStatusList(list: ProviderInfo[]): void {
    statusList = Array.isArray(list) ? list : [];
  }

  async function openAuthUrl(url: string): Promise<void> {
    if (isTauri) {
      await openExternal(url);
      return;
    }
    window.open(url, '_blank', 'noopener,noreferrer');
  }

  async function copyToClipboard(value: string, kind: 'deviceCode' | 'deviceUrl'): Promise<void> {
    await navigator.clipboard.writeText(value);
    if (kind === 'deviceCode') {
      copiedDeviceCode = value;
      setTimeout(() => {
        if (copiedDeviceCode === value) copiedDeviceCode = null;
      }, 2000);
      return;
    }
    copiedDeviceUrl = value;
    setTimeout(() => {
      if (copiedDeviceUrl === value) copiedDeviceUrl = null;
    }, 2000);
  }

  function clearAccountManagerRequest(): void {
    accountManagerRequest = null;
  }

  function clearModelSelectorRequest(): void {
    modelSelectorRequest = null;
  }

  function maybeRequestModelSelector(status: ProviderInfo | undefined, request: boolean): void {
    if (
      request &&
      status?.authenticated &&
      !status.hideModelSelector &&
      (status.allAvailableModels?.length ?? 0) > 0
    ) {
      modelSelectorRequest = status;
    }
  }

  // ─── API: status & catalog ─────────────────────────────────────────────

  async function loadProvidersFromApi(): Promise<void> {
    if (!browser) return;
    try {
      const res = await apiFetch(apiUrl('/api/providers'));
      if (!res.ok) {
        if (import.meta.env.DEV) console.warn(`Failed to load providers: HTTP ${res.status}`);
        return;
      }
      const json = await parseJsonResponse<{ data?: ProviderInfo[] }>(res);
      const list = json?.data;
      if (Array.isArray(list)) statusList = list;
    } catch (error) {
      if (import.meta.env.DEV) console.warn('Failed to load providers from API', error);
    }
  }

  async function loadAvailableProviders(): Promise<void> {
    try {
      const res = await apiFetch(apiUrl('/api/providers/available'));
      const data = await parseJsonResponse<{
        ok?: boolean;
        data?: Array<{ name: string; authMode: string }>;
      }>(res);
      if (data?.ok && Array.isArray(data.data)) {
        availableProviderTypes = data.data;
      }
    } catch {
      availableProviderTypes = [];
    }
  }

  async function loadDetectedClis(): Promise<void> {
    try {
      const res = await apiFetch(apiUrl('/api/providers/detect'));
      const data = await parseJsonResponse<{ ok?: boolean; data?: DetectedCli[] }>(res);
      if (data?.ok && Array.isArray(data.data)) detectedClis = data.data;
    } catch {
      detectedClis = [];
    }
  }

  async function refreshProviderStatus(
    name: string,
    options?: { warmModelList?: boolean },
  ): Promise<ProviderInfo | undefined> {
    await loadProvidersFromApi();
    if (options?.warmModelList) {
      await new Promise((resolve) => setTimeout(resolve, 700));
      await loadProvidersFromApi();
    }
    await tick();
    return getProviderStatus(name);
  }

  async function syncProviderUi(
    name: string,
    options?: { openModelSelector?: boolean; successMessage?: string },
  ): Promise<SyncProviderUiResult> {
    const status = await refreshProviderStatus(name, {
      warmModelList: options?.openModelSelector === true,
    });
    const modelCount = status?.allAvailableModels?.length ?? 0;
    const openModelSelector =
      !!status?.authenticated &&
      options?.openModelSelector === true &&
      !status.hideModelSelector &&
      modelCount > 0;

    if (status?.authenticated) {
      maybeRequestModelSelector(status, options?.openModelSelector === true);
      if (options?.successMessage) {
        const suffix = modelCount > 0 ? ` (${modelCount} models ready)` : '';
        toastStore.success(options.successMessage + suffix);
      }
    } else if (options?.successMessage) {
      toastStore.success(options.successMessage);
    }

    return { status, openModelSelector, modelCount };
  }

  // ─── Poll timers ───────────────────────────────────────────────────────

  function clearCopilotPollTimer(): void {
    if (copilotPollTimer) {
      clearTimeout(copilotPollTimer);
      copilotPollTimer = null;
    }
  }

  function clearKimiCodePollTimer(): void {
    if (kimicodePollTimer) {
      clearTimeout(kimicodePollTimer);
      kimicodePollTimer = null;
    }
  }

  function clearCodexPollTimer(): void {
    if (codexPollTimer) {
      clearTimeout(codexPollTimer);
      codexPollTimer = null;
    }
  }

  function destroy(): void {
    clearCopilotPollTimer();
    clearKimiCodePollTimer();
    clearCodexPollTimer();
  }

  // Device codes are short-lived. Every poll tick checks the deadline so an
  // unapproved sign-in ends with an honest "expired" message instead of
  // polling forever behind a "Waiting…" line.
  const AUTH_EXPIRED_MESSAGE = 'Sign-in code expired — click Auth to start a new one.';

  function deviceAuthCountdown(expiresAt: number | undefined): string {
    if (!expiresAt) return '';
    const mins = Math.max(1, Math.ceil((expiresAt - Date.now()) / 60_000));
    return ` Code expires in ~${mins} min.`;
  }

  async function pollCopilotAuth(deviceCode: string, intervalMs: number): Promise<void> {
    clearCopilotPollTimer();
    if (copilotDeviceAuth && Date.now() > copilotDeviceAuth.expiresAt) {
      copilotAuthStatus = 'error';
      copilotAuthMessage = AUTH_EXPIRED_MESSAGE;
      browserAuthMessages.copilot = copilotAuthMessage;
      browserAuthPending.copilot = false;
      copilotDeviceAuth = null;
      return;
    }
    try {
      const res = await apiFetch(apiUrl('/api/providers/copilot/auth/poll'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ deviceCode }),
      });
      const data = await parseJsonResponse<{
        ok?: boolean;
        error?: string;
        data?: {
          status?: string;
          error?: string;
          errorDescription?: string;
          savedAccount?: SavedAccountSummary;
        };
      }>(res);

      if (!data.ok) {
        copilotAuthStatus = 'error';
        copilotAuthMessage = data.error ?? 'Copilot sign-in failed';
        browserAuthMessages.copilot = copilotAuthMessage;
        browserAuthPending.copilot = false;
        return;
      }

      const status = data.data?.status;
      if (status === 'connected') {
        copilotAuthStatus = 'connected';
        copilotAuthMessage = 'GitHub Copilot connected';
        browserAuthMessages.copilot = copilotAuthMessage;
        browserAuthPending.copilot = false;
        copilotDeviceAuth = null;
        await syncProviderUi('copilot', {
          openModelSelector: true,
          successMessage: 'GitHub Copilot connected',
        });
        return;
      }

      const pollError = data.data?.error;
      if (pollError && pollError !== 'authorization_pending') {
        copilotAuthStatus = 'error';
        copilotAuthMessage = data.data?.errorDescription ?? pollError;
        browserAuthMessages.copilot = copilotAuthMessage;
        browserAuthPending.copilot = false;
        return;
      }

      copilotAuthStatus = 'pending';
      browserAuthPending.copilot = true;
      browserAuthMessages.copilot = `${copilotAuthMessage}${deviceAuthCountdown(copilotDeviceAuth?.expiresAt)}`;
      copilotPollTimer = setTimeout(() => {
        void pollCopilotAuth(deviceCode, intervalMs);
      }, intervalMs);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Copilot sign-in failed';
      copilotAuthStatus = 'error';
      copilotAuthMessage = message;
      browserAuthMessages.copilot = copilotAuthMessage;
      browserAuthPending.copilot = false;
    }
  }

  async function pollKimiCodeAuth(deviceCode: string, intervalMs: number): Promise<void> {
    clearKimiCodePollTimer();
    if (kimicodeDeviceAuth && Date.now() > kimicodeDeviceAuth.expiresAt) {
      kimicodeAuthStatus = 'error';
      kimicodeAuthMessage = AUTH_EXPIRED_MESSAGE;
      browserAuthMessages.kimicode = kimicodeAuthMessage;
      browserAuthPending.kimicode = false;
      kimicodeDeviceAuth = null;
      return;
    }
    try {
      const res = await apiFetch(apiUrl('/api/providers/kimicode/auth/poll'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ deviceCode }),
      });
      const data = await parseJsonResponse<{
        ok?: boolean;
        error?: string;
        data?: {
          status?: string;
          error?: string;
          errorDescription?: string;
        };
      }>(res);

      if (!data.ok) {
        kimicodeAuthStatus = 'error';
        kimicodeAuthMessage = data.error ?? 'Kimi Code sign-in failed';
        browserAuthMessages.kimicode = kimicodeAuthMessage;
        browserAuthPending.kimicode = false;
        return;
      }

      const status = data.data?.status;
      if (status === 'connected') {
        kimicodeAuthStatus = 'connected';
        kimicodeAuthMessage = 'Kimi Code connected';
        browserAuthMessages.kimicode = kimicodeAuthMessage;
        browserAuthPending.kimicode = false;
        kimicodeDeviceAuth = null;
        await syncProviderUi('kimicode', {
          openModelSelector: true,
          successMessage: 'Kimi Code connected',
        });
        return;
      }

      const pollError = data.data?.error;
      if (pollError && pollError !== 'authorization_pending') {
        kimicodeAuthStatus = 'error';
        kimicodeAuthMessage = data.data?.errorDescription ?? pollError;
        browserAuthMessages.kimicode = kimicodeAuthMessage;
        browserAuthPending.kimicode = false;
        return;
      }

      kimicodeAuthStatus = 'pending';
      browserAuthPending.kimicode = true;
      browserAuthMessages.kimicode = `${kimicodeAuthMessage}${deviceAuthCountdown(kimicodeDeviceAuth?.expiresAt)}`;
      kimicodePollTimer = setTimeout(() => {
        void pollKimiCodeAuth(deviceCode, intervalMs);
      }, intervalMs);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Kimi Code sign-in failed';
      kimicodeAuthStatus = 'error';
      kimicodeAuthMessage = message;
      browserAuthMessages.kimicode = kimicodeAuthMessage;
      browserAuthPending.kimicode = false;
    }
  }

  async function pollCodexAuth(
    deviceAuthId: string,
    userCode: string,
    intervalMs: number,
    saveAccount = false,
    label?: string,
  ): Promise<void> {
    clearCodexPollTimer();
    if (codexDeviceAuth && Date.now() > codexDeviceAuth.expiresAt) {
      codexAuthStatus = 'error';
      codexAuthMessage = AUTH_EXPIRED_MESSAGE;
      browserAuthMessages.codex = codexAuthMessage;
      browserAuthPending.codex = false;
      codexDeviceAuth = null;
      return;
    }
    try {
      const res = await apiFetch(apiUrl('/api/providers/codex/auth/poll'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ deviceAuthId, userCode, saveAccount, label }),
      });
      const data = await parseJsonResponse<{
        ok?: boolean;
        error?: string;
        data?: {
          status?: string;
          error?: string;
          errorDescription?: string;
          savedAccount?: SavedAccountSummary;
        };
      }>(res);

      if (!data.ok) {
        codexAuthStatus = 'error';
        codexAuthMessage = data.error ?? 'Codex sign-in failed';
        browserAuthMessages.codex = codexAuthMessage;
        browserAuthPending.codex = false;
        return;
      }

      const status = data.data?.status;
      if (status === 'connected') {
        codexAuthStatus = 'connected';
        codexAuthMessage = 'Codex connected';
        browserAuthMessages.codex = codexAuthMessage;
        browserAuthPending.codex = false;
        codexDeviceAuth = null;
        await syncProviderUi('codex', {
          openModelSelector: true,
          successMessage: saveAccount
            ? `Codex account "${data.data?.savedAccount?.label ?? label ?? 'account'}" saved`
            : 'Codex connected',
        });
        if (saveAccount) {
          accountLabelInputs.codex = '';
          await loadProviderAccounts('codex', true);
          if (data.data?.savedAccount) {
            accountManagerRequest = { provider: 'codex', account: data.data.savedAccount };
          }
        }
        return;
      }

      const pollError = data.data?.error;
      if (pollError && pollError !== 'authorization_pending') {
        codexAuthStatus = 'error';
        codexAuthMessage = data.data?.errorDescription ?? pollError;
        browserAuthMessages.codex = codexAuthMessage;
        browserAuthPending.codex = false;
        return;
      }

      codexAuthStatus = 'pending';
      browserAuthPending.codex = true;
      browserAuthMessages.codex = `${codexAuthMessage}${deviceAuthCountdown(codexDeviceAuth?.expiresAt)}`;
      codexPollTimer = setTimeout(() => {
        void pollCodexAuth(deviceAuthId, userCode, intervalMs, saveAccount, label);
      }, intervalMs);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Codex sign-in failed';
      codexAuthStatus = 'error';
      codexAuthMessage = message;
      browserAuthMessages.codex = codexAuthMessage;
      browserAuthPending.codex = false;
    }
  }

  // ─── Accounts ──────────────────────────────────────────────────────────

  async function loadProviderAccounts(name: string, force = false): Promise<void> {
    if (!force && (accountsLoading[name] || providerAccounts[name])) return;
    accountsLoading[name] = true;
    try {
      const res = await apiFetch(apiUrl(`/api/providers/${name}/accounts`));
      const data = await parseJsonResponse<{
        ok?: boolean;
        data?: StoredProviderAccount[];
        fallbackOrder?: string[];
        error?: string;
      }>(res);
      if (data.ok && Array.isArray(data.data)) {
        providerAccounts[name] = data.data;
        if (data.fallbackOrder) {
          fallbackOrders[name] = data.fallbackOrder;
        }
      } else if (force) {
        providerAccounts[name] = [];
      }
    } catch {
      if (force) providerAccounts[name] = [];
    } finally {
      accountsLoading[name] = false;
    }
  }

  async function saveAccountProfileLabel(
    provider: string,
    accountId: string,
    label: string,
  ): Promise<boolean> {
    const trimmed = label.trim();
    if (!trimmed) {
      toastStore.error('Enter an account name');
      return false;
    }
    try {
      const res = await apiFetch(apiUrl(`/api/providers/${provider}/accounts/${accountId}`), {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ label: trimmed }),
      });
      const data = await parseJsonResponse<{ ok?: boolean; error?: string }>(res);
      if (!data.ok) {
        toastStore.error(data.error ?? 'Failed to rename profile');
        return false;
      }
      await loadProviderAccounts(provider, true);
      toastStore.success('Profile updated');
      return true;
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Failed to rename profile';
      toastStore.error(message);
      return false;
    }
  }

  async function saveFallbackOrder(name: string, order: string[]): Promise<void> {
    fallbackSaving = name;
    try {
      const res = await apiFetch(apiUrl(`/api/providers/${name}/fallback-order`), {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ order }),
      });
      const data = await parseJsonResponse<{ ok?: boolean; error?: string }>(res);
      if (data.ok) {
        fallbackOrders[name] = order;
      } else {
        toastStore.error(data.error ?? 'Failed to save fallback order');
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Failed to save fallback order';
      toastStore.error(message);
    } finally {
      fallbackSaving = null;
    }
  }

  function getOrderedFallbackAccounts(name: string): StoredProviderAccount[] {
    const accounts = providerAccounts[name] ?? [];
    if (accounts.length < 2) return [];
    const order = fallbackOrders[name] ?? [];
    const ordered: StoredProviderAccount[] = [];
    const seen = new Set<string>();
    for (const id of order) {
      const acc = accounts.find((a) => a.id === id);
      if (acc) {
        ordered.push(acc);
        seen.add(id);
      }
    }
    for (const acc of accounts) {
      if (!seen.has(acc.id)) ordered.push(acc);
    }
    if (
      !fallbackItems[name] ||
      fallbackItems[name].length !== ordered.length ||
      fallbackItems[name].some((a, i) => a.id !== ordered[i].id)
    ) {
      fallbackItems[name] = [...ordered];
    }
    return fallbackItems[name];
  }

  function handleFallbackDndFinalize(name: string, items: StoredProviderAccount[]): void {
    fallbackItems[name] = items;
    const newOrder = items.map((a) => a.id);
    void saveFallbackOrder(name, newOrder);
  }

  // ─── Connect / disconnect / auth ───────────────────────────────────────

  async function connectProvider(name: string): Promise<ConnectProviderResult> {
    const caps = getProviderCaps(name);
    const apiKey = keyInputs[name]?.trim();
    const authToken = tokenInputs[name]?.trim();
    const baseUrl = urlInputs[name]?.trim();
    if (caps.authMode === 'api_key' && !apiKey) {
      toastStore.error('Enter API key');
      return { ok: false };
    }
    if (caps.authMode === 'api_key_or_auth' && !apiKey && !authToken) {
      toastStore.error('Enter API key');
      return { ok: false };
    }
    if (caps.authMode === 'auth_only' && !authToken && !usesBrowserAuth(name)) {
      toastStore.error('Enter auth token');
      return { ok: false };
    }
    if (caps.authMode === 'base_url_only' && !baseUrl) {
      toastStore.error('Enter endpoint URL');
      return { ok: false };
    }

    saving = name;
    try {
      const body: Record<string, string> = {};
      if (apiKey) body.apiKey = apiKey;
      if (authToken) body.authToken = authToken;
      if (baseUrl) body.baseUrl = baseUrl;
      verifying = name;
      const res = await apiFetch(apiUrl(`/api/providers/${name}`), {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      verifying = null;
      const data = await parseJsonResponse<{ ok?: boolean; error?: string }>(res);
      if (data.ok) {
        keyInputs[name] = '';
        tokenInputs[name] = '';
        urlInputs[name] = '';
        const status = await refreshProviderStatus(name, { warmModelList: true });
        toastStore.success(`${getProviderDisplayLabel(name)} connected ✓`);
        const openModelSelector =
          !!status && !status.hideModelSelector && (status.allAvailableModels?.length ?? 0) > 0;
        return { ok: true, openModelSelector, status };
      }
      toastStore.error(data.error ?? 'Connection failed');
      return { ok: false };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Network error';
      toastStore.error(message);
      return { ok: false };
    } finally {
      saving = null;
      verifying = null;
    }
  }

  async function startBrowserAuthFlow(
    name: string,
    options: { saveAccount?: boolean; label?: string; profileConfirmed?: boolean } = {},
  ): Promise<BrowserAuthStartResult> {
    if (name === 'codex' && options.saveAccount && !options.profileConfirmed) {
      return { kind: 'needs_codex_profile', options };
    }
    browserAuthBusy = name;
    browserAuthMessages[name] = '';
    try {
      const res = await apiFetch(apiUrl(`/api/providers/${name}/auth/start`), {
        method: 'POST',
      });
      const data = await parseJsonResponse<{
        ok?: boolean;
        error?: string;
        data?: {
          status?: string;
          url?: string;
          message?: string;
          deviceAuthId?: string;
          deviceCode?: string;
          userCode?: string;
          verificationUri?: string;
          verificationUriComplete?: string;
          interval?: number;
          expiresIn?: number;
        };
      }>(res);

      if (!data.ok || !data.data) {
        toastStore.error(data.error ?? 'Failed to start sign-in');
        return { kind: 'error' };
      }

      if (data.data.status === 'connected') {
        browserAuthPending[name] = false;
        browserAuthMessages[name] = data.data.message ?? '';
        const sync = await syncProviderUi(name, {
          openModelSelector: true,
          successMessage: `${getProviderDisplayLabel(name)} connected`,
        });
        return {
          kind: 'connected',
          name,
          openModelSelector: sync.openModelSelector,
          status: sync.status,
        };
      }

      browserAuthPending[name] = true;
      browserAuthMessages[name] = data.data.message ?? 'Continue sign-in in your browser';

      const authUrl =
        data.data.verificationUriComplete ?? data.data.url ?? data.data.verificationUri;
      if (authUrl) {
        await openAuthUrl(authUrl);
      }

      if (
        name === 'copilot' &&
        data.data.deviceCode &&
        data.data.userCode &&
        data.data.verificationUri
      ) {
        copilotDeviceAuth = {
          deviceCode: data.data.deviceCode,
          userCode: data.data.userCode,
          verificationUri: data.data.verificationUri,
          verificationUriComplete: data.data.verificationUriComplete,
          expiresAt: Date.now() + (data.data.expiresIn ?? 900) * 1000,
          intervalMs: Math.max(1000, (data.data.interval ?? 5) * 1000),
        };
        copilotAuthStatus = 'pending';
        copilotAuthMessage = 'Approve GitHub Copilot in the browser to finish connecting.';
        browserAuthMessages[name] = copilotAuthMessage;
        void pollCopilotAuth(copilotDeviceAuth.deviceCode, copilotDeviceAuth.intervalMs);
      } else if (
        name === 'kimicode' &&
        data.data.deviceCode &&
        data.data.userCode &&
        data.data.verificationUri
      ) {
        kimicodeDeviceAuth = {
          deviceCode: data.data.deviceCode,
          userCode: data.data.userCode,
          verificationUri: data.data.verificationUri,
          verificationUriComplete: data.data.verificationUriComplete,
          expiresAt: Date.now() + (data.data.expiresIn ?? 900) * 1000,
          intervalMs: Math.max(1000, (data.data.interval ?? 5) * 1000),
        };
        kimicodeAuthStatus = 'pending';
        kimicodeAuthMessage = 'Approve Kimi Code in the browser to finish connecting.';
        browserAuthMessages[name] = kimicodeAuthMessage;
        void pollKimiCodeAuth(kimicodeDeviceAuth.deviceCode, kimicodeDeviceAuth.intervalMs);
      } else if (name === 'codex' && data.data.userCode && data.data.verificationUri) {
        codexDeviceAuth = {
          deviceAuthId: data.data.deviceAuthId,
          userCode: data.data.userCode,
          verificationUri: data.data.verificationUri,
          verificationUriComplete: data.data.verificationUriComplete,
          expiresAt: Date.now() + (data.data.expiresIn ?? 900) * 1000,
          intervalMs: Math.max(1000, (data.data.interval ?? 5) * 1000),
        };
        codexAuthStatus = 'pending';
        await copyToClipboard(codexDeviceAuth.userCode, 'deviceCode');
        codexAuthMessage = `Codex sign-in code ${codexDeviceAuth.userCode} copied to clipboard. Finish approval in the browser.`;
        browserAuthMessages[name] = codexAuthMessage;
        if (codexDeviceAuth.deviceAuthId) {
          void pollCodexAuth(
            codexDeviceAuth.deviceAuthId,
            codexDeviceAuth.userCode,
            codexDeviceAuth.intervalMs,
            options.saveAccount === true,
            options.label,
          );
        }
      } else {
        toastStore.info(data.data.message ?? 'Finish sign-in in the browser, then confirm here.');
      }
      return { kind: 'started' };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Failed to start sign-in';
      toastStore.error(message);
      return { kind: 'error' };
    } finally {
      browserAuthBusy = null;
    }
  }

  async function finishBrowserAuthFlow(name: string): Promise<SyncProviderUiResult | null> {
    browserAuthBusy = name;
    try {
      const res = await apiFetch(apiUrl(`/api/providers/${name}/auth/complete`), {
        method: 'POST',
      });
      const data = await parseJsonResponse<{ ok?: boolean; error?: string }>(res);
      if (!data.ok) {
        toastStore.error(data.error ?? 'Sign-in is not complete yet');
        return null;
      }

      browserAuthPending[name] = false;
      browserAuthMessages[name] = '';
      await loadProvidersFromApi();
      toastStore.success(`${getProviderDisplayLabel(name)} connected ✓`);
      const status = getProviderStatus(name);
      const modelCount = status?.allAvailableModels?.length ?? 0;
      return {
        status,
        openModelSelector: false,
        modelCount,
      };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Failed to finish sign-in';
      toastStore.error(message);
      return null;
    } finally {
      browserAuthBusy = null;
    }
  }

  async function disconnectProvider(name: string): Promise<void> {
    try {
      const res = await apiFetch(apiUrl(`/api/providers/${name}`), { method: 'DELETE' });
      const data = await parseJsonResponse<{ ok?: boolean }>(res);
      if (data.ok) {
        await loadProvidersFromApi();
        toastStore.info(`${getProviderDisplayLabel(name)} disconnected`);
      }
    } catch {
      // ignore
    }
  }

  async function saveSelectedModels(
    name: string,
    selected: string[],
    hideSelector: boolean,
  ): Promise<boolean> {
    try {
      const res = await apiFetch(apiUrl(`/api/providers/${name}`), {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ selectedModels: selected, hideModelSelector: hideSelector }),
      });
      const data = await parseJsonResponse<{ ok?: boolean; error?: string }>(res);
      if (data.ok) {
        await loadProvidersFromApi();
        toastStore.success('Models updated');
        return true;
      }
      toastStore.error(data.error ?? 'Failed to update models');
      return false;
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Network error';
      toastStore.error(message);
      return false;
    }
  }

  async function rotateProviderKey(
    name: string,
    newKey: string,
    keyType: 'apiKey' | 'authToken',
  ): Promise<void> {
    if (!newKey.trim()) {
      toastStore.error('Enter a new key');
      return;
    }
    try {
      const body: Record<string, string> = {};
      body[keyType] = newKey.trim();
      const res = await apiFetch(apiUrl(`/api/providers/${name}`), {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await parseJsonResponse<{ ok?: boolean; error?: string }>(res);
      if (data.ok) {
        await loadProvidersFromApi();
        toastStore.success(`${getProviderDisplayLabel(name)} key rotated ✓`);
      } else {
        toastStore.error(data.error ?? 'Failed to rotate key');
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Network error';
      toastStore.error(message);
    }
  }

  async function saveProviderAccount(name: string, activate = false): Promise<void> {
    const caps = getProviderCaps(name);
    const label = accountLabelInputs[name]?.trim();
    const apiKey = accountKeyInputs[name]?.trim();
    const authToken = accountTokenInputs[name]?.trim();
    const baseUrl = accountUrlInputs[name]?.trim();

    if (!apiKey && !authToken && !baseUrl) {
      toastStore.error('Enter account credentials to save');
      return;
    }
    if (caps.authMode === 'auth_only' && !authToken && !usesBrowserAuth(name)) {
      toastStore.error('Enter auth token');
      return;
    }
    if (caps.authMode === 'api_key' && !apiKey && !baseUrl) {
      toastStore.error('Enter API key');
      return;
    }
    if (caps.authMode === 'base_url_only' && !baseUrl) {
      toastStore.error('Enter endpoint URL');
      return;
    }

    accountBusy = `${name}:save`;
    try {
      const res = await apiFetch(apiUrl(`/api/providers/${name}/accounts`), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ label, apiKey, authToken, baseUrl, activate }),
      });
      const data = await parseJsonResponse<{
        ok?: boolean;
        data?: { account?: { id: string } };
        error?: string;
      }>(res);
      if (data.ok) {
        accountLabelInputs[name] = '';
        accountKeyInputs[name] = '';
        accountTokenInputs[name] = '';
        accountUrlInputs[name] = '';
        await loadProviderAccounts(name, true);
        const newAccountId = data.data?.account?.id;
        if (newAccountId) {
          const currentOrder = fallbackOrders[name] ?? [];
          const allIds = new Set((providerAccounts[name] ?? []).map((a) => a.id));
          const missing = [...allIds].filter((id) => !currentOrder.includes(id));
          if (missing.length > 0) {
            void saveFallbackOrder(name, [...currentOrder, ...missing]);
          }
        }
        if (activate) await loadProvidersFromApi();
        toastStore.success(activate ? 'Account saved and activated' : 'Account saved');
      } else {
        toastStore.error(data.error ?? 'Failed to save account');
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Failed to save account';
      toastStore.error(message);
    } finally {
      accountBusy = null;
    }
  }

  async function activateProviderAccount(name: string, accountId: string): Promise<void> {
    accountBusy = `${name}:activate:${accountId}`;
    try {
      const res = await apiFetch(apiUrl(`/api/providers/${name}/accounts/${accountId}/activate`), {
        method: 'POST',
      });
      const data = await parseJsonResponse<{ ok?: boolean; error?: string }>(res);
      if (data.ok) {
        await loadProvidersFromApi();
        await loadProviderAccounts(name, true);
        toastStore.success('Saved account activated');
      } else {
        toastStore.error(data.error ?? 'Failed to activate account');
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Failed to activate account';
      toastStore.error(message);
    } finally {
      accountBusy = null;
    }
  }

  async function deleteProviderAccount(name: string, accountId: string): Promise<void> {
    accountBusy = `${name}:delete:${accountId}`;
    try {
      const res = await apiFetch(apiUrl(`/api/providers/${name}/accounts/${accountId}`), {
        method: 'DELETE',
      });
      const data = await parseJsonResponse<{ ok?: boolean; error?: string }>(res);
      if (data.ok) {
        await loadProviderAccounts(name, true);
        const currentOrder = fallbackOrders[name] ?? [];
        const cleaned = currentOrder.filter((id) => id !== accountId);
        if (cleaned.length !== currentOrder.length) {
          void saveFallbackOrder(name, cleaned);
        }
        toastStore.info('Saved account removed');
      } else {
        toastStore.error(data.error ?? 'Failed to remove account');
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Failed to remove account';
      toastStore.error(message);
    } finally {
      accountBusy = null;
    }
  }

  // ─── Custom providers ──────────────────────────────────────────────────

  async function addCustomProvider(form: {
    label: string;
    kind: string;
    baseUrl: string;
    apiKey: string;
    models: string;
  }): Promise<boolean> {
    const label = form.label.trim();
    const baseUrl = form.baseUrl.trim();
    if (!label) {
      toastStore.error('Enter a display name');
      return false;
    }
    if (!baseUrl) {
      toastStore.error('Enter the base URL');
      return false;
    }
    addingCustom = true;
    try {
      const models = form.models
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
      const res = await apiFetch(apiUrl('/api/providers/custom'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          label,
          kind: form.kind,
          baseUrl,
          apiKey: form.apiKey.trim() || undefined,
          models: models.length ? models : undefined,
        }),
      });
      const data = await parseJsonResponse<{ ok?: boolean; error?: string }>(res);
      if (data?.ok) {
        toastStore.success(`Custom provider "${label}" added ✓`);
        await loadAvailableProviders();
        await loadProvidersFromApi();
        return true;
      }
      toastStore.error(data?.error ?? 'Failed to add custom provider');
      return false;
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Network error';
      toastStore.error(message);
      return false;
    } finally {
      addingCustom = false;
    }
  }

  async function deleteCustomProvider(id: string): Promise<boolean> {
    try {
      const res = await apiFetch(apiUrl(`/api/providers/custom/${encodeURIComponent(id)}`), {
        method: 'DELETE',
      });
      const data = await parseJsonResponse<{ ok?: boolean; error?: string }>(res);
      if (data?.ok) {
        toastStore.info('Custom provider removed');
        await loadAvailableProviders();
        await loadProvidersFromApi();
        return true;
      }
      toastStore.error(data?.error ?? 'Failed to remove custom provider');
      return false;
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Network error';
      toastStore.error(message);
      return false;
    }
  }

  // ─── Derived provider list for UI ──────────────────────────────────────

  function buildProviderList(): ProviderListItem[] {
    const types =
      availableProviderTypes.length > 0
        ? availableProviderTypes.map((type) => ({
            ...type,
            authMode: getKnownAuthMode(type.name, type.authMode ?? 'api_key'),
          }))
        : statusList.map((p) => ({
            name: p.name,
            authMode: getKnownAuthMode(
              p.name,
              typeof p.authMode === 'string' ? p.authMode : (p.authMode?.id ?? 'api_key'),
            ),
          }));

    const providerLabels: Record<string, string> = {
      anthropic: 'Anthropic',
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
      kimicode: 'Kimi Code',
      minimax: 'MiniMax',
      moonshot: 'Moonshot AI / Kimi API',
      zai: 'ZAI',
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
      opencodego: 'OpenCode Go',
      firmware: 'Firmware',
      '302ai': '302.ai',
      claude: 'Claude Code',
      codex: 'OpenAI Codex',
      grok: 'Grok Build',
      jules: 'Google Jules',
      antigravity: 'Antigravity',
      mistral: 'Mistral AI',
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
      novita: 'Novita',
      banbri: 'Banbri',
    };

    const providerPlaceholders: Record<string, string> = {
      anthropic: 'sk-ant-...',
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
      kimicode: 'Auth with Kimi Code',
      minimax: 'sk-...',
      moonshot: 'sk-...',
      zai: 'sk-...',
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
      opencodego: 'Get key at opencode.ai/auth (subscribe to Go)',
      firmware: 'sk-...',
      '302ai': 'sk-...',
      jules: 'Jules API key (jules.google.com/settings)',
      mistralai: 'sk-...',
      claude: 'Claude auth token',
      codex: 'Auth with ChatGPT',
      grok: 'Uses your local grok CLI — run "grok login" first',
      antigravity: 'Uses your local agy CLI — run "agy login" first',
      mistral: 'sk-...',
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
      novita: 'sk-...',
      banbri: 'sk-...',
    };

    const providersNeedingUrl = new Set(['local', 'ollama', 'lmstudio', 'llamacpp', 'azure']);

    return types
      .map((type) => ({
        key: type.name,
        label:
          providerLabels[type.name] ||
          statusList.find((p) => p.name === type.name)?.label ||
          (type.name.startsWith('custom:')
            ? type.name.slice('custom:'.length)
            : type.name.charAt(0).toUpperCase() + type.name.slice(1)),
        placeholder: providerPlaceholders[type.name] || 'API key...',
        needsUrl: providersNeedingUrl.has(type.name) || type.name.startsWith('custom:'),
      }))
      .sort((a, b) => a.label.localeCompare(b.label));
  }

  let providerList = $derived(buildProviderList());

  return {
    get statusList() {
      return statusList;
    },
    get availableProviderTypes() {
      return availableProviderTypes;
    },
    get detectedClis() {
      return detectedClis;
    },
    get providerList() {
      return providerList;
    },
    get keyInputs() {
      return keyInputs;
    },
    set keyInputs(v: Record<string, string>) {
      keyInputs = v;
    },
    get tokenInputs() {
      return tokenInputs;
    },
    set tokenInputs(v: Record<string, string>) {
      tokenInputs = v;
    },
    get urlInputs() {
      return urlInputs;
    },
    set urlInputs(v: Record<string, string>) {
      urlInputs = v;
    },
    get accountLabelInputs() {
      return accountLabelInputs;
    },
    set accountLabelInputs(v: Record<string, string>) {
      accountLabelInputs = v;
    },
    get accountKeyInputs() {
      return accountKeyInputs;
    },
    set accountKeyInputs(v: Record<string, string>) {
      accountKeyInputs = v;
    },
    get accountTokenInputs() {
      return accountTokenInputs;
    },
    set accountTokenInputs(v: Record<string, string>) {
      accountTokenInputs = v;
    },
    get accountUrlInputs() {
      return accountUrlInputs;
    },
    set accountUrlInputs(v: Record<string, string>) {
      accountUrlInputs = v;
    },
    get providerAccounts() {
      return providerAccounts;
    },
    get accountsLoading() {
      return accountsLoading;
    },
    get accountBusy() {
      return accountBusy;
    },
    get fallbackOrders() {
      return fallbackOrders;
    },
    get fallbackItems() {
      return fallbackItems;
    },
    get fallbackSaving() {
      return fallbackSaving;
    },
    get saving() {
      return saving;
    },
    get verifying() {
      return verifying;
    },
    get browserAuthBusy() {
      return browserAuthBusy;
    },
    get browserAuthPending() {
      return browserAuthPending;
    },
    get browserAuthMessages() {
      return browserAuthMessages;
    },
    get copiedDeviceCode() {
      return copiedDeviceCode;
    },
    get copiedDeviceUrl() {
      return copiedDeviceUrl;
    },
    get addingCustom() {
      return addingCustom;
    },
    get accountManagerRequest() {
      return accountManagerRequest;
    },
    get modelSelectorRequest() {
      return modelSelectorRequest;
    },
    get copilotDeviceAuth() {
      return copilotDeviceAuth;
    },
    get copilotAuthStatus() {
      return copilotAuthStatus;
    },
    get copilotAuthMessage() {
      return copilotAuthMessage;
    },
    get kimicodeDeviceAuth() {
      return kimicodeDeviceAuth;
    },
    get kimicodeAuthStatus() {
      return kimicodeAuthStatus;
    },
    get kimicodeAuthMessage() {
      return kimicodeAuthMessage;
    },
    get codexDeviceAuth() {
      return codexDeviceAuth;
    },
    get codexAuthStatus() {
      return codexAuthStatus;
    },
    get codexAuthMessage() {
      return codexAuthMessage;
    },
    get tokenPlaceholders() {
      return TOKEN_PLACEHOLDERS;
    },

    browserAuthProviders,
    getProviderDisplayLabel,
    getKnownAuthMode,
    usesBrowserAuth,
    getProviderCaps,
    getProviderStatus,
    getProviderAccounts,
    setProviderStatusList,
    loadProvidersFromApi,
    loadAvailableProviders,
    loadDetectedClis,
    refreshProviderStatus,
    syncProviderUi,
    loadProviderAccounts,
    saveAccountProfileLabel,
    saveFallbackOrder,
    getOrderedFallbackAccounts,
    handleFallbackDndFinalize,
    connectProvider,
    startBrowserAuthFlow,
    finishBrowserAuthFlow,
    disconnectProvider,
    saveSelectedModels,
    rotateProviderKey,
    saveProviderAccount,
    activateProviderAccount,
    deleteProviderAccount,
    addCustomProvider,
    deleteCustomProvider,
    copyToClipboard,
    clearAccountManagerRequest,
    clearModelSelectorRequest,
    destroy,
  };
}

export const providersStore = createProvidersStore();

/** @deprecated Use providersStore.loadProvidersFromApi — kept for gradual migration */
export async function loadProvidersFromApi(): Promise<void> {
  return providersStore.loadProvidersFromApi();
}
