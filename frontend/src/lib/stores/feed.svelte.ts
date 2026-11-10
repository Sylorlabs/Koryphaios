// Feed Store — handles feed entries and message display
// Split from the monolithic websocket.svelte.ts for better separation of concerns

import type { AgentIdentity, RunRevisionRef } from '@koryphaios/shared';
import type { CompactionProgressPayload, ContextBreakdown } from '@koryphaios/shared';
import type { FeedEntry, FeedEntryType } from '$lib/types';
import { sessionStore } from './sessions.svelte';
import { onSessionRemoved, onSessionsRemoved } from './session-removal';
import { apiUrl } from '$lib/utils/api-url';
import { apiFetch, parseJsonResponse } from '$lib/api.svelte';
import { normalizeToolName, toolPresentation } from '$lib/utils/tool-presentation';
import { setSessionMcpToolRegistry, type McpToolServerIdentity } from './mcp-tool-registry.svelte';
import {
  mergeFeedTimeline,
  omitArchivedToolDuplicates,
  operationalEntriesForReload,
  withoutAnalyzingThoughts,
} from '$lib/utils/feed-timeline';
import {
  chooseVariantRepresentative,
  type DisplayMessage,
  type MessageDisplayBoundary,
} from '$lib/utils/message-variants';
import {
  applyFeedVisibility,
  feedTargetKeysForEntry,
  makeClientFeedEntryId,
  type FeedTombstoneVisibility,
  type FeedVisibilityRecord,
} from '$lib/utils/feed-visibility';

export type { FeedEntry, FeedEntryType };

// ─── Constants ──────────────────────────────────────────────────────────────

// Routine inspection is useful while an agent works, but it is not a separate
// conversation item. Keep it in one collapsed "Explored codebase" group.
const EPHEMERAL_TOOLS = new Set([
  'ls',
  'list_directory',
  'read_file',
  'read',
  'view_file',
  'grep',
  'grep_search',
  'glob',
  'glob_search',
  'find',
  'codebase_search',
]);
const MAX_FEED_ENTRIES = 2000;
const MAX_FEED_VISIBILITY_TARGETS_PER_REQUEST = 256;
let feedIdCounter = 0;

// ─── Reactive State ──────────────────────────────────────────────────────────

let feed = $state<FeedEntry[]>([]);
let feedSessionId = $state('');
let loadingSessionId = $state('');
// Ownership token for the chat loading surface. The transcript is revealed
// only once the archived tool rows have joined the text history, so a
// superseded load must never clear a newer load's spinner, and a load that
// fails or is aborted must never leave one spinning forever.
let sessionLoadToken = 0;
// Enrichment is part of the initial layout (tool rows change the transcript's
// height). Give it a bounded wait rather than apiFetch's 30s default: a slow
// or wedged enrichment lane must not hold the whole chat behind a spinner.
const ENRICHMENT_TIMEOUT_MS = 3_000;
const ENRICHMENT_TIMED_OUT = Symbol('enrichment-timed-out');
// Bumped when the reader sends a message. The transcript uses it to make sure
// the appended row and the turn it starts never move a reader who is parked
// above the bottom: sending is their own action, so it must not re-anchor the
// viewport the way new agent output does.
let userSendRevision = $state(0);
let feedTransitionGeneration = 0;
let sessionRemovalGeneration = 0;
// History and live events can be causally interleaved after a reload. Track
// the committed snapshot by id rather than an array offset: an offset assumes
// history always precedes live rows and loses that property once canonical
// sequence ordering correctly places reasoning before a persisted answer.
let feedTransitionBaseIds = new Set<string>();
const sessionFeedCache = new Map<string, FeedEntry[]>();
const sessionMessageHistory = new Map<string, DisplayMessage[]>();
const olderMessagesBySession = new Map<string, boolean>();
const oldestMessageCursorBySession = new Map<string, string | null>();
let loadingOlderSessionId = $state('');

// ── Turn-scoped row continuation ───────────────────────────────────────────
// Answer text can continue across tool activity, so continuation deltas resolve
// the row they continue by identity rather than by "whatever happens to be
// last". Reasoning is deliberately different: a reasoning burst after a tool
// gets a new row so the transcript preserves the event order. agents.svelte.ts
// holds the drilldown mirror of this logic.
const FEED_CONTINUATION_TYPES: ReadonlySet<FeedEntry['type']> = new Set(['content', 'thinking']);
/** The row a given (session, agent, type, visibility) delta continues. */
const feedStreamTargets = new Map<
  string,
  { sessionId: string; agentId: string; entryId: string }
>();
/** Turns that have ended: a later delta opens a new row instead of continuing
 *  a finished answer. Keyed by turn (session + agent). */
const closedFeedTurns = new Set<string>();

function feedTurnKey(sessionId: string, agentId: string): string {
  return `${sessionId}::${agentId}`;
}
function feedTargetKey(
  sessionId: string,
  agentId: string,
  type: FeedEntry['type'],
  userHidden: boolean,
): string {
  return `${sessionId}::${agentId}::${type}::${userHidden ? 'hidden' : 'visible'}`;
}

/** The row this delta continues within its session lane, or null when the turn
 *  has no open row (new turn, ended turn, or a user message started a new one). */
function openFeedStreamTarget(
  entries: FeedEntry[],
  targetKey: string,
  turnKey: string,
  entry: FeedEntry,
): FeedEntry | null {
  if (closedFeedTurns.has(turnKey)) return null;
  const lastIdx = entries.length - 1;
  // Reasoning is a distinct transcript event. A provider may emit another
  // reasoning burst after a tool call or response, and that burst must render
  // after the tool rather than being appended to the first reasoning block.
  // Content is intentionally allowed to continue across tool activity below;
  // reasoning is not.
  if (entry.type === 'thinking') {
    const latest = entries[lastIdx];
    if (
      !latest ||
      latest.type !== 'thinking' ||
      latest.agentId !== entry.agentId ||
      Boolean(latest.userHidden) !== Boolean(entry.userHidden)
    ) {
      return null;
    }
  }
  // A user message is a hard row boundary: it starts a new turn, so nothing
  // before it may be continued.
  const boundary = entries.findLastIndex((row) => row.type === 'user_message');
  const floor = boundary + 1;

  const recorded = feedStreamTargets.get(targetKey);
  if (recorded) {
    const at = entries.findIndex((row) => row.id === recorded.entryId);
    if (at >= floor && at >= 0) return entries[at];
    // Superseded by a new turn (or evicted) — stop honouring it.
    feedStreamTargets.delete(targetKey);
  }
  for (let i = lastIdx; i >= floor; i--) {
    const row = entries[i];
    if (row.type === entry.type && row.agentId === entry.agentId) {
      return Boolean(row.userHidden) === Boolean(entry.userHidden) ? row : null;
    }
  }
  return null;
}

type DurableClientFeedEntry = { id: string; kind: 'client_error'; text: string; timestamp: number };
type SessionFeedPersistence = {
  entries: DurableClientFeedEntry[];
  tombstones: FeedVisibilityRecord[];
  loaded: boolean;
};
const sessionFeedPersistence = new Map<string, SessionFeedPersistence>();
const feedPersistenceLoads = new Map<string, Promise<SessionFeedPersistence | null>>();
// Message IDs deleted client-side but possibly still present in an in-flight
// fetch response. loadSessionMessages filters these out so a reload that was
// already underway when the user deleted a message can't bring it back.
// The backend deletion is permanent, so this only guards the race window.
const deletedMessageIds = new Set<string>();

// Cache for grouped feed — rebuild only on structural changes, not per token
let lastGroupedFeed = $state<FeedEntry[]>([]);
let feedVersion = $state(0);
let streamingRevision = $state(0);

// Track analyzing thought index to avoid O(N) filtering
let analyzingThoughtId = $state<string | null>(null);
// A thought can arrive as one buffered provider event. Keep the server time at
// which the agent entered its thinking state so that case still has an honest
// elapsed duration instead of being displayed as 0.0s.
const activeThinkingStartedAt = new Map<string, number>();

function rebuildGroupedFeedCache(): void {
  lastGroupedFeed = getGroupedEntries(feed);
}

/** Normalize message text for dedup comparisons. Collapses whitespace so a
 *  streamed turn and its persisted counterpart match even when the provider
 *  emits deltas with slightly different spacing. */
function normalizeFeedText(text: string): string {
  return (text ?? '').trim().replace(/\s+/g, ' ');
}

function cloneEntries(entries: FeedEntry[]): FeedEntry[] {
  return entries.map((entry) => ({
    ...entry,
    metadata: entry.metadata ? { ...entry.metadata } : entry.metadata,
    entries: entry.entries ? cloneEntries(entry.entries) : entry.entries,
  }));
}

function persistenceForSession(sessionId: string): SessionFeedPersistence {
  return (
    sessionFeedPersistence.get(sessionId) ?? {
      entries: [],
      tombstones: [],
      loaded: false,
    }
  );
}

function visibleEntriesForSession(sessionId: string, entries: readonly FeedEntry[]): FeedEntry[] {
  const persistence = persistenceForSession(sessionId);
  return applyFeedVisibility(entries, persistence.tombstones);
}

function entrySessionId(entry: FeedEntry): string {
  const direct = entry.metadata?.sessionId;
  if (typeof direct === 'string' && direct) return direct;
  for (const child of entry.entries ?? []) {
    const childSessionId = entrySessionId(child);
    if (childSessionId) return childSessionId;
  }
  return feedSessionId;
}

function applyDurableVisibilityToSession(sessionId: string): void {
  if (!sessionId) return;
  let changed = false;
  if (feedSessionId === sessionId) {
    feed = visibleEntriesForSession(sessionId, feed);
    changed = true;
  }
  const cached = sessionFeedCache.get(sessionId);
  if (cached) {
    sessionFeedCache.set(sessionId, cloneEntries(visibleEntriesForSession(sessionId, cached)));
  } else if (feedSessionId === sessionId) {
    sessionFeedCache.set(sessionId, cloneEntries(feed));
  }
  if (changed) {
    feedVersion++;
    rebuildGroupedFeedCache();
  }
}

function decorateEntryForSession(sessionId: string, entry: FeedEntry): FeedEntry | null {
  return visibleEntriesForSession(sessionId, [entry])[0] ?? null;
}

