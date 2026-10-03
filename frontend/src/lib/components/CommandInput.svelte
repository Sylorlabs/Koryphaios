<script lang="ts">
  import { onDestroy, onMount, tick, untrack } from 'svelte';
  import { clipboardMarkdown } from '$lib/utils/rich-paste';
  import Send from 'lucide-svelte/icons/send';
  import ChevronDown from 'lucide-svelte/icons/chevron-down';
  import ChevronRight from 'lucide-svelte/icons/chevron-right';
  import Sparkles from 'lucide-svelte/icons/sparkles';
  import Square from 'lucide-svelte/icons/square';
  import Users from 'lucide-svelte/icons/users';
  import User from 'lucide-svelte/icons/user';
  import ShieldCheck from 'lucide-svelte/icons/shield-check';
  import ShieldAlert from 'lucide-svelte/icons/shield-alert';
  import Circle from 'lucide-svelte/icons/circle';
  import Paperclip from 'lucide-svelte/icons/paperclip';
  import Clipboard from 'lucide-svelte/icons/clipboard';
  import ClipboardList from 'lucide-svelte/icons/clipboard-list';
  import Mic from 'lucide-svelte/icons/mic';
  import X from 'lucide-svelte/icons/x';
  import Check from 'lucide-svelte/icons/check';
  import Search from 'lucide-svelte/icons/search';
  import Plus from 'lucide-svelte/icons/plus';
  import Target from 'lucide-svelte/icons/target';
  import Settings from 'lucide-svelte/icons/settings';
  import Workflow from 'lucide-svelte/icons/workflow';
  import Zap from 'lucide-svelte/icons/zap';
  import Pencil from 'lucide-svelte/icons/pencil';
  import MessageCircleQuestion from 'lucide-svelte/icons/message-circle-question';
  import SlidersHorizontal from 'lucide-svelte/icons/sliders-horizontal';
  import { wsStore } from '$lib/stores/websocket.svelte';
  import { shortcutStore } from '$lib/stores/shortcuts.svelte';
  import { formatKey } from '$lib/utils/platform';
  import { agentSettingsStore } from '$lib/stores/agent-settings.svelte';
  import {
    buildReasoningConfigFromLevels,
    resolveReasoningLevel,
    type VoiceSettings,
    type GoalScope,
    type ContextBreakdown,
  } from '@koryphaios/shared';
  import BrainIcon from '$lib/components/icons/BrainIcon.svelte';
  import ProviderIcon from '$lib/components/icons/ProviderIcon.svelte';
  import ImageInputFallbackDialog from './ImageInputFallbackDialog.svelte';
  import {
    modelHasVerifiedImageInput,
    needsImageInputChoice,
    readRememberedImageInputMode,
    rememberImageInputMode,
    type ImageInputMode,
  } from '$lib/utils/image-input-fallback';
  import {
    getModelConfigurationWarning,
    isEnabledModelSelection,
    parseProviderModelSelection,
  } from '$lib/utils/model-config';
  import { invoke } from '@tauri-apps/api/core';
  import { toastStore } from '$lib/stores/toast.svelte';
  import { isGuidedDemo } from '$lib/demo-flags';
  import { sessionStore } from '$lib/stores/sessions.svelte';
  import { projectStore } from '$lib/stores/project.svelte';
  import { apiFetch } from '$lib/api.svelte';
  import { apiUrl } from '$lib/utils/api-url';
  import { goalStore } from '$lib/stores/goals.svelte';
  import { goalDisplayStore } from '$lib/stores/goal-display.svelte';
  import type { GoalActionRequest } from '$lib/utils/goal-actions';
  import GoalMode from './GoalMode.svelte';
  import ChecklistPanel from './ChecklistPanel.svelte';
  import {
    clearComposerDraft,
    loadComposerDraft,
    loadComposerDraftAttachments,
    saveComposerDraft,
    type ComposerDraftAttachment,
  } from '$lib/stores/composer-drafts';
  import { loadComposerPreference, saveComposerPreference } from '$lib/stores/composer-preferences';
  import type { SessionAgentOverrides } from '@koryphaios/shared';
  import {
    loadComposerSessionState,
    saveComposerSessionState,
  } from '$lib/stores/composer-session-state';
  import KorySelect from './KorySelect.svelte';
  import { loadLocalFormDraft, saveLocalFormDraft } from '$lib/utils/local-form-drafts';
  import { estimateCacheBreakImpact, formatCompactTokens } from '$lib/utils/cache-break-impact';

  export type Attachment = {
    type: 'image' | 'file';
    data: string;
    name: string;
    mimeType?: string;
  };

  interface Props {
    onSend: (
      message: string,
      model?: string,
      reasoningLevel?: string,
      attachments?: Attachment[],
      fastMode?: boolean,
      imageInputMode?: ImageInputMode,
    ) => Promise<boolean> | boolean;
    onExecuteCommand?: (command: string) => Promise<boolean> | boolean;
    /** When true, show Stop instead of Send; clicking stops manager and workers for the session. */
    isRunning?: boolean;
    /** Kory is parked — waiting on a background terminal or your answer. The
     *  owned wait must be answered or cancelled before another turn starts. */
    isWaiting?: boolean;
    /** What Kory is waiting on, e.g. "background terminal: dev-server". */
    waitingReason?: string;
    onStop?: () => void;
    onOpenSettings?: (
      section?: 'advanced' | 'agent' | 'voice',
      agentSection?: 'permissions',
    ) => void;
    onOpenWorkflows?: () => void;
    workflowStatus?: { name: string; stage: string; status: string; task: string };
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
    /** Bindable mirror of the composer's selected model (e.g. "claude:sonnet")
     *  so the parent can react to provider changes (e.g. to surface that CLI
     *  provider's native /commands in the slash picker). */
    selectedModel?: string;
    /** Bindable mirror of the current reasoning selection for cache prewarm routing. */
    selectedReasoningLevel?: string;
    interactionMode?: 'act' | 'plan';
    onInteractionModeChange?: (mode: 'act' | 'plan') => void;
    planReady?: boolean;
    onApprovePlan?: () => void;
    /** Opaque session id used only to scope local unsent-draft recovery. */
    draftKey?: string;
    /** Parent-side deferred send succeeded; clear the retained composer draft. */
    clearDraftRequest?: number;
    /** When non-empty (worker tab), the composer is pinned to that worker's
     *  own model instead of the active chat's selection ("provider:model"). */
    forcedModel?: string;
  }

  let {
    onSend,
    onExecuteCommand,
    isRunning = false,
    isWaiting = false,
    waitingReason = '',
    onStop,
    onOpenSettings,
    onOpenWorkflows,
    workflowStatus,
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
    selectedModel = $bindable(''),
    selectedReasoningLevel = $bindable(''),
    interactionMode = 'act',
    onInteractionModeChange,
    planReady = false,
    onApprovePlan,
    draftKey = 'welcome',
    clearDraftRequest = 0,
    forcedModel = '',
  }: Props = $props();
  let actionPanelRef = $state<HTMLDivElement>();
  let showModelPicker = $state(false);
  let modelSearchQuery = $state('');
  let expandedProviders = $state<Set<string>>(new Set());
  const MODEL_STORAGE_KEY = 'koryphaios-selected-model';
  let _storedModel =
    typeof localStorage !== 'undefined' ? localStorage.getItem(MODEL_STORAGE_KEY) : null;
  if (_storedModel === 'auto') {
    localStorage.removeItem(MODEL_STORAGE_KEY);
    _storedModel = null;
  }
  // Bindable selectedModel: seeded from localStorage once, then kept in sync
  // with the parent so the composer's slash picker can surface the active CLI
  // provider's native /commands.
  // The seed intentionally reads only the *initial* prop values; demo surfaces
  // seed from initialModel instead of the last-used global model.
  untrack(() => {
    if (!selectedModel && !initialModel && _storedModel) selectedModel = _storedModel;
  });
  let lastContextPreviewKey = $state('');
  let selectedPickerIndex = $state(0);
  let modelSelectionGeneration = 0;
  let imageAdmissionPending = $state(false);
  let attachments = $state<Attachment[]>([]);
  let hydratedDraftKey = $state<string | null>(null);
  let lastClearDraftRequest = $state<number | undefined>(undefined);
  // False while a restored draft's attachment payloads are still being read.
  let draftPayloadsReady = $state(true);
  let composerUnmounted = false;
  onDestroy(() => {
    composerUnmounted = true;
  });

  function currentDraftKey(): string {
    return draftKey.trim() || 'welcome';
  }

  function clearCurrentDraft() {
    value = '';
    attachments = [];
    void clearComposerDraft(currentDraftKey());
    resizeToMin();
  }

  // One composer instance survives chat switching. Persist the outgoing draft
  // before loading the next *session-scoped* draft so work cannot bleed from
  // one chat into another or disappear during a renderer relaunch.
  $effect(() => {
    const nextKey = currentDraftKey();
    if (hydratedDraftKey === nextKey) return;
    const previousKey = hydratedDraftKey;
    hydratedDraftKey = nextKey;
    if (previousKey !== null) {
      void saveComposerDraft(previousKey, value, attachments as ComposerDraftAttachment[]);
    }
    const recovered = loadComposerDraft(nextKey);
    // Text is available immediately; attachment payloads live on disk and are
    // read back asynchronously. Saving is suspended until they land, so a save
    // triggered by this restore cannot overwrite the draft with no images.
    draftPayloadsReady = false;
    value = recovered.text;
    attachments = recovered.attachments as Attachment[];
    void loadComposerDraftAttachments(nextKey).then((stored) => {
      if (composerUnmounted || hydratedDraftKey !== nextKey) return;
      if (stored.length > 0) attachments = stored as Attachment[];
      draftPayloadsReady = true;
    });
    // Controls (model, effort, fast mode) are chat-scoped too: restore the
    // incoming chat's own saved controls instead of keeping the previous
    // chat's picker. Worker tabs pin the model and restore on unpin.
    if (!forcedModel) restoreComposerControls(nextKey);
  });

  // ─── Per-chat composer controls (model, reasoning effort, fast mode) ────────
  // A model id whose preference restore must be skipped once: chat-scoped
  // controls win over the model's global defaults right after a restore.
  let suppressPreferenceRestoreFor = $state('');
  let lastForcedModel = $state('');

  function restoreComposerControls(scope: string) {
    const saved = loadComposerSessionState(scope);
    if (saved.model) {
      suppressPreferenceRestoreFor = saved.model;
      if (saved.model !== selectedModel) selectedModel = saved.model;
    } else {
      suppressPreferenceRestoreFor = '';
      // This chat never picked a model: fall back to the last model used
      // anywhere so the picker isn't empty, matching brand-new chats.
      try {
        const lastUsed =
          typeof localStorage !== 'undefined' ? localStorage.getItem(MODEL_STORAGE_KEY) : null;
        if (lastUsed && lastUsed !== selectedModel) selectedModel = lastUsed;
      } catch {}
    }
    if (saved.reasoningLevel !== undefined) reasoningLevel = saved.reasoningLevel;
    if (typeof saved.fastMode === 'boolean') fastMode = saved.fastMode;
  }

  // A worker tab pins the composer to that worker's own model. Leaving the tab
  // hands the composer back to the chat, which restores the chat's saved
  // controls instead of keeping the worker's model.
  $effect(() => {
    const next = forcedModel;
    if (next === lastForcedModel) return;
    const wasForced = !!lastForcedModel;
    lastForcedModel = next;
    if (next) {
      if (next !== selectedModel) selectedModel = next;
    } else if (wasForced) {
      restoreComposerControls(currentDraftKey());
    }
  });

  // Persist control changes into the active chat's scope so each chat keeps
  // its own picker state across switches and reloads. Worker-tab pinning must
  // never leak the worker's model into the chat's scope.
  $effect(() => {
    const scope = currentDraftKey();
    if (hydratedDraftKey !== scope) return;
    if (forcedModel || !selectedModel) return;
    saveComposerSessionState(scope, { model: selectedModel, reasoningLevel, fastMode });
  });

  $effect(() => {
    const key = currentDraftKey();
    if (hydratedDraftKey !== key || !draftPayloadsReady) return;
    // A save in flight must not be abandoned on the next keystroke: the draft
    // is the user's work, so every autosave is allowed to land.
    void saveComposerDraft(key, value, attachments as ComposerDraftAttachment[]);
  });

  $effect(() => {
    if (lastClearDraftRequest === undefined) {
      lastClearDraftRequest = clearDraftRequest;
      return;
    }
    if (clearDraftRequest === lastClearDraftRequest) return;
    lastClearDraftRequest = clearDraftRequest;
    clearCurrentDraft();
  });
  let modelPickerVisionOnly = $state(false);
  let contextImagePreview = $state<{
    sessionId: string;
    imageCount: number;
  } | null>(null);
  // Non-persistent choices made while switching models authorize exactly the
  // next send. The separate "Don't ask again" choice is the only durable one.
  let oneShotImageOmitConsents = $state<Set<string>>(new Set());
  let imageFallbackWarning = $state<{
    mode: 'model-switch' | 'send';
    targetValue: string;
    targetLabel: string;
    imageCount: number;
    historicalImageCount?: number;
    message?: string;
  } | null>(null);
  let previewAttachment = $state<Attachment | null>(null);
  let previewDialogRef = $state<HTMLDivElement>();
  let previewTriggerRef: HTMLButtonElement | null = null;
  let isReadingClipboard = $state(false);
  type BrowserSpeechRecognition = {
    lang: string;
    continuous: boolean;
    interimResults: boolean;
    start: () => void;
    stop: () => void;
    abort: () => void;
    onresult:
      | ((event: {
          resultIndex: number;
          results: ArrayLike<{ isFinal: boolean; 0: { transcript: string } }>;
        }) => void)
      | null;
    onerror: ((event: { error: string }) => void) | null;
    onend: (() => void) | null;
  };
  type BrowserSpeechRecognitionConstructor = new () => BrowserSpeechRecognition;
  type LocalPcmRecorder = {
    stream: MediaStream;
    context: AudioContext;
    source: MediaStreamAudioSourceNode;
    processor: ScriptProcessorNode;
    sink: GainNode;
    chunks: Float32Array[];
    sampleRate: number;
    language: string;
  };
  type LocalVoiceModelStatus = {
    installed: boolean;
    modelId: string;
  };

  let isRecording = $state(false);
  let isTranscribing = $state(false);
  // True while a push-to-talk key or button is held down.
  let holdToTalkActive = $state(false);
  let activeRecorder: MediaRecorder | null = null;
  let activeLocalRecorder: LocalPcmRecorder | null = null;
  let activeSpeechRecognition: BrowserSpeechRecognition | null = null;
  let voiceSettings = $state<VoiceSettings | null>(null);
  let composerMicrophoneEnabled = $derived(voiceSettings?.voiceModeEnabled === true);
  // Every chord bound to voice mode, so the hint never advertises only the one a
  // platform might swallow.
  let voiceShortcutHint = $derived(
    shortcutStore
      .chords('voice_mode')
      .map((chord) => chord.map(formatKey).join('+'))
      .filter(Boolean)
      .join(' or '),
  );
  const pendingAttachmentReads = new Set<Promise<void>>();
  let referenceFileInputRef = $state<HTMLInputElement>();
  let referenceFolderInputRef = $state<HTMLInputElement>();
  let showReferenceMenu = $state(false);
  let showGoalActions = $state(false);

  // ─── Goal composer (lives above the chat, not in the sidebar) ───────────────
  const goalScopeOptions = [
    { value: 'workspace', label: 'Workspace', description: 'Available from every chat' },
    { value: 'project', label: 'Project', description: 'Restricted to this project' },
    { value: 'session', label: 'This chat', description: 'Restricted to the active chat' },
  ];
  const defaultGoalScope = (): GoalScope =>
    sessionStore.activeSessionId ? 'session' : projectStore.currentPath ? 'project' : 'workspace';
  let showGoalComposer = $state(false);
  let goalObjective = $state('');
  let goalScope = $state<GoalScope>(defaultGoalScope());
  let goalError = $state('');
  let goalDraftHydratedFor = $state<string | null>(null);
  let goalDraftRecovered = $state(false);
  let goalComposerInput = $state<HTMLInputElement>();
  let goalDraftScope = $derived(
    sessionStore.activeSessionId || `project:${projectStore.currentPath ?? 'workspace'}`,
  );
  $effect(() => {
    const nextScope = goalDraftScope;
    if (goalDraftHydratedFor === nextScope) return;
    if (goalDraftHydratedFor !== null) {
      saveLocalFormDraft('goal-composer', goalDraftHydratedFor, {
        objective: goalObjective,
        scope: goalScope,
      });
    }
    const recovered = loadLocalFormDraft('goal-composer', nextScope);
    const hasRecoveredGoal = Boolean(recovered.objective?.trim());
    goalDraftHydratedFor = nextScope;
    goalObjective = recovered.objective || '';
    goalScope =
      hasRecoveredGoal &&
      (recovered.scope === 'workspace' ||
        recovered.scope === 'project' ||
        recovered.scope === 'session')
        ? recovered.scope
        : defaultGoalScope();
    goalDraftRecovered = hasRecoveredGoal;
  });
  $effect(() => {
    const draftScope = goalDraftScope;
    if (goalDraftHydratedFor !== draftScope) return;
    saveLocalFormDraft('goal-composer', draftScope, { objective: goalObjective, scope: goalScope });
  });
  $effect(() => {
    const command = (event: Event) => {
      const detail = (event as CustomEvent<GoalActionRequest | string>).detail;
      const request: GoalActionRequest =
        typeof detail === 'string' ? { action: detail as GoalActionRequest['action'] } : detail;
      if (request.action !== 'goal_create') return;
      showGoalComposer = true;
      goalError = '';
      if (request.objective) goalObjective = request.objective;
      setTimeout(() => goalComposerInput?.focus(), 0);
    };
    window.addEventListener('kory:goal-action', command);
    return () => window.removeEventListener('kory:goal-action', command);
  });
  function toggleGoalComposer() {
    showGoalComposer = !showGoalComposer;
    goalError = '';
    if (showGoalComposer) setTimeout(() => goalComposerInput?.focus(), 0);
  }
  async function createGoal() {
    try {
      goalError = '';
      if (!goalObjective.trim()) {
        goalComposerInput?.focus();
        return;
      }
      if (goalScope === 'project' && !projectStore.currentPath)
        throw new Error('Open a project before creating a project goal');
      if (goalScope === 'session' && !sessionStore.activeSessionId)
        throw new Error('Open a chat before creating a chat goal');
      const goal = await goalStore.create({
        objective: goalObjective.trim(),
        scope: goalScope,
        projectPath: goalScope === 'project' ? (projectStore.currentPath ?? undefined) : undefined,
        sessionId:
          goalScope === 'session' ? (sessionStore.activeSessionId ?? undefined) : undefined,
        planningDepth: agentSettingsStore.settings.goalPlanningDepth ?? 'adaptive',
      });
      goalObjective = '';
      goalDraftRecovered = false;
      showGoalComposer = false;
      // The new goal surfaces in the Goal Mode bubble directly above the chat.
      goalDisplayStore.update({ composer: true });
      if (agentSettingsStore.settings.automaticGoalDriving) await goalStore.drive(goal.id);
    } catch (err) {
      goalError = err instanceof Error ? err.message : String(err);
    }
  }

  let liveFileMentions = $state<string[]>([]);

  $effect(() => {
    if (!selectedModel && initialModel) selectedModel = initialModel;
  });

  // Permission presets are workspace settings. Load them for the composer
  // itself (not only after Settings is opened) and refresh on project changes.
  $effect(() => {
    projectStore.currentPath;
    void agentSettingsStore.loadSettings();
  });

  $effect(() => {
    if (!previewAttachment || !previewDialogRef) return;
    previewDialogRef.querySelector<HTMLButtonElement>('button')?.focus();
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
    if (provider === 'unorouter') return 'UnoRouter';
    if (provider === 'vertexai') return 'Vertex AI';
    if (provider === 'copilot') return 'Copilot';
    if (provider === 'kimicode') return 'Kimi Code';
    if (provider === 'grok') return 'Grok Build';
    return provider.charAt(0).toUpperCase() + provider.slice(1);
  }

  // Reasoning state - now tracks provider AND model
  let reasoningLevel = $state('medium');
  let showReasoningMenu = $state(false);
  let restoredComposerPreferenceFor = $state('');

  $effect(() => {
    selectedReasoningLevel = reasoningLevel;
  });

  let fallbackProvider = $derived.by(() => {
    const preferred = wsStore.providers.find(
      (p) => p.enabled && (p.adapterAvailable ?? p.authenticated),
    );
    return preferred?.name ?? 'anthropic';
  });

  let providerNames = $derived(wsStore.providers.map((p) => p.name));

  let currentProvider = $derived(
    !selectedModel
      ? fallbackProvider
      : (parseProviderModelSelection(selectedModel, providerNames).provider ?? fallbackProvider),
  );
  let currentModel = $derived(parseProviderModelSelection(selectedModel, providerNames).model);

  /** A model's own live-reported effort levels (e.g. Codex's supported_reasoning_levels)
   *  are the sole source of reasoning config. There are no static fallback tables —
   *  if the provider doesn't report reasoningLevels for a model, the picker is not shown. */
  function findModelDef(
    provider: string,
    model: string | undefined,
  ):
    | {
        id: string;
        name?: string;
        reasoningLevels?: string[];
        canReason?: boolean;
        supportsFastMode?: boolean;
        supportsAttachments?: boolean;
        vision?: boolean;
        costPerMInputTokens?: number;
        costPerMInputCached?: number;
      }
    | undefined {
    if (!model) return undefined;
    const p = wsStore.providers.find((p) => p.name === provider);
    const catalog = (p as any)?.allAvailableModels as
      | Array<{
          id: string;
          reasoningLevels?: string[];
          canReason?: boolean;
          supportsFastMode?: boolean;
          supportsAttachments?: boolean;
          vision?: boolean;
          costPerMInputTokens?: number;
          costPerMInputCached?: number;
          name?: string;
          /** Superseded ids (e.g. Antigravity's per-effort slugs) that now
           *  resolve to this model, so a selection saved before a catalog
           *  collapse still resolves to a real model. */
          aliases?: string[];
        }>
      | undefined;
    return catalog?.find((m) => m.id === model || m.aliases?.includes(model));
  }

  function effectiveReasoningConfig(provider: string, model: string | undefined) {
    const def = findModelDef(provider, model);
    // Levels the provider/CLI/models.dev reported for this exact model are
    // authoritative — including an explicit [] meaning "this model has NO
    // effort control". No static fallback; no canReason guess.
    if (Array.isArray(def?.reasoningLevels)) {
      return buildReasoningConfigFromLevels(def.reasoningLevels);
    }
    return null;
  }

  let reasoningConfig = $derived(
    !selectedModel ? null : effectiveReasoningConfig(currentProvider, currentModel),
  );
  let reasoningSupported = $derived(
    !!selectedModel && !!reasoningConfig && reasoningConfig.options.length > 0,
  );
  let reasoningIsValid = $derived(
    !!reasoningLevel &&
      !!reasoningConfig &&
      reasoningConfig.options.some((o) => o.value === reasoningLevel),
  );

  // Effort and Fast/Priority are model capabilities, so retain them per exact
  // selected model rather than applying an unsupported choice to another
  // provider. The live catalog below still wins if a model's capabilities
  // changed since the preference was written.
  $effect(() => {
    const model = selectedModel;
    if (!model || model === restoredComposerPreferenceFor) return;
    restoredComposerPreferenceFor = model;
    // A chat restoring its own saved controls must not be overridden by the
    // model's global defaults.
    if (suppressPreferenceRestoreFor === model) {
      suppressPreferenceRestoreFor = '';
      return;
    }
    const saved = loadComposerPreference(model);
    if (saved.reasoningLevel) reasoningLevel = saved.reasoningLevel;
    if (typeof saved.fastMode === 'boolean') fastMode = saved.fastMode;
  });

  $effect(() => {
    if (!reasoningConfig || reasoningConfig.options.length === 0) return;
    const next = resolveReasoningLevel(
      reasoningLevel,
      reasoningConfig.options.map((o) => o.value),
    );
    if (next !== reasoningLevel) reasoningLevel = next;
  });
  let fastMode = $state(false);
  let fastModeSupported = $derived(
    !!selectedModel &&
      (currentProvider === 'openai' ||
        ((currentProvider === 'codex' || currentProvider === 'codex-auth') &&
          findModelDef(currentProvider, currentModel)?.supportsFastMode === true)),
  );
  let fastModeLabel = $derived(currentProvider === 'openai' ? 'Priority' : 'Fast');
  let fastModeHint = $derived(
    currentProvider === 'openai'
      ? 'API Priority processing. Requires Priority access on this OpenAI project.'
      : '1.5× faster Codex service tier. Uses ChatGPT credits at a higher rate.',
  );

  $effect(() => {
    if (!fastModeSupported) fastMode = false;
  });

  $effect(() => {
    const model = selectedModel;
    if (!model || !reasoningIsValid) return;
    saveComposerPreference(model, { reasoningLevel });
  });

  $effect(() => {
    const model = selectedModel;
    if (!model || !fastModeSupported) return;
    saveComposerPreference(model, { fastMode });
  });

  let showPermissionMenu = $state(false);

  const PERMISSION_OPTIONS = [
    {
      value: 'yolo',
      label: 'YOLO',
      description: 'Run actions without approval prompts or risk checks.',
      icon: Zap,
      tone: 'text-[var(--color-warning)]',
    },
    {
      value: 'guarded',
      label: 'Guarded',
      description: 'Run all edits and routine tools. Ask only before risky actions.',
      icon: ShieldCheck,
      tone: 'text-[var(--color-success)]',
    },
    {
      value: 'edits',
      label: 'Accept edits',
      description: 'Apply file edits automatically. Ask before other actions.',
      icon: Pencil,
      tone: 'text-[var(--color-info)]',
    },
    {
      value: 'ask',
      label: 'Ask',
      description: 'Ask before every action.',
      icon: MessageCircleQuestion,
      tone: 'text-[var(--color-text-secondary)]',
    },
    {
      value: 'custom',
      label: 'Custom',
      description: 'Use the detailed approval rules from Settings.',
      icon: SlidersHorizontal,
      tone: 'text-[var(--color-accent)]',
    },
  ] as const;

  type PermissionMode = (typeof PERMISSION_OPTIONS)[number]['value'];

  // ─── Per-chat approval posture (permission preset, agent mode, critic) ─────
  // These three controls used to be project settings, so switching one chat to
  // YOLO silently reconfigured every other chat in the workspace. They are now
  // stored on the session itself, and the project value stays the default for
  // any chat that never made a choice.
  let sessionAgentOverrides = $derived(
    sessionStore.sessions.find((s) => s.id === sessionStore.activeSessionId)?.agentOverrides ?? {},
  );
  // Covers the window where the durable row has not caught up yet (and the
  // welcome panel, which has no session at all). Tagged with its chat so an
  // in-flight patch can never surface on the chat the user switched to.
  let pendingAgentOverrides = $state<{
    scope: string;
    overrides: SessionAgentOverrides;
  } | null>(null);
  let chatAgentOverrides = $derived.by(() => {
    const scope = currentDraftKey();
    const pending = pendingAgentOverrides;
    if (pending && pending.scope === scope) return pending.overrides;
    return sessionStore.activeSessionId ? sessionAgentOverrides : loadComposerSessionState(scope);
  });

  function setChatAgentOverrides(patch: SessionAgentOverrides) {
    const next = { ...chatAgentOverrides, ...patch };
    const scope = currentDraftKey();
    pendingAgentOverrides = { scope, overrides: next };
    saveComposerSessionState(scope, {
      ...(next.permissionMode ? { permissionMode: next.permissionMode } : {}),
      ...(next.agentExecutionMode ? { agentExecutionMode: next.agentExecutionMode } : {}),
      ...(typeof next.criticGateEnabled === 'boolean'
        ? { criticGateEnabled: next.criticGateEnabled }
        : {}),
    });
    const sessionId = sessionStore.activeSessionId;
    if (!sessionId) return;
    void sessionStore.setSessionAgentOverrides(sessionId, patch).then(() => {
      // Release the optimistic layer either way: on success the session row is
      // the source of truth, on failure the store has already rolled back.
      if (pendingAgentOverrides?.overrides === next) pendingAgentOverrides = null;
    });
  }

  let permissionMode = $derived(
    (chatAgentOverrides.permissionMode ??
      (agentSettingsStore.settings.permissionMode === 'plan'
        ? 'guarded'
        : (agentSettingsStore.settings.permissionMode ?? 'guarded'))) as PermissionMode,
  );
  let permissionModeMeta = $derived(
    PERMISSION_OPTIONS.find((option) => option.value === permissionMode) ?? PERMISSION_OPTIONS[1],
  );

  $effect(() => {
    // Yolo is a single connection-level flag on wsStore (setYoloMode takes no
    // session), so derive it purely from the current permission mode.
    wsStore.setYoloMode(permissionMode === 'yolo');
  });

  function selectPermissionMode(next: PermissionMode) {
    showPermissionMenu = false;
    if (permissionMode !== next) {
      setChatAgentOverrides({ permissionMode: next });
    }
    if (next === 'custom' && !isGuidedDemo) onOpenSettings?.('agent', 'permissions');
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
    const models: Array<{
      label: string;
      value: string;
      provider: string;
      name: string;
      contextWindow?: number;
      supportsAttachments?: boolean;
      vision?: boolean;
    }> = [];
    for (const p of wsStore.providers) {
      if (p.enabled && (p.adapterAvailable ?? p.authenticated)) {
        const enabledIds = new Set(p.models);
        const catalog = (p as any).allAvailableModels as
          | Array<{
              id: string;
              name: string;
              contextWindow?: number;
              contextVerified?: boolean;
              supportsAttachments?: boolean;
              vision?: boolean;
            }>
          | undefined;
        if (catalog && catalog.length > 0) {
          for (const m of catalog) {
            if (enabledIds.size === 0 || enabledIds.has(m.id)) {
              models.push({
                label: `(${providerLabel(p.name)}) ${m.name}`,
                value: `${p.name}:${m.id}`,
                provider: p.name,
                name: m.name,
                supportsAttachments: m.supportsAttachments,
                vision: m.vision,
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
            models.push({
              label: `(${providerLabel(p.name)}) ${m}`,
              value: `${p.name}:${m}`,
              provider: p.name,
              name: m,
            });
          }
        }
      }
    }
    return models;
  });

  // The catalog is the authority, but provider status arrives incrementally
  // (refreshModels flights return models:[] / detected / unknown). Only clear
  // a manual choice once the catalog for that provider is definitively loaded,
  // otherwise a transient push would irreversibly delete localStorage and the
  // picker would fall back to "Select model".
  $effect(() => {
    const value = selectedModel;
    const providers = wsStore.providers;
    if (!value || value === 'auto' || providers.length === 0) return;
    const { provider, model } = parseProviderModelSelection(value, providerNames);
    if (!provider || !model) return;
    if (isEnabledModelSelection(providers, value)) return;
    const target = providers.find((p) => p.name === provider);
    // Provider list incomplete or catalog still in flight: preserve selection.
    if (!target) return;
    if (target.connectionState === 'detected' || target.connectionState === 'unknown') return;
    if (!Array.isArray(target.models) || target.models.length === 0) return;
    selectedModel = '';
    if (typeof localStorage !== 'undefined') localStorage.removeItem(MODEL_STORAGE_KEY);
  });

  let filteredQuickModels = $derived.by(() => {
    const candidates = modelPickerVisionOnly
      ? availableModels.filter((model) => modelHasVerifiedImageInput(model))
      : availableModels;
    const query = modelSearchQuery.trim().toLowerCase();
    if (!query) return candidates;
    return candidates.filter((model) => {
      const haystack =
        `${model.name} ${providerLabel(model.provider)} ${model.provider} ${model.value}`.toLowerCase();
      return haystack.includes(query);
    });
  });

  let isSearchingModels = $derived(modelSearchQuery.trim().length > 0);

  let groupedModels = $derived.by(() => {
    const map = new Map<string, (typeof availableModels)[number][]>();
    const order: string[] = [];
    for (const model of filteredQuickModels) {
      if (!map.has(model.provider)) {
        order.push(model.provider);
        map.set(model.provider, []);
      }
      map.get(model.provider)!.push(model);
    }
    return order.map((provider) => ({
      provider,
      label: providerLabel(provider),
      models: map.get(provider)!,
    }));
  });

  let selectedModelLabel = $derived.by(() => {
    if (!selectedModel) return 'Select model';
    const parsed = parseProviderModelSelection(selectedModel, providerNames);
    if (!parsed.model || !parsed.provider) return selectedModel;
    const modelDef = findModelDef(parsed.provider, parsed.model);
    if (modelDef?.name) return `(${providerLabel(parsed.provider)}) ${modelDef.name}`;
    return parsed.model;
  });

  let contextPreviewGeneration = 0;

  async function previewSelectedModelContext(value: string) {
    const sid = sessionStore.activeSessionId;
    if (!sid || !value) return;
    if (contextImagePreview?.sessionId !== sid) contextImagePreview = null;
    const generation = ++contextPreviewGeneration;
    const target = availableModels.find((m) => m.value === value);
    const { provider, model } = parseProviderModelSelection(value, providerNames);
    if (!provider || !model) {
      wsStore.clearManagerContextPreview(sid);
      return;
    }
    // A selection is a new telemetry epoch. Clear the prior provider/model's
    // usage composition immediately; the matching backend response is the only
    // thing allowed to repopulate it.
    wsStore.beginManagerContextPreview(sid, provider, model, target?.contextWindow);
    if (disableModelPreviewRequests) return;
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
        )
          return;
        try {
          const response = await apiFetch(apiUrl(`/api/sessions/${sid}/context/model-preview`), {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ model, provider }),
          });
          const result = (await response.json()) as {
            error?: string;
            usage?: {
              provider?: string;
              model?: string;
              used?: number;
              contextWindow?: number;
              contextKnown?: boolean;
              contextSource?: 'live' | 'catalog' | 'alias';
              usageKnown?: boolean;
              hasImageAttachments?: boolean;
              imageAttachmentCount?: number;
              cachedInputTokens?: number;
              breakdown?: ContextBreakdown;
            };
          };
          if (!response.ok || !result.usage) {
            throw new Error(result.error || `Context preview failed (${response.status})`);
          }
          if (
            generation !== contextPreviewGeneration ||
            sessionStore.activeSessionId !== sid ||
            selectedModel !== value
          )
            return;
          contextImagePreview = {
            sessionId: sid,
            imageCount:
              typeof result.usage?.imageAttachmentCount === 'number'
                ? result.usage.imageAttachmentCount
                : result.usage?.hasImageAttachments
                  ? 1
                  : 0,
          };
          wsStore.applyManagerContextPreview(sid, provider, model, result.usage);
          if (result.usage?.contextSource === 'live' || result.usage?.contextSource === 'alias')
            return;
        } catch (err: unknown) {
          console.debug(
            'Context preview request failed:',
            err instanceof Error ? err.message : String(err),
          );
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
    if (!sid) return;
    // No model selected — clear stale context metadata from the previous chat
    // instead of continuing to show the previous model's window.
    if (!model) {
      const key = `${sid}:none`;
      if (key === lastContextPreviewKey) return;
      lastContextPreviewKey = key;
      contextImagePreview = null;
      wsStore.clearManagerContextPreview(sid);
      return;
    }
    // Track catalog changes so a late provider discovery can replace an
    // initially unknown window with verified metadata.
    const targetWindow = availableModels.find((m) => m.value === model)?.contextWindow ?? 0;
    const key = `${sid}:${model}:${targetWindow}`;
    if (key === lastContextPreviewKey) return;
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
  let mentionPaths = $derived(liveFileMentions.length > 0 ? liveFileMentions : fileMentions);

  let pickerItems = $derived.by<ComposerPickerItem[]>(() => {
    const ctx = triggerContext;
    if (!ctx) return [];
    const query = ctx.query.trim().toLowerCase();

    if (ctx.trigger === '/') {
      return slashCommands
        .filter(
          (item) =>
            !query ||
            item.command.toLowerCase().includes(query) ||
            item.label.toLowerCase().includes(query),
        )
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
  let pickerOpen = $derived(
    !!triggerContext && (triggerContext.trigger === '@' || pickerItems.length > 0),
  );

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
    const fast = trimmed.match(/^\/fast(?:\s+(on|off|status))?$/i);
    if (fast) {
      if (!fastModeSupported) {
        toastStore.error(
          'Fast mode is only available for Fast-capable ChatGPT Codex models or OpenAI API Priority processing.',
        );
      } else if (fast[1]?.toLowerCase() === 'status') {
        toastStore.info(`${fastModeLabel} is ${fastMode ? 'on' : 'off'}. ${fastModeHint}`);
      } else {
        fastMode = fast[1] ? fast[1].toLowerCase() === 'on' : !fastMode;
        toastStore.info(`${fastModeLabel} ${fastMode ? 'enabled' : 'disabled'}. ${fastModeHint}`);
      }
      value = '';
      resizeToMin();
      return true;
    }
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
      if (
        e.key === 'Tab' ||
        (e.key === 'Enter' && !e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey)
      ) {
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
    // Ctrl+Shift+V / Cmd+Shift+V → force paste image from clipboard
    if ((e.ctrlKey || e.metaKey) && e.shiftKey && (e.key === 'v' || e.key === 'V')) {
      e.preventDefault();
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

  function visibleTranscriptImageCount(): number {
    return wsStore.feed.reduce((count, entry) => {
      if (entry.type !== 'user_message') return count;
      const entryAttachments = (entry.metadata as { attachments?: Attachment[] } | undefined)
        ?.attachments;
      return (
        count + (entryAttachments?.filter((attachment) => attachment.type === 'image').length ?? 0)
      );
    }, 0);
  }

  function contextImageCount(): number {
    const sid = sessionStore.activeSessionId;
    if (sid && contextImagePreview?.sessionId === sid) {
      // The backend preview is the authoritative active-context count. The
      // visible feed may include entries excluded by Time Travel/compaction.
      return contextImagePreview.imageCount;
    }
    return visibleTranscriptImageCount();
  }

  /**
   * Decisions that can withhold pixels always re-read the backend's active
   * provider context. The cached preview is UI telemetry and may be stale
   * after compaction, rewind, deletion, or an in-flight send.
   */
  async function authoritativeContextImageCount(modelValue: string): Promise<number> {
    if (disableModelPreviewRequests) return visibleTranscriptImageCount();
    const sid = sessionStore.activeSessionId;
    const { provider, model } = parseProviderModelSelection(modelValue, providerNames);
    if (!sid || !provider || !model) return visibleTranscriptImageCount();
    try {
      const response = await apiFetch(apiUrl(`/api/sessions/${sid}/context/model-preview`), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model, provider }),
      });
      const result = (await response.json()) as {
        error?: string;
        usage?: { hasImageAttachments?: boolean; imageAttachmentCount?: number };
      };
      if (!response.ok || !result.usage) {
        throw new Error(result.error || `Context preview failed (${response.status})`);
      }
      const imageCount =
        typeof result.usage.imageAttachmentCount === 'number'
          ? result.usage.imageAttachmentCount
          : result.usage.hasImageAttachments
            ? 1
            : 0;
      if (sessionStore.activeSessionId === sid) {
        contextImagePreview = { sessionId: sid, imageCount };
      }
      return imageCount;
    } catch (err: unknown) {
      console.debug(
        'Authoritative image context lookup failed:',
        err instanceof Error ? err.message : String(err),
      );
      // Fail closed. The active feed can overcount compacted rows, but it will
      // never silently send a known image to an unverified transport.
      return visibleTranscriptImageCount();
    }
  }

  function imageConsentKey(modelValue: string): string {
    return `${sessionStore.activeSessionId ?? 'new-session'}::${modelValue}`;
  }

  function hasImageOmitConsent(modelValue: string): boolean {
    const remembered = readRememberedImageInputMode(
      typeof localStorage === 'undefined' ? undefined : localStorage,
    );
    return remembered === 'omit' || oneShotImageOmitConsents.has(imageConsentKey(modelValue));
  }

  function grantImageOmitConsent(modelValue: string, remember: boolean, oneShot = false) {
    if (remember) {
      rememberImageInputMode(
        typeof localStorage === 'undefined' ? undefined : localStorage,
        'omit',
      );
    } else if (oneShot) {
      oneShotImageOmitConsents = new Set([
        ...oneShotImageOmitConsents,
        imageConsentKey(modelValue),
      ]);
    }
  }

  function consumeOneShotImageOmitConsent(modelValue: string) {
    const key = imageConsentKey(modelValue);
    if (!oneShotImageOmitConsents.has(key)) return;
    const next = new Set(oneShotImageOmitConsents);
    next.delete(key);
    oneShotImageOmitConsents = next;
  }

  function showImageOmitNotice(modelValue: string) {
    toastStore.warning('Sent without image input. Images remain visible in the transcript.', {
      duration: 8_000,
      actionLabel: 'Ask next time',
      action: () => {
        rememberImageInputMode(
          typeof localStorage === 'undefined' ? undefined : localStorage,
          'reject',
        );
        const next = new Set(oneShotImageOmitConsents);
        next.delete(imageConsentKey(modelValue));
        oneShotImageOmitConsents = next;
      },
    });
  }

  async function dispatchSend(
    trimmed: string,
    imageInputMode: ImageInputMode = 'reject',
    historicalImageCount = contextImageCount(),
  ) {
    const now = Date.now();
    if (now - lastSendAt < SEND_COOLDOWN_MS) return;
    lastSendAt = now;
    const outgoingAttachments = attachments.length > 0 ? [...attachments] : undefined;
    const outgoingImageCount =
      outgoingAttachments?.filter((attachment) => attachment.type === 'image').length ?? 0;
    const modelValue = selectedModel;
    // A preview started before this turn cannot overwrite the optimistic
    // post-send image count with its older database snapshot.
    contextPreviewGeneration++;
    let accepted = false;
    try {
      accepted =
        (await onSend(
          trimmed,
          modelValue,
          reasoningLevel,
          outgoingAttachments,
          fastMode,
          imageInputMode,
        )) !== false;
    } catch (error) {
      toastStore.error(error instanceof Error ? error.message : 'Could not send message');
      return;
    }
    // A consent/project/configuration interruption is not a send. Keep the
    // local draft intact so closing that dialog or reloading cannot lose text
    // or recoverable attachments.
    if (!accepted) return;
    if (outgoingImageCount > 0 && sessionStore.activeSessionId) {
      const sid = sessionStore.activeSessionId;
      contextImagePreview = {
        sessionId: sid,
        imageCount: historicalImageCount + outgoingImageCount,
      };
    }
    consumeOneShotImageOmitConsent(modelValue);
    if (imageInputMode === 'omit') showImageOmitNotice(modelValue);
    clearCurrentDraft();
  }

  function continueWithoutImageInput(remember: boolean) {
    const warning = imageFallbackWarning;
    if (!warning) return;
    imageFallbackWarning = null;
    if (warning.mode === 'model-switch') {
      // A non-persistent model-switch choice carries through only to the next
      // send, avoiding a second dialog without turning it into "don't ask".
      grantImageOmitConsent(warning.targetValue, remember, !remember);
      applyModelSelection(warning.targetValue);
      toastStore.info(
        remember
          ? 'Model selected. Image input will be omitted until you choose Ask next time.'
          : 'Model selected. Image input will be omitted from the next send.',
      );
      return;
    }
    grantImageOmitConsent(warning.targetValue, remember);
    void dispatchSend(
      warning.message ?? value.trim(),
      'omit',
      warning.historicalImageCount ?? contextImageCount(),
    );
  }

  function chooseVisionModelFromWarning() {
    imageFallbackWarning = null;
    // The click bubbles through the window-level outside-click handler. Open
    // after that event finishes so it cannot immediately close the picker.
    requestAnimationFrame(() => openModelPicker(true));
  }

  async function send() {
    if (disabled) return;
    // Local slash commands control Koryphaios itself and must remain usable
    // before a provider/model is selected (Goal Mode, Settings, Time Travel,
    // help, and workspace navigation do not require model authority).
    if (await executeSlashIfNeeded()) return;
    if (configurationWarning) {
      onOpenSettings?.();
      return;
    }
    if (!selectedModel) {
      openModelPicker();
      return;
    }
    if (imageAdmissionPending) return;
    imageAdmissionPending = true;
    try {
      if (pendingAttachmentReads.size > 0) {
        await Promise.all([...pendingAttachmentReads]);
      }
      const admissionValue = value;
      const admissionAttachments = attachments;
      const trimmed = admissionValue.trim();
      if (!trimmed && admissionAttachments.length === 0) return;
      const currentImages = admissionAttachments.filter(
        (attachment) => attachment.type === 'image',
      ).length;
      const sendSessionId = sessionStore.activeSessionId;
      const sendModelValue = selectedModel;
      const historicalImages = await authoritativeContextImageCount(sendModelValue);
      if (
        sessionStore.activeSessionId !== sendSessionId ||
        selectedModel !== sendModelValue ||
        value !== admissionValue ||
        attachments !== admissionAttachments
      )
        return;
      const totalImages = historicalImages + currentImages;
      const model = findModelDef(currentProvider, currentModel);
      const hasOmitConsent = hasImageOmitConsent(selectedModel);
      if (needsImageInputChoice(totalImages, model, hasOmitConsent)) {
        imageFallbackWarning = {
          mode: 'send',
          targetValue: selectedModel,
          targetLabel: selectedModelLabel,
          imageCount: totalImages,
          historicalImageCount: historicalImages,
          message: trimmed,
        };
        return;
      }
      if (totalImages > 0 && !modelHasVerifiedImageInput(model) && hasOmitConsent) {
        await dispatchSend(trimmed, 'omit', historicalImages);
        return;
      }
      await dispatchSend(trimmed, 'reject', historicalImages);
    } finally {
      imageAdmissionPending = false;
    }
  }

  function stop() {
    onStop?.();
  }

  const BASE_MIN_HEIGHT_PX = 88;
  const MAX_HEIGHT_PX = 280;
  let minHeightPx = $state(BASE_MIN_HEIGHT_PX);

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

  let composerMetricsFrame: number | null = null;
  let composerResizeObserver: ResizeObserver | null = null;
  let lastActionPanelHeight = -1;

  /**
   * Re-measure the composer on the next frame, coalescing bursts.
   *
   * `autoResize()` measures (`scrollHeight`) and then writes `style.height`, so
   * running it inside a ResizeObserver callback forces a synchronous relayout
   * during layout delivery. Chromium cannot report the resulting size change
   * back in the same cycle and logs "ResizeObserver loop completed with
   * undelivered notifications" on every composer relayout. Deferring to an
   * animation frame keeps all measurement and style writes outside the
   * delivery step.
   */
  function scheduleComposerMetrics(): void {
    if (typeof requestAnimationFrame === 'undefined') return;
    if (composerMetricsFrame !== null) return;
    composerMetricsFrame = requestAnimationFrame(() => {
      composerMetricsFrame = null;
      syncComposerMinHeight();
      autoResize();
    });
  }

  /**
   * Point the observer at the current action panel. The panel is rendered
   * conditionally, so this re-runs whenever `actionPanelRef` changes instead of
   * latching onto whatever happened to be mounted during `onMount`.
   */
  function observeActionPanel(el: HTMLDivElement | undefined): void {
    if (!composerResizeObserver) {
      composerResizeObserver = new ResizeObserver((entries) => {
        const entry = entries[entries.length - 1];
        if (!entry) return;
        // `borderBoxSize` is the accurate measurement but is missing in older
        // engines, so fall back to the content box there.
        const height = entry.borderBoxSize?.[0]?.blockSize ?? entry.contentRect.height;
        // Only the panel's height feeds the composer's minimum height, so an
        // unchanged panel must not schedule more work.
        if (height === lastActionPanelHeight) return;
        lastActionPanelHeight = height;
        scheduleComposerMetrics();
      });
    }
    composerResizeObserver.disconnect();
    lastActionPanelHeight = -1;
    if (el) composerResizeObserver.observe(el);
  }

  function audioMimeType(): string | undefined {
    return ['audio/webm;codecs=opus', 'audio/mp4', 'audio/ogg;codecs=opus'].find((type) =>
      MediaRecorder.isTypeSupported(type),
    );
  }

  function blobBase64(blob: Blob): Promise<string> {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onerror = () => reject(reader.error ?? new Error('Could not read the recording'));
      reader.onload = () => resolve(String(reader.result).split(',', 2)[1] ?? '');
      reader.readAsDataURL(blob);
    });
  }

  function combineAudioChunks(chunks: Float32Array[]): Float32Array {
    const length = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
    const combined = new Float32Array(length);
    let offset = 0;
    for (const chunk of chunks) {
      combined.set(chunk, offset);
      offset += chunk.length;
    }
    return combined;
  }

  function resampleTo16Khz(input: Float32Array, sampleRate: number): Float32Array {
    if (!input.length || sampleRate === 16_000) return input;
    const ratio = sampleRate / 16_000;
    const outputLength = Math.max(1, Math.round(input.length / ratio));
    const output = new Float32Array(outputLength);
    for (let index = 0; index < outputLength; index += 1) {
      const sourcePosition = index * ratio;
      const leftIndex = Math.floor(sourcePosition);
      const rightIndex = Math.min(leftIndex + 1, input.length - 1);
      const mix = sourcePosition - leftIndex;
      output[index] = input[leftIndex] * (1 - mix) + input[rightIndex] * mix;
    }
    return output;
  }

  async function pcm16Base64(samples: Float32Array): Promise<string> {
    const bytes = new Uint8Array(samples.length * 2);
    const view = new DataView(bytes.buffer);
    for (let index = 0; index < samples.length; index += 1) {
      const sample = Math.max(-1, Math.min(1, samples[index]));
      view.setInt16(index * 2, sample < 0 ? sample * 32768 : sample * 32767, true);
    }
    return blobBase64(new Blob([bytes.buffer], { type: 'application/octet-stream' }));
  }

  async function transcribeLocalRecording(samples: Float32Array, language: string) {
    isTranscribing = true;
    try {
      const pcmBase64 = await pcm16Base64(samples);
      const result = await invoke<{ text: string }>('transcribe_local_voice', {
        pcmBase64,
        language,
      });
      if (!result.text?.trim()) throw new Error('No speech was detected');
      appendTranscription(result.text);
    } catch (error) {
      toastStore.error(error instanceof Error ? error.message : String(error));
    } finally {
      isTranscribing = false;
    }
  }

  function releaseLocalRecorder(recorder: LocalPcmRecorder) {
    recorder.processor.onaudioprocess = null;
    recorder.source.disconnect();
    recorder.processor.disconnect();
    recorder.sink.disconnect();
    recorder.stream.getTracks().forEach((track) => track.stop());
    void recorder.context.close();
  }

  function stopLocalRecording(transcribe = true) {
    const recorder = activeLocalRecorder;
    if (!recorder) return;
    activeLocalRecorder = null;
    isRecording = false;
    releaseLocalRecorder(recorder);
    if (!transcribe) return;
    const samples = resampleTo16Khz(combineAudioChunks(recorder.chunks), recorder.sampleRate);
    if (samples.length) void transcribeLocalRecording(samples, recorder.language);
  }

  async function startLocalRecording(settings: VoiceSettings) {
    if (!navigator.mediaDevices?.getUserMedia)
      throw new Error('Microphone recording is unavailable in this runtime');
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
      },
    });
    const context = new AudioContext();
    await context.resume();
    const source = context.createMediaStreamSource(stream);
    const processor = context.createScriptProcessor(4096, 1, 1);
    const sink = context.createGain();
    sink.gain.value = 0;
    const chunks: Float32Array[] = [];
    processor.onaudioprocess = (event) => {
      chunks.push(new Float32Array(event.inputBuffer.getChannelData(0)));
    };
    source.connect(processor);
    processor.connect(sink);
    sink.connect(context.destination);
    activeLocalRecorder = {
      stream,
      context,
      source,
      processor,
      sink,
      chunks,
      sampleRate: context.sampleRate,
      language: settings.input.language || 'en',
    };
    isRecording = true;
  }

  async function loadComposerVoiceSettings(): Promise<VoiceSettings> {
    const response = await apiFetch(apiUrl('/api/voice/settings'));
    const result = await response.json();
    if (!response.ok || !result.data)
      throw new Error(result.error || 'Could not load voice settings');
    voiceSettings = result.data;
    return voiceSettings!;
  }

  function appendTranscription(transcript: string) {
    const text = transcript.trim();
    if (!text) return;
    value = `${value}${value && !value.endsWith(' ') ? ' ' : ''}${text}`;
    requestAnimationFrame(() => {
      autoResize();
      inputRef?.focus();
    });
  }

  function speechRecognitionErrorMessage(error: string): string {
    if (error === 'service-not-allowed')
      return 'Speech recognition is not allowed. Check Koryphaios microphone and speech recognition access in System Settings.';
    if (error === 'not-allowed')
      return 'Speech recognition is not allowed. Check Koryphaios microphone access in System Settings.';
    if (error === 'audio-capture') return 'Speech recognition could not access the microphone.';
    const readable = error.trim().replaceAll('-', ' ') || 'unknown error';
    return `Speech recognition failed: ${readable}`;
  }

  async function startSystemRecognition(settings: VoiceSettings) {
    const speechWindow = window as typeof window & {
      SpeechRecognition?: BrowserSpeechRecognitionConstructor;
      webkitSpeechRecognition?: BrowserSpeechRecognitionConstructor;
    };
    const Recognition = speechWindow.SpeechRecognition ?? speechWindow.webkitSpeechRecognition;
    if (!Recognition) throw new Error('System speech recognition is unavailable in this runtime');
    if (navigator.mediaDevices?.getUserMedia) {
      const permissionStream = await navigator.mediaDevices.getUserMedia({ audio: true });
      permissionStream.getTracks().forEach((track) => track.stop());
    }
    const recognition = new Recognition();
    recognition.lang = settings.input.language;
    recognition.continuous = true;
    recognition.interimResults = false;
    recognition.onresult = (event) => {
      for (let index = event.resultIndex; index < event.results.length; index += 1) {
        const result = event.results[index];
        if (result?.isFinal) appendTranscription(result[0].transcript);
      }
    };
    recognition.onerror = (event) => {
      if (event.error !== 'aborted' && event.error !== 'no-speech')
        toastStore.error(speechRecognitionErrorMessage(event.error));
    };
    recognition.onend = () => {
      if (activeSpeechRecognition === recognition) activeSpeechRecognition = null;
      isRecording = false;
    };
    activeSpeechRecognition = recognition;
    recognition.start();
    isRecording = true;
  }

  async function transcribeRecording(blob: Blob, language: string) {
    isTranscribing = true;
    try {
      const audioBase64 = await blobBase64(blob);
      const response = await apiFetch(apiUrl('/api/voice/transcribe'), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ audioBase64, mimeType: blob.type, language }),
      });
      const result = await response.json();
      if (!response.ok || !result.data?.text)
        throw new Error(result.error || 'Transcription failed');
      appendTranscription(result.data.text);
    } catch (error) {
      toastStore.error(error instanceof Error ? error.message : 'Transcription failed');
    } finally {
      isTranscribing = false;
    }
  }

  /** Stop whatever is currently recording and transcribe it. */
  function stopRecording() {
    if (activeLocalRecorder && isRecording) {
      stopLocalRecording();
      return true;
    }
    if (activeSpeechRecognition && isRecording) {
      activeSpeechRecognition.stop();
      return true;
    }
    if (activeRecorder && isRecording) {
      activeRecorder.stop();
      return true;
    }
    return false;
  }

  function isRecordingNow(): boolean {
    return isRecording && !!(activeLocalRecorder || activeSpeechRecognition || activeRecorder);
  }

  /** Begin a push-to-talk hold from the microphone button. */
  function beginHoldToTalk() {
    if (holdToTalkActive || isRecordingNow()) return;
    holdToTalkActive = true;
    void startRecording();
  }

  /** End a push-to-talk hold. Releasing without a recording is a no-op, so a
   *  hold that was refused (no microphone permission, no model installed) does
   *  not leave the hold stuck. */
  function endHoldToTalk() {
    if (!holdToTalkActive) return;
    holdToTalkActive = false;
    stopRecording();
  }

  async function toggleRecording() {
    if (stopRecording()) return;
    await startRecording();
  }

  async function startRecording() {
    try {
      const settings = await loadComposerVoiceSettings();
      if (!settings.voiceModeEnabled)
        throw new Error('Enable the composer microphone in Voice settings first');
      if (settings.input.provider === 'kory-local') {
        let localStatus: LocalVoiceModelStatus;
        try {
          localStatus = await invoke<LocalVoiceModelStatus>('local_voice_model_status');
        } catch {
          // A refused hold must not stay held, or the next release stops
          // whatever started later.
          holdToTalkActive = false;
          onOpenSettings?.('voice');
          return;
        }
        if (!localStatus.installed) {
          holdToTalkActive = false;
          onOpenSettings?.('voice');
          return;
        }
        await startLocalRecording(settings);
        return;
      }
      if (settings.input.provider === 'system') {
        await startSystemRecognition(settings);
        return;
      }
      if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined')
        throw new Error('Microphone recording is unavailable in this runtime');
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const chunks: BlobPart[] = [];
      const type = audioMimeType();
      const recorder = new MediaRecorder(stream, type ? { mimeType: type } : undefined);
      activeRecorder = recorder;
      recorder.ondataavailable = (event) => {
        if (event.data.size) chunks.push(event.data);
      };
      recorder.onstop = () => {
        stream.getTracks().forEach((track) => track.stop());
        const blob = new Blob(chunks, { type: recorder.mimeType || type || 'audio/webm' });
        activeRecorder = null;
        isRecording = false;
        if (blob.size) void transcribeRecording(blob, settings.input.language || 'en');
      };
      recorder.start();
      isRecording = true;
    } catch (error) {
      holdToTalkActive = false;
      toastStore.error(error instanceof Error ? error.message : 'Could not access the microphone');
    }
  }

  onMount(() => {
    if (typeof window === 'undefined') return;

    // Global Esc listener to stop running agent
    const handleGlobalEsc = (e: KeyboardEvent) => {
      if (
        e.key === 'Escape' &&
        isRunning &&
        !showModelPicker &&
        !showReasoningMenu &&
        !pickerOpen
      ) {
        stop();
      }
    };
    window.addEventListener('keydown', handleGlobalEsc);
    // Voice mode is a global action so it works without focusing the composer.
    // It is push to talk: hold the key to record, release to transcribe.
    const voiceBlocked = () =>
      !composerMicrophoneEnabled ||
      disabled ||
      imageAdmissionPending ||
      !!configurationWarning ||
      isTranscribing;
    const voiceTargetIsTyping = () => {
      const target = document.activeElement;
      if (!target) return false;
      if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) return true;
      return (target as HTMLElement).isContentEditable === true;
    };
    const handleVoiceShortcutDown = (e: KeyboardEvent) => {
      if (e.repeat || !shortcutStore.matches('voice_mode', e)) return;
      if (voiceBlocked() || isRecordingNow()) return;
      // A binding with no modifier would otherwise swallow ordinary typing, so
      // it only acts outside a text field.
      if (shortcutStore.isBare('voice_mode') && voiceTargetIsTyping()) return;
      e.preventDefault();
      beginHoldToTalk();
    };
    const handleVoiceShortcutUp = (e: KeyboardEvent) => {
      if (!holdToTalkActive || !shortcutStore.matches('voice_mode', e)) return;
      e.preventDefault();
      endHoldToTalk();
    };
    // A key released outside the window never delivers keyup, so the recording
    // is stopped when focus leaves instead of running forever.
    const releaseVoiceHold = () => endHoldToTalk();
    const handleVoiceBlur = () => releaseVoiceHold();
    window.addEventListener('keydown', handleVoiceShortcutDown);
    window.addEventListener('keyup', handleVoiceShortcutUp);
    window.addEventListener('blur', handleVoiceBlur);
    const handleVoiceSettingsChanged = (event: Event) => {
      voiceSettings = (event as CustomEvent<VoiceSettings>).detail;
    };
    window.addEventListener('koryphaios:voice-settings-changed', handleVoiceSettingsChanged);
    void loadComposerVoiceSettings().catch(() => {
      voiceSettings = null;
    });

    observeActionPanel(actionPanelRef);

    const handleWindowResize = () => {
      scheduleComposerMetrics();
    };

    window.addEventListener('resize', handleWindowResize);
    scheduleComposerMetrics();

    return () => {
      composerResizeObserver?.disconnect();
      if (composerMetricsFrame !== null) cancelAnimationFrame(composerMetricsFrame);
      composerMetricsFrame = null;
      window.removeEventListener('resize', handleWindowResize);
      window.removeEventListener('keydown', handleGlobalEsc);
      window.removeEventListener('keydown', handleVoiceShortcutDown);
      window.removeEventListener('keyup', handleVoiceShortcutUp);
      window.removeEventListener('blur', handleVoiceBlur);
      window.removeEventListener('koryphaios:voice-settings-changed', handleVoiceSettingsChanged);
      activeSpeechRecognition?.abort();
      if (activeLocalRecorder) stopLocalRecording(false);
      if (activeRecorder?.state !== 'inactive') activeRecorder?.stop();
      activeRecorder?.stream.getTracks().forEach((track) => track.stop());
    };
  });

  $effect(() => {
    // The action panel is conditional, so re-point the observer whenever the
    // bound element changes; observing whatever existed at mount time left the
    // composer permanently unobserved.
    observeActionPanel(actionPanelRef);
    scheduleComposerMetrics();
    return () => {
      composerResizeObserver?.disconnect();
    };
  });

  $effect(() => {
    value; // track value so we resize when it changes (e.g. paste or programmatic set)
    if (typeof requestAnimationFrame === 'undefined') return;
    requestAnimationFrame(() => autoResize());
  });

  // Set when the user picks a model whose window can't hold the current
  // session context — they choose how to shrink it instead of a silent break.
  let overflowWarning = $state<{
    value: string;
    label: string;
    window: number;
    used: number;
  } | null>(null);

  function warnWarmCacheBreak(
    change: string,
    modelDef: ReturnType<typeof findModelDef>,
    compareWithCachedRate: boolean,
  ) {
    const impact = estimateCacheBreakImpact(
      wsStore.contextUsage.cachedInputTokens ?? 0,
      modelDef?.costPerMInputTokens,
      compareWithCachedRate ? modelDef?.costPerMInputCached : undefined,
    );
    if (!impact) return;

    let message = `${change} changes the prompt-cache identity. ~${formatCompactTokens(impact.cachedTokens)} warm input tokens will be re-read fresh on the next turn.`;
    if (impact.freshCostUsd !== undefined) {
      message += ` Estimated fresh input: $${impact.freshCostUsd.toFixed(4)}.`;
    }
    if (impact.incrementalCostUsd !== undefined) {
      message += ` About $${impact.incrementalCostUsd.toFixed(4)} more than the cached read.`;
    }
    toastStore.warning(message, { duration: 9_000 });
  }

  function applyModelSelection(value: string) {
    if (value !== selectedModel) {
      const parsed = parseProviderModelSelection(value, providerNames);
      warnWarmCacheBreak(
        `Switching to ${parsed.model ?? 'this model'}`,
        parsed.provider && parsed.model ? findModelDef(parsed.provider, parsed.model) : undefined,
        false,
      );
    }
    const targetConsentKey = imageConsentKey(value);
    if (
      oneShotImageOmitConsents.size > 0 &&
      !(oneShotImageOmitConsents.size === 1 && oneShotImageOmitConsents.has(targetConsentKey))
    ) {
      oneShotImageOmitConsents = oneShotImageOmitConsents.has(targetConsentKey)
        ? new Set([targetConsentKey])
        : new Set();
    }
    selectedModel = value;
    showModelPicker = false;
    if (typeof localStorage !== 'undefined') localStorage.setItem(MODEL_STORAGE_KEY, value);
    // Re-baseline the context bar immediately (optimistic, from local model
    // data), then ask the backend for the trusted window — the backend answer
    // arrives as a normal stream.usage event and always wins. Works for every
    // harness and API provider.
    previewSelectedModelContext(value);
  }

  async function selectModel(value: string) {
    const generation = ++modelSelectionGeneration;
    const selectionSessionId = sessionStore.activeSessionId;
    const target = availableModels.find((m) => m.value === value);
    const usage = wsStore.contextUsage;
    if (target?.contextWindow && usage.isReliable && usage.used > target.contextWindow) {
      showModelPicker = false;
      overflowWarning = {
        value,
        label: target.label,
        window: target.contextWindow,
        used: usage.used,
      };
      return;
    }
    if (imageAdmissionPending) return;
    imageAdmissionPending = true;
    const admissionAttachments = attachments;
    try {
      const historicalImageCount = await authoritativeContextImageCount(value);
      if (
        generation !== modelSelectionGeneration ||
        sessionStore.activeSessionId !== selectionSessionId ||
        attachments !== admissionAttachments
      )
        return;
      const imageCount =
        historicalImageCount +
        admissionAttachments.filter((attachment) => attachment.type === 'image').length;
      if (target && needsImageInputChoice(imageCount, target, hasImageOmitConsent(value))) {
        showModelPicker = false;
        imageFallbackWarning = {
          mode: 'model-switch',
          targetValue: value,
          targetLabel: target.label,
          imageCount,
        };
        return;
      }
      applyModelSelection(value);
    } finally {
      imageAdmissionPending = false;
    }
  }

  function openModelPicker(visionOnly = false) {
    modelPickerVisionOnly = visionOnly;
    showModelPicker = true;
    modelSearchQuery = '';
    if (selectedModel) {
      const provider =
        parseProviderModelSelection(selectedModel, providerNames).provider ?? currentProvider;
      expandedProviders = new Set(provider ? [provider] : []);
    } else if (groupedModels.length === 1) {
      expandedProviders = new Set([groupedModels[0].provider]);
    } else {
      expandedProviders = new Set();
    }
  }

  function toggleProvider(provider: string) {
    if (isSearchingModels) return;
    const next = new Set(expandedProviders);
    if (next.has(provider)) {
      next.delete(provider);
    } else {
      next.add(provider);
    }
    expandedProviders = next;
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
    if (w) await selectModel(w.value);
  }

  function selectReasoning(value: string) {
    if (value !== reasoningLevel) {
      warnWarmCacheBreak(
        `Changing reasoning to ${reasoningLabel(value)}`,
        findModelDef(currentProvider, currentModel),
        true,
      );
    }
    reasoningLevel = value;
    showReasoningMenu = false;
  }

  function reasoningLabel(value: string): string {
    const config = effectiveReasoningConfig(currentProvider, currentModel);
    if (config) {
      const opt = config.options.find((o) => o.value === value);
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
    const modelDef = findModelDef(currentProvider, modelId);
    if (modelDef?.name) return modelDef.name;
    return modelId
      .split('-')
      .map((word: string) => word.charAt(0).toUpperCase() + word.slice(1))
      .join(' ');
  });

  function handleClickOutside(e: MouseEvent) {
    const target = e.target as HTMLElement;
    if (!target.closest('.model-picker')) showModelPicker = false;
    if (!target.closest('.reasoning-picker')) showReasoningMenu = false;
    if (!target.closest('.reference-picker')) showReferenceMenu = false;
    if (!target.closest('.permission-picker')) showPermissionMenu = false;
    if (!target.closest('.agent-mode-picker')) showAgentModeMenu = false;
  }

  let canSend = $derived(
    !disabled && !imageAdmissionPending && (value.trim().length > 0 || attachments.length > 0),
  );

  // Dropdown, not a blind cycle button — all three modes stay visible and
  // pickable without clicking through the others.
  let showAgentModeMenu = $state(false);

  const AGENT_MODE_OPTIONS = [
    { value: 'auto', label: 'Auto', description: 'Kory decides per task', icon: Sparkles },
    {
      value: 'single',
      label: 'Single Agent',
      description: 'One agent handles everything',
      icon: User,
    },
    {
      value: 'multi',
      label: 'Multi-Agent',
      description: 'Enforce workers and parallelize when useful',
      icon: Users,
    },
  ] as const;

  function setAgentExecutionMode(next: 'auto' | 'single' | 'multi') {
    showAgentModeMenu = false;
    if (effectiveAgentExecutionMode === next) return;
    setChatAgentOverrides({ agentExecutionMode: next });
  }

  let effectiveAgentExecutionMode = $derived(
    chatAgentOverrides.agentExecutionMode ??
      agentSettingsStore.settings.agentExecutionMode ??
      'auto',
  );
  let effectiveCriticGateEnabled = $derived(
    chatAgentOverrides.criticGateEnabled ?? agentSettingsStore.settings.criticGateEnabled,
  );

  let agentExecutionModeMeta = $derived.by(() => {
    const mode = effectiveAgentExecutionMode;
    if (mode === 'multi') {
      return {
        label: 'Multi-Agent',
        title: 'Agent Mode: Multi-Agent',
        icon: Users,
        className:
          'bg-[var(--color-info-bg)] text-[var(--color-info)] border border-[var(--color-info)]/30',
      };
    }
    if (mode === 'single') {
      return {
        label: 'Single Agent',
        title: 'Agent Mode: Single Agent',
        icon: User,
        className:
          'bg-[var(--color-surface-3)] text-[var(--color-text-secondary)] border border-[var(--color-border)] hover:brightness-110',
      };
    }
    return {
      label: 'Auto',
      title: 'Agent Mode: Auto',
      icon: Sparkles,
      className:
        'bg-[var(--color-success-bg)] text-[var(--color-success)] border border-[var(--color-success)]/25 hover:brightness-110',
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
      const path = (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name;
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
      } catch (err: unknown) {
        console.debug(
          'Tauri file dialog failed:',
          err instanceof Error ? err.message : String(err),
        );
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
      } catch (err: unknown) {
        console.debug(
          'Tauri folder dialog failed:',
          err instanceof Error ? err.message : String(err),
        );
        // Fall through to browser picker
      }
    }
    referenceFolderInputRef?.click();
  }

  function removeAttachment(index: number) {
    if (imageAdmissionPending) return;
    if (previewAttachment === attachments[index]) {
      previewAttachment = null;
      previewTriggerRef = null;
    }
    attachments = attachments.filter((_, i) => i !== index);
  }

  function openAttachmentPreview(attachment: Attachment, trigger: HTMLButtonElement) {
    previewTriggerRef = trigger;
    previewAttachment = attachment;
  }

  function closeAttachmentPreview() {
    previewAttachment = null;
    const trigger = previewTriggerRef;
    previewTriggerRef = null;
    requestAnimationFrame(() => trigger?.focus());
  }

  function imageExtension(mimeType: string): string {
    if (mimeType === 'image/jpeg') return 'jpg';
    if (mimeType === 'image/gif') return 'gif';
    if (mimeType === 'image/webp') return 'webp';
    if (mimeType === 'image/avif') return 'avif';
    return 'png';
  }

  function readClipboardBlob(blob: Blob, name?: string): Promise<Attachment> {
    const mimeType = blob.type.startsWith('image/') ? blob.type : 'image/png';
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onerror = () => reject(reader.error ?? new Error('Could not read clipboard image'));
      reader.onload = () => {
        const loaded = typeof reader.result === 'string' ? reader.result : '';
        const comma = loaded.indexOf(',');
        if (comma < 0 || comma === loaded.length - 1) {
          reject(new Error('Clipboard image was empty'));
          return;
        }
        resolve({
          type: 'image',
          data: loaded.slice(comma + 1),
          name: name || `clipboard-image.${imageExtension(mimeType)}`,
          mimeType,
        });
      };
      reader.readAsDataURL(blob);
    });
  }

  function addClipboardBlob(blob: Blob, name?: string): Promise<void> {
    let pending: Promise<void>;
    pending = readClipboardBlob(blob, name)
      .then((attachment) => {
        attachments = [...attachments, attachment];
      })
      .catch((error) => {
        toastStore.error(error instanceof Error ? error.message : 'Could not read clipboard image');
      })
      .finally(() => pendingAttachmentReads.delete(pending));
    pendingAttachmentReads.add(pending);
    return pending;
  }

  async function addTauriClipboardImage() {
    const { readImage } = await import('@tauri-apps/plugin-clipboard-manager');
    const image = await readImage();
    const [{ width, height }, rgba] = await Promise.all([image.size(), image.rgba()]);
    if (!width || !height || rgba.length !== width * height * 4) {
      throw new Error('Clipboard returned an invalid image');
    }

    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('Could not prepare clipboard image');
    context.putImageData(new ImageData(new Uint8ClampedArray(rgba), width, height), 0, 0);
    const blob = await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob(
        (encoded) =>
          encoded ? resolve(encoded) : reject(new Error('Could not encode clipboard image')),
        'image/png',
      );
    });
    await addClipboardBlob(blob, 'clipboard-image.png');
  }

  /** Force-paste image from OS clipboard (bypasses text). Used by Ctrl+Shift+V and the paste-image button. */
  async function pasteImageFromClipboard() {
    if (isReadingClipboard || imageAdmissionPending) return;
    isReadingClipboard = true;
    try {
      // Prefer the browser API when available. It preserves the original image format.
      try {
        if (navigator.clipboard?.read) {
          const clipboardItems = await navigator.clipboard.read();
          for (const item of clipboardItems) {
            const type = item.types.find((candidate) => candidate.startsWith('image/'));
            if (type) {
              await addClipboardBlob(await item.getType(type));
              return;
            }
          }
        }
      } catch (err: unknown) {
        console.debug(
          'Clipboard read blocked or unavailable:',
          err instanceof Error ? err.message : String(err),
        );
        // Browser clipboard access is commonly blocked in a webview; use the native API below.
      }

      // Native clipboard handles screenshots and images copied outside the webview.
      if (typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window) {
        try {
          await addTauriClipboardImage();
          return;
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          if (
            !message.toLowerCase().includes('clipboard') &&
            !message.toLowerCase().includes('image')
          ) {
            toastStore.error(`Clipboard error: ${message}`);
            return;
          }
        }
      }

      toastStore.error('No image found in clipboard');
    } finally {
      isReadingClipboard = false;
    }
  }

  // Track whether we already handled this paste event (prevents double-fire
  // from the container + textarea both seeing the same bubbling event).
  let lastPasteEvent: ClipboardEvent | null = null;

  function clipboardImageFiles(data: DataTransfer | null): File[] {
    if (!data) return [];
    const files: File[] = [];
    const seen = new Set<File>();
    for (const item of Array.from(data.items ?? [])) {
      if (!item.type.startsWith('image/')) continue;
      const file = item.getAsFile();
      if (file && !seen.has(file)) {
        seen.add(file);
        files.push(file);
      }
    }
    // WebKitGTK can expose screenshot clipboard data only through files.
    for (const file of Array.from(data.files ?? [])) {
      if (file.type.startsWith('image/') && !seen.has(file)) {
        seen.add(file);
        files.push(file);
      }
    }
    return files;
  }

  /** Preserve rich text before considering image-only clipboard contents. */
  function handlePaste(e: ClipboardEvent) {
    if (imageAdmissionPending) {
      e.preventDefault();
      return;
    }
    // If this exact event was already handled (container + textarea both fire), skip.
    if (lastPasteEvent === e) return;
    lastPasteEvent = e;

    const converted = e.clipboardData ? clipboardMarkdown(e.clipboardData) : null;
    if (converted !== null && inputRef) {
      e.preventDefault();
      inputRef.focus();
      // insertText preserves browser undo history. Unsupported webviews use a
      // selection-aware fallback instead of replacing the entire draft.
      let inserted = false;
      try {
        inserted = document.execCommand('insertText', false, converted);
      } catch {
        /* fallback below */
      }
      if (inserted) {
        value = inputRef.value;
      } else {
        const start = inputRef.selectionStart;
        const end = inputRef.selectionEnd;
        value = value.slice(0, start) + converted + value.slice(end);
        void tick().then(() =>
          inputRef?.setSelectionRange(start + converted.length, start + converted.length),
        );
      }
      void tick().then(autoResize);
      return;
    }

    // A copied document may also offer an image representation. If its rich
    // structure cannot be recovered, preserve text rather than attach a bitmap.
    if (e.clipboardData?.getData('text/plain')) return;
    const imageFiles = clipboardImageFiles(e.clipboardData);
    if (imageFiles.length > 0) {
      e.preventDefault();
      for (const file of imageFiles) void addClipboardBlob(file, file.name || undefined);
      requestAnimationFrame(() => {
        lastPasteEvent = null;
      });
      return;
    }

    const hasText = Array.from(e.clipboardData?.types ?? []).some((type) =>
      type.startsWith('text/'),
    );
    if (!hasText && typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window) {
      // Some WebKitGTK builds omit images from the paste event. Fall back to
      // the Tauri clipboard path for ordinary Ctrl+V as well.
      e.preventDefault();
      void pasteImageFromClipboard();
    }
    // Preserve the textarea's native text paste, selection, input, and undo.

    // Clear the guard after a tick so a new paste works
    requestAnimationFrame(() => {
      lastPasteEvent = null;
    });
  }
