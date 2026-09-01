export type VoiceCapability = 'stt' | 'tts';

export interface VoiceSettings {
  input: { provider: string; modelId: string; language: string };
  output: { provider: string; modelId: string; voiceId: string; speed: number };
  autoReadFinalReplies: boolean;
  voiceModeEnabled: boolean;
}

export interface VoiceProviderDescriptor {
  id: string;
  name: string;
  capabilities: VoiceCapability[];
  local: boolean;
  configured: boolean;
  supportsDiscovery: boolean;
  models?: Array<{ id: string; name: string; capability?: VoiceCapability }>;
  /** Voices offered by a speech-synthesis provider. */
  voices?: Array<{ id: string; name: string }>;
}

export interface VoiceModelDescriptor {
  id: string;
  name: string;
  provider: string;
  capability: VoiceCapability;
  languages: string[];
  voices?: Array<{ id: string; name: string }>;
}

export interface TranscriptionResult {
  text: string;
  language?: string;
  durationMs?: number;
  provider: string;
  modelId: string;
}
export interface SynthesisRequest {
  text: string;
  provider: string;
  modelId: string;
  voiceId?: string;
  speed?: number;
}
export interface SynthesisResult {
  audioBase64: string;
  mimeType: string;
  durationMs?: number;
  provider: string;
  modelId: string;
}
