import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type {
  SynthesisRequest,
  SynthesisResult,
  TranscriptionResult,
  VoicePackManifest,
  VoicePackStatus,
  VoiceProviderDescriptor,
  VoiceSettings,
} from '@koryphaios/shared';
import { getContext } from '../context';
import { ValidationError } from '../errors/types';
import { serverLog } from '../logger';
import { PROJECT_ROOT } from '../runtime/paths';

export const DEFAULT_VOICE_SETTINGS: VoiceSettings = {
  input: { provider: 'openai', modelId: 'gpt-4o-mini-transcribe', language: 'en' },
  output: {
    provider: 'system',
    modelId: 'web-speech-synthesis',
    voiceId: 'system-default',
    speed: 1,
  },
  autoReadFinalReplies: false,
  voiceModeEnabled: true,
  liveTranscription: false,
};

const SETTINGS_DIR = process.env.KORYPHAIOS_DATA_DIR ?? join(PROJECT_ROOT, '.koryphaios');
const SETTINGS_PATH = join(SETTINGS_DIR, 'voice-settings.json');
const VOICE_PACKS_DIR = join(SETTINGS_DIR, 'voice-packs');

type DownloadableVoicePack = {
  manifest: VoicePackManifest;
  baseUrl: string;
};

const ENGLISH_DICTATION_PACK: DownloadableVoicePack = {
  manifest: {
    schemaVersion: 1,
    id: 'moonshine-tiny-en-int8',
    version: '2026-08-01',
    name: 'Moonshine English Dictation',
    family: 'moonshine',
    capabilities: ['stt'],
    languages: ['en'],
    license: { name: 'MIT', file: 'https://github.com/moonshine-ai/moonshine/blob/main/LICENSE' },
    sizeBytes: 43_943_830,
    files: [
      {
        path: 'encoder_model.ort',
        sizeBytes: 13_281_600,
        sha256: '94e90a4654fc45cdfedb77c4c08e1739f48862998e58fada384b25118134f221',
      },
      {
        path: 'decoder_model_merged.ort',
        sizeBytes: 30_412_256,
        sha256: 'cf524c4862d36e9e5ab032eddc73637efd822d70e868ac575cf1a46e1e4708a0',
      },
      {
        path: 'tokenizer.bin',
        sizeBytes: 249_974,
        sha256: '6884b35fd6377d4c4d32336a0bc152f36b64d1e45b6503683cdc238250a8472d',
      },
    ],
  },
  baseUrl: 'https://download.moonshine.ai/model/tiny-en/quantized/tiny-en',
};

const VOICE_PACKS = new Map([[ENGLISH_DICTATION_PACK.manifest.id, ENGLISH_DICTATION_PACK]]);
const voicePackDownloads = new Map<string, Promise<VoicePackStatus>>();

async function packIsInstalled(pack: DownloadableVoicePack): Promise<boolean> {
  const root = join(VOICE_PACKS_DIR, pack.manifest.id);
  try {
    const sizes = await Promise.all(
      pack.manifest.files.map((file) => stat(join(root, file.path)).then((value) => value.size)),
    );
    return sizes.every((size, index) => size === pack.manifest.files[index].sizeBytes);
  } catch (err: unknown) {
    serverLog.debug(
      { err: err instanceof Error ? err.message : String(err), packId: pack.manifest.id },
      'Voice pack not installed or incomplete',
    );
    return false;
  }
}

export async function listVoicePacks(): Promise<VoicePackStatus[]> {
  return Promise.all(
    [...VOICE_PACKS.values()].map(async (pack) => ({
      manifest: pack.manifest,
      state: (await packIsInstalled(pack))
        ? ('installed' as const)
        : voicePackDownloads.has(pack.manifest.id)
          ? ('downloading' as const)
          : ('available' as const),
    })),
  );
}

