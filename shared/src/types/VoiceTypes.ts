export type VoiceCapability = 'stt' | 'tts';
export type VoiceModelFamily = 'kitten' | 'vits' | 'piper' | 'kokoro' | 'matcha' | 'pockettts' | 'supertonic' | 'moonshine' | 'whisper';

export interface VoiceSettings {
  input: { provider: string; modelId: string; language: string };
  output: { provider: string; modelId: string; voiceId: string; speed: number };
  autoReadFinalReplies: boolean;
  voiceModeEnabled: boolean;
  liveTranscription: boolean;
}

export interface VoiceProviderDescriptor {
  id: string;
  name: string;
  capabilities: VoiceCapability[];
  local: boolean;
  configured: boolean;
  supportsDiscovery: boolean;
}

export interface VoiceModelDescriptor {
  id: string;
  name: string;
  provider: string;
  capability: VoiceCapability;
  languages: string[];
  voices?: Array<{ id: string; name: string }>;
}

export interface VoicePackManifest {
  schemaVersion: 1;
  id: string;
  version: string;
  name: string;
  family: VoiceModelFamily;
  capabilities: VoiceCapability[];
  languages: string[];
  license: { name: string; file: string };
  sizeBytes: number;
  files: Array<{ path: string; sizeBytes: number; sha256: string }>;
  builtIn?: boolean;
}

export interface VoicePackStatus { manifest: VoicePackManifest; state: 'available' | 'downloading' | 'installed' | 'failed'; downloadedBytes?: number; error?: string }
export interface TranscriptionResult { text: string; language?: string; durationMs?: number; provider: string; modelId: string }
export interface SynthesisRequest { text: string; provider: string; modelId: string; voiceId?: string; speed?: number }
export interface SynthesisResult { audioBase64: string; mimeType: string; durationMs?: number; provider: string; modelId: string }
