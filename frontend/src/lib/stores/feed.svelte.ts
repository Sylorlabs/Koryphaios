// Feed Store — handles feed entries and message display
// Split from the monolithic websocket.svelte.ts for better separation of concerns

import type { AgentIdentity } from '@koryphaios/shared';
import type { FeedEntry, FeedEntryType } from '$lib/types';
import { sessionStore } from './sessions.svelte';
import { apiUrl } from '$lib/utils/api-url';
import { apiFetch, parseJsonResponse } from '$lib/api.svelte';
import {
  mergeFeedTimeline,
  omitArchivedToolDuplicates,
  operationalEntriesForReload,
} from '$lib/utils/feed-timeline';

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
const MAX_CACHED_SESSION_FEEDS = 8;
let feedIdCounter = 0;

// ─── Reactive State ──────────────────────────────────────────────────────────

let feed = $state<FeedEntry[]>([]);
let feedSessionId = $state('');
let loadingSessionId = $state('');
let feedTransitionGeneration = 0;
let feedLoadGeneration = 0;
let feedTransitionBaseLength = 0;
let feedIsShared = false;
const sessionFeedCache = new Map<string, FeedEntry[]>();
const sessionFeedRecency = new Map<string, number>();

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

function pruneSessionFeedCache(): void {
  while (sessionFeedCache.size > MAX_CACHED_SESSION_FEEDS) {
    let oldestId: string | null = null;
    let oldestTs = Infinity;
    for (const [id, ts] of sessionFeedRecency) {
      if (ts < oldestTs) {
        oldestTs = ts;
        oldestId = id;
      }
    }
    if (oldestId === null) break;
    sessionFeedCache.delete(oldestId);
    sessionFeedRecency.delete(oldestId);
  }
}

function getCachedFeed(sessionId: string): FeedEntry[] | undefined {
  const entries = sessionFeedCache.get(sessionId);
  if (entries !== undefined) sessionFeedRecency.set(sessionId, Date.now());
  return entries;
}

function setCachedFeed(sessionId: string, entries: FeedEntry[]): void {
  sessionFeedCache.set(sessionId, entries);
  sessionFeedRecency.set(sessionId, Date.now());
  pruneSessionFeedCache();
}

