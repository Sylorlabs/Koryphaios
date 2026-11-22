/**
 * Independent, deliberately unregistered speech/audio evidence probe.
 *
 * This module measures real external ASR and TTS processes. Its results are
 * partial technical evidence, NOT a full-task scorer or a simulated streaming
 * service. The two V5 external-environment gates must remain in effect until
 * representative held-out, streaming, listening, and paired-review evidence
 * exists and is independently verified.
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';

export const SPEECH_AUDIO_SCENARIOS = {
  recognition: 'speech-audio-ai-full-task-1-individual',
  synthesis: 'speech-audio-ai-full-task-2-individual',
} as const;

export interface SpeechAudioRecording {
  /** Exact source bytes must be independently pinned before running inference. */
  path: string;
  sha256: string;
  sourceProvenance: string;
  recordingRights: string;
  /** Independently established transcript, not a transcription produced by the model under test. */
  referenceTranscript: string;
  referenceProvenance: string;
  language: string;
  speakerDescription: string;
  acousticCondition: string;
  device: string;
  criticalEntities: string[];
  /** Only descriptive labels: a label does not prove that a slice is representative. */
  slices: string[];
}

export interface SpeechAudioModel {
  /** Real whisper.cpp GGML model file, separately pinned by SHA-256. */
  path: string;
  sha256: string;
  id: string;
  language: string;
}

export interface AudioStreamIdentity {
  path: string;
  sha256: string;
  codec: string;
  sampleRate: number;
  channels: number;
  durationSeconds: number;
}

export interface SpeechAudioSegment {
  text: string;
  startMs: number;
  endMs: number;
}

export interface SpeechAudioAsrResult {
  probePassed: boolean;
  blockers: string[];
  /** Real process and source identity, never a streaming latency claim. */
  evidence?: {
    engine: 'whisper.cpp/whisper-cli';
    engineVersion: string;
    model: { id: string; sha256: string; language: string };
    input: AudioStreamIdentity;
    inferenceInput: AudioStreamIdentity;
    sourceProvenance: string;
    recordingRights: string;
    referenceProvenance: string;
    speakerDescription: string;
    acousticCondition: string;
    device: string;
    slices: string[];
    referenceTranscript: string;
    transcript: string;
    /** Raw special/non-speech tokens remain visible in segments; never counted as words. */
    silenceMarkers: number;
    /** Whisper may report padded 10-second [BLANK_AUDIO] offsets on 2-second inputs. */
    timestampPaddingObserved: boolean;
    segments: SpeechAudioSegment[];
    batchWallMs: number;
    realTimeFactor: number;
    wer: number | null;
    cer: number | null;
    /** A zero-reference recording is scored separately so hallucination cannot be averaged away. */
    silenceHallucinatedWords: number | null;
    criticalEntities: Array<{ text: string; found: boolean }>;
    evidenceFile: string;
  };
}

export interface SpeechAudioTtsResult {
  probePassed: boolean;
  blockers: string[];
  evidence?: {
    engine: 'macOS say';
    voice: string;
    locale: string;
    voiceRights: string;
    sourceText: string;
    normalizedSpokenText: string;
    synthesisWallMs: number;
    /** macOS `say -o` is batch: first playable streamed audio is unobserved. */
    firstAudioMs: null;
    source: AudioStreamIdentity;
    encoded: AudioStreamIdentity;
    decodedPeak: number;
    decodedRms: number;
    clippedSampleFraction: number;
    evidenceFile: string;
    /** True handset/browser playback and independent human listening are unavailable here. */
    physicalPlayback: 'unverified';
    humanListening: 'unverified';
  };
}

const SHA256 = /^[a-f0-9]{64}$/iu;
const LIMIT_MS = 180_000;
const MAX_OUTPUT_BYTES = 24_000_000;

