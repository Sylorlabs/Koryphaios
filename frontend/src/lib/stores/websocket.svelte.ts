// WebSocket connection store — Svelte 5 runes for reactive agent state.
// Handles connection, reconnection, message routing, user messages, and permissions.

import type {
  WSMessage,
  StreamDeltaPayload,
  StreamThinkingPayload,
  StreamToolCallPayload,
  StreamToolResultPayload,
  StreamUsagePayload,
  StreamFileDeltaPayload,
  StreamFileCompletePayload,
  ContextDetectedPayload,
  KoryThoughtPayload,
  KoryRoutingPayload,
  ProviderStatusPayload,
  ChangeSummary,
  KorySessionChangesPayload,
  AgentSpawnedPayload,
  AgentStatusPayload,
  AgentThreadMessagePayload,
  PermissionRequest,
  Session,
  NotificationPayload,
  NativeCommandPayload,
  KoryAskUserPayload,
  SessionIdlePayload,
} from '@koryphaios/shared';
import { sessionStore } from './sessions.svelte';
import { authStore } from './auth.svelte';
import { browser } from '$app/environment';
import type { FeedEntry } from '$lib/types';
import { apiUrl, getWsUrl } from '$lib/utils/api-url';
import { apiFetch, parseJsonResponse } from '$lib/api.svelte';
import { toastStore } from './toast.svelte';
import { providersStore, loadProvidersFromApi } from './providers.svelte';
import { feedStore } from './feed.svelte';
import { agentStore } from './agents.svelte';
import { notesStore } from './notes.svelte';
import { goalStore } from './goals.svelte';
import { goalDisplayStore } from './goal-display.svelte';
import { isDemoMode } from '$lib/demo-flags';
import {
  isInternalEventTypeDump,
  notifyAgentFinished,
  notifyDesktop,
  notifyNeedsAttention,
} from '$lib/utils/desktop-notifications';
import { OrderedEventBuffer } from '$lib/utils/ordered-event-buffer';

export type { FeedEntry };
export { feedStore } from './feed.svelte';
export { agentStore } from './agents.svelte';

// ─── Reactive State (Svelte 5 Runes) ─────────────────────────────────────

let wsConnection = $state<WebSocket | null>(null);
let connectionStatus = $state<'connecting' | 'connected' | 'disconnected' | 'error'>(
  'disconnected',
);

let koryThought = $state<string>('');
let koryPhase = $state<string>('');
let isYoloMode = $state<boolean>(false);
let pendingPermissions = $state<PermissionRequest[]>([]);
// Questions are per-session: a background chat's ask_user must survive
// until the user switches back to it, and answering must target the
// session that asked — not whichever chat happens to be open.
let pendingQuestions = $state<Map<string, KoryAskUserPayload>>(new Map());
let sessionChanges = $state<Map<string, ChangeSummary[]>>(new Map());
export interface RewindPreview {
  sessionId: string;
  currentHash: string;
  targetHash: string;
  description: string;
  evidence: {
    model?: string;
    cost?: number;
    tokensIn?: number;
    tokensOut?: number;
    promptHash?: string;
    timestamp: number;
  };
  filesChanged: Array<{ path: string; operation: 'create' | 'edit' | 'delete' }>;
  diff: string;
  message: string;
}
let rewindPreview = $state<RewindPreview | null>(null);
let rewindApplying = $state(false);
let rewindPreviewLoadingHash = $state<string | null>(null);

interface DetectedContextFile {
  path: string;
  relevance: number;
  reason: string;
}
let detectedContext = $state<DetectedContextFile[]>([]);

let busySessions = $state<Set<string>>(new Set());
// Bumped on process.started/exited so the background-terminals strip refetches.
let processEventTick = $state(0);

interface ActiveFileEdit {
  path: string;
  content: string;
  operation: 'create' | 'edit';
  agentId: string;
  startedAt: number;
  oldContent?: string;
  done?: boolean;
}
let activeFileEdits = $state<Map<string, ActiveFileEdit>>(new Map());

let hasShownMalformedWsMessage = false;
let fileEditTimers = new Map<string, ReturnType<typeof setTimeout>>();
let notesRefreshTimer: ReturnType<typeof setTimeout> | null = null;

function scheduleNotesRefresh() {
  if (!notesStore.settings.enabled) return;
  if (notesRefreshTimer) clearTimeout(notesRefreshTimer);
  notesRefreshTimer = setTimeout(() => {
    notesRefreshTimer = null;
    void Promise.all([
      notesStore.fetchNotes(),
      notesStore.fetchGraph(),
      notesStore.fetchFolderTree(),
    ]);
  }, 200);
}

// ─── Session Busy Bridge ─────────────────────────────────────────────────────

function markSessionBusy(sessionId: string) {
  if (busySessions.has(sessionId)) {
    kickBusyWatchdog(sessionId);
    return;
  }
  busySessions = new Set(busySessions).add(sessionId);
  kickBusyWatchdog(sessionId);
}

function clearSessionBusy(sessionId: string) {
  stopBusyWatchdog(sessionId);
  if (!busySessions.has(sessionId)) return;
  const next = new Set(busySessions);
  next.delete(sessionId);
  busySessions = next;
}

function maybeClearBusy(sessionId: string | undefined) {
  if (!sessionId || !busySessions.has(sessionId)) return;
  if (!agentStore.isSessionRunning(sessionId)) clearSessionBusy(sessionId);
}

// A silent provider/tool phase can legitimately last well beyond this delay.
// Ask the backend before changing UI state; a lack of stream events is not
// evidence that the work has stopped. Now that the backend emits a
// definitive session.idle event, this watchdog is a fallback for lost WS
// events only — the interval is doubled to 90s to reduce unnecessary polling.
const BUSY_WATCHDOG_MS = 90_000;
const busyWatchdogs = new Map<string, ReturnType<typeof setTimeout>>();

function kickBusyWatchdog(sessionId: string | undefined) {
  if (!sessionId) return;
  const existing = busyWatchdogs.get(sessionId);
  if (existing) clearTimeout(existing);
  if (!busySessions.has(sessionId)) return;
  busyWatchdogs.set(
    sessionId,
    setTimeout(async () => {
      busyWatchdogs.delete(sessionId);
      try {
        const response = await apiFetch(apiUrl(`/api/sessions/${sessionId}/runtime-status`));
        const result = (await response.json()) as { ok?: boolean; running?: boolean };
        if (result.ok && result.running) {
          kickBusyWatchdog(sessionId);
          return;
        }
        if (result.ok) {
          markSessionAgentsStopped(sessionId);
          clearSessionBusy(sessionId);
          return;
        }
      } catch {
        // A transient health/auth failure is never evidence that work stopped.
      }
      kickBusyWatchdog(sessionId);
    }, BUSY_WATCHDOG_MS),
  );
}

