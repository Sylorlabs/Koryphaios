<script lang="ts">
  import { onDestroy, onMount, tick } from 'svelte';
  import { providersStore } from '$lib/stores/providers.svelte';
  import { theme, type ThemePreset, type AccentColor, type FontFamily } from '$lib/stores/theme.svelte';
  import { shortcutStore } from '$lib/stores/shortcuts.svelte';
import { defaultShortcuts as globalDefaultShortcuts } from '$lib/stores/shortcuts.svelte';
import { toastStore } from '$lib/stores/toast.svelte';
  import {
    Key,
    Palette,
    Keyboard,
    Check,
    Copy,
    Zap,
    Server,
    Cpu,
    X,
    User,
    Shield,
    Search,
    CreditCard,
    AlertTriangle,
    Brain,
    Bot,
    FlaskConical,
    Sparkles,
    Terminal,
    Users,
    MessageSquare,
    Type,
    RotateCcw,
    Save,
    GripVertical,
    Plus,
    Trash2,
    StickyNote,
    FolderOpen,
    RefreshCw,
    Eye,
    EyeOff,
  } from 'lucide-svelte';
  import MemoryEditor from './MemoryEditor.svelte';
  import AgentSettings from './AgentSettings.svelte';
  import ExperimentalSettings from './ExperimentalSettings.svelte';
  import ProviderIcon from './icons/ProviderIcon.svelte';
  import { memoryStore } from '$lib/stores/memory.svelte';
  import { agentSettingsStore } from '$lib/stores/agent-settings.svelte';
  import { experimentalStore } from '$lib/stores/experimental.svelte';
  import { collaborationStore } from '$lib/stores/collaboration.svelte';
  import { modeStore } from '$lib/stores/mode.svelte';
  import { notesStore } from '$lib/stores/notes.svelte';
  import { projectStore } from '$lib/stores/project.svelte';
  import { sessionStore, type NewChatBehavior } from '$lib/stores/sessions.svelte';
  import {
    NOTE_TOOL_DEFINITIONS,
    type NotePermissionLevel,
    type NotesPermissionPreset,
  } from '@koryphaios/shared';
  import ModelSelectionDialog from './ModelSelectionDialog.svelte';
  import ModeToggle from './ModeToggle.svelte';
  import TeamAccessProfiles from './TeamAccessProfiles.svelte';
  import ModelSharingPanel from './ModelSharingPanel.svelte';
  import NumberStepper from './NumberStepper.svelte';
  import SettingsSwitch from './SettingsSwitch.svelte';
  import KorySelect from './KorySelect.svelte';
  import { apiUrl } from '$lib/utils/api-url';
