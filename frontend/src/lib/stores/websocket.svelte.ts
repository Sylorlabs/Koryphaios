// WebSocket connection store — Svelte 5 runes for reactive agent state.
// Handles connection, reconnection, message routing, user messages, and permissions.

import type {
  FusionSelection,
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
  KorySkillPayload,
  ProviderStatusPayload,
  ChangeSummary,
  KorySessionChangesPayload,
  AgentSpawnedPayload,
  AgentStatusPayload,
  AgentThreadMessagePayload,
  AgentSteeringQueuePayload,
  PermissionRequest,
  Session,
  NotificationPayload,
  NativeCommandPayload,
  KoryAskUserPayload,
  KoryAskUserResolvedPayload,
  CompactionProgressPayload,
  SessionTimelineRewrittenPayload,
  SessionHistoryPrunedPayload,
  SessionActionableWaitsPayload,
} from '@koryphaios/shared';
import {
  hasRequiredSessionIdentity,
  isAgentBackgroundProcess,
  type SessionWSMessage,
  type ProcessProvenance,
  type ProcessSupervision,
  type ProcessTerminalReason,
} from '@koryphaios/shared';
import { sessionStore } from './sessions.svelte';
import { authStore } from './auth.svelte';
import { browser } from '$app/environment';
import type { FeedEntry } from '$lib/types';
import { apiUrl, getWsUrl } from '$lib/utils/api-url';
import {
  deviceRouting,
  deviceSessionKey,
  isDeviceSessionKey,
  mapDeviceSessionIds,
} from './device-routing.svelte';
import { apiFetch, parseJsonResponse } from '$lib/api.svelte';
import { toastStore } from './toast.svelte';
import { providersStore, loadProvidersFromApi } from './providers.svelte';
import { feedStore } from './feed.svelte';
import { agentStore } from './agents.svelte';
import { notesStore, type NotesRealtimeUpdate } from './notes.svelte';
import { goalStore } from './goals.svelte';
import { checklistStore } from './checklists.svelte';
import { isDemoMode } from '$lib/demo-flags';
import { runStateStore } from './run-state.svelte';
import { applyDesktopUiSettings } from './desktop-ui-settings-sync';
import type { DesktopUiSettings } from '@koryphaios/shared';
import {
  createWebSocketPong,
  isWebSocketPing,
  nextWebSocketCandidateIndex,
  prepareAuthenticatedWebSocketUrl,
  redactWebSocketUrl,
} from '$lib/utils/websocket-protocol';
import { OrderedSessionEventIngress } from '$lib/utils/ordered-session-events';
import {
  isImmediateOrderedErrorDuplicate,
  sequencedTerminalRunFailure,
} from '$lib/utils/run-failure-feed';
import { TimelineRewriteEpochGate } from '$lib/utils/timeline-rewrite-gate';
import {
  readReview,
  sameReview,
  reviewResolutionMatches,
  questionResolutionMatches,
} from '$lib/utils/review-protocol';
import { onSessionUnsubscribed } from './session-subscriptions';

// The session store publishes this notification instead of importing this
// module, so session lifecycle and the websocket stay one-way.
onSessionUnsubscribed(unsubscribeFromSession);

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
export interface ReviewPublication extends KorySessionChangesPayload {
  sessionId: string;
}
export interface ReviewSelection {
  review: ReviewPublication;
  selectionGeneration: number;
  routingGeneration: number;
  origin: string;
  target: { deviceId: string; id: string } | null;
}
export interface ReviewResponse {
  review: ReviewPublication;
  phase: 'submitting' | 'awaiting_confirmation' | 'uncertain' | 'failed';
  error?: string;
}
let sessionReviews = $state<Map<string, ReviewPublication>>(new Map());
let reviewResponses = $state<Map<string, ReviewResponse>>(new Map());

type CancellationKey = string;
let pendingCancellations = $state<Map<CancellationKey, Promise<void>>>(new Map());

/** A stop must not leave the composer gated forever on a backend that is
 *  draining a provider stream. The local stop is authoritative immediately;
 *  this only bounds how long a pending steering send waits for the handoff. */
const CANCELLATION_REQUEST_TIMEOUT_MS = 8_000;

function sessionCancellationKey(sessionId: string): CancellationKey {
  return `session:${sessionId}`;
}

function agentCancellationKey(sessionId: string, agentId: string): CancellationKey {
  return `agent:${sessionId}:${agentId}`;
}

function cancellationFailure(error: unknown, subject: string): Error {
  const detail = error instanceof Error && error.message ? error.message : String(error);
  return new Error(`Could not stop ${subject}: ${detail}`);
}

function cancelWithKey(
  key: CancellationKey,
  path: string,
  subject: string,
  body?: Record<string, string>,
  onAcknowledged?: () => void,
  onFailed?: () => void,
): Promise<void> {
  const existing = pendingCancellations.get(key);
  if (existing) return existing;

  let completion!: Promise<void>;
  completion = (async () => {
    // Stop is a local interruption first. Mark the captured run stopped before
    // the HTTP handoff, so a slow provider or tool call cannot leave the UI
    // frozen on "work is running". If the request fails, restore the fence so
    // the server's authoritative state can take over again.
    onAcknowledged?.();
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    try {
      const timeout = new Promise<never>((_, reject) => {
        timeoutHandle = setTimeout(
          () =>
            reject(
              new Error(`No stop confirmation within ${CANCELLATION_REQUEST_TIMEOUT_MS / 1000}s`),
            ),
          CANCELLATION_REQUEST_TIMEOUT_MS,
        );
      });
      const response = await Promise.race([
        apiFetch(apiUrl(path), {
          method: 'POST',
          ...(body
            ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
            : {}),
        }),
        timeout,
      ]);
      const result = await parseJsonResponse<{ ok?: boolean; error?: string }>(response);
      if (!response.ok || result.ok === false || result.error) {
        throw new Error(
          result.error || `Request failed: ${response.status} ${response.statusText}`,
        );
      }
    } catch (error) {
      onFailed?.();
      const failure = cancellationFailure(error, subject);
      toastStore.error(failure.message);
      throw failure;
    } finally {
      if (timeoutHandle) clearTimeout(timeoutHandle);
      if (pendingCancellations.get(key) === completion) {
        const next = new Map(pendingCancellations);
        next.delete(key);
        pendingCancellations = next;
      }
    }
  })();
  pendingCancellations = new Map(pendingCancellations).set(key, completion);
  return completion;
}

async function waitForCancellation(sessionId: string, agentId?: string): Promise<boolean> {
  const keys = [sessionCancellationKey(sessionId)];
  if (agentId) keys.push(agentCancellationKey(sessionId, agentId));
  const pending = keys
    .map((key) => pendingCancellations.get(key))
    .filter((completion): completion is Promise<void> => !!completion);
  if (!pending.length) return true;
  try {
    await Promise.all(pending);
    return true;
  } catch {
    // cancelWithKey already reports the failure. Returning false is important:
    // send callers leave the draft untouched and do not start a new run.
    return false;
  }
}

function cancelSession(sessionId: string, purpose: 'stop' | 'steer' = 'stop'): Promise<void> {
  if (!sessionId) return Promise.resolve();
  return cancelWithKey(
    sessionCancellationKey(sessionId),
    `/api/sessions/${encodeURIComponent(sessionId)}/cancel`,
    'this session',
    purpose === 'steer' ? { purpose } : undefined,
    () => markSessionAgentsStopped(sessionId),
    () => runStateStore.clearUserStopped(sessionId),
  );
}

function cancelAgent(sessionId: string, agentId: string): Promise<void> {
  if (!sessionId || !agentId) return Promise.resolve();
  return cancelWithKey(
    agentCancellationKey(sessionId, agentId),
    `/api/agent/${encodeURIComponent(agentId)}/cancel`,
    'this agent',
    undefined,
    () => {
      runStateStore.markAgentStopped(sessionId, agentId);
      agentStore.markAgentStopped(sessionId, agentId);
    },
    () => agentStore.updateAgentStatus(sessionId, agentId, 'streaming'),
  );
}

function publishReview(sessionId: string, value: unknown, fromSnapshot = false): boolean {
  const review = readReview(value);
  if (!review) return false;
  const current = sessionReviews.get(sessionId);
  if (
    fromSnapshot &&
    current &&
    sameReview(current, review) &&
    JSON.stringify(current.changes) === JSON.stringify(review.changes)
  )
    return true;
  const publication = { ...review, sessionId };
  sessionReviews = new Map(sessionReviews).set(sessionId, publication);
  sessionChanges = new Map(sessionChanges).set(sessionId, publication.changes);
  const response = reviewResponses.get(sessionId);
  if (response && !sameReview(response.review, publication)) {
    const next = new Map(reviewResponses);
    next.delete(sessionId);
    reviewResponses = next;
  }
  return true;
}

function clearReview(sessionId: string) {
  const reviews = new Map(sessionReviews);
  const changes = new Map(sessionChanges);
  const responses = new Map(reviewResponses);
  reviews.delete(sessionId);
  changes.delete(sessionId);
  responses.delete(sessionId);
  sessionReviews = reviews;
  sessionChanges = changes;
  reviewResponses = responses;
}

function resolveReview(sessionId: string, value: unknown): boolean {
  const current = sessionReviews.get(sessionId);
  if (!current || !reviewResolutionMatches(current, value)) return false;
  clearReview(sessionId);
  return true;
}

function captureReview(sessionId: string): ReviewSelection | null {
  const review = sessionReviews.get(sessionId);
  if (!review) return null;
  const chat = deviceRouting.chat;
  return {
    review,
    selectionGeneration: sessionStore.selectionGeneration,
    routingGeneration: deviceRouting.generation,
    origin: apiUrl('/api'),
    target:
      chat && deviceSessionKey(chat) === sessionId
        ? { deviceId: chat.deviceId, id: chat.id }
        : null,
  };
}

function ownsReview(selection: ReviewSelection): boolean {
  return (
    sessionReviews.get(selection.review.sessionId) === selection.review &&
    sessionStore.activeSessionId === selection.review.sessionId &&
    sessionStore.selectionGeneration === selection.selectionGeneration &&
    deviceRouting.generation === selection.routingGeneration &&
    apiUrl('/api') === selection.origin
  );
}
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

// Run-phase state (busy/running/waiting/stopped) is owned by runStateStore.
// The old busySessions/userStoppedSessions Sets and the watchdog lived here,
// but they were five overlapping signals that routinely disagreed. Now
// runStateStore.applyEvent() is the single reducer for all phase transitions.
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

/** A feed item is a worker only after the backend emitted `agent.spawned`. */
function isSpawnedSubAgent(sessionId: string, agentId: string | undefined): boolean {
  if (!agentId || !sessionId) return false;
  const identity = agentStore.getAgent(sessionId, agentId)?.identity;
  return !!identity && identity.role !== 'manager';
}

