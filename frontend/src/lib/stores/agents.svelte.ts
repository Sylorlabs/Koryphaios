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
  /** True when tokensUsed is approximate (provider-flagged cumulative total
   *  or clamped to the window). Display clamps to contextMax regardless. */
  usageEstimated: boolean;
  /** Estimated prompt composition from the backend (context-usage bar segments). */
  contextBreakdown?: ContextBreakdown;
  /** Provider-reported cached input already included in tokensUsed. */
  cachedInputTokens?: number;
  /** Provider-reported prompt-cache writes for the latest live turn. */
  cacheWriteInputTokens?: number;
  /** Latest live turn cost estimate from backend pricing. */
  estimatedCostUsd?: number;
  /** Latest live turn savings estimate from prompt caching. */
  cacheSavingsUsd?: number;
  sessionId: string;
}

// ─── Reactive State ──────────────────────────────────────────────────────────

const initialAgents = new Map<string, AgentState>();
initialAgents.set(
  'kory-manager',
  reactiveAgent({
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
    usageEstimated: false,
    sessionId: '',
  }),
);

let agents = $state<Map<string, AgentState>>(initialAgents);

/**
 * Wrap an AgentState so it is a reactive proxy.
 *
 * A `$state` Map does not deep-proxy the plain objects stored in it, so
 * `agent.status = 'done'` was invisible to every reader: the components that
 * render a card (WorkerCard, AgentThreadFeed) are handed the object through a
 * keyed `#each`, and Svelte treats an unchanged object reference as an unchanged
 * prop, so no $derived depending on `agent.status` re-evaluated. A finished
 * worker kept its spinner and its "Stop and close" label indefinitely.
 *
 * Proxying at construction keeps the existing in-place mutation style working
 * instead of forcing every status writer to copy the record.
 */
function reactiveAgent(state: AgentState): AgentState {
  // `$state` is only legal as a declaration initializer, so it cannot be written
  // as `return $state(state)`.
  const proxied = $state(state);
  return proxied;
}
let agentThreadFeeds = $state<Map<string, FeedEntry[]>>(new Map());
let agentThreadVersion = $state(0);
let managerContextSelection: { sessionId: string; provider: string; model: string } | null = null;
// Monotonic counter bumped by every authoritative occupancy write (a real
// `stream.usage` report, a durable seed, or a selection change). A model
// preview captures the value in effect when its request was issued; applying
// the response after the counter moved means a newer measurement already
// landed, so the snapshot is stale and must not overwrite it.
let managerOccupancyRevision = 0;
let managerPreviewIssuedAtRevision = 0;

// Svelte 5's $state does not proxy Map contents or the plain objects
// stored in them — mutating an AgentState in place is invisible to the
// UI. Every mutation must go through commitAgents() to publish a new
// Map reference.
function commitAgents() {
  agents = new Map(agents);
}

const MAX_THREAD_ENTRIES = 2000;
// Same rule as the main feed: one turn is one answer, even when tool rows land
// between its text deltas. Track the row each thread's current turn is still
// filling so a tool call in the middle of a sentence cannot split the answer.
const THREAD_CONTINUATION_TYPES: ReadonlySet<FeedEntry['type']> = new Set(['content', 'thinking']);
const threadStreamTargets = new Map<
  string,
  { sessionId: string; agentId: string; entryId: string }
>();
// Threads whose turn has ended: a later delta opens a new row instead of
// continuing the finished answer.
const closedThreadTurns = new Set<string>();

// ─── Agent Thread Helpers ───────────────────────────────────────────────────

function getAgentThreadKey(sessionId: string, agentId: string): string {
  return `${sessionId}:${agentId}`;
}

function setAgentThreadFeed(sessionId: string, agentId: string, entries: FeedEntry[]) {
  agentThreadFeeds.set(getAgentThreadKey(sessionId, agentId), entries);
  agentThreadVersion++;
}

