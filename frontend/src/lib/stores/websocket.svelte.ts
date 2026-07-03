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
let pendingQuestions = $state<
  Map<string, { question: string; options: string[]; allowOther: boolean }>
>(new Map());
let sessionChanges = $state<Map<string, ChangeSummary[]>>(new Map());

interface DetectedContextFile {
  path: string;
  relevance: number;
  reason: string;
}
let detectedContext = $state<DetectedContextFile[]>([]);

let busySessions = $state<Set<string>>(new Set());

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
  if (busySessions.has(sessionId)) return;
  busySessions = new Set(busySessions).add(sessionId);
}

function clearSessionBusy(sessionId: string) {
  if (!busySessions.has(sessionId)) return;
  const next = new Set(busySessions);
  next.delete(sessionId);
  busySessions = next;
}

function maybeClearBusy(sessionId: string | undefined) {
  if (!sessionId || !busySessions.has(sessionId)) return;
  if (!agentStore.isSessionRunning(sessionId)) clearSessionBusy(sessionId);
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function providerDisplayName(provider: string): string {
  if (provider === 'openai') return 'OpenAI';
  if (provider === 'codex') return 'Codex';
  if (provider === 'anthropic') return 'Anthropic';
  if (provider === 'google') return 'Google';
  if (provider === 'xai') return 'xAI';
  if (provider === 'openrouter') return 'OpenRouter';
  if (provider === 'vertexai') return 'Vertex AI';
  if (provider === 'copilot') return 'Copilot';
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

// ─── Message Handler ───────────────────────────────────────────────────────

function handleMessage(msg: WSMessage) {
  const activeSessionId = sessionStore.activeSessionId;
  const isForActiveSession = !msg.sessionId || msg.sessionId === activeSessionId;
  const agents = agentStore.agents;

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
      agentStore.updateAgentStatus(p.agentId, p.status, msg.sessionId ?? undefined);
      if (p.status === 'done' || p.status === 'idle') {
        maybeClearBusy(msg.sessionId ?? agents.get(p.agentId)?.sessionId);
      }
      break;
    }

    case 'system.info': {
      // Cancel notification → live stop marker as plain system text, not a
      // Kory message. The backend persists a matching system row for reloads.
      const info = msg.payload as { message?: string };
      if (isForActiveSession && info?.message === 'Session cancelled') {
        feedStore.removeAnalyzingThoughtEntries();
        feedStore.addFeedEntry({
          timestamp: msg.timestamp,
          type: 'system',
          agentId: 'system',
          agentName: '',
          glowClass: '',
          text: 'Stopped by user.',
        });
      }
      break;
    }

    case 'agent.completed':
    case 'stream.complete': {
      const p = msg.payload as { agentId: string };
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
        });
      }
      break;
    }

    case 'stream.delta': {
      const p = msg.payload as StreamDeltaPayload;
      agentStore.appendAgentContent(p.agentId, p.content, msg.sessionId ?? undefined);
      if (isForActiveSession) {
        feedStore.removeAnalyzingThoughtEntries();
        feedStore.accumulateFeedEntry({
          timestamp: msg.timestamp,
          type: 'content',
          agentId: p.agentId,
          agentName: agents.get(p.agentId)?.identity.name ?? 'Worker',
          glowClass: feedStore.resolveGlowClass(agents.get(p.agentId)?.identity),
          text: p.content,
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
          metadata: { sessionId: msg.sessionId },
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
          thinkingStartedAt: msg.timestamp,
          metadata:
            typeof p.thinkingTokens === 'number' ? { thinkingTokens: p.thinkingTokens } : {},
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
          thinkingStartedAt: msg.timestamp,
          metadata: { sessionId: msg.sessionId },
        });
      }
      break;
    }

    case 'stream.tool_call': {
      const p = msg.payload as StreamToolCallPayload;
      agentStore.addToolCall(p.agentId, p.toolCall.name, msg.sessionId ?? undefined);
      if (isForActiveSession) {
        feedStore.addFeedEntry({
          timestamp: msg.timestamp,
          type: 'tool_call',
          agentId: p.agentId,
          agentName: agents.get(p.agentId)?.identity.name ?? 'Worker',
          glowClass: feedStore.resolveGlowClass(agents.get(p.agentId)?.identity),
          text: `Calling tool: ${p.toolCall.name}`,
          metadata: { toolCall: p.toolCall },
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
          metadata: { toolCall: p.toolCall, sessionId: msg.sessionId },
        });
      }
      break;
    }

    case 'stream.tool_result': {
      const p = msg.payload as StreamToolResultPayload;
      if (isForActiveSession) {
        feedStore.addFeedEntry({
          timestamp: msg.timestamp,
          type: 'tool_result',
          agentId: p.agentId,
          agentName: agents.get(p.agentId)?.identity.name ?? 'Worker',
          glowClass: feedStore.resolveGlowClass(agents.get(p.agentId)?.identity),
          text: p.toolResult.isError
            ? `Tool error: ${p.toolResult.output}`
            : `Tool result (${p.toolResult.durationMs.toFixed(0)}ms): ${p.toolResult.output}`,
          metadata: { toolResult: p.toolResult },
        });
      }
      if (msg.sessionId) {
        agentStore.upsertAgentThreadEntry(msg.sessionId, p.agentId, {
          timestamp: msg.timestamp,
          type: 'tool_result',
          agentId: p.agentId,
          agentName: agentStore.getAgentFeedLabel(p.agentId),
          glowClass: feedStore.resolveGlowClass(agents.get(p.agentId)?.identity),
          text: p.toolResult.isError
            ? `Tool error: ${p.toolResult.output}`
            : `Tool result (${p.toolResult.durationMs.toFixed(0)}ms): ${p.toolResult.output}`,
          metadata: { toolResult: p.toolResult, sessionId: msg.sessionId },
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
      const p = msg.payload as { question: string; options: string[]; allowOther: boolean };
      const sid = msg.sessionId ?? activeSessionId;
      if (sid) {
        const next = new Map(pendingQuestions);
        next.set(sid, {
          question: p.question,
          options: p.options,
          allowOther: p.allowOther,
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
      void notesStore.fetchNotes();
      void notesStore.fetchGraph();
      void notesStore.fetchFolderTree();
      if (p.noteId && notesStore.currentNote?.id === p.noteId) {
        void notesStore.fetchNote(p.noteId);
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
          agentName: 'System',
          glowClass: '',
          text: errorText,
        });
      }
      break;
    }

    case 'system.notification': {
      const p = msg.payload as Partial<NotificationPayload>;
      if (!isForActiveSession) break;
      const notificationType = p.type ?? 'info';
      const text = p.title ? `${p.title}: ${p.message ?? ''}`.trim() : (p.message ?? 'Notification');
      pushToast(notificationType, text);
      feedStore.addFeedEntry({
        timestamp: msg.timestamp,
        type: notificationType === 'error' ? 'error' : 'system',
        agentId: '',
        agentName: 'System',
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

function subscribeToSession(sessionId: string) {
  if (!sessionId) return;
  subscribedSessions.add(sessionId);
  if (wsConnection?.readyState !== WebSocket.OPEN) return;
  wsConnection.send(
    JSON.stringify({ type: 'subscribe_session', sessionId, timestamp: Date.now() }),
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
  connectionStatus = 'disconnected';
}

export { loadProvidersFromApi };

function sendMessage(
  sessionId: string,
  content: string,
  model?: string,
  reasoningLevel?: string,
  attachments?: Array<{ type: string; data: string; name: string }>,
) {
  feedStore.addUserMessage(sessionId, content, attachments);
  markSessionBusy(sessionId);
  detectedContext = [];
  void apiFetch(apiUrl('/api/messages'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId, content, model, reasoningLevel, attachments }),
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

function sendAgentMessage(sessionId: string, agentId: string, content: string) {
  if (!sessionId || !agentId || !content.trim()) return;
  void apiFetch(apiUrl(`/api/agent/${agentId}/message`), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId, content }),
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

function clearFeed() {
  feedStore.clearFeed();
  activeFileEdits = new Map();
  detectedContext = [];
  agentStore.clearNonManagerAgents();
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
  }>,
) {
  clearFeed();
  koryThought = '';
  koryPhase = '';
  await feedStore.loadSessionMessages(sessionId, messages);
}

async function rewind(hash: string) {
  const sessionId = sessionStore.activeSessionId;
  if (!sessionId) return;

  try {
    const res = await apiFetch(apiUrl(`/api/sessions/${sessionId}/rewind`), {
      method: 'POST',
      body: JSON.stringify({ hash }),
    });
    const data = await parseJsonResponse<{ ok?: boolean; message?: string }>(res);
    if (data.ok) {
      toastStore.success('Rewound successfully');
      const messages = await sessionStore.fetchMessages(sessionId);
      await loadSessionMessages(sessionId, messages);
    } else {
      toastStore.error(`Rewind failed: ${data.message}`);
    }
  } catch (err) {
    console.error('Rewind failed:', err);
    toastStore.error('Rewind failed');
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
  get activeFileEdits() {
    return activeFileEdits;
  },
  get managerStatus() {
    return agentStore.getManagerStatus();
  },
  get contextUsage() {
    return agentStore.getContextUsage();
  },
  get detectedContext() {
    return detectedContext;
  },
  isSessionRunning: agentStore.isSessionRunning,
  isSessionBusy: (sessionId: string | null | undefined) =>
    !!sessionId && (busySessions.has(sessionId) || agentStore.isSessionRunning(sessionId)),
  markSessionAgentsStopped,
  markAgentStopped: agentStore.markAgentStopped,
  clearSessionBusy,
  clearAnalyzing: feedStore.removeAnalyzingThoughtEntries,
  connect,
  disconnect,
  sendMessage,
  sendAgentMessage,
  sendUserInput,
  respondToChanges,
  loadSessionMessages,
  loadAgentThreads: agentStore.loadAgentThreads,
  loadAgentThreadMessages: agentStore.loadAgentThreadMessages,
  getAgentThreadFeed: agentStore.getAgentThreadFeed,
  removeEntries: feedStore.removeEntries,
  setEntryVisibility: feedStore.setEntryVisibility,
  setManagerContextWindow: agentStore.setManagerContextWindow,
  respondToPermission,
  subscribeToSession,
  clearFeed,
  rewind,
  toggleYolo,
  setYoloMode,
  loadProvidersFromApi,
};