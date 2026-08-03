// Agent Store — handles agent state, identity, and per-agent thread feeds
// Split from the monolithic websocket.svelte.ts for better separation of concerns

import type {
  AgentIdentity,
  AgentStatus,
  StreamUsagePayload,
  ContextBreakdown,
} from '@koryphaios/shared';
import type { FeedEntry } from '$lib/types';
import { sessionStore } from './sessions.svelte';
import { apiUrl } from '$lib/utils/api-url';
import { apiFetch, parseJsonResponse } from '$lib/api.svelte';
import { feedStore, getGroupedEntries } from './feed.svelte';
import { finalizeThinkingEntries } from '$lib/utils/feed-timeline';

// ─── Agent State ────────────────────────────────────────────────────────────

export interface AgentState {
  identity: AgentIdentity;
  status: AgentStatus;
  content: string;
  thinking: string;
  toolCalls: Array<{ id: string; name: string; status: string }>;
  task: string;
  tokensUsed: number;
  contextMax: number;
  contextKnown: boolean;
  hasUsageData: boolean;
  /** Estimated prompt composition from the backend (context-usage bar segments). */
  contextBreakdown?: ContextBreakdown;
  sessionId: string;
}

// ─── Reactive State ──────────────────────────────────────────────────────────

const initialAgents = new Map<string, AgentState>();
const initialManager = $state<AgentState>({
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
initialAgents.set('kory-manager', initialManager);

let agents = $state<Map<string, AgentState>>(initialAgents);
let agentThreadFeeds = $state<Map<string, FeedEntry[]>>(new Map());
let agentThreadVersion = $state(0);

// The manager is a single agent shared by every session, so its
// `sessionId` field flips to whichever session emitted an event last.
// Track its status per session so concurrent chats don't clobber each
// other's busy/running indicators.
let managerStatusBySession = $state<Map<string, AgentStatus>>(new Map());

// Svelte runes may only appear in a variable initializer. Keeping this
// factory at that boundary lets map values remain deeply reactive.
function createReactiveAgent(state: AgentState): AgentState {
  const agent = $state<AgentState>(state);
  return agent;
}

// Svelte 5's $state does not proxy Map contents, so adding/removing
// entries still requires reassigning the Map via commitAgents(). Agent
// values are deeply reactive, so their properties can be updated in place.
function commitAgents() {
  agents = new Map(agents);
}

function setManagerStatusForSession(sessionId: string | undefined, status: AgentStatus) {
  if (!sessionId) return;
  if (managerStatusBySession.get(sessionId) === status) return;
  const next = new Map(managerStatusBySession);
  next.set(sessionId, status);
  managerStatusBySession = next;
}

const MAX_THREAD_ENTRIES = 2000;
const MAX_THREAD_SESSIONS = 8;

// LRU bookkeeping for agentThreadFeeds: sessionId → last-touched timestamp.
// Plain (non-reactive) Map — updated on every read/write so pruneAgentThreadFeeds
// can evict the least-recently-used session's threads when the cap is exceeded.
let agentThreadSessionRecency = new Map<string, number>();

// ─── Agent Thread Helpers ───────────────────────────────────────────────────

function getAgentThreadKey(sessionId: string, agentId: string): string {
  return `${sessionId}:${agentId}`;
}

function touchAgentThreadSession(sessionId: string) {
  agentThreadSessionRecency.set(sessionId, Date.now());
}

function pruneAgentThreadFeeds() {
  while (agentThreadSessionRecency.size > MAX_THREAD_SESSIONS) {
    let lruKey: string | null = null;
    let lruTime = Infinity;
    for (const [sid, t] of agentThreadSessionRecency) {
      if (t < lruTime) {
        lruTime = t;
        lruKey = sid;
      }
    }
    if (!lruKey) break;
    agentThreadSessionRecency.delete(lruKey);
    const prefix = `${lruKey}:`;
    const next = new Map<string, FeedEntry[]>();
    for (const [k, v] of agentThreadFeeds) {
      if (!k.startsWith(prefix)) next.set(k, v);
    }
    agentThreadFeeds = next;
  }
}

function setAgentThreadFeed(sessionId: string, agentId: string, entries: FeedEntry[]) {
  const next = new Map(agentThreadFeeds);
  next.set(getAgentThreadKey(sessionId, agentId), entries);
  agentThreadFeeds = next;
  touchAgentThreadSession(sessionId);
  pruneAgentThreadFeeds();
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

/** A result supersedes its live call in the worker transcript. */
function completeAgentThreadToolCall(
  sessionId: string,
  agentId: string,
  callId: string,
  entry: Omit<FeedEntry, 'id'>,
): boolean {
  const key = getAgentThreadKey(sessionId, agentId);
  const current = agentThreadFeeds.get(key) ?? [];
  const index = current.findLastIndex(
    (candidate) =>
      candidate.type === 'tool_call' &&
      (candidate.metadata as { toolCall?: { id?: string } } | undefined)?.toolCall?.id === callId,
  );
  if (index < 0) {
    upsertAgentThreadEntry(sessionId, agentId, entry);
    return false;
  }
  const next = [...current];
  next[index] = { ...entry, id: current[index].id };
  setAgentThreadFeed(sessionId, agentId, next);
  return true;
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
    const updated: FeedEntry = {
      ...last,
      text: last.text + entry.text,
      timestamp: entry.timestamp,
    };
    if (last.type === 'thinking' && last.thinkingStartedAt) {
      updated.durationMs = entry.timestamp - last.thinkingStartedAt;
    } else if (last.type === 'thinking' && !last.thinkingStartedAt) {
      updated.thinkingStartedAt = entry.timestamp;
    }
    const next = [...current];
    next[lastIdx] = updated;
    setAgentThreadFeed(sessionId, agentId, next);
    return;
  }

  upsertAgentThreadEntry(sessionId, agentId, entry);
}

function getAgentFeedLabel(agentId: string, fallback = 'Agent'): string {
  return agents.get(agentId)?.identity.name ?? fallback;
}

function getAgentThreadEntries(sessionId: string, agentId: string): FeedEntry[] {
  const entries = agentThreadFeeds.get(getAgentThreadKey(sessionId, agentId));
  if (entries) touchAgentThreadSession(sessionId);
  return entries ?? [];
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

function finalizeAgentThreadThinking(sessionId: string, agentId: string, endedAt: number) {
  const entries = getAgentThreadEntries(sessionId, agentId);
  const next = finalizeThinkingEntries(entries, agentId, endedAt);
  if (next.some((entry, index) => entry !== entries[index])) {
    setAgentThreadFeed(sessionId, agentId, next);
  }
}

// ─── Agent Actions ──────────────────────────────────────────────────────────

export function spawnAgent(identity: AgentIdentity, task: string, sessionId: string) {
  agents.set(
    identity.id,
    createReactiveAgent({
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
    }),
  );
  agents = new Map(agents);
}

export function updateAgentStatus(agentId: string, status: AgentStatus, sessionId?: string) {
  const agent = agents.get(agentId);
  if (agent) {
    agent.status = status;
    if (sessionId) agent.sessionId = sessionId;
    if (agentId === 'kory-manager') setManagerStatusForSession(sessionId, status);
  }
}

export function appendAgentContent(agentId: string, content: string, sessionId?: string) {
  const agent = agents.get(agentId);
  if (agent) {
    agent.content += content;
    agent.status = 'streaming';
    if (sessionId) agent.sessionId = sessionId;
    if (agentId === 'kory-manager') setManagerStatusForSession(sessionId, 'streaming');
  }
}

export function appendAgentThinking(agentId: string, thinking: string, sessionId?: string) {
  const agent = agents.get(agentId);
  if (agent) {
    agent.thinking += thinking;
    if (sessionId) agent.sessionId = sessionId;
    if (agentId === 'kory-manager') setManagerStatusForSession(sessionId, 'thinking');
  }
}

export function addToolCall(agentId: string, id: string, name: string, sessionId?: string) {
  const agent = agents.get(agentId);
  if (agent) {
    agent.toolCalls.push({ id, name, status: 'running' });
    agent.status = 'tool_calling';
    if (sessionId) agent.sessionId = sessionId;
    if (agentId === 'kory-manager') setManagerStatusForSession(sessionId, 'tool_calling');
  }
}

/** Retire a completed tool from the compact worker-card activity list. */
export function completeToolCall(agentId: string, callId: string, sessionId?: string) {
  const agent = agents.get(agentId);
  if (!agent) return;
  const index = agent.toolCalls.findLastIndex((tool) => tool.id === callId);
  if (index >= 0) agent.toolCalls.splice(index, 1);
  if (sessionId) agent.sessionId = sessionId;
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
    if (payload.breakdown) agent.contextBreakdown = payload.breakdown;
    if (sessionId) agent.sessionId = sessionId;
  }
}

/** Seed the manager's usage from a persisted snapshot (session reload) so the
 *  context bar shows real data before any new turn runs. */
export function seedManagerUsage(
  sessionId: string,
  usage: {
    used: number;
    max: number;
    contextKnown: boolean;
    breakdown?: ContextBreakdown;
  },
) {
  const agent = agents.get('kory-manager');
  if (!agent) return;
  agent.tokensUsed = Math.max(0, usage.used);
  if (usage.max > 0) agent.contextMax = usage.max;
  agent.contextKnown = usage.contextKnown && usage.max > 0;
  agent.hasUsageData = true;
  if (usage.breakdown) agent.contextBreakdown = usage.breakdown;
  agent.sessionId = sessionId;
}

/** Update the manager's context window immediately when the user switches
 *  models — the bar must re-baseline right away, not on the next turn. */
export function setManagerContextWindow(sessionId: string, contextWindow?: number) {
  const agent = agents.get('kory-manager');
  if (!agent) return;
  if (agent.sessionId !== sessionId) {
    agent.sessionId = sessionId;
    agent.tokensUsed = 0;
    agent.contextBreakdown = undefined;
  }
  // Selecting a model is enough to render context metadata. A provider turn
  // is not required just to show an empty window.
  agent.hasUsageData = true;
  if (contextWindow && contextWindow > 0) {
    agent.contextMax = contextWindow;
    agent.contextKnown = true;
  } else {
    // Unknown window for the new model — show "window unknown" rather than
    // the previous model's stale max.
    agent.contextKnown = false;
    agent.contextMax = 0;
  }
}

export function completeAgent(agentId: string, sessionId?: string) {
  const agent = agents.get(agentId);
  if (agent) {
    agent.status = 'done';
    if (sessionId) agent.sessionId = sessionId;
    if (agentId === 'kory-manager') setManagerStatusForSession(sessionId, 'done');
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
    if (agentId === 'kory-manager') setManagerStatusForSession(sessionId, 'idle');
  }
}

export function setManagerSessionId(sessionId: string) {
  const manager = agents.get('kory-manager');
  if (manager && manager.sessionId !== sessionId) {
    manager.sessionId = sessionId;
  }
}

export function removeAgent(agentId: string) {
  if (agentId === 'kory-manager') return;
  agents.delete(agentId);
  agents = new Map(agents);
}

export function clearNonManagerAgents() {
  const next = new Map<string, AgentState>();
  for (const [id, a] of agents) {
    if (id === 'kory-manager') {
      next.set(id, createReactiveAgent({ ...a, content: '', thinking: '', toolCalls: [] }));
    } else if (isActiveStatus(a.status)) {
      // Keep workers that are still running — this is called on every
      // chat switch, and wiping another session's live agents would kill
      // its busy indicator and orphan its incoming stream events.
      next.set(id, a);
    }
  }
  agents = next;
}

/** Mark all agents for this session as done (optimistic UI when user clicks Stop). */
export function markSessionAgentsStopped(sessionId: string) {
  for (const a of agents.values()) {
    if (a.sessionId === sessionId && a.status !== 'idle' && a.status !== 'done') {
      a.status = 'done';
    }
  }
  setManagerStatusForSession(sessionId, 'done');
}

/** Mark a single agent as done (optimistic UI when user cancels one worker). */
export function markAgentStopped(agentId: string) {
  const agent = agents.get(agentId);
  if (agent && agent.status !== 'idle' && agent.status !== 'done') {
    agent.status = 'done';
  }
}

// ─── Derived State ───────────────────────────────────────────────────────────

function isActiveStatus(status: AgentStatus | undefined): boolean {
  // 'waiting' = parked on a background process / user input — the composer
  // shows a Waiting state instead of Stop, and sending is allowed.
  return !!status && status !== 'idle' && status !== 'done' && status !== 'waiting';
}

export function getManagerStatus(): AgentStatus {
  const activeSessionId = sessionStore.activeSessionId;
  const manager = agents.get('kory-manager');

  // Per-session record wins: it is not clobbered when another session's
  // manager event flips the shared entry's sessionId.
  const perSession = activeSessionId ? managerStatusBySession.get(activeSessionId) : undefined;
  if (isActiveStatus(perSession)) return perSession!;

  if (
    manager &&
    isActiveStatus(manager.status) &&
    (manager.sessionId === activeSessionId || !manager.sessionId)
  ) {
    return manager.status;
  }

  if (activeSessionId) {
    for (const a of agents.values()) {
      if (a.sessionId === activeSessionId && isActiveStatus(a.status)) {
        return a.status;
      }
    }
  }

  return 'idle';
}

/** True when the session's manager is parked waiting (background terminal or
 *  a question to the user) — the composer shows the Waiting button state. */
export function isSessionWaiting(sessionId: string | null | undefined): boolean {
  if (!sessionId) return false;
  const st = managerStatusBySession.get(sessionId);
  if (st === 'waiting' || st === 'waiting_user') return true;
  const manager = agents.get('kory-manager');
  return !!manager && manager.sessionId === sessionId &&
    (manager.status === 'waiting' || manager.status === 'waiting_user');
}

export function isSessionRunning(sessionId: string): boolean {
  if (isActiveStatus(managerStatusBySession.get(sessionId))) return true;
  for (const a of agents.values()) {
    if (a.sessionId === sessionId && isActiveStatus(a.status)) {
      // The shared manager entry's sessionId flips to whichever session
      // spoke last, so only trust it when the per-session record agrees
      // it isn't finished.
      if (a.identity.id === 'kory-manager' && managerStatusBySession.has(sessionId)) continue;
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
  breakdown?: ContextBreakdown;
} {
  const activeSessionId = sessionStore.activeSessionId;
  const candidates = [...agents.values()].filter(
    (a) => a.sessionId === activeSessionId && a.hasUsageData,
  );

  if (candidates.length === 0) {
    return { used: 0, max: 0, percent: 0, isReliable: false, reason: 'usage_unknown' };
  }
  // The manager owns the conversation context; workers/critics report their own
  // (separate) usage and must not blank the bar the moment they spawn.
  const manager = candidates.find(
    (a) => a.identity.role === 'manager' || a.identity.id === 'kory-manager',
  );
  if (!manager && candidates.length > 1) {
    return { used: 0, max: 0, percent: 0, isReliable: false, reason: 'multi_agent_usage' };
  }

  const agent = manager ?? candidates[0];
  if (!agent.contextKnown || agent.contextMax <= 0) {
    // Window size unknown — still report real usage so the bar never lies by
    // omission; the UI shows tokens-used with an "unknown window" treatment.
    return {
      used: Math.max(0, agent.tokensUsed),
      max: 0,
      percent: 0,
      isReliable: false,
      reason: 'context_unknown',
      breakdown: agent.contextBreakdown,
    };
  }

  const used = Math.max(0, agent.tokensUsed);
  const max = agent.contextMax;
  const percent = Math.min(100, Math.round((used / max) * 100));
  return { used, max, percent, isReliable: true, breakdown: agent.contextBreakdown };
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

    // Agent identities are held in a shared map (not one map per chat). A slow
    // response for the previously viewed chat must never replace the manager
    // or worker identities belonging to the chat now on screen.
    if (sessionStore.activeSessionId !== sessionId) return;

    for (const thread of data.data) {
      const existing = agents.get(thread.agent.id);
      agents.set(
        thread.agent.id,
        createReactiveAgent({
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
        }),
      );
      const key = getAgentThreadKey(sessionId, thread.agent.id);
      if (!agentThreadFeeds.has(key)) {
        setAgentThreadFeed(sessionId, thread.agent.id, []);
      }
    }
    if (data.data.length > 0) commitAgents();
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
  isSessionWaiting,
  getContextUsage,
  spawnAgent,
  updateAgentStatus,
  appendAgentContent,
  appendAgentThinking,
  addToolCall,
  completeToolCall,
  updateUsage,
  completeAgent,
  clearAgentContent,
  clearAgentStreamingState,
  setManagerSessionId,
  removeAgent,
  clearNonManagerAgents,
  markSessionAgentsStopped,
  markAgentStopped,
  seedManagerUsage,
  setManagerContextWindow,
  getAgentThreadKey,
  setAgentThreadFeed,
  upsertAgentThreadEntry,
  completeAgentThreadToolCall,
  accumulateAgentThreadEntry,
  getAgentFeedLabel,
  getAgentThreadEntries,
  getAgentThreadFeed,
  ensureAgentThreadFeed,
  finalizeAgentThreadThinking,
  loadAgentThreads,
  loadAgentThreadMessages,
};
