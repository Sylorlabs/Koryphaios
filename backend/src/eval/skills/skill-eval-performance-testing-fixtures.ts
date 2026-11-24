import { hostOS, isMac } from '../../runtime/platform';
import { createHash, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { cpus, release } from 'node:os';
import { join } from 'node:path';
import type {
  SkillEvalDeterministicScore,
  SkillEvalDeterministicScorer,
  SkillEvalFixtureMaterializer,
} from './skill-eval-execution';
import { readFixtureText, readJsonArtifact, writeFixtureFile } from './skill-eval-fixture-helpers';

const SCENARIO_ID = 'performance-testing-full-task-2';
const BENCHMARK_TOOL_VERSION = 'kory-performance-benchmark@1';
const CORPUS_BYTES = 64 * 1024;

interface BenchmarkPlan {
  coldSeparate?: boolean;
  discardWarmup?: boolean;
  warmupMs?: number;
  repetitions?: number;
  minMeasuredMs?: number;
  machineReadable?: boolean;
  baselineIncluded?: boolean;
  baselineOrderControl?: string;
}

interface BenchmarkResult {
  schemaVersion?: number;
  scenarioId?: string;
  receipt?: string;
  cold?: { latencyMs?: number; correct?: boolean };
  warmup?: { requestedMs?: number; durationMs?: number; discarded?: boolean };
  repetitions?: Array<{
    index?: number;
    durationMs?: number;
    corpusPasses?: number;
    events?: number;
    throughputEventsPerSecond?: number;
    latencyNsPerEvent?: number;
    heapDeltaBytes?: number;
    correct?: boolean;
  }>;
  variation?: { throughputCv?: number; min?: number; max?: number };
  correctness?: { oracleMatched?: boolean; checkedPaths?: string[] };
  environment?: {
    runtime?: string;
    runtimeVersion?: string;
    platform?: string;
    architecture?: string;
    cpuModel?: string;
    osRelease?: string;
    powerFingerprintBefore?: string;
    powerFingerprintAfter?: string;
    powerStable?: boolean;
    benchmarkToolVersion?: string;
    buildOptimization?: string;
    buildFingerprint?: string;
    sourceFingerprint?: string;
    corpusFingerprint?: string;
    corpusBytes?: number;
    commitOrImage?: string;
  };
  orderControl?: { baselineIncluded?: boolean; note?: string };
}

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

function buildCorpus(): { text: string; oracle: string } {
  const typeNames = ['created', 'updated', 'deleted', 'heartbeat'] as const;
  const rows: string[] = [];
  const typeCounts: Record<string, number> = Object.fromEntries(typeNames.map((name) => [name, 0]));
  let valueSum = 0;
  let index = 0;
  while (true) {
    const type = typeNames[index % typeNames.length]!;
    const value = (index * 17) % 1009;
    const row = JSON.stringify({
      id: `evt-${String(index).padStart(5, '0')}`,
      type,
      value,
      source: index % 3 === 0 ? 'api' : index % 3 === 1 ? 'worker' : 'scheduler',
      tags: [`tenant-${index % 11}`, `shard-${index % 7}`],
      payload: `fixed-event-payload-${String(index % 97).padStart(2, '0')}`,
    });
    const candidate = `${rows.join('\n')}${rows.length ? '\n' : ''}${row}\n`;
    if (Buffer.byteLength(candidate) > 64_000) break;
    rows.push(row);
    typeCounts[type] = (typeCounts[type] ?? 0) + 1;
    valueSum += value;
    index += 1;
  }
  let text = `${rows.join('\n')}\n`;
  const padding = CORPUS_BYTES - Buffer.byteLength(text);
  if (padding < 0) throw new Error('Generated performance corpus exceeded 64KB');
  text = `${text.slice(0, -1)}${' '.repeat(padding)}\n`;
  if (Buffer.byteLength(text) !== CORPUS_BYTES)
    throw new Error('Performance corpus is not exactly 64KB');
  return {
    text,
    oracle: `${JSON.stringify({ count: rows.length, valueSum, typeCounts }, null, 2)}\n`,
  };
}

const corpus = buildCorpus();

const PARSER_SOURCE = `export function parseEvent(line) {
  const value = JSON.parse(line);
  if (!value || typeof value !== 'object') throw new TypeError('event must be an object');
  if (typeof value.id !== 'string' || typeof value.type !== 'string' || typeof value.value !== 'number') {
    throw new TypeError('event schema mismatch');
  }
  return value;
}
`;

const COLD_RUNNER = `import { pathToFileURL } from 'node:url';
const [bundlePath, corpusPath, oraclePath] = process.argv.slice(2);
const started = performance.now();
const parser = await import(pathToFileURL(bundlePath).href + '?cold=' + Date.now());
const lines = (await Bun.file(corpusPath).text()).trimEnd().split('\\n');
const oracle = JSON.parse(await Bun.file(oraclePath).text());
const counts = {};
let valueSum = 0;
for (const line of lines) {
  const event = parser.parseEvent(line);
  counts[event.type] = (counts[event.type] ?? 0) + 1;
  valueSum += event.value;
}
const correct = lines.length === oracle.count && valueSum === oracle.valueSum &&
  Object.entries(oracle.typeCounts).every(([name, count]) => counts[name] === count);
process.stdout.write(JSON.stringify({ latencyMs: performance.now() - started, correct }));
`;

const BENCHMARK_CORE = `import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { cpus, release } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const sha = (value) => createHash('sha256').update(value).digest('hex');
const [planArg, outputArg] = process.argv.slice(2);
const root = process.cwd();
const planPath = resolve(root, planArg);
const outputPath = resolve(root, outputArg);
const plan = JSON.parse(await Bun.file(planPath).text());
if (plan.coldSeparate !== true || plan.discardWarmup !== true || plan.machineReadable !== true ||
    plan.repetitions !== 5 || !Number.isFinite(plan.warmupMs) || plan.warmupMs < 20 ||
    !Number.isFinite(plan.minMeasuredMs) || plan.minMeasuredMs < 40 || plan.baselineIncluded !== false) {
  throw new Error('benchmark plan does not satisfy the fixed execution protocol');
}

const sourcePath = join(root, 'src/parser.ts');
const corpusPath = join(root, 'corpus/events.ndjson');
const oraclePath = join(root, 'corpus/oracle.json');
const sourceText = await Bun.file(sourcePath).text();
const corpusText = await Bun.file(corpusPath).text();
const build = await Bun.build({
  entrypoints: [sourcePath],
  outdir: join(root, 'dist'),
  target: 'bun',
  format: 'esm',
  minify: true,
  sourcemap: 'none',
});
if (!build.success || build.outputs.length !== 1) throw new Error('optimized parser build failed');
const bundlePath = build.outputs[0].path;
const bundleText = await Bun.file(bundlePath).text();
const oracle = JSON.parse(await Bun.file(oraclePath).text());
const lines = corpusText.trimEnd().split('\\n');

const aggregate = (parseEvent) => {
  const counts = {};
  let valueSum = 0;
  for (const line of lines) {
    const event = parseEvent(line);
    counts[event.type] = (counts[event.type] ?? 0) + 1;
    valueSum += event.value;
  }
  const correct = lines.length === oracle.count && valueSum === oracle.valueSum &&
    Object.entries(oracle.typeCounts).every(([name, count]) => counts[name] === count);
  return { correct };
};

const cold = spawnSync(process.execPath, [join(root, 'harness/cold-runner.mjs'), bundlePath, corpusPath, oraclePath], {
  cwd: root,
  env: { PATH: process.env.PATH ?? '', HOME: root, TMPDIR: root, NO_COLOR: '1', TERM: 'dumb' },
  encoding: 'utf8',
  timeout: 10_000,
  maxBuffer: 1_000_000,
});
if (cold.error || cold.status !== 0) throw new Error('cold benchmark failed: ' + (cold.error?.message ?? cold.stderr));
const coldResult = JSON.parse(cold.stdout);

const parser = await import(pathToFileURL(bundlePath).href + '?warm=' + Date.now());
if (!aggregate(parser.parseEvent).correct) throw new Error('parser does not match fixed oracle');
const warmStart = performance.now();
let warmPasses = 0;
while (performance.now() - warmStart < plan.warmupMs) {
  if (!aggregate(parser.parseEvent).correct) throw new Error('oracle failed during warmup');
  warmPasses += 1;
}
const warmupDuration = performance.now() - warmStart;

const repetitions = [];
for (let index = 0; index < plan.repetitions; index += 1) {
  const heapBefore = process.memoryUsage().heapUsed;
  const started = performance.now();
  let passes = 0;
  let correct = true;
  while (performance.now() - started < plan.minMeasuredMs) {
    correct = aggregate(parser.parseEvent).correct && correct;
    passes += 1;
  }
  const durationMs = performance.now() - started;
  const events = passes * lines.length;
  repetitions.push({
    index: index + 1,
    durationMs,
    corpusPasses: passes,
    events,
    throughputEventsPerSecond: events / (durationMs / 1000),
    latencyNsPerEvent: (durationMs * 1_000_000) / Math.max(events, 1),
    heapDeltaBytes: process.memoryUsage().heapUsed - heapBefore,
    correct,
  });
}

const powerSnapshot = () => {
  if (!isMac()) return 'power-settings-observation-not-supported-on-' + hostOS();
  const result = spawnSync('/usr/bin/pmset', ['-g', 'custom'], { encoding: 'utf8', timeout: 2_000 });
  return result.status === 0 ? result.stdout : 'pmset-unavailable';
};
const powerBefore = powerSnapshot();
await Bun.sleep(5);
const powerAfter = powerSnapshot();
const throughputs = repetitions.map((item) => item.throughputEventsPerSecond);
const mean = throughputs.reduce((sum, value) => sum + value, 0) / throughputs.length;
const variance = throughputs.reduce((sum, value) => sum + (value - mean) ** 2, 0) / throughputs.length;
const sourceFingerprint = sha(sourceText);
const result = {
  schemaVersion: 1,
  scenarioId: ${JSON.stringify(SCENARIO_ID)},
  receipt: process.env.KORY_BENCH_RECEIPT ?? '',
  cold: coldResult,
  warmup: { requestedMs: plan.warmupMs, durationMs: warmupDuration, discarded: true, corpusPasses: warmPasses },
  repetitions,
  variation: { throughputCv: Math.sqrt(variance) / Math.max(mean, 1), min: Math.min(...throughputs), max: Math.max(...throughputs) },
  correctness: { oracleMatched: repetitions.every((item) => item.correct) && coldResult.correct === true, checkedPaths: ['cold', 'warmup', 'five-warm-repetitions'] },
  environment: {
    runtime: 'Bun',
    runtimeVersion: Bun.version,
    platform: hostOS(),
    architecture: process.arch,
    cpuModel: cpus()[0]?.model ?? 'unknown',
    osRelease: release(),
    powerFingerprintBefore: sha(powerBefore),
    powerFingerprintAfter: sha(powerAfter),
    powerStable: powerBefore === powerAfter,
    benchmarkToolVersion: ${JSON.stringify(BENCHMARK_TOOL_VERSION)},
    buildOptimization: 'bun-build minify=true target=bun format=esm',
    buildFingerprint: sha(bundleText),
    sourceFingerprint,
    corpusFingerprint: sha(corpusText),
    corpusBytes: Buffer.byteLength(corpusText),
    commitOrImage: 'fixture-source-sha256:' + sourceFingerprint,
  },
  orderControl: {
    baselineIncluded: false,
    note: plan.baselineOrderControl,
  },
};
await Bun.write(outputPath, JSON.stringify(result, null, 2) + '\\n');
process.stdout.write(JSON.stringify({ ok: true, output: outputArg, repetitions: repetitions.length }));
`;

const FIXED_FILES: Readonly<Record<string, string>> = {
  'src/parser.ts': PARSER_SOURCE,
  'corpus/events.ndjson': corpus.text,
  'corpus/oracle.json': corpus.oracle,
  'harness/cold-runner.mjs': COLD_RUNNER,
  'harness/benchmark-core.mjs': BENCHMARK_CORE,
};

const STARTER_PLAN: BenchmarkPlan = {
  coldSeparate: false,
  discardWarmup: false,
  warmupMs: 0,
  repetitions: 1,
  minMeasuredMs: 0,
  machineReadable: false,
  baselineIncluded: false,
  baselineOrderControl: '',
};

export const PERFORMANCE_TESTING_VALID_PLAN: BenchmarkPlan = {
  coldSeparate: true,
  discardWarmup: true,
  warmupMs: 25,
  repetitions: 5,
  minMeasuredMs: 45,
  machineReadable: true,
  baselineIncluded: false,
  baselineOrderControl:
    'No baseline build is supplied by this fixture, so baseline/candidate ordering is not applicable. If a baseline is added, interleave or randomize repetition order.',
};

function fixedFilesIntact(root: string): boolean {
  try {
    return Object.entries(FIXED_FILES).every(
      ([path, content]) => readFixtureText(root, path) === content,
    );
  } catch {
    return false;
  }
}

function validPlan(plan: BenchmarkPlan | null): plan is Required<BenchmarkPlan> {
  return Boolean(
    plan &&
    plan.coldSeparate === true &&
    plan.discardWarmup === true &&
    plan.machineReadable === true &&
    plan.baselineIncluded === false &&
    plan.repetitions === 5 &&
    typeof plan.warmupMs === 'number' &&
    plan.warmupMs >= 20 &&
    typeof plan.minMeasuredMs === 'number' &&
    plan.minMeasuredMs >= 40 &&
    typeof plan.baselineOrderControl === 'string' &&
    /interleave|random/iu.test(plan.baselineOrderControl),
  );
}

function fail(message: string, integrityFailure = false): SkillEvalDeterministicScore {
  return {
    passed: false,
    quality: 0,
    verification: 0,
    integrityFailure,
    evidence: [message],
  };
}

async function scorePerformanceBenchmark(root: string): Promise<SkillEvalDeterministicScore> {
  if (!fixedFilesIntact(root)) {
    return fail(
      'Fixed parser, corpus, oracle, or evaluator benchmark harness was changed or replaced.',
      true,
    );
  }
  const plan = readJsonArtifact<BenchmarkPlan>(root, 'benchmark-plan.json');
  if (!validPlan(plan)) {
    return fail(
      'Benchmark plan does not separate cold/warm execution, discard warmup, preserve five repetitions, or document baseline-order control.',
    );
  }
  const receipt = `KORY_PERF_${randomUUID().replaceAll('-', '')}`;
  const outputPath = 'evaluation/performance-testing-scenario-2-raw.json';
  const run = spawnSync(
    process.execPath,
    ['run', '--no-env-file', 'harness/benchmark-core.mjs', 'benchmark-plan.json', outputPath],
    {
      cwd: root,
      env: {
        PATH: process.env.PATH ?? '',
        HOME: root,
        TMPDIR: root,
        TEMP: root,
        TMP: root,
        NO_COLOR: '1',
        TERM: 'dumb',
        KORY_BENCH_RECEIPT: receipt,
      },
      encoding: 'utf8',
      timeout: 20_000,
      maxBuffer: 1_000_000,
    },
  );
  if (run.error || run.status !== 0) {
    return fail(
      `Benchmark execution failed: ${run.error?.message ?? `${run.stdout ?? ''}\n${run.stderr ?? ''}`.trim().slice(-3_000)}`,
    );
  }
  if (!fixedFilesIntact(root)) {
    return fail('Evaluator-owned benchmark inputs changed during execution.', true);
  }
  const result = readJsonArtifact<BenchmarkResult>(root, outputPath);
  if (!result || result.receipt !== receipt)
    return fail('Machine-readable benchmark result is missing its evaluator receipt.');

  const sourceFingerprint = sha256(PARSER_SOURCE);
  const corpusFingerprint = sha256(corpus.text);
  const repetitions = result.repetitions ?? [];
  const coldWarm =
    (result.cold?.latencyMs ?? 0) > 0 &&
    result.cold?.correct === true &&
    result.warmup?.discarded === true &&
    (result.warmup?.durationMs ?? 0) >= plan.warmupMs;
  const repetitionProtocol =
    repetitions.length === 5 &&
    repetitions.every(
      (item, index) =>
        item.index === index + 1 &&
        (item.durationMs ?? 0) >= plan.minMeasuredMs &&
        (item.corpusPasses ?? 0) > 0 &&
        (item.events ?? 0) > 0 &&
        (item.throughputEventsPerSecond ?? 0) > 0 &&
        (item.latencyNsPerEvent ?? 0) > 0 &&
        Number.isFinite(item.heapDeltaBytes) &&
        item.correct === true,
    ) &&
    Number.isFinite(result.variation?.throughputCv) &&
    (result.variation?.min ?? 0) > 0 &&
    (result.variation?.max ?? 0) >= (result.variation?.min ?? 0);
  const identity =
    result.environment?.runtime === 'Bun' &&
    result.environment.runtimeVersion === Bun.version &&
    result.environment.platform === hostOS() &&
    result.environment.architecture === process.arch &&
    result.environment.cpuModel === (cpus()[0]?.model ?? 'unknown') &&
    result.environment.osRelease === release() &&
    result.environment.powerStable === true &&
    result.environment.powerFingerprintBefore === result.environment.powerFingerprintAfter &&
    result.environment.benchmarkToolVersion === BENCHMARK_TOOL_VERSION &&
    /minify=true/iu.test(result.environment.buildOptimization ?? '') &&
    typeof result.environment.buildFingerprint === 'string' &&
    result.environment.buildFingerprint.length === 64 &&
    result.environment.sourceFingerprint === sourceFingerprint &&
    result.environment.corpusFingerprint === corpusFingerprint &&
    result.environment.corpusBytes === CORPUS_BYTES &&
    result.environment.commitOrImage === `fixture-source-sha256:${sourceFingerprint}`;
  const correctness =
    result.correctness?.oracleMatched === true &&
    result.correctness.checkedPaths?.includes('cold') === true &&
    result.correctness.checkedPaths?.includes('warmup') === true &&
    result.correctness.checkedPaths?.includes('five-warm-repetitions') === true;
  const orderControl =
    result.orderControl?.baselineIncluded === false &&
    typeof result.orderControl.note === 'string' &&
    /interleave|random/iu.test(result.orderControl.note);
  const checks = [
    ['cold versus discarded warmup', coldWarm],
    ['five measured repetitions and raw variation', repetitionProtocol],
    ['build/runtime/machine/corpus identity', identity],
    ['fixed parsed-event oracle', correctness],
    ['baseline ordering control', orderControl],
  ] as const;
  const passed = checks.every(([, ok]) => ok);
  return {
    passed,
    quality: checks.filter(([, ok]) => ok).length / checks.length,
    verification: passed ? 1 : 0,
    integrityFailure: false,
    evidence: [
      outputPath,
      ...checks.map(([name, ok]) => `${name}: ${ok ? 'pass' : 'fail'}`),
      `Bun ${Bun.version}; ${hostOS()}/${process.arch}; CPU ${cpus()[0]?.model ?? 'unknown'}`,
      'The hidden runner performs actual optimized build, cold-process execution, warmup, five timed repetitions, memory sampling, and oracle checks. It does not establish skill uplift or blind semantic quality by itself.',
    ],
  };
}

export const PERFORMANCE_TESTING_SKILL_EVAL_MATERIALIZERS: readonly SkillEvalFixtureMaterializer[] =
  [
    {
      id: 'performance-testing/parser-benchmark@1',
      matches: (scenario) => scenario.id === SCENARIO_ID,
      materialize: (root) => {
        for (const [path, content] of Object.entries(FIXED_FILES))
          writeFixtureFile(root, path, content);
        writeFixtureFile(root, 'benchmark-plan.json', `${JSON.stringify(STARTER_PLAN, null, 2)}\n`);
        writeFixtureFile(
          root,
          'README.md',
          '# Parser benchmark task\n\nThe 64KB corpus, correctness oracle, parser source, and evaluator-owned benchmark engine are fixed. Complete benchmark-plan.json so the engine performs a separate cold measurement, discarded warmup, five independent measured repetitions with at least 40 ms each, machine-readable raw evidence, and explicit handling of baseline-order drift. There is no baseline build in this fixture. Do not edit src/, corpus/, or harness/.\n',
        );
      },
    },
  ];

export const PERFORMANCE_TESTING_SKILL_EVAL_SCORERS: readonly SkillEvalDeterministicScorer[] = [
  {
    id: 'performance-testing/parser-benchmark-scorer@1',
    scenarioIds: [SCENARIO_ID],
    score: ({ workingDirectory }) => scorePerformanceBenchmark(workingDirectory),
  },
];