</script>

<svelte:window onclick={handleClickOutside} />

<div class="command-input px-4 py-3" onpaste={handlePaste}>
  <!-- No project: show error -->
  {#if disabled}
    <div
      class="mb-2 px-3 py-2 rounded-md text-sm flex items-center gap-2"
      style="background: var(--color-warning-bg); border: 1px solid color-mix(in srgb, var(--color-warning) 35%, var(--color-border)); color: var(--color-text-primary);"
    >
      <span class="text-[var(--color-warning)]">⚠</span>
      <span>{disabledMessage}</span>
    </div>
  {/if}

  <!-- No provider: show blocking setup state -->
  {#if !disabled && configurationWarning}
    <div
      class="mb-2 flex flex-wrap items-center justify-between gap-2 px-3 py-2 rounded-md"
      style="background: var(--color-error-bg); border: 1px solid color-mix(in srgb, var(--color-error) 35%, var(--color-border)); color: var(--color-text-primary);"
    >
      <div class="flex-1 min-w-48">
        <span class="text-xs" style="color: var(--color-text-secondary);"
          >{configurationWarning}</span
        >
      </div>
      <button
        type="button"
        class="shrink-0 rounded px-2 py-1 text-xs text-[var(--color-text-primary)] hover:bg-[var(--color-surface-3)] focus-visible:outline focus-visible:outline-[var(--color-accent)]"
        onclick={() => onOpenSettings?.()}
      >
        Open Settings
      </button>
    </div>
  {/if}

  <div
    class="rounded-xl border px-4 py-3"
    style="background: var(--color-surface-1); border-color: var(--color-border);"
  >
    <!-- Controls row: Model picker + Reasoning toggle -->
    <div class="mb-2 flex flex-wrap items-center gap-2">
      <!-- Model selector -->
      <div class="relative model-picker">
        <button
          type="button"
          class="flex min-h-9 items-center gap-2 rounded-lg px-3 text-sm font-medium transition-colors hover:brightness-110"
          aria-expanded={showModelPicker}
          style="background: var(--color-surface-2); color: {selectedModel
            ? 'var(--color-text-primary)'
            : 'var(--color-text-muted)'}; border: 1px solid var(--color-border);"
          onclick={() => {
            if (showModelPicker) {
              showModelPicker = false;
            } else {
              openModelPicker();
            }
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
            {#if modelPickerVisionOnly}
              <div
                class="border-b border-[var(--color-border)] bg-[var(--color-accent)]/8 px-3 py-2 text-xs text-[var(--color-text-secondary)]"
              >
                Showing models with verified image input
              </div>
            {/if}
            <div class="relative border-b p-2.5" style="border-color: var(--color-border);">
              <Search
                class="pointer-events-none absolute left-5 top-1/2 -translate-y-1/2"
                size={15}
                style="color: var(--color-text-muted);"
              />
              <input
                type="search"
                bind:value={modelSearchQuery}
                aria-label="Search quick models"
                placeholder="Search models…"
                class="w-full rounded-lg border bg-[var(--color-surface-1)] py-2 pr-3 text-sm text-[var(--color-text-primary)] outline-none placeholder:text-[var(--color-text-muted)] focus:border-[var(--color-accent)]"
                style="border-color: var(--color-border); padding-left: 2.25rem;"
              />
            </div>
            <div class="max-h-72 overflow-y-auto">
              {#if availableModels.length === 0}
                <div
                  class="px-4 py-4 text-xs leading-relaxed"
                  style="color: var(--color-text-muted);"
                >
                  <div class="font-semibold mb-1" style="color: var(--color-text-secondary);">
                    No provider connected
                  </div>
                  <div class="mb-3">
                    Open Settings → Providers and connect one to choose a model.
                  </div>
                  {#if onOpenSettings}
                    <button
                      type="button"
                      class="text-[var(--color-accent)] hover:underline"
                      onclick={() => {
                        showModelPicker = false;
                        onOpenSettings();
                      }}
                    >
                      Open Settings →
                    </button>
                  {/if}
                </div>
              {:else if filteredQuickModels.length === 0}
                <div class="px-4 py-5 text-center text-xs" style="color: var(--color-text-muted);">
                  {#if modelPickerVisionOnly && !modelSearchQuery.trim()}
                    No enabled models report verified image input.
                  {:else}
                    No models match “{modelSearchQuery}”.
                  {/if}
                </div>
              {:else}
                <div class="py-1">
                  {#each groupedModels as group (group.provider)}
                    <div>
                      <button
                        type="button"
                        class="w-full flex items-center justify-between gap-2 px-3 py-2.5 text-left transition-colors hover:bg-[var(--color-surface-3)] {selectedModel?.startsWith(
                          `${group.provider}:`,
                        )
                          ? 'bg-[var(--color-surface-3)]/50'
                          : ''}"
                        style="color: var(--color-text-primary);"
                        onclick={() => toggleProvider(group.provider)}
                        aria-expanded={isSearchingModels || expandedProviders.has(group.provider)}
                      >
                        <div class="flex items-center gap-2 min-w-0">
                          <ProviderIcon provider={group.provider} size={16} class="shrink-0" />
                          <span class="text-sm font-medium truncate">{group.label}</span>
                          <span class="text-xs text-[var(--color-text-muted)]"
                            >({group.models.length})</span
                          >
                        </div>
                        <span class="shrink-0 text-[var(--color-text-muted)]">
                          {#if isSearchingModels || expandedProviders.has(group.provider)}
                            <ChevronDown size={14} />
                          {:else}
                            <ChevronRight size={14} />
                          {/if}
                        </span>
                      </button>
                      {#if isSearchingModels || expandedProviders.has(group.provider)}
                        <div class="pb-1">
                          {#each group.models as model (model.value)}
                            <button
                              type="button"
                              class="w-full text-left pl-10 pr-4 py-2 text-sm transition-colors hover:bg-[var(--color-surface-3)] flex items-center gap-2 {selectedModel ===
                              model.value
                                ? 'text-[var(--color-accent)]'
                                : ''}"
                              style="color: {selectedModel === model.value
                                ? 'var(--color-accent)'
                                : 'var(--color-text-secondary)'};"
                              onclick={() => selectModel(model.value)}
                            >
                              <span class="flex-1 min-w-0 truncate">{model.name}</span>
                              {#if selectedModel === model.value}
                                <Check size={14} class="shrink-0" />
                              {/if}
                            </button>
                          {/each}
                        </div>
                      {/if}
                    </div>
                  {/each}
                </div>
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
            class="flex min-h-9 items-center gap-2 rounded-lg px-3 text-sm font-medium transition-colors hover:brightness-110"
            aria-expanded={showReasoningMenu}
            style="background: var(--color-surface-2); color: {reasoningIsValid
              ? 'var(--color-text-primary)'
              : 'var(--color-text-muted)'}; border: 1px solid var(--color-border);"
            onclick={() => (showReasoningMenu = !showReasoningMenu)}
            title={reasoningIsValid ? 'Set auto effort' : 'Choose reasoning effort for this model'}
          >
            <BrainIcon
              reasoningLevel={reasoningIsValid ? reasoningLevel : ''}
              size={20}
              class="text-[var(--color-accent)]"
            />
            <span>{reasoningIsValid ? reasoningLabel(reasoningLevel) : 'Choose reasoning'}</span>
            <ChevronDown size={14} class="text-text-muted" />
          </button>

          {#if showReasoningMenu}
            <div
              class="absolute bottom-full left-0 mb-2 w-72 rounded-xl border shadow-2xl z-50 overflow-hidden backdrop-blur-md"
              style="background: var(--color-surface-2); border-color: var(--color-border);"
            >
              <div
                class="px-4 py-2.5 text-xs font-medium"
                style="color: var(--color-text-secondary); border-bottom: 1px solid var(--color-border);"
              >
                {`${modelDisplayName} · ${reasoningIsValid ? reasoningLabel(reasoningLevel) : 'Choose reasoning'}`}
              </div>
              <div class="py-1">
                {#each reasoningConfig.options as opt}
                  <button
                    type="button"
                    class="w-full text-left px-4 py-3 transition-all hover:bg-[var(--color-surface-3)] group"
                    onclick={() => selectReasoning(opt.value)}
                  >
                    <div class="flex items-center justify-between mb-0.5">
                      <span
                        class="text-sm font-semibold {reasoningLevel === opt.value
                          ? 'text-[var(--color-accent)]'
                          : 'text-[var(--color-text-primary)]'}"
                      >
                        {opt.label}
                      </span>
                      {#if reasoningLevel === opt.value}
                        <div
                          class="w-1.5 h-1.5 rounded-full bg-[var(--color-accent)] shadow-[0_0_8px_var(--color-accent)]"
                        ></div>
                      {/if}
                    </div>
                    <div class="text-xs leading-relaxed" style="color: var(--color-text-muted);">
                      {opt.description}
                    </div>
                  </button>
                {/each}
              </div>
            </div>
          {/if}
        </div>
      {/if}

      {#if fastModeSupported}
        <button
          type="button"
          class="flex min-h-9 items-center gap-2 rounded-lg px-3 text-sm font-medium transition-colors hover:brightness-110"
          style="background: {fastMode
            ? 'color-mix(in srgb, var(--color-accent) 22%, var(--color-surface-3))'
            : 'var(--color-surface-3)'}; color: {fastMode
            ? 'var(--color-accent)'
            : 'var(--color-text-primary)'}; border: 1px solid {fastMode
            ? 'color-mix(in srgb, var(--color-accent) 65%, var(--color-border))'
            : 'var(--color-border)'};"
          onclick={() => (fastMode = !fastMode)}
          aria-pressed={fastMode}
          title={fastModeHint}
        >
          <Zap size={17} fill={fastMode ? 'currentColor' : 'none'} />
          <span>{fastModeLabel}</span>
        </button>
      {/if}

      <button
        type="button"
        class="flex min-h-9 items-center gap-2 rounded-lg border px-3 text-sm font-medium transition-colors hover:brightness-110 {isGuidedDemo
          ? 'border-[var(--color-border)] bg-[var(--color-surface-3)] text-[var(--color-text-secondary)]'
          : interactionMode === 'plan'
            ? 'border-[var(--color-info)]/40 bg-[var(--color-info-bg)] text-[var(--color-info)]'
            : 'border-[var(--color-border)] bg-[var(--color-surface-3)] text-[var(--color-text-primary)]'}"
        aria-pressed={!isGuidedDemo && interactionMode === 'plan'}
        aria-disabled={isGuidedDemo}
        onclick={() =>
          isGuidedDemo
            ? toastStore.info('Not available in this demo')
            : onInteractionModeChange?.(interactionMode === 'plan' ? 'act' : 'plan')}
        title={isGuidedDemo
          ? 'Not available in this demo'
          : 'Plan mode keeps project files unchanged and preserves a planning note between restarts'}
      >
        <ClipboardList size={17} />
        <span
          >{isGuidedDemo
            ? 'Not available in this demo'
            : interactionMode === 'plan'
              ? 'Planning'
              : 'Plan'}</span
        >
      </button>

      <div class="permission-picker relative">
        <button
          type="button"
          class="flex min-h-9 items-center gap-2 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-2)] px-3 text-sm font-medium text-[var(--color-text-primary)] transition-colors hover:brightness-110"
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
            class="absolute bottom-full left-0 z-50 mb-2 w-80 overflow-hidden rounded-xl border shadow-2xl"
            style="background: var(--color-surface-2); border-color: var(--color-border);"
            role="menu"
            aria-label="Permission mode"
          >
            <div
              class="flex items-center justify-between gap-3 border-b border-[var(--color-border)] px-4 py-3"
            >
              <span class="text-xs font-medium text-[var(--color-text-secondary)]">Permissions</span
              >
              <button
                type="button"
                class="flex items-center gap-1 rounded-md px-1.5 py-1 text-[11px] text-[var(--color-text-secondary)] transition-colors hover:bg-[var(--color-surface-3)]"
                onclick={() => {
                  showPermissionMenu = false;
                  onOpenSettings?.('agent', 'permissions');
                }}
                title="Open permission settings"><Settings size={13} /> Settings</button
              >
            </div>
            <div class="py-1">
              {#each PERMISSION_OPTIONS as option (option.value)}
                {@const active = permissionMode === option.value}
                <button
                  type="button"
                  role="menuitemradio"
                  aria-checked={active}
                  class="flex w-full items-start gap-3 px-4 py-2.5 text-left transition-colors hover:bg-[var(--color-surface-3)]"
                  onclick={() => selectPermissionMode(option.value)}
                >
                  <option.icon size={16} class="mt-0.5 shrink-0 {option.tone}" />
                  <span class="min-w-0 flex-1">
                    <span
                      class="block text-sm font-semibold"
                      style="color: {active ? 'var(--color-accent)' : 'var(--color-text-primary)'};"
                      >{option.label}</span
                    >
                    <span class="block text-[11px] leading-relaxed text-[var(--color-text-muted)]"
                      >{option.description}</span
                    >
                  </span>
                  {#if active}<Check
                      size={14}
                      class="mt-1 shrink-0 text-[var(--color-accent)]"
                    />{/if}
                </button>
              {/each}
            </div>
          </div>
        {/if}
      </div>
    </div>

    {#if goalDisplayStore.composer && showGoalComposer}
      <div
        class="mb-3 rounded-xl border p-3"
        style="border-color: color-mix(in srgb, var(--color-accent) 35%, var(--color-border)); background: color-mix(in srgb, var(--color-accent) 6%, var(--color-surface-2));"
        role="group"
        aria-label="New goal"
      >
        <div class="flex items-center gap-2">
          <Target size={14} class="shrink-0 text-[var(--color-accent)]" />
          <span class="text-xs font-semibold text-[var(--color-text-primary)]">New goal</span>
          <button
            type="button"
            class="ml-auto rounded p-1 text-[var(--color-text-muted)] hover:bg-[var(--color-surface-3)] hover:text-[var(--color-text-primary)]"
            aria-label="Close goal composer"
            title="Close goal composer"
            onclick={() => (showGoalComposer = false)}><X size={13} /></button
          >
        </div>
        <div class="mt-2 flex gap-2">
          <input
            bind:this={goalComposerInput}
            aria-label="Goal objective"
            class="min-w-0 flex-1 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-1)] px-2.5 py-1.5 text-xs text-[var(--color-text-primary)] placeholder:text-[var(--color-text-muted)]"
            placeholder="What should Koryphaios finish?"
            bind:value={goalObjective}
            onkeydown={(event) => {
              if (event.key === 'Enter') void createGoal();
            }}
          />
          <button
            type="button"
            class="shrink-0 rounded-lg px-3 py-1.5 text-xs font-semibold transition-colors"
            style="background: var(--color-accent); color: var(--color-on-accent);"
            onclick={() => void createGoal()}
            aria-label={agentSettingsStore.settings.automaticGoalDriving
              ? 'Create and start goal'
              : 'Create goal'}
          >
            {agentSettingsStore.settings.automaticGoalDriving ? 'Create & start' : 'Create'}
          </button>
        </div>
        <div class="mt-2 flex flex-wrap items-center gap-2">
          <div class="min-w-0 flex-1 sm:max-w-56">
            <KorySelect
              compact
              value={goalScope}
              label="Goal scope"
              options={goalScopeOptions}
              onchange={(value) => (goalScope = value as GoalScope)}
            />
          </div>
          <p class="min-w-0 flex-1 text-[10px] text-[var(--color-text-muted)]">
            {agentSettingsStore.settings.automaticGoalDriving
              ? 'Starts automatically with the selected composer model and continues until done, paused, stopped, or genuinely blocked.'
              : 'Automatic start is off. The goal will wait until you press Start.'}
          </p>
        </div>
        {#if goalDraftRecovered}
          <p class="mt-1.5 text-[10px] text-[var(--color-success)]">
            Recovered unsent goal draft on this device.
          </p>
        {/if}
        {#if goalError}<p class="mt-1.5 text-xs text-[var(--color-error)]" role="alert">
            {goalError}
          </p>{/if}
      </div>
    {/if}

    <ChecklistPanel />
    <GoalMode />

    {#if workflowStatus}
      <button
        type="button"
        class="mb-3 flex w-full items-center gap-2 rounded-xl border px-3 py-2 text-left transition-colors hover:bg-[var(--color-surface-3)]"
        style="border-color: color-mix(in srgb, var(--color-info) 35%, var(--color-border)); background: color-mix(in srgb, var(--color-info) 7%, transparent);"
        onclick={() => onOpenWorkflows?.()}
        aria-label={`Open active workflow: ${workflowStatus.name}`}
      >
        <Workflow size={14} class="shrink-0 text-[var(--color-info)]" />
        <span class="min-w-0 flex-1"
          ><span class="block truncate text-xs font-semibold text-[var(--color-text-primary)]"
            >{workflowStatus.name} · {workflowStatus.stage}</span
          ><span class="block truncate text-[10px] text-[var(--color-text-muted)]"
            >{workflowStatus.status} · {workflowStatus.task}</span
          ></span
        >
      </button>
    {/if}

    <!-- Input area -->
    <div class="flex flex-col gap-3 xl:flex-row xl:items-end">
      <div class="min-w-0 flex-1">
        {#if pickerOpen}
          <div
            class="mb-3 overflow-hidden rounded-xl border"
            style="background: var(--color-surface-2); border-color: var(--color-border);"
          >
            <div
              class="px-3 py-2 text-xs font-medium"
              style="color: var(--color-text-muted); border-bottom: 1px solid var(--color-border);"
            >
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
                    class="flex w-full items-start justify-between gap-3 px-3 py-2 text-left transition-colors {index ===
                    selectedPickerIndex
                      ? 'bg-[var(--color-surface-3)]'
                      : 'hover:bg-[var(--color-surface-3)]'}"
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
                    <div class="shrink-0 text-xs" style="color: var(--color-text-muted);">
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
            {#each attachments as attachment, i}
              <div
                class="relative group rounded-lg overflow-hidden border"
                style="border-color: var(--color-border); width: 64px; height: 64px;"
              >
                {#if attachment.type === 'image'}
                  <button
                    type="button"
                    class="block h-full w-full cursor-zoom-in overflow-hidden bg-[var(--color-surface-2)] outline-none transition-all hover:brightness-110 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--color-accent)]"
                    aria-label={`Open ${attachment.name} preview`}
                    aria-haspopup="dialog"
                    onclick={(event) => openAttachmentPreview(attachment, event.currentTarget)}
                  >
                    <img
                      src={`data:${attachment.mimeType ?? 'image/png'};base64,${attachment.data}`}
                      alt={attachment.name}
                      class="h-full w-full object-cover transition-transform duration-200 group-hover:scale-105"
                    />
                  </button>
                {/if}
                <button
                  type="button"
                  class="absolute right-1 top-1 rounded-full bg-black/70 p-0.5 text-white opacity-0 shadow-md transition-opacity hover:bg-black/90 focus:opacity-100 group-hover:opacity-100"
                  onclick={() => removeAttachment(i)}
                  aria-label={`Remove ${attachment.name}`}
                  disabled={imageAdmissionPending}
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
            bind:value
            oninput={autoResize}
            onkeydown={handleKeydown}
            onpaste={handlePaste}
            placeholder={disabled
              ? disabledMessage
              : imageAdmissionPending
                ? 'Checking image input…'
                : placeholder}
            rows="1"
            class="input w-full"
            data-testid="composer-input"
            disabled={disabled || imageAdmissionPending}
            style="resize: none; min-height: {minHeightPx}px; max-height: 280px; font-size: 15px; line-height: 1.6; box-sizing: border-box; padding: 10px 88px 10px 12px; background: transparent; border: none; box-shadow: none; {disabled ||
            imageAdmissionPending
              ? 'opacity: 0.6; cursor: not-allowed;'
              : ''}"
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
                onclick={() => (showGoalActions = !showGoalActions)}
                disabled={disabled || imageAdmissionPending || !!configurationWarning}
                aria-label="More composer actions"
                title="More actions"><Plus size={16} /></button
              >
              {#if showGoalActions}
                <div
                  class="absolute bottom-full right-0 mb-1 w-48 rounded-lg border shadow-xl z-50 overflow-hidden"
                  style="background: var(--color-surface-2); border-color: var(--color-border);"
                >
                  {#if goalDisplayStore.composer}<button
                      type="button"
                      class="flex w-full items-center gap-2 px-3 py-2 text-left text-xs hover:bg-[var(--color-surface-3)]"
                      style="color: var(--color-text-primary);"
                      onclick={() => {
                        showGoalActions = false;
                        queueMicrotask(() =>
                          window.dispatchEvent(
                            new CustomEvent('kory:goal-action', { detail: 'goal_create' }),
                          ),
                        );
                      }}><Target size={14} /> Create verified goal</button
                    >
                    <button
                      type="button"
                      class="flex w-full items-center gap-2 px-3 py-2 text-left text-xs hover:bg-[var(--color-surface-3)]"
                      style="color: var(--color-text-primary);"
                      onclick={() => {
                        showGoalActions = false;
                        onOpenSettings?.('advanced');
                      }}><Settings size={14} /> Goal settings</button
                    >{/if}
                  <button
                    type="button"
                    class="flex w-full items-center gap-2 px-3 py-2 text-left text-xs hover:bg-[var(--color-surface-3)]"
                    style="color: var(--color-text-primary);"
                    onclick={() => {
                      showGoalActions = false;
                      onOpenWorkflows?.();
                    }}><Workflow size={14} /> Attach workflow</button
                  >
                </div>
              {/if}
            </div>
            <div class="relative">
              <button
                type="button"
                class="flex items-center justify-center w-8 h-8 rounded-lg transition-colors hover:bg-[var(--color-surface-3)] disabled:opacity-40 disabled:cursor-not-allowed"
                style="color: var(--color-text-muted);"
                onclick={() => (showReferenceMenu = !showReferenceMenu)}
                disabled={disabled || imageAdmissionPending || !!configurationWarning}
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
              onclick={() => void pasteImageFromClipboard()}
              disabled={disabled ||
                imageAdmissionPending ||
                !!configurationWarning ||
                isReadingClipboard}
              aria-label={isReadingClipboard
                ? 'Reading image from clipboard'
                : 'Paste image from clipboard'}
              title="Paste image from clipboard (Ctrl+Shift+V)"
            >
              <Clipboard size={16} />
            </button>
            {#if composerMicrophoneEnabled}
              <button
                type="button"
                class="flex h-8 w-8 items-center justify-center rounded-lg transition-all hover:bg-[var(--color-surface-3)] disabled:cursor-not-allowed disabled:opacity-40 {isRecording
                  ? 'bg-[var(--color-error-bg)] text-[var(--color-error)] shadow-[inset_0_0_0_1px_color-mix(in_srgb,var(--color-error)_36%,transparent)]'
                  : 'text-[var(--color-text-muted)]'}"
                onpointerdown={(event) => {
                  // Push to talk, matching the keyboard shortcut: hold the
                  // button to record, release to transcribe.
                  if (event.button !== 0) return;
                  event.preventDefault();
                  beginHoldToTalk();
                }}
                onpointerup={() => endHoldToTalk()}
                onpointerleave={() => endHoldToTalk()}
                onpointercancel={() => endHoldToTalk()}
                onkeydown={(event) => {
                  if (event.repeat) return;
                  if (event.key !== ' ' && event.key !== 'Enter') return;
                  event.preventDefault();
                  beginHoldToTalk();
                }}
                onkeyup={(event) => {
                  if (event.key !== ' ' && event.key !== 'Enter') return;
                  event.preventDefault();
                  endHoldToTalk();
                }}
                onblur={() => endHoldToTalk()}
                disabled={disabled ||
                  imageAdmissionPending ||
                  !!configurationWarning ||
                  isTranscribing}
                aria-pressed={isRecording}
                aria-label={isTranscribing
                  ? 'Transcribing recording'
                  : isRecording
                    ? 'Recording, release to transcribe'
                    : 'Hold to record a voice prompt'}
                title={isTranscribing
                  ? 'Transcribing…'
                  : isRecording
                    ? 'Release to transcribe'
                    : `Hold to record${voiceShortcutHint ? ` (${voiceShortcutHint})` : ''}`}
              >
                <Mic size={16} class={isRecording || isTranscribing ? 'animate-pulse' : ''} />
              </button>
            {/if}
          </div>
        </div>
      </div>
      <div class="w-full xl:w-auto xl:self-end">
        <div
          bind:this={actionPanelRef}
          class="flex flex-col gap-2 border-t pt-3 xl:min-w-[188px] xl:border-t-0 xl:border-l xl:pl-3 xl:pt-0"
          style="border-color: var(--color-border);"
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
                    {@const active = effectiveAgentExecutionMode === option.value}
                    <button
                      type="button"
                      role="menuitemradio"
                      aria-checked={active}
                      class="w-full flex items-start gap-2.5 px-3 py-2 text-left transition-colors hover:bg-[var(--color-surface-3)]"
                      onclick={() => setAgentExecutionMode(option.value)}
                    >
                      <option.icon
                        size={13}
                        class="mt-0.5 shrink-0"
                        style="color: {active ? 'var(--color-accent)' : 'var(--color-text-muted)'};"
                      />
                      <span class="min-w-0 flex-1">
                        <span
                          class="block text-[11px] font-medium"
                          style="color: {active
                            ? 'var(--color-accent)'
                            : 'var(--color-text-primary)'};">{option.label}</span
                        >
                        <span class="block text-[10px]" style="color: var(--color-text-muted);"
                          >{option.description}</span
                        >
                      </span>
                      {#if active}
                        <Check
                          size={12}
                          class="mt-0.5 shrink-0"
                          style="color: var(--color-accent);"
                        />
                      {/if}
                    </button>
                  {/each}
                </div>
              {/if}
            </div>

            <button
              type="button"
              class="flex items-center gap-1.5 text-[11px] font-medium px-2.5 py-1.5 rounded-md transition-colors {effectiveCriticGateEnabled
                ? 'bg-[var(--color-warning-bg)] text-[var(--color-warning)] border border-[var(--color-warning)]/30'
                : 'bg-[var(--color-surface-3)] text-[var(--color-text-muted)] border border-[var(--color-border)] hover:brightness-110'}"
              onclick={() =>
                setChatAgentOverrides({ criticGateEnabled: !effectiveCriticGateEnabled })}
              title="Toggle Critic Agent for this chat"
              aria-pressed={effectiveCriticGateEnabled}
            >
              {#if effectiveCriticGateEnabled}
                <ShieldCheck size={12} />
                <span>Critic: On</span>
              {:else}
                <ShieldAlert size={12} />
                <span>Critic: Off</span>
              {/if}
            </button>
          </div>
          {#if interactionMode === 'plan' && planReady}
            <button
              type="button"
              class="rounded-lg bg-[var(--color-accent)] px-3 py-2 text-xs font-semibold text-[var(--color-on-accent)] hover:opacity-90"
              onclick={() => onApprovePlan?.()}>Approve plan & implement</button
            >
          {/if}

          <button
            type="button"
            onclick={isRunning || isWaiting ? stop : send}
            disabled={disabled || imageAdmissionPending || (!isRunning && !isWaiting && !canSend)}
            class="btn flex w-full items-center justify-center gap-2 {isRunning
              ? 'stop-btn'
              : isWaiting
                ? 'waiting-btn'
                : 'btn-primary'}"
            style="height: 44px; padding: 0 16px; font-size: 14px; {disabled ||
            imageAdmissionPending ||
            (!isRunning && !isWaiting && !canSend)
              ? 'opacity: 0.5; cursor: not-allowed;'
              : ''}"
            aria-label={imageAdmissionPending
              ? 'Checking image input support'
              : isRunning
                ? 'Stop the running model'
                : isWaiting
                  ? 'Kory is waiting. Click to cancel'
                  : 'Send message'}
            title={imageAdmissionPending
              ? 'Checking active image context before sending'
              : isRunning
                ? 'Stop (Esc)'
                : isWaiting
                  ? waitingReason
                    ? `Waiting on ${waitingReason}. Click to cancel`
                    : 'Kory is waiting. Click to cancel'
                  : !canSend
                    ? 'Type a message to send'
                    : configurationWarning
                      ? 'Run a local command, or open Settings to configure a provider'
                      : 'Send (Enter)'}
          >
            {#if isRunning}
              <span class="stop-pulse" aria-hidden="true">
                <Square size={10} fill="currentColor" strokeWidth={0} />
              </span>
              <span>Stop</span>
            {:else if isWaiting}
              <span class="waiting-dots" aria-hidden="true"
                ><span></span><span></span><span></span></span
              >
              <span>Waiting{waitingReason ? ` · ${waitingReason}` : '…'}</span>
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
        Provider messages need setup. Local /commands remain available.
      {:else}
        Enter to send · Shift+Enter for new line · Ctrl+V paste text · Ctrl+Shift+V paste image
      {/if}
    </span>
    {#if value.length > 0}
      <span class="text-xs" style="color: var(--color-text-muted);">{value.length} chars</span>
    {/if}
  </div>
</div>

{#if imageFallbackWarning}
  <ImageInputFallbackDialog
    modelLabel={imageFallbackWarning.targetLabel}
    imageCount={imageFallbackWarning.imageCount}
    mode={imageFallbackWarning.mode}
    oncontinue={continueWithoutImageInput}
    onchoosemodel={chooseVisionModelFromWarning}
    oncancel={() => (imageFallbackWarning = null)}
  />
{/if}

{#if previewAttachment}
  <div
    class="fixed inset-0 z-[120] flex items-center justify-center bg-black/80 p-4 backdrop-blur-md sm:p-8"
    role="presentation"
    onmousedown={(event) => {
      if (event.target === event.currentTarget) closeAttachmentPreview();
    }}
  >
    <div
      bind:this={previewDialogRef}
      class="flex max-h-[calc(100vh-2rem)] max-w-[min(96vw,1440px)] flex-col overflow-hidden rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface-1)] shadow-2xl shadow-black/70 sm:max-h-[calc(100vh-4rem)]"
      role="dialog"
      aria-modal="true"
      aria-label={`Image preview: ${previewAttachment.name}`}
      tabindex="-1"
      onkeydown={(event) => {
        if (event.key === 'Escape') {
          event.preventDefault();
          closeAttachmentPreview();
        } else if (event.key === 'Tab') {
          event.preventDefault();
          previewDialogRef?.querySelector<HTMLButtonElement>('button')?.focus();
        }
      }}
    >
      <header
        class="flex min-h-12 items-center gap-3 border-b border-[var(--color-border)] bg-[var(--color-surface-2)] px-4 py-2.5"
      >
        <div class="min-w-0 flex-1">
          <p class="truncate text-sm font-medium text-[var(--color-text-primary)]">
            {previewAttachment.name}
          </p>
          <p class="text-xs text-[var(--color-text-muted)]">Image preview</p>
        </div>
        <span class="hidden text-[10px] text-[var(--color-text-muted)] sm:block">Esc to close</span>
        <button
          type="button"
          class="rounded-lg p-2 text-[var(--color-text-muted)] outline-none transition-colors hover:bg-[var(--color-surface-3)] hover:text-[var(--color-text-primary)] focus-visible:ring-2 focus-visible:ring-[var(--color-accent)]"
          aria-label="Close image preview"
          onclick={closeAttachmentPreview}
        >
          <X size={18} />
        </button>
      </header>
      <div
        class="flex min-h-0 flex-1 items-center justify-center overflow-auto bg-black/30 p-3 sm:p-5"
      >
        <img
          src={`data:${previewAttachment.mimeType ?? 'image/png'};base64,${previewAttachment.data}`}
          alt={previewAttachment.name}
          class="block max-h-[calc(100vh-8rem)] max-w-full rounded-lg object-contain shadow-2xl shadow-black/50"
        />
      </div>
    </div>
  </div>
{/if}

{#if overflowWarning}
  <div
    class="fixed inset-0 z-[95] flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm"
  >
    <div
      class="w-full max-w-md rounded-2xl border p-6 shadow-2xl"
      style="background: var(--color-surface-2); border-color: var(--color-border);"
      role="alertdialog"
      aria-label="Context too large for model"
    >
      <h3 class="text-base font-semibold mb-2" style="color: var(--color-text-primary);">
        Context won't fit
      </h3>
      <p class="text-sm mb-5 leading-relaxed" style="color: var(--color-text-secondary);">
        This session uses ~{formatContextSize(overflowWarning.used)} tokens, but
        <span class="font-medium" style="color: var(--color-text-primary);"
          >{overflowWarning.label}</span
        >
        has a ~{formatContextSize(overflowWarning.window)} window. Shrink the context first:
      </p>
      <div class="flex flex-col gap-2">
        <button
          type="button"
          class="w-full rounded-xl border px-4 py-2.5 text-sm font-medium text-left transition-colors hover:bg-[var(--color-surface-3)]"
          style="border-color: var(--color-border); color: var(--color-text-primary);"
          onclick={() => {
            overflowWarning = null;
            toastStore.info(
              'Hover tool outputs in the feed and use the agent-hide button to prune them.',
            );
          }}
        >
          Prune manually
          <span class="block text-xs mt-0.5" style="color: var(--color-text-muted);"
            >Hide bulky tool outputs from the agent yourself, then switch.</span
          >
        </button>
        <button
          type="button"
          class="w-full rounded-xl border px-4 py-2.5 text-sm font-medium text-left transition-colors hover:bg-[var(--color-surface-3)]"
          style="border-color: var(--color-border); color: var(--color-text-primary);"
          onclick={overflowAskAgentPrune}
        >
          Ask the agent to prune
          <span class="block text-xs mt-0.5" style="color: var(--color-text-muted);"
            >The current agent trims its own context below the new limit.</span
          >
        </button>
        <button
          type="button"
          class="w-full rounded-xl border px-4 py-2.5 text-sm font-medium text-left transition-colors hover:bg-[var(--color-surface-3)]"
          style="border-color: var(--color-border); color: var(--color-text-primary);"
          onclick={overflowCompact}
        >
          Compact the conversation
          <span class="block text-xs mt-0.5" style="color: var(--color-text-muted);"
            >The current large-window agent summarizes the session first.</span
          >
        </button>
        <button
          type="button"
          class="w-full rounded-xl border px-4 py-2.5 text-sm font-medium text-left transition-colors hover:bg-[var(--color-surface-3)]"
          style="border-color: var(--color-border); color: var(--color-text-primary);"
          onclick={overflowNewChat}
        >
          Start a new chat
          <span class="block text-xs mt-0.5" style="color: var(--color-text-muted);"
            >Fresh session on the new model.</span
          >
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
  /* Waiting is distinct from running, with a calm, theme-aware status tone. */
  :global(.waiting-btn) {
    background: var(--color-warning-bg);
    color: var(--color-warning);
    border: 1px solid color-mix(in srgb, var(--color-warning) 45%, transparent);
    animation: waiting-breathe 2.4s ease-in-out infinite;
  }
  @keyframes waiting-breathe {
    0%,
    100% {
      box-shadow: 0 0 0 0 transparent;
    }
    50% {
      box-shadow: 0 0 14px 0 color-mix(in srgb, var(--color-warning) 25%, transparent);
    }
  }
  .waiting-dots {
    display: inline-flex;
    gap: 3px;
  }
  .waiting-dots span {
    width: 5px;
    height: 5px;
    border-radius: 9999px;
    background: currentColor;
    animation: waiting-dot 1.2s ease-in-out infinite;
  }
  .waiting-dots span:nth-child(2) {
    animation-delay: 0.2s;
  }
  .waiting-dots span:nth-child(3) {
    animation-delay: 0.4s;
  }
  @keyframes waiting-dot {
    0%,
    60%,
    100% {
      opacity: 0.35;
      transform: translateY(0);
    }
    30% {
      opacity: 1;
      transform: translateY(-2px);
    }
  }

  /* Stop button — unmistakably "live, click to stop" with a pulsing ring. */
  :global(.stop-btn) {
    background: var(--color-error-bg);
    border: 1px solid color-mix(in srgb, var(--color-error) 45%, transparent);
    color: var(--color-error);
    font-weight: 600;
    transition:
      background 0.15s ease,
      border-color 0.15s ease,
      color 0.15s ease;
  }
  :global(.stop-btn:hover) {
    background: color-mix(in srgb, var(--color-error) 20%, var(--color-surface-1));
    border-color: var(--color-error);
    color: var(--color-error);
  }
  :global(.stop-pulse) {
    position: relative;
    display: flex;
    align-items: center;
    justify-content: center;
    width: 22px;
    height: 22px;
    border-radius: 50%;
    background: var(--color-error-bg);
    color: var(--color-error);
    flex-shrink: 0;
  }
  :global(.stop-pulse::after) {
    content: '';
    position: absolute;
    inset: 0;
    border-radius: 50%;
    border: 2px solid color-mix(in srgb, var(--color-error) 70%, transparent);
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
    :global(.stop-pulse::after),
    :global(.waiting-btn),
    .waiting-dots span {
      animation: none;
    }
  }
</style>
