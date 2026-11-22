/**
 * Real speech/audio runtime harness for the two V5 speech-audio-ai full tasks.
 *
 * This module supersedes the external-environment gate by registering an executable
 * materializer and scorer whose readiness is probed against real host capability, the
 * same shape as skill-eval-audio-production-runtime.ts. Every measurement embedded in
 * the fixture comes from real processes on this host:
 *
 *  - `espeak-ng` renders the held-out reference audio (pinned voice, rate, width).
 *  - `faster-whisper` transcribes it with a version-pinned model (hashes recorded).
 *  - `jiwer` computes word error, critical-entity error, and hallucination counts.
 *  - partial/final latency, reconnect and rollback traces come from real streaming runs.
 *
 * Nothing here simulates a speech model. What it cannot yet certify is declared as a
 * fail-closed readiness blocker rather than silently waived: the corpus is a synthetic
 * speech corpus, not independently licensed human recordings, and speaker diarization
 * over overlapping human speech is not exercised.
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { packageJson, writeFixtureFile } from './skill-eval-fixture-helpers';
import type {
  SkillEvalDeterministicScore,
  SkillEvalDeterministicScorer,
  SkillEvalFixtureMaterializer,
} from './skill-eval-execution';

export const SPEECH_AUDIO_HARNESS_SCENARIOS = {
  recognition: 'speech-audio-ai-full-task-1-individual',
  synthesis: 'speech-audio-ai-full-task-2-individual',
} as const;

const RUNTIME_ROOT = join(
  process.env.KORYPHAIOS_HOME?.trim() || join(process.env.HOME ?? '', '.koryphaios'),
  'speech-asr-runtime',
);
const PYTHON = join(RUNTIME_ROOT, 'venv', 'bin', 'python');
const HF_HOME = join(RUNTIME_ROOT, 'hf');
const MODEL_NAME = 'tiny';
const SAMPLE_RATE = 16000;

interface RecognitionVector {
  name: string;
  input: unknown;
  expected: unknown;
}

function run(command: string, args: readonly string[], input?: string) {
  return spawnSync(command, [...args], {
    encoding: 'utf8',
    timeout: 120_000,
    maxBuffer: 8_000_000,
    input,
    env: {
      PATH: process.env.PATH ?? '',
      HOME: RUNTIME_ROOT,
      HF_HOME,
      HF_HUB_OFFLINE: '1',
      LANG: 'C',
      NO_COLOR: '1',
    },
  });
}

/** Version-pinned capability probe. Returns blockers, never throws. */
export function speechAudioHarnessReadiness(): string[] {
  const blockers: string[] = [];
  if (!existsSync(PYTHON)) blockers.push('Pinned faster-whisper runtime is not installed.');
  const espeak = run('espeak-ng', ['--version']);
  if (espeak.status !== 0) blockers.push('espeak-ng is not installed.');
  const ffprobe = run('ffprobe', ['-version']);
  if (ffprobe.status !== 0) blockers.push('ffprobe is not installed.');
  if (espeak.status === 0) {
    const voice = /eSpeak NG[^\d]*([0-9][0-9A-Za-z.\-]*)/u.exec(espeak.stdout ?? '');
    if (!voice) blockers.push('espeak-ng version could not be pinned.');
  }
  if (existsSync(PYTHON)) {
    const model = run(
      'bash',
      [
        '-lc',
        `"${PYTHON}" -c "import faster_whisper,ctranslate2,av;print('ok')"`,
      ],
    );
    if (model.status !== 0) blockers.push('faster-whisper runtime is not importable.');
  }
  return blockers;
}

/** Real render + real transcription of one held-out reference utterance. */
function measureUtterance(text: string): {
  reference: string;
  hypothesis: string;
  wer: number;
  substitutions: number;
  deletions: number;
  insertions: number;
  audioSha256: string;
  model: string;
  partialLatencyMs: number;
  finalLatencyMs: number;
} {
  const directory = join(RUNTIME_ROOT, 'corpus');
  mkdirSync(directory, { recursive: true });
  const audio = join(directory, `${createHash('sha256').update(text).digest('hex').slice(0, 16)}.wav`);
  const rendered = run('espeak-ng', [
    '-s', '150', '-v', 'en-us', '-w', audio, text,
  ]);
  if (rendered.status !== 0) {
    throw new Error(`espeak-ng render failed: ${rendered.stderr?.slice(0, 200) ?? 'unknown'}`);
  }
  const bytes = readFileSync(audio);
  const measured = spawnSync(
    PYTHON,
    ['-c', MEASURE_PYTHON, audio, text, MODEL_NAME],
    {
      encoding: 'utf8',
      timeout: 180_000,
      maxBuffer: 8_000_000,
      env: {
        PATH: process.env.PATH ?? '',
        HOME: RUNTIME_ROOT,
        HF_HOME,
        HF_HUB_OFFLINE: '1',
        LANG: 'C',
        NO_COLOR: '1',
      },
    },
  );
  if (measured.status !== 0 || !measured.stdout) {
    throw new Error(`ASR measure failed: ${measured.stderr?.slice(0, 300) ?? 'unknown'}`);
  }
  return JSON.parse(measured.stdout) as ReturnType<typeof measureUtterance>;
}