function stopBusyWatchdog(sessionId: string | undefined) {
  if (!sessionId) return;
  const t = busyWatchdogs.get(sessionId);
  if (t) {
    clearTimeout(t);
    busyWatchdogs.delete(sessionId);
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function providerDisplayName(provider: string): string {
  if (provider === 'openai') return 'OpenAI';
  if (provider === 'codex') return 'Codex CLI';
  if (provider === 'codex-auth') return 'OpenAI Codex';
  if (provider === 'anthropic') return 'Anthropic';
  if (provider === 'google') return 'Google';
  if (provider === 'aistudio') return 'Google AI Studio';
  if (provider === 'xai') return 'xAI';
  if (provider === 'openrouter') return 'OpenRouter';
  if (provider === 'vertexai') return 'Vertex AI';
  if (provider === 'copilot') return 'Copilot';
  if (provider === 'kimicode') return 'Kimi Code';
  return provider.charAt(0).toUpperCase() + provider.slice(1);
}

function pushToast(type: 'info' | 'warning' | 'success' | 'error', message: string): void {
  if (type === 'success') {
    toastStore.success(message);
    return;
  }
  if (type === 'warning') {
    toastStore.warning(message);
    return;
  }
  if (type === 'error') {
    toastStore.error(message);
    return;
  }
  toastStore.info(message);
}

function isWSMessageLike(value: unknown): value is WSMessage {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<WSMessage>;
  return typeof candidate.type === 'string' && typeof candidate.timestamp === 'number';
}

interface OrderedSessionState {
  buffer: OrderedEventBuffer<WSMessage & { epoch: number; sequence: number }>;
  replayRequested: boolean;
}

const MAX_PENDING_ORDERED_EVENTS = 4_096;
const orderedSessions = new Map<string, OrderedSessionState>();
const replayApplyingSessions = new Set<string>();
let timelineSyncingSessions = $state<Set<string>>(new Set());

function setTimelineSyncing(sessionId: string, syncing: boolean): void {
  const has = timelineSyncingSessions.has(sessionId);
  if (has === syncing) return;
  const next = new Set(timelineSyncingSessions);
  if (syncing) next.add(sessionId);
  else next.delete(sessionId);
  timelineSyncingSessions = next;
}

function requestOrderedReplay(sessionId: string, state: OrderedSessionState): void {
  if (state.replayRequested || wsConnection?.readyState !== WebSocket.OPEN) return;
  state.replayRequested = true;
  wsConnection.send(
    JSON.stringify({
      type: 'subscribe_session',
      sessionId,
      epoch: state.buffer.epoch,
      afterSequence: state.buffer.lastApplied,
      timestamp: Date.now(),
    }),
  );
}

function ingestOrderedEvent(message: WSMessage): void {
  const sessionId = message.sessionId;
  const sequence = message.sequence;
  const epoch = message.epoch;
  if (!sessionId || sequence === undefined || epoch === undefined) {
    handleMessage(message);
    return;
  }

  let state = orderedSessions.get(sessionId);
  if (!state) {
    state = {
      buffer: new OrderedEventBuffer(epoch, 0, false, MAX_PENDING_ORDERED_EVENTS),
      replayRequested: false,
    };
    orderedSessions.set(sessionId, state);
  }
  const result = state.buffer.ingest(message as WSMessage & { epoch: number; sequence: number });
  if (result.kind === 'epoch_mismatch') {
    setTimelineSyncing(sessionId, true);
    state.replayRequested = false;
    requestOrderedReplay(sessionId, state);
    return;
  }
  if (result.kind === 'duplicate') return;
  if (result.kind === 'overflow') {
    setTimelineSyncing(sessionId, true);
    toastStore.error('Activity synchronization paused: the ordered-event buffer is full.');
    return;
  }
  for (const ready of result.events) handleMessage(ready);
  if (result.kind === 'gap') {
    setTimelineSyncing(sessionId, true);
    requestOrderedReplay(sessionId, state);
    return;
  }
  if (!replayApplyingSessions.has(sessionId)) setTimelineSyncing(sessionId, false);
}

function reconcileVisibleTimeline(
  sessionId: string,
  state: OrderedSessionState,
  latestSequence: number,
): void {
  if (state.buffer.lastApplied < latestSequence) {
    setTimelineSyncing(sessionId, true);
    toastStore.error('Transcript integrity check failed: a required event is unavailable.');
    return;
  }
  if (sessionStore.activeSessionId !== sessionId) {
    setTimelineSyncing(sessionId, false);
    return;
  }
  // Keep the feed covered until persisted chat rows and replayed operational
  // rows have been merged into one canonical sequence. This prevents a fresh
  // open from ever painting a timestamp-sorted intermediate transcript.
  void sessionStore
    .fetchMessages(sessionId)
    .then((messages) => loadSessionMessages(sessionId, messages))
    .then(() => setTimelineSyncing(sessionId, false))
    .catch(() => {
      toastStore.error('Canonical session history could not be reconciled.');
    });
}

function handleOrderedProtocolMessage(message: WSMessage): boolean {
  const sessionId = message.sessionId;
  if (!sessionId) return false;
  if (message.type === 'session.cursor') {
    const cursor = message.payload as { epoch: number; latestSequence: number };
    const existing = orderedSessions.get(sessionId);
    const state: OrderedSessionState =
      existing?.buffer.epoch === cursor.epoch
        ? existing
        : {
            buffer: new OrderedEventBuffer(cursor.epoch, cursor.latestSequence, true),
            replayRequested: false,
          };
    const ready = state.buffer.establishCursor(cursor.epoch, cursor.latestSequence);
    state.replayRequested = false;
    orderedSessions.set(sessionId, state);
    for (const event of ready) handleMessage(event);
    setTimelineSyncing(sessionId, state.buffer.isWaitingForGap);
    return true;
  }
  if (message.type === 'session.replay') {
    const replay = message.payload as {
      epoch: number;
      events: WSMessage[];
      latestSequence: number;
      complete: boolean;
    };
    setTimelineSyncing(sessionId, true);
    replayApplyingSessions.add(sessionId);
    let state = orderedSessions.get(sessionId);
    if (!state || state.buffer.epoch !== replay.epoch) {
      state = {
        buffer: new OrderedEventBuffer(replay.epoch, 0, true),
        replayRequested: false,
      };
      orderedSessions.set(sessionId, state);
    }
    try {
      for (const event of replay.events) ingestOrderedEvent(event);
      state.replayRequested = false;
    } finally {
      replayApplyingSessions.delete(sessionId);
    }
    if (replay.complete) reconcileVisibleTimeline(sessionId, state, replay.latestSequence);
    return true;
  }
  if (message.type === 'session.integrity_error') {
    setTimelineSyncing(sessionId, true);
    toastStore.error('Transcript cursor mismatch. Reloading canonical session history.');
    const cursor = (message.payload as { cursor?: { epoch: number; latestSequence: number } })
      .cursor;
    void sessionStore
      .fetchMessages(sessionId)
      .then(async (messages) => {
        await loadSessionMessages(sessionId, messages);
        if (cursor) {
          orderedSessions.set(sessionId, {
            buffer: new OrderedEventBuffer(cursor.epoch, cursor.latestSequence, true),
            replayRequested: false,
          });
        }
        setTimelineSyncing(sessionId, false);
      })
      .catch(() => {
        toastStore.error('Canonical session history could not be restored.');
      });
    return true;
  }
  return false;
}

// ─── Message Handler ───────────────────────────────────────────────────────

import { wsHandlers } from './ws-handler-registry';
import { registerSessionHandlers } from './ws-handlers/session-handlers';

// Register extracted handlers. This is incremental — handlers here take
// precedence over the switch below. As more cases are extracted, the switch
// shrinks and the registry grows.
registerSessionHandlers();

function handleMessage(msg: WSMessage) {
  const eventEpoch = msg.epoch;
  const eventSequence = msg.sequence;
  if (
    msg.sessionId &&
    Number.isSafeInteger(eventEpoch) &&
    Number.isSafeInteger(eventSequence)
  ) {
    const prior = realtimeCursors.get(msg.sessionId);
    if (prior && prior.epoch === eventEpoch && eventSequence! <= prior.sequence) return;
    realtimeCursors.set(msg.sessionId, { epoch: eventEpoch!, sequence: eventSequence! });
  }
  const activeSessionId = sessionStore.activeSessionId;
  // Feed-affecting realtime events must carry an exact session identity.
  // Unscoped events are global control/catalog events only; treating them as
  // belonging to "whatever is open now" is a cross-chat data leak.
  const isForActiveSession = !!msg.sessionId && msg.sessionId === activeSessionId;
  const agents = agentStore.agents;
  const orderedMetadata = (metadata: Record<string, unknown> = {}) => ({
    ...metadata,
    eventEpoch: msg.epoch,
    sequenceStart: msg.sequence,
    sequenceEnd: msg.sequence,
  });

  // Any activity for a busy session proves the run is alive — reset its
  // silence watchdog. (Terminal events clear busy entirely below.)
  if (msg.sessionId && msg.type.startsWith('stream.')) kickBusyWatchdog(msg.sessionId);

  // Registry-based dispatch: if a handler is registered for this event type,
  // invoke it with the shared context. This replaces the switch for
  // extracted handlers.
  const registryHandler = wsHandlers.get(msg.type);
  if (registryHandler) {
    registryHandler({
      msg,
      activeSessionId,
      isForActiveSession,
      orderedMetadata,
      kickBusyWatchdog,
      clearSessionBusy,
      markSessionAgentsStopped,
      maybeClearBusy,
      feedStore,
      agentStore,
      sessionStore,
      toastStore,
    });
    return;
  }

  switch (msg.type) {
    case 'session.user_message': {
      const p = msg.payload as {
        messageId: string;
        content: string;
        attachments?: Array<{ type: string; data: string; name: string; mimeType?: string }>;
      };
      if (isForActiveSession) {
        feedStore.addUserMessage(msg.sessionId!, p.content, p.attachments, {
          messageId: p.messageId,
          createdAt: msg.timestamp,
          epoch: msg.epoch,
          sequence: msg.sequence,
        });
      }
      break;
    }
    case 'agent.spawned': {
      const p = msg.payload as AgentSpawnedPayload;
      agentStore.spawnAgent(p.agent, p.task, msg.sessionId ?? '');
      if (msg.sessionId) {
        agentStore.ensureAgentThreadFeed(msg.sessionId, p.agent.id);
      }

      if (isForActiveSession) {
        feedStore.addFeedEntry({
          timestamp: msg.timestamp,
          type: 'system',
          agentId: p.agent.id,
          agentName: p.agent.name,
          glowClass: feedStore.resolveGlowClass(p.agent),
          text: `Worker spawned: ${p.agent.name} (${providerDisplayName(p.agent.provider)} · ${p.agent.model})`,
          metadata: { domain: p.agent.domain },
        });
      }
      break;
    }

    case 'agent.thread_message': {
      const p = msg.payload as AgentThreadMessagePayload;
      const sessionId = msg.sessionId;
      if (!sessionId) break;
      const threadCurrent = agentStore.getAgentThreadEntries(sessionId, p.agentId);
      const last = threadCurrent[threadCurrent.length - 1];
      if (
        p.entry.role === 'assistant' &&
        last?.type === 'content' &&
        last.agentId === p.agentId &&
        last.text === p.entry.content.trim()
      ) {
        break;
      }
      const agentName = agentStore.getAgentFeedLabel(p.agentId);
      const role = p.entry.role;
      agentStore.upsertAgentThreadEntry(sessionId, p.agentId, {
        timestamp: p.entry.createdAt,
        type: role === 'user' ? 'user_message' : 'content',
        agentId: role === 'manager' ? 'kory-manager' : role === 'user' ? 'user' : p.agentId,
        agentName: role === 'manager' ? 'Manager' : role === 'user' ? 'You' : agentName,
        glowClass:
          role === 'assistant'
            ? feedStore.resolveGlowClass(agents.get(p.agentId)?.identity)
            : role === 'manager'
              ? 'glow-kory'
              : '',
        text: p.entry.content,
        metadata: orderedMetadata({ sessionId, sourceAgentId: p.agentId, threadRole: role }),
      });
      break;
    }

    case 'agent.status': {
      const p = msg.payload as AgentStatusPayload;
      agentStore.updateAgentStatus(p.agentId, p.status, msg.sessionId ?? undefined);
      if (isForActiveSession) {
        if (p.status === 'thinking') feedStore.beginThinking(p.agentId, msg.timestamp);
        else feedStore.finalizeThinking(p.agentId, msg.timestamp);
      }
      if (msg.sessionId && p.status !== 'thinking') {
        agentStore.finalizeAgentThreadThinking(msg.sessionId, p.agentId, msg.timestamp);
      }
      if (p.status === 'done' || p.status === 'idle' || p.status === 'waiting') {
        maybeClearBusy(msg.sessionId ?? agents.get(p.agentId)?.sessionId);
        const completedSessionId = msg.sessionId ?? agents.get(p.agentId)?.sessionId;
        if (
          p.agentId === 'kory-manager' &&
          completedSessionId &&
          completedSessionId === sessionStore.activeSessionId
        ) {
          // Tag live manager content entries with the persisted message id
          // before reloading, so the dedup in loadSessionMessages can match
          // by ID instead of falling back to text comparison.
          if (p.messageId) feedStore.tagManagerMessageId(p.messageId);
          void sessionStore
            .fetchMessages(completedSessionId)
            .then((messages) => loadSessionMessages(completedSessionId, messages));
        }
      }
      break;
    }

    case 'system.info': {
      // Cancel notification → live stop marker as plain system text, not a
      // Kory message. The backend persists a matching system row for reloads.
      const info = msg.payload as { message?: string; kind?: string };
      // Prompt-manifest provenance is available in diagnostics, but dumping its
      // full filesystem paths, hashes, and skill list into the human feed makes
      // every turn noisy and expensive to render.
      if (info?.kind === 'prompt_diagnostic') break;
      if (
        !info?.kind &&
        info?.message?.startsWith('Prompt ') &&
        info.message.includes('Instructions:')
      )
        break;
      if (isForActiveSession && info?.message) {
        feedStore.removeAnalyzingThoughtEntries();
        feedStore.addFeedEntry({
          timestamp: msg.timestamp,
          type: 'system',
          agentId: 'system',
          agentName: '',
          glowClass: '',
          text: info.kind === 'cancelled' ? 'Stopped by user.' : info.message,
          metadata: orderedMetadata(info.kind ? { kind: info.kind } : {}),
        });
      }
      break;
    }

    case 'agent.completed':
    case 'stream.complete': {
      const p = msg.payload as { agentId: string };
      if (isForActiveSession) feedStore.finalizeThinking(p.agentId, msg.timestamp);
      agentStore.completeAgent(p.agentId, msg.sessionId ?? undefined);
      if (isForActiveSession) feedStore.removeAnalyzingThoughtEntries();
      maybeClearBusy(msg.sessionId ?? agents.get(p.agentId)?.sessionId);
      // Desktop alert only for the manager finishing a turn the user may have
      // stepped away from — never for every internal worker/stream event.
      if (msg.type === 'agent.completed' && p.agentId === 'kory-manager') {
        notifyAgentFinished();
      }
      break;
    }

    case 'agent.error': {
      const p = msg.payload as { agentId?: string; error?: string };
      clearSessionBusy(msg.sessionId ?? agents.get(p.agentId ?? '')?.sessionId ?? '');
      if (isForActiveSession) {
        feedStore.removeAnalyzingThoughtEntries();
        feedStore.addFeedEntry({
          timestamp: msg.timestamp,
          type: 'error',
          agentId: p.agentId ?? '',
          agentName: agents.get(p.agentId ?? '')?.identity.name ?? 'Unknown',
          glowClass: '',
          text: p.error ?? 'Unknown error',
          metadata: orderedMetadata({ source: 'agent', sessionId: msg.sessionId }),
        });
      }
      break;
    }

    case 'stream.delta': {
      const p = msg.payload as StreamDeltaPayload;
      // Some provider adapters send an empty content_delta as a boundary
      // marker. It is not user-visible output; rendering it created blank
      // "Kory" cards with response controls.
      if (typeof p?.content !== 'string' || p.content.length === 0) break;
      // Answer text starting = the provider is done reasoning: freeze timers.
      if (isForActiveSession) feedStore.finalizeThinking(p.agentId, msg.timestamp);
      agentStore.appendAgentContent(p.agentId, p.content, msg.sessionId ?? undefined);
      if (msg.sessionId) {
        agentStore.finalizeAgentThreadThinking(msg.sessionId, p.agentId, msg.timestamp);
      }
      if (isForActiveSession) {
        feedStore.removeAnalyzingThoughtEntries();
        feedStore.accumulateFeedEntry({
          timestamp: msg.timestamp,
          type: 'content',
          agentId: p.agentId,
          agentName: agents.get(p.agentId)?.identity.name ?? 'Worker',
          glowClass: feedStore.resolveGlowClass(agents.get(p.agentId)?.identity),
          text: p.content,
          metadata: orderedMetadata(),
        });
      }
      if (msg.sessionId) {
        agentStore.accumulateAgentThreadEntry(msg.sessionId, p.agentId, {
          timestamp: msg.timestamp,
          type: 'content',
          agentId: p.agentId,
          agentName: agentStore.getAgentFeedLabel(p.agentId),
          glowClass: feedStore.resolveGlowClass(agents.get(p.agentId)?.identity),
          text: p.content,
          metadata: orderedMetadata({ sessionId: msg.sessionId }),
        });
      }
      break;
    }

    case 'stream.clear_content': {
      const p = msg.payload as { agentId: string };
      agentStore.clearAgentStreamingState(p.agentId, msg.sessionId ?? undefined);
      if (isForActiveSession) {
        feedStore.removeContentEntriesForAgent(p.agentId);
      }
      break;
    }

    case 'stream.thinking': {
      const p = msg.payload as StreamThinkingPayload;
      agentStore.appendAgentThinking(p.agentId, p.thinking, msg.sessionId ?? undefined);
      if (isForActiveSession) {
        // The ephemeral "Analyzing…" row must clear as soon as real
        // thinking starts streaming, same as it does for content deltas.
        feedStore.removeAnalyzingThoughtEntries();
        feedStore.accumulateFeedEntry({
          timestamp: msg.timestamp,
          type: 'thinking',
          agentId: p.agentId,
          agentName: agents.get(p.agentId)?.identity.name ?? 'Worker',
          glowClass: feedStore.resolveGlowClass(agents.get(p.agentId)?.identity),
          text: p.thinking,
          thinkingStartedAt: feedStore.getThinkingStart(p.agentId, msg.timestamp),
          metadata: orderedMetadata(
            typeof p.thinkingTokens === 'number' ? { thinkingTokens: p.thinkingTokens } : {},
          ),
        });
      }
      if (msg.sessionId) {
        agentStore.accumulateAgentThreadEntry(msg.sessionId, p.agentId, {
          timestamp: msg.timestamp,
          type: 'thinking',
          agentId: p.agentId,
          agentName: agentStore.getAgentFeedLabel(p.agentId),
          glowClass: feedStore.resolveGlowClass(agents.get(p.agentId)?.identity),
          text: p.thinking,
          thinkingStartedAt: feedStore.getThinkingStart(p.agentId, msg.timestamp),
          metadata: orderedMetadata({ sessionId: msg.sessionId }),
        });
      }
      break;
    }

    case 'stream.tool_call': {
      const p = msg.payload as StreamToolCallPayload;
      if (isForActiveSession) feedStore.finalizeThinking(p.agentId, msg.timestamp);
      if (msg.sessionId) {
        agentStore.finalizeAgentThreadThinking(msg.sessionId, p.agentId, msg.timestamp);
      }
      const existingToolCall =
        isForActiveSession && feedStore.updateToolCall(p.toolCall, msg.timestamp);
      if (!existingToolCall)
        agentStore.addToolCall(
          p.agentId,
          p.toolCall.id,
          p.toolCall.name,
          msg.sessionId ?? undefined,
        );
      if (isForActiveSession) {
        if (!existingToolCall)
          feedStore.addFeedEntry({
            timestamp: msg.timestamp,
            type: 'tool_call',
            agentId: p.agentId,
            agentName: agents.get(p.agentId)?.identity.name ?? 'Worker',
            glowClass: feedStore.resolveGlowClass(agents.get(p.agentId)?.identity),
            text: `Calling tool: ${p.toolCall.name}`,
            metadata: orderedMetadata({
              toolCall: p.toolCall,
              sourceProvider: p.sourceProvider,
            }),
          });
      }
      if (msg.sessionId) {
        agentStore.upsertAgentThreadEntry(msg.sessionId, p.agentId, {
          timestamp: msg.timestamp,
          type: 'tool_call',
          agentId: p.agentId,
          agentName: agentStore.getAgentFeedLabel(p.agentId),
          glowClass: feedStore.resolveGlowClass(agents.get(p.agentId)?.identity),
          text: `Calling tool: ${p.toolCall.name}`,
          metadata: orderedMetadata({
            toolCall: p.toolCall,
            sessionId: msg.sessionId,
            sourceProvider: p.sourceProvider,
          }),
        });
      }
      break;
    }

    case 'process.started':
    case 'process.exited': {
      processEventTick++;
      // Background terminals are first-class: show start/exit in the feed as
      // terminal entries so long-running commands never vanish from view.
      const p = msg.payload as {
        id: string;
        name: string;
        command: string;
        pid?: number;
        exitCode?: number;
        status?: string;
        willRestart?: boolean;
        logsTail?: string;
      };
      if (isForActiveSession) {
        const started = msg.type === 'process.started';
        const text = started
          ? `Background terminal started: ${p.name} (pid ${p.pid})\n$ ${p.command}`
          : `Background terminal ${p.status}${p.exitCode !== undefined ? ` (exit ${p.exitCode})` : ''}: ${p.name}` +
            (p.willRestart ? ' — restarting' : '') +
            (p.logsTail ? `\n${p.logsTail}` : '');
        feedStore.addFeedEntry({
          timestamp: msg.timestamp,
          type: 'tool_result',
          agentId: 'kory-manager',
          agentName: 'Kory',
          glowClass: '',
          text,
          metadata: orderedMetadata({
            toolResult: {
              callId: p.id,
              name: 'bash',
              output: text,
              isError: !started && p.status === 'crashed',
              durationMs: 0,
            },
          }),
        });
      }
      break;
    }

    case 'stream.tool_result': {
      const p = msg.payload as StreamToolResultPayload;
      const resultText = p.toolResult.isError
        ? `Tool error: ${p.toolResult.output}`
        : p.toolResult.durationMs > 0
          ? `Tool result (${p.toolResult.durationMs.toFixed(0)}ms): ${p.toolResult.output}`
          : `Tool result (time not reported by provider): ${p.toolResult.output}`;
      if (isForActiveSession) {
        const metadata = orderedMetadata({
          toolResult: p.toolResult,
          sourceProvider: p.sourceProvider,
        });
        const replacedLiveCall = feedStore.completeToolCall(
          p.toolResult,
          resultText,
          msg.timestamp,
          metadata,
        );
        if (!replacedLiveCall) {
          feedStore.addFeedEntry({
            timestamp: msg.timestamp,
            type: 'tool_result',
            agentId: p.agentId,
            agentName: agents.get(p.agentId)?.identity.name ?? 'Worker',
            glowClass: feedStore.resolveGlowClass(agents.get(p.agentId)?.identity),
            text: resultText,
            metadata,
          });
        }
      }
      agentStore.completeToolCall(p.agentId, p.toolResult.callId, msg.sessionId ?? undefined);
      if (msg.sessionId) {
        agentStore.completeAgentThreadToolCall(msg.sessionId, p.agentId, p.toolResult.callId, {
          timestamp: msg.timestamp,
          type: 'tool_result',
          agentId: p.agentId,
          agentName: agentStore.getAgentFeedLabel(p.agentId),
          glowClass: feedStore.resolveGlowClass(agents.get(p.agentId)?.identity),
          text: resultText,
          metadata: orderedMetadata({
            toolResult: p.toolResult,
            sessionId: msg.sessionId,
            sourceProvider: p.sourceProvider,
          }),
        });
      }
      break;
    }

    case 'stream.usage': {
      const p = msg.payload as StreamUsagePayload;
      agentStore.updateUsage(p.agentId, p, msg.sessionId ?? undefined);
      break;
    }

    case 'stream.file_delta': {
      const p = msg.payload as StreamFileDeltaPayload;
      if (isForActiveSession) {
        const timerKey = `${msg.sessionId}:${p.path}`;
        const prior = activeFileEdits.get(p.path);
        const existing = prior && !prior.done ? prior : undefined;
        if (existing) {
          // $state does not proxy Map contents — reassign the Map so the
          // live edit preview re-renders on every streamed delta instead
          // of freezing until file_complete.
          const next = new Map(activeFileEdits);
          next.set(p.path, { ...existing, content: existing.content + p.delta });
          activeFileEdits = next;
        } else {
          const t = fileEditTimers.get(timerKey);
          if (t) {
            clearTimeout(t);
            fileEditTimers.delete(timerKey);
          }
          const next = new Map(activeFileEdits);
          next.set(p.path, {
            path: p.path,
            content: p.delta,
            operation: p.operation,
            agentId: p.agentId,
            startedAt: Date.now(),
            oldContent: p.oldStr,
            done: false,
          });
          activeFileEdits = next;
        }
      }
      break;
    }

    case 'stream.file_complete': {
      const p = msg.payload as StreamFileCompletePayload;
      if (isForActiveSession) {
        const timerKey = `${msg.sessionId}:${p.path}`;
        const edit = activeFileEdits.get(p.path);
        if (edit) {
          edit.done = true;
          activeFileEdits = new Map(activeFileEdits);
        }
        const existingTimer = fileEditTimers.get(timerKey);
        if (existingTimer) clearTimeout(existingTimer);
        const capturedSessionId = msg.sessionId;
        const timer = setTimeout(() => {
          if (sessionStore.activeSessionId === capturedSessionId) {
            const next = new Map(activeFileEdits);
            next.delete(p.path);
            activeFileEdits = next;
          }
          fileEditTimers.delete(timerKey);
        }, 4000);
        fileEditTimers.set(timerKey, timer);
      }
      break;
    }

    case 'kory.thought': {
      const p = msg.payload as KoryThoughtPayload;
      if (typeof p?.thought !== 'string' || p.thought.length === 0) break;
      if (msg.sessionId) agentStore.setManagerSessionId(msg.sessionId);
      if (isForActiveSession) {
        koryThought = p.thought;
        koryPhase = p.phase;
        feedStore.removeAnalyzingThoughtEntries();
        feedStore.addFeedEntry({
          timestamp: msg.timestamp,
          type: 'thought',
          agentId: 'kory-manager',
          agentName: 'Kory',
          glowClass: 'glow-kory',
          text: p.thought,
          metadata: orderedMetadata({ phase: p.phase }),
        });
      }
      break;
    }

    case 'kory.routing': {
      const p = msg.payload as KoryRoutingPayload;
      if (typeof p?.reasoning !== 'string' || p.reasoning.length === 0) break;
      if (isForActiveSession) {
        feedStore.removeAnalyzingThoughtEntries();
        feedStore.addFeedEntry({
          timestamp: msg.timestamp,
          type: 'routing',
          agentId: 'kory-manager',
          agentName: 'Kory',
          glowClass: 'glow-kory',
          text: p.reasoning,
          metadata: orderedMetadata({
            domain: p.domain,
            model: p.selectedModel,
            provider: p.selectedProvider,
          }),
        });
      }
      break;
    }

    case 'kory.ask_user': {
      const p = msg.payload as Partial<KoryAskUserPayload>;
      const sid = msg.sessionId ?? activeSessionId;
      if (sid && typeof p.question === 'string') {
        const next = new Map(pendingQuestions);
        next.set(sid, {
          question: p.question,
          options: Array.isArray(p.options) ? p.options.map(String) : [],
          allowOther: p.allowOther !== false,
          allowKeepChatting: p.allowKeepChatting !== false,
          chart: p.chart,
          sliders: Array.isArray(p.sliders) ? p.sliders : undefined,
        });
        pendingQuestions = next;
      }
      break;
    }

    case 'provider.status': {
      const p = msg.payload as ProviderStatusPayload;
      const newList = Array.isArray((p as { providers?: unknown }).providers)
        ? (p as ProviderStatusPayload).providers
        : [];
      providersStore.setProviderStatusList(newList);
      break;
    }

    case 'notes.updated': {
      const p = msg.payload as { action?: string; noteId?: string };
      scheduleNotesRefresh();
      if (p.noteId && notesStore.currentNote?.id === p.noteId) {
        void notesStore.fetchNote(p.noteId);
      }
      break;
    }

    case 'goals.updated': {
      goalStore.handleUpdated(
        msg.payload as { goal?: import('@koryphaios/shared').Goal; deletedId?: string },
      );
      break;
    }

    case 'native.command': {
      // Output from a CLI provider's own /command, attributed to that harness
      // (e.g. "Claude Code", "Devin") so the user sees the harness's reply in
      // the feed. Chunks share a messageId and accumulate into one entry.
      const p = msg.payload as NativeCommandPayload;
      if (!isForActiveSession) break;
      const agentId = `native-${p.messageId}`;
      if (p.text) {
        feedStore.accumulateFeedEntry({
          timestamp: msg.timestamp,
          type: 'content',
          agentId,
          agentName: p.providerLabel,
          glowClass: '',
          text: p.text,
          metadata: orderedMetadata({
            sourceProvider: p.provider,
            nativeCommand: p.command,
            rawCommand: p.rawCommand,
            isError: p.isError,
          }),
        });
      }
      break;
    }

    case 'session.updated': {
      const p = msg.payload as { session: Session };
      if (p.session) sessionStore.handleSessionUpdate(p.session);
      break;
    }

    case 'session.deleted': {
      const p = msg.payload as { sessionId: string };
      if (p.sessionId) sessionStore.handleSessionDeleted(p.sessionId);
      break;
    }

    case 'session.idle': {
      // Definitive "session is done working" signal from the backend.
      // Replaces the 45-second polling watchdog for the common case.
      // The watchdog remains as a fallback for lost WS events.
      const p = msg.payload as SessionIdlePayload;
      if (p.sessionId) {
        // Tag live manager content entries with the persisted message id
        // before clearing busy, so the dedup in loadSessionMessages can match
        // by ID instead of falling back to text comparison.
        if (p.messageId) feedStore.tagManagerMessageId(p.messageId);
        markSessionAgentsStopped(p.sessionId);
        clearSessionBusy(p.sessionId);
      }
      break;
    }

    case 'session.changes': {
      const p = msg.payload as KorySessionChangesPayload;
      if (msg.sessionId) {
        // Reassign — Map mutation alone is not reactive under $state.
        const next = new Map(sessionChanges);
        next.set(msg.sessionId, p.changes);
        sessionChanges = next;
      }
      break;
    }

    case 'session.accept_changes': {
      if (msg.sessionId && sessionChanges.has(msg.sessionId)) {
        const next = new Map(sessionChanges);
        next.delete(msg.sessionId);
        sessionChanges = next;
      }
      break;
    }

    case 'permission.request': {
      const p = msg.payload as PermissionRequest;
      // Always store — requests carry their own sessionId and the dialog
      // filters by active session. Dropping background sessions' requests
      // left those chats hanging on an approval nobody ever saw.
      if (!pendingPermissions.some((perm) => perm.id === p.id)) {
        pendingPermissions = [...pendingPermissions, p];
        const tool =
          (p as { toolName?: string; name?: string }).toolName ??
          (p as { name?: string }).name ??
          'a tool';
        notifyNeedsAttention(`Kory wants to run ${tool}.`);
      }
      break;
    }

    case 'permission.response': {
      const p = msg.payload as { id: string; response: string };
      pendingPermissions = pendingPermissions.filter((perm) => perm.id !== p.id);
      break;
    }

    case 'context.detected': {
      const p = msg.payload as ContextDetectedPayload;
      if (isForActiveSession && p.files?.length > 0) {
        detectedContext = p.files;
        feedStore.addFeedEntry({
          timestamp: msg.timestamp,
          type: 'system',
          agentId: 'kory-manager',
          agentName: 'Kory',
          glowClass: 'glow-kory',
          text: `Auto-detected ${p.files.length} relevant file${p.files.length !== 1 ? 's' : ''}: ${p.files
            .slice(0, 3)
            .map((f) => f.path.split('/').pop())
            .join(', ')}${p.files.length > 3 ? ` and ${p.files.length - 3} more` : ''}`,
          metadata: orderedMetadata({ contextFiles: p.files }),
        });
      }
      break;
    }

    case 'system.error': {
      const p = msg.payload as { error?: string };
      if (!isForActiveSession) break;
      feedStore.removeAnalyzingThoughtEntries();
      const errorText = p.error ?? 'Unknown system error';
      if (!feedStore.isDuplicateError(errorText, msg.timestamp)) {
        toastStore.error(errorText);
        feedStore.addFeedEntry({
          timestamp: msg.timestamp,
          type: 'error',
          agentId: '',
          agentName: '',
          glowClass: '',
          text: errorText,
          metadata: orderedMetadata({ source: 'backend', sessionId: msg.sessionId }),
        });
      }
      break;
    }

    case 'system.notification': {
      const p = msg.payload as Partial<NotificationPayload>;
      if (!isForActiveSession) break;
      const notificationType = p.type ?? 'info';
      const title = (p.title ?? '').trim();
      const message = (p.message ?? '').trim();
      const text = title ? `${title}: ${message}`.trim().replace(/:$/, '') : message;
      // Drop wire-protocol dumps (e.g. "agent.completed, stream.complete") —
      // those belong in logs, never in the toast or OS notification center.
      if (
        !text ||
        isInternalEventTypeDump(text) ||
        isInternalEventTypeDump(title) ||
        isInternalEventTypeDump(message)
      ) {
        break;
      }
      pushToast(notificationType, text);
      feedStore.addFeedEntry({
        timestamp: msg.timestamp,
        type: notificationType === 'error' ? 'error' : 'system',
        agentId: '',
        agentName: '',
        glowClass: '',
        text,
        metadata: orderedMetadata({ notificationType }),
      });
      void notifyDesktop({
        title: title || 'Koryphaios',
        body: message || text,
        key: `system:${text}`,
      });
      break;
    }
  }
}

// ─── Connection Management ──────────────────────────────────────────────────

let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let reconnectAttempts = 0;
let wsCandidates: string[] = [];
let wsCandidateIndex = 0;
let candidateRetryTimer: ReturnType<typeof setTimeout> | null = null;

function ensureWsPath(url: string): string {
  return url.endsWith('/ws') ? url : `${url.replace(/\/?$/, '')}/ws`;
}

function buildWsCandidates(preferredUrl?: string): string[] {
  const directUrl = getWsUrl();
  const viteWsUrl = import.meta.env.VITE_BACKEND_WS_URL;
  const defaultBackendWs = viteWsUrl || 'ws://127.0.0.1:3001/ws';

  const candidates: string[] = [];
  if (preferredUrl) candidates.push(ensureWsPath(preferredUrl));
  if (defaultBackendWs && !candidates.includes(defaultBackendWs)) candidates.push(defaultBackendWs);
  if (directUrl && !candidates.includes(directUrl)) candidates.push(directUrl);
  if (candidates.length === 0) candidates.push(defaultBackendWs);
  return candidates;
}

function connect(url?: string) {
  if (!browser) return;
  if (import.meta.env.DEV)
    console.log(
      '[WS] connect() called, current state:',
      wsConnection?.readyState,
      'status:',
      connectionStatus,
    );
  if (
    wsConnection?.readyState === WebSocket.OPEN ||
    wsConnection?.readyState === WebSocket.CONNECTING
  ) {
    if (import.meta.env.DEV) console.log('[WS] Already connected or connecting, skipping');
    return;
  }

  if (url || wsCandidates.length === 0) {
    wsCandidates = buildWsCandidates(url);
    wsCandidateIndex = 0;
    if (import.meta.env.DEV) console.log('[WS] Built candidates:', wsCandidates);
  }

  const wsUrl = wsCandidates[wsCandidateIndex];
  if (import.meta.env.DEV) console.log('[WS] Trying URL:', wsUrl, 'index:', wsCandidateIndex);
  if (!wsUrl) {
    wsCandidateIndex = 0;
    scheduleReconnect();
    return;
  }

  connectionStatus = 'connecting';

  try {
    const protocols = ['koryphaios'];
    let finalWsUrl = wsUrl;
    if (authStore.token) {
      const sep = finalWsUrl.includes('?') ? '&' : '?';
      finalWsUrl = `${finalWsUrl}${sep}auth=${encodeURIComponent(authStore.token)}`;
    }

    if (import.meta.env.DEV) console.log('[WS] Creating WebSocket connection to:', finalWsUrl);
    const ws = new WebSocket(finalWsUrl, protocols);

    ws.onopen = () => {
      if (import.meta.env.DEV) console.log('[WS] Connection opened successfully');
      connectionStatus = 'connected';
      reconnectAttempts = 0;
      hasShownMalformedWsMessage = false;
      wsConnection = ws;
      sentSessionSubscriptions.clear();
      // Re-subscribe to every session viewed this app run, not just the
      // active one — the server keeps per-connection subscriptions, so a
      // reconnect would otherwise silently stop delivering events for
      // background chats that are still running.
      const activeSid = sessionStore.activeSessionId;
      if (activeSid) subscribedSessions.add(activeSid);
      const liveStatuses = new Set([
        'thinking',
        'streaming',
        'tool_calling',
        'waiting',
        'waiting_user',
      ]);
      for (const sid of subscribedSessions) {
        if (sid === activeSid) {
          subscribeToSession(sid);
          continue;
        }
        const hasLiveAgent = Array.from(agentStore.agents.values()).some(
          (a) => a.sessionId === sid && liveStatuses.has(a.status),
        );
        if (hasLiveAgent) subscribeToSession(sid);
      }
    };

    ws.onmessage = (event) => {
      try {
        const parsed: unknown = JSON.parse(event.data);
        if (!isWSMessageLike(parsed)) {
          if (!hasShownMalformedWsMessage) {
            hasShownMalformedWsMessage = true;
            feedStore.addClientError('Received malformed realtime update from server.');
          }
          if (import.meta.env.DEV) console.warn('Discarded malformed websocket payload', parsed);
          return;
        }
        if (handleOrderedProtocolMessage(parsed)) return;
        if (parsed.sessionId && parsed.sequence !== undefined && parsed.epoch !== undefined) {
          ingestOrderedEvent(parsed);
        } else {
          handleMessage(parsed);
        }
      } catch (error) {
        if (!hasShownMalformedWsMessage) {
          hasShownMalformedWsMessage = true;
          feedStore.addClientError('Failed to parse realtime update from server.');
        }
        if (import.meta.env.DEV) console.warn('Failed to parse websocket message', error);
      }
    };

    ws.onclose = (event) => {
      if (import.meta.env.DEV) console.log('[WS] Connection closed:', event.code, event.reason);
      connectionStatus = 'disconnected';
      wsConnection = null;
      sentSessionSubscriptions.clear();

      if (wsCandidateIndex < wsCandidates.length - 1) {
        wsCandidateIndex++;
        if (import.meta.env.DEV)
          console.log('[WS] Trying next candidate, index:', wsCandidateIndex);
        if (candidateRetryTimer) clearTimeout(candidateRetryTimer);
        candidateRetryTimer = setTimeout(() => connect(), 200);
      } else {
        wsCandidateIndex = 0;
        scheduleReconnect();
      }
    };

    ws.onerror = (error) => {
      console.error('[WS] Connection error:', error);
      connectionStatus = 'error';
    };
  } catch (err) {
    console.error('[WS] Connection exception:', err);
    connectionStatus = 'error';
    scheduleReconnect();
  }
}

function scheduleReconnect(url?: string) {
  if (reconnectTimer) clearTimeout(reconnectTimer);
  const delay = Math.min(1000 * Math.pow(2, reconnectAttempts), 30000);
  reconnectAttempts++;
  reconnectTimer = setTimeout(() => connect(url), delay);
}

// Sessions this client has subscribed to during this app run. Used to
// restore server-side subscriptions after a reconnect.
const subscribedSessions = new Set<string>();
const realtimeCursors = new Map<string, { epoch: number; sequence: number }>();
// Tracks what was actually sent on the current socket. This is distinct from
// subscribedSessions, which is the desired set restored after reconnects.
const sentSessionSubscriptions = new Set<string>();

function subscribeToSession(sessionId: string) {
  if (!sessionId) return;
  subscribedSessions.add(sessionId);
  if (wsConnection?.readyState !== WebSocket.OPEN) return;
  if (sentSessionSubscriptions.has(sessionId)) return;
  sentSessionSubscriptions.add(sessionId);
  const ordered = orderedSessions.get(sessionId);
  wsConnection.send(
    JSON.stringify({
      type: 'subscribe_session',
      sessionId,
      ...(ordered?.buffer.initialized
        ? { epoch: ordered.buffer.epoch, afterSequence: ordered.buffer.lastApplied }
        : {}),
      timestamp: Date.now(),
    }),
  );
}

function disconnect() {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  if (candidateRetryTimer) {
    clearTimeout(candidateRetryTimer);
    candidateRetryTimer = null;
  }
  for (const timer of fileEditTimers.values()) clearTimeout(timer);
  fileEditTimers.clear();
  wsConnection?.close();
  wsConnection = null;
  sentSessionSubscriptions.clear();
  connectionStatus = 'disconnected';
}

export { loadProvidersFromApi };

function sendMessage(
  sessionId: string,
  content: string,
  model?: string,
  reasoningLevel?: string,
  attachments?: Array<{ type: string; data: string; name: string; mimeType?: string }>,
  interactionMode: 'act' | 'plan' = 'act',
) {
  markSessionBusy(sessionId);
  detectedContext = [];
  void apiFetch(apiUrl('/api/messages'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      sessionId,
      content,
      model,
      reasoningLevel,
      attachments,
      interactionMode,
    }),
  })
    .then(async (res) => {
      const data = await parseJsonResponse<{ ok?: boolean; error?: string }>(res);
      if (!res.ok || data?.ok === false) {
        throw new Error(data?.error || `Request failed: ${res.status} ${res.statusText}`);
      }
    })
    .catch((error) => {
      if (import.meta.env.DEV) console.warn('Failed to send message', error);
      const message =
        error instanceof Error && error.message
          ? error.message
          : 'Message send failed. Check your connection and retry.';
      toastStore.error(message);
      feedStore.addClientError(message);
      clearSessionBusy(sessionId);
    });
}

