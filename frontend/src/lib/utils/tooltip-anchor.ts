/**
 * Tooltip anchor rect for a trigger element.
 *
 * Anchoring to the element's own bounding box floats the callout over empty
 * space whenever the trigger is a full-width row whose text only fills part
 * of it. A Range over the element's contents hugs the rendered text instead,
 * clamped back to the element so overflowing content cannot push the anchor
 * outside it.
 */
export function tooltipAnchorRect(target: HTMLElement): {
  left: number;
  right: number;
  top: number;
  bottom: number;
  width: number;
  height: number;
} {
  const t = target.getBoundingClientRect();
  const range = document.createRange();
  range.selectNodeContents(target);
  // jsdom's Range has no getBoundingClientRect; fall back to the element box.
  const c = typeof range.getBoundingClientRect === 'function' ? range.getBoundingClientRect() : null;
  if (c && c.width > 0 && c.height > 0) {
    const left = Math.max(c.left, t.left);
    const right = Math.min(c.right, t.right);
    if (right > left) {
      return { left, right, top: t.top, bottom: t.bottom, width: right - left, height: t.height };
    }
  }
  return {
    left: t.left,
    right: t.right,
    top: t.top,
    bottom: t.bottom,
    width: t.width,
    height: t.height,
  };
}
