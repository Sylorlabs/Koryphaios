import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type {
  SynthesisRequest,
  SynthesisResult,
  TranscriptionResult,
  VoiceProviderDescriptor,
  VoiceSettings,
} from '@koryphaios/shared';
import {
  estimateSpeechCostUsd,
  estimateTranscriptionCostUsd,
  recordApiUsage,
} from '../billing/api-usage-ledger';
import { getContext } from '../context';
import { ValidationError } from '../errors/types';
import { serverLog } from '../logger';
import { PROJECT_ROOT } from '../runtime/paths';

export const DEFAULT_VOICE_SETTINGS: VoiceSettings = {
  input: { provider: 'system', modelId: 'web-speech-recognition', language: 'en' },
  output: {
    provider: 'system',
    modelId: 'web-speech-synthesis',
    voiceId: 'system-default',
    speed: 1,
  },
  autoReadFinalReplies: false,
  voiceModeEnabled: true,
};

/** Resolved per call so tests can redirect the data dir via env. */
function settingsDir(): string {
  return process.env.KORYPHAIOS_DATA_DIR?.trim() || join(PROJECT_ROOT, '.koryphaios');
}

function settingsPath(): string {
  return join(settingsDir(), 'voice-settings.json');
}
const OPENAI_TTS_VOICES = [
  'alloy',
  'ash',
  'ballad',
  'coral',
  'echo',
  'fable',
  'nova',
  'onyx',
  'sage',
  'shimmer',
  'verse',
].map((id) => ({ id, name: id.charAt(0).toUpperCase() + id.slice(1) }));

const PLAYAI_TTS_VOICES = [
  'Arista-PlayAI',
  'Atlas-PlayAI',
  'Basil-PlayAI',
  'Briggs-PlayAI',
  'Calum-PlayAI',
  'Celeste-PlayAI',
  'Cheyenne-PlayAI',
  'Chip-PlayAI',
  'Fritz-PlayAI',
  'Gail-PlayAI',
  'Indigo-PlayAI',
  'Mamaw-PlayAI',
  'Mason-PlayAI',
  'Mikail-PlayAI',
  'Mitch-PlayAI',
  'Quinn-PlayAI',
  'Thunder-PlayAI',
].map((id) => ({ id, name: id.replace('-PlayAI', '') }));

const DEEPGRAM_TTS_MODELS = [
  'aura-asteria-en',
  'aura-luna-en',
  'aura-stella-en',
  'aura-athena-en',
  'aura-hera-en',
  'aura-orion-en',
  'aura-arcas-en',
  'aura-puck-en',
  'aura-zeus-en',
].map((id) => ({ id, name: id, capability: 'tts' as const }));