function upsertAgentThreadEntry(
  sessionId: string,
  agentId: string,
  entry: Omit<FeedEntry, 'id'>,
): FeedEntry | undefined {
  const key = getAgentThreadKey(sessionId, agentId);
  const current = agentThreadFeeds.get(key) ?? [];
  const candidate: FeedEntry = { ...entry, id: feedStore.nextFeedId('aft') };
  const nextEntry = feedStore.visibleEntriesForSession(sessionId, [candidate])[0];
  if (!nextEntry) return undefined;
  const next = [...current, nextEntry];
  if (next.length > MAX_THREAD_ENTRIES) {
    next.splice(0, next.length - MAX_THREAD_ENTRIES);
  }
  setAgentThreadFeed(sessionId, agentId, next);
  return nextEntry;
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
  const targetKey = `${key}::${entry.type}::${entry.userHidden ? 'hidden' : 'visible'}`;
  const continuesTurn = THREAD_CONTINUATION_TYPES.has(entry.type);
  const target = continuesTurn
    ? openThreadStreamTarget(current, targetKey, key, entry as FeedEntry)
    : last &&
        last.type === entry.type &&
        last.agentId === entry.agentId &&
        Boolean(last.userHidden) === Boolean(entry.userHidden)
      ? last
      : null;

  if (target) {
    target.text += entry.text;
    target.timestamp = entry.timestamp;
    if (target.type === 'thinking') {
      // Reconnected mid-turn: replayed reasoning is sealed on arrival, so a
      // live delta arriving afterwards has to re-open the block or the
      // drill-down stopwatch stops counting while the turn is still running.
      if (entry.thinkingFinalized === undefined && target.thinkingFinalized) {
        target.thinkingFinalized = false;
      }
      if (target.thinkingStartedAt) {
        target.durationMs = entry.timestamp - target.thinkingStartedAt;
      } else {
        target.thinkingStartedAt = entry.timestamp;
      }
    }
    agentThreadVersion++;
    if (continuesTurn) {
      threadStreamTargets.set(targetKey, { sessionId, agentId, entryId: target.id });
    }
    return;
  }

  const created = upsertAgentThreadEntry(sessionId, agentId, entry);
  if (created && continuesTurn) {
    closedThreadTurns.delete(key);
    threadStreamTargets.set(targetKey, { sessionId, agentId, entryId: created.id });
  }
}

/** The row this thread delta continues, or null when this turn has no open row. */
function openThreadStreamTarget(
  current: FeedEntry[],
  targetKey: string,
  threadKey: string,
  entry: FeedEntry,
): FeedEntry | null {
  if (closedThreadTurns.has(threadKey)) return null;
  const recorded = threadStreamTargets.get(targetKey);
  if (recorded) {
    const target = current.findLast((row) => row.id === recorded.entryId);
    if (target) return target;
    threadStreamTargets.delete(targetKey);
  }
  return (
    current.findLast(
      (row) =>
        row.type === entry.type &&
        row.agentId === entry.agentId &&
        Boolean(row.userHidden) === Boolean(entry.userHidden),
    ) ?? null
  );
}

/** Close the rows a thread's current turn may still append to so the next delta
 *  opens a new item. Called when an agent's turn ends. */
export function closeAgentThreadTurn(sessionId?: string, agentId?: string) {
  if (!sessionId && !agentId) {
    threadStreamTargets.clear();
    closedThreadTurns.clear();
    return;
  }
  for (const [key, target] of [...threadStreamTargets]) {
    if (sessionId && target.sessionId !== sessionId) continue;
    if (agentId && target.agentId !== agentId) continue;
    threadStreamTargets.delete(key);
  }
  if (sessionId && agentId) closedThreadTurns.add(getAgentThreadKey(sessionId, agentId));
}

/** Agent-drilldown mirror of the feed's completion flip: turn the thread's
 *  live "running" card into its completed result card in place. Returns true
 *  when a live row was completed or was already complete, so the caller can
 *  skip appending a duplicate output row. */