function persistedClientErrorEntries(sessionId: string): FeedEntry[] {
  return persistenceForSession(sessionId).entries.map((entry) => ({
    id: `client-${entry.id}`,
    timestamp: entry.timestamp,
    type: 'error' as const,
    agentId: 'kory-manager',
    agentName: 'Kory',
    glowClass: '',
    text: entry.text,
    metadata: {
      sessionId,
      source: 'client',
      clientEntryId: entry.id,
      persistedClientError: true,
    },
  }));
}

async function loadFeedPersistence(
  sessionId: string,
  signal?: AbortSignal,
): Promise<SessionFeedPersistence | null> {
  if (!sessionId) return null;
  const existing = persistenceForSession(sessionId);
  if (existing.loaded) return existing;
  const inFlight = feedPersistenceLoads.get(sessionId);
  if (inFlight) return inFlight;
  const removalGeneration = sessionRemovalGeneration;
  const request = apiFetch(apiUrl(`/api/sessions/${sessionId}/feed`), { signal })
    .then(async (response) => {
      const result = await parseJsonResponse<{
        ok?: boolean;
        data?: {
          entries?: DurableClientFeedEntry[];
          tombstones?: FeedVisibilityRecord[];
        };
      }>(response);
      if (!response.ok || result.ok !== true) return null;
      if (
        sessionRemovalGeneration !== removalGeneration ||
        feedPersistenceLoads.get(sessionId) !== request
      ) {
        return null;
      }
      const prior = persistenceForSession(sessionId);
      const entries = new Map<string, DurableClientFeedEntry>();
      for (const entry of result.data?.entries ?? []) {
        if (
          entry?.kind === 'client_error' &&
          typeof entry.id === 'string' &&
          typeof entry.text === 'string' &&
          Number.isSafeInteger(entry.timestamp)
        ) {
          entries.set(entry.id, entry);
        }
      }
      // Preserve a just-created local row while its write races this snapshot.
      for (const entry of prior.entries) entries.set(entry.id, entry);
      const tombstones = new Map<string, FeedTombstoneVisibility>();
      for (const record of result.data?.tombstones ?? []) {
        if (
          typeof record?.targetKey === 'string' &&
          (record.visibility === 'hidden' || record.visibility === 'deleted')
        ) {
          tombstones.set(record.targetKey, record.visibility);
        }
      }
      for (const record of prior.tombstones) tombstones.set(record.targetKey, record.visibility);
      const state: SessionFeedPersistence = {
        entries: [...entries.values()],
        tombstones: [...tombstones.entries()].map(([targetKey, visibility]) => ({
          targetKey,
          visibility,
        })),
        loaded: true,
      };
      sessionFeedPersistence.set(sessionId, state);
      applyDurableVisibilityToSession(sessionId);
      return state;
    })
    .catch(() => null)
    .finally(() => {
      if (feedPersistenceLoads.get(sessionId) === request) feedPersistenceLoads.delete(sessionId);
    });
  feedPersistenceLoads.set(sessionId, request);
  return request;
}

/**
 * Atomically move the visible feed to another session. The old feed is saved
 * under its owner and the target's last complete snapshot is restored
 * immediately, so rapid switching never shows another chat. The visible feed
 * stays behind the loading state until the target's fresh history has landed.
 */
function activateSessionFeed(sessionId: string): number {
  if (feedSessionId === sessionId) return feedTransitionGeneration;
  const previousSessionId = feedSessionId;
  if (feedSessionId) {
    // A reasoning block still running in the chat the reader is leaving must be
    // sealed, or reopening it shows a stopwatch climbing from a start timestamp
    // whose origin the reader can no longer see.
    sealThinkingInLane(feed, undefined, 0, false);
    sessionFeedCache.set(feedSessionId, cloneEntries(feed));
  }
  feedTransitionGeneration++;
  feedSessionId = sessionId;
  feed = sessionId ? cloneEntries(sessionFeedCache.get(sessionId) ?? []) : [];
  // A cached snapshot is useful as the next render's data, but it is not the
  // authoritative restore. Keep it behind the loading state while the current
  // history request reconciles it, rather than exposing VirtualList's estimated
  // layout and making the transcript visibly scroll into place.
  beginSessionLoad(sessionId);
  // Message history is a rehydratable duplicate of the feed cache. Keep it
  // only for the session being opened so switching through many large chats
  // cannot retain a second full copy of every transcript indefinitely.
  if (previousSessionId) {
    sessionMessageHistory.delete(previousSessionId);
    olderMessagesBySession.delete(previousSessionId);
    oldestMessageCursorBySession.delete(previousSessionId);
  }
  feedTransitionBaseIds = new Set(feed.map((entry) => entry.id));
  streamingRevision = 0;
  analyzingThoughtId = null;
  activeThinkingStartedAt.clear();
  deletedMessageIds.clear();
  feedVersion++;
  rebuildGroupedFeedCache();
  return feedTransitionGeneration;
}

/** Start owning the loading surface for a session that is being opened. */
function beginSessionLoad(sessionId: string): void {
  sessionLoadToken++;
  loadingSessionId = sessionId;
}

/** Release it only if this load still owns it. */
function endSessionLoad(token: number, sessionId: string): void {
  if (token !== sessionLoadToken) return;
  if (ownsFeed(sessionId) && loadingSessionId === sessionId) loadingSessionId = '';
}

function finishSessionLoad(sessionId: string, generation?: number): void {
  if (ownsFeed(sessionId, generation) && loadingSessionId === sessionId) {
    loadingSessionId = '';
  }
  // A load that lost its scope must not release a newer load's spinner.
  sessionLoadToken++;
}

function ownsFeed(sessionId: string, generation?: number): boolean {
  return (
    !!sessionId &&
    feedSessionId === sessionId &&
    sessionStore.activeSessionId === sessionId &&
    (generation === undefined || generation === feedTransitionGeneration)
  );
}

/** Read the tail from the same session lane that addFeedEntryForSession writes. */
function lastEntryForSession(sessionId: string): FeedEntry | undefined {
  return ownsFeed(sessionId) ? feed.at(-1) : sessionFeedCache.get(sessionId)?.at(-1);
}

/**
 * Newest tool row of the current turn for a session, so surfaces outside the
 * transcript (the sidebar) can render the same ToolActivityIcon the chat shows.
 * Scanning stops at the user's message so a previous turn never leaks in.
 */
function latestToolEntryForSession(sessionId: string): FeedEntry | undefined {
  void feedVersion;
  const lane = laneEntries(sessionId);
  if (!lane) return undefined;
  for (let i = lane.length - 1; i >= 0; i--) {
    const entry = lane[i];
    if (entry.type === 'user_message') return undefined;
    if (entry.type === 'tool_call' || entry.type === 'tool_result' || entry.type === 'tool_group') return entry;
  }
  return undefined;
}

function patchGroupedFeedEntry(
  entryId: string,
  text: string,
  timestamp: number,
  extra?: Partial<FeedEntry>,
): void {
  for (let i = lastGroupedFeed.length - 1; i >= 0; i--) {
    const grouped = lastGroupedFeed[i];
    if (grouped.id === entryId) {
      grouped.text = text;
      grouped.timestamp = timestamp;
      if (extra) Object.assign(grouped, extra);
      return;
    }
    if (grouped.entries?.length) {
      const sub = grouped.entries[grouped.entries.length - 1];
      if (sub?.id === entryId) {
        sub.text = text;
        sub.timestamp = timestamp;
        if (extra) Object.assign(sub, extra);
        return;
      }
    }
  }
}

// Structural changes bump feedVersion; streaming text bumps streamingRevision only
let groupedFeed = $derived.by(() => {
  const _structure = feedVersion;
  const _stream = streamingRevision;
  void _structure;
  void _stream;
  return lastGroupedFeed;
});

// ─── Glow Class Resolver ────────────────────────────────────────────────────

