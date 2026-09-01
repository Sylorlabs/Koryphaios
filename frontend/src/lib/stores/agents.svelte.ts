// Agent Store — handles agent state, identity, and per-agent thread feeds
// Split from the monolithic websocket.svelte.ts for better separation of concerns

import type {
  AgentIdentity,
  AgentStatus,
  StreamUsagePayload,
  ContextBreakdown,
  SessionRunTerminalPhase,
} from '@koryphaios/shared';
import type { FeedEntry } from '$lib/types';
import { sessionStore } from './sessions.svelte';
import { apiUrl } from '$lib/utils/api-url';
import { apiFetch, parseJsonResponse } from '$lib/api.svelte';
import { feedStore, getGroupedEntries } from './feed.svelte';
import { runStateStore } from './run-state.svelte';
import { TERMINAL_AGENT_STATUSES } from './run-state-core';

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
  /** Estimated prompt composition from the backend (context-usage bar segments). */
  contextBreakdown?: ContextBreakdown;
  /** Provider-reported cached input already included in tokensUsed. */
  cachedInputTokens?: number;
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
let managerContextSelection: { sessionId: string; provider: string; model: string } | null = null;

// Svelte 5's $state does not proxy Map contents or the plain objects
// stored in them — mutating an AgentState in place is invisible to the
// UI. Every mutation must go through commitAgents() to publish a new
// Map reference.
function commitAgents() {
  agents = new Map(agents);
}

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
  const candidate: FeedEntry = { ...entry, id: feedStore.nextFeedId('aft') };
  const nextEntry = feedStore.visibleEntriesForSession(sessionId, [candidate])[0];
  if (!nextEntry) return;
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
  const candidate: FeedEntry = { ...entry, id: 'pending-agent-thread-entry' };
  const visible = feedStore.visibleEntriesForSession(sessionId, [candidate])[0];
  if (!visible) return;
  entry = visible;
  const lastIdx = current.length - 1;
  const last = lastIdx >= 0 ? current[lastIdx] : null;

  if (
    last &&
    last.type === entry.type &&
    last.agentId === entry.agentId &&
    Boolean(last.userHidden) === Boolean(entry.userHidden)
  ) {
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
    commitAgents();
  }
}

export function appendAgentContent(agentId: string, content: string, sessionId?: string) {
  const agent = agents.get(agentId);
  if (agent) {
    agent.content += content;
    // Terminal statuses are sticky — a late stream.delta arriving after
    // agent.status: done (reordering, replay, or a trailing provider chunk)
    // must NOT flip the WorkerCard back to "Streaming". The content is still
    // appended (harmless for the thread feed), but the status stays put.
    // Explicit re-activation goes through updateAgentStatus / spawnAgent,
    // which are not guarded.
    if (!TERMINAL_AGENT_STATUSES.has(agent.status)) {
      agent.status = 'streaming';
    }
    if (sessionId) agent.sessionId = sessionId;
    commitAgents();
  }
}

export function appendAgentThinking(agentId: string, thinking: string, sessionId?: string) {
  const agent = agents.get(agentId);
  if (agent) {
    agent.thinking += thinking;
    if (sessionId) agent.sessionId = sessionId;
    commitAgents();
  }
}

export function addToolCall(agentId: string, name: string, sessionId?: string) {
  const agent = agents.get(agentId);
  if (agent) {
    agent.toolCalls.push({ name, status: 'running' });
    // Same stickiness guard as appendAgentContent — a late stream.tool_call
    // after the agent is done must not resurrect it as "tool_calling".
    if (!TERMINAL_AGENT_STATUSES.has(agent.status)) {
      agent.status = 'tool_calling';
    }
    if (sessionId) agent.sessionId = sessionId;
    commitAgents();
  }
}