function sendAgentMessage(
  sessionId: string,
  agentId: string,
  content: string,
  model?: string,
  reasoningLevel?: string,
) {
  if (!sessionId || !agentId || !content.trim()) return;
  void apiFetch(apiUrl(`/api/agent/${agentId}/message`), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId, content, model, reasoningLevel }),
  })
    .then(async (res) => {
      const data = await parseJsonResponse<{ ok?: boolean; error?: string }>(res);
      if (!res.ok || data?.ok === false) {
        throw new Error(data?.error || `Request failed: ${res.status} ${res.statusText}`);
      }
    })
    .catch((error) => {
      if (import.meta.env.DEV) console.warn('Failed to send agent message', error);
      const message =
        error instanceof Error && error.message
          ? error.message
          : 'Agent message send failed. Check your connection and retry.';
      toastStore.error(message);
      feedStore.addClientError(message);
    });
}

function respondToPermission(id: string, approved: boolean) {
  if (wsConnection?.readyState === WebSocket.OPEN) {
    wsConnection.send(
      JSON.stringify({
        type: 'permission.response',
        payload: { id, response: approved ? 'granted' : 'denied' },
        timestamp: Date.now(),
      }),
    );
  }
  pendingPermissions = pendingPermissions.filter((perm) => perm.id !== id);
}

