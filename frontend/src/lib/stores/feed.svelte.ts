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
let feedIdCounter = 0;

// ─── Reactive State ──────────────────────────────────────────────────────────

let feed = $state<FeedEntry[]>([]);
let feedSessionId = $state('');
let loadingSessionId = $state('');
let feedTransitionGeneration = 0;
let feedTransitionBaseLength = 0;
const sessionFeedCache = new Map<string, FeedEntry[]>();

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
  if (!ownsFeed(sessionId)) return;
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

function upsertCompaction(payload: CompactionProgressPayload) {
  if (!ownsFeed(payload.sessionId)) return;
  const existing = feed.find(
    (entry) => entry.type === 'compaction' && entry.metadata?.compactionId === payload.compactionId,
  );
  const metadata = { ...payload } as unknown as Record<string, unknown>;
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

/** Toggle entry visibility flags (user-hide is UI-only; agent-hide is set after the API call). */
function setEntryVisibility(id: string, patch: { userHidden?: boolean; agentHidden?: boolean }) {
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

export function getGroupedEntries(entries: FeedEntry[]): FeedEntry[] {
  const result: FeedEntry[] = [];
  let currentGroup: FeedEntry | null = null;
  let agentGroup: FeedEntry | null = null;

  for (const entry of entries) {
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
    cost?: number;
    variantGroupId?: string;
    variantIndex?: number;
    attachments?: Array<{ type: 'image' | 'file'; data: string; name: string; mimeType?: string }>;
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
  // Don't wipe the feed up front — that leaves a visible blank flash for the
  // whole round trip below. Instead remember where "new" entries begin and
  // swap everything in atomically once the fetched history is ready.
  const liveTailAtLoad = feed.slice(feedTransitionBaseLength);

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

  const history = messages
    .filter((m) => !m.variantGroupId || (m.variantIndex ?? 0) === 0)
    .map((m) => {
      const isCompaction = m.role === 'system' && m.content.startsWith('[KORY_COMPACTION]');
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
          cost: m.cost,
          messageId: m.id,
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
  for (const m of messages) {
    if (m.variantGroupId && (m.variantIndex ?? 0) !== 0) continue;
    persistedTextKeys.add(`${m.role}\u0000${normalizeFeedText(m.content)}`);
    if (m.role === 'assistant') persistedAssistantTexts.push(normalizeFeedText(m.content));
  }
  const dedupedLiveTail = liveTailAtLoad.filter((entry) => {
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
  feed = [...history, ...dedupedLiveTail];
  loadingSessionId = '';
  feedTransitionBaseLength = history.length;
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
  if (!ownsFeed(sessionId, options.generation)) return false;

  const enrichedHistory = history.map((entry) => ({
    ...entry,
    ghostHash: timeline.find((item) => item.messageId === entry.metadata?.messageId)?.hash,
  }));
  const liveOperational = operationalEntriesForReload(feed.slice(feedTransitionBaseLength));
  const archivedWithoutLiveDuplicates = omitArchivedToolDuplicates(toolHistory, liveOperational);
  const merged = mergeFeedTimeline(enrichedHistory, archivedWithoutLiveDuplicates, liveOperational);
  // Anything pushed onto the feed while we awaited (live stream events for
  // this session) belongs after history — everything before
  // feedLengthAtStart is stale (either the old session's content, on a
  // switch, or this same session's now-persisted turn) and gets replaced.
  // Preserve only events that arrived after the immediate text-history commit.
  // Cached pre-switch rows were replaced above and can never leak back in.
  feed = [...merged, ...feed.slice(feedTransitionBaseLength)];
  feedTransitionBaseLength = merged.length;
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
  accumulateFeedEntry,
  addUserMessage,
  removeAnalyzingThoughtEntries,
  addClientError,
  upsertCompaction,
  hasPersistedAssistantContaining,
  removeEntries,
  setEntryVisibility,
  finalizeThinking,
  beginThinking,
  getThinkingStart,
  updateToolCall,
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
