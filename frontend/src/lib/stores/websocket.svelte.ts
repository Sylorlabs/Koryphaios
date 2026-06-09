// WebSocket connection store — Svelte 5 runes for reactive agent state.
// Handles connection, reconnection, message routing, user messages, and permissions.

import type {
  WSMessage,
  WSEventType,
  AgentIdentity,
  AgentStatus,
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

// ─── Agent State ────────────────────────────────────────────────────────────

interface AgentState {
  identity: AgentIdentity;
  status: AgentStatus;
  content: string;
  thinking: string;
  toolCalls: Array<{ name: string; status: string }>;
  task: string;
  tokensUsed: number;
  contextMax: number;
  contextKnown: boolean;
  hasUsageData: boolean;
  sessionId: string;
}

// ─── Feed Entry ─────────────────────────────────────────────────────────────

const EPHEMERAL_TOOLS = new Set(['ls', 'read_file', 'grep', 'glob']);

export type { FeedEntry };

// ─── Reactive State (Svelte 5 Runes) ─────────────────────────────────────

let wsConnection = $state<WebSocket | null>(null);
let connectionStatus = $state<'connecting' | 'connected' | 'disconnected' | 'error'>(
  'disconnected',
);
let feed = $state<FeedEntry[]>([]);
let agentThreadFeeds = $state<Map<string, FeedEntry[]>>(new Map());
let agentThreadVersion = $state(0);

// Use $derived for groupedFeed to prevent infinite loops
// This ensures it only recalculates when feed reference changes
// Cache for grouped feed to prevent O(N) recalculations on every token during streaming
let lastGroupedFeed = $state<FeedEntry[]>([]);
let lastFeedVersion = 0;
let feedVersion = $state(0);

// Grouped feed only recalculates when feedVersion changes (new entries)
let groupedFeed = $derived.by(() => {
  // Use feedVersion to track structural changes vs content updates
  const _v = feedVersion;
  return getGroupedFeed();
});

let providers = $state<ProviderStatusPayload['providers']>([]);
let koryThought = $state<string>('');
let koryPhase = $state<string>('');
let isYoloMode = $state<boolean>(false);
let pendingPermissions = $state<PermissionRequest[]>([]);
let pendingQuestion = $state<{ question: string; options: string[]; allowOther: boolean } | null>(
  null,
);
let sessionChanges = $state<Map<string, ChangeSummary[]>>(new Map());

// Smart context detection - files auto-included for current session
interface DetectedContextFile {
  path: string;
  relevance: number;
  reason: string;
}
let detectedContext = $state<DetectedContextFile[]>([]);

// Track analyzing thought index to avoid O(N) filtering
let analyzingThoughtId = $state<string | null>(null);

// Initialize manager agent state
const initialAgents = new Map<string, AgentState>();
initialAgents.set('kory-manager', {
  identity: {
    id: 'kory-manager',
    name: 'Kory',
    role: 'manager',
    model: 'Unknown',
    provider: 'google',
    domain: 'general',
    glowColor: 'rgba(255,215,0,0.6)',
  },
  status: 'idle',
  content: '',
  thinking: '',
  toolCalls: [],
  task: 'Orchestrating...',
  tokensUsed: 0,
  contextMax: 0,
  contextKnown: false,
  hasUsageData: false,
  sessionId: '',
});

let agents = $state<Map<string, AgentState>>(initialAgents);

// File edit streaming state (Cursor-style live preview)
interface ActiveFileEdit {
  path: string;
  content: string;
  operation: 'create' | 'edit';
  agentId: string;
  startedAt: number;
}
let activeFileEdits = $state<Map<string, ActiveFileEdit>>(new Map());

const MAX_FEED_ENTRIES = 2000;
let feedIdCounter = 0;
let hasShownMalformedWsMessage = false;
// Track pending file-edit removal timers for cleanup on disconnect
let fileEditTimers = new Map<string, ReturnType<typeof setTimeout>>();

// ─── Glow class resolver ───────────────────────────────────────────────────

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

function resolveGlowClass(agent?: AgentIdentity): string {
  if (!agent) return '';
  switch (agent.domain) {
    case 'frontend':
      return 'glow-codex';
    case 'backend':
      return 'glow-google';
    case 'general':
      return 'glow-claude';
    case 'review':
      return 'glow-claude';
    case 'test':
      return 'glow-test';
    default:
      return '';
  }
}

// ─── Feed Management ────────────────────────────────────────────────────────

function addFeedEntry(entry: Omit<FeedEntry, 'id'>) {
  const newEntry: FeedEntry = { ...entry, id: `fe-${++feedIdCounter}` };
  if (newEntry.type === 'thought' && (newEntry.metadata as any)?.phase === 'analyzing') {
    analyzingThoughtId = newEntry.id;
  }
  feed.push(newEntry);
  if (feed.length > MAX_FEED_ENTRIES) feed.splice(0, feed.length - MAX_FEED_ENTRIES);
  feedVersion++;
}

function addClientError(text: string) {
  const activeSessionId = sessionStore.activeSessionId;
  if (!activeSessionId) return;
  addFeedEntry({
    timestamp: Date.now(),
    type: 'error',
    agentId: 'kory-manager',
    agentName: 'Kory',
    glowClass: '',
    text,
    metadata: { sessionId: activeSessionId, source: 'client' },
  });
}

function pushToast(
  type: 'info' | 'warning' | 'success' | 'error',
  message: string,
): void {
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

/** Efficiently remove the ephemeral analyzing thought. */
function removeAnalyzingThoughtEntries() {
  if (!analyzingThoughtId) return;
  const idx = feed.findIndex(e => e.id === analyzingThoughtId);
  if (idx !== -1) {
    feed.splice(idx, 1);
    feedVersion++;
  }
  analyzingThoughtId = null;
}

// Accumulate streaming text into the last matching feed entry instead of creating one per token
function accumulateFeedEntry(entry: Omit<FeedEntry, 'id'>) {
  const lastIdx = feed.length - 1;
  const last = lastIdx >= 0 ? feed[lastIdx] : null;
  if (last && last.type === entry.type && last.agentId === entry.agentId) {
    const updates: Partial<FeedEntry> = {
      text: last.text + entry.text,
      timestamp: entry.timestamp,
    };

    if (last.type === 'thinking' && last.thinkingStartedAt) {
      updates.durationMs = entry.timestamp - last.thinkingStartedAt;
    } else if (last.type === 'thinking' && !last.thinkingStartedAt) {
      updates.thinkingStartedAt = entry.timestamp;
    }

    // Merge updates into the existing object to avoid identity change if possible,
    // though Svelte 5 will still trigger if the element reference changes.
    feed[lastIdx] = { ...last, ...updates };
    // NOTE: feedVersion NOT incremented here because we're just updating the last item's text,
    // which shouldn't require a full regrouping of the whole feed.
  } else {
    addFeedEntry(entry);
  }
}

function addUserMessage(sessionId: string, content: string, attachments?: Array<{type: string, data: string, name: string}>) {
  const userEntry: FeedEntry = {
    id: `user-${++feedIdCounter}`,
    timestamp: Date.now(),
    type: 'user_message',
    agentId: 'user',
    agentName: 'You',
    glowClass: '',
    text: content,
    metadata: { sessionId, attachments },
  };
  feed.push(userEntry);
  if (feed.length > MAX_FEED_ENTRIES) feed.splice(0, feed.length - MAX_FEED_ENTRIES);
}

function getAgentThreadKey(sessionId: string, agentId: string): string {
  return `${sessionId}:${agentId}`;
}

function setAgentThreadFeed(sessionId: string, agentId: string, entries: FeedEntry[]) {
  agentThreadFeeds.set(getAgentThreadKey(sessionId, agentId), entries);
  agentThreadVersion++;
}

function upsertAgentThreadEntry(sessionId: string, agentId: string, entry: Omit<FeedEntry, 'id'>) {
  const key = getAgentThreadKey(sessionId, agentId);
  const current = agentThreadFeeds.get(key) ?? [];
  const nextEntry: FeedEntry = { ...entry, id: `aft-${++feedIdCounter}` };
  const next = [...current, nextEntry];
  if (next.length > MAX_FEED_ENTRIES) {
    next.splice(0, next.length - MAX_FEED_ENTRIES);
  }
  setAgentThreadFeed(sessionId, agentId, next);
}

function accumulateAgentThreadEntry(
  sessionId: string,
  agentId: string,
  entry: Omit<FeedEntry, 'id'>,
) {
  const key = getAgentThreadKey(sessionId, agentId);
  const current = agentThreadFeeds.get(key) ?? [];
  const lastIdx = current.length - 1;
  const last = lastIdx >= 0 ? current[lastIdx] : null;

  if (last && last.type === entry.type && last.agentId === entry.agentId) {
    const next = [...current];
    next[lastIdx] = {
      ...last,
      text: last.text + entry.text,
      timestamp: entry.timestamp,
      ...(last.type === 'thinking' && last.thinkingStartedAt
        ? { durationMs: entry.timestamp - last.thinkingStartedAt }
        : {}),
      ...(last.type === 'thinking' && !last.thinkingStartedAt
        ? { thinkingStartedAt: entry.timestamp }
        : {}),
    };
    setAgentThreadFeed(sessionId, agentId, next);
    return;
  }

  upsertAgentThreadEntry(sessionId, agentId, entry);
}

function getAgentFeedLabel(agentId: string, fallback = 'Agent'): string {
  return agents.get(agentId)?.identity.name ?? fallback;
}

// ─── Message Handler ───────────────────────────────────────────────────────

function handleMessage(msg: WSMessage) {
  const activeSessionId = sessionStore.activeSessionId;
  const isForActiveSession = !msg.sessionId || msg.sessionId === activeSessionId;

  switch (msg.type) {
    case 'agent.spawned': {
      const p = msg.payload as AgentSpawnedPayload;
      // In Svelte 5, $state Maps are reactive to set/delete
      agents.set(p.agent.id, {
        identity: p.agent,
        status: 'thinking',
        content: '',
        thinking: '',
        toolCalls: [],
        task: p.task,
        tokensUsed: 0,
        contextMax: 0,
        contextKnown: false,
        hasUsageData: false,
        sessionId: msg.sessionId ?? '',
      });
      if (msg.sessionId) {
        setAgentThreadFeed(msg.sessionId, p.agent.id, agentThreadFeeds.get(getAgentThreadKey(msg.sessionId, p.agent.id)) ?? []);
      }

      if (isForActiveSession) {
        addFeedEntry({
          timestamp: msg.timestamp,
          type: 'system',
          agentId: p.agent.id,
          agentName: p.agent.name,
          glowClass: resolveGlowClass(p.agent),
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
      const key = getAgentThreadKey(sessionId, p.agentId);
      const current = agentThreadFeeds.get(key) ?? [];
      const last = current[current.length - 1];
      if (
        p.entry.role === 'assistant' &&
        last?.type === 'content' &&
        last.agentId === p.agentId &&
        last.text === p.entry.content.trim()
      ) {
        break;
      }
      const agentName = getAgentFeedLabel(p.agentId);
      const role = p.entry.role;
      upsertAgentThreadEntry(sessionId, p.agentId, {
        timestamp: p.entry.createdAt,
        type: role === 'user' ? 'user_message' : 'content',
        agentId: role === 'manager' ? 'kory-manager' : role === 'user' ? 'user' : p.agentId,
        agentName: role === 'manager' ? 'Manager' : role === 'user' ? 'You' : agentName,
        glowClass: role === 'assistant' ? resolveGlowClass(agents.get(p.agentId)?.identity) : role === 'manager' ? 'glow-kory' : '',
        text: p.entry.content,
        metadata: { sessionId, sourceAgentId: p.agentId, threadRole: role },
      });
      break;
    }

    case 'agent.status': {
      const p = msg.payload as AgentStatusPayload;
      const agent = agents.get(p.agentId);
      if (agent) {
        agent.status = p.status;
        if (msg.sessionId) agent.sessionId = msg.sessionId;
      }
      break;
    }

    case 'agent.completed':
    case 'stream.complete': {
      const p = msg.payload as any;
      const agent = agents.get(p.agentId);
      if (agent) {
        agent.status = 'done';
        if (msg.sessionId) agent.sessionId = msg.sessionId;
      }
      if (isForActiveSession) removeAnalyzingThoughtEntries();
      break;
    }

    case 'agent.error': {
      const p = msg.payload as any;
      if (isForActiveSession) {
        removeAnalyzingThoughtEntries();
        addFeedEntry({
          timestamp: msg.timestamp,
          type: 'error',
          agentId: p.agentId ?? '',
          agentName: agents.get(p.agentId)?.identity.name ?? 'Unknown',
          glowClass: '',
          text: p.error ?? 'Unknown error',
        });
      }
      break;
    }

    case 'stream.delta': {
      const p = msg.payload as StreamDeltaPayload;
      const agent = agents.get(p.agentId);
      if (agent) {
        agent.content += p.content;
        agent.status = 'streaming';
        if (msg.sessionId) agent.sessionId = msg.sessionId;
      }
      if (isForActiveSession) {
        removeAnalyzingThoughtEntries();
        accumulateFeedEntry({
          timestamp: msg.timestamp,
          type: 'content',
          agentId: p.agentId,
          agentName: agents.get(p.agentId)?.identity.name ?? 'Worker',
          glowClass: resolveGlowClass(agents.get(p.agentId)?.identity),
          text: p.content,
        });
      }
      if (msg.sessionId) {
        accumulateAgentThreadEntry(msg.sessionId, p.agentId, {
          timestamp: msg.timestamp,
          type: 'content',
          agentId: p.agentId,
          agentName: getAgentFeedLabel(p.agentId),
          glowClass: resolveGlowClass(agents.get(p.agentId)?.identity),
          text: p.content,
          metadata: { sessionId: msg.sessionId },
        });
      }
      break;
    }

    case 'stream.clear_content': {
      const p = msg.payload as { agentId: string };
      const agent = agents.get(p.agentId);
      if (agent) {
        agent.content = '';
        agent.status = 'idle';
        if (msg.sessionId) agent.sessionId = msg.sessionId;
      }
      if (isForActiveSession) {
        // Efficiently filter the feed without replacing the whole array if possible,
        // but Svelte 5 needs array identity change for broad reactivity on arrays.
        const entriesToRemove = new Set<string>();
        for (let i = feed.length - 1; i >= 0; i--) {
          const entry = feed[i];
          if (entry?.type === 'user_message') break;
          if (entry?.agentId === p.agentId && entry?.type === 'content') {
            entriesToRemove.add(entry.id);
          } else if (entry?.type !== 'content' && entry?.type !== 'thinking') {
            break;
          }
        }
        if (entriesToRemove.size > 0) {
          feed = feed.filter((e) => !entriesToRemove.has(e.id));
          feedVersion++;
        }
      }
      break;
    }

    case 'stream.thinking': {
      const p = msg.payload as StreamThinkingPayload;
      const agent = agents.get(p.agentId);
      if (agent) {
        agent.thinking += p.thinking;
        if (msg.sessionId) agent.sessionId = msg.sessionId;
      }
      if (isForActiveSession) {
        accumulateFeedEntry({
          timestamp: msg.timestamp,
          type: 'thinking',
          agentId: p.agentId,
          agentName: agents.get(p.agentId)?.identity.name ?? 'Worker',
          glowClass: resolveGlowClass(agents.get(p.agentId)?.identity),
          text: p.thinking,
          thinkingStartedAt: msg.timestamp,
        });
      }
      if (msg.sessionId) {
        accumulateAgentThreadEntry(msg.sessionId, p.agentId, {
          timestamp: msg.timestamp,
          type: 'thinking',
          agentId: p.agentId,
          agentName: getAgentFeedLabel(p.agentId),
          glowClass: resolveGlowClass(agents.get(p.agentId)?.identity),
          text: p.thinking,
          thinkingStartedAt: msg.timestamp,
          metadata: { sessionId: msg.sessionId },
        });
      }
      break;
    }

    case 'stream.tool_call': {
      const p = msg.payload as StreamToolCallPayload;
      const agent = agents.get(p.agentId);
      if (agent) {
        agent.toolCalls.push({ name: p.toolCall.name, status: 'running' });
        agent.status = 'tool_calling';
        if (msg.sessionId) agent.sessionId = msg.sessionId;
      }
      if (isForActiveSession) {
        addFeedEntry({
          timestamp: msg.timestamp,
          type: 'tool_call',
          agentId: p.agentId,
          agentName: agents.get(p.agentId)?.identity.name ?? 'Worker',
          glowClass: resolveGlowClass(agents.get(p.agentId)?.identity),
          text: `Calling tool: ${p.toolCall.name}`,
          metadata: { toolCall: p.toolCall },
        });
      }
      if (msg.sessionId) {
        upsertAgentThreadEntry(msg.sessionId, p.agentId, {
          timestamp: msg.timestamp,
          type: 'tool_call',
          agentId: p.agentId,
          agentName: getAgentFeedLabel(p.agentId),
          glowClass: resolveGlowClass(agents.get(p.agentId)?.identity),
          text: `Calling tool: ${p.toolCall.name}`,
          metadata: { toolCall: p.toolCall, sessionId: msg.sessionId },
        });
      }
      break;
    }

    case 'stream.tool_result': {
      const p = msg.payload as StreamToolResultPayload;
      if (isForActiveSession) {
        addFeedEntry({
          timestamp: msg.timestamp,
          type: 'tool_result',
          agentId: p.agentId,
          agentName: agents.get(p.agentId)?.identity.name ?? 'Worker',
          glowClass: resolveGlowClass(agents.get(p.agentId)?.identity),
          text: p.toolResult.isError
            ? `Tool error: ${p.toolResult.output}`
            : `Tool result (${p.toolResult.durationMs.toFixed(0)}ms): ${p.toolResult.output}`,
          metadata: { toolResult: p.toolResult },
        });
      }
      if (msg.sessionId) {
        upsertAgentThreadEntry(msg.sessionId, p.agentId, {
          timestamp: msg.timestamp,
          type: 'tool_result',
          agentId: p.agentId,
          agentName: getAgentFeedLabel(p.agentId),
          glowClass: resolveGlowClass(agents.get(p.agentId)?.identity),
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
      const agent = agents.get(p.agentId);
      if (agent) {
        agent.tokensUsed = Math.max(0, p.tokensUsed || 0);
        if (typeof p.contextWindow === 'number') {
          agent.contextMax = p.contextWindow;
        }
        agent.contextKnown = !!p.contextKnown;
        agent.hasUsageData = !!p.usageKnown;
        if (msg.sessionId) agent.sessionId = msg.sessionId;
      }
      break;
    }

    case 'stream.file_delta': {
      const p = msg.payload as StreamFileDeltaPayload;
      if (isForActiveSession) {
        const existing = activeFileEdits.get(p.path);
        if (existing) {
          existing.content += p.delta;
        } else {
          activeFileEdits.set(p.path, {
            path: p.path,
            content: p.delta,
            operation: p.operation,
            agentId: p.agentId,
            startedAt: Date.now(),
          });
        }
      }
      break;
    }

    case 'stream.file_complete': {
      const p = msg.payload as StreamFileCompletePayload;
      if (isForActiveSession) {
        const existingTimer = fileEditTimers.get(p.path);
        if (existingTimer) clearTimeout(existingTimer);
        const timer = setTimeout(() => {
          activeFileEdits.delete(p.path);
          fileEditTimers.delete(p.path);
        }, 2000);
        fileEditTimers.set(p.path, timer);
      }
      break;
    }

    case 'kory.thought': {
      const p = msg.payload as KoryThoughtPayload;
      if (msg.sessionId) {
        const manager = agents.get('kory-manager');
        if (manager) manager.sessionId = msg.sessionId;
      }
      if (isForActiveSession) {
        koryThought = p.thought;
        koryPhase = p.phase;
        removeAnalyzingThoughtEntries();
        addFeedEntry({
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
        removeAnalyzingThoughtEntries();
        addFeedEntry({
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
      const p = msg.payload as any;
      if (isForActiveSession) {
        pendingQuestion = {
          question: p.question,
          options: p.options,
          allowOther: p.allowOther,
        };
      }
      break;
    }

    case 'provider.status': {
      const p = msg.payload as ProviderStatusPayload;
      const newList = Array.isArray((p as any)?.providers) ? (p as any).providers : [];
      providers = newList;
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
        sessionChanges.set(msg.sessionId, p.changes);
      }
      break;
    }

    case 'session.accept_changes': {
      if (msg.sessionId) {
        sessionChanges.delete(msg.sessionId);
      }
      break;
    }

    case 'permission.request': {
      const p = msg.payload as PermissionRequest;
      if (isForActiveSession) {
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
        addFeedEntry({
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
      const p = msg.payload as any;
      if (!isForActiveSession) break;
      removeAnalyzingThoughtEntries();
      const errorText = p.error ?? 'Unknown system error';
      const last = feed.length > 0 ? feed[feed.length - 1] : null;
      const isDuplicate =
        last?.type === 'error' && last.text === errorText && msg.timestamp - last.timestamp < 3000;
      if (!isDuplicate) {
        toastStore.error(errorText);
        addFeedEntry({
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
      const text = p.title ? `${p.title}: ${p.message ?? ''}`.trim() : p.message ?? 'Notification';
      pushToast(notificationType, text);
      addFeedEntry({
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
  // In Tauri, use the direct backend URL
  const directUrl = getWsUrl();
  // Use Vite-injected env for backend URL (this is set correctly by vite.config.ts)
  const viteWsUrl = import.meta.env.VITE_BACKEND_WS_URL;
  const defaultBackendWs = viteWsUrl || 'ws://127.0.0.1:3001/ws';

  const candidates: string[] = [];
  // In dev mode (browser), prefer the backend URL directly
  // In Tauri, directUrl should already point to backend
  if (preferredUrl) candidates.push(ensureWsPath(preferredUrl));
  // Add backend URL first for browser dev mode
  if (defaultBackendWs && !candidates.includes(defaultBackendWs)) candidates.push(defaultBackendWs);
  // Then Tauri URL if different
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

  // Reset candidates if a new URL is provided or list is empty
  if (url || wsCandidates.length === 0) {
    wsCandidates = buildWsCandidates(url);
    wsCandidateIndex = 0;
    console.log('[WS] Built candidates:', wsCandidates);
  }

  let wsUrl = wsCandidates[wsCandidateIndex];
  console.log('[WS] Trying URL:', wsUrl, 'index:', wsCandidateIndex);
  if (!wsUrl) {
    wsCandidateIndex = 0;
    scheduleReconnect();
    return;
  }

  connectionStatus = 'connecting';
  providers = Array.isArray(providers) ? providers : [];

  try {
    const protocols = ['koryphaios'];
    let finalWsUrl = wsUrl;
    if (authStore.token) {
      // Append auth token as a query parameter because WebSocket subprotocols cannot contain spaces (e.g. "Bearer ...")
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
      // Subscribe to the active session so backend can scope messages
      const activeSid = sessionStore.activeSessionId;
      if (activeSid) subscribeToSession(activeSid);
    };

    ws.onmessage = (event) => {
      try {
        const parsed: unknown = JSON.parse(event.data);
        if (!isWSMessageLike(parsed)) {
          if (!hasShownMalformedWsMessage) {
            hasShownMalformedWsMessage = true;
            addClientError('Received malformed realtime update from server.');
          }
          if (import.meta.env.DEV) console.warn('Discarded malformed websocket payload', parsed);
          return;
        }
        handleMessage(parsed);
      } catch (error) {
        if (!hasShownMalformedWsMessage) {
          hasShownMalformedWsMessage = true;
          addClientError('Failed to parse realtime update from server.');
        }
        if (import.meta.env.DEV) console.warn('Failed to parse websocket message', error);
      }
    };

    ws.onclose = (event) => {
      console.log('[WS] Connection closed:', event.code, event.reason);
      connectionStatus = 'disconnected';
      wsConnection = null;

      // Rotate through candidates if we haven't exhausted them
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

function subscribeToSession(sessionId: string) {
  if (!sessionId || wsConnection?.readyState !== WebSocket.OPEN) return;
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
  // Clean up file edit timers
  for (const timer of fileEditTimers.values()) clearTimeout(timer);
  fileEditTimers.clear();
  wsConnection?.close();
  wsConnection = null;
  connectionStatus = 'disconnected';
}

/** Fetch provider status from API so providers and API keys show after refresh (before or without WS). */
export async function loadProvidersFromApi(): Promise<void> {
  if (!browser) return;
  try {
    const res = await apiFetch(apiUrl('/api/providers'));
    if (!res.ok) {
      if (import.meta.env.DEV) console.warn(`Failed to load providers: HTTP ${res.status}`);
      return;
    }
    const json = await parseJsonResponse<{ data?: ProviderStatusPayload['providers'] }>(res);
    const list = json?.data;
    if (Array.isArray(list)) providers = list;
  } catch (error) {
    if (import.meta.env.DEV) console.warn('Failed to load providers from API', error);
  }
}

function sendMessage(sessionId: string, content: string, model?: string, reasoningLevel?: string, attachments?: Array<{type: string, data: string, name: string}>) {
  addUserMessage(sessionId, content, attachments);
  // Clear previous context detection for new message
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
      addClientError(message);
    });
}

async function loadAgentThreads(sessionId: string): Promise<void> {
  if (!sessionId) return;
  try {
    const res = await apiFetch(apiUrl(`/api/agent/threads/${sessionId}`));
    const data = await parseJsonResponse<{
      ok?: boolean;
      data?: Array<{
        agent: AgentIdentity;
        status: AgentStatus;
      }>;
    }>(res);
    if (!res.ok || data?.ok === false || !Array.isArray(data?.data)) return;

    for (const thread of data.data) {
      const existing = agents.get(thread.agent.id);
      agents.set(thread.agent.id, {
        identity: thread.agent,
        status: thread.status,
        content: existing?.content ?? '',
        thinking: existing?.thinking ?? '',
        toolCalls: existing?.toolCalls ?? [],
        task: existing?.task ?? '',
        tokensUsed: existing?.tokensUsed ?? 0,
        contextMax: existing?.contextMax ?? 0,
        contextKnown: existing?.contextKnown ?? false,
        hasUsageData: existing?.hasUsageData ?? false,
        sessionId,
      });
      if (!agentThreadFeeds.has(getAgentThreadKey(sessionId, thread.agent.id))) {
        setAgentThreadFeed(sessionId, thread.agent.id, []);
      }
    }
  } catch (error) {
    if (import.meta.env.DEV) console.warn('Failed to load agent threads', error);
  }
}

async function loadAgentThreadMessages(sessionId: string, agentId: string): Promise<void> {
  if (!sessionId || !agentId) return;
  try {
    const res = await apiFetch(apiUrl(`/api/agent/${agentId}/thread?sessionId=${encodeURIComponent(sessionId)}`));
    const data = await parseJsonResponse<{
      ok?: boolean;
      data?: Array<{
        id: string;
        role: 'manager' | 'user' | 'assistant';
        content: string;
        createdAt: number;
      }>;
    }>(res);
    if (!res.ok || data?.ok === false || !Array.isArray(data?.data)) return;
    const identity = agents.get(agentId)?.identity;
    const entries = data.data.map((entry) => ({
      id: `ath-${entry.id}`,
      timestamp: entry.createdAt,
      type: entry.role === 'user' ? ('user_message' as const) : ('content' as const),
      agentId: entry.role === 'manager' ? 'kory-manager' : entry.role === 'user' ? 'user' : agentId,
      agentName:
        entry.role === 'manager'
          ? 'Manager'
          : entry.role === 'user'
            ? 'You'
            : identity?.name ?? 'Agent',
      glowClass:
        entry.role === 'assistant'
          ? resolveGlowClass(identity)
          : entry.role === 'manager'
            ? 'glow-kory'
            : '',
      text: entry.content,
      metadata: { sessionId, sourceAgentId: agentId, threadRole: entry.role },
    }));
    setAgentThreadFeed(sessionId, agentId, entries);
  } catch (error) {
    if (import.meta.env.DEV) console.warn('Failed to load agent thread messages', error);
  }
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
      addClientError(message);
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

// ─── Session Message Loading ────────────────────────────────────────────────

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
  // Clear current feed and metadata for the new session
  clearFeed();
  koryThought = '';
  koryPhase = '';

  // Fetch timeline to link ghost hashes
  let timeline: any[] = [];
  try {
    const res = await apiFetch(apiUrl(`/api/sessions/${sessionId}/timetravel`));
    const data = await parseJsonResponse(res);
    if (data.ok) timeline = data.data.timeline;
  } catch (err) {
    console.warn('Failed to fetch timeline:', err);
  }

  feed = messages.map((m) => {
    // Find linked ghost hash from timeline
    const ghost = timeline.find((t) => t.messageId === m.id);

    return {
      id: `hist-${m.id}`,
      timestamp: m.createdAt,
      type: m.role === 'user' ? ('user_message' as const) : ('content' as const),
      agentId: m.role === 'user' ? 'user' : 'kory-manager',
      agentName: m.role === 'user' ? 'You' : 'Kory',
      glowClass: m.role === 'user' ? '' : 'glow-kory',
      text: m.content,
      metadata: { sessionId, model: m.model, cost: m.cost },
      ghostHash: ghost?.hash,
    };
  });
  feedVersion++;
}

function removeEntries(ids: Set<string>) {
  feed = feed.filter((e) => !ids.has(e.id));
}

function getToolName(entry: FeedEntry): string {
  const metadata = entry.metadata as
    | { toolCall?: { name?: string }; toolResult?: { name?: string } }
    | undefined;
  return metadata?.toolCall?.name ?? metadata?.toolResult?.name ?? '';
}

function getGroupedEntries(entries: FeedEntry[]): FeedEntry[] {
  const result: FeedEntry[] = [];
  let currentGroup: FeedEntry | null = null;

  for (const entry of entries) {
    const toolName = getToolName(entry);
    const isEphemeral =
      (entry.type === 'tool_call' || entry.type === 'tool_result') && EPHEMERAL_TOOLS.has(toolName);

    if (isEphemeral) {
      if (currentGroup && currentGroup.agentId === entry.agentId) {
        currentGroup.entries!.push(entry);
        currentGroup.timestamp = entry.timestamp;

        const toolNames = new Set(currentGroup.entries!.map(getToolName).filter(Boolean));
        const count = Math.ceil(currentGroup.entries!.length / 2);
        currentGroup.text = `Explored codebase (${count} operation${count !== 1 ? 's' : ''}: ${Array.from(toolNames).join(', ')})`;
      } else {
        currentGroup = {
          id: `group-${entry.id}`,
          timestamp: entry.timestamp,
          type: 'tool_group',
          agentId: entry.agentId,
          agentName: entry.agentName,
          glowClass: entry.glowClass,
          text: `Analyzing codebase...`,
          entries: [entry],
          isCollapsed: true,
        };
        result.push(currentGroup);
      }
    } else {
      currentGroup = null;
      result.push(entry);
    }
  }
  return result;
}

function getGroupedFeed(): FeedEntry[] {
  return getGroupedEntries(feed);
}

// ─── Derived helpers ────────────────────────────────────────────────────────

function getManagerStatus(): AgentStatus {
  const activeSessionId = sessionStore.activeSessionId;
  const manager = agents.get('kory-manager');

  // Only show manager as active if it's working on the CURRENT session
  if (
    manager &&
    manager.status !== 'idle' &&
    manager.status !== 'done' &&
    (manager.sessionId === activeSessionId || !manager.sessionId)
  ) {
    return manager.status;
  }

  // Fallback: if any worker for THIS session is active, infer from their states
  for (const a of agents.values()) {
    if (a.sessionId === activeSessionId && a.status !== 'idle' && a.status !== 'done') {
      return a.status;
    }
  }
  return 'idle';
}

function getContextUsage(): {
  used: number;
  max: number;
  percent: number;
  isReliable: boolean;
  reason?: string;
} {
  const activeSessionId = sessionStore.activeSessionId;
  const candidates = [...agents.values()].filter(
    (a) => a.sessionId === activeSessionId && a.hasUsageData,
  );

  // Exact session context is only reliable when we have one authoritative usage source.
  if (candidates.length === 0) {
    return { used: 0, max: 0, percent: 0, isReliable: false, reason: 'usage_unknown' };
  }
  if (candidates.length > 1) {
    return { used: 0, max: 0, percent: 0, isReliable: false, reason: 'multi_agent_usage' };
  }

  const agent = candidates[0];
  if (!agent.contextKnown || agent.contextMax <= 0) {
    return { used: 0, max: 0, percent: 0, isReliable: false, reason: 'context_unknown' };
  }

  const used = Math.max(0, agent.tokensUsed);
  const max = agent.contextMax;
  const percent = Math.min(100, Math.round((used / max) * 100));
  return { used, max, percent, isReliable: true };
}

function isSessionRunning(sessionId: string): boolean {
  for (const a of agents.values()) {
    if (a.sessionId === sessionId && a.status !== 'idle' && a.status !== 'done') {
      return true;
    }
  }
  return false;
}

/** Mark all agents for this session as done (optimistic UI when user clicks Stop). */
function markSessionAgentsStopped(sessionId: string) {
  let changed = false;
  for (const a of agents.values()) {
    if (a.sessionId === sessionId && a.status !== 'idle' && a.status !== 'done') {
      a.status = 'done';
      changed = true;
    }
  }
  if (changed) agents = new Map(agents);
}

/** Mark a single agent as done (optimistic UI when user cancels one worker). */
function markAgentStopped(agentId: string) {
  const agent = agents.get(agentId);
  if (agent && agent.status !== 'idle' && agent.status !== 'done') {
    agent.status = 'done';
    agents = new Map(agents);
  }
}

function sendUserInput(sessionId: string, selection: string, text?: string) {
  if (wsConnection?.readyState === WebSocket.OPEN) {
    wsConnection.send(
      JSON.stringify({
        type: 'user_input',
        sessionId,
        selection,
        text,
        timestamp: Date.now(),
      }),
    );
  }
  pendingQuestion = null;
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
  feed = [];
  feedVersion++;
  activeFileEdits = new Map();
  detectedContext = [];
  // Clear non-essential agent states but keep kory-manager
  const manager = agents.get('kory-manager');
  agents = new Map();
  if (manager) agents.set('kory-manager', { ...manager, content: '', thinking: '', toolCalls: [] });
}

async function rewind(hash: string) {
  const sessionId = sessionStore.activeSessionId;
  if (!sessionId) return;

  try {
    const res = await apiFetch(apiUrl(`/api/sessions/${sessionId}/rewind`), {
      method: 'POST',
      body: JSON.stringify({ hash }),
    });
    const data = await parseJsonResponse(res);
    if (data.ok) {
      toastStore.success('Rewound successfully');
      // Reload session messages and timeline
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

function getAgentThreadFeed(sessionId: string, agentId: string): FeedEntry[] {
  const entries = agentThreadFeeds.get(getAgentThreadKey(sessionId, agentId)) ?? [];
  return getGroupedEntries(entries);
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

// ─── Exported Store ─────────────────────────────────────────────────────────

export const wsStore = {
  get connection() {
    return wsConnection;
  },
  get status() {
    return connectionStatus;
  },
  get agents() {
    return agents;
  },
  get feed() {
    return feed;
  },
  get groupedFeed() {
    return groupedFeed;
  },
  get agentThreadVersion() {
    return agentThreadVersion;
  },
  get providers() {
    return providers;
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
    return pendingQuestion;
  },
  get sessionChanges() {
    return sessionChanges;
  },
  get activeFileEdits() {
    return activeFileEdits;
  },
  get managerStatus() {
    return getManagerStatus();
  },
  get contextUsage() {
    return getContextUsage();
  },
  get detectedContext() {
    return detectedContext;
  },
  isSessionRunning,
  markSessionAgentsStopped,
  markAgentStopped,
  clearAnalyzing: removeAnalyzingThoughtEntries,
  connect,
  disconnect,
  sendMessage,
  sendAgentMessage,
  sendUserInput,
  respondToChanges,
  loadSessionMessages,
  loadAgentThreads,
  loadAgentThreadMessages,
  getAgentThreadFeed,
  removeEntries,
  respondToPermission,
  subscribeToSession,
  clearFeed,
  rewind,
  toggleYolo,
  setYoloMode,
  loadProvidersFromApi,
};