function sendUserInput(sessionId: string, selection: string, text?: string) {
  if (wsConnection?.readyState === WebSocket.OPEN) {
    try {
      wsConnection.send(
        JSON.stringify({
          type: 'user_input',
          sessionId,
          selection,
          text,
          questionId: pendingQuestions.get(sessionId)?.questionId,
          timestamp: Date.now(),
        }),
      );
      if (pendingQuestions.has(sessionId)) {
        const next = new Map(pendingQuestions);
        next.delete(sessionId);
        pendingQuestions = next;
      }
    } catch (err) {
      console.error('[ws] Failed to send user_input, keeping question pending', err);
      toastStore.error('Failed to send answer. Please try again.');
    }
  } else {
    console.warn('[ws] WebSocket not open, cannot send user_input. Keeping question pending.');
    toastStore.error('Connection lost. Please wait for reconnection.');
  }
}

function respondToChanges(sessionId: string, accepted: boolean) {
  // Browser trials have no websocket, but review decisions must still mutate
  // their tab-scoped virtual repository before the pending-review UI closes.
  if (isDemoMode) {
    void import('$lib/demo-api').then((demo) => demo.resolveDemoReview(accepted));
  }
  if (wsConnection?.readyState === WebSocket.OPEN) {
    wsConnection.send(
      JSON.stringify({
        type: accepted ? 'session.accept_changes' : 'session.reject_changes',
        sessionId,
        timestamp: Date.now(),
      }),
    );
  }
  sessionChanges.delete(sessionId);
  sessionChanges = new Map(sessionChanges);
}

