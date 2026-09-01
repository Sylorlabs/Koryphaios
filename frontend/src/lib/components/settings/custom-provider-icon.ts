export const CUSTOM_PROVIDER_ICON_MAX_BYTES = 5 * 1024 * 1024;
export const CUSTOM_PROVIDER_ICON_MAX_PIXELS = 40_000_000;
export const CUSTOM_PROVIDER_ICON_OUTPUT_SIZE = 256;
export const CUSTOM_PROVIDER_ICON_VIEWPORT_SIZE = 184;
export const CUSTOM_PROVIDER_ICON_MIN_ZOOM = 100;
export const CUSTOM_PROVIDER_ICON_MAX_ZOOM = 400;
export const CUSTOM_PROVIDER_ICON_ZOOM_STEP = 10;

export const CUSTOM_PROVIDER_ICON_MIME_TYPES = ['image/png', 'image/jpeg', 'image/webp'] as const;

export type CustomProviderIconMimeType = (typeof CUSTOM_PROVIDER_ICON_MIME_TYPES)[number];
export type CustomProviderIconShape = 'rounded-square' | 'circle';

export interface CustomProviderIconSelection {
  /**
   * A browser-normalized 256 x 256 PNG. It is null when only the presentation
   * shape changed for an icon that is already stored by the backend.
   */
  blob: Blob | null;
  shape: CustomProviderIconShape;
}

export interface IconCropTransform {
  scale: number;
  displayWidth: number;
  displayHeight: number;
  maxPanX: number;
  maxPanY: number;
  panX: number;
  panY: number;
}

export interface IconCropSourceRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface IconFileLike {
  name?: string;
  size: number;
  type: string;
}

export function validateCustomProviderIconFile(file: IconFileLike): string | null {
  if (!CUSTOM_PROVIDER_ICON_MIME_TYPES.includes(file.type as CustomProviderIconMimeType)) {
    return 'Choose a PNG, JPEG, or WebP image.';
  }
  if (!(file.size > 0)) return 'That image is empty. Choose another file.';
  if (file.size > CUSTOM_PROVIDER_ICON_MAX_BYTES) {
    return 'Choose an image smaller than 5 MiB.';
  }
  return null;
}

export function validateCustomProviderIconDimensions(width: number, height: number): string | null {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width < 1 || height < 1) {
    return 'That image could not be decoded. Choose another file.';
  }
  if (width * height > CUSTOM_PROVIDER_ICON_MAX_PIXELS) {
    return 'Choose an image smaller than 40 megapixels.';
  }
  return null;
}

export function clampIconZoomPercent(value: number): number {
  if (!Number.isFinite(value)) return CUSTOM_PROVIDER_ICON_MIN_ZOOM;
  return Math.min(
    CUSTOM_PROVIDER_ICON_MAX_ZOOM,
    Math.max(CUSTOM_PROVIDER_ICON_MIN_ZOOM, Math.round(value)),
  );
}

export function computeIconCropTransform(
  sourceWidth: number,
  sourceHeight: number,
  viewportSize: number,
  zoomPercent: number,
  requestedPanX = 0,
  requestedPanY = 0,
): IconCropTransform {
  const safeWidth = Math.max(1, sourceWidth);
  const safeHeight = Math.max(1, sourceHeight);
  const safeViewport = Math.max(1, viewportSize);
  const zoom = clampIconZoomPercent(zoomPercent) / 100;
  const coverScale = Math.max(safeViewport / safeWidth, safeViewport / safeHeight);
  const scale = coverScale * zoom;
  const displayWidth = safeWidth * scale;
  const displayHeight = safeHeight * scale;
  const maxPanX = Math.max(0, (displayWidth - safeViewport) / 2);
  const maxPanY = Math.max(0, (displayHeight - safeViewport) / 2);
  const panX = maxPanX === 0 ? 0 : Math.min(maxPanX, Math.max(-maxPanX, requestedPanX));
  const panY = maxPanY === 0 ? 0 : Math.min(maxPanY, Math.max(-maxPanY, requestedPanY));

  return {
    scale,
    displayWidth,
    displayHeight,
    maxPanX,
    maxPanY,
    panX,
    panY,
  };
}

export function computeIconCropSourceRect(
  sourceWidth: number,
  sourceHeight: number,
  viewportSize: number,
  zoomPercent: number,
  requestedPanX = 0,
  requestedPanY = 0,
): IconCropSourceRect {
  const transform = computeIconCropTransform(
    sourceWidth,
    sourceHeight,
    viewportSize,
    zoomPercent,
    requestedPanX,
    requestedPanY,
  );
  const cropWidth = Math.min(sourceWidth, viewportSize / transform.scale);
  const cropHeight = Math.min(sourceHeight, viewportSize / transform.scale);
  const maxX = Math.max(0, sourceWidth - cropWidth);
  const maxY = Math.max(0, sourceHeight - cropHeight);
  const x = sourceWidth / 2 - cropWidth / 2 - transform.panX / transform.scale;
  const y = sourceHeight / 2 - cropHeight / 2 - transform.panY / transform.scale;

  return {
    x: Math.min(maxX, Math.max(0, x)),
    y: Math.min(maxY, Math.max(0, y)),
    width: cropWidth,
    height: cropHeight,
  };
}