export function updateUsage(agentId: string, payload: StreamUsagePayload, sessionId?: string) {
  const agent = agents.get(agentId);
  if (agent) {
    if (agentId === 'kory-manager') {
      if (
        !managerContextSelection ||
        sessionId !== managerContextSelection.sessionId ||
        payload.provider !== managerContextSelection.provider ||
        payload.model !== managerContextSelection.model
      ) {
        // Startup replay can deliver an old usage event before the composer has
        // selected anything. Fail closed until an exact selection is pinned;
        // late events from the prior provider/model cannot take ownership.
        return;
      }
    }
    // A non-authoritative dispatch/preview update starts a fresh telemetry
    // epoch. Never merge it with the prior provider/model's exact usage: that
    // is how CLI harness overhead survived a switch to an API provider.
    agent.tokensUsed = payload.usageKnown ? Math.max(0, payload.tokensUsed || 0) : 0;
    if (typeof payload.contextWindow === 'number') {
      agent.contextMax = payload.contextWindow;
    } else if (!payload.contextKnown) {
      agent.contextMax = 0;
    }
    agent.contextKnown = !!payload.contextKnown;
    agent.hasUsageData = !!payload.usageKnown;
    agent.identity.provider = payload.provider;
    agent.identity.model = payload.model;
    agent.contextBreakdown = payload.usageKnown ? payload.breakdown : undefined;
    agent.cachedInputTokens = payload.usageKnown
      ? Math.max(0, payload.cachedInputTokens ?? 0)
      : undefined;
    if (sessionId) agent.sessionId = sessionId;
    commitAgents();
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
    provider?: string;
    model?: string;
    cachedInputTokens?: number;
    breakdown?: ContextBreakdown;
  },
): boolean {
  const agent = agents.get('kory-manager');
  if (!agent) return false;
  // Legacy snapshots have no provider/model provenance. Applying one after a
  // picker change can resurrect a CLI harness segment under an API provider,
  // so fail closed until this exact selection reports fresh usage.
  if (!usage.provider || !usage.model) return false;
  if (
    !managerContextSelection ||
    managerContextSelection.sessionId !== sessionId ||
    managerContextSelection.provider !== usage.provider ||
    managerContextSelection.model !== usage.model
  ) {
    return false;
  }
  agent.tokensUsed = Math.max(0, usage.used);
  agent.contextMax = usage.max > 0 ? usage.max : 0;
  agent.contextKnown = usage.contextKnown && usage.max > 0;
  agent.hasUsageData = true;
  agent.identity.provider = usage.provider;
  agent.identity.model = usage.model;
  agent.contextBreakdown = usage.breakdown;
  agent.cachedInputTokens = Math.max(0, usage.cachedInputTokens ?? 0);
  agent.sessionId = sessionId;
  commitAgents();
  return true;
}

export interface ManagerContextPreview {
  provider?: string;
  model?: string;
  used?: number;
  contextWindow?: number;
  contextKnown?: boolean;
  usageKnown?: boolean;
  cachedInputTokens?: number;
  breakdown?: ContextBreakdown;
}

function clearManagerUsage(agent: AgentState) {
  agent.tokensUsed = 0;
  agent.hasUsageData = false;
  agent.contextBreakdown = undefined;
  agent.cachedInputTokens = undefined;
}

/** Start a backend-owned context preview for an exact provider/model pair.
 *  A changed selection immediately drops the old pair's usage composition;
 *  only a matching backend preview or stream usage event may repopulate it. */
export function beginManagerContextPreview(
  sessionId: string,
  provider: string,
  model: string,
  contextWindow?: number,
) {
  const agent = agents.get('kory-manager');
  if (!agent) return;
  const selectionChanged =
    agent.sessionId !== sessionId ||
    agent.identity.provider !== provider ||
    agent.identity.model !== model;
  if (selectionChanged) clearManagerUsage(agent);
  managerContextSelection = { sessionId, provider, model };
  agent.sessionId = sessionId;
  agent.identity.provider = provider;
  agent.identity.model = model;
  if (contextWindow && contextWindow > 0) {
    agent.contextMax = contextWindow;
    agent.contextKnown = true;
  } else {
    agent.contextMax = 0;
    agent.contextKnown = false;
  }
  commitAgents();
}

/** Apply a model-preview response only while its provider/model is still the
 *  active selection. Preview data replaces state wholesale; absent or unknown
 *  usage means "awaiting provider report", never "reuse the previous total". */
