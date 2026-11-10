import type { FeedEntryLocal } from '$lib/types';

// Row height estimates for the chat transcripts.
//
// Why this exists: a virtualized transcript can only lay out rows it has
// actually rendered. Every row it has not rendered is placed from an estimate,
// so the distance between two messages the reader has scrolled between is an
// estimate too — and when those rows are finally rendered and measured, the
// transcript's true height changes. The size of that change is the glitch a
// reader scrolling through a long chat feels as: the scroll extent jumps, the
// browser re-clamps the scroll offset, and the content lurches.
//
// So the estimate has to be close, not merely cheap. A flat "a content row is
// 120px" is not: a one-line answer really is ~45px and a markdown response with
// a code block and a table is well over 1000px, so a flat estimate is wrong by
// an order of magnitude on both ends and the errors accumulate along the
// whole transcript. Estimating from the row's own content size brings that
// error down to roughly a line of text per row.
//
// The rates below are derived from the transcript's own typography
// (`.markdown-content`: 14px type at 1.7 line-height ≈ 24px per line) and the
// width the feed renders at (~88 characters per line). They are deliberately
// not refined by a factor learned from measurements as they arrive: a factor
// that shifts every unrendered row's estimate mid-scroll moves the transcript's
// true height by far more than the error it removes.

/** `.markdown-content` line box: 14px × 1.7. */
const LINE_HEIGHT = 24;
/** Characters that fit across the feed at its rendered width. */
const CHARS_PER_LINE = 88;
/** Sub-agent and tool transcripts render narrower than the manager feed. */
const NARROW_CHARS_PER_LINE = 68;
/** Tool output and reasoning panels are clamped, so they stop growing. */
const CLAMPED_MAX = 520;
/** A reasoning panel is a header button on its own, and only becomes the text
 *  once it is opened. */
const THINKING_COLLAPSED = 48;
/** Sub-agent activity renders inside `max-h-56`. */
const AGENT_GROUP_MAX = 288;
/** Nothing in a transcript row is taller than this; a clamp beats a wild guess. */
const ROW_MAX = 4000;

function textLines(length: number, charsPerLine = CHARS_PER_LINE): number {
  return Math.ceil(length / charsPerLine);
}

function clamp(height: number): number {
  return Math.min(Math.max(height, 24), ROW_MAX);
}

/** Total text length of an entry, including the entries folded into a group. */
function contentLength(entry: FeedEntryLocal): number {
  if (typeof entry.text === 'string' && entry.text.length > 0) return entry.text.length;
  if (entry.entries && entry.entries.length > 0) {
    let total = 0;
    for (const child of entry.entries) total += contentLength(child);
    return total;
  }
  return 0;
}

function countEntries(entry: FeedEntryLocal): number {
  if (!entry.entries || entry.entries.length === 0) return 1;
  let total = 0;
  for (const child of entry.entries) total += countEntries(child);
  return total;
}

/**
 * Estimated rendered height of one transcript row, in CSS pixels.
 *
 * Shared by the manager feed and the per-agent threads so both transcripts
 * describe the same rows the same way.
 */
export function estimateFeedHeight(entry: FeedEntryLocal): number {
  switch (entry.type) {
    case 'user_message':
      // A bubble: padding around the text, and fewer characters per line
      // because the bubble carries its own inset.
      return clamp(48 + textLines(contentLength(entry), NARROW_CHARS_PER_LINE) * LINE_HEIGHT);

    case 'content':
    case 'error':
    case 'system':
      // Prose and code: paragraphs, lists and fenced blocks all wrap, and a
      // code block's lines are set a little tighter than prose.
      return clamp(32 + textLines(contentLength(entry)) * LINE_HEIGHT);

    case 'thought':
    case 'thinking':
      // Collapsed, a reasoning panel is a single header button — the text is
      // not rendered at all, so its length says nothing about its height.
      // Estimating from the text made a long collapsed thought look like a
      // tall one, which put hundreds of phantom pixels into the transcript's
      // height for every one of them.
      if (entry.isCollapsed) return THINKING_COLLAPSED;
      return Math.min(CLAMPED_MAX, clamp(40 + textLines(contentLength(entry)) * 20));

    case 'tool_call':
      // A card header with the tool's arguments folded away.
      return clamp(64 + textLines(contentLength(entry), NARROW_CHARS_PER_LINE) * 18);

    case 'tool_result':
      // Output is rendered into a clamped, scrollable panel.
      return Math.min(
        CLAMPED_MAX,
        clamp(56 + textLines(contentLength(entry), NARROW_CHARS_PER_LINE) * 18),
      );

    case 'tool_group':
      // One card per folded call, sharing one clamped panel.
      return Math.min(
        CLAMPED_MAX,
        clamp(
          56 +
            countEntries(entry) * 44 +
            textLines(contentLength(entry), NARROW_CHARS_PER_LINE) * 14,
        ),
      );

    case 'agent_group':
      // Sub-agent groups render as a clamped summary inside `max-h-56`, never
      // as a full transcript dump, so they stay short no matter how much
      // they contain.
      return Math.min(
        AGENT_GROUP_MAX,
        clamp(96 + textLines(contentLength(entry), NARROW_CHARS_PER_LINE) * 16),
      );

    case 'compaction':
    case 'routing':
      return clamp(72);

    default:
      return clamp(40 + textLines(contentLength(entry)) * LINE_HEIGHT);
  }
}