/** Reverse of resolveGlowClass, for entries that only carry a glow class. */
function glowToDomain(glow: string): string {
  switch (glow) {
    case 'glow-codex':
      return 'frontend';
    case 'glow-google':
      return 'backend';
    case 'glow-test':
      return 'test';
    case 'glow-claude':
      return 'general';
    default:
      return 'general';
  }
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

function nextFeedId(prefix: string): string {
  return `${prefix}-${++feedIdCounter}`;
}

// ─── Feed Actions ────────────────────────────────────────────────────────────

function addFeedEntry(entry: Omit<FeedEntry, 'id'>): FeedEntry | undefined {
  const sessionId = entrySessionId(entry as FeedEntry);
  const visible = decorateEntryForSession(sessionId, { ...entry, id: 'pending-feed-entry' });
  if (!visible) return;
  const newEntry: FeedEntry = { ...visible, id: nextFeedId('fe') };
  // A tool, response, status marker, or any other non-reasoning event closes
  // the current reasoning segment. The next thinking delta therefore gets a
  // new row at its actual position in the event stream.
  if (newEntry.type !== 'thinking') {
    feedStreamTargets.delete(feedTargetKey(sessionId, newEntry.agentId, 'thinking', false));
    feedStreamTargets.delete(feedTargetKey(sessionId, newEntry.agentId, 'thinking', true));
  }
  if (
    newEntry.type === 'thought' &&
    ((newEntry.metadata as { phase?: string })?.phase === 'analyzing' ||
      newEntry.text === 'Preparing provider request...')
  ) {
    analyzingThoughtId = newEntry.id;
  }
  feed.push(newEntry);
  if (feed.length > MAX_FEED_ENTRIES) feed.splice(0, feed.length - MAX_FEED_ENTRIES);
  feedVersion++;
  rebuildGroupedFeedCache();
  return newEntry;
}

/**
 * Preserve a durable event even when its session is running in the background.
 * The realtime ingress cursor is per session and therefore advances for
 * background subscriptions too; dropping the row here would make it
 * impossible to recover when the user later opens that session without
 * reconnecting the socket.
 */
function addFeedEntryForSession(sessionId: string, entry: Omit<FeedEntry, 'id'>): void {
  const visible = decorateEntryForSession(sessionId, { ...entry, id: 'pending-feed-entry' });
  if (!visible) return;
  if (ownsFeed(sessionId)) {
    addFeedEntry(visible);
    return;
  }

  const cached = cloneEntries(sessionFeedCache.get(sessionId) ?? []);
  const epoch = visible.metadata?.eventEpoch;
  const sequence = visible.metadata?.sequenceStart;
  const last = cached.at(-1);
  const lastEpoch = last?.metadata?.eventEpoch;
  const lastSequence = last?.metadata?.sequenceEnd ?? last?.metadata?.sequenceStart;
  const duplicateErrorPair =
    visible.type === 'error' &&
    last?.type === 'error' &&
    last.text === visible.text &&
    ((visible.timestamp - last.timestamp >= 0 && visible.timestamp - last.timestamp < 3_000) ||
      (Number.isSafeInteger(epoch) &&
        Number.isSafeInteger(sequence) &&
        lastEpoch === epoch &&
        Number(lastSequence) + 1 === Number(sequence)));
  if (duplicateErrorPair) return;
  const alreadyCached = cached.some(
    (candidate) =>
      Number.isSafeInteger(epoch) &&
      Number.isSafeInteger(sequence) &&
      candidate.metadata?.eventEpoch === epoch &&
      candidate.metadata?.sequenceStart === sequence,
  );
  if (alreadyCached) return;

  cached.push({ ...visible, id: nextFeedId('fe') });
  if (cached.length > MAX_FEED_ENTRIES) cached.splice(0, cached.length - MAX_FEED_ENTRIES);
  sessionFeedCache.set(sessionId, cached);
}

function accumulateFeedEntry(entry: Omit<FeedEntry, 'id'>) {
  const sessionId = entrySessionId(entry as FeedEntry);
  const visible = decorateEntryForSession(sessionId, { ...entry, id: 'pending-feed-entry' });
  if (!visible) return;
  entry = visible;
  const lastIdx = feed.length - 1;
  const last = lastIdx >= 0 ? feed[lastIdx] : null;
  const continuesTurn = FEED_CONTINUATION_TYPES.has(entry.type);
  const turnKey = feedTurnKey(sessionId, entry.agentId);
  const targetKey = feedTargetKey(sessionId, entry.agentId, entry.type, Boolean(entry.userHidden));
  // A continuation delta resolves the row it continues by identity, not by
  // "whatever is last": a tool call or another agent's row landing mid-sentence
  // must not split this turn's text or reasoning into two rows.
  const target = continuesTurn
    ? openFeedStreamTarget(feed, targetKey, turnKey, entry as FeedEntry)
    : last &&
        last.type === entry.type &&
        last.agentId === entry.agentId &&
        Boolean(last.userHidden) === Boolean(entry.userHidden)
      ? last
      : null;

  if (target) {
    const updates: Partial<FeedEntry> = {
      // Replayed reasoning updates can carry the complete current block rather
      // than a token delta. Do not duplicate the block when the server repeats
      // the same text while advancing its timestamp/duration.
      text:
        target.type === 'thinking' && target.text === entry.text
          ? target.text
          : target.text + entry.text,
      timestamp: entry.timestamp,
      userHidden: entry.userHidden,
    };

    if (target.type === 'thinking') {
      // Reconnected mid-turn: replayed reasoning is sealed on arrival, so a live
      // delta arriving afterwards has to re-open the block or the stopwatch
      // stops counting while the turn is still running.
      if (entry.thinkingFinalized === undefined && target.thinkingFinalized) {
        updates.thinkingFinalized = false;
      }
      if (target.thinkingStartedAt) {
        updates.durationMs = entry.timestamp - target.thinkingStartedAt;
      } else {
        updates.thinkingStartedAt = entry.timestamp;
      }
    }
    // Redacted-thinking progress (token estimates) rides in metadata and must
    // keep updating as new deltas land - monotonically (provider estimates can
    // arrive out of order; the display must never count down).
    if (entry.metadata && Object.keys(entry.metadata).length > 0) {
      const merged = { ...target.metadata, ...entry.metadata } as Record<string, unknown>;
      const prevTok =
        (target.metadata as { thinkingTokens?: number } | undefined)?.thinkingTokens ?? 0;
      const nextTok = (entry.metadata as { thinkingTokens?: number }).thinkingTokens ?? 0;
      if (prevTok || nextTok) merged.thinkingTokens = Math.max(prevTok, nextTok);
      const priorSequence = Number(target.metadata?.sequenceStart);
      const nextSequence = Number(entry.metadata.sequenceStart);
      if (Number.isSafeInteger(priorSequence) && Number.isSafeInteger(nextSequence)) {
        merged.sequenceStart = Math.min(priorSequence, nextSequence);
        merged.sequenceEnd = Math.max(
          Number(entry.metadata.sequenceEnd ?? priorSequence),
          Number(nextSequence),
        );
      }
      updates.metadata = merged;
    }

    Object.assign(target, updates);
    patchGroupedFeedEntry(target.id, target.text, target.timestamp, updates);
    streamingRevision++;
    feedStreamTargets.set(targetKey, { sessionId, agentId: entry.agentId, entryId: target.id });
    return;
  }

  const created = addFeedEntry(entry);
  if (created && continuesTurn) {
    closedFeedTurns.delete(turnKey);
    feedStreamTargets.set(targetKey, { sessionId, agentId: entry.agentId, entryId: created.id });
  }
}

function beginThinking(agentId: string, timestamp: number): number {
  const existing = activeThinkingStartedAt.get(agentId);
  if (existing !== undefined) return existing;
  activeThinkingStartedAt.set(agentId, timestamp);
  return timestamp;
}

function getThinkingStart(agentId: string, fallbackTimestamp: number): number {
  return beginThinking(agentId, fallbackTimestamp);
}

function addUserMessage(
  sessionId: string,
  content: string,
  attachments?: Array<{ type: string; data: string; name: string; mimeType?: string }>,
) {
  if (!ownsFeed(sessionId)) return null;
  const userEntry: FeedEntry = {
    id: nextFeedId('user'),
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
  userSendRevision++;
  feedVersion++;
  rebuildGroupedFeedCache();
  return userEntry.id;
}

/** Remove every ephemeral analyzing thought.
 *
 * A session-history refresh can replace the tracked row while a cancellation
 * is in flight. Filtering by phase as well as the remembered ID makes Stop
 * authoritative even across that race.
 */
function removeAnalyzingThoughtEntries(sessionId?: string) {
  const next = withoutAnalyzingThoughts(feed, analyzingThoughtId);
  if (next.length !== feed.length) {
    feed = next;
    feedVersion++;
    rebuildGroupedFeedCache();
  }
  analyzingThoughtId = null;
  const targetSession = sessionId ?? feedSessionId;
  if (targetSession) {
    const cached = sessionFeedCache.get(targetSession);
    if (cached) {
      const nextCached = withoutAnalyzingThoughts(cached, null);
      if (nextCached.length !== cached.length) {
        sessionFeedCache.set(targetSession, nextCached);
      }
    }
  }
}

function addClientError(text: string) {
  const activeSessionId = sessionStore.activeSessionId;
  if (!activeSessionId) return;
  const clientEntryId = makeClientFeedEntryId();
  const timestamp = Date.now();
  const localPersistence = persistenceForSession(activeSessionId);
  sessionFeedPersistence.set(activeSessionId, {
    ...localPersistence,
    entries: [
      ...localPersistence.entries,
      { id: clientEntryId, kind: 'client_error', text, timestamp },
    ],
  });
  addFeedEntry({
    timestamp,
    type: 'error',
    agentId: 'kory-manager',
    agentName: 'Kory',
    glowClass: '',
    text,
    metadata: { sessionId: activeSessionId, source: 'client', clientEntryId },
  });
  // Only explicit session-feed errors use this endpoint. Toasts and passive
  // telemetry remain transient by design, so reconnecting does not replay a
  // pile of stale notifications as transcript evidence.
  void apiFetch(apiUrl(`/api/sessions/${activeSessionId}/feed/client-errors`), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: clientEntryId, text }),
  })
    .then(async (response) => {
      const result = await parseJsonResponse<{ ok?: boolean }>(response);
      if (!response.ok || result.ok !== true) {
        throw new Error('The backend did not accept the feed error.');
      }
    })
    .catch((error) => {
      console.warn('Could not persist explicit client feed error:', error);
    });
}

function upsertCompaction(
  payload: CompactionProgressPayload,
  eventMetadata: Record<string, unknown> = {},
) {
  if (!ownsFeed(payload.sessionId)) return;
  const existing = feed.find(
    (entry) => entry.type === 'compaction' && entry.metadata?.compactionId === payload.compactionId,
  );
  const metadata = { ...payload, ...eventMetadata } as unknown as Record<string, unknown>;
  const nextText = (payload.raw ?? payload.summary ?? payload.text ?? payload.message).replace(/\u2014/g, ', ').replace(/\u2013/g, '-');
  if (existing) {
    existing.text = nextText;
    existing.timestamp = Date.now();
    existing.metadata = metadata;
    patchGroupedFeedEntry(existing.id, existing.text, existing.timestamp, { metadata });
    streamingRevision++;
    return;
  }
  addFeedEntry({
    timestamp: Date.now(),
    type: 'compaction',
    agentId: 'kory-manager',
    agentName: 'Kory',
    glowClass: 'glow-kory',
    text: nextText,
    isCollapsed: true,
    metadata,
  });
}

function hasPersistedAssistantContaining(text: string, eventTimestamp: number): boolean {
  const needle = normalizeFeedText(text);
  if (!needle) return false;
  return feed.some(
    (entry) =>
      entry.type === 'content' &&
      entry.agentId === 'kory-manager' &&
      typeof entry.metadata?.messageId === 'string' &&
      entry.timestamp >= eventTimestamp &&
      normalizeFeedText(entry.text).includes(needle),
  );
}

/** Provider signalled reasoning is over (content started / turn completed):
 * freeze matching live blocks at their server-timestamp duration. */
/** The entry array backing a session lane: the visible feed when the reader is
 *  on that session, otherwise its cached transcript. Mutating the returned
 *  array mutates that lane in place. */
