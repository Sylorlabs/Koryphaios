import { describe, expect, it } from 'vitest';
import {
  CUSTOM_PROVIDER_ICON_MAX_BYTES,
  clampIconZoomPercent,
  computeIconCropSourceRect,
  computeIconCropTransform,
  validateCustomProviderIconDimensions,
  validateCustomProviderIconFile,
} from './custom-provider-icon';

describe('custom provider icon input validation', () => {
  it('accepts supported image types up to the file-size limit', () => {
    expect(
      validateCustomProviderIconFile({ size: CUSTOM_PROVIDER_ICON_MAX_BYTES, type: 'image/png' }),
    ).toBeNull();
    expect(validateCustomProviderIconFile({ size: 1024, type: 'image/jpeg' })).toBeNull();
    expect(validateCustomProviderIconFile({ size: 1024, type: 'image/webp' })).toBeNull();
  });

  it('rejects unsupported, empty, and oversized files', () => {
    expect(validateCustomProviderIconFile({ size: 1024, type: 'image/svg+xml' })).toMatch(/PNG/);
    expect(validateCustomProviderIconFile({ size: 0, type: 'image/png' })).toMatch(/empty/);
    expect(
      validateCustomProviderIconFile({
        size: CUSTOM_PROVIDER_ICON_MAX_BYTES + 1,
        type: 'image/png',
      }),
    ).toMatch(/5 MiB/);
  });

  it('rejects invalid and excessively large decoded dimensions', () => {
    expect(validateCustomProviderIconDimensions(0, 200)).toMatch(/decoded/);
    expect(validateCustomProviderIconDimensions(8000, 6000)).toMatch(/40 megapixels/);
    expect(validateCustomProviderIconDimensions(2000, 2000)).toBeNull();
  });
});

describe('custom provider icon crop geometry', () => {
  it('clamps zoom to the supported 100 to 400 percent range', () => {
    expect(clampIconZoomPercent(12)).toBe(100);
    expect(clampIconZoomPercent(275.4)).toBe(275);
    expect(clampIconZoomPercent(900)).toBe(400);
  });

  it('covers a square viewport without exposing blank space', () => {
    const transform = computeIconCropTransform(400, 200, 200, 100);
    expect(transform.scale).toBe(1);
    expect(transform.displayWidth).toBe(400);
    expect(transform.displayHeight).toBe(200);
    expect(transform.maxPanX).toBe(100);
    expect(transform.maxPanY).toBe(0);
  });

  it('clamps panning at the image boundary', () => {
    const transform = computeIconCropTransform(400, 200, 200, 100, 500, -500);
    expect(transform.panX).toBe(100);
    expect(transform.panY).toBe(0);
  });

  it('maps visible panning into the source crop rectangle', () => {
    expect(computeIconCropSourceRect(400, 200, 200, 100, 50, 0)).toEqual({
      x: 50,
      y: 0,
      width: 200,
      height: 200,
    });
  });

  it('uses a centered, smaller source crop when zoomed in', () => {
    expect(computeIconCropSourceRect(400, 200, 200, 200)).toEqual({
      x: 150,
      y: 50,
      width: 100,
      height: 100,
    });
  });

  it('handles portrait images symmetrically', () => {
    const transform = computeIconCropTransform(200, 400, 200, 100, 0, -80);
    expect(transform.maxPanX).toBe(0);
    expect(transform.maxPanY).toBe(100);
    expect(transform.panY).toBe(-80);
    expect(computeIconCropSourceRect(200, 400, 200, 100, 0, -80).y).toBe(180);
  });
});