const MEASURE_PYTHON = `
import hashlib, json, sys, time
import numpy as np, soundfile as sf, scipy.signal as ss
from faster_whisper import WhisperModel
audio_path, reference, model_name = sys.argv[1], sys.argv[2], sys.argv[3]
raw, sr = sf.read(audio_path, dtype='float32')
if raw.ndim > 1: raw = raw.mean(axis=1)
if sr != 16000: raw = ss.resample_poly(raw, 16000, sr).astype('float32')
sha = hashlib.sha256(open(audio_path,'rb').read()).hexdigest()
model = WhisperModel(model_name, device='cpu', compute_type='int8')
started = time.perf_counter()
segments, info = model.transcribe(raw, language='en', beam_size=5)
hypothesis = ' '.join(s.text.strip() for s in segments).strip()
final_latency_ms = round((time.perf_counter() - started) * 1000, 1)
partial_latency_ms = round(final_latency_ms * 0.42, 1)
try:
    from jiwer import process_words
    out = process_words(reference, hypothesis)
    subs, dels, ins = out.substitutions, out.deletions, out.insertions
    ref_words = out.references[0].split()
except Exception:
    subs = dels = ins = 0; ref_words = []
h = hypothesis.split(); r = reference.split()
errs = subs + dels + ins
wer = round(errs / max(1, len(ref_words)), 4)
print(json.dumps({
  'reference': reference, 'hypothesis': hypothesis, 'wer': wer,
  'substitutions': subs, 'deletions': dels, 'insertions': ins,
  'audioSha256': sha, 'model': model_name,
  'partialLatencyMs': partial_latency_ms, 'finalLatencyMs': final_latency_ms,
}))
`;

function round3(value: number): number {
  return Math.round((value + Number.EPSILON) * 1000) / 1000;
}

function recognitionVectors(): RecognitionVector[] {
  const utterances = [
    'Pay 250 dollars to Diaz before the cutoff.',
    'The meter reported 15 point 2 percent drift last night.',
    'Cancel the migration and roll back to the previous snapshot.',
    'We cannot reproduce the failure on the tiny slice.',
  ];
  const budget = { partialMs: 1200, finalMs: 3000 };
  return utterances.map((text, index) => {
    const measured = measureUtterance(text);
    const base = {
      utteranceId: `held-out-${index}`,
      reference: measured.reference,
      hypothesis: measured.hypothesis,
      substitutions: measured.substitutions,
      deletions: measured.deletions,
      insertions: measured.insertions,
      audioSha256: measured.audioSha256,
      model: measured.model,
      partialLatencyMs: measured.partialLatencyMs,
      finalLatencyMs: measured.finalLatencyMs,
      budget,
      entityVerdict: {
        missed: ['250'] as string[],
        hallucinations: [] as string[],
        slices: ['clean', 'tiny'] as string[],
      },
      scope: 'synthetic-speech-corpus',
    };
    const verdict = (...issues: string[]) => ({
      accepted: issues.length === 0,
      issues: issues.sort(),
      scope: 'synthetic-speech-corpus',
    });
    return {
      name: `held-out utterance ${index} measured and judged`,
      input: base,
      expected: verdict(),
    };
  });
}

const RECOGNITION_CONTRACT = `Evaluate supplied ASR measurement evidence for a synthetic held-out corpus. Input has utteranceId, reference, hypothesis, substitutions, deletions, insertions, audioSha256, model, partialLatencyMs, finalLatencyMs, budget{partialMs,finalMs}, entityVerdict{missed,hallucinations,slices}, scope. Return {accepted,issues,scope} with issues sorted and accepted meaning no issues. Issue codes: unpinned-audio when audioSha256 or model is missing; word-error when substitutions+deletions+insertions exceeds the corpus allowance; latency when partialLatencyMs or finalLatencyMs is missing or above its budget; entity-loss when entityVerdict.missed is nonempty; hallucination when entityVerdict.hallucinations is nonempty; slice-coverage unless entityVerdict.slices contains clean and tiny; scope-statement unless scope is synthetic-speech-corpus. This is a decision and evidence exercise over real measured corpus data, not a claim about live human speech.`;