function exec(binary: string, args: string[], binaryOutput = false): {
  status: number | null;
  stdout: Buffer | string;
  stderr: string;
  error?: string;
  elapsedMs: number;
} {
  const began = performance.now();
  const result = spawnSync(binary, args, {
    encoding: binaryOutput ? 'buffer' : 'utf8',
    timeout: LIMIT_MS,
    maxBuffer: MAX_OUTPUT_BYTES,
    windowsHide: true,
    shell: false,
  });
  return {
    status: result.status,
    stdout: result.stdout ?? (binaryOutput ? Buffer.alloc(0) : ''),
    stderr: String(result.stderr ?? ''),
    error: result.error?.message,
    elapsedMs: performance.now() - began,
  };
}

function checked(binary: string, args: string[], binaryOutput = false): Buffer | string {
  const result = exec(binary, args, binaryOutput);
  if (result.status !== 0) {
    throw new Error(`${binary} failed (${result.status}): ${(result.error ?? result.stderr).slice(-300)}`);
  }
  return result.stdout;
}

function hash(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function inputFile(path: string, expectedHash: string): void {
  if (!SHA256.test(expectedHash)) throw new Error('Missing pinned SHA-256 evidence');
  if (!existsSync(path) || !lstatSync(path).isFile()) throw new Error(`Missing regular input file: ${path}`);
  if (hash(path) !== expectedHash.toLowerCase()) throw new Error(`Source SHA-256 mismatch: ${path}`);
}

function probe(path: string): AudioStreamIdentity {
  if (!existsSync(path) || !lstatSync(path).isFile()) throw new Error(`Missing encoded audio: ${path}`);
  const metadata = JSON.parse(String(checked('ffprobe', [
    '-v', 'error', '-select_streams', 'a:0',
    '-show_entries', 'stream=codec_name,sample_rate,channels:format=duration',
    '-of', 'json', path,
  ]))) as {
    streams?: Array<{ codec_name?: string; sample_rate?: string; channels?: number }>;
    format?: { duration?: string };
  };
  const stream = metadata.streams?.[0];
  const sampleRate = Number(stream?.sample_rate);
  const channels = Number(stream?.channels);
  const durationSeconds = Number(metadata.format?.duration);
  if (!stream?.codec_name || !Number.isInteger(sampleRate) || sampleRate < 8000 ||
    !Number.isInteger(channels) || channels < 1 || channels > 8 ||
    !Number.isFinite(durationSeconds) || durationSeconds < 0.2 || durationSeconds > 180) {
    throw new Error('Invalid, missing, or out-of-bounds decoded audio metadata');
  }
  return { path, sha256: hash(path), codec: stream.codec_name, sampleRate, channels, durationSeconds };
}

function tokens(text: string): string[] {
  return text.normalize('NFKC').toLocaleLowerCase('und')
    .replace(/[^\p{L}\p{N}]+/gu, ' ').trim().split(/\s+/u).filter(Boolean);
}

function editDistance<T>(left: readonly T[], right: readonly T[]): number {
  let previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let i = 1; i <= left.length; i++) {
    const row = [i];
    for (let j = 1; j <= right.length; j++) {
      row[j] = Math.min(
        previous[j]! + 1, row[j - 1]! + 1,
        previous[j - 1]! + (left[i - 1] === right[j - 1] ? 0 : 1),
      );
    }
    previous = row;
  }
  return previous[right.length]!;
}

/** Case/punctuation normalized, with numerals and named entities preserved. */
export function speechRecognitionErrors(reference: string, hypothesis: string): {
  wer: number | null;
  cer: number | null;
  silenceHallucinatedWords: number | null;
} {
  const ref = tokens(reference);
  const hyp = tokens(hypothesis);
  if (!ref.length) return { wer: null, cer: null, silenceHallucinatedWords: hyp.length };
  const refChars = Array.from(ref.join(''));
  const hypChars = Array.from(hyp.join(''));
  return {
    wer: editDistance(ref, hyp) / ref.length,
    cer: editDistance(refChars, hypChars) / refChars.length,
    silenceHallucinatedWords: null,
  };
}

function entityFound(text: string, entity: string): boolean {
  const haystack = tokens(text);
  const needle = tokens(entity);
  return needle.length > 0 && haystack.some((_, index) =>
    needle.every((word, offset) => haystack[index + offset] === word));
}

