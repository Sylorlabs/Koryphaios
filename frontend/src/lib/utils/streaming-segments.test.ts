import { describe, expect, it } from 'vitest';
import { computeStreamingSegments } from './streaming-segments';

describe('computeStreamingSegments', () => {
  it('returns empty for empty text', () => {
    expect(computeStreamingSegments('')).toEqual([]);
  });

  it('returns a single text segment for plain text with no fences', () => {
    const segs = computeStreamingSegments('Hello world');
    expect(segs).toHaveLength(1);
    expect(segs[0].kind).toBe('text');
    expect(segs[0].text).toBe('Hello world');
  });

  it('renders a completed color block mid-stream', () => {
    const text = 'Here are colors:\n```color\n#ff0000 Red\n#00ff00 Green\n```\nDone!';
    const segs = computeStreamingSegments(text);
    expect(segs).toHaveLength(3);
    expect(segs[0].kind).toBe('text');
    expect(segs[0].text).toBe('Here are colors:');
    expect(segs[1].kind).toBe('block');
    expect(segs[1].html).toContain('kory-color');
    expect(segs[1].html).toContain('background:#ff0000');
    expect(segs[2].kind).toBe('text');
    expect(segs[2].text).toBe('Done!');
  });

  it('treats an incomplete (unclosed) fence as raw text', () => {
    // The color block has no closing ``` — should be raw text, not rendered.
    const text = 'Colors:\n```color\n#ff0000 Red\n';
    const segs = computeStreamingSegments(text);
    expect(segs).toHaveLength(1);
    expect(segs[0].kind).toBe('text');
    expect(segs[0].text).toBe('Colors:\n```color\n#ff0000 Red\n');
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
    expect(segs[1].text).toBe(' between ');
    expect(segs[2].kind).toBe('block');
    expect(segs[2].html).toContain('kory-chart');
  });

  it('renders a completed block followed by an incomplete fence', () => {
    // First block is complete, second is still streaming (no closing fence).
    const text =
      '```color\n#f00 Red\n```\nMore:\n```html\n<div>unfinished';
    const segs = computeStreamingSegments(text);
    expect(segs).toHaveLength(2);
    expect(segs[0].kind).toBe('block');
    expect(segs[0].html).toContain('kory-color');
    // "More:" and the incomplete html fence merge into one text segment.
    expect(segs[1].kind).toBe('text');
    expect(segs[1].text).toContain('More:');
    expect(segs[1].text).toContain('```html');
    expect(segs[1].text).toContain('<div>unfinished');
  });

  it('leaves non-rich fences (e.g. python) as raw text', () => {
    const text = '```python\nprint("hi")\n```';
    const segs = computeStreamingSegments(text);
    expect(segs).toHaveLength(1);
    expect(segs[0].kind).toBe('text');
    expect(segs[0].text).toBe('```python\nprint("hi")\n```');
  });

  it('treats a malformed rich block (renderer returns null) as raw text', () => {
    // Invalid JSON for a chart block — renderer returns null.
    const text = '```chart\nnot json\n```';
    const segs = computeStreamingSegments(text);
    expect(segs).toHaveLength(1);
    expect(segs[0].kind).toBe('text');
    expect(segs[0].text).toContain('```chart');
    expect(segs[0].text).toContain('not json');
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
  });

  it('preserves newlines in raw text segments', () => {
    const text = 'line1\nline2\nline3';
    const segs = computeStreamingSegments(text);
    expect(segs).toHaveLength(1);
    expect(segs[0].text).toBe('line1\nline2\nline3');
  });
});