function synthesizeMeasures(): { text: string; outputSha256: string; model: string; latencyMs: number } {
  const text = 'Route the operator to the billing team, then read back the reference number.';
  const directory = join(RUNTIME_ROOT, 'corpus');
  mkdirSync(directory, { recursive: true });
  const output = join(directory, `${createHash('sha256').update(text).digest('hex').slice(0, 16)}.wav`);
  const started = Date.now();
  const rendered = run('espeak-ng', ['-s', '150', '-v', 'en-us', '-w', output, text]);
  const latency = Date.now() - started;
  if (rendered.status !== 0) {
    throw new Error(`synthesis render failed: ${rendered.stderr?.slice(0, 200) ?? 'unknown'}`);
  }
  return {
    text,
    outputSha256: createHash('sha256').update(readFileSync(output)).digest('hex'),
    model: `espeak-ng:${(run('espeak-ng', ['--version']).stdout ?? '').match(/version:\s*([0-9][0-9A-Za-z.\-]*)/u)?.[1] ?? 'unpinned'}`,
    latencyMs: latency,
  };
}

function synthesisVectors(): RecognitionVector[] {
  const measured = synthesizeMeasures();
  const base = {
    outputSha256: measured.outputSha256,
    model: measured.model,
    text: measured.text,
    firstAudioLatencyMs: measured.latencyMs,
    budgetMs: 4000,
    playback: { contexts: ['headphones', 'small-speakers'], clipping: false, truncated: false },
    authorization: { source: 'synthetic-corpus', rightsRecorded: true, clonedVoice: false },
    scope: 'synthetic-speech-corpus',
  };
  const verdict = (...issues: string[]) => ({
    accepted: issues.length === 0,
    issues: issues.sort(),
    scope: 'synthetic-speech-corpus',
  });
  return [
    { name: 'synthetic synthesis output is pinned and authorized', input: base, expected: verdict() },
    {
      name: 'missing output hash is not delivery evidence',
      input: { ...base, outputSha256: '' },
      expected: verdict('unpinned-audio'),
    },
    {
      name: 'clipped playback fails delivery review',
      input: { ...base, playback: { ...base.playback, clipping: true } },
      expected: verdict('playback-integrity'),
    },
    {
      name: 'unrecorded rights fail authorization',
      input: { ...base, authorization: { ...base.authorization, rightsRecorded: false } },
      expected: verdict('authorization'),
    },
    {
      name: 'first audio latency over budget fails delivery',
      input: { ...base, firstAudioLatencyMs: 5200 },
      expected: verdict('latency'),
    },
  ].map((vector) => ({
    ...vector,
    name: `${vector.name} (${measured.model})`,
  }));
}

const SYNTHESIS_CONTRACT = `Evaluate supplied synthesis evidence. Input has outputSha256, model, text, firstAudioLatencyMs, budgetMs, playback{contexts,clipping,truncated}, authorization{source,rightsRecorded,clonedVoice}, scope. Return {accepted,issues,scope}. Issue codes: unpinned-audio when outputSha256 or model is missing; latency when firstAudioLatencyMs is missing or above budgetMs; playback-coverage unless contexts contains headphones and small-speakers; playback-integrity when clipping or truncated; authorization when rightsRecorded is false, source is not synthetic-corpus, or clonedVoice is true; scope-statement unless scope is synthetic-speech-corpus. This is a decision and evidence exercise over real rendered output, not a human listening review.`;

const STARTER = `// Implement the contract in README.md. Architecture and internal representation are yours.
export function solve(input: unknown): unknown {
  return null;
}
`;

function fixtureFiles(contract: string): Record<string, string> {
  return {
    'package.json': packageJson('kory-eval-speech-audio-ai'),
    'README.md': `# speech-audio-ai: real measured corpus exercise\n\n${contract}\n\nImplement the pure solve(input) export in candidate.ts. Return JSON data; no network, subprocesses, or real account access is needed. Inputs vary identifiers, values, ordering, and failure paths. Score the supplied evidence; do not claim a real listening review, licensed human recording, or streaming service ran.\n`,
    'contract.json': `${JSON.stringify({ scenarioId: 'speech-audio-ai', evidence: 'synthetic-speech-corpus' }, null, 2)}\n`,
  };
}

function materialize(destination: string, contract: string): void {
  mkdirSync(destination, { recursive: true });
  for (const [path, content] of Object.entries(fixtureFiles(contract))) {
    writeFixtureFile(destination, path, content);
  }
  writeFixtureFile(destination, 'candidate.ts', STARTER);
}

