import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { SynthesisRequest, VoicePackManifest, VoicePackStatus, VoiceProviderDescriptor, VoiceSettings } from '@koryphaios/shared';
import { PROJECT_ROOT } from '../runtime/paths';
import { createUserCredentialsService } from '../services';

export const DEFAULT_VOICE_SETTINGS: VoiceSettings = {
  input: { provider: 'local', modelId: 'moonshine-tiny-en-int8', language: 'en' },
  output: { provider: 'local', modelId: 'kitten-tts-0.8-micro', voiceId: 'expr-voice-2-m', speed: 1 },
  autoReadFinalReplies: false,
  voiceModeEnabled: true,
  liveTranscription: true,
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
    name: 'English Dictation',
    family: 'moonshine',
    capabilities: ['stt'],
    languages: ['en'],
    license: { name: 'MIT', file: 'https://github.com/moonshine-ai/moonshine/blob/main/LICENSE' },
    sizeBytes: 43_943_830,
    files: [
      { path: 'encoder_model.ort', sizeBytes: 13_281_600, sha256: '94e90a4654fc45cdfedb77c4c08e1739f48862998e58fada384b25118134f221' },
      { path: 'decoder_model_merged.ort', sizeBytes: 30_412_256, sha256: 'cf524c4862d36e9e5ab032eddc73637efd822d70e868ac575cf1a46e1e4708a0' },
      { path: 'tokenizer.bin', sizeBytes: 249_974, sha256: '6884b35fd6377d4c4d32336a0bc152f36b64d1e45b6503683cdc238250a8472d' },
    ],
  },
  baseUrl: 'https://download.moonshine.ai/model/tiny-en/quantized/tiny-en',
};

const VOICE_PACKS = new Map([[ENGLISH_DICTATION_PACK.manifest.id, ENGLISH_DICTATION_PACK]]);
const voicePackDownloads = new Map<string, Promise<VoicePackStatus>>();

async function packIsInstalled(pack: DownloadableVoicePack): Promise<boolean> {
  const root = join(VOICE_PACKS_DIR, pack.manifest.id);
  try {
    const sizes = await Promise.all(pack.manifest.files.map((file) => stat(join(root, file.path)).then((value) => value.size)));
    return sizes.every((size, index) => size === pack.manifest.files[index].sizeBytes);
  } catch {
    return false;
  }
}

export async function listVoicePacks(): Promise<VoicePackStatus[]> {
  return Promise.all([...VOICE_PACKS.values()].map(async (pack) => ({
    manifest: pack.manifest,
    state: await packIsInstalled(pack) ? 'installed' as const : voicePackDownloads.has(pack.manifest.id) ? 'downloading' as const : 'available' as const,
  })));
}

async function downloadVoicePackFile(url: string, destination: string, sizeBytes: number, sha256: string): Promise<void> {
  const response = await fetch(url, { signal: AbortSignal.timeout(120_000) });
  if (!response.ok) throw new Error(`Model host returned HTTP ${response.status}`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength !== sizeBytes) throw new Error(`Downloaded file has the wrong size (${bytes.byteLength} bytes)`);
  const digest = createHash('sha256').update(bytes).digest('hex');
  if (digest !== sha256) throw new Error('Downloaded file failed checksum verification');
  await writeFile(destination, bytes, { mode: 0o600 });
}

