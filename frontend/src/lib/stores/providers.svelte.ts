/**
 * Providers Store
 *
 * Centralizes provider API calls, connection/auth flows, account management,
 * and provider status state (synced from API + WebSocket).
 */

import { browser } from '$app/environment';
import { tick } from 'svelte';
import { open as openExternal } from '@tauri-apps/plugin-shell';
import { copyText } from '$lib/utils/clipboard';
import type { ProviderInfo } from '@koryphaios/shared';
import { apiUrl } from '$lib/utils/api-url';
import { apiFetch, parseJsonResponse } from '$lib/api.svelte';
import { toastStore } from './toast.svelte';
import {
  clearRecoverableDeviceAuthFlow,
  loadRecoverableDeviceAuthFlows,
  saveRecoverableDeviceAuthFlow,
  type DeviceAuthProvider,
} from './device-auth-recovery';
import type {
  CustomProviderIconSelection,
  CustomProviderIconShape,
} from '$lib/components/settings/custom-provider-icon';

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
  source?: 'saved' | 'cli-autodetect';
  email?: string | null;
  plan?: string | null;
  health?: 'ready' | 'expired' | 'unknown';
  profileDir?: string;
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
  /** Legacy compatibility alias for loginDetected. */
  loggedIn: boolean;
  /** Local login material was detected; remote account access is not implied. */
  loginDetected?: boolean;
  autoEnabled: boolean;
  provider: string | null;
  authSource: string | null;
  note: string;
  docsUrl: string;
  nativeResearch?: {
    eligible: boolean;
    nativeTools: string[];
    reason: string;
  };
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
  requiresDeployment: boolean;
  baseUrlPlaceholder?: string;
  enabled: boolean;
  authenticated: boolean;
  adapterAvailable: boolean;
  credentialDetected: boolean;
  connectionState:
    'not_configured' | 'detected' | 'verified' | 'failed' | 'unknown' | 'unavailable';
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

export type AwsCredentialScan = {
  detected: boolean;
  sources: Array<{
    kind: 'env' | 'shared_credentials_file' | 'config_file';
    profile?: string;
    region?: string;
    sso?: boolean;
  }>;
  description: string;
};

export type BrowserAuthStartResult =
  | { kind: 'connected'; name: string; openModelSelector: boolean; status?: ProviderInfo }
  | { kind: 'started' }
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

export type AddCustomProviderResult = {
  ok: boolean;
  id?: string;
  catalogDetected?: boolean;
  error?: string;
  canSaveUnverified?: boolean;
  requiresManualModels?: boolean;
  normalizedBaseUrl?: string;
};

type CachedCustomProviderIcon = {
  url: string;
  revision: string;
  shape: CustomProviderIconShape;
};

export const browserAuthProviders = new Set([
  'copilot',
  'codex-auth',
  'kimicode',
  'claude',
  'grok',
  'antigravity',
]);

// Cline is deliberately not a browser/device-code flow. Its own local CLI owns
// authentication, so reconnecting means probing that CLI and activating its
// non-secret session marker. Freebuff is the same class of provider: it reads
// its login straight from the machine's CLI (freebuff login ->
// ~/.config/manicode/credentials.json) and must never prompt for a token, so it
// is treated as a local-CLI-connect provider rather than a generic token entry.
export const localCliConnectProviders = new Set([
  'codex',
  'cursor',
  'devin',
  'cline',
  'freebuff',
]);

// Provider display labels are sourced from the backend status response
// (which returns `label` per provider). This fallback is only used before
// the first status load completes.
const PROVIDER_LABEL_FALLBACK: Record<string, string> = {
  anthropic: 'Anthropic',
  openai: 'OpenAI',
  google: 'Google',
  aistudio: 'Google AI Studio',
  xai: 'xAI',
  codebuff: 'Codebuff API',
  openrouter: 'OpenRouter',
  tokenrouter: 'TokenRouter',
  groq: 'Groq',
  digitalocean: 'DigitalOcean Inference',
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
  codex: 'Codex CLI',
  'codex-auth': 'OpenAI Codex',
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
  google: 'Gemini API key',
  aistudio: 'Gemini API key (AI Studio)',
  poe: 'Poe API key (poe.com/api_key)',
  kimicode: 'Auth with Kimi Code',
  azure: 'Bearer token',
};

const isTauri = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
const CLI_ACCOUNT_NOTICE_DISMISSALS_KEY = 'koryphaios.dismissed-cli-account-notices.v1';

type CliAccountNotice = { id: string; provider: string };

function cliAccountNoticeFingerprint(accounts: CliAccountNotice[], providers: string[]): string {
  return providers
    .map(
      (provider) =>
        `${provider}:${accounts
          .filter((account) => account.provider === provider)
          .map((account) => account.id)
          .sort()
          .join(',')}`,
    )
    .sort()
    .join('|');
}

function hasDismissedCliAccountNotice(fingerprint: string): boolean {
  try {
    const dismissed = JSON.parse(
      window.localStorage.getItem(CLI_ACCOUNT_NOTICE_DISMISSALS_KEY) ?? '[]',
    );
    return Array.isArray(dismissed) && dismissed.includes(fingerprint);
  } catch (err: unknown) {
    console.debug(
      'Failed to read CLI account notice dismissals:',
      err instanceof Error ? err.message : String(err),
    );
    return false;
  }
}

