import { describe, expect, it } from 'bun:test';
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