function setDemoSessionChanges(sessionId: string, changes: ChangeSummary[]) {
  const next = new Map(sessionChanges);
  if (changes.length) next.set(sessionId, changes);
  else next.delete(sessionId);
  sessionChanges = next;
}

function clearFeed() {
  feedStore.clearFeed();
  activeFileEdits = new Map();
  detectedContext = [];
  agentStore.clearNonManagerAgents();
}

function activateSessionFeed(sessionId: string): number {
  const generation = feedStore.activateSessionFeed(sessionId);
  activeFileEdits = new Map();
  detectedContext = [];
  agentStore.clearNonManagerAgents();
  koryThought = '';
  koryPhase = '';
  return generation;
}

async function loadSessionMessages(
  sessionId: string,
  messages: Array<{
    id: string;
    role: string;
    content: string;
    createdAt: number;
    model?: string;
    provider?: string;
    cost?: number;
    variantGroupId?: string;
    variantIndex?: number;
    kind?: string;
  }>,
  options: { generation?: number; signal?: AbortSignal } = {},
) {
  if (!feedStore.ownsFeed(sessionId, options.generation)) return;
  // Reset ancillary per-session UI state up front, but leave the feed itself
  // alone — feedStore.loadSessionMessages swaps it in atomically once the
  // fetched history is ready, avoiding a blank flash during the round trip.
  activeFileEdits = new Map();
  detectedContext = [];
  agentStore.clearNonManagerAgents();
  koryThought = '';
  koryPhase = '';
  await feedStore.loadSessionMessages(sessionId, messages, {
    ...options,
    onUsage: (usage) => agentStore.seedManagerUsage(sessionId, usage),
  });
}