async function downloadVoicePackFile(
  url: string,
  destination: string,
  sizeBytes: number,
  sha256: string,
): Promise<void> {
  const response = await fetch(url, { signal: AbortSignal.timeout(120_000) });
  if (!response.ok) throw new ValidationError(`Model host returned HTTP ${response.status}`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength !== sizeBytes)
    throw new ValidationError(
      `Downloaded model file has the wrong size (${bytes.byteLength} bytes)`,
    );
  const digest = createHash('sha256').update(bytes).digest('hex');
  if (digest !== sha256)
    throw new ValidationError('Downloaded model file failed checksum verification');
  await writeFile(destination, bytes, { mode: 0o600 });
}

export function downloadVoicePack(id: string): Promise<VoicePackStatus> {
  const pack = VOICE_PACKS.get(id);
  if (!pack) return Promise.reject(new ValidationError('Unknown voice pack'));
  const existing = voicePackDownloads.get(id);
  if (existing) return existing;
  const work = (async () => {
    if (await packIsInstalled(pack))
      return { manifest: pack.manifest, state: 'installed' as const };
    await mkdir(VOICE_PACKS_DIR, { recursive: true });
    const stage = join(VOICE_PACKS_DIR, `.${id}.partial-${randomUUID()}`);
    try {
      await mkdir(stage, { recursive: false, mode: 0o700 });
      for (const file of pack.manifest.files) {
        await downloadVoicePackFile(
          `${pack.baseUrl}/${file.path}`,
          join(stage, file.path),
          file.sizeBytes,
          file.sha256,
        );
      }
      await rm(join(VOICE_PACKS_DIR, id), { recursive: true, force: true });
      await rename(stage, join(VOICE_PACKS_DIR, id));
      return { manifest: pack.manifest, state: 'installed' as const };
    } catch (error) {
      await rm(stage, { recursive: true, force: true }).catch(() => undefined);
      throw error;
    }
  })().finally(() => voicePackDownloads.delete(id));
  voicePackDownloads.set(id, work);
  return work;
}

const PROVIDERS: Array<Omit<VoiceProviderDescriptor, 'configured'>> = [
  {
    id: 'system',
    name: 'Operating system speech',
    capabilities: ['tts'],
    local: true,
    supportsDiscovery: true,
  },
  {
    id: 'openai',
    name: 'OpenAI Audio',
    capabilities: ['stt', 'tts'],
    local: false,
    supportsDiscovery: true,
  },
];

export function validateVoiceSettings(value: unknown): VoiceSettings {
  if (!value || typeof value !== 'object')
    throw new ValidationError('Voice settings must be an object');
  const v = value as VoiceSettings;
  for (const side of [v.input, v.output]) {
    if (!side || typeof side.provider !== 'string' || typeof side.modelId !== 'string')
      throw new ValidationError('Provider and model ID are required');
  }
  if (v.input.provider !== 'openai' || v.input.modelId !== 'gpt-4o-mini-transcribe')
    throw new ValidationError('Select the supported OpenAI transcription model.');
  if (!(
    (v.output.provider === 'system' && v.output.modelId === 'web-speech-synthesis') ||
    (v.output.provider === 'openai' && v.output.modelId === 'gpt-4o-mini-tts')
  ))
    throw new ValidationError('Select a supported speech output model.');
  if (!v.input.language?.trim()) throw new ValidationError('Input language is required');
  if (!v.output.voiceId?.trim()) throw new ValidationError('Output voice is required');
  if (!Number.isFinite(v.output.speed) || v.output.speed < 0.5 || v.output.speed > 2)
    throw new ValidationError('Speech speed must be between 0.5 and 2');
  if (typeof v.autoReadFinalReplies !== 'boolean')
    throw new ValidationError('Auto-read must be boolean');
  if (typeof v.voiceModeEnabled !== 'boolean' || typeof v.liveTranscription !== 'boolean')
    throw new ValidationError('Voice mode settings must be boolean');
  return structuredClone(v);
}

export async function loadVoiceSettings(): Promise<VoiceSettings> {
  try {
    return validateVoiceSettings(JSON.parse(await readFile(SETTINGS_PATH, 'utf8')));
  } catch (err: unknown) {
    serverLog.debug(
      { err: err instanceof Error ? err.message : String(err) },
      'Voice settings file missing or invalid; using defaults',
    );
    return structuredClone(DEFAULT_VOICE_SETTINGS);
  }
}

