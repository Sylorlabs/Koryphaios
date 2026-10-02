// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { marked } from 'marked';
import { createChatMarkdown, renderChatMarkdown } from './chat-markdown';
import { computeStreamingSegments } from './streaming-segments';

function dom(source: string): HTMLDivElement {
  const el = document.createElement('div');
  el.innerHTML = renderChatMarkdown(source);
  return el;
}

describe('native chat Markdown', () => {
  it.each([
    '$e = 0.0113$',
    String.raw`\(e = 0.0113\)`,
    '$$\nc = \\sqrt{a^2-b^2}\n$$',
    String.raw`\[v = \frac{2\pi ab}{Tr_p}\]`,
    '```math\n\\boxed{5.50 \\text{ km/s}}\n```',
    '```latex\nx^2\n```',
    '```tex\nx^2\n```',
  ])('renders equation syntax %s with accessible source', (source) => {
    const el = dom(source);
    expect(el.querySelector('.katex')).not.toBeNull();
    expect(el.querySelector('math annotation[encoding="application/x-tex"]')).not.toBeNull();
    expect(el.querySelector('.katex-error')).toBeNull();
  });

  it.each([
    String.raw`$$ T=\sqrt{a^3} $$ $$ T=\sqrt{(0.3870)^3} $$ $$ T=0.24078\text{ years} $$`,
    String.raw`\[ T=\sqrt{a^3} \] \[ T=\sqrt{(0.3870)^3} \] \[ T=0.24078\text{ years} \]`,
  ])(
    'renders consecutive display equations separately instead of swallowing delimiters (%#)',
    (source) => {
      for (const html of [
        renderChatMarkdown(source),
        computeStreamingSegments(source)
          .map((s) => s.html)
          .join(''),
      ]) {
        const el = document.createElement('div');
        el.innerHTML = html;
        expect(el.querySelector('.katex-error')).toBeNull();
        expect(el.querySelectorAll('.katex-display')).toHaveLength(3);
        expect(Array.from(el.querySelectorAll('annotation'), (node) => node.textContent)).toEqual([
          String.raw`T=\sqrt{a^3}`,
          String.raw`T=\sqrt{(0.3870)^3}`,
          String.raw`T=0.24078\text{ years}`,
        ]);
      }
    },
  );

  it('keeps prose between and after display equations outside the math', () => {
    const el = dom(String.raw`$$x^2$$ then $$y^3$$ after.`);
    expect(el.querySelector('.katex-error')).toBeNull();
    expect(el.querySelectorAll('.katex')).toHaveLength(2);
    expect(Array.from(el.querySelectorAll('annotation'), (node) => node.textContent)).toEqual([
      'x^2',
      'y^3',
    ]);
    expect(el.textContent).toContain('then');
    expect(el.textContent).toContain('after.');
  });

  it('keeps completed equations valid while the next equation streams in', () => {
    const source = String.raw`$$x^2$$ $$\frac{y}{2}$$`;
    for (let length = '$$x^2$$'.length; length <= source.length; length++) {
      const el = dom(source.slice(0, length));
      expect(el.querySelector('.katex-error')).toBeNull();
      expect(el.querySelector('annotation')?.textContent).toBe('x^2');
    }
    expect(dom(source).querySelectorAll('.katex')).toHaveLength(2);
  });

  it('keeps currency, escaped dollars and code literal', () => {
    const el = dom('Costs $5 and $10. Escaped \\$x\\$. `\\(x\\)`\n\n```js\nconst x = "$x$";\n```');
    expect(el.querySelector('.katex')).toBeNull();
    expect(el.querySelectorAll('code')).toHaveLength(2);
    expect(el.textContent).toContain('Costs $5 and $10.');
  });

  it('preserves headings, lists, inline math and aligned tables', () => {
    const el = dom(
      '# Neptune\n\n1. Orbit\n2. Speed\n\n| Planet | $a$ |\n| --- | ---: |\n| Neptune | 4495.10 |',
    );
    expect(el.querySelector('h1')?.textContent).toBe('Neptune');
    expect(el.querySelectorAll('li')).toHaveLength(2);
    expect(el.querySelectorAll('.kory-table-scroll table th')).toHaveLength(2);
    expect(el.querySelector('th .katex')).not.toBeNull();
    expect(el.querySelector('td[align="right"]')?.textContent).toBe('4495.10');
  });

  it('recovers from incomplete or invalid math without breaking surrounding prose', () => {
    expect(dom('Before \\(unfinished').textContent).toContain('unfinished');
    const el = dom('Before\n\n$\\frac{x$\n\nAfter');
    expect(el.querySelector('.katex-error')).not.toBeNull();
    expect(el.textContent).toContain('After');
    expect(dom('$$x^2$$').querySelector('.katex')).not.toBeNull();
  });

  it('sanitizes raw HTML and untrusted TeX without weakening sandboxed HTML', () => {
    const el = dom(
      '<img src="x" onerror="alert(1)"><script>alert(1)</script>\n\n' +
        String.raw`\(\href{javascript:alert(1)}{click}\)` +
        '\n\n```html\n<script>alert(1)</script><h1>Isolated</h1>\n```',
    );
    expect(el.querySelector('script, [onerror], a[href^="javascript:"]')).toBeNull();
    const frame = el.querySelector('iframe');
    expect(frame?.getAttribute('sandbox')).toBe('');
    expect(frame?.getAttribute('srcdoc')).toContain("default-src 'none'");
  });

  it('renders existing charts/colors and math in streaming segments', () => {
    const source =
      'Equation \\(x^2\\)\n\n```color\n#abcdef Sky\n```\n\n' +
      '```chart\n{"type":"bar","labels":["N"],"datasets":[{"label":"speed","data":[5.5]}]}\n```';
    expect(renderChatMarkdown(source)).toContain('kory-color');
    expect(renderChatMarkdown(source)).toContain('kory-chart');
    const stream = computeStreamingSegments(source)
      .map((segment) => segment.html)
      .join('');
    expect(stream).toContain('katex');
    expect(stream).toContain('kory-chart');
    expect(stream).toContain('kory-color');
  });

  it('does not mutate global marked or other feed parsers', () => {
    const before = marked.parse('$$x^2$$');
    const a = createChatMarkdown();
    a.use({ renderer: { paragraph: () => '<p>custom</p>' } });
    expect(createChatMarkdown().parse('hello')).toBe('<p>hello</p>\n');
    expect(marked.parse('$$x^2$$')).toBe(before);
  });
});
