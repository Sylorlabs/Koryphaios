import { describe, expect, it } from 'bun:test';
import { DEFAULT_VOICE_SETTINGS, assertNoCloudFallback, validateVoiceSettings } from './voice-service';
describe('voice settings', () => {
  it('validates defaults and speed limits', () => { expect(validateVoiceSettings(DEFAULT_VOICE_SETTINGS)).toEqual(DEFAULT_VOICE_SETTINGS); expect(() => validateVoiceSettings({ ...DEFAULT_VOICE_SETTINGS, output: { ...DEFAULT_VOICE_SETTINGS.output, speed: 3 } })).toThrow(); });
  it('never silently falls back from local', () => expect(() => assertNoCloudFallback(DEFAULT_VOICE_SETTINGS, 'stt')).toThrow(/will not send/));
});