const PROVIDERS: Array<Omit<VoiceProviderDescriptor, 'configured'>> = [
  {
    id: 'system',
    name: 'Browser / operating system',
    capabilities: ['stt', 'tts'],
    local: true,
    supportsDiscovery: true,
    models: [
      { id: 'web-speech-recognition', name: 'System speech recognition', capability: 'stt' },
    ],
  },
  {
    id: 'openai',
    name: 'OpenAI Audio',
    capabilities: ['stt', 'tts'],
    local: false,
    supportsDiscovery: true,
    models: [
      { id: 'gpt-4o-mini-transcribe', name: 'GPT-4o mini Transcribe', capability: 'stt' },
      { id: 'gpt-4o-transcribe', name: 'GPT-4o Transcribe', capability: 'stt' },
      { id: 'whisper-1', name: 'Whisper', capability: 'stt' },
      { id: 'gpt-4o-mini-tts', name: 'GPT-4o mini TTS', capability: 'tts' },
      { id: 'tts-1', name: 'TTS-1', capability: 'tts' },
      { id: 'tts-1-hd', name: 'TTS-1 HD', capability: 'tts' },
    ],
    voices: OPENAI_TTS_VOICES,
  },
  {
    id: 'groq',
    name: 'Groq Audio',
    capabilities: ['stt', 'tts'],
    local: false,
    supportsDiscovery: true,
    models: [
      { id: 'whisper-large-v3-turbo', name: 'Whisper Large v3 Turbo', capability: 'stt' },
      { id: 'whisper-large-v3', name: 'Whisper Large v3', capability: 'stt' },
      { id: 'playai-tts', name: 'PlayAI TTS', capability: 'tts' },
    ],
    voices: PLAYAI_TTS_VOICES,
  },
  {
    id: 'deepgram',
    name: 'Deepgram',
    capabilities: ['stt', 'tts'],
    local: false,
    supportsDiscovery: false,
    models: [{ id: 'nova-3', name: 'Nova 3', capability: 'stt' }, ...DEEPGRAM_TTS_MODELS],
  },
  {
    id: 'assemblyai',
    name: 'AssemblyAI',
    capabilities: ['stt'],
    local: false,
    supportsDiscovery: false,
    models: [
      { id: 'universal-3-5-pro', name: 'Universal 3.5 Pro', capability: 'stt' },
      { id: 'universal-2', name: 'Universal 2', capability: 'stt' },
    ],
  },
  {
    id: 'local',
    name: 'Local OpenAI-compatible endpoint',
    capabilities: ['stt', 'tts'],
    local: true,
    supportsDiscovery: true,
    models: [
      { id: 'whisper-1', name: 'Whisper / loaded local model', capability: 'stt' },
      { id: 'tts-1', name: 'Endpoint speech model', capability: 'tts' },
    ],
  },
  {
    id: 'lmstudio',
    name: 'LM Studio',
    capabilities: ['stt', 'tts'],
    local: true,
    supportsDiscovery: true,
    models: [
      { id: 'whisper-1', name: 'Loaded local model', capability: 'stt' },
      { id: 'tts-1', name: 'Endpoint speech model', capability: 'tts' },
    ],
  },
  {
    id: 'llamacpp',
    name: 'llama.cpp compatible server',
    capabilities: ['stt', 'tts'],
    local: true,
    supportsDiscovery: true,
    models: [
      { id: 'whisper-1', name: 'Loaded local model', capability: 'stt' },
      { id: 'tts-1', name: 'Endpoint speech model', capability: 'tts' },
    ],
  },
];

const INPUT_PROVIDER_IDS = new Set(
  PROVIDERS.filter((provider) => provider.capabilities.includes('stt')).map(
    (provider) => provider.id,
  ),
);

const TTS_PROVIDER_IDS = new Set(
  PROVIDERS.filter((provider) => provider.capabilities.includes('tts')).map(
    (provider) => provider.id,
  ),
);

export function validateVoiceSettings(value: unknown): VoiceSettings {
  if (!value || typeof value !== 'object')
    throw new ValidationError('Voice settings must be an object');
  const v = value as VoiceSettings;
  for (const side of [v.input, v.output]) {
    if (!side || typeof side.provider !== 'string' || typeof side.modelId !== 'string')
      throw new ValidationError('Provider and model ID are required');
  }
  if (!INPUT_PROVIDER_IDS.has(v.input.provider) && !v.input.provider.startsWith('custom:'))
    throw new ValidationError('Select a supported speech-to-text provider.');
  if (v.input.provider === 'system' && v.input.modelId !== 'web-speech-recognition')
    throw new ValidationError('Select the supported system speech recognition model.');
  if (v.output.provider === 'system') {
    if (v.output.modelId !== 'web-speech-synthesis')
      throw new ValidationError('Select the supported system speech synthesis model.');
  } else if (!TTS_PROVIDER_IDS.has(v.output.provider) && !v.output.provider.startsWith('custom:')) {
    throw new ValidationError('Select a supported speech output provider.');
  } else if (!v.output.modelId?.trim()) {
    throw new ValidationError('Select a supported speech output model.');
  }
  if (!v.input.language?.trim()) throw new ValidationError('Input language is required');
  if (!v.output.voiceId?.trim()) throw new ValidationError('Output voice is required');
  if (!Number.isFinite(v.output.speed) || v.output.speed < 0.5 || v.output.speed > 2)
    throw new ValidationError('Speech speed must be between 0.5 and 2');
  if (typeof v.autoReadFinalReplies !== 'boolean')
    throw new ValidationError('Auto-read must be boolean');
  if (typeof v.voiceModeEnabled !== 'boolean')
    throw new ValidationError('Voice mode settings must be boolean');
  return structuredClone(v);
}

