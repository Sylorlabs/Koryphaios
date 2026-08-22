import { describe, expect, test } from 'bun:test';
import {
  DEFAULT_VOICE_SETTINGS,
  downloadVoicePack,
  listVoicePacks,
  listVoiceProviders,
  synthesizeCloud,
  transcribeCloud,
  validateVoiceSettings,
} from './voice-service';

describe('voice settings', () => {
  test('validates supported providers, models, and speed limits', () => {
    expect(validateVoiceSettings(DEFAULT_VOICE_SETTINGS)).toEqual(DEFAULT_VOICE_SETTINGS);
    expect(() =>
      validateVoiceSettings({
        ...DEFAULT_VOICE_SETTINGS,
        output: { ...DEFAULT_VOICE_SETTINGS.output, speed: 3 },
      }),
    ).toThrow('Speech speed must be between 0.5 and 2');
    expect(() =>
      validateVoiceSettings({
        ...DEFAULT_VOICE_SETTINGS,
        input: { provider: 'openai', modelId: 'whisper-1', language: 'en' },
      }),
    ).toThrow('supported OpenAI transcription model');
    expect(() =>
      validateVoiceSettings({
        ...DEFAULT_VOICE_SETTINGS,
        output: { provider: 'local', modelId: 'unknown', voiceId: 'voice', speed: 1 },
      }),
    ).toThrow('supported speech output model');
  });

  test('accepts system and OpenAI speech output', () => {
    expect(validateVoiceSettings(DEFAULT_VOICE_SETTINGS).output.provider).toBe('system');
    const cloud = validateVoiceSettings({
      ...DEFAULT_VOICE_SETTINGS,
      output: { provider: 'openai', modelId: 'gpt-4o-mini-tts', voiceId: 'alloy', speed: 1 },
    });
    expect(cloud.output.provider).toBe('openai');
  });

  test('requires audio and text before cloud requests', async () => {
    await expect(transcribeCloud({})).rejects.toThrow('Recorded audio is required');
    await expect(
      synthesizeCloud({ text: '', provider: 'openai', modelId: 'gpt-4o-mini-tts' }),
    ).rejects.toThrow('Text is required');
  });

  test('catalog exposes system and OpenAI speech paths', async () => {
    const providers = await listVoiceProviders();
    expect(providers.map((provider) => provider.id)).toEqual(['system', 'openai']);
    expect(providers[0]).toMatchObject({ capabilities: ['tts'], configured: true, local: true });
  });
});

describe('voice pack catalog', () => {
  test('publishes a downloadable verified English dictation inventory', async () => {
    const packs = await listVoicePacks();
    const english = packs.find((pack) => pack.manifest.id === 'moonshine-tiny-en-int8');
    expect(english).toBeDefined();
    expect(english?.manifest.family).toBe('moonshine');
    expect(english?.manifest.capabilities).toEqual(['stt']);
    expect(english?.manifest.files).toHaveLength(3);
    expect(english?.manifest.files.every((file) => /^[a-f0-9]{64}$/.test(file.sha256))).toBe(true);
    expect(english?.state === 'available' || english?.state === 'installed').toBe(true);
  });

  test('rejects unknown model packs without making a request', async () => {
    await expect(downloadVoicePack('../not-a-pack')).rejects.toThrow('Unknown voice pack');
  });
});