export function downloadVoicePack(id: string): Promise<VoicePackStatus> {
  const pack = VOICE_PACKS.get(id);
  if (!pack) return Promise.reject(new Error('Unknown voice pack'));
  const existing = voicePackDownloads.get(id);
  if (existing) return existing;

  const work = (async () => {
    if (await packIsInstalled(pack)) return { manifest: pack.manifest, state: 'installed' as const };
    await mkdir(VOICE_PACKS_DIR, { recursive: true });
    const stage = join(VOICE_PACKS_DIR, `.${id}.partial-${randomUUID()}`);
    try {
      await mkdir(stage, { recursive: false, mode: 0o700 });
      for (const file of pack.manifest.files) {
        await downloadVoicePackFile(`${pack.baseUrl}/${file.path}`, join(stage, file.path), file.sizeBytes, file.sha256);
      }
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
  { id: 'local', name: 'On device', capabilities: ['stt', 'tts'], local: true, supportsDiscovery: false },
  { id: 'system', name: 'System voice', capabilities: ['stt', 'tts'], local: false, supportsDiscovery: true },
  { id: 'openai', name: 'OpenAI', capabilities: ['stt', 'tts'], local: false, supportsDiscovery: true },
  { id: 'aistudio', name: 'Google AI Studio', capabilities: ['stt', 'tts'], local: false, supportsDiscovery: true },
  { id: 'elevenlabs', name: 'ElevenLabs', capabilities: ['stt', 'tts'], local: false, supportsDiscovery: true },
  { id: 'deepgram', name: 'Deepgram', capabilities: ['stt', 'tts'], local: false, supportsDiscovery: true },
  { id: 'gladia', name: 'Gladia', capabilities: ['stt'], local: false, supportsDiscovery: false },
  { id: 'assemblyai', name: 'AssemblyAI', capabilities: ['stt'], local: false, supportsDiscovery: false },
  { id: 'lmnt', name: 'LMNT', capabilities: ['tts'], local: false, supportsDiscovery: true },
];

export function validateVoiceSettings(value: unknown): VoiceSettings {
  if (!value || typeof value !== 'object') throw new Error('Voice settings must be an object');
  const v = value as VoiceSettings;
  for (const side of [v.input, v.output]) if (!side || typeof side.provider !== 'string' || typeof side.modelId !== 'string') throw new Error('Provider and model ID are required');
  if (!v.input.language?.trim()) throw new Error('Input language is required');
  if (!v.output.voiceId?.trim()) throw new Error('Output voice is required');
  if (!Number.isFinite(v.output.speed) || v.output.speed < 0.5 || v.output.speed > 2) throw new Error('Speech speed must be between 0.5 and 2');
  if (typeof v.autoReadFinalReplies !== 'boolean') throw new Error('Auto-read must be boolean');
  if (typeof v.voiceModeEnabled !== 'boolean' || typeof v.liveTranscription !== 'boolean') throw new Error('Voice mode settings must be boolean');
  return structuredClone(v);
}

export async function loadVoiceSettings(): Promise<VoiceSettings> {
  try { return validateVoiceSettings(JSON.parse(await readFile(SETTINGS_PATH, 'utf8'))); } catch { return structuredClone(DEFAULT_VOICE_SETTINGS); }
}
export async function saveVoiceSettings(value: unknown): Promise<VoiceSettings> {
  const valid = validateVoiceSettings(value); await mkdir(SETTINGS_DIR, { recursive: true });
  const partial = `${SETTINGS_PATH}.partial`; await writeFile(partial, JSON.stringify(valid, null, 2), { mode: 0o600 }); await rename(partial, SETTINGS_PATH); return valid;
}
export async function listVoiceProviders(): Promise<VoiceProviderDescriptor[]> {
  const envKeys: Record<string, string> = { openai: 'OPENAI_API_KEY', aistudio: 'GOOGLE_AI_STUDIO_API_KEY', elevenlabs: 'ELEVENLABS_API_KEY', deepgram: 'DEEPGRAM_API_KEY', gladia: 'GLADIA_API_KEY', assemblyai: 'ASSEMBLYAI_API_KEY', lmnt: 'LMNT_API_KEY' };
  const credentials = createUserCredentialsService();
  return Promise.all(PROVIDERS.map(async p => {
    const saved = p.local || p.id === 'system' ? [] : await credentials.list('local-user', { provider: p.id, isActive: true });
    return { ...p, configured: p.local || p.id === 'system' || saved.some(item => item.type === 'apiKey') || Boolean(process.env[envKeys[p.id]]) };
  }));
}
export function assertNoCloudFallback(settings: VoiceSettings, capability: 'stt' | 'tts') {
  const selected = capability === 'stt' ? settings.input : settings.output;
  if (selected.provider === 'local') throw new Error(`Local ${capability.toUpperCase()} is unavailable. Install its pack; Koryphaios will not send audio or text to a cloud provider automatically.`);
}
export async function transcribeCloud(): Promise<never> { throw new Error('The selected cloud transcription adapter is not available in this build'); }
export async function synthesizeCloud(_request: SynthesisRequest): Promise<never> { throw new Error('The selected cloud synthesis adapter is not available in this build'); }
