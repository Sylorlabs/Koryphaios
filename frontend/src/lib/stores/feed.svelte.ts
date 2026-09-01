// Feed Store — handles feed entries and message display
// Split from the monolithic websocket.svelte.ts for better separation of concerns

import type { AgentIdentity } from '@koryphaios/shared';
import type { CompactionProgressPayload } from '@koryphaios/shared';
import type { FeedEntry, FeedEntryType } from '$lib/types';
import { sessionStore } from './sessions.svelte';
import { apiUrl } from '$lib/utils/api-url';
import { apiFetch, parseJsonResponse } from '$lib/api.svelte';
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
  'search_notes',
  'recall_notes',
]);
const MAX_FEED_ENTRIES = 2000;
const MAX_FEED_VISIBILITY_TARGETS_PER_REQUEST = 256;
let feedIdCounter = 0;

// ─── Reactive State ──────────────────────────────────────────────────────────

let feed = $state<FeedEntry[]>([]);
let feedSessionId = $state('');
let loadingSessionId = $state('');
let feedTransitionGeneration = 0;
// History and live events can be causally interleaved after a reload. Track
// the committed snapshot by id rather than an array offset: an offset assumes
// history always precedes live rows and loses that property once canonical
// sequence ordering correctly places reasoning before a persisted answer.
let feedTransitionBaseIds = new Set<string>();
const sessionFeedCache = new Map<string, FeedEntry[]>();
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

async function loadFeedPersistence(sessionId: string, signal?: AbortSignal): Promise<SessionFeedPersistence | null> {
  if (!sessionId) return null;
  const existing = persistenceForSession(sessionId);
  if (existing.loaded) return existing;
  const inFlight = feedPersistenceLoads.get(sessionId);
  if (inFlight) return inFlight;
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
    .finally(() => feedPersistenceLoads.delete(sessionId));
  feedPersistenceLoads.set(sessionId, request);
  return request;
}

/**
 * Atomically move the visible feed to another session. The old feed is saved
 * under its owner and the target's last complete snapshot is restored
 * immediately, so rapid switching never shows another chat or a blank wait.
 */
function activateSessionFeed(sessionId: string): number {
  if (feedSessionId === sessionId) return feedTransitionGeneration;
  if (feedSessionId) sessionFeedCache.set(feedSessionId, cloneEntries(feed));
  feedTransitionGeneration++;
  feedSessionId = sessionId;
  const hasSnapshot = sessionId ? sessionFeedCache.has(sessionId) : true;
  feed = sessionId ? cloneEntries(sessionFeedCache.get(sessionId) ?? []) : [];
  loadingSessionId = sessionId && !hasSnapshot ? sessionId : '';
  feedTransitionBaseIds = new Set(feed.map((entry) => entry.id));
  streamingRevision = 0;
  analyzingThoughtId = null;
  activeThinkingStartedAt.clear();
  deletedMessageIds.clear();
  feedVersion++;
  rebuildGroupedFeedCache();
  return feedTransitionGeneration;
}

