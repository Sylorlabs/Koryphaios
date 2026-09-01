import { describe, expect, it } from 'vitest';
import {
  analyzeHtmlVisualSafety,
  analyzeMarkdownVisualSafety,
  visualModeFor,
} from './skill-visual-safety';

describe('skill visual editor safety', () => {
  it('routes native and custom documents through the declared safe renderer', () => {
    expect(visualModeFor('markdown', 'plain')).toBe('markdown');
    expect(visualModeFor('text', 'html')).toBe('plain');
    expect(visualModeFor('html', 'markdown')).toBe('html');
    expect(visualModeFor('custom', 'markdown')).toBe('markdown');
  });

  it('accepts stock CommonMark while locking extensions that would be rewritten', () => {
    expect(
      analyzeMarkdownVisualSafety('# Review\n\n- Keep evidence\n- Report limits').editable,
    ).toBe(true);
    expect(analyzeMarkdownVisualSafety('- [x] Preserve this marker')).toMatchObject({
      editable: false,
      reason: expect.stringContaining('task-list'),
    });
    expect(analyzeMarkdownVisualSafety('| A | B |\n|---|---|\n| 1 | 2 |').editable).toBe(false);
    expect(analyzeMarkdownVisualSafety('<widget mode="exact" />').editable).toBe(false);
  });

  it('does not mistake advanced-looking text inside code fences for live markup', () => {
    const source = '```md\n- [x] literal\n<table><tr><td>x</td></tr></table>\n```';
    expect(analyzeMarkdownVisualSafety(source).editable).toBe(true);
  });

  it('locks extensions that the stock CommonMark AST would otherwise flatten', () => {
    expect(analyzeMarkdownVisualSafety('> [!NOTE]\n> Keep exact').editable).toBe(false);
    expect(analyzeMarkdownVisualSafety('Term\n: Definition').editable).toBe(false);
    expect(analyzeMarkdownVisualSafety('+++\ntitle = "Exact"\n+++').editable).toBe(false);
    expect(analyzeMarkdownVisualSafety('<![CDATA[exact]]>').editable).toBe(false);
    expect(analyzeMarkdownVisualSafety('```custom\nunclosed').editable).toBe(false);
  });

  it('allows the HTML subset represented by the schema', () => {
    expect(
      analyzeHtmlVisualSafety(
        '<h2>Review</h2><p>Use <strong>evidence</strong>.</p><ul><li>One</li></ul>',
      ).editable,
    ).toBe(true);
  });

  it('locks unsupported, styled, or active HTML without mounting it', () => {
    expect(analyzeHtmlVisualSafety('<section>Exact source</section>')).toMatchObject({
      editable: false,
      reason: expect.stringContaining('<section>'),
    });
    expect(analyzeHtmlVisualSafety('<p style="color:red">Exact source</p>').editable).toBe(false);
    expect(analyzeHtmlVisualSafety('<a href="javascript:alert(1)">Do not run</a>').editable).toBe(
      false,
    );
    expect(analyzeHtmlVisualSafety('<script>alert(1)</script>').editable).toBe(false);
  });

  it('locks malformed HTML before browser repair can erase source evidence', () => {
    expect(analyzeHtmlVisualSafety('before</section>after').editable).toBe(false);
    expect(analyzeHtmlVisualSafety('<section').editable).toBe(false);
    expect(analyzeHtmlVisualSafety('</script><p>x</p>').editable).toBe(false);
    expect(analyzeHtmlVisualSafety('<![CDATA[x]]>').editable).toBe(false);
  });

  it('locks external image sources before the visual serializer can instantiate them', () => {
    expect(
      analyzeHtmlVisualSafety('<p>Evidence</p><img src="https://example.invalid/private.png">'),
    ).toMatchObject({ editable: false, reason: expect.stringContaining('External HTML image') });
  });
});
