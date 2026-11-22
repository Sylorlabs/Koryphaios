import { afterEach, describe, expect, it, vi } from 'vitest';
import { tooltipAnchorRect } from './tooltip-anchor';

function domRect(partial: {
  left: number;
  right: number;
  top: number;
  bottom: number;
}): DOMRect {
  return {
    ...partial,
    width: partial.right - partial.left,
    height: partial.bottom - partial.top,
  } as DOMRect;
}

function targetWith(rect: DOMRect): HTMLElement {
  const target = document.createElement('div');
  vi.spyOn(target, 'getBoundingClientRect').mockReturnValue(rect);
  return target;
}

function stubContentRange(rect: DOMRect): void {
  vi.spyOn(document, 'createRange').mockReturnValue({
    selectNodeContents: vi.fn(),
    getBoundingClientRect: () => rect,
  } as unknown as Range);
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('tooltipAnchorRect', () => {
  it('anchors to the content range inside a wide row', () => {
    const target = targetWith(domRect({ left: 0, right: 1000, top: 50, bottom: 74 }));
    stubContentRange(domRect({ left: 100, right: 300, top: 52, bottom: 70 }));
    expect(tooltipAnchorRect(target)).toEqual({
      left: 100,
      right: 300,
      top: 50,
      bottom: 74,
      width: 200,
      height: 24,
    });
  });

  it('falls back to the target rect when the content range is empty', () => {
    const rect = domRect({ left: 0, right: 1000, top: 50, bottom: 74 });
    const target = targetWith(rect);
    stubContentRange(domRect({ left: 0, right: 0, top: 0, bottom: 0 }));
    expect(tooltipAnchorRect(target)).toEqual({
      left: 0,
      right: 1000,
      top: 50,
      bottom: 74,
      width: 1000,
      height: 24,
    });
  });

  it('clamps a content range wider than the target', () => {
    const target = targetWith(domRect({ left: 0, right: 1000, top: 50, bottom: 74 }));
    stubContentRange(domRect({ left: -50, right: 2000, top: 40, bottom: 90 }));
    expect(tooltipAnchorRect(target)).toEqual({
      left: 0,
      right: 1000,
      top: 50,
      bottom: 74,
      width: 1000,
      height: 24,
    });
  });

  it('falls back to the target rect when the range lacks getBoundingClientRect', () => {
    const rect = domRect({ left: 0, right: 1000, top: 50, bottom: 74 });
    const target = targetWith(rect);
    vi.spyOn(document, 'createRange').mockReturnValue({
      selectNodeContents: vi.fn(),
    } as unknown as Range);
    expect(tooltipAnchorRect(target)).toEqual({
      left: 0,
      right: 1000,
      top: 50,
      bottom: 74,
      width: 1000,
      height: 24,
    });
  });
});
