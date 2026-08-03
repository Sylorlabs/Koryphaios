import type { FeedEntryLocal } from '$lib/types';

/**
 * Merge independently loaded transcript lanes into one stable chronology.
 *
 * WebSocket delivery is ordered, but persisted messages, live reasoning, and
 * archived tools are loaded from separate sources. Concatenating those lanes
 * makes an assistant answer appear before the reasoning/tools that produced it.
 * Array.sort is stable in supported runtimes, so equal timestamps retain the
 * source order supplied by the caller.
 */
export function mergeFeedTimeline(
  ...lanes: ReadonlyArray<ReadonlyArray<FeedEntryLocal>>
): FeedEntryLocal[] {
  return lanes.flat().sort((a, b) => {
    const byTime = a.timestamp - b.timestamp;
    if (byTime !== 0) return byTime;

    // Persisted user input existed before operational events for its turn;
    // persisted assistant/system output is written only after those events.
    // Preserve live source order for every other same-millisecond collision.
    return persistedBoundaryRank(a) - persistedBoundaryRank(b);
  });
}

function persistedBoundaryRank(entry: FeedEntryLocal): number {
  if (typeof entry.metadata?.messageId !== 'string') return 0;
  return entry.type === 'user_message' ? -1 : 1;
}

function archivedToolId(entry: FeedEntryLocal): string | undefined {
  if (entry.type !== 'tool_result') return undefined;
  return (entry.metadata as { toolResult?: { archiveId?: string } } | undefined)?.toolResult
    ?.archiveId;
}

/**
 * Archived context and the live WebSocket result can describe the same tool
 * execution. Keep the live row: it has the provider label and real duration,
 * while the archive is a reload fallback with a synthetic zero duration.
 */
export function omitArchivedToolDuplicates(
  archived: ReadonlyArray<FeedEntryLocal>,
  live: ReadonlyArray<FeedEntryLocal>,
): FeedEntryLocal[] {
  const liveArchiveIds = new Set(live.map(archivedToolId).filter((id): id is string => !!id));
  if (liveArchiveIds.size === 0) return [...archived];
  return archived.filter((entry) => {
    const archiveId = archivedToolId(entry);
    return !archiveId || !liveArchiveIds.has(archiveId);
  });
}

/** Finalize reasoning inside a per-agent transcript when its next action lands. */
export function finalizeThinkingEntries(
  entries: ReadonlyArray<FeedEntryLocal>,
  agentId: string,
  endedAt: number,
): FeedEntryLocal[] {
  let changed = false;
  const next = entries.map((entry) => {
    if (entry.type !== 'thinking' || entry.agentId !== agentId || entry.thinkingFinalized) {
      return entry;
    }
    changed = true;
    const durationMs =
      entry.thinkingStartedAt === undefined
        ? entry.durationMs
        : Math.max(entry.durationMs ?? 0, endedAt - entry.thinkingStartedAt);
    return { ...entry, durationMs, thinkingFinalized: true };
  });
  return changed ? next : [...entries];
}