function laneEntries(sessionId: string): FeedEntry[] | null {
  if (!sessionId) return null;
  // The feed lane is selected by feedSessionId. The session store can update
  // one tick later during a switch (and tests intentionally exercise that
  // ordering), but a terminal event for the currently displayed lane must
  // still be allowed to seal its rows.
  if (feedSessionId === sessionId) return feed;
  return sessionFeedCache.get(sessionId) ?? null;
}

/** Seal every still-running reasoning block in a lane at a server timestamp.
 *  `endedAt` is a provider timestamp, never a client clock reading. */
function sealThinkingInLane(
  entries: FeedEntry[],
  agentId: string | undefined,
  endedAt: number,
  measured: boolean,
): boolean {
  let changed = false;
  for (const e of entries) {
    if (e.type !== 'thinking' || e.thinkingFinalized) continue;
    if (agentId && e.agentId !== agentId) continue;
    if (measured) {
      const startedAt = e.thinkingStartedAt ?? activeThinkingStartedAt.get(e.agentId);
      if (startedAt !== undefined) e.durationMs = Math.max(e.durationMs ?? 0, endedAt - startedAt);
    } else {
      // Leaving the chat: the start timestamp's origin is no longer visible, so
      // freeze at the last server timestamp observed rather than differencing
      // a client clock against a server start.
      e.durationMs = e.durationMs ?? 0;
    }
    e.thinkingFinalized = true;
    changed = true;
  }
  return changed;
}

/** Provider signalled reasoning is over (content started / turn completed):
 *  freeze matching live blocks at their server-timestamp duration. A null
 *  timestamp is used for a local stop acknowledgement: without a server end
 *  timestamp it is safer to freeze at the last observed server duration than
 *  to subtract a server timestamp from the browser clock.
 *
 *  `sessionId` names the lane the turn belongs to, which is NOT necessarily the
 *  one the reader is looking at: a run that completes in the background must
 *  still seal its own transcript instead of the reader's current chat. */
function finalizeThinking(
  agentId?: string,
  endedAt: number | null = Date.now(),
  sessionId?: string,
) {
  const lane = sessionId ?? feedSessionId;
  const entries = laneEntries(lane);
  if (!entries) return;
  // `endedAt` is always a provider timestamp here, so a background lane still
  // measures its own block against its own start — never the reader's clock.
  const changed = sealThinkingInLane(entries, agentId, endedAt ?? 0, endedAt !== null);
  if (agentId) {
    if (ownsFeed(lane)) activeThinkingStartedAt.delete(agentId);
  } else if (ownsFeed(lane)) {
    activeThinkingStartedAt.clear();
  }
  if (!changed) return;
  if (ownsFeed(lane)) {
    feed = [...feed];
    feedVersion++;
    rebuildGroupedFeedCache();
  }
}

/** Close the rows an agent's current turn may still append to, so the next
 *  delta opens a new item instead of continuing a finished answer. Mirrors
 *  closeAgentThreadTurn in the agent drilldown. */
function closeStreamTurn(agentId?: string, sessionId = feedSessionId) {
  if (!agentId) {
    const closedAgents = new Set<string>();
    for (const [key, target] of [...feedStreamTargets]) {
      if (target.sessionId !== sessionId) continue;
      feedStreamTargets.delete(key);
      closedAgents.add(target.agentId);
    }
    for (const closedAgent of closedAgents) {
      closedFeedTurns.add(feedTurnKey(sessionId, closedAgent));
    }
    return;
  }
  for (const [key, target] of [...feedStreamTargets]) {
    if (target.sessionId !== sessionId) continue;
    if (target.agentId !== agentId) continue;
    feedStreamTargets.delete(key);
  }
  if (sessionId) closedFeedTurns.add(feedTurnKey(sessionId, agentId));
}

/** Turn the live "running" tool card into its completed result card in place.
 *  Returns true when a live row was completed, or when the result was already
 *  recorded, so the caller can skip appending a duplicate output row. */
function completeToolCall(
  callId: string,
  resultText: string,
  toolResult: Record<string, unknown>,
  timestamp: number,
  eventMetadata: Record<string, unknown> = {},
  agentId?: string,
): boolean {
  const sessionId =
    typeof eventMetadata.sessionId === 'string' ? eventMetadata.sessionId : feedSessionId;
  const entries = laneEntries(sessionId) ?? [];
  const target = entries.findLast(
    (candidate) =>
      candidate.type === 'tool_call' &&
      (!agentId || candidate.agentId === agentId) &&
      (candidate.metadata as { toolCall?: { id?: string } } | undefined)?.toolCall?.id === callId,
  );
  if (target) {
    target.type = 'tool_result';
    target.text = resultText;
    target.timestamp = timestamp;
    target.metadata = {
      ...target.metadata,
      ...eventMetadata,
      // Keep the card anchored where the command started across history merges.
      ...(Number.isSafeInteger(target.metadata?.sequenceStart) && {
        sequenceStart: target.metadata?.sequenceStart,
      }),
      toolResult,
    };
    if (ownsFeed(sessionId)) {
      streamingRevision++;
      feedVersion++;
      rebuildGroupedFeedCache();
    }
    return true;
  }
  return entries.some(
    (candidate) =>
      candidate.type === 'tool_result' &&
      (!agentId || candidate.agentId === agentId) &&
      (candidate.metadata as { toolResult?: { callId?: string } } | undefined)?.toolResult
        ?.callId === callId,
  );
}

/** A tool starts before its JSON input is completely streamed. Patch that
 * existing card once the backend has the final arguments rather than adding a
 * second, duplicate "Calling tool" row. */
function updateToolCall(
  toolCall: { id: string; name: string; input: Record<string, unknown> },
  timestamp: number,
  sessionId = feedSessionId,
  agentId?: string,
) {
  const entry = laneEntries(sessionId)?.findLast(
    (candidate) =>
      (candidate.type === 'tool_call' || candidate.type === 'tool_result') &&
      (!agentId || candidate.agentId === agentId) &&
      ((candidate.metadata?.toolCall as { id?: string } | undefined)?.id ??
        (candidate.metadata?.toolResult as { callId?: string } | undefined)?.callId) ===
        toolCall.id,
  );
  if (!entry) return false;
  // A replayed start (or late final arguments) must not resurrect finished work.
  if (entry.type === 'tool_result' && !Object.keys(toolCall.input).length) return true;
  if (entry.type === 'tool_call') entry.timestamp = timestamp;
  entry.metadata = { ...entry.metadata, toolCall };
  if (ownsFeed(sessionId)) {
    patchGroupedFeedEntry(entry.id, entry.text, entry.timestamp, { metadata: entry.metadata });
    streamingRevision++;
  }
  return true;
}

/** Input of the live `tool_call` row a result belongs to, so the result can
 * show both the command and its output. */
function findToolCallInput(
  callId: string,
): { id: string; name: string; input: Record<string, unknown> } | undefined {
  if (!callId) return undefined;
  const entry = feed.findLast(
    (candidate) =>
      candidate.type === 'tool_call' &&
      (candidate.metadata as { toolCall?: { id?: string } } | undefined)?.toolCall?.id === callId,
  );
  return (
    entry?.metadata as
      { toolCall?: { id: string; name: string; input: Record<string, unknown> } } | undefined
  )?.toolCall;
}

/** Update an already-rendered row without changing its durable source. */
function setEntryVisibility(id: string, patch: { userHidden?: boolean; agentHidden?: boolean }) {
  const entry = feed.find((e) => e.id === id);
  if (!entry) return;
  if (patch.userHidden !== undefined) entry.userHidden = patch.userHidden;
  if (patch.agentHidden !== undefined) entry.agentHidden = patch.agentHidden;
  feed = [...feed];
  feedVersion++;
  rebuildGroupedFeedCache();
}

/** Attach the authoritative message identity once an optimistic send commits.
 *
 * The backend creates the message before it accepts the turn.  Carrying that
 * ID back to the optimistic row closes the interval where a Hide/Delete would
 * otherwise have no durable replay target.
 */
function bindMessageIdentity(sessionId: string, entryId: string, messageId: string): void {
  if (!sessionId || !entryId || !messageId) return;
  const patchEntries = (
    entries: readonly FeedEntry[],
  ): { entries: FeedEntry[]; changed: boolean } => {
    let changed = false;
    const next = entries.map((entry) => {
      const nested = entry.entries ? patchEntries(entry.entries) : undefined;
      if (entry.id !== entryId && !nested?.changed) return entry;
      changed = true;
      return {
        ...entry,
        ...(entry.id === entryId ? { metadata: { ...entry.metadata, sessionId, messageId } } : {}),
        ...(nested ? { entries: nested.entries } : {}),
      };
    });
    return { entries: next, changed };
  };

  if (feedSessionId === sessionId) {
    const patched = patchEntries(feed);
    if (patched.changed) {
      feed = patched.entries;
      feedVersion++;
      rebuildGroupedFeedCache();
    }
  }
  const cached = sessionFeedCache.get(sessionId);
  if (cached) {
    const patched = patchEntries(cached);
    if (patched.changed) sessionFeedCache.set(sessionId, patched.entries);
  }
}

function commitFeedVisibility(
  sessionId: string,
  targetKeys: readonly string[],
  visibility: FeedTombstoneVisibility | 'visible',
): void {
  const targets = [...new Set(targetKeys)];
  if (!sessionId || targets.length === 0) return;
  const current = persistenceForSession(sessionId);
  const tombstones = new Map<string, FeedTombstoneVisibility>(
    current.tombstones.map((record) => [record.targetKey, record.visibility]),
  );
  for (const targetKey of targets) {
    if (visibility === 'visible') tombstones.delete(targetKey);
    else tombstones.set(targetKey, visibility);
  }
  sessionFeedPersistence.set(sessionId, {
    ...current,
    tombstones: [...tombstones.entries()].map(([targetKey, nextVisibility]) => ({
      targetKey,
      visibility: nextVisibility,
    })),
  });
  applyDurableVisibilityToSession(sessionId);
}