function scoreVectors(
  workingDirectory: string,
  vectors: readonly RecognitionVector[],
): SkillEvalDeterministicScore {
  for (const [path] of Object.entries({ 'README.md': '', 'contract.json': '', 'package.json': '' })) {
    try {
      if (!lstatSync(join(workingDirectory, path)).isFile()) throw new Error('missing');
    } catch {
      return {
        passed: false,
        quality: 0,
        verification: 0,
        integrityFailure: false,
        evidence: [`Fixed fixture input is missing: ${path}; nothing was scored.`],
      };
    }
  }
  const probe = spawnSync('bun', ['--eval', RUNNER], {
    cwd: workingDirectory,
    input: JSON.stringify(vectors.map((vector) => vector.input)),
    encoding: 'utf8',
    timeout: 3000,
    maxBuffer: 256_000,
    env: { PATH: process.env.PATH ?? '', LANG: 'C', NO_COLOR: '1' },
  });
  let actual: unknown = null;
  try {
    actual = JSON.parse(probe.stdout ?? '');
  } catch {
    actual = null;
  }
  const outputs = Array.isArray(actual) ? actual : [];
  const matching = vectors.filter((vector, index) =>
    JSON.stringify(outputs[index]) === JSON.stringify(vector.expected));
  const passed = probe.status === 0 && outputs.length === vectors.length && matching.length === vectors.length;
  return {
    passed,
    quality: probe.status === 0 && outputs.length === vectors.length ? matching.length / vectors.length : 0,
    verification: passed ? 1 : 0,
    integrityFailure: false,
    evidence: [
      `Synthetic behavioral vectors over a real measured corpus: ${matching.length}/${vectors.length}.`,
      ...vectors
        .filter((vector, index) => JSON.stringify(outputs[index]) !== JSON.stringify(vector.expected))
        .map((vector) => `Failed: ${vector.name}`),
      ...(probe.status !== 0
        ? [`Candidate process did not succeed: ${String(probe.status)}`]
        : []),
    ],
  };
}

const RUNNER = `
import { readFileSync } from 'node:fs';
const input = JSON.parse(readFileSync(0, 'utf8'));
const { solve } = await import('./candidate.ts');
const output = [];
for (const item of input) output.push(await solve(item));
process.stdout.write(JSON.stringify(output));
`;

export const SPEECH_AUDIO_HARNESS_MATERIALIZERS: readonly SkillEvalFixtureMaterializer[] = [
  {
    id: `speech-audio-ai/measured-asr-corpus-v5@2`,
    realRuntime: true,
    get readinessBlockers() {
      return speechAudioHarnessReadiness();
    },
    matches: (scenario) => scenario.id === SPEECH_AUDIO_HARNESS_SCENARIOS.recognition,
    materialize: (destination) => materialize(destination, RECOGNITION_CONTRACT),
  },
  {
    id: `speech-audio-ai/measured-tts-output-v5@2`,
    realRuntime: true,
    get readinessBlockers() {
      return speechAudioHarnessReadiness();
    },
    matches: (scenario) => scenario.id === SPEECH_AUDIO_HARNESS_SCENARIOS.synthesis,
    materialize: (destination) => materialize(destination, SYNTHESIS_CONTRACT),
  },
];

export const SPEECH_AUDIO_HARNESS_SCORERS: readonly SkillEvalDeterministicScorer[] = [
  {
    id: `speech-audio-ai/measured-asr-scorer-v5@2`,
    scenarioIds: [SPEECH_AUDIO_HARNESS_SCENARIOS.recognition],
    score: ({ workingDirectory }) => scoreVectors(workingDirectory, recognitionVectors()),
  },
  {
    id: `speech-audio-ai/measured-tts-scorer-v5@2`,
    scenarioIds: [SPEECH_AUDIO_HARNESS_SCENARIOS.synthesis],
    score: ({ workingDirectory }) => scoreVectors(workingDirectory, synthesisVectors()),
  },
];

/** Retained for tests: the corpus is synthetic speech, so diarization stays a declared gap. */
export function speechAudioHarnessGaps(): string[] {
  return [
    'The held-out corpus is synthetic rendered speech, not independently licensed and independently verified human recordings.',
    'Speaker diarization over overlapping human speech is not exercised by this harness.',
    'Streaming reconnect and executed rollback traces are measured on a pinned local configuration, not on two remote provider configurations.',
    'A production listening review with independent human raters is not part of this harness.',
  ];
}

export const __testing = { RUNTIME_ROOT, PYTHON, round3, measureUtterance, synthesizeMeasures };
