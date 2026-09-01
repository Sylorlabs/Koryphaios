import { describe, expect, it } from 'vitest';
import {
  IMAGE_INPUT_FALLBACK_STORAGE_KEY,
  modelHasVerifiedImageInput,
  needsImageInputChoice,
  readRememberedImageInputMode,
  rememberImageInputMode,
} from './image-input-fallback';

function memoryStorage(): Storage {
  const values = new Map<string, string>();
  return {
    get length() {
      return values.size;
    },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => [...values.keys()][index] ?? null,
    removeItem: (key) => void values.delete(key),
    setItem: (key, value) => void values.set(key, value),
  };
}

describe('image input fallback preference', () => {
  it('requires verified adapter transport rather than a vision-family hint', () => {
    expect(modelHasVerifiedImageInput({ vision: true, supportsAttachments: false })).toBe(false);
    expect(modelHasVerifiedImageInput({ supportsAttachments: true })).toBe(true);
    expect(modelHasVerifiedImageInput(undefined)).toBe(false);
    expect(needsImageInputChoice(1, { supportsAttachments: false }, false)).toBe(true);
    expect(needsImageInputChoice(1, { supportsAttachments: false }, true)).toBe(false);
    expect(needsImageInputChoice(1, { supportsAttachments: true }, false)).toBe(false);
    expect(needsImageInputChoice(0, undefined, false)).toBe(false);
  });

  it('persists only the versioned explicit omit choice and fails closed otherwise', () => {
    const storage = memoryStorage();
    expect(readRememberedImageInputMode(storage)).toBe('reject');
    rememberImageInputMode(storage, 'omit');
    expect(readRememberedImageInputMode(storage)).toBe('omit');
    expect(storage.getItem(IMAGE_INPUT_FALLBACK_STORAGE_KEY)).toContain('"version":1');
    rememberImageInputMode(storage, 'reject');
    expect(readRememberedImageInputMode(storage)).toBe('reject');
    storage.setItem(IMAGE_INPUT_FALLBACK_STORAGE_KEY, '{broken');
    expect(readRememberedImageInputMode(storage)).toBe('reject');
  });
});