function clampSpeechSpeed(value: unknown): number {
  const speed = typeof value === 'number' && Number.isFinite(value) ? value : 1;
  return Math.min(2, Math.max(0.5, speed));
}

/**
 * Repair a stale settings file instead of discarding it: keep every field
 * that is still valid, collapse legacy sentinels (e.g. 'stt-unavailable')
 * and unknown providers to defaults. Without this, one stale field reset
 * the user's whole voice configuration on every load.
 */
export function sanitizeVoiceSettings(raw: unknown): VoiceSettings {
  const defaults = structuredClone(DEFAULT_VOICE_SETTINGS);
  if (!raw || typeof raw !== 'object') return defaults;
  const source = raw as Record<string, unknown>;
  const input = (source.input ?? {}) as Record<string, unknown>;
  const output = (source.output ?? {}) as Record<string, unknown>;

  const settings: VoiceSettings = {
    input: {
      provider:
        typeof input.provider === 'string' && input.provider.trim()
          ? input.provider.trim()
          : defaults.input.provider,
      modelId:
        typeof input.modelId === 'string' && input.modelId.trim()
          ? input.modelId.trim()
          : defaults.input.modelId,
      language:
        typeof input.language === 'string' && input.language.trim()
          ? input.language.trim()
          : defaults.input.language,
    },
    output: {
      provider:
        typeof output.provider === 'string' && output.provider.trim()
          ? output.provider.trim()
          : defaults.output.provider,
      modelId:
        typeof output.modelId === 'string' && output.modelId.trim()
          ? output.modelId.trim()
          : defaults.output.modelId,
      voiceId:
        typeof output.voiceId === 'string' && output.voiceId.trim()
          ? output.voiceId.trim()
          : defaults.output.voiceId,
      speed: clampSpeechSpeed(output.speed),
    },
    autoReadFinalReplies:
      typeof source.autoReadFinalReplies === 'boolean'
        ? source.autoReadFinalReplies
        : defaults.autoReadFinalReplies,
    voiceModeEnabled:
      typeof source.voiceModeEnabled === 'boolean'
        ? source.voiceModeEnabled
        : defaults.voiceModeEnabled,
  };

  // System providers only accept their built-in model ids.
  if (settings.input.provider === 'system') settings.input.modelId = 'web-speech-recognition';
  if (settings.output.provider === 'system') {
    settings.output.modelId = 'web-speech-synthesis';
    settings.output.voiceId = 'system-default';
  }
  // Unknown providers fall back per side, preserving the other side's picks.
  if (
    !INPUT_PROVIDER_IDS.has(settings.input.provider) &&
    !settings.input.provider.startsWith('custom:')
  ) {
    settings.input = structuredClone(defaults.input);
  }
  if (
    !TTS_PROVIDER_IDS.has(settings.output.provider) &&
    !settings.output.provider.startsWith('custom:')
  ) {
    settings.output = structuredClone(defaults.output);
  }
  return settings;
}