export async function saveVoiceSettings(value: unknown): Promise<VoiceSettings> {
  const valid = validateVoiceSettings(value);
  await mkdir(SETTINGS_DIR, { recursive: true });
  const partial = `${SETTINGS_PATH}.partial`;
  await writeFile(partial, JSON.stringify(valid, null, 2), { mode: 0o600 });
  await rename(partial, SETTINGS_PATH);
  return valid;
}

export async function listVoiceProviders(): Promise<VoiceProviderDescriptor[]> {
  let openAIConfigured = false;
  try {
    openAIConfigured = Boolean(getContext().providers.getConfigs().openai?.apiKey);
  } catch {
    openAIConfigured = Boolean(process.env.OPENAI_API_KEY);
  }
  return PROVIDERS.map((provider) => ({
    ...provider,
    configured: provider.id === 'system' || openAIConfigured,
  }));
}

function openAIConfig() {
  let config: { apiKey?: string; baseUrl?: string } | undefined;
  try {
    config = getContext().providers.getConfigs().openai;
  } catch {
    config = undefined;
  }
  const apiKey = config?.apiKey || process.env.OPENAI_API_KEY;
  if (!apiKey) throw new ValidationError('Connect OpenAI in Providers before using cloud speech.');
  return { apiKey, baseUrl: (config?.baseUrl || 'https://api.openai.com/v1').replace(/\/$/, '') };
}

export async function transcribeCloud(request: {
  audioBase64?: string;
  mimeType?: string;
  language?: string;
}): Promise<TranscriptionResult> {
  if (!request.audioBase64) throw new ValidationError('Recorded audio is required');
  const { apiKey, baseUrl } = openAIConfig();
  const bytes = Buffer.from(request.audioBase64, 'base64');
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
  const form = new FormData();
  form.set('file', new Blob([bytes], { type: mimeType }), `recording.${extension}`);
  form.set('model', 'gpt-4o-mini-transcribe');
  if (request.language) form.set('language', request.language);
  const startedAt = Date.now();
  const response = await fetch(`${baseUrl}/audio/transcriptions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}` },
    body: form,
    signal: AbortSignal.timeout(120_000),
  });
  const result = (await response.json().catch(() => ({}))) as {
    text?: string;
    error?: { message?: string };
  };
  if (!response.ok)
    throw new ValidationError(
      result.error?.message || `OpenAI transcription returned HTTP ${response.status}`,
    );
  if (!result.text?.trim()) throw new ValidationError('Transcription returned no text');
  return {
    text: result.text.trim(),
    language: request.language,
    durationMs: Date.now() - startedAt,
    provider: 'openai',
    modelId: 'gpt-4o-mini-transcribe',
  };
}

export async function synthesizeCloud(request: SynthesisRequest): Promise<SynthesisResult> {
  if (!request.text?.trim()) throw new ValidationError('Text is required');
  if (request.text.length > 4096)
    throw new ValidationError('Speech text must be 4,096 characters or fewer');
  const { apiKey, baseUrl } = openAIConfig();
  const startedAt = Date.now();
  const response = await fetch(`${baseUrl}/audio/speech`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'gpt-4o-mini-tts',
      input: request.text,
      voice: request.voiceId || 'alloy',
      speed: request.speed ?? 1,
      response_format: 'mp3',
    }),
    signal: AbortSignal.timeout(120_000),
  });
  if (!response.ok) {
    const result = (await response.json().catch(() => ({}))) as { error?: { message?: string } };
    throw new ValidationError(
      result.error?.message || `OpenAI speech returned HTTP ${response.status}`,
    );
  }
  return {
    audioBase64: Buffer.from(await response.arrayBuffer()).toString('base64'),
    mimeType: 'audio/mpeg',
    durationMs: Date.now() - startedAt,
    provider: 'openai',
    modelId: 'gpt-4o-mini-tts',
  };
}
