import { describe, expect, it } from 'bun:test';
import {
  htmlSandboxPlaceholder,
  expandHtmlSandboxes,
  sandboxedHtml,
} from './html-sandbox';

describe('html-sandbox', () => {
  it('emits a DOMPurify-safe placeholder with base64 content', () => {
    const placeholder = htmlSandboxPlaceholder('<h1>Hi</h1>');
    expect(placeholder).toContain('class="kory-html-sandbox"');
    expect(placeholder).toContain('data-content="');
    expect(placeholder).not.toContain('<h1>');
  });

  it('round-trips Unicode content through encode/decode', () => {
    const placeholder = htmlSandboxPlaceholder('<p>✨ café — 你好</p>');
    const expanded = expandHtmlSandboxes(placeholder);
    expect(expanded).toContain('<iframe');
    expect(expanded).toContain('sandbox=""');
    expect(expanded).toContain('srcdoc="');
    // The decoded UTF-8 text survives inside the srcdoc (HTML-escaped tags).
    expect(expanded).toContain('✨ café — 你好');
    expect(expanded).toContain('&lt;p&gt;');
  });

  it('injects a strict CSP meta into the sandboxed document', () => {
    const expanded = expandHtmlSandboxes(htmlSandboxPlaceholder('<b>x</b>'));
    expect(expanded).toContain("Content-Security-Policy");
    expect(expanded).toContain("default-src 'none'");
  });

  it('escapes the srcdoc payload so attribute injection cannot occur', () => {
    const malicious = '<img src=x onerror="alert(1)">';
    const expanded = expandHtmlSandboxes(htmlSandboxPlaceholder(malicious));
    // The raw quote must not appear unescaped inside the srcdoc attribute.
    expect(expanded).toContain('&quot;');
    expect(expanded.slice(expanded.indexOf('srcdoc="') + 8)).not.toContain('"onerror');
  });

  it('leaves HTML without placeholders untouched', () => {
    const html = '<p>nothing to expand here</p>';
    expect(expandHtmlSandboxes(html)).toBe(html);
  });

  it('sandboxedHtml injects CSP into an existing <head> or prepends it', () => {
    expect(sandboxedHtml('<html><head><title>t</title></head></html>')).toContain(
      '<head><meta http-equiv="Content-Security-Policy"',
    );
    expect(sandboxedHtml('<div>no head</div>').startsWith('<meta')).toBe(true);
  });

  // DOMPurify can't run in bun (no DOM), so this test verifies the contract
  // structurally: the placeholder must be a bare <div> with only a class and
  // a data-* attribute — no nested elements, no event handlers, no scripts.
  // DOMPurify's default config allows <div> and data-* attributes, so this
  // shape passes through sanitize() unchanged. If this contract breaks, the
  // sandbox iframes will silently vanish after sanitization in FeedEntry.
  it('placeholder is sanitizer-safe by construction (DOMPurify contract)', () => {
    const placeholder = htmlSandboxPlaceholder('<script>alert(1)</script><b>hi</b>');

    // Must be a single <div> element with no children.
    expect(placeholder.startsWith('<div ')).toBe(true);
    expect(placeholder.endsWith('></div>')).toBe(true);

    // Must contain only class and data-content attributes — no event handlers,
    // no style, no src, no href, no script tags inside the div itself.
    expect(placeholder).not.toContain('<script');
    expect(placeholder).not.toMatch(/\son\w+=/i);
    expect(placeholder).not.toContain('src=');
    expect(placeholder).not.toContain('href=');
    expect(placeholder).not.toContain('style=');

    // The raw HTML payload must NOT appear in the placeholder — only base64.
    expect(placeholder).not.toContain('<script>alert');
    expect(placeholder).not.toContain('<b>hi</b>');

    // Verify the base64 decodes back to the original (round-trip integrity).
    const match = /data-content="([^"]*)"/.exec(placeholder);
    expect(match).not.toBeNull();
    const expanded = expandHtmlSandboxes(placeholder);
    expect(expanded).toContain('&lt;script&gt;');
  });

  it('expandHtmlSandboxes handles multiple placeholders in one document', () => {
    const html =
      htmlSandboxPlaceholder('<p>first</p>') +
      '<div>middle</div>' +
      htmlSandboxPlaceholder('<p>second</p>');
    const expanded = expandHtmlSandboxes(html);
    expect((expanded.match(/<iframe/g) ?? []).length).toBe(2);
    expect(expanded).toContain('first');
    expect(expanded).toContain('second');
    expect(expanded).toContain('<div>middle</div>');
  });
});
