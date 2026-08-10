import { describe, expect, test } from 'bun:test';
import {
  DEFAULT_VOICE_SETTINGS,
  assertNoCloudFallback,
  downloadVoicePack,
  listVoicePacks,
  listVoiceProviders,
  synthesizeCloud,
  transcribeCloud,
  validateVoiceSettings,
  VOICE_AUTOMATION_UNAVAILABLE_ERROR,
  VOICE_PACK_RUNTIME_UNAVAILABLE_ERROR,
  VOICE_SERVER_TTS_UNAVAILABLE_ERROR,
  VOICE_STT_UNAVAILABLE_ERROR,
} from './voice-service';

describe('voice settings', () => {
  test('validates defaults and speed limits', () => {
    // Valid settings pass through unchanged
    expect(validateVoiceSettings(DEFAULT_VOICE_SETTINGS)).toEqual(DEFAULT_VOICE_SETTINGS);
    // Speed above the maximum is rejected
    expect(() =>
      validateVoiceSettings({
        ...DEFAULT_VOICE_SETTINGS,
        output: { ...DEFAULT_VOICE_SETTINGS.output, speed: 3 },
      }),
    ).toThrow();
    // Speed below the minimum is rejected
    expect(() =>
      validateVoiceSettings({
        ...DEFAULT_VOICE_SETTINGS,
        output: { ...DEFAULT_VOICE_SETTINGS.output, speed: 0.1 },
      }),
    ).toThrow();
    // Missing output section is rejected (not silently defaulted)
    expect(() =>
      validateVoiceSettings({
        ...DEFAULT_VOICE_SETTINGS,
        output: undefined as any,
      }),
    ).toThrow();
  });

  test('rejects cloud and downloaded-but-unimplemented local adapters', () => {
    expect(() =>
      validateVoiceSettings({
        ...DEFAULT_VOICE_SETTINGS,
        input: { provider: 'openai', modelId: 'whisper-1', language: 'en' },
      }),
    ).toThrow(VOICE_STT_UNAVAILABLE_ERROR);
    expect(() =>
      validateVoiceSettings({
        ...DEFAULT_VOICE_SETTINGS,
        output: {
          provider: 'local',
          modelId: 'kitten-tts-0.8-micro',
          voiceId: 'expr-voice-1-m',
          speed: 1,
        },
      }),
    ).toThrow(VOICE_SERVER_TTS_UNAVAILABLE_ERROR);
    expect(() =>
      validateVoiceSettings({ ...DEFAULT_VOICE_SETTINGS, autoReadFinalReplies: true }),
    ).toThrow(VOICE_AUTOMATION_UNAVAILABLE_ERROR);
  });

  test('never silently routes speech input or server synthesis', async () => {
    expect(() => assertNoCloudFallback(DEFAULT_VOICE_SETTINGS, 'stt')).toThrow(
      VOICE_STT_UNAVAILABLE_ERROR,
    );
    expect(() => assertNoCloudFallback(DEFAULT_VOICE_SETTINGS, 'tts')).toThrow(
      VOICE_SERVER_TTS_UNAVAILABLE_ERROR,
    );
    await expect(transcribeCloud()).rejects.toThrow(VOICE_STT_UNAVAILABLE_ERROR);
    await expect(
      synthesizeCloud({
        text: 'must stay local',
        provider: 'openai',
        modelId: 'tts-1',
        voiceId: 'alloy',
        speed: 1,
      }),
    ).rejects.toThrow(VOICE_SERVER_TTS_UNAVAILABLE_ERROR);
  });

  test('catalog exposes only the implemented system synthesis path', async () => {
    expect(await listVoiceProviders()).toEqual([
      {
        id: 'system',
        name: 'Operating system speech',
        capabilities: ['tts'],
        local: false,
        supportsDiscovery: true,
        configured: true,
      },
    ]);
  });
});

describe('voice pack catalog', () => {
  test('retains the verified English dictation file inventory without claiming a runtime', async () => {
    const packs = await listVoicePacks();
    const english = packs.find((pack) => pack.manifest.id === 'moonshine-tiny-en-int8');

    expect(english).toBeDefined();
    expect(english?.manifest.family).toBe('moonshine');
    expect(english?.manifest.capabilities).toEqual(['stt']);
    expect(english?.manifest.files).toHaveLength(3);
    expect(english?.manifest.files.every((file) => /^[a-f0-9]{64}$/.test(file.sha256))).toBe(true);
    expect(english?.state).not.toBe('available');
    expect(english?.error).toBe(VOICE_PACK_RUNTIME_UNAVAILABLE_ERROR);
  });

  test('rejects both known and unknown pack downloads before any network request', async () => {
    await expect(downloadVoicePack('moonshine-tiny-en-int8')).rejects.toThrow(
      VOICE_PACK_RUNTIME_UNAVAILABLE_ERROR,
    );
    await expect(downloadVoicePack('../not-a-pack')).rejects.toThrow('Unknown voice pack');
  });
});
