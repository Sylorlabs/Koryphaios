import { describe, expect, it } from 'vitest';
import { THEME_PRESETS } from './theme-palette';
import { contrastRatio, readableForeground } from './theme-contrast';

describe('theme contrast foregrounds', () => {
  it('keeps every built-in accent and status fill AA-readable', () => {
    const fills = [
      '#D5B261',
      '#6366f1',
      '#06b6d4',
      '#10b981',
      '#f59e0b',
      '#f43f5e',
      '#8b5cf6',
      ...Object.values(THEME_PRESETS).map((palette) => palette['--color-success']),
    ];

    for (const fill of fills) {
      const foreground = readableForeground(fill);
      expect(contrastRatio(foreground, fill), `${foreground} on ${fill}`).toBeGreaterThanOrEqual(
        4.5,
      );
    }
  });

  it('switches foregrounds for dark and light custom accents', () => {
    expect(readableForeground('#101828')).toBe('#ffffff');
    expect(readableForeground('#f7e7b5')).toBe('#000000');
  });
});
