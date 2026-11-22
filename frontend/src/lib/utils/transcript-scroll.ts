// Per-transcript reader position.
//
// A raw pixel offset is only meaningful while the same rows are loaded. A chat
// reopens from its newest page, so a deep parked position needs a row identity:
// save the row at the viewport top plus the offset inside it. The session sync
// uses `resumeMessageLimit` to fetch enough of the newest history to include
// that row in one request, and VirtualList puts the row back at the same screen
// position even if its measured height changed.

export interface TranscriptScrollState {
  scrollTop: number;
  follow: boolean;
  /** Row id at the viewport top when the reader parked mid-transcript. */
  anchorId?: string;
  /** Pixels from the row's top to the viewport top. */
  anchorOffset?: number;
  /** Rows between the anchor and the newest row when the position was saved. */
  rowsAfterAnchor?: number;
}

const STORAGE_KEY = 'koryphaios-transcript-scroll-v1';
const MAX_TRANSCRIPTS = 12;
/** Matches sessions.svelte.ts INITIAL_MESSAGE_PAGE_SIZE. */
const DEFAULT_PAGE_SIZE = 50;
/** One resume read may include the anchor and everything newer, up to this. */
export const MAX_RESUME_PAGE_SIZE = 1000;

function readStoredStates(): Map<string, TranscriptScrollState> {
  const states = new Map<string, TranscriptScrollState>();
  if (typeof localStorage === 'undefined') return states;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return states;
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return states;
    for (const [id, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (!id || !value || typeof value !== 'object') continue;
      const row = value as Record<string, unknown>;
      if (typeof row.scrollTop !== 'number' || !Number.isFinite(row.scrollTop)) continue;
      if (typeof row.follow !== 'boolean') continue;
      const state: TranscriptScrollState = {
        scrollTop: Math.max(0, row.scrollTop),
        follow: row.follow,
      };
      if (typeof row.anchorId === 'string' && row.anchorId) {
        state.anchorId = row.anchorId;
      }
      if (typeof row.anchorOffset === 'number' && Number.isFinite(row.anchorOffset)) {
        state.anchorOffset = row.anchorOffset;
      }
      if (
        typeof row.rowsAfterAnchor === 'number' &&
        Number.isSafeInteger(row.rowsAfterAnchor) &&
        row.rowsAfterAnchor >= 0
      ) {
        state.rowsAfterAnchor = row.rowsAfterAnchor;
      }
      states.set(id, state);
    }
  } catch {
    // Corrupt or unavailable storage just means no restored position.
    return new Map();
  }
  return states;
}

const scrollStates = readStoredStates();

function persist(): void {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(Object.fromEntries(scrollStates)));
  } catch {
    // Storage can be full or disabled; the in-memory position still works.
  }
}

export function getTranscriptScrollState(id: string): TranscriptScrollState | undefined {
  return id ? scrollStates.get(id) : undefined;
}

export function saveTranscriptScrollState(id: string, state: TranscriptScrollState): void {
  if (!id) return;
  const next: TranscriptScrollState = {
    scrollTop: Math.max(0, state.scrollTop),
    follow: state.follow,
  };
  if (state.anchorId) next.anchorId = state.anchorId;
  if (state.anchorOffset !== undefined && Number.isFinite(state.anchorOffset)) {
    next.anchorOffset = state.anchorOffset;
  }
  if (
    state.rowsAfterAnchor !== undefined &&
    Number.isSafeInteger(state.rowsAfterAnchor) &&
    state.rowsAfterAnchor >= 0
  ) {
    next.rowsAfterAnchor = state.rowsAfterAnchor;
  }
  // Re-inserting moves the transcript to the end, so eviction drops the least
  // recently opened one rather than an arbitrary one.
  scrollStates.delete(id);
  scrollStates.set(id, next);
  while (scrollStates.size > MAX_TRANSCRIPTS) {
    const oldest = scrollStates.keys().next();
    if (oldest.done) break;
    scrollStates.delete(oldest.value);
  }
  persist();
}

/**
 * Size the first history read for a parked reader.
 *
 * The newest page alone cannot contain an anchor that is hundreds of messages
 * back. Asking for the rows from the anchor through the newest row in one
 * request avoids paging backwards while the reader waits, and the adapter
 * pages further only if the position is beyond this bound.
 */
export function resumeMessageLimit(state: TranscriptScrollState | undefined): number | undefined {
  if (!state || state.follow || !state.anchorId) return undefined;
  const after = state.rowsAfterAnchor;
  if (after === undefined || !Number.isSafeInteger(after) || after < 0) return undefined;
  return Math.min(MAX_RESUME_PAGE_SIZE, Math.max(DEFAULT_PAGE_SIZE, after + DEFAULT_PAGE_SIZE + 1));
}