let hasShownMalformedWsMessage = false;
let fileEditTimers = new Map<string, ReturnType<typeof setTimeout>>();

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
  if (provider === 'opencode') return 'OpenCode';
  if (provider === 'beam') return 'Reflection AI';
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

function orderedEventMetadata(msg: WSMessage): Record<string, unknown> {
  return {
    ...(msg.sessionId ? { sessionId: msg.sessionId } : {}),
    ...(msg.eventId ? { eventId: msg.eventId } : {}),
    ...(Number.isSafeInteger(msg.epoch) ? { eventEpoch: msg.epoch } : {}),
    ...(Number.isSafeInteger(msg.sequence)
      ? { sequenceStart: msg.sequence, sequenceEnd: msg.sequence }
      : {}),
    ...(Number.isSafeInteger(msg.parentSequence) ? { parentSequence: msg.parentSequence } : {}),
    ...(msg.replayed ? { replayed: true } : {}),
  };
}

/** A manager stream event that belongs to a turn (Invariant 2). Such events are
 *  folded into the turn's parts (feedStore.applyManagerTurnEvent) rather than
 *  written as independent rows. */
function isManagerTurnEvent(msg: WSMessage): boolean {
  const payload = msg.payload as { agentId?: unknown; messageId?: unknown } | null;
  return (
    payload?.agentId === 'kory-manager' &&
    typeof payload.messageId === 'string' &&
    payload.messageId.length > 0
  );
}

function addBackendErrorToSessionFeed(
  msg: WSMessage,
  errorText: string,
  metadata: Record<string, unknown> & { sourceEvent: 'run.state' | 'system.error' },
): void {
  const sessionId = msg.sessionId;
  if (!sessionId) return;
  const isActive = sessionId === sessionStore.activeSessionId;
  const orderedDuplicate = isImmediateOrderedErrorDuplicate(
    feedStore.lastEntryForSession(sessionId),
    msg,
    errorText,
  );
  if (isActive) {
    feedStore.removeAnalyzingThoughtEntries(sessionId);
    if (feedStore.isDuplicateError(sessionId, errorText, msg.timestamp) || orderedDuplicate) {
      return;
    }
  }
  if (orderedDuplicate) return;
  feedStore.addFeedEntryForSession(sessionId, {
    timestamp: msg.timestamp,
    type: 'error',
    agentId: '',
    agentName: '',
    glowClass: '',
    text: errorText,
    metadata: {
      ...orderedEventMetadata(msg),
      ...metadata,
      source: 'backend',
      sessionId,
    },
  });
}

/** Apply durable session sequencing before any UI reducer sees an event. */
function ingestRealtimeMessage(msg: WSMessage): void {
  if (msg.type === 'session.history_pruned') {
    applyHistoryPruned(msg);
    return;
  }
  const result = orderedSessionIngress.ingestWithReplayRequest(msg);
  for (const ordered of result.events) handleMessage(ordered);
  if (result.replayFrom) requestSessionReplay(result.replayFrom);
}

/** Retention deleted history this client can no longer replay. Jump the
 * ordered buffer past it (no epoch rotation, no transcript reset). Only a
 * client that had already applied part of that epoch actually missed events;
 * it reloads the chat's persisted messages, which are never pruned. */
function applyHistoryPruned(msg: WSMessage): void {
  if (!msg.sessionId) return;
  const sessionId = msg.sessionId;
  const payload = msg.payload as Partial<SessionHistoryPrunedPayload> | undefined;
  const epoch = Number(payload?.epoch ?? msg.epoch);
  const through = Number(payload?.throughSequence);
  if (!Number.isSafeInteger(epoch) || !Number.isSafeInteger(through)) return;
  const { events, missed } = orderedSessionIngress.skipPrunedHistory(sessionId, epoch, through);
  for (const ordered of events) handleMessage(ordered);
  if (!missed || sessionId !== sessionStore.activeSessionId) return;
  void (async () => {
    try {
      const messages = await sessionStore.fetchMessages(sessionId);
      if (sessionId !== sessionStore.activeSessionId) return;
      await loadSessionMessages(sessionId, messages);
    } catch (error) {
      console.error('Failed to reload history after pruned events:', error);
    }
  })();
}

// ─── Message Handler ───────────────────────────────────────────────────────

const warnedUnscopedEventTypes = new Set<string>();

