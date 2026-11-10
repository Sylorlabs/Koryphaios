// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import {
  computeStreamingSegments,
  computeStreamingSegmentsIncrementalFast,
  computeStreamingSegmentsIncremental,
  type StreamingSegmentsSnapshot,
} from './streaming-segments';

describe('streaming fast path', () => {
  it('does not parse prose on every live update but still renders rich blocks', () => {
    const before = computeStreamingSegmentsIncrementalFast(null, 'Hello **world**\n');
    expect(before.segments[0]?.html).toBe('Hello **world**\n');

    const after = computeStreamingSegmentsIncrementalFast(
      before,
      'Hello **world**\n```color\n#ff0000 Red\n```\nDone',
    );
    expect(after.segments[0]?.html).toBe('Hello **world**');
    expect(after.segments[1]?.kind).toBe('block');
    expect(after.segments[1]?.html).toContain('kory-color');
    expect(after.segments[2]?.html).toBe('Done');
  });
});

describe('computeStreamingSegments', () => {
  it('returns empty for empty text', () => {
    expect(computeStreamingSegments('')).toEqual([]);
  });

  it('returns a single text segment for plain text with no fences', () => {
    const segs = computeStreamingSegments('Hello world');
    expect(segs).toHaveLength(1);
    expect(segs[0].kind).toBe('text');
    expect(segs[0].html).toBe('<p>Hello world</p>\n');
  });

  it('renders a completed color block mid-stream', () => {
    const text = 'Here are colors:\n```color\n#ff0000 Red\n#00ff00 Green\n```\nDone!';
    const segs = computeStreamingSegments(text);
    expect(segs).toHaveLength(3);
    expect(segs[0].kind).toBe('text');
    expect(segs[0].html).toBe('<p>Here are colors:</p>\n');
    expect(segs[1].kind).toBe('block');
    expect(segs[1].html).toContain('kory-color');
    expect(segs[1].html).toContain('background:#ff0000');
    expect(segs[2].kind).toBe('text');
    expect(segs[2].html).toBe('<p>Done!</p>\n');
  });

  it('treats an incomplete (unclosed) fence as raw text', () => {
    // The color block has no closing ``` — should be raw text, not rendered.
    const text = 'Colors:\n```color\n#ff0000 Red\n';
    const segs = computeStreamingSegments(text);
    expect(segs).toHaveLength(1);
    expect(segs[0].kind).toBe('text');
    expect(segs[0].html).toBe(
      '<p>Colors:</p>\n<pre><code class="language-color">#ff0000 Red\n</code></pre>\n',
    );
  });

  it('renders a completed chart block', () => {
    const text = '```chart\n{"type":"bar","labels":["A"],"datasets":[{"data":[1]}]}\n```';
    const segs = computeStreamingSegments(text);
    expect(segs).toHaveLength(1);
    expect(segs[0].kind).toBe('block');
    expect(segs[0].html).toContain('kory-chart');
  });

  it('renders a completed html sandbox block', () => {
    const text = '```html\n<div>Hi</div>\n```';
    const segs = computeStreamingSegments(text);
    expect(segs).toHaveLength(1);
    expect(segs[0].kind).toBe('block');
    expect(segs[0].html).toContain('<iframe');
    expect(segs[0].html).toContain('sandbox=""');
  });

  it('renders multiple completed blocks with text between them', () => {
    const text =
      '```color\n#f00 Red\n```\n between \n```chart\n{"type":"pie","labels":["X"],"datasets":[{"data":[1]}]}\n```';
    const segs = computeStreamingSegments(text);
    expect(segs).toHaveLength(3);
    expect(segs[0].kind).toBe('block');
    expect(segs[0].html).toContain('kory-color');
    expect(segs[1].kind).toBe('text');
    expect(segs[1].html).toBe('<p> between </p>\n');
    expect(segs[2].kind).toBe('block');
    expect(segs[2].html).toContain('kory-chart');
  });

  it('renders a completed block followed by an incomplete fence', () => {
    // First block is complete, second is still streaming (no closing fence).
    const text = '```color\n#f00 Red\n```\nMore:\n```html\n<div>unfinished';
    const segs = computeStreamingSegments(text);
    expect(segs).toHaveLength(2);
    expect(segs[0].kind).toBe('block');
    expect(segs[0].html).toContain('kory-color');
    // "More:" and the incomplete html fence merge into one text segment.
    expect(segs[1].kind).toBe('text');
    expect(segs[1].html).toContain('<p>More:</p>');
    expect(segs[1].html).toContain('&lt;div&gt;unfinished');
  });

  it('leaves non-rich fences (e.g. python) as raw text', () => {
    const text = '```python\nprint("hi")\n```';
    const segs = computeStreamingSegments(text);
    expect(segs).toHaveLength(1);
    expect(segs[0].kind).toBe('text');
    expect(segs[0].html).toBe('<pre><code class="language-python">print("hi")\n</code></pre>\n');
  });

  it('treats a malformed rich block (renderer returns null) as raw text', () => {
    // Invalid JSON for a chart block — renderer returns null.
    const text = '```chart\nnot json\n```';
    const segs = computeStreamingSegments(text);
    expect(segs).toHaveLength(1);
    expect(segs[0].kind).toBe('text');
    expect(segs[0].html).toContain('<pre><code class="language-chart">not json');
  });

  it('handles kory- prefixed language aliases', () => {
    const text = '```kory-color\n#f00 Red\n```';
    const segs = computeStreamingSegments(text);
    expect(segs).toHaveLength(1);
    expect(segs[0].kind).toBe('block');
    expect(segs[0].html).toContain('kory-color');
  });

  it('handles empty content in a completed block', () => {
    const text = '```color\n```';
    const segs = computeStreamingSegments(text);
    // Empty color input → renderer returns null → raw text.
    expect(segs).toHaveLength(1);
    expect(segs[0].kind).toBe('text');
    expect(segs[0].html).toBe('<pre><code class="language-color">\n</code></pre>\n');
  });

  it('preserves newlines in raw text segments', () => {
    const text = 'line1\nline2\nline3';
    const segs = computeStreamingSegments(text);
    expect(segs).toHaveLength(1);
    expect(segs[0].html).toBe('<p>line1\nline2\nline3</p>\n');
  });
});

