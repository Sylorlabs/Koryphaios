import { describe, expect, it } from 'vitest';
import { THEME_PRESETS } from './theme-palette';

type Rgb = [number, number, number];

function parseHex(value: string): Rgb {
  const match = /^#([\da-f]{2})([\da-f]{2})([\da-f]{2})$/i.exec(value.trim());
  if (!match) throw new Error(`Expected #RRGGBB, received ${value}`);
  return [parseInt(match[1], 16), parseInt(match[2], 16), parseInt(match[3], 16)];
}

function parseColor(value: string, background: Rgb): Rgb {
  if (value.startsWith('#')) return parseHex(value);
  const match = /^rgba\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*,\s*([\d.]+)\s*\)$/i.exec(
    value.trim(),
  );
  if (!match) throw new Error(`Unsupported theme color: ${value}`);
  const foreground: Rgb = [Number(match[1]), Number(match[2]), Number(match[3])];
  const alpha = Number(match[4]);
  return foreground.map((channel, index) =>
    Math.round(channel * alpha + background[index] * (1 - alpha)),
  ) as Rgb;
}

function linearChannel(channel: number): number {
  const normalized = channel / 255;
  return normalized <= 0.04045
    ? normalized / 12.92
    : ((normalized + 0.055) / 1.055) ** 2.4;
}

function luminance([red, green, blue]: Rgb): number {
  return (
    0.2126 * linearChannel(red) +
    0.7152 * linearChannel(green) +
    0.0722 * linearChannel(blue)
  );
}

function contrastRatio(foreground: Rgb, background: Rgb): number {
  const light = Math.max(luminance(foreground), luminance(background));
  const dark = Math.min(luminance(foreground), luminance(background));
  return (light + 0.05) / (dark + 0.05);
}

describe('theme palette accessibility contracts', () => {
  it('keeps primary, secondary, and muted text AA-readable on every surface', () => {
    for (const [themeName, palette] of Object.entries(THEME_PRESETS)) {
      const surfaces = Object.entries(palette).filter(([token]) =>
        /^--color-surface-[0-4]$/.test(token),
      );
      const textTokens = [
        '--color-text-primary',
        '--color-text-secondary',
        '--color-text-muted',
      ] as const;

      expect(surfaces).toHaveLength(5);
      for (const [surfaceToken, surfaceValue] of surfaces) {
        const background = parseHex(surfaceValue);
        for (const textToken of textTokens) {
          const textValue = palette[textToken];
          expect(textValue).toBeTruthy();
          const ratio = contrastRatio(parseColor(textValue, background), background);
          expect(
            ratio,
            `${themeName} ${textToken} on ${surfaceToken} has contrast ${ratio.toFixed(2)}:1`,
          ).toBeGreaterThanOrEqual(4.5);
        }
      }
    }
  });

  it('preserves a visible hierarchy on the most elevated surface', () => {
    for (const [themeName, palette] of Object.entries(THEME_PRESETS)) {
      const background = parseHex(palette['--color-surface-4']);
      const primary = contrastRatio(
        parseColor(palette['--color-text-primary'], background),
        background,
      );
      const secondary = contrastRatio(
        parseColor(palette['--color-text-secondary'], background),
        background,
      );
      const muted = contrastRatio(
        parseColor(palette['--color-text-muted'], background),
        background,
      );

      expect(primary, `${themeName} primary hierarchy`).toBeGreaterThanOrEqual(secondary);
      expect(secondary, `${themeName} secondary hierarchy`).toBeGreaterThanOrEqual(muted);
    }
  });
});