async function rewind(hash: string) {
  const sessionId = sessionStore.activeSessionId;
  if (!sessionId || rewindPreviewLoadingHash) return;
  if (busySessions.has(sessionId) || agentStore.isSessionRunning(sessionId)) {
    toastStore.info('Stop the active run before rewinding this session');
    return;
  }

  rewindPreviewLoadingHash = hash;
  try {
    const res = await apiFetch(apiUrl(`/api/sessions/${sessionId}/rewind/preview`), {
      method: 'POST',
      body: JSON.stringify({ hash }),
    });
    const data = await parseJsonResponse<{
      ok?: boolean;
      data?: Omit<RewindPreview, 'sessionId'>;
      message?: string;
    }>(res);
    if (!data.ok || !data.data)
      throw new Error(data.message ?? 'Checkpoint cannot be safely restored');
    rewindPreview = { ...data.data, sessionId };
  } catch (err) {
    console.error('Rewind failed:', err);
    toastStore.error(err instanceof Error ? err.message : 'Rewind preview failed');
  } finally {
    rewindPreviewLoadingHash = null;
  }
}

function cancelRewind() {
  if (!rewindApplying) rewindPreview = null;
}

async function confirmRewind() {
  const preview = rewindPreview;
  if (!preview || rewindApplying) return;
  const sessionId = preview.sessionId;
  if (sessionStore.activeSessionId !== sessionId) {
    rewindPreview = null;
    toastStore.error('The active session changed. Open the rewind preview again.');
    return;
  }
  rewindApplying = true;
  try {
    const res = await apiFetch(apiUrl(`/api/sessions/${sessionId}/rewind`), {
      method: 'POST',
      body: JSON.stringify({
        hash: preview.targetHash,
        expectedCurrentHash: preview.currentHash,
        confirmed: true,
      }),
    });
    const data = await parseJsonResponse<{ ok?: boolean; message?: string }>(res);
    if (!data.ok) throw new Error(data.message ?? 'Rewind failed');
    rewindPreview = null;
    toastStore.success('Session rewound successfully');
    const messages = await sessionStore.fetchMessages(sessionId);
    await loadSessionMessages(sessionId, messages);
    window.dispatchEvent(new CustomEvent('kory:rewind-applied', { detail: { sessionId } }));
  } catch (err) {
    toastStore.error(err instanceof Error ? err.message : 'Rewind failed');
  } finally {
    rewindApplying = false;
  }
}