async function persistFeedVisibility(
  sessionId: string,
  targetKeys: readonly string[],
  visibility: FeedTombstoneVisibility | 'visible',
  options: { applyLocal?: boolean } = {},
): Promise<void> {
  const targets = [...new Set(targetKeys)];
  if (!sessionId || targets.length === 0) return;
  // A collapsed operational group can contain more children than the API's
  // bounded mutation payload. Send exact-key batches; the UI does not update
  // its local tombstone map unless every batch was accepted.
  for (let offset = 0; offset < targets.length; offset += MAX_FEED_VISIBILITY_TARGETS_PER_REQUEST) {
    const batch = targets.slice(offset, offset + MAX_FEED_VISIBILITY_TARGETS_PER_REQUEST);
    const response = await apiFetch(apiUrl(`/api/sessions/${sessionId}/feed/visibility`), {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ targets: batch, visibility }),
    });
    const result = await parseJsonResponse<{ ok?: boolean; error?: string }>(response);
    if (!response.ok || result.ok !== true) {
      throw new Error(result.error || `Feed visibility update failed (${response.status}).`);
    }
  }

  if (options.applyLocal !== false) commitFeedVisibility(sessionId, targets, visibility);
}

/** Put a failed two-step message deletion back into its exact prior view state.
 *
 * Message storage and the immutable event log are separate authorities. We
 * install a view tombstone first so an ordered replay cannot resurrect the
 * message between deletion and the next history projection; if deletion is
 * refused, restore the previous per-key states rather than assuming visible.
 */
async function restoreFeedVisibility(
  sessionId: string,
  targetKeys: readonly string[],
  previous: ReadonlyMap<string, FeedTombstoneVisibility>,
): Promise<void> {
  const grouped = new Map<FeedTombstoneVisibility | 'visible', string[]>();
  for (const targetKey of targetKeys) {
    const visibility = previous.get(targetKey) ?? 'visible';
    const group = grouped.get(visibility) ?? [];
    group.push(targetKey);
    grouped.set(visibility, group);
  }
  for (const [visibility, keys] of grouped) {
    await persistFeedVisibility(sessionId, keys, visibility);
  }
}

/** Hide/show a rendered feed row with a durable replay identity when present. */
async function setUserEntryVisibility(entry: FeedEntry, hidden: boolean): Promise<boolean> {
  const sessionId = entrySessionId(entry);
  const targetKeys = feedTargetKeysForEntry(entry);
  if (sessionId && entry.type === 'user_message' && targetKeys.length === 0) {
    throw new Error('This message is still being saved. Try again once the send completes.');
  }
  if (!sessionId || targetKeys.length === 0) {
    // A truly local, unsequenced row has no future replay source. Keep the
    // useful immediate behavior without pretending it was made durable.
    setEntryVisibility(entry.id, { userHidden: hidden });
    return true;
  }
  await persistFeedVisibility(sessionId, targetKeys, hidden ? 'hidden' : 'visible');
  return true;
}

function removeEntries(ids: Set<string>) {
  if (ids.size === 0) return;
  feed = feed.filter((e) => !ids.has(e.id));
  feedVersion++;
  rebuildGroupedFeedCache();
}

/**
 * Delete a message from its authoritative store, or install a durable
 * view-tombstone for immutable operational evidence. This avoids rewriting an
 * ordered event log just because a user no longer wants to see one card.
 */
async function deleteEntry(entry: FeedEntry, selectedMessageId?: string): Promise<boolean> {
  const messageId = selectedMessageId ?? (entry.metadata?.messageId as string | undefined);
  const sessionId = entrySessionId(entry);
  if (messageId && sessionId) {
    // A persisted chat row can also carry the exact ordered-event range that
    // produced it. Tombstone both identities before deleting the message so a
    // reconnect/reload never rebuilds the answer from the immutable replay
    // lane after its message row is gone.
    const targetKeys = feedTargetKeysForEntry(entry);
    const previousVisibility = new Map<string, FeedTombstoneVisibility>(
      persistenceForSession(sessionId).tombstones.map((record) => [
        record.targetKey,
        record.visibility,
      ]),
    );
    let messageDeleted = false;
    try {
      if (targetKeys.length > 0) {
        await persistFeedVisibility(sessionId, targetKeys, 'deleted', { applyLocal: false });
      }
      const response = await apiFetch(apiUrl(`/api/messages/${sessionId}/${messageId}`), {
        method: 'DELETE',
      });
      const result = await parseJsonResponse<{ ok?: boolean; error?: string }>(response);
      if (!response.ok || result.ok !== true) {
        throw new Error(result.error || `Message deletion failed (${response.status}).`);
      }
      messageDeleted = true;

      // Only establish a local race tombstone after durable deletion succeeds.
      // Then reload the authoritative projection once; never make a failed
      // request look successful by merely removing the row in this window.
      if (targetKeys.length > 0) commitFeedVisibility(sessionId, targetKeys, 'deleted');
      deletedMessageIds.add(messageId);
      const messages = await sessionStore.fetchMessages(sessionId);
      if (!(await loadSessionMessages(sessionId, messages))) {
        throw new Error('The message was deleted, but refreshed chat history could not be shown.');
      }
      return true;
    } catch (err) {
      // Once the message store accepted deletion, keep the ordered-event
      // tombstone even if the follow-up projection fails. Restoring it here
      // would make an immutable replay resurrect a message that no longer
      // exists in the authoritative history.
      if (!messageDeleted && targetKeys.length > 0) {
        try {
          await restoreFeedVisibility(sessionId, targetKeys, previousVisibility);
        } catch (restoreError) {
          console.warn(
            'Failed to restore feed visibility after rejected message deletion:',
            restoreError,
          );
        }
      }
      console.error('Failed to delete message on backend:', err);
      throw err;
    }
  }
  const targetKeys = feedTargetKeysForEntry(entry);
  if (sessionId && entry.type === 'user_message' && targetKeys.length === 0) {
    throw new Error('This message is still being saved. Try again once the send completes.');
  }
  if (sessionId && targetKeys.length > 0) {
    await persistFeedVisibility(sessionId, targetKeys, 'deleted');
  } else {
    // Unsequenced ephemeral rows have no replay identity. They can only be
    // removed from the current live view and are never advertised as durable.
    removeEntries(new Set([entry.id]));
  }
  return true;
}

function removeContentEntriesForAgent(agentId: string) {
  const entriesToRemove = new Set<string>();
  for (let i = feed.length - 1; i >= 0; i--) {
    const entry = feed[i];
    if (entry?.type === 'user_message') break;
    if (entry?.agentId === agentId && entry?.type === 'content') {
      entriesToRemove.add(entry.id);
    } else if (entry?.type !== 'content' && entry?.type !== 'thinking') {
      break;
    }
  }
  if (entriesToRemove.size > 0) {
    removeEntries(entriesToRemove);
  }
}

function clearFeed() {
  feed = [];
  feedTransitionBaseIds.clear();
  feedVersion++;
  streamingRevision = 0;
  analyzingThoughtId = null;
  activeThinkingStartedAt.clear();
  rebuildGroupedFeedCache();
}

/** Drop the visible and cached transcript after an authoritative conversation
 * rewrite. The subsequent history load rebuilds persisted chat and the current
 * event epoch; retaining the prior operational lane would resurrect errors and
 * tool rows from the discarded branch. */
function resetSessionFeed(sessionId: string): number {
  sessionFeedCache.delete(sessionId);
  if (feedSessionId !== sessionId) return feedTransitionGeneration;
  // Invalidate any history request that began on the discarded branch. The
  // rewrite handler starts a fresh generation after this reset.
  feedTransitionGeneration++;
  feed = [];
  beginSessionLoad(sessionId);
  feedTransitionBaseIds.clear();
  streamingRevision = 0;
  analyzingThoughtId = null;
  activeThinkingStartedAt.clear();
  feedVersion++;
  rebuildGroupedFeedCache();
  return feedTransitionGeneration;
}

/** Drop every trace of a chat that no longer exists. The visible lane is only
 *  cleared while that chat still owns it — a replacement chat is activated
 *  separately — and no loading state is left behind, because nothing will
 *  rebuild this one. */
function clearSessionFeedState(sessionId: string): void {
  const sessionAgentIds = new Set<string>();
  const rememberEntryAgents = (entries: readonly FeedEntry[]) => {
    for (const entry of entries) {
      if (entry.agentId) sessionAgentIds.add(entry.agentId);
      if (entry.entries) rememberEntryAgents(entry.entries);
    }
  };
  const cached = sessionFeedCache.get(sessionId);
  if (cached) rememberEntryAgents(cached);
  if (feedSessionId === sessionId) rememberEntryAgents(feed);
  sessionFeedCache.delete(sessionId);
  sessionMessageHistory.delete(sessionId);
  olderMessagesBySession.delete(sessionId);
  oldestMessageCursorBySession.delete(sessionId);
  sessionFeedPersistence.delete(sessionId);
  feedPersistenceLoads.delete(sessionId);
  for (const [key, target] of [...feedStreamTargets]) {
    if (target.sessionId === sessionId) {
      sessionAgentIds.add(target.agentId);
      feedStreamTargets.delete(key);
    }
  }
  for (const key of [...closedFeedTurns]) {
    if (key.startsWith(`${sessionId}::`)) closedFeedTurns.delete(key);
  }
  for (const agentId of sessionAgentIds) activeThinkingStartedAt.delete(agentId);
  if (loadingOlderSessionId === sessionId) loadingOlderSessionId = '';
}

function forgetSessionFeed(sessionId: string): void {
  sessionRemovalGeneration++;
  clearSessionFeedState(sessionId);
  if (feedSessionId !== sessionId) return;
  // Invalidate a history request that began against the deleted chat, so its
  // response cannot repopulate the lane after the switch.
  feedTransitionGeneration++;
  feed = [];
  loadingSessionId = '';
  feedTransitionBaseIds = new Set();
  streamingRevision = 0;
  analyzingThoughtId = null;
  activeThinkingStartedAt.clear();
  deletedMessageIds.clear();
  feedVersion++;
  rebuildGroupedFeedCache();
}

onSessionRemoved(forgetSessionFeed);
onSessionsRemoved((sessionIds) => {
  sessionRemovalGeneration++;
  for (const sessionId of sessionIds) clearSessionFeedState(sessionId);
  if (!feedSessionId || !sessionIds.has(feedSessionId)) return;
  feedTransitionGeneration++;
  feed = [];
  loadingSessionId = '';
  feedTransitionBaseIds = new Set();
  streamingRevision = 0;
  analyzingThoughtId = null;
  activeThinkingStartedAt.clear();
  deletedMessageIds.clear();
  feedVersion++;
  rebuildGroupedFeedCache();
});

