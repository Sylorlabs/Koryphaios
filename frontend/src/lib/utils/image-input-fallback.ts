export type ImageInputMode = 'reject' | 'omit';

export const IMAGE_INPUT_FALLBACK_STORAGE_KEY = 'koryphaios-image-input-fallback-v1';

export function modelHasVerifiedImageInput(model?: {
  supportsAttachments?: boolean;
  vision?: boolean;
}): boolean {
  // Transport support is the operative contract. A model-family vision badge
  // alone is insufficient when an adapter cannot carry pixels.
  return model?.supportsAttachments === true;
}

export function needsImageInputChoice(
  imageCount: number,
  model: { supportsAttachments?: boolean; vision?: boolean } | undefined,
  hasOmitConsent: boolean,
): boolean {
  return imageCount > 0 && !modelHasVerifiedImageInput(model) && !hasOmitConsent;
}

export function readRememberedImageInputMode(storage?: Storage): ImageInputMode {
  if (!storage) return 'reject';
  try {
    const value = JSON.parse(storage.getItem(IMAGE_INPUT_FALLBACK_STORAGE_KEY) ?? 'null') as {
      version?: number;
      mode?: string;
    } | null;
    return value?.version === 1 && value.mode === 'omit' ? 'omit' : 'reject';
  } catch {
    return 'reject';
  }
}

export function rememberImageInputMode(storage: Storage | undefined, mode: ImageInputMode): void {
  if (!storage) return;
  if (mode === 'reject') {
    storage.removeItem(IMAGE_INPUT_FALLBACK_STORAGE_KEY);
    return;
  }
  storage.setItem(IMAGE_INPUT_FALLBACK_STORAGE_KEY, JSON.stringify({ version: 1, mode: 'omit' }));
}