function finishSessionLoad(sessionId: string, generation?: number): void {
  if (ownsFeed(sessionId, generation) && loadingSessionId === sessionId) {
    loadingSessionId = '';
  }
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

function addFeedEntry(entry: Omit<FeedEntry, 'id'>) {
  const sessionId = entrySessionId(entry as FeedEntry);
  const visible = decorateEntryForSession(sessionId, { ...entry, id: 'pending-feed-entry' });
  if (!visible) return;
  const newEntry: FeedEntry = { ...visible, id: nextFeedId('fe') };
  if (
    newEntry.type === 'thought' &&
    (newEntry.metadata as { phase?: string })?.phase === 'analyzing'
  ) {
    analyzingThoughtId = newEntry.id;
  }
  feed.push(newEntry);
  if (feed.length > MAX_FEED_ENTRIES) feed.splice(0, feed.length - MAX_FEED_ENTRIES);
  feedVersion++;
  rebuildGroupedFeedCache();
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

  if (
    last &&
    last.type === entry.type &&
    last.agentId === entry.agentId &&
    Boolean(last.userHidden) === Boolean(entry.userHidden)
  ) {
    const updates: Partial<FeedEntry> = {
      text: last.text + entry.text,
      timestamp: entry.timestamp,
      userHidden: entry.userHidden,
    };

    if (last.type === 'thinking' && last.thinkingStartedAt) {
      updates.durationMs = entry.timestamp - last.thinkingStartedAt;
    } else if (last.type === 'thinking' && !last.thinkingStartedAt) {
      updates.thinkingStartedAt = entry.timestamp;
    }
    // Redacted-thinking progress (token estimates) rides in metadata and must
    // keep updating as new deltas land — monotonically (provider estimates can
    // arrive out of order; the display must never count down).
    if (entry.metadata && Object.keys(entry.metadata).length > 0) {
      const merged = { ...last.metadata, ...entry.metadata } as Record<string, unknown>;
      const prevTok =
        (last.metadata as { thinkingTokens?: number } | undefined)?.thinkingTokens ?? 0;
      const nextTok = (entry.metadata as { thinkingTokens?: number }).thinkingTokens ?? 0;
      if (prevTok || nextTok) merged.thinkingTokens = Math.max(prevTok, nextTok);
      const priorSequence = Number(last.metadata?.sequenceStart);
      const nextSequence = Number(entry.metadata.sequenceStart);
      if (Number.isSafeInteger(priorSequence) && Number.isSafeInteger(nextSequence)) {
        merged.sequenceStart = Math.min(priorSequence, nextSequence);
        merged.sequenceEnd = Math.max(
          Number(last.metadata?.sequenceEnd ?? priorSequence),
          Number(entry.metadata.sequenceEnd ?? nextSequence),
        );
      }
      updates.metadata = merged;
    }

    Object.assign(last, updates);
    patchGroupedFeedEntry(last.id, last.text, last.timestamp, updates);
    streamingRevision++;
  } else {
    addFeedEntry(entry);
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
function removeAnalyzingThoughtEntries() {
  const next = withoutAnalyzingThoughts(feed, analyzingThoughtId);
  if (next.length !== feed.length) {
    feed = next;
    feedVersion++;
    rebuildGroupedFeedCache();
  }
  analyzingThoughtId = null;
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

function upsertCompaction(payload: CompactionProgressPayload, eventMetadata: Record<string, unknown> = {}) {
  if (!ownsFeed(payload.sessionId)) return;
  const existing = feed.find(
    (entry) => entry.type === 'compaction' && entry.metadata?.compactionId === payload.compactionId,
  );
  const metadata = { ...payload, ...eventMetadata } as unknown as Record<string, unknown>;
  if (existing) {
    existing.text = payload.message;
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
    text: payload.message,
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
function finalizeThinking(agentId?: string, endedAt = Date.now()) {
  let changed = false;
  for (const e of feed) {
    if (e.type === 'thinking' && !e.thinkingFinalized && (!agentId || e.agentId === agentId)) {
      const startedAt = e.thinkingStartedAt ?? activeThinkingStartedAt.get(e.agentId);
      if (startedAt !== undefined) e.durationMs = Math.max(e.durationMs ?? 0, endedAt - startedAt);
      e.thinkingFinalized = true;
      changed = true;
    }
  }
  if (agentId) activeThinkingStartedAt.delete(agentId);
  else activeThinkingStartedAt.clear();
  if (changed) {
    feed = [...feed];
    feedVersion++;
    rebuildGroupedFeedCache();
  }
}

/** A tool starts before its JSON input is completely streamed. Patch that
 * existing card once the backend has the final arguments rather than adding a
 * second, duplicate "Calling tool" row. */
function updateToolCall(
  toolCall: { id: string; name: string; input: Record<string, unknown> },
  timestamp: number,
) {
  const entry = feed.findLast(
    (candidate) =>
      candidate.type === 'tool_call' &&
      (candidate.metadata as { toolCall?: { id?: string } } | undefined)?.toolCall?.id ===
        toolCall.id,
  );
  if (!entry) return false;
  entry.timestamp = timestamp;
  entry.metadata = { ...entry.metadata, toolCall };
  patchGroupedFeedEntry(entry.id, entry.text, timestamp, { metadata: entry.metadata });
  streamingRevision++;
  return true;
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
  const patchEntries = (entries: readonly FeedEntry[]): { entries: FeedEntry[]; changed: boolean } => {
    let changed = false;
    const next = entries.map((entry) => {
      const nested = entry.entries ? patchEntries(entry.entries) : undefined;
      if (entry.id !== entryId && !nested?.changed) return entry;
      changed = true;
      return {
        ...entry,
        ...(entry.id === entryId
          ? { metadata: { ...entry.metadata, sessionId, messageId } }
          : {}),
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
      persistenceForSession(sessionId).tombstones.map((record) => [record.targetKey, record.visibility]),
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
          console.warn('Failed to restore feed visibility after rejected message deletion:', restoreError);
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
  loadingSessionId = sessionId;
  feedTransitionBaseIds.clear();
  streamingRevision = 0;
  analyzingThoughtId = null;
  activeThinkingStartedAt.clear();
  feedVersion++;
  rebuildGroupedFeedCache();
  return feedTransitionGeneration;
}

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

function getToolName(entry: FeedEntry): string {
  const metadata = entry.metadata as
    { toolCall?: { name?: string }; toolResult?: { name?: string } } | undefined;
  return metadata?.toolCall?.name ?? metadata?.toolResult?.name ?? '';
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
          isCollapsed: false,
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
      (entry.type === 'tool_call' || entry.type === 'tool_result') && EPHEMERAL_TOOLS.has(toolName);

    if (isEphemeral) {
      if (currentGroup && currentGroup.agentId === entry.agentId) {
        currentGroup.entries!.push(entry);
        currentGroup.timestamp = entry.timestamp;
        currentGroup.userHidden = currentGroup.entries!.every((child) => child.userHidden === true);

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

async function loadSessionMessages(
  sessionId: string,
  messages: DisplayMessage[],
  options: {
    generation?: number;
    signal?: AbortSignal;
    onUsage?: (usage: {
      used: number;
      max: number;
      contextKnown: boolean;
      provider?: string;
      model?: string;
      cachedInputTokens?: number;
      breakdown?: { system: number; memory: number; tools: number; chat: number };
    }) => void;
  } = {},
) {
  if (!ownsFeed(sessionId, options.generation)) return false;
  // Load user-owned feed state before rebuilding the transcript. Ordered
  // replay can begin before history arrives; this keeps deleted rows from
  // flashing back into view and restores explicit client errors alongside
  // server-originated evidence.
  await loadFeedPersistence(sessionId, options.signal);
  if (!ownsFeed(sessionId, options.generation)) return false;
  const boundary: MessageDisplayBoundary = sessionStore.getMessageDisplayBoundary?.(messages) ?? {
    activeMessageId: null,
    conversationRevision: null,
    providerConversationRevision: null,
    authoritative: false,
  };
  // Don't wipe the feed up front — that leaves a visible blank flash for the
  // whole round trip below. Instead remember where "new" entries begin and
  // swap everything in atomically once the fetched history is ready.
  const transitionTail = feed.filter((entry) => !feedTransitionBaseIds.has(entry.id));
  // A same-session refresh may run after an earlier refresh has already made
  // replayed reasoning, tools, and errors part of the committed base. Those
  // rows are still durable operational transcript and must not be replaced by
  // the message table, which contains only chat text. Retain them regardless
  // of when this particular refresh began, then add genuinely new tail rows.
  const liveTailAtLoad = mergeFeedTimeline(operationalEntriesForReload(feed), transitionTail);

  // Filter out messages deleted client-side whose deletion may not yet be
  // reflected in this fetch response (race with an in-flight reload).
  if (deletedMessageIds.size > 0) {
    messages = messages.filter((m) => !deletedMessageIds.has(m.id));
  }

  let timeline: Array<{ messageId?: string; hash?: string }> = [];
  let contextData: {
    lastUsage?: {
      used: number;
      max: number;
      contextKnown: boolean;
      provider?: string;
      model?: string;
      cachedInputTokens?: number;
      breakdown?: { system: number; memory: number; tools: number; chat: number };
    } | null;
    data?: Array<{
      id: string;
      ts: number;
      kind: string;
      label: string;
      content: string;
      isError?: boolean;
      prunedForAgent: boolean;
    }>;
  } = {};
  const ancillary = Promise.allSettled([
    apiFetch(apiUrl(`/api/sessions/${sessionId}/timetravel`), { signal: options.signal }).then(
      (res) => parseJsonResponse<{ ok?: boolean; data?: { timeline?: typeof timeline } }>(res),
    ),
    apiFetch(apiUrl(`/api/sessions/${sessionId}/context`), { signal: options.signal }).then((res) =>
      parseJsonResponse<{
        ok?: boolean;
        lastUsage?: typeof contextData.lastUsage;
        data?: typeof contextData.data;
      }>(res),
    ),
  ]);

  // The user may have switched to another session while the timeline
  // fetch was in flight; writing this (now stale) history would show the
  // wrong chat's messages in the current chat.
  if (!ownsFeed(sessionId, options.generation)) return false;

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
      text: isCompaction ? m.content.replace(/^\[KORY_COMPACTION\]\n?/, '') : m.content,
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
  for (const m of displayMessages) {
    persistedTextKeys.add(`${m.role}\u0000${normalizeFeedText(m.content)}`);
    if (m.role === 'assistant') persistedAssistantTexts.push(normalizeFeedText(m.content));
  }
  const dedupedLiveTail = liveTailAtLoad.filter((entry) => {
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
  });
  // Text history is the critical path. Commit it immediately; timeline hashes
  // and archived tool proof enrich the same isolated session afterward.
  // The message history is authoritative for text, while the retained live
  // rows carry durable causal anchors. Merge them now rather than appending
  // one lane after the other so a replayed reasoning row remains before the
  // persisted answer it produced even when their wall clocks disagree.
  feed = visibleEntriesForSession(
    sessionId,
    mergeFeedTimeline(historyWithLiveAnchors, persistedClientErrorEntries(sessionId), dedupedLiveTail),
  );
  loadingSessionId = '';
  const committedIds = new Set(feed.map((entry) => entry.id));
  feedTransitionBaseIds = committedIds;
  sessionFeedCache.set(sessionId, cloneEntries(feed));
  feedVersion++;
  streamingRevision = 0;
  analyzingThoughtId = null;
  rebuildGroupedFeedCache();

  const [timelineResult, contextResult] = await ancillary;
  if (options.signal?.aborted || !ownsFeed(sessionId, options.generation)) return true;
  if (timelineResult.status === 'fulfilled' && timelineResult.value.ok) {
    timeline = timelineResult.value.data?.timeline ?? [];
  }
  if (contextResult.status === 'fulfilled' && contextResult.value.ok) {
    contextData = contextResult.value;
  }
  // Restore archived tool activity (tool runs aren't part of message history —
  // without this, reopening a chat silently dropped all proof-of-work).
  let toolHistory: FeedEntry[] = [];
  try {
    if (contextData.lastUsage && ownsFeed(sessionId, options.generation)) {
      options.onUsage?.(contextData.lastUsage);
    }
    if (Array.isArray(contextData.data)) {
      toolHistory = contextData.data.map((e) => ({
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
          toolResult: {
            callId: e.id,
            name: e.label.split(' ')[0] || 'tool',
            output: e.content,
            isError: e.isError === true,
            durationMs: 0,
            archiveId: e.id,
          },
        },
      }));
    }
  } catch (err: unknown) {
    /* archive unavailable — text history still loads */
    console.debug(
      'Failed to load archived tool history:',
      err instanceof Error ? err.message : String(err),
    );
  }
  if (!ownsFeed(sessionId, options.generation)) return false;

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
  feed = visibleEntriesForSession(sessionId, mergeFeedTimeline(merged, tailAfterMerged));
  feedTransitionBaseIds = new Set(feed.map((entry) => entry.id));
  sessionFeedCache.set(sessionId, cloneEntries(feed));
  feedVersion++;
  streamingRevision = 0;
  analyzingThoughtId = null;
  rebuildGroupedFeedCache();
  return true;
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
  beginThinking,
  getThinkingStart,
  updateToolCall,
  removeContentEntriesForAgent,
  clearFeed,
  resetSessionFeed,
  activateSessionFeed,
  finishSessionLoad,
  ownsFeed,
  lastEntryForSession,
  loadSessionMessages,
  resolveGlowClass,
  getGroupedEntries,
  isDuplicateError,
  nextFeedId,
};
