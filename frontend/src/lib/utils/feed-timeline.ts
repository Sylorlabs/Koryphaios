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
  // A history refresh can observe the same live row in both its initial
  // snapshot and the events that arrived while ancillary context was loading.
  // Feed IDs are canonical, so collapse those overlaps before Svelte receives
  // them; duplicate keyed rows otherwise crash the entire virtualized feed.
  const seenIds = new Set<string>();
  const merged = lanes.flat().filter((entry) => {
    if (seenIds.has(entry.id)) return false;
    seenIds.add(entry.id);
    return true;
  });

  return merged.sort(compareFeedChronology);
}

/**
 * The one chronology comparator for feed rows.
 *
 * Canonical (epoch, sequence) is the authority whenever both rows carry it,
 * because the backend assigns it at emission time. Wall-clock `timestamp` is
 * only a fallback: WebSocket delivery order is not the same thing as event
 * order. Replayed durable events arrive on subscribe and coalesced or
 * backpressured frames arrive late, so a row can reach a lane minutes after
 * the rows that followed it. Appending on arrival would place it below newer
 * work while still displaying its original time, which is the "skill row below
 * a later tool call" defect.
 */
export function compareFeedChronology(a: FeedEntryLocal, b: FeedEntryLocal): number {
  const aOrder = canonicalOrder(a);
  const bOrder = canonicalOrder(b);
  if (aOrder && bOrder && aOrder.epoch === bOrder.epoch) {
    const bySequence = aOrder.sequence - bOrder.sequence;
    if (bySequence !== 0) return bySequence;
  }
  const byTime = a.timestamp - b.timestamp;
  if (byTime !== 0) return byTime;

  // Persisted user input existed before operational events for its turn;
  // persisted assistant/system output is written only after those events.
  // Preserve live source order for every other same-millisecond collision.
  return persistedBoundaryRank(a) - persistedBoundaryRank(b);
}

/**
 * Insert `entry` at its chronological position instead of at the tail.
 *
 * A lane is kept sorted on every insert so an event that arrives late is
 * placed where it happened. Returns the index the entry occupies, so callers
 * can report and test position rather than only membership.
 */
export function insertByChronology(
  lane: FeedEntryLocal[],
  entry: FeedEntryLocal,
): number {
  let low = 0;
  let high = lane.length;
  while (low < high) {
    const mid = (low + high) >> 1;
    // `<= 0` keeps equal rows in arrival order rather than reversing them.
    if (compareFeedChronology(lane[mid], entry) <= 0) low = mid + 1;
    else high = mid;
  }
  lane.splice(low, 0, entry);
  return low;
}

function canonicalOrder(entry: FeedEntryLocal): { epoch: number; sequence: number } | null {
  const epoch = entry.metadata?.eventEpoch;
  const sequence = entry.metadata?.sequenceStart;
  return Number.isSafeInteger(epoch) && Number.isSafeInteger(sequence)
    ? { epoch: Number(epoch), sequence: Number(sequence) }
    : null;
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

/** Whether an entry is a transient analyzing thought that should never become permanent. */
export function isAnalyzingThought(entry: FeedEntryLocal): boolean {
  return (
    entry.type === 'thought' &&
    ((entry.metadata as { phase?: string } | undefined)?.phase === 'analyzing' ||
      entry.text === 'Preparing provider request...')
  );
}

/** Keep durable operational events while a message-history refresh replaces
 * persisted chat rows. A completed live row may already be tagged with its
 * persisted message id, so canonical sequence is the stronger discriminator.
 * Ephemeral analyzing thoughts must never be preserved across reload. */
export function operationalEntriesForReload(
  entries: ReadonlyArray<FeedEntryLocal>,
): FeedEntryLocal[] {
  return entries.filter(
    (entry) =>
      !isAnalyzingThought(entry) &&
      (Number.isSafeInteger(entry.metadata?.sequenceStart) ||
        typeof entry.metadata?.messageId !== 'string'),
  );
}

/** Remove the transient manager-analysis row even when a history refresh has
 * replaced its original client ID while Stop was in flight. */
export function withoutAnalyzingThoughts(
  entries: ReadonlyArray<FeedEntryLocal>,
  trackedId: string | null,
): FeedEntryLocal[] {
  return entries.filter(
    (entry) => entry.id !== trackedId && !isAnalyzingThought(entry),
  );
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
