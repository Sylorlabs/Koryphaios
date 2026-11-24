<script lang="ts">
  import { onDestroy, onMount, tick } from 'svelte';
  import { fade, fly } from 'svelte/transition';
  import {
    providerCapabilityKinds,
    type ProviderCapabilityKind,
  } from '@koryphaios/shared';
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
  import Archive from 'lucide-svelte/icons/archive';
  import RotateCcw from 'lucide-svelte/icons/rotate-ccw';
  import Save from 'lucide-svelte/icons/save';
  import GripVertical from 'lucide-svelte/icons/grip-vertical';
  import Plus from 'lucide-svelte/icons/plus';
  import ChevronDown from 'lucide-svelte/icons/chevron-down';
  import Trash2 from 'lucide-svelte/icons/trash-2';
  import StickyNote from 'lucide-svelte/icons/sticky-note';
  import FolderOpen from 'lucide-svelte/icons/folder-open';
  import Download from 'lucide-svelte/icons/download';
  import RefreshCw from 'lucide-svelte/icons/refresh-cw';
  import Eye from 'lucide-svelte/icons/eye';
  import EyeOff from 'lucide-svelte/icons/eye-off';
  import AudioLines from 'lucide-svelte/icons/audio-lines';
  import Film from 'lucide-svelte/icons/film';
  import ImageIcon from 'lucide-svelte/icons/image';
  import ImagePlus from 'lucide-svelte/icons/image-plus';
  import Plug from 'lucide-svelte/icons/plug';
  import Clock3 from 'lucide-svelte/icons/clock-3';
  import House from 'lucide-svelte/icons/house';
  import MemoryEditor from './MemoryEditor.svelte';
  import KorySelect from './KorySelect.svelte';
  import ProviderExecutionModes from './ProviderExecutionModes.svelte';
  import AgentSettings from './AgentSettings.svelte';
  import ExperimentalSettings from './ExperimentalSettings.svelte';
  import ProviderIcon from './icons/ProviderIcon.svelte';
  import FreebuffBalance from './FreebuffBalance.svelte';
  import { memoryStore } from '$lib/stores/memory.svelte';
  import { agentSettingsStore } from '$lib/stores/agent-settings.svelte';
  import { experimentalStore } from '$lib/stores/experimental.svelte';
  import { collaborationStore } from '$lib/stores/collaboration.svelte';
  import { notesStore } from '$lib/stores/notes.svelte';
  import { projectDisplayName, projectStore } from '$lib/stores/project.svelte';
  import { sessionStore } from '$lib/stores/sessions.svelte';
  import ModelSelectionDialog from './ModelSelectionDialog.svelte';
  import TeamAccessProfiles from './TeamAccessProfiles.svelte';
  import ColorPickerModal from './ColorPickerModal.svelte';
  import AppearanceSettings from './AppearanceSettings.svelte';
  import ConfirmDialog from './ConfirmDialog.svelte';
  import ModelSharingPanel from './ModelSharingPanel.svelte';
  import SettingsSwitch from './SettingsSwitch.svelte';
  import VoiceSettings from './VoiceSettings.svelte';
  import ImageSettings from './ImageSettings.svelte';
  import VideoSettings from './VideoSettings.svelte';
  import WelcomeSettings from './WelcomeSettings.svelte';
  import McpServersSettings from './McpServersSettings.svelte';
  import ArchivedChatsSettings from './ArchivedChatsSettings.svelte';
  import CustomProviderIconEditor from './settings/CustomProviderIconEditor.svelte';
  import SettingsPage from './settings/SettingsPage.svelte';
  import NotesSettings from './settings/NotesSettings.svelte';
  import type {
    CustomProviderIconSelection,
    CustomProviderIconShape,
  } from './settings/custom-provider-icon';
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
  import { formatContextWindowOption } from '$lib/utils/context-window';
  import { dndzone } from 'svelte-dnd-action';
  import { invoke } from '@tauri-apps/api/core';
  import LinkDevicePanel from './LinkDevicePanel.svelte';
  import MonitorSmartphone from 'lucide-svelte/icons/monitor-smartphone';
  import Layers from 'lucide-svelte/icons/layers';
  import SkillsWorkspace from './SkillsWorkspace.svelte';
  import ProjectIdentitySettings from './settings/ProjectIdentitySettings.svelte';
  import ProviderIconContextMenu from './ProviderIconContextMenu.svelte';
  import UsageAnalyticsDashboard from './settings/UsageAnalyticsDashboard.svelte';
  import type { UsageViewMode } from '$lib/utils/usage-analytics';

  interface Props {
    open?: boolean;
    initialTab?: SettingsTab | undefined;
    initialAgentSection?: 'permissions';
    voiceSetupRequired?: boolean;
    onClose?: () => void;
  }

  let {
    open = false,
    initialTab,
    initialAgentSection,
    voiceSetupRequired = false,
    onClose,
  }: Props = $props();
  let activeTab = $state<SettingsTab>('providers');
  let settingsSearch = $state('');
  let wasOpen = $state(false);
  let settingsDialog = $state<HTMLDivElement | null>(null);
  let settingsSearchInput = $state<HTMLInputElement | null>(null);
  let previouslyFocused = $state<HTMLElement | null>(null);
  const SETTINGS_PANE_STORAGE_KEY = 'koryphaios-settings-last-pane';
  const settingsIcons: Record<SettingsTab, typeof Key> = {
    project: FolderOpen,
    devices: MonitorSmartphone,
    providers: Key,
    agent: Bot,
    memory: Brain,
    notes: StickyNote,
    skills: Layers,
    archived: Archive,
    appearance: Palette,
    welcome: House,
    shortcuts: Keyboard,
    voice: AudioLines,
    teams: Users,
    billing: CreditCard,
    experimental: Shield,
    images: ImageIcon,
    video: Film,
    mcp: Plug,
  };

  /**
   * Where a non-chat provider is actually used. These providers have no
   * chat-completions endpoint, so the badge tells the user which surface the
   * credential will power instead of leaving them wondering why no models appear.
   */
  const CAPABILITY_SURFACE_LABELS: Partial<Record<ProviderCapabilityKind, string>> = {
    image: 'Images',
    video: 'Video',
    audio: 'Voice',
    embedding: 'Embeddings',
    rerank: 'Rerank',
    memory: 'Memory',
  };

  function capabilityKinds(providerKey: string): ProviderCapabilityKind[] {
    return providerCapabilityKinds(providerKey);
  }

  const filteredSettingsCatalog = $derived(filterSettingsCatalog(SETTINGS_CATALOG, settingsSearch));
  const settingsEntryDescription = (id: SettingsTab): string | undefined =>
    SETTINGS_CATALOG.find((entry) => entry.id === id)?.description;

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
  let colorPickerTarget = $state<'primary' | 'secondary'>('primary');
  let colorPickerScheme = $state<'dark' | 'light'>('dark');
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
  let teamHostName = $state('');
  let hostWorkspacePaths = $state<string[]>(
    projectStore.currentPath ? [projectStore.currentPath] : [],
  );
  let hostPathsInitializedFor = $state<string | null>(projectStore.currentPath);
  let rotateKeyInput = $state<HTMLInputElement | null>(null);
  let visibleSecrets = $state<Record<string, boolean>>({});
  let skillsHaveUnsavedChanges = $state(false);
  let agentSettingsHaveUnsavedChanges = $state(false);
  let showUnsavedEditsCloseConfirmation = $state(false);
  let pendingSettingsCloseAction: (() => void) | null = null;

  function finishSettingsClose() {
    const action = pendingSettingsCloseAction;
    pendingSettingsCloseAction = null;
    onClose?.();
    action?.();
  }

  function requestSettingsCloseWith(action: (() => void) | null = null) {
    pendingSettingsCloseAction = action;
    if (skillsHaveUnsavedChanges || agentSettingsHaveUnsavedChanges) {
      showUnsavedEditsCloseConfirmation = true;
      return;
    }
    finishSettingsClose();
  }

  function requestSettingsClose() {
    requestSettingsCloseWith();
  }

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
      memoryStore.setActiveTab('settings');
      agentSettingsStore.setActiveTab('settings');
      void tick().then(() => {
        if (settingsSearchInput?.getClientRects().length) settingsSearchInput.focus();
        else settingsDialog?.focus();
      });
    } else if (!open && wasOpen) {
      // Reopening rebuilds the panes it needs, so nothing stale survives a
      // closed drawer. Every pane is still mounted while it is in use.
      visitedSettingsTabs = new Set();
      const target = previouslyFocused;
      previouslyFocused = null;
      void tick().then(() => target?.focus());
    }
    wasOpen = open;
  });

  // Mount the pane the user actually opened. Panes that were never opened stay
  // unmounted, so their work never competes with the one that is on screen.
  $effect(() => {
    if (open) markSettingsTabVisited(activeTab);
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
    const trackUnsavedSkills = (event: Event) => {
      skillsHaveUnsavedChanges = (event as CustomEvent<{ dirty?: boolean }>).detail?.dirty === true;
    };
    const trackUnsavedAgentSettings = (event: Event) => {
      agentSettingsHaveUnsavedChanges =
        (event as CustomEvent<{ dirty?: boolean }>).detail?.dirty === true;
    };
    window.addEventListener('koryphaios:skills-dirty', trackUnsavedSkills);
    window.addEventListener('koryphaios:agent-settings-dirty', trackUnsavedAgentSettings);
    // Capture before the page-level shortcut handler. Otherwise assigning a
    // binding such as the primary-modifier chord can trigger the old global
    // action before this
    // drawer has a chance to save the newly captured binding.
    const captureShortcutAssignment = (event: KeyboardEvent) => {
      if (editingShortcutId) handleShortcutKeydown(event);
    };
    window.addEventListener('keydown', captureShortcutAssignment, { capture: true });
    // macOS never delivers fn/Globe to a webview, so the shell relays it and
    // the editor records it here — otherwise Fn could never be assigned even
    // though the voice binding can be set to it.
    const inTauri = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
    let unlistenNativeFn: (() => void) | null = null;
    if (inTauri) {
      void import('@tauri-apps/api/event').then(({ listen }) => {
        void listen('voice://fn-down', () => {
          if (!editingShortcutId) return;
          commitCapturedShortcut(['Fn']);
        }).then((u) => {
          unlistenNativeFn = u;
        });
      });
    }
    return () => {
      window.removeEventListener('open-provider-account-settings', openProviderAccounts);
      window.removeEventListener('koryphaios:skills-dirty', trackUnsavedSkills);
      window.removeEventListener('koryphaios:agent-settings-dirty', trackUnsavedAgentSettings);
      window.removeEventListener('keydown', captureShortcutAssignment, { capture: true });
      unlistenNativeFn?.();
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
    await collaborationStore.hostSession(paths, teamHostName.trim() || 'Host');
  }

  let loadedNotesProject: string | null = null;
  // `null` is a valid "personal skills only" project scope. Keep an explicit
  // uninitialized sentinel so the first Agent open still loads that scope.
  let loadedAgentProject: string | null | undefined = undefined;
  let loadedAgentSkillsProject: string | null | undefined = undefined;

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
      void agentSettingsStore.loadSettingsAndPreferences();
    }
    if (open && activeTab === 'skills' && loadedAgentSkillsProject !== projectPath) {
      loadedAgentSkillsProject = projectPath;
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
      requestSettingsClose();
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
    loadAwsCredentialScan,
    refreshAwsScanAndStatus,
    refreshProvider,
    loadProviderAccounts,
    connectProvider,
    startBrowserAuthFlow,
    finishBrowserAuthFlow,
    disconnectProvider,
    saveProviderAccount,
    activateProviderAccount,
    deleteProviderAccount,
    saveSelectedModels: saveProviderModels,
    saveContextWindow,
    rotateProviderKey,
    addCustomProvider: addCustomProviderToStore,
    deleteCustomProvider: deleteCustomProviderFromStore,
    saveCustomProviderIcon,
    removeCustomProviderIcon,
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
  // The provider catalog arrives over the network, so an empty pane is a
  // loading state rather than a result. Rendering placeholders keeps the
  // drawer from reading as broken for the beat before the data lands.
  let providersLoading = $state(false);
  // Roughly the height of a screenful of provider rows, so the placeholder
  // block occupies about as much space as the catalog that replaces it.
  const PROVIDER_SKELETON_ROWS = Array.from({ length: 8 }, (_, index) => index);
  // Panes mount the first time they are opened and stay mounted afterwards.
  // Mounting every tab at once made opening Settings build all of its markup
  // and fire the Voice/Images/Video/MCP requests before the user looked at
  // any of them, which is what made the drawer feel slow to load.
  let visitedSettingsTabs = $state<Set<SettingsTab>>(new Set());
  const skillsVisited = $derived(visitedSettingsTabs.has('skills'));

  function markSettingsTabVisited(tab: SettingsTab) {
    if (visitedSettingsTabs.has(tab)) return;
    visitedSettingsTabs = new Set(visitedSettingsTabs).add(tab);
  }

  $effect(() => {
    if (collaborationStore.settingsRequest > handledTeamSettingsRequest) {
      handledTeamSettingsRequest = collaborationStore.settingsRequest;
      selectSettingsTab('teams');
    }
  });

  function showTokenInput(name: string, caps: ReturnType<typeof getProviderCaps>): boolean {
    if (usesLocalCliConnection(name) || usesBrowserAuth(name)) return false;
    return caps.supportsAuthToken;
  }

  const isBedrock = (name: string): boolean => name === 'bedrock';
  // Notion credentials are Personal Access Tokens (ntn_…), not API keys.
  const isNotion = (name: string): boolean => name === 'notion';

  function providerCredentialPlaceholder(
    name: string,
    label: string,
    kind: 'apiKey' | 'authToken',
  ): string {
    if (name === 'bedrock') {
      return kind === 'apiKey' ? 'e.g. AKIAIOSFODNN7EXAMPLE' : 'e.g. wJalrXUtnFEMI/K7MDENG/…';
    }
    if (name === 'notion') return 'e.g. ntn_a1b2c3d4…';
    if (kind === 'authToken') {
      return providersStore.tokenPlaceholders[name]
        ? `e.g. ${providersStore.tokenPlaceholders[name]}`
        : `e.g. a1b2c3d4e5f6… (${label} token)`;
    }
    return providersStore.apiKeyPlaceholders[name]
      ? `e.g. ${providersStore.apiKeyPlaceholders[name]}`
      : `e.g. a1b2c3d4e5f6… (${label} API key)`;
  }

  // ─── AWS system-credential banner (Bedrock) ─────────────────────────────
  // The backend scans for credential *sources* on the machine (env vars,
  // ~/.aws/credentials, ~/.aws/config) and reports only where they live.
  // Users can Connect (use the machine's AWS login) or Ignore (dismiss).
  let ignoredAwsScans = $state<Record<string, string>>({});

  function awsBannerDismissed(name: string): boolean {
    const scan = providersStore.awsCredentialScans[name];
    if (!scan?.detected) return true;
    return ignoredAwsScans[name] === scan.description;
  }

  function ignoreSystemCredentials(name: string): void {
    const scan = providersStore.awsCredentialScans[name];
    if (scan) ignoredAwsScans[name] = scan.description;
  }

  async function connectUsingSystemCredentials(name: string): Promise<void> {
    await handleConnectProvider(name);
  }

  function bedrocksInputsVisible(name: string): boolean {
    return isBedrock(name) && !usesLocalCliConnection(name) && !usesBrowserAuth(name);
  }

  $effect(() => {
    if (!open) return;
    if (activeTab === 'providers' && expandedProvider === 'bedrock') {
      void refreshAwsScanAndStatus('bedrock');
    }
  });

  // Freebuff account-hour snapshots shown on the provider card itself — the
  // billing dashboard's cliUsage feed only loads on the billing tab, so the
  // card fetches the dedicated account endpoint when this section opens.
  let freebuffAccountRows = $state<
    Array<{ accountId: string; label?: string; snapshot?: import('@koryphaios/shared').FreebuffAccountSnapshot }>
  >([]);

  async function loadFreebuffAccountRows() {
    try {
      const res = await apiFetch(apiUrl('/api/providers/freebuff/account'), {}, 15_000);
      const body = await parseJsonResponse<{ data?: typeof freebuffAccountRows }>(res);
      freebuffAccountRows = Array.isArray(body?.data) ? body.data : [];
    } catch {
      freebuffAccountRows = [];
    }
  }

  // The hour rows are fetched lazily on card expansion rather than inside
  // loadProviderSection: a throw in an upstream loader there must never starve
  // this fetch, and expanding is exactly when the balance is visible.
  $effect(() => {
    if (open && expandedProvider === 'freebuff' && freebuffAccountRows.length === 0) {
      void loadFreebuffAccountRows();
    }
  });

  async function loadProviderSection() {
    providersLoading = true;
    try {
      if (providersStore.availableProviderTypes.length === 0) await loadAvailableProviders();
      await loadProvidersFromApi();
      await loadDetectedClis();
    } finally {
      providersLoading = false;
    }
  }

  async function refreshProviderSection() {
    providersLoading = true;
    try {
      if (providersStore.availableProviderTypes.length === 0) await loadAvailableProviders();
      await loadProvidersFromApi({ forceRefreshModels: true });
      await loadDetectedClis();
      await loadFreebuffAccountRows();
    } finally {
      providersLoading = false;
    }
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
        void loadProviderSection();
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
  type ProviderCategory = 'all' | 'ready' | 'auth' | 'subscriptions' | 'api' | 'local' | 'custom';
  let providerCategory = $state<ProviderCategory>('all');
  const PROVIDER_CATEGORIES: Array<{ id: ProviderCategory; label: string }> = [
    { id: 'all', label: 'All' },
    { id: 'ready', label: 'Connected' },
    { id: 'auth', label: 'Auth' },
    { id: 'subscriptions', label: 'CLI subscriptions' },
    { id: 'api', label: 'API' },
    { id: 'local', label: 'Local' },
    { id: 'custom', label: 'Custom' },
  ];
  const LOCAL_PROVIDER_KEYS = new Set(['local', 'ollama', 'lmstudio', 'llamacpp']);
  const AUTH_PROVIDER_KEYS = new Set(['codex-auth']);
  // Categorization is based on the provider being used, not incidental CLI
  // detection. For example, installing `claude` must not reclassify the
  // direct `anthropic` API provider as a subscription.
  const CLI_SUBSCRIPTION_PROVIDER_KEYS = new Set([
    'claude',
    'codex',
    'grok',
    'antigravity',
    'kimicode',
    'cursor',
    'devin',
    'freebuff',
    'omnirush',
    'opencode',
  ]);
  const LOCAL_ENDPOINT_PROVIDER_KEYS = new Set(['local', 'ollama', 'lmstudio', 'llamacpp']);
  const isCliExecutionProvider = (providerKey: string): boolean =>
    CLI_SUBSCRIPTION_PROVIDER_KEYS.has(providerKey) &&
    !LOCAL_ENDPOINT_PROVIDER_KEYS.has(providerKey);
  const providerCategoryFor = (provider: {
    key: string;
  }): Exclude<ProviderCategory, 'all' | 'ready'> => {
    if (LOCAL_PROVIDER_KEYS.has(provider.key)) return 'local';
    if (provider.key.startsWith('custom:')) return 'custom';
    if (AUTH_PROVIDER_KEYS.has(provider.key)) return 'auth';
    if (CLI_SUBSCRIPTION_PROVIDER_KEYS.has(provider.key)) {
      return 'subscriptions';
    }
    return 'api';
  };
  const installedClis = $derived(providersStore.detectedClis.filter((c) => c.installed));
  const installedCliFor = (providerKey: string) =>
    providersStore.detectedClis.find((cli) => cli.provider === providerKey && cli.installed);
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
          return status?.connectionState === 'verified';
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
    if (deployment === 'hybrid') return 'Cloud + local';
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
    if (deployment === 'hybrid') {
      return 'Cloud sandboxes or a local agent · chosen per thread';
    }
    if (deployment === 'local') {
      return isCliExecutionProvider(providerKey) ? null : 'Local endpoint';
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
  let customForm = $state({
    label: '',
    baseUrl: '',
    apiKey: '',
    models: '',
    headers: '',
    adapter: '',
  });
  let showNewCustomIconEditor = $state(false);
  let showCustomAdvanced = $state(false);
  let newCustomIconSelection = $state.raw<CustomProviderIconSelection | null>(null);
  let customAddError = $state('');
  let customCanSaveUnverified = $state(false);
  let customRequiresManualModels = $state(false);
  let customIconEditorTarget = $state<{ id: string; label: string } | null>(null);
  let customIconDraft = $state.raw<CustomProviderIconSelection | null | undefined>(undefined);
  let customIconSaving = $state(false);
  let customIconDialog = $state<HTMLDivElement | null>(null);
  let customIconPreviouslyFocused = $state<HTMLElement | null>(null);
  let customIconEditorError = $state('');
  let providerIconContextMenu = $state<{
    id: string;
    providerKey: string;
    providerLabel: string;
    hasCustomIcon: boolean;
    x: number;
    y: number;
    returnFocus: HTMLElement | null;
  } | null>(null);
  let copiedEndpoint = $state(false);
  let pendingDeleteProvider = $state<{ id: string; label: string } | null>(null);

  function resetCustomProviderForm() {
    customForm = {
      label: '',
      baseUrl: '',
      apiKey: '',
      models: '',
      headers: '',
      adapter: '',
    };
    showNewCustomIconEditor = false;
    newCustomIconSelection = null;
    showCustomAdvanced = false;
    customAddError = '';
    customCanSaveUnverified = false;
    customRequiresManualModels = false;
  }

  // "Name: Value" per line; malformed lines are skipped, case-insensitive
  // duplicate names resolve last-wins. Empty input means no headers.
  function parseCustomHeaders(raw: string): Record<string, string> | undefined {
    const parsed = new Map<string, { name: string; value: string }>();
    for (const line of raw.split('\n')) {
      const text = line.trim();
      const colon = text.indexOf(':');
      if (colon <= 0) continue;
      const name = text.slice(0, colon).trim();
      if (!/^[a-zA-Z0-9!#$%&'*+\-.^_`|~]+$/.test(name)) continue;
      parsed.set(name.toLowerCase(), { name, value: text.slice(colon + 1).trim() });
    }
    if (parsed.size === 0) return undefined;
    return Object.fromEntries([...parsed.values()].map(({ name, value }) => [name, value]));
  }

  async function addCustomProvider(allowUnverified = false) {
    customAddError = '';
    customCanSaveUnverified = false;
    customRequiresManualModels = false;
    const result = await addCustomProviderToStore({
      ...customForm,
      headers: parseCustomHeaders(customForm.headers),
      allowUnverified,
    });
    if (result.normalizedBaseUrl) customForm.baseUrl = result.normalizedBaseUrl;
    if (result.ok) {
      if (result.id && newCustomIconSelection?.blob) {
        await saveCustomProviderIcon(result.id, newCustomIconSelection);
      }
      resetCustomProviderForm();
      showAddCustom = false;
      return;
    }
    customAddError = result.error ?? 'Koryphaios could not add this provider.';
    customCanSaveUnverified = result.canSaveUnverified === true;
    customRequiresManualModels = result.requiresManualModels === true;
  }

  function openCustomIconEditor(id: string, label: string) {
    customIconPreviouslyFocused =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    customIconEditorTarget = { id, label };
    customIconDraft = undefined;
    customIconEditorError = '';
    void tick().then(() => customIconDialog?.focus());
  }

  function providerIconMenuId(providerKey: string): string {
    return `provider-icon-menu-${providerKey.replace(/[^a-zA-Z0-9_-]/g, '-')}`;
  }

  function openProviderIconContextMenu(
    event: MouseEvent,
    providerKey: string,
    providerLabel: string,
    returnFocus?: HTMLElement | null,
  ) {
    event.preventDefault();
    event.stopPropagation();
    providerIconContextMenu = {
      id: providerIconMenuId(providerKey),
      providerKey,
      providerLabel,
      hasCustomIcon: Boolean(providersStore.getCustomProviderIcon(providerKey)),
      x: event.clientX,
      y: event.clientY,
      returnFocus: returnFocus ?? (event.currentTarget as HTMLElement | null),
    };
  }

  function openProviderIconContextMenuFromKeyboard(
    event: KeyboardEvent,
    providerKey: string,
    providerLabel: string,
  ) {
    if (event.key !== 'ContextMenu' && !(event.shiftKey && event.key === 'F10')) return;
    event.preventDefault();
    event.stopPropagation();
    const trigger = event.currentTarget as HTMLElement;
    const rect = trigger.getBoundingClientRect();
    providerIconContextMenu = {
      id: providerIconMenuId(providerKey),
      providerKey,
      providerLabel,
      hasCustomIcon: Boolean(providersStore.getCustomProviderIcon(providerKey)),
      x: rect.left,
      y: rect.bottom + 4,
      returnFocus: trigger,
    };
  }

  function closeProviderIconContextMenu() {
    providerIconContextMenu = null;
  }

  function editProviderIconFromContextMenu(providerKey: string, providerLabel: string) {
    openCustomIconEditor(providerKey, providerLabel);
  }

  async function removeProviderIconFromContextMenu(providerKey: string) {
    await removeCustomProviderIcon(providerKey);
  }

  function openProviderSettingsFromContextMenu(providerKey: string) {
    selectSettingsTab('providers');
    expandedProvider = providerKey;
  }

  function finishCustomIconEditorClose() {
    const focusTarget = customIconPreviouslyFocused;
    customIconEditorTarget = null;
    customIconDraft = undefined;
    customIconEditorError = '';
    customIconPreviouslyFocused = null;
    void tick().then(() => {
      if (focusTarget?.isConnected) focusTarget.focus();
      else settingsDialog?.focus();
    });
  }

  function closeCustomIconEditor() {
    if (customIconSaving) return;
    finishCustomIconEditorClose();
  }

  function customIconDialogFocusableElements(): HTMLElement[] {
    if (!customIconDialog) return [];
    return [
      ...customIconDialog.querySelectorAll<HTMLElement>(
        'button, [href], input, textarea, [tabindex]:not([tabindex="-1"])',
      ),
    ].filter(
      (element) =>
        element.tabIndex >= 0 &&
        !element.matches(':disabled') &&
        !element.hasAttribute('hidden') &&
        element.getAttribute('aria-hidden') !== 'true',
    );
  }

  function handleCustomIconDialogKeydown(event: KeyboardEvent) {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      closeCustomIconEditor();
      return;
    }
    if (event.key !== 'Tab') return;

    const focusable = customIconDialogFocusableElements();
    if (focusable.length === 0) {
      event.preventDefault();
      customIconDialog?.focus();
      return;
    }
    const first = focusable[0];
    const last = focusable.at(-1)!;
    if (
      event.shiftKey &&
      (document.activeElement === first || document.activeElement === customIconDialog)
    ) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  async function persistCustomIconDraft() {
    if (!customIconEditorTarget || customIconDraft === undefined) return;
    customIconSaving = true;
    try {
      const ok =
        customIconDraft === null
          ? await removeCustomProviderIcon(customIconEditorTarget.id)
          : await saveCustomProviderIcon(customIconEditorTarget.id, customIconDraft);
      if (ok) {
        finishCustomIconEditorClose();
      }
    } finally {
      customIconSaving = false;
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

  // The CodeBuddy CLI and WorkBuddy Desktop catalogs publish their own
  // selectable context tiers. The vendor defaults to a smaller tier (e.g.
  // 300K on a 1M model), so Koryphaios pins the maximum unless the user (or
  // the backend through the same provider API) chooses another value.
  function contextWindowOptionsFor(status: any): number[] {
    const options = status?.contextWindowOptions;
    return Array.isArray(options)
      ? options.filter(
          (n: unknown): n is number =>
            typeof n === 'number' && Number.isSafeInteger(n) && n > 0,
        )
      : [];
  }

  function contextWindowValueFor(status: any): string {
    const options = contextWindowOptionsFor(status);
    if (options.length < 2) return '';
    const maximum = options[options.length - 1];
    const configured = status?.contextWindow;
    return String(
      typeof configured === 'number' && options.includes(configured) ? configured : maximum,
    );
  }

  function contextWindowSelectOptions(status: any) {
    const options = contextWindowOptionsFor(status);
    const maximum = options[options.length - 1];
    return options.map((tokens) => ({
      value: String(tokens),
      label: formatContextWindowOption(tokens),
      description:
        tokens === maximum
          ? 'Maximum tier (Koryphaios default)'
          : `${formatContextWindowOption(tokens)} token session budget`,
    }));
  }

  async function handleContextWindowChange(name: string, value: string) {
    const tokens = Number(value);
    if (!Number.isSafeInteger(tokens) || tokens <= 0) return;
    await saveContextWindow(name, tokens);
  }

  function modelSelectorTarget(status: any) {
    const accounts = getProviderAccounts(status.name).filter(
      (account) => account.source === 'cli-autodetect',
    );
    if (accounts.length < 2) return status;
    const fallback = providersStore.fallbackOrders[status.name];
    if (fallback === undefined) return status;
    const enabledAccounts = new Set(fallback);
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
    if ((selectorTarget.allAvailableModels?.length ?? 0) === 0) {
      void refreshProvider(status.name, { silent: true }).then((result) => {
        const latest = result.status;
        if (!latest || !showModelSelector || selectorTarget?.name !== status.name) return;
        selectorTarget = modelSelectorTarget(latest);
      });
    }
  }

  $effect(() => {
    if (!showModelSelector || !selectorTarget) return;
    // The dialog snapshots its catalog at open and owns in-progress picks, so
    // only refresh its target when the list was still loading. Replacing the
    // target mid-session used to reset the user's picks on custom providers.
    if ((selectorTarget.allAvailableModels?.length ?? 0) > 0) return;
    const latest = getProviderStatus(selectorTarget.name);
    if (!latest) return;
    const next = modelSelectorTarget(latest);
    if (
      (next.allAvailableModels?.length ?? 0) !== (selectorTarget.allAvailableModels?.length ?? 0) ||
      (next.emptyMessage ?? '') !== (selectorTarget.emptyMessage ?? '')
    ) {
      selectorTarget = next;
    }
  });

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
    showAccountManageDialog = false;
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
  function commitCapturedShortcut(keys: string[]) {
    const shortcuts = shortcutStore.list;
    const idx = shortcuts.findIndex((s) => s.id === editingShortcutId);
    if (idx >= 0) {
      shortcuts[idx] = { ...shortcuts[idx], keys };
      shortcutStore.list = [...shortcuts];
      shortcutStore.save();
    }
    editingShortcutId = null;
    capturedKeys = [];
  }
  function handleShortcutKeydown(e: KeyboardEvent) {
    if (!editingShortcutId) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    const keys: string[] = [];
    // A single platform modifier is recorded as 'Mod' so the binding follows
    // the platform: capturing ⌘ on a Mac should still mean Ctrl elsewhere.
    const primaryModifier = e.metaKey !== e.ctrlKey ? (e.metaKey ? 'Meta' : 'Ctrl') : 'Mod';
    if (e.ctrlKey || e.metaKey) keys.push(primaryModifier);
    if (e.shiftKey) keys.push('Shift');
    if (e.altKey) keys.push('Alt');
    const key = e.key;
    if (!['Control', 'Shift', 'Alt', 'Meta'].includes(key))
      keys.push(key.length === 1 ? key.toUpperCase() : key);
    if (keys.length === 0) return;
    capturedKeys = keys;
    if (!['Control', 'Shift', 'Alt', 'Meta'].includes(key)) commitCapturedShortcut(keys);
  }
  function resetShortcuts() {
    shortcutStore.reset();
    shortcutStore.save();
    toastStore.info('Shortcuts reset');
  }

  // ─── Billing ─────────────────────────────────────────────────────────
  let billingSummaryLoading = $state(false);
  let billingLiveLoading = $state(false);
  let billingCredits = $state<any>(null);
  // Environment scope belongs to the billing dashboard, where it filters real
  // usage data. It is intentionally not a global Settings-header control.
  let settingsEnvironmentScope = $state('all');
  let billingViewMode = $state<UsageViewMode>('cost');
  let billingError = $state<string | null>(null);
  let billingLiveError = $state<string | null>(null);
  let billingRefreshTimer: ReturnType<typeof setTimeout> | null = null;
  let expandedSubscriptionTrends = $state<Record<string, boolean>>({});
  let subscriptionTrendRanges = $state<Record<string, number>>({});
  let activeSubscriptionTrendPoints = $state<Record<string, number | undefined>>({});
  const BILLING_PREFERENCES_STORAGE_KEY = 'koryphaios-billing-preferences-v1';
  let billingExcludedProviders = $state<string[]>([]);
  let showSubscriptionApiEquivalent = $state(true);
  let expandedBillingProviders = $state<Record<string, boolean>>({});
  let billingControlsExpanded = $state(false);
  let billingControlsSearch = $state('');
  const TEAM_UI_PREFERENCES_STORAGE_KEY = 'koryphaios-team-ui-preferences-v1';
  let showTeamSidebarShortcut = $state(false);

  function loadTeamUiPreferences() {
    if (typeof localStorage === 'undefined') return;
    try {
      const parsed = JSON.parse(localStorage.getItem(TEAM_UI_PREFERENCES_STORAGE_KEY) ?? '{}') as {
        showTeamSidebarShortcut?: boolean;
      };
      showTeamSidebarShortcut = parsed.showTeamSidebarShortcut === true;
    } catch {
      showTeamSidebarShortcut = false;
    }
  }

  function toggleTeamSidebarShortcut() {
    showTeamSidebarShortcut = !showTeamSidebarShortcut;
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(
        TEAM_UI_PREFERENCES_STORAGE_KEY,
        JSON.stringify({ showTeamSidebarShortcut }),
      );
    }
    window.dispatchEvent(new CustomEvent('kory:team-ui-preferences-changed'));
  }

  function loadBillingPreferences() {
    if (typeof localStorage === 'undefined') return;
    try {
      const parsed = JSON.parse(localStorage.getItem(BILLING_PREFERENCES_STORAGE_KEY) ?? '{}') as {
        excludedProviders?: string[];
        showSubscriptionApiEquivalent?: boolean;
      };
      billingExcludedProviders = Array.isArray(parsed.excludedProviders)
        ? parsed.excludedProviders.filter((provider) => typeof provider === 'string')
        : [];
      showSubscriptionApiEquivalent = parsed.showSubscriptionApiEquivalent !== false;
    } catch {
      billingExcludedProviders = [];
      showSubscriptionApiEquivalent = true;
    }
  }

  function saveBillingPreferences() {
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(
        BILLING_PREFERENCES_STORAGE_KEY,
        JSON.stringify({
          excludedProviders: billingExcludedProviders,
          showSubscriptionApiEquivalent,
        }),
      );
    }
    window.dispatchEvent(new CustomEvent('kory:billing-preferences-changed'));
  }

  function billingProviderIncluded(provider: string): boolean {
    return !billingExcludedProviders.includes(provider.toLowerCase());
  }

  function billingApiPath(path: string, forceRefresh = false): string {
    const params = new URLSearchParams();
    if (forceRefresh) params.set('refresh', '1');
    for (const provider of billingExcludedProviders) params.append('excludeProvider', provider);
    const query = params.toString();
    return `${path}${query ? `?${query}` : ''}`;
  }

  async function toggleBillingProvider(provider: string) {
    const normalized = provider.toLowerCase();
    billingExcludedProviders = billingProviderIncluded(normalized)
      ? [...billingExcludedProviders, normalized]
      : billingExcludedProviders.filter((item) => item !== normalized);
    saveBillingPreferences();
    await loadBillingCredits();
  }

  function toggleSubscriptionApiEquivalent() {
    showSubscriptionApiEquivalent = !showSubscriptionApiEquivalent;
    saveBillingPreferences();
  }

  function formatBillingUsd(value: number | null | undefined, minimumDigits = 2): string {
    if (value == null || !Number.isFinite(value)) return '$?.??';
    if (value === 0) return '$0.00';
    const digits =
      value >= 100 ? Math.max(minimumDigits, 2) : value >= 1 ? Math.max(minimumDigits, 4) : 6;
    return `$${value.toFixed(digits)}`;
  }

  onMount(() => {
    loadBillingPreferences();
    loadTeamUiPreferences();
  });

  function formatTokens(n: number): string {
    if (!Number.isFinite(n) || n <= 0) return '0';
    if (n >= 1e9) return (n / 1e9).toFixed(1) + 'B';
    if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
    if (n >= 1e3) return (n / 1e3).toFixed(1) + 'k';
    return String(n);
  }

  function formatUsdRate(n: number): string {
    return n.toLocaleString(undefined, { maximumFractionDigits: 6 });
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

  function formatBalanceReset(ms: number | undefined): string {
    if (ms == null || !Number.isFinite(ms)) return '';
    return new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' }).format(
      new Date(ms),
    );
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

  // The billing panel reads two endpoints: /summary carries the local ledger
  // data (spend, analytics, accounts) and /live the slower CLI/balance probes.
  // Each merges into billingCredits as it arrives so the fast part is never
  // held back by the slow one.
  function mergeBillingPayload(data: any) {
    const providers = new Set<string>([
      ...((billingCredits?.availableBillingProviders as string[] | undefined) ?? []),
      ...((data?.availableBillingProviders as string[] | undefined) ?? []),
    ]);
    billingCredits = {
      ...(billingCredits ?? {}),
      ...data,
      availableBillingProviders: [...providers].sort((a, b) => a.localeCompare(b)),
    };
  }

  async function fetchBillingSummary(forceRefresh: boolean) {
    billingSummaryLoading = true;
    try {
      const res = await apiFetch(
        apiUrl(billingApiPath('/api/billing/summary', forceRefresh)),
        {},
        15_000,
      );
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        billingError =
          text && text.trim()
            ? `Billing API not available (${res.status})`
            : 'Billing API not available';
        return;
      }
      const data = await parseJsonResponse(res);
      if (data?.ok === false) {
        billingError = data.error || 'Billing API returned an error';
        return;
      }
      mergeBillingPayload(data);
    } catch (e: unknown) {
      billingError = e instanceof Error ? e.message : String(e);
    } finally {
      billingSummaryLoading = false;
    }
  }

  async function fetchBillingLive(forceRefresh: boolean) {
    billingLiveLoading = true;
    try {
      let res = await apiFetch(
        apiUrl(billingApiPath('/api/billing/live', forceRefresh)),
        {},
        15_000,
      );
      if (!res.ok && (res.status === 500 || res.status === 408) && forceRefresh) {
        // Some environments stall during refresh work (provider APIs, heavy log
        // scans); drop to cached mode and keep the UI usable.
        res = await apiFetch(apiUrl(billingApiPath('/api/billing/live')), {}, 15_000);
      }
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        billingLiveError =
          text && text.trim()
            ? `Billing live data not available (${res.status})`
            : 'Billing live data not available';
        return;
      }
      const data = await parseJsonResponse(res);
      if (data?.ok === false) {
        billingLiveError = data.error || 'Billing API returned an error';
        return;
      }
      mergeBillingPayload(data);
      // Slow CLI scans and provider balances complete in the background. Keep
      // the drawer interactive, then refresh just the live part once.
      if (data?.refreshing) {
        billingRefreshTimer = setTimeout(() => {
          billingRefreshTimer = null;
          if (open && activeTab === 'billing') void fetchBillingLive(false);
        }, 1_500);
      }
    } catch (e: unknown) {
      billingLiveError = e instanceof Error ? e.message : String(e);
    } finally {
      billingLiveLoading = false;
    }
  }

  async function loadBillingCredits(forceRefresh = false) {
    if (billingRefreshTimer) {
      clearTimeout(billingRefreshTimer);
      billingRefreshTimer = null;
    }
    billingError = null;
    billingLiveError = null;
    await Promise.allSettled([fetchBillingSummary(forceRefresh), fetchBillingLive(forceRefresh)]);
  }

  // The drawer can be opened directly on Billing (for example from a shortcut),
  // which bypasses the sidebar click handler. Load once in that case too; the
  // explicit Refresh button remains the only forced network refresh.
  $effect(() => {
    if (
      open &&
      activeTab === 'billing' &&
      !billingCredits &&
      !billingSummaryLoading &&
      !billingLiveLoading &&
      !billingError &&
      !billingLiveError
    ) {
      void loadBillingCredits();
    }
  });

  let apiUsage = $state<{
    entries: Array<{
      id: string;
      ts: number;
      kind: string;
      provider: string;
      model: string;
      estimatedCostUsd?: number;
      detail?: string;
    }>;
    totals: {
      totalCount: number;
      byKind: Record<string, number>;
      estimatedCostUsd?: number;
    };
  } | null>(null);
  let apiUsageLoading = $state(false);
  let apiUsageError = $state<string | null>(null);

  async function loadApiUsage() {
    apiUsageLoading = true;
    apiUsageError = null;
    try {
      const res = await apiFetch(apiUrl('/api/usage?limit=25'));
      const data = await parseJsonResponse(res);
      if (!res.ok || !data?.ok) throw new Error(data?.error || `Usage API returned ${res.status}`);
      apiUsage = data.data;
    } catch (e: unknown) {
      apiUsageError = e instanceof Error ? e.message : String(e);
    } finally {
      apiUsageLoading = false;
    }
  }

  async function exportUsageCsv() {
    try {
      const res = await apiFetch(apiUrl('/api/usage/export'));
      if (!res.ok) throw new Error(`Export failed (${res.status})`);
      const blob = await res.blob();
      const anchor = document.createElement('a');
      anchor.href = URL.createObjectURL(blob);
      anchor.download = `koryphaios-api-usage-${new Date().toISOString().slice(0, 10)}.csv`;
      anchor.click();
      // Defer revocation: older WKWebView builds cancel in-flight downloads
      // when the URL is revoked synchronously.
      setTimeout(() => URL.revokeObjectURL(anchor.href), 0);
    } catch (e: unknown) {
      toastStore.error(e instanceof Error ? e.message : 'Could not export usage');
    }
  }

  function formatApiUsageKind(kind: string): string {
    if (kind === 'image') return 'Image';
    if (kind === 'tts') return 'Speech';
    if (kind === 'stt') return 'Transcribe';
    return kind;
  }

  $effect(() => {
    if (open && activeTab === 'billing' && !apiUsage && !apiUsageError && !apiUsageLoading) {
      void loadApiUsage();
    }
  });

  // Closing the drawer invalidates the panel so reopening shows fresh counts.
  $effect(() => {
    if (!open) apiUsage = null;
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
    class="fixed inset-0 z-[var(--z-modal)] flex min-h-0 flex-col"
    style="background: var(--color-surface-1);"
    role="dialog"
    aria-modal="true"
    aria-labelledby="settings-title"
    data-testid="settings-drawer"
    in:fly={{ y: 14, duration: 200 }}
    out:fade={{ duration: 140 }}
  >
    <!-- Header -->
    <div
      class="settings-frame-header flex h-14 shrink-0 items-center justify-between border-b px-5"
      style="background: var(--color-surface-0);"
    >
      <div class="flex min-w-0 flex-wrap items-center gap-x-3.5 gap-y-1">
        <h2
          id="settings-title"
          class="text-[15px] font-semibold tracking-tight"
          style="color: var(--color-text-primary);"
        >
          Settings
        </h2>
      </div>
      <button
        type="button"
        class="flex h-8 w-8 items-center justify-center rounded-lg text-[var(--color-text-muted)] transition-colors hover:bg-[var(--color-surface-3)] hover:text-[var(--color-text-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)]/60"
        onclick={requestSettingsClose}
        aria-label="Close settings"
      >
        <X size={16} />
      </button>
    </div>

    <div class="flex min-h-0 flex-1 overflow-hidden">
      <aside
        class="settings-navigation flex w-16 shrink-0 flex-col border-r border-[var(--color-border)] bg-[var(--color-surface-0)] sm:w-60"
        aria-label="Settings navigation"
      >
        <div class="hidden p-3 pb-1 sm:block">
          <label for="settings-search" class="sr-only">Search settings</label>
          <div class="relative">
            <Search
              size={13}
              class="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-[var(--color-text-muted)]"
            />
            <input
              bind:this={settingsSearchInput}
              id="settings-search"
              type="search"
              bind:value={settingsSearch}
              placeholder="Search settings"
              class="h-9 w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-1)] pl-8 pr-8 text-xs text-[var(--color-text-primary)] outline-none placeholder:text-[var(--color-text-muted)] hover:border-[var(--color-border-bright)] focus-visible:border-[var(--color-accent)]"
            />
            {#if settingsSearch}
              <button
                type="button"
                aria-label="Clear settings search"
                onclick={() => (settingsSearch = '')}
                class="absolute right-1.5 top-1/2 flex h-6 w-6 -translate-y-1/2 items-center justify-center rounded-md text-[var(--color-text-muted)] hover:bg-[var(--color-surface-3)] hover:text-[var(--color-text-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)]/60"
              >
                <X size={12} />
              </button>
            {/if}
          </div>
        </div>

        <nav class="min-h-0 flex-1 overflow-y-auto px-2 py-2" aria-label="Settings sections">
          {#each SETTINGS_GROUPS as group (group)}
            {@const groupEntries = filteredSettingsCatalog.filter((entry) => entry.group === group)}
            {#if groupEntries.length}
              <div class="mb-2">
                <div
                  class="hidden px-2.5 pb-1 pt-3 text-xs font-medium text-[var(--color-text-muted)] sm:block"
                >
                  {group}
                </div>
                <div class="space-y-px">
                  {#each groupEntries as entry (entry.id)}
                    {@const Icon = settingsIcons[entry.id]}
                    <button
                      type="button"
                      class="settings-tab flex h-9 w-full items-center justify-center gap-2.5 rounded-lg px-2.5 text-left focus-visible:outline-none sm:justify-start focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--color-accent)]/65 {activeTab ===
                      entry.id
                        ? 'settings-tab-active'
                        : ''}"
                      aria-current={activeTab === entry.id ? 'page' : undefined}
                      title={entry.description}
                      data-tooltip-placement="right"
                      onclick={() => selectSettingsTab(entry.id)}
                    >
                      <span
                        class="settings-tab-icon flex h-5 w-5 shrink-0 items-center justify-center"
                        aria-hidden="true"><Icon size={15} /></span
                      >
                      <span class="hidden min-w-0 flex-1 truncate text-[13px] sm:block"
                        >{entry.label}</span
                      >
                      <span class="sr-only">{entry.scope}</span>
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
              <p class="mt-1 text-[11px] leading-relaxed text-[var(--color-text-muted)]">
                Try a feature, outcome, or scope.
              </p>
              <button
                type="button"
                class="mt-3 min-h-9 rounded-lg px-3 text-[11px] font-medium text-[var(--color-accent)] hover:bg-[var(--color-surface-2)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)]/60"
                onclick={() => (settingsSearch = '')}>Clear search</button
              >
            </div>
          {/if}
        </nav>
      </aside>

      <!-- Content Area. Every tab panel below is a `flex-1` scroll child of this
           column, so each one MUST carry `min-h-0`: a flex item's automatic
           minimum size is its content height, so without it the panel refuses to
           shrink, grows past the clipped parent, and its own scrollbar never
           engages (scrolling the page appears to do nothing). `overflow-x-hidden`
           keeps a stray horizontal scrollbar from appearing at all. -->
      <div class="settings-content flex min-w-0 flex-1 flex-col overflow-hidden">
        <!-- Providers Tab -->
        <div
          class={activeTab === 'providers'
            ? 'flex-1 min-h-0 overflow-y-auto overflow-x-hidden'
            : 'hidden'}
        >
          <SettingsPage
            width="wide"
            title="Providers & models"
            description={settingsEntryDescription('providers')}
          >
            {#snippet actions()}
              <button
                type="button"
                class="inline-flex shrink-0 items-center gap-1.5 rounded-md border border-[var(--color-border)] px-2.5 py-1.5 text-xs text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-3)] hover:text-[var(--color-text-primary)]"
                title="Refresh providers and detected CLIs"
                aria-label="Refresh providers and detected CLIs"
                onclick={refreshProviderSection}
              >
                <RefreshCw size={12} />
                Refresh
              </button>
            {/snippet}
            <div class="space-y-4">
              <div class="relative">
                <Search
                  size={14}
                  class="absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none"
                  style="color: var(--color-text-muted);"
                />
                <input
                  type="text"
                  aria-label="Search providers"
                  placeholder="Search providers…"
                  bind:value={providerSearchQuery}
                  class="input w-full py-2 text-sm"
                  style="padding-left: 2.75rem;"
                />
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

              <!-- Detected on your system — presence is not an authentication verdict. -->
              {#if showDetectedCliSummary}
                <div class="border-y border-[var(--color-border)] py-3">
                  <div class="flex items-center justify-between mb-3">
                    <span class="text-sm font-semibold text-[var(--color-text-primary)]"
                      >Detected on your system</span
                    >
                    <div class="flex items-center gap-2">
                      <span class="text-[11px] text-[var(--color-text-muted)]"
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
                      {@const cliProviderStatus = cli.provider
                        ? getProviderStatus(cli.provider)
                        : undefined}
                      <div class="flex items-start gap-3">
                        <span
                          class="mt-1.5 h-2 w-2 rounded-full flex-shrink-0"
                          style="background: {cliProviderStatus?.connectionState === 'verified'
                            ? 'var(--color-success)'
                            : (cli.loginDetected ?? cli.loggedIn)
                              ? 'var(--color-warning)'
                              : 'var(--color-text-muted)'};"
                        ></span>
                        <div class="min-w-0 flex-1">
                          <div class="flex items-center gap-2 flex-wrap">
                            <span class="text-sm font-medium text-[var(--color-text-primary)]"
                              >{cli.displayName}</span
                            >
                            {#if cliProviderStatus?.connectionState === 'verified'}
                              <span
                                class="text-[11px] px-1.5 py-0.5 rounded-full font-medium"
                                style="background: var(--color-success-bg); color: var(--color-success);"
                                >Connected · CLI verified</span
                              >
                            {:else if cli.autoEnabled}
                              <span
                                class="text-[11px] px-1.5 py-0.5 rounded-full font-medium"
                                style="background: var(--color-warning-bg); color: var(--color-warning);"
                                >Login detected · connection pending</span
                              >
                            {:else if cli.loginDetected ?? cli.loggedIn}
                              <span
                                class="text-[11px] px-1.5 py-0.5 rounded-full font-medium"
                                style="background: var(--color-warning-bg); color: var(--color-warning);"
                                >Login material detected · check below</span
                              >
                            {:else}
                              <span class="text-[11px] text-[var(--color-text-muted)]"
                                >Installed · no login material detected</span
                              >
                            {/if}
                            {#if cli.nativeResearch}
                              <span
                                class="text-[11px] px-1.5 py-0.5 rounded-full font-medium"
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
                          <p
                            class="text-[11px] text-[var(--color-text-muted)] leading-relaxed mt-0.5"
                          >
                            {cli.note}
                            {#if cli.nativeResearch}
                              <span class="block mt-0.5"
                                >Research: {cli.nativeResearch.reason}.</span
                              >
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
                  class="group flex w-full flex-wrap items-center gap-x-3 gap-y-1 rounded-md px-2 py-2 text-left transition-colors hover:bg-[var(--color-surface-2)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)]/50"
                >
                  <div class="flex items-center gap-2">
                    <Plus size={16} class="shrink-0" style="color: var(--color-accent);" />
                    <span
                      class="text-sm font-semibold text-[var(--color-text-primary)] transition-colors duration-150 group-hover:text-[var(--color-accent)]"
                      >Add a custom provider</span
                    >
                  </div>
                  <span
                    class="text-[11px] text-[var(--color-text-muted)] transition-colors duration-150 group-hover:text-[var(--color-text-secondary)]"
                    >OpenAI compatible &amp; more</span
                  >
                </button>
              {:else}
                <section class="border-y border-[var(--color-border)] py-4">
                  <button
                    type="button"
                    onclick={() => {
                      resetCustomProviderForm();
                      showAddCustom = false;
                    }}
                    class="group flex w-full items-center justify-between text-left"
                  >
                    <div class="flex items-center gap-2">
                      <Plus size={16} class="shrink-0" style="color: var(--color-accent);" />
                      <span class="text-sm font-semibold text-[var(--color-text-primary)]"
                        >Add a custom provider</span
                      >
                    </div>
                    <span class="text-[11px] text-[var(--color-text-muted)]">Close</span>
                  </button>
                  <div class="mt-4 space-y-3 border-t border-[var(--color-border)] pt-4">
                    <p class="text-[11px] text-[var(--color-text-muted)] leading-relaxed">
                      Connect an OpenAI-, Anthropic-, or Gemini-compatible endpoint. Koryphaios
                      detects the format and checks <code>/models</code> before saving. Catalog access
                      does not verify inference, entitlement, or quota; those are checked on first use.
                      If discovery is unsupported, you can save with manual model IDs.
                    </p>
                    <div class="space-y-1">
                      <label class="settings-field-label" for="custom-label">Display name</label>
                      <input
                        id="custom-label"
                        type="text"
                        placeholder="My LLM"
                        bind:value={customForm.label}
                        class="input w-full text-xs"
                      />
                    </div>
                    <div class="space-y-1">
                      <label class="settings-field-label" for="custom-url">Base URL</label>
                      <input
                        id="custom-url"
                        type="text"
                        placeholder="https://api.example.com/v1"
                        bind:value={customForm.baseUrl}
                        class="input w-full text-xs"
                      />
                    </div>
                    <div class="space-y-1">
                      <label class="settings-field-label" for="custom-key"
                        >API key <span class="opacity-60 normal-case"
                          >(optional. Leave blank if not required)</span
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
                          aria-label={visibleSecrets['custom-key']
                            ? 'Hide API key'
                            : 'Show API key'}
                          title={visibleSecrets['custom-key'] ? 'Hide API key' : 'Show API key'}
                        >
                          {#if visibleSecrets['custom-key']}<EyeOff size={15} />{:else}<Eye
                              size={15}
                            />{/if}
                        </button>
                      </div>
                    </div>
                    <div class="space-y-1">
                      <label class="settings-field-label" for="custom-models"
                        >Models <span class="opacity-60 normal-case"
                          >(optional, comma-separated)</span
                        ></label
                      >
                      <input
                        id="custom-models"
                        type="text"
                        placeholder="my model a, my model b. Or leave blank to fetch automatically"
                        bind:value={customForm.models}
                        class="input w-full text-xs"
                      />
                    </div>
                    <div
                      class="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-2)]"
                    >
                      <button
                        type="button"
                        onclick={() => (showCustomAdvanced = !showCustomAdvanced)}
                        aria-expanded={showCustomAdvanced}
                        aria-controls="custom-advanced-section"
                        class="flex w-full items-center justify-between px-3 py-2.5 text-left transition-colors hover:bg-[var(--color-surface-3)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)]/50 rounded-xl"
                      >
                        <span
                          class="flex items-center gap-2 text-xs font-medium text-[var(--color-text-primary)]"
                        >
                          <Terminal size={14} /> Advanced
                        </span>
                        <ChevronDown
                          size={15}
                          class="text-[var(--color-text-muted)] transition-transform duration-200 ease-out"
                          style={showCustomAdvanced
                            ? 'transform: rotate(180deg);'
                            : 'transform: rotate(0deg);'}
                        />
                      </button>
                      <div
                        id="custom-advanced-section"
                        class="grid transition-[grid-template-rows] duration-200 ease-out"
                        style={showCustomAdvanced
                          ? 'grid-template-rows: 1fr;'
                          : 'grid-template-rows: 0fr;'}
                      >
                        <div class="overflow-hidden" inert={!showCustomAdvanced}>
                          <div class="space-y-1 px-3 pb-3">
                            <KorySelect
                              value={customForm.adapter}
                              label="Wire adapter"
                              description="Overrides auto-detection for endpoints outside the standard OpenAI/Anthropic/Gemini formats."
                              options={[
                                {
                                  value: '',
                                  label: 'Auto-detect (recommended)',
                                  description: 'Probe the endpoint and pick the best match',
                                },
                                {
                                  value: 'ollama',
                                  label: 'Ollama (native)',
                                  description: '/api/chat protocol with native tool calls',
                                },
                                {
                                  value: 'cohere',
                                  label: 'Cohere (v2 native)',
                                  description: '/v2/chat protocol with SSE events',
                                },
                              ]}
                              onchange={(value) => (customForm.adapter = value)}
                            />
                            <label class="settings-field-label" for="custom-headers"
                              >Custom headers <span class="opacity-60 normal-case">(optional)</span
                              ></label
                            >
                            <textarea
                              id="custom-headers"
                              rows="3"
                              placeholder="x-openclaw-model: my-model"
                              bind:value={customForm.headers}
                              class="input w-full text-xs"
                            ></textarea>
                            <p class="text-[11px] text-[var(--color-text-muted)] leading-relaxed">
                              One per line, Name: Value. Sent with every request to this endpoint.
                            </p>
                          </div>
                        </div>
                      </div>
                    </div>
                    {#if showNewCustomIconEditor}
                      <CustomProviderIconEditor
                        id="new-custom-provider-icon"
                        onchange={(selection) => (newCustomIconSelection = selection)}
                        onerror={(message) => (customAddError = message)}
                      />
                    {:else}
                      <button
                        type="button"
                        onclick={() => (showNewCustomIconEditor = true)}
                        class="flex w-full items-center justify-between rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-2)] px-3 py-2.5 text-left transition-colors hover:border-[var(--color-accent)]/50 hover:bg-[var(--color-surface-3)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)]/50"
                      >
                        <span
                          class="flex items-center gap-2 text-xs font-medium text-[var(--color-text-primary)]"
                        >
                          <ImageIcon size={14} /> Add a custom icon
                        </span>
                        <span class="text-[11px] text-[var(--color-text-muted)]">Optional</span>
                      </button>
                    {/if}

                    {#if customAddError}
                      <div
                        role="alert"
                        class="flex items-start gap-2 rounded-xl border border-[var(--color-error)]/40 bg-[var(--color-error-bg)] px-3 py-2.5 text-xs leading-relaxed text-[var(--color-error)]"
                      >
                        <AlertTriangle size={14} class="mt-0.5 shrink-0" />
                        <div class="space-y-1">
                          <p>{customAddError}</p>
                          {#if customRequiresManualModels}
                            <p class="text-[11px] opacity-85">
                              Add at least one model ID above to enable the explicit unverified
                              path.
                            </p>
                          {/if}
                        </div>
                      </div>
                    {/if}

                    <div class="space-y-2">
                      <button
                        type="button"
                        onclick={() => addCustomProvider(false)}
                        disabled={providersStore.addingCustom}
                        class="btn btn-primary w-full text-xs py-2"
                        >{providersStore.addingCustom
                          ? 'Checking endpoint…'
                          : 'Check catalog & add provider'}</button
                      >
                      {#if customCanSaveUnverified && customForm.models.trim()}
                        <button
                          type="button"
                          onclick={() => addCustomProvider(true)}
                          disabled={providersStore.addingCustom}
                          class="btn btn-secondary w-full text-xs py-2"
                          >Save unverified with manual models</button
                        >
                        <p
                          class="text-center text-[11px] leading-relaxed text-[var(--color-text-muted)]"
                        >
                          Authentication failures cannot be bypassed. This option is only for
                          endpoints that do not expose a model catalog.
                        </p>
                      {/if}
                    </div>
                  </div>
                </section>
              {/if}

              {#if providerSearchQuery.trim()}
                <div class="text-xs text-[var(--color-text-muted)]">
                  {filteredProviderList.length} provider{filteredProviderList.length === 1
                    ? ''
                    : 's'} matching "{providerSearchQuery.trim()}"
                </div>
              {/if}

              {#if filteredProviderList.length === 0}
                {#if providersLoading}
                  <!-- Placeholders hold the pane's shape while the catalog loads so
                   the list does not appear as a sudden content jump. -->
                  <div
                    class="divide-y divide-[var(--color-border)] border-y border-[var(--color-border)]"
                    aria-hidden="true"
                  >
                    {#each PROVIDER_SKELETON_ROWS as index (index)}
                      <div class="flex min-h-12 items-center gap-3 px-2 py-2">
                        <div
                          class="h-5 w-5 shrink-0 animate-pulse rounded-md bg-[var(--color-surface-3)]"
                        ></div>
                        <div class="min-w-0 flex-1">
                          <div
                            class="h-3 animate-pulse rounded bg-[var(--color-surface-3)]"
                            style="width: {140 + ((index * 37) % 90)}px;"
                          ></div>
                          <div
                            class="mt-2 h-2 animate-pulse rounded bg-[var(--color-surface-3)] opacity-70"
                            style="width: {200 + ((index * 53) % 120)}px;"
                          ></div>
                        </div>
                        <div
                          class="h-6 w-16 shrink-0 animate-pulse rounded-full bg-[var(--color-surface-3)]"
                        ></div>
                      </div>
                    {/each}
                  </div>
                  <p class="pt-3 text-xs text-[var(--color-text-muted)]">Loading providers…</p>
                {:else}
                  <div
                    class="rounded-xl border border-[var(--color-border)] p-8 text-center bg-[var(--color-surface-1)]"
                  >
                    <Search
                      size={24}
                      class="mx-auto mb-3 opacity-40"
                      style="color: var(--color-text-muted);"
                    />
                    <p class="text-sm text-[var(--color-text-secondary)] mb-1">
                      No providers found
                    </p>
                    <p class="text-xs text-[var(--color-text-muted)]">
                      {#if providerSearchQuery.trim()}
                        Try a different search term or clear the filter.
                      {:else}
                        No providers in the "{PROVIDER_CATEGORIES.find(
                          (c) => c.id === providerCategory,
                        )?.label ?? providerCategory}" category. Try switching to "All" or add a
                        custom provider.
                      {/if}
                    </p>
                  </div>
                {/if}
              {:else}
                <div
                  class="divide-y divide-[var(--color-border)] border-y border-[var(--color-border)]"
                >
                  {#each filteredProviderList as prov (prov.key)}
                    {@const status = getProviderStatus(prov.key)}
                    {@const caps = getProviderCaps(prov.key)}
                    {@const installedCli = installedCliFor(prov.key)}
                    {@const deployment = deploymentDescription(status?.deployment, prov.key)}
                    {@const badge = deploymentLabel(status?.deployment, prov.key)}
                    <div class="flex flex-col">
                      <div class="provider-row-header">
                        <button
                          type="button"
                          onclick={() =>
                            (expandedProvider = expandedProvider === prov.key ? null : prov.key)}
                          oncontextmenu={prov.key.startsWith('custom:')
                            ? (event) =>
                                openProviderIconContextMenu(
                                  event,
                                  prov.key,
                                  status?.label ?? prov.label,
                                  event.currentTarget as HTMLElement,
                                )
                            : undefined}
                          onkeydown={prov.key.startsWith('custom:')
                            ? (event) =>
                                openProviderIconContextMenuFromKeyboard(
                                  event,
                                  prov.key,
                                  status?.label ?? prov.label,
                                )
                            : undefined}
                          class="provider-row-toggle group flex min-h-12 min-w-0 flex-1 items-center justify-between gap-3 rounded-md px-2 py-2 text-left transition-colors hover:bg-[var(--color-surface-2)]"
                          aria-expanded={expandedProvider === prov.key}
                          aria-controls={`provider-details-${prov.key}`}
                        >
                          <div class="flex min-w-0 items-center gap-3">
                            <div
                              class="flex h-5 w-5 shrink-0 items-center justify-center overflow-hidden"
                            >
                              <ProviderIcon
                                provider={prov.key}
                                size={20}
                                class="w-full h-full"
                                oncontextmenu={prov.key.startsWith('custom:')
                                  ? (event) =>
                                      openProviderIconContextMenu(
                                        event,
                                        prov.key,
                                        status?.label ?? prov.label,
                                        event.currentTarget as HTMLElement,
                                      )
                                  : undefined}
                              />
                            </div>
                            <div class="min-w-0">
                              <div class="flex min-w-0 items-center gap-2">
                                <span
                                  class="block truncate text-sm font-semibold text-[var(--color-text-primary)]"
                                  title={status?.label ?? prov.label}
                                  >{status?.label ?? prov.label}</span
                                >
                                {#if isCliExecutionProvider(prov.key) && badge}
                                  <span
                                    class="inline-flex shrink-0 items-center gap-1 rounded-full bg-[var(--color-success-bg)] px-1.5 py-px text-[11px] font-medium text-[var(--color-success)]"
                                    >{badge}</span
                                  >
                                {/if}
                              </div>
                              <p
                                class="line-clamp-2 text-xs leading-5 text-[var(--color-text-muted)] group-hover:text-[var(--color-text-secondary)]"
                              >
                                {#if status?.configurationBlocked}
                                  Unavailable in this build
                                {:else if status?.connectionState === 'verified'}
                                  {@const selectedCount = status.models?.length ?? 0}
                                  {@const availableCount = status.allAvailableModels?.length ?? 0}
                                  Connected{availableCount > 0 && selectedCount > 0
                                    ? ` · ${selectedCount}/${availableCount} models enabled`
                                    : ''}{status.autoDetectedSource
                                    ? ` · auto-detected (${status.autoDetectedSource})`
                                    : ''}
                                {:else if status?.connectionState === 'failed'}
                                  Connection failed
                                {:else if status?.connectionState === 'detected' && status?.verificationScope === 'catalog' && prov.key.startsWith('custom:')}
                                  {@const selectedCount = status.models?.length ?? 0}
                                  {@const availableCount = status.allAvailableModels?.length ?? 0}
                                  Connected{availableCount > 0 && selectedCount > 0
                                    ? ` · ${selectedCount}/${availableCount} models enabled`
                                    : ''}
                                {:else if status?.connectionState === 'detected' && status?.verificationScope === 'catalog'}
                                  Catalog access detected · inference unverified
                                {:else if installedCli}
                                  Found on system · not connected
                                {:else if status?.credentialDetected ?? status?.authenticated}
                                  Configuration saved · not connected
                                {:else if deployment}
                                  {deployment}
                                {:else}
                                  Not configured
                                {/if}
                              </p>
                              {#if capabilityKinds(prov.key).length > 0}
                                <div class="mt-1 flex flex-wrap items-center gap-1">
                                  {#each capabilityKinds(prov.key) as kind (kind)}
                                    <span
                                      class="rounded-full bg-[var(--color-surface-3)] px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-[var(--color-text-muted)]"
                                    >
                                      {CAPABILITY_SURFACE_LABELS[kind] ?? kind}
                                    </span>
                                  {/each}
                                  <span
                                    class="text-[11px] text-[var(--color-text-muted)]"
                                    title="This provider has no chat-completions endpoint. Its key powers the surfaces above, and it is deliberately absent from the chat model list."
                                  >
                                    · no chat models
                                  </span>
                                </div>
                              {/if}
                            </div>
                          </div>
                          <div class="flex shrink-0 items-center gap-2">
                            {#if status?.connectionState === 'verified'}
                              <div
                                class="flex items-center gap-1.5 px-2 py-0.5 rounded-full bg-[var(--color-success-bg)] text-[var(--color-success)] text-xs font-medium"
                                title="Connected"
                              >
                                <span class="w-1 h-1 rounded-full bg-[var(--color-success)]"></span>
                                Connected
                              </div>
                            {:else if status?.connectionState === 'failed'}
                              <div
                                class="flex items-center gap-1.5 px-2 py-0.5 rounded-full bg-[var(--color-error-bg)] text-[var(--color-error)] text-xs font-medium"
                                title={status.verificationError ??
                                  'The last connection attempt failed'}
                              >
                                <span class="w-1 h-1 rounded-full bg-[var(--color-error)]"></span>
                                Failed
                              </div>
                            {:else if status?.connectionState === 'detected' && status?.verificationScope === 'catalog' && prov.key.startsWith('custom:')}
                              <div
                                class="flex items-center gap-1.5 px-2 py-0.5 rounded-full bg-[var(--color-success-bg)] text-[var(--color-success)] text-xs font-medium"
                                title="Endpoint added and model catalog confirmed. Inference verifies on first use"
                              >
                                <span class="w-1 h-1 rounded-full bg-[var(--color-success)]"></span>
                                Connected
                              </div>
                            {:else if status?.connectionState === 'detected' && status?.verificationScope === 'catalog'}
                              <div
                                class="flex items-center gap-1.5 px-2 py-0.5 rounded-full bg-[var(--color-info-bg)] text-[var(--color-info)] text-xs font-medium"
                                title="Model catalog access succeeded. Inference is checked on first use"
                              >
                                <span class="w-1 h-1 rounded-full bg-[var(--color-info)]"></span>
                                Catalog
                              </div>
                            {:else if installedCli}
                              <div
                                class="flex items-center gap-1.5 px-2 py-0.5 rounded-full bg-[var(--color-warning-bg)] text-[var(--color-warning)] text-xs font-medium"
                                title="CLI found on this system but not connected"
                              >
                                <span class="w-1 h-1 rounded-full bg-[var(--color-warning)]"></span>
                                Detected
                              </div>
                            {:else if status?.credentialDetected ?? status?.authenticated}
                              <div
                                class="flex items-center gap-1.5 px-2 py-0.5 rounded-full bg-[var(--color-surface-3)] text-[var(--color-text-secondary)] text-xs font-medium"
                                title="Configuration is saved but has not been verified"
                              >
                                <span class="w-1 h-1 rounded-full bg-[var(--color-text-muted)]"
                                ></span>
                                Configured
                              </div>
                            {:else}
                              <div
                                class="w-2 h-2 rounded-full bg-[var(--color-text-muted)] opacity-50"
                              ></div>
                            {/if}
                            <ChevronDown
                              size={15}
                              class="text-[var(--color-text-muted)] transition-transform {expandedProvider ===
                              prov.key
                                ? 'rotate-180'
                                : ''}"
                            />
                          </div>
                        </button>
                        {#if prov.key.startsWith('custom:')}
                          <button
                            type="button"
                            class="provider-row-refresh inline-flex shrink-0 items-center justify-center rounded-md px-2 py-1.5 text-xs text-[var(--color-text-muted)] transition-colors hover:bg-[var(--color-surface-3)] hover:text-[var(--color-text-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)]/70"
                            aria-label={`Provider logo actions for ${status?.label ?? prov.label}`}
                            aria-haspopup="menu"
                            aria-expanded={providerIconContextMenu?.providerKey === prov.key}
                            aria-controls={providerIconContextMenu?.providerKey === prov.key
                              ? providerIconContextMenu.id
                              : undefined}
                            title="Provider logo actions"
                            onclick={(event) => {
                              event.stopPropagation();
                              const trigger = event.currentTarget as HTMLElement;
                              const rect = trigger.getBoundingClientRect();
                              providerIconContextMenu = {
                                id: providerIconMenuId(prov.key),
                                providerKey: prov.key,
                                providerLabel: status?.label ?? prov.label,
                                hasCustomIcon: Boolean(
                                  providersStore.getCustomProviderIcon(prov.key),
                                ),
                                x: rect.left,
                                y: rect.bottom + 4,
                                returnFocus: trigger,
                              };
                            }}
                            oncontextmenu={(event) =>
                              openProviderIconContextMenu(
                                event,
                                prov.key,
                                status?.label ?? prov.label,
                                event.currentTarget as HTMLElement,
                              )}
                            onkeydown={(event) =>
                              openProviderIconContextMenuFromKeyboard(
                                event,
                                prov.key,
                                status?.label ?? prov.label,
                              )}
                          >
                            <ImagePlus size={13} />
                          </button>
                        {/if}
                        <!-- Sits outside the row's toggle button: a button nested in a
                       button is invalid HTML and unreachable by keyboard. -->
                        <button
                          type="button"
                          class="provider-row-refresh inline-flex shrink-0 items-center gap-1 rounded-md px-2 py-1.5 text-xs text-[var(--color-text-muted)] transition-colors hover:bg-[var(--color-surface-3)] hover:text-[var(--color-text-primary)] disabled:opacity-50"
                          disabled={providersStore.refreshingProviders[prov.key] === true}
                          aria-busy={providersStore.refreshingProviders[prov.key] === true}
                          onclick={() => providersStore.refreshProvider(prov.key)}
                          title="Re-check this provider and reload its model list"
                          aria-label="Re-check {status?.label ??
                            prov.label} and reload its model list"
                        >
                          <RefreshCw
                            size={12}
                            class={providersStore.refreshingProviders[prov.key] === true
                              ? 'animate-spin'
                              : ''}
                          />
                          <span
                            class="provider-action-label"
                            class:busy={providersStore.refreshingProviders[prov.key] === true}
                          >
                            <span class="provider-action-idle">Refresh</span>
                            <span
                              class="provider-action-busy"
                              aria-hidden={providersStore.refreshingProviders[prov.key] !== true}
                              >Checking…</span
                            >
                          </span>
                        </button>
                      </div>
                      {#if expandedProvider === prov.key}
                        {@const caps = getProviderCaps(prov.key)}
                        {@const configurationBlocked = status?.configurationBlocked === true}
                        {@const isCustomProvider = prov.key.startsWith('custom:')}
                        {@const currentCustomIcon = isCustomProvider
                          ? providersStore.getCustomProviderIcon(prov.key)
                          : undefined}
                        <div
                          id={`provider-details-${prov.key}`}
                          class="provider-details space-y-2 px-2 pb-4 pt-2 sm:pl-13"
                        >
                          {#if badge && !isCliExecutionProvider(prov.key)}
                            <div class="flex flex-wrap items-center gap-x-2 gap-y-1">
                              <span
                                class={`inline-flex items-center gap-1 px-1.5 py-px rounded-full text-[11px] font-medium ${
                                  status?.deployment === 'cloud'
                                    ? 'bg-[var(--color-info-bg)] text-[var(--color-info)]'
                                    : status?.deployment === 'hybrid'
                                      ? 'bg-[var(--color-warning-bg)] text-[var(--color-warning)]'
                                      : status?.deployment === 'local'
                                        ? 'bg-[var(--color-success-bg)] text-[var(--color-success)]'
                                        : 'bg-[var(--color-surface-3)] text-[var(--color-text-secondary)]'
                                }`}
                              >
                                {badge}
                              </span>
                            </div>
                          {/if}
                          <ProviderExecutionModes capabilities={status?.execution} />
                          {#if contextWindowOptionsFor(status).length >= 2}
                            <div class="px-1 pt-1">
                              <KorySelect
                                value={contextWindowValueFor(status)}
                                label="Context window"
                                description="Real context tiers reported by this provider's models. Maximum is the default; a smaller tier reduces the session budget."
                                options={contextWindowSelectOptions(status)}
                                onchange={(value) => handleContextWindowChange(prov.key, value)}
                              />
                            </div>
                          {/if}
                          {#if status?.credentialDetected ?? status?.authenticated}
                            <!-- The action buttons lead the block, on one horizontal
                             row: "Run safe check" sits beside "Manage Models". The
                             grey text below explains the state they act on, so it
                             must never render above the controls. -->
                            <div class="provider-actions">
                              {#if usesLocalCliConnection(prov.key)}
                                <button
                                  type="button"
                                  onclick={() => handleConnectProvider(prov.key)}
                                  disabled={providersStore.saving === prov.key}
                                  aria-busy={providersStore.saving === prov.key}
                                  class="btn btn-secondary"
                                  ><span
                                    class="provider-action-label"
                                    class:busy={providersStore.saving === prov.key}
                                  >
                                    <span class="provider-action-idle"
                                      >{getLocalCliConnectLabel(prov.key)}</span
                                    >
                                    <span
                                      class="provider-action-busy"
                                      aria-hidden={providersStore.saving !== prov.key}
                                      >Checking…</span
                                    >
                                  </span></button
                                >
                              {:else if status.connectionState !== 'verified'}
                                <button
                                  type="button"
                                  onclick={() => handleConnectProvider(prov.key)}
                                  disabled={providersStore.saving === prov.key}
                                  aria-busy={providersStore.saving === prov.key}
                                  class="btn btn-secondary"
                                  ><span
                                    class="provider-action-label"
                                    class:busy={providersStore.saving === prov.key}
                                  >
                                    <span class="provider-action-idle">Run safe check</span>
                                    <span
                                      class="provider-action-busy"
                                      aria-hidden={providersStore.saving !== prov.key}
                                      >Checking…</span
                                    >
                                  </span></button
                                >
                              {/if}
                              {#if (status.connectionState === 'verified' || (status.connectionState === 'detected' && status.verificationScope === 'catalog' && (status.allAvailableModels?.length ?? 0) > 0)) && !status.hideModelSelector}
                                <button
                                  type="button"
                                  onclick={() => openModelSelector(status)}
                                  class="btn btn-secondary">Manage Models</button
                                >
                              {/if}
                              {#if isCustomProvider}
                                <button
                                  type="button"
                                  onclick={() =>
                                    openCustomIconEditor(prov.key, status?.label ?? prov.label)}
                                  class="btn btn-secondary provider-icon-button"
                                  title={currentCustomIcon
                                    ? 'Edit provider icon'
                                    : 'Add provider icon'}
                                  aria-label={currentCustomIcon
                                    ? 'Edit provider icon'
                                    : 'Add provider icon'}
                                >
                                  <ImagePlus size={14} />
                                </button>
                              {/if}
                              {#if caps.supportsApiKey && !usesBrowserAuth(prov.key)}
                                <button
                                  type="button"
                                  onclick={() => {
                                    rotateProvider = { name: prov.key, keyType: 'apiKey' };
                                    showRotateDialog = true;
                                  }}
                                  class="inline-flex items-center gap-1 text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)] font-medium transition-colors"
                                  title="Replace the stored API key without disconnecting"
                                >
                                  <RotateCcw size={10} /> Rotate key
                                </button>
                              {/if}
                              <button
                                type="button"
                                onclick={() => disconnectProvider(prov.key)}
                                class="text-[var(--color-error)] hover:opacity-80 font-medium transition-opacity"
                                >Disconnect</button
                              >
                            </div>
                            {#if status?.connectionState === 'failed'}
                              <div class="text-xs leading-relaxed text-[var(--color-text-muted)]">
                                Connection failed{status.verificationError
                                  ? `: ${status.verificationError}`
                                  : '.'}
                              </div>
                            {:else if status?.error}
                              <div
                                class="mt-2 flex items-start gap-2 rounded-lg border border-[var(--color-error)] bg-[var(--color-error-bg)] px-3 py-2 text-xs leading-relaxed text-[var(--color-error)]"
                              >
                                <AlertTriangle size={14} class="mt-0.5 shrink-0" />
                                <span>
                                  {status.error}
                                  {#if status.modelCatalogUrl}
                                    <span class="mt-1 block text-[11px] opacity-80"
                                      >Model catalog: {status.modelCatalogUrl}</span
                                    >
                                  {/if}
                                </span>
                              </div>
                            {:else if status?.connectionState === 'detected' && status?.verificationScope === 'catalog'}
                              <div class="text-xs leading-relaxed text-[var(--color-text-muted)]">
                                Catalog verified · inference checks on first use.
                              </div>
                            {:else if status?.connectionState !== 'verified'}
                              <div class="text-xs leading-relaxed text-[var(--color-text-muted)]">
                                Not connected.
                              </div>
                            {/if}
                            {#if prov.key === 'freebuff'}
                              {#each freebuffAccountRows as row (`freebuff-hours:${row.accountId}`)}
                                <FreebuffBalance account={row.snapshot} variant="compact" />
                              {/each}
                            {/if}
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
                                <p
                                  class="text-[11px] leading-relaxed text-[var(--color-text-muted)]"
                                >
                                  Credential present · unverified. It is preserved but cannot
                                  activate this unavailable adapter.
                                </p>
                                <button
                                  type="button"
                                  onclick={() => disconnectProvider(prov.key)}
                                  class="shrink-0 text-[11px] font-medium text-[var(--color-error)] transition-opacity hover:opacity-80"
                                  >Remove saved credentials</button
                                >
                              </div>
                            {/if}
                          {:else}
                            <div class="space-y-2">
                              {#if bedrocksInputsVisible(prov.key)}
                                {@const awsScan = providersStore.awsCredentialScans[prov.key]}
                                {#if awsScan?.detected && !awsBannerDismissed(prov.key)}
                                  <div
                                    class="rounded-lg border border-[var(--color-info)]/30 bg-[var(--color-info-bg)]/40 px-3 py-2.5"
                                  >
                                    <div
                                      class="flex items-center gap-1.5 text-[11px] font-semibold text-[var(--color-info)]"
                                    >
                                      <Key size={12} />
                                      AWS credentials detected on the system
                                    </div>
                                    <p
                                      class="mt-1 text-[11px] leading-relaxed text-[var(--color-text-secondary)]"
                                    >
                                      Found via {awsScan.description}. Connect to use the machine's
                                      AWS login for Bedrock, or enter credentials below to override
                                      it.
                                    </p>
                                    <div class="mt-2 flex items-center gap-2">
                                      <button
                                        type="button"
                                        onclick={() => connectUsingSystemCredentials(prov.key)}
                                        disabled={providersStore.saving === prov.key}
                                        class="btn btn-primary flex-1 text-[11px] py-1.5"
                                        >{providersStore.saving === prov.key
                                          ? 'Checking…'
                                          : 'Connect'}</button
                                      >
                                      <button
                                        type="button"
                                        onclick={() => ignoreSystemCredentials(prov.key)}
                                        disabled={providersStore.saving === prov.key}
                                        class="btn btn-secondary flex-1 text-[11px] py-1.5"
                                        >Ignore</button
                                      >
                                    </div>
                                  </div>
                                {/if}
                              {/if}
                              {#if caps.supportsApiKey}
                                <div class="relative">
                                  <label class="sr-only" for={`provider-key-${prov.key}`}
                                    >{isBedrock(prov.key)
                                      ? 'AWS Access Key ID'
                                      : isNotion(prov.key)
                                        ? 'Personal Access Token'
                                        : 'API Key'}</label
                                  >
                                  <input
                                    id={`provider-key-${prov.key}`}
                                    type={secretInputType(`provider-key-${prov.key}`)}
                                    placeholder={providerCredentialPlaceholder(
                                      prov.key,
                                      prov.label,
                                      'apiKey',
                                    )}
                                    bind:value={providersStore.keyInputs[prov.key]}
                                    class="input w-full text-xs"
                                    style="padding-right: 2.75rem;"
                                    onkeydown={(e) =>
                                      e.key === 'Enter' && handleConnectProvider(prov.key)}
                                  />
                                  <button
                                    type="button"
                                    class="secret-visibility absolute inset-y-0 right-1 my-auto z-10"
                                    onclick={() =>
                                      toggleSecretVisibility(`provider-key-${prov.key}`)}
                                    aria-label={visibleSecrets[`provider-key-${prov.key}`]
                                      ? isNotion(prov.key)
                                        ? 'Hide token'
                                        : 'Hide API key'
                                      : isNotion(prov.key)
                                        ? 'Show token'
                                        : 'Show API key'}
                                    title={visibleSecrets[`provider-key-${prov.key}`]
                                      ? isNotion(prov.key)
                                        ? 'Hide token'
                                        : 'Hide API key'
                                      : isNotion(prov.key)
                                        ? 'Show token'
                                        : 'Show API key'}
                                  >
                                    {#if visibleSecrets[`provider-key-${prov.key}`]}<EyeOff
                                        size={15}
                                      />{:else}<Eye size={15} />{/if}
                                  </button>
                                </div>
                                {#if status?.credentialUrl}
                                  <div class="text-right">
                                    <a
                                      href={status.credentialUrl}
                                      target="_blank"
                                      rel="noreferrer"
                                      class="text-[11px] text-[var(--color-accent)] hover:underline"
                                      >{isNotion(prov.key) ? 'Get PAT' : 'Get API key'}</a
                                    >
                                  </div>
                                {/if}
                              {/if}
                              {#if showTokenInput(prov.key, caps)}
                                <div class="relative">
                                  <label class="sr-only" for={`provider-token-${prov.key}`}
                                    >{isBedrock(prov.key)
                                      ? 'Secret Access Key'
                                      : 'Auth Token'}</label
                                  >
                                  <input
                                    id={`provider-token-${prov.key}`}
                                    type={secretInputType(`provider-token-${prov.key}`)}
                                    placeholder={providerCredentialPlaceholder(
                                      prov.key,
                                      prov.label,
                                      'authToken',
                                    )}
                                    bind:value={providersStore.tokenInputs[prov.key]}
                                    class="input w-full pr-11 text-xs"
                                    onkeydown={(e) =>
                                      e.key === 'Enter' && handleConnectProvider(prov.key)}
                                  />
                                  <button
                                    type="button"
                                    class="secret-visibility absolute inset-y-0 right-1 my-auto z-10"
                                    onclick={() =>
                                      toggleSecretVisibility(`provider-token-${prov.key}`)}
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
                              {#if isBedrock(prov.key)}
                                <label
                                  class="settings-field-label"
                                  for={`provider-aws-region-${prov.key}`}>AWS Region</label
                                >
                                <input
                                  id={`provider-aws-region-${prov.key}`}
                                  type="text"
                                  placeholder="e.g. us-east-1 (default)"
                                  bind:value={providersStore.awsRegionInputs[prov.key]}
                                  class="input w-full text-xs"
                                  onkeydown={(e) =>
                                    e.key === 'Enter' && handleConnectProvider(prov.key)}
                                />
                                <label
                                  class="settings-field-label"
                                  for={`provider-aws-session-${prov.key}`}
                                  >Session Token
                                  <span class="normal-case opacity-70"
                                    >(optional, for temporary keys)</span
                                  ></label
                                >
                                <div class="relative">
                                  <input
                                    id={`provider-aws-session-${prov.key}`}
                                    type={secretInputType(`provider-aws-session-${prov.key}`)}
                                    placeholder="AWS session token"
                                    bind:value={providersStore.awsSessionTokenInputs[prov.key]}
                                    class="input w-full pr-11 text-xs"
                                    onkeydown={(e) =>
                                      e.key === 'Enter' && handleConnectProvider(prov.key)}
                                  />
                                  <button
                                    type="button"
                                    class="secret-visibility absolute inset-y-0 right-1 my-auto z-10"
                                    onclick={() =>
                                      toggleSecretVisibility(`provider-aws-session-${prov.key}`)}
                                    aria-label={visibleSecrets[`provider-aws-session-${prov.key}`]
                                      ? 'Hide session token'
                                      : 'Show session token'}
                                  >
                                    {#if visibleSecrets[`provider-aws-session-${prov.key}`]}<EyeOff
                                        size={15}
                                      />{:else}<Eye size={15} />{/if}
                                  </button>
                                </div>
                              {/if}
                              {#if caps.requiresBaseUrl}
                                <label class="settings-field-label" for={`provider-url-${prov.key}`}
                                  >Endpoint URL</label
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
                                  class="settings-field-label"
                                  for={`provider-deployment-${prov.key}`}
                                  >{prov.key === 'sapai'
                                    ? 'Deployment ID'
                                    : 'Deployment name'}</label
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
                                <p
                                  class="text-[11px] leading-relaxed text-[var(--color-text-muted)]"
                                >
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
                                    <p class="text-[11px] text-[var(--color-text-muted)]">
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
                                        class="rounded-md bg-[var(--color-surface-2)] px-2.5 py-2 text-[11px] text-[var(--color-text-secondary)]"
                                      >
                                        <div class="font-medium text-[var(--color-text-primary)]">
                                          {getProviderDisplayLabel(prov.key)} sign-in needs approval.
                                        </div>
                                        <div class="mt-1">
                                          The browser was opened automatically.
                                        </div>
                                        <div>Paste this code if you're asked for it.</div>
                                        <div class="mt-2 flex items-center gap-2">
                                          <span>Code:</span>
                                          <span
                                            class="font-semibold tracking-[0.18em] text-[var(--color-text-primary)]"
                                            >{userCode}</span
                                          >
                                          <button
                                            type="button"
                                            class="inline-flex items-center gap-1 rounded border border-[var(--color-border)] px-1.5 py-0.5 text-[11px] hover:bg-[var(--color-surface-3)]"
                                            onclick={() => copyToClipboard(userCode, 'deviceCode')}
                                          >
                                            <Copy size={10} />
                                            {providersStore.copiedDeviceCode === userCode
                                              ? 'Copied'
                                              : 'Copy code'}
                                          </button>
                                        </div>
                                        {#if deviceAuth.verificationUri}
                                          <div class="mt-1 break-all">
                                            {deviceAuth.verificationUri}
                                          </div>
                                        {/if}
                                        <div
                                          class="mt-2 text-[11px] text-[var(--color-text-muted)]"
                                        >
                                          Waiting for {getProviderDisplayLabel(prov.key)} approval to
                                          complete…
                                        </div>
                                      </div>
                                    {/if}
                                  {/if}
                                  <div class="flex gap-2">
                                    <button
                                      type="button"
                                      onclick={() => handleStartBrowserAuth(prov.key)}
                                      disabled={providersStore.browserAuthBusy === prov.key}
                                      class="btn btn-secondary flex-1 text-[11px] py-2"
                                    >
                                      {providersStore.browserAuthBusy === prov.key &&
                                      !providersStore.browserAuthPending[prov.key]
                                        ? 'Opening sign-in…'
                                        : 'Sign in'}
                                    </button>
                                    {#if providersStore.browserAuthPending[prov.key] && prov.key !== 'copilot' && prov.key !== 'kimicode' && prov.key !== 'codex-auth'}
                                      <button
                                        type="button"
                                        onclick={() => handleFinishBrowserAuth(prov.key)}
                                        disabled={providersStore.browserAuthBusy === prov.key}
                                        class="btn btn-primary flex-1 text-[11px] py-2 shadow-lg shadow-[var(--color-accent)]/10"
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
                              {#if usesLocalCliConnection(prov.key) && prov.key === 'freebuff'}
                                <p
                                  class="text-[11px] leading-relaxed text-[var(--color-text-muted)]"
                                >
                                  First-time Freebuff setup can take a few minutes while its
                                  isolated runtime is prepared.
                                </p>
                              {/if}
                              {#if usesBrowserAuth(prov.key) && caps.supportsApiKey}
                                <div class="flex items-center gap-3 py-1">
                                  <div class="flex-1 border-t border-[var(--color-border)]"></div>
                                  <span
                                    class="text-xs font-medium text-[var(--color-text-secondary)]"
                                    >Alternative sign-in</span
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
                                    : 'Connect'}</button
                                >
                              {:else if !usesBrowserAuth(prov.key)}
                                <button
                                  type="button"
                                  onclick={() => handleConnectProvider(prov.key)}
                                  disabled={providersStore.saving === prov.key}
                                  class="btn btn-primary w-full text-xs py-2 shadow-lg shadow-[var(--color-accent)]/10"
                                  >{providersStore.saving === prov.key
                                    ? usesLocalCliConnection(prov.key)
                                      ? prov.key === 'freebuff'
                                        ? 'Preparing Freebuff…'
                                        : 'Checking CLI…'
                                      : 'Connecting…'
                                    : usesLocalCliConnection(prov.key)
                                      ? getLocalCliConnectLabel(prov.key)
                                      : 'Connect'}</button
                                >
                              {/if}
                              {#if prov.key.startsWith('custom:')}
                                <button
                                  type="button"
                                  onclick={() => deleteCustomProvider(prov.key)}
                                  class="btn btn-ghost w-full text-[11px] py-1.5 mt-1 text-[var(--color-error)] hover:bg-[var(--color-error-bg)] flex items-center justify-center gap-1.5"
                                >
                                  <Trash2 size={12} /> Remove this custom provider
                                </button>
                              {/if}
                              {#if providersStore.connectErrors[prov.key]}
                                <div
                                  class="flex items-start gap-2 rounded-lg border border-[var(--color-error)] bg-[var(--color-error-bg)] px-3 py-2 text-xs text-[var(--color-error)]"
                                >
                                  <AlertTriangle size={14} class="shrink-0 mt-0.5" />
                                  <span class="flex-1"
                                    >{providersStore.connectErrors[prov.key]}</span
                                  >
                                </div>
                              {/if}
                            </div>
                          {/if}
                          {#if !configurationBlocked && getProviderAccounts(prov.key).length > 1}
                            <div class="space-y-3 border-t border-[var(--color-border)] pt-3">
                              <div class="flex items-center justify-between gap-3">
                                <div>
                                  <p class="text-xs font-medium text-[var(--color-text-secondary)]">
                                    Saved accounts
                                  </p>
                                  <p class="text-[11px] text-[var(--color-text-muted)]">
                                    Keep multiple keys or account logins per provider and switch
                                    between them.
                                  </p>
                                </div>
                                <button
                                  type="button"
                                  onclick={() => loadProviderAccounts(prov.key, true)}
                                  class="text-[11px] text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)]"
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
                                      class="border-b border-[var(--color-border)] py-2.5 last:border-b-0"
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
                                          <div
                                            class="mt-1 text-[11px] text-[var(--color-text-muted)]"
                                          >
                                            Local profile detected · authentication and plan
                                            unverified
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
                                              class="mt-1 text-[11px] text-[var(--color-text-muted)]"
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
                                              class="btn btn-secondary text-[11px] px-2.5 py-1"
                                            >
                                              {providersStore.accountBusy ===
                                              `${prov.key}:activate:${account.id}`
                                                ? 'Activating...'
                                                : 'Activate'}
                                            </button>
                                            <button
                                              type="button"
                                              onclick={() => openAccountManager(prov.key, account)}
                                              class="btn btn-secondary text-[11px] px-2.5 py-1"
                                            >
                                              Manage
                                            </button>
                                            <button
                                              type="button"
                                              onclick={() =>
                                                deleteProviderAccount(prov.key, account.id)}
                                              disabled={providersStore.accountBusy ===
                                                `${prov.key}:delete:${account.id}`}
                                              class="text-[11px] text-[var(--color-error)] hover:opacity-80 font-medium transition-opacity"
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
                                  <p
                                    class="text-[11px] leading-relaxed text-[var(--color-text-muted)]"
                                  >
                                    This provider's accounts are managed by its CLI. Sign in there,
                                    then use the check-login button above.
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
                                        placeholder={isBedrock(prov.key)
                                          ? 'AKIA… (access key ID)'
                                          : isNotion(prov.key)
                                            ? 'ntn_… (personal access token)'
                                            : providerCredentialPlaceholder(
                                                prov.key,
                                                prov.label,
                                                'apiKey',
                                              )}
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
                                        placeholder={providerCredentialPlaceholder(
                                          prov.key,
                                          prov.label,
                                          'authToken',
                                        )}
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
                                      This provider connects through browser sign-in instead of
                                      manual saved credentials.
                                    </p>
                                    <button
                                      type="button"
                                      onclick={() => handleStartBrowserAuth(prov.key)}
                                      disabled={providersStore.browserAuthBusy === prov.key}
                                      class="btn btn-primary w-full text-[11px] py-2 shadow-lg shadow-[var(--color-accent)]/10"
                                    >
                                      {providersStore.browserAuthBusy === prov.key
                                        ? isCliExecutionProvider(prov.key)
                                          ? 'Checking CLI Login…'
                                          : 'Opening sign-in…'
                                        : isCliExecutionProvider(prov.key)
                                          ? providersStore.getCliLoginLabel(prov.key)
                                          : 'Sign in'}
                                    </button>
                                  {:else}
                                    <div class="flex gap-2">
                                      <button
                                        type="button"
                                        onclick={() => saveProviderAccount(prov.key, false)}
                                        disabled={providersStore.accountBusy === `${prov.key}:save`}
                                        class="btn btn-secondary flex-1 text-[11px] py-2"
                                      >
                                        {providersStore.accountBusy === `${prov.key}:save`
                                          ? 'Saving...'
                                          : 'Save Account'}
                                      </button>
                                      <button
                                        type="button"
                                        onclick={() => saveProviderAccount(prov.key, true)}
                                        disabled={providersStore.accountBusy === `${prov.key}:save`}
                                        class="btn btn-primary flex-1 text-[11px] py-2 shadow-lg shadow-[var(--color-accent)]/10"
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
                            <div class="space-y-3 border-t border-[var(--color-border)] pt-3">
                              <div class="flex items-center justify-between gap-3">
                                <div>
                                  <p class="text-xs font-medium text-[var(--color-text-secondary)]">
                                    Fallback order
                                  </p>
                                  <p class="text-[11px] text-[var(--color-text-muted)]">
                                    Choose the CLI profiles Koryphaios may use, then drag to set
                                    their priority.
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
                                  class="text-[11px] text-[var(--color-text-muted)] transition-opacity duration-150 shrink-0 w-16 text-right"
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
                                onconsider={(e) =>
                                  handleFallbackDndConsider(prov.key, e.detail.items)}
                                onfinalize={(e) =>
                                  handleFallbackDndFinalize(prov.key, e.detail.items)}
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
                                      class="text-[11px] font-bold text-[var(--color-accent)] shrink-0 w-5 text-center"
                                      >{i + 1}</span
                                    >
                                    <div class="flex-1 min-w-0">
                                      <div
                                        class="text-xs font-semibold text-[var(--color-text-primary)] truncate"
                                      >
                                        {account.label}
                                      </div>
                                      <div class="text-[11px] text-[var(--color-text-muted)]">
                                        {[
                                          account.hasApiKey ? 'API key' : null,
                                          account.hasAuthToken ? 'Auth token' : null,
                                          account.hasBaseUrl ? 'Endpoint URL' : null,
                                        ]
                                          .filter(Boolean)
                                          .join(' · ')}
                                      </div>
                                    </div>
                                    <span class="text-xs text-[var(--color-text-muted)] shrink-0"
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
          </SettingsPage>
        </div>

        <!-- Panes below mount on first visit. Speech, images, video, MCP and
             the welcome cards all fetch on mount, so rendering them with the
             drawer fired those requests before the user had opened them. -->
        {#if open && visitedSettingsTabs.has('voice')}
          <div class={activeTab === 'voice' ? 'flex-1 min-h-0 overflow-y-auto' : 'hidden'}>
            <VoiceSettings attention={voiceSetupRequired} />
          </div>
        {/if}
        {#if open && visitedSettingsTabs.has('images')}
          <div class={activeTab === 'images' ? 'flex-1 min-h-0 overflow-y-auto' : 'hidden'}>
            <ImageSettings />
          </div>
        {/if}
        {#if open && visitedSettingsTabs.has('video')}
          <div class={activeTab === 'video' ? 'flex-1 min-h-0 overflow-y-auto' : 'hidden'}>
            <VideoSettings />
          </div>
        {/if}
        {#if open && visitedSettingsTabs.has('mcp')}
          <div class={activeTab === 'mcp' ? 'flex-1 min-h-0 overflow-y-auto' : 'hidden'}>
            <McpServersSettings />
          </div>
        {/if}

        {#if open && visitedSettingsTabs.has('appearance')}
          <div class={activeTab === 'appearance' ? 'flex-1 min-h-0 overflow-y-auto' : 'hidden'}>
            <AppearanceSettings
              bind:showColorPicker
              bind:colorPickerTarget
              bind:colorPickerScheme
            />
          </div>
        {/if}

        {#if open && visitedSettingsTabs.has('welcome')}
          <div class={activeTab === 'welcome' ? 'flex-1 min-h-0 overflow-y-auto' : 'hidden'}>
            <WelcomeSettings onReplayWalkthrough={() => requestSettingsClose()} />
          </div>
        {/if}

        <!-- Shortcuts Tab -->
        <div
          class={activeTab === 'shortcuts'
            ? 'flex-1 min-h-0 overflow-y-auto overflow-x-hidden'
            : 'hidden'}
        >
          <SettingsPage
            width="wide"
            title="Keyboard Shortcuts"
            description="Customizable global key bindings"
          >
            {#snippet actions()}
              <button
                type="button"
                onclick={resetShortcuts}
                class="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-[var(--color-border)] text-[var(--color-text-secondary)] text-xs font-medium hover:bg-[var(--color-surface-3)] hover:text-[var(--color-text-primary)] transition-colors"
              >
                <RotateCcw size={12} /> Reset to defaults
              </button>
            {/snippet}
            <div class="grid grid-cols-1 gap-x-6 gap-y-1 md:grid-cols-2">
              {#each shortcutStore.list as shortcut (shortcut.id)}
                <div
                  class="group flex items-center justify-between gap-4 rounded-lg px-3 py-2.5 transition-colors hover:bg-[var(--color-surface-2)]"
                  data-testid="shortcut-row"
                  data-shortcut-id={shortcut.id}
                >
                  <div class="min-w-0">
                    <div class="text-[13px] font-medium text-[var(--color-text-primary)]">
                      {shortcut.action}
                    </div>
                    <div class="text-xs text-[var(--color-text-muted)]">{shortcut.description}</div>
                  </div>
                  <button
                    type="button"
                    onclick={() => startEditShortcut(shortcut.id)}
                    class="flex shrink-0 items-center gap-1 px-2.5 py-1.5 rounded-md border bg-[var(--color-surface-1)] text-xs font-mono transition-colors
                         {editingShortcutId === shortcut.id
                      ? 'ring-2 ring-[var(--color-accent)] border-[var(--color-accent)] text-[var(--color-accent)]'
                      : 'border-[var(--color-border)] text-[var(--color-text-secondary)] group-hover:border-[var(--color-border-bright)] group-hover:text-[var(--color-text-primary)]'}"
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
          </SettingsPage>
        </div>

        <!-- Billing Tab -->
        <div
          class={activeTab === 'billing'
            ? 'flex-1 min-h-0 overflow-y-auto overflow-x-hidden w-full'
            : 'hidden'}
        >
          <UsageAnalyticsDashboard
            {billingCredits}
            billingLoading={billingSummaryLoading}
            {showSubscriptionApiEquivalent}
            bind:selectedEnvironment={settingsEnvironmentScope}
            bind:viewMode={billingViewMode}
            {getProviderDisplayLabel}
            onRefresh={() => {
              loadBillingCredits(true);
              void loadApiUsage();
            }}
          />

          <div class="mx-auto w-full max-w-[1144px] space-y-8 px-8 pb-10 pt-5">
            {#if billingError}
              <div
                class="p-4 rounded-xl border text-xs"
                style="border-color: var(--color-error); color: var(--color-error); background: var(--color-error-bg);"
              >
                Billing data unavailable: {billingError}
                <button
                  type="button"
                  class="ml-2 underline"
                  onclick={() => loadBillingCredits(true)}>Retry</button
                >
              </div>
            {/if}
            {#snippet apiUsagePanel()}
              <div
                class="billing-panel space-y-4 rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface-2)] p-5"
              >
                <div class="flex items-start justify-between gap-4">
                  <div>
                    <h4 class="text-xs font-medium text-[var(--color-text-secondary)]">
                      Image &amp; voice API usage
                    </h4>
                    <p class="mt-1 text-[11px] text-[var(--color-text-muted)]">
                      Estimated cost from this app's image and voice calls. Estimates only. This is
                      not a bill. Entries older than 90 days are pruned.
                    </p>
                  </div>
                  <div class="flex gap-2">
                    <button
                      type="button"
                      class="inline-flex min-h-8 items-center gap-1.5 rounded-lg border border-[var(--color-border)] px-2.5 py-1.5 text-[11px] font-semibold text-[var(--color-text-secondary)] transition-colors hover:border-[var(--color-accent)]/50 hover:text-[var(--color-text-primary)]"
                      onclick={() => void loadApiUsage()}
                    >
                      <RefreshCw size={12} class={apiUsageLoading ? 'animate-spin' : ''} />
                      Refresh
                    </button>
                    <button
                      type="button"
                      class="inline-flex min-h-8 items-center gap-1.5 rounded-lg border border-[var(--color-border)] px-2.5 py-1.5 text-[11px] font-semibold text-[var(--color-text-secondary)] transition-colors hover:border-[var(--color-accent)]/50 hover:text-[var(--color-text-primary)]"
                      onclick={() => void exportUsageCsv()}
                    >
                      <Download size={12} /> CSV
                    </button>
                  </div>
                </div>
                {#if apiUsageError}
                  <div
                    class="p-3 rounded-xl border text-xs"
                    style="border-color: var(--color-error); color: var(--color-error); background: var(--color-error-bg);"
                  >
                    Usage data unavailable: {apiUsageError}
                    <button type="button" class="ml-2 underline" onclick={() => void loadApiUsage()}
                      >Retry</button
                    >
                  </div>
                {:else if apiUsage}
                  <div class="flex flex-wrap gap-4 text-xs">
                    <span class="text-[var(--color-text-secondary)]">
                      Total calls <span class="font-bold text-[var(--color-text-primary)]"
                        >{apiUsage.totals.totalCount}</span
                      >
                    </span>
                    <span class="text-[var(--color-text-secondary)]">
                      Images <span class="font-bold text-[var(--color-text-primary)]"
                        >{apiUsage.totals.byKind.image ?? 0}</span
                      >
                    </span>
                    <span class="text-[var(--color-text-secondary)]">
                      Speech <span class="font-bold text-[var(--color-text-primary)]"
                        >{apiUsage.totals.byKind.tts ?? 0}</span
                      >
                    </span>
                    <span class="text-[var(--color-text-secondary)]">
                      Transcribe <span class="font-bold text-[var(--color-text-primary)]"
                        >{apiUsage.totals.byKind.stt ?? 0}</span
                      >
                    </span>
                    <span class="text-[var(--color-text-secondary)]">
                      Estimated
                      <span class="font-bold text-[var(--color-text-primary)]">
                        {apiUsage.totals.estimatedCostUsd !== undefined
                          ? `$${apiUsage.totals.estimatedCostUsd.toFixed(4)}`
                          : 'Not available'}
                      </span>
                    </span>
                  </div>
                  {#if apiUsage.entries.length > 0}
                    <div
                      class="divide-y divide-[var(--color-border)] rounded-xl border border-[var(--color-border)]"
                    >
                      {#each apiUsage.entries.slice(0, 10) as entry (entry.id)}
                        <div class="flex items-center justify-between gap-3 px-3 py-2 text-[11px]">
                          <div class="min-w-0">
                            <span class="font-semibold text-[var(--color-text-primary)]"
                              >{formatApiUsageKind(entry.kind)}</span
                            >
                            <span class="text-[var(--color-text-muted)]">
                              · {entry.provider} · {entry.model}{entry.detail
                                ? ` · ${entry.detail}`
                                : ''}</span
                            >
                          </div>
                          <div
                            class="flex shrink-0 items-center gap-3 text-[var(--color-text-muted)]"
                          >
                            <span>{new Date(entry.ts).toLocaleString()}</span>
                            <span
                              class="w-14 text-right font-semibold text-[var(--color-text-primary)]"
                            >
                              {entry.estimatedCostUsd !== undefined
                                ? `$${entry.estimatedCostUsd.toFixed(4)}`
                                : 'Not available'}
                            </span>
                          </div>
                        </div>
                      {/each}
                    </div>
                  {:else}
                    <p class="text-[11px] text-[var(--color-text-muted)]">
                      No image or voice API calls recorded yet.
                    </p>
                  {/if}
                {:else}
                  <div class="h-16 rounded-xl bg-[var(--color-surface-3)] animate-pulse"></div>
                {/if}
              </div>
            {/snippet}
            {@render apiUsagePanel()}
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
            {#if billingLiveError && !billingLiveLoading}
              <div
                class="p-4 rounded-xl border text-xs"
                style="border-color: var(--color-error); color: var(--color-error); background: var(--color-error-bg);"
              >
                Live billing data unavailable: {billingLiveError}
                <button
                  type="button"
                  class="ml-2 underline"
                  onclick={() => loadBillingCredits(true)}>Retry</button
                >
              </div>
            {/if}
            <!-- CLI subscriptions: account-separated local usage + quota burn -->
            {#if billingCredits?.cliUsage?.length}
              <div class="space-y-4">
                <div class="ml-1 flex flex-wrap items-end justify-between gap-3">
                  <div>
                    <h3 class="text-sm font-bold text-[var(--color-text-primary)]">
                      CLI subscriptions
                    </h3>
                    <p class="mt-1 text-[11px] text-[var(--color-text-muted)]">
                      Each detected profile is shown separately, with usage, quota, and provider
                      credits when reported by the account.
                    </p>
                  </div>
                </div>
                <div class="grid grid-cols-1 xl:grid-cols-2 gap-4">
                  {#each billingCredits.cliUsage as cli (`${cli.provider}:${cli.accountId ?? 'aggregate'}`)}
                    <div
                      class="billing-panel space-y-4 rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface-2)] p-5"
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
                              <div class="text-[11px] text-[var(--color-text-muted)]">
                                {cli.accountEmail || 'CLI profile'}
                              </div>
                            {/if}
                          </div>
                          {#if cli.planType}
                            <span
                              class="px-2 py-0.5 rounded-full text-xs font-medium bg-[var(--color-surface-3)] text-[var(--color-text-secondary)]"
                              >{cli.planType}</span
                            >
                          {/if}
                          {#if cli.apiProviderName}
                            <span
                              class="px-2 py-0.5 rounded-full text-xs font-medium bg-[var(--color-accent)]/10 text-[var(--color-accent)]"
                              title="Raw inference API provider backing this CLI subscription"
                              >API: {cli.apiProviderName}</span
                            >
                          {/if}
                        </div>
                        <div
                          class="flex flex-col items-end gap-0.5 text-[11px] text-[var(--color-text-muted)]"
                        >
                          {#if cli.usageSource}
                            <span
                              >{cli.usageSource === 'codex-app-server'
                                ? 'Tokens: live Codex account data'
                                : cli.usageSource === 'kory-provider-events'
                                  ? 'Tokens: Freebuff request logs'
                                  : 'Tokens: local Koryphaios history'}</span
                            >
                          {:else}
                            <span title="No metered token activity recorded for this account yet"
                              >Tokens: none recorded yet</span
                            >
                          {/if}
                          {#if cli.quotaSource === 'live-cli-account'}
                            <span
                              class="font-medium text-[var(--color-success)]"
                              title="Current account quota reported by the provider's own account API. It is not estimated from local token history"
                              >Limits: live {providersStore.getProviderDisplayLabel(
                                cli.provider,
                              )} account</span
                            >
                          {/if}
                        </div>
                      </div>

                      {#if cli.provider === 'freebuff'}
                        <FreebuffBalance account={cli.freebuffAccount} />
                      {/if}
                      {#if cli.attribution === 'unavailable'}
                        <div
                          class="rounded-xl border border-[var(--color-warning)] bg-[var(--color-warning-bg)] px-3 py-2 text-[11px] text-[var(--color-text-secondary)]"
                        >
                          Usage unavailable for this account: {cli.attributionNote}. Point this CLI
                          profile at its own session directory to enable account-separated usage.
                        </div>
                      {:else}
                        {#if cli.usagePrecision === 'input-context-only'}
                          <div
                            class="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-1)] px-3 py-2 text-[11px] text-[var(--color-text-secondary)]"
                          >
                            {#if cli.provider === 'freebuff'}
                              Freebuff reports the input context before each model request. Its
                              current log does not expose upstream output-token usage, so these
                              token totals and API-equivalent values are input side only. These are
                              not charges or invented output estimates.
                            {:else}
                              {cli.provider} exposes input-context usage without upstream output-token
                              totals. Its OpenRouter equivalent is therefore input side only. This is
                              not an invented full inference value.
                            {/if}
                          </div>
                        {/if}
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
                        {#if showSubscriptionApiEquivalent && cli.apiValueMinUsd !== undefined && cli.apiValueMaxUsd !== undefined}
                          <div
                            class="flex items-center justify-between gap-3 rounded-xl bg-[var(--color-surface-1)] px-3 py-2 text-[11px]"
                          >
                            <span class="text-[var(--color-text-secondary)]"
                              >OpenRouter {cli.apiValueCoverage === 'full' ? 'inference' : 'input'} value
                              range · 30d</span
                            >
                            <div class="text-right">
                              <div class="font-mono font-semibold text-[var(--color-text-primary)]">
                                ${cli.apiValueMinUsd.toFixed(4)} to ${cli.apiValueMaxUsd.toFixed(4)}
                              </div>
                              {#if (cli.apiValueCoverage === 'full' ? cli.apiFreshValueUsd : cli.apiFreshInputValueUsd) !== undefined}
                                <div class="text-[11px] text-[var(--color-text-muted)]">
                                  fresh-rate value ${(cli.apiValueCoverage === 'full'
                                    ? cli.apiFreshValueUsd
                                    : cli.apiFreshInputValueUsd
                                  ).toFixed(4)}
                                </div>
                              {/if}
                              {#if cli.apiCacheAdjustedValueUsd !== undefined}
                                <div class="text-[11px] text-[var(--color-accent)]">
                                  observed cache reads ${cli.apiCacheAdjustedValueUsd.toFixed(4)}
                                </div>
                              {/if}
                            </div>
                          </div>
                          <div class="px-1 text-[11px] text-[var(--color-text-muted)]">
                            Comparison value from OpenRouter’s official catalog, not the CLI’s
                            actual subscription charge. The range includes published cache-read,
                            fresh-input, and cache-write scenarios when available.{#if cli.cacheAccounting === 'provider-reported'}
                              The observed-cache figure applies the CLI’s reported cache-read
                              tokens.{/if}
                          </div>
                        {:else if showSubscriptionApiEquivalent && cli.apiValueUsd !== undefined}
                          <div
                            class="flex items-center justify-between rounded-xl bg-[var(--color-surface-1)] px-3 py-2 text-[11px]"
                          >
                            <span class="text-[var(--color-text-secondary)]"
                              >API-equivalent input value · 30d</span
                            >
                            <span class="font-mono font-semibold text-[var(--color-text-primary)]"
                              >${cli.apiValueUsd.toFixed(4)}</span
                            >
                          </div>
                        {/if}
                        {#each cli.quotas as q (q.label)}
                          {@const remainingPercent = Math.max(0, 100 - q.usedPercent)}
                          <div>
                            <div class="flex items-center justify-between text-[11px] mb-1">
                              <span class="text-[var(--color-text-secondary)] font-medium"
                                >{q.label}</span
                              >
                              <span
                                class="font-mono font-bold"
                                style="color: {q.usedPercent >= 90
                                  ? 'var(--color-error)'
                                  : q.usedPercent >= 70
                                    ? 'var(--color-warning)'
                                    : 'var(--color-text-secondary)'};"
                              >
                                {remainingPercent.toFixed(0)}% left{q.resetsAt
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
                                  remainingPercent,
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
                              <div class="text-xs font-medium text-[var(--color-text-secondary)]">
                                {w.period}
                              </div>
                              <div
                                class="mt-1 text-xs font-mono font-bold text-[var(--color-text-primary)]"
                              >
                                {formatTokens(w.tokensIn + w.tokensOut)}
                              </div>
                              <div class="text-[11px] text-[var(--color-text-muted)]">tokens</div>
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
                            <div class="flex items-center justify-between gap-3 text-[11px]">
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
                                    aria-pressed={(subscriptionTrendRanges[trendKey] ?? 14) ===
                                      days}
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
                                  class="flex items-center justify-between rounded-md bg-[var(--color-surface-2)] px-2 py-1 text-[11px]"
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
                              onpointermove={(event) =>
                                updateUsageTrendPoint(event, trendKey, trend)}
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
                              class="mt-1 flex justify-between text-[11px] text-[var(--color-text-muted)]"
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
                                  <span
                                    class="font-mono text-[var(--color-text-secondary)] truncate"
                                    >{m.model}</span
                                  >
                                  <span
                                    class="font-mono text-[var(--color-text-muted)] shrink-0 ml-3"
                                  >
                                    {formatTokens(m.tokensIn + m.tokensOut)} tokens
                                  </span>
                                </div>
                                {#if showSubscriptionApiEquivalent && (m.apiEquivalent || m.apiProvider)}
                                  <div
                                    class="mt-0.5 flex items-center gap-1 text-[11px] text-[var(--color-text-muted)]"
                                  >
                                    <span class="font-medium">API equivalent</span>
                                    <span
                                      class="font-mono text-[var(--color-accent)]/80 truncate"
                                      title={m.apiEquivalent ?? m.apiProvider ?? ''}
                                    >
                                      {m.apiProvider ? `${m.apiProvider}/` : ''}{m.apiEquivalent ??
                                        '(unmapped)'}
                                    </span>
                                    {#if m.apiEquivalent && m.apiEquivalent === m.model}
                                      <span class="text-[var(--color-text-muted)] italic"
                                        >(same)</span
                                      >
                                    {/if}
                                  </div>
                                {/if}
                                <!-- Model context is catalog metadata, not usage;
                                     it is deliberately absent from Billing. -->
                                {#if showSubscriptionApiEquivalent &&
                                  (m.apiValueUsd !== undefined ||
                                    m.apiValueMinUsd !== undefined ||
                                    m.apiCacheAdjustedValueUsd !== undefined)}
                                  <div
                                    class="mt-1 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[11px] text-[var(--color-text-muted)]"
                                  >
                                    {#if showSubscriptionApiEquivalent && m.apiValueMinUsd !== undefined && m.apiValueMaxUsd !== undefined}
                                      <span
                                        >OpenRouter {m.apiValueCoverage === 'full'
                                          ? 'inference'
                                          : 'input'}
                                        <span class="font-mono text-[var(--color-text-secondary)]"
                                          >${m.apiValueMinUsd.toFixed(4)} to ${m.apiValueMaxUsd.toFixed(
                                            4,
                                          )}</span
                                        ></span
                                      >
                                    {:else if showSubscriptionApiEquivalent && m.apiValueUsd !== undefined}
                                      <span
                                        >API input value
                                        <span class="font-mono text-[var(--color-text-secondary)]"
                                          >${m.apiValueUsd.toFixed(4)}</span
                                        ></span
                                      >
                                    {/if}
                                    {#if showSubscriptionApiEquivalent && m.apiCacheAdjustedValueUsd !== undefined}
                                      <span
                                        >Observed cache
                                        <span class="font-mono text-[var(--color-text-secondary)]"
                                          >${m.apiCacheAdjustedValueUsd.toFixed(4)}</span
                                        ></span
                                      >
                                    {/if}
                                  </div>
                                {/if}
                                {#if showSubscriptionApiEquivalent && m.promptUsdPerMillion !== undefined}
                                  <div
                                    class="mt-0.5 text-[11px] text-[var(--color-text-muted)]"
                                    title={m.pricingHasThresholds
                                      ? 'OpenRouter publishes prompt size pricing thresholds. Koryphaios applies them to each recorded request.'
                                      : 'Official OpenRouter per-token pricing'}
                                  >
                                    OpenRouter $/M: fresh
                                    <span class="font-mono"
                                      >${formatUsdRate(m.promptUsdPerMillion)}</span
                                    >{#if m.completionUsdPerMillion !== undefined}, output
                                      <span class="font-mono"
                                        >${formatUsdRate(m.completionUsdPerMillion)}</span
                                      >{/if}{#if m.cacheReadUsdPerMillion !== undefined}, cache read
                                      <span class="font-mono"
                                        >${formatUsdRate(m.cacheReadUsdPerMillion)}</span
                                      >{/if}{#if m.cacheWriteUsdPerMillion !== undefined}, cache
                                      write
                                      <span class="font-mono"
                                        >${formatUsdRate(m.cacheWriteUsdPerMillion)}</span
                                      >{/if}{#if m.pricingHasThresholds}
                                      <span class="italic"> · size-tiered</span>{/if}
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
                  <p class="mt-1 text-[11px] text-[var(--color-text-muted)]">
                    CLI profiles are being checked while usage history is indexed. Connected means a
                    provider probe succeeded; a detected profile has not been connected in
                    Koryphaios yet.
                  </p>
                </div>
                <div class="grid grid-cols-1 xl:grid-cols-2 gap-4">
                  {#each billingCredits.detectedCliAccounts as account (`${account.provider}:${account.id}`)}
                    <div
                      class="billing-panel flex items-center gap-3 rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface-2)] p-5"
                    >
                      <div
                        class="flex h-9 w-9 items-center justify-center rounded-lg bg-[var(--color-surface-3)] p-2"
                      >
                        <ProviderIcon provider={account.provider} size={20} />
                      </div>
                      <div class="min-w-0 flex-1">
                        <div
                          class="truncate text-sm font-semibold text-[var(--color-text-primary)]"
                        >
                          {account.email || account.label}
                        </div>
                        <div class="text-[11px] text-[var(--color-text-muted)]">
                          {account.plan
                            ? `${account.plan.toUpperCase()} plan · `
                            : ''}{account.connectionState === 'connected'
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
            {:else if billingLiveLoading && billingCredits}
              <div
                class="flex items-center gap-2 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-2)] px-4 py-3 text-xs text-[var(--color-text-secondary)]"
                role="status"
              >
                <RefreshCw size={13} class="animate-spin text-[var(--color-accent)]" />
                Loading subscription usage…
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
                      class="billing-panel rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-2)] p-4 text-center"
                    >
                      <div
                        class="w-8 h-8 mx-auto rounded-lg bg-[var(--color-surface-3)] flex items-center justify-center p-1.5 mb-2"
                      >
                        <ProviderIcon provider={bal.provider} size={20} class="w-full h-full" />
                      </div>
                      <div class="text-lg font-black font-mono text-[var(--color-success)]">
                        {bal.availableUsd != null
                          ? `$${bal.availableUsd.toFixed(2)}`
                          : bal.allowanceUsedPercent != null
                            ? `${Math.round(bal.allowanceUsedPercent)}% used`
                            : 'Not available'}
                      </div>
                      <div class="text-xs font-medium text-[var(--color-text-muted)] mt-1">
                        {getProviderDisplayLabel(bal.provider)}
                      </div>
                      {#if bal.availableUsd == null && (bal.plan || bal.allowanceResetsAt)}
                        <div class="mt-1 text-[11px] text-[var(--color-text-muted)]">
                          {[
                            bal.plan ? `${bal.plan} plan` : '',
                            bal.allowanceResetsAt
                              ? `resets ${formatBalanceReset(bal.allowanceResetsAt)}`
                              : '',
                          ]
                            .filter(Boolean)
                            .join(' · ')}
                        </div>
                      {/if}
                    </div>
                  {/each}
                </div>
              </div>
            {:else if billingLiveLoading && billingCredits}
              <div
                class="flex items-center gap-2 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-2)] px-4 py-3 text-xs text-[var(--color-text-secondary)]"
                role="status"
              >
                <RefreshCw size={13} class="animate-spin text-[var(--color-accent)]" />
                Loading provider balances…
              </div>
            {/if}

            <div class="space-y-4">
              <div class="ml-1">
                <h3 class="text-sm font-bold text-[var(--color-text-primary)]">
                  Tracked API spend by provider
                </h3>
                <p class="mt-1 text-[11px] text-[var(--color-text-muted)]">
                  Expand a provider for exact model-level tracked spend. Unknown pricing stays
                  unknown.
                </p>
              </div>
              <div class="space-y-2">
                {#if billingCredits?.byProvider?.length}
                  {#each billingCredits.byProvider as prov (prov.name)}
                    <div
                      class="billing-panel overflow-hidden rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-2)]"
                    >
                      <button
                        type="button"
                        class="flex w-full items-center gap-3 p-4 text-left transition-colors hover:bg-[var(--color-surface-3)]"
                        aria-expanded={expandedBillingProviders[prov.name] ?? false}
                        onclick={() =>
                          (expandedBillingProviders[prov.name] = !(
                            expandedBillingProviders[prov.name] ?? false
                          ))}
                      >
                        <span
                          class="w-4 shrink-0 text-[11px] text-[var(--color-text-muted)]"
                          aria-hidden="true"
                        >
                          {expandedBillingProviders[prov.name] ? '▼' : '▶'}
                        </span>
                        <span
                          class="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-[var(--color-surface-3)] p-1.5"
                        >
                          <ProviderIcon provider={prov.name} size={20} class="h-full w-full" />
                        </span>
                        <span class="min-w-0 flex-1">
                          <span
                            class="block truncate text-xs font-semibold text-[var(--color-text-primary)]"
                            >{getProviderDisplayLabel(prov.name)}</span
                          >
                          <span class="text-[11px] font-mono text-[var(--color-text-muted)]"
                            >{formatTokens((prov.tokensIn ?? 0) + (prov.tokensOut ?? 0))} tokens</span
                          >
                        </span>
                        <span class="text-right">
                          <span
                            class="block text-xs font-mono font-bold text-[var(--color-text-secondary)]"
                          >
                            {prov.hasKnownCost === false
                              ? '$?.??'
                              : formatBillingUsd(prov.spendUsd ?? (prov.spendCents ?? 0) / 100)}
                          </span>
                          {#if prov.pricingIncomplete}<span
                              class="text-[11px] text-[var(--color-warning)]"
                              >pricing incomplete</span
                            >{/if}
                        </span>
                      </button>
                      {#if expandedBillingProviders[prov.name]}
                        <div
                          class="border-t border-[var(--color-border)] bg-[var(--color-surface-1)] px-4 py-2"
                        >
                          {#each prov.models ?? [] as model (model.model)}
                            <div class="flex items-center justify-between gap-3 py-2 text-[11px]">
                              <div class="min-w-0">
                                <div class="truncate font-mono text-[var(--color-text-secondary)]">
                                  {model.model}
                                </div>
                                <div class="text-[11px] text-[var(--color-text-muted)]">
                                  {formatTokens((model.tokensIn ?? 0) + (model.tokensOut ?? 0))} tokens
                                </div>
                              </div>
                              <div
                                class="shrink-0 text-right font-mono font-semibold text-[var(--color-text-primary)]"
                              >
                                {model.hasKnownCost === false
                                  ? '$?.??'
                                  : formatBillingUsd(
                                      model.spendUsd ?? (model.spendCents ?? 0) / 100,
                                    )}
                                {#if model.pricingIncomplete}<div
                                    class="text-[11px] font-sans font-normal text-[var(--color-warning)]"
                                  >
                                    incomplete
                                  </div>{/if}
                              </div>
                            </div>
                          {/each}
                        </div>
                      {/if}
                    </div>
                  {/each}
                {:else}
                  <div
                    class="py-12 text-center border-2 border-dashed border-[var(--color-border)] rounded-2xl"
                  >
                    <p class="text-xs text-[var(--color-text-muted)]">
                      No tracked API usage recorded yet
                    </p>
                  </div>
                {/if}
              </div>
            </div>

            <div
              class="billing-panel space-y-3 rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface-2)] p-4"
            >
              <button
                type="button"
                class="flex w-full items-center gap-3 text-left"
                aria-expanded={billingControlsExpanded}
                aria-controls="billing-controls-body"
                onclick={() => (billingControlsExpanded = !billingControlsExpanded)}
              >
                <span class="min-w-0 flex-1">
                  <span class="block text-sm font-bold text-[var(--color-text-primary)]"
                    >Billing controls</span
                  >
                  <span class="mt-1 block text-[11px] text-[var(--color-text-muted)]">
                    Choose which providers contribute to Billing totals and live balance probes.
                    {#if billingCredits?.availableBillingProviders?.length}
                      {billingCredits.availableBillingProviders.filter((provider: string) =>
                        billingProviderIncluded(provider),
                      ).length} of {billingCredits.availableBillingProviders.length} included.
                    {/if}
                  </span>
                </span>
                <span
                  class="shrink-0 text-[11px] font-semibold text-[var(--color-text-muted)]"
                  aria-hidden="true"
                >
                  {billingControlsExpanded ? 'Hide' : 'Show'}
                </span>
                <ChevronDown
                  size={16}
                  class="shrink-0 text-[var(--color-text-muted)] transition-transform {billingControlsExpanded
                    ? 'rotate-180'
                    : ''}"
                />
              </button>
              {#if billingControlsExpanded}
                <div id="billing-controls-body" class="space-y-3">
                  <SettingsSwitch
                    compact
                    checked={showSubscriptionApiEquivalent}
                    label="Show subscription API-equivalent values"
                    description="Comparison value only. It is never added to tracked API spend."
                    onchange={toggleSubscriptionApiEquivalent}
                  />
                  {#if billingCredits?.availableBillingProviders?.length}
                    <div class="relative">
                      <Search
                        size={13}
                        class="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-[var(--color-text-muted)]"
                      />
                      <label for="billing-controls-search" class="sr-only"
                        >Search billing providers</label
                      >
                      <input
                        id="billing-controls-search"
                        type="search"
                        bind:value={billingControlsSearch}
                        placeholder="Search providers..."
                        class="h-9 w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-1)] pl-8 pr-8 text-xs text-[var(--color-text-primary)] outline-none placeholder:text-[var(--color-text-muted)] hover:border-[var(--color-border-bright)] focus-visible:border-[var(--color-accent)]"
                      />
                      {#if billingControlsSearch}
                        <button
                          type="button"
                          aria-label="Clear billing provider search"
                          onclick={() => (billingControlsSearch = '')}
                          class="absolute right-1.5 top-1/2 flex h-6 w-6 -translate-y-1/2 items-center justify-center rounded-md text-[var(--color-text-muted)] hover:bg-[var(--color-surface-3)] hover:text-[var(--color-text-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)]/60"
                        >
                          <X size={12} />
                        </button>
                      {/if}
                    </div>
                    {@const billingControlsQuery = billingControlsSearch.trim().toLocaleLowerCase()}
                    {@const filteredBillingProviders = (
                      billingCredits.availableBillingProviders as string[]
                    ).filter((provider: string) => {
                      if (!billingControlsQuery) return true;
                      return (
                        provider.toLocaleLowerCase().includes(billingControlsQuery) ||
                        getProviderDisplayLabel(provider)
                          .toLocaleLowerCase()
                          .includes(billingControlsQuery)
                      );
                    })}
                    {#if filteredBillingProviders.length}
                      <div class="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
                        {#each filteredBillingProviders as provider (provider)}
                          <SettingsSwitch
                            compact
                            checked={billingProviderIncluded(provider)}
                            label={getProviderDisplayLabel(provider)}
                            description="Include this provider in Billing"
                            onchange={() => void toggleBillingProvider(provider)}
                          />
                        {/each}
                      </div>
                    {:else}
                      <div
                        class="rounded-xl border border-dashed border-[var(--color-border)] px-3 py-5 text-center"
                      >
                        <p class="text-xs font-medium text-[var(--color-text-secondary)]">
                          No providers match “{billingControlsSearch.trim()}”
                        </p>
                        <button
                          type="button"
                          class="mt-2 min-h-9 rounded-lg px-3 text-[11px] font-medium text-[var(--color-accent)] hover:bg-[var(--color-surface-2)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)]/60"
                          onclick={() => (billingControlsSearch = '')}>Clear search</button
                        >
                      </div>
                    {/if}
                  {/if}
                </div>
              {/if}
            </div>
          </div>
        </div>

        <!-- Memory Tab -->
        {#if open && activeTab === 'devices'}
          <div class="flex-1 min-h-0 overflow-y-auto"><LinkDevicePanel /></div>
        {/if}
        {#if open && activeTab === 'project'}
          <ProjectIdentitySettings />
        {/if}
        {#if open && activeTab === 'memory'}
          <div class="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
            <MemoryEditor />
          </div>
        {/if}

        <!-- Keep skill drafts mounted while navigating between settings panes. -->
        {#if open && skillsVisited}
          <div
            class={activeTab === 'skills'
              ? 'skills-settings-workspace flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden'
              : 'hidden'}
          >
            <SkillsWorkspace active={activeTab === 'skills'} />
          </div>
        {/if}

        <!-- Archived chats Tab -->
        {#if open && activeTab === 'archived'}
          <div class="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
            <ArchivedChatsSettings />
          </div>
        {/if}

        <!-- Agent Tab -->
        <div
          class={activeTab === 'agent'
            ? 'flex-1 min-h-0 min-w-0 overflow-hidden flex flex-col'
            : 'hidden'}
        >
          <AgentSettings
            active={open && activeTab === 'agent'}
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
            ? 'flex-1 min-h-0 overflow-y-auto overflow-x-hidden'
            : 'hidden'}
        >
          <SettingsPage
            width="wide"
            title="Team access"
            description="The host controls what guests can see, submit, and which models are available"
          >
            <div class="w-full">
              <SettingsSwitch
                checked={showTeamSidebarShortcut}
                label="Show Teams shortcut in sidebar"
                description="Restore the Join or host a team workspace shortcut above your workspace tree."
                onchange={toggleTeamSidebarShortcut}
                flat
              />
            </div>

            {#if collaborationStore.activeCollab}
              <!-- ── ACTIVE SESSION ── -->
              <div class="w-full space-y-8">
                <!-- Invite links -->
                <div>
                  <div
                    class="mb-4 flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wider text-[var(--color-accent)]"
                  >
                    <span
                      class="h-1.5 w-1.5 rounded-full bg-[var(--color-accent)]"
                      aria-hidden="true"
                    ></span>
                    {collaborationStore.activeCollab.relayEnabled
                      ? 'Live via Relay'
                      : 'Active Session'}
                  </div>

                  {#if collaborationStore.activeCollab.relayEnabled}
                    <h4 class="text-sm font-semibold text-[var(--color-text-primary)] mb-3">
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
                    <!-- A host without an enforced relay is not shareable. Do not
                         present the historical local join code as usable. -->
                    <div
                      class="rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface-1)] p-4"
                    >
                      <p class="text-xs font-semibold text-[var(--color-text-primary)]">
                        Sharing is not configured
                      </p>
                      <p class="mt-1 text-[11px] leading-5 text-[var(--color-text-muted)]">
                        Configure the collaboration relay to create an invite, or use Linked Devices
                        for a direct connection. This workspace remains available locally.
                      </p>
                    </div>
                  {/if}
                </div>

                <!-- Host policy -->
                <TeamAccessProfiles models={teamModels} />

                <!-- Pending approvals -->
                {#if collaborationStore.pendingPrompts.length > 0}
                  <div
                    class="rounded-xl border border-[var(--color-warning)] bg-[var(--color-warning-bg)] p-5"
                  >
                    <h4
                      class="text-sm font-semibold text-[var(--color-warning)] mb-3 flex items-center gap-2"
                    >
                      <Clock3 size={15} /> Pending Guest Prompts ({collaborationStore.pendingPrompts
                        .length})
                    </h4>
                    <div class="space-y-3">
                      {#each collaborationStore.pendingPrompts as p (p.promptId)}
                        <div class="rounded-lg bg-[var(--color-surface-1)] p-4">
                          <div class="flex items-start justify-between gap-4">
                            <div class="flex-1 min-w-0">
                              <div class="flex items-center gap-2 mb-1">
                                <span class="text-xs font-medium text-[var(--color-warning)]"
                                  >{p.name}</span
                                >
                                <span class="text-[11px] text-[var(--color-text-muted)]"
                                  >· {p.role}</span
                                >
                              </div>
                              <p class="text-sm text-[var(--color-text-primary)] break-words">
                                {p.content}
                              </p>
                              {#if p.model}<p
                                  class="mt-2 text-[11px] text-[var(--color-text-muted)]"
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
                <div class="w-full">
                  <div class="mb-3">
                    <h4 class="text-sm font-semibold text-[var(--color-text-primary)]">
                      Team sessions
                    </h4>
                    <p class="mt-1 text-xs text-[var(--color-text-muted)]">
                      These are separate from your personal session history. Joining never replaces
                      or merges your local sessions.
                    </p>
                  </div>
                  <div class="space-y-3">
                    {#each collaborationStore.joinedSessions as team (team.sessionId)}<div
                        class="flex items-center gap-3 rounded-md p-3 transition-colors hover:bg-[var(--color-surface-2)]"
                      >
                        <div class="min-w-0 flex-1">
                          <div class="truncate text-xs font-bold text-[var(--color-text-primary)]">
                            {team.sessionName}
                          </div>
                          <div class="mt-1 text-[11px] text-[var(--color-text-muted)]">
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
              <div class="grid w-full grid-cols-1 items-start gap-x-10 gap-y-8 md:grid-cols-2">
                <div class="flex flex-col">
                  <h4 class="mb-1 text-sm font-semibold text-[var(--color-text-primary)]">
                    Team session
                  </h4>
                  <p class="mb-4 text-xs leading-5 text-[var(--color-text-muted)]">
                    Generate invite links for teammates to watch or co-pilot your active AI session
                    in real time.
                  </p>
                  <label class="mb-4 block text-xs text-[var(--color-text-secondary)]">
                    Your name shown to teammates
                    <input
                      bind:value={teamHostName}
                      maxlength="80"
                      placeholder="Host name"
                      class="mt-1.5 min-h-10 w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-1)] px-3 py-2 text-sm outline-none focus:border-[var(--color-accent)]"
                    />
                  </label>

                  <div class="mb-4 border-t border-[var(--color-border)] pt-4">
                    <div class="mb-3 flex items-start justify-between gap-4">
                      <div>
                        <div class="text-xs font-semibold text-[var(--color-text-primary)]">
                          Working in
                        </div>
                        <div class="mt-0.5 text-[11px] text-[var(--color-text-muted)]">
                          Workspace roots available to this hosted session.
                        </div>
                      </div>
                      <button
                        type="button"
                        onclick={addHostWorkspacePath}
                        class="flex shrink-0 items-center gap-1.5 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-2)] px-2.5 py-1.5 text-[11px] font-bold text-[var(--color-text-secondary)] transition-colors hover:border-[var(--color-accent)]/50 hover:text-[var(--color-text-primary)]"
                      >
                        <FolderOpen size={13} /> Add folder
                      </button>
                    </div>

                    {#if hostWorkspacePaths.length}
                      <div class="space-y-2">
                        {#each hostWorkspacePaths as path, index (index)}
                          <div
                            class="group flex min-h-11 items-center gap-2 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-0)] p-2.5 transition-colors focus-within:border-[var(--color-accent)]/60"
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
                        class="flex w-full items-center justify-center gap-2 rounded-xl border border-dashed border-[var(--color-border)] py-4 text-[var(--color-text-muted)] transition-colors hover:border-[var(--color-accent)]/50 hover:text-[var(--color-text-secondary)]"
                      >
                        <Plus size={16} />
                        <span class="text-xs font-medium">Add a workspace folder</span>
                      </button>
                    {/if}
                  </div>
                  <button
                    type="button"
                    onclick={startHosting}
                    disabled={collaborationStore.loading ||
                      !hostWorkspacePaths.some((path) => path.trim())}
                    class="btn btn-primary w-full py-2.5 font-semibold rounded-lg"
                  >
                    {collaborationStore.loading ? 'Sharing…' : 'Share session'}
                  </button>
                </div>

                <div class="flex flex-col">
                  <h4 class="mb-1 text-sm font-semibold text-[var(--color-text-primary)]">
                    Connect to a team
                  </h4>
                  <p class="mb-4 text-xs leading-5 text-[var(--color-text-muted)]">
                    Enter the host's eight-character code. The host's join policy decides whether
                    you are admitted automatically and which access profile you receive.
                  </p>
                  <form
                    class="space-y-3"
                    onsubmit={(event) => {
                      event.preventDefault();
                      if (!collaborationStore.loading)
                        void collaborationStore.joinSession(teamJoinCode, teamGuestName || 'Guest');
                    }}
                  >
                    <input
                      bind:value={teamGuestName}
                      aria-label="Your display name"
                      placeholder="Your display name"
                      class="min-h-10 w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-1)] px-3 py-2 text-sm outline-none focus:border-[var(--color-accent)]"
                    />
                    <input
                      bind:value={teamJoinCode}
                      aria-label="Team join code"
                      aria-invalid={!!collaborationStore.joinError}
                      aria-describedby={collaborationStore.joinError
                        ? 'team-join-error'
                        : undefined}
                      oninput={() => collaborationStore.clearJoinError()}
                      autocomplete="off"
                      spellcheck="false"
                      maxlength="8"
                      placeholder="JOIN CODE"
                      class="min-h-10 w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-1)] px-3 py-2 font-mono text-base font-semibold uppercase tracking-[0.15em] outline-none focus:border-[var(--color-accent)]"
                    />
                    {#if collaborationStore.joinError}
                      <p
                        id="team-join-error"
                        role="alert"
                        class="text-xs leading-5 text-[var(--color-error)]"
                      >
                        {collaborationStore.joinError}
                      </p>
                    {/if}
                    <button
                      type="submit"
                      disabled={!teamJoinCode.trim() || collaborationStore.loading}
                      class="btn btn-primary w-full rounded-lg py-2.5 font-semibold"
                      >{collaborationStore.loading ? 'Joining…' : 'Request to join'}</button
                    >
                    <p class="text-center text-[11px] text-[var(--color-text-muted)]">
                      Browser guests can still use either signed invite link without installing
                      Koryphaios.
                    </p>
                  </form>
                </div>
              </div>
            {/if}

            <!-- ── SECOND SECTION: Share Models ── separate from collaboration;
               its own models-only invite link so it never grants session access. -->
            <div class="w-full border-t border-[var(--color-border)] pt-8">
              <ModelSharingPanel
                hostName={collaborationStore.activeCollab?.policy.hostName ||
                  teamHostName.trim() ||
                  'Host'}
              />
            </div>
          </SettingsPage>
        </div>

        <!-- Notes Tab -->
        <div
          class={activeTab === 'notes'
            ? 'notes-settings-scroll flex-1 min-h-0 overflow-y-auto overflow-x-hidden'
            : 'hidden'}
        >
          <NotesSettings onNavigate={requestSettingsCloseWith} />
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
  {#key selectorTarget.name}
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
  {/key}
{/if}

{#if showColorPicker}
  <ColorPickerModal
    open={showColorPicker}
    target={colorPickerTarget}
    scheme={colorPickerScheme}
    onClose={() => {
      showColorPicker = false;
    }}
  />
{/if}

{#if providerIconContextMenu}
  {@const contextMenu = providerIconContextMenu}
  <ProviderIconContextMenu
    id={contextMenu.id}
    providerLabel={contextMenu.providerLabel}
    hasCustomIcon={contextMenu.hasCustomIcon}
    x={contextMenu.x}
    y={contextMenu.y}
    returnFocus={contextMenu.returnFocus}
    onedit={() => editProviderIconFromContextMenu(contextMenu.providerKey, contextMenu.providerLabel)}
    onremove={() => void removeProviderIconFromContextMenu(contextMenu.providerKey)}
    onsettings={() => openProviderSettingsFromContextMenu(contextMenu.providerKey)}
    onclose={closeProviderIconContextMenu}
  />
{/if}

{#if customIconEditorTarget}
  {@const currentIcon = providersStore.getCustomProviderIcon(customIconEditorTarget.id)}
  <div
    class="fixed inset-0 z-[110] flex items-center justify-center overflow-y-auto bg-black/70 p-4 backdrop-blur-md"
    role="presentation"
    onclick={(event) => event.currentTarget === event.target && closeCustomIconEditor()}
    onkeydown={(event) => event.key === 'Escape' && closeCustomIconEditor()}
  >
    <div
      class="my-auto w-full max-w-md rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface-1)] p-5 shadow-2xl"
      role="dialog"
      aria-modal="true"
      aria-labelledby="custom-provider-icon-dialog-title"
    >
      <div class="mb-4 flex items-start justify-between gap-4">
        <div>
          <h3
            id="custom-provider-icon-dialog-title"
            class="text-base font-semibold text-[var(--color-text-primary)]"
          >
            {customIconEditorTarget.label} icon
          </h3>
          <p class="mt-1 text-xs leading-relaxed text-[var(--color-text-muted)]">
            Frame exactly what should appear throughout Koryphaios. The original image is never
            stored.
          </p>
        </div>
        <button
          type="button"
          onclick={closeCustomIconEditor}
          disabled={customIconSaving}
          class="rounded-lg p-2 text-[var(--color-text-muted)] transition-colors hover:bg-[var(--color-surface-3)] hover:text-[var(--color-text-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)]/60 disabled:opacity-50"
          aria-label="Close custom icon editor"
        >
          <X size={17} />
        </button>
      </div>

      <CustomProviderIconEditor
        id={`custom-provider-icon-${customIconEditorTarget.id}`}
        existingIconUrl={currentIcon?.url ?? null}
        initialShape={(currentIcon?.shape ?? 'rounded-square') as CustomProviderIconShape}
        disabled={customIconSaving}
        onchange={(selection) => {
          customIconDraft = selection;
          customIconEditorError = '';
        }}
        onerror={(message) => (customIconEditorError = message)}
      />

      {#if customIconEditorError}
        <div
          role="alert"
          class="mt-3 flex items-start gap-2 rounded-xl border border-[var(--color-error)]/40 bg-[var(--color-error-bg)] px-3 py-2.5 text-xs text-[var(--color-error)]"
        >
          <AlertTriangle size={14} class="mt-0.5 shrink-0" />
          <span>{customIconEditorError}</span>
        </div>
      {/if}

      <div class="mt-4 flex justify-end gap-2">
        <button
          type="button"
          onclick={closeCustomIconEditor}
          disabled={customIconSaving}
          class="btn btn-secondary px-4 py-2 text-xs">Cancel</button
        >
        <button
          type="button"
          onclick={persistCustomIconDraft}
          disabled={customIconSaving || customIconDraft === undefined}
          class="btn btn-primary px-4 py-2 text-xs"
        >
          {customIconSaving ? 'Saving…' : customIconDraft === null ? 'Remove icon' : 'Save icon'}
        </button>
      </div>
    </div>
  </div>
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
          <label class="settings-field-label" for="manage-account-label">Profile name</label>
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

<ConfirmDialog
  open={showUnsavedEditsCloseConfirmation}
  title={skillsHaveUnsavedChanges
    ? 'Discard unsaved skill edits?'
    : 'Keep unsaved Agent settings edits?'}
  message={skillsHaveUnsavedChanges
    ? agentSettingsHaveUnsavedChanges
      ? 'The Skills workspace has unsaved edits and Agent Preferences or Manager Notes have a local recovery draft. Closing now discards the skill edits held in memory. Agent editor drafts stay recoverable on this device.'
      : 'The Skills workspace has unsaved edits, including any in-progress new skill. Closing Settings now discards those in-memory edits.'
    : 'Agent Preferences or Manager Notes have unsaved edits. They are retained as a local recovery draft on this device and will be restored when you reopen Settings.'}
  confirmLabel={skillsHaveUnsavedChanges
    ? 'Discard skills and close'
    : 'Keep recovery draft and close'}
  variant="warning"
  onCancel={() => {
    showUnsavedEditsCloseConfirmation = false;
    pendingSettingsCloseAction = null;
  }}
  onConfirm={() => {
    showUnsavedEditsCloseConfirmation = false;
    skillsHaveUnsavedChanges = false;
    finishSettingsClose();
  }}
/>

<style>
  .provider-row-header {
    display: flex;
    align-items: center;
    gap: 8px;
    min-width: 0;
  }
  .provider-row-refresh {
    min-height: 32px;
    margin-right: 4px;
    white-space: nowrap;
  }
  .provider-details {
    min-width: 0;
    overflow-wrap: anywhere;
  }
  .provider-actions {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 8px;
  }
  .provider-actions > button {
    flex: 0 0 auto;
    min-height: 34px;
    padding: 6px 12px;
    font-size: 12px;
    line-height: 20px;
    white-space: nowrap;
    transition:
      background-color 150ms ease,
      border-color 150ms ease,
      color 150ms ease;
  }
  .provider-actions > .provider-icon-button {
    width: 34px;
    padding-inline: 6px;
  }
  .provider-actions > button:focus-visible,
  .provider-row-refresh:focus-visible {
    outline: 2px solid var(--color-accent);
    outline-offset: 2px;
  }
  /* Both labels occupy the same grid cell, reserving the larger intrinsic
     width. Busy updates cannot move adjacent controls or leave WebKit paint
     artifacts from an animated size change. */
  .provider-action-label {
    display: inline-grid;
  }
  .provider-action-label > span {
    grid-area: 1 / 1;
  }
  .provider-action-busy {
    visibility: hidden;
  }
  .provider-action-label.busy > .provider-action-idle {
    visibility: hidden;
  }
  .provider-action-label.busy > .provider-action-busy {
    visibility: visible;
  }
  @media (max-width: 640px) {
    .provider-row-header {
      gap: 2px;
    }
    .provider-row-toggle {
      flex-wrap: wrap;
      gap: 4px;
    }
    .provider-row-toggle > div:last-child {
      margin-left: 32px;
    }
    .provider-row-refresh {
      padding-inline: 6px;
    }
  }
  .notes-settings-scroll {
    container: notes-settings / inline-size;
  }
  .settings-frame-header {
    border-bottom-color: color-mix(in srgb, var(--color-text-muted) 14%, transparent);
  }
  .settings-navigation {
    border-right-color: color-mix(in srgb, var(--color-text-muted) 14%, transparent);
  }
  .settings-content {
    background: var(--color-surface-1);
  }
  /* Switching sections is a cross-fade, not a hard swap of opaque blocks. The
     class switches between the pane's layout and `hidden`, so the same element
     re-entering is what replays the animation. */
  .settings-content > div:not(.hidden) {
    animation: settings-pane-in var(--duration-normal) var(--ease-out);
  }
  @keyframes settings-pane-in {
    from {
      opacity: 0;
      transform: translateY(6px);
    }
    to {
      opacity: 1;
      transform: none;
    }
  }
  .settings-content :global(.input),
  .settings-content :global(input),
  .settings-content :global(textarea) {
    border-color: color-mix(in srgb, var(--color-text-muted) 17%, transparent);
    border-radius: 7px;
    background: var(--color-surface-2);
  }
  .settings-content :global(.rounded-2xl.border),
  .settings-content :global(.rounded-xl.border) {
    border-color: color-mix(in srgb, var(--color-text-muted) 14%, transparent);
    border-radius: 9px;
    box-shadow: none;
  }
  .settings-content :global(.rounded-2xl.border:hover),
  .settings-content :global(.rounded-xl.border:hover) {
    border-color: color-mix(in srgb, var(--color-text-muted) 24%, transparent);
  }
  /* Structural settings sections use surface changes and spacing for grouping.
     Borders stay available for fields, buttons, selected options, and alerts. */
  .settings-content :global(.settings-panel) {
    border: 0 !important;
    border-radius: 0 !important;
    background: transparent !important;
    box-shadow: none !important;
  }
  .settings-content :global(.billing-panel) {
    border: 1px solid color-mix(in srgb, var(--color-text-muted) 14%, transparent) !important;
    border-radius: 12px !important;
    background: var(--color-surface-2) !important;
    box-shadow: none !important;
  }
  .settings-content :global(button:focus-visible),
  .settings-content :global(input:focus-visible),
  .settings-content :global(textarea:focus-visible) {
    outline: 2px solid color-mix(in srgb, var(--color-accent) 68%, transparent);
    outline-offset: 2px;
  }
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
    color: var(--color-text-secondary);
    background: transparent;
    transition:
      color 150ms ease,
      background-color 150ms ease;
  }
  .settings-tab .settings-tab-icon {
    color: var(--color-text-muted);
    transition: color 150ms ease;
  }
  .settings-tab:hover {
    color: var(--color-text-primary);
    background: var(--color-surface-2);
  }
  .settings-tab:hover .settings-tab-icon {
    color: var(--color-text-secondary);
  }
  .settings-tab.settings-tab-active {
    color: var(--color-text-primary);
    background: var(--color-surface-3);
    font-weight: 500;
  }
  .settings-tab.settings-tab-active .settings-tab-icon {
    color: var(--color-accent);
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
