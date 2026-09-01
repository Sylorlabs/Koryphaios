import { afterAll, beforeAll, describe, expect, mock, test } from 'bun:test';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DEFAULT_VOICE_SETTINGS,
  listVoiceProviders,
  loadVoiceSettings,
  sanitizeVoiceSettings,
  synthesizeCloud,
  transcribeCloud,
  validateVoiceSettings,
} from './voice-service';
import { setContext } from '../context';

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
        input: { provider: 'unknown', modelId: 'whisper-1', language: 'en' },
      }),
    ).toThrow('supported speech-to-text provider');
    expect(() =>
      validateVoiceSettings({
        ...DEFAULT_VOICE_SETTINGS,
        output: { provider: 'assemblyai', modelId: 'universal-2', voiceId: 'voice', speed: 1 },
      }),
    ).toThrow('supported speech output provider');
  });

  test('accepts speech output from every TTS-capable provider', () => {
    expect(validateVoiceSettings(DEFAULT_VOICE_SETTINGS).input.provider).toBe('system');
    const local = validateVoiceSettings({
      ...DEFAULT_VOICE_SETTINGS,
      input: { provider: 'local', modelId: 'downloaded-whisper', language: 'en' },
    });
    expect(local.input.modelId).toBe('downloaded-whisper');
    const cloud = validateVoiceSettings({
      ...DEFAULT_VOICE_SETTINGS,
      input: { provider: 'groq', modelId: 'whisper-large-v3-turbo', language: 'en' },
      output: { provider: 'openai', modelId: 'gpt-4o-mini-tts', voiceId: 'alloy', speed: 1 },
    });
    expect(cloud.input.provider).toBe('groq');
    expect(cloud.output.provider).toBe('openai');
    const groqTts = validateVoiceSettings({
      ...DEFAULT_VOICE_SETTINGS,
      output: { provider: 'groq', modelId: 'playai-tts', voiceId: 'Fritz-PlayAI', speed: 1 },
    });
    expect(groqTts.output.modelId).toBe('playai-tts');
    const deepgramTts = validateVoiceSettings({
      ...DEFAULT_VOICE_SETTINGS,
      output: {
        provider: 'deepgram',
        modelId: 'aura-asteria-en',
        voiceId: 'default',
        speed: 1,
      },
    });
    expect(deepgramTts.output.provider).toBe('deepgram');
    const localTts = validateVoiceSettings({
      ...DEFAULT_VOICE_SETTINGS,
      output: { provider: 'local', modelId: 'kokoro', voiceId: 'default', speed: 1 },
    });
    expect(localTts.output.modelId).toBe('kokoro');
  });

  test('requires audio and text before cloud requests', async () => {
    await expect(transcribeCloud({})).rejects.toThrow('Recorded audio is required');
    await expect(
      synthesizeCloud({ text: '', provider: 'openai', modelId: 'gpt-4o-mini-tts' }),
    ).rejects.toThrow('Text is required');
  });

  test('sanitizes stale settings instead of discarding them', () => {
    // Legacy sentinel that used to poison the whole file.
    const poisoned = {
      input: { provider: 'system', modelId: 'stt-unavailable', language: 'en' },
      output: { provider: 'groq', modelId: 'playai-tts', voiceId: 'Fritz-PlayAI', speed: 1.4 },
      autoReadFinalReplies: true,
      voiceModeEnabled: false,
      liveTranscription: false,
    };
    const sanitized = sanitizeVoiceSettings(poisoned);
    expect(sanitized.input).toEqual({
      provider: 'system',
      modelId: 'web-speech-recognition',
      language: 'en',
    });
    // The valid cloud output side survives untouched.
    expect(sanitized.output).toEqual({
      provider: 'groq',
      modelId: 'playai-tts',
      voiceId: 'Fritz-PlayAI',
      speed: 1.4,
    });
    expect(sanitized.autoReadFinalReplies).toBe(true);
    expect(sanitized.voiceModeEnabled).toBe(false);
    expect(() => validateVoiceSettings(sanitized)).not.toThrow();

    // Unknown providers fall back per side; speed clamps into range.
    const mixed = sanitizeVoiceSettings({
      input: { provider: 'does-not-exist', modelId: 'x', language: 'en' },
      output: { provider: 'also-fake', modelId: 'y', voiceId: 'z', speed: 9 },
    });
    expect(mixed.input).toEqual(DEFAULT_VOICE_SETTINGS.input);
    expect(mixed.output).toEqual(DEFAULT_VOICE_SETTINGS.output);

    // Garbage input yields defaults.
    expect(sanitizeVoiceSettings('nope')).toEqual(DEFAULT_VOICE_SETTINGS);
    expect(sanitizeVoiceSettings(null)).toEqual(DEFAULT_VOICE_SETTINGS);
  });

  test('sanitize output always re-validates against hostile inputs', () => {
    const hostile: Array<unknown> = [
      { output: { provider: 'openai', modelId: '', voiceId: '  ', speed: 1 } },
      { input: { provider: 'system', modelId: '   ', language: '' } },
      {
        input: { provider: 'custom:lab', modelId: 'whisper-1', language: 'en' },
        output: { provider: 'custom:lab', modelId: 'kokoro', voiceId: 'af', speed: 0.1 },
      },
      {
        input: { provider: 'groq', modelId: 'whisper-large-v3', language: 'en' },
        output: { speed: Number.NaN },
      },
      {
        output: {
          provider: 'deepgram',
          modelId: 'aura-asteria-en',
          voiceId: 'default',
          speed: '1.5',
        },
      },
      { input: { modelId: 42 }, output: { provider: 7 }, voiceModeEnabled: 'yes' },
    ];
    for (const candidate of hostile) {
      const sanitized = sanitizeVoiceSettings(candidate);
      // Must not throw — otherwise loadVoiceSettings would loop on repair.
      expect(() => validateVoiceSettings(sanitized)).not.toThrow();
    }
    const custom = sanitizeVoiceSettings(hostile[2]);
    expect(custom.input).toEqual({
      provider: 'custom:lab',
      modelId: 'whisper-1',
      language: 'en',
    });
    expect(custom.output.speed).toBe(0.5);
  });

  test('loadVoiceSettings repairs a poisoned file on disk', async () => {
    const previousDataDir = process.env.KORYPHAIOS_DATA_DIR;
    const tempDir = mkdtempSync(join(tmpdir(), 'kory-voice-settings-'));
    process.env.KORYPHAIOS_DATA_DIR = tempDir;
    try {
      const settingsPath = join(tempDir, 'voice-settings.json');
      writeFileSync(
        settingsPath,
        JSON.stringify({
          input: { provider: 'system', modelId: 'stt-unavailable', language: 'en' },
          output: { provider: 'openai', modelId: 'gpt-4o-mini-tts', voiceId: 'alloy', speed: 1 },
          autoReadFinalReplies: true,
          voiceModeEnabled: true,
        }),
      );
      const loaded = await loadVoiceSettings();
      expect(loaded.input.modelId).toBe('web-speech-recognition');
      expect(loaded.output).toEqual({
        provider: 'openai',
        modelId: 'gpt-4o-mini-tts',
        voiceId: 'alloy',
        speed: 1,
      });
      expect(loaded.autoReadFinalReplies).toBe(true);
      // The file on disk is now valid — a second load takes the fast path.
      const reloaded = await loadVoiceSettings();
      expect(reloaded).toEqual(loaded);
      expect(() =>
        validateVoiceSettings(JSON.parse(readFileSync(settingsPath, 'utf8'))),
      ).not.toThrow();
    } finally {
      if (previousDataDir === undefined) delete process.env.KORYPHAIOS_DATA_DIR;
      else process.env.KORYPHAIOS_DATA_DIR = previousDataDir;
    }
  });

  test('catalog exposes system, API, and local speech paths', async () => {
    const providers = await listVoiceProviders();
    expect(providers.map((provider) => provider.id)).toEqual([
      'system',
      'openai',
      'groq',
      'deepgram',
      'assemblyai',
      'local',
      'lmstudio',
      'llamacpp',
    ]);
    expect(providers[0]).toMatchObject({
      capabilities: ['stt', 'tts'],
      configured: true,
      local: true,
    });
    expect(providers.find((provider) => provider.id === 'local')).toMatchObject({
      capabilities: ['stt', 'tts'],
      local: true,
    });
    const openai = providers.find((provider) => provider.id === 'openai');
    expect(openai?.models?.some((model) => model.id === 'gpt-4o-mini-tts')).toBe(true);
    expect(openai?.voices?.map((voice) => voice.id)).toContain('alloy');
    const groq = providers.find((provider) => provider.id === 'groq');
    expect(groq?.capabilities).toContain('tts');
    expect(groq?.voices?.map((voice) => voice.id)).toContain('Fritz-PlayAI');
    const deepgram = providers.find((provider) => provider.id === 'deepgram');
    expect(deepgram?.models?.some((model) => model.id === 'aura-asteria-en')).toBe(true);
    const assemblyai = providers.find((provider) => provider.id === 'assemblyai');
    expect(assemblyai?.capabilities).toEqual(['stt']);
  });

  test('merges audio models discovered from authenticated providers', async () => {
    setContext({
      providers: {
        getConfigs: () => ({
          openai: { apiKey: 'test-key', baseUrl: 'https://api.openai.com/v1' },
          'custom:voice-lab': { custom: true, kind: 'openai', baseUrl: 'http://localhost:9999/v1' },
        }),
        get: (id: string) => {
          if (id === 'openai') {
            return {
              listModels: () => [
                { id: 'gpt-4o-mini-tts', name: 'GPT-4o mini TTS' },
                { id: 'gpt-4o-transcribe', name: 'GPT-4o Transcribe' },
                { id: 'gpt-5-chat', name: 'GPT-5' },
              ],
            };
          }
          if (id === 'custom:voice-lab') {
            return {
              listModels: () => [
                { id: 'hexgrad/Kokoro-82M', name: 'Kokoro 82M' },
                { id: 'Systran/faster-whisper-large-v3', name: 'Faster Whisper Large v3' },
                { id: 'qwen2.5-coder', name: 'Qwen2.5 Coder' },
              ],
            };
          }
          return undefined;
        },
      },
    } as never);
    const providers = await listVoiceProviders();
    const openai = providers.find((provider) => provider.id === 'openai');
    expect(openai?.models?.map((model) => model.id)).toContain('gpt-4o-mini-tts');
    expect(openai?.models?.map((model) => model.id)).not.toContain('gpt-5-chat');
    const custom = providers.find((provider) => provider.id === 'custom:voice-lab');
    expect(custom?.configured).toBe(true);
    expect(custom?.models?.find((model) => model.id === 'hexgrad/Kokoro-82M')?.capability).toBe(
      'tts',
    );
    expect(
      custom?.models?.find((model) => model.id === 'Systran/faster-whisper-large-v3')?.capability,
    ).toBe('stt');
    expect(custom?.models?.map((model) => model.id)).not.toContain('qwen2.5-coder');
  });
});

