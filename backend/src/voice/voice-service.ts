import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { SynthesisRequest, VoiceProviderDescriptor, VoiceSettings } from '@koryphaios/shared';
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
