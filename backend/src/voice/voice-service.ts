import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type {
  SynthesisRequest,
  VoicePackManifest,
  VoicePackStatus,
  VoiceProviderDescriptor,
  VoiceSettings,
} from '@koryphaios/shared';
import { ValidationError } from '../errors/types';
import { serverLog } from '../logger';
import { PROJECT_ROOT } from '../runtime/paths';

export const DEFAULT_VOICE_SETTINGS: VoiceSettings = {
  input: { provider: 'system', modelId: 'stt-unavailable', language: 'en' },
  output: {
    provider: 'system',
    modelId: 'web-speech-synthesis',
    voiceId: 'system-default',
    speed: 1,
  },
  autoReadFinalReplies: false,
  voiceModeEnabled: false,
  liveTranscription: false,
};

export const VOICE_STT_UNAVAILABLE_ERROR =
  'Speech input is unavailable in this build. Koryphaios has no active microphone or transcription runtime, and no audio was uploaded.';
export const VOICE_SERVER_TTS_UNAVAILABLE_ERROR =
  'Server-side speech synthesis is unavailable in this build. Only explicit operating-system speech synthesis can run in the app runtime; no cloud request was made.';
export const VOICE_AUTOMATION_UNAVAILABLE_ERROR =
  'Automatic voice controls are unavailable in this build. Use the explicit system-voice preview only.';
export const VOICE_PACK_RUNTIME_UNAVAILABLE_ERROR =
  'Local voice model downloads are unavailable in this build because Koryphaios has no inference runtime for them. Existing model files were left untouched and no network request was made.';

const SETTINGS_DIR = process.env.KORYPHAIOS_DATA_DIR ?? join(PROJECT_ROOT, '.koryphaios');
const SETTINGS_PATH = join(SETTINGS_DIR, 'voice-settings.json');
const VOICE_PACKS_DIR = join(SETTINGS_DIR, 'voice-packs');

type VoicePackInventoryEntry = {
  manifest: VoicePackManifest;
};

const ENGLISH_DICTATION_PACK: VoicePackInventoryEntry = {
  manifest: {
    schemaVersion: 1,
    id: 'moonshine-tiny-en-int8',
    version: '2026-08-01',
    name: 'English Dictation',
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
};

const VOICE_PACKS = new Map([[ENGLISH_DICTATION_PACK.manifest.id, ENGLISH_DICTATION_PACK]]);

async function packIsInstalled(pack: VoicePackInventoryEntry): Promise<boolean> {
  const root = join(VOICE_PACKS_DIR, pack.manifest.id);
  try {
    const sizes = await Promise.all(
      pack.manifest.files.map((file) => stat(join(root, file.path)).then((value) => value.size)),
    );
    return sizes.every((size, index) => size === pack.manifest.files[index].sizeBytes);
  } catch (err: unknown) {
    // Missing or incomplete pack files mean it isn't installed yet.
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
      state: (await packIsInstalled(pack)) ? ('installed' as const) : ('failed' as const),
      error: VOICE_PACK_RUNTIME_UNAVAILABLE_ERROR,
    })),
  );
}

export function downloadVoicePack(id: string): Promise<VoicePackStatus> {
  if (!VOICE_PACKS.has(id)) return Promise.reject(new ValidationError('Unknown voice pack'));
  return Promise.reject(new ValidationError(VOICE_PACK_RUNTIME_UNAVAILABLE_ERROR));
}
const PROVIDERS: Array<Omit<VoiceProviderDescriptor, 'configured'>> = [
  {
    id: 'system',
    name: 'Operating system speech',
    capabilities: ['tts'],
    local: false,
    supportsDiscovery: true,
  },
];

export function validateVoiceSettings(value: unknown): VoiceSettings {
  if (!value || typeof value !== 'object') throw new Error('Voice settings must be an object');
  const v = value as VoiceSettings;
  for (const side of [v.input, v.output])
    if (!side || typeof side.provider !== 'string' || typeof side.modelId !== 'string')
      throw new Error('Provider and model ID are required');
  if (v.input.provider !== 'system' || v.input.modelId !== 'stt-unavailable')
    throw new Error(VOICE_STT_UNAVAILABLE_ERROR);
  if (v.output.provider !== 'system' || v.output.modelId !== 'web-speech-synthesis')
    throw new Error(VOICE_SERVER_TTS_UNAVAILABLE_ERROR);
  if (!v.input.language?.trim()) throw new Error('Input language is required');
  if (!v.output.voiceId?.trim()) throw new Error('Output voice is required');
  if (!Number.isFinite(v.output.speed) || v.output.speed < 0.5 || v.output.speed > 2)
    throw new Error('Speech speed must be between 0.5 and 2');
  if (typeof v.autoReadFinalReplies !== 'boolean') throw new Error('Auto-read must be boolean');
  if (typeof v.voiceModeEnabled !== 'boolean' || typeof v.liveTranscription !== 'boolean')
    throw new Error('Voice mode settings must be boolean');
  if (v.autoReadFinalReplies || v.voiceModeEnabled || v.liveTranscription)
    throw new Error(VOICE_AUTOMATION_UNAVAILABLE_ERROR);
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
  return PROVIDERS.map((provider) => ({ ...provider, configured: true }));
}
export function assertNoCloudFallback(settings: VoiceSettings, capability: 'stt' | 'tts') {
  const selected = capability === 'stt' ? settings.input : settings.output;
  if (capability === 'stt') throw new ValidationError(VOICE_STT_UNAVAILABLE_ERROR);
  throw new ValidationError(
    selected.provider === 'system'
      ? VOICE_SERVER_TTS_UNAVAILABLE_ERROR
      : `The selected ${capability.toUpperCase()} adapter is unavailable. Koryphaios did not fall back to a cloud provider.`,
  );
}
export async function transcribeCloud(): Promise<never> {
  throw new ValidationError(VOICE_STT_UNAVAILABLE_ERROR);
}
export async function synthesizeCloud(_request: SynthesisRequest): Promise<never> {
  throw new ValidationError(VOICE_SERVER_TTS_UNAVAILABLE_ERROR);
}
