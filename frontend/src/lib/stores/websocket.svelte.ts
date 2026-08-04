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
  CompactionProgressPayload,
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
// Stop is optimistic: the backend may still have buffered stream/thought
// events in flight. Keep those events from resurrecting a run in the UI until
// the next user message explicitly starts a new turn for that session.
const userStoppedSessions = new Set<string>();
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

// ─── Session Busy Bridge ─────────────────────────────────────────────────────

function markSessionBusy(sessionId: string) {
  userStoppedSessions.delete(sessionId);
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

// Watchdog: if a session is marked busy but goes SILENT (no stream activity)
// for this long, the agent is gone and a terminal event was dropped — force
// the busy/Stop state off so the composer never gets stuck. Any stream event
// for the session resets its timer.
const BUSY_WATCHDOG_MS = 45_000;
const busyWatchdogs = new Map<string, ReturnType<typeof setTimeout>>();

function kickBusyWatchdog(sessionId: string | undefined) {
  if (!sessionId) return;
  const existing = busyWatchdogs.get(sessionId);
  if (existing) clearTimeout(existing);
  if (!busySessions.has(sessionId)) return;
  busyWatchdogs.set(
    sessionId,
    setTimeout(() => {
      busyWatchdogs.delete(sessionId);
      // Silent too long — the run ended without a terminal event reaching us.
      markSessionAgentsStopped(sessionId);
      clearSessionBusy(sessionId);
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

// ─── Message Handler ───────────────────────────────────────────────────────

function handleMessage(msg: WSMessage) {
  const eventEpoch = msg.epoch;
  const eventSequence = msg.sequence;
  if (msg.sessionId && Number.isSafeInteger(eventEpoch) && Number.isSafeInteger(eventSequence)) {
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

  if (
    msg.sessionId &&
    userStoppedSessions.has(msg.sessionId) &&
    (msg.type === 'kory.thought' ||
      msg.type === 'kory.routing' ||
      msg.type === 'stream.delta' ||
      msg.type === 'stream.thinking' ||
      msg.type === 'stream.tool_call' ||
      msg.type === 'stream.tool_result' ||
      msg.type === 'stream.file_delta' ||
      msg.type === 'stream.file_complete')
  ) {
    return;
  }

  // Any activity for a busy session proves the run is alive — reset its
  // silence watchdog. (Terminal events clear busy entirely below.)
  if (msg.sessionId && msg.type.startsWith('stream.')) kickBusyWatchdog(msg.sessionId);

  switch (msg.type) {
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
        metadata: { sessionId, sourceAgentId: p.agentId, threadRole: role },
      });
      break;
    }

    case 'agent.status': {
      const p = msg.payload as AgentStatusPayload;
      if (
        msg.sessionId &&
        userStoppedSessions.has(msg.sessionId) &&
        !['done', 'idle', 'waiting'].includes(p.status)
      ) {
        break;
      }
      agentStore.updateAgentStatus(p.agentId, p.status, msg.sessionId ?? undefined);
      if (isForActiveSession) {
        if (p.status === 'thinking') feedStore.beginThinking(p.agentId, msg.timestamp);
        else feedStore.finalizeThinking(p.agentId, msg.timestamp);
      }
      if (p.status === 'done' || p.status === 'idle' || p.status === 'waiting') {
        maybeClearBusy(msg.sessionId ?? agents.get(p.agentId)?.sessionId);
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
        if (info.message === 'Session cancelled' && msg.sessionId) {
          userStoppedSessions.add(msg.sessionId);
          clearSessionBusy(msg.sessionId);
        }
        feedStore.removeAnalyzingThoughtEntries();
        feedStore.addFeedEntry({
          timestamp: msg.timestamp,
          type: 'system',
          agentId: 'system',
          agentName: '',
          glowClass: '',
          text: info.message === 'Session cancelled' ? 'Stopped by user.' : info.message,
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
          metadata: { source: 'agent', sessionId: msg.sessionId },
        });
      }
      break;
    }

    case 'stream.delta': {
      const p = msg.payload as StreamDeltaPayload;
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
          metadata: orderedEventMetadata(msg),
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
            toolCall: p.toolCall,
            sessionId: msg.sessionId,
            sourceProvider: p.sourceProvider,
          },
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
          metadata: {
            toolResult: {
              callId: p.id,
              name: 'bash',
              output: text,
              isError: !started && p.status === 'crashed',
              durationMs: 0,
            },
          },
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
        feedStore.addFeedEntry({
          timestamp: msg.timestamp,
          type: 'tool_result',
          agentId: p.agentId,
          agentName: agents.get(p.agentId)?.identity.name ?? 'Worker',
          glowClass: feedStore.resolveGlowClass(agents.get(p.agentId)?.identity),
          text: resultText,
          metadata: {
            ...orderedEventMetadata(msg),
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
          metadata: { phase: p.phase },
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
          metadata: { domain: p.domain, model: p.selectedModel, provider: p.selectedProvider },
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
      feedStore.upsertCompaction(payload);
      if (msg.type === 'compaction.completed') {
        clearSessionBusy(payload.sessionId);
        toastStore.success('Context compacted — the manager will start fresh on the next turn');
      } else if (msg.type === 'compaction.failed') {
        clearSessionBusy(payload.sessionId);
        toastStore.error(payload.error ?? 'Compaction failed');
      } else {
        markSessionBusy(payload.sessionId);
      }
      break;
    }

    case 'notes.updated': {
      const p = msg.payload as { action?: string; noteId?: string };
      void notesStore.fetchNotes();
      void notesStore.fetchGraph();
      void notesStore.fetchFolderTree();
      if (p.noteId && notesStore.currentNote?.id === p.noteId) {
        void notesStore.fetchNote(p.noteId);
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
          metadata: { contextFiles: p.files },
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
          metadata: { source: 'backend', sessionId: msg.sessionId },
        });
      }
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
        metadata: { notificationType },
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

  if (url || wsCandidates.length === 0) {
    wsCandidates = buildWsCandidates(url);
    wsCandidateIndex = 0;
    console.log('[WS] Built candidates:', wsCandidates);
  }

  const wsUrl = wsCandidates[wsCandidateIndex];
  console.log('[WS] Trying URL:', wsUrl, 'index:', wsCandidateIndex);
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

    console.log('[WS] Creating WebSocket connection to:', finalWsUrl);
    const ws = new WebSocket(finalWsUrl, protocols);

    ws.onopen = () => {
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
        handleMessage(parsed);
      } catch (error) {
        if (!hasShownMalformedWsMessage) {
          hasShownMalformedWsMessage = true;
          feedStore.addClientError('Failed to parse realtime update from server.');
        }
        if (import.meta.env.DEV) console.warn('Failed to parse websocket message', error);
      }
    };

    ws.onclose = (event) => {
      console.log('[WS] Connection closed:', event.code, event.reason);
      connectionStatus = 'disconnected';
      wsConnection = null;
      sentSessionSubscriptions.clear();

      if (wsCandidateIndex < wsCandidates.length - 1) {
        wsCandidateIndex++;
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
  const cursor = realtimeCursors.get(sessionId);
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
  attachments?: Array<{ type: string; data: string; name: string }>,
  fastMode?: boolean,
) {
  feedStore.addUserMessage(sessionId, content, attachments);
  markSessionBusy(sessionId);
  detectedContext = [];
  void apiFetch(apiUrl('/api/messages'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId, content, model, reasoningLevel, attachments, fastMode }),
  })
    .then(async (res) => {
      const data = await parseJsonResponse<{ ok?: boolean; error?: string }>(res);
      if (!res.ok || data?.ok === false) {
        throw new Error(data?.error || `Request failed: ${res.status} ${res.statusText}`);
      }
      // Refresh the session list so the sidebar's message count updates
      // immediately after the user's message is persisted.
      void sessionStore.fetchSessions();
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
  userStoppedSessions.add(sessionId);
  clearSessionBusy(sessionId);
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
    return agentStore.getManagerStatus();
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
  confirmRewind,
  cancelRewind,
  toggleYolo,
  setYoloMode,
  loadProvidersFromApi,
};
