import { describe, expect, it } from 'vitest';
import {
  segmentHtmlVisualSource,
  segmentMarkdownVisualSource,
  type VisualSourceSegment,
} from './skill-visual-segments';

function reconstructed(segments: VisualSourceSegment[]): string {
  return segments.map((segment) => segment.source).join('');
}

describe('skill visual source segmentation', () => {
  it('covers mixed Markdown exactly while isolating the unsupported block', () => {
    const locked = '\n\n:::custom\r\nraw  payload  \r\n:::\n\n';
    const source = `Editable intro${locked}Editable tail`;
    const segments = segmentMarkdownVisualSource(source);

    expect(segments.map((segment) => segment.kind)).toEqual(['editable', 'locked', 'editable']);
    expect(segments[1].source).toBe(locked);
    expect(reconstructed(segments)).toBe(source);
    expect(segments[0].start).toBe(0);
    expect(segments.at(-1)?.end).toBe(source.length);
  });

  it('locks known extension blocks that the stock CommonMark AST would flatten', () => {
    const cases = [
      '> [!NOTE]\n> Keep exact\n\nAfter',
      'Term\n: Definition\n\nAfter',
      '+++\ntitle = "Exact"\n+++\n\nAfter',
      '<![CDATA[exact]]>\n\nAfter',
      '```custom\nunclosed fence',
    ];

    for (const source of cases) {
      const segments = segmentMarkdownVisualSource(source);
      expect(segments.some((segment) => segment.kind === 'locked')).toBe(true);
      expect(reconstructed(segments)).toBe(source);
    }
  });

  it('does not classify extension-looking text inside a closed code fence as raw markup', () => {
    const source = '```md\n- [x] literal\n<section>literal</section>\n```\n\nAfter';
    expect(segmentMarkdownVisualSource(source)).toEqual([
      { kind: 'editable', source, start: 0, end: source.length },
    ]);
  });

  it('uses original HTML offsets for supported, raw, and supported siblings', () => {
    const locked =
      '\r\n<section data-mode="Exact"><custom-tag>Raw &amp; exact</custom-tag></section>\r\n';
    const source = `<p>Before</p>${locked}<p>After</p>`;
    const segments = segmentHtmlVisualSource(source, document);

    expect(segments.map((segment) => segment.kind)).toEqual(['editable', 'locked', 'editable']);
    expect(segments[1].source).toBe(locked);
    expect(reconstructed(segments)).toBe(source);
  });

  it('fails malformed and ambiguous HTML closed without losing any source bytes', () => {
    const cases = ['before</section>after', '<section', '</script><p>After</p>', '<![CDATA[x]]>'];
    for (const source of cases) {
      const segments = segmentHtmlVisualSource(source, document);
      expect(segments.some((segment) => segment.kind === 'locked')).toBe(true);
      expect(reconstructed(segments)).toBe(source);
    }
  });
});
