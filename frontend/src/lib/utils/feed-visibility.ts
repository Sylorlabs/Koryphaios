import type { FeedEntry } from '$lib/types';

export type FeedTombstoneVisibility = 'hidden' | 'deleted';

export interface FeedVisibilityRecord {
  targetKey: string;
  visibility: FeedTombstoneVisibility;
}

interface EventRange {
  epoch: number;
  start: number;
  end: number;
}

const SIMPLE_IDENTIFIER = /^[A-Za-z0-9_-]{1,256}$/;

function stringValue(value: unknown): string | null {
  return typeof value === 'string' && SIMPLE_IDENTIFIER.test(value) ? value : null;
}

function eventRangeFor(entry: FeedEntry): EventRange | null {
  const epoch = Number(entry.metadata?.eventEpoch);
  const start = Number(entry.metadata?.sequenceStart);
  const end = Number(entry.metadata?.sequenceEnd ?? start);
  if (
    !Number.isSafeInteger(epoch) ||
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(end) ||
    epoch < 1 ||
    start < 1 ||
    end < start
  ) {
    return null;
  }
  return { epoch, start, end };
}

function eventTargetKey(range: EventRange): string {
  return `event:${range.epoch}:${range.start}:${range.end}`;
}

function parseEventTargetKey(targetKey: string): EventRange | null {
  const match = /^event:([1-9]\d*):([1-9]\d*):([1-9]\d*)$/.exec(targetKey);
  if (!match) return null;
  const epoch = Number(match[1]);
  const start = Number(match[2]);
  const end = Number(match[3]);
  if (
    !Number.isSafeInteger(epoch) ||
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(end) ||
    start > end
  ) {
    return null;
  }
  return { epoch, start, end };
}

/** Stable IDs for every durable feed source represented by one rendered row. */
export function feedTargetKeysForEntry(entry: FeedEntry): string[] {
  const keys = new Set<string>();
  const visit = (candidate: FeedEntry) => {
    const metadata = candidate.metadata;
    const messageId = stringValue(metadata?.messageId);
    if (messageId) keys.add(`message:${messageId}`);

    const archiveId = stringValue(
      (metadata?.toolResult as { archiveId?: unknown } | undefined)?.archiveId,
    );
    if (archiveId) keys.add(`archive:${archiveId}`);

    const threadEntryId = stringValue(metadata?.threadEntryId);
    if (threadEntryId) keys.add(`thread:${threadEntryId}`);

    const clientEntryId = stringValue(metadata?.clientEntryId);
    if (clientEntryId) keys.add(`client:${clientEntryId}`);

    const range = eventRangeFor(candidate);
    if (range) keys.add(eventTargetKey(range));

    for (const child of candidate.entries ?? []) visit(child);
  };
  visit(entry);
  return [...keys];
}

function visibilityForEntry(
  entry: FeedEntry,
  tombstones: ReadonlyMap<string, FeedTombstoneVisibility>,
): FeedTombstoneVisibility | undefined {
  let hidden = false;
  for (const key of feedTargetKeysForEntry({ ...entry, entries: undefined })) {
    const visibility = tombstones.get(key);
    if (visibility === 'deleted') return 'deleted';
    if (visibility === 'hidden') hidden = true;
  }

  const entryRange = eventRangeFor(entry);
  if (entryRange) {
    for (const [key, visibility] of tombstones) {
      const targetRange = parseEventTargetKey(key);
      if (
        !targetRange ||
        targetRange.epoch !== entryRange.epoch ||
        targetRange.end < entryRange.start ||
        targetRange.start > entryRange.end
      ) {
        continue;
      }
      if (visibility === 'deleted') return 'deleted';
      hidden = true;
    }
  }

  if (entry.entries?.length) {
    const childVisibilities = entry.entries.map((child) => visibilityForEntry(child, tombstones));
    if (childVisibilities.length && childVisibilities.every((visibility) => visibility === 'deleted')) {
      return 'deleted';
    }
    if (childVisibilities.length && childVisibilities.every((visibility) => visibility)) {
      hidden = true;
    }
  }
  return hidden ? 'hidden' : undefined;
}

/** Apply immutable server-backed visibility state before a feed is rendered. */
export function applyFeedVisibility(
  entries: readonly FeedEntry[],
  records: readonly FeedVisibilityRecord[],
): FeedEntry[] {
  const tombstones = new Map(records.map((record) => [record.targetKey, record.visibility]));
  const visit = (entry: FeedEntry): FeedEntry | null => {
    // Determine the parent state from the original tree.  If every child was
    // deleted, filtering them first would leave an empty group that no longer
    // carries enough information to conclude the group is deleted too.
    const visibility = visibilityForEntry(entry, tombstones);
    if (visibility === 'deleted') return null;
    const children = entry.entries?.map(visit).filter((child): child is FeedEntry => child !== null);
    const candidate = children ? { ...entry, entries: children } : entry;
    // A stale local `userHidden` must not outlive an explicit Show action. For
    // rows without a durable identity preserve its current in-memory value.
    const hasDurableTarget = feedTargetKeysForEntry(candidate).length > 0;
    if (visibility === 'hidden' || (hasDurableTarget && candidate.userHidden)) {
      return { ...candidate, userHidden: visibility === 'hidden' };
    }
    return candidate;
  };
  return entries.map(visit).filter((entry): entry is FeedEntry => entry !== null);
}

export function makeClientFeedEntryId(): string {
  const id = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return `client-error-${id.replace(/[^A-Za-z0-9_-]/g, '')}`;
}
