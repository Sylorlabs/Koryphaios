import { describe, expect, it } from 'vitest';
import {
  accentKeywordCss,
  parseInlineStyleAttrs,
  sanitizeInlineColor,
  sanitizeInlineFontSize,
  sanitizeInlineHtmlStyles,
} from './kory-inline-style';

describe('sanitizeInlineColor', () => {
  it('accepts hex, functional, and named colors', () => {
    expect(sanitizeInlineColor('#ff0000')).toBe('#ff0000');
    expect(sanitizeInlineColor('rgb(255,0,0)')).toBe('rgb(255,0,0)');
    expect(sanitizeInlineColor('hsl(0, 100%, 50%)')).toBe('hsl(0,100%,50%)');
    expect(sanitizeInlineColor('red')).toBe('red');
  });

  it('maps accent keywords to theme variables', () => {
    expect(sanitizeInlineColor('accent')).toBe('var(--color-accent)');
    expect(sanitizeInlineColor('secondary-accent')).toBe('var(--color-accent-secondary)');
    expect(accentKeywordCss('accent')).toBe('var(--color-accent)');
  });

  it('rejects style-breakout and non-color input', () => {
    expect(sanitizeInlineColor('red; font-size:99px')).toBeNull();
    expect(sanitizeInlineColor('expression(alert(1))')).toBeNull();
    expect(sanitizeInlineColor('not-a-color')).toBeNull();
    expect(sanitizeInlineColor('')).toBeNull();
  });
});

describe('sanitizeInlineFontSize', () => {
  it('accepts named sizes', () => {
    expect(sanitizeInlineFontSize('large')).toBe('1.125em');
    expect(sanitizeInlineFontSize('2xl')).toBe('1.5em');
  });

  it('clamps numeric sizes', () => {
    expect(sanitizeInlineFontSize('20px')).toBe('20px');
    expect(sanitizeInlineFontSize('20')).toBe('20px');
    expect(sanitizeInlineFontSize('200px')).toBeNull();
    expect(sanitizeInlineFontSize('8px')).toBeNull();
    expect(sanitizeInlineFontSize('0.5em')).toBeNull();
    expect(sanitizeInlineFontSize('500%')).toBeNull();
  });
});

describe('parseInlineStyleAttrs', () => {
  it('parses bare colors, sizes, and flags', () => {
    expect(parseInlineStyleAttrs('red, large, bold')).toEqual({
      css: 'color:red;font-size:1.125em;font-weight:700',
    });
  });

  it('parses key=value pairs with paren-safe splitting', () => {
    expect(parseInlineStyleAttrs('color=rgb(96,165,250), size=xl')).toEqual({
      css: 'color:rgb(96,165,250);font-size:1.25em',
    });
  });

  it('supports accent colors and highlight backgrounds', () => {
    expect(parseInlineStyleAttrs('color=accent, size=xl')?.css).toContain(
      'color:var(--color-accent)',
    );
    expect(parseInlineStyleAttrs('bg=#fff3cd')?.css).toContain('background-color:#fff3cd');
  });

  it('returns null for unrecognized input so source stays literal', () => {
    expect(parseInlineStyleAttrs('not-a-color-or-size!!!')).toBeNull();
    expect(parseInlineStyleAttrs('color=expression(alert(1))')).toBeNull();
    expect(parseInlineStyleAttrs('')).toBeNull();
  });
});

describe('sanitizeInlineHtmlStyles', () => {
  it('keeps the safe subset and drops the rest', () => {
    const html = sanitizeInlineHtmlStyles(
      '<span style="color:#ff0000; font-size:20px; font-weight:bold; position:absolute; background:url(javascript:alert(1))">x</span>',
    );
    expect(html).toContain('color:#ff0000');
    expect(html).toContain('font-size:20px');
    expect(html).toContain('font-weight:700');
    expect(html).not.toContain('position');
    expect(html).not.toContain('url(');
  });

  it('neutralizes expression() and !important', () => {
    const html = sanitizeInlineHtmlStyles(
      '<span style="width:expression(alert(1)); color:red !important">x</span>',
    );
    expect(html).not.toContain('expression');
    expect(html).not.toContain('important');
    expect(html).toContain('color:red');
  });

  it('converts font color and drops face/size', () => {
    const html = sanitizeInlineHtmlStyles('<font color="red" size="7" face="x">x</font>');
    expect(html).toContain('color:red');
    expect(html).not.toContain('size=');
    expect(html).not.toContain('face=');
  });

  it('admits only exact theme-accent var references', () => {
    expect(sanitizeInlineHtmlStyles('<span style="color:var(--color-accent)">x</span>')).toContain(
      'var(--color-accent)',
    );
    expect(sanitizeInlineHtmlStyles('<span style="color:var(--evil)">x</span>')).toBe(
      '<span>x</span>',
    );
  });
});
