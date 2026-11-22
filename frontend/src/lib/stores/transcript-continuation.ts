import type { FeedEntry } from '$lib/types';

/**
 * Shared transcript-stream rules.
 *
 * The main feed and the agent drill-down render the same turn events through
 * different arrays but used to carry two copies of these decisions. A fix in
 * one copy silently left the other view wrong, which is exactly how a live row
 * and its drill-down disagreed. Both stores now use this module.
 */

/** Row types whose deltas continue an open row. */
export const TRANSCRIPT_CONTINUATION_TYPES: ReadonlySet<FeedEntry['type']> = new Set([
  'content',
  'thinking',
]);

export function isTranscriptContinuation(type: FeedEntry['type']): boolean {
  return TRANSCRIPT_CONTINUATION_TYPES.has(type);
}

/** Key for the row a (lane, type, visibility) delta is currently filling. */
export function continuationTargetKey(
  lane: string,
  type: FeedEntry['type'],
  userHidden: boolean | undefined,
): string {
  return `${lane}::${type}::${userHidden ? 'hidden' : 'visible'}`;
}

/**
 * Reasoning is a distinct transcript event: a burst after a tool call must open
 * a new row so event order survives. Content is allowed to continue across tool
 * activity, so only thinking is constrained to the immediately previous row.
 */
export function thinkingContinuesLatest(
  latest: FeedEntry | undefined,
  entry: FeedEntry,
): boolean {
  if (entry.type !== 'thinking') return true;
  return Boolean(
    latest &&
      latest.type === 'thinking' &&
      latest.agentId === entry.agentId &&
      Boolean(latest.userHidden) === Boolean(entry.userHidden),
  );
}

/**
 * The row this delta continues, or null when the turn has no open row.
 *
 * `floor` excludes rows before a hard boundary (a user message starts a new
 * turn). `recordedEntryId` is the row this lane was last filling; it wins over
 * the type scan so another agent's row landing mid-sentence cannot split it.
 */
export function findContinuationRow(
  entries: readonly FeedEntry[],
  entry: FeedEntry,
  options: { floor?: number; recordedEntryId?: string } = {},
): FeedEntry | null {
  if (!thinkingContinuesLatest(entries[entries.length - 1], entry)) return null;
  const floor = Math.max(0, options.floor ?? 0);

  if (options.recordedEntryId) {
    const at = entries.findIndex((row) => row.id === options.recordedEntryId);
    if (at >= floor) return entries[at]!;
  }

  for (let index = entries.length - 1; index >= floor; index--) {
    const row = entries[index]!;
    if (row.type === entry.type && row.agentId === entry.agentId) {
      return Boolean(row.userHidden) === Boolean(entry.userHidden) ? row : null;
    }
  }
  return null;
}

export interface ThinkingTimingUpdate {
  thinkingStartedAt?: number;
  durationMs?: number;
  thinkingFinalized?: boolean;
}

/**
 * Resume a live reasoning block. A replayed/sealed block that receives a later
 * live delta must re-open, or the drill-down stopwatch stops while the turn is
 * still running.
 */
export function resumeThinkingTiming(
  target: Pick<FeedEntry, 'thinkingStartedAt' | 'thinkingFinalized'>,
  entry: Pick<FeedEntry, 'timestamp' | 'thinkingFinalized'>,
): ThinkingTimingUpdate {
  const update: ThinkingTimingUpdate = {};
  if (entry.thinkingFinalized === undefined && target.thinkingFinalized) {
    update.thinkingFinalized = false;
  }
  if (target.thinkingStartedAt) {
    update.durationMs = entry.timestamp - target.thinkingStartedAt;
  } else {
    update.thinkingStartedAt = entry.timestamp;
  }
  return update;
}

/**
 * Freeze a reasoning block at a server timestamp. Never difference a server
 * start against the browser clock: that reports clock skew as reasoning time.
 */
export function frozenThinkingDuration(
  current: number | undefined,
  startedAt: number,
  endedAt: number,
): number {
  return Math.max(current ?? 0, endedAt - startedAt, 0);
}
