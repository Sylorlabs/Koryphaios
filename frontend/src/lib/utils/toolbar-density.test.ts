import { describe, expect, it } from 'vitest';
import { chooseCollapse, collapsedRanks, fitsOnOneLine } from './toolbar-density';

interface Item {
  /** Width that stays visible when the label collapses (0 = the whole item is the label). */
  width: number;
  /** Extra width contributed by the label while it is shown (default 0). */
  label?: number;
  /** Collapse rank; omit for an element that never collapses. */
  rank?: number;
}

/** Builds a toolbar whose items report layout from a fake engine that reads the
 *  live `data-collapsed` state: an item is `width` plus `label` while shown, and
 *  an item that ends up zero wide is hidden. Items wrap left to right at
 *  `rowWidth`. Items listed with `group` sit inside a wrapping group element. */
function toolbar(rowWidth: number, items: Item[], { grouped = 0 } = {}) {
  const row = document.createElement('div');
  const group = document.createElement('div');
  group.setAttribute('data-collapse-group', '');
  const elements = items.map((spec, index) => {
    const el = document.createElement('button');
    if (spec.rank !== undefined) el.setAttribute('data-collapse-rank', String(spec.rank));
    (index >= items.length - grouped ? group : row).appendChild(el);
    return { el, spec };
  });
  row.appendChild(group);
  if (grouped === 0) group.remove();

  const widthOf = (el: HTMLElement, spec: Item) =>
    spec.width + (el.hasAttribute('data-collapsed') ? 0 : (spec.label ?? 0));

  const layout = () => {
    let x = 0;
    let line = 0;
    const tops = new Map<Element, number>();
    for (const { el, spec } of elements) {
      const width = widthOf(el, spec);
      if (width === 0) continue;
      if (x > 0 && x + width > rowWidth) {
        line += 1;
        x = 0;
      }
      tops.set(el, line * 40);
      x += width + 8;
    }
    return tops;
  };
  for (const { el, spec } of elements) {
    Object.defineProperty(el, 'offsetWidth', { get: () => widthOf(el, spec) });
    Object.defineProperty(el, 'offsetHeight', { get: () => (widthOf(el, spec) ? 36 : 0) });
    el.getBoundingClientRect = () =>
      ({ top: layout().get(el) ?? 0, height: 36 }) as DOMRect;
  }
  Object.defineProperty(group, 'offsetWidth', { get: () => 10 });
  Object.defineProperty(group, 'offsetHeight', { get: () => 36 });
  return row;
}

/** Ranked items with distinct label widths, plus one unranked item that always stays. */
const distinct: Item[] = [
  { width: 40, label: 100, rank: 1 },
  { width: 40, label: 100, rank: 2 },
  { width: 40, label: 10, rank: 3 },
  { width: 40, label: 100, rank: 4 },
  { width: 40, label: 100, rank: 5 },
  { width: 200 },
];

/** A composer-shaped row: eleven ranks, each label the same width, so the
 *  smallest-threshold fit is also the only one. */
const composer: Item[] = Array.from({ length: 11 }, (_, index) => ({
  width: 40,
  label: 100,
  rank: index + 1,
}));

function collapsedSet(row: HTMLElement): number[] {
  return collapsedRanks(row);
}

describe('toolbar collapse', () => {
  it('keeps every label when the row is wide enough', () => {
    const row = toolbar(2000, distinct);
    expect(chooseCollapse(row)).toBe(0);
    expect(collapsedSet(row)).toEqual([]);
    expect(row.getAttribute('data-collapse-max')).toBe('0');
  });

  it('collapses ranks in order as the row narrows', () => {
    // Equal label widths make each threshold the only fitting state, so the
    // collapsed set is always the prefix 1..k and the rank order is exact.
    // Rank r first collapses at the width where threshold r stops fitting.
    const firstAt = new Map<number, number>();
    for (let width = 1700; width >= 500; width -= 5) {
      const row = toolbar(width, composer);
      chooseCollapse(row);
      const collapsed = collapsedSet(row);
      expect(collapsed).toEqual(Array.from({ length: collapsed.length }, (_, i) => i + 1));
      for (const rank of collapsed) if (!firstAt.has(rank)) firstAt.set(rank, width);
    }
    const order = Array.from({ length: 11 }, (_, i) => firstAt.get(i + 1) ?? Infinity);
    for (let i = 1; i < order.length; i += 1) {
      expect(order[i]).toBeLessThan(order[i - 1] as number);
    }
  });

  it('collapses the critic (11) last and git (10) second-to-last', () => {
    const at = (width: number) => {
      const row = toolbar(width, composer);
      chooseCollapse(row);
      return collapsedSet(row);
    };
    // Git (10) is still shown whenever the critic (11) has not yet collapsed.
    for (let width = 1700; width >= 500; width -= 5) {
      const collapsed = at(width);
      if (collapsed.includes(11)) expect(collapsed).toContain(10);
      if (collapsed.includes(10)) expect(collapsed).toContain(9);
    }
    expect(at(620)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(at(600)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
  });

  it('refills freed space with a more important label before hiding it', () => {
    // Everything shown is 850px. Collapsing ranks 1..4 leaves 540px, and only
    // ranks 1..5 fit a 500px row, so k = 5. Refilling from the top keeps rank 3
    // (10px) because 1, 2, 4 and 5 still leave room for it.
    const row = toolbar(500, distinct);
    expect(chooseCollapse(row)).toBe(5);
    expect(collapsedSet(row)).toEqual([1, 2, 4, 5]);
    expect(row.getAttribute('data-collapse-max')).toBe('5');
    expect(fitsOnOneLine(row)).toBe(true);
  });

  it('collapses a shared rank as one group', () => {
    // Rank 2 is a label plus its chevron: both must go together.
    const items: Item[] = [
      { width: 40, label: 0 },
      { width: 0, label: 100, rank: 2 },
      { width: 0, label: 14, rank: 2 },
      { width: 40, label: 0 },
      { width: 40, label: 0, rank: 1 },
    ];
    for (const width of [400, 220, 150]) {
      const row = toolbar(width, items);
      chooseCollapse(row);
      const label = row.querySelector('[data-collapse-rank="2"]') as HTMLElement;
      const chevron = row.querySelectorAll('[data-collapse-rank="2"]')[1] as HTMLElement;
      expect(label.hasAttribute('data-collapsed')).toBe(chevron.hasAttribute('data-collapsed'));
    }
  });

  it('is deterministic: the same width always yields the same state', () => {
    const row = toolbar(500, distinct);
    chooseCollapse(row);
    const first = collapsedSet(row);
    // Start from a different state: everything collapsed, then a stray attribute.
    for (const el of Array.from(row.querySelectorAll('[data-collapse-rank]'))) {
      el.setAttribute('data-collapsed', '');
    }
    chooseCollapse(row);
    expect(collapsedSet(row)).toEqual(first);
    // And from nothing collapsed.
    for (const el of Array.from(row.querySelectorAll('[data-collapsed]'))) {
      el.removeAttribute('data-collapsed');
    }
    chooseCollapse(row);
    expect(collapsedSet(row)).toEqual(first);
  });

  it('treats a wrapped nested group as not fitting', () => {
    // The last two items sit in a group that wraps onto a second line.
    const row = toolbar(300, [{ width: 200 }, { width: 200 }, { width: 200 }], { grouped: 2 });
    expect(fitsOnOneLine(row)).toBe(false);
  });
});