function detachFeedIfShared(): void {
  if (feedIsShared) {
    feed = [...feed];
    feedIsShared = false;
  }
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

/**
 * Atomically move the visible feed to another session. The old feed is saved
 * under its owner and the target's last complete snapshot is restored
 * immediately, so rapid switching never shows another chat or a blank wait.
 */
function activateSessionFeed(sessionId: string): number {
  if (feedSessionId === sessionId) return feedTransitionGeneration;
  if (feedSessionId) setCachedFeed(feedSessionId, feed);
  feedTransitionGeneration++;
  feedLoadGeneration++;
  feedSessionId = sessionId;
  const hasSnapshot = sessionId ? sessionFeedCache.has(sessionId) : true;
  const cached = sessionId ? getCachedFeed(sessionId) : undefined;
  feed = cached ?? [];
  feedIsShared = !!cached;
  loadingSessionId = sessionId && !hasSnapshot ? sessionId : '';
  feedTransitionBaseLength = feed.length;
  streamingRevision = 0;
  analyzingThoughtId = null;
  activeThinkingStartedAt.clear();
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
      for (let j = 0; j < grouped.entries.length; j++) {
        const sub = grouped.entries[j];
        if (sub.id === entryId) {
          sub.text = text;
          sub.timestamp = timestamp;
          if (extra) Object.assign(sub, extra);
          return;
        }
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
  detachFeedIfShared();
  const newEntry: FeedEntry = { ...entry, id: nextFeedId('fe') };
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

function accumulateFeedEntry(entry: Omit<FeedEntry, 'id'>) {
  detachFeedIfShared();
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
    // Redacted-thinking progress (token estimates) rides in metadata and must
    // keep updating as new deltas land — monotonically (provider estimates can
    // arrive out of order; the display must never count down).
    if (entry.metadata && Object.keys(entry.metadata).length > 0) {
      const merged = { ...last.metadata, ...entry.metadata } as Record<string, unknown>;
      // A coalesced visual block occupies a sequence range. Its location is
      // anchored to the first event while the end advances with each delta.
      if (last.metadata?.sequenceStart !== undefined) {
        merged.sequenceStart = last.metadata.sequenceStart;
      }
      const prevTok =
        (last.metadata as { thinkingTokens?: number } | undefined)?.thinkingTokens ?? 0;
      const nextTok = (entry.metadata as { thinkingTokens?: number }).thinkingTokens ?? 0;
      if (prevTok || nextTok) merged.thinkingTokens = Math.max(prevTok, nextTok);
      updates.metadata = merged;
    }

    Object.assign(last, updates);
    patchGroupedFeedEntry(last.id, last.text, last.timestamp, updates);
    streamingRevision++;
  } else {
    addFeedEntry(entry);
  }
}

/** Tag the most recent run of manager content entries with the persisted
 *  message id. Called after the backend finishes a turn but before the
 *  message reload, so loadSessionMessages can dedup by ID instead of text. */
function tagManagerMessageId(messageId: string): void {
  detachFeedIfShared();
  // Walk backwards from the end of the feed, tagging consecutive manager
  // content entries (and any interleaved thinking/tool entries that belong
  // to the same turn). Stop at the first user message — that's the turn
  // boundary.
  for (let i = feed.length - 1; i >= 0; i--) {
    const entry = feed[i];
    if (entry.type === 'user_message') break;
    if (entry.type === 'content' && entry.agentId === 'kory-manager') {
      const meta = (entry.metadata ?? {}) as Record<string, unknown>;
      if (!meta.messageId) {
        meta.messageId = messageId;
        entry.metadata = meta;
      }
    }
  }
  rebuildGroupedFeedCache();
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
  persisted?: { messageId: string; createdAt: number; epoch?: number; sequence?: number },
) {
  if (!ownsFeed(sessionId)) return;
  detachFeedIfShared();
  if (
    persisted?.messageId &&
    feed.some((entry) => entry.metadata?.messageId === persisted.messageId)
  )
    return;
  const userEntry: FeedEntry = {
    id: persisted ? `hist-${persisted.messageId}` : nextFeedId('user'),
    timestamp: persisted?.createdAt ?? Date.now(),
    type: 'user_message',
    agentId: 'user',
    agentName: 'You',
    glowClass: '',
    text: content,
    metadata: {
      sessionId,
      attachments,
      messageId: persisted?.messageId,
      eventEpoch: persisted?.epoch,
      sequenceStart: persisted?.sequence,
      sequenceEnd: persisted?.sequence,
    },
  };
  feed.push(userEntry);
  if (feed.length > MAX_FEED_ENTRIES) feed.splice(0, feed.length - MAX_FEED_ENTRIES);
  feedVersion++;
  rebuildGroupedFeedCache();
}

/** Efficiently remove the ephemeral analyzing thought. */
function removeAnalyzingThoughtEntries() {
  if (!analyzingThoughtId) return;
  detachFeedIfShared();
  const idx = feed.findIndex((e) => e.id === analyzingThoughtId);
  if (idx !== -1) {
    feed.splice(idx, 1);
    feedVersion++;
    rebuildGroupedFeedCache();
  }
  analyzingThoughtId = null;
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

/** Provider signalled reasoning is over (content started / turn completed):
 * freeze matching live blocks at their server-timestamp duration. */
function finalizeThinking(agentId?: string, endedAt = Date.now()) {
  let changed = false;
  detachFeedIfShared();
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
  detachFeedIfShared();
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

/** Replace the live tool-call row as soon as its matching result arrives.
 * Keeping both rows made finished work look as though it were still running. */
function completeToolCall(
  toolResult: {
    callId: string;
    name: string;
    output: string;
    isError: boolean;
    durationMs: number;
  },
  text: string,
  timestamp: number,
  extraMetadata: Record<string, unknown> = {},
): boolean {
  detachFeedIfShared();
  const entry = feed.findLast(
    (candidate) =>
      candidate.type === 'tool_call' &&
      (candidate.metadata as { toolCall?: { id?: string } } | undefined)?.toolCall?.id ===
        toolResult.callId,
  );
  if (!entry) return false;

  entry.type = 'tool_result';
  entry.text = text;
  entry.timestamp = timestamp;
  entry.metadata = {
    ...entry.metadata,
    ...extraMetadata,
    // Keep the call's sequence as the visual position; the result's sequence
    // is the end of this causally bound operation.
    sequenceStart: entry.metadata?.sequenceStart ?? extraMetadata.sequenceStart,
    toolResult,
  };
  feedVersion++;
  rebuildGroupedFeedCache();
  return true;
}

/** Toggle entry visibility flags (user-hide is UI-only; agent-hide is set after the API call). */
function setEntryVisibility(id: string, patch: { userHidden?: boolean; agentHidden?: boolean }) {
  detachFeedIfShared();
  const entry = feed.find((e) => e.id === id);
  if (!entry) return;
  if (patch.userHidden !== undefined) entry.userHidden = patch.userHidden;
  if (patch.agentHidden !== undefined) entry.agentHidden = patch.agentHidden;
  feed = [...feed];
  feedVersion++;
  rebuildGroupedFeedCache();
}

function removeEntries(ids: Set<string>) {
  if (ids.size === 0) return;
  feed = feed.filter((e) => !ids.has(e.id));
  feedIsShared = false;
  feedVersion++;
  rebuildGroupedFeedCache();
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
  feedIsShared = false;
  feedVersion++;
  streamingRevision = 0;
  analyzingThoughtId = null;
  activeThinkingStartedAt.clear();
  rebuildGroupedFeedCache();
}

function isDuplicateError(text: string, timestamp: number): boolean {
  const last = feed.length > 0 ? feed[feed.length - 1] : null;
  return !!(last?.type === 'error' && last.text === text && timestamp - last.timestamp < 3000);
}

// ─── Grouped Feed (for virtual list) ─────────────────────────────────────────

function getToolName(entry: FeedEntry): string {
  const metadata = entry.metadata as
    | { toolCall?: { name?: string }; toolResult?: { name?: string } }
    | undefined;
  return metadata?.toolCall?.name ?? metadata?.toolResult?.name ?? '';
}

/** Agent ids that are NOT sub-agents (they render at top level). */
const TOP_LEVEL_AGENTS = new Set(['kory-manager', 'kory', 'user', 'system']);

export function getGroupedEntries(entries: FeedEntry[]): FeedEntry[] {
  const result: FeedEntry[] = [];
  let currentGroup: FeedEntry | null = null;
  let agentGroup: FeedEntry | null = null;

  for (const entry of entries) {
    // Keep worker events as individual, inspectable feed rows. A synthetic
    // "frontend — 1 step" wrapper hid the actual assignment and progress,
    // which made a live worker look like opaque background activity.
    const isSubAgent = !TOP_LEVEL_AGENTS.has(entry.agentId) && entry.type !== 'user_message';
    if (isSubAgent) {
      currentGroup = null;
      agentGroup = null;
      result.push(entry);
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

// ─── Session Loading ─────────────────────────────────────────────────────────

async function loadSessionMessages(
  sessionId: string,
  messages: Array<{
    id: string;
    role: string;
    content: string;
    createdAt: number;
    model?: string;
    provider?: string;
    cost?: number;
    variantGroupId?: string;
    variantIndex?: number;
    kind?: string;
  }>,
  options: {
    generation?: number;
    signal?: AbortSignal;
    onUsage?: (usage: {
      used: number;
      max: number;
      contextKnown: boolean;
      breakdown?: { system: number; memory: number; tools: number; chat: number };
    }) => void;
  } = {},
) {
  if (!ownsFeed(sessionId, options.generation)) return false;
  const loadGeneration = ++feedLoadGeneration;
  // Don't wipe the feed up front — that leaves a visible blank flash for the
  // whole round trip below. Keep every non-message operational event while
  // replacing persisted chat text. A completion refresh happens after later
  // turns too; retaining only the newest tail here used to erase reasoning
  // and tool proof from all earlier turns.
  const liveTailAtLoad = operationalEntriesForReload(feed);

  let timeline: Array<{ messageId?: string; hash?: string }> = [];
  let contextData: {
    lastUsage?: {
      used: number;
      max: number;
      contextKnown: boolean;
      breakdown?: { system: number; memory: number; tools: number; chat: number };
    } | null;
    data?: Array<{
      id: string;
      ts: number;
      kind: string;
      label: string;
      content: string;
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

  const variantsByGroup = new Map<string, typeof messages>();
  for (const message of messages) {
    if (!message.variantGroupId) continue;
    const variants = variantsByGroup.get(message.variantGroupId) ?? [];
    variants.push(message);
    variantsByGroup.set(message.variantGroupId, variants);
  }

  const baseMessages = messages.filter(
    (m) =>
      (!m.variantGroupId || (m.variantIndex ?? 0) === 0) &&
      // Never resurrect malformed/incomplete persisted assistant rows as an
      // empty Kory response after recovery. A real final response is always
      // non-blank (the backend supplies an explicit failure notice otherwise).
      (m.role !== 'assistant' || m.content.trim().length > 0),
  );
  const history = baseMessages.map((m, messageIndex) => {
    const followingAssistant =
      m.role === 'user'
        ? baseMessages.slice(messageIndex + 1).find((candidate) => candidate.role === 'assistant')
        : undefined;
    const replayModel =
      followingAssistant?.provider && followingAssistant.model
        ? `${followingAssistant.provider}:${followingAssistant.model}`
        : followingAssistant?.model;
    return {
      id: `hist-${m.id}`,
      timestamp: m.createdAt,
      // System rows are plain markers ("Stopped by user.") — not Kory speech.
      type:
        m.role === 'user'
          ? ('user_message' as const)
          : m.role === 'system'
            ? ('system' as const)
            : ('content' as const),
      agentId: m.role === 'user' ? 'user' : m.role === 'system' ? 'system' : 'kory-manager',
      agentName: m.role === 'user' ? 'You' : m.role === 'system' ? '' : 'Kory',
      glowClass: m.role === 'user' || m.role === 'system' ? '' : 'glow-kory',
      text: m.content,
      metadata: {
        sessionId,
        eventEpoch: undefined as number | undefined,
        sequenceStart: undefined as number | undefined,
        sequenceEnd: undefined as number | undefined,
        model: m.model ?? replayModel,
        cost: m.cost,
        messageId: m.id,
        kind: m.kind,
        variantGroupId: m.variantGroupId,
        responseVariants: m.variantGroupId
          ? (variantsByGroup.get(m.variantGroupId) ?? [])
              .sort((a, b) => (a.variantIndex ?? 0) - (b.variantIndex ?? 0))
              .map((variant) => ({
                id: variant.id,
                content: variant.content,
                model: variant.model,
                index: variant.variantIndex ?? 0,
              }))
          : [{ id: m.id, content: m.content, model: m.model, index: 0 }],
      },
      ghostHash: undefined,
    };
  });
  // Replayed operational rows carry the authoritative sequence. Transfer the
  // matching anchor onto persisted chat rows before the live duplicate is
  // removed, so a later history refresh cannot fall back to timestamp order.
  for (const entry of history) {
    const normalized = normalizeFeedText(entry.text);
    const candidates = liveTailAtLoad.filter((live) => {
      if (entry.type === 'user_message') {
        return (
          live.type === 'user_message' &&
          (live.metadata?.messageId === entry.metadata.messageId ||
            normalizeFeedText(live.text) === normalized)
        );
      }
      if (entry.type === 'content') {
        return (
          live.type === 'content' &&
          live.agentId === 'kory-manager' &&
          !!normalizeFeedText(live.text) &&
          normalized.includes(normalizeFeedText(live.text))
        );
      }
      return live.type === entry.type && normalizeFeedText(live.text) === normalized;
    });
    const ordered = candidates
      .map((candidate) => ({
        epoch: candidate.metadata?.eventEpoch,
        sequence: candidate.metadata?.sequenceStart,
      }))
      .filter(
        (value): value is { epoch: number; sequence: number } =>
          Number.isSafeInteger(value.epoch) && Number.isSafeInteger(value.sequence),
      )
      .sort((a, b) => a.sequence - b.sequence)[0];
    if (ordered) {
      entry.metadata.eventEpoch = ordered.epoch;
      entry.metadata.sequenceStart = ordered.sequence;
      entry.metadata.sequenceEnd = ordered.sequence;
    }
  }
  // The live tail holds the turn we just watched stream in (the user's
  // message via addUserMessage + Kory's reply via accumulateFeedEntry). By
  // the time we reload, that turn is persisted and present in `history`
  // above — keeping both would render the user's text and Kory's reply
  // twice. Drop the now-persisted text rows from the live tail, but keep
  // ephemeral rows (thinking, tool calls, tool results, system markers)
  // that aren't part of message history. Worker content is also kept:
  // only the manager's turns are persisted as session messages.
  // Build a set of persisted message IDs for ID-based dedup. When live feed
  // entries carry a messageId (tagged by tagManagerMessageId before reload),
  // we can match deterministically instead of comparing text.
  const persistedMessageIds = new Set<string>();
  const persistedTextKeys = new Set<string>();
  const persistedAssistantTexts: string[] = [];
  const persistedAssistantTextSet = new Set<string>();
  for (const m of messages) {
    if (m.variantGroupId && (m.variantIndex ?? 0) !== 0) continue;
    persistedMessageIds.add(m.id);
    persistedTextKeys.add(`${m.role}\u0000${normalizeFeedText(m.content)}`);
    if (m.role === 'assistant') {
      const normalized = normalizeFeedText(m.content);
      persistedAssistantTexts.push(normalized);
      persistedAssistantTextSet.add(normalized);
    }
  }
  const dedupedLiveTail = liveTailAtLoad.filter((entry) => {
    if (entry.type === 'user_message') {
      // User messages don't carry a messageId in the live feed, so text
      // matching is still the fallback here.
      return !persistedTextKeys.has(`user\u0000${normalizeFeedText(entry.text)}`);
    }
    if (entry.type === 'content' && entry.agentId === 'kory-manager') {
      // Prefer deterministic ID matching when available. Live entries tagged
      // by tagManagerMessageId will have metadata.messageId set.
      const liveMessageId = entry.metadata?.messageId as string | undefined;
      if (liveMessageId && persistedMessageIds.has(liveMessageId)) return false;
      // Fallback for entries without a messageId (e.g. older sessions loaded
      // before the tagging was added, or entries that arrived after tagging):
      // match by text containment as before.
      const text = normalizeFeedText(entry.text);
      if (!text) return true;
      if (persistedAssistantTextSet.has(text)) return false;
      return !persistedAssistantTexts.some((p) => p.includes(text));
    }
    return true;
  });
  // Text history is the critical path. Commit it immediately; timeline hashes
  // and archived tool proof enrich the same isolated session afterward.
  // Persisted text and live operational events are separate storage lanes,
  // not separate visual sections. Rebuild one causal timeline so reasoning
  // and tools cannot jump below the answer that followed them.
  feed = mergeFeedTimeline(history, dedupedLiveTail);
  feedIsShared = false;
  loadingSessionId = '';
  // Events appended after this point arrived while ancillary history was
  // loading. The already-retained live tail is carried explicitly below.
  feedTransitionBaseLength = feed.length;
  setCachedFeed(sessionId, feed);
  feedVersion++;
  streamingRevision = 0;
  analyzingThoughtId = null;
  rebuildGroupedFeedCache();

  const [timelineResult, contextResult] = await ancillary;
  if (
    options.signal?.aborted ||
    loadGeneration !== feedLoadGeneration ||
    !ownsFeed(sessionId, options.generation)
  )
    return true;
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
    if (
      contextData.lastUsage &&
      loadGeneration === feedLoadGeneration &&
      ownsFeed(sessionId, options.generation)
    ) {
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
            isError: false,
            durationMs: 0,
            archiveId: e.id,
          },
        },
      }));
    }
  } catch {
    /* archive unavailable — text history still loads */
  }
  if (loadGeneration !== feedLoadGeneration || !ownsFeed(sessionId, options.generation)) {
    return false;
  }

  const enrichedHistory = history.map((entry) => ({
    ...entry,
    ghostHash: timeline.find((item) => item.messageId === entry.metadata?.messageId)?.hash,
  }));
  const eventsSinceImmediateCommit = feed.slice(feedTransitionBaseLength);
  const retainedLiveEvents = [...dedupedLiveTail, ...eventsSinceImmediateCommit];
  const uniqueToolHistory = omitArchivedToolDuplicates(toolHistory, retainedLiveEvents);
  // Anything pushed onto the feed while we awaited (live stream events for
  // this session) belongs after history — everything before
  // feedLengthAtStart is stale (either the old session's content, on a
  // switch, or this same session's now-persisted turn) and gets replaced.
  // Preserve only events that arrived after the immediate text-history commit.
  // Cached pre-switch rows were replaced above and can never leak back in.
  feed = mergeFeedTimeline(enrichedHistory, uniqueToolHistory, retainedLiveEvents);
  feedIsShared = false;
  feedTransitionBaseLength = feed.length;
  setCachedFeed(sessionId, feed);
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
  accumulateFeedEntry,
  tagManagerMessageId,
  addUserMessage,
  removeAnalyzingThoughtEntries,
  addClientError,
  removeEntries,
  setEntryVisibility,
  finalizeThinking,
  beginThinking,
  getThinkingStart,
  updateToolCall,
  completeToolCall,
  removeContentEntriesForAgent,
  clearFeed,
  activateSessionFeed,
  finishSessionLoad,
  ownsFeed,
  loadSessionMessages,
  resolveGlowClass,
  getGroupedEntries,
  isDuplicateError,
  nextFeedId,
};
