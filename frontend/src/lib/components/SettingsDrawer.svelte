<script lang="ts">
  import { onDestroy, tick } from 'svelte';
  import { providersStore } from '$lib/stores/providers.svelte';
  import { theme, type ThemePreset, type AccentColor, type FontFamily } from '$lib/stores/theme.svelte';
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
  import {
    NOTE_TOOL_DEFINITIONS,
    type NotePermissionLevel,
    type NotesPermissionPreset,
  } from '@koryphaios/shared';
  import ModelSelectionDialog from './ModelSelectionDialog.svelte';
  import ModeToggle from './ModeToggle.svelte';
  import { apiFetch, parseJsonResponse } from '$lib/api.svelte';
  import { dndzone } from 'svelte-dnd-action';

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
  let rotateKeyInput = $state<HTMLInputElement | null>(null);

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
    copyToClipboard,
  } = providersStore;

  let providersLoadAttempted = $state(false);
  let lastInitializedTab = $state<typeof activeTab | null>(null);

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
      if (providersStore.availableProviderTypes.length === 0 && !providersLoadAttempted) {
        providersLoadAttempted = true;
        void loadAvailableProviders();
        void loadDetectedClis();
      }
    } else {
      providersLoadAttempted = false;
    }

    if (activeTab === lastInitializedTab) return;
    lastInitializedTab = activeTab;

    if (activeTab === 'memory') void memoryStore.loadAllMemory();
    if (activeTab === 'agent') void agentSettingsStore.loadAll();
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
      toastStore.error('Enter a profile name');
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
  interface Shortcut { id: string; keys: string[]; action: string; description?: string }
  const defaultShortcuts: Shortcut[] = [
    { id: 'send', keys: ['Ctrl', 'Enter'], action: 'Send message', description: 'Submit task' },
    { id: 'settings', keys: ['Ctrl', ','], action: 'Open settings', description: 'Preferences' },
    { id: 'new_session', keys: ['Ctrl', 'N'], action: 'New session', description: 'Clear' },
    { id: 'focus_input', keys: ['Ctrl', 'K'], action: 'Focus input', description: 'Jump' },
    { id: 'close', keys: ['Esc'], action: 'Close dialogs', description: 'Back' },
  ];

  function loadShortcuts(): Shortcut[] {
    try { const stored = localStorage.getItem('koryphaios-shortcuts'); if (stored) return JSON.parse(stored); } catch {}
    return structuredClone(defaultShortcuts);
  }

  let shortcuts = $state<Shortcut[]>(loadShortcuts());
  let editingShortcutId = $state<string | null>(null);
  let capturedKeys = $state<string[]>([]);

  function startEditShortcut(id: string) { editingShortcutId = id; capturedKeys = []; }
  function handleShortcutKeydown(e: KeyboardEvent) {
    if (!editingShortcutId) return; e.preventDefault(); e.stopPropagation();
    const keys: string[] = []; if (e.ctrlKey) keys.push('Ctrl'); if (e.shiftKey) keys.push('Shift'); if (e.altKey) keys.push('Alt'); if (e.metaKey) keys.push('Meta');
    const key = e.key; if (!['Control', 'Shift', 'Alt', 'Meta'].includes(key)) keys.push(key.length === 1 ? key.toUpperCase() : key);
    if (keys.length === 0) return; capturedKeys = keys;
    if (!['Control', 'Shift', 'Alt', 'Meta'].includes(key)) {
      const idx = shortcuts.findIndex(s => s.id === editingShortcutId);
      if (idx >= 0) { shortcuts[idx] = { ...shortcuts[idx], keys: capturedKeys }; shortcuts = [...shortcuts]; localStorage.setItem('koryphaios-shortcuts', JSON.stringify(shortcuts)); }
      editingShortcutId = null; capturedKeys = [];
    }
  }
  function resetShortcuts() { shortcuts = structuredClone(defaultShortcuts); localStorage.removeItem('koryphaios-shortcuts'); toastStore.info('Shortcuts reset'); }

  // ─── Billing ─────────────────────────────────────────────────────────
  let billingLoading = $state(false);
  let billingCredits = $state<any>(null);
  let billingError = $state<string | null>(null);

  async function loadBillingCredits() {
    billingLoading = true; billingError = null;
    try {
      const res = await apiFetch('/api/billing/credits');
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
      <button class="p-1.5 rounded-lg transition-colors hover:bg-[var(--color-surface-3)]" style="color: var(--color-text-muted);" onclick={onClose} aria-label="Close">
        <X size={18} />
      </button>
    </div>

    <!-- Tab bar -->
    <div class="flex gap-1 px-4 py-2 border-b shrink-0 overflow-x-auto no-scrollbar" style="background: var(--color-surface-0); border-color: var(--color-border);">
      {#each [
        { id: 'providers', label: 'Providers', icon: Key },
        { id: 'appearance', label: 'Appearance', icon: Palette },
        { id: 'shortcuts', label: 'Shortcuts', icon: Keyboard },
        { id: 'billing', label: 'Billing', icon: CreditCard, action: loadBillingCredits },
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
          {#if tab.id === 'experimental' && experimentalStore.enabledCount > 0}
            <span class="ml-1 min-w-[16px] h-4 px-1 rounded-full bg-amber-500 text-white text-[9px] flex items-center justify-center font-medium">
              {experimentalStore.enabledCount}
            </span>
          {/if}
        </button>
      {/each}
    </div>

    <!-- Content Area -->
    <div class="flex-1 min-h-0 overflow-hidden flex flex-col">
      <!-- Providers Tab -->
      <div class={activeTab === 'providers' ? 'flex-1 overflow-y-auto px-6 py-5 space-y-6' : 'hidden'}>
        <div class="relative">
          <Search size={14} class="absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" style="color: var(--color-text-muted);" />
          <input type="text" placeholder="Search providers..." bind:value={providerSearchQuery} class="input w-full pl-12 py-2 text-sm" />
        </div>

        <!-- Detected on your system — agent CLIs Koryphaios auto-picked up -->
        {#if providersStore.detectedClis.some((c) => c.installed)}
          <div class="rounded-xl border border-[var(--color-border)] p-4 bg-[var(--color-surface-1)]">
            <div class="flex items-center justify-between mb-3">
              <span class="text-sm font-semibold text-[var(--color-text-primary)]">Detected on your system</span>
              <span class="text-[10px] text-[var(--color-text-muted)]">Auto-picked up — no setup needed</span>
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
                        <span class="text-[10px] px-1.5 py-0.5 rounded-full font-medium" style="background: var(--color-warning-bg, rgba(245,158,11,0.15)); color: var(--color-warning, #f59e0b);">Logged in — needs a key</span>
                      {:else}
                        <span class="text-[10px] text-[var(--color-text-muted)]">Installed — not logged in</span>
                      {/if}
                    </div>
                    <p class="text-[10px] text-[var(--color-text-muted)] leading-relaxed mt-0.5">{cli.note}</p>
                  </div>
                </div>
              {/each}
            </div>
          </div>
        {/if}

        <!-- Add a custom (bring-your-own) provider -->
        <div class="rounded-xl border border-dashed border-[var(--color-border)] p-4 bg-[var(--color-surface-1)]">
          <button type="button" onclick={() => (showAddCustom = !showAddCustom)} class="w-full flex items-center justify-between text-left">
            <div class="flex items-center gap-2">
              <Plus size={15} style="color: var(--color-accent);" />
              <span class="text-sm font-semibold text-[var(--color-text-primary)]">Add a custom provider</span>
            </div>
            <span class="text-[10px] text-[var(--color-text-muted)]">OpenAI-compatible &amp; more</span>
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
                <select id="custom-kind" bind:value={customForm.kind} class="input w-full text-xs">
                  <option value="openai">OpenAI-compatible (/v1/chat/completions)</option>
                  <option value="anthropic">Anthropic-compatible (/v1/messages)</option>
                  <option value="gemini">Gemini-compatible</option>
                </select>
              </div>
              <div class="space-y-1">
                <label class="text-[10px] uppercase tracking-wider text-[var(--color-text-muted)] font-medium" for="custom-url">Base URL</label>
                <input id="custom-url" type="text" placeholder="https://api.example.com/v1" bind:value={customForm.baseUrl} class="input w-full text-xs" />
              </div>
              <div class="space-y-1">
                <label class="text-[10px] uppercase tracking-wider text-[var(--color-text-muted)] font-medium" for="custom-key">API key <span class="opacity-60 normal-case">(optional — leave blank if not required)</span></label>
                <input id="custom-key" type="password" placeholder="sk-..." bind:value={customForm.apiKey} class="input w-full text-xs" />
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
                      <button type="button" onclick={() => disconnectProvider(prov.key)} class="text-[10px] text-red-400 hover:text-red-300 font-medium transition-colors">Disconnect</button>
                    </div>
                  {:else}
                    <div class="space-y-2">
                      {#if caps.supportsApiKey}
                        <label class="text-[10px] text-[var(--color-text-muted)] font-medium uppercase tracking-wider" for={`provider-key-${prov.key}`}>API Key</label>
                        <input id={`provider-key-${prov.key}`} type="password" placeholder={prov.placeholder} bind:value={providersStore.keyInputs[prov.key]} class="input w-full text-xs" onkeydown={(e) => e.key === 'Enter' && handleConnectProvider(prov.key)} />
                      {/if}
                      {#if showTokenInput(prov.key, caps)}
                        <label class="text-[10px] text-[var(--color-text-muted)] font-medium uppercase tracking-wider" for={`provider-token-${prov.key}`}>Auth Token</label>
                        <input id={`provider-token-${prov.key}`} type="password" placeholder={providersStore.tokenPlaceholders[prov.key] ?? 'Auth token'} bind:value={providersStore.tokenInputs[prov.key]} class="input w-full text-xs" onkeydown={(e) => e.key === 'Enter' && handleConnectProvider(prov.key)} />
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
                          {#if prov.key === 'copilot' && providersStore.copilotDeviceAuth}
                            <div class="rounded-md bg-[var(--color-surface-2)] px-2.5 py-2 text-[10px] text-[var(--color-text-secondary)]">
                              <div>User code: <span class="font-semibold text-[var(--color-text-primary)]">{providersStore.copilotDeviceAuth.userCode}</span></div>
                              <div class="mt-1 break-all">{providersStore.copilotDeviceAuth.verificationUri}</div>
                            </div>
                          {/if}
                          {#if prov.key === 'kimicode' && providersStore.kimicodeDeviceAuth}
                            {@const kimiUserCode = providersStore.kimicodeDeviceAuth.userCode}
                            <div class="rounded-md bg-[var(--color-surface-2)] px-2.5 py-2 text-[10px] text-[var(--color-text-secondary)]">
                              <div class="font-medium text-[var(--color-text-primary)]">Kimi Code sign-in needs approval.</div>
                              <div class="mt-1">The browser was opened automatically.</div>
                              <div>Paste this code if Kimi asks for it.</div>
                              <div class="mt-2 flex items-center gap-2">
                                <span>Code:</span>
                                <span class="font-semibold tracking-[0.18em] text-[var(--color-text-primary)]">{kimiUserCode}</span>
                                <button
                                  type="button"
                                  class="inline-flex items-center gap-1 rounded border border-[var(--color-border)] px-1.5 py-0.5 text-[10px] hover:bg-[var(--color-surface-3)]"
                                  onclick={() => copyToClipboard(kimiUserCode, 'deviceCode')}
                                >
                                  <Copy size={10} />
                                  {providersStore.copiedDeviceCode === kimiUserCode ? 'Copied' : 'Copy code'}
                                </button>
                              </div>
                              <div class="mt-2 text-[10px] text-[var(--color-text-muted)]">
                                Waiting for Kimi Code approval to complete…
                              </div>
                            </div>
                          {/if}
                          {#if prov.key === 'codex' && providersStore.codexDeviceAuth}
                            {@const codexUserCode = providersStore.codexDeviceAuth.userCode}
                            <div class="rounded-md bg-[var(--color-surface-2)] px-2.5 py-2 text-[10px] text-[var(--color-text-secondary)]">
                              <div class="font-medium text-[var(--color-text-primary)]">Codex sign-in needs a code.</div>
                              <div class="mt-1">The browser was opened automatically.</div>
                              <div>Paste this code if Codex asks for it.</div>
                              <div class="mt-2 flex items-center gap-2">
                                <span>Code:</span>
                                <span class="font-semibold tracking-[0.18em] text-[var(--color-text-primary)]">{codexUserCode}</span>
                                <button
                                  type="button"
                                  class="inline-flex items-center gap-1 rounded border border-[var(--color-border)] px-1.5 py-0.5 text-[10px] hover:bg-[var(--color-surface-3)]"
                                  onclick={() => copyToClipboard(codexUserCode, 'deviceCode')}
                                >
                                  <Copy size={10} />
                                  {providersStore.copiedDeviceCode === codexUserCode ? 'Copied' : 'Copy code'}
                                </button>
                              </div>
                              <div class="mt-2 text-[10px] text-[var(--color-text-muted)]">
                                Waiting for Codex approval to complete…
                              </div>
                            </div>
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
                            {#if providersStore.browserAuthPending[prov.key] && prov.key !== 'copilot' && prov.key !== 'codex' && prov.key !== 'kimicode' && prov.key !== 'google-subscription'}
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
                        <input
                          type="password"
                          placeholder={prov.placeholder}
                          bind:value={providersStore.accountKeyInputs[prov.key]}
                          class="input w-full text-xs"
                        />
                      {/if}
                      {#if showTokenInput(prov.key, caps)}
                        <input
                          type="password"
                          placeholder={providersStore.tokenPlaceholders[prov.key] ?? 'Auth token'}
                          bind:value={providersStore.accountTokenInputs[prov.key]}
                          class="input w-full text-xs"
                        />
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
          {#each shortcuts as shortcut}
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
      </div>

      <!-- Billing Tab -->
      <div class={activeTab === 'billing' ? 'flex-1 overflow-y-auto px-6 py-5 space-y-8 w-full max-w-7xl mx-auto' : 'hidden'}>
        <div class="grid grid-cols-1 md:grid-cols-2 gap-6">
          <div class="p-6 rounded-2xl bg-gradient-to-br from-[var(--color-surface-2)] to-[var(--color-surface-1)] border border-[var(--color-border)] shadow-xl relative overflow-hidden">
            <div class="absolute -top-4 -right-4 w-24 h-24 bg-[var(--color-accent)]/5 rounded-full blur-3xl"></div>
            <div class="text-[10px] text-[var(--color-text-muted)] uppercase tracking-widest font-bold mb-2">Total Workspace Spend</div>
            <div class="text-4xl font-black text-[var(--color-text-primary)] flex items-baseline gap-1">
              {#if billingCredits === null}
                <div class="h-10 w-32 bg-[var(--color-surface-3)] animate-pulse rounded-lg"></div>
              {:else}
                <span class="text-2xl opacity-50">$</span>{(billingCredits.totalSpendCents / 100).toFixed(2)}
              {/if}
            </div>
            <p class="text-[10px] text-[var(--color-text-muted)] mt-4">Estimated from local token usage tracking</p>
          </div>

          <div class="p-6 rounded-2xl bg-[var(--color-surface-2)] border border-[var(--color-border)]">
            <div class="text-[10px] text-[var(--color-text-muted)] uppercase tracking-widest font-bold mb-2">Available Budget</div>
            <div class="text-4xl font-black text-emerald-400 flex items-baseline gap-1">
              {#if billingCredits === null}
                <div class="h-10 w-32 bg-[var(--color-surface-3)] animate-pulse rounded-lg"></div>
              {:else}
                <span class="text-2xl opacity-50">$</span>{(billingCredits.remainingCents / 100).toFixed(2)}
              {/if}
            </div>
            <div class="mt-4 h-2 w-full bg-[var(--color-surface-3)] rounded-full overflow-hidden">
              <div class="h-full bg-emerald-500 rounded-full" style="width: 75%"></div>
            </div>
          </div>
        </div>

        <div class="space-y-4">
          <h3 class="text-sm font-bold text-[var(--color-text-primary)] ml-1">Consumption by Provider</h3>
          <div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
            {#if billingCredits?.byProvider}
              {#each billingCredits.byProvider as prov (prov.name)}
                <div class="flex items-center justify-between p-4 bg-[var(--color-surface-2)] rounded-xl border border-[var(--color-border)]">
                  <div class="flex items-center gap-3">
                    <div class="w-8 h-8 rounded-lg bg-[var(--color-surface-3)] flex items-center justify-center p-1.5 shrink-0">
                      <ProviderIcon provider={prov.name} size={20} class="w-full h-full" />
                    </div>
                    <span class="text-xs font-semibold">{getProviderDisplayLabel(prov.name)}</span>
                  </div>
                  <div class="text-xs font-mono font-bold text-[var(--color-text-secondary)]">${(prov.spendCents / 100).toFixed(3)}</div>
                </div>
              {/each}
            {:else}
              <div class="col-span-full py-12 text-center border-2 border-dashed border-[var(--color-border)] rounded-2xl">
                <p class="text-xs text-[var(--color-text-muted)]">No usage data recorded yet</p>
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
            <p class="text-sm text-[var(--color-text-muted)] mt-2">Invite teammates to watch or co-pilot your live AI agent session</p>
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
                  <h4 class="text-sm font-bold text-[var(--color-text-primary)] mb-5">Invite Links — share the right link for each teammate's role</h4>
                  <div class="space-y-3">
                    {#each [
                      { role: 'viewer', label: 'Viewer', desc: 'Watch only — no interaction', color: 'text-blue-400', bg: 'bg-blue-500/10' },
                      { role: 'collaborator', label: 'Collaborator', desc: 'Can submit prompts — you approve each one before agents run', color: 'text-amber-400', bg: 'bg-amber-500/10' },
                      { role: 'copilot', label: 'Co-Pilot', desc: 'Full shared control — prompts execute immediately', color: 'text-[var(--color-accent)]', bg: 'bg-[var(--color-accent)]/10' },
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
                          onclick={() => collaborationStore.copyInviteLink(r.role as any)}
                          class="shrink-0 rounded-xl {r.bg} {r.color} px-4 py-2 text-xs font-bold transition-all hover:opacity-80"
                        >
                          Copy Link
                        </button>
                      </div>
                    {/each}
                  </div>
                {:else}
                  <!-- Relay not configured — show legacy join code -->
                  <div class="text-center">
                    <p class="mb-2 block text-[10px] font-bold uppercase tracking-widest text-[var(--color-text-muted)]">Join Code (local network only)</p>
                    <code class="block rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface-1)] py-4 text-3xl font-black tracking-[0.3em] text-[var(--color-accent)]">
                      {collaborationStore.activeCollab.joinCode || '••••••'}
                    </code>
                    <p class="mt-3 text-[11px] text-[var(--color-text-muted)]">
                      Configure <code class="font-mono">RELAY_URL</code> and <code class="font-mono">RELAY_HOST_SECRET</code> in your environment for internet-accessible invite links.
                    </p>
                  </div>
                {/if}
              </div>

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
            <div class="grid grid-cols-1 md:grid-cols-2 gap-8 max-w-4xl mx-auto">
              <div class="p-8 rounded-3xl bg-[var(--color-surface-2)] border border-[var(--color-border)] hover:border-[var(--color-accent)]/30 transition-all flex flex-col text-center">
                <div class="w-12 h-12 bg-emerald-500/10 text-emerald-400 rounded-2xl flex items-center justify-center mx-auto mb-6">
                  <Zap size={24} />
                </div>
                <h4 class="text-lg font-bold mb-2">Host a Session</h4>
                <p class="text-xs text-[var(--color-text-muted)] mb-8">
                  Generate invite links for teammates to watch or co-pilot your active AI session in real time.
                </p>
                <button
                  type="button"
                  onclick={() => collaborationStore.hostSession()}
                  disabled={collaborationStore.loading}
                  class="btn btn-primary w-full py-3 mt-auto font-bold rounded-xl disabled:opacity-50"
                >
                  {collaborationStore.loading ? 'Starting...' : 'Start Collaboration'}
                </button>
              </div>

              <div class="p-8 rounded-3xl bg-[var(--color-surface-2)] border border-[var(--color-border)] hover:border-[var(--color-accent)]/30 transition-all flex flex-col text-center">
                <div class="w-12 h-12 bg-blue-500/10 text-blue-400 rounded-2xl flex items-center justify-center mx-auto mb-6">
                  <Keyboard size={24} />
                </div>
                <h4 class="text-lg font-bold mb-2">Join via Invite Link</h4>
                <p class="text-xs text-[var(--color-text-muted)] mb-8">
                  Ask the host for their viewer, collaborator, or co-pilot invite link and open it in any browser.
                </p>
                <p class="text-[11px] text-[var(--color-text-muted)] mt-auto">
                  Invite links open a live feed page — no Koryphaios install required.
                </p>
              </div>
            </div>
          {/if}
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
            <input
              type="number"
              min="100"
              max="5000"
              step="100"
              class="input h-8 w-24 text-sm text-right"
              value={notesStore.settings.maxContextTokens}
              oninput={(e) => notesStore.updateSettings({ maxContextTokens: parseInt((e.currentTarget as HTMLInputElement).value, 10) || 2000 })}
            />
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
      <input bind:this={rotateKeyInput} type="password" bind:value={newKeyValue} placeholder="sk-..." class="input w-full text-base py-3 mb-6 font-mono" />
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
            <h3 class="mt-2 text-2xl font-black text-[var(--color-text-primary)]">Enter a profile name before sign-in</h3>
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
          <h3 class="text-base font-semibold text-[var(--color-text-primary)]">Saved Profile</h3>
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
          <div class="mt-1 text-[11px] text-[var(--color-text-muted)]">Use this saved profile name when switching accounts. Model management opens the provider model selector.</div>
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
</style>
