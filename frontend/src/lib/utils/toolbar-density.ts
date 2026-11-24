/**
 * Priority-ordered toolbar collapse.
 *
 * Every collapsible element carries `data-collapse-rank="N"`. Lower N collapses
 * first; elements that share a rank collapse together as one group (a label
 * and its chevron, for example). A collapsed element gets the boolean attribute
 * `data-collapsed`, and CSS decides what that means from `data-collapse-mode`:
 *
 * - `hide` (default): the element is `display: none`.
 * - `truncate`: the element is capped at a short width and ellipsised.
 * - `swap`: the element swaps its long text for a short word (critic trigger).
 *
 * The fit is greedy and synchronous, and it always starts from "nothing
 * collapsed", so one width always produces one state whatever the previous
 * state was:
 *
 * 1. If the row fits with every label shown, stop.
 * 2. Otherwise find the smallest threshold k such that collapsing every group
 *    with rank <= k fits. If no threshold fits, collapse everything.
 * 3. Refill: for r = k down to the least rank, un-collapse group r and keep it
 *    shown if the row still fits. Freed space is therefore never wasted on a
 *    lower-priority label when a more important one would fit.
 *
 * `data-collapse-max` on the row records k for debugging.
 *
 * Width changes are fitted synchronously inside the ResizeObserver callback,
 * so a resize never paints a frame at the wrong state. The observed target is a
 * zero-height sentinel: collapsing labels changes the row's height but never the
 * sentinel's size, so fitting inside the callback cannot trigger a
 * ResizeObserver loop. Label text changes are re-fitted on the next frame.
 */

const RANK_ATTR = 'data-collapse-rank';
const COLLAPSED_ATTR = 'data-collapsed';
const GROUP_ATTR = 'data-collapse-group';
const IGNORE_ATTR = 'data-collapse-ignore';

/** The items whose vertical position decides whether the row wrapped. Nested
 *  wrapping rows (marked `data-collapse-group`) contribute their own children.
 *  An element with no box (display: none) is not an item. */
function lineItems(row: HTMLElement): HTMLElement[] {
  const items: HTMLElement[] = [];
  for (const child of Array.from(row.children)) {
    if (!(child instanceof HTMLElement)) continue;
    if (child.hasAttribute(IGNORE_ATTR)) continue;
    if (child.offsetWidth === 0 && child.offsetHeight === 0) continue;
    if (child.hasAttribute(GROUP_ATTR)) items.push(...lineItems(child));
    else items.push(child);
  }
  return items;
}

/** True when every visible item sits on the same line. */
export function fitsOnOneLine(row: HTMLElement): boolean {
  const items = lineItems(row);
  if (items.length < 2) return true;
  const rects = items.map((item) => item.getBoundingClientRect());
  const firstTop = Math.min(...rects.map((rect) => rect.top));
  const lowestTop = Math.max(...rects.map((rect) => rect.top));
  const tallest = Math.max(...rects.map((rect) => rect.height));
  // Items on one line can differ in height and alignment; a wrapped item
  // starts at least one full item below the first line.
  return lowestTop - firstTop < tallest / 2;
}

/** Every distinct rank present in the row, ascending. */
function ranksIn(row: HTMLElement): number[] {
  const ranks = new Set<number>();
  for (const el of Array.from(row.querySelectorAll<HTMLElement>(`[${RANK_ATTR}]`))) {
    const rank = Number(el.getAttribute(RANK_ATTR));
    if (Number.isInteger(rank)) ranks.add(rank);
  }
  return [...ranks].sort((a, b) => a - b);
}

/** Writes the collapsed state: every element whose rank is in `collapsed` gets
 *  `data-collapsed`, every other ranked element loses it. */