export async function loadVoiceSettings(): Promise<VoiceSettings> {
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(settingsPath(), 'utf8'));
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    // A missing file is normal first-run state; a corrupt one means user
    // configuration could not be read and deserves visibility.
    const isMissing = (err as NodeJS.ErrnoException | undefined)?.code === 'ENOENT';
    serverLog[isMissing ? 'debug' : 'warn'](
      { err: message, path: settingsPath() },
      isMissing
        ? 'Voice settings file missing; using defaults'
        : 'Voice settings file is corrupt; using defaults until it is re-saved',
    );
    return structuredClone(DEFAULT_VOICE_SETTINGS);
  }
  try {
    return validateVoiceSettings(raw);
  } catch {
    const sanitized = sanitizeVoiceSettings(raw);
    serverLog.info(
      { path: settingsPath() },
      'Voice settings contained stale fields; sanitized and re-saved',
    );
    try {
      await saveVoiceSettings(sanitized);
    } catch (saveErr: unknown) {
      serverLog.debug(
        { err: saveErr instanceof Error ? saveErr.message : String(saveErr) },
        'Failed to persist sanitized voice settings',
      );
    }
    return sanitized;
  }
}

export async function saveVoiceSettings(value: unknown): Promise<VoiceSettings> {
  const valid = validateVoiceSettings(value);
  await mkdir(settingsDir(), { recursive: true });
  const partial = `${settingsPath()}.partial-${randomUUID()}`;
  await writeFile(partial, JSON.stringify(valid, null, 2), { mode: 0o600 });
  await rename(partial, settingsPath());
  return valid;
}

type VoiceProviderConfig = {
  apiKey?: string;
  authToken?: string;
  baseUrl?: string;
  disabled?: boolean;
  headers?: Record<string, string>;
};

function providerConfigs(): Record<string, VoiceProviderConfig> {
  try {
    return getContext().providers.getConfigs();
  } catch {
    return {};
  }
}

function providerIsConfigured(id: string, config: VoiceProviderConfig | undefined): boolean {
  if (id === 'system') return true;
  if (!config || config.disabled) return false;
  if (id === 'local' || id === 'lmstudio' || id === 'llamacpp' || id.startsWith('custom:'))
    return Boolean(config.baseUrl?.trim());
  return Boolean(config.apiKey?.trim() || config.authToken?.trim());
}

const DISCOVERED_STT_PATTERN = /(whisper|transcribe|transcription|moonshine|voxtral|asr)/i;
const DISCOVERED_TTS_PATTERN =
  /(tts|kokoro|piper|vits|matcha|supertonic|pockettts|kitten|styletts|melo|speech)/i;

/** Best-effort classification of a live-discovered model as speech input or output. */
function classifyAudioModel(id: string): 'stt' | 'tts' | undefined {
  if (DISCOVERED_STT_PATTERN.test(id)) return 'stt';
  if (DISCOVERED_TTS_PATTERN.test(id)) return 'tts';
  return undefined;
}

/**
 * Merge audio-capable models discovered from the authenticated provider
 * (registry catalog cache) into the curated voice model list. Chat models are
 * ignored; curated entries always win over discovered duplicates.
 */
function mergeDiscoveredVoiceModels(
  descriptor: Omit<VoiceProviderDescriptor, 'configured'>,
): VoiceProviderDescriptor['models'] {
  let registryProvider:
    { listModels(): Array<{ id: string; name?: string; apiModelId?: string }> } | undefined;
  try {
    registryProvider = getContext().providers.get(descriptor.id);
  } catch {
    return descriptor.models;
  }
  if (!registryProvider) return descriptor.models;
  let live: Array<{ id: string; name?: string; apiModelId?: string }> = [];
  try {
    live = registryProvider.listModels();
  } catch (err: unknown) {
    serverLog.debug(
      { err: err instanceof Error ? err.message : String(err), provider: descriptor.id },
      'Voice model discovery failed',
    );
    return descriptor.models;
  }
  const curated = new Set((descriptor.models ?? []).map((model) => model.id));
  const discovered = live
    .map((def) => {
      const id = def.apiModelId?.trim() || def.id;
      return { id, name: def.name?.trim() || id, capability: classifyAudioModel(id) };
    })
    .filter(
      (entry): entry is { id: string; name: string; capability: 'stt' | 'tts' } =>
        Boolean(entry.capability) && !curated.has(entry.id),
    );
  return [...(descriptor.models ?? []), ...discovered];
}

