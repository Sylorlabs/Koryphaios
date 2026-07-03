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

export function getGroupedEntries(entries: FeedEntry[]): FeedEntry[] {
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
  }>,
) {
  clearFeed();

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

  const history = messages.map((m) => {
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
      metadata: { sessionId, model: m.model, cost: m.cost },
      ghostHash: ghost?.hash,
    };
  });
  // Anything already in the feed streamed in live while we awaited the
  // timeline fetch (clearFeed ran at the top) — keep it after history
  // instead of wiping it.
  feed = [...history, ...feed];
  feedVersion++;
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
  removeContentEntriesForAgent,
  clearFeed,
  loadSessionMessages,
  resolveGlowClass,
  getGroupedEntries,
  isDuplicateError,
  nextFeedId,
};