export function applyCollapse(row: HTMLElement, collapsed: ReadonlySet<number>): void {
  for (const el of Array.from(row.querySelectorAll<HTMLElement>(`[${RANK_ATTR}]`))) {
    const rank = Number(el.getAttribute(RANK_ATTR));
    if (collapsed.has(rank)) el.setAttribute(COLLAPSED_ATTR, '');
    else el.removeAttribute(COLLAPSED_ATTR);
  }
}

/** Ranks currently collapsed, read back from the DOM. */
export function collapsedRanks(row: HTMLElement): number[] {
  const ranks = new Set<number>();
  for (const el of Array.from(
    row.querySelectorAll<HTMLElement>(`[${RANK_ATTR}][${COLLAPSED_ATTR}]`),
  )) {
    ranks.add(Number(el.getAttribute(RANK_ATTR)));
  }
  return [...ranks].sort((a, b) => a - b);
}

/** Fits the row by the greedy rule above and leaves it in the chosen state.
 *  Returns the threshold k (0 when nothing collapsed). */
export function chooseCollapse(row: HTMLElement): number {
  const ranks = ranksIn(row);
  const upTo = (limit: number) => new Set(ranks.filter((rank) => rank <= limit));

  applyCollapse(row, new Set());
  if (fitsOnOneLine(row) || ranks.length === 0) {
    row.setAttribute('data-collapse-max', '0');
    return 0;
  }

  // Smallest threshold whose collapse fits. If none does, collapse everything.
  let threshold = ranks[ranks.length - 1] ?? 0;
  for (const rank of ranks) {
    applyCollapse(row, upTo(rank));
    if (fitsOnOneLine(row)) {
      threshold = rank;
      break;
    }
  }

  // Refill from most important (threshold) to least, keeping each group that fits.
  const kept = upTo(threshold);
  for (const rank of ranks.filter((r) => r <= threshold).reverse()) {
    kept.delete(rank);
    applyCollapse(row, kept);
    if (!fitsOnOneLine(row)) {
      kept.add(rank);
    }
  }
  applyCollapse(row, kept);
  row.setAttribute('data-collapse-max', String(threshold));
  return threshold;
}

/** Svelte action: keeps `row` fitted on one line. */
export function toolbarCollapse(node: HTMLElement) {
  let frame = 0;

  const fit = () => {
    frame = 0;
    chooseCollapse(node);
  };
  // Run in the next frame, before paint: trial states are never shown.
  const schedule = () => {
    if (frame === 0 && typeof requestAnimationFrame === 'function') {
      frame = requestAnimationFrame(fit);
    }
  };

  if (getComputedStyle(node).position === 'static') node.style.position = 'relative';
  const sentinel = document.createElement('div');
  sentinel.setAttribute('aria-hidden', 'true');
  sentinel.setAttribute(IGNORE_ATTR, '');
  sentinel.style.cssText =
    'position:absolute;inset-inline:0;top:0;height:0;visibility:hidden;pointer-events:none;';
  node.appendChild(sentinel);

  fit();
  let lastWidth = -1;
  const observer =
    typeof ResizeObserver === 'function'
      ? new ResizeObserver((entries) => {
          const width = entries[entries.length - 1]?.contentRect.width ?? 0;
          if (width === lastWidth) return;
          lastWidth = width;
          if (frame !== 0) {
            cancelAnimationFrame(frame);
            frame = 0;
          }
          fit();
        })
      : null;
  observer?.observe(sentinel);
  // Labels change (model renamed, branch loaded, a control appears): re-fit,
  // since a shorter label may now fit more of the row.
  const mutations =
    typeof MutationObserver === 'function'
      ? new MutationObserver((records) => {
          if (records.every((record) => record.target === sentinel)) return;
          schedule();
        })
      : null;
  mutations?.observe(node, { childList: true, subtree: true, characterData: true });
  void document.fonts?.ready.then(schedule);

  return {
    destroy() {
      if (frame !== 0) cancelAnimationFrame(frame);
      observer?.disconnect();
      mutations?.disconnect();
      sentinel.remove();
    },
  };
}
