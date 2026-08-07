import { describe, expect, it } from 'vitest';
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

describe('adversarial XSS and CSP bypass attempts', () => {
  it('neutralizes data: URL injection in srcdoc', () => {
    const malicious = '<iframe srcdoc="data:text/html,<script>alert(1)</script>"></iframe>';
    const expanded = expandHtmlSandboxes(htmlSandboxPlaceholder(malicious));
    // The malicious payload is HTML-escaped inside the outer srcdoc attribute,
    // so the inner data: URL cannot execute as a nested browsing context.
    expect(expanded).toContain('<iframe');
    expect(expanded).not.toContain('srcdoc="data:text/html');
    // No unescaped <script> reaches the output.
    expect(expanded).not.toContain('<script>alert(1)</script>');
  });

  it('preserves strict CSP against meta tag override attempts', () => {
    // Attacker tries to inject a permissive CSP meta to weaken the sandbox.
    const malicious = `<meta http-equiv="Content-Security-Policy" content="default-src 'unsafe-inline'">`;
    const expanded = expandHtmlSandboxes(htmlSandboxPlaceholder(malicious));
    // The strict CSP is always injected first (sandboxedHtml prepends it).
    // Browsers enforce multiple CSP metas additively (most restrictive wins),
    // so the strict `default-src 'none'` still holds even if the attacker's
    // meta is rendered as a real tag inside the iframe.
    expect(expanded).toContain("default-src 'none'");
    const cspIdx = expanded.indexOf("default-src 'none'");
    // The attacker's meta is HTML-escaped within srcdoc (no unescaped <meta).
    expect(expanded).not.toContain('<meta http-equiv="Content-Security-Policy"');
    // The strict CSP must appear before any attacker-controlled content.
    const attackerIdx = expanded.indexOf("unsafe-inline'");
    if (attackerIdx !== -1) expect(cspIdx).toBeLessThan(attackerIdx);
  });

  it('neutralizes CSS expression() injection via sandbox + CSP', () => {
    const malicious = '<div style="width:expression(alert(1))">x</div>';
    const expanded = expandHtmlSandboxes(htmlSandboxPlaceholder(malicious));
    // expression() has no HTML metacharacters so it survives as text inside
    // the escaped srcdoc. It is neutralized by the sandbox attribute (no
    // scripts) and CSP (default-src 'none'), not by string removal.
    expect(expanded).toContain('sandbox=""');
    expect(expanded).toContain("default-src 'none'");
    // No unescaped <div or style attribute breaks out of the srcdoc boundary.
    expect(expanded).not.toContain('<div style="width:expression');
    const afterSrcdoc = expanded.slice(expanded.indexOf('srcdoc="') + 8);
    // No unescaped double-quote that could close the srcdoc attribute early.
    expect(afterSrcdoc).not.toContain('"x</div>');
  });

  it('renders CSS @import injection as inert escaped text', () => {
    const malicious = `<style>@import 'evil.css'</style>`;
    const expanded = expandHtmlSandboxes(htmlSandboxPlaceholder(malicious));
    // The @import is escaped inside srcdoc; even if rendered, the strict CSP
    // (default-src 'none') blocks stylesheet fetches. Verify no break-out.
    expect(expanded).not.toContain(`<style>@import 'evil.css'</style>`);
    // No unescaped quote that could close the srcdoc attribute early.
    const afterSrcdoc = expanded.slice(expanded.indexOf('srcdoc="') + 8);
    expect(afterSrcdoc).not.toContain(`'<`);
  });

  it('neutralizes CSS url(javascript:) injection via sandbox + CSP', () => {
    const malicious = `<div style="background:url(javascript:alert(1))">x</div>`;
    const expanded = expandHtmlSandboxes(htmlSandboxPlaceholder(malicious));
    // url(javascript:) has no HTML metacharacters so it survives as text in
    // the escaped srcdoc. It is neutralized by CSP (default-src 'none') and
    // the sandbox attribute (no scripts), not by string removal.
    expect(expanded).toContain('sandbox=""');
    expect(expanded).toContain("default-src 'none'");
    // No unescaped <div breaks out of the srcdoc attribute boundary.
    expect(expanded).not.toContain('<div style="background:url(javascript');
    const afterSrcdoc = expanded.slice(expanded.indexOf('srcdoc="') + 8);
    // No unescaped double-quote that could close srcdoc early.
    expect(afterSrcdoc).not.toContain('"x</div>');
  });

  it('does not allow __proto__ pollution to alter the placeholder', () => {
    // The placeholder is base64-encoded, so JSON-shaped __proto__ payloads are
    // just encoded bytes — they cannot reach the prototype chain.
    const malicious = JSON.stringify({ __proto__: { polluted: true }, value: 'x' });
    const placeholder = htmlSandboxPlaceholder(malicious);
    expect(placeholder).not.toContain('__proto__');
    expect(placeholder).not.toContain('polluted');
    // Verify the global prototype is untouched after encoding.
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it('handles a very long payload (1MB+) without crashing or hanging', () => {
    const big = '<div>' + 'A'.repeat(1024 * 1024) + '</div>';
    const start = Date.now();
    const expanded = expandHtmlSandboxes(htmlSandboxPlaceholder(big));
    const elapsed = Date.now() - start;
    expect(expanded).toContain('<iframe');
    // Should complete quickly (well under 5s) — no pathological regex.
    expect(elapsed).toBeLessThan(5000);
  });

  it('neutralizes Unicode bidi override characters wrapping a script', () => {
    // U+202E (RIGHT-TO-LEFT OVERRIDE) attempts to visually disguise a script.
    const malicious = `\u202e<script>alert(1)</script>`;
    const placeholder = htmlSandboxPlaceholder(malicious);
    // The bidi char is just encoded bytes; the script must not appear raw.
    expect(placeholder).not.toContain('<script>alert(1)</script>');
    const expanded = expandHtmlSandboxes(placeholder);
    expect(expanded).not.toContain('<script>alert(1)</script>');
    expect(expanded).toContain('&lt;script&gt;');
  });

  it('escapes form elements so they cannot submit inside the sandbox', () => {
    const malicious = `<form action="http://evil.com"><input type="submit"></form>`;
    const expanded = expandHtmlSandboxes(htmlSandboxPlaceholder(malicious));
    // The iframe has sandbox="" (no forms) AND form-action 'none' in CSP.
    // The form markup is escaped within srcdoc so it cannot break out.
    expect(expanded).not.toContain(`<form action="http://evil.com">`);
    // No unescaped quote that could close srcdoc early.
    const afterSrcdoc = expanded.slice(expanded.indexOf('srcdoc="') + 8);
    expect(afterSrcdoc).not.toContain(`"action="http://evil.com`);
  });

  it('escapes SVG onload handlers so they cannot fire', () => {
    const malicious = `<svg onload="alert(1)">x</svg>`;
    const expanded = expandHtmlSandboxes(htmlSandboxPlaceholder(malicious));
    // The <svg and onload are HTML-escaped within srcdoc; even when the
    // browser unescapes them, the sandbox attribute (no scripts) and CSP
    // prevent the onload handler from firing.
    expect(expanded).toContain('sandbox=""');
    expect(expanded).toContain("default-src 'none'");
    // No unescaped <svg onload reaches the raw output.
    expect(expanded).not.toContain('<svg onload="alert(1)">');
    // No unescaped double-quote that could close the srcdoc attribute early.
    const afterSrcdoc = expanded.slice(expanded.indexOf('srcdoc="') + 8);
    expect(afterSrcdoc).not.toContain('">x</svg>');
  });

  it('escapes iframe src javascript: injection attempts', () => {
    const malicious = `<iframe src="javascript:alert(1)">`;
    const expanded = expandHtmlSandboxes(htmlSandboxPlaceholder(malicious));
    // The inner iframe markup is escaped; only the outer sandbox iframe is real.
    expect(expanded).not.toContain(`<iframe src="javascript:alert(1)">`);
    const afterSrcdoc = expanded.slice(expanded.indexOf('srcdoc="') + 8);
    expect(afterSrcdoc).not.toContain(`"src="javascript:alert(1)`);
  });
});