function isDuplicateError(text: string, timestamp: number): boolean {
  const last = feed.length > 0 ? feed[feed.length - 1] : null;
  const delta = last ? timestamp - last.timestamp : -1;
  return !!(last?.type === 'error' && last.text === text && delta >= 0 && delta < 3_000);
}

/**
 * A history response only carries a wall-clock creation timestamp. When it
 * replaces a streamed manager reply, retain the reply's durable event-log
 * position so timeline reconciliation does not put that persisted reply ahead
 * of replayed reasoning merely because the database timestamp is coarse.
 *
 * Work backwards so repeated assistant text belongs to the most recent
 * persisted reply. A coalesced live content row already carries the first and
 * final sequence of its delta range, which is exactly the canonical anchor we
 * need to preserve.
 */
function anchorPersistedRepliesToLiveContent(
  history: FeedEntry[],
  liveEntries: ReadonlyArray<FeedEntry>,
): FeedEntry[] {
  const liveContent = liveEntries
    .map((entry, index) => ({ entry, index }))
    .filter(({ entry }) => {
      const epoch = entry.metadata?.eventEpoch;
      const sequence = entry.metadata?.sequenceStart;
      return (
        entry.type === 'content' &&
        entry.agentId === 'kory-manager' &&
        Number.isSafeInteger(epoch) &&
        Number.isSafeInteger(sequence) &&
        !!normalizeFeedText(entry.text)
      );
    });
  if (liveContent.length === 0) return history;

  const claimedLiveEntries = new Set<number>();
  const anchored = [...history];
  for (let historyIndex = anchored.length - 1; historyIndex >= 0; historyIndex--) {
    const persisted = anchored[historyIndex];
    if (
      persisted.type !== 'content' ||
      persisted.agentId !== 'kory-manager' ||
      typeof persisted.metadata?.messageId !== 'string'
    ) {
      continue;
    }

    const persistedText = normalizeFeedText(persisted.text);
    if (!persistedText) continue;
    const match = [...liveContent]
      .reverse()
      .find(
        ({ entry, index }) =>
          !claimedLiveEntries.has(index) && persistedText.includes(normalizeFeedText(entry.text)),
      );
    if (!match) continue;

    claimedLiveEntries.add(match.index);
    const eventEpoch = Number(match.entry.metadata?.eventEpoch);
    const sequenceStart = Number(match.entry.metadata?.sequenceStart);
    const sequenceEnd = Number(match.entry.metadata?.sequenceEnd ?? sequenceStart);
    anchored[historyIndex] = {
      ...persisted,
      metadata: {
        ...persisted.metadata,
        eventEpoch,
        sequenceStart,
        ...(Number.isSafeInteger(sequenceEnd) ? { sequenceEnd } : {}),
      },
    };
  }
  return anchored;
}

// ─── Grouped Feed (for virtual list) ─────────────────────────────────────────

/** Archive labels are `<tool> <JSON input>` clipped to 140 chars; only a
 * label that still parses is trustworthy enough to show as the command. */
