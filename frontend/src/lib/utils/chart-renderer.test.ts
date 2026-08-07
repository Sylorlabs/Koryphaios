import { describe, expect, it } from 'vitest';
import { renderKoryChart } from './chart-renderer';

describe('renderKoryChart', () => {
  it('renders bar, line, and pie chart specifications as accessible SVG', () => {
    for (const type of ['bar', 'line', 'pie']) {
      const html = renderKoryChart(JSON.stringify({
        type,
        title: `${type} example`,
        labels: ['Alpha', 'Beta'],
        datasets: [{ label: 'Score', data: [4, 9] }],
      }));
      expect(html).toContain('class="kory-chart"');
      expect(html).toContain('<svg');
      expect(html).toContain('role="img"');
    }
  });

  it('supports compact point data and escapes agent-controlled labels', () => {
    const html = renderKoryChart(JSON.stringify({
      type: 'bar',
      data: [{ label: '<script>alert(1)</script>', value: 3 }],
    }));
    expect(html).toContain('&lt;script&gt;');
    expect(html).not.toContain('<script>');
  });

  it('rejects malformed or unsupported chart blocks', () => {
    expect(renderKoryChart('not json')).toBeNull();
    expect(renderKoryChart('{"type":"scatter","labels":["A"],"datasets":[{"data":[1]}]}')).toBeNull();
  });
});

describe('adversarial chart spec injection', () => {
  it('escapes SVG XSS payloads in labels', () => {
    const html = renderKoryChart(JSON.stringify({
      type: 'bar',
      labels: ['<svg><script>alert(1)</script></svg>'],
      datasets: [{ label: 'S', data: [1] }],
    }));
    expect(html).not.toBeNull();
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;');
  });

  it('escapes data: URL payloads in labels', () => {
    const html = renderKoryChart(JSON.stringify({
      type: 'bar',
      labels: ['data:image/svg+xml,<script>alert(1)</script>'],
      datasets: [{ label: 'S', data: [1] }],
    }));
    expect(html).not.toBeNull();
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;');
  });

  it('does not allow __proto__ or constructor.prototype pollution', () => {
    const spec = JSON.stringify({
      type: 'bar',
      labels: ['A'],
      datasets: [{ data: [1] }],
      __proto__: { polluted: true },
      constructor: { prototype: { polluted2: true } },
    });
    const html = renderKoryChart(spec);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(({} as Record<string, unknown>).polluted2).toBeUndefined();
    // The chart still renders normally.
    expect(html).toContain('class="kory-chart"');
  });

  it('filters out NaN/Infinity values in data arrays', () => {
    const html = renderKoryChart(JSON.stringify({
      type: 'bar',
      labels: ['A', 'B', 'C'],
      datasets: [{ label: 'S', data: [1, NaN, Infinity] }],
    }));
    // finiteNumber() drops NaN and Infinity; only [1] survives → pointCount=1.
    expect(html).not.toBeNull();
    expect(html).not.toContain('NaN');
    expect(html).not.toContain('Infinity');
  });

  it('handles a very large dataset (1000+ points) without crashing', () => {
    const labels = Array.from({ length: 1000 }, (_, i) => `L${i}`);
    const data = Array.from({ length: 1000 }, (_, i) => i);
    const start = Date.now();
    const html = renderKoryChart(JSON.stringify({
      type: 'line',
      labels,
      datasets: [{ label: 'S', data }],
    }));
    const elapsed = Date.now() - start;
    expect(html).not.toBeNull();
    expect(html).toContain('class="kory-chart"');
    // pointCount is capped at 48, so this should be fast.
    expect(elapsed).toBeLessThan(2000);
  });

  it('escapes labels with newlines and control characters', () => {
    const html = renderKoryChart(JSON.stringify({
      type: 'bar',
      labels: ['A\nB\r\tC\x00'],
      datasets: [{ data: [1] }],
    }));
    expect(html).not.toBeNull();
    // No unescaped HTML metacharacters reach the output (the label is
    // rendered inside an SVG <text> element, fully escaped).
    expect(html).not.toContain('<script');
    expect(html).not.toContain('<img');
    // Control characters (NUL, BEL, etc.) are now stripped by escapeHtml.
    expect(html).not.toContain('\x00');
  });

  it('labels with control characters are stripped', () => {
    // FIXED: escapeHtml() now strips C0 control characters (NUL, BEL, etc.)
    // and bidi override characters before escaping HTML metacharacters.
    const html = renderKoryChart(JSON.stringify({
      type: 'bar',
      labels: ['A\x00B\x07C'],
      datasets: [{ data: [1] }],
    }));
    expect(html).not.toContain('\x00');
    expect(html).not.toContain('\x07');
  });

  it('escapes labels with bidi override characters', () => {
    const html = renderKoryChart(JSON.stringify({
      type: 'bar',
      labels: ['\u202e<script>alert(1)</script>'],
      datasets: [{ data: [1] }],
    }));
    expect(html).not.toBeNull();
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;');
  });

  it('escapes XSS payloads in the title field', () => {
    const html = renderKoryChart(JSON.stringify({
      type: 'bar',
      title: '<img src=x onerror=alert(1)>',
      labels: ['A'],
      datasets: [{ data: [1] }],
    }));
    expect(html).not.toBeNull();
    // No unescaped <img tag reaches the output.
    expect(html).not.toContain('<img src=x onerror=alert(1)>');
    expect(html).not.toContain('<img');
    // The payload is HTML-escaped — the word "onerror" appears only as
    // inert escaped text content, not as a live attribute.
    expect(html).toContain('&lt;img');
    expect(html).toContain('onerror=alert(1)&gt;');
  });

  it('handles empty labels array with non-empty data array', () => {
    const html = renderKoryChart(JSON.stringify({
      type: 'bar',
      labels: [],
      datasets: [{ label: 'S', data: [1, 2, 3] }],
    }));
    // pointCount = min(48, 0, 3) = 0 → returns null (no crash).
    expect(html).toBeNull();
  });

  it('handles mismatched labels/data lengths gracefully', () => {
    // More labels than data points.
    const html = renderKoryChart(JSON.stringify({
      type: 'bar',
      labels: ['A', 'B', 'C', 'D'],
      datasets: [{ label: 'S', data: [1, 2] }],
    }));
    // pointCount = min(48, 4, 2) = 2 → renders 2 points, no crash.
    expect(html).not.toBeNull();
    expect(html).toContain('class="kory-chart"');
  });
});