export function applyManagerContextPreview(
  sessionId: string,
  provider: string,
  model: string,
  usage: ManagerContextPreview | undefined,
): boolean {
  const agent = agents.get('kory-manager');
  if (
    !agent ||
    agent.sessionId !== sessionId ||
    agent.identity.provider !== provider ||
    agent.identity.model !== model ||
    (usage?.provider !== undefined && usage.provider !== provider) ||
    (usage?.model !== undefined && usage.model !== model)
  ) {
    return false;
  }

  if (usage?.contextKnown && usage.contextWindow && usage.contextWindow > 0) {
    agent.contextMax = usage.contextWindow;
    agent.contextKnown = true;
  } else {
    agent.contextMax = 0;
    agent.contextKnown = false;
  }

  if (usage?.usageKnown === true && typeof usage.used === 'number') {
    agent.tokensUsed = Math.max(0, usage.used);
    agent.hasUsageData = true;
    agent.contextBreakdown = usage.breakdown;
    agent.cachedInputTokens = Math.max(0, usage.cachedInputTokens ?? 0);
  } else {
    clearManagerUsage(agent);
  }
  commitAgents();
  return true;
}

export function clearManagerContextPreview(sessionId: string) {
  const agent = agents.get('kory-manager');
  if (!agent) return;
  managerContextSelection = null;
  agent.sessionId = sessionId;
  agent.contextMax = 0;
  agent.contextKnown = false;
  clearManagerUsage(agent);
  commitAgents();
}

/** Legacy window-only update. New model selections should use
 *  beginManagerContextPreview so provider/model provenance is retained. */
export function setManagerContextWindow(sessionId: string, contextWindow?: number) {
  const agent = agents.get('kory-manager');
  if (!agent) return;
  if (agent.sessionId !== sessionId) {
    agent.sessionId = sessionId;
    clearManagerUsage(agent);
  }
  if (contextWindow && contextWindow > 0) {
    agent.contextMax = contextWindow;
    agent.contextKnown = true;
  } else {
    // Unknown window for the new model — show "window unknown" rather than
    // the previous model's stale max.
    agent.contextKnown = false;
    agent.contextMax = 0;
  }
  commitAgents();
}

export function completeAgent(agentId: string, sessionId?: string) {
  const agent = agents.get(agentId);
  if (agent) {
    agent.status = 'done';
    if (sessionId) agent.sessionId = sessionId;
    commitAgents();
  }
}

export function clearAgentContent(agentId: string) {
  const agent = agents.get(agentId);
  if (agent) {
    agent.content = '';
    agent.thinking = '';
    agent.toolCalls = [];
    commitAgents();
  }
}

export function clearAgentStreamingState(agentId: string, sessionId?: string) {
  const agent = agents.get(agentId);
  if (agent) {
    agent.content = '';
    agent.status = 'idle';
    if (sessionId) agent.sessionId = sessionId;
    commitAgents();
  }
}

