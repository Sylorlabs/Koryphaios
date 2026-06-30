// Agent Store — handles agent state, identity, and per-agent thread feeds
// Split from the monolithic websocket.svelte.ts for better separation of concerns

import type {
  AgentIdentity,
  AgentStatus,
  StreamUsagePayload,
} from '@koryphaios/shared';
import type { FeedEntry } from '$lib/types';
import { sessionStore } from './sessions.svelte';
import { apiUrl } from '$lib/utils/api-url';
import { apiFetch, parseJsonResponse } from '$lib/api.svelte';
import { feedStore, getGroupedEntries } from './feed.svelte';

// ─── Agent State ────────────────────────────────────────────────────────────

export interface AgentState {
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

// ─── Reactive State ──────────────────────────────────────────────────────────

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
let agentThreadFeeds = $state<Map<string, FeedEntry[]>>(new Map());
let agentThreadVersion = $state(0);

const MAX_THREAD_ENTRIES = 2000;

// ─── Agent Thread Helpers ───────────────────────────────────────────────────

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
  const nextEntry: FeedEntry = { ...entry, id: feedStore.nextFeedId('aft') };
  const next = [...current, nextEntry];
  if (next.length > MAX_THREAD_ENTRIES) {
    next.splice(0, next.length - MAX_THREAD_ENTRIES);
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
    last.text += entry.text;
    last.timestamp = entry.timestamp;
    if (last.type === 'thinking' && last.thinkingStartedAt) {
      last.durationMs = entry.timestamp - last.thinkingStartedAt;
    } else if (last.type === 'thinking' && !last.thinkingStartedAt) {
      last.thinkingStartedAt = entry.timestamp;
    }
    agentThreadVersion++;
    return;
  }

  upsertAgentThreadEntry(sessionId, agentId, entry);
}

function getAgentFeedLabel(agentId: string, fallback = 'Agent'): string {
  return agents.get(agentId)?.identity.name ?? fallback;
}

function getAgentThreadEntries(sessionId: string, agentId: string): FeedEntry[] {
  return agentThreadFeeds.get(getAgentThreadKey(sessionId, agentId)) ?? [];
}

function getAgentThreadFeed(sessionId: string, agentId: string): FeedEntry[] {
  return getGroupedEntries(getAgentThreadEntries(sessionId, agentId));
}

function ensureAgentThreadFeed(sessionId: string, agentId: string) {
  const key = getAgentThreadKey(sessionId, agentId);
  if (!agentThreadFeeds.has(key)) {
    setAgentThreadFeed(sessionId, agentId, []);
  }
}

// ─── Agent Actions ──────────────────────────────────────────────────────────

export function spawnAgent(identity: AgentIdentity, task: string, sessionId: string) {
  agents.set(identity.id, {
    identity,
    status: 'thinking',
    content: '',
    thinking: '',
    toolCalls: [],
    task,
    tokensUsed: 0,
    contextMax: 0,
    contextKnown: false,
    hasUsageData: false,
    sessionId,
  });
  agents = new Map(agents);
}

export function updateAgentStatus(agentId: string, status: AgentStatus, sessionId?: string) {
  const agent = agents.get(agentId);
  if (agent) {
    agent.status = status;
    if (sessionId) agent.sessionId = sessionId;
  }
}

export function appendAgentContent(agentId: string, content: string, sessionId?: string) {
  const agent = agents.get(agentId);
  if (agent) {
    agent.content += content;
    agent.status = 'streaming';
    if (sessionId) agent.sessionId = sessionId;
  }
}

export function appendAgentThinking(agentId: string, thinking: string, sessionId?: string) {
  const agent = agents.get(agentId);
  if (agent) {
    agent.thinking += thinking;
    if (sessionId) agent.sessionId = sessionId;
  }
}

export function addToolCall(agentId: string, name: string, sessionId?: string) {
  const agent = agents.get(agentId);
  if (agent) {
    agent.toolCalls.push({ name, status: 'running' });
    agent.status = 'tool_calling';
    if (sessionId) agent.sessionId = sessionId;
  }
}