function createOutput(parent?: string): string {
  const directory = parent ?? tmpdir();
  mkdirSync(directory, { recursive: true });
  return mkdtempSync(join(directory, 'kory-speech-evidence-'));
}

function failAsr(cause: unknown): SpeechAudioAsrResult {
  return { probePassed: false, blockers: [cause instanceof Error ? cause.message : String(cause)] };
}

/**
 * Run a real batch inference. A successful probe supplies WER/CER and source
 * identity, but supplies NO partials, endpointing, diarization or live latency.
 */
export function runSpeechRecognitionProbe(
  recording: SpeechAudioRecording,
  model: SpeechAudioModel,
  outputParent?: string,
): SpeechAudioAsrResult {
  try {
    if (!recording.sourceProvenance || !recording.recordingRights ||
      !recording.referenceProvenance || !recording.language ||
      !recording.speakerDescription || !recording.acousticCondition || !recording.device ||
      !model.id || !model.language || recording.language !== model.language ||
      recording.referenceTranscript.length > 10_000 || recording.criticalEntities.length > 30) {
      throw new Error('Source rights, independent reference, signal context, or pinned model identity missing');
    }
    inputFile(recording.path, recording.sha256);
    inputFile(model.path, model.sha256);
    const source = probe(recording.path);
    const version = exec('whisper-cli', ['--version']);
    if (version.status !== 0) throw new Error(`Real whisper-cli unavailable: ${version.error ?? version.stderr.slice(-120)}`);
    const engineVersion = `${version.stdout}\n${version.stderr}`.match(/whisper\.cpp version:\s*([\w.-]+)/iu)?.[1];
    if (!engineVersion) throw new Error('Cannot identify whisper.cpp runtime version');
    const directory = createOutput(outputParent);
    const wav = join(directory, 'inference-input.wav');
    checked('ffmpeg', ['-v', 'error', '-nostdin', '-y', '-i', recording.path,
      '-map', '0:a:0', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', wav]);
    const inferenceInput = probe(wav);
    if (inferenceInput.sampleRate !== 16000 || inferenceInput.channels !== 1 ||
      inferenceInput.codec !== 'pcm_s16le') throw new Error('Whisper input preprocessing mismatch');
    const prefix = join(directory, 'inference');
    const observed = exec('whisper-cli', [
      '-ng', '-m', model.path, '-f', wav, '-l', model.language,
      '-oj', '-of', prefix, '-np',
    ]);
    if (observed.status !== 0) throw new Error(`Real ASR inference failed: ${observed.error ?? observed.stderr.slice(-250)}`);
    const outputFile = prefix + '.json';
    if (!existsSync(outputFile)) throw new Error('Whisper produced no independently inspectable inference JSON');
    const decoded = JSON.parse(readFileSync(outputFile, 'utf8')) as {
      result?: { language?: string };
      params?: { model?: string; language?: string };
      transcription?: Array<{ text?: string; offsets?: { from?: number; to?: number } }>;
    };
    if (decoded.params?.model !== model.path || decoded.params?.language !== model.language ||
      decoded.result?.language !== model.language || !Array.isArray(decoded.transcription)) {
      throw new Error('Whisper model, language, or transcription identity does not match request');
    }
    let previousEnd = 0;
    let silenceMarkers = 0;
    let timestampPaddingObserved = false;
    const segments = decoded.transcription.map((segment) => {
      const startMs = segment.offsets?.from;
      const endMs = segment.offsets?.to;
      const blankMarker = segment.text?.trim() === '[BLANK_AUDIO]';
      if (typeof segment.text !== 'string' || !Number.isFinite(startMs) ||
        !Number.isFinite(endMs) || startMs! < previousEnd || endMs! < startMs! ||
        (endMs! > inferenceInput.durationSeconds * 1000 + 500 &&
          (!blankMarker || endMs! > 30_000))) {
        throw new Error('ASR segment timestamps invalid or out of bounds');
      }
      if (blankMarker) silenceMarkers++;
      if (blankMarker && endMs! > inferenceInput.durationSeconds * 1000 + 500) {
        timestampPaddingObserved = true;
      }
      previousEnd = endMs!;
      return { text: segment.text, startMs: startMs!, endMs: endMs! };
    });
    const transcript = segments.filter((segment) => segment.text.trim() !== '[BLANK_AUDIO]')
      .map((segment) => segment.text.trim()).join(' ').trim();
    const errorRates = speechRecognitionErrors(recording.referenceTranscript, transcript);
    const evidenceFile = join(directory, 'evidence.json');
    const evidence = {
      engine: 'whisper.cpp/whisper-cli' as const, engineVersion,
      model: { id: model.id, sha256: model.sha256, language: model.language },
      input: source, inferenceInput,
      sourceProvenance: recording.sourceProvenance,
      recordingRights: recording.recordingRights,
      referenceProvenance: recording.referenceProvenance,
      speakerDescription: recording.speakerDescription,
      acousticCondition: recording.acousticCondition,
      device: recording.device,
      slices: recording.slices,
      referenceTranscript: recording.referenceTranscript,
      transcript, segments, silenceMarkers, timestampPaddingObserved,
      batchWallMs: observed.elapsedMs,
      realTimeFactor: observed.elapsedMs / (inferenceInput.durationSeconds * 1000),
      ...errorRates,
      criticalEntities: recording.criticalEntities.map((text) => ({ text, found: entityFound(transcript, text) })),
      evidenceFile,
    };
    writeFileSync(evidenceFile, JSON.stringify(evidence, null, 2));
    return { probePassed: true, blockers: [], evidence };
  } catch (error) {
    return failAsr(error);
  }
}

export interface SpeechAudioTtsRequest {
  sourceText: string;
  /** TTS normalization is explicit and preserved, rather than inferred from audio. */
  normalizedSpokenText: string;
  voice: string;
  locale: string;
  /** A documented grant to use the installed system voice, never custom cloning. */
  voiceRights: string;
}

/** Measures actual independently decoded 8 kHz mono G.711 mu-law delivery. */
export function inspectSpeechDelivery(encodedPath: string, referenceDurationSeconds: number): {
  passed: boolean;
  blockers: string[];
  identity?: AudioStreamIdentity;
  peak?: number;
  rms?: number;
  clippedFraction?: number;
} {
  try {
    if (!Number.isFinite(referenceDurationSeconds) || referenceDurationSeconds < 0.2 ||
      referenceDurationSeconds > 180) throw new Error('Reference audio duration is invalid');
    const identity = probe(encodedPath);
    const raw = checked('ffmpeg', ['-v', 'error', '-nostdin', '-i', encodedPath,
      '-f', 's16le', '-ac', '1', '-ar', '16000', '-'], true) as Buffer;
    const blockers: string[] = [];
    if (identity.sampleRate !== 8000 || identity.channels !== 1 || identity.codec !== 'pcm_mulaw') {
      blockers.push('Encoded target is not 8 kHz mono G.711 mu-law');
    }
    if (Math.abs(identity.durationSeconds - referenceDurationSeconds) > 0.35) {
      blockers.push('Delivery duration differs from source: truncation or extra audio');
    }
    if (raw.length < 16000 || raw.length % 2) blockers.push('Insufficient decoded audio samples');
    let sumSquares = 0;
    let peak = 0;
    let clipped = 0;
    const count = Math.floor(raw.length / 2);
    for (let index = 0; index < count; index++) {
      const amplitude = Math.abs(raw.readInt16LE(index * 2) / 32768);
      sumSquares += amplitude * amplitude;
      peak = Math.max(peak, amplitude);
      if (amplitude >= 0.99) clipped++;
    }
    const rms = Math.sqrt(sumSquares / (count || 1));
    const clippedFraction = clipped / (count || 1);
    if (rms < 0.004) blockers.push('Decoded output is silent or too quiet for the target channel');
    if (clippedFraction > 0.005) blockers.push('Decoded output has substantial clipping');
    return { passed: blockers.length === 0, blockers, identity, peak, rms, clippedFraction };
  } catch (error) {
    return { passed: false, blockers: [error instanceof Error ? error.message : String(error)] };
  }
}

/** Real host-voice synthesis. First-audio timing, device playback and listening remain unavailable. */
export function runSpeechSynthesisProbe(
  request: SpeechAudioTtsRequest,
  outputParent?: string,
): SpeechAudioTtsResult {
  try {
    if (!request.voice || !request.locale || !request.voiceRights ||
      !request.sourceText.trim() || !request.normalizedSpokenText.trim() ||
      request.normalizedSpokenText.length > 1000 || /\bclone\b/iu.test(request.voiceRights)) {
      throw new Error('Speech content, system voice identity, or voice authorization missing');
    }
    // Some versions of `say` silently substitute the default voice for an
    // unknown -v argument, so a successful process exit is insufficient.
    const advertised = String(checked('say', ['-v', '?']));
    const declaredVoice = advertised.split('\n').some((line) => {
      const match = line.match(/^(.+?)\s+([a-z]{2}_[A-Z]{2})\s+#/u);
      return match?.[1]?.trim() === request.voice && match[2] === request.locale;
    });
    if (!declaredVoice) throw new Error('Requested system voice/locale absent from installed voice catalog');
    const directory = createOutput(outputParent);
    const sourceFile = join(directory, 'host-synthesis.aiff');
    const observed = exec('say', ['-v', request.voice, '-o', sourceFile, '--', request.normalizedSpokenText]);
    if (observed.status !== 0 || !existsSync(sourceFile)) {
      throw new Error(`Real authorized system voice unavailable: ${observed.error ?? observed.stderr.slice(-250)}`);
    }
    const source = probe(sourceFile);
    const encodedFile = join(directory, 'telephony-delivery.wav');
    checked('ffmpeg', ['-v', 'error', '-nostdin', '-y', '-i', sourceFile,
      '-map', '0:a:0', '-ac', '1', '-ar', '8000', '-c:a', 'pcm_mulaw', encodedFile]);
    const inspected = inspectSpeechDelivery(encodedFile, source.durationSeconds);
    if (!inspected.passed || !inspected.identity) {
      throw new Error(`Encoded TTS delivery failed: ${inspected.blockers.join('; ')}`);
    }
    const evidenceFile = join(directory, 'evidence.json');
    const evidence = {
      engine: 'macOS say' as const,
      voice: request.voice, locale: request.locale, voiceRights: request.voiceRights,
      sourceText: request.sourceText, normalizedSpokenText: request.normalizedSpokenText,
      synthesisWallMs: observed.elapsedMs, firstAudioMs: null,
      source, encoded: inspected.identity,
      decodedPeak: inspected.peak!, decodedRms: inspected.rms!,
      clippedSampleFraction: inspected.clippedFraction!, evidenceFile,
      physicalPlayback: 'unverified' as const, humanListening: 'unverified' as const,
    };
    writeFileSync(evidenceFile, JSON.stringify(evidence, null, 2));
    return { probePassed: true, blockers: [], evidence };
  } catch (error) {
    return { probePassed: false, blockers: [error instanceof Error ? error.message : String(error)] };
  }
}

/** The sidecar has intentionally NOT replaced either full-task gate. */
export function speechAudioFullTaskGaps(scenarioId: string): string[] {
  if (scenarioId === SPEECH_AUDIO_SCENARIOS.recognition) return [
    'No complete, authorized, versioned held-out corpus with independently verified accent/language, noise, overlap, device, long-utterance and silence references.',
    'No two real version-pinned streaming ASR configurations, live interim/final/endpoint/reconnect traces, measured partial/final latency, or rollback execution.',
    'No independently verified speaker diarization/turn scoring or critical-entity migration threshold across representative slices.',
    'No same-model skill/no-skill agent pair and independent blind semantic review.',
  ];
  if (scenarioId === SPEECH_AUDIO_SCENARIOS.synthesis) return [
    'Host system voice exposes no independently pinned versioned provider model or complete rights/target-voice provenance for the intended deployment.',
    'No representative independently reviewed multilingual pronunciation, human listening evaluation, or real target-device playback captures.',
    'No streaming first-audio/interrupt/reconnect latency measurements or provider migration/rollback execution.',
    'No same-model skill/no-skill agent pair and independent blind semantic review.',
  ];
  return ['Unknown speech/audio V5 scenario'];
}
