export type ImageInputMode = 'reject' | 'omit' | 'allow';

export const IMAGE_INPUT_FALLBACK_STORAGE_KEY = 'koryphaios-image-input-fallback-v1';
export const IMAGE_INPUT_TRUST_STORAGE_KEY = 'koryphaios-image-input-trust-v1';

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
  if (mode !== 'omit') {
    storage.removeItem(IMAGE_INPUT_FALLBACK_STORAGE_KEY);
    return;
  }
  storage.setItem(IMAGE_INPUT_FALLBACK_STORAGE_KEY, JSON.stringify({ version: 1, mode: 'omit' }));
}

function readTrustedImageModels(storage?: Storage): string[] {
  if (!storage) return [];
  try {
    const value = JSON.parse(storage.getItem(IMAGE_INPUT_TRUST_STORAGE_KEY) ?? 'null') as {
      version?: number;
      models?: unknown;
    } | null;
    if (value?.version !== 1 || !Array.isArray(value.models)) return [];
    return value.models.filter(
      (model): model is string => typeof model === 'string' && model.length > 0,
    );
  } catch {
    return [];
  }
}

/** User-authorized exceptions are scoped to the exact provider/model selection. */
export function hasTrustedImageModel(storage: Storage | undefined, modelValue: string): boolean {
  return readTrustedImageModels(storage).includes(modelValue);
}

export function rememberTrustedImageModel(storage: Storage | undefined, modelValue: string): void {
  if (!storage || !modelValue) return;
  const models = [...new Set([...readTrustedImageModels(storage), modelValue])];
  storage.setItem(IMAGE_INPUT_TRUST_STORAGE_KEY, JSON.stringify({ version: 1, models }));
}

export function forgetTrustedImageModel(storage: Storage | undefined, modelValue: string): void {
  if (!storage) return;
  const models = readTrustedImageModels(storage).filter((model) => model !== modelValue);
  if (models.length === 0) storage.removeItem(IMAGE_INPUT_TRUST_STORAGE_KEY);
  else storage.setItem(IMAGE_INPUT_TRUST_STORAGE_KEY, JSON.stringify({ version: 1, models }));
}
