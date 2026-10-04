import type { ToolCallOutput } from './registry';

export function withoutToolImages(result: ToolCallOutput): Omit<ToolCallOutput, 'images'> {
  const { images: _images, ...textResult } = result;
  return textResult;
}

/** Bound model-visible tool images before admitting external/native payloads. */
export interface ToolImage {
  mimeType: string;
  data: string;
}
export function validatedToolImages(value: unknown): ToolImage[] {
  if (!Array.isArray(value)) return [];
  let total = 0;
  const images: ToolImage[] = [];
  for (const image of value.slice(0, 4)) {
    if (
      !image ||
      typeof image !== 'object' ||
      !['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(image.mimeType) ||
      typeof image.data !== 'string' ||
      !image.data.length ||
      image.data.length > 14_000_000 ||
      !/^[A-Za-z0-9+/]+={0,2}$/.test(image.data)
    )
      continue;
    total += image.data.length;
    if (total > 20_000_000) break;
    images.push({ mimeType: image.mimeType, data: image.data });
  }
  return images;
}
