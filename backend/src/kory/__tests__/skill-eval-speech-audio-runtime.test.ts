import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  inspectSpeechDelivery,
  runSpeechRecognitionProbe,
  runSpeechSynthesisProbe,
  speechAudioFullTaskGaps,
  speechRecognitionErrors,
  SPEECH_AUDIO_SCENARIOS,
} from '../../eval/skills/skill-eval-speech-audio-runtime';

const modelPath = process.env.KORY_SPEECH_REAL_ASR_MODEL;
const realRecordingPath = process.env.KORY_SPEECH_REAL_ASR_FIXTURE;
// Recording: ggml-org/whisper.cpp tag v1.9.4, samples/jfk.wav.
// Model: independent ggml-tiny.en fixture downloaded before evaluation.
// Deriving either SHA-256 from the supplied path would let an unrelated or
// modified file silently become its own trusted reference.
const PINNED_JFK_WAV_SHA256 = '59dfb9a4acb36fe2a2affc14bacbee2920ff435cb13cc314a08c13f66ba7860e';
const PINNED_TINY_EN_SHA256 = '921e4cf8686fdd993dcd081a5da5b6c365bfde1162e72b08d75ac75289920b1f';
// An explicitly requested real run must fail when its inputs/tools are missing.
// Skipping in that case would turn a broken real probe into a green test suite.
const asrProbeRequested = !!modelPath || !!realRecordingPath;