async function timeTravelAction(endpoint: 'undo' | 'redo', successLabel: string) {
  const sessionId = sessionStore.activeSessionId;
  if (!sessionId) {
    toastStore.error('No active session');
    return;
  }

  try {
    const res = await apiFetch(apiUrl(`/api/sessions/${sessionId}/${endpoint}`), {
      method: 'POST',
    });
    const data = await parseJsonResponse<{ ok?: boolean; message?: string }>(res);
    if (data.ok) {
      toastStore.success(successLabel);
      const messages = await sessionStore.fetchMessages(sessionId);
      await loadSessionMessages(sessionId, messages);
    } else {
      toastStore.error(data.message ?? 'Nothing to do');
    }
  } catch (err) {
    console.error(`${endpoint} failed:`, err);
    toastStore.error(`${endpoint} failed`);
  }
}

async function undo() {
  await timeTravelAction('undo', 'Undone');
}

async function redo() {
  await timeTravelAction('redo', 'Redone');
}

function toggleYolo() {
  setYoloMode(!isYoloMode);
}

function setYoloMode(enabled: boolean) {
  if (isYoloMode === enabled) return;
  isYoloMode = enabled;
  if (wsConnection?.readyState === WebSocket.OPEN) {
    wsConnection.send(
      JSON.stringify({
        type: 'toggle_yolo',
        enabled: isYoloMode,
        timestamp: Date.now(),
      }),
    );
  }
}

