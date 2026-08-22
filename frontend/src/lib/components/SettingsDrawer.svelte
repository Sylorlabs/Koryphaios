<script lang="ts">
  import { onDestroy, onMount, tick } from 'svelte';
  import { providersStore } from '$lib/stores/providers.svelte';
  import { theme } from '$lib/stores/theme.svelte';
  import { shortcutStore } from '$lib/stores/shortcuts.svelte';
  import { defaultShortcuts as globalDefaultShortcuts } from '$lib/stores/shortcuts.svelte';
  import { toastStore } from '$lib/stores/toast.svelte';
  import { formatKey } from '$lib/utils/platform';
  import Key from 'lucide-svelte/icons/key';
  import Palette from 'lucide-svelte/icons/palette';
  import Keyboard from 'lucide-svelte/icons/keyboard';
  import Check from 'lucide-svelte/icons/check';
  import Copy from 'lucide-svelte/icons/copy';
  import Zap from 'lucide-svelte/icons/zap';
  import Server from 'lucide-svelte/icons/server';
  import Cpu from 'lucide-svelte/icons/cpu';
  import X from 'lucide-svelte/icons/x';
  import Shield from 'lucide-svelte/icons/shield';
  import Search from 'lucide-svelte/icons/search';
  import CreditCard from 'lucide-svelte/icons/credit-card';
  import AlertTriangle from 'lucide-svelte/icons/alert-triangle';
  import Brain from 'lucide-svelte/icons/brain';
  import Bot from 'lucide-svelte/icons/bot';
  import FlaskConical from 'lucide-svelte/icons/flask-conical';
  import Sparkles from 'lucide-svelte/icons/sparkles';
  import Terminal from 'lucide-svelte/icons/terminal';
  import Users from 'lucide-svelte/icons/users';
  import MessageSquare from 'lucide-svelte/icons/message-square';
  import RotateCcw from 'lucide-svelte/icons/rotate-ccw';
  import Save from 'lucide-svelte/icons/save';
  import GripVertical from 'lucide-svelte/icons/grip-vertical';
  import Plus from 'lucide-svelte/icons/plus';
  import Trash2 from 'lucide-svelte/icons/trash-2';
  import StickyNote from 'lucide-svelte/icons/sticky-note';
  import FolderOpen from 'lucide-svelte/icons/folder-open';
  import RefreshCw from 'lucide-svelte/icons/refresh-cw';
  import Eye from 'lucide-svelte/icons/eye';
  import EyeOff from 'lucide-svelte/icons/eye-off';
  import AudioLines from 'lucide-svelte/icons/audio-lines';
  import ImageIcon from 'lucide-svelte/icons/image';
  import Plug from 'lucide-svelte/icons/plug';
  import Clock3 from 'lucide-svelte/icons/clock-3';
  import MemoryEditor from './MemoryEditor.svelte';
  import AgentSettings from './AgentSettings.svelte';
  import ExperimentalSettings from './ExperimentalSettings.svelte';
  import ProviderIcon from './icons/ProviderIcon.svelte';
  import { memoryStore } from '$lib/stores/memory.svelte';
  import { agentSettingsStore } from '$lib/stores/agent-settings.svelte';
  import { experimentalStore } from '$lib/stores/experimental.svelte';
  import { collaborationStore } from '$lib/stores/collaboration.svelte';
  import { notesStore } from '$lib/stores/notes.svelte';
  import { projectStore } from '$lib/stores/project.svelte';
  import { sessionStore } from '$lib/stores/sessions.svelte';
  import {
    NOTE_TOOL_DEFINITIONS,
    type NotePermissionLevel,
    type NotesPermissionPreset,
  } from '@koryphaios/shared';
  import ModelSelectionDialog from './ModelSelectionDialog.svelte';
  import TeamAccessProfiles from './TeamAccessProfiles.svelte';
  import ColorPickerModal from './ColorPickerModal.svelte';
  import AppearanceSettings from './AppearanceSettings.svelte';
  import ConfirmDialog from './ConfirmDialog.svelte';
  import ModelSharingPanel from './ModelSharingPanel.svelte';
  import NumberStepper from './NumberStepper.svelte';
  import KorySlider from './KorySlider.svelte';
  import SettingsSwitch from './SettingsSwitch.svelte';
  import KorySelect from './KorySelect.svelte';
  import VoiceSettings from './VoiceSettings.svelte';
  import ImageSettings from './ImageSettings.svelte';
  import McpServersSettings from './McpServersSettings.svelte';
  import { mcpServersStore } from '$lib/stores/mcp-servers.svelte';
  import { apiUrl } from '$lib/utils/api-url';
  import { apiFetch, parseJsonResponse } from '$lib/api.svelte';
  import {
    filterSettingsCatalog,
    resolveSettingsTab,
    SETTINGS_CATALOG,
    SETTINGS_GROUPS,
    type SettingsTab,
  } from '$lib/utils/settings-catalog';
  import { shouldRemaskSecrets } from '$lib/utils/secret-visibility';
  import { dndzone } from 'svelte-dnd-action';
  import { invoke } from '@tauri-apps/api/core';

  interface Props {
    open?: boolean;
    initialTab?: SettingsTab | undefined;
    initialAgentSection?: 'permissions';
    onClose?: () => void;
  }

  let { open = false, initialTab, initialAgentSection, onClose }: Props = $props();
  let activeTab = $state<SettingsTab>('providers');
  let settingsSearch = $state('');
  let wasOpen = $state(false);
  let settingsDialog = $state<HTMLDivElement | null>(null);
  let settingsSearchInput = $state<HTMLInputElement | null>(null);
  let previouslyFocused = $state<HTMLElement | null>(null);
  const SETTINGS_PANE_STORAGE_KEY = 'koryphaios-settings-last-pane';
  const settingsIcons: Record<SettingsTab, typeof Key> = {
    providers: Key,
    agent: Bot,
    memory: Brain,
    notes: StickyNote,
    appearance: Palette,
    shortcuts: Keyboard,
    voice: AudioLines,
    teams: Users,
    billing: CreditCard,
    experimental: Shield,
    images: ImageIcon,
    mcp: Plug,
  };
  const filteredSettingsCatalog = $derived(filterSettingsCatalog(SETTINGS_CATALOG, settingsSearch));
  const selectedSettingsEntry = $derived(
    SETTINGS_CATALOG.find((entry) => entry.id === activeTab) ?? SETTINGS_CATALOG[0],
  );

  function readSavedSettingsTab(): string | null {
    if (typeof localStorage === 'undefined') return null;
    try {
      return localStorage.getItem(SETTINGS_PANE_STORAGE_KEY);
    } catch {
      return null;
    }
  }

  function selectSettingsTab(tab: SettingsTab) {
    activeTab = tab;
    if (typeof localStorage !== 'undefined') {
      try {
        localStorage.setItem(SETTINGS_PANE_STORAGE_KEY, tab);
      } catch {
        // A blocked storage API must not make Settings navigation unusable.
      }
    }
  }

  let showModelSelector = $state(false);
  let selectorTarget = $state<any>(null);
  let showColorPicker = $state(false);
  let showRotateDialog = $state(false);
  let rotateProvider = $state<{ name: string; keyType: 'apiKey' | 'authToken' } | null>(null);
  let showAccountManageDialog = $state(false);
  let managingAccountProvider = $state<string | null>(null);
  let managingAccountId = $state<string | null>(null);
  let managingAccountLabel = $state('');
  let managingAccountSaving = $state(false);
  let newKeyValue = $state('');
  let teamJoinCode = $state('');
  let teamGuestName = $state('');
  let hostWorkspacePaths = $state<string[]>(
    projectStore.currentPath ? [projectStore.currentPath] : [],
  );
  let hostPathsInitializedFor = $state<string | null>(projectStore.currentPath);
  let rotateKeyInput = $state<HTMLInputElement | null>(null);
  let visibleSecrets = $state<Record<string, boolean>>({});

  // Apply a requested destination only as the drawer opens. This lets a
  // contextual shortcut (such as Goal settings) land on Advanced without
  // forcing the user back there when they explore another settings tab.
  $effect(() => {
    if (shouldRemaskSecrets(open, wasOpen)) visibleSecrets = {};
    if (open && !wasOpen) {
      previouslyFocused =
        document.activeElement instanceof HTMLElement ? document.activeElement : null;
      selectSettingsTab(resolveSettingsTab(initialTab, readSavedSettingsTab()));
      settingsSearch = '';
      // Memory and Agent are single-page consoles. Their specialised editors
      // remain available from within the page, rather than becoming a second
      // row of navigation under Settings.
      memoryStore.setActiveTab('settings');
      agentSettingsStore.setActiveTab('settings');
      void tick().then(() => settingsSearchInput?.focus());
    } else if (!open && wasOpen) {
      const target = previouslyFocused;
      previouslyFocused = null;
      void tick().then(() => target?.focus());
    }
    wasOpen = open;
  });

  onMount(() => {
    const openProviderAccounts = () => {
      selectSettingsTab('providers');
      const ambiguous = providersStore.cliAccountSelectionRequired[0];
      if (ambiguous) {
        expandedProvider = ambiguous;
        void loadProviderAccounts(ambiguous, true);
      }
    };
    window.addEventListener('open-provider-account-settings', openProviderAccounts);
    // Capture before the page-level shortcut handler. Otherwise assigning a
    // binding such as Ctrl+K can trigger the old global action before this
    // drawer has a chance to save the newly captured binding.
    const captureShortcutAssignment = (event: KeyboardEvent) => {
      if (editingShortcutId) handleShortcutKeydown(event);
    };
    window.addEventListener('keydown', captureShortcutAssignment, { capture: true });
    return () => {
      window.removeEventListener('open-provider-account-settings', openProviderAccounts);
      window.removeEventListener('keydown', captureShortcutAssignment, { capture: true });
    };
  });

  function secretInputType(id: string): 'text' | 'password' {
    return visibleSecrets[id] ? 'text' : 'password';
  }

  function toggleSecretVisibility(id: string) {
    visibleSecrets = { ...visibleSecrets, [id]: !visibleSecrets[id] };
  }

  $effect(() => {
    const current = projectStore.currentPath;
    if (
      activeTab !== 'teams' ||
      collaborationStore.activeCollab ||
      current === hostPathsInitializedFor
    )
      return;
    hostPathsInitializedFor = current;
    if (current) hostWorkspacePaths = [current];
  });

  function updateHostWorkspacePath(index: number, value: string) {
    hostWorkspacePaths = hostWorkspacePaths.map((path, i) => (i === index ? value : path));
  }

  function removeHostWorkspacePath(index: number) {
    hostWorkspacePaths = hostWorkspacePaths.filter((_, i) => i !== index);
  }

  async function addHostWorkspacePath() {
    try {
      const selected = await invoke<string | null>('select_folder_dialog');
      if (!selected || hostWorkspacePaths.includes(selected)) return;
      hostWorkspacePaths = [...hostWorkspacePaths, selected];
    } catch (error) {
      toastStore.error(error instanceof Error ? error.message : 'Could not open folder picker');
    }
  }

  async function startHosting() {
    const paths = [...new Set(hostWorkspacePaths.map((path) => path.trim()).filter(Boolean))];
    if (!paths.length) {
      toastStore.error('Add at least one workspace path before hosting');
      return;
    }
    if (await collaborationStore.hostSession(paths)) onClose?.();
  }

  const NOTE_PERMISSION_PRESETS: Array<{
    id: Exclude<NotesPermissionPreset, 'custom'>;
    label: string;
    description: string;
  }> = [
    { id: 'default', label: 'Default', description: 'Reads auto, writes ask' },
    { id: 'allow_all', label: 'Allow all', description: 'Agents run without prompts' },
    { id: 'ask_all', label: 'Ask all', description: 'Confirm every action' },
    { id: 'block_all', label: 'Block all', description: 'Hide all note tools from agents' },
  ];

  const permissionLevelLabels: Record<NotePermissionLevel, string> = {
    auto: 'Allow',
    ask: 'Ask',
    block: 'Hide',
  };
  let loadedNotesProject: string | null = null;
  let loadedAgentProject: string | null = null;

  $effect(() => {
    const projectPath = projectStore.currentPath;
    if (open && activeTab === 'notes' && loadedNotesProject !== projectPath) {
      loadedNotesProject = projectPath;
      void notesStore.fetchAgentPermissions();
      // Settings are persisted server-side (context injection honors them) —
      // refresh from the source of truth instead of trusting the local mirror.
      void notesStore.fetchSettings();
    }
    if (open && activeTab === 'agent' && loadedAgentProject !== projectPath) {
      loadedAgentProject = projectPath;
      void agentSettingsStore.loadAll();
    }
  });

  $effect(() => {
    if (showRotateDialog) {
      void tick().then(() => rotateKeyInput?.focus());
    }
  });

  function handleKeydown(e: KeyboardEvent) {
    if (!open || e.defaultPrevented) return;
    if (e.key === 'Escape') {
      if (
        showModelSelector ||
        showColorPicker ||
        showRotateDialog ||
        showAccountManageDialog ||
        pendingDeleteProvider
      )
        return;
      onClose?.();
      return;
    }
    if (e.key !== 'Tab' || !settingsDialog?.contains(e.target as Node)) return;
    const focusable = [
      ...settingsDialog.querySelectorAll<HTMLElement>(
        'button:not([disabled]), input:not([disabled]), textarea:not([disabled]), [href], [tabindex]:not([tabindex="-1"])',
      ),
    ].filter((element) => element.getClientRects().length > 0);
    const first = focusable[0];
    const last = focusable.at(-1);
    if (!first || !last) return;
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  }

  // ─── Provider Management (store-backed) ───────────────────────────────
  const {
    getProviderDisplayLabel,
    getProviderCaps,
    getProviderStatus,
    getProviderAccounts,
    usesBrowserAuth,
    usesLocalCliConnection,
    getLocalCliConnectLabel,
    loadProvidersFromApi,
    loadAvailableProviders,
    loadDetectedClis,
    loadProviderAccounts,
    connectProvider,
    startBrowserAuthFlow,
    finishBrowserAuthFlow,
    disconnectProvider,
    saveProviderAccount,
    activateProviderAccount,
    deleteProviderAccount,
    saveSelectedModels: saveProviderModels,
    rotateProviderKey,
    addCustomProvider: addCustomProviderToStore,
    deleteCustomProvider: deleteCustomProviderFromStore,
    saveAccountProfileLabel,
    getOrderedFallbackAccounts,
    handleFallbackDndConsider,
    handleFallbackDndFinalize,
    saveFallbackOrder,
    setFallbackEnabled,
    copyToClipboard,
  } = providersStore;

  function isAccountSelected(provider: string, accountId: string): boolean {
    return (
      providersStore.accountSelectionConfigured[provider] !== true ||
      (providersStore.fallbackOrders[provider] ?? []).includes(accountId)
    );
  }

  async function toggleCliAccount(provider: string, accountId: string, enabled: boolean) {
    const current = providersStore.fallbackOrders[provider] ?? [];
    const next = enabled
      ? [...current.filter((id) => id !== accountId), accountId]
      : current.filter((id) => id !== accountId);
    await saveFallbackOrder(provider, next);
  }

  function getCliProfileAccounts(provider: string) {
    return getProviderAccounts(provider).filter((account) => account.source === 'cli-autodetect');
  }

  function hasMultipleCliProfiles(provider: string): boolean {
    return getCliProfileAccounts(provider).length > 1;
  }

  let providersLoadAttempted = $state(false);
  let lastInitializedTab = $state<typeof activeTab | null>(null);
  let handledTeamSettingsRequest = 0;

  $effect(() => {
    if (collaborationStore.settingsRequest > handledTeamSettingsRequest) {
      handledTeamSettingsRequest = collaborationStore.settingsRequest;
      selectSettingsTab('teams');
    }
  });

  function showTokenInput(_name: string, caps: ReturnType<typeof getProviderCaps>): boolean {
    return caps.supportsAuthToken;
  }

  function refreshProviderSection() {
    if (providersStore.availableProviderTypes.length === 0) void loadAvailableProviders();
    void loadProvidersFromApi({ forceRefreshModels: true });
    void loadDetectedClis();
  }

  $effect(() => {
    if (!open) {
      providersLoadAttempted = false;
      lastInitializedTab = null;
      return;
    }

    if (activeTab === 'providers') {
      if (!providersLoadAttempted) {
        providersLoadAttempted = true;
        refreshProviderSection();
      }
    } else {
      providersLoadAttempted = false;
    }

    if (activeTab === lastInitializedTab) return;
    lastInitializedTab = activeTab;

    // Project-aware effects above own Memory and Agent initialization. Calling
    // them again here caused duplicate requests and visible loading flicker.
    if (activeTab === 'experimental') void experimentalStore.loadAll();
    if (activeTab === 'mcp') void mcpServersStore.loadAll();
  });

  $effect(() => {
    const request = providersStore.accountManagerRequest;
    if (!request) return;
    managingAccountProvider = request.provider;
    managingAccountId = request.account.id;
    managingAccountLabel = request.account.label;
    showAccountManageDialog = true;
    providersStore.clearAccountManagerRequest();
  });

  $effect(() => {
    const status = providersStore.modelSelectorRequest;
    if (!status) return;
    expandedProvider = status.name;
    selectorTarget = status;
    showModelSelector = true;
    providersStore.clearModelSelectorRequest();
  });

  let providerSearchQuery = $state('');
  const clineSignInCommand = 'cline auth --provider cline --apikey <YOUR_KEY>';
  type ProviderCategory = 'all' | 'ready' | 'auth' | 'subscriptions' | 'api' | 'local' | 'custom';
  let providerCategory = $state<ProviderCategory>('all');
  const PROVIDER_CATEGORIES: Array<{ id: ProviderCategory; label: string }> = [
    { id: 'all', label: 'All' },
    { id: 'ready', label: 'Configured' },
    { id: 'auth', label: 'Auth' },
    { id: 'subscriptions', label: 'CLI subscriptions' },
    { id: 'api', label: 'API' },
    { id: 'local', label: 'Local' },
    { id: 'custom', label: 'Custom' },
  ];
  const LOCAL_PROVIDER_KEYS = new Set(['local', 'ollama', 'lmstudio', 'llamacpp']);
  const AUTH_PROVIDER_KEYS = new Set(['codex-auth']);
  const CUSTOM_PROVIDER_KEYS = new Set(['custom']);
  // Categorization is based on the provider being used, not incidental CLI
  // detection. For example, installing `claude` must not reclassify the
  // direct `anthropic` API provider as a subscription.
  const CLI_SUBSCRIPTION_PROVIDER_KEYS = new Set([
    'claude',
    'codex',
    'grok',
    'antigravity',
    'cursor',
    'devin',
    'cline',
    'copilot',
  ]);
  const LOCAL_ENDPOINT_PROVIDER_KEYS = new Set(['local', 'ollama', 'lmstudio', 'llamacpp']);
  const isCliExecutionProvider = (providerKey: string): boolean =>
    CLI_SUBSCRIPTION_PROVIDER_KEYS.has(providerKey) &&
    !LOCAL_ENDPOINT_PROVIDER_KEYS.has(providerKey);
  const providerCategoryFor = (provider: {
    key: string;
  }): Exclude<ProviderCategory, 'all' | 'ready'> => {
    if (LOCAL_PROVIDER_KEYS.has(provider.key)) return 'local';
    if (CUSTOM_PROVIDER_KEYS.has(provider.key)) return 'custom';
    if (AUTH_PROVIDER_KEYS.has(provider.key)) return 'auth';
    if (CLI_SUBSCRIPTION_PROVIDER_KEYS.has(provider.key)) {
      return 'subscriptions';
    }
    return 'api';
  };
  const installedClis = $derived(providersStore.detectedClis.filter((c) => c.installed));
  // Detection is useful setup detail, but it duplicates the provider cards if
  // shown in the default catalog. Keep it with the CLI subscription filter,
  // the one place where the distinction between installed and connected is
  // actionable.
  const showDetectedCliSummary = $derived(
    providerCategory === 'subscriptions' && installedClis.length > 0,
  );
  const filteredProviderList = $derived.by(() => {
    const q = providerSearchQuery.trim().toLowerCase();
    return providersStore.providerList
      .filter((provider) => {
        const status = getProviderStatus(provider.key);
        if (providerCategory === 'ready') {
          return Boolean(status?.credentialDetected ?? status?.authenticated);
        }
        return providerCategory === 'all' || providerCategoryFor(provider) === providerCategory;
      })
      .filter(
        (provider) =>
          !q || provider.label.toLowerCase().includes(q) || provider.key.toLowerCase().includes(q),
      )
      .sort((left, right) => {
        const rank = (providerKey: string): number => {
          const status = getProviderStatus(providerKey);
          if (status?.connectionState === 'verified') return 0;
          if (status?.credentialDetected ?? status?.authenticated) return 1;
          return 2;
        };
        const leftReady = rank(left.key);
        const rightReady = rank(right.key);
        return leftReady - rightReady || left.label.localeCompare(right.label);
      });
  });

  function deploymentLabel(
    deployment: 'cloud' | 'api' | 'local' | 'hybrid' | undefined | null,
    providerKey: string,
  ): string | null {
    if (AUTH_PROVIDER_KEYS.has(providerKey)) return 'OpenAI Codex';
    if (deployment === 'cloud') return 'Cloud agent';
    if (deployment === 'local')
      return isCliExecutionProvider(providerKey) ? 'CLI' : 'Local endpoint';
    return null;
  }

  function deploymentDescription(
    deployment: 'cloud' | 'api' | 'local' | 'hybrid' | undefined | null,
    providerKey: string,
  ): string | null {
    if (AUTH_PROVIDER_KEYS.has(providerKey))
      return 'OpenAI Codex sign-in · managed by local Codex app-server';
    if (deployment === 'cloud') {
      return 'Cloud agent · sync via git pull / gh pr checkout';
    }
    if (deployment === 'local') {
      return isCliExecutionProvider(providerKey)
        ? 'CLI provider — runs via local CLI'
        : 'Local endpoint';
    }
    return null;
  }
  const teamModels = $derived.by(() =>
    providersStore.statusList
      .filter((provider) => provider.enabled && provider.connectionState === 'verified')
      .flatMap((provider) =>
        (provider.selectedModels?.length ? provider.selectedModels : provider.models).map(
          (model) => ({
            id: `${provider.name}:${model}`,
            provider: getProviderDisplayLabel(provider.name),
            model,
            reasoningLevels:
              provider.allAvailableModels?.find(
                (def) => def.id === model || def.apiModelId === model,
              )?.reasoningLevels ?? [],
          }),
        ),
      )
      .filter((item, index, all) => all.findIndex((other) => other.id === item.id) === index),
  );

  let expandedProvider = $state<string | null>(null);
  let showAddCustom = $state(false);
  let customForm = $state({ label: '', kind: 'openai', baseUrl: '', apiKey: '', models: '' });
  let copiedEndpoint = $state(false);
  let pendingDeleteProvider = $state<{ id: string; label: string } | null>(null);

  async function addCustomProvider() {
    const ok = await addCustomProviderToStore(customForm);
    if (ok) {
      customForm = { label: '', kind: 'openai', baseUrl: '', apiKey: '', models: '' };
      showAddCustom = false;
    }
  }

  async function deleteCustomProvider(id: string) {
    const provider = providersStore.providerList.find((p) => p.key === id);
    pendingDeleteProvider = { id, label: provider?.label ?? id };
  }

  async function confirmDeleteCustomProvider() {
    if (!pendingDeleteProvider) return;
    const ok = await deleteCustomProviderFromStore(pendingDeleteProvider.id);
    if (ok) expandedProvider = null;
    pendingDeleteProvider = null;
  }

  async function handleConnectProvider(name: string) {
    const result = await connectProvider(name);
    if (result.ok) {
      expandedProvider = null;
      if (result.openModelSelector && result.status) {
        setTimeout(() => {
          selectorTarget = result.status ?? null;
          showModelSelector = true;
        }, 100);
      }
    }
  }

  async function handleStartBrowserAuth(name: string, options: { saveAccount?: boolean } = {}) {
    const result = await startBrowserAuthFlow(name, options);
    if (result.kind === 'connected') {
      expandedProvider = name;
      if (result.openModelSelector && result.status) {
        selectorTarget = result.status;
        showModelSelector = true;
      }
      return;
    }
    if (result.kind === 'started') {
      expandedProvider = name;
    }
  }

  async function handleFinishBrowserAuth(name: string) {
    await finishBrowserAuthFlow(name);
  }

  async function saveSelectedModels(selected: string[], hideSelector: boolean) {
    if (!selectorTarget) return;
    const ok = await saveProviderModels(selectorTarget.name, selected, hideSelector);
    if (ok) {
      showModelSelector = false;
      selectorTarget = null;
    }
  }

  function modelSelectorTarget(status: any) {
    const accounts = getProviderAccounts(status.name).filter(
      (account) => account.source === 'cli-autodetect',
    );
    // A single CLI profile is the provider's normal connection, not an
    // account-selection flow. Filtering it through fallback state can make
    // its models disappear even though there is nothing to choose between.
    if (accounts.length < 2) return status;
    const enabledAccounts = new Set(providersStore.fallbackOrders[status.name] ?? []);
    const models = (status.allAvailableModels ?? []).filter((model: any) =>
      enabledAccounts.has(model.accountId),
    );
    return {
      ...status,
      allAvailableModels: models,
      selectedModels: (status.selectedModels ?? []).filter((id: string) =>
        models.some((model: any) => model.id === id),
      ),
      emptyMessage:
        enabledAccounts.size === 0
          ? 'Turn on an account to manage models.'
          : 'The enabled accounts did not report any models.',
    };
  }

  function openModelSelector(status: any) {
    selectorTarget = modelSelectorTarget(status);
    showModelSelector = true;
  }

  function openAccountManager(provider: string, account: { id: string; label: string }) {
    managingAccountProvider = provider;
    managingAccountId = account.id;
    managingAccountLabel = account.label;
    showAccountManageDialog = true;
  }

  async function saveAccountProfileLabelFromDialog() {
    if (!managingAccountProvider || !managingAccountId) return;
    managingAccountSaving = true;
    try {
      const ok = await saveAccountProfileLabel(
        managingAccountProvider,
        managingAccountId,
        managingAccountLabel,
      );
      if (ok) managingAccountLabel = managingAccountLabel.trim();
    } finally {
      managingAccountSaving = false;
    }
  }

  function manageAccountModels() {
    if (!managingAccountProvider) return;
    const status = getProviderStatus(managingAccountProvider);
    if (!status) {
      toastStore.error('Provider is not connected');
      return;
    }
    openModelSelector(status);
  }

  $effect(() => {
    if (open && activeTab === 'providers' && expandedProvider) {
      void loadProviderAccounts(expandedProvider);
    }
  });

  onDestroy(() => {
    providersStore.destroy();
  });

  // ─── Shortcuts ───────────────────────────────────────────────────────
  let editingShortcutId = $state<string | null>(null);
  let capturedKeys = $state<string[]>([]);

  function startEditShortcut(id: string) {
    editingShortcutId = id;
    capturedKeys = [];
  }
  function handleShortcutKeydown(e: KeyboardEvent) {
    if (!editingShortcutId) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    const keys: string[] = [];
    if (e.ctrlKey) keys.push('Ctrl');
    if (e.shiftKey) keys.push('Shift');
    if (e.altKey) keys.push('Alt');
    if (e.metaKey) keys.push('Meta');
    const key = e.key;
    if (!['Control', 'Shift', 'Alt', 'Meta'].includes(key))
      keys.push(key.length === 1 ? key.toUpperCase() : key);
    if (keys.length === 0) return;
    capturedKeys = keys;
    if (!['Control', 'Shift', 'Alt', 'Meta'].includes(key)) {
      const shortcuts = shortcutStore.list;
      const idx = shortcuts.findIndex((s) => s.id === editingShortcutId);
      if (idx >= 0) {
        shortcuts[idx] = { ...shortcuts[idx], keys: capturedKeys };
        shortcutStore.list = [...shortcuts];
        shortcutStore.save();
      }
      editingShortcutId = null;
      capturedKeys = [];
    }
  }
  function resetShortcuts() {
    shortcutStore.reset();
    shortcutStore.save();
    toastStore.info('Shortcuts reset');
  }

  // ─── Billing ─────────────────────────────────────────────────────────
  let billingLoading = $state(false);
  let billingCredits = $state<any>(null);
  let billingError = $state<string | null>(null);
  let billingRefreshTimer: ReturnType<typeof setTimeout> | null = null;
  let expandedSubscriptionTrends = $state<Record<string, boolean>>({});
  let subscriptionTrendRanges = $state<Record<string, number>>({});
  let activeSubscriptionTrendPoints = $state<Record<string, number | undefined>>({});

  function formatTokens(n: number): string {
    if (!Number.isFinite(n) || n <= 0) return '0';
    if (n >= 1e9) return (n / 1e9).toFixed(1) + 'B';
    if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
    if (n >= 1e3) return (n / 1e3).toFixed(1) + 'k';
    return String(n);
  }

  function subscriptionTrendKey(cli: { provider?: string; accountId?: string }) {
    return `${cli.provider ?? 'cli'}:${cli.accountId ?? 'aggregate'}`;
  }

  function shownUsageTrend(cli: {
    provider?: string;
    accountId?: string;
    dailyUsage?: Array<{ date?: string; tokens?: number }>;
  }) {
    const key = subscriptionTrendKey(cli);
    return (cli.dailyUsage ?? []).slice(-(subscriptionTrendRanges[key] ?? 14));
  }

  function usageTrendPoints(
    dailyUsage: Array<{ date?: string; tokens?: number }> | undefined,
    height = 64,
  ): string {
    const values = dailyUsage?.map((entry) => Math.max(0, entry.tokens ?? 0)) ?? [];
    if (!values.length) return '';
    const max = Math.max(...values, 1);
    const width = 280;
    return values
      .map((value, index) => {
        const x = values.length === 1 ? width / 2 : (index / (values.length - 1)) * width;
        const y = height - (value / max) * (height - 4) - 2;
        return `${x.toFixed(1)},${y.toFixed(1)}`;
      })
      .join(' ');
  }

  function formatUsageTrendDate(date: string | undefined): string {
    if (!date) return '';
    return new Intl.DateTimeFormat(undefined, {
      month: 'short',
      day: 'numeric',
      timeZone: 'UTC',
    }).format(new Date(`${date}T00:00:00Z`));
  }

  function updateUsageTrendPoint(
    event: PointerEvent,
    key: string,
    dailyUsage: Array<{ date?: string; tokens?: number }>,
  ) {
    const bounds = (event.currentTarget as SVGSVGElement).getBoundingClientRect();
    const ratio = Math.max(0, Math.min(1, (event.clientX - bounds.left) / bounds.width));
    const nextIndex = Math.min(dailyUsage.length - 1, Math.round(ratio * (dailyUsage.length - 1)));
    // Pointer events arrive far more often than the selected day can change.
    // Avoid invalidating the whole settings drawer for identical points.
    if (activeSubscriptionTrendPoints[key] === nextIndex) return;
    activeSubscriptionTrendPoints[key] = nextIndex;
  }

  async function loadBillingCredits(forceRefresh = false) {
    if (billingRefreshTimer) {
      clearTimeout(billingRefreshTimer);
      billingRefreshTimer = null;
    }
    billingLoading = true;
    billingError = null;
    try {
      const requestUrl = `/api/billing/credits${forceRefresh ? '?refresh=1' : ''}`;
      let res = await apiFetch(apiUrl(requestUrl), {}, 3_000);
      if (!res.ok) {
        if ((res.status === 500 || res.status === 408) && forceRefresh) {
          // Some environments stall during refresh work (provider APIs, heavy log
          // scans); drop to cached mode and keep the UI usable.
          res = await apiFetch(apiUrl('/api/billing/credits'), {}, 3_000);
        }
        if (!res.ok) {
          const text = await res.text().catch(() => '');
          billingError =
            text && text.trim()
              ? `Billing API not available (${res.status})`
              : 'Billing API not available';
          return;
        }
      }
      const data = await parseJsonResponse(res);
      if (data?.ok === false) {
        billingError = data.error || 'Billing API returned an error';
        return;
      }
      billingCredits = data;
      // Slow CLI scans and provider balances complete in the background. Keep
      // the drawer interactive, then replace the provisional snapshot once.
      if (data?.refreshing) {
        billingRefreshTimer = setTimeout(() => {
          billingRefreshTimer = null;
          if (open && activeTab === 'billing') void loadBillingCredits();
        }, 1_500);
      }
    } catch (e: unknown) {
      billingError = e instanceof Error ? e.message : String(e);
    } finally {
      billingLoading = false;
    }
  }

  // The drawer can be opened directly on Billing (for example from a shortcut),
  // which bypasses the sidebar click handler. Load once in that case too; the
  // explicit Refresh button remains the only forced network refresh.
  $effect(() => {
    if (open && activeTab === 'billing' && !billingCredits && !billingLoading) {
      void loadBillingCredits();
    }
  });

  onDestroy(() => {
    if (billingRefreshTimer) clearTimeout(billingRefreshTimer);
  });