function sha(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function command(name: string, args: string[]): boolean {
  const result = spawnSync(name, args, { encoding: 'utf8', timeout: 8000 });
  return result.status === 0;
}

const hasDeliveryTools = command('ffmpeg', ['-version']) && command('ffprobe', ['-version']);
const hasSay = command('say', ['-v', '?']);

describe('speech-audio V5 independent, unregistered real-model sidecar', () => {
  test('refuses qualification despite partial batch or TTS probes', () => {
    for (const id of Object.values(SPEECH_AUDIO_SCENARIOS)) {
      const missing = speechAudioFullTaskGaps(id);
      expect(missing.length).toBeGreaterThanOrEqual(4);
      expect(missing.join(' ')).toContain('skill/no-skill');
    }
  });

  test('keeps word errors, numeral changes, entities and silence hallucination distinct', () => {
    const measured = speechRecognitionErrors('Pay 250 dollars to Diaz.', 'Pay 25 dollars to Diaz!');
    expect(measured.wer).toBeCloseTo(0.2);
    expect(measured.cer).toBeGreaterThan(0);
    expect(measured.silenceHallucinatedWords).toBeNull();
    expect(speechRecognitionErrors('', 'a hallucinated phrase')).toEqual({
      wer: null, cer: null, silenceHallucinatedWords: 3,
    });
    expect(speechRecognitionErrors('', '')).toEqual({ wer: null, cer: null, silenceHallucinatedWords: 0 });
  });

  test('fails closed without genuine pinned ASR model/runtime and reference metadata', () => {
    const result = runSpeechRecognitionProbe({
      path: '/no-such-audio.wav', sha256: '0'.repeat(64),
      sourceProvenance: 'test source', recordingRights: 'test rights',
      referenceTranscript: 'hi', referenceProvenance: 'independent reference',
      language: 'en', speakerDescription: 'single speaker', acousticCondition: 'quiet',
      device: 'test device', criticalEntities: [], slices: ['clean'],
    }, {
      path: '/missing-model.bin', sha256: '0'.repeat(64),
      id: 'pinned-model', language: 'en',
    });
    expect(result.probePassed).toBe(false);
    expect(result.evidence).toBeUndefined();
    expect(result.blockers.join(' ')).toContain('Missing regular input file');
  });

  test.skipIf(!asrProbeRequested)(
    'executes actual whisper.cpp on recorded JFK speech and verifies source/model fingerprints',
    () => {
      if (!modelPath || !realRecordingPath || !hasDeliveryTools) {
        throw new Error('Real ASR probe requires both pinned paths, ffmpeg and ffprobe');
      }
      const root = mkdtempSync(join(tmpdir(), 'kory-speech-asr-test-'));
      try {
        expect(sha(realRecordingPath!)).toBe(PINNED_JFK_WAV_SHA256);
        expect(sha(modelPath!)).toBe(PINNED_TINY_EN_SHA256);
        const sample = {
          path: realRecordingPath!, sha256: PINNED_JFK_WAV_SHA256,
          sourceProvenance: 'whisper.cpp 1.9.4 packaged jfk.wav, recorded 1961 JFK inaugural speech',
          recordingRights: 'public speech fixture, used solely for local eval',
          referenceTranscript: 'And so, my fellow Americans, ask not what your country can do for you; ask what you can do for your country.',
          referenceProvenance: 'John F. Kennedy 1961 inaugural address text (independent of ASR output)',
          language: 'en', speakerDescription: 'one real English-language adult speaker',
          acousticCondition: 'archival speech recording', device: 'unknown original capture',
          criticalEntities: ['Americans', 'country'], slices: ['real-recording', 'English', 'archival'],
        };
        const model = {
          path: modelPath!, sha256: PINNED_TINY_EN_SHA256, id: 'ggml-tiny.en', language: 'en',
        };
        const measured = runSpeechRecognitionProbe(sample, model, root);
        expect(measured.blockers).toEqual([]);
        expect(measured.probePassed).toBe(true);
        expect(measured.evidence?.engine).toBe('whisper.cpp/whisper-cli');
        expect(measured.evidence?.engineVersion).toBe('1.9.4');
        expect(measured.evidence?.model.sha256).toBe(model.sha256);
        expect(measured.evidence?.batchWallMs).toBeGreaterThan(0);
        expect(measured.evidence?.input.sha256).toBe(sample.sha256);
        expect(measured.evidence?.inferenceInput.sampleRate).toBe(16000);
        expect(measured.evidence?.segments.length).toBeGreaterThan(0);
        expect(measured.evidence?.wer).toBeLessThan(0.6);
        expect(measured.evidence?.criticalEntities).toEqual([
          { text: 'Americans', found: true }, { text: 'country', found: true },
        ]);
        expect(existsSync(measured.evidence!.evidenceFile)).toBe(true);

        const forged = runSpeechRecognitionProbe({ ...sample, sha256: '0'.repeat(64) }, model, root);
        expect(forged.probePassed).toBe(false);
        expect(forged.blockers.join(' ')).toContain('SHA-256 mismatch');
        const unpinnedModel = runSpeechRecognitionProbe(sample, { ...model, sha256: 'f'.repeat(64) }, root);
        expect(unpinnedModel.probePassed).toBe(false);
        expect(unpinnedModel.blockers.join(' ')).toContain('SHA-256 mismatch');

        // Genuine zero-speech acoustic stimulus and a real model response: no invented transcript.
        const silence = join(root, 'silence.wav');
        const generated = spawnSync('ffmpeg', [
          '-v', 'error', '-y', '-f', 'lavfi', '-i', 'anullsrc=r=16000:cl=mono',
          '-t', '2', '-c:a', 'pcm_s16le', silence,
        ], { encoding: 'utf8', timeout: 8000 });
        expect(generated.status, generated.stderr).toBe(0);
        const negative = runSpeechRecognitionProbe({
          ...sample, path: silence, sha256: sha(silence), referenceTranscript: '',
          referenceProvenance: 'Generated 2 s zero-speech signal, exact signal oracle',
          sourceProvenance: 'FFmpeg anullsrc acoustic negative control',
          recordingRights: 'locally generated zero-speech fixture',
          acousticCondition: 'digital silence', speakerDescription: 'no speakers',
          criticalEntities: [], slices: ['negative', 'silence'],
        }, model, root);
        expect(negative.probePassed).toBe(true);
        expect(negative.evidence?.wer).toBeNull();
        expect(negative.evidence?.silenceHallucinatedWords).toBeGreaterThanOrEqual(0);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
    150_000,
  );

  test.skipIf(!hasSay || !hasDeliveryTools)(
    'executes real system TTS, measures mu-law decoded audio, rejects truncation and verifies recovery',
    () => {
      const root = mkdtempSync(join(tmpdir(), 'kory-speech-tts-test-'));
      try {
        const result = runSpeechSynthesisProbe({
          sourceText: 'Turn right at number 41.',
          normalizedSpokenText: 'Turn right at number forty one.',
          voice: process.env.KORY_SPEECH_SYSTEM_VOICE || 'Samantha',
          locale: 'en_US',
          voiceRights: 'Use of installed operating-system distributed voice for a local test; no custom voice or cloning',
        }, root);
        expect(result.blockers).toEqual([]);
        expect(result.probePassed).toBe(true);
        expect(result.evidence?.synthesisWallMs).toBeGreaterThan(0);
        expect(result.evidence?.encoded.codec).toBe('pcm_mulaw');
        expect(result.evidence?.encoded.sampleRate).toBe(8000);
        expect(result.evidence?.encoded.channels).toBe(1);
        expect(result.evidence?.decodedRms).toBeGreaterThan(0.004);
        expect(result.evidence?.firstAudioMs).toBeNull();
        expect(result.evidence?.humanListening).toBe('unverified');
        expect(existsSync(result.evidence!.evidenceFile)).toBe(true);

        const truncated = join(root, 'truncated.wav');
        const cut = spawnSync('ffmpeg', [
          '-v', 'error', '-y', '-i', result.evidence!.encoded.path,
          '-t', '0.5', '-c:a', 'pcm_mulaw', truncated,
        ], { encoding: 'utf8', timeout: 8000 });
        expect(cut.status, cut.stderr).toBe(0);
        const rejected = inspectSpeechDelivery(truncated, result.evidence!.source.durationSeconds);
        expect(rejected.passed).toBe(false);
        expect(rejected.blockers.join(' ')).toContain('truncation');
        expect(inspectSpeechDelivery(result.evidence!.encoded.path, result.evidence!.source.durationSeconds).passed).toBe(true);

        const noVoice = runSpeechSynthesisProbe({
          sourceText: 'hello', normalizedSpokenText: 'hello',
          voice: 'a-voice-that-is-not-installed-99821', locale: 'en_US', voiceRights: 'system testing',
        }, root);
        expect(noVoice.probePassed).toBe(false);
        expect(noVoice.blockers.length).toBeGreaterThan(0);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
    60_000,
  );
});
