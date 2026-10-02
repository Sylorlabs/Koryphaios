// Reader-initiated expansions (a reasoning panel, a tool's output, a
// compaction summary) grow the feed row they live in, which pushes every
// message below it down and off the screen — the reader then has to scroll
// down again just to get back to what they were reading. The transcript
// absorbs that growth into its own scroll offset instead, so the content
// below the expansion keeps its screen position while the expansion opens
// above it.
//
// The request is a bubbling DOM event rather than a callback because the
// control that expands has no reference to the transcript that owns the
// scroll container. The event reaches the virtualized row it sits in, which
// does know that row's position and the viewport's, and can therefore
// decide whether compensating the scroll is the reader's intent (a
// deliberate expansion) or would fight them (passive growth such as a
// streaming row).
export const EXPAND_ANCHOR_EVENT = 'koryphaios:expand-anchor';

/**
 * Ask the surrounding transcript to keep the content below this element
 * anchored while it grows. Call it from the click handler, before the
 * expansion is applied.
 */
export function requestExpandAnchor(node: EventTarget | null | undefined): void {
  node?.dispatchEvent(new CustomEvent(EXPAND_ANCHOR_EVENT, { bubbles: true }));
}
