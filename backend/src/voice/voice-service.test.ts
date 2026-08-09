import { describe, expect, test } from 'bun:test';
import {
  DEFAULT_VOICE_SETTINGS,
  assertNoCloudFallback,
  downloadVoicePack,
  listVoicePacks,
  validateVoiceSettings,
} from './voice-service';

describe('voice settings', () => {
  test('validates defaults and speed limits', () => {
    // Valid settings pass through unchanged
    expect(validateVoiceSettings(DEFAULT_VOICE_SETTINGS)).toEqual(DEFAULT_VOICE_SETTINGS);
    // Speed above the maximum is rejected
    expect(() => validateVoiceSettings({
      ...DEFAULT_VOICE_SETTINGS,
      output: { ...DEFAULT_VOICE_SETTINGS.output, speed: 3 },
    })).toThrow();
    // Speed below the minimum is rejected
    expect(() => validateVoiceSettings({
      ...DEFAULT_VOICE_SETTINGS,
      output: { ...DEFAULT_VOICE_SETTINGS.output, speed: 0.1 },
    })).toThrow();
    // Missing output section is rejected (not silently defaulted)
    expect(() => validateVoiceSettings({
      ...DEFAULT_VOICE_SETTINGS,
      output: undefined as any,
    })).toThrow();
  });

  test('never silently falls back from local', () => {
    expect(() => assertNoCloudFallback(DEFAULT_VOICE_SETTINGS, 'stt')).toThrow(/will not send/);
  });
});

describe('voice pack catalog', () => {
  test('exposes the verified English dictation pack as downloadable', async () => {
    const packs = await listVoicePacks();
    const english = packs.find((pack) => pack.manifest.id === 'moonshine-tiny-en-int8');

    expect(english).toBeDefined();
    expect(english?.manifest.family).toBe('moonshine');
    expect(english?.manifest.capabilities).toEqual(['stt']);
    expect(english?.manifest.files).toHaveLength(3);
    expect(english?.manifest.files.every((file) => /^[a-f0-9]{64}$/.test(file.sha256))).toBe(true);
  });

  test('rejects unknown pack identifiers before any network request', async () => {
    await expect(downloadVoicePack('../not-a-pack')).rejects.toThrow('Unknown voice pack');
  });
});