export function setManagerSessionId(sessionId: string) {
  const manager = agents.get('kory-manager');
  if (manager && manager.sessionId !== sessionId) {
    managerContextSelection = null;
    manager.sessionId = sessionId;
    manager.contextMax = 0;
    manager.contextKnown = false;
    clearManagerUsage(manager);
    commitAgents();
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
      next.set(id, { ...a, content: '', thinking: '', toolCalls: [] });
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
  let changed = false;
  for (const a of agents.values()) {
    if (a.sessionId === sessionId && a.status !== 'idle' && a.status !== 'done') {
      a.status = 'done';
      changed = true;
    }
  }
  if (changed) commitAgents();
}

/**
 * Resolve non-manager cards left visually active after an authoritative
 * terminal SessionRun projection. The run aggregate is the only source that
 * may make this call; keeping the agent records (and their thread/output)
 * lets users still inspect completed work while removing a false spinner.
 */
export function terminalizeSessionSubAgents(
  sessionId: string,
  terminalPhase: SessionRunTerminalPhase,
): number {
  if (!sessionId) return 0;
  // A cancellation is terminal but not a worker execution failure. Failed
  // and restart-interrupted runs use error so the card remains truthful.
  const terminalStatus: AgentStatus = terminalPhase === 'error' ? 'error' : 'done';
  let changed = 0;
  for (const [agentId, agent] of agents) {
    if (
      agentId === 'kory-manager' ||
      agent.identity.role === 'manager' ||
      agent.sessionId !== sessionId ||
      TERMINAL_AGENT_STATUSES.has(agent.status)
    ) {
      continue;
    }
    agent.status = terminalStatus;
    changed++;
  }
  if (changed) commitAgents();
  return changed;
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

function isActiveStatus(status: AgentStatus | undefined): boolean {
  // 'waiting' = parked on a background process / user input — the composer
  // shows a Waiting state instead of Stop, and sending is allowed.
  return !!status && status !== 'idle' && status !== 'done' && status !== 'waiting';
}

export function getManagerStatus(): AgentStatus {
  // Per-session status tracking is now owned by runStateStore. The shared
  // manager entry's sessionId flips across chats, so we can't trust it.
  return runStateStore.getAgentStatusForSession(sessionStore.activeSessionId);
}

/** Returns the manager status for a specific session (not just the active
 *  one). Used by the sidebar to show reasoning/thinking indicators on all
 *  sessions, not just the currently selected one. */
export function getManagerStatusForSession(sessionId: string | null | undefined): AgentStatus {
  return runStateStore.getAgentStatusForSession(sessionId);
}

/** True when the session's manager is parked waiting (background terminal or
 *  a question to the user) — the composer shows the Waiting button state. */
export function isSessionWaiting(sessionId: string | null | undefined): boolean {
  return runStateStore.isWaiting(sessionId);
}

export function isSessionRunning(sessionId: string): boolean {
  return runStateStore.isRunning(sessionId);
}

export function getContextUsage(): {
  used: number;
  max: number;
  percent: number;
  isReliable: boolean;
  reason?: string;
  breakdown?: ContextBreakdown;
  cachedInputTokens?: number;
  provider?: string;
} {
  const activeSessionId = sessionStore.activeSessionId;
  const sessionAgents = [...agents.values()].filter((a) => a.sessionId === activeSessionId);
  const sessionManager = sessionAgents.find(
    (a) => a.identity.role === 'manager' || a.identity.id === 'kory-manager',
  );

  if (!sessionManager?.hasUsageData) {
    return {
      used: 0,
      max: sessionManager?.contextKnown ? Math.max(0, sessionManager.contextMax) : 0,
      percent: 0,
      isReliable: false,
      reason: 'usage_unknown',
      provider: sessionManager?.identity.provider,
    };
  }
  // The bar is the manager conversation's context window. A worker or critic
  // has a separate provider call and must never take over merely because it is
  // the only agent with usage while the selected manager awaits a fresh report.
  const agent = sessionManager;
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
      cachedInputTokens: agent.cachedInputTokens,
      provider: agent.identity.provider,
    };
  }

  const used = Math.max(0, agent.tokensUsed);
  const max = agent.contextMax;
  const percent = Math.min(100, Math.round((used / max) * 100));
  return {
    used,
    max,
    percent,
    isReliable: true,
    breakdown: agent.contextBreakdown,
    cachedInputTokens: agent.cachedInputTokens,
    provider: agent.identity.provider,
  };
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
    if (data.data.length > 0) commitAgents();
  } catch (error) {
    if (import.meta.env.DEV) console.warn('Failed to load agent threads', error);
  }
}

async function loadAgentThreadMessages(sessionId: string, agentId: string): Promise<void> {
  if (!sessionId || !agentId) return;
  try {
    await feedStore.loadFeedPersistence(sessionId);
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
      metadata: {
        sessionId,
        sourceAgentId: agentId,
        threadRole: entry.role,
        threadEntryId: entry.id,
      },
    }));
    setAgentThreadFeed(sessionId, agentId, feedStore.visibleEntriesForSession(sessionId, entries));
  } catch (error) {
    if (import.meta.env.DEV) console.warn('Failed to load agent thread messages', error);
  }
}

/** Reapply durable view tombstones after a thread action changes visibility. */
function applySessionFeedVisibility(sessionId: string): void {
  const prefix = `${sessionId}:`;
  let changed = false;
  for (const [key, entries] of agentThreadFeeds) {
    if (!key.startsWith(prefix)) continue;
    agentThreadFeeds.set(key, feedStore.visibleEntriesForSession(sessionId, entries));
    changed = true;
  }
  if (changed) agentThreadVersion++;
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
  getManagerStatusForSession,
  isSessionRunning,
  isSessionWaiting,
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
  terminalizeSessionSubAgents,
  markAgentStopped,
  seedManagerUsage,
  beginManagerContextPreview,
  applyManagerContextPreview,
  clearManagerContextPreview,
  setManagerContextWindow,
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
  applySessionFeedVisibility,
};
