// Feed Store — handles feed entries and message display
// Split from the monolithic websocket.svelte.ts for better separation of concerns

import type { AgentIdentity } from '@koryphaios/shared';
import type { FeedEntry, FeedEntryType } from '$lib/types';
import { sessionStore } from './sessions.svelte';
import { apiUrl } from '$lib/utils/api-url';
import { apiFetch, parseJsonResponse } from '$lib/api.svelte';

export type { FeedEntry, FeedEntryType };

// ─── Constants ──────────────────────────────────────────────────────────────

const EPHEMERAL_TOOLS = new Set(['ls', 'read_file', 'grep', 'glob']);
const MAX_FEED_ENTRIES = 2000;
let feedIdCounter = 0;

// ─── Reactive State ──────────────────────────────────────────────────────────

let feed = $state<FeedEntry[]>([]);

// Cache for grouped feed — rebuild only on structural changes, not per token
let lastGroupedFeed = $state<FeedEntry[]>([]);
let feedVersion = $state(0);
let streamingRevision = $state(0);

// Track analyzing thought index to avoid O(N) filtering
let analyzingThoughtId = $state<string | null>(null);

function rebuildGroupedFeedCache(): void {
  lastGroupedFeed = getGroupedEntries(feed);
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
    case 'glow-codex': return 'frontend';
    case 'glow-google': return 'backend';
    case 'glow-test': return 'test';
    case 'glow-claude': return 'general';
    default: return 'general';
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
  if (newEntry.type === 'thought' && (newEntry.metadata as { phase?: string })?.phase === 'analyzing') {
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
    // keep updating as new deltas land.
    if (entry.metadata && Object.keys(entry.metadata).length > 0) {
      updates.metadata = { ...last.metadata, ...entry.metadata };
    }

    Object.assign(last, updates);
    patchGroupedFeedEntry(last.id, last.text, last.timestamp, updates);
    streamingRevision++;
  } else {
    addFeedEntry(entry);
  }
}

function addUserMessage(
  sessionId: string,
  content: string,
  attachments?: Array<{ type: string; data: string; name: string }>,
) {
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

/** Efficiently remove the ephemeral analyzing thought. */
function removeAnalyzingThoughtEntries() {
  if (!analyzingThoughtId) return;
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

/** Persist the client-observed thinking duration — monotonic max, so a
 *  virtual-list remount can never show a smaller number than the user saw. */
function recordThinkingDuration(id: string, ms: number) {
  const entry = feed.find((e) => e.id === id);
  if (!entry || ms <= (entry.durationMs ?? 0)) return;
  entry.durationMs = ms;
  feed = [...feed];
  feedVersion++;
  rebuildGroupedFeedCache();
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
    // Sub-agent entries get a clear, expanded-by-default grouping so spawned
    // workers never look like stray manager output.
    const isSubAgent = !TOP_LEVEL_AGENTS.has(entry.agentId) && entry.type !== 'user_message';
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
  }>,
) {
  // Don't wipe the feed up front — that leaves a visible blank flash for the
  // whole round trip below. Instead remember where "new" entries begin and
  // swap everything in atomically once the fetched history is ready.
  const feedLengthAtStart = feed.length;

  let timeline: Array<{ messageId?: string; hash?: string }> = [];
  try {
    const res = await apiFetch(apiUrl(`/api/sessions/${sessionId}/timetravel`));
    const data = await parseJsonResponse<{ ok?: boolean; data?: { timeline?: typeof timeline } }>(
      res,
    );
    if (data.ok) timeline = data.data?.timeline ?? [];
  } catch (err) {
    console.warn('Failed to fetch timeline:', err);
  }

  // The user may have switched to another session while the timeline
  // fetch was in flight; writing this (now stale) history would show the
  // wrong chat's messages in the current chat.
  if (sessionStore.activeSessionId !== sessionId) return;

  const variantsByGroup = new Map<string, typeof messages>();
  for (const message of messages) {
    if (!message.variantGroupId) continue;
    const variants = variantsByGroup.get(message.variantGroupId) ?? [];
    variants.push(message);
    variantsByGroup.set(message.variantGroupId, variants);
  }

  const history = messages.filter((m) => !m.variantGroupId || (m.variantIndex ?? 0) === 0).map((m) => {
    const ghost = timeline.find((t) => t.messageId === m.id);

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
      },
      ghostHash: ghost?.hash,
    };
  });
  // Restore archived tool activity (tool runs aren't part of message history —
  // without this, reopening a chat silently dropped all proof-of-work).
  let toolHistory: FeedEntry[] = [];
  try {
    const res = await apiFetch(apiUrl(`/api/sessions/${sessionId}/context`));
    const data = await parseJsonResponse<{
      ok?: boolean;
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
    }>(res);
    if (data.ok && data.lastUsage && sessionStore.activeSessionId === sessionId) {
      const { seedManagerUsage } = await import('./agents.svelte');
      seedManagerUsage(sessionId, data.lastUsage);
    }
    if (data.ok && Array.isArray(data.data)) {
      toolHistory = data.data.map((e) => ({
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
  if (sessionStore.activeSessionId !== sessionId) return;

  const merged = [...history, ...toolHistory].sort((a, b) => a.timestamp - b.timestamp);
  // Anything pushed onto the feed while we awaited (live stream events for
  // this session) belongs after history — everything before
  // feedLengthAtStart is stale (either the old session's content, on a
  // switch, or this same session's now-persisted turn) and gets replaced.
  feed = [...merged, ...feed.slice(feedLengthAtStart)];
  feedVersion++;
  streamingRevision = 0;
  analyzingThoughtId = null;
  rebuildGroupedFeedCache();
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
  addFeedEntry,
  accumulateFeedEntry,
  addUserMessage,
  removeAnalyzingThoughtEntries,
  addClientError,
  removeEntries,
  setEntryVisibility,
  recordThinkingDuration,
  removeContentEntriesForAgent,
  clearFeed,
  loadSessionMessages,
  resolveGlowClass,
  getGroupedEntries,
  isDuplicateError,
  nextFeedId,
};