export async function listVoiceProviders(): Promise<VoiceProviderDescriptor[]> {
  const configs = providerConfigs();
  const builtIns = PROVIDERS.map((provider) => ({
    ...provider,
    configured: providerIsConfigured(provider.id, configs[provider.id]),
    models: mergeDiscoveredVoiceModels(provider),
  }));
  const custom: VoiceProviderDescriptor[] = Object.entries(configs)
    .filter(([id, config]) => id.startsWith('custom:') && providerIsConfigured(id, config))
    .map(([id]) => ({
      id,
      name: id.slice('custom:'.length),
      capabilities: ['stt', 'tts'],
      local: true,
      configured: true,
      supportsDiscovery: true,
      models: mergeDiscoveredVoiceModels({
        id,
        name: id.slice('custom:'.length),
        capabilities: ['stt', 'tts'],
        local: true,
        supportsDiscovery: true,
        models: [
          { id: 'whisper-1', name: 'Loaded endpoint model', capability: 'stt' as const },
          { id: 'tts-1', name: 'Endpoint speech model', capability: 'tts' as const },
        ],
      }),
    }));
  return [...builtIns, ...custom];
}

function voiceProviderConfig(provider: string): VoiceProviderConfig {
  const config = providerConfigs()[provider];
  if (!providerIsConfigured(provider, config))
    throw new ValidationError(
      `Connect or configure ${provider} in Providers before using cloud speech.`,
    );
  return config!;
}

type TranscriptionRequest = { audioBase64?: string; mimeType?: string; language?: string };

type AudioInput = { bytes: Uint8Array<ArrayBuffer>; mimeType: string; extension: string };

function decodeAudio(request: TranscriptionRequest): AudioInput {
  if (!request.audioBase64) throw new ValidationError('Recorded audio is required');
  const bytes = Uint8Array.from(Buffer.from(request.audioBase64, 'base64'));
  if (!bytes.length || bytes.length > 25 * 1024 * 1024)
    throw new ValidationError('Audio must be between 1 byte and 25 MB');
  const mimeType = request.mimeType || 'audio/webm';
  const extension = mimeType.includes('mp4')
    ? 'm4a'
    : mimeType.includes('ogg')
      ? 'ogg'
      : mimeType.includes('wav')
        ? 'wav'
        : 'webm';
  return { bytes, mimeType, extension };
}

function providerBaseUrl(provider: string, config: VoiceProviderConfig): string {
  const raw = config.baseUrl?.replace(/\/$/, '');
  if (!raw) throw new ValidationError(`${provider} does not have a speech API base URL.`);
  if (provider === 'lmstudio' || provider === 'llamacpp' || provider === 'local')
    return raw.endsWith('/v1') ? raw : `${raw}/v1`;
  return raw;
}

function providerHeaders(config: VoiceProviderConfig, scheme = 'Bearer'): Record<string, string> {
  const token = config.apiKey || config.authToken;
  return {
    ...config.headers,
    ...(token ? { Authorization: `${scheme} ${token}` } : {}),
  };
}

async function transcribeOpenAICompatible(
  provider: string,
  modelId: string,
  request: TranscriptionRequest,
  audio: AudioInput,
): Promise<string> {
  const config = voiceProviderConfig(provider);
  const form = new FormData();
  form.set(
    'file',
    new Blob([audio.bytes], { type: audio.mimeType }),
    `recording.${audio.extension}`,
  );
  form.set('model', modelId);
  if (request.language) form.set('language', request.language);
  const response = await fetch(`${providerBaseUrl(provider, config)}/audio/transcriptions`, {
    method: 'POST',
    headers: providerHeaders(config),
    body: form,
    signal: AbortSignal.timeout(120_000),
  });
  const result = (await response.json().catch(() => ({}))) as {
    text?: string;
    error?: { message?: string } | string;
  };
  if (!response.ok) {
    const detail = typeof result.error === 'string' ? result.error : result.error?.message;
    throw new ValidationError(
      detail || `${provider} transcription returned HTTP ${response.status}`,
    );
  }
  if (!result.text?.trim()) throw new ValidationError('Transcription returned no text');
  return result.text.trim();
}