function handleMessage(msg: WSMessage) {
  // Invariant 4: a session-scoped event without its sessionId is dropped before
  // any store is touched. It is never attributed to whichever chat is open.
  if (!hasRequiredSessionIdentity(msg)) {
    if (!warnedUnscopedEventTypes.has(msg.type)) {
      warnedUnscopedEventTypes.add(msg.type);
      console.warn(`Dropped session-scoped realtime event without sessionId (${msg.type}).`);
    }
    return;
  }
  // The server replays a session's durable log as one fast burst. That is
  // historic evidence, not a live turn: note it so the feed holds its loading
  // surface until the burst ends rather than replaying the log on screen.
  if (msg.replayed && msg.sessionId) feedStore.noteReplayBurst(msg.sessionId);
  const activeSessionId = sessionStore.activeSessionId;
  // The open chat decides only which lane is displayed, never where a write lands.
  const isForActiveSession = !!msg.sessionId && msg.sessionId === activeSessionId;

  // Run-phase state is owned by runStateStore. Its acceptance result is
  // authoritative: once a terminal or user-stop guard rejects late traffic,
  // no feed, agent, or toast reducer may render that stale event.
  if (!runStateStore.applyEvent(msg)) return;

  switch (msg.type) {
    case 'session.timeline_rewritten': {
      const sm = msg as SessionWSMessage;
      const p = msg.payload as SessionTimelineRewrittenPayload;
      const eventEpoch = p?.eventEpoch;
      // This control fact is valid only as sequence one of the epoch it opens.
      // Reject malformed/unordered copies instead of clearing a live transcript.
      if (
        !sm.sessionId ||
        p?.reason !== 'conversation_rewind' ||
        !Number.isSafeInteger(eventEpoch) ||
        eventEpoch !== msg.epoch ||
        msg.sequence !== 1
      ) {
        break;
      }
      void applyTimelineRewrite(sm.sessionId, eventEpoch, {
        adoptIngress: false,
      });
      break;
    }

    case 'run.state': {
      const sm = msg as SessionWSMessage;
      const snapshot = (msg.payload as { snapshot?: { phase?: string; updatedAt?: number } })
        ?.snapshot;
      // The durable run aggregate is authoritative after a reload. Keep
      // worker cards inspectable, but terminalize any stale active cards that
      // predate the replayed terminal snapshot so a renderer cannot show a
      // spinner for work the backend has already closed.
      if (
        sm.sessionId &&
        snapshot &&
        (snapshot.phase === 'done' || snapshot.phase === 'error' || snapshot.phase === 'cancelled')
      ) {
        feedStore.removeAnalyzingThoughtEntries(sm.sessionId);
        if (isForActiveSession) feedStore.removeAnalyzingThoughtEntries(sm.sessionId);
        const endedAt =
          typeof snapshot.updatedAt === 'number' && Number.isFinite(snapshot.updatedAt)
            ? snapshot.updatedAt
            : null;
        finalizeSessionThinking(sm.sessionId, undefined, endedAt, true);
        agentStore.terminalizeSessionSubAgents(
          sm.sessionId,
          snapshot.phase as 'done' | 'error' | 'cancelled',
        );
      }
      const failure = sequencedTerminalRunFailure(msg, sm.sessionId);
      // Only the ordered transition is transcript evidence. The server follows
      // replay with an unsequenced current-state projection; rendering that too
      // would duplicate the durable card on every reconnect.
      if (failure) {
        addBackendErrorToSessionFeed(msg, failure.reason, {
          sourceEvent: 'run.state',
          runId: failure.snapshot.runId,
          runRevision: failure.snapshot.revision,
          terminalReason: failure.reason,
        });
      }
      break;
    }

    case 'agent.spawned': {
      const sm = msg as SessionWSMessage;
      const p = msg.payload as AgentSpawnedPayload;
      agentStore.spawnAgent(sm.sessionId, p.agent, p.task, {
        parentAgentId: p.parentAgentId,
        startedAt: msg.timestamp,
      });
      {
        agentStore.ensureAgentThreadFeed(sm.sessionId, p.agent.id);
      }

      // Critic work has its own durable `critic_review` tool card. Adding the
      // generic delegation card as well leaves two rows for one review and
      // makes the link users need compete with a transient "Delegating" row.
      // Keep the spawned identity in the rail/thread store; the evaluation
      // card remains the persistent chat/evaluation entry.
      if (p.agent.role !== 'critic') {
        feedStore.addFeedEntryForSession(sm.sessionId, {
          timestamp: msg.timestamp,
          type: 'tool_call',
          agentId: 'kory-manager',
          agentName: 'Kory',
          glowClass: 'glow-kory',
          text: `Delegating to ${p.agent.name}: ${p.task}`,
          metadata: {
            ...orderedEventMetadata(msg),
            domain: p.agent.domain,
            source: 'agent.spawned',
            delegatedAgentId: p.agent.id,
            delegatedAgentName: p.agent.name,
            toolCall: {
              id: `agent-spawn-${p.agent.id}`,
              name: 'delegate_to_worker',
              input: {
                agentId: p.agent.id,
                agentName: p.agent.name,
                domain: p.agent.domain,
                model: p.agent.model,
                provider: p.agent.provider,
                task: p.task,
              },
            },
          },
        });
      }
      break;
    }

    case 'agent.thread_message': {
      const sm = msg as SessionWSMessage;
      const p = msg.payload as AgentThreadMessagePayload;
      const sessionId = sm.sessionId;
      if (!sessionId) break;
      const threadCurrent = agentStore.getAgentThreadEntries(sessionId, p.agentId);
      const last = threadCurrent[threadCurrent.length - 1];
      if (
        p.entry.role === 'assistant' &&
        last?.type === 'content' &&
        last.agentId === p.agentId &&
        last.text === p.entry.content.trim()
      ) {
        // The streamed assistant row and this durable thread transcript row
        // are the same visible evidence. Retain both stable identities so a
        // later Hide/Delete survives either a websocket replay or a direct
        // thread-history reload.
        last.metadata = {
          ...last.metadata,
          ...orderedEventMetadata(msg),
          sessionId,
          sourceAgentId: p.agentId,
          threadRole: p.entry.role,
          threadEntryId: p.entry.id,
        };
        break;
      }
      const agentName = agentStore.getAgentFeedLabel(sm.sessionId, p.agentId);
      const role = p.entry.role;
      agentStore.upsertAgentThreadEntry(sessionId, p.agentId, {
        timestamp: p.entry.createdAt,
        type: role === 'user' ? 'user_message' : 'content',
        agentId: role === 'manager' ? 'kory-manager' : role === 'user' ? 'user' : p.agentId,
        agentName: role === 'manager' ? 'Manager' : role === 'user' ? 'You' : agentName,
        glowClass:
          role === 'assistant'
            ? feedStore.resolveGlowClass(agentStore.getAgent(sm.sessionId, p.agentId)?.identity)
            : role === 'manager'
              ? 'glow-kory'
              : '',
        text: p.entry.content,
        metadata: {
          ...orderedEventMetadata(msg),
          sessionId,
          sourceAgentId: p.agentId,
          threadRole: role,
          threadEntryId: p.entry.id,
        },
      });
      break;
    }

    case 'agent.steering_queue': {
      const sm = msg as SessionWSMessage;
      const p = msg.payload as AgentSteeringQueuePayload;
      if (p?.agentId) agentStore.setAgentSteeringQueue(sm.sessionId, p.agentId, p.commands ?? []);
      break;
    }

    case 'device.event': {
      if (typeof window !== 'undefined')
        window.dispatchEvent(new CustomEvent('kory:device-event', { detail: msg.payload }));
      break;
    }
    case 'agent.status': {
      const sm = msg as SessionWSMessage;
      const p = msg.payload as AgentStatusPayload;
      // Suppression of active statuses after a user stop is handled by
      // runStateStore.applyEvent above. Here we only need to check whether
      // applyEvent suppressed it — if the session is stoppedByUser and this
      // is an active status, skip the feed/agent update too.
      const rs = sm.sessionId ? runStateStore.states.get(sm.sessionId) : undefined;
      if (
        rs?.stoppedByUser &&
        !['done', 'idle', 'waiting', 'waiting_user', 'error'].includes(p.status)
      ) {
        break;
      }
      agentStore.updateAgentStatus(sm.sessionId, p.agentId, p.status, msg.timestamp);
      if (
        sm.sessionId &&
        p.agentId !== 'kory-manager' &&
        ['done', 'idle', 'error'].includes(p.status)
      ) {
        const agent = agentStore.getAgent(sm.sessionId, p.agentId);
        feedStore.completeToolCall(
          sm.sessionId,
          `agent-spawn-${p.agentId}`,
          `${agent?.identity.name ?? 'Agent'} ${p.status}`,
          {
            callId: `agent-spawn-${p.agentId}`,
            name: 'delegate_to_worker',
            output: `${agent?.identity.name ?? 'Agent'} ${p.status}`,
            isError: p.status === 'error',
            // Both stamps are server event timestamps, so this is the
            // delegated agent's real run time, not a client-clock guess.
            durationMs:
              agent?.startedAt !== undefined && typeof msg.timestamp === 'number'
                ? Math.max(0, msg.timestamp - agent.startedAt)
                : 0,
          },
          msg.timestamp,
          { sessionId: sm.sessionId, source: 'agent.status' },
          'kory-manager',
        );
      }
      if (['done', 'idle', 'error'].includes(p.status)) {
        finalizeSessionThinking(sm.sessionId, p.agentId, msg.timestamp, true);
      }
      if (p.status !== 'analyzing') {
        if (isForActiveSession) feedStore.removeAnalyzingThoughtEntries(sm.sessionId);
        feedStore.removeAnalyzingThoughtEntries(sm.sessionId);
      }
      if (isForActiveSession) {
        if (p.status === 'thinking')
          feedStore.beginThinking(sm.sessionId, p.agentId, msg.timestamp);
        else feedStore.finalizeThinking(sm.sessionId, p.agentId, msg.timestamp);
      }
      // Historical terminal statuses are transcript evidence, not a new turn
      // completion. The startup session loader already fetches message history;
      // refetching once for every replayed prior turn races those requests
      // against the ordered-event replay and can replace durable error/tool rows
      // with message-only history.
      if (!msg.replayed && (p.status === 'done' || p.status === 'idle' || p.status === 'waiting')) {
        const completedSessionId = sm.sessionId;
        if (
          p.agentId === 'kory-manager' &&
          completedSessionId &&
          completedSessionId === sessionStore.activeSessionId
        ) {
          void sessionStore
            .fetchMessages(completedSessionId)
            .then((messages) => loadSessionMessages(completedSessionId, messages));
          // Refresh the session list so the sidebar's message count and cost
          // reflect the turn that just completed.
          void sessionStore.fetchSessions();
        }
      }
      break;
    }

    case 'agent.updated': {
      const sm = msg as SessionWSMessage;
      const p = msg.payload as {
        agentId: string;
        model?: string;
        provider?: string;
        reasoningLevel?: string;
      };
      agentStore.updateAgentControls(sm.sessionId, p.agentId, p);
      break;
    }

    case 'system.info': {
      // Cancel notification → live stop marker as plain system text, not a
      // Kory message. The backend persists a matching system row for reloads.
      const info = msg.payload as { message?: string };
      // Prompt-manifest provenance is available in diagnostics, but dumping its
      // full filesystem paths, hashes, and skill list into the human feed makes
      // every turn noisy and expensive to render.
      const isPromptDiagnostic =
        info?.message?.startsWith('Prompt ') && info.message.includes('Instructions:');
      if (isPromptDiagnostic) break;
      if (msg.sessionId && info?.message === 'Session cancelled') {
        // The backend publishes this cancellation marker before the HTTP stop
        // response reaches the browser. Finalize here as well as on the HTTP
        // acknowledgment so the stopwatch cannot keep running in that gap.
        markSessionAgentsStopped(msg.sessionId);
      }
      if (isForActiveSession && info?.message) {
        // applyEvent already handled the "Session cancelled" stop suppression
        // and phase transition; here we just render the feed marker.
        feedStore.removeAnalyzingThoughtEntries(activeSessionId);
        feedStore.addFeedEntryForSession(activeSessionId, {
          timestamp: msg.timestamp,
          type: 'system',
          agentId: 'system',
          agentName: '',
          glowClass: '',
          text: info.message === 'Session cancelled' ? 'Stopped by user.' : info.message,
          metadata: orderedEventMetadata(msg),
        });
      }
      break;
    }

    case 'agent.completed':
    case 'stream.complete': {
      const sm = msg as SessionWSMessage;
      const p = msg.payload as { agentId: string };
      finalizeSessionThinking(sm.sessionId, p.agentId, msg.timestamp, true);
      if (isForActiveSession) feedStore.finalizeThinking(sm.sessionId, p.agentId, msg.timestamp);
      if (msg.type === 'stream.complete' && isManagerTurnEvent(msg)) {
        feedStore.applyManagerTurnEvent(sm.sessionId, msg);
      }
      agentStore.completeAgent(sm.sessionId, p.agentId);
      if (isForActiveSession) feedStore.removeAnalyzingThoughtEntries(sm.sessionId);
      // Run-phase clearing is handled by applyEvent above.
      break;
    }

    case 'agent.error': {
      const sm = msg as SessionWSMessage;
      const p = msg.payload as { agentId?: string; error?: string };
      const isSubAgent = isSpawnedSubAgent(sm.sessionId, p.agentId);
      // Run-phase error transition is handled by applyEvent above.
      finalizeSessionThinking(sm.sessionId, p.agentId, msg.timestamp, true);
      {
        if (isForActiveSession) feedStore.removeAnalyzingThoughtEntries(sm.sessionId);
        feedStore.addFeedEntryForSession(sm.sessionId, {
          timestamp: msg.timestamp,
          type: 'error',
          agentId: isSubAgent ? p.agentId! : 'kory-manager',
          agentName: isSubAgent
            ? (agentStore.getAgent(sm.sessionId, p.agentId!)?.identity.name ?? 'Worker')
            : 'Kory',
          glowClass: '',
          text: p.error ?? 'Unknown error',
          metadata: {
            ...orderedEventMetadata(msg),
            source: 'agent',
            sessionId: sm.sessionId,
            ...(isSubAgent && { isSubAgent: true }),
          },
        });
      }
      break;
    }

    case 'stream.delta': {
      const sm = msg as SessionWSMessage;
      const p = msg.payload as StreamDeltaPayload;
      const isSubAgent = isSpawnedSubAgent(sm.sessionId, p.agentId);
      // Answer text starting = the provider is done reasoning: freeze timers.
      finalizeSessionThinking(sm.sessionId, p.agentId, msg.timestamp);
      if (isForActiveSession) feedStore.finalizeThinking(sm.sessionId, p.agentId, msg.timestamp);
      agentStore.appendAgentContent(sm.sessionId, p.agentId, p.content);
      if (isManagerTurnEvent(msg)) {
        if (isForActiveSession) feedStore.removeAnalyzingThoughtEntries(sm.sessionId);
        feedStore.applyManagerTurnEvent(sm.sessionId, msg);
      } else if (isForActiveSession) {
        feedStore.removeAnalyzingThoughtEntries(sm.sessionId);
        feedStore.accumulateFeedEntry(sm.sessionId, {
          timestamp: msg.timestamp,
          type: 'content',
          agentId: p.agentId,
          agentName: agentStore.getAgent(sm.sessionId, p.agentId)?.identity.name ?? 'Worker',
          glowClass: feedStore.resolveGlowClass(
            agentStore.getAgent(sm.sessionId, p.agentId)?.identity,
          ),
          text: p.content,
          metadata: { ...orderedEventMetadata(msg), ...(isSubAgent && { isSubAgent: true }) },
        });
      }
      {
        agentStore.accumulateAgentThreadEntry(sm.sessionId, p.agentId, {
          timestamp: msg.timestamp,
          type: 'content',
          agentId: p.agentId,
          agentName: agentStore.getAgentFeedLabel(sm.sessionId, p.agentId),
          glowClass: feedStore.resolveGlowClass(
            agentStore.getAgent(sm.sessionId, p.agentId)?.identity,
          ),
          text: p.content,
          metadata: { ...orderedEventMetadata(msg), sessionId: sm.sessionId },
        });
      }
      break;
    }

    case 'stream.clear_content': {
      const sm = msg as SessionWSMessage;
      const p = msg.payload as { agentId: string };
      agentStore.clearAgentStreamingState(sm.sessionId, p.agentId);
      if (isManagerTurnEvent(msg)) {
        feedStore.applyManagerTurnEvent(sm.sessionId, msg);
      } else if (isForActiveSession) {
        feedStore.removeContentEntriesForAgent(sm.sessionId, p.agentId);
      }
      break;
    }

    case 'stream.thinking': {
      const sm = msg as SessionWSMessage;
      const p = msg.payload as StreamThinkingPayload;
      const isSubAgent = isSpawnedSubAgent(sm.sessionId, p.agentId);
      agentStore.appendAgentThinking(sm.sessionId, p.agentId, p.thinking);
      if (isManagerTurnEvent(msg)) {
        if (isForActiveSession) feedStore.removeAnalyzingThoughtEntries(sm.sessionId);
        feedStore.applyManagerTurnEvent(sm.sessionId, msg);
      } else if (isForActiveSession) {
        // The ephemeral "Analyzing…" row must clear as soon as real
        // thinking starts streaming, same as it does for content deltas.
        feedStore.removeAnalyzingThoughtEntries(sm.sessionId);
        feedStore.accumulateFeedEntry(sm.sessionId, {
          timestamp: msg.timestamp,
          type: 'thinking',
          agentId: p.agentId,
          agentName: agentStore.getAgent(sm.sessionId, p.agentId)?.identity.name ?? 'Worker',
          glowClass: feedStore.resolveGlowClass(
            agentStore.getAgent(sm.sessionId, p.agentId)?.identity,
          ),
          text: p.thinking,
          thinkingStartedAt: feedStore.getThinkingStart(sm.sessionId, p.agentId, msg.timestamp),
          ...(msg.replayed && { thinkingFinalized: true }),
          metadata: {
            ...orderedEventMetadata(msg),
            ...(isSubAgent && { isSubAgent: true }),
            ...(typeof p.thinkingTokens === 'number' ? { thinkingTokens: p.thinkingTokens } : {}),
          },
        });
      }
      {
        agentStore.accumulateAgentThreadEntry(sm.sessionId, p.agentId, {
          timestamp: msg.timestamp,
          type: 'thinking',
          agentId: p.agentId,
          agentName: agentStore.getAgentFeedLabel(sm.sessionId, p.agentId),
          glowClass: feedStore.resolveGlowClass(
            agentStore.getAgent(sm.sessionId, p.agentId)?.identity,
          ),
          text: p.thinking,
          thinkingStartedAt: feedStore.getThinkingStart(sm.sessionId, p.agentId, msg.timestamp),
          ...(msg.replayed && { thinkingFinalized: true }),
          metadata: { ...orderedEventMetadata(msg), sessionId: sm.sessionId },
        });
      }
      break;
    }

    case 'stream.tool_call': {
      const sm = msg as SessionWSMessage;
      const p = msg.payload as StreamToolCallPayload;
      const isSubAgent = isSpawnedSubAgent(sm.sessionId, p.agentId);
      finalizeSessionThinking(sm.sessionId, p.agentId, msg.timestamp);
      if (isForActiveSession) {
        feedStore.finalizeThinking(sm.sessionId, p.agentId, msg.timestamp);
        feedStore.removeAnalyzingThoughtEntries(sm.sessionId);
      }
      feedStore.removeAnalyzingThoughtEntries(sm.sessionId);
      const turnEvent = isManagerTurnEvent(msg);
      // A turn folds its tool call by call id, so "new" is the turn's answer.
      const existingToolCall = turnEvent
        ? !feedStore.applyManagerTurnEvent(sm.sessionId, msg)
        : !!sm.sessionId &&
          feedStore.updateToolCall(sm.sessionId, p.toolCall, msg.timestamp, p.agentId);
      if (!existingToolCall) agentStore.addToolCall(sm.sessionId, p.agentId, p.toolCall.name);
      agentStore.noteAgentToolCall(sm.sessionId, p.agentId, {
        id: p.toolCall.id,
        name: p.toolCall.name,
        input: p.toolCall.input as Record<string, unknown> | undefined,
      });
      if (!turnEvent) {
        if (!existingToolCall)
          feedStore.addFeedEntryForSession(sm.sessionId, {
            timestamp: msg.timestamp,
            type: 'tool_call',
            agentId: p.agentId,
            agentName: agentStore.getAgent(sm.sessionId, p.agentId)?.identity.name ?? 'Worker',
            glowClass: feedStore.resolveGlowClass(
              agentStore.getAgent(sm.sessionId, p.agentId)?.identity,
            ),
            text: `Calling tool: ${p.toolCall.name}`,
            metadata: {
              ...orderedEventMetadata(msg),
              ...(isSubAgent && { isSubAgent: true }),
              toolCall: p.toolCall,
              sourceProvider: p.sourceProvider,
            },
          });
      }
      {
        agentStore.upsertAgentThreadEntry(sm.sessionId, p.agentId, {
          timestamp: msg.timestamp,
          type: 'tool_call',
          agentId: p.agentId,
          agentName: agentStore.getAgentFeedLabel(sm.sessionId, p.agentId),
          glowClass: feedStore.resolveGlowClass(
            agentStore.getAgent(sm.sessionId, p.agentId)?.identity,
          ),
          text: `Calling tool: ${p.toolCall.name}`,
          metadata: {
            ...orderedEventMetadata(msg),
            toolCall: p.toolCall,
            sessionId: sm.sessionId,
            sourceProvider: p.sourceProvider,
          },
        });
      }
      break;
    }

    case 'process.started':
    case 'process.exited':
    case 'process.status': {
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
        provenance: ProcessProvenance;
        supervision: ProcessSupervision;
        isBackground: boolean;
        terminalReason?: ProcessTerminalReason;
        terminalError?: string;
        willRestart?: boolean;
        logsTail?: string;
      };
      if (isForActiveSession && isAgentBackgroundProcess(p)) {
        const started = msg.type === 'process.started';
        const text = started
          ? `Background terminal started: ${p.name} (pid ${p.pid})\n$ ${p.command}`
          : `Background terminal ${p.status}${p.exitCode !== undefined ? ` (exit ${p.exitCode})` : ''}${p.terminalReason ? ` [${p.terminalReason}]` : ''}: ${p.name}` +
            (p.willRestart ? ' — restarting' : '') +
            (p.terminalError ? `\n${p.terminalError}` : '') +
            (p.logsTail ? `\n${p.logsTail}` : '');
        feedStore.addFeedEntryForSession(activeSessionId, {
          timestamp: msg.timestamp,
          type: 'tool_result',
          agentId: 'kory-manager',
          agentName: 'Kory',
          glowClass: '',
          text,
          metadata: {
            ...orderedEventMetadata(msg),
            toolResult: {
              callId: p.id,
              name: 'bash',
              output: text,
              isError:
                !started &&
                (p.status === 'crashed' || p.status === 'spawn_failed' || p.status === 'orphaned'),
              durationMs: 0,
            },
          },
        });
      }
      break;
    }

    case 'stream.tool_result': {
      const sm = msg as SessionWSMessage;
      const p = msg.payload as StreamToolResultPayload;
      agentStore.noteAgentToolResult(sm.sessionId, p.agentId, p.toolResult.callId);
      if (isForActiveSession) feedStore.removeAnalyzingThoughtEntries(sm.sessionId);
      feedStore.removeAnalyzingThoughtEntries(sm.sessionId);
      const isSubAgent = isSpawnedSubAgent(sm.sessionId, p.agentId);
      const resultText = p.toolResult.isError
        ? `Tool error: ${p.toolResult.output}`
        : p.toolResult.durationMs > 0
          ? `Tool result (${p.toolResult.durationMs.toFixed(0)}ms): ${p.toolResult.output}`
          : `Tool result (time not reported by provider): ${p.toolResult.output}`;
      if (isManagerTurnEvent(msg)) {
        feedStore.applyManagerTurnEvent(sm.sessionId, msg);
      } else {
        const completed = feedStore.completeToolCall(
          sm.sessionId,
          p.toolResult.callId,
          resultText,
          p.toolResult,
          msg.timestamp,
          orderedEventMetadata(msg),
          p.agentId,
        );
        if (!completed)
          feedStore.addFeedEntryForSession(sm.sessionId, {
            timestamp: msg.timestamp,
            type: 'tool_result',
            agentId: p.agentId,
            agentName: agentStore.getAgent(sm.sessionId, p.agentId)?.identity.name ?? 'Worker',
            glowClass: feedStore.resolveGlowClass(
              agentStore.getAgent(sm.sessionId, p.agentId)?.identity,
            ),
            text: resultText,
            metadata: {
              ...orderedEventMetadata(msg),
              ...(isSubAgent && { isSubAgent: true }),
              toolResult: p.toolResult,
              sourceProvider: p.sourceProvider,
            },
          });
      }
      {
        const completed = agentStore.completeAgentThreadEntry(
          sm.sessionId,
          p.agentId,
          p.toolResult.callId,
          resultText,
          p.toolResult,
          msg.timestamp,
          orderedEventMetadata(msg),
        );
        if (!completed)
          agentStore.upsertAgentThreadEntry(sm.sessionId, p.agentId, {
            timestamp: msg.timestamp,
            type: 'tool_result',
            agentId: p.agentId,
            agentName: agentStore.getAgentFeedLabel(sm.sessionId, p.agentId),
            glowClass: feedStore.resolveGlowClass(
              agentStore.getAgent(sm.sessionId, p.agentId)?.identity,
            ),
            text: resultText,
            metadata: {
              ...orderedEventMetadata(msg),
              toolResult: p.toolResult,
              sessionId: sm.sessionId,
              sourceProvider: p.sourceProvider,
            },
          });
      }
      break;
    }

    case 'stream.usage': {
      const sm = msg as SessionWSMessage;
      const p = msg.payload as StreamUsagePayload;
      agentStore.updateUsage(sm.sessionId, p.agentId, p);
      // A turn just reported billable usage. Tell billing consumers so a spend
      // figure can refresh at the moment it changes instead of on the next tick.
      window.dispatchEvent(
        new CustomEvent('kory:usage-changed', { detail: { sessionId: sm.sessionId } }),
      );
      break;
    }

    case 'stream.file_delta': {
      const sm = msg as SessionWSMessage;
      const p = msg.payload as StreamFileDeltaPayload;
      if (isForActiveSession) {
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
          const t = fileEditTimers.get(p.path);
          if (t) {
            clearTimeout(t);
            fileEditTimers.delete(p.path);
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
      const sm = msg as SessionWSMessage;
      const p = msg.payload as StreamFileCompletePayload;
      if (isForActiveSession) {
        const edit = activeFileEdits.get(p.path);
        if (edit) {
          edit.done = true;
          activeFileEdits = new Map(activeFileEdits);
        }
        const existingTimer = fileEditTimers.get(p.path);
        if (existingTimer) clearTimeout(existingTimer);
        const timer = setTimeout(() => {
          const next = new Map(activeFileEdits);
          next.delete(p.path);
          activeFileEdits = next;
          fileEditTimers.delete(p.path);
        }, 4000);
        fileEditTimers.set(p.path, timer);
      }
      break;
    }

    case 'kory.thought': {
      const sm = msg as SessionWSMessage;
      const p = msg.payload as KoryThoughtPayload;
      if (isForActiveSession) {
        agentStore.setManagerSessionId(sm.sessionId);
        koryThought = p.thought;
        koryPhase = p.phase;
        feedStore.removeAnalyzingThoughtEntries(sm.sessionId);
        feedStore.addFeedEntryForSession(sm.sessionId, {
          timestamp: msg.timestamp,
          type: 'thought',
          agentId: 'kory-manager',
          agentName: 'Kory',
          glowClass: 'glow-kory',
          text: p.thought,
          metadata: {
            ...orderedEventMetadata(msg),
            phase: p.phase,
            ...{ sessionId: sm.sessionId },
          },
        });
      }
      break;
    }

    case 'kory.routing': {
      const sm = msg as SessionWSMessage;
      const p = msg.payload as KoryRoutingPayload;
      if (isForActiveSession) {
        feedStore.removeAnalyzingThoughtEntries(sm.sessionId);
        feedStore.addFeedEntryForSession(sm.sessionId, {
          timestamp: msg.timestamp,
          type: 'routing',
          agentId: 'kory-manager',
          agentName: 'Kory',
          glowClass: 'glow-kory',
          text: p.reasoning,
          metadata: {
            ...orderedEventMetadata(msg),
            domain: p.domain,
            model: p.selectedModel,
            provider: p.selectedProvider,
          },
        });
      }
      break;
    }

    case 'kory.skill': {
      const sm = msg as SessionWSMessage;
      const p = msg.payload as KorySkillPayload;
      if (isForActiveSession && Array.isArray(p.skills)) {
        // One row per skill: the feed reads "Used skill <name>", and a turn
        // that selects three skills is three distinct facts, not one blob.
        for (const skill of p.skills) {
          if (!skill || typeof skill.name !== 'string' || !skill.name) continue;
          feedStore.addFeedEntryForSession(sm.sessionId, {
            timestamp: msg.timestamp,
            type: 'skill',
            agentId: p.agentId ?? 'kory-manager',
            agentName: 'Kory',
            glowClass: 'glow-kory',
            text: skill.name,
            metadata: {
              ...orderedEventMetadata(msg),
              skillName: skill.name,
              representation: skill.representation,
              ...(skill.reason ? { reason: skill.reason } : {}),
              ...(skill.source ? { skillSource: skill.source } : {}),
            },
          });
        }
      }
      break;
    }

    case 'kory.ask_user': {
      const sm = msg as SessionWSMessage;
      const p = msg.payload as KoryAskUserPayload;
      const sid = sm.sessionId ?? activeSessionId;
      if (sid) {
        const options = Array.isArray(p.options)
          ? p.options.filter((o): o is string => typeof o === 'string')
          : [];
        const next = new Map(pendingQuestions);
        next.set(sid, {
          question: p.question,
          options,
          allowOther: p.allowOther || options.length === 0,
          allowKeepChatting: p.allowKeepChatting,
          questionId: p.questionId,
        });
        pendingQuestions = next;
      }
      break;
    }

    case 'kory.ask_user_resolved': {
      const sm = msg as SessionWSMessage;
      const p = msg.payload as KoryAskUserResolvedPayload;
      const sid = sm.sessionId;
      if (!sid) break;
      const current = pendingQuestions.get(sid);
      if (current && questionResolutionMatches(current, p)) {
        const next = new Map(pendingQuestions);
        next.delete(sid);
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

    case 'compaction.started':
    case 'compaction.progress':
    case 'compaction.completed':
    case 'compaction.failed': {
      const sm = msg as SessionWSMessage;
      const payload = msg.payload as CompactionProgressPayload;
      feedStore.upsertCompaction(sm.sessionId, payload, orderedEventMetadata(msg));
      // Run-phase transitions for compaction are handled by applyEvent above.
      if (msg.type === 'compaction.completed') {
        toastStore.success('Context compacted. The manager will start fresh on the next turn.');
      } else if (msg.type === 'compaction.failed') {
        toastStore.error(payload.error ?? 'Compaction failed');
      }
      break;
    }

    case 'notes.updated': {
      notesStore.handleRealtimeUpdate(msg.payload as NotesRealtimeUpdate);
      if (typeof window !== 'undefined')
        window.dispatchEvent(new CustomEvent('kory-notes-updated', { detail: msg.payload }));
      break;
    }

    case 'workspace.updated': {
      // Authoritative workspace snapshot — the main page reconciles it, which
      // replaces the high-frequency workspace polling fallback.
      if (typeof window !== 'undefined') {
        window.dispatchEvent(new CustomEvent('kory-workspace-snapshot', { detail: msg.payload }));
      }
      break;
    }

    case 'desktop.ui.updated': {
      const payload = msg.payload as {
        settings?: DesktopUiSettings;
        replayWalkthrough?: boolean;
      };
      if (payload.settings) {
        applyDesktopUiSettings(payload.settings, payload.replayWalkthrough === true);
      }
      break;
    }

    case 'goals.updated': {
      const payload = msg.payload as {
        goal?: import('@koryphaios/shared').Goal;
        deletedId?: string;
      };
      const update = goalStore.handleUpdated(payload);
      if (update.managerCreated && payload.goal) {
        goalStore.selectedGoalId = payload.goal.id;
        toastStore.success('Kory started a durable goal');
        queueMicrotask(() =>
          window.dispatchEvent(
            new CustomEvent('kory:goal-action', {
              detail: { action: 'goal_open', source: 'manager' },
            }),
          ),
        );
      }
      break;
    }

    case 'checklists.updated': {
      // One handler for human and agent edits alike, so a list ticked by a
      // worker agent appears in the open panel and the transcript at once.
      checklistStore.handleUpdated(
        msg.payload as {
          checklist?: import('@koryphaios/shared').Checklist;
          deletedId?: string;
        },
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
        feedStore.accumulateFeedEntry(activeSessionId, {
          timestamp: msg.timestamp,
          type: 'content',
          agentId,
          agentName: p.providerLabel,
          glowClass: '',
          text: p.text,
          metadata: {
            ...orderedEventMetadata(msg),
            sourceProvider: p.provider,
            nativeCommand: p.command,
            rawCommand: p.rawCommand,
            isError: p.isError,
          },
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

    case 'session.changes': {
      const sm = msg as SessionWSMessage;
      publishReview(sm.sessionId, msg.payload);
      break;
    }

    case 'session.changes_resolved': {
      const sm = msg as SessionWSMessage;
      resolveReview(sm.sessionId, msg.payload);
      break;
    }

    case 'session.accept_changes': {
      const sm = msg as SessionWSMessage;
      const current = sm.sessionId ? sessionReviews.get(sm.sessionId) : null;
      if (current && !current.reviewId && !current.reviewRevision) clearReview(current.sessionId);
      break;
    }

    case 'session.actionable_waits': {
      const p = msg.payload as SessionActionableWaitsPayload;
      const sessionIds = [...(p.questionSessionIds ?? []), ...(p.reviewSessionIds ?? [])];
      for (const sessionId of new Set(sessionIds)) {
        if (typeof sessionId === 'string' && sessionId) subscribeToSession(sessionId);
      }
      break;
    }

    case 'permission.request': {
      const sm = msg as SessionWSMessage;
      const p = msg.payload as PermissionRequest;
      // Always store — requests carry their own sessionId and the dialog
      // filters by active session. Dropping background sessions' requests
      // left those chats hanging on an approval nobody ever saw.
      if (!pendingPermissions.some((perm) => perm.id === p.id)) {
        pendingPermissions = [...pendingPermissions, p];
      }
      break;
    }

    case 'permission.response': {
      const sm = msg as SessionWSMessage;
      const p = msg.payload as { id: string; response: string };
      pendingPermissions = pendingPermissions.filter((perm) => perm.id !== p.id);
      break;
    }

    case 'context.detected': {
      const sm = msg as SessionWSMessage;
      const p = msg.payload as ContextDetectedPayload;
      if (isForActiveSession && p.files?.length > 0) {
        detectedContext = p.files;
        feedStore.addFeedEntryForSession(sm.sessionId, {
          timestamp: msg.timestamp,
          type: 'system',
          agentId: 'kory-manager',
          agentName: 'Kory',
          glowClass: 'glow-kory',
          text: `Auto-detected ${p.files.length} relevant file${p.files.length !== 1 ? 's' : ''}: ${p.files
            .slice(0, 3)
            .map((f) => f.path.split('/').pop())
            .join(', ')}${p.files.length > 3 ? ` and ${p.files.length - 3} more` : ''}`,
          metadata: { ...orderedEventMetadata(msg), contextFiles: p.files },
        });
      }
      break;
    }

    case 'system.error': {
      const p = msg.payload as { error?: string };
      const errorText = p.error ?? 'Unknown system error';
      addBackendErrorToSessionFeed(msg, errorText, { sourceEvent: 'system.error' });
      break;
    }

    case 'system.notification': {
      const p = msg.payload as Partial<NotificationPayload>;
      if (!isForActiveSession) break;
      const notificationType = p.type ?? 'info';
      const text = p.title
        ? `${p.title}: ${p.message ?? ''}`.trim()
        : (p.message ?? 'Notification');
      if (notificationType !== 'error') pushToast(notificationType, text);
      feedStore.addFeedEntryForSession(activeSessionId, {
        timestamp: msg.timestamp,
        type: notificationType === 'error' ? 'error' : 'system',
        agentId: '',
        agentName: '',
        glowClass: '',
        text,
        metadata: { ...orderedEventMetadata(msg), notificationType },
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
let connectInFlight: Promise<void> | null = null;
let connectGeneration = 0;
let shouldReconnect = false;

function ensureWsPath(url: string): string {
  return url.endsWith('/ws') ? url : `${url.replace(/\/?$/, '')}/ws`;
}

function buildWsCandidates(preferredUrl?: string): string[] {
  const directUrl = getWsUrl();
  // The baked VITE/localhost default is a dev-server convenience only; in
  // production builds (incl. the Tauri bundle) the app must not send its
  // bearer token to whatever happens to listen on the dev port.
  const viteWsUrl = import.meta.env.DEV ? import.meta.env.VITE_BACKEND_WS_URL : undefined;
  const defaultBackendWs = viteWsUrl || (import.meta.env.DEV ? 'ws://127.0.0.1:3001/ws' : '');

  const candidates: string[] = [];
  if (preferredUrl) candidates.push(ensureWsPath(preferredUrl));
  if (directUrl && !candidates.includes(directUrl)) candidates.push(directUrl);
  if (defaultBackendWs && !candidates.includes(defaultBackendWs)) candidates.push(defaultBackendWs);
  return candidates;
}

function connect(url?: string) {
  if (!browser) return;
  shouldReconnect = true;
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
    console.log('[WS] Already connected or connecting, skipping');
    return;
  }
  if (connectInFlight) {
    console.log('[WS] Authentication refresh already in progress, skipping');
    return;
  }

  const generation = connectGeneration;
  const attempt = connectAuthenticated(url, generation);
  connectInFlight = attempt;
  void attempt.finally(() => {
    if (connectInFlight === attempt) connectInFlight = null;
  });
}

async function connectAuthenticated(url: string | undefined, generation: number): Promise<void> {
  if (!shouldReconnect || generation !== connectGeneration) return;

  if (url || wsCandidates.length === 0) {
    wsCandidates = buildWsCandidates(url);
    wsCandidateIndex = 0;
    console.log('[WS] Built candidates:', wsCandidates.map(redactWebSocketUrl));
  }

  const wsUrl = wsCandidates[wsCandidateIndex];
  console.log('[WS] Trying URL:', redactWebSocketUrl(wsUrl), 'index:', wsCandidateIndex);
  if (!wsUrl) {
    wsCandidateIndex = 0;
    scheduleReconnect();
    return;
  }

  connectionStatus = 'connecting';

  try {
    const protocols = ['koryphaios'];
    const finalWsUrl = await prepareAuthenticatedWebSocketUrl(
      wsUrl,
      () => authStore.ensureSession(),
      () => authStore.token,
    );
    if (!shouldReconnect || generation !== connectGeneration) return;
    if (!finalWsUrl) {
      console.warn('[WS] Authentication unavailable; reconnect deferred');
      connectionStatus = 'error';
      scheduleReconnect();
      return;
    }
    if (
      wsConnection?.readyState === WebSocket.OPEN ||
      wsConnection?.readyState === WebSocket.CONNECTING
    ) {
      return;
    }

    console.log('[WS] Creating WebSocket connection to:', redactWebSocketUrl(finalWsUrl));
    const ws = new WebSocket(finalWsUrl, protocols);
    let opened = false;
    wsConnection = ws;

    ws.onopen = () => {
      if (!shouldReconnect || generation !== connectGeneration || wsConnection !== ws) {
        ws.close();
        return;
      }
      opened = true;
      console.log('[WS] Connection opened successfully');
      connectionStatus = 'connected';
      reconnectAttempts = 0;
      hasShownMalformedWsMessage = false;
      wsConnection = ws;
      sentSessionSubscriptions.clear();
      // Recover membership and durable outcomes missed while disconnected,
      // not just the selected transcript/workspace listing.
      void sessionStore.fetchSessions?.();
      // Re-subscribe to every session viewed this app run, not just the
      // active one — the server keeps per-connection subscriptions, so a
      // reconnect would otherwise silently stop delivering events for
      // background chats that are still running.
      const activeSid = sessionStore.activeSessionId;
      if (activeSid) subscribedSessions.add(activeSid);
      for (const sid of subscribedSessions) {
        subscribeToSession(sid);
      }
      // A fresh renderer otherwise knows only its active chat. Ask for the
      // compact durable index of background chats waiting on the user, then
      // subscribe to precisely those sessions so their ask/review controls
      // are reconstructed without replaying every historical chat.
      ws.send(
        JSON.stringify({
          type: 'session.actionable_waits.request',
          timestamp: Date.now(),
        }),
      );
      // Broadcasts missed while disconnected are unrecoverable (workspace
      // events are ephemeral) — pull authoritative state once on reconnect.
      if (typeof window !== 'undefined') {
        window.dispatchEvent(new CustomEvent('kory-workspace-refresh'));
      }
    };

    ws.onmessage = (event) => {
      try {
        const parsed: unknown = JSON.parse(event.data);
        if (!isWSMessageLike(parsed)) {
          if (!hasShownMalformedWsMessage) {
            hasShownMalformedWsMessage = true;
            feedStore.addClientError(
              sessionStore.activeSessionId,
              'Received malformed realtime update from server.',
            );
          }
          if (import.meta.env.DEV) {
            console.warn('Discarded malformed websocket payload', {
              payloadType:
                parsed === null ? 'null' : Array.isArray(parsed) ? 'array' : typeof parsed,
              payloadBytes:
                typeof event.data === 'string'
                  ? new TextEncoder().encode(event.data).byteLength
                  : 0,
            });
          }
          return;
        }
        if (isWebSocketPing(parsed)) {
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify(createWebSocketPong()));
          }
          return;
        }
        ingestRealtimeMessage(parsed);
      } catch (error) {
        if (!hasShownMalformedWsMessage) {
          hasShownMalformedWsMessage = true;
          feedStore.addClientError(
            sessionStore.activeSessionId,
            'Failed to parse realtime update from server.',
          );
        }
        if (import.meta.env.DEV) {
          console.warn('Failed to parse websocket message', {
            payloadType:
              event.data === null
                ? 'null'
                : Array.isArray(event.data)
                  ? 'array'
                  : typeof event.data,
            payloadBytes:
              typeof event.data === 'string' ? new TextEncoder().encode(event.data).byteLength : 0,
            parseErrorType: error instanceof SyntaxError ? 'SyntaxError' : 'Error',
          });
        }
      }
    };

    ws.onclose = (event) => {
      if (wsConnection !== ws) return;
      console.log('[WS] Connection closed:', event.code, event.reason);
      connectionStatus = 'disconnected';
      wsConnection = null;
      sentSessionSubscriptions.clear();
      orderedSessionIngress.clearPending();
      if (!shouldReconnect || generation !== connectGeneration) return;

      const nextCandidate = nextWebSocketCandidateIndex(
        wsCandidateIndex,
        wsCandidates.length,
        opened,
      );
      if (!opened && nextCandidate !== 0) {
        wsCandidateIndex = nextCandidate;
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
  if (!shouldReconnect) return;
  if (reconnectTimer) clearTimeout(reconnectTimer);
  const delay = Math.min(1000 * Math.pow(2, reconnectAttempts), 30000);
  reconnectAttempts++;
  reconnectTimer = setTimeout(() => connect(url), delay);
}

// Sessions this client has subscribed to during this app run. Used to
// restore server-side subscriptions after a reconnect.
const subscribedSessions = new Set<string>();
const orderedSessionIngress = new OrderedSessionEventIngress<WSMessage>();
const timelineRewriteGate = new TimelineRewriteEpochGate();
const timelineRewriteRefreshes = new Map<string, { epoch: number; completion: Promise<void> }>();
// Tracks what was actually sent on the current socket. This is distinct from
// subscribedSessions, which is the desired set restored after reconnects.
const sentSessionSubscriptions = new Set<string>();

/** Recover a dropped ordered event without cycling the socket. The backend's
 * subscribe handler is idempotent and replays every durable row after this
 * last-applied cursor, including the terminal event currently held in ingress. */
function requestSessionReplay(cursor: {
  sessionId: string;
  epoch: number;
  sequence: number;
}): void {
  const target = deviceRouting.chat;
  if (isDeviceSessionKey(cursor.sessionId)) {
    if (!target || deviceSessionKey(target) !== cursor.sessionId) return;
    void apiFetch(apiUrl(`/api/devices/${target.deviceId}/rpc`), {
      method: 'POST',
      body: JSON.stringify({
        operation: 'events',
        input: { sessionId: target.id, epoch: cursor.epoch, sequence: cursor.sequence },
      }),
    })
      .then((response) => response.json())
      .then((result) => {
        if (result.ok && Array.isArray(result.data))
          for (const message of result.data)
            ingestRealtimeMessage(mapDeviceSessionIds(message, target, true));
      })
      .catch(() => undefined);
    return;
  }
  if (wsConnection?.readyState !== WebSocket.OPEN) return;
  wsConnection.send(
    JSON.stringify({
      type: 'subscribe_session',
      sessionId: cursor.sessionId,
      timestamp: Date.now(),
      epoch: cursor.epoch,
      sequence: cursor.sequence,
    }),
  );
}

function adoptRewrittenSessionEpoch(sessionId: string, epoch: number): void {
  orderedSessionIngress.resetSessionToEpoch(sessionId, epoch);
  subscribedSessions.add(sessionId);
  sentSessionSubscriptions.delete(sessionId);
  subscribeToSession(sessionId);
}

/** Apply a durable timeline rewrite once per session epoch. The WS control row
 * normally wins the race; the initiating HTTP response is a fallback when the
 * socket is disconnected and otherwise awaits the same history refresh. */
function applyTimelineRewrite(
  sessionId: string,
  epoch: number,
  options: { adoptIngress: boolean },
): Promise<void> {
  const lease = timelineRewriteGate.adopt(sessionId, epoch);
  if (!lease) return Promise.resolve();
  if (!lease.accepted) {
    return lease.epoch === epoch
      ? (timelineRewriteRefreshes.get(sessionId)?.completion ?? Promise.resolve())
      : Promise.resolve();
  }

  const rewriteGeneration = feedStore.resetSessionFeed(sessionId);
  agentStore.invalidateManagerContextUsage(sessionId);
  if (options.adoptIngress) adoptRewrittenSessionEpoch(sessionId, epoch);

  const completion = (async () => {
    if (sessionId !== sessionStore.activeSessionId) return;
    // Never trust a load that began before the epoch control row. It may have
    // captured the discarded branch; resetSessionFeed invalidated its
    // generation, and this is the one authoritative post-rewrite refresh.
    try {
      const messages = await sessionStore.fetchMessages(sessionId, lease.signal);
      if (lease.signal.aborted || !timelineRewriteGate.isCurrent(sessionId, epoch)) return;
      await loadSessionMessages(sessionId, messages, {
        generation: rewriteGeneration,
        signal: lease.signal,
      });
    } catch (error) {
      if (lease.signal.aborted) return;
      feedStore.finishSessionLoad(sessionId);
      const detail = error instanceof Error ? error.message : 'Unknown history refresh failure';
      console.error('Failed to reload rewritten session history:', error);
      if (sessionId === sessionStore.activeSessionId) {
        feedStore.addClientError(sessionId, `Rewritten chat history failed to load: ${detail}`);
      }
    }
  })();
  timelineRewriteRefreshes.set(sessionId, { epoch, completion });
  return completion;
}

function subscribeToSession(sessionId: string) {
  if (!sessionId) return;
  if (isDeviceSessionKey(sessionId)) {
    const target = deviceRouting.chat;
    if (
      !target ||
      deviceSessionKey(target) !== sessionId ||
      sentSessionSubscriptions.has(sessionId) ||
      wsConnection?.readyState !== WebSocket.OPEN
    )
      return;
    subscribedSessions.add(sessionId);
    sentSessionSubscriptions.add(sessionId);
    const ownConnection = connectGeneration;
    const ownRouting = deviceRouting.generation;
    const ownSelection = sessionStore.selectionGeneration;
    const origin = apiUrl('/api');
    const current = () =>
      ownConnection === connectGeneration &&
      ownRouting === deviceRouting.generation &&
      ownSelection === sessionStore.selectionGeneration &&
      deviceRouting.chat === target &&
      origin === apiUrl('/api');
    // Reconnect uses the same guarded snapshot projection as opening and polling.
    // A second reducer here previously resurrected reviews resolved during open.
    void import('./devices.svelte')
      .then(async ({ deviceStore }) => {
        if (!current()) return;
        const owner = deviceStore.captureChat();
        if (!owner || !deviceStore.ownsChat(owner)) {
          sentSessionSubscriptions.delete(sessionId);
          return;
        }
        const applied = await deviceStore.refreshChat(owner, 'open_chat');
        if (!current()) return;
        if (!applied) {
          sentSessionSubscriptions.delete(sessionId);
          return;
        }
        const cursor = orderedSessionIngress.getCursor(sessionId);
        if (cursor) requestSessionReplay({ sessionId, ...cursor });
      })
      .catch((error) => {
        if (current()) {
          sentSessionSubscriptions.delete(sessionId);
          toastStore.error(error.message);
        }
      });
    return;
  }
  subscribedSessions.add(sessionId);
  if (wsConnection?.readyState !== WebSocket.OPEN) return;
  // WebSocket open and Svelte's queued session activation can race during a
  // full app relaunch. Replaying into the active session before its feed owns
  // that session writes durable rows into the previous/empty feed, and the
  // subsequent activation clears them. Keep the desired subscription queued;
  // useSessionSync calls this again immediately after activateSessionFeed.
  if (sessionId === sessionStore.activeSessionId && !feedStore.ownsFeed(sessionId)) return;
  if (sentSessionSubscriptions.has(sessionId)) return;
  sentSessionSubscriptions.add(sessionId);
  // A fresh renderer has no cursor and replays the retained log from zero.
  // The server suppresses stream events whose turn is already durable as
  // persisted `parts` — the HTTP projection carries those rows — so replay
  // delivers only operational state and the in-flight turn
  // (websocket-handler.ts isReplayCoveredByPersistedParts).
  // An in-app reconnect resumes after the last event actually applied.
  const cursor = orderedSessionIngress.getCursor(sessionId);
  wsConnection.send(
    JSON.stringify({
      type: 'subscribe_session',
      sessionId,
      timestamp: Date.now(),
      epoch: cursor?.epoch,
      sequence: cursor?.sequence,
    }),
  );
}

/** Remove a session from the subscription set so a WS reconnect does not
 *  re-subscribe to (and replay stale events for) a deleted chat. */
function unsubscribeFromSession(sessionId: string) {
  subscribedSessions.delete(sessionId);
  sentSessionSubscriptions.delete(sessionId);
  orderedSessionIngress.resetSession(sessionId);
  timelineRewriteGate.clearSession(sessionId);
  timelineRewriteRefreshes.delete(sessionId);
}

function disconnect() {
  shouldReconnect = false;
  connectGeneration++;
  connectInFlight = null;
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
  orderedSessionIngress.clearPending();
  const connection = wsConnection;
  wsConnection = null;
  connection?.close();
  sentSessionSubscriptions.clear();
  connectionStatus = 'disconnected';
}

export { loadProvidersFromApi };

/** Stable id for one user send. The server's command ledger replays the first
 *  result for a repeated id, so a send can be retried after a dropped
 *  connection without posting the message twice or starting a second turn. */
function newClientMessageId(): string {
  return `cm_${crypto.randomUUID().replace(/-/g, '')}`;
}

/** A network failure (no HTTP response) is safe to retry because the request
 *  carries a clientMessageId; HTTP errors are answers and are not retried. */
const SEND_NETWORK_RETRIES = 2;
const SEND_RETRY_BASE_MS = 400;

async function postMessageIdempotently(body: Record<string, unknown>): Promise<Response> {
  let attempt = 0;
  for (;;) {
    try {
      return await apiFetch(apiUrl('/api/messages'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
    } catch (error) {
      if (attempt >= SEND_NETWORK_RETRIES) throw error;
      attempt += 1;
      await new Promise((resolve) => setTimeout(resolve, SEND_RETRY_BASE_MS * attempt));
    }
  }
}

async function sendMessage(
  sessionId: string,
  content: string,
  model?: string,
  reasoningLevel?: string,
  attachments?: Array<{ type: string; data: string; name: string; mimeType?: string }>,
  speedTier?: string,
  imageInputMode: 'reject' | 'omit' | 'allow' = 'reject',
  modelParameters?: Record<string, number | string>,
  fusion?: FusionSelection,
): Promise<boolean> {
  // Stop is an HTTP handoff, not a local UI transition. A terminal run.state
  // can arrive before the cancel response, so wait on the captured session's
  // cancellation before adding a user message or starting the next run.
  if (!(await waitForCancellation(sessionId))) return false;
  const optimisticEntryId = feedStore.addUserMessage(sessionId, content, attachments);
  runStateStore.startRun(sessionId);
  detectedContext = [];
  try {
    const res = await postMessageIdempotently({
      sessionId,
      clientMessageId: newClientMessageId(),
      content,
      model,
      reasoningLevel,
      attachments,
      speedTier,
      imageInputMode,
      modelParameters,
      fusion,
    });
    const data = await parseJsonResponse<{
      ok?: boolean;
      error?: string;
      data?: { messageId?: string };
    }>(res);
    if (!res.ok || data?.ok === false) {
      throw new Error(data?.error || `Request failed: ${res.status} ${res.statusText}`);
    }
    if (optimisticEntryId && typeof data?.data?.messageId === 'string') {
      feedStore.bindMessageIdentity(sessionId, optimisticEntryId, data.data.messageId);
    }
    // Refresh the session list so the sidebar's message count updates
    // immediately after the user's message is persisted.
    void sessionStore.fetchSessions();
    return true;
  } catch (error) {
    if (import.meta.env.DEV) console.warn('Failed to send message', error);
    const message =
      error instanceof Error && error.message
        ? error.message
        : 'Message send failed. Check your connection and retry.';
    if (optimisticEntryId) feedStore.removeEntries(sessionId, new Set([optimisticEntryId]));
    feedStore.addClientError(sessionId, message);
    runStateStore.markUserStopped(sessionId);
    return false;
  }
}

/** Steer the active manager turn with the instruction currently in the
 * composer. The backend owns the semantics: the send parks behind the live
 * run, the running stack finishes its in-flight tool call or provider turn
 * and yields at a safe boundary, then the message is admitted as the next
 * turn. No client-side cancel — tearing a turn down mid-edit is exactly what
 * checkpoint steering exists to avoid. Stop remains the hard kill. */
async function steerMessage(
  sessionId: string,
  content: string,
  model?: string,
  reasoningLevel?: string,
  attachments?: Array<{ type: string; data: string; name: string; mimeType?: string }>,
  speedTier?: string,
  imageInputMode: 'reject' | 'omit' | 'allow' = 'reject',
  modelParameters?: Record<string, number | string>,
  fusion?: FusionSelection,
): Promise<boolean> {
  if (!sessionId) return false;
  return sendMessage(
    sessionId,
    content,
    model,
    reasoningLevel,
    attachments,
    speedTier,
    imageInputMode,
    modelParameters,
    fusion,
  );
}

async function sendAgentMessage(
  sessionId: string,
  agentId: string,
  content: string,
  model?: string,
  reasoningLevel?: string,
): Promise<boolean> {
  if (!sessionId || !agentId || !content.trim()) return false;
  if (!(await waitForCancellation(sessionId, agentId))) return false;
  try {
    const res = await apiFetch(apiUrl(`/api/agent/${agentId}/message`), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId, content, model, reasoningLevel }),
    });
    const data = await parseJsonResponse<{ ok?: boolean; error?: string }>(res);
    if (!res.ok || data?.ok === false) {
      throw new Error(data?.error || `Request failed: ${res.status} ${res.statusText}`);
    }
    return true;
  } catch (error) {
    if (import.meta.env.DEV) console.warn('Failed to send agent message', error);
    const message =
      error instanceof Error && error.message
        ? error.message
        : 'Agent message send failed. Check your connection and retry.';
    feedStore.addClientError(sessionStore.activeSessionId, message);
    return false;
  }
}

function respondToPermission(id: string, approved: boolean) {
  const permission = pendingPermissions.find((perm) => perm.id === id);
  const target = deviceRouting.chat;
  if (target && permission?.sessionId === deviceSessionKey(target)) {
    void apiFetch(apiUrl(`/api/devices/${target.deviceId}/rpc`), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        operation: 'permission',
        input: {
          sessionId: target.id,
          permissionId: id,
          selection: approved ? 'granted' : 'denied',
        },
      }),
    })
      .then(async (response) => {
        if (!response.ok) {
          const body = await parseJsonResponse<{ error?: string }>(response).catch(
            () => ({ error: undefined }) as { error?: string },
          );
          throw new Error(body.error || 'Could not send the permission response to the target.');
        }
        pendingPermissions = pendingPermissions.filter((perm) => perm.id !== id);
      })
      .catch((error) =>
        toastStore.error(error instanceof Error ? error.message : 'Permission response failed.'),
      );
    return;
  }
  if (wsConnection?.readyState === WebSocket.OPEN) {
    wsConnection.send(
      JSON.stringify({
        type: 'permission.response',
        payload: { id, response: approved ? 'granted' : 'denied' },
        sessionId: permission?.sessionId,
        timestamp: Date.now(),
      }),
    );
  }
  pendingPermissions = pendingPermissions.filter((perm) => perm.id !== id);
}

function sendUserInput(sessionId: string, selection: string, text?: string) {
  const target = deviceRouting.chat;
  if (target && sessionId === deviceSessionKey(target)) {
    void apiFetch(apiUrl(`/api/devices/${target.deviceId}/rpc`), {
      method: 'POST',
      body: JSON.stringify({
        operation: 'answer',
        input: {
          sessionId: target.id,
          selection,
          text,
          questionId: pendingQuestions.get(sessionId)?.questionId,
        },
      }),
    })
      .then((response) => {
        if (!response.ok) throw new Error('Could not send the answer to the target.');
      })
      .catch((error) => toastStore.error(error.message));
    return;
  }
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

async function respondToChanges(
  sessionId: string,
  accepted: boolean,
  selection: ReviewSelection,
): Promise<void> {
  if (!selection || selection.review.sessionId !== sessionId || !ownsReview(selection)) return;
  const prior = reviewResponses.get(sessionId);
  if (prior && prior.phase !== 'failed') return;
  const review = selection.review;
  let attempt: ReviewResponse = { review, phase: 'submitting' };
  reviewResponses = new Map(reviewResponses).set(sessionId, attempt);
  let sent = false;
  const update = (phase: ReviewResponse['phase'], error?: string) => {
    if (reviewResponses.get(sessionId) !== attempt) return;
    attempt = { review, phase, error };
    reviewResponses = new Map(reviewResponses).set(sessionId, attempt);
  };
  try {
    if (isDemoMode && !selection.target) {
      const demo = await import('$lib/demo-api');
      if (!ownsReview(selection)) {
        update('failed', 'The displayed review changed.');
        return;
      }
      await demo.resolveDemoReview(accepted);
      if (sessionReviews.get(sessionId) === review && apiUrl('/api') === selection.origin)
        clearReview(sessionId);
      return;
    }
    if (!review.reviewId || !review.reviewRevision)
      throw new Error(
        'Refresh this review before responding; its publication identity is missing.',
      );
    if (isDeviceSessionKey(sessionId) && !selection.target)
      throw new Error('Open this review on its linked desktop before responding.');
    if (selection.target) {
      sent = true;
      const response = await apiFetch(
        apiUrl(`/api/devices/${encodeURIComponent(selection.target.deviceId)}/rpc`),
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            operation: 'review',
            input: {
              sessionId: selection.target.id,
              accept: accepted,
              reviewId: review.reviewId,
              reviewRevision: review.reviewRevision,
            },
          }),
        },
      );
      const result = await parseJsonResponse<{
        ok?: boolean;
        error?: string;
        data?: { reviewed?: boolean; reviewId?: string; reviewRevision?: string; status?: string };
      }>(response);
      if (!response.ok || !result.ok)
        throw new Error(result.error || 'Could not confirm the review on the target.');
      const data = result.data;
      if (
        !data?.reviewed ||
        data.reviewId !== review.reviewId ||
        data.reviewRevision !== review.reviewRevision ||
        !reviewResolutionMatches(review, data)
      )
        throw new Error(
          'The target did not confirm this review revision. Check its status before retrying.',
        );
      // A result belongs to its captured publication even if the user navigated away.
      if (apiUrl('/api') === selection.origin && reviewResponses.get(sessionId) === attempt)
        resolveReview(sessionId, data);
      return;
    }
    if (wsConnection?.readyState !== WebSocket.OPEN)
      throw new Error('Connection lost. Reconnect before responding.');
    wsConnection.send(
      JSON.stringify({
        type: accepted ? 'session.accept_changes' : 'session.reject_changes',
        sessionId,
        reviewId: review.reviewId,
        reviewRevision: review.reviewRevision,
        timestamp: Date.now(),
      }),
    );
    sent = true;
    update('awaiting_confirmation');
  } catch (error) {
    update(
      sent ? 'uncertain' : 'failed',
      error instanceof Error ? error.message : 'Review could not be confirmed.',
    );
  }
}

function setDemoSessionChanges(sessionId: string, changes: ChangeSummary[]) {
  if (changes.length) publishReview(sessionId, { changes });
  else clearReview(sessionId);
}

function clearFeed() {
  feedStore.clearFeed(sessionStore.activeSessionId);
  activeFileEdits = new Map();
  detectedContext = [];
  agentStore.clearNonManagerAgents(sessionStore.activeSessionId);
}

function activateSessionFeed(sessionId: string): number {
  const generation = feedStore.activateSessionFeed(sessionId);
  activeFileEdits = new Map();
  detectedContext = [];
  // Pass the session being opened, not the store's current value: this runs
  // from the same tick that flips activeSessionId, and the sweep must keep
  // the incoming session's finished workers rather than the outgoing one's.
  agentStore.clearNonManagerAgents(sessionId);
  // Bind the manager to the newly activated session immediately. Previously the
  // binding only moved on a `kory.thought` event, so opening a chat that had
  // never run a turn left the manager pointing at the previous session and
  // `getContextUsage()` reported "usage_unknown" for a session whose durable
  // snapshot was sitting in the archive.
  agentStore.bindManagerSession(sessionId);
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
    cost?: number;
    variantGroupId?: string;
    variantIndex?: number;
  }>,
  options: { generation?: number; signal?: AbortSignal } = {},
) {
  if (!feedStore.ownsFeed(sessionId, options.generation)) return;
  const boundary = sessionStore.getMessageDisplayBoundary?.(messages);
  const priorRevision = feedStore.feed.find((entry) =>
    Number.isSafeInteger(entry.metadata?.providerConversationRevision),
  )?.metadata?.providerConversationRevision;
  if (
    boundary?.authoritative &&
    typeof priorRevision === 'number' &&
    typeof boundary.providerConversationRevision === 'number' &&
    boundary.providerConversationRevision > priorRevision
  ) {
    // An actual branch rewrite invalidates occupancy. An empty archive response
    // during an ordinary refresh does not: it may precede a usage persistence
    // write or describe an older boundary than the live report already shown.
    agentStore.invalidateManagerContextUsage(sessionId);
  }
  const usageRevision = agentStore.managerUsageRevision;
  // Reset ancillary per-session UI state up front, but leave the feed itself
  // alone — feedStore.loadSessionMessages swaps it in atomically once the
  // fetched history is ready, avoiding a blank flash during the round trip.
  activeFileEdits = new Map();
  detectedContext = [];
  agentStore.clearNonManagerAgents(sessionId);
  koryThought = '';
  koryPhase = '';
  await feedStore.loadSessionMessages(sessionId, messages, {
    ...options,
    onUsage: (usage) => {
      // History is a request-time snapshot. A newer live report, preview, or
      // branch invalidation wins while that request is in flight.
      if (usage && agentStore.managerUsageRevision === usageRevision) {
        agentStore.seedManagerUsage(sessionId, usage);
      }
    },
  });
}

async function rewind(hash: string) {
  const sessionId = sessionStore.activeSessionId;
  if (!sessionId || rewindPreviewLoadingHash) return;
  if (runStateStore.isBusy(sessionId)) {
    toastStore.info('Stop the active run before rewinding this session');
    return;
  }

  rewindPreviewLoadingHash = hash;
  try {
    const res = await apiFetch(apiUrl(`/api/sessions/${sessionId}/rewind/preview`), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
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
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        hash: preview.targetHash,
        expectedCurrentHash: preview.currentHash,
        confirmed: true,
      }),
    });
    const data = await parseJsonResponse<{ ok?: boolean; message?: string; eventEpoch?: number }>(
      res,
    );
    if (!data.ok) throw new Error(data.message ?? 'Rewind failed');
    rewindPreview = null;
    toastStore.success('Session rewound successfully');
    if (Number.isSafeInteger(data.eventEpoch)) {
      // The durable WS control row usually arrives first. Epoch gating makes
      // this HTTP result an idempotent fallback instead of a second clear/load.
      await applyTimelineRewrite(sessionId, Number(data.eventEpoch), {
        adoptIngress: true,
      });
    } else {
      // Code-only checkpoints deliberately retain the current transcript, but
      // preserve the existing history refresh behavior.
      const messages = await sessionStore.fetchMessages(sessionId);
      await loadSessionMessages(sessionId, messages);
    }
    window.dispatchEvent(new CustomEvent('kory:rewind-applied', { detail: { sessionId } }));
  } catch (err) {
    toastStore.error(err instanceof Error ? err.message : 'Rewind failed');
  } finally {
    rewindApplying = false;
  }
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

function finalizeSessionThinking(
  sessionId: string,
  agentId?: string,
  endedAt: number | null = null,
  closeTurn = false,
) {
  // Main-feed and drill-down entries are separate mutable lanes. Finalizing
  // only the visible feed leaves an agent's reasoning stopwatch live after a
  // stop or terminal event, especially when the chat is reopened later.
  feedStore.finalizeThinking(sessionId, agentId, endedAt);
  agentStore.finalizeThreadThinking(sessionId, agentId, endedAt);
  if (closeTurn) {
    feedStore.closeStreamTurn(sessionId, agentId);
    agentStore.closeAgentThreadTurn(sessionId, agentId);
  }
}

function markSessionAgentsStopped(sessionId: string) {
  // Run-phase stop is owned by runStateStore; agentStore still marks its
  // agent entries done for content-streaming indicators (ManagerFeed etc.).
  runStateStore.markUserStopped(sessionId);
  finalizeSessionThinking(sessionId, undefined, null, true);
  agentStore.markSessionAgentsStopped(sessionId);
  feedStore.removeAnalyzingThoughtEntries(sessionId);
}

// ─── Exported Store ─────────────────────────────────────────────────────────

export const wsStore = {
  ingestLinkedMessage: ingestRealtimeMessage,
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
  get sessionReviews() {
    return sessionReviews;
  },
  get reviewResponses() {
    return reviewResponses;
  },
  captureReview,
  publishReview,
  resolveReview,
  cancelSession,
  cancelAgent,
  steerMessage,
  isCancellationPending(sessionId: string, agentId?: string): boolean {
    return pendingCancellations.has(
      agentId ? agentCancellationKey(sessionId, agentId) : sessionCancellationKey(sessionId),
    );
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
    // Derive from run-state for the active session — no longer reads the
    // shared manager object's status, which was clobbered across chats.
    return runStateStore.getAgentStatusForSession(sessionStore.activeSessionId);
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
  // Run-phase reads delegate to runStateStore — the single source of truth.
  isSessionRunning: runStateStore.isRunning,
  isSessionWaiting: runStateStore.isWaiting,
  isSessionBusy: runStateStore.isBusy,
  isSessionStoppedByUser: runStateStore.isStoppedByUser,
  getManagerStatusForSession: runStateStore.getAgentStatusForSession,
  getAgentStatusesForSession: (sessionId: string) =>
    agentStore.getAgentStatusesForSession?.(sessionId) ?? [],
  markSessionAgentsStopped,
  markAgentStopped: (sessionId: string, agentId: string) => {
    runStateStore.markAgentStopped(sessionId, agentId);
    agentStore.markAgentStopped(sessionId, agentId);
  },
  clearAnalyzing: (sessionId: string) => feedStore.removeAnalyzingThoughtEntries(sessionId),
  addClientError: (sessionId: string, text: string) => feedStore.addClientError(sessionId, text),
  finishSessionLoad: feedStore.finishSessionLoad,
  connect,
  disconnect,
  sendMessage,
  sendAgentMessage,
  sendUserInput,
  respondToChanges,
  setDemoSessionChanges,
  loadSessionMessages,
  loadAgentThreads: agentStore?.loadAgentThreads,
  loadAgentThreadMessages: agentStore?.loadAgentThreadMessages,
  getAgentThreadFeed: agentStore?.getAgentThreadFeed,
  removeEntries: feedStore.removeEntries,
  setEntryVisibility: feedStore.setEntryVisibility,
  setUserEntryVisibility: feedStore.setUserEntryVisibility,
  closeStreamTurn: feedStore.closeStreamTurn,
  finalizeThinking: feedStore.finalizeThinking,
  beginManagerContextPreview: agentStore?.beginManagerContextPreview,
  applyManagerContextPreview: agentStore?.applyManagerContextPreview,
  clearManagerContextPreview: agentStore?.clearManagerContextPreview,
  invalidateManagerContextUsage: agentStore?.invalidateManagerContextUsage,
  setManagerContextWindow: agentStore?.setManagerContextWindow,
  respondToPermission,
  subscribeToSession,
  unsubscribeFromSession,
  clearFeed,
  activateSessionFeed,
  rewind,
  confirmRewind,
  cancelRewind,
  toggleYolo,
  setYoloMode,
  loadProvidersFromApi,
};