export function updateUsage(agentId: string, payload: StreamUsagePayload, sessionId?: string) {
  const agent = agents.get(agentId);
  if (agent) {
    agent.tokensUsed = Math.max(0, payload.tokensUsed || 0);
    if (typeof payload.contextWindow === 'number') {
      agent.contextMax = payload.contextWindow;
    }
    agent.contextKnown = !!payload.contextKnown;
    agent.hasUsageData = !!payload.usageKnown;
    if (sessionId) agent.sessionId = sessionId;
  }
}

export function completeAgent(agentId: string, sessionId?: string) {
  const agent = agents.get(agentId);
  if (agent) {
    agent.status = 'done';
    if (sessionId) agent.sessionId = sessionId;
  }
}

export function clearAgentContent(agentId: string) {
  const agent = agents.get(agentId);
  if (agent) {
    agent.content = '';
    agent.thinking = '';
    agent.toolCalls = [];
  }
}

export function clearAgentStreamingState(agentId: string, sessionId?: string) {
  const agent = agents.get(agentId);
  if (agent) {
    agent.content = '';
    agent.status = 'idle';
    if (sessionId) agent.sessionId = sessionId;
  }
}

export function setManagerSessionId(sessionId: string) {
  const manager = agents.get('kory-manager');
  if (manager) manager.sessionId = sessionId;
}

export function removeAgent(agentId: string) {
  if (agentId === 'kory-manager') return;
  agents.delete(agentId);
  agents = new Map(agents);
}

export function clearNonManagerAgents() {
  const manager = agents.get('kory-manager');
  agents = new Map();
  if (manager) {
    agents.set('kory-manager', { ...manager, content: '', thinking: '', toolCalls: [] });
  }
}

/** Mark all agents for this session as done (optimistic UI when user clicks Stop). */
export function markSessionAgentsStopped(sessionId: string) {
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
export function markAgentStopped(agentId: string) {
  const agent = agents.get(agentId);
  if (agent && agent.status !== 'idle' && agent.status !== 'done') {
    agent.status = 'done';
    agents = new Map(agents);
  }
}

// ─── Derived State ───────────────────────────────────────────────────────────

export function getManagerStatus(): AgentStatus {
  const activeSessionId = sessionStore.activeSessionId;
  const manager = agents.get('kory-manager');

  if (
    manager &&
    manager.status !== 'idle' &&
    manager.status !== 'done' &&
    (manager.sessionId === activeSessionId || !manager.sessionId)
  ) {
    return manager.status;
  }

  if (activeSessionId) {
    for (const a of agents.values()) {
      if (a.sessionId === activeSessionId && a.status !== 'idle' && a.status !== 'done') {
        return a.status;
      }
    }
  }

  return 'idle';
}

export function isSessionRunning(sessionId: string): boolean {
  for (const a of agents.values()) {
    if (a.sessionId === sessionId && a.status !== 'idle' && a.status !== 'done') {
      return true;
    }
  }
  return false;
}

export function getContextUsage(): {
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

// ─── API Loading ─────────────────────────────────────────────────────────────

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
      const key = getAgentThreadKey(sessionId, thread.agent.id);
      if (!agentThreadFeeds.has(key)) {
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
    const res = await apiFetch(
      apiUrl(`/api/agent/${agentId}/thread?sessionId=${encodeURIComponent(sessionId)}`),
    );
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
            : (identity?.name ?? 'Agent'),
      glowClass:
        entry.role === 'assistant'
          ? feedStore.resolveGlowClass(identity)
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

// ─── Exported Store ─────────────────────────────────────────────────────────

export const agentStore = {
  get agents() {
    return agents;
  },
  get agentList() {
    return [...agents.values()];
  },
  get agentThreadVersion() {
    return agentThreadVersion;
  },
  getManagerStatus,
  isSessionRunning,
  getContextUsage,
  spawnAgent,
  updateAgentStatus,
  appendAgentContent,
  appendAgentThinking,
  addToolCall,
  updateUsage,
  completeAgent,
  clearAgentContent,
  clearAgentStreamingState,
  setManagerSessionId,
  removeAgent,
  clearNonManagerAgents,
  markSessionAgentsStopped,
  markAgentStopped,
  getAgentThreadKey,
  setAgentThreadFeed,
  upsertAgentThreadEntry,
  accumulateAgentThreadEntry,
  getAgentFeedLabel,
  getAgentThreadEntries,
  getAgentThreadFeed,
  ensureAgentThreadFeed,
  loadAgentThreads,
  loadAgentThreadMessages,
};