function parseArchivedToolInput(summary: string): Record<string, unknown> | undefined {
  const trimmed = summary.trim();
  if (!trimmed.startsWith('{') || !trimmed.endsWith('}')) return undefined;
  try {
    const parsed = JSON.parse(trimmed);
    return parsed &&
      typeof parsed === 'object' &&
      !Array.isArray(parsed) &&
      Object.keys(parsed).length
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

function getToolName(entry: FeedEntry): string {
  const metadata = entry.metadata as
    { toolCall?: { name?: string }; toolResult?: { name?: string } } | undefined;
  return normalizeToolName(metadata?.toolCall?.name ?? metadata?.toolResult?.name ?? '');
}

export function getGroupedEntries(entries: FeedEntry[]): FeedEntry[] {
  const result: FeedEntry[] = [];
  const seenIds = new Set<string>();
  let currentGroup: FeedEntry | null = null;
  let agentGroup: FeedEntry | null = null;

  for (const entry of entries) {
    // Defensive dedup: if the feed array somehow contains two entries
    // with the same id (e.g. a reload race that bypasses the merge
    // dedup), skip the duplicate instead of crashing Svelte's keyed
    // each block with `each_key_duplicate`.
    if (seenIds.has(entry.id)) continue;
    seenIds.add(entry.id);
    // Only an actual `agent.spawned` worker may be rendered as a sub-agent.
    // Provider names, stale IDs, and ordinary manager errors must never gain
    // worker UI merely because their id differs from `kory-manager`.
    const isSubAgent = entry.metadata?.isSubAgent === true && entry.type !== 'user_message';
    if (isSubAgent) {
      currentGroup = null;
      if (agentGroup && agentGroup.agentId === entry.agentId) {
        agentGroup.entries!.push(entry);
        agentGroup.timestamp = entry.timestamp;
        agentGroup.text = `${entry.agentName} — ${agentGroup.entries!.length} steps`;
        agentGroup.userHidden = agentGroup.entries!.every((child) => child.userHidden === true);
      } else {
        const domain =
          (entry.metadata?.domain as string | undefined) ?? glowToDomain(entry.glowClass);
        agentGroup = {
          id: `agent-group-${entry.id}`,
          timestamp: entry.timestamp,
          type: 'agent_group',
          agentId: entry.agentId,
          agentName: entry.agentName,
          glowClass: entry.glowClass,
          text: `${entry.agentName} — 1 step`,
          entries: [entry],
          isCollapsed: true,
          userHidden: entry.userHidden,
          metadata: { domain },
        };
        result.push(agentGroup);
      }
      continue;
    }
    agentGroup = null;
    const toolName = getToolName(entry);
    const isEphemeral =
      (entry.type === 'tool_call' || entry.type === 'tool_result') &&
      EPHEMERAL_TOOLS.has(toolName) &&
      !toolPresentation(entry).failed;

    if (isEphemeral) {
      if (currentGroup && currentGroup.agentId === entry.agentId) {
        currentGroup.entries!.push(entry);
        currentGroup.timestamp = entry.timestamp;
        currentGroup.userHidden = currentGroup.entries!.every((child) => child.userHidden === true);

        const toolNames = new Set(currentGroup.entries!.map(getToolName).filter(Boolean));
        const count = currentGroup.entries!.length;
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
          userHidden: entry.userHidden,
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

// ─── Session Loading ─────────────────────────────────────────────────────────

type SessionLoadOptions = {
  generation?: number;
  signal?: AbortSignal;
  /** Older-page hydration only needs to rebuild text; do not refetch the
   * expensive enrichment lanes that were already loaded for this session. */
  loadAncillary?: boolean;
  onUsage?: (
    usage: {
      used: number;
      max: number;
      contextKnown: boolean;
      provider?: string;
      model?: string;
      cachedInputTokens?: number;
      breakdown?: ContextBreakdown;
    } | null,
  ) => void;
};

/**
 * Own the chat loading surface for the whole open, not just the first commit.
 *
 * The text page commits first, but the archived tool rows join a moment later.
 * Revealing between those two commits is what made an opened chat look like
 * someone flick-scrolling to the bottom: the second commit grows the
 * transcript by hundreds of estimated rows, and the bottom pin walks the view
 * down through every tool card as each measurement batch settles.
 */
async function loadSessionMessages(
  sessionId: string,
  messages: DisplayMessage[],
  options: SessionLoadOptions = {},
): Promise<boolean> {
  // A full load owns the reveal. Two refreshes can overlap (a timeline
  // rewrite racing the normal history fetch); only the newest may drop the
  // spinner, or the older one reveals a half-merged transcript.
  const loadToken =
    options.loadAncillary === false ? sessionLoadToken : ++sessionLoadToken;
  try {
    return await loadSessionMessagesImpl(sessionId, messages, options);
  } finally {
    // Older-page hydration is a background append, not a session open. It
    // must neither release nor take ownership of the loading surface.
    if (options.loadAncillary !== false) endSessionLoad(loadToken, sessionId);
  }
}

async function loadSessionMessagesImpl(
  sessionId: string,
  messages: DisplayMessage[],
  options: SessionLoadOptions,
): Promise<boolean> {
  if (!ownsFeed(sessionId, options.generation)) return false;
  const removalGeneration = sessionRemovalGeneration;
  const pageInfo = sessionStore.getMessagePageInfo?.(messages);
  if (pageInfo) {
    sessionMessageHistory.set(sessionId, [...messages]);
    olderMessagesBySession.set(sessionId, pageInfo.hasMore);
    oldestMessageCursorBySession.set(sessionId, pageInfo.oldestMessageId);
  }
  // Load user-owned feed state before rebuilding the transcript. Ordered
  // replay can begin before history arrives; this keeps deleted rows from
  // flashing back into view and restores explicit client errors alongside
  // server-originated evidence.
  await loadFeedPersistence(sessionId, options.signal);
  if (
    sessionRemovalGeneration !== removalGeneration ||
    !ownsFeed(sessionId, options.generation)
  ) return false;
  const boundary: MessageDisplayBoundary = sessionStore.getMessageDisplayBoundary?.(messages) ?? {
    activeMessageId: null,
    conversationRevision: null,
    providerConversationRevision: null,
    authoritative: false,
  };
  // Don't wipe the feed up front — that leaves a visible blank flash for the
  // whole round trip below. Instead remember where "new" entries begin and
  // swap everything in atomically once the fetched history is ready.
  const transitionTail = withoutAnalyzingThoughts(
    feed.filter((entry) => !feedTransitionBaseIds.has(entry.id)),
    analyzingThoughtId,
  );
  // A same-session refresh may run after an earlier refresh has already made
  // replayed reasoning, tools, and errors part of the committed base. Those
  // rows are still durable operational transcript and must not be replaced by
  // the message table, which contains only chat text. Retain them regardless
  // of when this particular refresh began, then add genuinely new tail rows.
  const liveTailAtLoad = mergeFeedTimeline(
    withoutAnalyzingThoughts(operationalEntriesForReload(feed), analyzingThoughtId),
    transitionTail,
  );

  // Filter out messages deleted client-side whose deletion may not yet be
  // reflected in this fetch response (race with an in-flight reload).
  if (deletedMessageIds.size > 0) {
    messages = messages.filter((m) => !deletedMessageIds.has(m.id));
  }

  let timeline: Array<{ messageId?: string; hash?: string }> = [];
  let contextData: {
    mcpServers?: McpToolServerIdentity[];
    lastUsage?: {
      used: number;
      max: number;
      contextKnown: boolean;
      provider?: string;
      model?: string;
      cachedInputTokens?: number;
      breakdown?: ContextBreakdown;
    } | null;
    data?: Array<{
      id: string;
      ts: number;
      kind: string;
      label: string;
      toolInput?: string;
      content: string;
      isError?: boolean;
      prunedForAgent: boolean;
      runRef?: RunRevisionRef;
    }>;
  } = {};
  let contextUsageDelivered = false;
  const timelineRequest = apiFetch(
    apiUrl(`/api/sessions/${sessionId}/timetravel`),
    { signal: options.signal },
    ENRICHMENT_TIMEOUT_MS,
  ).then((res) => parseJsonResponse<{ ok?: boolean; data?: { timeline?: typeof timeline } }>(res));
  // Only the archived tool activity that belongs to this page of messages is
  // requested. The backend otherwise returns the session's whole tool history
  // (hundreds of rows, each up to 4 KB), which a reopened long chat had to
  // merge and lay out before it could paint. The window starts one page-duration
  // before the oldest loaded message so the oldest visible turn keeps the tool
  // rows that produced it; those rows are archived before the answer is saved.
  const oldestCreatedAt = messages.reduce(
    (oldest, message) => Math.min(oldest, message.createdAt),
    Number.POSITIVE_INFINITY,
  );
  const newestCreatedAt = messages.reduce((newest, message) => Math.max(newest, message.createdAt), 0);
  const contextSince = Number.isFinite(oldestCreatedAt)
    ? Math.max(0, oldestCreatedAt - Math.max(newestCreatedAt - oldestCreatedAt, 5 * 60_000))
    : undefined;
  const contextRequest = apiFetch(
    apiUrl(
      `/api/sessions/${sessionId}/context${contextSince === undefined ? '' : `?since=${contextSince}`}`,
    ),
    {
      signal: options.signal,
    },
    ENRICHMENT_TIMEOUT_MS,
  ).then((res) =>
    parseJsonResponse<{
      ok?: boolean;
      lastUsage?: typeof contextData.lastUsage;
      mcpServers?: McpToolServerIdentity[];
      data?: typeof contextData.data;
    }>(res),
  );

  // Context usage is a live signal, not ancillary transcript enrichment. Apply
  // it as soon as its request completes instead of waiting for timetravel and
  // archived tool history to finish too.
  void contextRequest
    .then((result) => {
      if (
        !result.ok ||
        sessionRemovalGeneration !== removalGeneration ||
        !ownsFeed(sessionId, options.generation)
      ) return;
      contextData = result;
      if (Array.isArray(result.mcpServers)) setSessionMcpToolRegistry(sessionId, result.mcpServers);
      if (Object.prototype.hasOwnProperty.call(result, 'lastUsage')) {
        contextUsageDelivered = true;
        options.onUsage?.(result.lastUsage ?? null);
      }
    })
    .catch(() => {
      // The allSettled path below handles failed enrichment.
    });
  // Bound the wait. Both requests carry the session switch signal, which
  // apiFetch prefers over its own timeout, so a wedged backend endpoint could
  // otherwise hold the loading surface open indefinitely.
  let enrichmentTimer: ReturnType<typeof setTimeout> | undefined;
  const ancillary = Promise.race([
    Promise.allSettled([timelineRequest, contextRequest]),
    new Promise<typeof ENRICHMENT_TIMED_OUT>((resolve) => {
      enrichmentTimer = setTimeout(() => resolve(ENRICHMENT_TIMED_OUT), ENRICHMENT_TIMEOUT_MS);
    }),
  ]).finally(() => {
    if (enrichmentTimer !== undefined) clearTimeout(enrichmentTimer);
  });

  // The user may have switched to another session while the timeline
  // fetch was in flight; writing this (now stale) history would show the
  // wrong chat's messages in the current chat.
  if (
    sessionRemovalGeneration !== removalGeneration ||
    !ownsFeed(sessionId, options.generation)
  ) return false;

  const variantsByGroup = new Map<string, DisplayMessage[]>();
  for (const message of messages) {
    if (!message.variantGroupId) continue;
    const variants = variantsByGroup.get(message.variantGroupId) ?? [];
    variants.push(message);
    variantsByGroup.set(message.variantGroupId, variants);
  }
  const variantChoices = new Map(
    [...variantsByGroup.entries()].map(([groupId, variants]) => [
      groupId,
      chooseVariantRepresentative(variants, boundary),
    ]),
  );
  const displayMessages = messages.filter(
    (message) =>
      !message.variantGroupId ||
      variantChoices.get(message.variantGroupId)?.representative.id === message.id,
  );

  const history = displayMessages.map((m) => {
    const isCompaction = m.role === 'system' && m.content.startsWith('[KORY_COMPACTION]');
    const variantChoice = m.variantGroupId ? variantChoices.get(m.variantGroupId) : undefined;
    return {
      id: `hist-${m.id}`,
      timestamp: m.createdAt,
      // System rows are plain markers ("Stopped by user.") — not Kory speech.
      type: isCompaction
        ? ('compaction' as const)
        : m.role === 'user'
          ? ('user_message' as const)
          : m.role === 'system'
            ? ('system' as const)
            : ('content' as const),
      agentId: isCompaction
        ? 'kory-manager'
        : m.role === 'user'
          ? 'user'
          : m.role === 'system'
            ? 'system'
            : 'kory-manager',
      agentName: isCompaction
        ? 'Kory'
        : m.role === 'user'
          ? 'You'
          : m.role === 'system'
            ? ''
            : 'Kory',
      glowClass: isCompaction
        ? 'glow-kory'
        : m.role === 'user' || m.role === 'system'
          ? ''
          : 'glow-kory',
      text: isCompaction ? m.content.replace(/^\[KORY_COMPACTION\]\n?/, '').replace(/\u2014/g, ', ').replace(/\u2013/g, '-') : m.content,
      isCollapsed: isCompaction,
      metadata: {
        sessionId,
        model: m.model,
        provider: m.provider,
        cost: m.cost,
        messageId: m.id,
        variantGroupId: m.variantGroupId,
        activeVariantId: variantChoice?.activeVariantId,
        variantIdentityAuthoritative: variantChoice?.authoritative ?? boundary.authoritative,
        activeMessageId: boundary.activeMessageId,
        conversationRevision: boundary.conversationRevision,
        providerConversationRevision: boundary.providerConversationRevision,
        responseVariants: m.variantGroupId
          ? (variantChoice?.variants ?? []).map((variant) => ({
              id: variant.id,
              content: variant.content,
              model: variant.model,
              provider: variant.provider,
              index: variant.variantIndex ?? 0,
              attachments: variant.attachments,
              isActive: variant.id === variantChoice?.activeVariantId,
            }))
          : [
              {
                id: m.id,
                content: m.content,
                model: m.model,
                provider: m.provider,
                index: 0,
                attachments: m.attachments,
                isActive: m.isActive === true,
              },
            ],
        attachments: m.attachments,
        ...(isCompaction
          ? {
              compactionId: m.id.replace(/^compact-/, ''),
              phase: 'complete',
              progress: 100,
              message: 'Compaction complete',
              model: m.model,
            }
          : {}),
      },
      ghostHash: undefined,
    };
  });
  const historyWithLiveAnchors = anchorPersistedRepliesToLiveContent(history, liveTailAtLoad);

  // The live tail holds the turn we just watched stream in (the user's
  // message via addUserMessage + Kory's reply via accumulateFeedEntry). By
  // the time we reload, that turn is persisted and present in `history`
  // above — keeping both would render the user's text and Kory's reply
  // twice. Drop the now-persisted text rows from the live tail, but keep
  // ephemeral rows (thinking, tool calls, tool results, system markers)
  // that aren't part of message history. Worker content is also kept:
  // only the manager's turns are persisted as session messages.
  const persistedTextKeys = new Set<string>();
  const persistedAssistantTexts: string[] = [];
  // Dedup against every retained row, not just the displayed representatives.
  // A regenerated response keeps the superseded answer as a retained sibling
  // variant: it is deliberately excluded from `displayMessages` (one variant is
  // shown at a time) but it is still persisted. Comparing the live tail only
  // against the representatives left the live-streamed copy of a superseded
  // variant unmatched, so it survived the reload and rendered as a second,
  // duplicate Kory answer next to the one that replaced it.
  for (const m of messages) {
    persistedTextKeys.add(`${m.role}\u0000${normalizeFeedText(m.content)}`);
    if (m.role === 'assistant') persistedAssistantTexts.push(normalizeFeedText(m.content));
  }
  const dedupedLiveTail = withoutAnalyzingThoughts(
    liveTailAtLoad.filter((entry) => {
      const clientEntryId = entry.metadata?.clientEntryId;
      if (
        typeof clientEntryId === 'string' &&
        persistenceForSession(sessionId).entries.some((persisted) => persisted.id === clientEntryId)
      ) {
        return false;
      }
      if (entry.type === 'user_message') {
        return !persistedTextKeys.has(`user\u0000${normalizeFeedText(entry.text)}`);
      }
      if (entry.type === 'content' && entry.agentId === 'kory-manager') {
        // A streamed reply may be split across several content entries when
        // tool calls interleave. Each segment is contained within the
        // persisted assistant message, so match by containment rather than
        // exact equality. Empty fragments never count as a match.
        const text = normalizeFeedText(entry.text);
        if (!text) return true;
        return !persistedAssistantTexts.some((p) => p.includes(text));
      }
      return true;
    }),
    analyzingThoughtId,
  );
  // Text history is the critical path. Commit it immediately; timeline hashes
  // and archived tool proof enrich the same isolated session afterward.
  // The message history is authoritative for text, while the retained live
  // rows carry durable causal anchors. Merge them now rather than appending
  // one lane after the other so a replayed reasoning row remains before the
  // persisted answer it produced even when their wall clocks disagree.
  feed = visibleEntriesForSession(
    sessionId,
    withoutAnalyzingThoughts(
      mergeFeedTimeline(
        historyWithLiveAnchors,
        persistedClientErrorEntries(sessionId),
        dedupedLiveTail,
      ),
      analyzingThoughtId,
    ),
  );
  const committedIds = new Set(feed.map((entry) => entry.id));
  feedTransitionBaseIds = committedIds;
  sessionFeedCache.set(sessionId, cloneEntries(feed));
  feedVersion++;
  streamingRevision = 0;
  analyzingThoughtId = null;
  rebuildGroupedFeedCache();
  // Deliberately keep the loading surface up. The text page is only half the
  // transcript: archived tool rows are merged below and change the layout by
  // hundreds of rows. Revealing here is what produced the visible scroll down
  // through the tool cards while the bottom pin chased the growing extent.
  // `loadSessionMessages` releases the surface in its finally block, so an
  // abort, a failed enrichment lane, or an early return cannot strand it.
  if (options.loadAncillary === false) return true;

  const ancillaryResult = await ancillary;
  // A timed-out lane may still land later. Merging it after the reveal would
  // grow the transcript in front of the reader, which is the exact scroll
  // crawl the loading surface exists to hide. Reveal the text page instead.
  if (ancillaryResult === ENRICHMENT_TIMED_OUT) return true;
  const [timelineResult, contextResult] = ancillaryResult;
  if (
    options.signal?.aborted ||
    sessionRemovalGeneration !== removalGeneration ||
    !ownsFeed(sessionId, options.generation)
  ) return true;
  if (timelineResult.status === 'fulfilled' && timelineResult.value.ok) {
    timeline = timelineResult.value.data?.timeline ?? [];
  }
  if (contextResult.status === 'fulfilled' && contextResult.value.ok) {
    contextData = contextResult.value;
    if (Array.isArray(contextData.mcpServers)) {
      setSessionMcpToolRegistry(sessionId, contextData.mcpServers);
    }
  }
  // Restore archived tool activity (tool runs aren't part of message history —
  // without this, reopening a chat silently dropped all proof-of-work).
  let toolHistory: FeedEntry[] = [];
  try {
    if (
      Object.prototype.hasOwnProperty.call(contextData, 'lastUsage') &&
      ownsFeed(sessionId, options.generation) &&
      !contextUsageDelivered
    ) {
      // `null` means no matching saved measurement was available. The caller
      // decides whether the branch actually changed; an ordinary refresh must
      // not erase a newer live reading merely because persistence is behind.
      options.onUsage?.(contextData.lastUsage ?? null);
    }
    if (Array.isArray(contextData.data)) {
      toolHistory = contextData.data.map((e) => {
        const name = e.label.split(' ')[0] || 'tool';
        const input = parseArchivedToolInput(e.toolInput ?? e.label.slice(name.length + 1));
        return {
          id: `arch-${e.id}`,
          timestamp: e.ts,
          type: 'tool_result' as const,
          agentId: 'kory-manager',
          agentName: 'Kory',
          glowClass: '',
          text: e.content || e.label,
          agentHidden: e.prunedForAgent,
          metadata: {
            sessionId,
            ...(e.runRef ? { runRef: e.runRef } : {}),
            ...(input && { toolCall: { id: e.id, name, input } }),
            ...(!input && e.toolInput && { toolInputPreview: e.toolInput }),
            toolResult: {
              callId: e.id,
              name,
              output: e.content,
              isError: e.isError === true,
              durationMs: 0,
              archiveId: e.id,
            },
          },
        };
      });
    }
  } catch (err: unknown) {
    /* archive unavailable — text history still loads */
    console.debug(
      'Failed to load archived tool history:',
      err instanceof Error ? err.message : String(err),
    );
  }
  if (
    sessionRemovalGeneration !== removalGeneration ||
    !ownsFeed(sessionId, options.generation)
  ) return false;

  const enrichedHistory = historyWithLiveAnchors.map((entry) => ({
    ...entry,
    ghostHash: timeline.find((item) => item.messageId === entry.metadata?.messageId)?.hash,
  }));
  // Preserve both the retained live rows committed with text history and any
  // rows that arrived while ancillary history was loading. The snapshot is
  // identified by feed IDs, not its old array position, because canonical
  // ordering may interleave those lanes.
  const liveSinceTextCommit = feed.filter((entry) => !committedIds.has(entry.id));
  const liveAcrossReload = mergeFeedTimeline(dedupedLiveTail, liveSinceTextCommit);
  const liveOperational = operationalEntriesForReload(liveAcrossReload);
  const archivedWithoutLiveDuplicates = omitArchivedToolDuplicates(toolHistory, liveOperational);
  const merged = mergeFeedTimeline(
    enrichedHistory,
    persistedClientErrorEntries(sessionId),
    archivedWithoutLiveDuplicates,
    liveOperational,
  );
  // Anything pushed onto the feed while we awaited (live stream events for
  // this session) belongs after history — everything before
  // feedLengthAtStart is stale (either the old session's content, on a
  // switch, or this same session's now-persisted turn) and gets replaced.
  // Preserve only events that arrived after the immediate text-history commit.
  // Cached pre-switch rows were replaced above and can never leak back in.
  //
  // `merged` already includes `liveOperational` (a subset of the tail), so
  // drop those IDs from the tail before concatenating — otherwise the same
  // entry appears twice and Svelte's keyed each block crashes with
  // `each_key_duplicate`.
  const mergedIds = new Set(merged.map((e) => e.id));
  const tailAfterMerged = liveAcrossReload.filter((e) => !mergedIds.has(e.id));
  feed = visibleEntriesForSession(
    sessionId,
    withoutAnalyzingThoughts(mergeFeedTimeline(merged, tailAfterMerged), analyzingThoughtId),
  );
  feedTransitionBaseIds = new Set(feed.map((entry) => entry.id));
  sessionFeedCache.set(sessionId, cloneEntries(feed));
  feedVersion++;
  streamingRevision = 0;
  analyzingThoughtId = null;
  rebuildGroupedFeedCache();
  // The transcript is complete now. `loadSessionMessages` drops the loading
  // surface in its finally block, so the reader's first paint is this full
  // layout rather than the estimate-sized text page from above.
  return true;
}

async function loadOlderSessionMessages(sessionId = feedSessionId): Promise<boolean> {
  if (
    !sessionId ||
    sessionId !== sessionStore.activeSessionId ||
    loadingOlderSessionId === sessionId
  ) {
    return false;
  }
  if (olderMessagesBySession.get(sessionId) !== true) return false;
  const current = sessionMessageHistory.get(sessionId) ?? [];
  const oldestMessageId = oldestMessageCursorBySession.get(sessionId);
  if (!oldestMessageId) return false;
  const removalGeneration = sessionRemovalGeneration;
  loadingOlderSessionId = sessionId;
  try {
    const older = await sessionStore.fetchMessages(sessionId, undefined, {
      beforeMessageId: oldestMessageId,
    });
    if (
      sessionRemovalGeneration !== removalGeneration ||
      sessionId !== sessionStore.activeSessionId ||
      feedSessionId !== sessionId
    ) return false;
    const pageInfo = sessionStore.getMessagePageInfo?.(older);
    const existing = new Set(current.map((message) => message.id));
    const combined = [...older.filter((message) => !existing.has(message.id)), ...current];
    sessionStore.copyMessageDisplayMetadata(
      combined,
      messagesForMetadata(current, older),
      pageInfo,
    );
    sessionMessageHistory.set(sessionId, combined);
    olderMessagesBySession.set(sessionId, pageInfo?.hasMore === true);
    oldestMessageCursorBySession.set(sessionId, pageInfo?.oldestMessageId ?? null);
    if (combined.length !== current.length) {
      // Reuse the normal atomic history reducer so variants, operational rows,
      // and scroll anchoring remain consistent with an initial load.
      await loadSessionMessages(sessionId, combined, { loadAncillary: false });
    }
    return combined.length !== current.length;
  } finally {
    if (loadingOlderSessionId === sessionId) loadingOlderSessionId = '';
  }
}

function messagesForMetadata(current: DisplayMessage[], older: DisplayMessage[]): DisplayMessage[] {
  // The current page carries the authoritative branch boundary. The older
  // page only contributes its cursor metadata, so preserve the current page's
  // identity when rebuilding the combined feed.
  return current.length > 0 ? current : older;
}

// ─── Exported Store ─────────────────────────────────────────────────────────

export const feedStore = {
  get feed() {
    return feed;
  },
  get groupedFeed() {
    return groupedFeed;
  },
  get length() {
    return feed.length;
  },
  get sessionId() {
    return feedSessionId;
  },
  get transitionGeneration() {
    return feedTransitionGeneration;
  },
  get isLoadingSession() {
    return !!feedSessionId && loadingSessionId === feedSessionId;
  },
  /** Monotonic count of messages the reader has sent in this transcript. */
  get userSendRevision() {
    return userSendRevision;
  },
  get hasOlderMessages() {
    return olderMessagesBySession.get(feedSessionId) === true;
  },
  get isLoadingOlderMessages() {
    return loadingOlderSessionId === feedSessionId;
  },
  addFeedEntry,
  addFeedEntryForSession,
  accumulateFeedEntry,
  addUserMessage,
  removeAnalyzingThoughtEntries,
  addClientError,
  upsertCompaction,
  hasPersistedAssistantContaining,
  removeEntries,
  deleteEntry,
  setEntryVisibility,
  bindMessageIdentity,
  setUserEntryVisibility,
  loadFeedPersistence,
  visibleEntriesForSession,
  finalizeThinking,
  finalizeSessionThinking: (sessionId: string, agentId?: string, endedAt: number | null = null) =>
    finalizeThinking(agentId, endedAt, sessionId),
  closeStreamTurn,
  completeToolCall,
  beginThinking,
  getThinkingStart,
  updateToolCall,
  findToolCallInput,
  removeContentEntriesForAgent,
  clearFeed,
  resetSessionFeed,
  forgetSessionFeed,
  activateSessionFeed,
  finishSessionLoad,
  ownsFeed,
  lastEntryForSession,
  latestToolEntryForSession,
  loadSessionMessages,
  loadOlderSessionMessages,
  resolveGlowClass,
  getGroupedEntries,
  isDuplicateError,
  nextFeedId,
};