function dismissCliAccountNotice(fingerprint: string): void {
  try {
    const dismissed = JSON.parse(
      window.localStorage.getItem(CLI_ACCOUNT_NOTICE_DISMISSALS_KEY) ?? '[]',
    );
    const next = Array.isArray(dismissed)
      ? [...new Set([...dismissed, fingerprint])].slice(-20)
      : [fingerprint];
    window.localStorage.setItem(CLI_ACCOUNT_NOTICE_DISMISSALS_KEY, JSON.stringify(next));
  } catch (err: unknown) {
    // A private-storage failure must never block provider discovery.
    console.debug(
      'Failed to persist CLI account notice dismissal:',
      err instanceof Error ? err.message : String(err),
    );
  }
}

// ============================================================================
// Store Factory
// ============================================================================

function createProvidersStore() {
  let statusList = $state<ProviderInfo[]>([]);
  let providerStatusLoadRevision = 0;
  let availableProviderTypes = $state<Array<{ name: string; authMode: string }>>([]);
  let detectedClis = $state<DetectedCli[]>([]);
  let cliAccountSelectionRequired = $state<string[]>([]);
  let cliAccountNoticeShown = false;

  let keyInputs = $state<Record<string, string>>({});
  let tokenInputs = $state<Record<string, string>>({});
  let urlInputs = $state<Record<string, string>>({});
  let deploymentInputs = $state<Record<string, string>>({});
  let awsRegionInputs = $state<Record<string, string>>({});
  let awsSessionTokenInputs = $state<Record<string, string>>({});
  let accountLabelInputs = $state<Record<string, string>>({});
  let accountKeyInputs = $state<Record<string, string>>({});
  let accountTokenInputs = $state<Record<string, string>>({});
  let accountUrlInputs = $state<Record<string, string>>({});
  let providerAccounts = $state<Record<string, StoredProviderAccount[]>>({});
  let accountsLoading = $state<Record<string, boolean>>({});
  let accountBusy = $state<string | null>(null);
  let fallbackOrders = $state<Record<string, string[]>>({});
  let accountSelectionConfigured = $state<Record<string, boolean>>({});
  let fallbackEnabled = $state<Record<string, boolean>>({});
  let fallbackItems = $state<Record<string, StoredProviderAccount[]>>({});
  let fallbackSaving = $state<string | null>(null);
  let saving = $state<string | null>(null);
  let verifying = $state<string | null>(null);
  /** Per-provider inline error message from the last connection attempt. */
  let connectErrors = $state<Record<string, string>>({});
  let browserAuthBusy = $state<string | null>(null);
  let browserAuthPending = $state<Record<string, boolean>>({});
  let browserAuthMessages = $state<Record<string, string>>({});
  let copiedDeviceCode = $state<string | null>(null);
  let copiedDeviceUrl = $state<string | null>(null);
  let addingCustom = $state(false);
  let customProviderIcons = $state<Record<string, CachedCustomProviderIcon | undefined>>({});
  const customProviderIconLoads = new Map<string, Promise<void>>();
  let accountManagerRequest = $state<{
    provider: string;
    account: StoredProviderAccount | SavedAccountSummary;
  } | null>(null);
  let modelSelectorRequest = $state<ProviderInfo | null>(null);

  let copilotDeviceAuth = $state<DeviceAuthInfo | null>(null);
  let copilotAuthStatus = $state<'idle' | 'pending' | 'connected' | 'error'>('idle');
  let copilotAuthMessage = $state<string>('');
  let copilotPollTimer: ReturnType<typeof setTimeout> | null = null;

  /** Per-provider AWS credential scan result (Bedrock), keyed by provider name. */
  let awsCredentialScans = $state<Record<string, AwsCredentialScan | undefined>>({});

  let kimicodeDeviceAuth = $state<DeviceAuthInfo | null>(null);
  let kimicodeAuthStatus = $state<'idle' | 'pending' | 'connected' | 'error'>('idle');
  let kimicodeAuthMessage = $state<string>('');
  let kimicodePollTimer: ReturnType<typeof setTimeout> | null = null;

  let codexDeviceAuth = $state<DeviceAuthInfo | null>(null);
  let codexAuthPollTimer: ReturnType<typeof setTimeout> | null = null;
  let deviceAuthRecoveryResumed = false;

  // ─── Helpers ───────────────────────────────────────────────────────────

  function getKnownAuthMode(name: string, fallback: string): string {
    if (
      name === 'copilot' ||
      name === 'codex-auth' ||
      name === 'codex' ||
      name === 'kimicode' ||
      name === 'claude' ||
      name === 'grok' ||
      name === 'antigravity' ||
      name === 'cline' ||
      name === 'cursor' ||
      name === 'devin' ||
      name === 'freebuff'
    ) {
      return 'auth_only';
    }
    return fallback;
  }

  function getProviderDisplayLabel(name: string): string {
    // Prefer the label from the backend status response (single source of truth).
    const fromStatus = statusList.find((p) => p.name === name)?.label;
    if (fromStatus) return fromStatus;
    return PROVIDER_LABEL_FALLBACK[name] ?? name.charAt(0).toUpperCase() + name.slice(1);
  }

  function usesBrowserAuth(name: string): boolean {
    return browserAuthProviders.has(name);
  }

  function usesLocalCliConnection(name: string): boolean {
    return localCliConnectProviders.has(name);
  }

  function getLocalCliConnectLabel(name: string): string {
    const label =
      { codex: 'Codex', cursor: 'Cursor', devin: 'Devin', cline: 'Cline', freebuff: 'Freebuff' }[
        name
      ] ?? name;
    return `Check ${label} CLI login`;
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
        requiresDeployment: status.requiresDeployment === true,
        baseUrlPlaceholder: status.baseUrlPlaceholder,
        enabled: status.enabled,
        authenticated: status.authenticated,
        adapterAvailable: status.adapterAvailable ?? status.authenticated,
        credentialDetected: status.credentialDetected ?? status.authenticated,
        connectionState:
          status.connectionState ?? (status.authenticated ? 'detected' : 'not_configured'),
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
      requiresDeployment: name === 'azure' || name === 'azurecognitive' || name === 'sapai',
      baseUrlPlaceholder: requiresBaseUrl ? 'e.g. http://localhost:1234/v1' : undefined,
      enabled: false,
      authenticated: false,
      adapterAvailable: false,
      credentialDetected: false,
      connectionState: 'not_configured',
      models: [],
    };
  }

  function getProviderAccounts(name: string): StoredProviderAccount[] {
    return providerAccounts[name] ?? [];
  }

  function setProviderStatusList(list: ProviderInfo[]): void {
    statusList = Array.isArray(list) ? list : [];
    void syncCustomProviderIcons(statusList);
  }

  function getCustomProviderIcon(name: string): CachedCustomProviderIcon | undefined {
    return customProviderIcons[name];
  }

  function revokeCustomProviderIcon(name: string): void {
    const cached = customProviderIcons[name];
    if (cached) URL.revokeObjectURL(cached.url);
    const next = { ...customProviderIcons };
    delete next[name];
    customProviderIcons = next;
  }

  async function loadCustomProviderIcon(status: ProviderInfo): Promise<void> {
    const metadata = status.customIcon;
    if (!metadata) {
      revokeCustomProviderIcon(status.name);
      return;
    }
    const current = customProviderIcons[status.name];
    if (current?.revision === metadata.revision) return;
    const inflight = customProviderIconLoads.get(status.name);
    if (inflight) {
      await inflight;
      const latestStatus = statusList.find((candidate) => candidate.name === status.name);
      if (
        latestStatus?.customIcon?.revision === metadata.revision &&
        customProviderIcons[status.name]?.revision !== metadata.revision
      ) {
        return loadCustomProviderIcon(latestStatus);
      }
      return;
    }

    const load = (async () => {
      try {
        const response = await apiFetch(
          apiUrl(`/api/providers/custom/${encodeURIComponent(status.name)}/icon`),
        );
        if (!response.ok) return;
        const blob = await response.blob();
        if (blob.type !== 'image/png') return;
        const latest = statusList.find((candidate) => candidate.name === status.name)?.customIcon;
        if (!latest || latest.revision !== metadata.revision) return;
        const url = URL.createObjectURL(blob);
        const previous = customProviderIcons[status.name];
        customProviderIcons = {
          ...customProviderIcons,
          [status.name]: { url, revision: metadata.revision, shape: metadata.shape },
        };
        if (previous) URL.revokeObjectURL(previous.url);
      } catch (error: unknown) {
        if (import.meta.env.DEV) {
          console.debug(
            'Failed to load custom provider icon:',
            error instanceof Error ? error.message : String(error),
          );
        }
      } finally {
        customProviderIconLoads.delete(status.name);
      }
    })();
    customProviderIconLoads.set(status.name, load);
    return load;
  }

  async function syncCustomProviderIcons(list: ProviderInfo[]): Promise<void> {
    if (!browser) return;
    const activeNames = new Set(
      list.filter((status) => status.customIcon).map((status) => String(status.name)),
    );
    for (const name of Object.keys(customProviderIcons)) {
      if (!activeNames.has(name)) revokeCustomProviderIcon(name);
    }
    await Promise.all(list.filter((status) => status.customIcon).map(loadCustomProviderIcon));
  }

  async function openAuthUrl(url: string): Promise<void> {
    if (isTauri) {
      await openExternal(url);
      return;
    }
    window.open(url, '_blank', 'noopener,noreferrer');
  }

  async function copyToClipboard(value: string, kind: 'deviceCode' | 'deviceUrl'): Promise<void> {
    await copyText(value);
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
      status?.connectionState === 'verified' &&
      !status.hideModelSelector &&
      (status.allAvailableModels?.length ?? 0) > 0
    ) {
      modelSelectorRequest = status;
    }
  }

  // ─── API: status & catalog ─────────────────────────────────────────────

  async function loadProvidersFromApi(
    options: { forceRefreshModels?: boolean } = {},
  ): Promise<boolean> {
    if (!browser) return false;
    const revision = ++providerStatusLoadRevision;

    const loadOnce = async (refreshModels: '0' | '1'): Promise<boolean> => {
      const res = await apiFetch(
        apiUrl(`/api/providers${refreshModels === '1' ? '?refreshModels=1' : ''}`),
      );
      if (!res.ok) {
        if (import.meta.env.DEV) console.warn(`Failed to load providers: HTTP ${res.status}`);
        return false;
      }
      const json = await parseJsonResponse<{ ok?: boolean; data?: ProviderInfo[] }>(res);
      const list = json?.data;
      if (json?.ok !== true || !Array.isArray(list)) return false;
      if (revision !== providerStatusLoadRevision) return false;
      statusList = list;
      void syncCustomProviderIcons(list);
      if (!cliAccountNoticeShown) {
        cliAccountNoticeShown = true;
        void loadCliAccountAmbiguity();
      }
      return true;
    };

    try {
      const refreshModels = options.forceRefreshModels ? '1' : '0';
      const first = await loadOnce(refreshModels);
      if (!first) return false;

      // Device codes are intentionally kept only for this browser session. Once
      // provider status is available after a renderer reload, restore a still
      // valid code and resume its existing poll endpoint. This never restores
      // credentials; successful polls still receive those only from the
      // backend/provider.
      resumeDeviceAuthFlows();

      if (options.forceRefreshModels) {
        // Refresh is async in providers, so we allow one extra short polling cycle
        // to capture the freshly discovered model catalog. The second read must
        // not force another network refresh or credential verification.
        await new Promise((resolve) => setTimeout(resolve, 700));
        return await loadOnce('0');
      }

      return true;
    } catch (error) {
      if (import.meta.env.DEV) console.warn('Failed to load providers from API', error);
      return false;
    }
  }

  async function loadCliAccountAmbiguity(): Promise<void> {
    try {
      const res = await apiFetch(apiUrl('/api/providers/cli-accounts'));
      const data = await parseJsonResponse<{
        ok?: boolean;
        data?: CliAccountNotice[];
        selectionRequired?: string[];
      }>(res);
      cliAccountSelectionRequired =
        data.ok && Array.isArray(data.selectionRequired) ? data.selectionRequired : [];
      if (cliAccountSelectionRequired.length > 0) {
        const fingerprint = cliAccountNoticeFingerprint(
          data.data ?? [],
          cliAccountSelectionRequired,
        );
        if (hasDismissedCliAccountNotice(fingerprint)) return;
        // A setup reminder is non-blocking: once it has been seen, closed, or
        // acted on, do not reintroduce it on every launch. New CLI profiles
        // produce a different fingerprint and can be surfaced once.
        dismissCliAccountNotice(fingerprint);
        const labels = cliAccountSelectionRequired
          .map((name) => getProviderDisplayLabel(name))
          .join(', ');
        toastStore.warning(
          `Multiple CLI accounts detected for ${labels}. Choose which accounts Koryphaios may use.`,
          {
            duration: 15_000,
            actionLabel: 'Choose accounts',
            action: () => window.dispatchEvent(new CustomEvent('open-provider-account-settings')),
          },
        );
      }
    } catch (err: unknown) {
      console.warn(
        'Failed to load CLI account ambiguity:',
        err instanceof Error ? err.message : String(err),
      );
      cliAccountSelectionRequired = [];
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
    } catch (err: unknown) {
      console.warn(
        'Failed to load available providers:',
        err instanceof Error ? err.message : String(err),
      );
      availableProviderTypes = [];
    }
  }

  async function loadDetectedClis(): Promise<void> {
    try {
      const res = await apiFetch(apiUrl('/api/providers/detect'));
      const data = await parseJsonResponse<{ ok?: boolean; data?: DetectedCli[] }>(res);
      if (data?.ok && Array.isArray(data.data)) detectedClis = data.data;
    } catch (err: unknown) {
      console.warn(
        'Failed to load detected CLIs:',
        err instanceof Error ? err.message : String(err),
      );
      detectedClis = [];
    }
  }

  /**
   * Scan the machine for a usable AWS credential source (Bedrock). The backend
   * only reports WHERE credentials live — it never returns the secret material —
   * so the result is safe to surface in the UI banner.
   */
  async function loadAwsCredentialScan(name = 'bedrock'): Promise<void> {
    try {
      const res = await apiFetch(apiUrl(`/api/providers/${name}/credentials/scan`));
      const data = await parseJsonResponse<{ ok?: boolean; data?: AwsCredentialScan }>(res);
      if (data?.ok && data.data) awsCredentialScans[name] = data.data;
      else awsCredentialScans[name] = undefined;
    } catch (err: unknown) {
      console.warn(
        'Failed to scan AWS credentials:',
        err instanceof Error ? err.message : String(err),
      );
      awsCredentialScans[name] = undefined;
    }
  }

  /** Pre-fill Bedrock region/keys from the system scan's detected region. */
  async function refreshAwsScanAndStatus(name = 'bedrock'): Promise<void> {
    await loadAwsCredentialScan(name);
    const scan = awsCredentialScans[name];
    const detected = scan?.sources.find((s) => s.region)?.region;
    if (detected && !awsRegionInputs[name]) awsRegionInputs[name] = detected;
  }

  async function refreshProviderStatus(
    name: string,
    options?: { warmModelList?: boolean },
  ): Promise<ProviderInfo | undefined> {
    await loadProvidersFromApi({ forceRefreshModels: options?.warmModelList });
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
      status?.connectionState === 'verified' &&
      options?.openModelSelector === true &&
      !status.hideModelSelector &&
      modelCount > 0;

    if (status?.connectionState === 'verified') {
      maybeRequestModelSelector(status, options?.openModelSelector === true);
      if (options?.successMessage) {
        const suffix = modelCount > 0 ? ` (${modelCount} models ready)` : '';
        toastStore.success(options.successMessage + suffix);
      }
    } else if (options?.successMessage && status?.connectionState === 'detected') {
      toastStore.info(
        `${options.successMessage}: login material detected; provider access is not verified`,
      );
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

  function clearCodexAuthPollTimer(): void {
    if (codexAuthPollTimer) {
      clearTimeout(codexAuthPollTimer);
      codexAuthPollTimer = null;
    }
  }

  function clearPersistedDeviceAuth(provider: DeviceAuthProvider): void {
    clearRecoverableDeviceAuthFlow(provider);
  }

  function isDeviceAuthProvider(name: string): name is DeviceAuthProvider {
    return name === 'copilot' || name === 'kimicode' || name === 'codex-auth';
  }

  function clearDeviceAuthForProvider(name: DeviceAuthProvider): void {
    clearPersistedDeviceAuth(name);
    if (name === 'copilot') {
      clearCopilotPollTimer();
      copilotDeviceAuth = null;
      browserAuthPending.copilot = false;
      return;
    }
    if (name === 'kimicode') {
      clearKimiCodePollTimer();
      kimicodeDeviceAuth = null;
      browserAuthPending.kimicode = false;
      return;
    }
    clearCodexAuthPollTimer();
    codexDeviceAuth = null;
    browserAuthPending['codex-auth'] = false;
  }

  function resumeDeviceAuthFlows(): void {
    if (!browser || deviceAuthRecoveryResumed) return;
    deviceAuthRecoveryResumed = true;

    const flows = loadRecoverableDeviceAuthFlows();
    const copilot = flows.copilot;
    if (copilot && !copilotDeviceAuth) {
      copilotDeviceAuth = copilot;
      copilotAuthStatus = 'pending';
      copilotAuthMessage = 'Resuming GitHub Copilot sign-in.';
      browserAuthPending.copilot = true;
      browserAuthMessages.copilot = `${copilotAuthMessage}${deviceAuthCountdown(copilot.expiresAt)}`;
      void pollCopilotAuth(copilot.deviceCode, copilot.intervalMs);
    }

    const kimicode = flows.kimicode;
    if (kimicode && !kimicodeDeviceAuth) {
      kimicodeDeviceAuth = kimicode;
      kimicodeAuthStatus = 'pending';
      kimicodeAuthMessage = 'Resuming Kimi Code sign-in.';
      browserAuthPending.kimicode = true;
      browserAuthMessages.kimicode = `${kimicodeAuthMessage}${deviceAuthCountdown(kimicode.expiresAt)}`;
      void pollKimiCodeAuth(kimicode.deviceCode, kimicode.intervalMs);
    }

    const codex = flows['codex-auth'];
    if (codex && !codexDeviceAuth) {
      codexDeviceAuth = codex;
      browserAuthPending['codex-auth'] = true;
      browserAuthMessages['codex-auth'] =
        `Resuming ChatGPT approval.${deviceAuthCountdown(codex.expiresAt)}`;
      void pollCodexAuth();
    }
  }

  function destroy(): void {
    clearCopilotPollTimer();
    clearKimiCodePollTimer();
    clearCodexAuthPollTimer();
    for (const icon of Object.values(customProviderIcons)) {
      if (icon) URL.revokeObjectURL(icon.url);
    }
    customProviderIcons = {};
    customProviderIconLoads.clear();
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

  async function pollCodexAuth(): Promise<void> {
    clearCodexAuthPollTimer();
    if (codexDeviceAuth && Date.now() > codexDeviceAuth.expiresAt) {
      browserAuthMessages['codex-auth'] = AUTH_EXPIRED_MESSAGE;
      browserAuthPending['codex-auth'] = false;
      codexDeviceAuth = null;
      clearPersistedDeviceAuth('codex-auth');
      return;
    }
    try {
      await loadProvidersFromApi();
      if (getProviderStatus('codex-auth')?.authenticated) {
        browserAuthPending['codex-auth'] = false;
        browserAuthMessages['codex-auth'] = 'OpenAI Codex connected';
        codexDeviceAuth = null;
        clearPersistedDeviceAuth('codex-auth');
        toastStore.success('OpenAI Codex connected');
        return;
      }
      browserAuthMessages['codex-auth'] =
        `Waiting for ChatGPT approval.${deviceAuthCountdown(codexDeviceAuth?.expiresAt)}`;
      codexAuthPollTimer = setTimeout(() => void pollCodexAuth(), 1_500);
    } catch (err: unknown) {
      console.debug(
        'Codex auth poll failed:',
        err instanceof Error ? err.message : String(err),
      );
      browserAuthMessages['codex-auth'] = 'OpenAI Codex sign-in failed — click Auth to try again.';
      browserAuthPending['codex-auth'] = false;
      codexDeviceAuth = null;
      clearPersistedDeviceAuth('codex-auth');
    }
  }

  async function pollCopilotAuth(deviceCode: string, intervalMs: number): Promise<void> {
    clearCopilotPollTimer();
    if (copilotDeviceAuth && Date.now() > copilotDeviceAuth.expiresAt) {
      copilotAuthStatus = 'error';
      copilotAuthMessage = AUTH_EXPIRED_MESSAGE;
      browserAuthMessages.copilot = copilotAuthMessage;
      browserAuthPending.copilot = false;
      copilotDeviceAuth = null;
      clearPersistedDeviceAuth('copilot');
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
        copilotDeviceAuth = null;
        clearPersistedDeviceAuth('copilot');
        return;
      }

      const status = data.data?.status;
      if (status === 'connected') {
        copilotAuthStatus = 'connected';
        copilotAuthMessage = 'GitHub Copilot connected';
        browserAuthMessages.copilot = copilotAuthMessage;
        browserAuthPending.copilot = false;
        copilotDeviceAuth = null;
        clearPersistedDeviceAuth('copilot');
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
        copilotDeviceAuth = null;
        clearPersistedDeviceAuth('copilot');
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
      copilotDeviceAuth = null;
      clearPersistedDeviceAuth('copilot');
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
      clearPersistedDeviceAuth('kimicode');
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
        kimicodeDeviceAuth = null;
        clearPersistedDeviceAuth('kimicode');
        return;
      }

      const status = data.data?.status;
      if (status === 'connected') {
        kimicodeAuthStatus = 'connected';
        kimicodeAuthMessage = 'Kimi Code connected';
        browserAuthMessages.kimicode = kimicodeAuthMessage;
        browserAuthPending.kimicode = false;
        kimicodeDeviceAuth = null;
        clearPersistedDeviceAuth('kimicode');
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
        kimicodeDeviceAuth = null;
        clearPersistedDeviceAuth('kimicode');
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
      kimicodeDeviceAuth = null;
      clearPersistedDeviceAuth('kimicode');
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
        accountSelectionConfigured?: boolean;
        fallbackEnabled?: boolean;
        error?: string;
      }>(res);
      if (data.ok && Array.isArray(data.data)) {
        providerAccounts[name] = data.data;
        if (data.fallbackOrder) {
          fallbackOrders[name] = data.fallbackOrder;
        }
        accountSelectionConfigured[name] = data.accountSelectionConfigured === true;
        fallbackEnabled[name] = data.fallbackEnabled === true;
      } else if (force) {
        providerAccounts[name] = [];
      }
    } catch (err: unknown) {
      console.warn(
        `Failed to load provider accounts for ${name}:`,
        err instanceof Error ? err.message : String(err),
      );
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

  async function saveFallbackOrder(
    name: string,
    order: string[],
    enabled = fallbackEnabled[name] ?? false,
  ): Promise<void> {
    fallbackSaving = name;
    try {
      const res = await apiFetch(apiUrl(`/api/providers/${name}/fallback-order`), {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ order, enabled }),
      });
      const data = await parseJsonResponse<{ ok?: boolean; error?: string }>(res);
      if (data.ok) {
        fallbackOrders[name] = order;
        accountSelectionConfigured[name] = true;
        fallbackEnabled[name] = enabled;
        await loadProvidersFromApi();
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
    const accounts = (providerAccounts[name] ?? []).filter(
      (account) => account.source === 'cli-autodetect',
    );
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
    const staged = fallbackItems[name];
    // This getter is called while Svelte evaluates the template. Mutating a
    // rune here triggers state_unsafe_mutation, so only reuse an already
    // staged drag order when it still describes the same account set.
    if (
      staged &&
      staged.length === ordered.length &&
      staged.every((account) => ordered.some((candidate) => candidate.id === account.id))
    ) {
      return staged;
    }
    return ordered;
  }

  function handleFallbackDndFinalize(name: string, items: StoredProviderAccount[]): void {
    const ordered = normalizeFallbackItems(name, items);
    fallbackItems[name] = ordered;
    const newOrder = ordered.map((a) => a.id);
    void saveFallbackOrder(name, newOrder);
  }

  /** Keep Svelte's keyed list aligned with svelte-dnd-action while a drag is in flight.
   * Without this, the action moves DOM nodes but the next reactive render restores the
   * old array, which makes account tiles appear to consume or vanish. */
  function handleFallbackDndConsider(name: string, items: StoredProviderAccount[]): void {
    fallbackItems[name] = normalizeFallbackItems(name, items);
  }

  function normalizeFallbackItems(
    name: string,
    items: StoredProviderAccount[],
  ): StoredProviderAccount[] {
    const accounts = (providerAccounts[name] ?? []).filter(
      (account) => account.source === 'cli-autodetect',
    );
    const known = new Map(accounts.map((account) => [account.id, account]));
    const normalized: StoredProviderAccount[] = [];
    const seen = new Set<string>();
    for (const item of items) {
      const account = known.get(item.id);
      if (account && !seen.has(account.id)) {
        normalized.push(account);
        seen.add(account.id);
      }
    }
    for (const account of accounts) {
      if (!seen.has(account.id)) normalized.push(account);
    }
    return normalized;
  }

  function setFallbackEnabled(name: string, enabled: boolean): void {
    const accounts = getOrderedFallbackAccounts(name);
    const order = fallbackOrders[name]?.length
      ? fallbackOrders[name]
      : accounts.map((account) => account.id);
    void saveFallbackOrder(name, order, enabled);
  }

  // ─── Connect / disconnect / auth ───────────────────────────────────────

  async function connectProvider(name: string): Promise<ConnectProviderResult> {
    const caps = getProviderCaps(name);
    const apiKey = keyInputs[name]?.trim();
    const authToken = tokenInputs[name]?.trim();
    const baseUrl = urlInputs[name]?.trim();
    const deployment = deploymentInputs[name]?.trim();
    const reuseStoredConfiguration =
      caps.credentialDetected && !apiKey && !authToken && !baseUrl && !deployment;
    if (!reuseStoredConfiguration && caps.authMode === 'api_key' && !apiKey) {
      toastStore.error('Enter API key');
      return { ok: false };
    }
    if (!reuseStoredConfiguration && caps.authMode === 'api_key_or_auth' && !apiKey && !authToken) {
      toastStore.error('Enter API key');
      return { ok: false };
    }
    if (
      !reuseStoredConfiguration &&
      caps.authMode === 'auth_only' &&
      !authToken &&
      !usesBrowserAuth(name) &&
      !usesLocalCliConnection(name)
    ) {
      toastStore.error('Enter auth token');
      return { ok: false };
    }
    if (!reuseStoredConfiguration && caps.authMode === 'base_url_only' && !baseUrl) {
      toastStore.error('Enter endpoint URL');
      return { ok: false };
    }
    if (!reuseStoredConfiguration && caps.requiresDeployment && !deployment) {
      toastStore.error('Enter the deployment name used for inference');
      return { ok: false };
    }

    saving = name;
    connectErrors[name] = '';
    try {
      const body: Record<string, string> = {};
      if (apiKey) body.apiKey = apiKey;
      if (authToken) body.authToken = authToken;
      if (baseUrl) body.baseUrl = baseUrl;
      if (deployment) body.deployment = deployment;
      if (awsRegionInputs[name]?.trim()) body.awsRegion = awsRegionInputs[name].trim();
      if (awsSessionTokenInputs[name]?.trim())
        body.awsSessionToken = awsSessionTokenInputs[name].trim();
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
        deploymentInputs[name] = '';
        awsSessionTokenInputs[name] = '';
        const status = await refreshProviderStatus(name, { warmModelList: true });
        if (status?.connectionState === 'verified') {
          toastStore.success(
            usesLocalCliConnection(name)
              ? `${getProviderDisplayLabel(name)} CLI login verified`
              : `${getProviderDisplayLabel(name)} credential verified`,
          );
        } else {
          toastStore.info(
            `${getProviderDisplayLabel(name)} configuration saved; provider access is not verified`,
          );
        }
        const openModelSelector =
          status?.connectionState === 'verified' &&
          !status.hideModelSelector &&
          (status.allAvailableModels?.length ?? 0) > 0;
        return { ok: true, openModelSelector, status };
      }
      const errMsg = data.error ?? 'Connection failed';
      connectErrors[name] = errMsg;
      toastStore.error(errMsg);
      return { ok: false };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Network error';
      connectErrors[name] = message;
      toastStore.error(message);
      return { ok: false };
    } finally {
      saving = null;
      verifying = null;
    }
  }

  async function startBrowserAuthFlow(
    name: string,
    options: { saveAccount?: boolean } = {},
  ): Promise<BrowserAuthStartResult> {
    void options;
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

      if (data.data.status === 'connected' || data.data.status === 'detected') {
        const detectedOnly = data.data.status === 'detected';
        if (isDeviceAuthProvider(name)) clearDeviceAuthForProvider(name);
        browserAuthPending[name] = false;
        browserAuthMessages[name] = data.data.message ?? '';
        const sync = await syncProviderUi(name, {
          openModelSelector: true,
          successMessage: detectedOnly
            ? `${getProviderDisplayLabel(name)} CLI setup recorded`
            : `${getProviderDisplayLabel(name)} connected`,
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
        clearCopilotPollTimer();
        copilotDeviceAuth = {
          deviceAuthId: data.data.deviceAuthId,
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
        saveRecoverableDeviceAuthFlow('copilot', copilotDeviceAuth);
        void pollCopilotAuth(copilotDeviceAuth.deviceCode, copilotDeviceAuth.intervalMs);
      } else if (
        name === 'kimicode' &&
        data.data.deviceCode &&
        data.data.userCode &&
        data.data.verificationUri
      ) {
        clearKimiCodePollTimer();
        kimicodeDeviceAuth = {
          deviceAuthId: data.data.deviceAuthId,
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
        saveRecoverableDeviceAuthFlow('kimicode', kimicodeDeviceAuth);
        void pollKimiCodeAuth(kimicodeDeviceAuth.deviceCode, kimicodeDeviceAuth.intervalMs);
      } else if (
        name === 'codex-auth' &&
        data.data.deviceCode &&
        data.data.userCode &&
        data.data.verificationUri
      ) {
        clearCodexAuthPollTimer();
        codexDeviceAuth = {
          deviceAuthId: data.data.deviceAuthId,
          deviceCode: data.data.deviceCode,
          userCode: data.data.userCode,
          verificationUri: data.data.verificationUri,
          verificationUriComplete: data.data.verificationUriComplete,
          expiresAt: Date.now() + (data.data.expiresIn ?? 900) * 1000,
          intervalMs: Math.max(1000, (data.data.interval ?? 5) * 1000),
        };
        browserAuthMessages[name] =
          'Enter the displayed code in ChatGPT. Koryphaios connects automatically after approval.';
        saveRecoverableDeviceAuthFlow('codex-auth', codexDeviceAuth);
        void pollCodexAuth();
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
      if (isDeviceAuthProvider(name)) clearDeviceAuthForProvider(name);
      await loadProvidersFromApi();
      const status = getProviderStatus(name);
      if (status?.connectionState === 'verified') {
        toastStore.success(`${getProviderDisplayLabel(name)} access verified`);
      } else {
        toastStore.info(
          `${getProviderDisplayLabel(name)} CLI setup recorded; account access remains unverified`,
        );
      }
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
        if (isDeviceAuthProvider(name)) clearDeviceAuthForProvider(name);
        await loadProvidersFromApi();
        toastStore.info(`${getProviderDisplayLabel(name)} disconnected`);
      }
    } catch (err: unknown) {
      console.warn(
        `Failed to disconnect provider ${name}:`,
        err instanceof Error ? err.message : String(err),
      );
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
    allowUnverified?: boolean;
  }): Promise<AddCustomProviderResult> {
    const label = form.label.trim();
    const baseUrl = form.baseUrl.trim();
    if (!label) {
      toastStore.error('Enter a display name');
      return { ok: false, error: 'Enter a display name' };
    }
    if (!baseUrl) {
      toastStore.error('Enter the base URL');
      return { ok: false, error: 'Enter the base URL' };
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
          allowUnverified: form.allowUnverified === true,
        }),
      });
      const data = await parseJsonResponse<{
        ok?: boolean;
        error?: string;
        canSaveUnverified?: boolean;
        requiresManualModels?: boolean;
        normalizedBaseUrl?: string;
        data?: { id?: string; catalogDetected?: boolean; normalizedBaseUrl?: string };
      }>(res);
      if (data?.ok) {
        toastStore.success(
          data.data?.catalogDetected
            ? `Catalog access confirmed — ${label} was added; inference verifies on first use`
            : `${label} saved with manual models; connection is still unverified`,
        );
        await loadAvailableProviders();
        await loadProvidersFromApi();
        return {
          ok: true,
          id: data.data?.id,
          catalogDetected: data.data?.catalogDetected,
          normalizedBaseUrl: data.data?.normalizedBaseUrl,
        };
      }
      return {
        ok: false,
        error: data?.error ?? 'Failed to add custom provider',
        canSaveUnverified: data?.canSaveUnverified,
        requiresManualModels: data?.requiresManualModels,
        normalizedBaseUrl: data?.normalizedBaseUrl,
      };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Network error';
      return { ok: false, error: message };
    } finally {
      addingCustom = false;
    }
  }

  async function saveCustomProviderIcon(
    id: string,
    selection: CustomProviderIconSelection,
  ): Promise<boolean> {
    try {
      let blob = selection.blob;
      if (!blob) {
        const cached = customProviderIcons[id];
        if (!cached) {
          toastStore.error('The current icon is not loaded yet. Try again in a moment.');
          return false;
        }
        blob = await fetch(cached.url).then((response) => response.blob());
      }
      const uploadBlob = blob;
      if (!uploadBlob) return false;
      const form = new FormData();
      form.append('icon', uploadBlob, 'provider-icon.png');
      form.append('shape', selection.shape);
      const response = await apiFetch(
        apiUrl(`/api/providers/custom/${encodeURIComponent(id)}/icon`),
        { method: 'PUT', body: form },
      );
      const data = await parseJsonResponse<{ ok?: boolean; error?: string }>(response);
      if (!data.ok) {
        toastStore.error(data.error ?? 'The custom icon could not be saved');
        return false;
      }
      revokeCustomProviderIcon(id);
      await loadProvidersFromApi();
      toastStore.success('Custom provider icon saved');
      return true;
    } catch (error: unknown) {
      toastStore.error(error instanceof Error ? error.message : 'The custom icon could not be saved');
      return false;
    }
  }

  async function removeCustomProviderIcon(id: string): Promise<boolean> {
    try {
      const response = await apiFetch(
        apiUrl(`/api/providers/custom/${encodeURIComponent(id)}/icon`),
        { method: 'DELETE' },
      );
      const data = await parseJsonResponse<{ ok?: boolean; error?: string }>(response);
      if (!data.ok) {
        toastStore.error(data.error ?? 'The custom icon could not be removed');
        return false;
      }
      revokeCustomProviderIcon(id);
      await loadProvidersFromApi();
      toastStore.info('Custom provider icon removed');
      return true;
    } catch (error: unknown) {
      toastStore.error(
        error instanceof Error ? error.message : 'The custom icon could not be removed',
      );
      return false;
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

    // All display metadata (label, placeholder, requiresBaseUrl) comes from
    // the backend status response — the single source of truth. No hardcoded
    // provider label/placeholder dicts that drift out of sync.
    return types
      .map((type) => {
        const status = statusList.find((p) => p.name === type.name);
        const label =
          status?.label ||
          PROVIDER_LABEL_FALLBACK[type.name] ||
          (type.name.startsWith('custom:')
            ? type.name.slice('custom:'.length)
            : type.name.charAt(0).toUpperCase() + type.name.slice(1));
        const placeholder = status?.baseUrlPlaceholder || 'API key...';
        const needsUrl = !!status?.requiresBaseUrl || type.name.startsWith('custom:');
        return { key: type.name, label, placeholder, needsUrl };
      })
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
    get cliAccountSelectionRequired() {
      return cliAccountSelectionRequired;
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
    get deploymentInputs() {
      return deploymentInputs;
    },
    set deploymentInputs(v: Record<string, string>) {
      deploymentInputs = v;
    },
    get awsRegionInputs() {
      return awsRegionInputs;
    },
    set awsRegionInputs(v: Record<string, string>) {
      awsRegionInputs = v;
    },
    get awsSessionTokenInputs() {
      return awsSessionTokenInputs;
    },
    set awsSessionTokenInputs(v: Record<string, string>) {
      awsSessionTokenInputs = v;
    },
    get awsCredentialScans() {
      return awsCredentialScans;
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
    get accountSelectionConfigured() {
      return accountSelectionConfigured;
    },
    get fallbackEnabled() {
      return fallbackEnabled;
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
    get connectErrors() {
      return connectErrors;
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
    get customProviderIcons() {
      return customProviderIcons;
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
    get codexDeviceAuth() {
      return codexDeviceAuth;
    },
    get kimicodeAuthStatus() {
      return kimicodeAuthStatus;
    },
    get kimicodeAuthMessage() {
      return kimicodeAuthMessage;
    },
    get tokenPlaceholders() {
      return TOKEN_PLACEHOLDERS;
    },

    browserAuthProviders,
    getProviderDisplayLabel,
    getKnownAuthMode,
    usesBrowserAuth,
    usesLocalCliConnection,
    getLocalCliConnectLabel,
    getProviderCaps,
    getProviderStatus,
    getCustomProviderIcon,
    getProviderAccounts,
    setProviderStatusList,
    loadProvidersFromApi,
    loadAvailableProviders,
    loadDetectedClis,
    loadAwsCredentialScan,
    refreshAwsScanAndStatus,
    refreshProviderStatus,
    syncProviderUi,
    loadProviderAccounts,
    saveAccountProfileLabel,
    saveFallbackOrder,
    setFallbackEnabled,
    getOrderedFallbackAccounts,
    handleFallbackDndConsider,
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
    saveCustomProviderIcon,
    removeCustomProviderIcon,
    copyToClipboard,
    clearAccountManagerRequest,
    clearModelSelectorRequest,
    destroy,
  };
}

export const providersStore = createProvidersStore();

/** @deprecated Use providersStore.loadProvidersFromApi — kept for gradual migration */
export async function loadProvidersFromApi(options?: {
  forceRefreshModels?: boolean;
}): Promise<boolean> {
  return providersStore.loadProvidersFromApi(options);
}