describe('speech synthesis dispatch', () => {
  const realFetch = globalThis.fetch;
  const calls: Array<{ url: string; body?: Record<string, unknown> }> = [];

  afterAll(() => {
    globalThis.fetch = realFetch;
  });

  test('synthesizes with the requested provider instead of assuming OpenAI', async () => {
    setContext({
      providers: {
        getConfigs: () => ({
          groq: { apiKey: 'groq-key', baseUrl: 'https://api.groq.com/openai/v1' },
          deepgram: { apiKey: 'dg-key', baseUrl: 'https://api.deepgram.com/v1' },
        }),
      },
    } as never);
    calls.length = 0;
    globalThis.fetch = mock(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input);
      calls.push({ url, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      return new Response(new ArrayBuffer(4), {
        headers: { 'content-type': 'audio/mpeg; charset=binary' },
      });
    }) as unknown as typeof fetch;
    try {
      const groq = await synthesizeCloud({
        text: 'Hello there',
        provider: 'groq',
        modelId: 'playai-tts',
        voiceId: 'Fritz-PlayAI',
        speed: 1.2,
      });
      expect(groq).toMatchObject({
        provider: 'groq',
        modelId: 'playai-tts',
        mimeType: 'audio/mpeg',
      });
      expect(calls[0]?.url).toBe('https://api.groq.com/openai/v1/audio/speech');
      expect(calls[0]?.body).toMatchObject({
        model: 'playai-tts',
        voice: 'Fritz-PlayAI',
        speed: 1.2,
      });

      const deepgram = await synthesizeCloud({
        text: 'Hello there',
        provider: 'deepgram',
        modelId: 'aura-asteria-en',
      });
      expect(deepgram).toMatchObject({ provider: 'deepgram', modelId: 'aura-asteria-en' });
      expect(calls[1]?.url).toBe('https://api.deepgram.com/v1/speak?model=aura-asteria-en');
      expect(calls[1]?.body).toEqual({ text: 'Hello there' });

      await expect(
        synthesizeCloud({ text: 'Hello', provider: 'assemblyai', modelId: 'universal-2' }),
      ).rejects.toThrow('does not support speech synthesis');
      await expect(
        synthesizeCloud({ text: 'Hello', provider: 'system', modelId: 'web-speech-synthesis' }),
      ).rejects.toThrow('runs on this device');
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});