</script>

<svelte:window
  onkeydown={(e) => {
    if (editingShortcutId) handleShortcutKeydown(e);
    else handleKeydown(e);
  }}
/>

{#if open}
  <div
    bind:this={settingsDialog}
    tabindex="-1"
    class="fixed inset-0 z-50 flex min-h-0 flex-col"
    style="background: var(--color-surface-1);"
    role="dialog"
    aria-modal="true"
    aria-labelledby="settings-title"
    data-testid="settings-drawer"
  >
    <!-- Header -->
    <div
      class="flex items-center justify-between px-5 py-3.5 shrink-0 border-b"
      style="border-color: var(--color-border); background: var(--color-surface-0);"
    >
      <div class="min-w-0">
        <h2
          id="settings-title"
          class="text-base font-semibold"
          style="color: var(--color-text-primary);"
        >
          Settings
        </h2>
        <p class="mt-0.5 truncate text-[10px] text-[var(--color-text-muted)]">
          Durable preferences and product capability status
        </p>
      </div>
      <button
        type="button"
        class="flex h-9 w-9 items-center justify-center rounded-lg text-[var(--color-text-muted)] transition-colors hover:bg-[var(--color-surface-3)] hover:text-[var(--color-text-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)]/60"
        onclick={() => onClose?.()}
        aria-label="Close settings"
      >
        <X size={18} />
      </button>
    </div>

    <div class="flex min-h-0 flex-1 overflow-hidden">
      <aside
        class="flex w-20 shrink-0 flex-col border-r border-[var(--color-border)] bg-[var(--color-surface-0)] sm:w-64"
        aria-label="Settings navigation"
      >
        <div class="hidden border-b border-[var(--color-border)] p-3 sm:block">
          <label for="settings-search" class="sr-only">Search settings</label>
          <div class="relative">
            <Search
              size={14}
              class="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-[var(--color-text-muted)]"
            />
            <input
              bind:this={settingsSearchInput}
              id="settings-search"
              type="search"
              bind:value={settingsSearch}
              placeholder="Search settings"
              class="h-10 w-full rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-1)] pl-9 pr-8 text-xs text-[var(--color-text-primary)] outline-none placeholder:text-[var(--color-text-muted)] hover:border-[var(--color-border-bright)] focus-visible:border-[var(--color-accent)] focus-visible:ring-2 focus-visible:ring-[var(--color-accent)]/35"
            />
            {#if settingsSearch}
              <button
                type="button"
                aria-label="Clear settings search"
                onclick={() => (settingsSearch = '')}
                class="absolute right-1.5 top-1/2 flex h-7 w-7 -translate-y-1/2 items-center justify-center rounded-md text-[var(--color-text-muted)] hover:bg-[var(--color-surface-3)] hover:text-[var(--color-text-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)]/60"
              >
                <X size={13} />
              </button>
            {/if}
          </div>
        </div>

        <nav class="min-h-0 flex-1 overflow-y-auto p-2" aria-label="Settings sections">
          {#each SETTINGS_GROUPS as group (group)}
            {@const groupEntries = filteredSettingsCatalog.filter((entry) => entry.group === group)}
            {#if groupEntries.length}
              <div class="mb-3">
                <div
                  class="hidden px-2 pb-1 pt-2 text-[9px] font-semibold uppercase tracking-[0.14em] text-[var(--color-text-muted)] sm:block"
                >
                  {group}
                </div>
                <div class="space-y-0.5">
                  {#each groupEntries as entry (entry.id)}
                    {@const Icon = settingsIcons[entry.id]}
                    <button
                      type="button"
                      class="settings-tab flex min-h-11 w-full items-center justify-center gap-3 rounded-xl px-2.5 py-2 text-left focus-visible:outline-none sm:justify-start focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--color-accent)]/65 {activeTab ===
                      entry.id
                        ? 'settings-tab-active'
                        : ''}"
                      aria-current={activeTab === entry.id ? 'page' : undefined}
                      title={entry.description}
                      onclick={() => selectSettingsTab(entry.id)}
                    >
                      <span
                        class="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-[var(--color-surface-2)]"
                        aria-hidden="true"><Icon size={14} /></span
                      >
                      <span class="hidden min-w-0 flex-1 sm:block">
                        <span class="block truncate text-xs font-medium">{entry.label}</span>
                        <span
                          class="mt-0.5 block truncate text-[9px] text-[var(--color-text-muted)]"
                          >{entry.scope}</span
                        >
                      </span>
                    </button>
                  {/each}
                </div>
              </div>
            {/if}
          {/each}
          {#if filteredSettingsCatalog.length === 0}
            <div
              class="m-2 rounded-xl border border-dashed border-[var(--color-border)] px-3 py-5 text-center"
            >
              <p class="text-xs font-medium text-[var(--color-text-secondary)]">
                No settings found
              </p>
              <p class="mt-1 text-[10px] leading-relaxed text-[var(--color-text-muted)]">
                Try a feature, outcome, or scope.
              </p>
              <button
                type="button"
                class="mt-3 min-h-9 rounded-lg px-3 text-[10px] font-medium text-[var(--color-accent)] hover:bg-[var(--color-surface-2)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)]/60"
                onclick={() => (settingsSearch = '')}>Clear search</button
              >
            </div>
          {/if}
        </nav>
      </aside>

      <!-- Content Area -->
      <div class="flex min-w-0 flex-1 flex-col overflow-hidden">
        <div
          class="flex min-h-14 shrink-0 items-center justify-between gap-4 border-b border-[var(--color-border)] bg-[var(--color-surface-1)] px-5 py-2.5"
        >
          <div class="min-w-0">
            <h3 class="truncate text-sm font-semibold text-[var(--color-text-primary)]">
              {selectedSettingsEntry.label}
            </h3>
            <p class="mt-0.5 truncate text-[10px] text-[var(--color-text-muted)]">
              {selectedSettingsEntry.description}
            </p>
          </div>
          <span
            class="shrink-0 rounded-full border border-[var(--color-border)] bg-[var(--color-surface-2)] px-2.5 py-1 text-[9px] font-medium text-[var(--color-text-secondary)]"
            >{selectedSettingsEntry.scope}</span
          >
        </div>
        <!-- Providers Tab -->
        <div
          class={activeTab === 'providers'
            ? 'flex-1 overflow-y-auto px-6 py-5 space-y-6'
            : 'hidden'}
        >
          <div class="flex items-center gap-2">
            <div class="relative flex-1">
              <Search
                size={14}
                class="absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none"
                style="color: var(--color-text-muted);"
              />
              <input
                type="text"
                placeholder="Search providers..."
                bind:value={providerSearchQuery}
                class="input w-full py-2 text-sm"
                style="padding-left: 2.75rem;"
              />
            </div>
            <button
              type="button"
              class="inline-flex shrink-0 items-center gap-1 rounded-md border border-[var(--color-border)] px-2.5 py-2 text-xs text-[var(--color-text-muted)] hover:bg-[var(--color-surface-3)]"
              title="Refresh providers and detected CLIs"
              aria-label="Refresh providers and detected CLIs"
              onclick={refreshProviderSection}
            >
              <RefreshCw size={12} />
              Refresh
            </button>
          </div>

          <div class="flex flex-wrap gap-2" role="group" aria-label="Provider category">
            {#each PROVIDER_CATEGORIES as category (category.id)}
              <button
                type="button"
                class="rounded-full border px-3 py-1.5 text-xs font-medium transition-colors {providerCategory ===
                category.id
                  ? 'border-[var(--color-accent)] bg-[var(--color-accent)]/12 text-[var(--color-text-primary)]'
                  : 'border-[var(--color-border)] text-[var(--color-text-muted)] hover:bg-[var(--color-surface-3)] hover:text-[var(--color-text-secondary)]'}"
                aria-pressed={providerCategory === category.id}
                onclick={() => (providerCategory = category.id)}
              >
                {category.label}
              </button>
            {/each}
          </div>

          <div
            class="flex items-start gap-2 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-1)] px-3 py-2.5 text-[10px] leading-relaxed text-[var(--color-text-muted)]"
          >
            <Shield size={13} class="mt-0.5 shrink-0 text-[var(--color-text-secondary)]" />
            <span
              >Direct API keys and tokens entered here stay local in <code
                >.koryphaios/credentials.json</code
              > with owner-only file permissions. This direct-provider store is not encrypted or backed
              by the operating-system keychain.</span
            >
          </div>

          <!-- Detected on your system — presence is not an authentication verdict. -->
          {#if showDetectedCliSummary}
            <div
              class="rounded-xl border border-[var(--color-border)] p-4 bg-[var(--color-surface-1)]"
            >
              <div class="flex items-center justify-between mb-3">
                <span class="text-sm font-semibold text-[var(--color-text-primary)]"
                  >Detected on your system</span
                >
                <div class="flex items-center gap-2">
                  <span class="text-[10px] text-[var(--color-text-muted)]"
                    >Local files and executables only</span
                  >
                  <button
                    type="button"
                    class="p-1 rounded-md transition-colors hover:bg-[var(--color-surface-3)]"
                    style="color: var(--color-text-muted);"
                    title="Re-check providers and installed CLIs"
                    aria-label="Re-check providers and installed CLIs"
                    onclick={refreshProviderSection}
                  >
                    <RefreshCw size={12} />
                  </button>
                </div>
              </div>
              <div class="space-y-2.5">
                {#each installedClis as cli (cli.id)}
                  <div class="flex items-start gap-3">
                    <span
                      class="mt-1.5 h-2 w-2 rounded-full flex-shrink-0"
                      style="background: {cli.autoEnabled
                        ? 'var(--color-warning)'
                        : (cli.loginDetected ?? cli.loggedIn)
                          ? 'var(--color-warning)'
                          : 'var(--color-text-muted)'};"
                    ></span>
                    <div class="min-w-0 flex-1">
                      <div class="flex items-center gap-2 flex-wrap">
                        <span class="text-sm font-medium text-[var(--color-text-primary)]"
                          >{cli.displayName}</span
                        >
                        {#if cli.autoEnabled}
                          <span
                            class="text-[10px] px-1.5 py-0.5 rounded-full font-medium"
                            style="background: var(--color-warning-bg); color: var(--color-warning);"
                            >Login material detected · enabled locally</span
                          >
                        {:else if cli.loginDetected ?? cli.loggedIn}
                          <span
                            class="text-[10px] px-1.5 py-0.5 rounded-full font-medium"
                            style="background: var(--color-warning-bg); color: var(--color-warning);"
                            >Login material detected · check below</span
                          >
                        {:else}
                          <span class="text-[10px] text-[var(--color-text-muted)]"
                            >Installed · no login material detected</span
                          >
                        {/if}
                        {#if cli.nativeResearch}
                          <span
                            class="text-[10px] px-1.5 py-0.5 rounded-full font-medium"
                            style="background: {cli.nativeResearch.eligible
                              ? 'var(--color-success-bg)'
                              : 'var(--color-surface-3)'}; color: {cli.nativeResearch.eligible
                              ? 'var(--color-success)'
                              : 'var(--color-text-muted)'};"
                            title={cli.nativeResearch.reason}
                          >
                            {cli.nativeResearch.eligible
                              ? 'Native research ready'
                              : 'Native research blocked'}
                          </span>
                        {/if}
                      </div>
                      <p class="text-[10px] text-[var(--color-text-muted)] leading-relaxed mt-0.5">
                        {cli.note}
                        {#if cli.nativeResearch}
                          <span class="block mt-0.5">Research: {cli.nativeResearch.reason}.</span>
                        {/if}
                        {#if cli.docsUrl && !cli.autoEnabled}
                          <a
                            href={cli.docsUrl}
                            target="_blank"
                            rel="noreferrer"
                            class="underline hover:text-[var(--color-accent)]">Setup guide</a
                          >
                        {/if}
                      </p>
                    </div>
                  </div>
                {/each}
              </div>
            </div>
          {/if}

          <!-- Add a custom (bring-your-own) provider -->
          {#if !showAddCustom}
            <button
              type="button"
              onclick={() => (showAddCustom = true)}
              class="group w-full rounded-xl border border-dashed border-[var(--color-border)] bg-[var(--color-surface-1)] p-4 text-left transition-colors duration-150 hover:border-[var(--color-accent)] hover:bg-[var(--color-surface-2)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)]/50"
            >
              <div class="flex items-center gap-2">
                <span
                  class="flex h-7 w-7 items-center justify-center rounded-lg bg-[var(--color-accent)]/10 transition-colors duration-150 group-hover:bg-[var(--color-accent)]/20"
                >
                  <Plus size={15} style="color: var(--color-accent);" />
                </span>
                <span
                  class="text-sm font-semibold text-[var(--color-text-primary)] transition-colors duration-150 group-hover:text-[var(--color-accent)]"
                  >Add a custom provider</span
                >
              </div>
              <span
                class="text-[10px] text-[var(--color-text-muted)] transition-colors duration-150 group-hover:text-[var(--color-text-secondary)]"
                >OpenAI-compatible &amp; more</span
              >
            </button>
          {:else}
            <section
              class="rounded-xl border border-dashed border-[var(--color-accent)]/60 bg-[var(--color-surface-1)] p-4"
            >
              <button
                type="button"
                onclick={() => (showAddCustom = false)}
                class="group flex w-full items-center justify-between text-left"
              >
                <div class="flex items-center gap-2">
                  <span
                    class="flex h-7 w-7 items-center justify-center rounded-lg bg-[var(--color-accent)]/10"
                    ><Plus size={15} style="color: var(--color-accent);" /></span
                  >
                  <span class="text-sm font-semibold text-[var(--color-text-primary)]"
                    >Add a custom provider</span
                  >
                </div>
                <span class="text-[10px] text-[var(--color-text-muted)]">Close</span>
              </button>
              <div class="mt-4 space-y-3 border-t border-[var(--color-border)] pt-4">
                <p class="text-[10px] text-[var(--color-text-muted)] leading-relaxed">
                  Bring your own endpoint — works with any OpenAI-compatible API (vLLM, LiteLLM, LM
                  Studio, self-hosted gateways, OpenRouter-style services), plus Anthropic- and
                  Gemini-compatible servers. Models are auto-fetched from <code>/models</code> when available,
                  or list them explicitly below.
                </p>
                <div class="space-y-1">
                  <label
                    class="text-[10px] uppercase tracking-wider text-[var(--color-text-muted)] font-medium"
                    for="custom-label">Display name</label
                  >
                  <input
                    id="custom-label"
                    type="text"
                    placeholder="My LLM"
                    bind:value={customForm.label}
                    class="input w-full text-xs"
                  />
                </div>
                <div class="space-y-1">
                  <label
                    class="text-[10px] uppercase tracking-wider text-[var(--color-text-muted)] font-medium"
                    for="custom-kind">API format</label
                  >
                  <KorySelect
                    value={customForm.kind}
                    label="Custom provider API format"
                    options={[
                      {
                        value: 'openai',
                        label: 'OpenAI-compatible',
                        description: '/v1/chat/completions',
                      },
                      {
                        value: 'anthropic',
                        label: 'Anthropic-compatible',
                        description: '/v1/messages',
                      },
                      { value: 'gemini', label: 'Gemini-compatible' },
                    ]}
                    onchange={(value) => (customForm.kind = value as typeof customForm.kind)}
                  />
                </div>
                <div class="space-y-1">
                  <label
                    class="text-[10px] uppercase tracking-wider text-[var(--color-text-muted)] font-medium"
                    for="custom-url">Base URL</label
                  >
                  <input
                    id="custom-url"
                    type="text"
                    placeholder="https://api.example.com/v1"
                    bind:value={customForm.baseUrl}
                    class="input w-full text-xs"
                  />
                </div>
                <div class="space-y-1">
                  <label
                    class="text-[10px] uppercase tracking-wider text-[var(--color-text-muted)] font-medium"
                    for="custom-key"
                    >API key <span class="opacity-60 normal-case"
                      >(optional — leave blank if not required)</span
                    ></label
                  >
                  <div class="relative">
                    <input
                      id="custom-key"
                      type={secretInputType('custom-key')}
                      placeholder="sk-..."
                      bind:value={customForm.apiKey}
                      class="input w-full text-xs"
                      style="padding-right: 2.75rem;"
                    />
                    <button
                      type="button"
                      class="secret-visibility absolute inset-y-0 right-1 my-auto z-10"
                      onclick={() => toggleSecretVisibility('custom-key')}
                      aria-label={visibleSecrets['custom-key'] ? 'Hide API key' : 'Show API key'}
                      title={visibleSecrets['custom-key'] ? 'Hide API key' : 'Show API key'}
                    >
                      {#if visibleSecrets['custom-key']}<EyeOff size={15} />{:else}<Eye
                          size={15}
                        />{/if}
                    </button>
                  </div>
                </div>
                <div class="space-y-1">
                  <label
                    class="text-[10px] uppercase tracking-wider text-[var(--color-text-muted)] font-medium"
                    for="custom-models"
                    >Models <span class="opacity-60 normal-case">(optional, comma-separated)</span
                    ></label
                  >
                  <input
                    id="custom-models"
                    type="text"
                    placeholder="my-model-a, my-model-b — or leave blank to auto-fetch"
                    bind:value={customForm.models}
                    class="input w-full text-xs"
                  />
                </div>
                <button
                  type="button"
                  onclick={addCustomProvider}
                  disabled={providersStore.addingCustom}
                  class="btn btn-primary w-full text-xs py-2"
                  >{providersStore.addingCustom ? 'Adding…' : 'Add provider'}</button
                >
              </div>
            </section>
          {/if}

          {#if providerSearchQuery.trim()}
            <div class="text-xs text-[var(--color-text-muted)]">
              {filteredProviderList.length} provider{filteredProviderList.length === 1 ? '' : 's'} matching
              "{providerSearchQuery.trim()}"
            </div>
          {/if}

          {#if filteredProviderList.length === 0}
            <div
              class="rounded-xl border border-[var(--color-border)] p-8 text-center bg-[var(--color-surface-1)]"
            >
              <Search
                size={24}
                class="mx-auto mb-3 opacity-40"
                style="color: var(--color-text-muted);"
              />
              <p class="text-sm text-[var(--color-text-secondary)] mb-1">No providers found</p>
              <p class="text-xs text-[var(--color-text-muted)]">
                {#if providerSearchQuery.trim()}
                  Try a different search term or clear the filter.
                {:else}
                  No providers in the "{PROVIDER_CATEGORIES.find((c) => c.id === providerCategory)
                    ?.label ?? providerCategory}" category. Try switching to "All" or add a custom
                  provider.
                {/if}
              </p>
            </div>
          {:else}
            <div
              class="grid grid-cols-1 items-start gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4"
            >
              {#each filteredProviderList as prov (prov.key)}
                {@const status = getProviderStatus(prov.key)}
                {@const caps = getProviderCaps(prov.key)}
                {@const deployment = deploymentDescription(status?.deployment, prov.key)}
                {@const badge = deploymentLabel(status?.deployment, prov.key)}
                <div
                  class="rounded-xl border border-[var(--color-border)] p-4 transition-all {expandedProvider ===
                  prov.key
                    ? 'bg-[var(--color-surface-2)] ring-1 ring-[var(--color-accent)]/30'
                    : 'bg-[var(--color-surface-1)] hover:bg-[var(--color-surface-2)] shadow-sm'}"
                >
                  <button
                    type="button"
                    onclick={() =>
                      (expandedProvider = expandedProvider === prov.key ? null : prov.key)}
                    class="w-full flex items-center justify-between text-left group"
                  >
                    <div class="flex items-center gap-3">
                      <div
                        class="w-8 h-8 rounded-lg bg-[var(--color-surface-3)] flex items-center justify-center p-1.5 shrink-0 overflow-hidden"
                      >
                        <ProviderIcon provider={prov.key} size={20} class="w-full h-full" />
                      </div>
                      <div>
                        <span class="text-sm font-semibold text-[var(--color-text-primary)]"
                          >{status?.label ?? prov.label}</span
                        >
                        <p
                          class="text-[10px] text-[var(--color-text-muted)] group-hover:text-[var(--color-text-secondary)]"
                        >
                          {#if status?.configurationBlocked}
                            Unavailable in this build
                          {:else if status?.connectionState === 'verified'}
                            {@const selectedCount = status.models?.length ?? 0}
                            {@const availableCount = status.allAvailableModels?.length ?? 0}
                            Connected{availableCount > 0
                              ? ` · ${selectedCount > 0 ? selectedCount : '—'}/${availableCount} models enabled`
                              : ''}
                          {:else if status?.connectionState === 'failed'}
                            Connection failed
                          {:else if status?.connectionState === 'detected' && status?.verificationScope === 'catalog'}
                            Catalog access detected · inference unverified
                          {:else if status?.credentialDetected ?? status?.authenticated}
                            Found on system · not yet connected
                          {:else if deployment}
                            {deployment}
                          {:else}
                            Not configured
                          {/if}
                        </p>
                      </div>
                    </div>
                    <div class="flex items-center gap-2">
                      {#if status?.connectionState === 'verified'}
                        <div
                          class="flex items-center gap-1.5 px-2 py-0.5 rounded-full bg-[var(--color-success-bg)] text-[var(--color-success)] text-[9px] font-bold"
                          title="Connected to Koryphaios and working"
                        >
                          <span class="w-1 h-1 rounded-full bg-[var(--color-success)]"></span>
                          Connected
                        </div>
                      {:else if status?.connectionState === 'failed'}
                        <div
                          class="flex items-center gap-1.5 px-2 py-0.5 rounded-full bg-[var(--color-error-bg)] text-[var(--color-error)] text-[9px] font-bold"
                          title={status.verificationError ?? 'The last connection attempt failed'}
                        >
                          <span class="w-1 h-1 rounded-full bg-[var(--color-error)]"></span>
                          Failed
                        </div>
                      {:else if status?.credentialDetected ?? status?.authenticated}
                        <div
                          class="flex items-center gap-1.5 px-2 py-0.5 rounded-full bg-[var(--color-warning-bg)] text-[var(--color-warning)] text-[9px] font-bold"
                          title="Found on this system but not yet connected to Koryphaios"
                        >
                          <span class="w-1 h-1 rounded-full bg-[var(--color-warning)]"></span>
                          Detected
                        </div>
                      {:else}
                        <div
                          class="w-2 h-2 rounded-full bg-[var(--color-text-muted)] opacity-50 ring-4 ring-[var(--color-border)]"
                        ></div>
                      {/if}
                    </div>
                  </button>
                  {#if expandedProvider === prov.key}
                    {@const caps = getProviderCaps(prov.key)}
                    {@const configurationBlocked = status?.configurationBlocked === true}
                    <div class="mt-4 space-y-3 pt-4 border-t border-[var(--color-border)]">
                      {#if status?.description}
                        <p class="text-[10px] text-[var(--color-text-muted)] leading-relaxed">
                          {status.description}
                        </p>
                      {/if}
                      {#if badge}
                        <div
                          class={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[9px] font-semibold uppercase tracking-wide ${
                            status?.deployment === 'cloud'
                              ? 'bg-[var(--color-info-bg)] text-[var(--color-info)]'
                              : status?.deployment === 'local'
                                ? 'bg-[var(--color-success-bg)] text-[var(--color-success)]'
                                : 'bg-[var(--color-surface-3)] text-[var(--color-text-secondary)]'
                          }`}
                        >
                          {badge}
                        </div>
                      {/if}
                      {#if status?.credentialDetected ?? status?.authenticated}
                        <div
                          class="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-0)]/70 px-3 py-2 text-[10px] leading-relaxed text-[var(--color-text-muted)]"
                        >
                          {#if status?.connectionState === 'verified'}
                            Connected to Koryphaios and working{status.verificationScope
                              ? ` · ${status.verificationScope} scope`
                              : ''}.
                          {:else if status?.connectionState === 'failed'}
                            Connection failed{status.verificationError
                              ? `: ${status.verificationError}`
                              : '.'}
                          {:else if status?.connectionState === 'detected' && status?.verificationScope === 'catalog'}
                            The provider catalog accepted this process's credentials. Runtime
                            inference permission, model entitlement, quota, and request success are
                            still unverified.
                          {:else}
                            Found on this system but not yet connected. This does not prove the credential,
                            account, entitlement, quota, or provider endpoint is usable.
                          {/if}
                        </div>
                        <div class="flex flex-wrap items-center justify-between gap-2">
                          <div class="text-[10px] text-[var(--color-text-muted)]">
                            {status.connectionState === 'verified'
                              ? `${(status.models?.length ?? 0) > 0 ? status.models?.length : '—'} enabled of ${(status.allAvailableModels?.length ?? 0) > 0 ? status.allAvailableModels?.length : '—'} listed`
                              : 'Model availability unverified'}
                          </div>
                          {#if status.connectionState === 'verified' && !status.hideModelSelector}
                            <button
                              type="button"
                              onclick={() => openModelSelector(status)}
                              class="btn btn-secondary text-[10px] py-1 px-3">Manage Models</button
                            >
                          {/if}
                          {#if usesLocalCliConnection(prov.key)}
                            <button
                              type="button"
                              onclick={() => handleConnectProvider(prov.key)}
                              disabled={providersStore.saving === prov.key}
                              class="btn btn-secondary text-[10px] py-1 px-3"
                              >{providersStore.saving === prov.key
                                ? 'Checking…'
                                : 'Check login again'}</button
                            >
                          {:else if status.connectionState !== 'verified'}
                            <button
                              type="button"
                              onclick={() => handleConnectProvider(prov.key)}
                              disabled={providersStore.saving === prov.key}
                              class="btn btn-secondary text-[10px] py-1 px-3"
                              >{providersStore.saving === prov.key
                                ? 'Checking…'
                                : 'Run safe check'}</button
                            >
                          {/if}
                          {#if caps.supportsApiKey && !usesBrowserAuth(prov.key)}
                            <button
                              type="button"
                              onclick={() => {
                                rotateProvider = { name: prov.key, keyType: 'apiKey' };
                                showRotateDialog = true;
                              }}
                              class="inline-flex items-center gap-1 text-[10px] text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)] font-medium transition-colors"
                              title="Replace the stored API key without disconnecting"
                            >
                              <RotateCcw size={10} /> Rotate key
                            </button>
                          {/if}
                          <button
                            type="button"
                            onclick={() => disconnectProvider(prov.key)}
                            class="text-[10px] text-[var(--color-error)] hover:opacity-80 font-medium transition-opacity"
                            >Disconnect</button
                          >
                        </div>
                      {:else if configurationBlocked}
                        <div
                          class="flex items-start gap-2 rounded-lg border border-[var(--color-warning)] bg-[var(--color-warning-bg)] px-3 py-2 text-xs text-[var(--color-warning)]"
                        >
                          <AlertTriangle size={14} class="mt-0.5 shrink-0" /><span
                            >{status?.error}</span
                          >
                        </div>
                        {#if providersStore.accountsLoading[prov.key]}
                          <p class="text-[11px] text-[var(--color-text-muted)]">
                            Checking for preserved credentials…
                          </p>
                        {:else if getProviderAccounts(prov.key).some((account) => account.source !== 'cli-autodetect')}
                          <div
                            class="flex items-center justify-between gap-3 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-0)]/70 p-3"
                          >
                            <p class="text-[11px] leading-relaxed text-[var(--color-text-muted)]">
                              Credential present · unverified. It is preserved but cannot activate
                              this unavailable adapter.
                            </p>
                            <button
                              type="button"
                              onclick={() => disconnectProvider(prov.key)}
                              class="shrink-0 text-[10px] font-medium text-[var(--color-error)] transition-opacity hover:opacity-80"
                              >Remove saved credentials</button
                            >
                          </div>
                        {/if}
                      {:else}
                        <div class="space-y-2">
                          {#if caps.supportsApiKey}
                            <div class="flex items-center justify-between gap-3">
                              <label
                                class="text-[10px] text-[var(--color-text-muted)] font-medium uppercase tracking-wider"
                                for={`provider-key-${prov.key}`}>API Key</label
                              >
                              {#if status?.credentialUrl}
                                <a
                                  href={status.credentialUrl}
                                  target="_blank"
                                  rel="noreferrer"
                                  class="text-[10px] text-[var(--color-accent)] hover:underline"
                                  >Get API key</a
                                >
                              {/if}
                            </div>
                            <div class="relative">
                              <input
                                id={`provider-key-${prov.key}`}
                                type={secretInputType(`provider-key-${prov.key}`)}
                                placeholder={prov.placeholder}
                                bind:value={providersStore.keyInputs[prov.key]}
                                class="input w-full text-xs"
                                style="padding-right: 2.75rem;"
                                onkeydown={(e) =>
                                  e.key === 'Enter' && handleConnectProvider(prov.key)}
                              />
                              <button
                                type="button"
                                class="secret-visibility absolute inset-y-0 right-1 my-auto z-10"
                                onclick={() => toggleSecretVisibility(`provider-key-${prov.key}`)}
                                aria-label={visibleSecrets[`provider-key-${prov.key}`]
                                  ? 'Hide API key'
                                  : 'Show API key'}
                                title={visibleSecrets[`provider-key-${prov.key}`]
                                  ? 'Hide API key'
                                  : 'Show API key'}
                              >
                                {#if visibleSecrets[`provider-key-${prov.key}`]}<EyeOff
                                    size={15}
                                  />{:else}<Eye size={15} />{/if}
                              </button>
                            </div>
                          {/if}
                          {#if showTokenInput(prov.key, caps)}
                            <label
                              class="text-[10px] text-[var(--color-text-muted)] font-medium uppercase tracking-wider"
                              for={`provider-token-${prov.key}`}>Auth Token</label
                            >
                            <div class="relative">
                              <input
                                id={`provider-token-${prov.key}`}
                                type={secretInputType(`provider-token-${prov.key}`)}
                                placeholder={providersStore.tokenPlaceholders[prov.key] ??
                                  'Auth token'}
                                bind:value={providersStore.tokenInputs[prov.key]}
                                class="input w-full pr-11 text-xs"
                                onkeydown={(e) =>
                                  e.key === 'Enter' && handleConnectProvider(prov.key)}
                              />
                              <button
                                type="button"
                                class="secret-visibility absolute inset-y-0 right-1 my-auto z-10"
                                onclick={() => toggleSecretVisibility(`provider-token-${prov.key}`)}
                                aria-label={visibleSecrets[`provider-token-${prov.key}`]
                                  ? 'Hide auth token'
                                  : 'Show auth token'}
                              >
                                {#if visibleSecrets[`provider-token-${prov.key}`]}<EyeOff
                                    size={15}
                                  />{:else}<Eye size={15} />{/if}
                              </button>
                            </div>
                          {/if}
                          {#if caps.requiresBaseUrl}
                            <label
                              class="text-[10px] text-[var(--color-text-muted)] font-medium uppercase tracking-wider"
                              for={`provider-url-${prov.key}`}>Endpoint URL</label
                            >
                            <input
                              id={`provider-url-${prov.key}`}
                              type="text"
                              placeholder={caps.baseUrlPlaceholder ?? 'https://...'}
                              bind:value={providersStore.urlInputs[prov.key]}
                              class="input w-full text-xs"
                              onkeydown={(e) =>
                                e.key === 'Enter' && handleConnectProvider(prov.key)}
                            />
                          {/if}
                          {#if caps.requiresDeployment}
                            <label
                              class="text-[10px] text-[var(--color-text-muted)] font-medium uppercase tracking-wider"
                              for={`provider-deployment-${prov.key}`}
                              >{prov.key === 'sapai' ? 'Deployment ID' : 'Deployment name'}</label
                            >
                            <input
                              id={`provider-deployment-${prov.key}`}
                              type="text"
                              placeholder={prov.key === 'sapai'
                                ? 'SAP AI Core deployment ID'
                                : 'Azure OpenAI deployment name'}
                              bind:value={providersStore.deploymentInputs[prov.key]}
                              class="input w-full text-xs"
                              onkeydown={(e) =>
                                e.key === 'Enter' && handleConnectProvider(prov.key)}
                            />
                            <p class="text-[10px] leading-relaxed text-[var(--color-text-muted)]">
                              {prov.key === 'sapai'
                                ? 'Use the deployed AI Core resource ID, not a foundation-model catalog ID.'
                                : 'Use the deployment name from Azure OpenAI, not the base model ID shown in the model catalog.'}
                            </p>
                          {/if}
                          {#if usesBrowserAuth(prov.key)}
                            <div
                              class="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-0)]/80 p-3 space-y-2"
                            >
                              {#if providersStore.browserAuthMessages[prov.key]}
                                <p class="text-[10px] text-[var(--color-text-muted)]">
                                  {providersStore.browserAuthMessages[prov.key]}
                                </p>
                              {/if}
                              <!-- One shared device-code panel for every device-code
                               provider — identical copy, code, copy-button, and
                               waiting line, so no provider gets a lesser flow. -->
                              {#if prov.key === 'copilot' || prov.key === 'kimicode' || prov.key === 'codex-auth'}
                                {@const deviceAuth =
                                  prov.key === 'copilot'
                                    ? providersStore.copilotDeviceAuth
                                    : prov.key === 'kimicode'
                                      ? providersStore.kimicodeDeviceAuth
                                      : providersStore.codexDeviceAuth}
                                {#if deviceAuth}
                                  {@const userCode = deviceAuth.userCode}
                                  <div
                                    class="rounded-md bg-[var(--color-surface-2)] px-2.5 py-2 text-[10px] text-[var(--color-text-secondary)]"
                                  >
                                    <div class="font-medium text-[var(--color-text-primary)]">
                                      {getProviderDisplayLabel(prov.key)} sign-in needs approval.
                                    </div>
                                    <div class="mt-1">The browser was opened automatically.</div>
                                    <div>Paste this code if you're asked for it.</div>
                                    <div class="mt-2 flex items-center gap-2">
                                      <span>Code:</span>
                                      <span
                                        class="font-semibold tracking-[0.18em] text-[var(--color-text-primary)]"
                                        >{userCode}</span
                                      >
                                      <button
                                        type="button"
                                        class="inline-flex items-center gap-1 rounded border border-[var(--color-border)] px-1.5 py-0.5 text-[10px] hover:bg-[var(--color-surface-3)]"
                                        onclick={() => copyToClipboard(userCode, 'deviceCode')}
                                      >
                                        <Copy size={10} />
                                        {providersStore.copiedDeviceCode === userCode
                                          ? 'Copied'
                                          : 'Copy code'}
                                      </button>
                                    </div>
                                    {#if deviceAuth.verificationUri}
                                      <div class="mt-1 break-all">{deviceAuth.verificationUri}</div>
                                    {/if}
                                    <div class="mt-2 text-[10px] text-[var(--color-text-muted)]">
                                      Waiting for {getProviderDisplayLabel(prov.key)} approval to complete…
                                    </div>
                                  </div>
                                {/if}
                              {/if}
                              <div class="flex gap-2">
                                <button
                                  type="button"
                                  onclick={() => handleStartBrowserAuth(prov.key)}
                                  disabled={providersStore.browserAuthBusy === prov.key}
                                  class="btn btn-secondary flex-1 text-[10px] py-2"
                                >
                                  {providersStore.browserAuthBusy === prov.key &&
                                  !providersStore.browserAuthPending[prov.key]
                                    ? 'Opening...'
                                    : 'Auth'}
                                </button>
                                {#if providersStore.browserAuthPending[prov.key] && prov.key !== 'copilot' && prov.key !== 'kimicode' && prov.key !== 'codex-auth'}
                                  <button
                                    type="button"
                                    onclick={() => handleFinishBrowserAuth(prov.key)}
                                    disabled={providersStore.browserAuthBusy === prov.key}
                                    class="btn btn-primary flex-1 text-[10px] py-2 shadow-lg shadow-[var(--color-accent)]/10"
                                  >
                                    {providersStore.browserAuthBusy === prov.key &&
                                    providersStore.browserAuthPending[prov.key]
                                      ? 'Checking...'
                                      : 'I Finished Sign-In'}
                                  </button>
                                {/if}
                              </div>
                            </div>
                          {/if}
                          {#if usesLocalCliConnection(prov.key)}
                            <div
                              class="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-0)]/80 p-3 text-[10px] leading-relaxed text-[var(--color-text-muted)]"
                            >
                              {#if prov.key === 'cline'}
                                This provider signs in via the Cline CLI. Run this in your terminal:
                                <div class="mt-1.5 flex items-start gap-1.5">
                                  <code
                                    class="break-all rounded border border-[var(--color-border)] bg-[var(--color-surface-2)] px-2 py-1.5"
                                    >{clineSignInCommand}</code
                                  >
                                  <button
                                    type="button"
                                    class="inline-flex shrink-0 items-center gap-1 rounded border border-[var(--color-border)] px-1.5 py-1 text-[10px] hover:bg-[var(--color-surface-3)]"
                                    onclick={() =>
                                      copyToClipboard(clineSignInCommand, 'deviceCode')}
                                  >
                                    {providersStore.copiedDeviceCode === clineSignInCommand
                                      ? 'Copied'
                                      : 'Copy command'}
                                  </button>
                                </div>
                              {:else}
                                Runs through the provider CLI. Koryphaios detects local sign-in
                                material and checks the CLI without storing a provider token.
                                Detection alone is not an account or entitlement verdict.
                              {/if}
                            </div>
                          {/if}
                          {#if usesBrowserAuth(prov.key) && caps.supportsApiKey}
                            <div class="flex items-center gap-3 py-1">
                              <div class="flex-1 border-t border-[var(--color-border)]"></div>
                              <span
                                class="text-[9px] text-[var(--color-text-muted)] uppercase tracking-wider font-medium"
                                >or use API key</span
                              >
                              <div class="flex-1 border-t border-[var(--color-border)]"></div>
                            </div>
                            <button
                              type="button"
                              onclick={() => handleConnectProvider(prov.key)}
                              disabled={providersStore.saving === prov.key}
                              class="btn btn-primary w-full text-xs py-2 shadow-lg shadow-[var(--color-accent)]/10"
                              >{providersStore.saving === prov.key
                                ? 'Testing...'
                                : 'Connect with API Key'}</button
                            >
                          {:else if !usesBrowserAuth(prov.key)}
                            <button
                              type="button"
                              onclick={() => handleConnectProvider(prov.key)}
                              disabled={providersStore.saving === prov.key}
                              class="btn btn-primary w-full text-xs py-2 shadow-lg shadow-[var(--color-accent)]/10"
                              >{providersStore.saving === prov.key
                                ? 'Checking CLI...'
                                : usesLocalCliConnection(prov.key)
                                  ? getLocalCliConnectLabel(prov.key)
                                  : 'Connect Provider'}</button
                            >
                          {/if}
                          {#if prov.key.startsWith('custom:')}
                            <button
                              type="button"
                              onclick={() => deleteCustomProvider(prov.key)}
                              class="btn btn-ghost w-full text-[10px] py-1.5 mt-1 text-[var(--color-error)] hover:bg-[var(--color-error-bg)] flex items-center justify-center gap-1.5"
                            >
                              <Trash2 size={12} /> Remove this custom provider
                            </button>
                          {/if}
                          {#if providersStore.connectErrors[prov.key]}
                            <div
                              class="flex items-start gap-2 rounded-lg border border-[var(--color-error)] bg-[var(--color-error-bg)] px-3 py-2 text-xs text-[var(--color-error)]"
                            >
                              <AlertTriangle size={14} class="shrink-0 mt-0.5" />
                              <span class="flex-1">{providersStore.connectErrors[prov.key]}</span>
                            </div>
                          {/if}
                        </div>
                      {/if}
                      {#if !configurationBlocked && getProviderAccounts(prov.key).length > 1}
                        <div
                          class="space-y-3 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-0)]/70 p-3"
                        >
                          <div class="flex items-center justify-between gap-3">
                            <div>
                              <p
                                class="text-[10px] font-semibold uppercase tracking-[0.2em] text-[var(--color-text-muted)]"
                              >
                                Saved Accounts
                              </p>
                              <p class="text-[11px] text-[var(--color-text-muted)]">
                                Keep multiple keys or account logins per provider and switch between
                                them.
                              </p>
                            </div>
                            <button
                              type="button"
                              onclick={() => loadProviderAccounts(prov.key, true)}
                              class="text-[10px] text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)]"
                              >Refresh</button
                            >
                          </div>

                          {#if providersStore.accountsLoading[prov.key]}
                            <p class="text-[11px] text-[var(--color-text-muted)]">
                              Loading saved accounts...
                            </p>
                          {:else if getProviderAccounts(prov.key).length === 0}
                            <p class="text-[11px] text-[var(--color-text-muted)]">
                              No saved accounts yet.
                            </p>
                          {:else}
                            <div class="space-y-2">
                              {#each getProviderAccounts(prov.key) as account (account.id)}
                                <div
                                  class="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-1)] p-2.5"
                                >
                                  {#if account.source === 'cli-autodetect' && hasMultipleCliProfiles(prov.key)}
                                    <SettingsSwitch
                                      compact
                                      checked={isAccountSelected(prov.key, account.id)}
                                      label={account.label}
                                      description={[
                                        'Local profile detected',
                                        'Authentication and plan unverified',
                                        account.profileDir,
                                      ]
                                        .filter(Boolean)
                                        .join(' · ')}
                                      onchange={() =>
                                        toggleCliAccount(
                                          prov.key,
                                          account.id,
                                          !isAccountSelected(prov.key, account.id),
                                        )}
                                    />
                                  {:else if account.source === 'cli-autodetect'}
                                    <div>
                                      <div
                                        class="text-xs font-semibold text-[var(--color-text-primary)]"
                                      >
                                        {account.label}
                                      </div>
                                      <div class="mt-1 text-[10px] text-[var(--color-text-muted)]">
                                        Local profile detected · authentication and plan unverified
                                      </div>
                                    </div>
                                  {:else}
                                    <div class="flex items-start justify-between gap-3">
                                      <div>
                                        <div
                                          class="text-xs font-semibold text-[var(--color-text-primary)]"
                                        >
                                          {account.label}
                                        </div>
                                        <div
                                          class="mt-1 text-[10px] text-[var(--color-text-muted)]"
                                        >
                                          {[
                                            account.hasApiKey ? 'API key' : null,
                                            account.hasAuthToken ? 'Auth token' : null,
                                            account.hasBaseUrl ? 'Endpoint URL' : null,
                                          ]
                                            .filter(Boolean)
                                            .join(' • ')}
                                        </div>
                                      </div>
                                      <div class="flex items-center gap-2">
                                        <button
                                          type="button"
                                          onclick={() =>
                                            activateProviderAccount(prov.key, account.id)}
                                          disabled={providersStore.accountBusy ===
                                            `${prov.key}:activate:${account.id}`}
                                          class="btn btn-secondary text-[10px] px-2.5 py-1"
                                        >
                                          {providersStore.accountBusy ===
                                          `${prov.key}:activate:${account.id}`
                                            ? 'Activating...'
                                            : 'Activate'}
                                        </button>
                                        <button
                                          type="button"
                                          onclick={() => openAccountManager(prov.key, account)}
                                          class="btn btn-secondary text-[10px] px-2.5 py-1"
                                        >
                                          Manage
                                        </button>
                                        <button
                                          type="button"
                                          onclick={() =>
                                            deleteProviderAccount(prov.key, account.id)}
                                          disabled={providersStore.accountBusy ===
                                            `${prov.key}:delete:${account.id}`}
                                          class="text-[10px] text-[var(--color-error)] hover:opacity-80 font-medium transition-opacity"
                                        >
                                          {providersStore.accountBusy ===
                                          `${prov.key}:delete:${account.id}`
                                            ? 'Removing...'
                                            : 'Delete'}
                                        </button>
                                      </div>
                                    </div>
                                  {/if}
                                </div>
                              {/each}
                            </div>
                          {/if}

                          <div class="space-y-2 pt-2 border-t border-[var(--color-border)]">
                            {#if usesLocalCliConnection(prov.key)}
                              <p class="text-[11px] leading-relaxed text-[var(--color-text-muted)]">
                                {#if prov.key === 'cline'}
                                  Cline CLI manages login. If needed, sign in with <code
                                    >{clineSignInCommand}</code
                                  > and then use the check-login button above.
                                {:else}
                                  This provider's accounts are managed by its CLI. Sign in there,
                                  then use the check-login button above.
                                {/if}
                              </p>
                            {:else}
                              <input
                                type="text"
                                placeholder="Label this saved account"
                                bind:value={providersStore.accountLabelInputs[prov.key]}
                                class="input w-full text-xs"
                              />
                              {#if caps.supportsApiKey}
                                <div class="relative">
                                  <input
                                    type={secretInputType(`account-key-${prov.key}`)}
                                    placeholder={prov.placeholder}
                                    bind:value={providersStore.accountKeyInputs[prov.key]}
                                    class="input w-full pr-11 text-xs"
                                  />
                                  <button
                                    type="button"
                                    class="secret-visibility absolute inset-y-0 right-1 my-auto z-10"
                                    onclick={() =>
                                      toggleSecretVisibility(`account-key-${prov.key}`)}
                                    aria-label={visibleSecrets[`account-key-${prov.key}`]
                                      ? 'Hide account API key'
                                      : 'Show account API key'}
                                  >
                                    {#if visibleSecrets[`account-key-${prov.key}`]}<EyeOff
                                        size={15}
                                      />{:else}<Eye size={15} />{/if}
                                  </button>
                                </div>
                              {/if}
                              {#if showTokenInput(prov.key, caps)}
                                <div class="relative">
                                  <input
                                    type={secretInputType(`account-token-${prov.key}`)}
                                    placeholder={providersStore.tokenPlaceholders[prov.key] ??
                                      'Auth token'}
                                    bind:value={providersStore.accountTokenInputs[prov.key]}
                                    class="input w-full pr-11 text-xs"
                                  />
                                  <button
                                    type="button"
                                    class="secret-visibility absolute inset-y-0 right-1 my-auto z-10"
                                    onclick={() =>
                                      toggleSecretVisibility(`account-token-${prov.key}`)}
                                    aria-label={visibleSecrets[`account-token-${prov.key}`]
                                      ? 'Hide account auth token'
                                      : 'Show account auth token'}
                                  >
                                    {#if visibleSecrets[`account-token-${prov.key}`]}<EyeOff
                                        size={15}
                                      />{:else}<Eye size={15} />{/if}
                                  </button>
                                </div>
                              {/if}
                              {#if caps.requiresBaseUrl}
                                <input
                                  type="text"
                                  placeholder={caps.baseUrlPlaceholder ?? 'https://...'}
                                  bind:value={providersStore.accountUrlInputs[prov.key]}
                                  class="input w-full text-xs"
                                />
                              {/if}
                              {#if usesBrowserAuth(prov.key)}
                                <p class="text-[11px] text-[var(--color-text-muted)]">
                                  This provider connects through browser sign-in instead of manual
                                  saved credentials.
                                </p>
                                <button
                                  type="button"
                                  onclick={() => handleStartBrowserAuth(prov.key)}
                                  disabled={providersStore.browserAuthBusy === prov.key}
                                  class="btn btn-primary w-full text-[10px] py-2 shadow-lg shadow-[var(--color-accent)]/10"
                                >
                                  {providersStore.browserAuthBusy === prov.key
                                    ? 'Opening...'
                                    : 'Auth'}
                                </button>
                              {:else}
                                <div class="flex gap-2">
                                  <button
                                    type="button"
                                    onclick={() => saveProviderAccount(prov.key, false)}
                                    disabled={providersStore.accountBusy === `${prov.key}:save`}
                                    class="btn btn-secondary flex-1 text-[10px] py-2"
                                  >
                                    {providersStore.accountBusy === `${prov.key}:save`
                                      ? 'Saving...'
                                      : 'Save Account'}
                                  </button>
                                  <button
                                    type="button"
                                    onclick={() => saveProviderAccount(prov.key, true)}
                                    disabled={providersStore.accountBusy === `${prov.key}:save`}
                                    class="btn btn-primary flex-1 text-[10px] py-2 shadow-lg shadow-[var(--color-accent)]/10"
                                  >
                                    {providersStore.accountBusy === `${prov.key}:save`
                                      ? 'Saving...'
                                      : 'Save + Activate'}
                                  </button>
                                </div>
                              {/if}
                            {/if}
                          </div>
                        </div>
                      {/if}
                      {#if hasMultipleCliProfiles(prov.key)}
                        {@const orderedAccounts = getOrderedFallbackAccounts(prov.key)}
                        <div
                          class="space-y-3 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-0)]/70 p-3"
                        >
                          <div class="flex items-center justify-between gap-3">
                            <div>
                              <p
                                class="text-[10px] font-semibold uppercase tracking-[0.2em] text-[var(--color-text-muted)]"
                              >
                                Fallback Order
                              </p>
                              <p class="text-[11px] text-[var(--color-text-muted)]">
                                Choose the CLI profiles Koryphaios may use, then drag to set their
                                priority.
                              </p>
                            </div>
                            <SettingsSwitch
                              compact
                              checked={providersStore.fallbackEnabled[prov.key] === true}
                              label="Enable fallback"
                              description="Try the next selected CLI profile when the first one cannot run."
                              onchange={() =>
                                setFallbackEnabled(
                                  prov.key,
                                  providersStore.fallbackEnabled[prov.key] !== true,
                                )}
                            />
                            <span
                              class="text-[10px] text-[var(--color-text-muted)] transition-opacity duration-150 shrink-0 w-16 text-right"
                              class:opacity-0={providersStore.fallbackSaving !== prov.key}
                              class:opacity-100={providersStore.fallbackSaving === prov.key}
                              aria-hidden={providersStore.fallbackSaving !== prov.key}
                            >
                              {providersStore.fallbackSaving === prov.key ? 'Saving...' : ''}
                            </span>
                          </div>
                          <div
                            class="space-y-2"
                            use:dndzone={{
                              items: orderedAccounts,
                              flipDurationMs: 250,
                              dragDisabled: providersStore.fallbackEnabled[prov.key] !== true,
                              type: `fallback-order:${prov.key}`,
                            }}
                            onconsider={(e) => handleFallbackDndConsider(prov.key, e.detail.items)}
                            onfinalize={(e) => handleFallbackDndFinalize(prov.key, e.detail.items)}
                          >
                            {#each orderedAccounts as account, i (account.id)}
                              <div
                                class="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-1)] p-2.5 flex items-center gap-2.5 {providersStore
                                  .fallbackEnabled[prov.key] === true
                                  ? 'cursor-grab active:cursor-grabbing'
                                  : 'opacity-60'}"
                              >
                                <GripVertical
                                  size={14}
                                  class="text-[var(--color-text-muted)] shrink-0"
                                />
                                <span
                                  class="text-[10px] font-bold text-[var(--color-accent)] shrink-0 w-5 text-center"
                                  >{i + 1}</span
                                >
                                <div class="flex-1 min-w-0">
                                  <div
                                    class="text-xs font-semibold text-[var(--color-text-primary)] truncate"
                                  >
                                    {account.label}
                                  </div>
                                  <div class="text-[10px] text-[var(--color-text-muted)]">
                                    {[
                                      account.hasApiKey ? 'API key' : null,
                                      account.hasAuthToken ? 'Auth token' : null,
                                      account.hasBaseUrl ? 'Endpoint URL' : null,
                                    ]
                                      .filter(Boolean)
                                      .join(' · ')}
                                  </div>
                                </div>
                                <span
                                  class="text-[9px] uppercase tracking-wider text-[var(--color-text-muted)] shrink-0"
                                  >{i === 0
                                    ? '1st'
                                    : i === 1
                                      ? '2nd'
                                      : i === 2
                                        ? '3rd'
                                        : `${i + 1}th`}</span
                                >
                              </div>
                            {/each}
                          </div>
                        </div>
                      {/if}
                    </div>
                  {/if}
                </div>
              {/each}
            </div>
          {/if}
        </div>

        <!-- Appearance Tab -->
        <div class={activeTab === 'voice' ? 'flex-1 min-h-0 overflow-y-auto' : 'hidden'}>
          <VoiceSettings />
        </div>
        <div class={activeTab === 'images' ? 'flex-1 min-h-0 overflow-y-auto' : 'hidden'}>
          <ImageSettings />
        </div>
        <div class={activeTab === 'mcp' ? 'flex-1 min-h-0 overflow-y-auto' : 'hidden'}>
          <McpServersSettings />
        </div>

        <div class={activeTab === 'appearance' ? 'flex-1 min-h-0 overflow-y-auto' : 'hidden'}>
          <AppearanceSettings bind:showColorPicker />
        </div>

        <!-- Shortcuts Tab -->
        <div
          class={activeTab === 'shortcuts'
            ? 'flex-1 overflow-y-auto px-6 py-5 space-y-6 w-full max-w-7xl mx-auto'
            : 'hidden'}
        >
          <div class="flex items-center justify-between mb-4">
            <div>
              <h3 class="text-base font-bold text-[var(--color-text-primary)]">
                Keyboard Shortcuts
              </h3>
              <p class="text-xs text-[var(--color-text-muted)]">Customizable global key bindings</p>
            </div>
            <button
              type="button"
              onclick={resetShortcuts}
              class="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-[var(--color-error-bg)] text-[var(--color-error)] text-xs font-medium hover:opacity-80 transition-opacity"
            >
              <RotateCcw size={12} /> Reset to Defaults
            </button>
          </div>
          <div class="grid grid-cols-1 md:grid-cols-2 gap-3">
            {#each shortcutStore.list as shortcut (shortcut.id)}
              <div
                class="group flex items-center justify-between p-4 bg-[var(--color-surface-2)] rounded-xl border border-[var(--color-border)] transition-colors hover:border-[var(--color-text-muted)]"
              >
                <div>
                  <div class="text-sm font-semibold text-[var(--color-text-primary)]">
                    {shortcut.action}
                  </div>
                  <div class="text-xs text-[var(--color-text-muted)]">{shortcut.description}</div>
                </div>
                <button
                  type="button"
                  onclick={() => startEditShortcut(shortcut.id)}
                  class="flex items-center gap-1 px-3 py-2 rounded-lg border bg-[var(--color-surface-1)] text-sm font-mono transition-all
                       {editingShortcutId === shortcut.id
                    ? 'ring-2 ring-[var(--color-accent)] border-[var(--color-accent)] text-[var(--color-accent)]'
                    : 'group-hover:border-[var(--color-text-secondary)] shadow-sm'}"
                >
                  {#if editingShortcutId === shortcut.id}
                    <span class="animate-pulse">Waiting for keys...</span>
                  {:else}
                    {#each shortcut.keys as key, i (i)}
                      <span>{formatKey(key)}</span>
                      {#if i < shortcut.keys.length - 1}<span class="opacity-30 mx-0.5">+</span
                        >{/if}
                    {/each}
                  {/if}
                </button>
              </div>
            {/each}
          </div>
        </div>

        <!-- Billing Tab -->
        <div
          class={activeTab === 'billing'
            ? 'flex-1 overflow-y-auto px-6 py-5 space-y-8 w-full'
            : 'hidden'}
        >
          {#if billingError}
            <div
              class="p-4 rounded-xl border text-xs"
              style="border-color: var(--color-error); color: var(--color-error); background: var(--color-error-bg);"
            >
              Billing data unavailable: {billingError}
              <button type="button" class="ml-2 underline" onclick={() => loadBillingCredits(true)}
                >Retry</button
              >
            </div>
          {/if}
          <div class="flex items-center justify-between gap-4">
            <div>
              <h3 class="text-sm font-bold text-[var(--color-text-primary)]">Usage and billing</h3>
              <p class="mt-1 text-[10px] text-[var(--color-text-muted)]">
                Recorded provider usage and account-reported balances
              </p>
            </div>
            <button
              type="button"
              class="inline-flex min-h-9 items-center gap-2 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-2)] px-3 py-2 text-xs font-semibold text-[var(--color-text-secondary)] transition-colors hover:border-[var(--color-accent)]/50 hover:text-[var(--color-text-primary)] disabled:opacity-50"
              disabled={billingLoading}
              onclick={() => loadBillingCredits(true)}
              aria-label="Refresh billing data"
            >
              <RefreshCw size={14} class={billingLoading ? 'animate-spin' : ''} />
              {billingLoading ? 'Refreshing…' : 'Refresh'}
            </button>
          </div>
          {#if billingCredits?.refreshing}
            <div
              class="flex items-center gap-2 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-2)] px-4 py-3 text-xs text-[var(--color-text-secondary)]"
              role="status"
            >
              <RefreshCw size={13} class="animate-spin text-[var(--color-accent)]" />
              Updating subscription usage and provider balances in the background. Recorded API usage
              remains available while this finishes.
            </div>
          {/if}
          <div class="grid grid-cols-1 md:grid-cols-2 gap-6">
            <div
              class="p-6 rounded-2xl bg-gradient-to-br from-[var(--color-surface-2)] to-[var(--color-surface-1)] border border-[var(--color-border)] shadow-xl relative"
            >
              <div
                class="absolute -top-4 -right-4 w-24 h-24 bg-[var(--color-accent)]/5 rounded-full blur-3xl"
              ></div>
              <div class="relative mb-3 flex items-start justify-between gap-4">
                <div>
                  <div
                    class="text-[10px] text-[var(--color-text-muted)] uppercase tracking-widest font-bold"
                  >
                    API Spend
                  </div>
                  <div class="mt-1 text-[9px] text-[var(--color-text-muted)]">
                    Metered API-key providers only
                  </div>
                </div>
              </div>
              <div
                class="text-4xl font-black text-[var(--color-text-primary)] flex items-baseline gap-1"
              >
                {#if billingLoading && !billingCredits}
                  <div class="h-10 w-32 bg-[var(--color-surface-3)] animate-pulse rounded-lg"></div>
                {:else if billingCredits?.refreshing && !billingCredits?.byProvider?.length}
                  <span class="text-xl text-[var(--color-text-muted)] font-semibold"
                    >Calculating…</span
                  >
                {:else}
                  <span class="text-2xl opacity-50">$</span>{(
                    (billingCredits?.totalSpendCents ?? 0) / 100
                  ).toFixed(2)}
                {/if}
              </div>
              <p class="text-[10px] text-[var(--color-text-muted)] mt-4">
                Computed from recorded metered tokens at verified model prices
              </p>
            </div>

            <div
              class="p-6 rounded-2xl bg-[var(--color-surface-2)] border border-[var(--color-border)]"
            >
              <div
                class="text-[10px] text-[var(--color-text-muted)] uppercase tracking-widest font-bold mb-2"
              >
                Provider Balance
              </div>
              <div
                class="text-4xl font-black text-[var(--color-success)] flex items-baseline gap-1"
              >
                {#if billingLoading && !billingCredits}
                  <div class="h-10 w-32 bg-[var(--color-surface-3)] animate-pulse rounded-lg"></div>
                {:else if typeof billingCredits?.remainingCents === 'number'}
                  <span class="text-2xl opacity-50">$</span>{(
                    billingCredits.remainingCents / 100
                  ).toFixed(2)}
                {:else if billingCredits?.refreshing && !billingCredits?.balances?.length}
                  <span class="text-xl text-[var(--color-text-muted)] font-semibold">Checking…</span
                  >
                {:else}
                  <span class="text-2xl text-[var(--color-text-muted)] font-semibold"
                    >Not reported</span
                  >
                {/if}
              </div>
              <p class="text-[10px] text-[var(--color-text-muted)] mt-4">
                {typeof billingCredits?.remainingCents === 'number'
                  ? `Live available balance${billingCredits?.balanceProviders?.length > 1 ? ` across ${billingCredits.balanceProviders.length} providers` : ' from your reporting provider'}`
                  : 'No configured API-key provider returned a queryable balance'}
              </p>
            </div>
          </div>

          <!-- CLI subscriptions: account-separated local usage + quota burn -->
          {#if billingCredits?.cliUsage?.length}
            <div class="space-y-4">
              <div class="ml-1 flex flex-wrap items-end justify-between gap-3">
                <div>
                  <h3 class="text-sm font-bold text-[var(--color-text-primary)]">
                    CLI subscriptions
                  </h3>
                  <p class="mt-1 text-[10px] text-[var(--color-text-muted)]">
                    Each detected profile is shown separately. These plans report usage and quota,
                    not API charges or balances.
                  </p>
                </div>
              </div>
              <div class="grid grid-cols-1 xl:grid-cols-2 gap-4">
                {#each billingCredits.cliUsage as cli (`${cli.provider}:${cli.accountId ?? 'aggregate'}`)}
                  <div
                    class="p-5 bg-[var(--color-surface-2)] rounded-2xl border border-[var(--color-border)] space-y-4"
                  >
                    <div class="flex items-center justify-between">
                      <div class="flex items-center gap-3">
                        <div
                          class="w-8 h-8 rounded-lg bg-[var(--color-surface-3)] flex items-center justify-center p-1.5"
                        >
                          <ProviderIcon provider={cli.provider} size={20} class="w-full h-full" />
                        </div>
                        <div>
                          <div class="text-sm font-semibold">
                            {getProviderDisplayLabel(cli.provider)}{cli.accountLabel
                              ? ` · ${cli.accountLabel}`
                              : ''}
                          </div>
                          {#if cli.accountEmail || cli.accountLabel}
                            <div class="text-[10px] text-[var(--color-text-muted)]">
                              {cli.accountEmail || 'CLI profile'}
                            </div>
                          {/if}
                        </div>
                        {#if cli.planType}
                          <span
                            class="px-2 py-0.5 rounded-full text-[9px] uppercase tracking-wider font-bold bg-[var(--color-surface-3)] text-[var(--color-text-muted)]"
                            >{cli.planType}</span
                          >
                        {/if}
                        {#if cli.apiProviderName}
                          <span
                            class="px-2 py-0.5 rounded-full text-[9px] uppercase tracking-wider font-bold bg-[var(--color-accent)]/10 text-[var(--color-accent)]"
                            title="Raw inference API provider backing this CLI subscription"
                            >API: {cli.apiProviderName}</span
                          >
                        {/if}
                      </div>
                      <span class="text-[10px] text-[var(--color-text-muted)]"
                        >{cli.usageSource === 'codex-app-server'
                          ? 'live Codex account data'
                          : "from the CLI's own logs"}</span
                      >
                    </div>

                    {#if cli.attribution === 'unavailable'}
                      <div
                        class="rounded-xl border border-[var(--color-warning)] bg-[var(--color-warning-bg)] px-3 py-2 text-[11px] text-[var(--color-text-secondary)]"
                      >
                        Usage unavailable for this account: {cli.attributionNote}. Point this CLI
                        profile at its own session directory to enable account-separated usage.
                      </div>
                    {:else}
                      {#if cli.creditBalance != null}
                        <div
                          class="flex items-center justify-between rounded-xl bg-[var(--color-surface-1)] px-3 py-2 text-[11px]"
                        >
                          <span class="text-[var(--color-text-secondary)]">Codex credits</span>
                          <span class="font-mono font-semibold text-[var(--color-text-primary)]"
                            >{cli.creditBalance}</span
                          >
                        </div>
                      {/if}
                      {#each cli.quotas as q (q.label)}
                        <div>
                          <div class="flex items-center justify-between text-[11px] mb-1">
                            <span class="text-[var(--color-text-secondary)] font-medium"
                              >{q.label} quota</span
                            >
                            <span
                              class="font-mono font-bold"
                              style="color: {q.usedPercent >= 90
                                ? 'var(--color-error)'
                                : q.usedPercent >= 70
                                  ? 'var(--color-warning)'
                                  : 'var(--color-text-secondary)'};"
                            >
                              {q.usedPercent.toFixed(0)}% burned{q.resetsAt
                                ? ` · resets ${new Date(q.resetsAt).toLocaleString(undefined, { weekday: 'short', hour: 'numeric', minute: '2-digit' })}`
                                : ''}
                            </span>
                          </div>
                          <div
                            class="h-2 w-full bg-[var(--color-surface-3)] rounded-full overflow-hidden"
                          >
                            <div
                              class="h-full rounded-full transition-all"
                              style="width: {Math.min(
                                100,
                                q.usedPercent,
                              )}%; background: {q.usedPercent >= 90
                                ? 'var(--color-error)'
                                : q.usedPercent >= 70
                                  ? 'var(--color-warning)'
                                  : 'var(--color-accent)'};"
                            ></div>
                          </div>
                        </div>
                      {/each}

                      <div class="grid grid-cols-4 gap-2 text-center">
                        {#each cli.windows as w (w.period)}
                          <div
                            class="p-2.5 rounded-xl bg-[var(--color-surface-1)] border border-[var(--color-border)]"
                          >
                            <div
                              class="text-[9px] uppercase tracking-wider text-[var(--color-text-muted)] font-bold"
                            >
                              {w.period}
                            </div>
                            <div
                              class="mt-1 text-xs font-mono font-bold text-[var(--color-text-primary)]"
                            >
                              {formatTokens(w.tokensIn + w.tokensOut)}
                            </div>
                            <div class="text-[9px] text-[var(--color-text-muted)]">tokens</div>
                          </div>
                        {/each}
                      </div>

                      {#if cli.dailyUsage?.length}
                        {@const trendKey = subscriptionTrendKey(cli)}
                        {@const trendExpanded = expandedSubscriptionTrends[trendKey] ?? false}
                        {@const trend = shownUsageTrend(cli)}
                        {@const activeTrendIndex = activeSubscriptionTrendPoints[trendKey]}
                        {@const activeTrendPoint =
                          activeTrendIndex == null ? undefined : trend[activeTrendIndex]}
                        <div
                          class="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-1)] p-3"
                        >
                          <div class="flex items-center justify-between gap-3 text-[10px]">
                            <span class="font-semibold text-[var(--color-text-secondary)]"
                              >Usage trend</span
                            >
                            <div class="flex items-center gap-1.5">
                              {#each [7, 14, 30] as days (days)}
                                <button
                                  type="button"
                                  class="rounded-md border px-1.5 py-0.5 font-mono transition-colors"
                                  class:border-[var(--color-accent)]={(subscriptionTrendRanges[
                                    trendKey
                                  ] ?? 14) === days}
                                  class:text-[var(--color-accent)]={(subscriptionTrendRanges[
                                    trendKey
                                  ] ?? 14) === days}
                                  class:border-[var(--color-border)]={(subscriptionTrendRanges[
                                    trendKey
                                  ] ?? 14) !== days}
                                  class:text-[var(--color-text-muted)]={(subscriptionTrendRanges[
                                    trendKey
                                  ] ?? 14) !== days}
                                  aria-pressed={(subscriptionTrendRanges[trendKey] ?? 14) === days}
                                  onclick={() => {
                                    subscriptionTrendRanges[trendKey] = days;
                                    activeSubscriptionTrendPoints[trendKey] = undefined;
                                  }}>{days}d</button
                                >
                              {/each}
                              <button
                                type="button"
                                class="ml-1 rounded-md border border-[var(--color-border)] px-1.5 py-0.5 font-medium text-[var(--color-text-secondary)] transition-colors hover:border-[var(--color-accent)] hover:text-[var(--color-accent)]"
                                aria-expanded={trendExpanded}
                                onclick={() =>
                                  (expandedSubscriptionTrends[trendKey] = !trendExpanded)}
                                >{trendExpanded ? 'Collapse' : 'Expand'}</button
                              >
                            </div>
                          </div>
                          <!-- Reserve this row so showing a hover value never moves the SVG out
                           from under the pointer (which used to produce a leave/re-enter loop). -->
                          <div class="mt-2 h-6">
                            {#if activeTrendPoint}
                              <div
                                class="flex items-center justify-between rounded-md bg-[var(--color-surface-2)] px-2 py-1 text-[10px]"
                              >
                                <span class="text-[var(--color-text-secondary)]"
                                  >{formatUsageTrendDate(activeTrendPoint.date)}</span
                                >
                                <span
                                  class="font-mono font-semibold text-[var(--color-text-primary)]"
                                  >{formatTokens(activeTrendPoint.tokens ?? 0)} tokens</span
                                >
                              </div>
                            {/if}
                          </div>
                          <svg
                            class="w-full overflow-visible {trendExpanded ? 'h-32' : 'h-16'}"
                            viewBox={trendExpanded ? '0 0 280 128' : '0 0 280 64'}
                            preserveAspectRatio="none"
                            role="img"
                            aria-label={`Daily token usage from ${formatUsageTrendDate(trend[0]?.date)} to ${formatUsageTrendDate(trend[trend.length - 1]?.date)}`}
                            onpointermove={(event) => updateUsageTrendPoint(event, trendKey, trend)}
                            onpointerleave={() =>
                              (activeSubscriptionTrendPoints[trendKey] = undefined)}
                          >
                            <line
                              x1="0"
                              y1={trendExpanded ? 127 : 63}
                              x2="280"
                              y2={trendExpanded ? 127 : 63}
                              stroke="var(--color-border)"
                              stroke-width="1"
                            />
                            <polyline
                              points={usageTrendPoints(trend, trendExpanded ? 128 : 64)}
                              fill="none"
                              stroke="var(--color-accent)"
                              stroke-width="2.5"
                              stroke-linecap="round"
                              stroke-linejoin="round"
                            />
                          </svg>
                          <div
                            class="mt-1 flex justify-between text-[9px] text-[var(--color-text-muted)]"
                          >
                            <span>{formatUsageTrendDate(trend[0]?.date)}</span>
                            <span>{formatUsageTrendDate(trend[trend.length - 1]?.date)}</span>
                          </div>
                        </div>
                      {/if}

                      {#if cli.byModel?.length}
                        <div class="space-y-1.5">
                          {#each cli.byModel.slice(0, 4) as m (m.model)}
                            <div class="rounded-lg bg-[var(--color-surface-1)] px-2.5 py-1.5">
                              <div class="flex items-center justify-between text-[11px]">
                                <span class="font-mono text-[var(--color-text-secondary)] truncate"
                                  >{m.model}</span
                                >
                                <span class="font-mono text-[var(--color-text-muted)] shrink-0 ml-3">
                                  {formatTokens(m.tokensIn + m.tokensOut)} tokens
                                </span>
                              </div>
                              {#if m.apiEquivalent || m.apiProvider}
                                <div class="mt-0.5 flex items-center gap-1 text-[9px] text-[var(--color-text-muted)]">
                                  <span class="uppercase tracking-wider font-bold">API equiv</span>
                                  <span
                                    class="font-mono text-[var(--color-accent)]/80 truncate"
                                    title={m.apiEquivalent ?? m.apiProvider ?? ''}
                                  >
                                    {m.apiProvider ? `${m.apiProvider}/` : ''}{m.apiEquivalent ?? '(unmapped)'}
                                  </span>
                                  {#if m.apiEquivalent && m.apiEquivalent === m.model}
                                    <span class="text-[var(--color-text-muted)] italic">(same)</span>
                                  {/if}
                                </div>
                              {/if}
                            </div>
                          {/each}
                        </div>
                      {/if}
                    {/if}
                  </div>
                {/each}
              </div>
            </div>
          {:else if billingCredits?.refreshing && billingCredits?.detectedCliAccounts?.length}
            <div class="space-y-4">
              <div>
                <h3 class="text-sm font-bold text-[var(--color-text-primary)]">
                  CLI subscriptions
                </h3>
                <p class="mt-1 text-[10px] text-[var(--color-text-muted)]">
                  CLI profiles are being checked while usage history is indexed. Connected means a
                  provider probe succeeded; a detected profile has not been connected in Koryphaios
                  yet.
                </p>
              </div>
              <div class="grid grid-cols-1 xl:grid-cols-2 gap-4">
                {#each billingCredits.detectedCliAccounts as account (`${account.provider}:${account.id}`)}
                  <div
                    class="flex items-center gap-3 rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface-2)] p-5"
                  >
                    <div
                      class="flex h-9 w-9 items-center justify-center rounded-lg bg-[var(--color-surface-3)] p-2"
                    >
                      <ProviderIcon provider={account.provider} size={20} />
                    </div>
                    <div class="min-w-0 flex-1">
                      <div class="truncate text-sm font-semibold text-[var(--color-text-primary)]">
                        {account.email || account.label}
                      </div>
                      <div class="text-[10px] text-[var(--color-text-muted)]">
                        {account.plan ? `${account.plan.toUpperCase()} plan · ` : ''}{account.connectionState ===
                        'connected'
                          ? 'Connected · indexing usage…'
                          : account.connectionState === 'failed'
                            ? 'Connection failed · indexing usage…'
                            : 'Detected · not connected · indexing usage…'}
                      </div>
                    </div>
                    <RefreshCw size={14} class="animate-spin text-[var(--color-accent)]" />
                  </div>
                {/each}
              </div>
            </div>
          {/if}

          {#if billingCredits?.balances?.length}
            <div class="space-y-4">
              <h3 class="text-sm font-bold text-[var(--color-text-primary)] ml-1">
                API account balances
              </h3>
              <div class="grid grid-cols-2 sm:grid-cols-4 gap-3">
                {#each billingCredits.balances as bal (bal.provider)}
                  <div
                    class="p-4 bg-[var(--color-surface-2)] rounded-xl border border-[var(--color-border)] text-center"
                  >
                    <div
                      class="w-8 h-8 mx-auto rounded-lg bg-[var(--color-surface-3)] flex items-center justify-center p-1.5 mb-2"
                    >
                      <ProviderIcon provider={bal.provider} size={20} class="w-full h-full" />
                    </div>
                    <div class="text-lg font-black font-mono text-[var(--color-success)]">
                      {bal.availableUsd != null ? `$${bal.availableUsd.toFixed(2)}` : '—'}
                    </div>
                    <div
                      class="text-[9px] uppercase tracking-wider text-[var(--color-text-muted)] font-bold mt-1"
                    >
                      {getProviderDisplayLabel(bal.provider)}
                    </div>
                  </div>
                {/each}
              </div>
            </div>
          {/if}

          <div class="space-y-4">
            <h3 class="text-sm font-bold text-[var(--color-text-primary)] ml-1">
              API Consumption by Provider
            </h3>
            <div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
              {#if billingCredits?.byProvider?.length}
                {#each billingCredits.byProvider as prov (prov.name)}
                  <div
                    class="flex items-center justify-between p-4 bg-[var(--color-surface-2)] rounded-xl border border-[var(--color-border)]"
                  >
                    <div class="flex items-center gap-3">
                      <div
                        class="w-8 h-8 rounded-lg bg-[var(--color-surface-3)] flex items-center justify-center p-1.5 shrink-0"
                      >
                        <ProviderIcon provider={prov.name} size={20} class="w-full h-full" />
                      </div>
                      <div>
                        <span class="text-xs font-semibold"
                          >{getProviderDisplayLabel(prov.name)}</span
                        >
                        <div class="text-[10px] text-[var(--color-text-muted)] font-mono">
                          {formatTokens((prov.tokensIn ?? 0) + (prov.tokensOut ?? 0))} tokens
                        </div>
                      </div>
                    </div>
                    <div class="text-right">
                      <div class="text-xs font-mono font-bold text-[var(--color-text-secondary)]">
                        ${((prov.spendCents ?? 0) / 100).toFixed(3)} spent
                      </div>
                      {#if billingCredits?.balances?.find((b: any) => b.provider === prov.name)?.availableUsd != null}
                        <div class="text-[10px] font-mono text-[var(--color-success)]">
                          ${billingCredits.balances
                            .find((b: any) => b.provider === prov.name)
                            .availableUsd.toFixed(2)} left
                        </div>
                      {/if}
                    </div>
                  </div>
                {/each}
              {:else}
                <div
                  class="col-span-full py-12 text-center border-2 border-dashed border-[var(--color-border)] rounded-2xl"
                >
                  <p class="text-xs text-[var(--color-text-muted)]">
                    No API usage recorded yet — chats through metered providers will appear here
                  </p>
                </div>
              {/if}
            </div>
          </div>
        </div>

        <!-- Memory Tab -->
        {#if open && activeTab === 'memory'}
          <div class="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
            <MemoryEditor />
          </div>
        {/if}

        <!-- Agent Tab -->
        <div
          class={activeTab === 'agent'
            ? 'flex-1 min-h-0 min-w-0 overflow-hidden flex flex-col'
            : 'hidden'}
        >
          <AgentSettings
            focusPermissions={open &&
              activeTab === 'agent' &&
              initialAgentSection === 'permissions'}
          />
        </div>

        <!-- Experimental Tab -->
        <div
          class={activeTab === 'experimental'
            ? 'flex-1 min-h-0 min-w-0 overflow-hidden flex flex-col'
            : 'hidden'}
        >
          <ExperimentalSettings />
        </div>

        <!-- Teams Tab -->
        <div
          class={activeTab === 'teams'
            ? 'flex-1 overflow-y-auto px-6 py-5 flex flex-col'
            : 'hidden'}
        >
          <div class="flex-1 w-full max-w-7xl mx-auto py-10">
            <div class="text-center mb-12">
              <div
                class="w-20 h-20 bg-[var(--color-accent)]/10 text-[var(--color-accent)] rounded-3xl flex items-center justify-center mx-auto mb-6 shadow-xl shadow-[var(--color-accent)]/5"
              >
                <Users size={40} />
              </div>
              <h3 class="text-2xl font-black text-[var(--color-text-primary)]">
                Team Collaboration
              </h3>
              <p class="text-sm text-[var(--color-text-muted)] mt-2">
                The host controls what guests can see, submit, and which models are available
              </p>
            </div>

            {#if collaborationStore.activeCollab}
              <!-- ── ACTIVE SESSION ── -->
              <div class="mx-auto max-w-4xl space-y-6">
                <!-- Invite links -->
                <div
                  class="relative rounded-3xl border border-[var(--color-accent)]/30 bg-[var(--color-surface-2)] p-8 shadow-2xl"
                >
                  <div
                    class="absolute -top-3 left-6 flex items-center gap-1.5 px-4 py-1 rounded-full bg-[var(--color-accent)] text-[10px] font-black uppercase tracking-widest text-[var(--color-surface-0)] shadow-lg"
                  >
                    <span
                      class="h-1.5 w-1.5 rounded-full bg-[var(--color-surface-0)]"
                      aria-hidden="true"
                    ></span>
                    {collaborationStore.activeCollab.relayEnabled
                      ? 'Live via Relay'
                      : 'Active Session'}
                  </div>

                  {#if collaborationStore.activeCollab.relayEnabled}
                    <h4 class="text-sm font-bold text-[var(--color-text-primary)] mb-5">
                      Browser invites
                    </h4>
                    <div class="space-y-3">
                      {#each [{ role: 'viewer', label: 'Viewer · Tier 1', desc: 'Read-only session feed. Cannot submit prompts or run models.', color: 'text-[var(--color-info)]', bg: 'bg-[var(--color-info-bg)]' }, { role: 'collaborator', label: 'Collaborator · Tier 2', desc: 'Can submit prompts when enabled. Host approval remains authoritative.', color: 'text-[var(--color-warning)]', bg: 'bg-[var(--color-warning-bg)]' }, { role: 'yolo', label: 'YOLO · Tier 3', desc: 'Unrestricted auto-execution, tools, models, and filesystem. Trusted users only.', color: 'text-[var(--color-error)]', bg: 'bg-[var(--color-error-bg)]' }] as r (r.role)}
                        <div
                          class="flex items-center gap-4 rounded-2xl bg-[var(--color-surface-1)] p-4"
                        >
                          <div class="flex-1">
                            <div class="flex items-center gap-2 mb-0.5">
                              <span class="text-xs font-bold {r.color}">{r.label}</span>
                            </div>
                            <p class="text-[11px] text-[var(--color-text-muted)]">{r.desc}</p>
                          </div>
                          <button
                            type="button"
                            onclick={() => collaborationStore.createInvite(r.role)}
                            class="shrink-0 rounded-xl {r.bg} {r.color} px-4 py-2 text-xs font-bold transition-all hover:opacity-80"
                          >
                            Copy Link
                          </button>
                        </div>
                      {/each}
                    </div>
                    <div class="mt-5 border-t border-[var(--color-border)] pt-5">
                      <div
                        class="flex items-center justify-between gap-4 rounded-2xl bg-[var(--color-surface-1)] p-4"
                      >
                        <div>
                          <div class="text-xs font-bold text-[var(--color-text-primary)]">
                            Native Koryphaios join
                          </div>
                          <p class="mt-1 text-[11px] text-[var(--color-text-muted)]">
                            Enter this code in Teams on another Koryphaios app.
                          </p>
                        </div>
                        <button
                          type="button"
                          onclick={() => collaborationStore.copyJoinCode()}
                          class="rounded-xl border border-[var(--color-border)] px-4 py-2 font-mono text-sm font-bold tracking-[0.16em] text-[var(--color-accent)] hover:bg-[var(--color-surface-3)]"
                        >
                          {collaborationStore.activeCollab.joinCode}
                        </button>
                      </div>
                    </div>
                  {:else}
                    <!-- Relay not configured — show legacy join code -->
                    <div class="text-center">
                      <p
                        class="mb-2 block text-[10px] font-bold uppercase tracking-widest text-[var(--color-text-muted)]"
                      >
                        Join Code (local network only)
                      </p>
                      <code
                        class="block rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface-1)] py-4 text-3xl font-black tracking-[0.3em] text-[var(--color-accent)]"
                      >
                        {collaborationStore.activeCollab.joinCode || '••••••'}
                      </code>
                      <p class="mt-3 text-[11px] text-[var(--color-text-muted)]">
                        Configure RELAY_URL and RELAY_HOST_SECRET in your environment for
                        internet-accessible invite links.
                      </p>
                    </div>
                  {/if}
                </div>

                <!-- Host policy -->
                <TeamAccessProfiles models={teamModels} />

                <!-- Pending approvals -->
                {#if collaborationStore.pendingPrompts.length > 0}
                  <div
                    class="rounded-3xl border border-[var(--color-warning)] bg-[var(--color-warning-bg)] p-6"
                  >
                    <h4
                      class="text-sm font-bold text-[var(--color-warning)] mb-4 flex items-center gap-2"
                    >
                      <Clock3 size={15} /> Pending Guest Prompts ({collaborationStore.pendingPrompts
                        .length})
                    </h4>
                    <div class="space-y-3">
                      {#each collaborationStore.pendingPrompts as p (p.promptId)}
                        <div
                          class="rounded-2xl bg-[var(--color-surface-1)] border border-[var(--color-border)] p-4"
                        >
                          <div class="flex items-start justify-between gap-4">
                            <div class="flex-1 min-w-0">
                              <div class="flex items-center gap-2 mb-1">
                                <span
                                  class="text-[10px] font-bold uppercase text-[var(--color-warning)]"
                                  >{p.name}</span
                                >
                                <span class="text-[10px] text-[var(--color-text-muted)]"
                                  >· {p.role}</span
                                >
                              </div>
                              <p class="text-sm text-[var(--color-text-primary)] break-words">
                                {p.content}
                              </p>
                              {#if p.model}<p
                                  class="mt-2 text-[10px] text-[var(--color-text-muted)]"
                                >
                                  Model: {p.model}{p.reasoningLevel
                                    ? ` · Reasoning: ${p.reasoningLevel}`
                                    : ' · Provider default reasoning'}
                                </p>{/if}
                            </div>
                            <div class="flex gap-2 shrink-0">
                              <button
                                type="button"
                                onclick={() => collaborationStore.approvePrompt(p.promptId, true)}
                                class="rounded-xl bg-[var(--color-success-bg)] text-[var(--color-success)] px-3 py-1.5 text-xs font-bold hover:opacity-80 transition-opacity"
                              >
                                Approve
                              </button>
                              <button
                                type="button"
                                onclick={() => collaborationStore.approvePrompt(p.promptId, false)}
                                class="rounded-xl bg-[var(--color-error-bg)] text-[var(--color-error)] px-3 py-1.5 text-xs font-bold hover:opacity-80 transition-opacity"
                              >
                                Reject
                              </button>
                            </div>
                          </div>
                        </div>
                      {/each}
                    </div>
                  </div>
                {/if}

                <!-- Stop hosting -->
                <button
                  type="button"
                  onclick={() => collaborationStore.endSession()}
                  class="btn w-full rounded-xl bg-[var(--color-error-bg)] py-3 font-bold text-[var(--color-error)] transition-opacity hover:opacity-80"
                >
                  Stop Hosting
                </button>
              </div>
            {:else}
              <!-- ── NOT HOSTING ── -->
              {#if collaborationStore.joinedSessions.length}
                <div
                  class="mx-auto mb-8 max-w-4xl rounded-3xl border border-[var(--color-border)] bg-[var(--color-surface-2)] p-6"
                >
                  <div class="mb-4">
                    <h4 class="text-sm font-bold text-[var(--color-text-primary)]">
                      Team sessions
                    </h4>
                    <p class="mt-1 text-[11px] text-[var(--color-text-muted)]">
                      These are separate from your personal session history. Joining never replaces
                      or merges your local sessions.
                    </p>
                  </div>
                  <div class="space-y-2">
                    {#each collaborationStore.joinedSessions as team (team.sessionId)}<div
                        class="flex items-center gap-3 rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface-1)] p-4"
                      >
                        <div class="min-w-0 flex-1">
                          <div class="truncate text-xs font-bold text-[var(--color-text-primary)]">
                            {team.sessionName}
                          </div>
                          <div class="mt-1 text-[10px] text-[var(--color-text-muted)]">
                            Access: {team.tierId} · Team workspace
                          </div>
                        </div>
                        <button
                          type="button"
                          onclick={() => collaborationStore.openJoinedSession(team.sessionId)}
                          class="rounded-xl bg-[var(--color-accent)]/10 px-4 py-2 text-xs font-bold text-[var(--color-accent)]"
                          >Open</button
                        ><button
                          type="button"
                          onclick={() => collaborationStore.leaveJoinedSession(team.sessionId)}
                          class="rounded-xl px-3 py-2 text-xs text-[var(--color-error)] hover:bg-[var(--color-error-bg)]"
                          >Leave</button
                        >
                      </div>{/each}
                  </div>
                </div>
              {/if}
              <div class="grid w-full max-w-4xl grid-cols-1 gap-6 mx-auto md:grid-cols-2">
                <div
                  class="flex flex-col rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface-2)] p-6 text-center transition-all hover:border-[var(--color-accent)]/30"
                >
                  <div
                    class="mx-auto mb-4 flex h-10 w-10 items-center justify-center rounded-xl bg-[var(--color-success-bg)] text-[var(--color-success)]"
                  >
                    <Zap size={24} />
                  </div>
                  <h4 class="mb-2 text-base font-bold">Team session</h4>
                  <p class="mb-5 text-xs text-[var(--color-text-muted)]">
                    Generate invite links for teammates to watch or co-pilot your active AI session
                    in real time.
                  </p>

                  <div
                    class="mb-5 flex-1 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-1)] p-4 text-left"
                  >
                    <div class="mb-3 flex items-center justify-between gap-3">
                      <div>
                        <div class="text-xs font-bold text-[var(--color-text-primary)]">
                          Working in
                        </div>
                        <div class="mt-0.5 text-[10px] text-[var(--color-text-muted)]">
                          Workspace roots available to this hosted session.
                        </div>
                      </div>
                      <button
                        type="button"
                        onclick={addHostWorkspacePath}
                        class="flex shrink-0 items-center gap-1.5 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-2)] px-2.5 py-1.5 text-[10px] font-bold text-[var(--color-text-secondary)] transition-colors hover:border-[var(--color-accent)]/50 hover:text-[var(--color-text-primary)]"
                      >
                        <FolderOpen size={13} /> Add folder
                      </button>
                    </div>

                    {#if hostWorkspacePaths.length}
                      <div class="space-y-2">
                        {#each hostWorkspacePaths as path, index (index)}
                          <div
                            class="group flex items-center gap-2 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-0)] p-2 transition-colors focus-within:border-[var(--color-accent)]/60"
                          >
                            <FolderOpen
                              size={14}
                              class="ml-1 shrink-0 text-[var(--color-accent)]"
                            />
                            <input
                              value={path}
                              aria-label={`Hosted workspace path ${index + 1}`}
                              oninput={(event) =>
                                updateHostWorkspacePath(index, event.currentTarget.value)}
                              class="min-w-0 flex-1 bg-transparent px-1 py-1 font-mono text-[11px] text-[var(--color-text-primary)] outline-none"
                              spellcheck="false"
                            />
                            <button
                              type="button"
                              aria-label={`Remove ${path || `workspace path ${index + 1}`}`}
                              onclick={() => removeHostWorkspacePath(index)}
                              class="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-[var(--color-text-muted)] transition-colors hover:bg-[var(--color-error-bg)] hover:text-[var(--color-error)]"
                            >
                              <X size={14} />
                            </button>
                          </div>
                        {/each}
                      </div>
                    {:else}
                      <button
                        type="button"
                        onclick={addHostWorkspacePath}
                        class="flex min-h-24 w-full flex-col items-center justify-center rounded-xl border border-dashed border-[var(--color-border)] text-[var(--color-text-muted)] transition-colors hover:border-[var(--color-accent)]/50 hover:text-[var(--color-text-secondary)]"
                      >
                        <Plus size={18} />
                        <span class="mt-2 text-[10px] font-medium">Add a workspace folder</span>
                      </button>
                    {/if}
                  </div>
                  <button
                    type="button"
                    onclick={startHosting}
                    disabled={collaborationStore.loading ||
                      !hostWorkspacePaths.some((path) => path.trim())}
                    class="btn btn-primary w-full py-3 mt-auto font-bold rounded-xl disabled:opacity-50"
                  >
                    {collaborationStore.loading ? 'Starting...' : 'Start Collaboration'}
                  </button>
                </div>

                <div
                  class="flex flex-col rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface-2)] p-6 text-center transition-all hover:border-[var(--color-accent)]/30"
                >
                  <div
                    class="mx-auto mb-4 flex h-10 w-10 items-center justify-center rounded-xl bg-[var(--color-info-bg)] text-[var(--color-info)]"
                  >
                    <Keyboard size={24} />
                  </div>
                  <h4 class="mb-2 text-base font-bold">Connect to a team</h4>
                  <p class="mb-5 text-xs text-[var(--color-text-muted)]">
                    Enter the host's eight-character code. The host's join policy decides whether
                    you are admitted automatically and which access profile you receive.
                  </p>
                  <div class="space-y-3 text-left">
                    <input
                      bind:value={teamGuestName}
                      placeholder="Your display name"
                      class="w-full rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-1)] px-4 py-3 text-sm outline-none focus:border-[var(--color-accent)]"
                    />
                    <input
                      bind:value={teamJoinCode}
                      maxlength="8"
                      placeholder="JOIN CODE"
                      class="w-full rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-1)] px-4 py-3 text-center font-mono text-lg font-bold uppercase tracking-[0.2em] outline-none focus:border-[var(--color-accent)]"
                    />
                    <button
                      type="button"
                      disabled={teamJoinCode.trim().length !== 8 || collaborationStore.loading}
                      onclick={() =>
                        collaborationStore.joinSession(teamJoinCode, teamGuestName || 'Guest')}
                      class="btn btn-primary w-full rounded-xl py-3 font-bold disabled:opacity-40"
                      >{collaborationStore.loading ? 'Joining…' : 'Request to join'}</button
                    >
                    <p class="text-center text-[10px] text-[var(--color-text-muted)]">
                      Browser guests can still use either signed invite link without installing
                      Koryphaios.
                    </p>
                  </div>
                </div>
              </div>
            {/if}

            <!-- ── SECOND SECTION: Share Models ── separate from collaboration;
               its own models-only invite link so it never grants session access. -->
            <div class="mx-auto mt-8 w-full max-w-4xl border-t border-[var(--color-border)] pt-8">
              <ModelSharingPanel />
            </div>
          </div>
        </div>

        <!-- Notes Tab -->
        <div
          class={activeTab === 'notes'
            ? 'flex-1 overflow-y-auto px-6 py-5 space-y-8 w-full max-w-7xl mx-auto'
            : 'hidden'}
        >
          <div>
            <h3 class="text-base font-semibold mb-1" style="color: var(--color-text-primary);">
              Note Network
            </h3>
            <p class="text-xs" style="color: var(--color-text-muted);">
              Obsidian-style note network — link notes with [[wikilinks]], visualise connections,
              and explicitly choose which notes enter agent context. Pinning only changes list
              order.
            </p>
          </div>

          <!-- Enable / disable -->
          <div class="space-y-5">
            <div
              class="text-[10px] font-semibold uppercase tracking-[0.14em]"
              style="color: var(--color-text-muted);"
            >
              General
            </div>

            <SettingsSwitch
              checked={notesStore.settings.enabled}
              label="Enable Notes"
              description="Show the Notes panel button and enable note creation"
              onchange={() =>
                void notesStore.updateSettings({ enabled: !notesStore.settings.enabled })}
              flat
            />

            <SettingsSwitch
              checked={notesStore.settings.autoIncludeInContext}
              label="Include selected notes in agent context"
              description="Only notes explicitly marked In context are eligible; pinned notes are unaffected"
              onchange={() =>
                void notesStore.updateSettings({
                  autoIncludeInContext: !notesStore.settings.autoIncludeInContext,
                })}
              flat
            />

            <!-- Max context tokens with enable/disable toggle -->
            <div class="flex items-start justify-between gap-4">
              <div class="min-w-0">
                <div class="text-sm font-medium" style="color: var(--color-text-primary);">
                  Max context tokens
                </div>
                <div class="text-xs mt-1" style="color: var(--color-text-muted);">
                  {(notesStore.settings.maxContextTokensEnabled ?? true)
                    ? 'Use a custom 100–100,000 token limit for explicitly selected notes'
                    : 'Custom limit off; the 100,000-token safety ceiling still applies'}
                </div>
              </div>
              <div class="flex items-start gap-4">
                {#if notesStore.settings.maxContextTokensEnabled ?? true}
                  <div class="w-52 shrink-0">
                    <NumberStepper
                      value={notesStore.settings.maxContextTokens}
                      min={100}
                      max={100000}
                      step={100}
                      label="Maximum note context tokens"
                      onchange={(value) => notesStore.updateSettings({ maxContextTokens: value })}
                    />
                  </div>
                {/if}
                <div class="shrink-0">
                  <SettingsSwitch
                    checked={notesStore.settings.maxContextTokensEnabled ?? true}
                    label="Max context tokens"
                    description=""
                    onchange={() =>
                      void notesStore.updateSettings({
                        maxContextTokensEnabled: !(
                          notesStore.settings.maxContextTokensEnabled ?? true
                        ),
                      })}
                    minimal
                    flat
                  />
                </div>
              </div>
            </div>

            <div class="flex items-center justify-between gap-4">
              <div>
                <div class="text-sm font-medium" style="color: var(--color-text-primary);">
                  Default folder path
                </div>
                <div class="text-xs mt-1" style="color: var(--color-text-muted);">
                  New notes are created here by default.
                </div>
              </div>
              <input
                type="text"
                placeholder="/"
                class="input h-8 w-32 text-sm"
                value={notesStore.settings.defaultFolderPath}
                onchange={(e) =>
                  notesStore.updateSettings({
                    defaultFolderPath: (e.currentTarget as HTMLInputElement).value || '/',
                  })}
              />
            </div>
          </div>

          <!-- Separator -->
          <div class="border-t" style="border-color: var(--color-border);"></div>

          <!-- Agent permissions -->
          <div class="space-y-5">
            <div class="flex items-start justify-between gap-4">
              <div>
                <div class="flex items-center gap-2">
                  <Shield size={14} style="color: var(--color-accent);" />
                  <div
                    class="text-[10px] font-semibold uppercase tracking-[0.14em]"
                    style="color: var(--color-text-muted);"
                  >
                    Agent Permissions
                  </div>
                </div>
                <p class="text-xs mt-1.5" style="color: var(--color-text-muted);">
                  Control what agents can do in the note network. Hidden tools are removed entirely
                  — agents won't see them. YOLO mode still bypasses "Ask" prompts.
                </p>
              </div>
              <button
                type="button"
                class="shrink-0 px-2.5 py-1 rounded-lg text-[11px] border transition-colors hover:bg-[var(--color-surface-3)]"
                style="border-color: var(--color-border); color: var(--color-text-muted);"
                onclick={() => void notesStore.resetAgentPermissions()}
              >
                Reset
              </button>
            </div>

            <div class="flex flex-wrap gap-2">
              {#each NOTE_PERMISSION_PRESETS as preset (preset.id)}
                <button
                  type="button"
                  class="px-3 py-2 rounded-xl text-left border transition-colors min-w-[120px]"
                  style="
                  background: {notesStore.agentPermissions.preset === preset.id
                    ? 'var(--color-accent-transparent)'
                    : 'var(--color-surface-2)'};
                  border-color: {notesStore.agentPermissions.preset === preset.id
                    ? 'var(--color-accent)'
                    : 'var(--color-border)'};
                  color: var(--color-text-primary);
                "
                  onclick={() => void notesStore.applyAgentPermissionPreset(preset.id)}
                >
                  <div class="text-xs font-semibold">{preset.label}</div>
                  <div class="text-[10px] mt-0.5" style="color: var(--color-text-muted);">
                    {preset.description}
                  </div>
                </button>
              {/each}
              {#if notesStore.agentPermissions.preset === 'custom'}
                <div
                  class="px-3 py-2 rounded-xl border min-w-[120px]"
                  style="background: var(--color-surface-2); border-color: var(--color-accent); color: var(--color-text-primary);"
                >
                  <div class="text-xs font-semibold">Custom</div>
                  <div class="text-[10px] mt-0.5" style="color: var(--color-text-muted);">
                    Per-action overrides
                  </div>
                </div>
              {/if}
            </div>

            {#if notesStore.agentPermissionsSaving}
              <p class="text-[11px]" style="color: var(--color-text-muted);">Saving permissions…</p>
            {/if}

            <div class="grid gap-4 lg:grid-cols-2">
              {#each ['read', 'write'] as category (category)}
                <div
                  class="rounded-2xl border p-4 space-y-3"
                  style="background: var(--color-surface-2); border-color: var(--color-border);"
                >
                  <div
                    class="text-xs font-semibold capitalize"
                    style="color: var(--color-text-primary);"
                  >
                    {category === 'read' ? 'Read actions' : 'Write actions'}
                  </div>
                  <div class="space-y-2">
                    {#each NOTE_TOOL_DEFINITIONS.filter((d) => d.category === category) as tool (tool.name)}
                      <div class="flex items-center justify-between gap-3 py-1">
                        <div class="min-w-0">
                          <div
                            class="text-xs font-medium truncate"
                            style="color: var(--color-text-primary);"
                          >
                            {tool.label}
                          </div>
                          <div class="text-[10px] truncate" style="color: var(--color-text-muted);">
                            {tool.description}
                          </div>
                        </div>
                        <div
                          class="flex shrink-0 rounded-xl border p-0.5"
                          style="background: var(--color-surface-1); border-color: var(--color-border);"
                        >
                          {#each ['auto', 'ask', 'block'] as level (level)}
                            <button
                              type="button"
                              class="rounded-lg px-2 py-1 text-[10px] font-semibold transition-colors"
                              style="background: {notesStore.agentPermissions.tools[tool.name] ===
                              level
                                ? 'var(--color-surface-4)'
                                : 'transparent'}; color: {notesStore.agentPermissions.tools[
                                tool.name
                              ] === level
                                ? 'var(--color-text-primary)'
                                : 'var(--color-text-muted)'}; box-shadow: {notesStore
                                .agentPermissions.tools[tool.name] === level
                                ? 'inset 0 0 0 1px var(--color-border)'
                                : 'none'};"
                              onclick={() =>
                                void notesStore.setAgentToolPermission(
                                  tool.name,
                                  level as NotePermissionLevel,
                                )}
                              aria-pressed={notesStore.agentPermissions.tools[tool.name] === level}
                            >
                              {permissionLevelLabels[level as NotePermissionLevel]}
                            </button>
                          {/each}
                        </div>
                      </div>
                    {/each}
                  </div>
                </div>
              {/each}
            </div>
          </div>

          <!-- Separator -->
          <div class="border-t" style="border-color: var(--color-border);"></div>

          <!-- Graph physics -->
          <div class="space-y-4">
            <div
              class="text-[10px] font-semibold uppercase tracking-[0.14em]"
              style="color: var(--color-text-muted);"
            >
              Graph Physics
            </div>

            <KorySlider
              id="notes-gravity"
              label="Gravity"
              value={notesStore.settings.graphPhysics.gravity}
              min={-500}
              max={0}
              step={10}
              valueText={`${notesStore.settings.graphPhysics.gravity} gravity strength`}
              onchange={(gravity) =>
                notesStore.updateSettings({
                  graphPhysics: { ...notesStore.settings.graphPhysics, gravity },
                })}
            />

            <KorySlider
              id="notes-link-distance"
              label="Link distance"
              value={notesStore.settings.graphPhysics.linkDistance}
              min={50}
              max={300}
              step={10}
              valueText={`${notesStore.settings.graphPhysics.linkDistance} pixels`}
              onchange={(linkDistance) =>
                notesStore.updateSettings({
                  graphPhysics: { ...notesStore.settings.graphPhysics, linkDistance },
                })}
            />

            <KorySlider
              id="notes-charge"
              label="Charge strength"
              value={notesStore.settings.graphPhysics.chargeStrength}
              min={-500}
              max={-50}
              step={10}
              valueText={`${notesStore.settings.graphPhysics.chargeStrength} charge strength`}
              onchange={(chargeStrength) =>
                notesStore.updateSettings({
                  graphPhysics: { ...notesStore.settings.graphPhysics, chargeStrength },
                })}
            />
          </div>

          <!-- Separator -->
          <div class="border-t" style="border-color: var(--color-border);"></div>

          <!-- Actions -->
          <div class="space-y-3">
            <div
              class="text-[10px] font-semibold uppercase tracking-[0.14em]"
              style="color: var(--color-text-muted);"
            >
              Actions
            </div>

            <button
              type="button"
              class="w-full flex items-center gap-2 px-4 py-2.5 rounded-xl text-sm font-medium transition-colors border hover:bg-[var(--color-surface-3)]"
              style="background: var(--color-surface-2); border-color: var(--color-border); color: var(--color-text-primary);"
              onclick={() => {
                onClose?.();
                window.dispatchEvent(new CustomEvent('open-notes-graph'));
              }}
            >
              <StickyNote size={14} style="color: var(--color-accent);" />
              Open Graph View
            </button>

            <button
              type="button"
              class="w-full flex items-center gap-2 px-4 py-2.5 rounded-xl text-sm font-medium transition-colors border hover:bg-[var(--color-surface-3)]"
              style="background: var(--color-surface-2); border-color: var(--color-border); color: var(--color-text-primary);"
              onclick={() => void notesStore.importMemoryAsNotes()}
            >
              <Brain size={14} style="color: var(--color-text-muted);" />
              Import Memory as Notes
            </button>
          </div>
        </div>
      </div>
    </div>
  </div>
{/if}

{#if showRotateDialog && rotateProvider}
  <div class="fixed inset-0 bg-black/80 flex items-center justify-center z-50 p-4 backdrop-blur-sm">
    <div
      class="bg-[var(--color-surface-1)] rounded-3xl p-8 w-full max-w-md border border-[var(--color-border)] shadow-2xl"
    >
      <h3 class="text-xl font-black mb-2 text-[var(--color-text-primary)]">Rotate API Key</h3>
      <p class="text-xs text-[var(--color-text-muted)] mb-6">
        Enter a new key for {getProviderDisplayLabel(rotateProvider.name)}. Your previous key will
        be immediately discarded.
      </p>
      <div class="relative mb-6">
        <input
          bind:this={rotateKeyInput}
          type={secretInputType('rotate-key')}
          bind:value={newKeyValue}
          placeholder="sk-..."
          class="input w-full pr-12 text-base py-3 font-mono"
        />
        <button
          type="button"
          class="secret-visibility absolute inset-y-0 right-1 my-auto z-10"
          onclick={() => toggleSecretVisibility('rotate-key')}
          aria-label={visibleSecrets['rotate-key']
            ? 'Hide replacement API key'
            : 'Show replacement API key'}
        >
          {#if visibleSecrets['rotate-key']}<EyeOff size={15} />{:else}<Eye size={15} />{/if}
        </button>
      </div>
      <div class="flex justify-end gap-3">
        <button
          type="button"
          onclick={() => {
            showRotateDialog = false;
            newKeyValue = '';
          }}
          class="px-6 py-2.5 text-xs font-bold rounded-xl bg-[var(--color-surface-3)] hover:bg-[var(--color-surface-4)] transition-colors"
          >Cancel</button
        >
        <button
          type="button"
          onclick={() => {
            rotateProviderKey(rotateProvider!.name, newKeyValue, rotateProvider!.keyType);
            showRotateDialog = false;
            newKeyValue = '';
          }}
          class="btn btn-primary px-8 py-2.5 text-xs font-bold rounded-xl shadow-lg shadow-[var(--color-accent)]/20"
          >Rotate Key</button
        >
      </div>
    </div>
  </div>
{/if}

{#if showModelSelector && selectorTarget}
  <ModelSelectionDialog
    providerName={selectorTarget.name}
    availableModels={selectorTarget.allAvailableModels}
    selectedModels={selectorTarget.selectedModels}
    emptyMessage={selectorTarget.emptyMessage}
    onSave={saveSelectedModels}
    onClose={() => {
      showModelSelector = false;
      selectorTarget = null;
    }}
  />
{/if}

{#if showColorPicker}
  <ColorPickerModal
    open={showColorPicker}
    onClose={() => {
      showColorPicker = false;
    }}
  />
{/if}

{#if pendingDeleteProvider}
  <ConfirmDialog
    open={true}
    title="Delete custom provider"
    message={'Remove "' +
      pendingDeleteProvider.label +
      '" from your provider list? This cannot be undone.'}
    variant="danger"
    confirmLabel="Delete"
    onConfirm={confirmDeleteCustomProvider}
    onCancel={() => (pendingDeleteProvider = null)}
  />
{/if}

{#if showAccountManageDialog && managingAccountProvider && managingAccountId}
  <div
    class="fixed inset-0 z-[101] flex items-center justify-center p-4 bg-black/70 backdrop-blur-md"
  >
    <div
      class="w-full max-w-md rounded-2xl border p-5 shadow-2xl"
      style="background: var(--color-surface-1); border-color: var(--color-border);"
    >
      <div class="flex items-center justify-between gap-3">
        <div>
          <h3 class="text-base font-semibold text-[var(--color-text-primary)]">Saved Account</h3>
          <p class="text-xs text-[var(--color-text-muted)]">
            {getProviderDisplayLabel(managingAccountProvider)}
          </p>
        </div>
        <button
          type="button"
          class="rounded-lg p-2 hover:bg-[var(--color-surface-3)]"
          onclick={() => (showAccountManageDialog = false)}
          aria-label="Close"
        >
          <X size={16} />
        </button>
      </div>
      <div class="mt-4 space-y-3">
        <div>
          <label
            class="text-[10px] text-[var(--color-text-muted)] font-medium uppercase tracking-wider"
            for="manage-account-label">Profile Name</label
          >
          <input
            id="manage-account-label"
            type="text"
            bind:value={managingAccountLabel}
            class="input mt-1 w-full text-sm"
          />
        </div>
        <div
          class="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-0)]/70 p-3"
        >
          <div class="text-xs font-semibold text-[var(--color-text-primary)]">
            {managingAccountLabel || 'Unnamed profile'}
          </div>
          <div class="mt-1 text-[11px] text-[var(--color-text-muted)]">
            This name identifies the account when switching. Model management opens the provider
            model selector.
          </div>
        </div>
      </div>
      <div class="mt-5 flex gap-2">
        <button type="button" class="btn btn-secondary flex-1" onclick={manageAccountModels}
          >Manage Models</button
        >
        <button
          type="button"
          class="btn btn-primary flex-1"
          onclick={() => void saveAccountProfileLabelFromDialog()}
          disabled={managingAccountSaving}
        >
          {managingAccountSaving ? 'Saving...' : 'Save Name'}
        </button>
      </div>
    </div>
  </div>
{/if}

<style>
  .no-scrollbar::-webkit-scrollbar {
    display: none;
  }
  .no-scrollbar {
    -ms-overflow-style: none;
    scrollbar-width: none;
  }

  /* Keep tab paint independent from a dynamically assembled utility class.
   * In the desktop webview that class could leave the old tab's filled layer
   * behind while Billing was mounting. */
  .settings-tab {
    color: var(--color-text-muted);
    background: transparent;
    transition:
      color 150ms ease,
      background-color 150ms ease;
  }
  .settings-tab:hover {
    color: var(--color-text-secondary);
  }
  .settings-tab.settings-tab-active {
    color: var(--color-text-primary);
    background: var(--color-surface-3);
    font-weight: 500;
  }

  /* Glassmorphism input styling override */
  :global(.input) {
    background: var(--color-surface-0) !important;
    border: 1px solid var(--color-border) !important;
    border-radius: 0.75rem !important;
    transition: all 0.2s cubic-bezier(0.4, 0, 0.2, 1) !important;
  }
  :global(.input:focus) {
    border-color: var(--color-accent) !important;
    box-shadow: 0 0 0 4px var(--color-accent-transparent) !important;
    background: var(--color-surface-1) !important;
  }
  .secret-visibility {
    display: inline-flex;
    height: 1.9rem;
    width: 1.9rem;
    align-items: center;
    justify-content: center;
    border-radius: 0.45rem;
    color: var(--color-text-muted);
  }
  .secret-visibility:hover,
  .secret-visibility:focus-visible {
    color: var(--color-text-primary);
    background: var(--color-surface-3);
    outline: none;
  }
</style>
