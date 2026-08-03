<script lang="ts">
  import { onMount } from 'svelte';
  import { Send, ChevronDown, Sparkles, Square, Users, User, ShieldCheck, ShieldAlert, Circle, Paperclip, Clipboard, X, Check, Search, Plus, Target, Settings, Zap, Pencil, MessageCircleQuestion, SlidersHorizontal, ZoomIn, ZoomOut, RotateCcw, ClipboardList, Play } from 'lucide-svelte';
  import { wsStore } from '$lib/stores/websocket.svelte';
  import { shortcutStore } from '$lib/stores/shortcuts.svelte';
  import { experimentalStore } from '$lib/stores/experimental.svelte';
  import { agentSettingsStore } from '$lib/stores/agent-settings.svelte';
  import { getReasoningConfig, buildReasoningConfigFromLevels } from '@koryphaios/shared';
  import BrainIcon from '$lib/components/icons/BrainIcon.svelte';
  import ProviderIcon from '$lib/components/icons/ProviderIcon.svelte';
  import { getModelConfigurationWarning } from '$lib/utils/model-config';
  import { invoke } from '@tauri-apps/api/core';
  import { toastStore } from '$lib/stores/toast.svelte';
  import { sessionStore } from '$lib/stores/sessions.svelte';
  import { apiFetch } from '$lib/api.svelte';
  import { apiUrl } from '$lib/utils/api-url';
  import { goalStore } from '$lib/stores/goals.svelte';
  import { goalDisplayStore } from '$lib/stores/goal-display.svelte';

  export type Attachment = { type: 'image' | 'file'; data: string; name: string; mimeType?: string };

  interface Props {
    onSend: (message: string, model?: string, reasoningLevel?: string, attachments?: Attachment[]) => void;
    onExecuteCommand?: (command: string) => Promise<boolean> | boolean;
    /** When true, show Stop instead of Send; clicking stops manager and workers for the session. */
    isRunning?: boolean;
    /** Kory is parked — waiting on a background terminal or your answer. The
     *  button shows a distinct Waiting state; sending is still allowed. */
    isWaiting?: boolean;
    /** What Kory is waiting on, e.g. "background terminal: dev-server". */
    waitingReason?: string;
    onStop?: () => void;
    onOpenSettings?: (section?: 'experimental' | 'agent', agentSection?: 'permissions') => void;
    inputRef?: HTMLTextAreaElement;
    value?: string;
    slashCommands?: Array<{ command: string; label: string; description: string }>;
    fileMentions?: string[];
    onRefreshFileMentions?: (query?: string) => Promise<string[] | void>;
    /** When true, disables input because no project is open */
    disabled?: boolean;
    disabledMessage?: string;
    placeholder?: string;
    /** Optional preselected model for controlled surfaces such as the static demo. */
    initialModel?: string;
    /** Keep context preview entirely client-side on static surfaces with no backend. */
    disableModelPreviewRequests?: boolean;
    interactionMode?: 'act' | 'plan';
    planReady?: boolean;
    planTransitioning?: boolean;
    onInteractionModeChange?: (mode: 'act' | 'plan') => void | Promise<void>;
    onPlanAction?: (action: 'implement' | 'clear-implement' | 'clear-goal' | 'exit') => void | Promise<void>;
    /** Bindable mirror of the composer's selected model (e.g. "claude:sonnet")
     *  so the parent can react to provider changes (e.g. to surface that CLI
     *  provider's native /commands in the slash picker). */
    selectedModel?: string;
  }

  let {
    onSend,
    onExecuteCommand,
    isRunning = false,
    isWaiting = false,
    waitingReason = '',
    onStop,
    onOpenSettings,
    inputRef = $bindable(),
    value = $bindable(''),
    slashCommands = [],
    fileMentions = [],
    onRefreshFileMentions,
    disabled = false,
    disabledMessage = 'Open a project to start chatting',
    placeholder = 'Ask Koryphaios to inspect, explain, or change this project...',
    initialModel = '',
    disableModelPreviewRequests = false,
    interactionMode = 'act',
    planReady = false,
    planTransitioning = false,
    onInteractionModeChange,
    onPlanAction,
    selectedModel = $bindable(''),
  }: Props = $props();
  let actionPanelRef = $state<HTMLDivElement>();
  let showModelPicker = $state(false);
  let modelSearchQuery = $state('');
  const MODEL_STORAGE_KEY = 'koryphaios-selected-model';
  let _storedModel = typeof localStorage !== 'undefined' ? localStorage.getItem(MODEL_STORAGE_KEY) : null;
  if (_storedModel === 'auto') { localStorage.removeItem(MODEL_STORAGE_KEY); _storedModel = null; }
  // Bindable selectedModel: seeded from localStorage once, then kept in sync
  // with the parent so the composer's slash picker can surface the active CLI
  // provider's native /commands.
  if (!selectedModel && _storedModel) selectedModel = _storedModel;
  let lastContextPreviewKey = $state('');
  let selectedPickerIndex = $state(0);
  let attachments = $state<Attachment[]>([]);
  let pendingAttachmentReads = $state(0);
  const attachmentReadTasks = new Set<Promise<void>>();
  let previewAttachment = $state<Attachment | null>(null);
  let previewZoom = $state(1);
  let previewOffsetX = $state(0);
  let previewOffsetY = $state(0);
  let previewDragging = $state(false);
  let previewDragX = 0;
  let previewDragY = 0;
  let referenceFileInputRef = $state<HTMLInputElement>();
  let referenceFolderInputRef = $state<HTMLInputElement>();
  let showReferenceMenu = $state(false);
  let showGoalActions = $state(false);
  let liveFileMentions = $state<string[]>([]);

  $effect(() => {
    if (!selectedModel && initialModel) selectedModel = initialModel;
  });

  type ComposerPickerItem =
    | { type: 'command'; key: string; label: string; value: string; description: string }
    | { type: 'file'; key: string; label: string; value: string; description: string };

  function providerLabel(provider: string): string {
    if (provider === 'openai') return 'OpenAI';
    if (provider === 'codex') return 'Codex CLI';
    if (provider === 'codex-auth') return 'OpenAI Codex';
    if (provider === 'anthropic') return 'Anthropic';
    if (provider === 'claude') return 'Claude Code';
    if (provider === 'antigravity') return 'Antigravity';
    if (provider === 'jules') return 'Jules (cloud)';
    if (provider === 'google') return 'Google';
    if (provider === 'aistudio') return 'Google AI Studio';
    if (provider === 'xai') return 'xAI';
    if (provider === 'openrouter') return 'OpenRouter';
    if (provider === 'vertexai') return 'Vertex AI';
    if (provider === 'copilot') return 'Copilot';
    if (provider === 'kimicode') return 'Kimi Code';
    if (provider === 'grok') return 'Grok Build';
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

  let fallbackProvider = $derived.by(() => {
    const preferred = wsStore.providers.find((p) => p.enabled && p.authenticated);
    return preferred?.name ?? 'anthropic';
  });

  let currentProvider = $derived(!selectedModel ? fallbackProvider : (parseModelSelection(selectedModel).provider ?? fallbackProvider));
  let currentModel = $derived(parseModelSelection(selectedModel).model);

  /** A model's own live-reported effort levels (e.g. Codex's supported_reasoning_levels) take
   *  priority over the static ReasoningConfig tables, which can go stale as providers ship
   *  new models/levels. */
  function findModelDef(provider: string, model: string | undefined): { reasoningLevels?: string[]; canReason?: boolean } | undefined {
    if (!model) return undefined;
    const p = wsStore.providers.find((p) => p.name === provider);
    const catalog = (p as any)?.allAvailableModels as Array<{ id: string; reasoningLevels?: string[]; canReason?: boolean }> | undefined;
    return catalog?.find((m) => m.id === model);
  }

  function effectiveReasoningConfig(provider: string, model: string | undefined) {
    const def = findModelDef(provider, model);
    // 1. Levels the provider/CLI reported for this exact model are authoritative —
    //    including an explicit [] meaning "this model has NO effort control"
    //    (e.g. Claude Code's Haiku 4.5). Only an ABSENT array falls through.
    if (Array.isArray(def?.reasoningLevels)) {
      return buildReasoningConfigFromLevels(def.reasoningLevels);
    }
    return (
      // 2. Static per-provider/model rules.
      getReasoningConfig(provider, model) ??
      // 3. Universal fallback: any reasoning-capable model gets at least the
      //    standard effort tiers — providers map/guard what's actually sent,
      //    so no provider is silently excluded from the picker.
      (def?.canReason ? buildReasoningConfigFromLevels(['low', 'medium', 'high']) : null)
    );
  }

  let reasoningConfig = $derived(!selectedModel ? null : effectiveReasoningConfig(currentProvider, currentModel));
  let reasoningSupported = $derived(!!selectedModel && !!reasoningConfig && reasoningConfig.options.length > 0);

  let showPermissionMenu = $state(false);

  const PERMISSION_OPTIONS = [
    { value: 'yolo', label: 'YOLO', description: 'Run every action without Kory approval or risk checks, including destructive commands.', icon: Zap, tone: 'text-amber-300' },
    { value: 'guarded', label: 'Guarded', description: 'Default. Accept routine work; block risky commands and ask before destructive ones.', icon: ShieldCheck, tone: 'text-emerald-300' },
    { value: 'edits', label: 'Accept edits', description: 'Apply file edits automatically; ask before other actions.', icon: Pencil, tone: 'text-sky-300' },
    { value: 'ask', label: 'Ask', description: 'Ask before every action.', icon: MessageCircleQuestion, tone: 'text-[var(--color-text-secondary)]' },
    { value: 'custom', label: 'Custom', description: 'Use the detailed approval rules from Settings.', icon: SlidersHorizontal, tone: 'text-violet-300' },
  ] as const;

  type PermissionMode = (typeof PERMISSION_OPTIONS)[number]['value'];

  let permissionMode = $derived((agentSettingsStore.settings.permissionMode === 'plan' ? 'guarded' : agentSettingsStore.settings.permissionMode ?? 'guarded') as PermissionMode);
  let permissionModeMeta = $derived(PERMISSION_OPTIONS.find((option) => option.value === permissionMode) ?? PERMISSION_OPTIONS[1]);

  // Keep the legacy live YOLO bridge aligned when a saved workspace policy is
  // loaded, rather than only after the picker is touched.
  $effect(() => {
    wsStore.setYoloMode(permissionMode === 'yolo');
  });

  function selectPermissionMode(next: PermissionMode) {
    showPermissionMenu = false;
    if (permissionMode !== next) {
      void agentSettingsStore.saveSettings({ ...agentSettingsStore.settings, permissionMode: next }, { quietSuccess: true });
    }
    if (next === 'custom') onOpenSettings?.('agent', 'permissions');
  }

  const configurationWarning = $derived(
    disabled ? null : getModelConfigurationWarning(wsStore.providers, selectedModel),
  );

  /** "200k" / "1M" / "272k" — compact real context window for the picker. */
  function formatContextSize(tokens: number | undefined): string {
    if (!tokens || tokens <= 0) return '';
    if (tokens >= 1_000_000) {
      const m = tokens / 1_000_000;
      return `${Number.isInteger(m) ? m : m.toFixed(1)}M`;
    }
    return `${Math.round(tokens / 1000)}k`;
  }

  let availableModels = $derived.by(() => {
    const models: Array<{ label: string; value: string; provider: string; contextWindow?: number }> = [];
    for (const p of wsStore.providers) {
      if (p.authenticated) {
        const enabledIds = new Set(p.models);
        const catalog = (p as any).allAvailableModels as Array<{ id: string; name: string; contextWindow?: number; contextVerified?: boolean }> | undefined;
        if (catalog && catalog.length > 0) {
          for (const m of catalog) {
            if (enabledIds.size === 0 || enabledIds.has(m.id)) {
              models.push({
                label: `(${providerLabel(p.name)}) ${m.name}`,
                value: `${p.name}:${m.id}`,
                provider: p.name,
                // Verified window size kept internally for the switch-overflow
                // guard — deliberately NOT shown in the picker.
                contextWindow: m.contextVerified ? m.contextWindow : undefined,
              });
            }
          }
        } else {
          for (const m of p.models) {
            // Same "(Provider) model" labeling as the rich-catalog branch —
            // bare-id providers shouldn't render as anonymous raw strings.
            models.push({ label: `(${providerLabel(p.name)}) ${m}`, value: `${p.name}:${m}`, provider: p.name });
          }
        }
      }
    }
    return models;
  });

  let filteredQuickModels = $derived.by(() => {
    const query = modelSearchQuery.trim().toLowerCase();
    if (!query) return availableModels;
    return availableModels.filter((model) =>
      `${model.label} ${model.provider} ${model.value}`.toLowerCase().includes(query),
    );
  });

  let selectedModelLabel = $derived.by(() => {
    if (!selectedModel) return 'Select model';
    const parsed = parseModelSelection(selectedModel);
    if (!parsed.model || !parsed.provider) return selectedModel;
    const provider = wsStore.providers.find(p => p.name === parsed.provider);
    const catalog = (provider as any)?.allAvailableModels as Array<{ id: string; name: string }> | undefined;
    const modelDef = catalog?.find(m => m.id === parsed.model);
    if (modelDef) return `(${providerLabel(parsed.provider)}) ${modelDef.name}`;
    return parsed.model;
  });

  let contextPreviewGeneration = 0;

  async function previewSelectedModelContext(value: string) {
    const sid = sessionStore.activeSessionId;
    if (!sid || !value) return;
    const generation = ++contextPreviewGeneration;
    const target = availableModels.find((m) => m.value === value);
    wsStore.setManagerContextWindow(sid, target?.contextWindow);
    if (disableModelPreviewRequests) return;
    const { provider, model } = parseModelSelection(value);
    if (provider && model) {
      // listModels() starts provider/CLI discovery in the background. Recheck
      // a few times so a live limit replaces the catalog fallback as soon as
      // discovery lands, without requiring another model change or message.
      for (const delay of [0, 1_000, 3_000, 6_000]) {
        if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
        if (
          generation !== contextPreviewGeneration ||
          sessionStore.activeSessionId !== sid ||
          selectedModel !== value
        ) return;
        try {
          const response = await apiFetch(apiUrl(`/api/sessions/${sid}/context/model-preview`), {
            method: 'POST',
            body: JSON.stringify({ model, provider }),
          });
          const result = await response.json() as {
            usage?: {
              contextWindow?: number;
              contextKnown?: boolean;
              contextSource?: 'live' | 'catalog' | 'alias';
            };
          };
          if (generation !== contextPreviewGeneration) return;
          wsStore.setManagerContextWindow(
            sid,
            result.usage?.contextKnown ? result.usage.contextWindow : undefined,
          );
          if (result.usage?.contextSource === 'live' || result.usage?.contextSource === 'alias') return;
        } catch {
          // Keep the current value and allow the next discovery recheck.
        }
      }
    }
  }

  // Also preview a model restored from local storage, or when a new session
  // becomes active. Previously context metadata only appeared after the first
  // message unless the user manually changed the picker during that session.
  $effect(() => {
    const sid = sessionStore.activeSessionId;
    const model = selectedModel;
    // Track catalog changes so a late provider discovery can replace an
    // initially unknown window with verified metadata.
    const targetWindow = availableModels.find((m) => m.value === model)?.contextWindow ?? 0;
    const key = sid && model ? `${sid}:${model}:${targetWindow}` : '';
    if (!key || key === lastContextPreviewKey) return;
    lastContextPreviewKey = key;
    previewSelectedModelContext(model);
  });

  // Cooldown to prevent duplicate sends (double Enter, key repeat, double-click)
  const SEND_COOLDOWN_MS = 800;
  let lastSendAt = $state(0);

  function getCaretPosition(): number {
    return inputRef?.selectionStart ?? value.length;
  }

  function getTriggerContext() {
    const caret = getCaretPosition();
    const beforeCaret = value.slice(0, caret);

    const atMatch = beforeCaret.match(/(?:^|\s)@([^\s]*)$/);
    if (atMatch && atMatch.index != null) {
      return {
        trigger: '@' as const,
        query: atMatch[1] ?? '',
        start: atMatch.index + (atMatch[0].startsWith(' ') ? 1 : 0),
        end: caret,
      };
    }

    const slashMatch = beforeCaret.match(/(?:^|\s)\/([^\s]*)$/);
    if (slashMatch && slashMatch.index != null) {
      return {
        trigger: '/' as const,
        query: slashMatch[1] ?? '',
        start: slashMatch.index + (slashMatch[0].startsWith(' ') ? 1 : 0),
        end: caret,
      };
    }

    return null;
  }

  let triggerContext = $derived(getTriggerContext());
  let mentionPaths = $derived(
    liveFileMentions.length > 0 ? liveFileMentions : fileMentions,
  );

  let pickerItems = $derived.by<ComposerPickerItem[]>(() => {
    const ctx = triggerContext;
    if (!ctx) return [];
    const query = ctx.query.trim().toLowerCase();

    if (ctx.trigger === '/') {
      return slashCommands
        .filter((item) => !query || item.command.toLowerCase().includes(query) || item.label.toLowerCase().includes(query))
        .slice(0, 8)
        .map((item) => ({
          type: 'command' as const,
          key: item.command,
          label: item.label,
          value: item.command,
          description: item.description,
        }));
    }

    return mentionPaths
      .filter((path) => !query || path.toLowerCase().includes(query))
      .slice(0, 20)
      .map((path) => ({
        type: 'file' as const,
        key: path,
        label: path.split('/').pop() || path,
        value: path,
        description: path,
      }));
  });
  let pickerOpen = $derived(!!triggerContext && (triggerContext.trigger === '@' || pickerItems.length > 0));

  $effect(() => {
    if (fileMentions.length > 0) liveFileMentions = fileMentions;
  });

  $effect(() => {
    const ctx = triggerContext;
    if (!ctx || ctx.trigger !== '@' || !onRefreshFileMentions) return;
    void onRefreshFileMentions(ctx.query).then((paths) => {
      if (Array.isArray(paths)) liveFileMentions = paths;
    });
  });

  $effect(() => {
    pickerItems;
    selectedPickerIndex = 0;
  });

  function replaceRange(start: number, end: number, nextText: string) {
    value = value.slice(0, start) + nextText + value.slice(end);
  }

  async function focusComposer() {
    await Promise.resolve();
    inputRef?.focus();
  }

  async function applyPickerItem(item: ComposerPickerItem): Promise<void> {
    const ctx = triggerContext;
    if (!ctx) return;

    if (item.type === 'command') {
      value = '';
      await onExecuteCommand?.(`/${item.value}`);
      resizeToMin();
      return;
    }

    replaceRange(ctx.start, ctx.end, `@${item.value} `);
    await focusComposer();
  }

  async function executeSlashIfNeeded(): Promise<boolean> {
    const trimmed = value.trim();
    if (!trimmed.startsWith('/')) return false;
    const handled = await onExecuteCommand?.(trimmed);
    if (handled) {
      value = '';
      resizeToMin();
      return true;
    }
    return false;
  }

  function handleKeydown(e: KeyboardEvent) {
    if (e.repeat) return; // ignore key repeat (e.g. holding Enter)
    // Shift+Tab cycles permission modes — handled globally in +page.svelte so it
    // works whether or not the composer is focused. Let it bubble by not calling
    // preventDefault here; the global handler will preventDefault when appropriate.
    if (e.key === 'Tab' && e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey && !pickerOpen) {
      return;
    }
    if (pickerOpen && pickerItems.length > 0) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        selectedPickerIndex = (selectedPickerIndex + 1) % pickerItems.length;
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        selectedPickerIndex = (selectedPickerIndex - 1 + pickerItems.length) % pickerItems.length;
        return;
      }
      if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey)) {
        e.preventDefault();
        void applyPickerItem(pickerItems[selectedPickerIndex]);
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        inputRef?.focus();
        return;
      }
    }
    const pasteTextMatches = shortcutStore.matches('paste_text', e);
    const pasteImageMatches = shortcutStore.matches('paste_image', e);
    if (pasteTextMatches && pasteImageMatches) {
      // Windows and macOS intentionally use the native shared paste binding.
      // Let the regular paste event choose an image when present, otherwise text.
      e.stopPropagation();
      return;
    }

    if (pasteTextMatches) {
      e.preventDefault();
      e.stopPropagation();
      void pasteTextFromClipboard();
      return;
    }

    if (pasteImageMatches) {
      e.preventDefault();
      e.stopPropagation();
      void pasteImageFromClipboard();
      return;
    }

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

  async function send() {
    if (disabled) return;
    if (!selectedModel) {
      showModelPicker = true;
      return;
    }
    if (configurationWarning) {
      onOpenSettings?.();
      return;
    }
    if (await executeSlashIfNeeded()) return;
    // Clipboard files are converted asynchronously. Wait for an in-flight
    // conversion so pressing Enter immediately after Ctrl/Cmd+V cannot send a
    // text-only message and silently discard the image.
    if (attachmentReadTasks.size > 0) await Promise.all([...attachmentReadTasks]);
    const trimmed = value.trim();
    if (!trimmed && attachments.length === 0) return;
    const now = Date.now();
    if (now - lastSendAt < SEND_COOLDOWN_MS) return; // debounce duplicate sends
    lastSendAt = now;
    const goal = goalStore.selectedGoal;
    if (goal) {
      void goalStore.drive(goal.id, { model: selectedModel, reasoningLevel, instructions: trimmed }).catch((error) => toastStore.error(error instanceof Error ? error.message : String(error)));
      value = '';
      attachments = [];
      return;
    }
    onSend(trimmed, selectedModel, reasoningLevel, attachments.length > 0 ? [...attachments] : undefined);
    value = '';
    attachments = [];
    resizeToMin();
  }

  function stop() {
    onStop?.();
  }

  const BASE_MIN_HEIGHT_PX = 88;
  const MAX_HEIGHT_PX = 280;
  let minHeightPx = $state(BASE_MIN_HEIGHT_PX);
  let composerResizeFrame: number | null = null;

  function syncComposerMinHeight() {
    if (typeof window === 'undefined') return;
    const isDesktopTwoColumn = window.innerWidth >= 1280;
    const actionPanelHeight = actionPanelRef?.getBoundingClientRect().height ?? 0;
    minHeightPx = isDesktopTwoColumn
      ? Math.max(BASE_MIN_HEIGHT_PX, Math.ceil(actionPanelHeight))
      : BASE_MIN_HEIGHT_PX;
  }

  function resizeToMin() {
    if (!inputRef) return;
    inputRef.style.height = 'auto';
    inputRef.style.height = minHeightPx + 'px';
  }

  function autoResize() {
    if (!inputRef) return;
    inputRef.style.height = 'auto';
    const h = inputRef.scrollHeight;
    inputRef.style.height = Math.max(minHeightPx, Math.min(h, MAX_HEIGHT_PX)) + 'px';
  }

  function scheduleComposerResize() {
    if (composerResizeFrame !== null) return;
    composerResizeFrame = requestAnimationFrame(() => {
      composerResizeFrame = null;
      syncComposerMinHeight();
      autoResize();
    });
  }

  onMount(() => {
    if (typeof window === "undefined") return;

    // Global Esc listener to stop running agent
    const handleGlobalEsc = (e: KeyboardEvent) => {
      if (
        e.key === "Escape" &&
        isRunning &&
        !showModelPicker &&
        !showReasoningMenu &&
        !pickerOpen
      ) {
        stop();
      }
    };
    window.addEventListener("keydown", handleGlobalEsc);
    const handlePasteImageShortcut = () => void pasteImageFromClipboard();
    const handlePreferredPasteShortcut = () => void (async () => {
      if (await tryPasteImageFromClipboard()) return;
      await pasteTextFromClipboard();
    })();
    window.addEventListener('koryphaios:paste-image', handlePasteImageShortcut);
    window.addEventListener('koryphaios:paste-preferred', handlePreferredPasteShortcut);

    const resizeObserver = new ResizeObserver(() => {
      // Writing textarea height while ResizeObserver delivers can retrigger
      // layout in the same notification cycle. Coalesce the write to the next
      // frame instead, after the browser completes its observation pass.
      scheduleComposerResize();
    });

    if (actionPanelRef) {
      resizeObserver.observe(actionPanelRef);
    }

    const handleWindowResize = () => {
      syncComposerMinHeight();
      autoResize();
    };

    window.addEventListener("resize", handleWindowResize);
    scheduleComposerResize();

    return () => {
      resizeObserver.disconnect();
      if (composerResizeFrame !== null) cancelAnimationFrame(composerResizeFrame);
      composerResizeFrame = null;
      window.removeEventListener("resize", handleWindowResize);
      window.removeEventListener("keydown", handleGlobalEsc);
      window.removeEventListener('koryphaios:paste-image', handlePasteImageShortcut);
      window.removeEventListener('koryphaios:paste-preferred', handlePreferredPasteShortcut);
    };
  });

  $effect(() => {
    actionPanelRef;
    if (typeof requestAnimationFrame === 'undefined') return;
    requestAnimationFrame(() => {
      syncComposerMinHeight();
      autoResize();
    });
  });

  $effect(() => {
    value; // track value so we resize when it changes (e.g. paste or programmatic set)
    if (typeof requestAnimationFrame === 'undefined') return;
    requestAnimationFrame(() => autoResize());
  });

  // Set when the user picks a model whose window can't hold the current
  // session context — they choose how to shrink it instead of a silent break.
  let overflowWarning = $state<{ value: string; label: string; window: number; used: number } | null>(null);

  function applyModelSelection(value: string) {
    selectedModel = value;
    showModelPicker = false;
    if (typeof localStorage !== 'undefined') localStorage.setItem(MODEL_STORAGE_KEY, value);
    // Re-baseline the context bar immediately (optimistic, from local model
    // data), then ask the backend for the trusted window — the backend answer
    // arrives as a normal stream.usage event and always wins. Works for every
    // harness and API provider.
    previewSelectedModelContext(value);
  }

  function selectModel(value: string) {
    const target = availableModels.find((m) => m.value === value);
    const usage = wsStore.contextUsage;
    if (
      target?.contextWindow &&
      usage.isReliable &&
      usage.used > target.contextWindow
    ) {
      showModelPicker = false;
      overflowWarning = {
        value,
        label: target.label,
        window: target.contextWindow,
        used: usage.used,
      };
      return;
    }
    applyModelSelection(value);
  }

  function overflowAskAgentPrune() {
    const w = overflowWarning;
    if (!w) return;
    overflowWarning = null;
    onSend(
      `I want to switch to ${w.label}, which has a ~${formatContextSize(w.window)} context window, but this session currently uses ~${formatContextSize(w.used)} tokens. Please prune your context down below ${formatContextSize(w.window)}: run fetch_context (no arguments) to review what you did, then prune_context on everything nonessential. Keep only what's needed to continue.`,
      selectedModel,
      reasoningLevel,
    );
  }

  async function overflowCompact() {
    overflowWarning = null;
    await onExecuteCommand?.('/compact');
    toastStore.info('Once compaction finishes, pick the model again.');
  }

  async function overflowNewChat() {
    const w = overflowWarning;
    overflowWarning = null;
    await onExecuteCommand?.('/new');
    if (w) applyModelSelection(w.value);
  }

  function selectReasoning(value: string) {
    reasoningLevel = value;
    showReasoningMenu = false;
  }

  function reasoningLabel(value: string): string {
    const config = effectiveReasoningConfig(currentProvider, currentModel);
    if (config) {
      const opt = config.options.find(o => o.value === value);
      if (opt) return opt.label;
    }
    // Fallback for Auto/None/Max etc
    if (value === 'none') return 'None';
    if (value === 'low') return 'Low';
    if (value === 'medium') return 'Medium';
    if (value === 'high') return 'High';
    if (value === 'xhigh') return 'max/xhigh';
    if (value === 'max') return 'Max';
    if (value === 'adaptive') return 'Auto';
    return value;
  }

  let modelDisplayName = $derived.by(() => {
    if (!selectedModel) return '';
    const modelId = currentModel;
    if (!modelId) return currentProvider.charAt(0).toUpperCase() + currentProvider.slice(1);
    const provider = wsStore.providers.find(p => p.name === currentProvider);
    const catalog = (provider as any)?.allAvailableModels as Array<{ id: string; name: string }> | undefined;
    const modelDef = catalog?.find(m => m.id === modelId);
    if (modelDef) return modelDef.name;
    return modelId.split('-').map((word: string) => word.charAt(0).toUpperCase() + word.slice(1)).join(' ');
  });

  function handleClickOutside(e: MouseEvent) {
    const target = e.target as HTMLElement;
    if (!target.closest('.model-picker')) showModelPicker = false;
    if (!target.closest('.reasoning-picker')) showReasoningMenu = false;
    if (!target.closest('.permission-picker')) showPermissionMenu = false;
    if (!target.closest('.reference-picker')) showReferenceMenu = false;
    if (!target.closest('.agent-mode-picker')) showAgentModeMenu = false;
  }

  let canSend = $derived(!disabled && !configurationWarning && (value.trim().length > 0 || attachments.length > 0 || pendingAttachmentReads > 0));

  // Dropdown, not a blind cycle button — all three modes stay visible and
  // pickable without clicking through the others.
  let showAgentModeMenu = $state(false);

  const AGENT_MODE_OPTIONS = [
    { value: 'auto', label: 'Auto', description: 'Kory decides per task', icon: Sparkles },
    { value: 'single', label: 'Single Agent', description: 'One agent handles everything', icon: User },
    { value: 'multi', label: 'Multi-Agent', description: 'Always delegate to specialist workers', icon: Users },
  ] as const;

  function setAgentExecutionMode(next: 'auto' | 'single' | 'multi') {
    showAgentModeMenu = false;
    if ((agentSettingsStore.settings.agentExecutionMode ?? 'auto') === next) return;
    void agentSettingsStore.saveSettings({
      ...agentSettingsStore.settings,
      agentExecutionMode: next,
    }, { quietSuccess: true });
  }

  let agentExecutionModeMeta = $derived.by(() => {
    const mode = agentSettingsStore.settings.agentExecutionMode ?? 'auto';
    if (mode === 'multi') {
      return {
        label: 'Multi-Agent',
        title: 'Agent Mode: Multi-Agent',
        icon: Users,
        className: 'bg-indigo-500/20 text-indigo-400 border border-indigo-500/30',
      };
    }
    if (mode === 'single') {
      return {
        label: 'Single Agent',
        title: 'Agent Mode: Single Agent',
        icon: User,
        className: 'bg-[var(--color-surface-3)] text-[var(--color-text-secondary)] border border-[var(--color-border)] hover:brightness-110',
      };
    }
    return {
      label: 'Auto',
      title: 'Agent Mode: Auto',
      icon: Sparkles,
      className: 'bg-emerald-500/14 text-emerald-300 border border-emerald-500/25 hover:brightness-110',
    };
  });

  function formatFileReference(path: string): string {
    return path.includes(' ') ? `@"${path}"` : `@${path}`;
  }

  function insertFileReference(path: string): void {
    const ref = formatFileReference(path);
    const caret = getCaretPosition();
    const before = value.slice(0, caret);
    const after = value.slice(caret);
    const needsSpace = before.length > 0 && !/\s$/.test(before);
    value = before + (needsSpace ? ' ' : '') + ref + ' ' + after;
    void focusComposer();
    requestAnimationFrame(() => autoResize());
  }

  function handleReferenceFileInput(e: Event) {
    const target = e.target as HTMLInputElement;
    if (!target.files?.length) return;
    for (const file of target.files) {
      const path =
        (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name;
      insertFileReference(path);
    }
    target.value = '';
    showReferenceMenu = false;
  }

  function handleReferenceFolderInput(e: Event) {
    const target = e.target as HTMLInputElement;
    if (!target.files?.length) return;
    const paths = new Set<string>();
    for (const file of target.files) {
      const rel = (file as File & { webkitRelativePath?: string }).webkitRelativePath;
      if (rel) {
        const folder = rel.includes('/') ? rel.split('/').slice(0, -1).join('/') : rel;
        if (folder) paths.add(folder.endsWith('/') ? folder : `${folder}/`);
      }
    }
    for (const path of paths) insertFileReference(path);
    target.value = '';
    showReferenceMenu = false;
  }

  async function pickReferenceFiles() {
    showReferenceMenu = false;
    const inTauri = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
    if (inTauri) {
      try {
        const selected = await invoke<string[] | null>('select_files_dialog');
        if (selected?.length) {
          for (const path of selected) insertFileReference(path);
        }
        return;
      } catch {
        // Fall through to browser picker
      }
    }
    referenceFileInputRef?.click();
  }

  async function pickReferenceFolder() {
    showReferenceMenu = false;
    const inTauri = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
    if (inTauri) {
      try {
        const selected = await invoke<string | null>('select_folder_dialog');
        if (selected) insertFileReference(selected.endsWith('/') ? selected : `${selected}/`);
        return;
      } catch {
        // Fall through to browser picker
      }
    }
    referenceFolderInputRef?.click();
  }

  function removeAttachment(index: number) {
    attachments = attachments.filter((_, i) => i !== index);
  }

  function clampPreviewZoom(value: number): number {
    return Math.min(6, Math.max(0.5, value));
  }

  function resetAttachmentPreview() {
    previewZoom = 1;
    previewOffsetX = 0;
    previewOffsetY = 0;
  }

  function openAttachmentPreview(attachment: Attachment) {
    previewAttachment = attachment;
    resetAttachmentPreview();
  }

  function closeAttachmentPreview() {
    previewAttachment = null;
    previewDragging = false;
  }

  function zoomAttachmentPreview(delta: number) {
    previewZoom = clampPreviewZoom(previewZoom + delta);
  }

  function handlePreviewWheel(event: WheelEvent) {
    event.preventDefault();
    zoomAttachmentPreview(event.deltaY < 0 ? 0.2 : -0.2);
  }

  function startPreviewDrag(event: PointerEvent) {
    previewDragging = true;
    previewDragX = event.clientX - previewOffsetX;
    previewDragY = event.clientY - previewOffsetY;
    (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
  }

  function movePreviewDrag(event: PointerEvent) {
    if (!previewDragging) return;
    previewOffsetX = event.clientX - previewDragX;
    previewOffsetY = event.clientY - previewDragY;
  }

  function imageExtension(mimeType: string): string {
    return mimeType === 'image/jpeg' ? 'jpg'
      : mimeType === 'image/gif' ? 'gif'
      : mimeType === 'image/webp' ? 'webp'
      : mimeType === 'image/avif' ? 'avif'
      : 'png';
  }

  function imageAttachmentFromBlob(blob: Blob, name?: string): Promise<Attachment> {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        const result = reader.result;
        if (typeof result !== 'string') return reject(new Error('Could not read clipboard image'));
        const mimeType = blob.type || 'image/png';
        resolve({
          type: 'image',
          data: result.split(',', 2)[1] ?? '',
          name: name || `clipboard-image.${imageExtension(mimeType)}`,
          mimeType,
        });
      };
      reader.onerror = () => reject(reader.error ?? new Error('Could not read clipboard image'));
      reader.readAsDataURL(blob);
    });
  }

  function addClipboardImage(blob: Blob, name?: string): Promise<void> {
    pendingAttachmentReads++;
    let task: Promise<void>;
    task = imageAttachmentFromBlob(blob, name)
      .then((attachment) => {
        attachments = [...attachments, attachment];
      })
      .catch((error) => {
        console.error('[CommandInput] clipboard image read failed:', error);
        toastStore.error('Could not attach the clipboard image');
      })
      .finally(() => {
        pendingAttachmentReads--;
        attachmentReadTasks.delete(task);
      });
    attachmentReadTasks.add(task);
    return task;
  }

  async function tauriClipboardImageBlob(): Promise<Blob | null> {
    if (typeof window === 'undefined' || !('__TAURI_INTERNALS__' in window)) return null;
    const { readImage } = await import('@tauri-apps/plugin-clipboard-manager');
    const image = await readImage();
    try {
      const [rgba, size] = await Promise.all([image.rgba(), image.size()]);
      if (!size.width || !size.height || rgba.length === 0) return null;
      const canvas = document.createElement('canvas');
      canvas.width = size.width;
      canvas.height = size.height;
      const context = canvas.getContext('2d');
      if (!context) throw new Error('Image canvas is unavailable');
      context.putImageData(
        new ImageData(new Uint8ClampedArray(rgba), size.width, size.height),
        0,
        0,
      );
      return await new Promise<Blob>((resolve, reject) => {
        canvas.toBlob(
          (blob) => blob ? resolve(blob) : reject(new Error('Could not encode clipboard image')),
          'image/png',
        );
      });
    } finally {
      await image.close();
    }
  }

  async function tryPasteImageFromClipboard(): Promise<boolean> {
    // Try browser clipboard first (works for images copied from web pages)
    try {
      const clipboardItems = await navigator.clipboard.read();
      for (const item of clipboardItems) {
        for (const type of item.types) {
          if (type.startsWith('image/')) {
            const blob = await item.getType(type);
            await addClipboardImage(blob, `clipboard-image.${imageExtension(type)}`);
            return true;
          }
        }
      }
    } catch (_) {
      // navigator.clipboard.read() may fail if permission denied — fall through to Tauri
    }

    // Tauri native clipboard (for OS-level screenshot tools)
    try {
      const blob = await tauriClipboardImageBlob();
      if (blob) {
        await addClipboardImage(blob, 'clipboard-image.png');
        return true;
      }
    } catch {
      // The clipboard may contain text rather than an image.
    }

    return false;
  }

  /** Force-paste image from OS clipboard (bypasses text). */
  async function pasteImageFromClipboard() {
    if (!(await tryPasteImageFromClipboard())) toastStore.error('No image found in clipboard');
  }

  async function pasteTextFromClipboard() {
    const text = await navigator.clipboard.readText().catch(() => '');
    if (!text || !inputRef) return;
    const start = inputRef.selectionStart ?? value.length;
    const end = inputRef.selectionEnd ?? value.length;
    value = value.slice(0, start) + text + value.slice(end);
    requestAnimationFrame(() => {
      if (!inputRef) return;
      const newPos = start + text.length;
      inputRef.selectionStart = newPos;
      inputRef.selectionEnd = newPos;
      inputRef.focus();
    });
  }

  // Guards against a browser delivering the same ClipboardEvent twice.
  let lastPasteEvent: ClipboardEvent | null = null;

  /** Ctrl+V / Cmd+V → paste image if available, else text. */
  function handlePaste(e: ClipboardEvent) {
    // If this exact event was already handled, skip.
    if (lastPasteEvent === e) return;
    lastPasteEvent = e;

    const items = e.clipboardData?.items;
    const imageFiles: File[] = [];
    if (items) {
      for (const item of items) {
        if (item.type.startsWith('image/')) {
          const file = item.getAsFile();
          if (file) imageFiles.push(file);
        }
      }
    }

    // WebKit/Tauri can expose pasted images only through clipboardData.files.
    // Use it as a fallback, without duplicating files we already got from items.
    if (imageFiles.length === 0) {
      for (const file of Array.from(e.clipboardData?.files ?? [])) {
        if (file.type.startsWith('image/')) imageFiles.push(file);
      }
    }

    if (imageFiles.length > 0) {
      e.preventDefault();
      for (const file of imageFiles) void addClipboardImage(file, file.name || undefined);
      requestAnimationFrame(() => { lastPasteEvent = null; });
      return;
    }

    e.preventDefault();

    // Focus the input if we're not already there
    inputRef?.focus();

    // Some Linux WebKit/Tauri builds omit image files from ClipboardEvent.
    // Check the native image clipboard before falling back to text.
    void (async () => {
      if (await tryPasteImageFromClipboard()) return;
      const text = await navigator.clipboard.readText().catch(() => '');
      if (text && inputRef) {
        const start = inputRef.selectionStart ?? value.length;
        const end = inputRef.selectionEnd ?? value.length;
        value = value.slice(0, start) + text + value.slice(end);
        requestAnimationFrame(() => {
          if (inputRef) {
            const newPos = start + text.length;
            inputRef.selectionStart = newPos;
            inputRef.selectionEnd = newPos;
            inputRef.focus();
          }
        });
      }
    })();

    // Clear the guard after a tick so a new paste works
    requestAnimationFrame(() => {
      lastPasteEvent = null;
    });
  }
