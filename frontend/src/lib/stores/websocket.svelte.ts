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
  KorySessionChangesResolvedPayload,
  AgentSpawnedPayload,
  AgentStatusPayload,
  AgentThreadMessagePayload,
  PermissionRequest,
  Session,
  NotificationPayload,
  NativeCommandPayload,
  KoryAskUserPayload,
  KoryAskUserResolvedPayload,
  CompactionProgressPayload,
  SessionTimelineRewrittenPayload,
  SessionActionableWaitsPayload,
} from '@koryphaios/shared';
import {
  isAgentBackgroundProcess,
  type ProcessProvenance,
  type ProcessSupervision,
  type ProcessTerminalReason,
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
import { notesStore, type NotesRealtimeUpdate } from './notes.svelte';
import { goalStore } from './goals.svelte';
import { goalDisplayStore } from './goal-display.svelte';
import { isDemoMode } from '$lib/demo-flags';
import { runStateStore } from './run-state.svelte';
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
// The displayed review body intentionally remains a simple ChangeSummary[];
// retain its durable identity alongside it so an older resolution cannot clear
// a newer review during replay/reconnect races.
let sessionChangeReviewIds = $state<Map<string, string>>(new Map());
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
function isSpawnedSubAgent(agentId: string | undefined): boolean {
  if (!agentId) return false;
  const identity = agentStore.agents.get(agentId)?.identity;
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
    feedStore.removeAnalyzingThoughtEntries();
    if (feedStore.isDuplicateError(errorText, msg.timestamp) || orderedDuplicate) {
      return;
    }
    toastStore.error(errorText);
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
  const result = orderedSessionIngress.ingestWithReplayRequest(msg);
  for (const ordered of result.events) handleMessage(ordered);
  if (result.replayFrom) requestSessionReplay(result.replayFrom);
}

// ─── Message Handler ───────────────────────────────────────────────────────

function handleMessage(msg: WSMessage) {
  const activeSessionId = sessionStore.activeSessionId;
  // Feed-affecting realtime events must carry an exact session identity.
  // Unscoped events are global control/catalog events only; treating them as
  // belonging to "whatever is open now" is a cross-chat data leak.
  const isForActiveSession = !!msg.sessionId && msg.sessionId === activeSessionId;
  const agents = agentStore.agents;

  // Run-phase state is owned by runStateStore. Its acceptance result is
  // authoritative: once a terminal or user-stop guard rejects late traffic,
  // no feed, agent, or toast reducer may render that stale event.
  if (!runStateStore.applyEvent(msg)) return;

  switch (msg.type) {
    case 'session.timeline_rewritten': {
      const p = msg.payload as SessionTimelineRewrittenPayload;
      const eventEpoch = p?.eventEpoch;
      // This control fact is valid only as sequence one of the epoch it opens.
      // Reject malformed/unordered copies instead of clearing a live transcript.
      if (
        !msg.sessionId ||
        p?.reason !== 'conversation_rewind' ||
        !Number.isSafeInteger(eventEpoch) ||
        eventEpoch !== msg.epoch ||
        msg.sequence !== 1
      ) {
        break;
      }
      void applyTimelineRewrite(msg.sessionId, eventEpoch, {
        adoptIngress: false,
      });
      break;
    }

    case 'run.state': {
      const snapshot = (msg.payload as { snapshot?: { phase?: string } })?.snapshot;
      // The durable run aggregate is authoritative after a reload. Keep
      // worker cards inspectable, but terminalize any stale active cards that
      // predate the replayed terminal snapshot so a renderer cannot show a
      // spinner for work the backend has already closed.
      if (
        msg.sessionId &&
        snapshot &&
        (snapshot.phase === 'done' || snapshot.phase === 'error' || snapshot.phase === 'cancelled')
      ) {
        agentStore.terminalizeSessionSubAgents(
          msg.sessionId,
          snapshot.phase as 'done' | 'error' | 'cancelled',
        );
      }
      const failure = sequencedTerminalRunFailure(msg, msg.sessionId ?? '');
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
          metadata: { ...orderedEventMetadata(msg), domain: p.agent.domain },
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

    case 'agent.status': {
      const p = msg.payload as AgentStatusPayload;
      // Suppression of active statuses after a user stop is handled by
      // runStateStore.applyEvent above. Here we only need to check whether
      // applyEvent suppressed it — if the session is stoppedByUser and this
      // is an active status, skip the feed/agent update too.
      const rs = msg.sessionId ? runStateStore.states.get(msg.sessionId) : undefined;
      if (
        rs?.stoppedByUser &&
        !['done', 'idle', 'waiting', 'waiting_user', 'error'].includes(p.status)
      ) {
        break;
      }
      agentStore.updateAgentStatus(p.agentId, p.status, msg.sessionId ?? undefined);
      if (isForActiveSession) {
        if (p.status === 'thinking') feedStore.beginThinking(p.agentId, msg.timestamp);
        else feedStore.finalizeThinking(p.agentId, msg.timestamp);
      }
      // Historical terminal statuses are transcript evidence, not a new turn
      // completion. The startup session loader already fetches message history;
      // refetching once for every replayed prior turn races those requests
      // against the ordered-event replay and can replace durable error/tool rows
      // with message-only history.
      if (!msg.replayed && (p.status === 'done' || p.status === 'idle' || p.status === 'waiting')) {
        const completedSessionId = msg.sessionId ?? agents.get(p.agentId)?.sessionId;
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
      if (isForActiveSession && info?.message) {
        // applyEvent already handled the "Session cancelled" stop suppression
        // and phase transition; here we just render the feed marker.
        feedStore.removeAnalyzingThoughtEntries();
        feedStore.addFeedEntry({
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
      const p = msg.payload as { agentId: string };
      if (isForActiveSession) feedStore.finalizeThinking(p.agentId, msg.timestamp);
      agentStore.completeAgent(p.agentId, msg.sessionId ?? undefined);
      if (isForActiveSession) feedStore.removeAnalyzingThoughtEntries();
      // Run-phase clearing is handled by applyEvent above.
      break;
    }

    case 'agent.error': {
      const p = msg.payload as { agentId?: string; error?: string };
      const isSubAgent = isSpawnedSubAgent(p.agentId);
      // Run-phase error transition is handled by applyEvent above.
      if (msg.sessionId) {
        if (isForActiveSession) feedStore.removeAnalyzingThoughtEntries();
        feedStore.addFeedEntryForSession(msg.sessionId, {
          timestamp: msg.timestamp,
          type: 'error',
          agentId: isSubAgent ? p.agentId! : 'kory-manager',
          agentName: isSubAgent ? (agents.get(p.agentId!)?.identity.name ?? 'Worker') : 'Kory',
          glowClass: '',
          text: p.error ?? 'Unknown error',
          metadata: {
            ...orderedEventMetadata(msg),
            source: 'agent',
            sessionId: msg.sessionId,
            ...(isSubAgent && { isSubAgent: true }),
          },
        });
      }
      break;
    }

    case 'stream.delta': {
      const p = msg.payload as StreamDeltaPayload;
      const isSubAgent = isSpawnedSubAgent(p.agentId);
      // Answer text starting = the provider is done reasoning: freeze timers.
      if (isForActiveSession) feedStore.finalizeThinking(p.agentId, msg.timestamp);
      agentStore.appendAgentContent(p.agentId, p.content, msg.sessionId ?? undefined);
      const alreadyPersisted =
        msg.replayed &&
        p.agentId === 'kory-manager' &&
        feedStore.hasPersistedAssistantContaining(p.content, msg.timestamp);
      if (isForActiveSession && !alreadyPersisted) {
        feedStore.removeAnalyzingThoughtEntries();
        feedStore.accumulateFeedEntry({
          timestamp: msg.timestamp,
          type: 'content',
          agentId: p.agentId,
          agentName: agents.get(p.agentId)?.identity.name ?? 'Worker',
          glowClass: feedStore.resolveGlowClass(agents.get(p.agentId)?.identity),
          text: p.content,
          metadata: { ...orderedEventMetadata(msg), ...(isSubAgent && { isSubAgent: true }) },
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
          metadata: { ...orderedEventMetadata(msg), sessionId: msg.sessionId },
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
      const isSubAgent = isSpawnedSubAgent(p.agentId);
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
          metadata: {
            ...orderedEventMetadata(msg),
            ...(isSubAgent && { isSubAgent: true }),
            ...(typeof p.thinkingTokens === 'number' ? { thinkingTokens: p.thinkingTokens } : {}),
          },
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
          metadata: { ...orderedEventMetadata(msg), sessionId: msg.sessionId },
        });
      }
      break;
    }

    case 'stream.tool_call': {
      const p = msg.payload as StreamToolCallPayload;
      const isSubAgent = isSpawnedSubAgent(p.agentId);
      if (isForActiveSession) feedStore.finalizeThinking(p.agentId, msg.timestamp);
      const existingToolCall =
        isForActiveSession && feedStore.updateToolCall(p.toolCall, msg.timestamp);
      if (!existingToolCall)
        agentStore.addToolCall(p.agentId, p.toolCall.name, msg.sessionId ?? undefined);
      if (isForActiveSession) {
        if (!existingToolCall)
          feedStore.addFeedEntry({
            timestamp: msg.timestamp,
            type: 'tool_call',
            agentId: p.agentId,
            agentName: agents.get(p.agentId)?.identity.name ?? 'Worker',
            glowClass: feedStore.resolveGlowClass(agents.get(p.agentId)?.identity),
            text: `Calling tool: ${p.toolCall.name}`,
            metadata: {
              ...orderedEventMetadata(msg),
              ...(isSubAgent && { isSubAgent: true }),
              toolCall: p.toolCall,
              sourceProvider: p.sourceProvider,
            },
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
          metadata: {
            ...orderedEventMetadata(msg),
            toolCall: p.toolCall,
            sessionId: msg.sessionId,
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
        feedStore.addFeedEntry({
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
      const p = msg.payload as StreamToolResultPayload;
      const isSubAgent = isSpawnedSubAgent(p.agentId);
      const resultText = p.toolResult.isError
        ? `Tool error: ${p.toolResult.output}`
        : p.toolResult.durationMs > 0
          ? `Tool result (${p.toolResult.durationMs.toFixed(0)}ms): ${p.toolResult.output}`
          : `Tool result (time not reported by provider): ${p.toolResult.output}`;
      if (isForActiveSession) {
        feedStore.addFeedEntry({
          timestamp: msg.timestamp,
          type: 'tool_result',
          agentId: p.agentId,
          agentName: agents.get(p.agentId)?.identity.name ?? 'Worker',
          glowClass: feedStore.resolveGlowClass(agents.get(p.agentId)?.identity),
          text: resultText,
          metadata: {
            ...orderedEventMetadata(msg),
            ...(isSubAgent && { isSubAgent: true }),
            toolResult: p.toolResult,
            sourceProvider: p.sourceProvider,
          },
        });
      }
      if (msg.sessionId) {
        agentStore.upsertAgentThreadEntry(msg.sessionId, p.agentId, {
          timestamp: msg.timestamp,
          type: 'tool_result',
          agentId: p.agentId,
          agentName: agentStore.getAgentFeedLabel(p.agentId),
          glowClass: feedStore.resolveGlowClass(agents.get(p.agentId)?.identity),
          text: resultText,
          metadata: {
            ...orderedEventMetadata(msg),
            toolResult: p.toolResult,
            sessionId: msg.sessionId,
            sourceProvider: p.sourceProvider,
          },
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
      const p = msg.payload as KoryThoughtPayload;
      if (isForActiveSession) {
        if (msg.sessionId) agentStore.setManagerSessionId(msg.sessionId);
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
          metadata: { ...orderedEventMetadata(msg), phase: p.phase },
        });
      }
      break;
    }

    case 'kory.routing': {
      const p = msg.payload as KoryRoutingPayload;
      if (isForActiveSession) {
        feedStore.removeAnalyzingThoughtEntries();
        feedStore.addFeedEntry({
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

    case 'kory.ask_user': {
      const p = msg.payload as KoryAskUserPayload;
      const sid = msg.sessionId ?? activeSessionId;
      if (sid) {
        const next = new Map(pendingQuestions);
        next.set(sid, {
          question: p.question,
          options: p.options,
          allowOther: p.allowOther,
          allowKeepChatting: p.allowKeepChatting,
          questionId: p.questionId,
        });
        pendingQuestions = next;
      }
      break;
    }

    case 'kory.ask_user_resolved': {
      const p = msg.payload as KoryAskUserResolvedPayload;
      const sid = msg.sessionId;
      if (!sid) break;
      const current = pendingQuestions.get(sid);
      // A durable terminal control can only clear the question it names. A
      // legacy/no-id control means the server has authoritatively established
      // that this session has no waiting question.
      if (!p.questionId || !current?.questionId || current.questionId === p.questionId) {
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
      const payload = msg.payload as CompactionProgressPayload;
      feedStore.upsertCompaction(payload, orderedEventMetadata(msg));
      // Run-phase transitions for compaction are handled by applyEvent above.
      if (msg.type === 'compaction.completed') {
        toastStore.success('Context compacted — the manager will start fresh on the next turn');
      } else if (msg.type === 'compaction.failed') {
        toastStore.error(payload.error ?? 'Compaction failed');
      }
      break;
    }

    case 'notes.updated': {
      notesStore.handleRealtimeUpdate(msg.payload as NotesRealtimeUpdate);
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

    case 'goals.updated': {
      const payload = msg.payload as {
        goal?: import('@koryphaios/shared').Goal;
        deletedId?: string;
      };
      const update = goalStore.handleUpdated(payload);
      if (update.managerCreated && payload.goal) {
        goalStore.selectedGoalId = payload.goal.id;
        goalDisplayStore.update({ sidebar: true });
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
      const p = msg.payload as KorySessionChangesPayload;
      if (msg.sessionId) {
        // Reassign — Map mutation alone is not reactive under $state.
        const next = new Map(sessionChanges);
        next.set(msg.sessionId, p.changes);
        sessionChanges = next;
        const reviewIds = new Map(sessionChangeReviewIds);
        if (p.reviewId) reviewIds.set(msg.sessionId, p.reviewId);
        else reviewIds.delete(msg.sessionId);
        sessionChangeReviewIds = reviewIds;
      }
      break;
    }

    case 'session.changes_resolved': {
      const p = msg.payload as KorySessionChangesResolvedPayload;
      const sid = msg.sessionId;
      if (!sid) break;
      const currentReviewId = sessionChangeReviewIds.get(sid);
      // Preserve a newer review when an old durable resolution is replayed.
      if (!p.reviewId || !currentReviewId || currentReviewId === p.reviewId) {
        const next = new Map(sessionChanges);
        next.delete(sid);
        sessionChanges = next;
        const reviewIds = new Map(sessionChangeReviewIds);
        reviewIds.delete(sid);
        sessionChangeReviewIds = reviewIds;
      }
      break;
    }

    case 'session.accept_changes': {
      if (msg.sessionId && sessionChanges.has(msg.sessionId)) {
        const next = new Map(sessionChanges);
        next.delete(msg.sessionId);
        sessionChanges = next;
      }
      if (msg.sessionId) {
        const reviewIds = new Map(sessionChangeReviewIds);
        reviewIds.delete(msg.sessionId);
        sessionChangeReviewIds = reviewIds;
      }
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
      pushToast(notificationType, text);
      feedStore.addFeedEntry({
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
      // Re-subscribe to every session viewed this app run, not just the
      // active one — the server keeps per-connection subscriptions, so a
      // reconnect would otherwise silently stop delivering events for
      // background chats that are still running.
      const activeSid = sessionStore.activeSessionId;
      if (activeSid) subscribedSessions.add(activeSid);
      for (const sid of subscribedSessions) subscribeToSession(sid);
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
            feedStore.addClientError('Received malformed realtime update from server.');
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
          feedStore.addClientError('Failed to parse realtime update from server.');
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
        toastStore.error(
          `Session rewound, but its refreshed history could not be loaded: ${detail}`,
        );
        feedStore.addClientError(`Rewritten chat history failed to load: ${detail}`);
      }
    }
  })();
  timelineRewriteRefreshes.set(sessionId, { epoch, completion });
  return completion;
}

function subscribeToSession(sessionId: string) {
  if (!sessionId) return;
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

async function sendMessage(
  sessionId: string,
  content: string,
  model?: string,
  reasoningLevel?: string,
  attachments?: Array<{ type: string; data: string; name: string; mimeType?: string }>,
  fastMode?: boolean,
  imageInputMode: 'reject' | 'omit' = 'reject',
): Promise<boolean> {
  const optimisticEntryId = feedStore.addUserMessage(sessionId, content, attachments);
  runStateStore.startRun(sessionId);
  detectedContext = [];
  try {
    const res = await apiFetch(apiUrl('/api/messages'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sessionId,
        content,
        model,
        reasoningLevel,
        attachments,
        fastMode,
        imageInputMode,
      }),
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
    toastStore.error(message);
    if (optimisticEntryId) feedStore.removeEntries(new Set([optimisticEntryId]));
    feedStore.addClientError(message);
    runStateStore.markUserStopped(sessionId);
    return false;
  }
}

async function sendAgentMessage(
  sessionId: string,
  agentId: string,
  content: string,
  model?: string,
  reasoningLevel?: string,
): Promise<boolean> {
  if (!sessionId || !agentId || !content.trim()) return false;
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
    toastStore.error(message);
    feedStore.addClientError(message);
    return false;
  }
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
  const reviewIds = new Map(sessionChangeReviewIds);
  reviewIds.delete(sessionId);
  sessionChangeReviewIds = reviewIds;
}

function setDemoSessionChanges(sessionId: string, changes: ChangeSummary[]) {
  const next = new Map(sessionChanges);
  if (changes.length) next.set(sessionId, changes);
  else next.delete(sessionId);
  sessionChanges = next;
  if (!changes.length) {
    const reviewIds = new Map(sessionChangeReviewIds);
    reviewIds.delete(sessionId);
    sessionChangeReviewIds = reviewIds;
  }
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
    cost?: number;
    variantGroupId?: string;
    variantIndex?: number;
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
  if (runStateStore.isBusy(sessionId)) {
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

function markSessionAgentsStopped(sessionId: string) {
  // Run-phase stop is owned by runStateStore; agentStore still marks its
  // agent entries done for content-streaming indicators (ManagerFeed etc.).
  runStateStore.markUserStopped(sessionId);
  agentStore.markSessionAgentsStopped(sessionId);
  if (sessionId === sessionStore.activeSessionId) feedStore.removeAnalyzingThoughtEntries();
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
  getManagerStatusForSession: runStateStore.getAgentStatusForSession,
  markSessionAgentsStopped,
  markAgentStopped: (agentId: string) => {
    // Single-agent cancel: find the session and delegate to runStateStore.
    const agent = agentStore.agents.get(agentId);
    if (agent?.sessionId) runStateStore.markAgentStopped(agent.sessionId, agentId);
    agentStore.markAgentStopped(agentId);
  },
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
  setUserEntryVisibility: feedStore.setUserEntryVisibility,
  finalizeThinking: feedStore.finalizeThinking,
  beginManagerContextPreview: agentStore.beginManagerContextPreview,
  applyManagerContextPreview: agentStore.applyManagerContextPreview,
  clearManagerContextPreview: agentStore.clearManagerContextPreview,
  setManagerContextWindow: agentStore.setManagerContextWindow,
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