describe('computeStreamingSegmentsIncremental', () => {
  const CHUNKED =
    'Intro text here\n```color\n#ff0000 Red\n#00ff00 Green\n```\nMiddle words\n```chart\n{"type":"bar","labels":["A"],"datasets":[{"data":[1]}]}\n```\nTrailing done!';

  function feedByChunks(text: string, chunkSize: number): StreamingSegmentsSnapshot {
    let snap: StreamingSegmentsSnapshot | null = null;
    for (let i = chunkSize; i < text.length; i += chunkSize) {
      snap = computeStreamingSegmentsIncremental(snap, text.slice(0, i));
    }
    return computeStreamingSegmentsIncremental(snap, text);
  }

  it('matches the full scan when fed token-by-token appends', () => {
    for (const chunkSize of [1, 7, 53]) {
      const snap = feedByChunks(CHUNKED, chunkSize);
      expect(snap.segments).toEqual(computeStreamingSegments(CHUNKED));
    }
  });

  it('keeps stable ids for completed blocks across appends', () => {
    const first = 'Before\n```color\n#f00 Red\n```\nAfter one';
    const second = `${first} After two`;
    const s1 = computeStreamingSegmentsIncremental(null, first);
    const s2 = computeStreamingSegmentsIncremental(s1, second);
    expect(s2.segments).toEqual(computeStreamingSegments(second));
    const block1 = s1.segments.find((s) => s.kind === 'block');
    const block2 = s2.segments.find((s) => s.kind === 'block');
    expect(block1).toBeDefined();
    // Same completed block keeps its id so keyed DOM nodes are not remounted.
    expect(block2?.id).toBe(block1?.id);
    expect(block2?.html).toBe(block1?.html);
  });

  it('renders a block the moment its closing fence streams in', () => {
    const open = 'Colors:\n```color\n#ff0000 Red\n';
    const closed = `${open}\`\`\`\nDone!`;
    const s1 = computeStreamingSegmentsIncremental(null, open);
    expect(s1.segments.every((s) => s.kind === 'text')).toBe(true);
    const s2 = computeStreamingSegmentsIncremental(s1, closed);
    expect(s2.segments).toEqual(computeStreamingSegments(closed));
    expect(s2.segments.some((s) => s.kind === 'block')).toBe(true);
  });

  it('falls back to a full scan on non-append edits', () => {
    const s1 = computeStreamingSegmentsIncremental(null, CHUNKED);
    const edited = `PREFIX EDIT\n${CHUNKED}`;
    const s2 = computeStreamingSegmentsIncremental(s1, edited);
    expect(s2.segments).toEqual(computeStreamingSegments(edited));
  });
});
