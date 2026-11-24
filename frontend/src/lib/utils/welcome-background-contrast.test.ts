import { describe, expect, it } from 'vitest';
import { feedChromeColors, welcomeTextColorForPixels } from './welcome-background-contrast';

function pixel(r: number, g: number, b: number, alpha = 255): number[] {
  return [r, g, b, alpha];
}

describe('welcome background text contrast', () => {
  const darkSurface = '#151210';
  const lightSurface = '#f8f9fa';

  it('uses dark text for white and pale colorful backgrounds', () => {
    expect(welcomeTextColorForPixels(pixel(255, 255, 255), 1, darkSurface)).toBe('#000000');
    expect(welcomeTextColorForPixels(pixel(245, 210, 120), 1, darkSurface)).toBe('#000000');
  });

  it('uses white text for dark and saturated rainbow backgrounds', () => {
    for (const color of [
      pixel(0, 0, 0),
      pixel(120, 20, 160),
      pixel(10, 105, 120),
      pixel(200, 20, 30),
    ]) {
      expect(welcomeTextColorForPixels(color, 1, lightSurface)).toBe('#ffffff');
    }
  });

  it('accounts for image transparency over the surface', () => {
    expect(welcomeTextColorForPixels(pixel(255, 255, 255, 0), 1, darkSurface)).toBe('#ffffff');
    expect(welcomeTextColorForPixels(pixel(0, 0, 0, 0), 1, lightSurface)).toBe('#000000');
  });

  it('accounts for the selected brightness/opacity', () => {
    const whitePixel = pixel(255, 255, 255);
    expect(welcomeTextColorForPixels(whitePixel, 0, darkSurface)).toBe('#ffffff');
    expect(welcomeTextColorForPixels(whitePixel, 1, darkSurface)).toBe('#000000');
    expect(welcomeTextColorForPixels(pixel(0, 0, 0), 0.2, lightSurface)).toBe('#000000');
    expect(welcomeTextColorForPixels(pixel(0, 0, 0), 1, lightSurface)).toBe('#ffffff');
  });

  it('uses the underlying surface when image pixels cannot be sampled', () => {
    expect(welcomeTextColorForPixels([], 1, darkSurface)).toBe('#ffffff');
    expect(welcomeTextColorForPixels([], 1, lightSurface)).toBe('#000000');
  });

  it('uses image-wide average luminance for mixed color samples', () => {
    expect(
      welcomeTextColorForPixels([...pixel(255, 255, 255), ...pixel(0, 0, 0)], 1, darkSurface),
    ).toBe('#000000');
    expect(welcomeTextColorForPixels([...pixel(0, 0, 0), ...pixel(0, 0, 0)], 1, lightSurface)).toBe(
      '#ffffff',
    );
  });
});

describe('feedChromeColors', () => {
  it('uses theme tokens when no background text color is resolved', () => {
    expect(feedChromeColors(undefined)).toEqual({
      fg: 'var(--color-text-muted)',
      fgHover: 'var(--color-text-primary)',
      hoverBg: 'var(--color-surface-2)',
    });
  });

  it('uses dark chrome over light backgrounds', () => {
    expect(feedChromeColors('#000000')).toEqual({
      fg: 'rgba(0, 0, 0, 0.82)',
      fgHover: '#000000',
      hoverBg: 'rgba(255, 255, 255, 0.55)',
    });
  });

  it('uses light chrome over dark backgrounds', () => {
    expect(feedChromeColors('#ffffff')).toEqual({
      fg: 'rgba(255, 255, 255, 0.88)',
      fgHover: '#ffffff',
      hoverBg: 'rgba(0, 0, 0, 0.45)',
    });
  });
});