function completeAgentThreadEntry(
  sessionId: string,
  agentId: string,
  callId: string,
  resultText: string,
  toolResult: Record<string, unknown>,
  timestamp: number,
): boolean {
  const key = getAgentThreadKey(sessionId, agentId);
  const current = agentThreadFeeds.get(key) ?? [];
  const entry = current.findLast(
    (candidate) =>
      candidate.type === 'tool_call' &&
      (candidate.metadata as { toolCall?: { id?: string } } | undefined)?.toolCall?.id === callId,
  );
  if (entry) {
    entry.type = 'tool_result';
    entry.text = resultText;
    entry.timestamp = timestamp;
    entry.metadata = { ...entry.metadata, toolResult };
    agentThreadVersion++;
    return true;
  }
  return current.some(
    (candidate) =>
      candidate.type === 'tool_result' &&
      (candidate.metadata as { toolResult?: { callId?: string } } | undefined)?.toolResult
        ?.callId === callId,
  );
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
  agents.set(
    identity.id,
    reactiveAgent({
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
      usageEstimated: false,
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
  if (!agent) return;

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

  // The window is metadata rather than occupancy, so every event may refresh
  // it — a turn-start event is often the first to report the active model's
  // window. Identity likewise tracks the event, not the measurement.
  //
  // A NON-authoritative event must never DOWNGRADE a window we already
  // verified. The manager emits a chars/4 planning estimate at the start of
  // every turn and before every tool-loop dispatch, and `resolveTrustedContextWindow`
  // answers "unknown" whenever background provider model discovery has not
  // landed yet. Zeroing the denominator on those made the bar flip to "model
  // window not reported" for the whole turn and then snap back — the most
  // visible face of context data that randomly disappears and reappears.
  const authoritative = payload.usageKnown === true;
  if (authoritative) {
    if (typeof payload.contextWindow === 'number' && payload.contextWindow > 0) {
      agent.contextMax = payload.contextWindow;
    } else {
      agent.contextMax = 0;
    }
    agent.contextKnown = payload.contextKnown === true && agent.contextMax > 0;
  } else if (typeof payload.contextWindow === 'number' && payload.contextWindow > 0) {
    // An estimate may still *establish* a window, but never erase one.
    agent.contextMax = payload.contextWindow;
    agent.contextKnown = payload.contextKnown === true;
  }
  agent.identity.provider = payload.provider;
  agent.identity.model = payload.model;
  if (sessionId) agent.sessionId = sessionId;

  // A non-authoritative event carries no provider telemetry. The manager emits
  // one at the start of every turn and again before every tool-loop dispatch
  // (a chars/4 planning estimate, not a token count, and routinely ~10x the
  // real total). It must neither be adopted as a total nor destroy the last
  // verified one: zeroing here made the meter read "0 used" for the entire
  // agentic turn, since a real report only lands when a provider call
  // completes. Only a genuine provider report moves occupancy. Switching
  // provider/model still clears through beginManagerContextPreview, so a prior
  // provider's total can never render under a new selection.
  if (!authoritative) {
    commitAgents();
    return;
  }

  // Clamp to the window: cumulative harness totals (Codex) must never render
  // an impossible ratio like 860k / 285k.
  const rawUsed = Math.max(0, payload.tokensUsed || 0);
  const windowSize =
    typeof payload.contextWindow === 'number' && payload.contextWindow > 0
      ? payload.contextWindow
      : 0;
  agent.tokensUsed = windowSize > 0 ? Math.min(rawUsed, windowSize) : rawUsed;
  agent.usageEstimated = payload.estimated === true || (windowSize > 0 && rawUsed > windowSize);
  agent.hasUsageData = true;
  agent.contextBreakdown = payload.breakdown;
  agent.cachedInputTokens = Math.max(0, payload.cachedInputTokens ?? 0);
  agent.cacheWriteInputTokens = Math.max(0, payload.cacheWriteInputTokens ?? 0);
  agent.estimatedCostUsd = payload.estimatedCostUsd;
  agent.cacheSavingsUsd = payload.cacheSavingsUsd;
  // A real provider report supersedes any model preview still in flight.
  managerOccupancyRevision++;
  commitAgents();
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
    estimated?: boolean;
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
  const rawUsed = Math.max(0, usage.used);
  agent.tokensUsed = usage.max > 0 ? Math.min(rawUsed, usage.max) : rawUsed;
  agent.contextMax = usage.max > 0 ? usage.max : 0;
  agent.contextKnown = usage.contextKnown && usage.max > 0;
  agent.hasUsageData = true;
  agent.usageEstimated = usage.estimated === true || (usage.max > 0 && rawUsed > usage.max);
  agent.identity.provider = usage.provider;
  agent.identity.model = usage.model;
  agent.contextBreakdown = usage.breakdown;
  agent.cachedInputTokens = Math.max(0, usage.cachedInputTokens ?? 0);
  agent.cacheWriteInputTokens = undefined;
  agent.estimatedCostUsd = undefined;
  agent.cacheSavingsUsd = undefined;
  agent.sessionId = sessionId;
  // A durable seed is a real measurement, so it supersedes in-flight previews
  // for the same reason a live provider report does.
  managerOccupancyRevision++;
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
  estimated?: boolean;
  cachedInputTokens?: number;
  breakdown?: ContextBreakdown;
}

function clearManagerUsage(agent: AgentState) {
  agent.tokensUsed = 0;
  agent.hasUsageData = false;
  agent.usageEstimated = false;
  agent.contextBreakdown = undefined;
  agent.cachedInputTokens = undefined;
  agent.cacheWriteInputTokens = undefined;
  agent.estimatedCostUsd = undefined;
  agent.cacheSavingsUsd = undefined;
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
  if (selectionChanged) {
    clearManagerUsage(agent);
    managerOccupancyRevision++;
  }
  managerContextSelection = { sessionId, provider, model };
  // Responses to the request this call is about to issue are only allowed to
  // write occupancy while nothing newer has landed since.
  managerPreviewIssuedAtRevision = managerOccupancyRevision;
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
 *  usage means "awaiting provider report", never "reuse the previous total".
 *
 *  A preview is a request/response snapshot, so it can resolve AFTER a newer
 *  authoritative `stream.usage` event. Applying it then rolled the meter
 *  backwards to a stale number, or blanked it via `clearManagerUsage` when the
 *  snapshot no longer matched the (now advanced) conversation boundary. The
 *  composer already guards selection changes with a generation counter, but a
 *  delayed response for an UNCHANGED selection sailed straight through. Record
 *  the occupancy revision the request was issued against and refuse to apply
 *  anything older. */
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

  // A newer authoritative measurement landed while this request was in flight.
  // The snapshot it carries is already stale — applying it would roll the meter
  // backwards, or blank it entirely when the boundary it described has since
  // advanced. Keep the newer value.
  if (managerOccupancyRevision !== managerPreviewIssuedAtRevision) return false;

  if (usage?.contextKnown && usage.contextWindow && usage.contextWindow > 0) {
    agent.contextMax = usage.contextWindow;
    agent.contextKnown = true;
  } else {
    agent.contextMax = 0;
    agent.contextKnown = false;
  }

  if (usage?.usageKnown === true && typeof usage.used === 'number') {
    const rawUsed = Math.max(0, usage.used);
    const windowSize =
      typeof usage.contextWindow === 'number' && usage.contextWindow > 0 ? usage.contextWindow : 0;
    agent.tokensUsed = windowSize > 0 ? Math.min(rawUsed, windowSize) : rawUsed;
    agent.hasUsageData = true;
    agent.usageEstimated = usage.estimated === true || (windowSize > 0 && rawUsed > windowSize);
    agent.contextBreakdown = usage.breakdown;
    agent.cachedInputTokens = Math.max(0, usage.cachedInputTokens ?? 0);
    agent.cacheWriteInputTokens = undefined;
    agent.estimatedCostUsd = undefined;
    agent.cacheSavingsUsd = undefined;
  } else {
    clearManagerUsage(agent);
  }
  // The preview itself becomes the newest occupancy fact.
  managerOccupancyRevision++;
  managerPreviewIssuedAtRevision = managerOccupancyRevision;
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

/** Bind the manager to a session without discarding an already-correct
 *  selection. `setManagerSessionId` unconditionally clears
 *  `managerContextSelection`, which is right when a live `kory.thought` event
 *  proves ownership moved, but wrong for the session-switch handoff: the
 *  composer's preview effect and the feed activation race, and clearing the
 *  selection after the composer pinned it left every subsequent `stream.usage`
 *  failing the provenance guard until the user touched the model picker. */
export function bindManagerSession(sessionId: string) {
  const manager = agents.get('kory-manager');
  if (!manager) return;
  const changed = manager.sessionId !== sessionId;
  manager.sessionId = sessionId;
  if (!changed) return;
  // A selection that already names this exact session stays valid.
  if (managerContextSelection && managerContextSelection.sessionId !== sessionId) {
    managerContextSelection = null;
  }
  manager.contextMax = 0;
  manager.contextKnown = false;
  clearManagerUsage(manager);
  managerOccupancyRevision++;
  commitAgents();
}

export function setManagerSessionId(sessionId: string) {
  const manager = agents.get('kory-manager');
  if (manager && manager.sessionId !== sessionId) {
    managerContextSelection = null;
    manager.sessionId = sessionId;
    manager.contextMax = 0;
    manager.contextKnown = false;
    clearManagerUsage(manager);
    managerOccupancyRevision++;
    commitAgents();
  }
}

export function removeAgent(agentId: string) {
  if (agentId === 'kory-manager') return;
  const agent = agents.get(agentId);
  if (!agent) return;
  // The card is gone, so its transcript is unreachable — release the buffered
  // entries too, otherwise every close leaks a full worker thread.
  if (agent.sessionId && agentThreadFeeds.delete(getAgentThreadKey(agent.sessionId, agentId))) {
    agentThreadVersion++;
  }
  agents.delete(agentId);
  agents = new Map(agents);
}

/**
 * Drop the agent cards that are not worth carrying across a chat switch.
 *
 * Two different reasons an agent is kept:
 *
 * - Still running. Wiping another session's live agent would kill its busy
 *   indicator and orphan the stream events still arriving for it.
 * - Belonging to the session being opened. Its completed workers must survive:
 *   this runs from activateSessionFeed()/loadSessionMessages(), which race
 *   loadAgentThreads() on every switch. Keeping only live agents here meant a
 *   worker that had already finished was deleted the instant you changed chats,
 *   so it could never be reviewed or closed. That also contradicted
 *   terminalizeSessionSubAgents(), which deliberately preserves records so
 *   finished work stays inspectable.
 *
 * Finished agents of *other* sessions are still dropped; they come back from
 * the durable thread list when that session is opened, so nothing is lost and
 * the map stays bounded by the open session plus whatever is live elsewhere.
 */
export function clearNonManagerAgents(activeSessionId = sessionStore.activeSessionId) {
  const next = new Map<string, AgentState>();
  for (const [id, a] of agents) {
    if (id === 'kory-manager') {
      next.set(id, reactiveAgent({ ...a, content: '', thinking: '', toolCalls: [] }));
    } else if (isActiveStatus(a.status) || a.sessionId === activeSessionId) {
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

/** Thread-feed mirror of the feed store's finalizeThinking: freeze any live
 *  reasoning timers in per-agent thread feeds. Thread entries carry their own
 *  thinkingStartedAt/durationMs copies, so finalizing only the main feed
 *  leaves drill-down timers ticking `Date.now() - thinkingStartedAt` forever
 *  when a terminal event never arrives for that agent.
 *
 *  `endedAt` must be a server timestamp, differenced against the
 *  server-sourced `thinkingStartedAt`. Pass null when no such event exists
 *  (Stop, or a run that simply went quiet): the block then freezes at the last
 *  server timestamp observed for it instead of at the client clock, which
 *  would report the distance between the two machines' clocks as reasoning
 *  time. */
export function finalizeThreadThinking(
  sessionId?: string,
  agentId?: string,
  endedAt: number | null = null,
) {
  let changed = false;
  const prefix = sessionId ? `${sessionId}:` : null;
  for (const [key, entries] of agentThreadFeeds) {
    if (prefix && !key.startsWith(prefix)) continue;
    for (const e of entries) {
      if (e.type === 'thinking' && !e.thinkingFinalized && (!agentId || e.agentId === agentId)) {
        if (e.thinkingStartedAt !== undefined) {
          const serverEnd = endedAt ?? e.timestamp;
          e.durationMs = Math.max(e.durationMs ?? 0, serverEnd - e.thinkingStartedAt, 0);
        }
        e.thinkingFinalized = true;
        changed = true;
      }
    }
  }
  if (changed) agentThreadVersion++;
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

/** Statuses of the session's non-manager (worker) agents.
 *
 *  The manager's per-session status is owned by runStateStore, so it is
 *  reported by getManagerStatusForSession instead. Workers live here, keyed by
 *  their own sessionId — the sidebar's status filter needs both to count a
 *  session as running/failed/waiting rather than only its manager. */
export function getAgentStatusesForSession(sessionId: string | null | undefined): AgentStatus[] {
  if (!sessionId) return [];
  const statuses: AgentStatus[] = [];
  for (const a of agents.values()) {
    if (a.identity.id === 'kory-manager' || a.identity.role === 'manager') continue;
    if (a.sessionId === sessionId && a.status) statuses.push(a.status);
  }
  return statuses;
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
  estimated?: boolean;
  breakdown?: ContextBreakdown;
  cachedInputTokens?: number;
  cacheWriteInputTokens?: number;
  estimatedCostUsd?: number;
  cacheSavingsUsd?: number;
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
      cacheWriteInputTokens: agent.cacheWriteInputTokens,
      estimatedCostUsd: agent.estimatedCostUsd,
      cacheSavingsUsd: agent.cacheSavingsUsd,
      provider: agent.identity.provider,
    };
  }

  const max = agent.contextMax;
  const used = Math.max(0, Math.min(agent.tokensUsed, max));
  const percent = Math.min(100, Math.round((used / max) * 100));
  return {
    used,
    max,
    percent,
    isReliable: true,
    estimated: agent.usageEstimated,
    breakdown: agent.contextBreakdown,
    cachedInputTokens: agent.cachedInputTokens,
    cacheWriteInputTokens: agent.cacheWriteInputTokens,
    estimatedCostUsd: agent.estimatedCostUsd,
    cacheSavingsUsd: agent.cacheSavingsUsd,
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
      agents.set(
        thread.agent.id,
        reactiveAgent({
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
          usageEstimated: existing?.usageEstimated ?? false,
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
  getAgentStatusesForSession,
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
  bindManagerSession,
  removeAgent,
  clearNonManagerAgents,
  markSessionAgentsStopped,
  finalizeThreadThinking,
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
  closeAgentThreadTurn,
  completeAgentThreadEntry,
  getAgentFeedLabel,
  getAgentThreadEntries,
  getAgentThreadFeed,
  ensureAgentThreadFeed,
  loadAgentThreads,
  loadAgentThreadMessages,
  applySessionFeedVisibility,
};
