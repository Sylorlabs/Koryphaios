// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import katex from 'katex';
import { clipboardMarkdown, richPasteToMarkdown } from './rich-paste';
import { renderChatMarkdown } from './chat-markdown';

function roundTrip(html: string): HTMLDivElement {
  const markdown = richPasteToMarkdown(html);
  expect(markdown).not.toBeNull();
  const el = document.createElement('div');
  el.innerHTML = renderChatMarkdown(markdown!);
  return el;
}

describe('rich clipboard conversion', () => {
  it('round-trips a ChatGPT-style Neptune document without duplicate equation glyphs', () => {
    const tex = String.raw`c = \sqrt{4495.10^2-4494.8152^2} = \boxed{50.60}`;
    const equation = katex.renderToString(tex, { displayMode: true });
    const html =
      '<h2>Neptune</h2>' +
      equation +
      '<table><thead><tr><th>Planet</th><th>a million km</th><th>Max km/s</th></tr></thead>' +
      '<tbody><tr><td>Neptune</td><td>4495.10</td><td>5.50</td></tr></tbody></table>' +
      '<ol><li>Draw <strong>elliptical</strong> orbits.</li><li>Put the Sun at a focus.</li></ol>';
    const el = roundTrip(html);
    expect(el.querySelector('h2')?.textContent).toBe('Neptune');
    expect(el.querySelectorAll('.katex')).toHaveLength(1);
    expect(el.querySelector('annotation')?.textContent).toBe(tex);
    expect(el.querySelectorAll('td')).toHaveLength(3);
    expect(el.querySelectorAll('li')).toHaveLength(2);
    expect(el.querySelector('strong')?.textContent).toBe('elliptical');
  });

  it('preserves nested lists, quote, links, inline math and code with backticks', () => {
    const el = roundTrip(
      '<blockquote>Quote</blockquote><ol start="3"><li>Third<ul><li>Nested</li></ul></li></ol>' +
        '<a href="https://example.com/path?q=1&amp;b=2">Source</a>' +
        katex.renderToString('e=0.0113') +
        '<pre><code class="language-js">const tick = `x`;</code></pre>',
    );
    expect(el.querySelector('blockquote')?.textContent?.trim()).toBe('Quote');
    expect(el.querySelector('ol')?.getAttribute('start')).toBe('3');
    expect(el.querySelector('ol ul li')?.textContent).toBe('Nested');
    expect(el.querySelector('a')?.getAttribute('href')).toBe('https://example.com/path?q=1&b=2');
    expect(el.querySelectorAll('.katex')).toHaveLength(1);
    expect(el.querySelector('code')?.textContent?.trim()).toBe('const tick = `x`;');
  });

  it('preserves literal Markdown punctuation and entities rather than introducing formatting', () => {
    const el = roundTrip(
      '<h2>Literal text</h2><p># title<br>- item<br>1. item<br>&amp;lt;img&amp;gt; *stars* $cash$</p>',
    );
    expect(el.querySelectorAll('h1, li, em, img, .katex')).toHaveLength(0);
    expect(el.textContent).toContain('&lt;img&gt; *stars* $cash$');
  });

  it('preserves pipes in table cells', () => {
    const el = roundTrip('<table><tr><th>Symbol</th></tr><tr><td>a | b</td></tr></table>');
    expect(el.querySelector('td')?.textContent).toBe('a | b');
  });

  it('does not mount scripts, image URLs or event handlers from pasted HTML', () => {
    const el = roundTrip(
      '<h2>Safe</h2><script>alert(1)</script><iframe src="https://evil.test"></iframe>' +
        '<a href="javascript:alert(1)">label</a><img src="https://evil.test" onerror="alert(1)" alt="diagram">',
    );
    expect(el.querySelector('script, iframe, img, [onerror], a')).toBeNull();
    expect(el.textContent).toContain('labeldiagram');
  });

  it.each([
    '',
    '<span>ordinary text</span>',
    '<img src="blob:screenshot">',
    '<h2>Math</h2><span class="katex"><span>x</span></span>',
    '<table><tr><td colspan="2">merged</td></tr></table>',
    '<div>'.repeat(105) + '<strong>deep</strong>' + '</div>'.repeat(105),
    'x'.repeat(1_000_001),
  ])('falls back to native paste when structure cannot be safely recovered (case %#)', (html) => {
    expect(richPasteToMarkdown(html)).toBeNull();
  });

  it('uses only text/html and leaves ordinary text paste alone', () => {
    expect(clipboardMarkdown({ getData: () => '' })).toBeNull();
    expect(
      clipboardMarkdown({ getData: (type) => (type === 'text/html' ? '<b>bold</b>' : '') }),
    ).toBe('**bold**');
  });
});