async function transcribeDeepgram(
  modelId: string,
  request: TranscriptionRequest,
  audio: AudioInput,
): Promise<string> {
  const config = voiceProviderConfig('deepgram');
  const query = new URLSearchParams({ model: modelId, smart_format: 'true' });
  if (request.language) query.set('language', request.language);
  const response = await fetch(`${providerBaseUrl('deepgram', config)}/listen?${query}`, {
    method: 'POST',
    headers: { ...providerHeaders(config, 'Token'), 'Content-Type': audio.mimeType },
    body: audio.bytes,
    signal: AbortSignal.timeout(120_000),
  });
  const result = (await response.json().catch(() => ({}))) as {
    err_msg?: string;
    results?: { channels?: Array<{ alternatives?: Array<{ transcript?: string }> }> };
  };
  if (!response.ok)
    throw new ValidationError(
      result.err_msg || `Deepgram transcription returned HTTP ${response.status}`,
    );
  const text = result.results?.channels?.[0]?.alternatives?.[0]?.transcript?.trim();
  if (!text) throw new ValidationError('Transcription returned no text');
  return text;
}

async function transcribeAssemblyAI(
  modelId: string,
  request: TranscriptionRequest,
  audio: AudioInput,
): Promise<string> {
  const config = voiceProviderConfig('assemblyai');
  const baseUrl = providerBaseUrl('assemblyai', config);
  const token = config.apiKey || config.authToken;
  const headers: Record<string, string> = token ? { Authorization: token } : {};
  const upload = await fetch(`${baseUrl}/upload`, {
    method: 'POST',
    headers: { ...headers, 'Content-Type': audio.mimeType },
    body: audio.bytes,
    signal: AbortSignal.timeout(120_000),
  });
  const uploadResult = (await upload.json().catch(() => ({}))) as {
    upload_url?: string;
    error?: string;
  };
  if (!upload.ok || !uploadResult.upload_url)
    throw new ValidationError(
      uploadResult.error || `AssemblyAI upload returned HTTP ${upload.status}`,
    );
  const create = await fetch(`${baseUrl}/transcript`, {
    method: 'POST',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      audio_url: uploadResult.upload_url,
      speech_models: [modelId],
      ...(request.language ? { language_code: request.language } : {}),
    }),
    signal: AbortSignal.timeout(120_000),
  });
  const created = (await create.json().catch(() => ({}))) as { id?: string; error?: string };
  if (!create.ok || !created.id)
    throw new ValidationError(
      created.error || `AssemblyAI transcription returned HTTP ${create.status}`,
    );
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    await Bun.sleep(750);
    const response = await fetch(`${baseUrl}/transcript/${created.id}`, {
      headers,
      signal: AbortSignal.timeout(15_000),
    });
    const result = (await response.json().catch(() => ({}))) as {
      status?: string;
      text?: string;
      error?: string;
    };
    if (!response.ok)
      throw new ValidationError(
        result.error || `AssemblyAI status returned HTTP ${response.status}`,
      );
    if (result.status === 'error')
      throw new ValidationError(result.error || 'AssemblyAI transcription failed');
    if (result.status === 'completed') {
      if (!result.text?.trim()) throw new ValidationError('Transcription returned no text');
      return result.text.trim();
    }
  }
  throw new ValidationError('AssemblyAI transcription timed out');
}

export async function transcribeRecording(
  request: TranscriptionRequest,
): Promise<TranscriptionResult> {
  const audio = decodeAudio(request);
  const settings = await loadVoiceSettings();
  const { provider, modelId } = settings.input;
  if (provider === 'system')
    throw new ValidationError('System speech recognition runs on this device in the composer.');
  const startedAt = Date.now();
  const text =
    provider === 'deepgram'
      ? await transcribeDeepgram(modelId, request, audio)
      : provider === 'assemblyai'
        ? await transcribeAssemblyAI(modelId, request, audio)
        : await transcribeOpenAICompatible(provider, modelId, request, audio);
  await recordApiUsage({
    kind: 'stt',
    provider,
    model: modelId,
    estimatedCostUsd: estimateTranscriptionCostUsd(modelId, audio.bytes.length),
    units: { measure: 'minutes', amount: Number((audio.bytes.length / 32_000 / 60).toFixed(3)) },
  });
  return {
    text,
    language: request.language,
    durationMs: Date.now() - startedAt,
    provider,
    modelId,
  };
}

