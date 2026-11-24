<script lang="ts">
  import { onDestroy, onMount, tick, untrack } from 'svelte';
  import { clipboardMarkdown } from '$lib/utils/rich-paste';
  import Send from 'lucide-svelte/icons/send';
  import ChevronDown from 'lucide-svelte/icons/chevron-down';
  import ChevronRight from 'lucide-svelte/icons/chevron-right';
  import Sparkles from 'lucide-svelte/icons/sparkles';
  import { agentModeMetaFor } from '$lib/utils/agent-mode-meta';
  import Square from 'lucide-svelte/icons/square';
  import PauseCircle from 'lucide-svelte/icons/pause-circle';
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
  import ListChecks from 'lucide-svelte/icons/list-checks';
  import Zap from 'lucide-svelte/icons/zap';
  import Pencil from 'lucide-svelte/icons/pencil';
  import MessageCircleQuestion from 'lucide-svelte/icons/message-circle-question';
  import SlidersHorizontal from 'lucide-svelte/icons/sliders-horizontal';
  import Info from 'lucide-svelte/icons/info';
  import { wsStore } from '$lib/stores/websocket.svelte';
  import { shortcutStore } from '$lib/stores/shortcuts.svelte';
  import { formatChord, formatShortcut, isMac } from '$lib/utils/platform';
  import { mergeTranscript, sliceAudioChunks, transcriptWords } from '$lib/utils/voice-transcript';
  import { toolbarCollapse } from '$lib/utils/toolbar-density';
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
  import FreebuffBalance from './FreebuffBalance.svelte';
  import ImageInputFallbackDialog from './ImageInputFallbackDialog.svelte';
  import SettingsSwitch from './SettingsSwitch.svelte';
  import ConfirmDialog from './ConfirmDialog.svelte';
  import {
    forgetTrustedImageModel,
    hasTrustedImageModel,
    modelHasVerifiedImageInput,
    needsImageInputChoice,
    readRememberedImageInputMode,
    rememberImageInputMode,
    rememberTrustedImageModel,
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
  import { checklistStore } from '$lib/stores/checklists.svelte';
  import GitWorkspaceControl from './GitWorkspaceControl.svelte';
  import {
    clearComposerDraft,
    loadComposerDraft,
    loadComposerDraftAttachments,
    saveComposerDraft,
    type ComposerDraftAttachment,
  } from '$lib/stores/composer-drafts';
  import {
    initialFusionSelection,
    initialSpeedTier,
    initialModelParameters,
    loadComposerPreference,
    saveComposerPreference,
  } from '$lib/stores/composer-preferences';
  import type {
    FreebuffAccountSnapshot,
    FusionCatalog,
    FusionSelection,
    ModelSpeedTier,
    ModelParameterDef,
    ModelParameterKey,
    ModelParameterValues,
    SessionAgentOverrides,
  } from '@koryphaios/shared';
  import {
    adjustFusionSelection,
    availableSidekicks,
    fusionPairingKey,
    fusionSidekickSpeedLabel,
    isFusionPairingAvailable,
    leadFastAvailable,
    parseFusionSlug,
    sanitizeModelParameterValues,
  } from '@koryphaios/shared';
  import {
    clearComposerApprovalState,
    composerApprovalDefaults,
    loadComposerSessionState,
    saveComposerSessionState,
  } from '$lib/stores/composer-session-state';
  import KorySelect from './KorySelect.svelte';
  import KorySlider from './KorySlider.svelte';
  import NumberStepper from './NumberStepper.svelte';
  import CriticModeSelect from './CriticModeSelect.svelte';
  import { CRITIC_MODE_OPTIONS, resolveCriticMode, type CriticMode } from '@koryphaios/shared';
  import { providerPermissionEnforcement } from '@koryphaios/shared';
  import { runStateStore } from '$lib/stores/run-state.svelte';
  import MediaAttachment from './MediaAttachment.svelte';
  import { createVoiceTap, type VoiceTap } from '$lib/utils/voice-tap';
  import { voiceRecorder } from '$lib/stores/voice-recorder.svelte';
  import { voiceConductor } from '$lib/voice-conductor/conductor.svelte';
  import type { CaptureMode, DictationRouter } from '$lib/voice-conductor/router';
  import { chatMediaKind, chatMediaMimeType, MAX_CHAT_MEDIA_BYTES } from '@koryphaios/shared';
  import { loadLocalFormDraft, saveLocalFormDraft } from '$lib/utils/local-form-drafts';
  import { estimateCacheBreakImpact, formatCompactTokens } from '$lib/utils/cache-break-impact';
  import { freebuffBaseRate, freebuffRateMultiplier } from '$lib/utils/freebuff-pricing';

  export type Attachment = {
    type: 'image' | 'file';
    data: string;
    name: string;
    mimeType?: string;
  };

  let mediaFileInputRef: HTMLInputElement;
  let mediaReadQueue = Promise.resolve();

  async function addMediaFiles(files: File[]) {
    const sessionId = sessionStore.activeSessionId;
    const draft = draftKey;
    for (const file of files) {
      const mimeType = chatMediaMimeType(file.name, file.type);
      const kind = chatMediaKind(mimeType);
      if (!kind) {
        toastStore.error(`Unsupported media file: ${file.name}`);
        continue;
      }
      if (!file.size) {
        toastStore.error(`The media file is empty: ${file.name}`);
        continue;
      }
      const existingBytes = attachments.reduce(
        (sum, attachment) => sum + Math.ceil((attachment.data.length * 3) / 4),
        0,
      );
      if (existingBytes + file.size > MAX_CHAT_MEDIA_BYTES) {
        toastStore.error('Chat media attachments must total 15 MB or less. Choose a smaller clip.');
        continue;
      }
      try {
        const data = await blobBase64(file);
        if (sessionStore.activeSessionId !== sessionId || draftKey !== draft) return;
        attachments = [
          ...attachments,
          { type: kind === 'image' ? 'image' : 'file', data, name: file.name, mimeType },
        ];
      } catch (error) {
        toastStore.error(error instanceof Error ? error.message : `Could not read ${file.name}`);
      }
    }
  }

  function queueMediaFiles(files: File[]) {
    if (disabled || imageAdmissionPending) return;
    let pending: Promise<void>;
    const sessionId = sessionStore.activeSessionId;
    const draft = draftKey;
    pending = mediaReadQueue
      .then(() => {
        if (sessionStore.activeSessionId !== sessionId || draftKey !== draft) return;
        return addMediaFiles(files);
      })
      .finally(() => pendingAttachmentReads.delete(pending));
    mediaReadQueue = pending.catch(() => {});
    pendingAttachmentReads.add(pending);
  }

  function handleMediaDrop(event: DragEvent) {
    if (!event.dataTransfer?.files.length) return;
    event.preventDefault();
    queueMediaFiles(Array.from(event.dataTransfer.files));
  }

  async function useAudioTranscript(attachment: Attachment) {
    if (isTranscribing || imageAdmissionPending) return;
    isTranscribing = true;
    const sessionId = sessionStore.activeSessionId;
    const draft = draftKey;
    try {
      const settingsResponse = await apiFetch(apiUrl('/api/voice/settings'));
      const settingsResult = await settingsResponse.json();
      if (!settingsResponse.ok || !settingsResult.data?.input)
        throw new Error('Could not load voice settings.');
      const settings = settingsResult.data as VoiceSettings;
      let text: string;
      if (settings.input.provider === 'kory-local') {
        const bytes = Uint8Array.from(atob(attachment.data), (char) => char.charCodeAt(0));
        const context = new AudioContext();
        try {
          const decoded = await context.decodeAudioData(bytes.buffer);
          const mono = new Float32Array(decoded.length);
          for (let channel = 0; channel < decoded.numberOfChannels; channel++) {
            const samples = decoded.getChannelData(channel);
            for (let i = 0; i < mono.length; i++) mono[i] += samples[i] / decoded.numberOfChannels;
          }
          const result = await invoke<{ text: string }>('transcribe_local_voice', {
            pcmBase64: await pcm16Base64(resampleTo16Khz(mono, decoded.sampleRate)),
            language: settings.input.language,
          });
          text = result.text;
        } finally {
          await context.close();
        }
      } else if (settings.input.provider === 'system') {
        throw new Error(
          'System speech recognition records the microphone. For audio files, choose Kory Voice or a transcription API in Settings → Voice.',
        );
      } else {
        const response = await apiFetch(apiUrl('/api/voice/transcribe'), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            audioBase64: attachment.data,
            mimeType: attachment.mimeType,
            language: settings.input.language,
          }),
        });
        const result = await response.json();
        if (!response.ok || !result.data?.text)
          throw new Error(result.error || 'Transcription failed.');
        text = result.data.text;
      }
      if (!text?.trim()) throw new Error('No speech was detected.');
      if (
        sessionStore.activeSessionId !== sessionId ||
        draftKey !== draft ||
        !attachments.includes(attachment)
      )
        return;
      appendTranscription(text);
      attachments = attachments.filter((item) => item !== attachment);
    } catch (error) {
      toastStore.error(error instanceof Error ? error.message : 'Transcription failed.');
    } finally {
      isTranscribing = false;
    }
  }

  interface Props {
    onSend: (
      message: string,
      model?: string,
      reasoningLevel?: string,
      attachments?: Attachment[],
      speedTier?: string,
      imageInputMode?: ImageInputMode,
      modelParameters?: ModelParameterValues,
      fusion?: FusionSelection,
    ) => Promise<boolean> | boolean;
    /** Submit an instruction to the active run. The parent cancels the current
     * provider turn and starts the continuation only after cancellation settles. */
    onSteer?: (
      message: string,
      model?: string,
      reasoningLevel?: string,
      attachments?: Attachment[],
      speedTier?: string,
      imageInputMode?: ImageInputMode,
      modelParameters?: ModelParameterValues,
      fusion?: FusionSelection,
    ) => Promise<boolean> | boolean;
    onExecuteCommand?: (command: string) => Promise<boolean> | boolean;
    /** When true, the primary action is Steer when the composer has input and
     * Stop when it is empty. */
    isRunning?: boolean;
    /** A stop request is settling. Keep the composer in a stopping state even
     * if a terminal run.state arrives before the HTTP response. */
    isStopping?: boolean;
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
    onSteer,
    onExecuteCommand,
    isRunning = false,
    isStopping = false,
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
  let contextPreviewAbortController: AbortController | null = null;
  let selectedPickerIndex = $state(0);
  let modelSelectionGeneration = 0;
  let freebuffAccountRows = $state<
    Array<{
      accountId: string;
      label: string;
      snapshot: FreebuffAccountSnapshot;
      turn?: {
        accountId: string;
        sessionId: string;
        role: string;
        startedAt: number;
        deadlineAt: number;
      } | null;
    }>
  >([]);
  let freebuffAccountRefreshTimer: ReturnType<typeof setInterval> | null = null;
  let freebuffAccountRefreshInFlight: Promise<void> | null = null;
  let imageAdmissionPending = $state(false);
  let attachments = $state<Attachment[]>([]);
  let hydratedDraftKey = $state<string | null>(null);
  let lastClearDraftRequest = $state<number | undefined>(undefined);
  // False while a restored draft's attachment payloads are still being read.
  let draftPayloadsReady = $state(true);
  let composerUnmounted = false;
  onDestroy(() => {
    composerUnmounted = true;
    contextPreviewAbortController?.abort();
    if (freebuffAccountRefreshTimer) clearInterval(freebuffAccountRefreshTimer);
    if (freebuffTickTimer) clearInterval(freebuffTickTimer);
  });

  async function refreshFreebuffAccount(): Promise<void> {
    if (freebuffAccountRefreshInFlight) return freebuffAccountRefreshInFlight;
    if (!wsStore.providers.some((provider) => provider.name === 'freebuff' && provider.enabled)) {
      freebuffAccountRows = [];
      return;
    }
    freebuffAccountRefreshInFlight = (async () => {
      try {
        const response = await apiFetch(apiUrl('/api/providers/freebuff/account'));
        const payload = (await response.json()) as {
          ok?: boolean;
          data?: Array<{
            accountId: string;
            label: string;
            snapshot: FreebuffAccountSnapshot;
            turn?: {
              accountId: string;
              sessionId: string;
              role: string;
              startedAt: number;
              deadlineAt: number;
            } | null;
          }>;
        };
        if (response.ok && payload.ok === true && Array.isArray(payload.data)) {
          freebuffAccountRows = payload.data;
        }
      } catch {
        // The model picker remains usable if the separate balance read is offline.
      } finally {
        freebuffAccountRefreshInFlight = null;
      }
    })();
    return freebuffAccountRefreshInFlight;
  }

  onMount(() => {
    void refreshFreebuffAccount();
    // Poll more often than the backend's 30s account cache so we pick up the
    // first fresh snapshot promptly without forcing extra provider requests.
    freebuffAccountRefreshTimer = setInterval(() => void refreshFreebuffAccount(), 15_000);
  });

  // Live countdown for this session's active Freebuff turn. The backend stamps
  // the real abort deadline; the 15s poll picks the row up and the 1s tick
  // keeps the label honest. The row disappears on terminal state because the
  // provider drops it when the slot is released.
  let freebuffTickNow = $state(Date.now());
  let freebuffTickTimer: ReturnType<typeof setInterval> | null = null;
  const freebuffActiveTurn = $derived(
    freebuffAccountRows
      .map((row) => row.turn)
      .find(
        (turn) =>
          turn != null &&
          turn.sessionId === sessionStore.activeSessionId &&
          turn.deadlineAt > freebuffTickNow,
      ) ?? null,
  );
  $effect(() => {
    if (freebuffActiveTurn && !freebuffTickTimer) {
      freebuffTickNow = Date.now();
      freebuffTickTimer = setInterval(() => (freebuffTickNow = Date.now()), 1_000);
    } else if (!freebuffActiveTurn && freebuffTickTimer) {
      clearInterval(freebuffTickTimer);
      freebuffTickTimer = null;
    }
  });
  function formatFreebuffTurnRemaining(ms: number): string {
    const totalSeconds = Math.max(0, Math.ceil(ms / 1000));
    return `${Math.floor(totalSeconds / 60)}:${String(totalSeconds % 60).padStart(2, '0')}`;
  }
  const freebuffTurnCountdown = $derived(
    freebuffActiveTurn
      ? formatFreebuffTurnRemaining(freebuffActiveTurn.deadlineAt - freebuffTickNow)
      : null,
  );

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
    let scopeDef = findModelDef(currentProvider, currentModel);
    // A chat saved on a legacy per-pairing `devin:fusion-…` id restores onto
    // the single `devin:fusion` model with its slot selection prefilled.
    if (
      scopeDef?.fusion &&
      currentModel &&
      currentModel !== 'fusion' &&
      currentModel.startsWith('fusion-')
    ) {
      const legacySel = parseFusionSlug(currentModel);
      selectedModel = `${currentProvider}:${scopeDef.id}`;
      scopeDef = findModelDef(currentProvider, currentModel);
      if (legacySel) fusionSelection = legacySel;
      // The canonical model id differs from the saved legacy id — retarget the
      // suppress flag so the preference-restore effect doesn't overwrite the
      // parsed slot prefill with the model's global defaults.
      suppressPreferenceRestoreFor = selectedModel;
    }
    fusionSelection ??= initialFusionSelection(saved, scopeDef?.fusion);
    speedTier = scopeDef
      ? initialSpeedTier(saved, scopeDef.speedTiers ?? [])
      : (saved.speedTier ?? null);
    speedTierPendingLegacy = !scopeDef && saved.fastMode === true;
    modelParameterValues = initialModelParameters(saved, scopeDef?.parameters);
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
    saveComposerSessionState(scope, {
      model: selectedModel,
      reasoningLevel,
      speedTier,
      modelParameters: modelParameterValues,
      // The don't-overwrite-while-def-unknown rule: while the catalog can't
      // confirm devin:fusion, keep the chat's stored slot selection.
      fusion:
        fusionSelection ??
        (currentModel === 'fusion' && !fusionCatalog
          ? loadComposerSessionState(scope).fusion
          : undefined),
    });
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
  // Non-persistent choices authorize the next send. Only "Remember my choice"
  // makes a capability correction durable for this exact provider/model.
  let oneShotImageOmitConsents = $state<Set<string>>(new Set());
  let oneShotImageAllowConsents = $state<Set<string>>(new Set());
  let imageFallbackWarning = $state<{
    sessionId: string | null;
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
    tap: VoiceTap | null;
    router: DictationRouter | null;
  };
  type LocalVoiceModelStatus = {
    installed: boolean;
    modelId: string;
  };

  let isRecording = $state(false);
  let isTranscribing = $state(false);
  // Covers microphone/model startup so simultaneous inputs cannot open two recorders.
  let voiceStarting = $state(false);
  let activeRecorder: MediaRecorder | null = null;
  let activeLocalRecorder: LocalPcmRecorder | null = null;
  // Live transcription while speaking: the local model has no streaming API,
  // so it is re-run on a cadence over a sliding window instead of the whole
  // capture. Both cursors are in source-rate frames.
  let localPartialTimer: ReturnType<typeof setInterval> | null = null;
  let localPartialInFlight = false;
  let localPartialCommitted = '';
  let localPartialConsumedFrames = 0;
  let liveTranscript: string[] = [];
  // True while the push-to-talk binding is physically held down.
  let voiceHeld = false;
  // Which binding is held: dictation (voice_mode) or the conductor.
  let heldCaptureMode: CaptureMode = 'dictation';
  // Routes the current capture's transcript to the composer or the conductor.
  let activeCaptureRouter: DictationRouter | null = null;
  let activeSpeechRecognition: BrowserSpeechRecognition | null = null;
  // Wall-clock ms the current recording has been running, for the timer.
  let recordingStartedAt = 0;
  let recordingElapsedMs = $state(0);
  let recordingTimer: ReturnType<typeof setInterval> | null = null;
  let voiceSettings = $state<VoiceSettings | null>(null);
  let composerMicrophoneEnabled = $derived(voiceSettings?.voiceModeEnabled === true);
  let voiceShortcutHint = $derived(
    [
      formatChord(...shortcutStore.keys('voice_mode')),
      formatChord(...shortcutStore.voiceFallbackKeys()),
    ]
      .filter(Boolean)
      .join(' or '),
  );
  let conductorShortcutHint = $derived(formatChord(...shortcutStore.keys('voice_conductor')));
  const pendingAttachmentReads = new Set<Promise<void>>();
  let referenceFileInputRef = $state<HTMLInputElement>();
  let referenceFolderInputRef = $state<HTMLInputElement>();
  let showReferenceMenu = $state(false);
  let showGoalActions = $state(false);
  // Checklists stay behind the more-actions menu until asked for, so an unused
  // list never takes composer space away from the message being written.
  let showChecklists = $state(false);
  // The panel itself no longer decides visibility, so this chat's existing
  // lists still reveal it without being asked for — and dismissing it sticks
  // until the set of lists changes, which is when a new checklist arrives.
  let checklistRevealKey = $derived(checklistStore.active.map((entry) => entry.id).join(','));
  $effect(() => {
    if (checklistRevealKey) {
      showChecklists = true;
      return;
    }
    // Closing the last list takes the docked panel with it, once the store has
    // actually loaded — a fresh chat must not close a panel the user just
    // opened with `/checklist` before its first fetch resolves.
    if (checklistStore.loaded) showChecklists = false;
  });

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
  // /checklist and the palette route here, since the docked list is owned by the
  // composer. A bare command reveals whatever this chat already has; a title
  // creates the list immediately so the command does something on its own.
  $effect(() => {
    const command = async (event: Event) => {
      const title = ((event as CustomEvent<{ title?: string }>).detail?.title ?? '').trim();
      if (!title) {
        // A bare `/checklist` is a toggle: running it again takes down the
        // docked surface the first one opened, so the composer can clear it
        // without reaching for the pointer.
        showChecklists = !showChecklists;
        return;
      }
      showChecklists = true;
      if (!sessionStore.activeSessionId) {
        toastStore.error('Open a chat before creating a checklist');
        return;
      }
      const created = await checklistStore.create({ title });
      if (!created) toastStore.error(checklistStore.error || 'Could not create checklist');
    };
    window.addEventListener('kory:checklist-action', command);
    return () => window.removeEventListener('kory:checklist-action', command);
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
    if (provider === 'google') return 'Google';
    if (provider === 'aistudio') return 'Google AI Studio';
    if (provider === 'xai') return 'xAI';
    if (provider === 'openrouter') return 'OpenRouter';
    if (provider === 'unorouter') return 'UnoRouter';
    if (provider === 'hundredmillionseek') return '100MillionSeek';
    if (provider === 'numes') return 'Numes';
    if (provider === 'coarena') return 'Coarena';
    if (provider === 'crowllm') return 'CrowLLM';
    if (provider === 'radeon') return 'AMD Radeon Cloud';
    if (provider === 'runcrate') return 'Runcrate';
    if (provider === 'tokenharbor') return 'Token Harbor';
    if (provider === 'logfare') return 'Logfare';
    if (provider === 'apinex') return 'APInex';
    if (provider === 'gwarden') return 'Gwarden AI';
    if (provider === 'respan') return 'Respan';
    if (provider === 'vertexai') return 'Vertex AI';
    if (provider === 'copilot') return 'Copilot';
    if (provider === 'kimicode') return 'Kimi Code';
    if (provider === 'grok') return 'Grok Build';
    if (provider === 'opencode') return 'OpenCode';
    if (provider === 'beam') return 'Reflection AI';
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
  /** Who actually enforces the permission mode for the selected provider. A
   *  mode is never a silent promise: when Kory is not in the tool path, the
   *  picker says so instead of quietly downgrading. */
  let permissionEnforcement = $derived(
    providerPermissionEnforcement(
      selectedModel ? currentProvider : '',
      currentProvider ? providerLabel(currentProvider) : undefined,
    ),
  );
  /** The model finished its answer and the run is settling follow-up work
   *  (critic, checkpoint). Stop still works, but nothing is being written. */
  let isFinalizing = $derived(
    isRunning && runStateStore.getPhase(sessionStore.activeSessionId) === 'finalizing',
  );
  /** The last run was cut off by a backend restart. Kory cannot resume a
   *  provider stream across a restart, so offer one explicit continuation. */
  const RESTART_INTERRUPTED_REASON = 'backend_restarted_during_active_run';
  const RESUME_PROMPT = 'Continue where you left off before Koryphaios restarted.';
  let dismissedInterruptedRunId = $state<string | null>(null);
  let interruptedRunId = $derived.by(() => {
    const sid = sessionStore.activeSessionId;
    if (!sid || isRunning || isWaiting) return null;
    if (runStateStore.getTerminalReason(sid) !== RESTART_INTERRUPTED_REASON) return null;
    const runId = runStateStore.getRunId(sid);
    return runId && runId !== dismissedInterruptedRunId ? runId : null;
  });

  async function resumeInterruptedTurn() {
    const draft = value;
    value = RESUME_PROMPT;
    await send();
    if (draft.trim() && !value.trim()) value = draft;
  }

  let permissionEnforced = $derived(
    permissionEnforcement.level === 'kory' || permissionEnforcement.level === 'kory-hooks',
  );

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
        speedTiers?: ModelSpeedTier[];
        parameters?: ModelParameterDef[];
        fusion?: FusionCatalog;
        vision?: boolean;
        accountId?: string;
        apiModelId?: string;
        freebuckCost?: number;
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
          speedTiers?: ModelSpeedTier[];
          parameters?: ModelParameterDef[];
          fusion?: FusionCatalog;
          vision?: boolean;
          accountId?: string;
          apiModelId?: string;
          freebuckCost?: number;
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
    const def = findModelDef(currentProvider, currentModel);
    speedTier = def
      ? initialSpeedTier(saved, def.speedTiers ?? [])
      : (saved.speedTier ?? null);
    speedTierPendingLegacy = !def && saved.fastMode === true;
    modelParameterValues = initialModelParameters(saved, def?.parameters);
    fusionSelection = initialFusionSelection(saved, def?.fusion);
    fusionAdjustedNote = null;
  });

  $effect(() => {
    if (!reasoningConfig || reasoningConfig.options.length === 0) return;
    const next = resolveReasoningLevel(
      reasoningLevel,
      reasoningConfig.options.map((o) => o.value),
    );
    if (next !== reasoningLevel) reasoningLevel = next;
  });
  // The speed control is data-driven: the vendor-confirmed faster serving
  // tiers ship on the model's catalog entry, so the chip appears only for
  // models that genuinely offer one and labels/descriptions come straight
  // from the catalog (no provider-name conditionals).
  let speedTier = $state<string | null>(null);
  let speedTierPendingLegacy = $state(false);
  let speedTiers = $derived(findModelDef(currentProvider, currentModel)?.speedTiers ?? []);
  let activeSpeedTier = $derived(speedTiers.find((tier) => tier.id === speedTier));
  let speedTierLabel = $derived(activeSpeedTier?.label ?? speedTiers[0]?.label ?? 'Fast');
  let showFastMenu = $state(false);

  function cycleSpeedTier(): void {
    if (speedTiers.length === 0) return;
    const index = speedTiers.findIndex((tier) => tier.id === speedTier);
    speedTier = speedTiers[index + 1]?.id ?? null;
  }

  $effect(() => {
    const model = selectedModel;
    if (!model || !reasoningIsValid) return;
    saveComposerPreference(model, { reasoningLevel });
  });

  $effect(() => {
    const model = selectedModel;
    // Never write over a stored choice while the catalog can't confirm this
    // model's tiers — a def that hasn't loaded yet would erase a saved tier.
    if (!model || speedTiers.length === 0) return;
    saveComposerPreference(model, { speedTier });
  });

  // Re-resolve a tier restored before the catalog arrived: an unknown id is
  // not the user's intent, and a legacy `fastMode: true` maps onto the first
  // tier only once the model's real tier list is known.
  $effect(() => {
    const tiers = speedTiers;
    if (!selectedModel || tiers.length === 0) return;
    if (speedTier && !tiers.some((tier) => tier.id === speedTier)) speedTier = null;
    if (speedTierPendingLegacy) {
      speedTierPendingLegacy = false;
      speedTier ??= tiers[0].id;
    }
  });

  // Model settings: provider-reported tunable parameters, already filtered to
  // what this adapter actually sends. The chip renders only when the model
  // declares at least one, and only overridden keys ever reach the request.
  let modelParameterValues = $state<ModelParameterValues>({});
  let modelParameters = $derived(
    findModelDef(currentProvider, currentModel)?.parameters ?? [],
  );
  let sanitizedModelParameters = $derived(
    sanitizeModelParameterValues(modelParameters, modelParameterValues),
  );
  let modelParameterOverrideCount = $derived(
    Object.keys(sanitizedModelParameters).length,
  );
  let showModelParametersMenu = $state(false);

  $effect(() => {
    const model = selectedModel;
    // Never write over stored overrides while the catalog can't confirm this
    // model's parameter list — same race as the speed tier.
    if (!model || modelParameters.length === 0) return;
    saveComposerPreference(model, { modelParameters: modelParameterValues });
  });

  // Devin Fusion: ONE model whose composer edits two slots (lead + sidekick).
  // When the selected model's def carries a `fusion` catalog the normal
  // reasoning/speed/settings chips hide and two slot chips appear; the whole
  // pairing matrix is vendor data, nothing is hard-coded.
  let fusionSelection = $state<FusionSelection | null>(null);
  let fusionCatalog = $derived(findModelDef(currentProvider, currentModel)?.fusion);
  let fusionAdjustedNote = $state<string | null>(null);
  let showFusionSlot1Menu = $state(false);
  let showFusionSlot2Menu = $state(false);
  let fusionLeadDef = $derived(
    fusionCatalog?.leads.find((l) => l.id === fusionSelection?.lead),
  );
  let fusionSidekickDef = $derived(
    fusionCatalog?.sidekicks.find((sk) => sk.id === fusionSelection?.sidekick),
  );
  let fusionAvailableSidekicks = $derived(
    fusionCatalog && fusionSelection
      ? new Set(
          availableSidekicks(fusionCatalog, fusionSelection.lead, fusionSelection.leadFast),
        )
      : new Set<string>(),
  );
  let fusionAnyFastPairing = $derived(
    fusionCatalog && fusionSelection
      ? availableSidekicks(fusionCatalog, fusionSelection.lead, true).length > 0
      : false,
  );
  let fusionSidekickPriorityLabel = $derived(
    fusionCatalog && fusionSelection
      ? fusionSidekickSpeedLabel(fusionSelection.sidekick, fusionSelection.leadFast, fusionCatalog)
      : null,
  );
  /** Whether the sidekick family has a `-priority` variant anywhere in the
   *  catalog — controls the read-only Fast row on the slot-2 panel. */
  let fusionSidekickHasPriority = $derived.by(() => {
    if (!fusionCatalog || !fusionSelection) return false;
    const needle = `|${fusionSelection.sidekick}|`;
    return Object.keys(fusionCatalog.pairings).some(
      (key) => key.includes('|fast|') && key.endsWith(needle),
    );
  });
  let fusionPairingMeta = $derived.by(() => {
    if (!fusionCatalog || !fusionSelection) return undefined;
    const cell =
      fusionCatalog.pairings[
        fusionPairingKey(
          fusionSelection.lead,
          fusionSelection.leadFast,
          fusionSelection.sidekick,
          fusionSelection.sidekickEffort,
        )
      ];
    if (!cell || cell[fusionSelection.leadEffort] === undefined) return undefined;
    return fusionCatalog.meta[
      fusionPairingKey(
        fusionSelection.lead,
        fusionSelection.leadFast,
        fusionSelection.sidekick,
        fusionSelection.sidekickEffort,
      )
    ];
  });

  function fusionEffortLabel(effort: string): string {
    const labels: Record<string, string> = {
      none: 'None',
      minimal: 'Minimal',
      low: 'Low',
      medium: 'Medium',
      high: 'High',
      xhigh: 'XHigh',
      ultra: 'Ultra',
      max: 'Max',
      fast: 'Fast',
      slow: 'Slow',
    };
    return labels[effort] ?? effort.charAt(0).toUpperCase() + effort.slice(1);
  }

  /** Full chip text for tooltips/aria — survives the collapsed icon-only state. */
  function fusionSlotChipLabel(slot: 1 | 2): string {
    const sel = fusionSelection;
    if (!sel) return slot === 1 ? 'Fusion 1' : 'Fusion 2';
    if (slot === 1) {
      const parts = [fusionLeadDef?.name ?? sel.lead, fusionEffortLabel(sel.leadEffort)];
      if (sel.leadFast) parts.push('Fast');
      return `Fusion 1: ${parts.join(' · ')}`;
    }
    const parts = [fusionSidekickDef?.name ?? sel.sidekick];
    if (sel.sidekickEffort) parts.push(fusionEffortLabel(sel.sidekickEffort));
    return `Fusion 2: ${parts.join(' · ')}`;
  }

  function fusionContextLabel(tokens: number): string {
    if (tokens >= 1_000_000) {
      const m = tokens / 1_000_000;
      return `${Number.isInteger(m) ? m : m.toFixed(1)}M`;
    }
    return `${Math.round(tokens / 1000)}k`;
  }

  /** Footer line for a slot panel: "1M context · $4 in / $20 out per 1M",
   *  cached price only when the vendor reports one. */
  function fusionMetaSummary(): string | null {
    const meta = fusionPairingMeta;
    if (!meta) return null;
    const parts = [`${fusionContextLabel(meta.contextWindow)} context`];
    if (meta.costPerMInputTokens !== undefined && meta.costPerMOutputTokens !== undefined) {
      parts.push(`$${meta.costPerMInputTokens} in / $${meta.costPerMOutputTokens} out per 1M`);
      if (meta.costPerMInputCached !== undefined) {
        parts.push(`$${meta.costPerMInputCached} cached`);
      }
    }
    return parts.join(' · ');
  }

  /** Apply one slot edit, letting the shared helper repair the pairing when
   *  the vendor doesn't offer the combination. */
  function applyFusionChange(
    changed: 'lead' | 'leadFast' | 'sidekick' | 'sidekickEffort' | 'leadEffort',
    patch: Partial<FusionSelection>,
  ): void {
    if (!fusionCatalog || !fusionSelection) return;
    const adjusted = adjustFusionSelection(
      fusionCatalog,
      { ...fusionSelection, ...patch },
      changed,
    );
    fusionSelection = adjusted.selection;
    fusionAdjustedNote = adjusted.adjustedNote ?? null;
    if (adjusted.adjustedNote) toastStore.info(adjusted.adjustedNote);
  }

  $effect(() => {
    const model = selectedModel;
    // Same don't-overwrite race as the speed tier: only persist once the
    // catalog confirms this model IS the fusion model.
    if (!model || !fusionCatalog || !fusionSelection) return;
    saveComposerPreference(model, { fusion: fusionSelection });
  });

  function setModelParameter(key: ModelParameterKey, value: number | string): void {
    modelParameterValues = { ...modelParameterValues, [key]: value };
  }

  function resetModelParameter(key: ModelParameterKey): void {
    const next = { ...modelParameterValues };
    delete next[key];
    modelParameterValues = next;
  }

  function resetAllModelParameters(): void {
    modelParameterValues = {};
  }

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
  /** Delegated-worker isolation preset for this chat: the manager decides on
   *  Auto, while Always/Never are the user's fixed choice. A chat that never
   *  chose inherits the project default, which each choice updates so the
   *  pick carries into new chats. */
  let worktreeMode = $derived(
    chatAgentOverrides.worktreeMode ??
      // Durable overrides written before the preset existed only carry the
      // checkbox: on was the manager-decides default, off meant Never.
      (typeof chatAgentOverrides.worktreeIsolation === 'boolean'
        ? chatAgentOverrides.worktreeIsolation
          ? 'auto'
          : 'never'
        : undefined) ??
      agentSettingsStore.settings.worktreeMode ??
      'auto',
  );
  const WORKTREE_MODES = ['auto', 'always', 'never'] as const;
  function cycleWorktreeMode() {
    const idx = WORKTREE_MODES.indexOf(worktreeMode as (typeof WORKTREE_MODES)[number]);
    const next = WORKTREE_MODES[(idx + 1) % WORKTREE_MODES.length];
    setChatAgentOverrides({ worktreeMode: next });
  }
  function worktreeModeLabel(): string {
    return worktreeMode === 'always' ? 'On' : worktreeMode === 'never' ? 'Off' : 'Auto';
  }
  function worktreeModeTitle(): string {
    if (worktreeMode === 'always')
      return 'Worktree: On. Every delegated worker runs in an isolated git worktree.';
    if (worktreeMode === 'never')
      return 'Worktree: Off. Delegated workers write directly into this chat checkout.';
    return 'Worktree: Auto. The manager decides isolation per task (worktrees merge back).';
  }

  function setChatAgentOverrides(patch: SessionAgentOverrides) {
    // Enabling the gate without naming a mode must mean Auto, not the legacy
    // "always" the shared resolver derives from a bare boolean. Critic Auto is
    // the default a new chat inherits; "Always" is only ever chosen on purpose.
    const normalizedPatch =
      patch.criticGateEnabled === true && !patch.criticMode
        ? { ...patch, criticMode: 'auto' as const }
        : patch;
    const next = { ...chatAgentOverrides, ...normalizedPatch };
    const scope = currentDraftKey();
    pendingAgentOverrides = { scope, overrides: next };
    saveComposerSessionState(scope, {
      ...(next.permissionMode ? { permissionMode: next.permissionMode } : {}),
      ...(next.agentExecutionMode ? { agentExecutionMode: next.agentExecutionMode } : {}),
      ...(next.worktreeMode ? { worktreeMode: next.worktreeMode } : {}),
      ...(next.criticMode ? { criticMode: next.criticMode } : {}),
      ...(typeof next.criticGateEnabled === 'boolean'
        ? { criticGateEnabled: next.criticGateEnabled }
        : {}),
    });
    // Every posture change here also becomes the project default, so the next
    // new chat starts from what the user just picked. Model and reasoning are
    // excluded by composerApprovalDefaults: those stay chat-local.
    const projectDefaults = composerApprovalDefaults(normalizedPatch);
    if (Object.keys(projectDefaults).length > 0) {
      void agentSettingsStore.saveSettings(projectDefaults, { quietSuccess: true });
    }
    const sessionId = sessionStore.activeSessionId;
    if (!sessionId) return;
    void sessionStore.setSessionAgentOverrides(sessionId, normalizedPatch).then(() => {
      // Release the optimistic layer either way: on success the session row is
      // the source of truth, on failure the store has already rolled back.
      if (pendingAgentOverrides?.overrides === next) pendingAgentOverrides = null;
    });
  }

  // A Critic / approval choice made before the chat exists has no session row to
  // live on yet, so it used to be dropped the moment the first message created
  // the session: the composer showed "Critic off" while the turn ran with the
  // project default. Carry that pending choice onto the session creation
  // produced, once, so the new chat starts with what the composer advertised.
  // Chats that never made a choice keep inheriting the project default.
  let pendingOverridesAppliedTo: string | null = null;
  $effect(() => {
    const sessionId = sessionStore.activeSessionId;
    const pending = pendingAgentOverrides;
    if (!sessionId || !pending) return;
    if (pending.scope === currentDraftKey()) return;
    if (pendingOverridesAppliedTo === sessionId) return;
    pendingOverridesAppliedTo = sessionId;
    pendingAgentOverrides = null;
    void sessionStore.setSessionAgentOverrides(sessionId, pending.overrides);
    // The session row owns these choices now. A leftover draft entry would
    // shadow the project default and make the next new chat open with the old
    // posture (e.g. YOLO here, Ask there).
    clearComposerApprovalState(pending.scope);
  });

  let permissionMode = $derived(
    (chatAgentOverrides.permissionMode ??
      agentSettingsStore.settings.permissionMode ??
      'guarded') as PermissionMode,
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
      // Also becomes the project default; setChatAgentOverrides does both.
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

  function formatFreebucks(value: number | undefined): string {
    if (value === undefined || !Number.isFinite(value)) return '—';
    return value.toLocaleString(undefined, { maximumFractionDigits: 2 });
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
      accountId?: string;
      apiModelId?: string;
      freebuckCost?: number;
      reasoningLevels?: string[];
      maxOutputTokens?: number;
      fusion?: FusionCatalog;
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
              accountId?: string;
              apiModelId?: string;
              freebuckCost?: number;
              reasoningLevels?: string[];
              maxOutputTokens?: number;
              fusion?: FusionCatalog;
            }>
          | undefined;
        if (catalog && catalog.length > 0) {
          for (const m of catalog) {
            // 'cli-default' is the CLI's managed-selection policy, not a model.
            // The backend keeps it valid for existing sessions; the picker hides it.
            if (p.name === 'freebuff' && m.id === 'freebuff/cli-default') continue;
            if (enabledIds.size === 0 || enabledIds.has(m.id)) {
              models.push({
                label: `(${providerLabel(p.name)}) ${m.name}`,
                value: `${p.name}:${m.id}`,
                provider: p.name,
                name: m.name,
                supportsAttachments: m.supportsAttachments,
                vision: m.vision,
                accountId: m.accountId,
                apiModelId: m.apiModelId,
                freebuckCost: m.freebuckCost,
                reasoningLevels: m.reasoningLevels,
                maxOutputTokens: m.maxOutputTokens,
                fusion: m.fusion,
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
    if (
      target.modelCatalogAuthoritative !== true &&
      (!Array.isArray(target.models) || target.models.length === 0)
    )
      return;
    selectedModel = '';
    if (typeof localStorage !== 'undefined') localStorage.removeItem(MODEL_STORAGE_KEY);
  });

  let filteredQuickModels = $derived.by(() => {
    const candidates = modelPickerVisionOnly
      ? availableModels.filter(
          (model) => modelHasVerifiedImageInput(model) || hasImageAllowConsent(model.value),
        )
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

  function freebuffSnapshotForModel(
    modelId: string | undefined,
  ): FreebuffAccountSnapshot | undefined {
    const accountId = modelId ? findModelDef('freebuff', modelId)?.accountId : undefined;
    return (
      accountId
        ? freebuffAccountRows.find((row) => row.accountId === accountId)
        : freebuffAccountRows[0]
    )?.snapshot;
  }

  /** Preserve the provider's live per-model information in the picker. The
   * account endpoint supplies this through `hours.prices`; the model catalog
   * carries the same value while the separate account refresh is in flight. */
  function freebuffProviderRateForSelection(
    value: string,
    fallback: number | undefined,
  ): number | undefined {
    const { model } = parseProviderModelSelection(value, providerNames);
    const definition = findModelDef('freebuff', model ?? '');
    const prices = freebuffSnapshotForModel(model)?.hours?.prices;
    const normalize = (input: string) => input.toLowerCase().replace(/[^a-z0-9]/g, '');
    if (prices) {
      const candidates = [model, definition?.id, definition?.apiModelId, definition?.name]
        .filter((id): id is string => !!id)
        .flatMap((id) => [id, id.slice(id.lastIndexOf(':') + 1)])
        .flatMap((id) => [id, id.replace(/^freebuff\/catalog-/, '')]);
      const candidateSet = new Set(candidates);
      for (const id of candidateSet) {
        const rate = prices[id];
        if (rate !== undefined) return rate;
      }
      const normalizedCandidates = new Set(candidates.map(normalize).filter(Boolean));
      const exactMatches = Object.entries(prices).filter(([key]) =>
        normalizedCandidates.has(normalize(key)),
      );
      if (exactMatches.length === 1) return exactMatches[0][1];
      if (exactMatches.length > 1) {
        // Prefer the first unambiguous key if several normalized forms collide.
        const unique = exactMatches[0];
        if (exactMatches.every(([key]) => key === unique[0])) return unique[1];
      }
      const fuzzyMatches = Object.entries(prices).filter(([key]) => {
        const normalizedKey = normalize(key);
        return [...normalizedCandidates].some(
          (candidate) =>
            candidate.length > 0 &&
            (normalizedKey.includes(candidate) || candidate.includes(normalizedKey)),
        );
      });
      if (fuzzyMatches.length === 1) return fuzzyMatches[0][1];
    }
    return definition?.freebuckCost ?? fallback;
  }

  /** The account's 1x baseline, from the live rate table when the account
   * refresh has landed, otherwise from the catalog's own reported costs. */
  function freebuffRateBase(): number | undefined {
    const accountRates = freebuffAccountRows
      .map((row) => freebuffBaseRate(row.snapshot.hours?.prices))
      .filter((rate): rate is number => rate !== undefined);
    if (accountRates.length > 0) return Math.min(...accountRates);
    const catalogCosts = availableModels
      .filter((model) => model.provider === 'freebuff')
      .map((model) => model.freebuckCost)
      .filter((cost): cost is number => cost !== undefined && Number.isFinite(cost) && cost > 0);
    return catalogCosts.length > 0 ? Math.min(...catalogCosts) : undefined;
  }

  /** The model's cost relative to the 1x model, as a bare "Nx" figure. */
  function formatFreebuffProviderRate(value: number | undefined): string | undefined {
    const multiplier = freebuffRateMultiplier(value, freebuffRateBase());
    if (multiplier === undefined) return undefined;
    if (multiplier === 0) return 'Free';
    const rounded = Math.round(multiplier * 10) / 10;
    return `${formatFreebucks(rounded)}x`;
  }

  let selectedModelLabel = $derived.by(() => {
    if (!selectedModel) return 'Select model';
    const parsed = parseProviderModelSelection(selectedModel, providerNames);
    if (!parsed.model || !parsed.provider) return selectedModel;
    const modelDef = findModelDef(parsed.provider, parsed.model);
    if (modelDef?.name) return `(${providerLabel(parsed.provider)}) ${modelDef.name}`;
    return parsed.model;
  });
  /** The composer button sits next to the provider's icon, so it names only the
   *  model; the tooltip and announcements keep the provider-qualified label. */
  let selectedModelShortLabel = $derived.by(() => {
    if (!selectedModel) return 'Select model';
    const parsed = parseProviderModelSelection(selectedModel, providerNames);
    if (!parsed.model || !parsed.provider) return selectedModel;
    return findModelDef(parsed.provider, parsed.model)?.name ?? parsed.model;
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
    contextPreviewAbortController?.abort();
    const abortController = new AbortController();
    contextPreviewAbortController = abortController;
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
            signal: abortController.signal,
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
          if (abortController.signal.aborted) return;
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
      const arg = fast[1]?.toLowerCase();
      if (fusionCatalog && fusionSelection) {
        // Fusion owns its Fast switch on slot 1 (`leadFast`); the sidekick's
        // -priority tier follows automatically per the pairing matrix.
        const sel = fusionSelection;
        if (arg === 'status') {
          toastStore.info(`Fusion 1 Fast is ${sel.leadFast ? 'on' : 'off'}.`);
        } else if (
          (arg === 'on' || !arg) &&
          !sel.leadFast &&
          !leadFastAvailable(fusionCatalog, sel.lead, sel.sidekick, sel.sidekickEffort) &&
          !fusionAnyFastPairing
        ) {
          toastStore.error('Devin offers no fast pairing for this lead.');
        } else {
          const nextFast = arg === 'on' ? true : arg === 'off' ? false : !sel.leadFast;
          const adjusted = adjustFusionSelection(
            fusionCatalog,
            { ...sel, leadFast: nextFast },
            'leadFast',
          );
          fusionSelection = adjusted.selection;
          toastStore.info(
            adjusted.adjustedNote ??
              (nextFast ? 'Fusion 1 Fast enabled.' : 'Fusion 1 Fast disabled.'),
          );
        }
        value = '';
        resizeToMin();
        return true;
      }
      if (speedTiers.length === 0) {
        toastStore.error('This model has no vendor-confirmed faster serving tier.');
      } else if (arg === 'status') {
        toastStore.info(
          `${speedTierLabel} is ${activeSpeedTier ? 'on' : 'off'}. ${activeSpeedTier?.description ?? speedTiers[0].description}`,
        );
      } else if (arg === 'on') {
        speedTier = speedTiers[0].id;
        toastStore.info(`${speedTiers[0].label} enabled. ${speedTiers[0].description}`);
      } else if (arg === 'off') {
        speedTier = null;
        toastStore.info(`${speedTierLabel} disabled.`);
      } else {
        cycleSpeedTier();
        toastStore.info(
          activeSpeedTier
            ? `${activeSpeedTier.label} enabled. ${activeSpeedTier.description}`
            : `${speedTierLabel} disabled.`,
        );
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
    // Mod+Shift+V (Ctrl on Windows/Linux, ⌘ on macOS) → force paste image
    if ((e.ctrlKey || e.metaKey) && e.shiftKey && (e.key === 'v' || e.key === 'V')) {
      e.preventDefault();
      void pasteImageFromClipboard();
      return;
    }

    if (isStopping) {
      e.preventDefault();
      return;
    }
    if (isRunning && shortcutStore.matches('send', e)) {
      e.preventDefault();
      if (canSend) void send();
      else stop();
      return;
    }
    if (shortcutStore.matches('send', e)) {
      e.preventDefault();
      send();
    } else if (e.key === 'Enter' && !e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey) {
      e.preventDefault();
      if (isRunning) {
        if (canSend) void send();
        else stop();
      } else send();
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

  function hasImageAllowConsent(modelValue: string): boolean {
    const storage = typeof localStorage === 'undefined' ? undefined : localStorage;
    return (
      hasTrustedImageModel(storage, modelValue) ||
      oneShotImageAllowConsents.has(imageConsentKey(modelValue))
    );
  }

  function grantImageAllowConsent(modelValue: string, remember: boolean, oneShot = false) {
    if (remember) {
      rememberTrustedImageModel(
        typeof localStorage === 'undefined' ? undefined : localStorage,
        modelValue,
      );
    } else if (oneShot) {
      oneShotImageAllowConsents = new Set([
        ...oneShotImageAllowConsents,
        imageConsentKey(modelValue),
      ]);
    }
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

  function consumeOneShotImageAllowConsent(modelValue: string) {
    const key = imageConsentKey(modelValue);
    if (!oneShotImageAllowConsents.has(key)) return;
    const next = new Set(oneShotImageAllowConsents);
    next.delete(key);
    oneShotImageAllowConsents = next;
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
      const submit = isRunning && canSend && onSteer ? onSteer : onSend;
      accepted =
        (await submit(
          trimmed,
          modelValue,
          reasoningLevel,
          outgoingAttachments,
          speedTier && speedTiers.some((tier) => tier.id === speedTier) ? speedTier : undefined,
          imageInputMode,
          Object.keys(sanitizedModelParameters).length > 0
            ? sanitizedModelParameters
            : undefined,
          fusionCatalog && fusionSelection ? fusionSelection : undefined,
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
    consumeOneShotImageAllowConsent(modelValue);
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

  function useImagesWithModel(remember: boolean) {
    const warning = imageFallbackWarning;
    if (!warning) return;
    imageFallbackWarning = null;
    if (
      warning.sessionId !== sessionStore.activeSessionId ||
      (warning.mode === 'send' && warning.targetValue !== selectedModel)
    ) {
      return;
    }
    grantImageAllowConsent(warning.targetValue, remember, !remember);
    if (remember) {
      toastStore.success('Image support remembered for this model.', {
        duration: 8_000,
        actionLabel: 'Undo',
        action: () => {
          forgetTrustedImageModel(
            typeof localStorage === 'undefined' ? undefined : localStorage,
            warning.targetValue,
          );
        },
      });
    }
    if (warning.mode === 'model-switch') {
      applyModelSelection(warning.targetValue);
      if (!remember) toastStore.info('Model selected. Images will be included in the next send.');
      return;
    }
    void dispatchSend(
      warning.message ?? value.trim(),
      'allow',
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
    if (disabled || isTranscribing) return;
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
      // Text-only sends cannot change image admission. Avoid a redundant
      // model-preview round trip on every normal message; retain the backend
      // lookup whenever the transcript or outgoing attachments contain images.
      const historicalImages =
        currentImages === 0 && visibleTranscriptImageCount() === 0
          ? 0
          : await authoritativeContextImageCount(sendModelValue);
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
      const hasAllowConsent = hasImageAllowConsent(selectedModel);
      if (needsImageInputChoice(totalImages, model, hasOmitConsent || hasAllowConsent)) {
        imageFallbackWarning = {
          sessionId: sendSessionId,
          mode: 'send',
          targetValue: selectedModel,
          targetLabel: selectedModelLabel,
          imageCount: totalImages,
          historicalImageCount: historicalImages,
          message: trimmed,
        };
        return;
      }
      if (totalImages > 0 && hasAllowConsent) {
        await dispatchSend(trimmed, 'allow', historicalImages);
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

  function primaryAction() {
    if (isStopping) return;
    if (isRunning || isWaiting) {
      if (canSend) void send();
      else stop();
    } else void send();
  }

  const BASE_MIN_HEIGHT_PX = 88;
  const MAX_HEIGHT_PX = 280;

  function resizeToMin() {
    if (!inputRef) return;
    inputRef.style.height = 'auto';
    inputRef.style.height = BASE_MIN_HEIGHT_PX + 'px';
  }

  function autoResize() {
    if (!inputRef) return;
    inputRef.style.height = 'auto';
    const h = inputRef.scrollHeight;
    inputRef.style.height = Math.max(BASE_MIN_HEIGHT_PX, Math.min(h, MAX_HEIGHT_PX)) + 'px';
  }

  let composerMetricsFrame: number | null = null;

  /**
   * Re-measure the composer on the next frame, coalescing bursts.
   */
  function scheduleComposerMetrics(): void {
    if (typeof requestAnimationFrame === 'undefined') return;
    if (composerMetricsFrame !== null) return;
    composerMetricsFrame = requestAnimationFrame(() => {
      composerMetricsFrame = null;
      autoResize();
    });
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

  async function transcribeLocalRecording(
    samples: Float32Array,
    language: string,
    committed = '',
    router: DictationRouter | null = null,
  ) {
    isTranscribing = true;
    try {
      const text = samples.length
        ? ((await invoke<{ text: string }>('transcribe_local_voice', {
            pcmBase64: await pcm16Base64(samples),
            language,
            prompt: localTranscriptionPrompt(committed),
          })).text ?? '')
        : '';
      const transcript = mergeTranscript(committed, text);
      if (!transcript.trim()) throw new Error('No speech was detected');
      deliverCaptureSegment(router, transcript);
      finishCaptureRouting(router);
    } catch (error) {
      toastStore.error(error instanceof Error ? error.message : String(error));
    } finally {
      isTranscribing = false;
      finishTranscriptionUi();
    }
  }

  const LOCAL_PARTIAL_INTERVAL_MS = 900;
  const LOCAL_PARTIAL_MIN_NEW_SECONDS = 0.35;
  const LOCAL_PARTIAL_OVERLAP_SECONDS = 0.4;
  /** A capture this short is transcribed in one pass, which is the most accurate. */
  const LOCAL_ONE_SHOT_MAX_MS = 30_000;
  const VOICE_VOCABULARY_KEY = 'koryphaios.voice-vocabulary';

  function stopLocalPartialLoop() {
    if (localPartialTimer !== null) {
      clearInterval(localPartialTimer);
      localPartialTimer = null;
    }
    localPartialInFlight = false;
  }

  /** Names and jargon to spell the user's way, read when a pass is sent. */
  function storedVoiceVocabulary(): string {
    try {
      return typeof localStorage === 'undefined'
        ? ''
        : (localStorage.getItem(VOICE_VOCABULARY_KEY) ?? '').replace(/\s+/g, ' ').trim();
    } catch {
      return '';
    }
  }

  /**
   * `initial_prompt` text for a pass: the glossary, plus the words already
   * committed so a chunk that starts mid-sentence keeps the same voice. Whisper
   * formats use it to bias decoding; other local runtimes ignore it.
   */
  function localTranscriptionPrompt(committed = ''): string | undefined {
    const prompt = [storedVoiceVocabulary(), transcriptWords(committed).slice(-14).join(' ')]
      .filter(Boolean)
      .join(' ')
      .trim();
    return prompt ? prompt.slice(-480) : undefined;
  }

  function resetLiveTranscript() {
    localPartialCommitted = '';
    localPartialConsumedFrames = 0;
    voiceRecorder.setPartialText('');
  }

  /**
   * Transcribe the audio since the last pass and publish the running transcript.
   *
   * Only the new audio plus a short overlap is sent, so the work per pass stays
   * constant for the whole dictation instead of growing with it — the old pass
   * re-sent every word already spoken, so each caption took longer than the one
   * before. The overlap keeps a word that straddles two passes intact, and
   * `mergeTranscript` removes the words both passes heard.
   */
  async function publishLiveLocalTranscript(recorder: LocalPcmRecorder) {
    if (localPartialInFlight || activeLocalRecorder !== recorder) return;
    const captured = recorder.chunks.reduce((sum, chunk) => sum + chunk.length, 0);
    const requiredNew = Math.floor(recorder.sampleRate * LOCAL_PARTIAL_MIN_NEW_SECONDS);
    if (captured - localPartialConsumedFrames < requiredNew) return;
    const overlapFrames = Math.floor(recorder.sampleRate * LOCAL_PARTIAL_OVERLAP_SECONDS);
    const from = Math.max(0, localPartialConsumedFrames - overlapFrames);
    localPartialInFlight = true;
    try {
      const samples = resampleTo16Khz(
        sliceAudioChunks(recorder.chunks, from),
        recorder.sampleRate,
      );
      const result = await invoke<{ text: string }>('transcribe_local_voice', {
        pcmBase64: await pcm16Base64(samples),
        language: recorder.language,
        prompt: localTranscriptionPrompt(localPartialCommitted),
      });
      if (activeLocalRecorder === recorder && isRecording) {
        localPartialCommitted = mergeTranscript(localPartialCommitted, result.text ?? '');
        localPartialConsumedFrames = captured;
        voiceRecorder.setPartialText(localPartialCommitted);
      }
    } catch {
      // Best effort; the release pass still covers everything uncommitted.
    } finally {
      localPartialInFlight = false;
    }
  }

  function releaseLocalRecorder(recorder: LocalPcmRecorder) {
    stopLocalPartialLoop();
    recorder.processor.onaudioprocess = null;
    recorder.source.disconnect();
    recorder.processor.disconnect();
    recorder.sink.disconnect();
    recorder.tap?.release();
    recorder.stream.getTracks().forEach((track) => track.stop());
    void recorder.context.close();
  }

  /** Stop the elapsed-time readout and reset the recording clock. */
  function endRecordingUi() {
    if (recordingTimer !== null) {
      clearInterval(recordingTimer);
      recordingTimer = null;
    }
    recordingElapsedMs = 0;
    recordingStartedAt = 0;
    voiceRecorder.end();
  }

  /**
   * Keep the last captured waveform visible while the audio is transcribed.
   * The analyser is no longer read once the phase becomes transcribing, but its
   * reference lets the existing waveform canvas retain its measured history.
   */
  function beginTranscriptionUi(analyser: AnalyserNode | null, elapsedMs: number) {
    if (recordingTimer !== null) {
      clearInterval(recordingTimer);
      recordingTimer = null;
    }
    voiceRecorder.begin('transcribing', analyser, elapsedMs);
  }

  /**
   * Let the browser paint the frozen waveform before removing the strip. Local
   * transcription can finish in the same turn as the stop action, which would
   * otherwise batch the transcribing state away before it is ever visible.
   */
  function finishTranscriptionUi() {
    const clear = () => {
      // Do not let an older transcription clear a new capture that started
      // before the scheduled cleanup ran.
      if (voiceRecorder.state.phase === 'transcribing') voiceRecorder.end();
    };
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(clear);
    else setTimeout(clear, 0);
  }

  /** Start the elapsed-time readout for a recording that is now live. */
  function beginRecordingUi(tap: VoiceTap | null, phase: 'recording' | 'transcribing') {
    recordingStartedAt = Date.now();
    recordingElapsedMs = 0;
    voiceRecorder.begin(phase, tap?.analyser ?? null, 0);
    if (recordingTimer !== null) clearInterval(recordingTimer);
    recordingTimer = setInterval(() => {
      recordingElapsedMs = Date.now() - recordingStartedAt;
      voiceRecorder.setElapsed(recordingElapsedMs);
    }, 100);
  }

  function stopLocalRecording(transcribe = true) {
    const recorder = activeLocalRecorder;
    if (!recorder) return;
    activeLocalRecorder = null;
    isRecording = false;
    const elapsedMs = recordingElapsedMs;
    const waveformAnalyser = recorder.tap?.analyser ?? null;
    releaseLocalRecorder(recorder);
    const samples = resampleTo16Khz(combineAudioChunks(recorder.chunks), recorder.sampleRate);
    // A short capture is worth one careful pass. A long one has already been
    // transcribed as it was spoken, so only its uncommitted tail is left to do;
    // re-sending ten minutes of audio would make the final caption the slowest
    // one of all.
    const committed = localPartialCommitted.trim();
    const oneShot = !committed || elapsedMs <= LOCAL_ONE_SHOT_MAX_MS;
    const consumed16k = Math.round(
      (localPartialConsumedFrames * 16_000) / Math.max(1, recorder.sampleRate),
    );
    const from = oneShot
      ? 0
      : Math.max(0, consumed16k - Math.floor(16_000 * LOCAL_PARTIAL_OVERLAP_SECONDS));
    if (transcribe && samples.length) {
      beginTranscriptionUi(waveformAnalyser, elapsedMs);
      void transcribeLocalRecording(
        samples.slice(from),
        recorder.language,
        oneShot ? '' : committed,
        recorder.router,
      );
    } else {
      endRecordingUi();
    }
    resetLiveTranscript();
  }

  async function startLocalRecording(settings: VoiceSettings) {
    if (!navigator.mediaDevices?.getUserMedia)
      throw new Error('Microphone recording is unavailable in this runtime');
    if (!(await requestMicrophoneConsent())) return;
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
    // The tap hangs off the same context as the recorder so the waveform and the
    // captured PCM come from one graph.
    const tapped = createVoiceTap(stream, context);
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
      tap: tapped?.tap ?? null,
      router: activeCaptureRouter,
    };
    isRecording = true;
    resetLiveTranscript();
    beginRecordingUi(tapped?.tap ?? null, 'recording');
    localPartialTimer = setInterval(() => {
      const recorder = activeLocalRecorder;
      if (recorder) void publishLiveLocalTranscript(recorder);
    }, LOCAL_PARTIAL_INTERVAL_MS);
  }

  async function loadComposerVoiceSettings(): Promise<VoiceSettings> {
    const response = await apiFetch(apiUrl('/api/voice/settings'));
    const result = await response.json();
    if (!response.ok || !result.data)
      throw new Error(result.error || 'Could not load voice settings');
    voiceSettings = result.data;
    return voiceSettings!;
  }

  /** Start routing a new capture: dictation, or a conductor command. */
  function beginCaptureRouting(mode: CaptureMode): DictationRouter {
    const router = voiceConductor.createRouter(mode, (next) => voiceRecorder.setMode(next));
    activeCaptureRouter = router;
    voiceRecorder.setMode(router.mode);
    return router;
  }

  /** Hand one final transcript segment to the router: dictation reaches the
   *  composer, a conductor command is held until the capture ends. */
  function deliverCaptureSegment(router: DictationRouter | null, transcript: string) {
    const forComposer = router ? router.push(transcript) : transcript;
    if (forComposer) appendTranscription(forComposer);
  }

  function finishCaptureRouting(router: DictationRouter | null) {
    if (!router) return;
    if (activeCaptureRouter === router) activeCaptureRouter = null;
    const command = router.finish();
    if (command !== null) void voiceConductor.handleUtterance(command);
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

  /**
   * Koryphaios asks first, the way the platform prompt does: a consent sheet
   * before any getUserMedia call so the microphone is never opened silently.
   * An OS-level grant skips it; an OS-level denial falls through to
   * getUserMedia so its actionable System Settings message is what the user
   * reads, instead of a prompt the platform would ignore anyway.
   */
  const MICROPHONE_CONSENT_KEY = 'koryphaios.microphone-consent';
  let microphoneConsentOpen = $state(false);
  let resolveMicrophoneConsent: ((granted: boolean) => void) | null = null;

  async function requestMicrophoneConsent(): Promise<boolean> {
    try {
      if (localStorage.getItem(MICROPHONE_CONSENT_KEY) === 'granted') return true;
    } catch {
      // Private mode blocks storage: fall through to the prompt.
    }
    try {
      const status = navigator.permissions
        ? await navigator.permissions.query({ name: 'microphone' } as PermissionDescriptor)
        : null;
      if (status?.state === 'granted' || status?.state === 'denied') return true;
    } catch {
      // Runtimes without the Permissions API still get the consent sheet.
    }
    return new Promise<boolean>((resolve) => {
      resolveMicrophoneConsent = resolve;
      microphoneConsentOpen = true;
    });
  }

  function settleMicrophoneConsent(granted: boolean) {
    microphoneConsentOpen = false;
    if (granted) {
      try {
        localStorage.setItem(MICROPHONE_CONSENT_KEY, 'granted');
      } catch {
        // The choice still applies for this attempt when storage is blocked.
      }
    } else {
      toastStore.info('Microphone access was declined. Press Allow to record a voice prompt.');
    }
    const resolve = resolveMicrophoneConsent;
    resolveMicrophoneConsent = null;
    resolve?.(granted);
  }

  /**
   * Translate a getUserMedia failure into something actionable. The raw
   * DOMException text ("The request is not allowed by the user agent or the
   * platform in the current context…") reads like a broken provider, but it
   * almost always means the OS-level microphone grant for Koryphaios is
   * missing: macOS never re-prompts once denied, so the user has to flip it in
   * System Settings themselves.
   */
  function microphoneErrorMessage(error: unknown): string {
    const name =
      error instanceof DOMException
        ? error.name
        : error instanceof Error && error.name
          ? error.name
          : '';
    if (name === 'NotAllowedError')
      return 'Microphone access was denied. Allow the microphone for Koryphaios in System Settings › Privacy & Security › Microphone, then try again.';
    if (
      name === 'NotFoundError' ||
      name === 'DevicesNotFoundError' ||
      name === 'OverconstrainedError'
    )
      return 'No microphone was found. Connect a microphone and try again.';
    if (name === 'NotReadableError' || name === 'AbortError')
      return 'The microphone is already in use by another app. Close it and try again.';
    if (name === 'SecurityError')
      return 'Microphone capture is blocked in this window. Restart the desktop app and try again.';
    if (error instanceof Error && error.message) return error.message;
    return 'Could not access the microphone';
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

  async function startSystemRecognition(settings: VoiceSettings, router: DictationRouter | null) {
    const speechWindow = window as typeof window & {
      SpeechRecognition?: BrowserSpeechRecognitionConstructor;
      webkitSpeechRecognition?: BrowserSpeechRecognitionConstructor;
    };
    const Recognition = speechWindow.SpeechRecognition ?? speechWindow.webkitSpeechRecognition;
    if (!Recognition) throw new Error('System speech recognition is unavailable in this runtime');
    if (!(await requestMicrophoneConsent())) return;
    const stream = navigator.mediaDevices?.getUserMedia
      ? await navigator.mediaDevices.getUserMedia({ audio: true })
      : null;
    const tapped = stream ? createVoiceTap(stream) : null;
    const releaseTap = () => {
      tapped?.tap.release();
      if (tapped) void tapped.context.close();
      stream?.getTracks().forEach((track) => track.stop());
    };
    const recognition = new Recognition();
    recognition.lang = settings.input.language;
    recognition.continuous = true;
    // Interim results are what make dictation readable as it is spoken.
    recognition.interimResults = true;
    recognition.onresult = (event) => {
      let interim = '';
      for (let index = event.resultIndex; index < event.results.length; index += 1) {
        const result = event.results[index];
        if (!result) continue;
        const transcript = result[0]?.transcript ?? '';
        if (result.isFinal) {
          if (transcript.trim()) deliverCaptureSegment(router, transcript);
        } else {
          interim += transcript;
        }
      }
      voiceRecorder.setPartialText(interim.trim());
    };
    recognition.onerror = (event) => {
      if (event.error !== 'aborted' && event.error !== 'no-speech')
        toastStore.error(speechRecognitionErrorMessage(event.error));
    };
    recognition.onend = () => {
      releaseTap();
      finishCaptureRouting(router);
      if (activeSpeechRecognition === recognition) activeSpeechRecognition = null;
      isRecording = false;
      endRecordingUi();
    };
    activeSpeechRecognition = recognition;
    try {
      recognition.start();
    } catch (error) {
      activeSpeechRecognition = null;
      releaseTap();
      throw error;
    }
    isRecording = true;
    beginRecordingUi(tapped?.tap ?? null, 'recording');
  }

  async function transcribeRecording(
    blob: Blob,
    language: string,
    elapsedMs: number,
    router: DictationRouter | null = null,
  ) {
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
      deliverCaptureSegment(router, result.data.text);
      finishCaptureRouting(router);
    } catch (error) {
      toastStore.error(error instanceof Error ? error.message : 'Transcription failed');
    } finally {
      isTranscribing = false;
      finishTranscriptionUi();
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

  /** Clicking the mic toggles capture. */
  async function toggleRecording() {
    if (stopRecording()) return;
    if (voiceStarting) return;
    voiceStarting = true;
    try {
      await startRecording();
    } finally {
      voiceStarting = false;
    }
  }

  /**
   * Push-to-talk: the shortcut records only while it is held. A release that
   * arrives before the microphone finished opening cancels nothing — the
   * capture is stopped as soon as startup settles, so a tap cannot leave a
   * recorder running in the background.
   */
  async function beginVoiceHold(mode: CaptureMode = 'dictation') {
    if (voiceHeld) return;
    if (mode === 'conductor' && !voiceConductor.enabled) return;
    if (disabled || imageAdmissionPending || configurationWarning || isTranscribing) return;
    if (isRecording || voiceStarting) return;
    voiceHeld = true;
    heldCaptureMode = mode;
    voiceStarting = true;
    try {
      await startRecording(true, () => voiceHeld, mode);
    } finally {
      voiceStarting = false;
    }
    if (!isRecording) {
      // The hold ended without a capture (declined consent, uninstalled local
      // model, or released while starting). Do not leave the binding latched.
      voiceHeld = false;
      return;
    }
    if (!voiceHeld) stopRecording();
  }

  function endVoiceHold() {
    voiceHeld = false;
    // A start still in flight checks `voiceHeld` when it settles.
    if (voiceStarting) return;
    stopRecording();
  }

  async function startRecording(
    enableVoiceMode = false,
    stillWanted = () => true,
    mode: CaptureMode = 'dictation',
  ) {
    const router = beginCaptureRouting(mode);
    try {
      let settings = await loadComposerVoiceSettings();
      if (!stillWanted()) return;
      if (!settings.voiceModeEnabled && enableVoiceMode) {
        const response = await apiFetch(apiUrl('/api/voice/settings'), {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ ...settings, voiceModeEnabled: true }),
        });
        const result = await response.json();
        if (!response.ok || !result.data)
          throw new Error(result.error || 'Could not enable voice mode');
        settings = result.data;
        voiceSettings = settings;
        window.dispatchEvent(
          new CustomEvent('koryphaios:voice-settings-changed', { detail: settings }),
        );
      }
      if (!stillWanted()) return;
      if (!settings.voiceModeEnabled)
        throw new Error('Enable the composer microphone in Voice settings first');
      if (settings.input.provider === 'kory-local') {
        let localStatus: LocalVoiceModelStatus;
        try {
          localStatus = await invoke<LocalVoiceModelStatus>('local_voice_model_status');
        } catch {
          onOpenSettings?.('voice');
          return;
        }
        if (!localStatus.installed) {
          onOpenSettings?.('voice');
          return;
        }
        if (!stillWanted()) return;
        await startLocalRecording(settings);
        return;
      }
      if (settings.input.provider === 'system') {
        await startSystemRecognition(settings, router);
        return;
      }
      if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined')
        throw new Error('Microphone recording is unavailable in this runtime');
      if (!(await requestMicrophoneConsent())) return;
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const chunks: BlobPart[] = [];
      const type = audioMimeType();
      const recorder = new MediaRecorder(stream, type ? { mimeType: type } : undefined);
      // A tap is only for the waveform, so a context it created is closed with
      // the recording rather than left running.
      const tapped = createVoiceTap(stream);
      activeRecorder = recorder;
      recorder.ondataavailable = (event) => {
        if (event.data.size) chunks.push(event.data);
      };
      recorder.onstop = () => {
        stream.getTracks().forEach((track) => track.stop());
        const blob = new Blob(chunks, { type: recorder.mimeType || type || 'audio/webm' });
        activeRecorder = null;
        isRecording = false;
        const elapsedMs = recordingElapsedMs;
        const waveformAnalyser = tapped?.tap.analyser ?? null;
        if (blob.size) beginTranscriptionUi(waveformAnalyser, elapsedMs);
        else endRecordingUi();
        if (tapped) {
          tapped.tap.release();
          void tapped.context.close();
        }
        if (blob.size)
          void transcribeRecording(blob, settings.input.language || 'en', elapsedMs, router);
      };
      recorder.start();
      isRecording = true;
      beginRecordingUi(tapped?.tap ?? null, 'recording');
    } catch (error) {
      toastStore.error(microphoneErrorMessage(error));
    }
  }

  onMount(() => {
    if (typeof window === 'undefined') return;

    // Global Esc listener to stop running agent
    const handleGlobalEsc = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && showFastMenu) {
        showFastMenu = false;
        return;
      }
      if (e.key === 'Escape' && showModelParametersMenu) {
        showModelParametersMenu = false;
        return;
      }
      if (e.key === 'Escape' && showFusionSlot1Menu) {
        showFusionSlot1Menu = false;
        return;
      }
      if (e.key === 'Escape' && showFusionSlot2Menu) {
        showFusionSlot2Menu = false;
        return;
      }
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
    // Keyboard/native edges toggle the same capture as the microphone button.
    let disposed = false;
    const voiceBlocked = () =>
      disabled || imageAdmissionPending || !!configurationWarning || isTranscribing;
    const voiceOnNativeFn = () => {
      const keys = shortcutStore.keys('voice_mode');
      return keys.length === 1 && keys[0].toLowerCase() === 'fn';
    };
    const handleVoiceShortcutDown = (e: KeyboardEvent) => {
      if (e.repeat) return;
      // The conductor chord is checked first: it is a superset of nothing the
      // dictation chord uses by default, but a user may bind them close.
      const conductor = voiceConductor.enabled && shortcutStore.matches('voice_conductor', e);
      if (!conductor && !shortcutStore.matches('voice_mode', e)) return;
      if (voiceBlocked()) return;
      e.preventDefault();
      void beginVoiceHold(conductor ? 'conductor' : 'dictation');
    };
    /** True when a released key is part of the held binding. `Mod` is Meta on
     *  macOS and Control elsewhere, so the modifier names are mapped here. */
    const releasesHeldBinding = (e: KeyboardEvent) => {
      const id = heldCaptureMode === 'conductor' ? 'voice_conductor' : 'voice_mode';
      const keys = shortcutStore.keys(id).map((key) => key.toLowerCase());
      const released = e.key.toLowerCase();
      if (keys.includes(released)) return true;
      if (released === 'control') return keys.includes('ctrl') || (!isMac() && keys.includes('mod'));
      if (released === 'meta') return keys.includes('meta') || (isMac() && keys.includes('mod'));
      return false;
    };
    // Releasing either half of the chord ends the hold. Requiring the exact
    // chord here would leave the capture running whenever the user let go of
    // the modifier before the target key.
    const handleVoiceShortcutUp = (e: KeyboardEvent) => {
      if (!voiceHeld) return;
      if (!releasesHeldBinding(e)) return;
      e.preventDefault();
      endVoiceHold();
    };
    // A release outside the window never reaches a keyup listener; without this
    // the microphone would stay open after an alt-tab.
    const handleVoiceBlur = () => {
      if (voiceHeld) endVoiceHold();
    };
    window.addEventListener('keydown', handleVoiceShortcutDown);
    window.addEventListener('keyup', handleVoiceShortcutUp);
    window.addEventListener('blur', handleVoiceBlur);
    // macOS never delivers fn/Globe to a webview, so the Tauri shell can still
    // relay a customized Fn binding. Both edges are relayed for hold-to-talk.
    const inTauri = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
    const nativeUnlisteners: (() => void)[] = [];
    if (inTauri) {
      void import('@tauri-apps/api/event').then(({ listen }) => {
        if (disposed) return;
        const retain = (unlisten: () => void) => {
          if (disposed) unlisten();
          else nativeUnlisteners.push(unlisten);
        };
        void listen('voice://fn-down', () => {
          if (voiceOnNativeFn()) void beginVoiceHold();
        }).then(retain);
        void listen('voice://fn-up', () => {
          if (voiceOnNativeFn()) endVoiceHold();
        }).then(retain);
      });
    }
    const handleVoiceSettingsChanged = (event: Event) => {
      voiceSettings = (event as CustomEvent<VoiceSettings>).detail;
    };
    window.addEventListener('koryphaios:voice-settings-changed', handleVoiceSettingsChanged);
    void loadComposerVoiceSettings().catch(() => {
      voiceSettings = null;
    });

    const handleWindowResize = () => {
      scheduleComposerMetrics();
    };

    window.addEventListener('resize', handleWindowResize);
    scheduleComposerMetrics();

    return () => {
      disposed = true;
      if (composerMetricsFrame !== null) cancelAnimationFrame(composerMetricsFrame);
      composerMetricsFrame = null;
      window.removeEventListener('resize', handleWindowResize);
      window.removeEventListener('keydown', handleGlobalEsc);
      window.removeEventListener('keydown', handleVoiceShortcutDown);
      window.removeEventListener('keyup', handleVoiceShortcutUp);
      window.removeEventListener('blur', handleVoiceBlur);
      window.removeEventListener('koryphaios:voice-settings-changed', handleVoiceSettingsChanged);
      nativeUnlisteners.forEach((unlisten) => unlisten());
      activeSpeechRecognition?.abort();
      if (activeLocalRecorder) stopLocalRecording(false);
      if (activeRecorder?.state !== 'inactive') activeRecorder?.stop();
      activeRecorder?.stream.getTracks().forEach((track) => track.stop());
      // An unmount mid-capture must not leave the strip showing live levels.
      voiceRecorder.end();
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
    if (
      oneShotImageAllowConsents.size > 0 &&
      !(oneShotImageAllowConsents.size === 1 && oneShotImageAllowConsents.has(targetConsentKey))
    ) {
      oneShotImageAllowConsents = oneShotImageAllowConsents.has(targetConsentKey)
        ? new Set([targetConsentKey])
        : new Set();
    }
    selectedModel = value;
    showModelPicker = false;
    if (typeof localStorage !== 'undefined') localStorage.setItem(MODEL_STORAGE_KEY, value);
    // The selectedModel effect is the single owner of preview requests. A
    // second call here used to race the effect and briefly replace the new
    // model's context meter with an older response.
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
      if (
        target &&
        needsImageInputChoice(
          imageCount,
          target,
          hasImageOmitConsent(value) || hasImageAllowConsent(value),
        )
      ) {
        showModelPicker = false;
        imageFallbackWarning = {
          sessionId: selectionSessionId,
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
    void refreshFreebuffAccount();
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

  function selectSpeedTier(next: string | null): void {
    speedTier = next;
    showFastMenu = false;
  }

  function modelParameterNumber(def: ModelParameterDef): number {
    const v = modelParameterValues[def.key];
    if (typeof v === 'number') return v;
    if (typeof def.default === 'number') return def.default;
    return def.min ?? 0;
  }

  /** The value as the slider readout shows it — the override or, when unset,
   *  the default in the same numeric format. */
  function modelParameterFormattedValue(def: ModelParameterDef): string {
    const v = modelParameterNumber(def);
    return def.kind === 'float' ? v.toFixed(2) : String(Math.round(v));
  }

  /** Hover copy for parameters whose names are easy to confuse (verbosity vs
   *  reasoning effort) or whose unset state is not obvious. */
  function modelParameterHint(def: ModelParameterDef): string {
    switch (def.key) {
      case 'max_tokens':
        return "Caps how many tokens the model may generate in one reply. With Force max off, the model's own maximum is used (∞).";
      case 'seed':
        return 'Makes sampling repeatable: the same prompt and seed tend to produce the same output. Some providers ignore it.';
      case 'verbosity':
        return 'Controls how long and detailed replies are. It is not reasoning effort: verbosity changes the answer, while thinking controls how much the model deliberates before answering.';
      default:
        return def.description;
    }
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
    // Git's expand/collapse control is a neighboring composer control, not a
    // model-selection dismissal action. Keep the picker open while the Git
    // panel is opened or closed.
    if (!target.closest('.model-picker') && !target.closest('.git-workspace'))
      showModelPicker = false;
    if (!target.closest('.reasoning-picker')) showReasoningMenu = false;
    if (!target.closest('.fast-mode-picker')) showFastMenu = false;
    if (!target.closest('.model-params-picker')) showModelParametersMenu = false;
    if (!target.closest('.fusion-slot-1-picker')) showFusionSlot1Menu = false;
    if (!target.closest('.fusion-slot-2-picker')) showFusionSlot2Menu = false;
    if (!target.closest('.reference-picker')) showReferenceMenu = false;
    if (!target.closest('.permission-picker')) showPermissionMenu = false;
    if (!target.closest('.agent-mode-picker')) showAgentModeMenu = false;
    if (!target.closest('.more-actions-picker')) showGoalActions = false;
  }

  let canSend = $derived(
    !disabled &&
      !isTranscribing &&
      !imageAdmissionPending &&
      (value.trim().length > 0 || attachments.length > 0),
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
  let effectiveCriticMode = $derived(
    resolveCriticMode(chatAgentOverrides, resolveCriticMode(agentSettingsStore.settings)),
  );

  /** The composer's critic control doubles as the default for new chats.
   *
   *  It used to be a per-chat override only, so choosing a mode here left every
   *  later chat on the project default — the choice never reached the value new
   *  sessions inherit. Persist it as the project default (which a chat without
   *  its own override reads) while still pinning this chat, and say so: silently
   *  changing a workspace-wide default would be worse than not changing it. */
  function selectCriticMode(criticMode: CriticMode) {
    const criticGateEnabled = criticMode !== 'off';
    setChatAgentOverrides({ criticMode, criticGateEnabled });
    const label =
      CRITIC_MODE_OPTIONS.find((option) => option.value === criticMode)?.label ?? criticMode;
    void agentSettingsStore
      .saveSettings({ criticMode, criticGateEnabled }, { quietSuccess: true })
      .then((saved) => {
        // A failed save is already reported by the settings store.
        if (!saved) return;
        toastStore.success(`Critic ${label} — this chat and new chats`);
      });
  }

  let agentExecutionModeMeta = $derived(agentModeMetaFor(effectiveAgentExecutionMode));

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

  /** Force-paste image from OS clipboard (bypasses text). Used by the
   *  platform-correct Mod+Shift+V chord and the paste-image button. */
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
      // the Tauri clipboard path for an ordinary paste as well.
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

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div
  class="command-input px-2 py-2 sm:px-4 sm:py-3"
  onpaste={handlePaste}
  ondrop={handleMediaDrop}
  ondragover={(event) => {
    if (event.dataTransfer?.types.includes('Files')) event.preventDefault();
  }}
>
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
  {#if !disabled && !configurationWarning && interruptedRunId}
    <div
      class="mb-2 flex flex-wrap items-center gap-2 rounded-md px-3 py-2"
      style="background: var(--color-surface-2); border: 1px solid var(--color-border);"
      data-testid="composer-restart-resume"
    >
      <span class="min-w-48 flex-1 text-xs text-[var(--color-text-secondary)]"
        >The last turn stopped when Koryphaios restarted.</span
      >
      <button
        type="button"
        class="shrink-0 rounded px-2 py-1 text-xs font-medium text-[var(--color-accent)] hover:bg-[var(--color-surface-3)]"
        onclick={() => void resumeInterruptedTurn()}
        title={RESUME_PROMPT}>Resume</button
      >
      <button
        type="button"
        class="shrink-0 rounded p-1 text-[var(--color-text-muted)] hover:bg-[var(--color-surface-3)]"
        aria-label="Dismiss"
        onclick={() => (dismissedInterruptedRunId = interruptedRunId)}><X size={13} /></button
      >
    </div>
  {/if}
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
    class="composer-card rounded-xl border px-2 py-2 sm:px-4 sm:py-3"
    style="background: var(--color-surface-1); border-color: var(--color-border);"
  >
    {#if goalDisplayStore.composer && showGoalComposer}
      <div
        class="mb-3 rounded-lg px-2 py-2"
        style="background: color-mix(in srgb, var(--color-accent) 4%, var(--color-surface-1));"
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
          <p class="min-w-0 flex-1 text-[11px] text-[var(--color-text-muted)]">
            {agentSettingsStore.settings.automaticGoalDriving
              ? 'Starts automatically with the selected composer model and continues until done, paused, stopped, or genuinely blocked.'
              : 'Automatic start is off. The goal will wait until you press Start.'}
          </p>
        </div>
        {#if goalDraftRecovered}
          <p class="mt-1.5 text-[11px] text-[var(--color-success)]">
            Recovered unsent goal draft on this device.
          </p>
        {/if}
        {#if goalError}<p class="mt-1.5 text-xs text-[var(--color-error)]" role="alert">
            {goalError}
          </p>{/if}
      </div>
    {/if}

    <ChecklistPanel open={showChecklists} onDismiss={() => (showChecklists = false)} />
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
          ><span class="block truncate text-[11px] text-[var(--color-text-muted)]"
            >{workflowStatus.status} · {workflowStatus.task}</span
          ></span
        >
      </button>
    {/if}

    <!-- Input area -->
    <div class="min-w-0">
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
              style="border-color: var(--color-border); width: {attachment.type === 'image'
                ? '64px'
                : 'min(100%, 360px)'};"
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
                    class="h-16 w-16 object-cover transition-transform duration-200 group-hover:scale-105"
                  />
                </button>
              {:else}
                <MediaAttachment
                  data={attachment.data}
                  name={attachment.name}
                  mimeType={attachment.mimeType}
                />
                {#if chatMediaKind(attachment.mimeType) === 'audio'}
                  <button
                    type="button"
                    class="px-3 pb-2 text-xs text-[var(--color-accent)]"
                    disabled={isTranscribing || imageAdmissionPending}
                    title="Replace this audio attachment with editable speech-to-text using your Voice settings"
                    onclick={() => void useAudioTranscript(attachment)}
                    >{isTranscribing ? 'Transcribing…' : 'Use transcript'}</button
                  >
                {/if}
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
        class="input block w-full"
        data-testid="composer-input"
        disabled={disabled || imageAdmissionPending}
        style="resize: none; min-height: {BASE_MIN_HEIGHT_PX}px; max-height: 280px; font-size: 15px; line-height: 1.6; box-sizing: border-box; padding: 10px 12px; background: transparent; border: none; box-shadow: none; {disabled ||
        imageAdmissionPending
          ? 'opacity: 0.6; cursor: not-allowed;'
          : ''}"
      ></textarea>
    </div>

    <!-- Bottom toolbar: Configuration, attachments, agent modes, and send -->
    <div
      class="composer-config-row mt-3 flex flex-wrap items-center gap-2"
      data-testid="composer-config-row"
      use:toolbarCollapse
    >
      <!-- Model selector -->
      <div class="relative model-picker" data-testid="composer-model-control">
        <button
          type="button"
          class="model-picker-trigger flex min-h-9 items-center gap-2 rounded-lg px-3 text-sm font-medium transition-colors hover:brightness-110"
          aria-expanded={showModelPicker}
          aria-label={selectedModel ? `Model: ${selectedModelLabel}` : 'Select model'}
          title={selectedModel ? `Model: ${selectedModelLabel}` : 'Select model'}
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
          <!-- Rank 9 hides the whole name and its chevron; rank 8 only caps the
               name's width first. The outer span is what rank 9 hides, so the
               inner truncation never has to undo a hide. -->
          <span class="composer-model-name" data-collapse-rank="9">
            <span
              class="composer-control-label composer-model-label"
              data-collapse-rank="8"
              data-collapse-mode="truncate">{selectedModelShortLabel}</span
            >
          </span>
          <ChevronDown size={14} class="text-text-muted" data-collapse-rank="9" />
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
                        <div class="flex min-w-0 flex-1 items-center gap-2">
                          <ProviderIcon provider={group.provider} size={16} class="shrink-0" />
                          <span class="min-w-0 truncate text-sm font-medium">{group.label}</span>
                          <span class="text-xs text-[var(--color-text-muted)]"
                            >({group.models.length})</span
                          >
                        </div>
                        <div class="ml-auto flex shrink-0 items-center gap-1.5">
                          <span
                            class="flex h-5 w-5 shrink-0 items-center justify-center text-[var(--color-text-muted)]"
                          >
                            {#if isSearchingModels || expandedProviders.has(group.provider)}
                              <ChevronDown size={14} />
                            {:else}
                              <ChevronRight size={14} />
                            {/if}
                          </span>
                        </div>
                      </button>
                      {#if group.provider === 'freebuff' && freebuffAccountRows[0]?.snapshot}
                        <div class="px-3 pb-1.5 pl-10">
                          <FreebuffBalance
                            account={freebuffAccountRows[0].snapshot}
                            variant="compact"
                          />
                        </div>
                      {/if}
                      {#if isSearchingModels || expandedProviders.has(group.provider)}
                        <div class="pb-1">
                          {#each group.models as model (model.value)}
                            {@const providerRate =
                              model.provider === 'freebuff'
                                ? formatFreebuffProviderRate(
                                    freebuffProviderRateForSelection(
                                      model.value,
                                      model.freebuckCost,
                                    ),
                                  )
                                : undefined}
                            <button
                              type="button"
                              class="w-full text-left pl-10 pr-3 py-2 text-sm leading-tight transition-colors hover:bg-[var(--color-surface-3)] flex items-center gap-2 {selectedModel ===
                              model.value
                                ? 'text-[var(--color-accent)]'
                                : ''}"
                              style="color: {selectedModel === model.value
                                ? 'var(--color-accent)'
                                : 'var(--color-text-secondary)'};"
                              onclick={() => selectModel(model.value)}
                            >
                              <span class="min-w-0 flex-1 truncate">
                                {model.name}
                                {#if model.fusion}
                                  <span
                                    class="block truncate text-[11px] font-normal"
                                    style="color: var(--color-text-muted);"
                                  >
                                    Two models: lead + sidekick{#if fusionSelection}
                                      {' '}· {model.fusion.leads.find((l) => l.id === fusionSelection?.lead)
                                        ?.name ?? fusionSelection.lead} + {model.fusion.sidekicks.find(
                                        (sk) => sk.id === fusionSelection?.sidekick,
                                      )?.name ?? fusionSelection.sidekick}{/if}
                                  </span>
                                {/if}
                              </span>
                              {#if model.provider === 'freebuff'}
                                {#if providerRate !== undefined}
                                  <span
                                    class="shrink-0 text-right text-[11px] font-medium text-[var(--color-accent)]"
                                    title="Provider-reported model rate"
                                  >
                                    {providerRate}
                                  </span>
                                {/if}
                              {/if}
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

      <!-- Devin Fusion: one model, two editable slots -->
      {#if fusionCatalog && fusionSelection}
        {@const sel = fusionSelection}
        <div class="relative fusion-slot-1-picker" data-testid="fusion-slot-1">
          <button
            type="button"
            class="fast-mode-control flex min-h-9 items-center gap-2 rounded-lg px-3 text-sm font-medium transition-colors hover:brightness-110"
            style="background: var(--color-surface-3); color: var(--color-text-primary); border: 1px solid var(--color-border);"
            aria-haspopup="dialog"
            aria-expanded={showFusionSlot1Menu}
            aria-label={fusionSlotChipLabel(1)}
            title={fusionSlotChipLabel(1)}
            onclick={() => {
              showFusionSlot1Menu = !showFusionSlot1Menu;
              showFusionSlot2Menu = false;
            }}
          >
            <span class="fusion-slot-badge" aria-hidden="true"
              >1{#if sel.leadFast}<Zap size={9} fill="currentColor" />{/if}</span
            >
            <span class="composer-control-label" data-collapse-rank="3"
              >{fusionLeadDef?.name ?? sel.lead} · {fusionEffortLabel(sel.leadEffort)}</span
            >
            <ChevronDown size={14} class="text-text-muted" data-collapse-rank="3" />
          </button>

          {#if showFusionSlot1Menu}
            <div
              class="absolute bottom-full left-0 mb-2 w-[min(22rem,calc(100vw-2rem))] rounded-xl border shadow-2xl z-50 overflow-hidden backdrop-blur-md"
              style="background: var(--color-surface-2); border-color: var(--color-border);"
              role="dialog"
              aria-label="Fusion 1 · Lead"
            >
              <div
                class="px-4 py-2.5 text-xs font-medium"
                style="color: var(--color-text-secondary); border-bottom: 1px solid var(--color-border);"
              >
                Fusion 1 · Lead
              </div>
              <div class="max-h-[60vh] overflow-y-auto px-4 py-3 space-y-4">
                <div>
                  <div class="text-xs font-medium text-[var(--color-text-primary)]">Model</div>
                  <div class="mt-1.5 space-y-0.5">
                    {#each fusionCatalog.leads as lead (lead.id)}
                      <button
                        type="button"
                        role="menuitemradio"
                        aria-checked={sel.lead === lead.id}
                        class="w-full text-left rounded-lg px-2.5 py-2 text-sm transition-colors hover:bg-[var(--color-surface-3)] {sel.lead ===
                        lead.id
                          ? 'text-[var(--color-accent)]'
                          : 'text-[var(--color-text-primary)]'}"
                        onclick={() => applyFusionChange('lead', { lead: lead.id })}
                      >
                        <div class="flex items-center justify-between">
                          <span class="font-medium">{lead.name}</span>
                          {#if sel.lead === lead.id}
                            <Check size={14} class="text-[var(--color-accent)]" />
                          {/if}
                        </div>
                      </button>
                    {/each}
                  </div>
                </div>
                <div>
                  <div class="text-xs font-medium text-[var(--color-text-primary)]">
                    Reasoning
                  </div>
                  {#if fusionLeadDef && fusionLeadDef.efforts.length > 1}
                    <div
                      class="mt-1.5 flex rounded-lg p-0.5"
                      style="background: var(--color-surface-3);"
                      role="radiogroup"
                      aria-label="Fusion 1 reasoning"
                    >
                      {#each fusionLeadDef.efforts as effort (effort)}
                        <button
                          type="button"
                          role="radio"
                          aria-checked={sel.leadEffort === effort}
                          class="flex-1 rounded-md px-2 py-1 text-xs font-medium transition-colors {sel.leadEffort ===
                          effort
                            ? 'text-[var(--color-accent)]'
                            : 'text-[var(--color-text-secondary)]'}"
                          style={sel.leadEffort === effort
                            ? 'background: var(--color-surface-2);'
                            : ''}
                          onclick={() => applyFusionChange('leadEffort', { leadEffort: effort })}
                        >
                          {fusionEffortLabel(effort)}
                        </button>
                      {/each}
                    </div>
                  {:else if fusionLeadDef && fusionLeadDef.efforts.length === 1}
                    <div class="mt-1.5 text-xs" style="color: var(--color-text-muted);">
                      {fusionEffortLabel(fusionLeadDef.efforts[0])} · set by Devin
                    </div>
                  {:else}
                    <div class="mt-1.5 text-xs" style="color: var(--color-text-muted);">
                      No reasoning tier
                    </div>
                  {/if}
                </div>
                <div>
                  <div class="text-xs font-medium text-[var(--color-text-primary)]">Fast</div>
                  {#if fusionAnyFastPairing}
                    <div
                      class="mt-1.5 flex rounded-lg p-0.5"
                      style="background: var(--color-surface-3);"
                      role="radiogroup"
                      aria-label="Fusion 1 Fast"
                    >
                      {#each [false, true] as on (String(on))}
                        <button
                          type="button"
                          role="radio"
                          aria-checked={sel.leadFast === on}
                          class="flex-1 rounded-md px-2 py-1 text-xs font-medium transition-colors {sel.leadFast ===
                          on
                            ? 'text-[var(--color-accent)]'
                            : 'text-[var(--color-text-secondary)]'}"
                          style={sel.leadFast === on ? 'background: var(--color-surface-2);' : ''}
                          onclick={() => applyFusionChange('leadFast', { leadFast: on })}
                        >
                          {on ? 'On' : 'Off'}
                        </button>
                      {/each}
                    </div>
                  {:else}
                    <div class="mt-1.5 text-xs" style="color: var(--color-text-muted);">
                      No fast pairing for this lead.
                    </div>
                  {/if}
                </div>
                {#if fusionAdjustedNote}
                  <div
                    class="rounded-lg border border-[var(--color-info)]/30 bg-[var(--color-info-bg)]/40 px-2.5 py-2 text-xs text-[var(--color-text-primary)]"
                  >
                    {fusionAdjustedNote}
                  </div>
                {/if}
              </div>
              {#if fusionMetaSummary()}
                <div
                  class="px-4 py-2 text-[11px]"
                  style="color: var(--color-text-muted); border-top: 1px solid var(--color-border);"
                >
                  {fusionMetaSummary()}
                </div>
              {/if}
            </div>
          {/if}
        </div>

        <div class="relative fusion-slot-2-picker" data-testid="fusion-slot-2">
          <button
            type="button"
            class="fast-mode-control flex min-h-9 items-center gap-2 rounded-lg px-3 text-sm font-medium transition-colors hover:brightness-110"
            style="background: var(--color-surface-3); color: var(--color-text-primary); border: 1px solid var(--color-border);"
            aria-haspopup="dialog"
            aria-expanded={showFusionSlot2Menu}
            aria-label={fusionSlotChipLabel(2)}
            title={fusionSlotChipLabel(2)}
            onclick={() => {
              showFusionSlot2Menu = !showFusionSlot2Menu;
              showFusionSlot1Menu = false;
            }}
          >
            <span class="fusion-slot-badge" aria-hidden="true">2</span>
            <span class="composer-control-label" data-collapse-rank="5"
              >{fusionSidekickDef?.name ?? sel.sidekick}{#if sel.sidekickEffort}
                {' '}· {fusionEffortLabel(sel.sidekickEffort)}{/if}</span
            >
            <ChevronDown size={14} class="text-text-muted" data-collapse-rank="5" />
          </button>

          {#if showFusionSlot2Menu}
            <div
              class="absolute bottom-full left-0 mb-2 w-[min(22rem,calc(100vw-2rem))] rounded-xl border shadow-2xl z-50 overflow-hidden backdrop-blur-md"
              style="background: var(--color-surface-2); border-color: var(--color-border);"
              role="dialog"
              aria-label="Fusion 2 · Sidekick"
            >
              <div
                class="px-4 py-2.5 text-xs font-medium"
                style="color: var(--color-text-secondary); border-bottom: 1px solid var(--color-border);"
              >
                Fusion 2 · Sidekick
              </div>
              <div class="max-h-[60vh] overflow-y-auto px-4 py-3 space-y-4">
                <div>
                  <div class="text-xs font-medium text-[var(--color-text-primary)]">Model</div>
                  <div class="mt-1.5 space-y-0.5">
                    {#each fusionCatalog.sidekicks as sidekick (sidekick.id)}
                      {@const offered = fusionAvailableSidekicks.has(sidekick.id)}
                      <button
                        type="button"
                        role="menuitemradio"
                        aria-checked={sel.sidekick === sidekick.id}
                        aria-disabled={!offered}
                        class="w-full text-left rounded-lg px-2.5 py-2 text-sm transition-colors hover:bg-[var(--color-surface-3)] {sel.sidekick ===
                        sidekick.id
                          ? 'text-[var(--color-accent)]'
                          : 'text-[var(--color-text-primary)]'}"
                        style={offered ? '' : 'opacity: 0.55;'}
                        onclick={() =>
                          applyFusionChange('sidekick', {
                            sidekick: sidekick.id,
                            sidekickEffort: sidekick.defaultEffort,
                          })}
                      >
                        <div class="flex items-center justify-between">
                          <span class="font-medium">{sidekick.name}</span>
                          {#if sel.sidekick === sidekick.id}
                            <Check size={14} class="text-[var(--color-accent)]" />
                          {/if}
                        </div>
                        {#if !offered}
                          <div class="text-[11px]" style="color: var(--color-text-muted);">
                            Not offered with {sel.leadFast ? 'Fast ' : ''}{fusionLeadDef?.name ??
                              sel.lead}
                          </div>
                        {/if}
                      </button>
                    {/each}
                  </div>
                </div>
                <div>
                  <div class="text-xs font-medium text-[var(--color-text-primary)]">
                    Reasoning
                  </div>
                  {#if fusionSidekickDef && fusionSidekickDef.efforts.length > 1}
                    <div
                      class="mt-1.5 flex rounded-lg p-0.5"
                      style="background: var(--color-surface-3);"
                      role="radiogroup"
                      aria-label="Fusion 2 reasoning"
                    >
                      {#each fusionSidekickDef.efforts as effort (effort)}
                        <button
                          type="button"
                          role="radio"
                          aria-checked={sel.sidekickEffort === effort}
                          class="flex-1 rounded-md px-2 py-1 text-xs font-medium transition-colors {sel.sidekickEffort ===
                          effort
                            ? 'text-[var(--color-accent)]'
                            : 'text-[var(--color-text-secondary)]'}"
                          style={sel.sidekickEffort === effort
                            ? 'background: var(--color-surface-2);'
                            : ''}
                          onclick={() =>
                            applyFusionChange('sidekickEffort', { sidekickEffort: effort })}
                        >
                          {fusionEffortLabel(effort)}
                        </button>
                      {/each}
                    </div>
                  {:else if fusionSidekickDef && fusionSidekickDef.efforts.length === 1}
                    <div class="mt-1.5 text-xs" style="color: var(--color-text-muted);">
                      {fusionEffortLabel(fusionSidekickDef.efforts[0])} · set by Devin
                    </div>
                  {:else}
                    <div class="mt-1.5 text-xs" style="color: var(--color-text-muted);">
                      No reasoning tier
                    </div>
                  {/if}
                </div>
                {#if fusionSidekickPriorityLabel}
                  <div>
                    <div class="text-xs font-medium text-[var(--color-text-primary)]">Fast</div>
                    <div class="mt-1.5 text-xs" style="color: var(--color-text-muted);">
                      {fusionSidekickPriorityLabel} · follows Fusion 1 Fast
                    </div>
                  </div>
                {:else if sel.leadFast || fusionSidekickHasPriority}
                  <div>
                    <div class="text-xs font-medium text-[var(--color-text-primary)]">Fast</div>
                    <div class="mt-1.5 text-xs" style="color: var(--color-text-muted);">
                      No fast tier
                    </div>
                  </div>
                {/if}
                {#if fusionAdjustedNote}
                  <div
                    class="rounded-lg border border-[var(--color-info)]/30 bg-[var(--color-info-bg)]/40 px-2.5 py-2 text-xs text-[var(--color-text-primary)]"
                  >
                    {fusionAdjustedNote}
                  </div>
                {/if}
              </div>
              {#if fusionMetaSummary()}
                <div
                  class="px-4 py-2 text-[11px]"
                  style="color: var(--color-text-muted); border-top: 1px solid var(--color-border);"
                >
                  {fusionMetaSummary()}
                </div>
              {/if}
            </div>
          {/if}
        </div>
      {/if}

      <!-- Reasoning toggle - shows/hides based on provider+model -->
      {#if reasoningSupported && reasoningConfig && !fusionCatalog}
        <div class="relative reasoning-picker" data-testid="composer-reasoning-control">
          <button
            type="button"
            class="reasoning-picker-trigger flex min-h-9 items-center gap-2 rounded-lg px-3 text-sm font-medium transition-colors hover:brightness-110"
            aria-expanded={showReasoningMenu}
            aria-label={reasoningIsValid
              ? `Reasoning: ${reasoningLabel(reasoningLevel)}`
              : 'Choose reasoning effort for this model'}
            style="background: var(--color-surface-2); color: {reasoningIsValid
              ? 'var(--color-text-primary)'
              : 'var(--color-text-muted)'}; border: 1px solid var(--color-border);"
            onclick={() => (showReasoningMenu = !showReasoningMenu)}
            title={reasoningIsValid
              ? `Reasoning: ${reasoningLabel(reasoningLevel)}`
              : 'Choose reasoning effort for this model'}
          >
            <BrainIcon
              reasoningLevel={reasoningIsValid ? reasoningLevel : ''}
              size={20}
              class="text-[var(--color-accent)]"
            />
            <span class="composer-control-label" data-collapse-rank="7"
              >{reasoningIsValid ? reasoningLabel(reasoningLevel) : 'Choose reasoning'}</span
            >
            <ChevronDown size={14} class="text-text-muted" data-collapse-rank="7" />
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

      {#if speedTiers.length > 0 && !fusionCatalog}
        <div class="relative fast-mode-picker" data-testid="composer-fast-control">
          <div
            class="fast-mode-control flex min-h-9 items-stretch rounded-lg text-sm font-medium transition-colors hover:brightness-110"
            style="background: {activeSpeedTier
              ? 'color-mix(in srgb, var(--color-accent) 14%, var(--color-surface-3))'
              : 'var(--color-surface-3)'}; color: {activeSpeedTier
              ? 'var(--color-accent)'
              : 'var(--color-text-primary)'}; border: 1px solid {activeSpeedTier
              ? 'var(--color-accent)'
              : 'var(--color-border)'};"
          >
            <button
              type="button"
              class="flex items-center gap-2 pl-3 pr-1.5"
              onclick={cycleSpeedTier}
              aria-label={`${speedTierLabel}: ${activeSpeedTier ? 'on' : 'off'}`}
            >
              <Zap size={17} fill={activeSpeedTier ? 'currentColor' : 'none'} />
              <span class="composer-control-label" data-collapse-rank="2">{speedTierLabel}</span>
            </button>
            <button
              type="button"
              class="flex items-center px-1.5"
              onclick={() => (showFastMenu = !showFastMenu)}
              aria-haspopup="menu"
              aria-expanded={showFastMenu}
              aria-label={`${speedTierLabel} options`}
            >
              <ChevronDown size={14} class="text-text-muted" data-collapse-rank="2" />
            </button>
          </div>

          {#if showFastMenu}
            <div
              class="absolute bottom-full left-0 mb-2 w-64 rounded-xl border shadow-2xl z-50 overflow-hidden backdrop-blur-md"
              style="background: var(--color-surface-2); border-color: var(--color-border);"
              role="menu"
              aria-label={speedTierLabel}
            >
              <div
                class="px-4 py-2.5 text-xs font-medium"
                style="color: var(--color-text-secondary); border-bottom: 1px solid var(--color-border);"
              >
                {`${modelDisplayName} · Speed`}
              </div>
              <div class="py-1">
                <button
                  type="button"
                  role="menuitemradio"
                  aria-checked={!activeSpeedTier}
                  class="w-full text-left px-4 py-2.5 transition-all hover:bg-[var(--color-surface-3)]"
                  onclick={() => selectSpeedTier(null)}
                >
                  <div class="flex items-center justify-between">
                    <span
                      class="text-sm font-semibold {!activeSpeedTier
                        ? 'text-[var(--color-accent)]'
                        : 'text-[var(--color-text-primary)]'}"
                    >
                      Off
                    </span>
                    {#if !activeSpeedTier}
                      <Check size={15} class="text-[var(--color-accent)]" />
                    {/if}
                  </div>
                </button>
                {#each speedTiers as tier (tier.id)}
                  <button
                    type="button"
                    role="menuitemradio"
                    aria-checked={speedTier === tier.id}
                    class="w-full text-left px-4 py-2.5 transition-all hover:bg-[var(--color-surface-3)]"
                    onclick={() => selectSpeedTier(tier.id)}
                  >
                    <div class="flex items-center justify-between">
                      <span
                        class="text-sm font-semibold {speedTier === tier.id
                          ? 'text-[var(--color-accent)]'
                          : 'text-[var(--color-text-primary)]'}"
                      >
                        {tier.label}
                      </span>
                      {#if speedTier === tier.id}
                        <Check size={15} class="text-[var(--color-accent)]" />
                      {/if}
                    </div>
                    <div class="mt-0.5 text-xs leading-relaxed" style="color: var(--color-text-muted);">
                      {tier.description}
                    </div>
                  </button>
                {/each}
              </div>
            </div>
          {/if}
        </div>
      {/if}

      {#if modelParameters.length > 0 && !fusionCatalog}
        <div class="relative model-params-picker" data-testid="composer-model-params-control">
          <button
            type="button"
            class="fast-mode-control flex min-h-9 items-center gap-2 rounded-lg px-3 text-sm font-medium transition-colors hover:brightness-110"
            style="background: var(--color-surface-3); color: var(--color-text-primary); border: 1px solid var(--color-border);"
            aria-haspopup="dialog"
            aria-expanded={showModelParametersMenu}
            aria-label="Model settings"
            onclick={() => (showModelParametersMenu = !showModelParametersMenu)}
          >
            <SlidersHorizontal
              size={17}
              color={modelParameterOverrideCount > 0 ? 'var(--color-accent)' : 'currentColor'}
            />
            <span class="composer-control-label" data-collapse-rank="4">Model settings</span>
            <ChevronDown size={14} class="text-text-muted" data-collapse-rank="4" />
          </button>

          {#if showModelParametersMenu}
            <div
              class="absolute bottom-full left-0 mb-2 w-[min(22rem,calc(100vw-2rem))] rounded-xl border shadow-2xl z-50 overflow-hidden backdrop-blur-md"
              style="background: var(--color-surface-2); border-color: var(--color-border);"
              role="dialog"
              aria-label="Model settings"
            >
              <div
                class="px-4 py-2.5 text-xs font-medium"
                style="color: var(--color-text-secondary); border-bottom: 1px solid var(--color-border);"
              >
                {`${modelDisplayName} · Model settings`}
              </div>
              <div class="max-h-[60vh] overflow-y-auto py-1">
                {#each modelParameters as def (def.key)}
                  {@const bounded =
                    def.kind !== 'enum' && def.min !== undefined && def.max !== undefined}
                  {@const overridden = modelParameterValues[def.key] !== undefined}
                  <div
                    class="px-4 py-2"
                    style="border-bottom: 1px solid color-mix(in srgb, var(--color-border) 45%, transparent);"
                  >
                    {#if def.key === 'max_tokens'}
                      <div class="flex items-center gap-3">
                        <div class="shrink-0">
                          <SettingsSwitch
                            checked={overridden}
                            label="Force max"
                            description="Force an explicit maximum output-token limit."
                            minimal
                            compact
                            quiet
                            onchange={() =>
                              overridden
                                ? resetModelParameter(def.key)
                                : setModelParameter(def.key, def.max ?? 1)}
                          />
                        </div>
                        <div class="flex min-w-0 flex-1 items-center gap-1.5">
                          <span
                            class="text-xs font-medium {overridden
                              ? 'text-[var(--color-accent)]'
                              : 'text-[var(--color-text-primary)]'}">{def.label}</span
                          >
                          <span
                            class="inline-flex shrink-0 cursor-help items-center text-[var(--color-text-muted)] transition-colors hover:text-[var(--color-text-primary)]"
                            role="img"
                            aria-label={modelParameterHint(def)}
                            title={modelParameterHint(def)}
                          >
                            <Info size={12} />
                          </span>
                          <span
                            class="font-mono text-xs tabular-nums {overridden
                              ? 'text-[var(--color-accent)]'
                              : 'text-[var(--color-text-muted)]'}"
                          >
                            {overridden ? modelParameterFormattedValue(def) : '∞'}
                          </span>
                        </div>
                      </div>
                      <div
                        class="mt-1 text-[11px] leading-snug line-clamp-2"
                        style="color: var(--color-text-muted);"
                      >
                        {def.description}
                      </div>
                      {#if overridden}
                        <div class="mt-2">
                          <KorySlider
                            id={`model-param-${def.key}`}
                            label="Limit"
                            description=""
                            displayValue={modelParameterFormattedValue(def)}
                            valueTone="accent"
                            value={modelParameterNumber(def)}
                            min={def.min!}
                            max={def.max!}
                            step={def.step ?? 1}
                            onchange={(v) => setModelParameter(def.key, v)}
                            compact
                          />
                        </div>
                      {/if}
                    {:else if bounded}
                      <KorySlider
                        id={`model-param-${def.key}`}
                        label={def.label}
                        description={def.description}
                        displayValue={modelParameterFormattedValue(def)}
                        valueTone={overridden ? 'accent' : 'muted'}
                        value={modelParameterNumber(def)}
                        min={def.min!}
                        max={def.max!}
                        step={def.step ?? 1}
                        onchange={(v) => setModelParameter(def.key, v)}
                        compact
                      />
                    {:else if def.kind === 'enum'}
                      <div
                        class="flex items-center gap-1.5 text-xs font-medium {overridden
                          ? 'text-[var(--color-accent)]'
                          : 'text-[var(--color-text-primary)]'}"
                      >
                        <span>{def.label}</span>
                        <span
                          class="inline-flex shrink-0 cursor-help items-center text-[var(--color-text-muted)] transition-colors hover:text-[var(--color-text-primary)]"
                          role="img"
                          aria-label={modelParameterHint(def)}
                          title={modelParameterHint(def)}
                        >
                          <Info size={12} />
                        </span>
                      </div>
                      <div
                        class="mt-1.5 flex rounded-lg p-0.5"
                        style="background: var(--color-surface-3);"
                        role="radiogroup"
                        aria-label={def.label}
                      >
                        {#each def.options ?? [] as option (option)}
                          <button
                            type="button"
                            role="radio"
                            aria-checked={modelParameterValues[def.key] === option}
                            class="flex-1 rounded-md px-2 py-1 text-xs font-medium transition-colors {modelParameterValues[
                              def.key
                            ] === option
                              ? 'text-[var(--color-accent)]'
                              : 'text-[var(--color-text-secondary)]'}"
                            style={modelParameterValues[def.key] === option
                              ? 'background: var(--color-surface-2);'
                              : ''}
                            onclick={() =>
                              modelParameterValues[def.key] === option
                                ? resetModelParameter(def.key)
                                : setModelParameter(def.key, option)}
                          >
                            {option}
                          </button>
                        {/each}
                      </div>
                      <div
                        class="mt-1 text-[11px] leading-snug line-clamp-2"
                        style="color: var(--color-text-muted);"
                      >
                        {def.description}
                      </div>
                    {:else}
                      <div class="flex items-center justify-between gap-3">
                        <span
                          class="flex shrink-0 items-center gap-1.5 whitespace-nowrap text-xs font-medium {overridden
                            ? 'text-[var(--color-accent)]'
                            : 'text-[var(--color-text-primary)]'}"
                        >
                          <span>{def.label}</span>
                          <span
                            class="inline-flex shrink-0 cursor-help items-center text-[var(--color-text-muted)] transition-colors hover:text-[var(--color-text-primary)]"
                            role="img"
                            aria-label={modelParameterHint(def)}
                            title={modelParameterHint(def)}
                          >
                            <Info size={12} />
                          </span>
                        </span>
                        <NumberStepper
                          value={modelParameterNumber(def)}
                          min={def.min ?? 0}
                          max={Number.MAX_SAFE_INTEGER}
                          step={def.step ?? 1}
                          label={def.label}
                          onchange={(v) => setModelParameter(def.key, v)}
                          compact
                          quiet
                        />
                      </div>
                      <div
                        class="mt-1 text-[11px] leading-snug line-clamp-2"
                        style="color: var(--color-text-muted);"
                      >
                        {def.description}
                      </div>
                    {/if}
                  </div>
                {/each}
              </div>
              {#if modelParameterOverrideCount > 0}
                <div class="flex items-center justify-end px-4 py-2">
                  <button
                    type="button"
                    class="text-xs font-medium transition-colors hover:brightness-125"
                    style="color: var(--color-accent);"
                    onclick={resetAllModelParameters}
                  >
                    Reset all
                  </button>
                </div>
              {/if}
            </div>
          {/if}
        </div>
      {/if}
      <button
        type="button"
        class="composer-control-button flex min-h-9 items-center gap-2 rounded-lg border px-3 text-sm font-medium transition-colors hover:brightness-110 {isGuidedDemo
          ? 'border-[var(--color-border)] bg-[var(--color-surface-3)] text-[var(--color-text-secondary)]'
          : interactionMode === 'plan'
            ? 'border-[var(--color-info)]/40 bg-[var(--color-info-bg)] text-[var(--color-info)]'
            : 'border-[var(--color-border)] bg-[var(--color-surface-3)] text-[var(--color-text-primary)]'}"
        aria-pressed={!isGuidedDemo && interactionMode === 'plan'}
        aria-disabled={isGuidedDemo}
        aria-label={isGuidedDemo ? 'Plan mode (not available in this demo)' : 'Plan mode'}
        onclick={() =>
          isGuidedDemo
            ? toastStore.info('Not available in this demo')
            : onInteractionModeChange?.(interactionMode === 'plan' ? 'act' : 'plan')}
        title={isGuidedDemo
          ? 'Not available in this demo'
          : 'Plan mode keeps project files unchanged and preserves a planning note between restarts'}
      >
        <ClipboardList size={17} />
        <span class="composer-control-label" data-collapse-rank="3"
          >{isGuidedDemo
            ? 'Not available in this demo'
            : interactionMode === 'plan'
              ? 'Planning'
              : 'Plan'}</span
        >
      </button>
      <div class="permission-picker relative" data-testid="composer-permission-control">
        <button
          type="button"
          class="permission-picker-trigger flex min-h-9 items-center gap-2 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-2)] px-3 text-sm font-medium text-[var(--color-text-primary)] transition-colors hover:brightness-110"
          onclick={() => (showPermissionMenu = !showPermissionMenu)}
          title={`Permissions: ${permissionModeMeta.label} · ${permissionEnforcement.label}`}
          aria-haspopup="menu"
          aria-expanded={showPermissionMenu}
          aria-label={`Permissions: ${permissionModeMeta.label}`}
        >
          <span class="relative inline-flex">
            <permissionModeMeta.icon size={17} class={permissionModeMeta.tone} />
            {#if selectedModel && !permissionEnforced}
              <span class="permission-unenforced-dot" aria-hidden="true"></span>
            {/if}
          </span>
          <span class="composer-control-label" data-collapse-rank="6">{permissionModeMeta.label}</span>
          <ChevronDown size={14} class="text-text-muted" data-collapse-rank="6" />
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
            <div
              class="flex items-start gap-2.5 border-b border-[var(--color-border)] px-4 py-2.5"
              data-testid="permission-enforcement"
              data-level={permissionEnforcement.level}
            >
              {#if permissionEnforced}
                <ShieldCheck size={15} class="mt-0.5 shrink-0 text-[var(--color-success)]" />
              {:else}
                <ShieldAlert size={15} class="mt-0.5 shrink-0 text-[var(--color-warning)]" />
              {/if}
              <span class="min-w-0">
                <span class="block text-xs font-semibold text-[var(--color-text-primary)]"
                  >{permissionEnforcement.label}</span
                >
                <span class="block text-[11px] leading-relaxed text-[var(--color-text-muted)]"
                  >{permissionEnforcement.detail}</span
                >
              </span>
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

      {#if sessionStore.activeSessionId}
        <!-- Rank 10 hides the branch name and chevron inside GitWorkspaceControl.
             A flex box, not display: contents: lineItems() skips zero-size
             boxes, and a contents wrapper would drop the git control from the fit. -->
        <div class="composer-git-slot" data-collapse-rank="10" data-collapse-mode="branch">
          <GitWorkspaceControl
            sessionId={sessionStore.activeSessionId}
            revision={sessionStore.sessions.find(
              (session) => session.id === sessionStore.activeSessionId,
            )?.version ?? 0}
            placement="composer"
            busy={isRunning || isWaiting}
          />
        </div>
        <!-- Per-chat isolation preset. Click cycles Auto → On → Off; on Auto
             the manager picks per task, On forces isolated worktrees, Off has
             workers write straight into this checkout. -->
        <button
          type="button"
          class="composer-worktree-toggle"
          aria-label="Worker isolation preset for delegated agents"
          data-testid="composer-worktree-toggle"
          data-collapse-rank="9"
          title={worktreeModeTitle()}
          onclick={cycleWorktreeMode}
        >
          <span class="composer-control-label" data-collapse-rank="9"
            >Worktree: {worktreeModeLabel()}</span
          >
        </button>
      {/if}
      <div
        class="composer-action-row ml-auto flex max-w-full flex-wrap items-center justify-end gap-2"
        data-testid="composer-action-row"
        data-collapse-group
      >
        {#if value.length > 0}
          <span class="text-xs text-[var(--color-text-muted)]" data-collapse-rank="1"
            >{value.length} chars</span
          >
        {/if}
        {#if freebuffTurnCountdown}
          <span
            class="min-w-[5rem] shrink-0 whitespace-nowrap text-right text-xs tabular-nums text-[var(--color-text-muted)]"
            data-collapse-rank="2"
            title="Freebuff session time remaining"
            data-testid="freebuff-turn-countdown">{freebuffTurnCountdown} left</span
          >
        {/if}
        <div class="flex shrink-0 items-center gap-0.5 reference-picker">
          <input
            type="file"
            multiple
            accept="image/*,audio/*,video/*"
            class="hidden"
            aria-label="Attach images, audio, or video"
            bind:this={mediaFileInputRef}
            onchange={(event) => {
              queueMediaFiles(Array.from(event.currentTarget.files ?? []));
              event.currentTarget.value = '';
            }}
          />
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
          <div class="relative more-actions-picker">
            <button
              type="button"
              class="flex items-center justify-center w-8 h-8 rounded-lg transition-colors hover:bg-[var(--color-surface-3)] disabled:opacity-40 disabled:cursor-not-allowed"
              style="color: var(--color-text-muted);"
              onclick={() => (showGoalActions = !showGoalActions)}
              disabled={disabled || imageAdmissionPending || !!configurationWarning}
              aria-label="More composer actions"
              aria-haspopup="menu"
              aria-expanded={showGoalActions}
              title="More actions"><Plus size={16} /></button
            >
            {#if showGoalActions}
              <div
                role="menu"
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
                  role="menuitem"
                  class="flex w-full items-center gap-2 px-3 py-2 text-left text-xs hover:bg-[var(--color-surface-3)]"
                  style="color: var(--color-text-primary);"
                  onclick={() => {
                    showGoalActions = false;
                    showChecklists = true;
                  }}
                >
                  <ListChecks size={14} />
                  {checklistStore.active.length > 0 ? 'Checklists' : 'New checklist'}
                </button>
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
              title="Attach media or reference a file or folder"
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
                  class="w-full text-left px-3 py-2 text-xs text-[var(--color-text-primary)] hover:bg-[var(--color-surface-3)]"
                  onclick={() => {
                    showReferenceMenu = false;
                    mediaFileInputRef?.click();
                  }}
                >
                  Attach image, audio, video…
                </button>
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
            title="Paste image from clipboard ({formatShortcut('Mod+Shift+V')})"
          >
            <Clipboard size={16} />
          </button>
          {#if composerMicrophoneEnabled}
            <div
              class="flex shrink-0 items-center"
              data-testid="composer-voice-recorder"
              data-state={isRecording ? 'recording' : isTranscribing ? 'transcribing' : 'idle'}
            >
              <button
                type="button"
                class="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg transition-colors hover:bg-[var(--color-surface-3)] disabled:cursor-not-allowed disabled:opacity-40"
                style={isRecording
                  ? 'color: var(--color-accent);'
                  : 'color: var(--color-text-muted);'}
                onclick={() => void toggleRecording()}
                disabled={disabled ||
                  imageAdmissionPending ||
                  !!configurationWarning ||
                  isTranscribing}
                aria-pressed={isRecording}
                aria-label={isTranscribing
                  ? 'Transcribing recording'
                  : isRecording
                    ? 'Stop recording and transcribe'
                    : 'Record a voice prompt'}
                title={isTranscribing
                  ? 'Transcribing…'
                  : isRecording
                    ? 'Stop recording and transcribe'
                    : `Click to record${voiceShortcutHint ? ` · hold ${voiceShortcutHint} to talk` : ''}${voiceConductor.enabled && conductorShortcutHint ? ` · hold ${conductorShortcutHint} for a voice command` : ''}`}
              >
                <Mic size={16} class={isRecording || isTranscribing ? 'animate-pulse' : ''} />
              </button>
            </div>
          {/if}
        </div>
        <div class="agent-mode-picker relative" data-testid="composer-agent-mode-control">
          <button
            type="button"
            class="agent-mode-trigger flex min-h-9 items-center gap-1.5 text-[11px] font-medium px-2.5 py-1.5 rounded-md transition-colors {agentExecutionModeMeta.className}"
            onclick={() => (showAgentModeMenu = !showAgentModeMenu)}
            title={agentExecutionModeMeta.title}
            aria-haspopup="menu"
            aria-expanded={showAgentModeMenu}
            aria-label={`Agent mode: ${agentExecutionModeMeta.label}`}
          >
            <agentExecutionModeMeta.icon size={12} />
            <span class="composer-control-label" data-collapse-rank="5">{agentExecutionModeMeta.label}</span>
            <ChevronDown size={10} class="opacity-60" data-collapse-rank="5" />
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
                      style="color: {active ? 'var(--color-accent)' : 'var(--color-text-primary)'};"
                      >{option.label}</span
                    >
                    <span class="block text-[11px]" style="color: var(--color-text-muted);"
                      >{option.description}</span
                    >
                  </span>
                  {#if active}
                    <Check size={12} class="mt-0.5 shrink-0" style="color: var(--color-accent);" />
                  {/if}
                </button>
              {/each}
            </div>
          {/if}
        </div>

        <!-- Rank 11 (last to collapse): the critic trigger swaps to its short word. -->
        <div class="composer-critic-slot" data-collapse-rank="11" data-collapse-mode="swap">
          <CriticModeSelect
            compact
            shortLabels
            value={effectiveCriticMode}
            onchange={(criticMode) => selectCriticMode(criticMode)}
          />
        </div>
        {#if interactionMode === 'plan' && planReady}
          <button
            type="button"
            class="min-h-9 rounded-lg bg-[var(--color-accent)] px-3 py-2 text-xs font-semibold text-[var(--color-on-accent)] hover:opacity-90"
            onclick={() => onApprovePlan?.()}>Approve plan & implement</button
          >
        {/if}

        <button
          type="button"
          data-testid="composer-primary-action"
          onclick={primaryAction}
          disabled={disabled ||
            isStopping ||
            imageAdmissionPending ||
            (!isRunning && !isWaiting && !canSend)}
          class="btn flex shrink-0 items-center justify-center gap-2 {isStopping ||
          ((isRunning || isWaiting) && !canSend)
            ? 'stop-btn'
            : (isRunning || isWaiting) && canSend
              ? 'steer-btn'
              : isWaiting
                ? 'waiting-btn'
                : 'btn-primary'}"
          style="height: 36px; padding: 0 16px; font-size: 14px; {disabled ||
          isStopping ||
          imageAdmissionPending ||
          (!isRunning && !isWaiting && !canSend)
            ? 'opacity: 0.5; cursor: not-allowed;'
            : ''}"
          aria-label={isStopping
            ? 'Stopping the current run'
            : imageAdmissionPending
              ? 'Checking image input support'
              : isRunning && canSend
                ? 'Steer the running model at its next safe point'
                : isFinalizing
                  ? 'Answer complete, finishing follow-up work. Stop'
                  : isRunning
                  ? 'Stop the running model'
                  : isWaiting && canSend
                    ? 'Send message and cancel the wait'
                    : isWaiting
                      ? 'Kory is waiting. Click to cancel'
                      : 'Send message'}
          title={isStopping
            ? 'Waiting for the current run to stop'
            : imageAdmissionPending
              ? 'Checking active image context before sending'
              : isRunning && canSend
                ? 'Queue this message. The running turn finishes its current step, then your message takes over. Stop cancels immediately'
                : isFinalizing
                  ? 'The answer is complete; Kory is finishing follow-up work such as review and checkpoints. Click to stop (Esc)'
                  : isRunning
                  ? 'Stop (Esc)'
                  : isWaiting && canSend
                    ? 'Send message and cancel the wait'
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
          {#if isStopping}
            <span class="stop-pulse" aria-hidden="true">
              <Square size={10} fill="currentColor" strokeWidth={0} />
            </span>
            <span>Stopping…</span>
          {:else if isRunning && canSend}
            <Send size={18} aria-hidden="true" />
            <span data-collapse-rank="4">Steer</span>
          {:else if isFinalizing}
            <Square size={10} fill="currentColor" strokeWidth={0} aria-hidden="true" />
            <span>Finalizing</span>
          {:else if isRunning}
            <span class="stop-pulse" aria-hidden="true">
              <Square size={10} fill="currentColor" strokeWidth={0} />
            </span>
            <span>Stop</span>
          {:else if isWaiting && canSend}
            <Send size={18} aria-hidden="true" />
            <span data-collapse-rank="4">Steer</span>
          {:else if isWaiting}
            <PauseCircle size={18} class="animate-pulse" aria-hidden="true" />
            <span>Waiting{waitingReason ? ` · ${waitingReason}` : '…'}</span>
          {:else}
            <!-- Empty composer is a plain disabled Send. "Waiting" is reserved
                 for Kory genuinely parked on something external, so an idle
                 app never reads as a busy app. -->
            <Send size={18} />
            <span data-collapse-rank="4">Send</span>
          {/if}
        </button>
      </div>
    </div>
  </div>
</div>

{#if imageFallbackWarning}
  <ImageInputFallbackDialog
    modelLabel={imageFallbackWarning.targetLabel}
    modelSupportsVision={availableModels.find(
      (model) => model.value === imageFallbackWarning?.targetValue,
    )?.vision === true}
    imageCount={imageFallbackWarning.imageCount}
    mode={imageFallbackWarning.mode}
    onallow={useImagesWithModel}
    oncontinue={continueWithoutImageInput}
    onchoosemodel={chooseVisionModelFromWarning}
    oncancel={() => (imageFallbackWarning = null)}
  />
{/if}

<ConfirmDialog
  open={microphoneConsentOpen}
  title="“Koryphaios” Would Like to Access the Microphone"
  message="Koryphaios records audio only when you press the microphone button so it can transcribe your prompt."
  confirmLabel="Allow"
  cancelLabel="Don't Allow"
  variant="info"
  onConfirm={() => settleMicrophoneConsent(true)}
  onCancel={() => settleMicrophoneConsent(false)}
/>

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
        <span class="hidden text-[11px] text-[var(--color-text-muted)] sm:block">Esc to close</span>
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

  /* A populated composer changes the running action from destructive stop to
   * a guided continuation. Keep it in the accent family so the distinction is
   * visible without making steering look like an error state. */
  :global(.steer-btn) {
    background: var(--color-accent);
    color: var(--color-on-accent);
    border: 1px solid color-mix(in srgb, var(--color-accent) 70%, transparent);
    font-weight: 600;
    transition:
      opacity 0.15s ease,
      background 0.15s ease;
  }
  :global(.steer-btn:hover) {
    opacity: 0.9;
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
  .command-input,
  .composer-card,
  .composer-config-row,
  .composer-action-row {
    min-width: 0;
    max-width: 100%;
  }

  .composer-config-row > *,
  .composer-action-row > * {
    max-width: 100%;
    min-width: 0;
  }

  .command-input {
    container: composer / inline-size;
  }

  /* Progressive collapse (utils/toolbar-density.ts). Each collapsible element
     has data-collapse-rank; the toolbar sets data-collapsed on the ones it
     collapses, and data-collapse-mode says what that means. Order, lowest rank
     first: 1 char count, 2 Fast, 3 Plan, 4 Send/Steer text, 5 agent mode,
     6 permissions, 7 reasoning, 8 model name truncated, 9 model name and
     chevron, 10 git branch, 11 critic short word. Stop, Waiting, Stopping and
     Finalizing keep their text. Every tooltip and aria-label keeps the full name.
     Attributes are set at runtime, so these selectors are :global under
     .command-input, which keeps them scoped to the composer. */
  .command-input :global(.composer-config-row [data-collapsed]:not([data-collapse-mode])) {
    display: none;
  }

  /* truncate: the model name caps its width and ellipsises. */
  .command-input :global(.composer-config-row [data-collapse-mode='truncate'][data-collapsed]) {
    max-width: 9rem;
  }

  /* branch: git hides its branch name and chevron; the tab keeps its icon. */
  .command-input
    :global(.composer-config-row [data-collapse-mode='branch'][data-collapsed] :is(.branch-name, .toggle-chevron)) {
    display: none;
  }
  .command-input
    :global(.composer-config-row [data-collapse-mode='branch'][data-collapsed] .git-toggle) {
    padding-inline: 0.625rem;
  }

  /* swap: the critic trigger shows its short word instead of "Critic: X" and drops its chevron. */
  .command-input
    :global(
      .composer-config-row [data-collapse-mode='swap'][data-collapsed]
        :is(.kory-select-label-full, .kory-select-chevron)
    ) {
    display: none;
  }
  .command-input
    :global(.composer-config-row [data-collapse-mode='swap'][data-collapsed] .kory-select-label-short) {
    display: inline;
  }

  /* A trigger whose label group has collapsed becomes a compact icon square.
     px-2.5 and gap-1.5 keep the Model settings icon and chevron contained. */
  .command-input
    :global(
      .composer-config-row
        :is(
          .fast-mode-control,
          .composer-control-button,
          .reasoning-picker-trigger,
          .permission-picker-trigger,
          .agent-mode-trigger,
          .model-picker-trigger
        ):has(> [data-collapsed])
    ) {
    min-width: 2.25rem;
    justify-content: center;
    padding-inline: 0.625rem;
    column-gap: 0.375rem;
  }

  .permission-unenforced-dot {
    position: absolute;
    top: -2px;
    right: -3px;
    width: 7px;
    height: 7px;
    border-radius: 9999px;
    background: var(--color-warning);
    box-shadow: 0 0 0 2px var(--color-surface-2);
  }

  /* Fusion slot chips keep this numbered badge when the label collapses, so the
     icon-only state still reads as "1" / "2" (plus the lead's Zap glyph). */
  .fusion-slot-badge {
    display: inline-flex;
    flex-shrink: 0;
    align-items: center;
    justify-content: center;
    gap: 1px;
    min-width: 1.15rem;
    height: 1.15rem;
    padding-inline: 0.3rem;
    border-radius: 5px;
    background: color-mix(in srgb, var(--color-accent) 18%, var(--color-surface-3));
    color: var(--color-accent);
    font-size: 10px;
    font-weight: 700;
    line-height: 1;
  }

  .composer-model-name {
    display: inline-flex;
    min-width: 0;
  }

  .composer-model-label {
    max-width: 16rem;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  /* Flex boxes, not display: contents, so the fit can still measure them. */
  .composer-git-slot,
  .composer-critic-slot {
    display: flex;
    min-width: 0;
  }

  .composer-worktree-toggle {
    display: inline-flex;
    align-items: center;
    gap: var(--space-2);
    min-height: var(--size-button-height-lg);
    padding: 0 var(--space-2);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-lg);
    background: var(--color-surface-2);
    color: var(--color-text-primary);
    font-size: var(--text-sm);
    font-weight: var(--font-medium);
  }


  @container composer (max-width: 760px) {
    .composer-action-row {
      gap: 0.375rem;
    }

    .composer-config-row {
      gap: 0.375rem;
    }

    .model-picker-trigger,
    .reasoning-picker-trigger,
    .agent-mode-trigger,
    .permission-picker-trigger,
    .composer-control-button,
    .fast-mode-control {
      gap: 0.375rem;
      padding-inline: 0.5rem;
      font-size: 0.75rem;
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