</script>

<svelte:window onclick={handleClickOutside} />

<div class="command-input px-4 py-3">
  <!-- No project: show error -->
  {#if disabled}
    <div class="mb-4 px-4 py-3 rounded-xl text-sm font-medium flex items-center gap-2" style="background: rgba(245, 158, 11, 0.12); border: 1px solid rgba(245, 158, 11, 0.35); color: var(--color-text-primary);">
      <span class="text-amber-400">⚠</span>
      <span>{disabledMessage}</span>
    </div>
  {/if}

  <!-- No provider: show blocking setup state -->
  {#if !disabled && configurationWarning}
    <div class="mb-4 flex items-center justify-between gap-3 px-4 py-3 rounded-xl" style="background: rgba(239, 68, 68, 0.12); border: 1px solid rgba(239, 68, 68, 0.35); color: var(--color-text-primary);">
      <div class="flex items-center gap-2 min-w-0">
        <span class="text-red-400 font-semibold shrink-0">Setup required</span>
        <span class="text-sm min-w-0" style="color: var(--color-text-secondary);">{configurationWarning}</span>
      </div>
      <button
        type="button"
        class="btn btn-secondary shrink-0"
        onclick={() => onOpenSettings?.()}
      >
        Open Settings
      </button>
    </div>
  {/if}

  <div class="composer-shell rounded-[20px] px-5 py-3" style="background: rgba(12, 10, 9, 0.2);">
    {#if interactionMode === 'plan'}
      <section class="mb-3 rounded-xl border border-cyan-400/25 bg-cyan-400/[0.06] p-3" aria-label="Plan mode">
        <div class="flex flex-wrap items-start justify-between gap-3">
          <div class="min-w-0">
            <div class="flex items-center gap-2 text-sm font-semibold text-cyan-200"><ClipboardList size={16} /> Plan mode</div>
            <p class="mt-1 max-w-3xl text-xs leading-relaxed text-[var(--color-text-secondary)]">
              Kory will inspect deeply, resolve consequential questions, keep the plan in Notes, and cannot edit, run shell commands, commit, or delegate.
            </p>
          </div>
          <button type="button" class="rounded-lg px-2.5 py-1.5 text-xs text-[var(--color-text-muted)] transition-colors hover:bg-[var(--color-surface-3)] hover:text-[var(--color-text-primary)]" disabled={planTransitioning} onclick={() => onPlanAction?.('exit')}>Exit plan mode</button>
        </div>
        {#if planReady}
          <div class="mt-3 flex flex-wrap gap-2 border-t border-cyan-400/15 pt-3">
            <button type="button" class="flex items-center gap-1.5 rounded-lg bg-cyan-300 px-3 py-2 text-xs font-semibold text-slate-950 transition-opacity hover:opacity-90 disabled:opacity-50" disabled={planTransitioning || isRunning} onclick={() => onPlanAction?.('implement')}><Play size={13} /> Approve & implement</button>
            <button type="button" class="rounded-lg border border-cyan-400/25 px-3 py-2 text-xs font-medium text-cyan-100 transition-colors hover:bg-cyan-400/10 disabled:opacity-50" disabled={planTransitioning || isRunning} onclick={() => onPlanAction?.('clear-implement')}><RotateCcw size={13} class="mr-1 inline" /> Clear context & implement</button>
            <button type="button" class="rounded-lg border border-cyan-400/25 px-3 py-2 text-xs font-medium text-cyan-100 transition-colors hover:bg-cyan-400/10 disabled:opacity-50" disabled={planTransitioning || isRunning} onclick={() => onPlanAction?.('clear-goal')}><Target size={13} class="mr-1 inline" /> Clear context & create goal</button>
          </div>
        {:else}
          <p class="mt-2 text-[11px] text-[var(--color-text-muted)]">Handoff actions unlock only after Kory resolves material questions and completes the plan, risks, acceptance criteria, and verification strategy.</p>
        {/if}
      </section>
    {/if}
    <!-- Controls row: Model picker + Reasoning toggle -->
    <div class="mb-3 flex flex-wrap items-center gap-3">
      <!-- Model selector -->
      <div class="relative model-picker">
        <button
          type="button"
          class="flex items-center gap-2 px-3.5 h-10 rounded-xl text-sm font-medium transition-all hover:brightness-110 active:scale-[0.98]"
          style="background: var(--color-surface-3); color: {selectedModel ? 'var(--color-text-primary)' : 'var(--color-text-muted)'}; border: 1px solid var(--color-border);"
          onclick={() => {
            showModelPicker = !showModelPicker;
            if (showModelPicker) modelSearchQuery = '';
          }}
        >
          {#if selectedModel}
            <ProviderIcon provider={currentProvider} size={16} class="shrink-0" />
          {/if}
          <span>{selectedModelLabel}</span>
          <ChevronDown size={14} class="text-text-muted" />
        </button>

        {#if showModelPicker}
          <div
            class="absolute bottom-full left-0 mb-2 w-80 overflow-hidden rounded-xl border shadow-2xl z-50"
            style="background: var(--color-surface-2); border-color: var(--color-border);"
          >
            <div class="relative border-b p-2.5" style="border-color: var(--color-border);">
              <Search class="pointer-events-none absolute left-5 top-1/2 -translate-y-1/2" size={15} style="color: var(--color-text-muted);" />
              <input
                type="search"
                bind:value={modelSearchQuery}
                aria-label="Search quick models"
                placeholder="Search models…"
                class="w-full rounded-lg border bg-[var(--color-surface-1)] py-2 pr-3 text-sm text-[var(--color-text-primary)] outline-none placeholder:text-[var(--color-text-muted)] focus:border-[var(--color-accent)]"
                style="border-color: var(--color-border); padding-left: 2.25rem;"
              />
            </div>
            <div class="max-h-60 overflow-y-auto">
            {#if availableModels.length === 0}
              <div class="px-4 py-4 text-xs leading-relaxed" style="color: var(--color-text-muted);">
                <div class="font-semibold mb-1" style="color: var(--color-text-secondary);">No provider connected</div>
                <div class="mb-3">Open Settings → Providers and connect one to choose a model.</div>
                {#if onOpenSettings}
                  <button
                    type="button"
                    class="text-[var(--color-accent)] hover:underline"
                    onclick={() => { showModelPicker = false; onOpenSettings(); }}
                  >
                    Open Settings →
                  </button>
                {/if}
              </div>
            {:else if filteredQuickModels.length === 0}
              <div class="px-4 py-5 text-center text-xs" style="color: var(--color-text-muted);">No models match “{modelSearchQuery}”.</div>
            {:else}
              {#each filteredQuickModels as model (model.value)}
                <button
                  type="button"
                  class="w-full text-left px-4 py-3 text-sm transition-colors hover:bg-[var(--color-surface-3)] flex items-center gap-2 {selectedModel === model.value ? 'text-[var(--color-accent)]' : ''}"
                  style="color: {selectedModel === model.value ? 'var(--color-accent)' : 'var(--color-text-secondary)'};"
                  onclick={() => selectModel(model.value)}
                >
                  <ProviderIcon provider={model.provider} size={16} class="shrink-0" />
                  <span class="flex-1 min-w-0 truncate">{model.label}</span>
                </button>
              {/each}
            {/if}
            </div>
          </div>
        {/if}
      </div>

      <!-- Reasoning toggle - shows/hides based on provider+model -->
      {#if reasoningSupported && reasoningConfig}
        <div class="relative reasoning-picker">
          <button
            type="button"
            class="flex items-center gap-2 px-3.5 h-10 rounded-xl text-sm font-medium transition-all hover:brightness-110 active:scale-[0.98]"
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
                {`${modelDisplayName} · ${reasoningLabel(reasoningLevel)}`}
              </div>
              <div class="py-1">
                {#each reasoningConfig.options as opt (opt.value)}
                  <button
                    type="button"
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

      <button
        type="button"
        class="flex h-10 items-center gap-2 rounded-xl border px-3.5 text-sm font-medium transition-all hover:brightness-110 active:scale-[0.98] {interactionMode === 'plan' ? 'border-cyan-400/40 bg-cyan-400/10 text-cyan-200' : 'border-[var(--color-border)] bg-[var(--color-surface-3)] text-[var(--color-text-primary)]'}"
        aria-pressed={interactionMode === 'plan'}
        title={interactionMode === 'plan' ? 'Plan mode is active for this chat' : 'Enter thorough Plan mode for this chat'}
        onclick={() => onInteractionModeChange?.(interactionMode === 'plan' ? 'act' : 'plan')}
      >
        <ClipboardList size={17} />
        <span>{interactionMode === 'plan' ? 'Planning' : 'Plan'}</span>
      </button>

      <div class="relative permission-picker">
        <button
          type="button"
          class="flex items-center gap-2 px-3.5 h-10 rounded-xl text-sm font-medium transition-all hover:brightness-110 active:scale-[0.98]"
          style="background: var(--color-surface-3); color: var(--color-text-primary); border: 1px solid var(--color-border);"
          onclick={() => (showPermissionMenu = !showPermissionMenu)}
          title={`Permissions: ${permissionModeMeta.label}`}
          aria-haspopup="menu"
          aria-expanded={showPermissionMenu}
        >
          <permissionModeMeta.icon size={17} class={permissionModeMeta.tone} />
          <span>{permissionModeMeta.label}</span>
          <ChevronDown size={14} class="text-text-muted" />
        </button>

        {#if showPermissionMenu}
          <div
            class="absolute bottom-full left-0 mb-2 w-80 rounded-xl border shadow-2xl z-50 overflow-hidden backdrop-blur-md"
            style="background: var(--color-surface-2-alpha, rgba(30, 30, 35, 0.9)); border-color: var(--color-border);"
            role="menu"
            aria-label="Permission mode"
          >
            <div class="flex items-center justify-between gap-3 px-4 py-3" style="border-bottom: 1px solid var(--color-border); background: rgba(255,255,255,0.03);">
              <span class="text-xs font-bold uppercase tracking-widest opacity-70" style="color: var(--color-text-muted);">Permissions</span>
              <button
                type="button"
                class="flex items-center gap-1 rounded-md px-1.5 py-1 text-[11px] transition-colors hover:bg-[var(--color-surface-3)]"
                style="color: var(--color-text-secondary);"
                onclick={() => { showPermissionMenu = false; onOpenSettings?.('agent', 'permissions'); }}
                title="Open custom permission rules"
              ><Settings size={13} /> Settings</button>
            </div>
            <div class="py-1">
              {#each PERMISSION_OPTIONS as option (option.value)}
                {@const active = permissionMode === option.value}
                <button
                  type="button"
                  role="menuitemradio"
                  aria-checked={active}
                  class="w-full flex items-start gap-3 px-4 py-2.5 text-left transition-all hover:bg-[var(--color-surface-3)]"
                  onclick={() => selectPermissionMode(option.value)}
                >
                  <option.icon size={16} class="mt-0.5 shrink-0 {option.tone}" />
                  <span class="min-w-0 flex-1">
                    <span class="block text-sm font-semibold" style="color: {active ? 'var(--color-accent)' : 'var(--color-text-primary)'};">{option.label}</span>
                    <span class="block text-[11px] leading-relaxed" style="color: var(--color-text-muted);">{option.description}</span>
                  </span>
                  {#if active}<Check size={14} class="mt-1 shrink-0" style="color: var(--color-accent);" />{/if}
                </button>
              {/each}
            </div>
          </div>
        {/if}
      </div>
    </div>

    <!-- Input area -->
    <div class="flex flex-col gap-3 xl:flex-row xl:items-start">
      <div class="min-w-0 flex-1">
        {#if pickerOpen}
          <div class="mb-3 overflow-hidden rounded-xl border" style="background: var(--color-surface-2); border-color: var(--color-border);">
            <div class="px-3 py-2 text-[11px] font-semibold uppercase tracking-[0.14em]" style="color: var(--color-text-muted); border-bottom: 1px solid var(--color-border);">
              {triggerContext?.trigger === '/' ? 'Commands' : 'Files'}
            </div>
            <div class="py-1 max-h-56 overflow-y-auto">
              {#if pickerItems.length === 0}
                <div class="px-3 py-2 text-xs" style="color: var(--color-text-muted);">
                  {triggerContext?.trigger === '@' ? 'Loading project files…' : 'No matches'}
                </div>
              {:else}
                {#each pickerItems as item, index (item.key)}
                  <button
                    type="button"
                    class="flex w-full items-start justify-between gap-3 px-3 py-2 text-left transition-colors {index === selectedPickerIndex ? 'bg-[var(--color-surface-3)]' : 'hover:bg-[var(--color-surface-3)]'}"
                    onclick={() => void applyPickerItem(item)}
                  >
                    <div class="min-w-0">
                      <div class="text-sm font-medium" style="color: var(--color-text-primary);">
                        {item.type === 'command' ? `/${item.value}` : `@${item.label}`}
                      </div>
                      <div class="truncate text-xs" style="color: var(--color-text-muted);">
                        {item.description}
                      </div>
                    </div>
                    <div class="shrink-0 text-[10px] uppercase tracking-[0.12em]" style="color: var(--color-text-muted);">
                      {item.type}
                    </div>
                  </button>
                {/each}
              {/if}
            </div>
          </div>
        {/if}

        <!-- Attachments Preview -->
        {#if attachments.length > 0}
          <div class="mb-3 flex flex-wrap gap-2">
            {#each attachments as attachment, i (i)}
              <div class="relative group rounded-lg overflow-hidden border" style="border-color: var(--color-border); width: 64px; height: 64px;">
                {#if attachment.type === 'image'}
                  <button
                    type="button"
                    class="block h-full w-full cursor-zoom-in"
                    onclick={() => openAttachmentPreview(attachment)}
                    aria-label={`Preview ${attachment.name}`}
                  >
                    <img src={`data:${attachment.mimeType ?? 'image/png'};base64,${attachment.data}`} alt={attachment.name} class="w-full h-full object-cover" />
                  </button>
                {/if}
                <button
                  type="button"
                  class="absolute top-1 right-1 p-0.5 rounded-full bg-black/60 text-white opacity-0 group-hover:opacity-100 transition-opacity hover:bg-black/80"
                  onclick={() => removeAttachment(i)}
                >
                  <X size={12} />
                </button>
              </div>
            {/each}
          </div>
        {/if}

        <div class="relative">
          <textarea
            bind:this={inputRef}
            bind:value={value}
            oninput={autoResize}
            onkeydown={handleKeydown}
            onpaste={handlePaste}
            placeholder={disabled ? disabledMessage : placeholder}
            rows="1"
            class="input w-full"
            disabled={disabled || !!configurationWarning}
            style="resize: none; min-height: {minHeightPx}px; max-height: 280px; font-size: 15px; line-height: 1.6; box-sizing: border-box; padding: 10px 88px 10px 12px; background: transparent; border: none; box-shadow: none; {disabled || configurationWarning ? 'opacity: 0.6; cursor: not-allowed;' : ''}"
          ></textarea>
          <div class="absolute bottom-2 right-1 flex items-center gap-0.5 reference-picker">
            <input
              type="file"
              multiple
              class="hidden"
              bind:this={referenceFileInputRef}
              onchange={handleReferenceFileInput}
            />
            <input
              type="file"
              multiple
              class="hidden"
              bind:this={referenceFolderInputRef}
              onchange={handleReferenceFolderInput}
              webkitdirectory
            />
            <div class="relative">
              <button
                type="button"
                class="flex items-center justify-center w-8 h-8 rounded-lg transition-colors hover:bg-[var(--color-surface-3)] disabled:opacity-40 disabled:cursor-not-allowed"
                style="color: var(--color-text-muted);"
                onclick={() => showGoalActions = !showGoalActions}
                disabled={disabled || !!configurationWarning}
                aria-label="More composer actions"
                title="More actions"
              ><Plus size={16} /></button>
              {#if showGoalActions}
                <div class="absolute bottom-full right-0 mb-1 w-48 rounded-lg border shadow-xl z-50 overflow-hidden" style="background: var(--color-surface-2); border-color: var(--color-border);">
                  <button type="button" class="flex w-full items-center gap-2 px-3 py-2 text-left text-xs hover:bg-[var(--color-surface-3)]" style="color: var(--color-text-primary);" onclick={() => { showGoalActions = false; goalDisplayStore.update({ sidebar: true }); queueMicrotask(() => window.dispatchEvent(new CustomEvent('kory:goal-action', { detail: 'goal_create' }))); }}><Target size={14} /> Create verified goal</button>
                  <button type="button" class="flex w-full items-center gap-2 px-3 py-2 text-left text-xs hover:bg-[var(--color-surface-3)]" style="color: var(--color-text-primary);" onclick={() => { showGoalActions = false; onOpenSettings?.('experimental'); }}><Settings size={14} /> Goal settings</button>
                </div>
              {/if}
            </div>
            <div class="relative">
              <button
                type="button"
                class="flex items-center justify-center w-8 h-8 rounded-lg transition-colors hover:bg-[var(--color-surface-3)] disabled:opacity-40 disabled:cursor-not-allowed"
                style="color: var(--color-text-muted);"
                onclick={() => (showReferenceMenu = !showReferenceMenu)}
                disabled={disabled || !!configurationWarning}
                title="Reference a file or folder"
              >
                <Paperclip size={16} />
              </button>
              {#if showReferenceMenu}
                <div
                  class="absolute bottom-full right-0 mb-1 w-40 rounded-lg border shadow-xl z-50 overflow-hidden"
                  style="background: var(--color-surface-2); border-color: var(--color-border);"
                >
                  <button
                    type="button"
                    class="w-full text-left px-3 py-2 text-xs hover:bg-[var(--color-surface-3)]"
                    style="color: var(--color-text-primary);"
                    onclick={() => void pickReferenceFiles()}
                  >
                    Pick file…
                  </button>
                  <button
                    type="button"
                    class="w-full text-left px-3 py-2 text-xs hover:bg-[var(--color-surface-3)]"
                    style="color: var(--color-text-primary);"
                    onclick={() => void pickReferenceFolder()}
                  >
                    Pick folder…
                  </button>
                </div>
              {/if}
            </div>
            <button
              type="button"
              class="flex items-center justify-center w-8 h-8 rounded-lg transition-colors hover:bg-[var(--color-surface-3)] disabled:opacity-40 disabled:cursor-not-allowed"
              style="color: var(--color-text-muted);"
              onclick={() => pasteImageFromClipboard()}
              disabled={disabled || !!configurationWarning}
              title="Paste image from clipboard (Ctrl+Shift+V)"
            >
              <Clipboard size={16} />
            </button>
          </div>
        </div>
      </div>
      <div class="w-full xl:w-auto xl:self-start">
        <div
          bind:this={actionPanelRef}
          class="flex flex-col gap-3 rounded-2xl border px-3 py-3 xl:min-w-[188px]"
          style="background: rgba(12, 10, 9, 0.34); border-color: var(--color-border);"
        >
          <div class="flex flex-wrap items-center gap-2 xl:justify-end">
            <div class="agent-mode-picker relative">
              <button
                type="button"
                class="flex items-center gap-1.5 text-[11px] font-medium px-2.5 py-1.5 rounded-md transition-colors {agentExecutionModeMeta.className}"
                onclick={() => (showAgentModeMenu = !showAgentModeMenu)}
                title={agentExecutionModeMeta.title}
                aria-haspopup="menu"
                aria-expanded={showAgentModeMenu}
              >
                <agentExecutionModeMeta.icon size={12} />
                <span>{agentExecutionModeMeta.label}</span>
                <ChevronDown size={10} class="opacity-60" />
              </button>
              {#if showAgentModeMenu}
                <div
                  class="absolute bottom-full right-0 mb-1.5 w-56 rounded-xl border shadow-xl z-30 overflow-hidden"
                  style="background: var(--color-surface-2); border-color: var(--color-border);"
                  role="menu"
                >
                  {#each AGENT_MODE_OPTIONS as option (option.value)}
                    {@const active = (agentSettingsStore.settings.agentExecutionMode ?? 'auto') === option.value}
                    <button
                      type="button"
                      role="menuitemradio"
                      aria-checked={active}
                      class="w-full flex items-start gap-2.5 px-3 py-2 text-left transition-colors hover:bg-[var(--color-surface-3)]"
                      onclick={() => setAgentExecutionMode(option.value)}
                    >
                      <option.icon size={13} class="mt-0.5 shrink-0" style="color: {active ? 'var(--color-accent)' : 'var(--color-text-muted)'};" />
                      <span class="min-w-0 flex-1">
                        <span class="block text-[11px] font-medium" style="color: {active ? 'var(--color-accent)' : 'var(--color-text-primary)'};">{option.label}</span>
                        <span class="block text-[10px]" style="color: var(--color-text-muted);">{option.description}</span>
                      </span>
                      {#if active}
                        <Check size={12} class="mt-0.5 shrink-0" style="color: var(--color-accent);" />
                      {/if}
                    </button>
                  {/each}
                </div>
              {/if}
            </div>

            <button
              type="button"
              class="flex items-center gap-1.5 text-[11px] font-medium px-2.5 py-1.5 rounded-md transition-colors {agentSettingsStore.settings.criticGateEnabled ? 'bg-amber-500/20 text-amber-400 border border-amber-500/30' : 'bg-[var(--color-surface-3)] text-[var(--color-text-muted)] border border-[var(--color-border)] hover:brightness-110'}"
              onclick={() => agentSettingsStore.saveSettings(
                { ...agentSettingsStore.settings, criticGateEnabled: !agentSettingsStore.settings.criticGateEnabled },
                { quietSuccess: true },
              )}
              title="Toggle Critic Agent"
            >
              {#if agentSettingsStore.settings.criticGateEnabled}
                <ShieldCheck size={12} />
                <span>Critic: On</span>
              {:else}
                <ShieldAlert size={12} />
                <span>Critic: Off</span>
              {/if}
            </button>
          </div>

          <button
            type="button"
            onclick={isRunning ? stop : isWaiting && !canSend ? stop : send}
            disabled={disabled || (!isRunning && !isWaiting && !canSend)}
            class="btn flex w-full items-center justify-center gap-2 {isRunning ? 'stop-btn' : isWaiting && !canSend ? 'waiting-btn' : 'btn-primary'}"
            style="height: 52px; padding: 0 20px; font-size: 14px; {disabled || configurationWarning || (!isRunning && !isWaiting && !canSend) ? 'opacity: 0.5; cursor: not-allowed;' : ''}"
            aria-label={isRunning ? 'Stop the running model' : isWaiting && !canSend ? 'Kory is waiting — click to cancel' : 'Send message'}
            title={isRunning ? 'Stop (Esc)' : isWaiting && !canSend ? (waitingReason ? `Waiting on ${waitingReason} — click to cancel` : 'Kory is waiting — click to cancel') : !canSend ? 'Type a message to send' : 'Send (Enter)'}
          >
            {#if isRunning}
              <span class="stop-pulse" aria-hidden="true">
                <Square size={10} fill="currentColor" strokeWidth={0} />
              </span>
              <span>Stop</span>
            {:else if isWaiting && !canSend}
              <span class="waiting-dots" aria-hidden="true"><span></span><span></span><span></span></span>
              <span>Waiting{waitingReason ? ` — ${waitingReason}` : '…'}</span>
            {:else}
              <!-- Empty composer is a plain disabled Send. "Waiting" is reserved
                   for Kory genuinely parked on something external, so an idle
                   app never reads as a busy app. -->
              <Send size={18} />
              Send
            {/if}
          </button>
        </div>
      </div>
    </div>
  </div>

  <div class="flex items-center justify-between mt-[var(--space-sm)]">
    <span class="text-xs" style="color: var(--color-text-muted);">
      {#if configurationWarning}
        Configure a provider to enable sending.
      {:else}
        Enter to send · Shift+Enter for new line · Shift+Tab cycle permissions · Ctrl+V paste text or image · Ctrl+Shift+V paste image
      {/if}
    </span>
    {#if value.length > 0}
      <span class="text-xs" style="color: var(--color-text-muted);">{value.length} chars</span>
    {/if}
  </div>
</div>

{#if previewAttachment}
  <div
    class="fixed inset-0 z-[110] flex flex-col bg-black/85 backdrop-blur-sm"
    role="dialog"
    aria-modal="true"
    aria-label={`Preview ${previewAttachment.name}`}
  >
    <div
      class="relative z-10 flex items-center justify-between gap-3 border-b px-4 py-3"
      style="background: var(--color-surface-1); border-color: var(--color-border);"
    >
      <div class="min-w-0">
        <div class="truncate text-sm font-medium" style="color: var(--color-text-primary);">{previewAttachment.name}</div>
        <div class="text-xs" style="color: var(--color-text-muted);">Scroll to zoom · drag to inspect an area · double-click to reset</div>
      </div>
      <div class="flex shrink-0 items-center gap-1">
        <button type="button" class="rounded-lg p-2 hover:bg-[var(--color-surface-3)]" style="color: var(--color-text-secondary);" onclick={() => zoomAttachmentPreview(-0.25)} aria-label="Zoom out"><ZoomOut size={17} /></button>
        <span class="w-12 text-center text-xs tabular-nums" style="color: var(--color-text-secondary);">{Math.round(previewZoom * 100)}%</span>
        <button type="button" class="rounded-lg p-2 hover:bg-[var(--color-surface-3)]" style="color: var(--color-text-secondary);" onclick={() => zoomAttachmentPreview(0.25)} aria-label="Zoom in"><ZoomIn size={17} /></button>
        <button type="button" class="rounded-lg p-2 hover:bg-[var(--color-surface-3)]" style="color: var(--color-text-secondary);" onclick={resetAttachmentPreview} aria-label="Reset preview"><RotateCcw size={17} /></button>
        <button type="button" class="ml-2 rounded-lg p-2 hover:bg-[var(--color-surface-3)]" style="color: var(--color-text-secondary);" onclick={closeAttachmentPreview} aria-label="Close preview"><X size={18} /></button>
      </div>
    </div>
    <div
      class="relative flex min-h-0 flex-1 touch-none select-none items-center justify-center overflow-hidden {previewDragging ? 'cursor-grabbing' : 'cursor-grab'}"
      role="group"
      aria-label="Zoomable image preview"
      onwheel={handlePreviewWheel}
      onpointerdown={startPreviewDrag}
      onpointermove={movePreviewDrag}
      onpointerup={() => (previewDragging = false)}
      onpointercancel={() => (previewDragging = false)}
      ondblclick={resetAttachmentPreview}
    >
      <img
        src={`data:${previewAttachment.mimeType ?? 'image/png'};base64,${previewAttachment.data}`}
        alt={previewAttachment.name}
        draggable="false"
        class="max-h-[82vh] max-w-[92vw] rounded-lg object-contain shadow-2xl will-change-transform"
        style={`transform: translate(${previewOffsetX}px, ${previewOffsetY}px) scale(${previewZoom});`}
      />
    </div>
  </div>
{/if}



{#if overflowWarning}
  <div class="fixed inset-0 z-[95] flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm">
    <div
      class="w-full max-w-md rounded-2xl border p-6 shadow-2xl"
      style="background: var(--color-surface-2); border-color: var(--color-border);"
      role="alertdialog"
      aria-label="Context too large for model"
    >
      <h3 class="text-base font-semibold mb-2" style="color: var(--color-text-primary);">Context won't fit</h3>
      <p class="text-sm mb-5 leading-relaxed" style="color: var(--color-text-secondary);">
        This session uses ~{formatContextSize(overflowWarning.used)} tokens, but
        <span class="font-medium" style="color: var(--color-text-primary);">{overflowWarning.label}</span>
        has a ~{formatContextSize(overflowWarning.window)} window. Shrink the context first:
      </p>
      <div class="flex flex-col gap-2">
        <button
          type="button"
          class="w-full rounded-xl border px-4 py-2.5 text-sm font-medium text-left transition-colors hover:bg-[var(--color-surface-3)]"
          style="border-color: var(--color-border); color: var(--color-text-primary);"
          onclick={() => { overflowWarning = null; toastStore.info('Hover tool outputs in the feed and use the agent-hide button to prune them.'); }}
        >
          Prune manually
          <span class="block text-xs mt-0.5" style="color: var(--color-text-muted);">Hide bulky tool outputs from the agent yourself, then switch.</span>
        </button>
        <button
          type="button"
          class="w-full rounded-xl border px-4 py-2.5 text-sm font-medium text-left transition-colors hover:bg-[var(--color-surface-3)]"
          style="border-color: var(--color-border); color: var(--color-text-primary);"
          onclick={overflowAskAgentPrune}
        >
          Ask the agent to prune
          <span class="block text-xs mt-0.5" style="color: var(--color-text-muted);">The current agent trims its own context below the new limit.</span>
        </button>
        <button
          type="button"
          class="w-full rounded-xl border px-4 py-2.5 text-sm font-medium text-left transition-colors hover:bg-[var(--color-surface-3)]"
          style="border-color: var(--color-border); color: var(--color-text-primary);"
          onclick={overflowCompact}
        >
          Compact the conversation
          <span class="block text-xs mt-0.5" style="color: var(--color-text-muted);">The current large-window agent summarizes the session first.</span>
        </button>
        <button
          type="button"
          class="w-full rounded-xl border px-4 py-2.5 text-sm font-medium text-left transition-colors hover:bg-[var(--color-surface-3)]"
          style="border-color: var(--color-border); color: var(--color-text-primary);"
          onclick={overflowNewChat}
        >
          Start a new chat
          <span class="block text-xs mt-0.5" style="color: var(--color-text-muted);">Fresh session on the new model.</span>
        </button>
        <button
          type="button"
          class="w-full rounded-xl px-4 py-2 text-xs font-medium transition-colors hover:bg-[var(--color-surface-3)]"
          style="color: var(--color-text-muted);"
          onclick={() => (overflowWarning = null)}
        >
          Cancel
        </button>
      </div>
    </div>
  </div>
{/if}

<style>
  /* Waiting button — Kory is parked on something external (background
     terminal, user input). Amber, calm slow pulse: alive but not burning. */
  :global(.waiting-btn) {
    background: color-mix(in srgb, #d5b261 14%, transparent);
    color: #d5b261;
    border: 1px solid color-mix(in srgb, #d5b261 45%, transparent);
    animation: waiting-breathe 2.4s ease-in-out infinite;
  }
  @keyframes waiting-breathe {
    0%, 100% { box-shadow: 0 0 0 0 rgba(var(--color-accent-rgb), 0); }
    50% { box-shadow: 0 0 14px 0 rgba(var(--color-accent-rgb), 0.35); }
  }
  .waiting-dots { display: inline-flex; gap: 3px; }
  .waiting-dots span {
    width: 5px; height: 5px; border-radius: 9999px; background: currentColor;
    animation: waiting-dot 1.2s ease-in-out infinite;
  }
  .waiting-dots span:nth-child(2) { animation-delay: 0.2s; }
  .waiting-dots span:nth-child(3) { animation-delay: 0.4s; }
  @keyframes waiting-dot {
    0%, 60%, 100% { opacity: 0.35; transform: translateY(0); }
    30% { opacity: 1; transform: translateY(-2px); }
  }

  /* Stop button — unmistakably "live, click to stop" with a pulsing ring. */
  :global(.stop-btn) {
    background: rgb(239 68 68 / 0.12);
    border: 1px solid rgb(239 68 68 / 0.45);
    color: #fca5a5;
    font-weight: 600;
    transition:
      background 0.15s ease,
      border-color 0.15s ease,
      color 0.15s ease;
  }
  :global(.stop-btn:hover) {
    background: rgb(239 68 68 / 0.2);
    border-color: rgb(239 68 68 / 0.85);
    color: #fecaca;
  }
  :global(.stop-pulse) {
    position: relative;
    display: flex;
    align-items: center;
    justify-content: center;
    width: 22px;
    height: 22px;
    border-radius: 50%;
    background: #ef4444;
    color: #fff;
    flex-shrink: 0;
  }
  :global(.stop-pulse::after) {
    content: '';
    position: absolute;
    inset: 0;
    border-radius: 50%;
    border: 2px solid rgb(239 68 68 / 0.7);
    animation: stop-ping 1.4s cubic-bezier(0, 0, 0.2, 1) infinite;
  }
  @keyframes stop-ping {
    0% {
      transform: scale(1);
      opacity: 0.7;
    }
    75%,
    100% {
      transform: scale(2);
      opacity: 0;
    }
  }
  @media (prefers-reduced-motion: reduce) {
    :global(.stop-pulse::after) {
      animation: none;
    }
  }
</style>
