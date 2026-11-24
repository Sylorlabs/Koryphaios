import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstatSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type {
  SkillEvalDeterministicScore,
  SkillEvalDeterministicScorer,
  SkillEvalFixtureMaterializer,
} from './skill-eval-execution';
import { packageJson, readJsonArtifact, writeFixtureFile } from './skill-eval-fixture-helpers';
import { availableHostSpeechEngine } from './skill-eval-speech-engine';

const INTERVIEW = 'audio-production-full-task-1-individual';
const NARRATION = 'audio-production-full-task-2-individual';
type Scenario = typeof INTERVIEW | typeof NARRATION;
type Variant = 'positive' | 'negative' | 'recovered';

interface AudioSpec {
  scenarioId: Scenario;
  duration: number;
  targetLufs: number;
  lufsTolerance: number;
  truePeakLimit: number;
  sampleRate: number;
  channels: number;
  codec: 'aac';
}

const SPECS: Record<Scenario, AudioSpec> = {
  [INTERVIEW]: {
    scenarioId: INTERVIEW,
    duration: 18,
    targetLufs: -16,
    lufsTolerance: 2,
    truePeakLimit: -1,
    sampleRate: 48000,
    channels: 2,
    codec: 'aac',
  },
  [NARRATION]: {
    scenarioId: NARRATION,
    duration: 30,
    targetLufs: -16,
    lufsTolerance: 2,
    truePeakLimit: -1,
    sampleRate: 48000,
    channels: 2,
    codec: 'aac',
  },
};

export interface AudioProductionCheck {
  id: string;
  passed: boolean;
  detail: string;
}

export interface AudioProductionResult {
  passed: boolean;
  checks: AudioProductionCheck[];
  blockers: string[];
  evidence: string[];
}

const MAX_AUDIO_BYTES = 32_000_000;

function run(
  executable: string,
  args: string[],
  options: { cwd?: string; binary?: boolean; timeout?: number } = {},
): { status: number | null; stdout: string | Buffer; stderr: string; error?: string } {
  const result = spawnSync(executable, args, {
    cwd: options.cwd,
    env: { ...process.env },
    encoding: options.binary ? 'buffer' : 'utf8',
    timeout: options.timeout ?? 90_000,
    maxBuffer: options.binary ? 10_000_000 : 2_000_000,
    windowsHide: true,
    shell: false,
  });
  return {
    status: result.status,
    stdout: result.stdout ?? (options.binary ? Buffer.alloc(0) : ''),
    stderr: String(result.stderr ?? ''),
    error: result.error?.message,
  };
}

function checked(
  executable: string,
  args: string[],
  cwd?: string,
  binary = false,
): string | Buffer {
  const result = run(executable, args, { cwd, binary });
  if (result.status !== 0) {
    throw new Error(
      `${executable} exited ${result.status}: ${(result.error ?? result.stderr).slice(-700)}`,
    );
  }
  return result.stdout;
}

function tools(): { voice: 'say' | 'espeak-ng' | null; blockers: string[] } {
  const blockers: string[] = [];
  for (const executable of ['ffmpeg', 'ffprobe']) {
    const result = run(executable, ['-version'], { timeout: 8_000 });
    if (result.status !== 0 || !String(result.stdout).includes('version'))
      blockers.push(`${executable} missing: ${result.error ?? result.stderr.slice(0, 100)}`);
  }
  if (blockers.length) return { voice: null, blockers };
  const filters = String(checked('ffmpeg', ['-hide_banner', '-filters']));
  for (const filter of ['amix', 'loudnorm', 'ebur128', 'highpass', 'afftdn', 'volume']) {
    if (!new RegExp(`\\b${filter}\\b`).test(filters)) blockers.push(`FFmpeg missing ${filter}`);
  }
  const encoders = String(checked('ffmpeg', ['-hide_banner', '-encoders']));
  if (!/\baac\b/.test(encoders)) blockers.push('FFmpeg AAC encoder missing');
  if (!/\bpcm_s24le\b/.test(encoders)) blockers.push('FFmpeg 24-bit PCM encoder missing');
  const voice = availableHostSpeechEngine();
  if (!voice) blockers.push('Real audible speech generator (say or espeak-ng) unavailable');
  return { voice, blockers };
}