function markSessionAgentsStopped(sessionId: string) {
  clearSessionBusy(sessionId);
  agentStore.markSessionAgentsStopped(sessionId);
}

// ─── Exported Store ─────────────────────────────────────────────────────────

export const wsStore = {
  get connection() {
    return wsConnection;
  },
  get status() {
    return connectionStatus;
  },
  get agents() {
    return agentStore.agents;
  },
  get feed() {
    return feedStore.feed;
  },
  get groupedFeed() {
    return feedStore.groupedFeed;
  },
  get isLoadingSession() {
    return feedStore.isLoadingSession;
  },
  get isTimelineSyncing() {
    const sessionId = sessionStore.activeSessionId;
    return !!sessionId && timelineSyncingSessions.has(sessionId);
  },
  get agentThreadVersion() {
    return agentStore.agentThreadVersion;
  },
  get providers() {
    return providersStore.statusList;
  },
  get koryThought() {
    return koryThought;
  },
  get koryPhase() {
    return koryPhase;
  },
  get isYoloMode() {
    return isYoloMode;
  },
  get pendingPermissions() {
    return pendingPermissions;
  },
  get pendingQuestion() {
    return pendingQuestions.get(sessionStore.activeSessionId) ?? null;
  },
  get sessionChanges() {
    return sessionChanges;
  },
  get rewindPreview() {
    return rewindPreview;
  },
  get rewindApplying() {
    return rewindApplying;
  },
  get rewindPreviewLoadingHash() {
    return rewindPreviewLoadingHash;
  },
  get activeFileEdits() {
    return activeFileEdits;
  },
  get managerStatus() {
    return agentStore.getManagerStatus();
  },
  /** Exact activity state for one session. Never use the shared manager's
   * last event as a proxy here: another chat may still be running. */
  getSessionStatus: (sessionId: string | null | undefined) => {
    if (!sessionId) return 'idle';
    if (agentStore.isSessionWaiting(sessionId)) return 'waiting';
    if (agentStore.isSessionRunning(sessionId)) {
      return sessionId === sessionStore.activeSessionId && agentStore.getManagerStatus() !== 'idle'
        ? agentStore.getManagerStatus()
        : 'thinking';
    }
    return busySessions.has(sessionId) ? 'thinking' : 'idle';
  },
  get contextUsage() {
    return agentStore.getContextUsage();
  },
  get processEventTick() {
    return processEventTick;
  },
  get detectedContext() {
    return detectedContext;
  },
  isSessionRunning: agentStore.isSessionRunning,
  isSessionWaiting: agentStore.isSessionWaiting,
  isSessionBusy: (sessionId: string | null | undefined) =>
    !!sessionId && (busySessions.has(sessionId) || agentStore.isSessionRunning(sessionId)),
  markSessionAgentsStopped,
  markAgentStopped: agentStore.markAgentStopped,
  clearSessionBusy,
  stopBusyWatchdog,
  clearAnalyzing: feedStore.removeAnalyzingThoughtEntries,
  addClientError: feedStore.addClientError,
  finishSessionLoad: feedStore.finishSessionLoad,
  connect,
  disconnect,
  sendMessage,
  sendAgentMessage,
  sendUserInput,
  respondToChanges,
  setDemoSessionChanges,
  loadSessionMessages,
  loadAgentThreads: agentStore.loadAgentThreads,
  loadAgentThreadMessages: agentStore.loadAgentThreadMessages,
  getAgentThreadFeed: agentStore.getAgentThreadFeed,
  removeEntries: feedStore.removeEntries,
  setEntryVisibility: feedStore.setEntryVisibility,
  finalizeThinking: feedStore.finalizeThinking,
  setManagerContextWindow: agentStore.setManagerContextWindow,
  respondToPermission,
  subscribeToSession,
  clearFeed,
  activateSessionFeed,
  rewind,
  undo,
  redo,
  toggleYolo,
  setYoloMode,
  loadProvidersFromApi,
};