export const transcribeCloud = transcribeRecording;

type SynthesisPayload = { audioBase64: string; mimeType: string };

async function synthesizeOpenAICompatibleSpeech(
  provider: string,
  modelId: string,
  request: SynthesisRequest,
): Promise<SynthesisPayload> {
  const config = voiceProviderConfig(provider);
  const voice =
    request.voiceId?.trim() && request.voiceId !== 'default' ? request.voiceId.trim() : 'alloy';
  const response = await fetch(`${providerBaseUrl(provider, config)}/audio/speech`, {
    method: 'POST',
    headers: { ...providerHeaders(config), 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: modelId,
      input: request.text,
      voice,
      speed: request.speed ?? 1,
      response_format: 'mp3',
    }),
    signal: AbortSignal.timeout(120_000),
  });
  if (!response.ok) {
    const result = (await response.json().catch(() => ({}))) as {
      error?: { message?: string } | string;
    };
    const detail = typeof result.error === 'string' ? result.error : result.error?.message;
    throw new ValidationError(detail || `${provider} speech returned HTTP ${response.status}`);
  }
  return {
    audioBase64: Buffer.from(await response.arrayBuffer()).toString('base64'),
    mimeType: response.headers.get('content-type')?.split(';')[0] || 'audio/mpeg',
  };
}

async function synthesizeDeepgram(
  modelId: string,
  request: SynthesisRequest,
): Promise<SynthesisPayload> {
  const config = voiceProviderConfig('deepgram');
  const query = new URLSearchParams({ model: modelId });
  const response = await fetch(`${providerBaseUrl('deepgram', config)}/speak?${query}`, {
    method: 'POST',
    headers: { ...providerHeaders(config, 'Token'), 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: request.text }),
    signal: AbortSignal.timeout(120_000),
  });
  if (!response.ok) {
    const result = (await response.json().catch(() => ({}))) as { err_msg?: string };
    throw new ValidationError(result.err_msg || `Deepgram speech returned HTTP ${response.status}`);
  }
  return {
    audioBase64: Buffer.from(await response.arrayBuffer()).toString('base64'),
    mimeType: response.headers.get('content-type')?.split(';')[0] || 'audio/mpeg',
  };
}

export async function synthesizeCloud(request: SynthesisRequest): Promise<SynthesisResult> {
  if (!request.text?.trim()) throw new ValidationError('Text is required');
  if (request.text.length > 4096)
    throw new ValidationError('Speech text must be 4,096 characters or fewer');
  const settings = await loadVoiceSettings();
  const provider = request.provider?.trim() || settings.output.provider;
  const modelId = request.modelId?.trim() || settings.output.modelId;
  if (provider === 'system')
    throw new ValidationError('System speech synthesis runs on this device in the browser.');
  if (!TTS_PROVIDER_IDS.has(provider) && !provider.startsWith('custom:'))
    throw new ValidationError(`${provider} does not support speech synthesis.`);
  const startedAt = Date.now();
  const payload =
    provider === 'deepgram'
      ? await synthesizeDeepgram(modelId, request)
      : await synthesizeOpenAICompatibleSpeech(provider, modelId, request);
  await recordApiUsage({
    kind: 'tts',
    provider,
    model: modelId,
    estimatedCostUsd: estimateSpeechCostUsd(modelId, request.text.length),
    units: { measure: 'characters', amount: request.text.length },
  });
  return {
    ...payload,
    durationMs: Date.now() - startedAt,
    provider,
    modelId,
  };
}