export function audioProductionRuntimeReadiness(_scenarioId: Scenario): string[] {
  return tools().blockers;
}

function absolute(root: string, relative: string): string {
  const pieces = relative.split('/');
  if (pieces.some((piece) => !piece || piece === '.' || piece === '..'))
    throw new Error('Unsafe audio fixture path');
  return join(root, ...pieces);
}

function regular(root: string, relative: string): string {
  const pieces = relative.split('/');
  let current = root;
  for (const [index, part] of pieces.entries()) {
    if (!part || part === '.' || part === '..') throw new Error('Unsafe audio path');
    current = join(current, part);
    const stat = lstatSync(current);
    if (stat.isSymbolicLink() || (index < pieces.length - 1 && !stat.isDirectory()))
      throw new Error(`Unsafe audio parent: ${relative}`);
    if (
      index === pieces.length - 1 &&
      (!stat.isFile() || stat.size === 0 || stat.size > MAX_AUDIO_BYTES)
    )
      throw new Error(`Missing or oversized audio file: ${relative}`);
  }
  return current;
}

function hash(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function sourceFiles(id: Scenario): string[] {
  return id === INTERVIEW
    ? ['sources/interview-a.wav', 'sources/interview-b.wav']
    : ['sources/narration.wav', 'sources/music.wav'];
}

function speak(root: string, basename: string, phrase: string, voice: 'say' | 'espeak-ng'): string {
  const relative = `sources/${basename}.${voice === 'say' ? 'aiff' : 'wav'}`;
  const destination = absolute(root, relative);
  if (voice === 'say') checked('say', ['-r', '154', '-o', destination, phrase], root);
  else checked('espeak-ng', ['-s', '154', '-w', destination, phrase], root);
  return destination;
}

function produceStem(
  root: string,
  voiceFile: string,
  output: string,
  duration: number,
  delayMs: number,
  speechGain: number,
  noiseGain: number,
): void {
  const args = [
    '-hide_banner',
    '-loglevel',
    'error',
    '-y',
    '-i',
    voiceFile,
    '-f',
    'lavfi',
    '-i',
    `anoisesrc=color=pink:amplitude=${noiseGain}:sample_rate=48000:duration=${duration}`,
    '-filter_complex',
    `[0:a]aresample=48000,volume=${speechGain},adelay=${delayMs},apad=whole_dur=${duration},atrim=duration=${duration}[voice];[voice][1:a]amix=inputs=2:duration=first:normalize=0,aresample=48000[a]`,
    '-map',
    '[a]',
    '-ac',
    '1',
    '-ar',
    '48000',
    '-c:a',
    'pcm_s24le',
    absolute(root, output),
  ];
  checked('ffmpeg', args, root);
}

function fixtureReadme(id: Scenario): string {
  const interview = id === INTERVIEW;
  return [
    '# Audio-production V5 real encoded media evaluation',
    '',
    'The 48 kHz, 24-bit WAV source stems are real audio bytes, not supplied meter numbers.',
    'Spoken lines were synthesized by the host speech engine; do not claim human recordings or human listening.',
    'Inspect evidence/contract.json and evidence/source-sha256.json. Keep supplied source media unmodified.',
    'Render .kory-eval/final.m4a, .kory-eval/negative.m4a, and .kory-eval/recovered.m4a from the stems.',
    'All deliveries must be actual AAC, stereo, 48 kHz, with final encoded integrated loudness and true peak within the per-task contract.',
    interview
      ? 'Restore both unequal-level speakers in the 18-second noisy interview; reduce noise without gating speech or destroying mono compatibility. Speaker B begins around 8.5 seconds.'
      : 'Produce a 30-second narration-over-music master. Duck the 220 Hz music bed by at least 6 dB during the first narration phrase; let it recover in the trailing speech-free section. Avoid abrupt audible gain jumps.',
    'Create an intentionally defective playable negative encoded file, and fix the defect in the recovered encode.',
    'Probe the final encoded files and compare decoded audio against original stems, including a small-speaker and mono listening proxy.',
    'Write .kory-eval/result.json with scenarioId, boundary="audio-production", outcome, audience, sourceTreatment, dynamics, speechClarity, musicBalance, monitoring, delivery, negativeDefect, recovery, uncertainty. Each description must be specific, at least 12 characters.',
    'Write .kory-eval/verification.json with negativeFinding, recoveryEvidence, and subjectiveListening="unverified" unless independently verified human playback actually occurred.',
    'Automated acoustic measurements and the small-speaker/mono transformations are NOT human listening; label subjective limitations accurately.',
    '',
  ].join('\n');
}

export function materializeAudioProductionFixture(root: string, id: Scenario): void {
  const available = tools();
  if (available.blockers.length || !available.voice)
    throw new Error('Audio-production runtime unavailable: ' + available.blockers.join('; '));
  mkdirSync(absolute(root, 'sources'), { recursive: true });
  writeFixtureFile(root, 'package.json', packageJson('kory-eval-audio-production'));
  writeFixtureFile(root, 'README.md', fixtureReadme(id));
  writeFixtureFile(root, 'evidence/contract.json', JSON.stringify(SPECS[id], null, 2) + '\n');
  if (id === INTERVIEW) {
    const first = speak(
      root,
      'speaker-a',
      'Our original interview was recorded near a busy office. The order process begins when the customer verifies their information, then confirms the delivery address.',
      available.voice,
    );
    const second = speak(
      root,
      'speaker-b',
      'Exactly. We can still correct an order before dispatch. Tell the customer which changes will appear on the confirmation screen.',
      available.voice,
    );
    produceStem(root, first, 'sources/interview-a.wav', 18, 0, 0.42, 0.008);
    produceStem(root, second, 'sources/interview-b.wav', 18, 8500, 0.12, 0.012);
  } else {
    const source = speak(
      root,
      'narrator',
      'Welcome to the quick start. First connect the cable and confirm the indicator turns green. Next open the settings and choose the current project. When the transfer finishes, review the final summary.',
      available.voice,
    );
    produceStem(root, source, 'sources/narration.wav', 30, 0, 0.4, 0);
    checked(
      'ffmpeg',
      [
        '-hide_banner',
        '-loglevel',
        'error',
        '-y',
        '-f',
        'lavfi',
        '-i',
        'sine=frequency=220:sample_rate=48000:duration=30',
        '-f',
        'lavfi',
        '-i',
        'sine=frequency=330:sample_rate=48000:duration=30',
        '-filter_complex',
        '[0:a]volume=0.65[a];[1:a]volume=0.25[b];[a][b]amix=inputs=2:duration=first:normalize=0[out]',
        '-map',
        '[out]',
        '-ac',
        '1',
        '-ar',
        '48000',
        '-c:a',
        'pcm_s24le',
        absolute(root, 'sources/music.wav'),
      ],
      root,
    );
  }
  const entries = Object.fromEntries(
    sourceFiles(id).map((file) => [file, hash(regular(root, file))]),
  );
  writeFixtureFile(root, 'evidence/source-sha256.json', JSON.stringify(entries, null, 2) + '\n');
}

function outputFile(root: string, variant: Variant): string {
  return absolute(root, `.kory-eval/${variant === 'positive' ? 'final' : variant}.m4a`);
}

/** Test oracle only. Evaluation subjects must produce their own renders and evidence. */
export function renderAudioProductionControl(root: string, id: Scenario, variant: Variant): void {
  if (audioProductionRuntimeReadiness(id).length) throw new Error('Audio runtime unavailable');
  mkdirSync(absolute(root, '.kory-eval'), { recursive: true });
  const inputs = sourceFiles(id).map((file) => regular(root, file));
  const args = ['-hide_banner', '-loglevel', 'error', '-y'];
  for (const input of inputs) args.push('-i', input);
  const mix =
    id === INTERVIEW
      ? '[0:a]highpass=f=80,afftdn=nr=10[a];[1:a]highpass=f=80,afftdn=nr=10[b];[a][b]amix=inputs=2:normalize=0:duration=first[m]'
      : '[0:a]highpass=f=90[voice];[1:a]volume=0.06:enable=between(t\\,0\\,18),volume=0.38:enable=between(t\\,18\\,30)[bed];[voice][bed]amix=inputs=2:normalize=0:duration=first[m]';
  if (variant === 'negative' && id === INTERVIEW) {
    const input = regular(root, '.kory-eval/final.m4a');
    checked(
      'ffmpeg',
      [
        '-hide_banner',
        '-loglevel',
        'error',
        '-y',
        '-i',
        input,
        '-af',
        'volume=9dB',
        '-ac',
        '2',
        '-ar',
        '48000',
        '-c:a',
        'aac',
        '-b:a',
        '192k',
        outputFile(root, variant),
      ],
      root,
    );
    return;
  }
  const bedMix =
    variant === 'negative' && id === NARRATION
      ? '[0:a]highpass=f=90[voice];[1:a]volume=0.8[bed];[voice][bed]amix=inputs=2:normalize=0:duration=first[m]'
      : mix;
  args.push(
    '-filter_complex',
    `${bedMix};[m]loudnorm=I=-16:TP=-2:LRA=7,volume=2dB,aresample=48000,aformat=channel_layouts=stereo[out]`,
    '-map',
    '[out]',
    '-t',
    String(SPECS[id].duration),
    '-ac',
    '2',
    '-ar',
    '48000',
    '-c:a',
    'aac',
    '-b:a',
    '192k',
    outputFile(root, variant),
  );
  checked('ffmpeg', args, root);
}

function pcm(path: string, channels: number, filter?: string): Float32Array {
  const args = ['-hide_banner', '-loglevel', 'error', '-i', path, '-map', '0:a:0'];
  if (filter) args.push('-af', filter);
  args.push('-ac', String(channels), '-ar', '8000', '-f', 'f32le', '-');
  const data = checked('ffmpeg', args, undefined, true);
  if (!Buffer.isBuffer(data)) throw new Error('Cannot decode audio to PCM');
  const count = data.byteLength / 4;
  const samples = new Float32Array(count);
  for (let index = 0; index < count; index++) samples[index] = data.readFloatLE(index * 4);
  return samples;
}

function rms(samples: Float32Array, begin: number, end: number, channels = 1): number {
  const start = Math.floor(begin * 8000) * channels;
  const stop = Math.min(samples.length, Math.floor(end * 8000) * channels);
  let total = 0;
  for (let index = start; index < stop; index++) total += samples[index]! ** 2;
  return Math.sqrt(total / Math.max(1, stop - start));
}

function similarity(a: Float32Array, b: Float32Array, begin: number, end: number): number {
  // Denoising, EQ, limiting and AAC change sample phases and introduce small
  // delays. Correlate the 20 ms *speech energy envelope* with a bounded lag.
  // This still requires the original spoken phrases to survive in the encode;
  // a loud constant tone, silence or unrelated speech cannot satisfy it.
  const start = Math.ceil(begin * 50);
  const stop = Math.min(Math.floor(end * 50), Math.floor(a.length / 160) - 1);
  const envelope = (audio: Float32Array, frame: number): number => {
    const position = frame * 160;
    if (position < 0 || position + 160 > audio.length) return 0;
    let sum = 0;
    for (let index = position; index < position + 160; index++) sum += audio[index]! ** 2;
    return Math.sqrt(sum / 160);
  };
  const source = Array.from({ length: stop - start }, (_, index) => envelope(a, start + index));
  const meanSource = source.reduce((sum, value) => sum + value, 0) / source.length;
  let best = -1;
  for (let lag = -15; lag <= 15; lag++) {
    const target = source.map((_, index) => envelope(b, start + index + lag));
    const meanTarget = target.reduce((sum, value) => sum + value, 0) / target.length;
    let cross = 0;
    let aa = 0;
    let bb = 0;
    for (let index = 0; index < source.length; index++) {
      const x = source[index]! - meanSource;
      const y = target[index]! - meanTarget;
      cross += x * y;
      aa += x * x;
      bb += y * y;
    }
    best = Math.max(best, cross / Math.max(1e-15, Math.sqrt(aa * bb)));
  }
  return best;
}

function toneAmplitude(samples: Float32Array, second: number, frequency: number): number {
  const start = Math.floor(second * 8000);
  const length = 4000;
  let sin = 0;
  let cos = 0;
  for (let index = 0; index < length && start + index < samples.length; index++) {
    const angle = (2 * Math.PI * frequency * index) / 8000;
    sin += samples[start + index]! * Math.sin(angle);
    cos += samples[start + index]! * Math.cos(angle);
  }
  return (2 * Math.hypot(sin, cos)) / length;
}

function loudness(path: string): { integrated: number; truePeak: number } {
  const measured = run('ffmpeg', [
    '-hide_banner',
    '-nostats',
    '-i',
    path,
    '-map',
    '0:a:0',
    '-vn',
    '-af',
    'ebur128=peak=true',
    '-f',
    'null',
    '-',
  ]);
  if (measured.status !== 0) throw new Error(measured.error ?? measured.stderr.slice(-400));
  const integrated = [...measured.stderr.matchAll(/\bI:\s*(-?\d+(?:\.\d+)?)\s*LUFS/g)].at(-1);
  const peak = [...measured.stderr.matchAll(/\bPeak:\s*(-?\d+(?:\.\d+)?)\s*dBFS/g)].at(-1);
  if (!integrated || !peak) throw new Error('Post-encode EBU R128 true-peak scan unavailable');
  return { integrated: Number(integrated[1]), truePeak: Number(peak[1]) };
}

function probe(path: string): { codec: unknown; rate: number; channels: number; duration: number } {
  const data = JSON.parse(
    String(
      checked('ffprobe', [
        '-v',
        'error',
        '-show_entries',
        'stream=codec_name,sample_rate,channels:format=duration',
        '-of',
        'json',
        path,
      ]),
    ),
  ) as { streams?: Array<Record<string, unknown>>; format?: Record<string, unknown> };
  const audio = data.streams?.[0];
  return {
    codec: audio?.codec_name,
    rate: Number(audio?.sample_rate),
    channels: Number(audio?.channels),
    duration: Number(data.format?.duration),
  };
}

function measure(root: string, id: Scenario, variant: Variant): AudioProductionCheck[] {
  const spec = SPECS[id];
  const relative = `.kory-eval/${variant === 'positive' ? 'final' : variant}.m4a`;
  const path = regular(root, relative);
  const info = probe(path);
  const format =
    info.codec === spec.codec &&
    info.rate === spec.sampleRate &&
    info.channels === spec.channels &&
    Math.abs(info.duration - spec.duration) < 0.15;
  const meter = loudness(path);
  const encoded = pcm(path, 1);
  const leftRight = pcm(path, 2);
  const phone = pcm(path, 1, 'highpass=f=300,lowpass=f=3400');
  const monoRms = rms(encoded, 0, Math.min(16, spec.duration));
  const stereoRms = rms(leftRight, 0, Math.min(16, spec.duration), 2);
  const smallSpeakerRms = rms(phone, 0, Math.min(16, spec.duration));
  const checks: AudioProductionCheck[] = [
    { id: 'encoded-format', passed: format, detail: JSON.stringify(info) },
    {
      id: 'post-encode-loudness',
      passed: Math.abs(meter.integrated - spec.targetLufs) <= spec.lufsTolerance,
      detail: `Measured ${meter.integrated} LUFS; expected ${spec.targetLufs} ± ${spec.lufsTolerance}`,
    },
    {
      id: 'post-encode-true-peak',
      passed: meter.truePeak <= spec.truePeakLimit && meter.truePeak > -60,
      detail: `Measured true peak ${meter.truePeak} dBTP; ceiling ${spec.truePeakLimit}`,
    },
    {
      id: 'decoded-mono-and-small-speaker-proxy',
      passed: monoRms > stereoRms * 0.45 && monoRms < stereoRms * 1.7 && smallSpeakerRms > 0.001,
      detail: `mono RMS ${monoRms.toFixed(4)}, stereo ${stereoRms.toFixed(4)}, 300–3400 Hz mono ${smallSpeakerRms.toFixed(4)}; automated proxy, not human listening`,
    },
  ];
  if (id === INTERVIEW) {
    const a = pcm(regular(root, 'sources/interview-a.wav'), 1);
    const b = pcm(regular(root, 'sources/interview-b.wav'), 1);
    const first = similarity(a, encoded, 1, 6);
    const second = similarity(b, encoded, 10, 16);
    checks.push({
      id: 'both-interview-speakers-preserved',
      passed: first > 0.25 && second > 0.2,
      detail: `decoded speech/source correlation first=${first.toFixed(3)} second=${second.toFixed(3)}`,
    });
  } else {
    const voice = pcm(regular(root, 'sources/narration.wav'), 1);
    const match = similarity(voice, encoded, 2, 9);
    const ducked = toneAmplitude(encoded, 5, 220);
    const released = toneAmplitude(encoded, 26, 220);
    checks.push({
      id: 'narration-source-preserved',
      passed: match > 0.25,
      detail: `decoded narration/source correlation=${match.toFixed(3)}`,
    });
    checks.push({
      id: 'music-duck-and-recovery',
      passed: released > 0.002 && ducked * 2 < released,
      detail: `decoded 220 Hz music during speech=${ducked.toFixed(4)}, after speech=${released.toFixed(4)}`,
    });
  }
  return checks;
}

function checkReports(root: string, id: Scenario): AudioProductionCheck {
  const report = readJsonArtifact<Record<string, unknown>>(root, '.kory-eval/result.json');
  const verification = readJsonArtifact<Record<string, unknown>>(
    root,
    '.kory-eval/verification.json',
  );
  const fields = [
    'outcome',
    'audience',
    'sourceTreatment',
    'dynamics',
    'speechClarity',
    'musicBalance',
    'monitoring',
    'delivery',
    'negativeDefect',
    'recovery',
    'uncertainty',
  ];
  const valid = Boolean(
    report?.scenarioId === id &&
    report.boundary === 'audio-production' &&
    fields.every(
      (field) => typeof report[field] === 'string' && String(report[field]).length >= 12,
    ) &&
    typeof verification?.negativeFinding === 'string' &&
    verification.negativeFinding.length > 16 &&
    typeof verification?.recoveryEvidence === 'string' &&
    verification.recoveryEvidence.length > 16 &&
    ['unverified', 'human-reviewed'].includes(String(verification.subjectiveListening)),
  );
  return {
    id: 'production-decisions-and-honest-listening-status',
    passed: valid,
    detail: valid
      ? `subjective=${verification?.subjectiveListening}; separate measured encoded QC`
      : 'Missing task-specific decisions or subjective listening limitation',
  };
}

function validateSources(root: string, id: Scenario): boolean {
  try {
    const manifest = readJsonArtifact<Record<string, string>>(root, 'evidence/source-sha256.json');
    const spec = readJsonArtifact<AudioSpec>(root, 'evidence/contract.json');
    if (!manifest || !spec || JSON.stringify(spec) !== JSON.stringify(SPECS[id])) return false;
    const names = sourceFiles(id);
    return (
      Object.keys(manifest).length === names.length &&
      names.every((name) => manifest[name] === hash(regular(root, name)))
    );
  } catch {
    return false;
  }
}

export function runAudioProductionRuntime(root: string, id: Scenario): AudioProductionResult {
  const blockers = audioProductionRuntimeReadiness(id);
  if (blockers.length) return { passed: false, checks: [], blockers, evidence: blockers };
  const checks: AudioProductionCheck[] = [
    {
      id: 'immutable-real-audio-source-provenance',
      passed: validateSources(root, id),
      detail: 'Source stems and contract must match original evaluator manifest',
    },
  ];
  if (!checks[0]!.passed) {
    return { passed: false, checks, blockers: [], evidence: checks.map((check) => check.detail) };
  }
  checks.push(checkReports(root, id));
  try {
    checks.push(
      ...measure(root, id, 'positive').map((check) => ({ ...check, id: `final-${check.id}` })),
    );
    checks.push(
      ...measure(root, id, 'recovered').map((check) => ({ ...check, id: `recovered-${check.id}` })),
    );
    const negative = measure(root, id, 'negative');
    // A playable negative may expose any genuine delivery failure. In particular,
    // phase-inverted stereo can meet the loudness target while disappearing in mono.
    // Require the independently decoded negative to fail a substantive audio check;
    // a malformed container alone is never an acceptable negative-path proof.
    const defectiveAudioChecks = new Set([
      'post-encode-loudness',
      'post-encode-true-peak',
      'decoded-mono-and-small-speaker-proxy',
      'both-interview-speakers-preserved',
      'narration-source-preserved',
      'music-duck-and-recovery',
    ]);
    checks.push({
      id: 'real-defective-encoded-negative-rejected',
      passed:
        negative.some((check) => check.id === 'encoded-format' && check.passed) &&
        negative.some((check) => defectiveAudioChecks.has(check.id) && !check.passed),
      detail: negative
        .filter((check) => !check.passed)
        .map((check) => `${check.id}: ${check.detail}`)
        .join('; ')
        .slice(0, 450),
    });
  } catch (error) {
    checks.push({
      id: 'real-encoded-media-probe',
      passed: false,
      detail: error instanceof Error ? error.message : String(error),
    });
  }
  return {
    passed: checks.every((check) => check.passed),
    checks,
    blockers: [],
    evidence: checks.map(
      (check) => `${check.id}: ${check.passed ? 'pass' : 'fail'} — ${check.detail}`,
    ),
  };
}

function score(id: Scenario, root: string): SkillEvalDeterministicScore {
  const result = runAudioProductionRuntime(root, id);
  const passed = result.checks.filter((check) => check.passed).length;
  return {
    passed: result.passed,
    quality: result.checks.length ? passed / result.checks.length : 0,
    verification: result.checks.length ? passed / result.checks.length : 0,
    integrityFailure: result.checks.some(
      (check) => check.id === 'immutable-real-audio-source-provenance' && !check.passed,
    ),
    evidence: result.evidence,
  };
}

export const AUDIO_PRODUCTION_RUNTIME_SCENARIOS = { interview: INTERVIEW, narration: NARRATION };

export const AUDIO_PRODUCTION_SKILL_EVAL_MATERIALIZERS: readonly SkillEvalFixtureMaterializer[] = [
  {
    id: 'audio-production/real-interview-media-v5@1',
    realRuntime: true,
    get readinessBlockers() {
      return audioProductionRuntimeReadiness(INTERVIEW);
    },
    matches: (scenario) => scenario.id === INTERVIEW,
    materialize: (destination) => materializeAudioProductionFixture(destination, INTERVIEW),
  },
  {
    id: 'audio-production/real-narration-media-v5@1',
    realRuntime: true,
    get readinessBlockers() {
      return audioProductionRuntimeReadiness(NARRATION);
    },
    matches: (scenario) => scenario.id === NARRATION,
    materialize: (destination) => materializeAudioProductionFixture(destination, NARRATION),
  },
];

export const AUDIO_PRODUCTION_SKILL_EVAL_SCORERS: readonly SkillEvalDeterministicScorer[] = [
  {
    id: 'audio-production/encoded-interview-scorer-v5@2',
    scenarioIds: [INTERVIEW],
    score: ({ workingDirectory }) => score(INTERVIEW, workingDirectory),
  },
  {
    id: 'audio-production/encoded-narration-scorer-v5@2',
    scenarioIds: [NARRATION],
    score: ({ workingDirectory }) => score(NARRATION, workingDirectory),
  },
];