import { apiFetch, parseJsonResponse } from '$lib/api.svelte';
  import { dndzone } from 'svelte-dnd-action';
  import { invoke } from '@tauri-apps/api/core';

  interface Props {
    open?: boolean;
    onClose?: () => void;
  }

  let { open = false, onClose }: Props = $props();
  let activeTab = $state<'providers' | 'appearance' | 'shortcuts' | 'billing' | 'memory' | 'agent' | 'experimental' | 'teams' | 'notes'>('providers');

  let showModelSelector = $state(false);
  let selectorTarget = $state<any>(null);
  let showRotateDialog = $state(false);
  let rotateProvider = $state<{ name: string; keyType: 'apiKey' | 'authToken' } | null>(null);
  let showCodexProfileDialog = $state(false);
  let codexProfileInput = $state('');
  let codexProfileInputRef = $state<HTMLInputElement | null>(null);
  let pendingCodexAuthOptions = $state<{ saveAccount?: boolean; label?: string } | null>(null);
  let showAccountManageDialog = $state(false);
  let managingAccountProvider = $state<string | null>(null);
  let managingAccountId = $state<string | null>(null);
  let managingAccountLabel = $state('');
  let managingAccountSaving = $state(false);
  let newKeyValue = $state('');
  let teamJoinCode = $state('');
  let teamGuestName = $state('');
  let hostWorkspacePaths = $state<string[]>(projectStore.currentPath ? [projectStore.currentPath] : []);
  let hostPathsInitializedFor = $state<string | null>(projectStore.currentPath);
  let rotateKeyInput = $state<HTMLInputElement | null>(null);
  let visibleSecrets = $state<Record<string, boolean>>({});

  onMount(() => {
    const openProviderAccounts = () => {
      activeTab = 'providers';
      const ambiguous = providersStore.cliAccountSelectionRequired[0];
      if (ambiguous) {
        expandedProvider = ambiguous;
        void loadProviderAccounts(ambiguous, true);
      }
    };
    window.addEventListener('open-provider-account-settings', openProviderAccounts);
    return () => window.removeEventListener('open-provider-account-settings', openProviderAccounts);
  });

  function secretInputType(id: string): 'text' | 'password' {
    return visibleSecrets[id] ? 'text' : 'password';
  }

  function toggleSecretVisibility(id: string) {
    visibleSecrets = { ...visibleSecrets, [id]: !visibleSecrets[id] };
  }

  $effect(() => {
    const current = projectStore.currentPath;
    if (activeTab !== 'teams' || collaborationStore.activeCollab || current === hostPathsInitializedFor) return;
    hostPathsInitializedFor = current;
    if (current) hostWorkspacePaths = [current];
  });

  function updateHostWorkspacePath(index: number, value: string) {
    hostWorkspacePaths = hostWorkspacePaths.map((path, i) => i === index ? value : path);
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
    const paths = [...new Set(hostWorkspacePaths.map(path => path.trim()).filter(Boolean))];
    if (!paths.length) {
      toastStore.error('Add at least one workspace path before hosting');
      return;
    }
    if (await collaborationStore.hostSession(paths)) onClose?.();
  }

  const NOTE_PERMISSION_PRESETS: Array<{
    id: Exclude<NotesPermissionPreset, 'custom'>
    label: string
    description: string
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
  let loadedMemoryProject: string | null = null;
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
    if (open && activeTab === 'memory' && loadedMemoryProject !== projectPath) {
      loadedMemoryProject = projectPath;
      void memoryStore.loadAllMemory();
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

  $effect(() => {
    if (showCodexProfileDialog) {
      void tick().then(() => codexProfileInputRef?.focus());
    }
  });

  function handleKeydown(e: KeyboardEvent) {
    if (e.key === 'Escape' && open && onClose) onClose();
  }

  // ─── Provider Management (store-backed) ───────────────────────────────
  const {
    getProviderDisplayLabel,
    getProviderCaps,
    getProviderStatus,
    getProviderAccounts,
    usesBrowserAuth,
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
    handleFallbackDndFinalize,
    saveFallbackOrder,
    copyToClipboard,
  } = providersStore;

  function isAccountSelected(provider: string, accountId: string): boolean {
    return (providersStore.fallbackOrders[provider] ?? []).includes(accountId);
  }

  async function toggleCliAccount(provider: string, accountId: string, enabled: boolean) {
    const current = providersStore.fallbackOrders[provider] ?? [];
    const next = enabled
      ? [...current.filter((id) => id !== accountId), accountId]
      : current.filter((id) => id !== accountId);
    await saveFallbackOrder(provider, next);
    if (enabled && current.length === 0) {
      await activateProviderAccount(provider, accountId);
    }
  }

  let providersLoadAttempted = $state(false);
  let lastInitializedTab = $state<typeof activeTab | null>(null);
  let handledTeamSettingsRequest = 0;

  $effect(() => {
    if (collaborationStore.settingsRequest > handledTeamSettingsRequest) {
      handledTeamSettingsRequest = collaborationStore.settingsRequest;
      activeTab = 'teams';
    }
  });

  function showTokenInput(_name: string, _caps: ReturnType<typeof getProviderCaps>): boolean {
    return false;
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
        if (providersStore.availableProviderTypes.length === 0) void loadAvailableProviders();
        // CLI login state changes underneath us (terminal logins/logouts), so
        // detection refreshes every time the Providers tab is opened — never
        // a stale "Connected automatically" for a logged-out CLI.
        void loadDetectedClis();
      }
    } else {
      providersLoadAttempted = false;
    }

    if (activeTab === lastInitializedTab) return;
    lastInitializedTab = activeTab;

    // Project-aware effects above own Memory and Agent initialization. Calling
    // them again here caused duplicate requests and visible loading flicker.
    if (activeTab === 'experimental') void experimentalStore.loadAll();
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
  const filteredProviderList = $derived.by(() => {
    const q = providerSearchQuery.trim().toLowerCase();
    if (!q) return providersStore.providerList;
    return providersStore.providerList.filter(
      (p) => p.label.toLowerCase().includes(q) || p.key.toLowerCase().includes(q),
    );
  });
  const teamModels = $derived.by(() => providersStore.statusList
    .filter((provider) => provider.enabled && provider.authenticated)
    .flatMap((provider) => (provider.selectedModels?.length ? provider.selectedModels : provider.models)
      .map((model) => ({ id: `${provider.name}:${model}`, provider: getProviderDisplayLabel(provider.name), model, reasoningLevels: provider.allAvailableModels?.find(def => def.id === model || def.apiModelId === model)?.reasoningLevels ?? [] })))
    .filter((item, index, all) => all.findIndex(other => other.id === item.id) === index));

  let expandedProvider = $state<string | null>(null);
  let showAddCustom = $state(false);
  let customForm = $state({ label: '', kind: 'openai', baseUrl: '', apiKey: '', models: '' });
  let copiedEndpoint = $state(false);

  async function addCustomProvider() {
    const ok = await addCustomProviderToStore(customForm);
    if (ok) {
      customForm = { label: '', kind: 'openai', baseUrl: '', apiKey: '', models: '' };
      showAddCustom = false;
    }
  }

  async function deleteCustomProvider(id: string) {
    const ok = await deleteCustomProviderFromStore(id);
    if (ok) expandedProvider = null;
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

  async function handleStartBrowserAuth(
    name: string,
    options: { saveAccount?: boolean; label?: string; profileConfirmed?: boolean } = {},
  ) {
    const result = await startBrowserAuthFlow(name, options);
    if (result.kind === 'needs_codex_profile') {
      pendingCodexAuthOptions = result.options;
      codexProfileInput = result.options.label?.trim() ?? '';
      showCodexProfileDialog = true;
      return;
    }
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
    selectorTarget = status;
    showModelSelector = true;
  }

  $effect(() => {
    if (open && activeTab === 'providers' && expandedProvider) {
      void loadProviderAccounts(expandedProvider);
    }
  });

  onDestroy(() => {
    providersStore.destroy();
  });

  async function confirmCodexProfileAuth() {
    const label = codexProfileInput.trim();
    if (!label) {
      toastStore.error('Enter an account name');
      return;
    }
    const options = pendingCodexAuthOptions ?? {};
    showCodexProfileDialog = false;
    pendingCodexAuthOptions = null;
    await handleStartBrowserAuth('codex', {
      ...options,
      saveAccount: true,
      label,
      profileConfirmed: true,
    });
  }


  // ─── Shortcuts ───────────────────────────────────────────────────────
  let editingShortcutId = $state<string | null>(null);
  let capturedKeys = $state<string[]>([]);

  function startEditShortcut(id: string) { editingShortcutId = id; capturedKeys = []; }
  function handleShortcutKeydown(e: KeyboardEvent) {
    if (!editingShortcutId) return; e.preventDefault(); e.stopPropagation();
    const keys: string[] = []; if (e.ctrlKey) keys.push('Ctrl'); if (e.shiftKey) keys.push('Shift'); if (e.altKey) keys.push('Alt'); if (e.metaKey) keys.push('Meta');
    const key = e.key; if (!['Control', 'Shift', 'Alt', 'Meta'].includes(key)) keys.push(key.length === 1 ? key.toUpperCase() : key);
    if (keys.length === 0) return; capturedKeys = keys;
    if (!['Control', 'Shift', 'Alt', 'Meta'].includes(key)) {
      const shortcuts = shortcutStore.list;
      const idx = shortcuts.findIndex(s => s.id === editingShortcutId);
      if (idx >= 0) { shortcuts[idx] = { ...shortcuts[idx], keys: capturedKeys }; shortcutStore.list = [...shortcuts]; shortcutStore.save(); }
      editingShortcutId = null; capturedKeys = [];
    }
  }
  function resetShortcuts() { shortcutStore.reset(); shortcutStore.save(); toastStore.info('Shortcuts reset'); }

  // ─── Billing ─────────────────────────────────────────────────────────
  let billingLoading = $state(false);
  let billingCredits = $state<any>(null);
  let billingError = $state<string | null>(null);
  let billingSpendView = $state<'api' | 'subscription' | 'all'>('api');

  const billingSpendOptions = [
    { value: 'api', label: 'API spend', description: 'Metered API-key provider charges' },
    { value: 'subscription', label: 'Subscription spend', description: '30-day API-equivalent inference value' },
    { value: 'all', label: 'All', description: 'API spend plus subscription inference value' },
  ];

  function selectedSpendCents(): number {
    if (billingSpendView === 'subscription') return billingCredits?.subscriptionInferenceCents ?? 0;
    if (billingSpendView === 'all') return billingCredits?.allSpendCents ?? 0;
    return billingCredits?.totalSpendCents ?? 0;
  }

  function formatTokens(n: number): string {
    if (!Number.isFinite(n) || n <= 0) return '0';
    if (n >= 1e9) return (n / 1e9).toFixed(1) + 'B';
    if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
    if (n >= 1e3) return (n / 1e3).toFixed(1) + 'k';
    return String(n);
  }

  async function loadBillingCredits(forceRefresh = false) {
    billingLoading = true; billingError = null;
    try {
      const res = await apiFetch(apiUrl(`/api/billing/credits${forceRefresh ? '?refresh=1' : ''}`));
      if (!res.ok) { billingError = 'Billing API not available'; return; }
      const data = await parseJsonResponse(res);
      billingCredits = data;
    } catch (e: any) { billingError = e.message; }
    finally { billingLoading = false; }
  }
</script>

<svelte:window onkeydown={(e) => { if (editingShortcutId) handleShortcutKeydown(e); else handleKeydown(e); }} />

{#if open}
  <div class="fixed inset-0 z-50 flex min-h-0 flex-col" style="background: var(--color-surface-1);" role="dialog" aria-modal="true" aria-labelledby="settings-title">
    <!-- Header -->
    <div class="flex items-center justify-between px-6 py-4 shrink-0 border-b" style="border-color: var(--color-border); background: var(--color-surface-0);">
      <h2 id="settings-title" class="text-base font-semibold" style="color: var(--color-text-primary);">Settings</h2>
      <button type="button" class="p-1.5 rounded-lg transition-colors hover:bg-[var(--color-surface-3)]" style="color: var(--color-text-muted);" onclick={() => onClose?.()} aria-label="Close settings">
        <X size={18} />
      </button>
    </div>

    <!-- Tab bar -->
    <div class="flex gap-1 px-4 py-2 border-b shrink-0 overflow-x-auto no-scrollbar" style="background: var(--color-surface-0); border-color: var(--color-border);">
      {#each [
        { id: 'providers', label: 'Providers', icon: Key },
        { id: 'appearance', label: 'Appearance', icon: Palette },
        { id: 'shortcuts', label: 'Shortcuts', icon: Keyboard },
        { id: 'billing', label: 'Billing', icon: CreditCard, action: () => loadBillingCredits(true) },
        { id: 'memory', label: 'Memory', icon: Brain },
        { id: 'agent', label: 'Agent', icon: Bot },
        { id: 'experimental', label: 'Advanced', icon: FlaskConical },
        { id: 'teams', label: 'Teams', icon: Users },
        { id: 'notes', label: 'Notes', icon: StickyNote },
      ] as tab}
        {@const Icon = tab.icon}
        <button
          type="button"
          class="flex-1 min-w-[100px] flex items-center justify-center gap-1.5 py-2 text-xs rounded-md transition-colors whitespace-nowrap
                 {activeTab === tab.id ? 'bg-[var(--color-surface-3)] text-[var(--color-text-primary)] font-medium' : 'text-[var(--color-text-muted)] hover:text-[var(--color-text-secondary)]'}"
          onclick={() => { activeTab = tab.id as any; if (tab.action) tab.action(); }}
        >
          <Icon size={13} /> {tab.label}
        </button>
      {/each}
    </div>

    <!-- Content Area -->
    <div class="flex-1 min-h-0 overflow-hidden flex flex-col">
      <!-- Providers Tab -->
      <div class={activeTab === 'providers' ? 'flex-1 overflow-y-auto px-6 py-5 space-y-6' : 'hidden'}>
        <div class="relative">
          <Search size={14} class="absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" style="color: var(--color-text-muted);" />
          <input type="text" placeholder="Search providers..." bind:value={providerSearchQuery} class="input w-full py-2 text-sm" style="padding-left: 2.75rem;" />
        </div>

        <!-- Detected on your system — agent CLIs Koryphaios auto-picked up -->
        {#if providersStore.detectedClis.some((c) => c.installed)}
          <div class="rounded-xl border border-[var(--color-border)] p-4 bg-[var(--color-surface-1)]">
            <div class="flex items-center justify-between mb-3">
              <span class="text-sm font-semibold text-[var(--color-text-primary)]">Detected on your system</span>
              <div class="flex items-center gap-2">
                <span class="text-[10px] text-[var(--color-text-muted)]">Auto-picked up — no setup needed</span>
                <button
                  type="button"
                  class="p-1 rounded-md transition-colors hover:bg-[var(--color-surface-3)]"
                  style="color: var(--color-text-muted);"
                  title="Re-check installed CLIs"
                  aria-label="Re-check installed CLIs"
                  onclick={() => void loadDetectedClis()}
                >
                  <RefreshCw size={12} />
                </button>
              </div>
            </div>
            <div class="space-y-2.5">
              {#each providersStore.detectedClis.filter((c) => c.installed) as cli (cli.id)}
                <div class="flex items-start gap-3">
                  <span
                    class="mt-1.5 h-2 w-2 rounded-full flex-shrink-0"
                    style="background: {cli.autoEnabled
                      ? 'var(--color-success, #22c55e)'
                      : cli.loggedIn
                        ? 'var(--color-warning, #f59e0b)'
                        : 'var(--color-text-muted)'};"
                  ></span>
                  <div class="min-w-0 flex-1">
                    <div class="flex items-center gap-2 flex-wrap">
                      <span class="text-sm font-medium text-[var(--color-text-primary)]">{cli.displayName}</span>
                      {#if cli.autoEnabled}
                        <span class="text-[10px] px-1.5 py-0.5 rounded-full font-medium" style="background: var(--color-success-bg, rgba(34,197,94,0.15)); color: var(--color-success, #22c55e);">Connected automatically</span>
                      {:else if cli.loggedIn}
                        <span class="text-[10px] px-1.5 py-0.5 rounded-full font-medium" style="background: var(--color-warning-bg, rgba(245,158,11,0.15)); color: var(--color-warning, #f59e0b);">Logged in — connect below</span>
                      {:else}
                        <span class="text-[10px] text-[var(--color-text-muted)]">Installed — not logged in</span>
                      {/if}
                    </div>
                    <p class="text-[10px] text-[var(--color-text-muted)] leading-relaxed mt-0.5">
                      {cli.note}
                      {#if cli.docsUrl && !cli.autoEnabled}
                        <a href={cli.docsUrl} target="_blank" rel="noreferrer" class="underline hover:text-[var(--color-accent)]">Setup guide</a>
                      {/if}
                    </p>
                  </div>
                </div>
              {/each}
            </div>
          </div>
        {/if}

        <!-- Add a custom (bring-your-own) provider -->
        <div class="rounded-xl border border-dashed border-[var(--color-border)] p-4 bg-[var(--color-surface-1)] transition-colors duration-150 hover:border-[var(--color-accent)] hover:bg-[var(--color-surface-2)]">
          <button type="button" onclick={() => (showAddCustom = !showAddCustom)} class="group w-full flex items-center justify-between text-left cursor-pointer">
            <div class="flex items-center gap-2">
              <span class="flex h-7 w-7 items-center justify-center rounded-lg bg-[var(--color-accent)]/10 transition-colors duration-150 group-hover:bg-[var(--color-accent)]/20">
                <Plus size={15} style="color: var(--color-accent);" />
              </span>
              <span class="text-sm font-semibold text-[var(--color-text-primary)] transition-colors duration-150 group-hover:text-[var(--color-accent)]">Add a custom provider</span>
            </div>
            <span class="text-[10px] text-[var(--color-text-muted)] transition-colors duration-150 group-hover:text-[var(--color-text-secondary)]">OpenAI-compatible &amp; more</span>
          </button>
          {#if showAddCustom}
            <div class="mt-4 space-y-3 pt-4 border-t border-[var(--color-border)]">
              <p class="text-[10px] text-[var(--color-text-muted)] leading-relaxed">
                Bring your own endpoint — works with any OpenAI-compatible API (vLLM, LiteLLM, LM Studio, self-hosted gateways, OpenRouter-style services), plus Anthropic- and Gemini-compatible servers. Models are auto-fetched from <code>/models</code> when available, or list them explicitly below.
              </p>
              <div class="space-y-1">
                <label class="text-[10px] uppercase tracking-wider text-[var(--color-text-muted)] font-medium" for="custom-label">Display name</label>
                <input id="custom-label" type="text" placeholder="My LLM" bind:value={customForm.label} class="input w-full text-xs" />
              </div>
              <div class="space-y-1">
                <label class="text-[10px] uppercase tracking-wider text-[var(--color-text-muted)] font-medium" for="custom-kind">API format</label>
                <KorySelect value={customForm.kind} label="Custom provider API format" options={[
                  { value:'openai', label:'OpenAI-compatible', description:'/v1/chat/completions' },
                  { value:'anthropic', label:'Anthropic-compatible', description:'/v1/messages' },
                  { value:'gemini', label:'Gemini-compatible' },
                ]} onchange={(value) => customForm.kind = value as typeof customForm.kind} />
              </div>
              <div class="space-y-1">
                <label class="text-[10px] uppercase tracking-wider text-[var(--color-text-muted)] font-medium" for="custom-url">Base URL</label>
                <input id="custom-url" type="text" placeholder="https://api.example.com/v1" bind:value={customForm.baseUrl} class="input w-full text-xs" />
              </div>
              <div class="space-y-1">
                <label class="text-[10px] uppercase tracking-wider text-[var(--color-text-muted)] font-medium" for="custom-key">API key <span class="opacity-60 normal-case">(optional — leave blank if not required)</span></label>
                <div class="relative">
                  <input id="custom-key" type={secretInputType('custom-key')} placeholder="sk-..." bind:value={customForm.apiKey} class="input w-full text-xs" style="padding-right: 2.75rem;" />
                  <button type="button" class="secret-visibility absolute inset-y-0 right-1 my-auto z-10" onclick={() => toggleSecretVisibility('custom-key')} aria-label={visibleSecrets['custom-key'] ? 'Hide API key' : 'Show API key'} title={visibleSecrets['custom-key'] ? 'Hide API key' : 'Show API key'}>
                    {#if visibleSecrets['custom-key']}<EyeOff size={15} />{:else}<Eye size={15} />{/if}
                  </button>
                </div>
              </div>
              <div class="space-y-1">
                <label class="text-[10px] uppercase tracking-wider text-[var(--color-text-muted)] font-medium" for="custom-models">Models <span class="opacity-60 normal-case">(optional, comma-separated)</span></label>
                <input id="custom-models" type="text" placeholder="my-model-a, my-model-b — or leave blank to auto-fetch" bind:value={customForm.models} class="input w-full text-xs" />
              </div>
              <button type="button" onclick={addCustomProvider} disabled={providersStore.addingCustom} class="btn btn-primary w-full text-xs py-2">{providersStore.addingCustom ? 'Adding…' : 'Add provider'}</button>
            </div>
          {/if}
        </div>

        <div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4 items-start">
          {#each filteredProviderList as prov (prov.key)}
            {@const status = getProviderStatus(prov.key)}
            {@const caps = getProviderCaps(prov.key)}
            <div class="rounded-xl border border-[var(--color-border)] p-4 transition-all {expandedProvider === prov.key ? 'bg-[var(--color-surface-2)] ring-1 ring-[var(--color-accent)]/30' : 'bg-[var(--color-surface-1)] hover:bg-[var(--color-surface-2)] shadow-sm'}">
              <button type="button" onclick={() => expandedProvider = expandedProvider === prov.key ? null : prov.key} class="w-full flex items-center justify-between text-left group">
                <div class="flex items-center gap-3">
                  <div class="w-8 h-8 rounded-lg bg-[var(--color-surface-3)] flex items-center justify-center p-1.5 shrink-0 overflow-hidden">
                    <ProviderIcon provider={prov.key} size={20} class="w-full h-full" />
                  </div>
                  <div>
                    <span class="text-sm font-semibold text-[var(--color-text-primary)]">{status?.label ?? prov.label}</span>
                    <p class="text-[10px] text-[var(--color-text-muted)] group-hover:text-[var(--color-text-secondary)]">
                      {#if status?.deployment === 'cloud'}
                        Cloud agent · sync via git pull / gh pr checkout
                      {:else if status?.authenticated}
                        {@const selectedCount = status.models?.length ?? 0}
                        {@const availableCount = status.allAvailableModels?.length ?? 0}
                        Connected{availableCount > 0 ? ` · ${selectedCount > 0 ? selectedCount : '—'}/${availableCount} enabled` : ' · —'}
                      {:else}
                        Not configured
                      {/if}
                    </p>
                  </div>
                </div>
                <div class="flex items-center gap-2">
                  {#if status?.authenticated}
                    <div class="flex items-center gap-1.5 px-2 py-0.5 rounded-full bg-emerald-500/10 text-emerald-400 text-[9px] font-bold">
                      <span class="w-1 h-1 rounded-full bg-emerald-400"></span>
                      {(status.allAvailableModels?.length ?? status.models?.length ?? 0) > 0 ? (status.allAvailableModels?.length ?? status.models?.length) : '—'}
                    </div>
                  {:else}
                    <div class="w-2 h-2 rounded-full bg-yellow-500/50 ring-4 ring-yellow-500/10"></div>
                  {/if}
                </div>
              </button>
              {#if expandedProvider === prov.key}
                {@const caps = getProviderCaps(prov.key)}
                <div class="mt-4 space-y-3 pt-4 border-t border-[var(--color-border)]">
                  {#if status?.description}
                    <p class="text-[10px] text-[var(--color-text-muted)] leading-relaxed">{status.description}</p>
                  {/if}
                  {#if status?.deployment === 'cloud'}
                    <div class="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full bg-violet-500/10 text-violet-300 text-[9px] font-semibold uppercase tracking-wide">
                      Cloud — changes land on GitHub first
                    </div>
                  {/if}
                  {#if status?.authenticated}
                    <div class="flex items-center justify-between">
                      <div class="text-[10px] text-[var(--color-text-muted)]">
                        {(status.models?.length ?? 0) > 0 ? status.models?.length : '—'} enabled of {(status.allAvailableModels?.length ?? 0) > 0 ? status.allAvailableModels?.length : '—'} available
                      </div>
                      <button type="button" onclick={() => { selectorTarget = status; showModelSelector = true; }} class="btn btn-secondary text-[10px] py-1 px-3">Manage Models</button>
                      {#if caps.supportsApiKey && !usesBrowserAuth(prov.key)}
                        <button
                          type="button"
                          onclick={() => { rotateProvider = { name: prov.key, keyType: 'apiKey' }; showRotateDialog = true; }}
                          class="inline-flex items-center gap-1 text-[10px] text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)] font-medium transition-colors"
                          title="Replace the stored API key without disconnecting"
                        >
                          <RotateCcw size={10} /> Rotate key
                        </button>
                      {/if}
                      <button type="button" onclick={() => disconnectProvider(prov.key)} class="text-[10px] text-red-400 hover:text-red-300 font-medium transition-colors">Disconnect</button>
                    </div>
                  {:else}
                    <div class="space-y-2">
                      {#if caps.supportsApiKey}
                        <label class="text-[10px] text-[var(--color-text-muted)] font-medium uppercase tracking-wider" for={`provider-key-${prov.key}`}>API Key</label>
                        <div class="relative">
                          <input id={`provider-key-${prov.key}`} type={secretInputType(`provider-key-${prov.key}`)} placeholder={prov.placeholder} bind:value={providersStore.keyInputs[prov.key]} class="input w-full text-xs" style="padding-right: 2.75rem;" onkeydown={(e) => e.key === 'Enter' && handleConnectProvider(prov.key)} />
                          <button type="button" class="secret-visibility absolute inset-y-0 right-1 my-auto z-10" onclick={() => toggleSecretVisibility(`provider-key-${prov.key}`)} aria-label={visibleSecrets[`provider-key-${prov.key}`] ? 'Hide API key' : 'Show API key'} title={visibleSecrets[`provider-key-${prov.key}`] ? 'Hide API key' : 'Show API key'}>
                            {#if visibleSecrets[`provider-key-${prov.key}`]}<EyeOff size={15} />{:else}<Eye size={15} />{/if}
                          </button>
                        </div>
                      {/if}
                      {#if showTokenInput(prov.key, caps)}
                        <label class="text-[10px] text-[var(--color-text-muted)] font-medium uppercase tracking-wider" for={`provider-token-${prov.key}`}>Auth Token</label>
                        <div class="relative">
                          <input id={`provider-token-${prov.key}`} type={secretInputType(`provider-token-${prov.key}`)} placeholder={providersStore.tokenPlaceholders[prov.key] ?? 'Auth token'} bind:value={providersStore.tokenInputs[prov.key]} class="input w-full pr-11 text-xs" onkeydown={(e) => e.key === 'Enter' && handleConnectProvider(prov.key)} />
                          <button type="button" class="secret-visibility absolute inset-y-0 right-1 my-auto z-10" onclick={() => toggleSecretVisibility(`provider-token-${prov.key}`)} aria-label={visibleSecrets[`provider-token-${prov.key}`] ? 'Hide auth token' : 'Show auth token'}>
                            {#if visibleSecrets[`provider-token-${prov.key}`]}<EyeOff size={15} />{:else}<Eye size={15} />{/if}
                          </button>
                        </div>
                      {/if}
                      {#if caps.requiresBaseUrl}
                        <label class="text-[10px] text-[var(--color-text-muted)] font-medium uppercase tracking-wider" for={`provider-url-${prov.key}`}>Endpoint URL</label>
                        <input id={`provider-url-${prov.key}`} type="text" placeholder={caps.baseUrlPlaceholder ?? 'https://...'} bind:value={providersStore.urlInputs[prov.key]} class="input w-full text-xs" onkeydown={(e) => e.key === 'Enter' && handleConnectProvider(prov.key)} />
                      {/if}
                      {#if usesBrowserAuth(prov.key)}
                        <div class="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-0)]/80 p-3 space-y-2">
                          {#if providersStore.browserAuthMessages[prov.key]}
                            <p class="text-[10px] text-[var(--color-text-muted)]">{providersStore.browserAuthMessages[prov.key]}</p>
                          {/if}
                          <!-- One shared device-code panel for every device-code
                               provider — identical copy, code, copy-button, and
                               waiting line, so no provider gets a lesser flow. -->
                          {#if prov.key === 'copilot' || prov.key === 'kimicode' || prov.key === 'codex'}
                            {@const deviceAuth =
                              prov.key === 'copilot' ? providersStore.copilotDeviceAuth
                              : prov.key === 'kimicode' ? providersStore.kimicodeDeviceAuth
                              : providersStore.codexDeviceAuth}
                            {#if deviceAuth}
                            {@const userCode = deviceAuth.userCode}
                            <div class="rounded-md bg-[var(--color-surface-2)] px-2.5 py-2 text-[10px] text-[var(--color-text-secondary)]">
                              <div class="font-medium text-[var(--color-text-primary)]">{getProviderDisplayLabel(prov.key)} sign-in needs approval.</div>
                              <div class="mt-1">The browser was opened automatically.</div>
                              <div>Paste this code if you're asked for it.</div>
                              <div class="mt-2 flex items-center gap-2">
                                <span>Code:</span>
                                <span class="font-semibold tracking-[0.18em] text-[var(--color-text-primary)]">{userCode}</span>
                                <button
                                  type="button"
                                  class="inline-flex items-center gap-1 rounded border border-[var(--color-border)] px-1.5 py-0.5 text-[10px] hover:bg-[var(--color-surface-3)]"
                                  onclick={() => copyToClipboard(userCode, 'deviceCode')}
                                >
                                  <Copy size={10} />
                                  {providersStore.copiedDeviceCode === userCode ? 'Copied' : 'Copy code'}
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
                              {providersStore.browserAuthBusy === prov.key && !providersStore.browserAuthPending[prov.key]
                                ? 'Opening...'
                                : 'Auth'}
                            </button>
                            {#if providersStore.browserAuthPending[prov.key] && prov.key !== 'copilot' && prov.key !== 'codex' && prov.key !== 'kimicode'}
                              <button
                                type="button"
                                onclick={() => handleFinishBrowserAuth(prov.key)}
                                disabled={providersStore.browserAuthBusy === prov.key}
                                class="btn btn-primary flex-1 text-[10px] py-2 shadow-lg shadow-[var(--color-accent)]/10"
                              >
                                {providersStore.browserAuthBusy === prov.key && providersStore.browserAuthPending[prov.key] ? 'Checking...' : 'I Finished Sign-In'}
                              </button>
                            {/if}
                          </div>
                        </div>
                      {/if}
                      {#if usesBrowserAuth(prov.key) && caps.supportsApiKey}
                        <div class="flex items-center gap-3 py-1">
                          <div class="flex-1 border-t border-[var(--color-border)]"></div>
                          <span class="text-[9px] text-[var(--color-text-muted)] uppercase tracking-wider font-medium">or use API key</span>
                          <div class="flex-1 border-t border-[var(--color-border)]"></div>
                        </div>
                        <button type="button" onclick={() => handleConnectProvider(prov.key)} disabled={providersStore.saving === prov.key} class="btn btn-primary w-full text-xs py-2 shadow-lg shadow-[var(--color-accent)]/10">{providersStore.saving === prov.key ? 'Testing...' : 'Connect with API Key'}</button>
                      {:else if !usesBrowserAuth(prov.key)}
                        <button type="button" onclick={() => handleConnectProvider(prov.key)} disabled={providersStore.saving === prov.key} class="btn btn-primary w-full text-xs py-2 shadow-lg shadow-[var(--color-accent)]/10">{providersStore.saving === prov.key ? 'Testing...' : 'Connect Provider'}</button>
                      {/if}
                      {#if prov.key.startsWith('custom:')}
                        <button type="button" onclick={() => deleteCustomProvider(prov.key)} class="btn btn-ghost w-full text-[10px] py-1.5 mt-1 text-red-400 hover:bg-red-500/10 flex items-center justify-center gap-1.5">
                          <Trash2 size={12} /> Remove this custom provider
                        </button>
                      {/if}
                    </div>
                  {/if}
                  <div class="space-y-3 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-0)]/70 p-3">
                    <div class="flex items-center justify-between gap-3">
                      <div>
                        <p class="text-[10px] font-semibold uppercase tracking-[0.2em] text-[var(--color-text-muted)]">Saved Accounts</p>
                        <p class="text-[11px] text-[var(--color-text-muted)]">Keep multiple keys or account logins per provider and switch between them.</p>
                      </div>
                      <button type="button" onclick={() => loadProviderAccounts(prov.key, true)} class="text-[10px] text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)]">Refresh</button>
                    </div>

                    {#if providersStore.accountsLoading[prov.key]}
                      <p class="text-[11px] text-[var(--color-text-muted)]">Loading saved accounts...</p>
                    {:else if getProviderAccounts(prov.key).length === 0}
                      <p class="text-[11px] text-[var(--color-text-muted)]">No saved accounts yet.</p>
                    {:else}
                      <div class="space-y-2">
                        {#each getProviderAccounts(prov.key) as account (account.id)}
                          <div class="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-1)] p-2.5">
                            {#if account.source === 'cli-autodetect'}
                              <SettingsSwitch
                                compact
                                checked={isAccountSelected(prov.key, account.id)}
                                label={account.email ?? account.label}
                                description={[
                                  account.plan ? `${account.plan.toUpperCase()} plan` : 'Plan not reported by CLI',
                                  account.health === 'ready' ? 'Login ready' : account.health === 'expired' ? 'Login expired' : 'Login status unverified',
                                  account.profileDir,
                                ].filter(Boolean).join(' · ')}
                                onchange={() => toggleCliAccount(prov.key, account.id, !isAccountSelected(prov.key, account.id))}
                              />
                            {:else}
                            <div class="flex items-start justify-between gap-3">
                              <div>
                                <div class="text-xs font-semibold text-[var(--color-text-primary)]">{account.label}</div>
                                <div class="mt-1 text-[10px] text-[var(--color-text-muted)]">
                                  {[
                                    account.hasApiKey ? 'API key' : null,
                                    account.hasAuthToken ? 'Auth token' : null,
                                    account.hasBaseUrl ? 'Endpoint URL' : null,
                                  ].filter(Boolean).join(' • ')}
                                </div>
                              </div>
                              <div class="flex items-center gap-2">
                                <button
                                  type="button"
                                  onclick={() => activateProviderAccount(prov.key, account.id)}
                                  disabled={providersStore.accountBusy === `${prov.key}:activate:${account.id}`}
                                  class="btn btn-secondary text-[10px] px-2.5 py-1"
                                >
                                  {providersStore.accountBusy === `${prov.key}:activate:${account.id}` ? 'Activating...' : 'Activate'}
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
                                  onclick={() => deleteProviderAccount(prov.key, account.id)}
                                  disabled={providersStore.accountBusy === `${prov.key}:delete:${account.id}`}
                                  class="text-[10px] text-red-400 hover:text-red-300 font-medium transition-colors"
                                >
                                  {providersStore.accountBusy === `${prov.key}:delete:${account.id}` ? 'Removing...' : 'Delete'}
                                </button>
                              </div>
                            </div>
                            {/if}
                          </div>
                        {/each}
                      </div>
                    {/if}

                    <div class="space-y-2 pt-2 border-t border-[var(--color-border)]">
                      <input
                        type="text"
                        placeholder="Label this saved account"
                        bind:value={providersStore.accountLabelInputs[prov.key]}
                        class="input w-full text-xs"
                      />
                      {#if caps.supportsApiKey}
                        <div class="relative">
                          <input type={secretInputType(`account-key-${prov.key}`)} placeholder={prov.placeholder} bind:value={providersStore.accountKeyInputs[prov.key]} class="input w-full pr-11 text-xs" />
                          <button type="button" class="secret-visibility absolute inset-y-0 right-1 my-auto z-10" onclick={() => toggleSecretVisibility(`account-key-${prov.key}`)} aria-label={visibleSecrets[`account-key-${prov.key}`] ? 'Hide account API key' : 'Show account API key'}>
                            {#if visibleSecrets[`account-key-${prov.key}`]}<EyeOff size={15} />{:else}<Eye size={15} />{/if}
                          </button>
                        </div>
                      {/if}
                      {#if showTokenInput(prov.key, caps)}
                        <div class="relative">
                          <input type={secretInputType(`account-token-${prov.key}`)} placeholder={providersStore.tokenPlaceholders[prov.key] ?? 'Auth token'} bind:value={providersStore.accountTokenInputs[prov.key]} class="input w-full pr-11 text-xs" />
                          <button type="button" class="secret-visibility absolute inset-y-0 right-1 my-auto z-10" onclick={() => toggleSecretVisibility(`account-token-${prov.key}`)} aria-label={visibleSecrets[`account-token-${prov.key}`] ? 'Hide account auth token' : 'Show account auth token'}>
                            {#if visibleSecrets[`account-token-${prov.key}`]}<EyeOff size={15} />{:else}<Eye size={15} />{/if}
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
                      {#if prov.key === 'codex'}
                        <button
                          type="button"
                          onclick={() => handleStartBrowserAuth('codex', { saveAccount: true, label: providersStore.accountLabelInputs[prov.key] })}
                          disabled={providersStore.browserAuthBusy === 'codex'}
                          class="btn btn-primary w-full text-[10px] py-2 shadow-lg shadow-[var(--color-accent)]/10"
                        >
                          {providersStore.browserAuthBusy === 'codex' ? 'Opening...' : 'Auth'}
                        </button>
                      {:else if usesBrowserAuth(prov.key)}
                        <p class="text-[11px] text-[var(--color-text-muted)]">
                          This provider connects through browser sign-in instead of manual saved credentials.
                        </p>
                        <button
                          type="button"
                          onclick={() => handleStartBrowserAuth(prov.key)}
                          disabled={providersStore.browserAuthBusy === prov.key}
                          class="btn btn-primary w-full text-[10px] py-2 shadow-lg shadow-[var(--color-accent)]/10"
                        >
                          {providersStore.browserAuthBusy === prov.key ? 'Opening...' : 'Auth'}
                        </button>
                      {:else}
                        <div class="flex gap-2">
                          <button
                            type="button"
                            onclick={() => saveProviderAccount(prov.key, false)}
                            disabled={providersStore.accountBusy === `${prov.key}:save`}
                            class="btn btn-secondary flex-1 text-[10px] py-2"
                          >
                            {providersStore.accountBusy === `${prov.key}:save` ? 'Saving...' : 'Save Account'}
                          </button>
                          <button
                            type="button"
                            onclick={() => saveProviderAccount(prov.key, true)}
                            disabled={providersStore.accountBusy === `${prov.key}:save`}
                            class="btn btn-primary flex-1 text-[10px] py-2 shadow-lg shadow-[var(--color-accent)]/10"
                          >
                            {providersStore.accountBusy === `${prov.key}:save` ? 'Saving...' : 'Save + Activate'}
                          </button>
                        </div>
                      {/if}
                    </div>
                  </div>
                  {#if getProviderAccounts(prov.key).length >= 2}
                    {@const orderedAccounts = getOrderedFallbackAccounts(prov.key)}
                    <div class="space-y-3 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-0)]/70 p-3">
                      <div class="flex items-center justify-between gap-3">
                        <div>
                          <p class="text-[10px] font-semibold uppercase tracking-[0.2em] text-[var(--color-text-muted)]">Fallback Order</p>
                          <p class="text-[11px] text-[var(--color-text-muted)]">Drag to set priority. When the active account fails, the next one is tried automatically.</p>
                        </div>
                        {#if providersStore.fallbackSaving === prov.key}
                          <span class="text-[10px] text-[var(--color-text-muted)]">Saving...</span>
                        {/if}
                      </div>
                      <div
                        class="space-y-2"
                        use:dndzone={{ items: orderedAccounts, dragDisabled: false }}
                        onfinalize={(e) => handleFallbackDndFinalize(prov.key, e.detail.items)}
                      >
                        {#each orderedAccounts as account, i (account.id)}
                          <div class="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-1)] p-2.5 flex items-center gap-2.5 cursor-grab active:cursor-grabbing">
                            <GripVertical size={14} class="text-[var(--color-text-muted)] shrink-0" />
                            <span class="text-[10px] font-bold text-[var(--color-accent)] shrink-0 w-5 text-center">{i + 1}</span>
                            <div class="flex-1 min-w-0">
                              <div class="text-xs font-semibold text-[var(--color-text-primary)] truncate">{account.label}</div>
                              <div class="text-[10px] text-[var(--color-text-muted)]">
                                {[
                                  account.hasApiKey ? 'API key' : null,
                                  account.hasAuthToken ? 'Auth token' : null,
                                  account.hasBaseUrl ? 'Endpoint URL' : null,
                                ].filter(Boolean).join(' · ')}
                              </div>
                            </div>
                            <span class="text-[9px] uppercase tracking-wider text-[var(--color-text-muted)] shrink-0">{i === 0 ? '1st' : i === 1 ? '2nd' : i === 2 ? '3rd' : `${i + 1}th`}</span>
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
      </div>

      <!-- Appearance Tab -->
      <div class={activeTab === 'appearance' ? 'flex-1 overflow-y-auto px-6 py-5 space-y-10 w-full max-w-7xl mx-auto' : 'hidden'}>
        <section>
          <div class="flex items-center gap-3 mb-6">
            <Palette size={20} class="text-[var(--color-accent)]" />
            <div>
              <h3 class="text-base font-bold text-[var(--color-text-primary)]">Theme Presets</h3>
              <p class="text-xs text-[var(--color-text-muted)]">Select your preferred application color scheme</p>
            </div>
          </div>
          <div class="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-5 gap-4">
            <!-- Static per-theme preview colors so each card shows its actual palette -->
          {#each theme.presets as t}
            {@const previewColors: Record<string, { bg: string; s1: string; s2: string; border: string; accent: string }> = {
              kintsugi:    { bg: '#0D0B0A', s1: '#141210', s2: '#1C1917', border: 'rgba(213, 178, 97, 0.16)', accent: '#D5B261' },
              midnight:    { bg: '#0a0a0b', s1: '#111113', s2: '#1a1a1e', border: '#2a2a30', accent: '#6366f1' },
              nord:        { bg: '#2e3440', s1: '#3b4252', s2: '#434c5e', border: '#4c566a', accent: '#81a1c1' },
              dracula:     { bg: '#1e1f29', s1: '#282a36', s2: '#2d303e', border: '#44475a', accent: '#ff79c6' },
              catppuccin:  { bg: '#1e1e2e', s1: '#24243a', s2: '#2a2a42', border: '#3a3a52', accent: '#cba6f7' },
              gruvbox:     { bg: '#1d2021', s1: '#282828', s2: '#32302f', border: '#504945', accent: '#fabd2f' },
              tokyo:       { bg: '#1a1b26', s1: '#1f2335', s2: '#24283b', border: '#343b58', accent: '#7aa2f7' },
              solarized:   { bg: '#002b36', s1: '#073642', s2: '#0b3f4a', border: '#1a5563', accent: '#268bd2' },
              light:       { bg: '#ffffff', s1: '#f8f9fa', s2: '#f1f3f5', border: '#dee2e6', accent: '#2563eb' },
              system:      { bg: '#f8f9fa', s1: '#141210', s2: '#262220', border: '#dee2e6', accent: '#D5B261' },
            }}
            {@const colors = previewColors[t.id] ?? previewColors.kintsugi}
            <button 
              type="button"
              class="group relative flex flex-col gap-3 p-3 rounded-xl border transition-all 
                     {theme.preset === t.id ? 'border-[var(--color-accent)] bg-[var(--color-surface-2)] shadow-lg' : 'border-[var(--color-border)] bg-[var(--color-surface-1)] hover:border-[var(--color-text-muted)]'}" 
              onclick={() => theme.setPreset(t.id as ThemePreset)}
            >
              <div class="w-full h-20 rounded-lg flex overflow-hidden shadow-inner border border-black/20" style="background: {colors.bg};">
                <!-- Mini Sidebar -->
                <div class="w-1/4 h-full border-r border-black/20 p-1.5 flex flex-col gap-1.5" style="background: {colors.s1}; border-color: {colors.border};">
                  <div class="w-full h-1.5 rounded-sm opacity-60" style="background: {colors.s2};"></div>
                  <div class="w-2/3 h-1.5 rounded-sm opacity-60" style="background: {colors.s2};"></div>
                  <div class="w-3/4 h-1.5 rounded-sm opacity-60" style="background: {colors.s2};"></div>
                </div>
                <!-- Mini Main Content -->
                <div class="flex-1 flex flex-col">
                  <!-- Header -->
                  <div class="h-4 w-full flex items-center px-2 border-b border-black/20" style="background: {colors.bg}; border-color: {colors.border};">
                    <div class="w-4 h-1 rounded-full" style="background: {colors.accent};"></div>
                  </div>
                  <!-- Chat Area -->
                  <div class="flex-1 p-2 flex flex-col gap-1.5 justify-end" style="background: {colors.bg};">
                    <!-- User bubble -->
                    <div class="self-end w-3/4 rounded shrink-0 p-1 shadow-sm" style="background: {colors.accent};">
                      <div class="h-[3px] w-full bg-white/40 rounded-full"></div>
                    </div>
                    <!-- Assistant bubble -->
                    <div class="self-start w-5/6 rounded shrink-0 border border-black/10 p-1" style="background: {colors.s1}; border-color: {colors.border};">
                      <div class="h-[3px] w-full opacity-50 mb-0.5 rounded-full" style="background: {colors.s2};"></div>
                      <div class="h-[3px] w-2/3 opacity-50 rounded-full" style="background: {colors.s2};"></div>
                    </div>
                  </div>
                </div>
              </div>
              <span class="text-xs font-semibold capitalize transition-colors {theme.preset === t.id ? 'text-[var(--color-accent)]' : 'text-[var(--color-text-secondary)]'}">{t.label}</span>
              {#if theme.preset === t.id}
                <div class="absolute -top-1 -right-1 w-5 h-5 bg-[var(--color-accent)] rounded-full flex items-center justify-center text-[var(--color-surface-0)] shadow-md">
                  <Check size={12} strokeWidth={3} />
                </div>
              {/if}
            </button>
          {/each}
        </div>
      </section>

        <section>
          <div class="flex items-center gap-3 mb-6">
            <Zap size={20} class="text-[var(--color-accent)]" />
            <div>
              <h3 class="text-base font-bold text-[var(--color-text-primary)]">Accent Color</h3>
              <p class="text-xs text-[var(--color-text-muted)]">Customize the primary interaction color</p>
            </div>
          </div>
          <div class="flex flex-wrap gap-4 p-4 rounded-2xl bg-[var(--color-surface-2)] border border-[var(--color-border)]">
            {#each theme.accents as color}
              <button 
                type="button"
                class="group relative w-12 h-12 rounded-xl transition-all hover:scale-110 active:scale-95 shadow-md
                       {theme.accent === color.id ? 'ring-2 ring-[var(--color-text-primary)] ring-offset-4 ring-offset-[var(--color-surface-2)]' : 'opacity-80 hover:opacity-100'}" 
                style="background-color: {color.color};" 
                onclick={() => theme.setAccent(color.id as AccentColor)}
                title={color.label}
              >
                {#if theme.accent === color.id}
                  <Check size={20} class="mx-auto text-white drop-shadow-md" strokeWidth={3} />
                {/if}
              </button>
            {/each}
          </div>
        </section>

        <section>
          <div class="flex items-center gap-3 mb-6">
            <Type size={20} class="text-[var(--color-accent)]" />
            <div>
              <h3 class="text-base font-bold text-[var(--color-text-primary)]">Typography</h3>
              <p class="text-xs text-[var(--color-text-muted)]">Choose the font family for the interface</p>
            </div>
          </div>
          {#each [...new Set(theme.fonts.map(f => f.category))] as category}
            <div class="mb-6">
              <p class="text-[10px] font-bold uppercase tracking-[0.2em] text-[var(--color-text-muted)] mb-3">{category}</p>
              <div class="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-3">
                {#each theme.fonts.filter(f => f.category === category) as f}
                  <button 
                    type="button"
                    class="flex flex-col gap-2 p-4 rounded-xl border transition-all text-left
                           {theme.font === f.id ? 'border-[var(--color-accent)] bg-[var(--color-surface-2)] shadow-lg shadow-[var(--color-accent)]/5' : 'border-[var(--color-border)] bg-[var(--color-surface-1)] hover:bg-[var(--color-surface-2)] hover:border-[var(--color-text-muted)]'}" 
                    onclick={() => theme.setFont(f.id as FontFamily)}
                  >
                    <span class="text-[10px] font-medium text-[var(--color-text-muted)]">{f.label}</span>
                    <span class="text-lg leading-tight" style="font-family: {theme.getFontFamily(f.id as FontFamily)}">Koryphaios</span>
                    <span class="text-[10px] opacity-50" style="font-family: {theme.getFontFamily(f.id as FontFamily)}">The quick brown fox</span>
                    {#if theme.font === f.id}
                      <div class="mt-1 flex items-center gap-1.5 text-[var(--color-accent)] font-bold text-[10px] uppercase tracking-tighter">
                        <Check size={10} strokeWidth={3} /> Active
                      </div>
                    {/if}
                  </button>
                {/each}
              </div>
            </div>
          {/each}
        </section>
      </div>

      <!-- Shortcuts Tab -->
      <div class={activeTab === 'shortcuts' ? 'flex-1 overflow-y-auto px-6 py-5 space-y-6 w-full max-w-7xl mx-auto' : 'hidden'}>
        <div class="flex items-center justify-between mb-4">
          <div>
            <h3 class="text-base font-bold text-[var(--color-text-primary)]">Keyboard Shortcuts</h3>
            <p class="text-xs text-[var(--color-text-muted)]">Customizable global key bindings</p>
          </div>
          <button type="button" onclick={resetShortcuts} class="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-red-500/10 text-red-400 text-xs font-medium hover:bg-red-500/20 transition-colors">
            <RotateCcw size={12} /> Reset to Defaults
          </button>
        </div>
        <div class="grid grid-cols-1 md:grid-cols-2 gap-3">
          {#each shortcutStore.list as shortcut}
            <div class="group flex items-center justify-between p-4 bg-[var(--color-surface-2)] rounded-xl border border-[var(--color-border)] transition-colors hover:border-[var(--color-text-muted)]">
              <div>
                <div class="text-sm font-semibold text-[var(--color-text-primary)]">{shortcut.action}</div>
                <div class="text-xs text-[var(--color-text-muted)]">{shortcut.description}</div>
              </div>
              <button 
                type="button"
                onclick={() => startEditShortcut(shortcut.id)} 
                class="flex items-center gap-1 px-3 py-2 rounded-lg border bg-[var(--color-surface-1)] text-sm font-mono transition-all
                       {editingShortcutId === shortcut.id ? 'ring-2 ring-[var(--color-accent)] border-[var(--color-accent)] text-[var(--color-accent)]' : 'group-hover:border-[var(--color-text-secondary)] shadow-sm'}"
              >
                {#if editingShortcutId === shortcut.id}
                  <span class="animate-pulse">Waiting for keys...</span>
                {:else}
                  {#each shortcut.keys as key, i}
                    <span>{key}</span>
                    {#if i < shortcut.keys.length - 1}<span class="opacity-30 mx-0.5">+</span>{/if}
                  {/each}
                {/if}
              </button>
            </div>
          {/each}
        </div>
        <section class="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-2)] p-4">
          <h4 class="text-sm font-semibold text-[var(--color-text-primary)]">New chat behavior</h4>
          <p class="mt-1 text-xs text-[var(--color-text-muted)]">Choose whether the new-chat control reuses an untouched composer or always opens another session.</p>
          <div class="mt-3 max-w-xl">
            <KorySelect
              value={sessionStore.newChatBehavior}
              label="New chat behavior"
              options={[
                { value: 'reuse-empty', label: 'Reuse untouched chat', description: 'Default. + and Ctrl/Cmd+N keep the active chat when it has no messages. Shift-click or Shift+Ctrl/Cmd+N forces a new one.' },
                { value: 'always-create', label: 'Always create a new chat', description: 'Every new-chat action opens a separate session.' },
              ]}
              onchange={(value) => sessionStore.setNewChatBehavior(value as NewChatBehavior)}
            />
          </div>
        </section>
      </div>

      <!-- Billing Tab -->
      <div class={activeTab === 'billing' ? 'flex-1 overflow-y-auto px-6 py-5 space-y-8 w-full max-w-7xl mx-auto' : 'hidden'}>
        {#if billingError}
          <div class="p-4 rounded-xl border text-xs" style="border-color: var(--color-error); color: var(--color-error); background: rgba(239,68,68,0.08);">
            Billing data unavailable: {billingError}
            <button type="button" class="ml-2 underline" onclick={() => loadBillingCredits(true)}>Retry</button>
          </div>
        {/if}
        <div class="flex items-center justify-between gap-4">
          <div>
            <h3 class="text-sm font-bold text-[var(--color-text-primary)]">Usage and billing</h3>
            <p class="mt-1 text-[10px] text-[var(--color-text-muted)]">Recorded provider usage and account-reported balances</p>
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
        <div class="grid grid-cols-1 md:grid-cols-2 gap-6">
          <div class="p-6 rounded-2xl bg-gradient-to-br from-[var(--color-surface-2)] to-[var(--color-surface-1)] border border-[var(--color-border)] shadow-xl relative">
            <div class="absolute -top-4 -right-4 w-24 h-24 bg-[var(--color-accent)]/5 rounded-full blur-3xl"></div>
            <div class="relative mb-3 flex items-start justify-between gap-4">
              <div>
                <div class="text-[10px] text-[var(--color-text-muted)] uppercase tracking-widest font-bold">
                  {billingSpendView === 'api' ? 'API Spend' : billingSpendView === 'subscription' ? 'Subscription Spend' : 'All Spend'}
                </div>
                <div class="mt-1 text-[9px] text-[var(--color-text-muted)]">
                  {billingSpendView === 'api' ? 'Metered keys' : billingSpendView === 'subscription' ? '30-day API-equivalent value' : 'Metered plus 30-day inference value'}
                </div>
              </div>
              <div class="w-52 shrink-0">
                <KorySelect
                  compact
                  value={billingSpendView}
                  label="Spend type"
                  options={billingSpendOptions}
                  onchange={(value) => billingSpendView = value as 'api' | 'subscription' | 'all'}
                />
              </div>
            </div>
            <div class="text-4xl font-black text-[var(--color-text-primary)] flex items-baseline gap-1">
              {#if billingLoading && !billingCredits}
                <div class="h-10 w-32 bg-[var(--color-surface-3)] animate-pulse rounded-lg"></div>
              {:else}
                <span class="text-2xl opacity-50">$</span>{(selectedSpendCents() / 100).toFixed(2)}
              {/if}
            </div>
            <p class="text-[10px] text-[var(--color-text-muted)] mt-4">
              {billingSpendView === 'subscription'
                ? 'Inference value is not an amount charged by subscription providers'
                : billingSpendView === 'all'
                  ? 'Combined comparison value; subscription inference is not an amount charged'
                  : 'Computed from recorded metered tokens at verified model prices'}
            </p>
          </div>

          <div class="p-6 rounded-2xl bg-[var(--color-surface-2)] border border-[var(--color-border)]">
            <div class="text-[10px] text-[var(--color-text-muted)] uppercase tracking-widest font-bold mb-2">Provider Balance</div>
            <div class="text-4xl font-black text-emerald-400 flex items-baseline gap-1">
              {#if billingLoading && !billingCredits}
                <div class="h-10 w-32 bg-[var(--color-surface-3)] animate-pulse rounded-lg"></div>
              {:else if typeof billingCredits?.remainingCents === 'number'}
                <span class="text-2xl opacity-50">$</span>{(billingCredits.remainingCents / 100).toFixed(2)}
              {:else}
                <span class="text-2xl text-[var(--color-text-muted)] font-semibold">Not reported</span>
              {/if}
            </div>
            <p class="text-[10px] text-[var(--color-text-muted)] mt-4">
              {typeof billingCredits?.remainingCents === 'number'
                ? 'Live balance from your provider account'
                : 'Your configured providers do not expose a queryable balance'}
            </p>
          </div>
        </div>

        <!-- CLI subscriptions: real local usage + quota burn -->
        {#if billingCredits?.cliUsage?.length}
          <div class="space-y-4">
            <h3 class="text-sm font-bold text-[var(--color-text-primary)] ml-1">CLI Subscriptions — real usage</h3>
            <div class="grid grid-cols-1 xl:grid-cols-2 gap-4">
              {#each billingCredits.cliUsage as cli (`${cli.provider}:${cli.accountId ?? 'aggregate'}`)}
                <div class="p-5 bg-[var(--color-surface-2)] rounded-2xl border border-[var(--color-border)] space-y-4">
                  <div class="flex items-center justify-between">
                    <div class="flex items-center gap-3">
                      <div class="w-8 h-8 rounded-lg bg-[var(--color-surface-3)] flex items-center justify-center p-1.5">
                        <ProviderIcon provider={cli.provider} size={20} class="w-full h-full" />
                      </div>
                      <div>
                        <div class="text-sm font-semibold">{getProviderDisplayLabel(cli.provider)}</div>
                        {#if cli.accountEmail || cli.accountLabel}
                          <div class="text-[10px] text-[var(--color-text-muted)]">{cli.accountEmail ?? cli.accountLabel}</div>
                        {/if}
                      </div>
                      {#if cli.planType}
                        <span class="px-2 py-0.5 rounded-full text-[9px] uppercase tracking-wider font-bold bg-[var(--color-surface-3)] text-[var(--color-text-muted)]">{cli.planType}</span>
                      {/if}
                    </div>
                    <span class="text-[10px] text-[var(--color-text-muted)]">from the CLI's own logs</span>
                  </div>

                  {#each cli.quotas as q (q.label)}
                    <div>
                      <div class="flex items-center justify-between text-[11px] mb-1">
                        <span class="text-[var(--color-text-secondary)] font-medium">{q.label} quota</span>
                        <span class="font-mono font-bold" style="color: {q.usedPercent >= 90 ? 'var(--color-error)' : q.usedPercent >= 70 ? '#f59e0b' : 'var(--color-text-secondary)'};">
                          {q.usedPercent.toFixed(0)}% burned{q.resetsAt ? ` · resets ${new Date(q.resetsAt).toLocaleString(undefined, { weekday: 'short', hour: 'numeric', minute: '2-digit' })}` : ''}
                        </span>
                      </div>
                      <div class="h-2 w-full bg-[var(--color-surface-3)] rounded-full overflow-hidden">
                        <div class="h-full rounded-full transition-all" style="width: {Math.min(100, q.usedPercent)}%; background: {q.usedPercent >= 90 ? 'var(--color-error)' : q.usedPercent >= 70 ? '#f59e0b' : 'var(--color-accent)'};"></div>
                      </div>
                    </div>
                  {/each}

                  <div class="grid grid-cols-4 gap-2 text-center">
                    {#each cli.windows as w (w.period)}
                      <div class="p-2.5 rounded-xl bg-[var(--color-surface-1)] border border-[var(--color-border)]">
                        <div class="text-[9px] uppercase tracking-wider text-[var(--color-text-muted)] font-bold">{w.period}</div>
                        <div class="mt-1 text-xs font-mono font-bold text-[var(--color-text-primary)]">{formatTokens(w.tokensIn + w.tokensOut)}</div>
                        <div class="text-[9px] text-[var(--color-text-muted)]">tokens</div>
                        <div class="mt-1 text-[10px] font-mono" style="color: var(--color-accent);">
                          {w.inferenceValueUsd != null ? `$${w.inferenceValueUsd.toFixed(2)}` : '—'}
                        </div>
                        <div class="text-[9px] text-[var(--color-text-muted)]">inference value</div>
                      </div>
                    {/each}
                  </div>

                  {#if cli.byModel?.length}
                    <div class="space-y-1">
                      {#each cli.byModel.slice(0, 4) as m (m.model)}
                        <div class="flex items-center justify-between text-[11px]">
                          <span class="font-mono text-[var(--color-text-secondary)] truncate">{m.model}</span>
                          <span class="font-mono text-[var(--color-text-muted)] shrink-0 ml-3">
                            {formatTokens(m.tokensIn + m.tokensOut)} · {m.inferenceValueUsd != null ? `$${m.inferenceValueUsd.toFixed(2)}` : 'unpriced'}
                          </span>
                        </div>
                      {/each}
                    </div>
                  {/if}
                </div>
              {/each}
            </div>
          </div>
        {/if}

        <!-- Saved provider accounts are credential inventory, not a claim of
             account-level spend. Usage is currently recorded per provider. -->
        {#if billingCredits?.accounts?.length}
          <div class="space-y-4">
          <div class="ml-1 flex items-end justify-between gap-4">
            <div>
              <h3 class="text-sm font-bold text-[var(--color-text-primary)]">Configured Accounts</h3>
              <p class="mt-1 text-[10px] text-[var(--color-text-muted)]">Every active account saved in Providers. Usage totals remain provider-level unless the provider reports account attribution.</p>
            </div>
            <span class="shrink-0 text-[10px] font-mono text-[var(--color-text-muted)]">{billingCredits.accounts.length} account{billingCredits.accounts.length === 1 ? '' : 's'}</span>
          </div>
          <div class="grid grid-cols-1 xl:grid-cols-2 gap-3">
              {#each billingCredits.accounts as account (`${account.provider}:${account.id}`)}
                <div class="flex items-center gap-3 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-2)] p-4">
                  <div class="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-[var(--color-surface-3)] p-2">
                    <ProviderIcon provider={account.provider} size={20} class="h-full w-full" />
                  </div>
                  <div class="min-w-0 flex-1">
                    <div class="flex items-center gap-2">
                      <span class="truncate text-xs font-semibold text-[var(--color-text-primary)]">{account.label}</span>
                      <span class="shrink-0 rounded-full px-2 py-0.5 text-[9px] font-bold uppercase tracking-wider" style="color: {account.subscription ? 'var(--color-accent)' : 'var(--color-text-secondary)'}; background: var(--color-surface-3);">{account.subscription ? 'Subscription-backed' : 'Metered API'}</span>
                    </div>
                    <div class="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-[10px] text-[var(--color-text-muted)]">
                      <span>{getProviderDisplayLabel(account.provider)}</span>
                      <span>·</span>
                      <span>{account.credentialTypes.map((type: string) => type === 'apiKey' ? 'API key' : type === 'authToken' ? 'Auth token' : type === 'cliProfile' ? 'Detected CLI profile' : 'Endpoint URL').join(' + ')}</span>
                      {#if account.email}<span>· {account.email}</span>{/if}
                      {#if account.plan}<span>· {String(account.plan).toUpperCase()} plan</span>{/if}
                      {#if account.health === 'expired'}<span class="text-amber-400">· Login expired</span>{/if}
                      {#if account.lastUsedAt}<span>· Last used {new Date(account.lastUsedAt).toLocaleString()}</span>{/if}
                    </div>
                  </div>
                  <div class="shrink-0 text-right">
                    <div class="text-[10px] font-bold uppercase tracking-wider text-[var(--color-text-muted)]">Usage</div>
                    <div class="mt-1 text-[10px] text-[var(--color-text-secondary)]">Provider aggregate</div>
                  </div>
                </div>
              {/each}
          </div>
        </div>
        {/if}

        {#if billingCredits?.balances?.length}
          <div class="space-y-4">
            <h3 class="text-sm font-bold text-[var(--color-text-primary)] ml-1">Live Account Balances</h3>
            <div class="grid grid-cols-2 sm:grid-cols-4 gap-3">
              {#each billingCredits.balances as bal (bal.provider)}
                <div class="p-4 bg-[var(--color-surface-2)] rounded-xl border border-[var(--color-border)] text-center">
                  <div class="w-8 h-8 mx-auto rounded-lg bg-[var(--color-surface-3)] flex items-center justify-center p-1.5 mb-2">
                    <ProviderIcon provider={bal.provider} size={20} class="w-full h-full" />
                  </div>
                  <div class="text-lg font-black font-mono text-emerald-400">
                    {bal.availableUsd != null ? `$${bal.availableUsd.toFixed(2)}` : '—'}
                  </div>
                  <div class="text-[9px] uppercase tracking-wider text-[var(--color-text-muted)] font-bold mt-1">{getProviderDisplayLabel(bal.provider)}</div>
                </div>
              {/each}
            </div>
          </div>
        {/if}

        <div class="space-y-4">
          <h3 class="text-sm font-bold text-[var(--color-text-primary)] ml-1">API Consumption by Provider</h3>
          <div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
            {#if billingCredits?.byProvider?.length}
              {#each billingCredits.byProvider as prov (prov.name)}
                <div class="flex items-center justify-between p-4 bg-[var(--color-surface-2)] rounded-xl border border-[var(--color-border)]">
                  <div class="flex items-center gap-3">
                    <div class="w-8 h-8 rounded-lg bg-[var(--color-surface-3)] flex items-center justify-center p-1.5 shrink-0">
                      <ProviderIcon provider={prov.name} size={20} class="w-full h-full" />
                    </div>
                    <div>
                      <span class="text-xs font-semibold">{getProviderDisplayLabel(prov.name)}</span>
                      <div class="text-[10px] text-[var(--color-text-muted)] font-mono">{formatTokens((prov.tokensIn ?? 0) + (prov.tokensOut ?? 0))} tokens</div>
                    </div>
                  </div>
                  <div class="text-right">
                    <div class="text-xs font-mono font-bold text-[var(--color-text-secondary)]">
                      {prov.subscription ? 'subscription' : `$${((prov.spendCents ?? 0) / 100).toFixed(3)} spent`}
                    </div>
                    {#if billingCredits?.balances?.find((b: any) => b.provider === prov.name)?.availableUsd != null}
                      <div class="text-[10px] font-mono text-emerald-400">
                        ${billingCredits.balances.find((b: any) => b.provider === prov.name).availableUsd.toFixed(2)} left
                      </div>
                    {/if}
                  </div>
                </div>
              {/each}
            {:else}
              <div class="col-span-full py-12 text-center border-2 border-dashed border-[var(--color-border)] rounded-2xl">
                <p class="text-xs text-[var(--color-text-muted)]">No API usage recorded yet — chats through metered providers will appear here</p>
              </div>
            {/if}
          </div>
        </div>
      </div>

      <!-- Memory Tab -->
      <div class={activeTab === 'memory' ? 'flex-1 min-h-0 min-w-0 overflow-hidden flex flex-col' : 'hidden'}>
        <MemoryEditor />
      </div>

      <!-- Agent Tab -->
      <div class={activeTab === 'agent' ? 'flex-1 min-h-0 min-w-0 overflow-hidden flex flex-col' : 'hidden'}>
        <AgentSettings />
      </div>

      <!-- Experimental Tab -->
      <div class={activeTab === 'experimental' ? 'flex-1 min-h-0 min-w-0 overflow-hidden flex flex-col' : 'hidden'}>
        <div class="flex-1 min-h-0 overflow-y-auto px-6 py-5"><ExperimentalSettings /></div>
      </div>

      <!-- Teams Tab -->
      <div class={activeTab === 'teams' ? 'flex-1 overflow-y-auto px-6 py-5 flex flex-col w-full max-w-7xl mx-auto' : 'hidden'}>
        <div class="flex-1 py-10">
          <div class="text-center mb-12">
            <div class="w-20 h-20 bg-[var(--color-accent)]/10 text-[var(--color-accent)] rounded-3xl flex items-center justify-center mx-auto mb-6 shadow-xl shadow-[var(--color-accent)]/5">
              <Users size={40} />
            </div>
            <h3 class="text-2xl font-black text-[var(--color-text-primary)]">Team Collaboration</h3>
            <p class="text-sm text-[var(--color-text-muted)] mt-2">The host controls what guests can see, submit, and which models are available</p>
          </div>

          {#if collaborationStore.activeCollab}
            <!-- ── ACTIVE SESSION ── -->
            <div class="mx-auto max-w-4xl space-y-6">

              <!-- Invite links -->
              <div class="relative rounded-3xl border border-[var(--color-accent)]/30 bg-[var(--color-surface-2)] p-8 shadow-2xl">
                <div class="absolute -top-3 left-6 px-4 py-1 rounded-full bg-[var(--color-accent)] text-[10px] font-black uppercase tracking-widest text-[var(--color-surface-0)] shadow-lg">
                  {collaborationStore.activeCollab.relayEnabled ? '● Live via Relay' : '● Active Session'}
                </div>

                {#if collaborationStore.activeCollab.relayEnabled}
                  <h4 class="text-sm font-bold text-[var(--color-text-primary)] mb-5">Browser invites</h4>
                  <div class="space-y-3">
                    {#each [
                      { role: 'viewer', label: 'Viewer · Tier 1', desc: 'Read-only session feed. Cannot submit prompts or run models.', color: 'text-blue-400', bg: 'bg-blue-500/10' },
                      { role: 'collaborator', label: 'Collaborator · Tier 2', desc: 'Can submit prompts when enabled. Host approval remains authoritative.', color: 'text-amber-400', bg: 'bg-amber-500/10' },
                      { role: 'yolo', label: 'YOLO · Tier 3', desc: 'Unrestricted auto-execution, tools, models, and filesystem. Trusted users only.', color: 'text-red-400', bg: 'bg-red-500/10' },
                    ] as r}
                      <div class="flex items-center gap-4 rounded-2xl bg-[var(--color-surface-1)] p-4">
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
                    <div class="flex items-center justify-between gap-4 rounded-2xl bg-[var(--color-surface-1)] p-4">
                      <div>
                        <div class="text-xs font-bold text-[var(--color-text-primary)]">Native Koryphaios join</div>
                        <p class="mt-1 text-[11px] text-[var(--color-text-muted)]">Enter this code in Teams on another Koryphaios app.</p>
                      </div>
                      <button type="button" onclick={() => collaborationStore.copyJoinCode()} class="rounded-xl border border-[var(--color-border)] px-4 py-2 font-mono text-sm font-bold tracking-[0.16em] text-[var(--color-accent)] hover:bg-[var(--color-surface-3)]">
                        {collaborationStore.activeCollab.joinCode}
                      </button>
                    </div>
                  </div>
                {:else}
                  <!-- Relay not configured — show legacy join code -->
                  <div class="text-center">
                    <p class="mb-2 block text-[10px] font-bold uppercase tracking-widest text-[var(--color-text-muted)]">Join Code (local network only)</p>
                    <code class="block rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface-1)] py-4 text-3xl font-black tracking-[0.3em] text-[var(--color-accent)]">
                      {collaborationStore.activeCollab.joinCode || '••••••'}
                    </code>
                    <p class="mt-3 text-[11px] text-[var(--color-text-muted)]">
                      Configure RELAY_URL and RELAY_HOST_SECRET in your environment for internet-accessible invite links.
                    </p>
                  </div>
                {/if}
              </div>

              <!-- Host policy -->
              <TeamAccessProfiles models={teamModels} />

              <!-- Pending approvals -->
              {#if collaborationStore.pendingPrompts.length > 0}
                <div class="rounded-3xl border border-amber-500/30 bg-amber-500/5 p-6">
                  <h4 class="text-sm font-bold text-amber-400 mb-4 flex items-center gap-2">
                    <span>⏳</span> Pending Guest Prompts ({collaborationStore.pendingPrompts.length})
                  </h4>
                  <div class="space-y-3">
                    {#each collaborationStore.pendingPrompts as p (p.promptId)}
                      <div class="rounded-2xl bg-[var(--color-surface-1)] border border-[var(--color-border)] p-4">
                        <div class="flex items-start justify-between gap-4">
                          <div class="flex-1 min-w-0">
                            <div class="flex items-center gap-2 mb-1">
                              <span class="text-[10px] font-bold uppercase text-amber-400">{p.name}</span>
                              <span class="text-[10px] text-[var(--color-text-muted)]">· {p.role}</span>
                            </div>
                            <p class="text-sm text-[var(--color-text-primary)] break-words">{p.content}</p>
                            {#if p.model}<p class="mt-2 text-[10px] text-[var(--color-text-muted)]">Model: {p.model}{p.reasoningLevel ? ` · Reasoning: ${p.reasoningLevel}` : ' · Provider default reasoning'}</p>{/if}
                          </div>
                          <div class="flex gap-2 shrink-0">
                            <button
                              type="button"
                              onclick={() => collaborationStore.approvePrompt(p.promptId, true)}
                              class="rounded-xl bg-emerald-500/10 text-emerald-400 px-3 py-1.5 text-xs font-bold hover:bg-emerald-500/20 transition-all"
                            >
                              Approve
                            </button>
                            <button
                              type="button"
                              onclick={() => collaborationStore.approvePrompt(p.promptId, false)}
                              class="rounded-xl bg-red-500/10 text-red-400 px-3 py-1.5 text-xs font-bold hover:bg-red-500/20 transition-all"
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
                class="btn w-full rounded-xl bg-red-500/10 py-3 font-bold text-red-400 transition-all hover:bg-red-500/20"
              >
                Stop Hosting
              </button>
            </div>

          {:else}
            <!-- ── NOT HOSTING ── -->
            {#if collaborationStore.joinedSessions.length}
              <div class="mx-auto mb-8 max-w-4xl rounded-3xl border border-[var(--color-border)] bg-[var(--color-surface-2)] p-6">
                <div class="mb-4"><h4 class="text-sm font-bold text-[var(--color-text-primary)]">Team sessions</h4><p class="mt-1 text-[11px] text-[var(--color-text-muted)]">These are separate from your personal session history. Joining never replaces or merges your local sessions.</p></div>
                <div class="space-y-2">{#each collaborationStore.joinedSessions as team (team.sessionId)}<div class="flex items-center gap-3 rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface-1)] p-4"><div class="min-w-0 flex-1"><div class="truncate text-xs font-bold text-[var(--color-text-primary)]">{team.sessionName}</div><div class="mt-1 text-[10px] text-[var(--color-text-muted)]">Access: {team.tierId} · Team workspace</div></div><button type="button" onclick={() => collaborationStore.openJoinedSession(team.sessionId)} class="rounded-xl bg-[var(--color-accent)]/10 px-4 py-2 text-xs font-bold text-[var(--color-accent)]">Open</button><button type="button" onclick={() => collaborationStore.leaveJoinedSession(team.sessionId)} class="rounded-xl px-3 py-2 text-xs text-red-400 hover:bg-red-500/10">Leave</button></div>{/each}</div>
              </div>
            {/if}
            <div class="grid grid-cols-1 md:grid-cols-2 gap-8 max-w-4xl mx-auto">
              <div class="p-8 rounded-3xl bg-[var(--color-surface-2)] border border-[var(--color-border)] hover:border-[var(--color-accent)]/30 transition-all flex flex-col text-center">
                <div class="w-12 h-12 bg-emerald-500/10 text-emerald-400 rounded-2xl flex items-center justify-center mx-auto mb-6">
                  <Zap size={24} />
                </div>
                <h4 class="text-lg font-bold mb-2">Host a Session</h4>
                <p class="text-xs text-[var(--color-text-muted)] mb-8">
                  Generate invite links for teammates to watch or co-pilot your active AI session in real time.
                </p>

                <div class="mb-6 flex-1 rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface-1)] p-4 text-left">
                  <div class="mb-3 flex items-center justify-between gap-3">
                    <div>
                      <div class="text-xs font-bold text-[var(--color-text-primary)]">Working in</div>
                      <div class="mt-0.5 text-[10px] text-[var(--color-text-muted)]">Workspace roots available to this hosted session.</div>
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
                        <div class="group flex items-center gap-2 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-0)] p-2 transition-colors focus-within:border-[var(--color-accent)]/60">
                          <FolderOpen size={14} class="ml-1 shrink-0 text-[var(--color-accent)]" />
                          <input
                            value={path}
                            aria-label={`Hosted workspace path ${index + 1}`}
                            oninput={(event) => updateHostWorkspacePath(index, event.currentTarget.value)}
                            class="min-w-0 flex-1 bg-transparent px-1 py-1 font-mono text-[11px] text-[var(--color-text-primary)] outline-none"
                            spellcheck="false"
                          />
                          <button
                            type="button"
                            aria-label={`Remove ${path || `workspace path ${index + 1}`}`}
                            onclick={() => removeHostWorkspacePath(index)}
                            class="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-[var(--color-text-muted)] transition-colors hover:bg-red-500/10 hover:text-red-400"
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
                  disabled={collaborationStore.loading || !hostWorkspacePaths.some(path => path.trim())}
                  class="btn btn-primary w-full py-3 mt-auto font-bold rounded-xl disabled:opacity-50"
                >
                  {collaborationStore.loading ? 'Starting...' : 'Start Collaboration'}
                </button>
              </div>

              <div class="p-8 rounded-3xl bg-[var(--color-surface-2)] border border-[var(--color-border)] hover:border-[var(--color-accent)]/30 transition-all flex flex-col text-center">
                <div class="w-12 h-12 bg-blue-500/10 text-blue-400 rounded-2xl flex items-center justify-center mx-auto mb-6">
                  <Keyboard size={24} />
                </div>
                <h4 class="text-lg font-bold mb-2">Join in Koryphaios</h4>
                <p class="text-xs text-[var(--color-text-muted)] mb-8">
                  Enter the host's eight-character code. The host's join policy decides whether you are admitted automatically and which access profile you receive.
                </p>
                <div class="space-y-3 text-left">
                  <input bind:value={teamGuestName} placeholder="Your display name" class="w-full rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-1)] px-4 py-3 text-sm outline-none focus:border-[var(--color-accent)]" />
                  <input bind:value={teamJoinCode} maxlength="8" placeholder="JOIN CODE" class="w-full rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-1)] px-4 py-3 text-center font-mono text-lg font-bold uppercase tracking-[0.2em] outline-none focus:border-[var(--color-accent)]" />
                  <button type="button" disabled={teamJoinCode.trim().length !== 8 || collaborationStore.loading} onclick={() => collaborationStore.joinSession(teamJoinCode, teamGuestName || 'Guest')} class="btn btn-primary w-full rounded-xl py-3 font-bold disabled:opacity-40">{collaborationStore.loading ? 'Joining…' : 'Request to join'}</button>
                  <p class="text-center text-[10px] text-[var(--color-text-muted)]">Browser guests can still use either signed invite link without installing Koryphaios.</p>
                </div>
              </div>
            </div>
          {/if}

          <!-- ── SECOND SECTION: Share Models ── separate from collaboration;
               its own models-only invite link so it never grants session access. -->
          <div class="mx-auto max-w-4xl mt-16 pt-12 border-t border-[var(--color-border)]">
            <ModelSharingPanel />
          </div>
        </div>
      </div>

      <!-- Notes Tab -->
      <div class={activeTab === 'notes' ? 'flex-1 overflow-y-auto px-6 py-5 space-y-6 w-full max-w-7xl mx-auto' : 'hidden'}>
        <div>
          <h3 class="text-base font-semibold mb-1" style="color: var(--color-text-primary);">Note Network</h3>
          <p class="text-xs" style="color: var(--color-text-muted);">Obsidian-style note network — link notes with [[wikilinks]], visualise connections, and include pinned notes in agent context.</p>
        </div>

        <!-- Enable / disable -->
        <div class="space-y-3">
          <div class="text-[10px] font-semibold uppercase tracking-[0.14em]" style="color: var(--color-text-muted);">General</div>

          <label class="flex items-center justify-between gap-4 py-2 cursor-pointer">
            <div>
              <div class="text-sm font-medium" style="color: var(--color-text-primary);">Enable Notes</div>
              <div class="text-xs mt-0.5" style="color: var(--color-text-muted);">Show the Notes panel button and enable note creation.</div>
            </div>
            <button
              type="button"
              role="switch"
              aria-checked={notesStore.settings.enabled}
              aria-label="Toggle notes enabled"
              class="relative inline-flex h-5 w-9 items-center rounded-full transition-colors shrink-0"
              style="background: {notesStore.settings.enabled ? 'var(--color-accent)' : 'var(--color-surface-4)'};"
              onclick={() => notesStore.updateSettings({ enabled: !notesStore.settings.enabled })}
            >
              <span
                class="inline-block h-3.5 w-3.5 rounded-full bg-white shadow transition-transform"
                style="transform: translateX({notesStore.settings.enabled ? '18px' : '2px'});"
              ></span>
            </button>
          </label>

          <label class="flex items-center justify-between gap-4 py-2 cursor-pointer">
            <div>
              <div class="text-sm font-medium" style="color: var(--color-text-primary);">Auto-include pinned notes in agent context</div>
              <div class="text-xs mt-0.5" style="color: var(--color-text-muted);">Pinned notes are automatically injected into the agent's system context.</div>
            </div>
            <button
              type="button"
              role="switch"
              aria-checked={notesStore.settings.autoIncludeInContext}
              aria-label="Toggle auto-include pinned notes"
              class="relative inline-flex h-5 w-9 items-center rounded-full transition-colors shrink-0"
              style="background: {notesStore.settings.autoIncludeInContext ? 'var(--color-accent)' : 'var(--color-surface-4)'};"
              onclick={() => notesStore.updateSettings({ autoIncludeInContext: !notesStore.settings.autoIncludeInContext })}
            >
              <span
                class="inline-block h-3.5 w-3.5 rounded-full bg-white shadow transition-transform"
                style="transform: translateX({notesStore.settings.autoIncludeInContext ? '18px' : '2px'});"
              ></span>
            </button>
          </label>

          <div class="flex items-center justify-between gap-4 py-2">
            <div>
              <div class="text-sm font-medium" style="color: var(--color-text-primary);">Max context tokens</div>
              <div class="text-xs mt-0.5" style="color: var(--color-text-muted);">Maximum tokens used by notes included in agent context (100–5000).</div>
            </div>
            <div class="w-52 shrink-0">
              <NumberStepper
                value={notesStore.settings.maxContextTokens}
                min={100}
                max={5000}
                step={100}
                label="Maximum note context tokens"
                onchange={(value) => notesStore.updateSettings({ maxContextTokens: value })}
              />
            </div>
          </div>

          <div class="flex items-center justify-between gap-4 py-2">
            <div>
              <div class="text-sm font-medium" style="color: var(--color-text-primary);">Default folder path</div>
              <div class="text-xs mt-0.5" style="color: var(--color-text-muted);">New notes are created here by default.</div>
            </div>
            <input
              type="text"
              placeholder="/"
              class="input h-8 w-32 text-sm"
              value={notesStore.settings.defaultFolderPath}
              onchange={(e) => notesStore.updateSettings({ defaultFolderPath: (e.currentTarget as HTMLInputElement).value || '/' })}
            />
          </div>
        </div>

        <!-- Separator -->
        <div class="border-t" style="border-color: var(--color-border);"></div>

        <!-- Agent permissions -->
        <div class="space-y-4">
          <div class="flex items-start justify-between gap-4">
            <div>
              <div class="flex items-center gap-2">
                <Shield size={14} style="color: var(--color-accent);" />
                <div class="text-[10px] font-semibold uppercase tracking-[0.14em]" style="color: var(--color-text-muted);">
                  Agent Permissions
                </div>
              </div>
              <p class="text-xs mt-1.5" style="color: var(--color-text-muted);">
                Control what agents can do in the note network. Hidden tools are removed entirely — agents won't see them. YOLO mode still bypasses "Ask" prompts.
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
                  background: {notesStore.agentPermissions.preset === preset.id ? 'rgba(var(--color-accent-rgb, 99 102 241) / 0.12)' : 'var(--color-surface-2)'};
                  border-color: {notesStore.agentPermissions.preset === preset.id ? 'var(--color-accent)' : 'var(--color-border)'};
                  color: var(--color-text-primary);
                "
                onclick={() => void notesStore.applyAgentPermissionPreset(preset.id)}
              >
                <div class="text-xs font-semibold">{preset.label}</div>
                <div class="text-[10px] mt-0.5" style="color: var(--color-text-muted);">{preset.description}</div>
              </button>
            {/each}
            {#if notesStore.agentPermissions.preset === 'custom'}
              <div
                class="px-3 py-2 rounded-xl border min-w-[120px]"
                style="background: var(--color-surface-2); border-color: var(--color-accent); color: var(--color-text-primary);"
              >
                <div class="text-xs font-semibold">Custom</div>
                <div class="text-[10px] mt-0.5" style="color: var(--color-text-muted);">Per-action overrides</div>
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
                <div class="text-xs font-semibold capitalize" style="color: var(--color-text-primary);">
                  {category === 'read' ? 'Read actions' : 'Write actions'}
                </div>
                <div class="space-y-2">
                  {#each NOTE_TOOL_DEFINITIONS.filter((d) => d.category === category) as tool (tool.name)}
                    <div class="flex items-center justify-between gap-3 py-1">
                      <div class="min-w-0">
                        <div class="text-xs font-medium truncate" style="color: var(--color-text-primary);">
                          {tool.label}
                        </div>
                        <div class="text-[10px] truncate" style="color: var(--color-text-muted);">
                          {tool.description}
                        </div>
                      </div>
                      <div class="flex shrink-0 rounded-xl border p-0.5" style="background: var(--color-surface-1); border-color: var(--color-border);">
                        {#each ['auto', 'ask', 'block'] as level (level)}
                          <button
                            type="button"
                            class="rounded-lg px-2 py-1 text-[10px] font-semibold transition-colors"
                            style="background: {notesStore.agentPermissions.tools[tool.name] === level ? 'var(--color-surface-4)' : 'transparent'}; color: {notesStore.agentPermissions.tools[tool.name] === level ? 'var(--color-text-primary)' : 'var(--color-text-muted)'}; box-shadow: {notesStore.agentPermissions.tools[tool.name] === level ? 'inset 0 0 0 1px var(--color-border)' : 'none'};"
                            onclick={() => void notesStore.setAgentToolPermission(tool.name, level as NotePermissionLevel)}
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
          <div class="text-[10px] font-semibold uppercase tracking-[0.14em]" style="color: var(--color-text-muted);">Graph Physics</div>

          <div class="space-y-1">
            <div class="flex items-center justify-between">
              <label for="notes-gravity" class="text-sm" style="color: var(--color-text-primary);">Gravity</label>
              <span class="text-xs tabular-nums" style="color: var(--color-text-muted);">{notesStore.settings.graphPhysics.gravity}</span>
            </div>
            <input
              id="notes-gravity"
              type="range"
              min="-500"
              max="0"
              step="10"
              class="w-full accent-[var(--color-accent)]"
              value={notesStore.settings.graphPhysics.gravity}
              oninput={(e) => notesStore.updateSettings({ graphPhysics: { ...notesStore.settings.graphPhysics, gravity: parseInt((e.currentTarget as HTMLInputElement).value, 10) } })}
            />
          </div>

          <div class="space-y-1">
            <div class="flex items-center justify-between">
              <label for="notes-link-distance" class="text-sm" style="color: var(--color-text-primary);">Link distance</label>
              <span class="text-xs tabular-nums" style="color: var(--color-text-muted);">{notesStore.settings.graphPhysics.linkDistance}</span>
            </div>
            <input
              id="notes-link-distance"
              type="range"
              min="50"
              max="300"
              step="10"
              class="w-full accent-[var(--color-accent)]"
              value={notesStore.settings.graphPhysics.linkDistance}
              oninput={(e) => notesStore.updateSettings({ graphPhysics: { ...notesStore.settings.graphPhysics, linkDistance: parseInt((e.currentTarget as HTMLInputElement).value, 10) } })}
            />
          </div>

          <div class="space-y-1">
            <div class="flex items-center justify-between">
              <label for="notes-charge" class="text-sm" style="color: var(--color-text-primary);">Charge strength</label>
              <span class="text-xs tabular-nums" style="color: var(--color-text-muted);">{notesStore.settings.graphPhysics.chargeStrength}</span>
            </div>
            <input
              id="notes-charge"
              type="range"
              min="-500"
              max="-50"
              step="10"
              class="w-full accent-[var(--color-accent)]"
              value={notesStore.settings.graphPhysics.chargeStrength}
              oninput={(e) => notesStore.updateSettings({ graphPhysics: { ...notesStore.settings.graphPhysics, chargeStrength: parseInt((e.currentTarget as HTMLInputElement).value, 10) } })}
            />
          </div>
        </div>

        <!-- Separator -->
        <div class="border-t" style="border-color: var(--color-border);"></div>

        <!-- Actions -->
        <div class="space-y-3">
          <div class="text-[10px] font-semibold uppercase tracking-[0.14em]" style="color: var(--color-text-muted);">Actions</div>

          <button
            type="button"
            class="w-full flex items-center gap-2 px-4 py-2.5 rounded-xl text-sm font-medium transition-colors border hover:bg-[var(--color-surface-3)]"
            style="background: var(--color-surface-2); border-color: var(--color-border); color: var(--color-text-primary);"
            onclick={() => { onClose?.(); window.dispatchEvent(new CustomEvent('open-notes-graph')); }}
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
{/if}

{#if showRotateDialog && rotateProvider}
  <div class="fixed inset-0 bg-black/80 flex items-center justify-center z-50 p-4 backdrop-blur-sm">
    <div class="bg-[var(--color-surface-1)] rounded-3xl p-8 w-full max-w-md border border-[var(--color-border)] shadow-2xl">
      <h3 class="text-xl font-black mb-2 text-[var(--color-text-primary)]">Rotate API Key</h3>
      <p class="text-xs text-[var(--color-text-muted)] mb-6">Enter a new key for {getProviderDisplayLabel(rotateProvider.name)}. Your previous key will be immediately discarded.</p>
      <div class="relative mb-6">
        <input bind:this={rotateKeyInput} type={secretInputType('rotate-key')} bind:value={newKeyValue} placeholder="sk-..." class="input w-full pr-12 text-base py-3 font-mono" />
        <button type="button" class="secret-visibility absolute inset-y-0 right-1 my-auto z-10" onclick={() => toggleSecretVisibility('rotate-key')} aria-label={visibleSecrets['rotate-key'] ? 'Hide replacement API key' : 'Show replacement API key'}>
          {#if visibleSecrets['rotate-key']}<EyeOff size={15} />{:else}<Eye size={15} />{/if}
        </button>
      </div>
      <div class="flex justify-end gap-3">
        <button type="button" onclick={() => { showRotateDialog = false; newKeyValue = ''; }} class="px-6 py-2.5 text-xs font-bold rounded-xl bg-[var(--color-surface-3)] hover:bg-[var(--color-surface-4)] transition-colors">Cancel</button>
        <button type="button" onclick={() => { rotateProviderKey(rotateProvider!.name, newKeyValue, rotateProvider!.keyType); showRotateDialog = false; newKeyValue = ''; }} class="btn btn-primary px-8 py-2.5 text-xs font-bold rounded-xl shadow-lg shadow-[var(--color-accent)]/20">Rotate Key</button>
      </div>
    </div>
  </div>
{/if}

{#if showCodexProfileDialog}
  <div class="fixed inset-0 z-50 flex items-center justify-center bg-[radial-gradient(circle_at_top,rgba(255,255,255,0.08),transparent_45%),rgba(3,7,18,0.94)] p-4 backdrop-blur-md">
    <div class="w-full max-w-2xl overflow-hidden rounded-[2rem] border border-[var(--color-accent)]/20 bg-[var(--color-surface-1)] shadow-2xl shadow-black/40">
      <div class="border-b border-[var(--color-border)] bg-[linear-gradient(135deg,var(--color-surface-2),var(--color-surface-1))] px-8 py-8">
        <div class="flex items-center gap-4">
          <div class="flex h-14 w-14 items-center justify-center rounded-2xl bg-[var(--color-accent)]/12 text-[var(--color-accent)]">
            <User size={26} />
          </div>
          <div>
            <p class="text-[11px] font-bold uppercase tracking-[0.28em] text-[var(--color-text-muted)]">Codex Account Auth</p>
            <h3 class="mt-2 text-2xl font-black text-[var(--color-text-primary)]">Name this account before sign-in</h3>
          </div>
        </div>
        <p class="mt-4 max-w-xl text-sm text-[var(--color-text-muted)]">
          This label is how the Codex account will appear inside Koryphaios after the browser sign-in finishes.
        </p>
      </div>

      <div class="px-8 py-8">
        <label for="codex-profile-name" class="mb-3 block text-[11px] font-bold uppercase tracking-[0.22em] text-[var(--color-text-muted)]">
          Profile Name
        </label>
        <input
          bind:this={codexProfileInputRef}
          id="codex-profile-name"
          type="text"
          bind:value={codexProfileInput}
          placeholder="Personal Codex, Work Codex, Team Sandbox..."
          class="input w-full py-4 text-base"
          onkeydown={(e) => e.key === 'Enter' && void confirmCodexProfileAuth()}
        />

        <div class="mt-8 flex justify-end gap-3">
          <button
            type="button"
            onclick={() => {
              showCodexProfileDialog = false;
              pendingCodexAuthOptions = null;
              codexProfileInput = '';
            }}
            class="rounded-xl bg-[var(--color-surface-3)] px-6 py-3 text-xs font-bold text-[var(--color-text-secondary)] transition-colors hover:bg-[var(--color-surface-4)]"
          >
            Cancel
          </button>
          <button
            type="button"
            onclick={() => void confirmCodexProfileAuth()}
            class="btn btn-primary rounded-xl px-8 py-3 text-xs font-bold shadow-lg shadow-[var(--color-accent)]/20"
          >
            Continue To Codex Auth
          </button>
        </div>
      </div>
    </div>
  </div>
{/if}

{#if showModelSelector && selectorTarget}
  <ModelSelectionDialog providerName={selectorTarget.name} availableModels={selectorTarget.allAvailableModels} selectedModels={selectorTarget.selectedModels} onSave={saveSelectedModels} onClose={() => { showModelSelector = false; selectorTarget = null; }} />
{/if}

{#if showAccountManageDialog && managingAccountProvider && managingAccountId}
  <div class="fixed inset-0 z-[101] flex items-center justify-center p-4 bg-black/70 backdrop-blur-md">
    <div class="w-full max-w-md rounded-2xl border p-5 shadow-2xl" style="background: var(--color-surface-1); border-color: var(--color-border);">
      <div class="flex items-center justify-between gap-3">
        <div>
          <h3 class="text-base font-semibold text-[var(--color-text-primary)]">Saved Account</h3>
          <p class="text-xs text-[var(--color-text-muted)]">{getProviderDisplayLabel(managingAccountProvider)}</p>
        </div>
        <button type="button" class="rounded-lg p-2 hover:bg-[var(--color-surface-3)]" onclick={() => showAccountManageDialog = false} aria-label="Close">
          <X size={16} />
        </button>
      </div>
      <div class="mt-4 space-y-3">
        <div>
          <label class="text-[10px] text-[var(--color-text-muted)] font-medium uppercase tracking-wider" for="manage-account-label">Profile Name</label>
          <input id="manage-account-label" type="text" bind:value={managingAccountLabel} class="input mt-1 w-full text-sm" />
        </div>
        <div class="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-0)]/70 p-3">
          <div class="text-xs font-semibold text-[var(--color-text-primary)]">{managingAccountLabel || 'Unnamed profile'}</div>
          <div class="mt-1 text-[11px] text-[var(--color-text-muted)]">This name identifies the account when switching. Model management opens the provider model selector.</div>
        </div>
      </div>
      <div class="mt-5 flex gap-2">
        <button type="button" class="btn btn-secondary flex-1" onclick={manageAccountModels}>Manage Models</button>
        <button type="button" class="btn btn-primary flex-1" onclick={() => void saveAccountProfileLabelFromDialog()} disabled={managingAccountSaving}>
          {managingAccountSaving ? 'Saving...' : 'Save Name'}
        </button>
      </div>
    </div>
  </div>
{/if}

<style>
  .no-scrollbar::-webkit-scrollbar { display: none; }
  .no-scrollbar { -ms-overflow-style: none; scrollbar-width: none; }
  
  /* Glassmorphism input styling override */
  :global(.input) {
    background: var(--color-surface-0) !important;
    border: 1px solid var(--color-border) !important;
    border-radius: 0.75rem !important;
    transition: all 0.2s cubic-bezier(0.4, 0, 0.2, 1) !important;
  }
  :global(.input:focus) {
    border-color: var(--color-accent) !important;
    box-shadow: 0 0 0 4px var(--color-accent-transparent, rgba(213, 178, 97, 0.1)) !important;
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
