import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  SkillEvalDeterministicScore,
  SkillEvalDeterministicScorer,
  SkillEvalFixtureMaterializer,
} from './skill-eval-execution';
import {
  packageJson,
  readFixtureText,
  readJsonArtifact,
  writeFixtureFile,
} from './skill-eval-fixture-helpers';

const HTTP_SCENARIO = 'performance-debugging-full-task-1';
const RETENTION_SCENARIO = 'performance-debugging-full-task-2';
const HTTP_REPORT = 'evaluation/performance-debugging-scenario-1-runtime.json';
const RETENTION_REPORT = 'evaluation/performance-debugging-scenario-2-runtime.json';
const LOCAL_RUN_TIMEOUT_MS = 10_000;

const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex');

interface HttpRecord {
  id: string;
  value: number;
  group: number;
}

const httpRecords: HttpRecord[] = Array.from({ length: 20_000 }, (_, index) => ({
  id: `record-${String(index).padStart(5, '0')}`,
  value: (index * 97) % 65_521,
  group: index % 31,
}));
const httpRequestIds = Array.from(
  { length: 220 },
  (_, index) => httpRecords[(index * 7_919 + 37) % httpRecords.length]!.id,
);
const httpOracle = Object.fromEntries(
  httpRecords.map((record) => [
    record.id,
    {
      id: record.id,
      score: (record.value * 31 + record.group * 17) % 1_000_003,
    },
  ]),
);
const HTTP_DATASET = `${JSON.stringify(httpRecords)}\n`;
const HTTP_WORKLOAD = `${JSON.stringify({
  offeredRequestsPerSecond: 400,
  warmupRequests: 20,
  repetitions: 5,
  requestsPerRepetition: 40,
  requestIds: httpRequestIds,
})}\n`;
const HTTP_ORACLE = `${JSON.stringify(httpOracle)}\n`;

export const PERFORMANCE_DEBUGGING_HTTP_INITIAL_SOURCE = `export interface RecordRow { id: string; value: number; group: number }
export interface ResultRow { id: string; score: number }

export function createRequestHandler(records: readonly RecordRow[]): (id: string) => ResultRow {
  return (id: string) => {
    // BUG: request logging serializes the complete 20k-record catalog twice on every lookup.
    JSON.stringify(records);
    JSON.stringify(records);
    const record = records.find((item) => item.id === id);
    if (!record) throw new Error('record not found');
    return { id: record.id, score: (record.value * 31 + record.group * 17) % 1_000_003 };
  };
}
`;

export const PERFORMANCE_DEBUGGING_HTTP_FIXED_SOURCE = `export interface RecordRow { id: string; value: number; group: number }
export interface ResultRow { id: string; score: number }

export function createRequestHandler(records: readonly RecordRow[]): (id: string) => ResultRow {
  const recordsById = new Map(records.map((record) => [record.id, record]));
  return (id: string) => {
    const record = recordsById.get(id);
    if (!record) throw new Error('record not found');
    return { id: record.id, score: (record.value * 31 + record.group * 17) % 1_000_003 };
  };
}
`;

export const PERFORMANCE_DEBUGGING_HTTP_PLAUSIBLE_FAULTY_SOURCE = `export interface RecordRow { id: string; value: number; group: number }
export interface ResultRow { id: string; score: number }

export function createRequestHandler(records: readonly RecordRow[]): (id: string) => ResultRow {
  const recordsById = new Map(records.map((record) => [record.id, record]));
  return (id: string) => {
    // Plausible but incomplete: lookup is indexed, while the hot-path full-catalog serialization remains.
    JSON.stringify(records);
    const record = recordsById.get(id);
    if (!record) throw new Error('record not found');
    return { id: record.id, score: (record.value * 31 + record.group * 17) % 1_000_003 };
  };
}
`;

const HTTP_RUNNER = `import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { pathToFileURL } from 'node:url';

const sha = (value) => createHash('sha256').update(value).digest('hex');
const outputPath = process.argv[2];
const receipt = process.env.KORY_PERFORMANCE_RECEIPT ?? '';
if (!outputPath || !receipt) throw new Error('missing evaluator output or receipt');
const datasetText = readFileSync('workload/http-records.json', 'utf8');
const workloadText = readFileSync('workload/http-workload.json', 'utf8');
const oracleText = readFileSync('workload/http-oracle.json', 'utf8');
const records = Object.freeze(JSON.parse(datasetText));
const workload = JSON.parse(workloadText);
const oracle = JSON.parse(oracleText);
if (records.length !== 20_000 || workload.offeredRequestsPerSecond !== 400 ||
    workload.warmupRequests !== 20 || workload.repetitions !== 5 ||
    workload.requestsPerRepetition !== 40 || workload.requestIds.length !== 220) {
  throw new Error('fixed HTTP workload protocol mismatch');
}

let handlerCpuMicros = 0;
let handlerWallMs = 0;
let handlerCalls = 0;
const imported = await import(pathToFileURL(process.cwd() + '/src/service.ts').href + '?receipt=' + encodeURIComponent(receipt));
if (typeof imported.createRequestHandler !== 'function') throw new Error('createRequestHandler export is required');
const handler = imported.createRequestHandler(records);
if (typeof handler !== 'function') throw new Error('createRequestHandler must return a function');
const server = Bun.serve({
  hostname: '127.0.0.1',
  port: 0,
  fetch(request) {
    const id = new URL(request.url).searchParams.get('id') ?? '';
    const cpuStart = process.cpuUsage();
    const wallStart = performance.now();
    try {
      const body = handler(id);
      return Response.json(body);
    } catch (error) {
      return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 });
    } finally {
      const cpu = process.cpuUsage(cpuStart);
      handlerCpuMicros += cpu.user + cpu.system;
      handlerWallMs += performance.now() - wallStart;
      handlerCalls += 1;
    }
  },
});

const intervalMs = 1000 / workload.offeredRequestsPerSecond;
const percentile = (values, fraction) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)] ?? 0;
};
const profileSnapshot = () => ({ handlerCpuMicros, handlerWallMs, handlerCalls });
const profileDelta = (before) => ({
  handlerCpuMicros: handlerCpuMicros - before.handlerCpuMicros,
  handlerWallMs: handlerWallMs - before.handlerWallMs,
  handlerCalls: handlerCalls - before.handlerCalls,
});

async function batch(ids, label) {
  const scheduledStart = performance.now() + 15;
  const cpuStart = process.cpuUsage();
  const memoryStart = process.memoryUsage();
  const profileStart = profileSnapshot();
  let inFlight = 0;
  let maxInFlight = 0;
  const latencies = [];
  const queueDelays = [];
  let responseBytes = 0;
  let correct = true;
  const requests = ids.map((id, index) => new Promise((resolve) => {
    const scheduledAt = scheduledStart + index * intervalMs;
    setTimeout(async () => {
      const dispatchedAt = performance.now();
      queueDelays.push(Math.max(0, dispatchedAt - scheduledAt));
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      // Latency is the real request round trip, measured from the actual send.
      // Scheduling jitter is recorded separately in queueDelays.
      const sentAt = performance.now();
      try {
        const response = await fetch('http://127.0.0.1:' + server.port + '/record?id=' + encodeURIComponent(id));
        const text = await response.text();
        latencies.push(performance.now() - sentAt);
        responseBytes += Buffer.byteLength(text);
        const value = JSON.parse(text);
        correct = correct && response.status === 200 && value.id === oracle[id].id && value.score === oracle[id].score;
      } catch {
        correct = false;
        latencies.push(performance.now() - sentAt);
      } finally {
        inFlight -= 1;
        resolve();
      }
    }, Math.max(0, scheduledAt - performance.now()));
  }));
  await Promise.all(requests);
  const finishedAt = performance.now();
  const cpu = process.cpuUsage(cpuStart);
  const memoryEnd = process.memoryUsage();
  const wallMs = finishedAt - scheduledStart;
  const cpuMs = (cpu.user + cpu.system) / 1000;
  return {
    label,
    offeredRequestsPerSecond: workload.offeredRequestsPerSecond,
    requests: ids.length,
    durationMs: wallMs,
    p50Ms: percentile(latencies, 0.5),
    p95Ms: percentile(latencies, 0.95),
    p99Ms: percentile(latencies, 0.99),
    throughputRequestsPerSecond: ids.length / (wallMs / 1000),
    correctness: correct,
    resources: {
      cpuUserMicros: cpu.user,
      cpuSystemMicros: cpu.system,
      heapDeltaBytes: memoryEnd.heapUsed - memoryStart.heapUsed,
      rssDeltaBytes: memoryEnd.rss - memoryStart.rss,
      arrayBufferDeltaBytes: memoryEnd.arrayBuffers - memoryStart.arrayBuffers,
      localIoResponseBytes: responseBytes,
      ioWaitEstimateMs: Math.max(0, wallMs - cpuMs),
    },
    saturation: {
      maxInFlight,
      maxScheduleDelayMs: Math.max(...queueDelays),
      p95ScheduleDelayMs: percentile(queueDelays, 0.95),
    },
    profile: profileDelta(profileStart),
  };
}

let report;
try {
  const warmup = await batch(workload.requestIds.slice(0, workload.warmupRequests), 'discarded-warmup');
  const repetitions = [];
  for (let index = 0; index < workload.repetitions; index += 1) {
    if (typeof Bun.gc === 'function') Bun.gc(true);
    const offset = workload.warmupRequests + index * workload.requestsPerRepetition;
    repetitions.push(await batch(
      workload.requestIds.slice(offset, offset + workload.requestsPerRepetition),
      'measured-' + (index + 1),
    ));
  }
  report = {
    schemaVersion: 1,
    scenarioId: ${JSON.stringify(HTTP_SCENARIO)},
    evidenceKind: 'actual-local-loopback-http-runtime',
    receipt,
    pid: process.pid,
    sourceFingerprint: sha(readFileSync('src/service.ts', 'utf8')),
    fixedFingerprints: {
      dataset: sha(datasetText),
      workload: sha(workloadText),
      oracle: sha(oracleText),
    },
    workload: {
      datasetRecords: records.length,
      offeredRequestsPerSecond: workload.offeredRequestsPerSecond,
      warmupRequests: workload.warmupRequests,
      repetitions: workload.repetitions,
      requestsPerRepetition: workload.requestsPerRepetition,
    },
    warmup: { ...warmup, discarded: true },
    repetitions,
  };
} finally {
  server.stop(true);
}
await Bun.write(outputPath, JSON.stringify(report, null, 2) + '\\n');
`;

const PROJECT_BYTES = 50 * 1024 * 1024;
const RETAINED_BYTES_PER_CYCLE = 18 * 1024 * 1024;
const PROJECT_SAMPLE_CHECKSUM = (PROJECT_BYTES / 4096) * 42;
const PROJECT_MANIFEST = `${JSON.stringify(
  {
    projectId: 'fixed-project-50mb',
    projectBytes: PROJECT_BYTES,
    fillByte: 42,
    sampleStride: 4096,
    sampleChecksum: PROJECT_SAMPLE_CHECKSUM,
    cycles: 20,
    checkpoints: [1, 10, 20],
    retainedBytesPerCycle: RETAINED_BYTES_PER_CYCLE,
  },
  null,
  2,
)}\n`;

export const PERFORMANCE_DEBUGGING_RETENTION_INITIAL_SOURCE = `export interface ProjectFixture { id: string; bytes: Uint8Array; checksum: number }
export interface RetentionToken { cycle: number; bytes: Uint8Array }
export interface ProjectSession { projectId: string; checksum: number; token: RetentionToken }

export function createProjectLifecycle() {
  let active: ProjectSession | undefined;
  const recentlyClosed: ProjectSession[] = [];
  return {
    openProject(project: ProjectFixture, token: RetentionToken): ProjectSession {
      active = { projectId: project.id, checksum: project.checksum, token };
      return active;
    },
    closeProject(session: ProjectSession): void {
      if (active !== session) throw new Error('closing inactive project');
      // BUG: closed sessions remain strongly reachable from lifecycle history.
      recentlyClosed.push(session);
      active = undefined;
    },
  };
}
`;

export const PERFORMANCE_DEBUGGING_RETENTION_FIXED_SOURCE = `export interface ProjectFixture { id: string; bytes: Uint8Array; checksum: number }
export interface RetentionToken { cycle: number; bytes: Uint8Array }
export interface ProjectSession { projectId: string; checksum: number; token: RetentionToken }

export function createProjectLifecycle() {
  let active: ProjectSession | undefined;
  return {
    openProject(project: ProjectFixture, token: RetentionToken): ProjectSession {
      active = { projectId: project.id, checksum: project.checksum, token };
      return active;
    },
    closeProject(session: ProjectSession): void {
      if (active !== session) throw new Error('closing inactive project');
      active = undefined;
    },
  };
}
`;

export const PERFORMANCE_DEBUGGING_RETENTION_PLAUSIBLE_FAULTY_SOURCE = `export interface ProjectFixture { id: string; bytes: Uint8Array; checksum: number }
export interface RetentionToken { cycle: number; bytes: Uint8Array }
export interface ProjectSession { projectId: string; checksum: number; token: RetentionToken }

export function createProjectLifecycle() {
  let active: ProjectSession | undefined;
  const recentDiagnostics: ProjectSession[] = [];
  return {
    openProject(project: ProjectFixture, token: RetentionToken): ProjectSession {
      active = { projectId: project.id, checksum: project.checksum, token };
      return active;
    },
    closeProject(session: ProjectSession): void {
      if (active !== session) throw new Error('closing inactive project');
      // Plausible but still faulty: retaining every fifth closed session remains unbounded.
      if (session.token.cycle % 5 === 0) recentDiagnostics.push(session);
      active = undefined;
    },
  };
}
`;

const RETENTION_RUNNER = `import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const sha = (value) => createHash('sha256').update(value).digest('hex');
const outputPath = process.argv[2];
const receipt = process.env.KORY_PERFORMANCE_RECEIPT ?? '';
if (!outputPath || !receipt) throw new Error('missing evaluator output or receipt');
const manifestText = readFileSync('workload/project-manifest.json', 'utf8');
const manifest = JSON.parse(manifestText);
if (manifest.projectBytes !== 50 * 1024 * 1024 || manifest.cycles !== 20 ||
    JSON.stringify(manifest.checkpoints) !== JSON.stringify([1, 10, 20]) ||
    manifest.retainedBytesPerCycle !== 18 * 1024 * 1024) {
  throw new Error('fixed retention workload protocol mismatch');
}
const projectBytes = new Uint8Array(manifest.projectBytes);
projectBytes.fill(manifest.fillByte);
let checksum = 0;
for (let index = 0; index < projectBytes.length; index += manifest.sampleStride) checksum += projectBytes[index];
if (checksum !== manifest.sampleChecksum) throw new Error('project fixture oracle mismatch');
const project = Object.freeze({ id: manifest.projectId, bytes: projectBytes, checksum });
const imported = await import(pathToFileURL(process.cwd() + '/src/lifecycle.ts').href + '?receipt=' + encodeURIComponent(receipt));
if (typeof imported.createProjectLifecycle !== 'function') throw new Error('createProjectLifecycle export is required');
const lifecycle = imported.createProjectLifecycle();
if (!lifecycle || typeof lifecycle.openProject !== 'function' || typeof lifecycle.closeProject !== 'function') {
  throw new Error('project lifecycle contract mismatch');
}

const weakTokens = [];
const checkpoints = [];
const cycles = [];
const initialMemory = process.memoryUsage();
let reopenCorrect = true;
let gcCheckpoints = 0;

// Bun reports process.memoryUsage().arrayBuffers as 0, so retained typed-array ownership is
// measured exactly through evaluator-owned WeakRefs instead of a process-wide counter.
const liveTokens = () => weakTokens.filter((reference) => reference.deref());
const liveTokenBytes = () => liveTokens().reduce((total, reference) => total + (reference.deref()?.bytes?.byteLength || 0), 0);

async function openAndClose(cycle) {
  let token = { cycle, bytes: new Uint8Array(manifest.retainedBytesPerCycle) };
  token.bytes.fill(cycle & 255);
  let session = lifecycle.openProject(project, token);
  reopenCorrect = reopenCorrect && session?.projectId === project.id &&
    session?.checksum === manifest.sampleChecksum && session?.token === token;
  const weak = new WeakRef(token);
  weakTokens.push(weak);
  const transient = process.memoryUsage();
  const transientLiveTokens = liveTokens().length;
  const transientLiveTokenBytes = liveTokenBytes();
  lifecycle.closeProject(session);
  session = undefined;
  token = undefined;
  await Bun.sleep(0);
  return { transient, transientLiveTokens, transientLiveTokenBytes };
}

for (let cycle = 1; cycle <= manifest.cycles; cycle += 1) {
  const transient = await openAndClose(cycle);
  Bun.gc(true);
  gcCheckpoints += 1;
  await Bun.sleep(0);
  const settled = process.memoryUsage();
  const record = {
    cycle,
    pid: process.pid,
    retainedTokens: liveTokens().length,
    retainedTokenBytes: liveTokenBytes(),
    transientLiveTokens: transient.transientLiveTokens,
    transientLiveTokenBytes: transient.transientLiveTokenBytes,
    transientHeapUsedBytes: transient.transient.heapUsed,
    transientExternalBytes: transient.transient.external,
    transientRssBytes: transient.transient.rss,
    settledHeapUsedBytes: settled.heapUsed,
    settledExternalBytes: settled.external,
    settledRssBytes: settled.rss,
  };
  cycles.push(record);
  if (manifest.checkpoints.includes(cycle)) checkpoints.push(record);
}

const finalMemory = process.memoryUsage();
const report = {
  schemaVersion: 1,
  scenarioId: ${JSON.stringify(RETENTION_SCENARIO)},
  evidenceKind: 'actual-local-single-process-retained-state-runtime',
  receipt,
  pid: process.pid,
  sourceFingerprint: sha(readFileSync('src/lifecycle.ts', 'utf8')),
  fixedFingerprints: { manifest: sha(manifestText) },
  protocol: {
    projectId: manifest.projectId,
    projectBytes: manifest.projectBytes,
    cycles: manifest.cycles,
    checkpoints: manifest.checkpoints,
    retainedBytesPerCycle: manifest.retainedBytesPerCycle,
    settleBeforeGc: true,
    gcCheckpoints,
    processRestarts: 0,
  },
  correctness: { reopenCorrect, successfulCycles: cycles.length, sampleChecksum: checksum },
  initialMemory,
  finalMemory,
  cycles,
  checkpoints,
};
await Bun.write(outputPath, JSON.stringify(report, null, 2) + '\\n');
`;

const HTTP_FIXED_FILES: Readonly<Record<string, string>> = {
  'package.json': packageJson('kory-performance-debugging-http', {}),
  'reference/base-service.ts': PERFORMANCE_DEBUGGING_HTTP_FIXED_SOURCE,
  'reference/regressed-service.ts': PERFORMANCE_DEBUGGING_HTTP_INITIAL_SOURCE,
  'workload/http-records.json': HTTP_DATASET,
  'workload/http-workload.json': HTTP_WORKLOAD,
  'workload/http-oracle.json': HTTP_ORACLE,
  'harness/http-runner.mjs': HTTP_RUNNER,
};

const RETENTION_FIXED_FILES: Readonly<Record<string, string>> = {
  'package.json': packageJson('kory-performance-debugging-retention', {}),
  'reference/regressed-lifecycle.ts': PERFORMANCE_DEBUGGING_RETENTION_INITIAL_SOURCE,
  'workload/project-manifest.json': PROJECT_MANIFEST,
  'harness/retention-runner.mjs': RETENTION_RUNNER,
};

interface LocalRun<T> {
  report: T | null;
  evidence: string;
  integrityFailure: boolean;
}

interface HttpRepetition {
  offeredRequestsPerSecond?: number;
  requests?: number;
  durationMs?: number;
  p50Ms?: number;
  p95Ms?: number;
  p99Ms?: number;
  throughputRequestsPerSecond?: number;
  correctness?: boolean;
  resources?: {
    cpuUserMicros?: number;
    cpuSystemMicros?: number;
    heapDeltaBytes?: number;
    rssDeltaBytes?: number;
    arrayBufferDeltaBytes?: number;
    localIoResponseBytes?: number;
    ioWaitEstimateMs?: number;
  };
  saturation?: { maxInFlight?: number; maxScheduleDelayMs?: number; p95ScheduleDelayMs?: number };
  profile?: { handlerCpuMicros?: number; handlerWallMs?: number; handlerCalls?: number };
}

interface HttpRuntimeReport {
  schemaVersion?: number;
  scenarioId?: string;
  evidenceKind?: string;
  receipt?: string;
  pid?: number;
  sourceFingerprint?: string;
  fixedFingerprints?: { dataset?: string; workload?: string; oracle?: string };
  workload?: {
    datasetRecords?: number;
    offeredRequestsPerSecond?: number;
    warmupRequests?: number;
    repetitions?: number;
    requestsPerRepetition?: number;
  };
  warmup?: HttpRepetition & { discarded?: boolean };
  repetitions?: HttpRepetition[];
}

interface RetentionCycle {
  cycle?: number;
  pid?: number;
  retainedTokens?: number;
  retainedTokenBytes?: number;
  transientLiveTokens?: number;
  transientLiveTokenBytes?: number;
  transientHeapUsedBytes?: number;
  transientExternalBytes?: number;
  transientRssBytes?: number;
  settledHeapUsedBytes?: number;
  settledExternalBytes?: number;
  settledRssBytes?: number;
}

interface RetentionRuntimeReport {
  schemaVersion?: number;
  scenarioId?: string;
  evidenceKind?: string;
  receipt?: string;
  pid?: number;
  sourceFingerprint?: string;
  fixedFingerprints?: { manifest?: string };
  protocol?: {
    projectId?: string;
    projectBytes?: number;
    cycles?: number;
    checkpoints?: number[];
    retainedBytesPerCycle?: number;
    settleBeforeGc?: boolean;
    gcCheckpoints?: number;
    processRestarts?: number;
  };
  correctness?: { reopenCorrect?: boolean; successfulCycles?: number; sampleChecksum?: number };
  initialMemory?: { heapUsed?: number; arrayBuffers?: number; rss?: number };
  finalMemory?: { heapUsed?: number; arrayBuffers?: number; rss?: number };
  cycles?: RetentionCycle[];
  checkpoints?: RetentionCycle[];
}

function fixedFilesIntact(root: string, files: Readonly<Record<string, string>>): boolean {
  try {
    return Object.entries(files).every(
      ([path, content]) => readFixtureText(root, path) === content,
    );
  } catch {
    return false;
  }
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

function runLocalEvaluator<T>(input: {
  fixedFiles: Readonly<Record<string, string>>;
  sourcePath: string;
  source: string;
  runnerPath: string;
  expectedScenario: string;
  validateIdentity: (report: T, receipt: string, sourceFingerprint: string) => boolean;
}): LocalRun<T> {
  const root = mkdtempSync(join(tmpdir(), 'kory-performance-debugging-'));
  const receipt = `KORY_PERFORMANCE_${randomUUID().replaceAll('-', '')}`;
  const outputPath = 'evaluation/runtime-report.json';
  try {
    for (const [path, content] of Object.entries(input.fixedFiles)) {
      writeFixtureFile(root, path, content);
    }
    writeFixtureFile(root, input.sourcePath, input.source);
    const ownedFiles = { ...input.fixedFiles, [input.sourcePath]: input.source };
    const run = spawnSync(
      process.execPath,
      ['run', '--no-env-file', input.runnerPath, outputPath],
      {
        cwd: root,
        env: {
          PATH: process.env.PATH ?? '',
          HOME: root,
          XDG_CONFIG_HOME: join(root, 'config'),
          XDG_CACHE_HOME: join(root, 'cache'),
          TMPDIR: root,
          TEMP: root,
          TMP: root,
          NO_COLOR: '1',
          TERM: 'dumb',
          KORY_PERFORMANCE_RECEIPT: receipt,
        },
        encoding: 'utf8',
        timeout: LOCAL_RUN_TIMEOUT_MS,
        killSignal: 'SIGKILL',
        maxBuffer: 1_000_000,
      },
    );
    const unchanged = fixedFilesIntact(root, ownedFiles);
    if (!unchanged) {
      return {
        report: null,
        evidence: `${input.expectedScenario}: evaluator-owned run files changed during execution`,
        integrityFailure: true,
      };
    }
    if (run.error || run.status !== 0 || run.signal) {
      const output = `${run.stdout ?? ''}\n${run.stderr ?? ''}`.trim().slice(-3_000);
      return {
        report: null,
        evidence: `${input.expectedScenario}: bounded local process failed (${run.error?.message ?? run.signal ?? run.status})${output ? `\n${output}` : ''}`,
        integrityFailure: false,
      };
    }
    const report = readJsonArtifact<T>(root, outputPath);
    const sourceFingerprint = sha256(input.source);
    if (!report || !input.validateIdentity(report, receipt, sourceFingerprint)) {
      return {
        report: null,
        evidence: `${input.expectedScenario}: evaluator receipt or fixed-input/source fingerprints did not validate`,
        integrityFailure: true,
      };
    }
    return {
      report,
      evidence: `${input.expectedScenario}: bounded local process completed with verified evaluator receipt`,
      integrityFailure: false,
    };
  } catch (error) {
    return {
      report: null,
      evidence: `${input.expectedScenario}: ${error instanceof Error ? error.message : String(error)}`,
      integrityFailure: true,
    };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function validHttpIdentity(
  report: HttpRuntimeReport,
  receipt: string,
  sourceFingerprint: string,
): boolean {
  return (
    report.schemaVersion === 1 &&
    report.scenarioId === HTTP_SCENARIO &&
    report.evidenceKind === 'actual-local-loopback-http-runtime' &&
    report.receipt === receipt &&
    Number.isInteger(report.pid) &&
    report.sourceFingerprint === sourceFingerprint &&
    report.fixedFingerprints?.dataset === sha256(HTTP_DATASET) &&
    report.fixedFingerprints.workload === sha256(HTTP_WORKLOAD) &&
    report.fixedFingerprints.oracle === sha256(HTTP_ORACLE)
  );
}

function validRetentionIdentity(
  report: RetentionRuntimeReport,
  receipt: string,
  sourceFingerprint: string,
): boolean {
  return (
    report.schemaVersion === 1 &&
    report.scenarioId === RETENTION_SCENARIO &&
    report.evidenceKind === 'actual-local-single-process-retained-state-runtime' &&
    report.receipt === receipt &&
    Number.isInteger(report.pid) &&
    report.sourceFingerprint === sourceFingerprint &&
    report.fixedFingerprints?.manifest === sha256(PROJECT_MANIFEST)
  );
}

function runHttpSource(source: string): LocalRun<HttpRuntimeReport> {
  return runLocalEvaluator({
    fixedFiles: HTTP_FIXED_FILES,
    sourcePath: 'src/service.ts',
    source,
    runnerPath: 'harness/http-runner.mjs',
    expectedScenario: HTTP_SCENARIO,
    validateIdentity: validHttpIdentity,
  });
}

function runRetentionSource(source: string): LocalRun<RetentionRuntimeReport> {
  return runLocalEvaluator({
    fixedFiles: RETENTION_FIXED_FILES,
    sourcePath: 'src/lifecycle.ts',
    source,
    runnerPath: 'harness/retention-runner.mjs',
    expectedScenario: RETENTION_SCENARIO,
    validateIdentity: validRetentionIdentity,
  });
}

function finitePositive(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

function httpProtocolValid(report: HttpRuntimeReport): boolean {
  const repetitions = report.repetitions ?? [];
  return Boolean(
    report.workload?.datasetRecords === 20_000 &&
    report.workload.offeredRequestsPerSecond === 400 &&
    report.workload.warmupRequests === 20 &&
    report.workload.repetitions === 5 &&
    report.workload.requestsPerRepetition === 40 &&
    report.warmup?.discarded === true &&
    report.warmup.correctness === true &&
    report.warmup.requests === 20 &&
    repetitions.length === 5 &&
    repetitions.every(
      (item) =>
        item.offeredRequestsPerSecond === 400 &&
        item.requests === 40 &&
        item.correctness === true &&
        finitePositive(item.durationMs) &&
        finitePositive(item.p50Ms) &&
        finitePositive(item.p95Ms) &&
        finitePositive(item.p99Ms) &&
        finitePositive(item.throughputRequestsPerSecond) &&
        finitePositive(item.resources?.cpuUserMicros) &&
        typeof item.resources?.cpuSystemMicros === 'number' &&
        Number.isFinite(item.resources.heapDeltaBytes) &&
        Number.isFinite(item.resources.rssDeltaBytes) &&
        Number.isFinite(item.resources.arrayBufferDeltaBytes) &&
        finitePositive(item.resources.localIoResponseBytes) &&
        typeof item.resources.ioWaitEstimateMs === 'number' &&
        item.resources.ioWaitEstimateMs >= 0 &&
        finitePositive(item.saturation?.maxInFlight) &&
        typeof item.saturation?.maxScheduleDelayMs === 'number' &&
        item.saturation.maxScheduleDelayMs >= 0 &&
        typeof item.saturation.p95ScheduleDelayMs === 'number' &&
        item.saturation.p95ScheduleDelayMs >= 0 &&
        finitePositive(item.profile?.handlerCpuMicros) &&
        finitePositive(item.profile.handlerWallMs) &&
        item.profile.handlerCalls === 40,
    ),
  );
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

function httpSummary(report: HttpRuntimeReport): {
  p50Ms: number;
  p95Ms: number;
  p99Ms: number;
  throughput: number;
  handlerCpuMicros: number;
  handlerWallMs: number;
  heapDeltaBytes: number;
  rssDeltaBytes: number;
  ioWaitEstimateMs: number;
  scheduleDelayMs: number;
} {
  const repetitions = report.repetitions!;
  return {
    p50Ms: median(repetitions.map((item) => item.p50Ms!)),
    p95Ms: median(repetitions.map((item) => item.p95Ms!)),
    p99Ms: median(repetitions.map((item) => item.p99Ms!)),
    throughput: median(repetitions.map((item) => item.throughputRequestsPerSecond!)),
    handlerCpuMicros: median(repetitions.map((item) => item.profile!.handlerCpuMicros!)),
    handlerWallMs: median(repetitions.map((item) => item.profile!.handlerWallMs!)),
    heapDeltaBytes: median(repetitions.map((item) => item.resources!.heapDeltaBytes!)),
    rssDeltaBytes: median(repetitions.map((item) => item.resources!.rssDeltaBytes!)),
    ioWaitEstimateMs: median(repetitions.map((item) => item.resources!.ioWaitEstimateMs!)),
    scheduleDelayMs: median(repetitions.map((item) => item.saturation!.p95ScheduleDelayMs!)),
  };
}

async function scoreHttpRegression(root: string): Promise<SkillEvalDeterministicScore> {
  if (!fixedFilesIntact(root, HTTP_FIXED_FILES)) {
    return fail(
      'Fixed HTTP dataset, workload, oracle, references, or evaluator runner changed.',
      true,
    );
  }
  let candidateSource: string;
  try {
    candidateSource = readFixtureText(root, 'src/service.ts');
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error), true);
  }

  const baseline = runHttpSource(PERFORMANCE_DEBUGGING_HTTP_FIXED_SOURCE);
  const before = runHttpSource(PERFORMANCE_DEBUGGING_HTTP_INITIAL_SOURCE);
  const after =
    candidateSource === PERFORMANCE_DEBUGGING_HTTP_INITIAL_SOURCE
      ? before
      : runHttpSource(candidateSource);
  const runs = [baseline, before, after];
  const failedRun = runs.find((run) => !run.report);
  if (failedRun) return fail(failedRun.evidence, failedRun.integrityFailure);
  if (!fixedFilesIntact(root, HTTP_FIXED_FILES)) {
    return fail('Evaluator-owned HTTP inputs changed during scoring.', true);
  }

  const baselineReport = baseline.report!;
  const beforeReport = before.report!;
  const afterReport = after.report!;
  const protocol = [baselineReport, beforeReport, afterReport].every(httpProtocolValid);
  if (!protocol)
    return fail(
      'A local HTTP run omitted fixed warmup, repetition, latency, throughput, resource, profile, saturation, or correctness evidence.',
    );

  const baselineSummary = httpSummary(baselineReport);
  const beforeSummary = httpSummary(beforeReport);
  const afterSummary = httpSummary(afterReport);
  const regressionReproduced =
    beforeSummary.p95Ms > baselineSummary.p95Ms * 1.5 &&
    beforeSummary.handlerCpuMicros > baselineSummary.handlerCpuMicros * 5 &&
    beforeSummary.throughput < baselineSummary.throughput * 0.9;
  const causalProfile =
    beforeSummary.handlerCpuMicros > afterSummary.handlerCpuMicros * 2.5 &&
    beforeSummary.handlerWallMs > afterSummary.handlerWallMs * 2.5;
  const restored =
    afterSummary.p95Ms < beforeSummary.p95Ms * 0.55 &&
    afterSummary.throughput > beforeSummary.throughput * 1.25 &&
    afterSummary.p95Ms <= baselineSummary.p95Ms * 3 + 3 &&
    afterSummary.throughput >= baselineSummary.throughput * 0.8;
  const semanticCorrectness = [baselineReport, beforeReport, afterReport].every((report) =>
    report.repetitions!.every((item) => item.correctness === true),
  );
  const sourceChanged =
    sha256(candidateSource) !== sha256(PERFORMANCE_DEBUGGING_HTTP_INITIAL_SOURCE);
  const checks = [
    ['fixed 20k-record/400-rps warmup and five-repetition protocol', protocol],
    ['starting p95/throughput regression reproduced against base', regressionReproduced],
    ['evaluator-owned handler CPU/wall profile explains the delta', causalProfile],
    ['identical post-fix run restores p95 and throughput', restored],
    ['fixed response oracle remains green', semanticCorrectness],
    ['candidate implementation differs from the regressed start', sourceChanged],
  ] as const;
  const passed = checks.every(([, ok]) => ok);
  const aggregate = {
    schemaVersion: 1,
    scenarioId: HTTP_SCENARIO,
    evidenceKind: 'evaluator-owned-before-after-local-runtime',
    integrity: {
      fixedInputsVerified: true,
      receiptsVerified: true,
      datasetFingerprint: sha256(HTTP_DATASET),
      workloadFingerprint: sha256(HTTP_WORKLOAD),
      oracleFingerprint: sha256(HTTP_ORACLE),
      candidateSourceFingerprint: sha256(candidateSource),
    },
    protocol: {
      localLoopbackHttp: true,
      boundedChildTimeoutMs: LOCAL_RUN_TIMEOUT_MS,
      datasetRecords: 20_000,
      offeredRequestsPerSecond: 400,
      warmupRequests: 20,
      repetitions: 5,
      requestsPerRepetition: 40,
    },
    baseline: { summary: baselineSummary, raw: baselineReport },
    before: { summary: beforeSummary, raw: beforeReport },
    after: { summary: afterSummary, raw: afterReport },
    checks: Object.fromEntries(checks),
  };
  try {
    writeFixtureFile(root, HTTP_REPORT, `${JSON.stringify(aggregate, null, 2)}\n`);
  } catch (error) {
    return fail(
      `Unable to persist evaluator-owned HTTP report: ${error instanceof Error ? error.message : String(error)}`,
      true,
    );
  }
  return {
    passed,
    quality: checks.filter(([, ok]) => ok).length / checks.length,
    verification: passed ? 1 : 0,
    integrityFailure: false,
    evidence: [
      HTTP_REPORT,
      baseline.evidence,
      before.evidence,
      after.evidence,
      ...checks.map(([name, ok]) => `${name}: ${ok ? 'pass' : 'fail'}`),
      `median p95 ms base/before/after: ${baselineSummary.p95Ms.toFixed(2)} / ${beforeSummary.p95Ms.toFixed(2)} / ${afterSummary.p95Ms.toFixed(2)}`,
      `median throughput rps base/before/after: ${baselineSummary.throughput.toFixed(1)} / ${beforeSummary.throughput.toFixed(1)} / ${afterSummary.throughput.toFixed(1)}`,
      `median handler CPU us base/before/after: ${baselineSummary.handlerCpuMicros.toFixed(0)} / ${beforeSummary.handlerCpuMicros.toFixed(0)} / ${afterSummary.handlerCpuMicros.toFixed(0)}`,
    ],
  };
}

function retentionProtocolValid(report: RetentionRuntimeReport): boolean {
  const cycles = report.cycles ?? [];
  const checkpoints = report.checkpoints ?? [];
  const pid = report.pid;
  return Boolean(
    report.protocol?.projectId === 'fixed-project-50mb' &&
    report.protocol.projectBytes === PROJECT_BYTES &&
    report.protocol.cycles === 20 &&
    JSON.stringify(report.protocol.checkpoints) === JSON.stringify([1, 10, 20]) &&
    report.protocol.retainedBytesPerCycle === RETAINED_BYTES_PER_CYCLE &&
    report.protocol.settleBeforeGc === true &&
    report.protocol.gcCheckpoints === 20 &&
    report.protocol.processRestarts === 0 &&
    report.correctness?.reopenCorrect === true &&
    report.correctness.successfulCycles === 20 &&
    report.correctness.sampleChecksum === PROJECT_SAMPLE_CHECKSUM &&
    cycles.length === 20 &&
    cycles.every(
      (cycle, index) =>
        cycle.cycle === index + 1 &&
        cycle.pid === pid &&
        typeof cycle.retainedTokens === 'number' &&
        cycle.retainedTokens >= 0 &&
        typeof cycle.retainedTokenBytes === 'number' &&
        cycle.retainedTokenBytes === cycle.retainedTokens * RETAINED_BYTES_PER_CYCLE &&
        finitePositive(cycle.transientLiveTokens) &&
        finitePositive(cycle.transientLiveTokenBytes) &&
        finitePositive(cycle.transientHeapUsedBytes) &&
        typeof cycle.transientExternalBytes === 'number' &&
        finitePositive(cycle.transientRssBytes) &&
        finitePositive(cycle.settledHeapUsedBytes) &&
        typeof cycle.settledExternalBytes === 'number' &&
        finitePositive(cycle.settledRssBytes),
    ) &&
    checkpoints.length === 3 &&
    checkpoints.map((checkpoint) => checkpoint.cycle).join(',') === '1,10,20',
  );
}

function monotonic(values: number[]): boolean {
  return values.every((value, index) => index === 0 || value >= values[index - 1]!);
}

function retentionSummary(report: RetentionRuntimeReport): {
  retainedAtCheckpoints: number[];
  retainedBytesAtCheckpoints: number[];
  finalRetainedTokens: number;
  finalRetainedTokenBytes: number;
  maxRetainedTokens: number;
  maxRetainedTokenBytes: number;
  rssGrowthBytes: number;
  transientAboveSettledBytes: number;
} {
  const checkpoints = report.checkpoints!;
  const cycles = report.cycles!;
  const retainedBytes = cycles.map((item) => item.retainedTokenBytes!);
  return {
    retainedAtCheckpoints: checkpoints.map((item) => item.retainedTokens!),
    retainedBytesAtCheckpoints: checkpoints.map((item) => item.retainedTokenBytes!),
    finalRetainedTokens: cycles.at(-1)!.retainedTokens!,
    finalRetainedTokenBytes: cycles.at(-1)!.retainedTokenBytes!,
    maxRetainedTokens: Math.max(...cycles.map((item) => item.retainedTokens!)),
    maxRetainedTokenBytes: Math.max(...retainedBytes),
    rssGrowthBytes: report.finalMemory!.rss! - report.initialMemory!.rss!,
    transientAboveSettledBytes: median(
      cycles.map((item) => item.transientRssBytes! - item.settledRssBytes!),
    ),
  };
}

async function scoreRetention(root: string): Promise<SkillEvalDeterministicScore> {
  if (!fixedFilesIntact(root, RETENTION_FIXED_FILES)) {
    return fail(
      'Fixed 50 MB project manifest, regressed reference, or retention evaluator runner changed.',
      true,
    );
  }
  let candidateSource: string;
  try {
    candidateSource = readFixtureText(root, 'src/lifecycle.ts');
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error), true);
  }

  const before = runRetentionSource(PERFORMANCE_DEBUGGING_RETENTION_INITIAL_SOURCE);
  const after =
    candidateSource === PERFORMANCE_DEBUGGING_RETENTION_INITIAL_SOURCE
      ? before
      : runRetentionSource(candidateSource);
  const failedRun = [before, after].find((run) => !run.report);
  if (failedRun) return fail(failedRun.evidence, failedRun.integrityFailure);
  if (!fixedFilesIntact(root, RETENTION_FIXED_FILES)) {
    return fail('Evaluator-owned retention inputs changed during scoring.', true);
  }

  const beforeReport = before.report!;
  const afterReport = after.report!;
  const protocol = [beforeReport, afterReport].every(retentionProtocolValid);
  if (!protocol)
    return fail(
      'A local retention run omitted the fixed single-process 20-cycle checkpoints, retained-state evidence, or reopen oracle.',
    );
  const beforeSummary = retentionSummary(beforeReport);
  const afterSummary = retentionSummary(afterReport);
  const beforeCycleCounts = beforeReport.cycles!.map((item) => item.retainedTokens!);
  const leakReproduced =
    monotonic(beforeCycleCounts) &&
    beforeSummary.retainedAtCheckpoints[0] === 1 &&
    beforeSummary.retainedAtCheckpoints[1] === 10 &&
    beforeSummary.retainedAtCheckpoints[2] === 20 &&
    beforeSummary.retainedBytesAtCheckpoints[2] === RETAINED_BYTES_PER_CYCLE * 20 &&
    beforeSummary.rssGrowthBytes >= RETAINED_BYTES_PER_CYCLE * 8;
  const retentionPath =
    beforeSummary.finalRetainedTokens === 20 &&
    afterSummary.finalRetainedTokens <= 1 &&
    beforeSummary.finalRetainedTokenBytes - afterSummary.finalRetainedTokenBytes >=
      RETAINED_BYTES_PER_CYCLE * 18;
  const boundedAfter =
    afterSummary.maxRetainedTokens <= 1 &&
    afterSummary.maxRetainedTokenBytes <= RETAINED_BYTES_PER_CYCLE &&
    afterSummary.rssGrowthBytes < RETAINED_BYTES_PER_CYCLE * 3 &&
    afterReport.protocol!.gcCheckpoints === 20 &&
    afterReport.protocol!.processRestarts === 0;
  const transientDistinguished = beforeReport.cycles!.every(
    (item) =>
      item.transientLiveTokens! >= item.retainedTokens! &&
      item.transientLiveTokenBytes! >= item.retainedTokenBytes! &&
      item.transientLiveTokenBytes! >= RETAINED_BYTES_PER_CYCLE,
  );
  const reopenCorrect =
    beforeReport.correctness?.reopenCorrect === true &&
    afterReport.correctness?.reopenCorrect === true;
  const sourceChanged =
    sha256(candidateSource) !== sha256(PERFORMANCE_DEBUGGING_RETENTION_INITIAL_SOURCE);
  const checks = [
    ['same real 50 MB project over one-process 20-cycle protocol', protocol],
    ['starting retained-token and memory growth reproduced', leakReproduced],
    ['retained ownership path is released after close', retentionPath],
    ['post-fix retained state reaches a bounded steady state', boundedAfter],
    ['transient allocation is recorded separately from settled retention', transientDistinguished],
    ['all 20 project reopen oracles remain green', reopenCorrect],
    ['candidate implementation differs from the regressed start', sourceChanged],
  ] as const;
  const passed = checks.every(([, ok]) => ok);
  const aggregate = {
    schemaVersion: 1,
    scenarioId: RETENTION_SCENARIO,
    evidenceKind: 'evaluator-owned-before-after-local-runtime',
    integrity: {
      fixedInputsVerified: true,
      receiptsVerified: true,
      manifestFingerprint: sha256(PROJECT_MANIFEST),
      candidateSourceFingerprint: sha256(candidateSource),
    },
    protocol: {
      boundedChildTimeoutMs: LOCAL_RUN_TIMEOUT_MS,
      projectBytes: PROJECT_BYTES,
      retainedBytesPerCycle: RETAINED_BYTES_PER_CYCLE,
      cycles: 20,
      checkpoints: [1, 10, 20],
      oneProcessPerRun: true,
      evaluatorGcCheckpoints: 20,
    },
    before: { summary: beforeSummary, raw: beforeReport },
    after: { summary: afterSummary, raw: afterReport },
    checks: Object.fromEntries(checks),
  };
  try {
    writeFixtureFile(root, RETENTION_REPORT, `${JSON.stringify(aggregate, null, 2)}\n`);
  } catch (error) {
    return fail(
      `Unable to persist evaluator-owned retention report: ${error instanceof Error ? error.message : String(error)}`,
      true,
    );
  }
  return {
    passed,
    quality: checks.filter(([, ok]) => ok).length / checks.length,
    verification: passed ? 1 : 0,
    integrityFailure: false,
    evidence: [
      RETENTION_REPORT,
      before.evidence,
      after.evidence,
      ...checks.map(([name, ok]) => `${name}: ${ok ? 'pass' : 'fail'}`),
      `retained tokens at cycles 1/10/20 before: ${beforeSummary.retainedAtCheckpoints.join('/')}`,
      `retained tokens at cycles 1/10/20 after: ${afterSummary.retainedAtCheckpoints.join('/')}`,
      `retained ownership MiB at cycle 20 before/after: ${(beforeSummary.finalRetainedTokenBytes / 1024 / 1024).toFixed(1)} / ${(afterSummary.finalRetainedTokenBytes / 1024 / 1024).toFixed(1)}`,
      `process rss growth MiB before/after: ${(beforeSummary.rssGrowthBytes / 1024 / 1024).toFixed(1)} / ${(afterSummary.rssGrowthBytes / 1024 / 1024).toFixed(1)}`,
    ],
  };
}

const httpMaterializer: SkillEvalFixtureMaterializer = {
  id: 'performance-debugging/http-p95-regression@1',
  realRuntime: true,
  matches: (scenario) => scenario.id === HTTP_SCENARIO,
  materialize: (destination) => {
    for (const [path, content] of Object.entries(HTTP_FIXED_FILES)) {
      writeFixtureFile(destination, path, content);
    }
    writeFixtureFile(destination, 'src/service.ts', PERFORMANCE_DEBUGGING_HTTP_INITIAL_SOURCE);
    writeFixtureFile(
      destination,
      'README.md',
      '# HTTP p95 regression\n\nFix the regression in `src/service.ts`. The evaluator owns the 20k-record dataset, response oracle, base/regressed references, 400 requests/s schedule, discarded warmup, five measured repetitions, resource accounting, and handler-path profile. It runs base, the original regression, and your candidate in bounded local loopback HTTP processes. Do not edit `reference/`, `workload/`, or `harness/`; candidate-authored benchmark claims are not accepted.\n',
    );
  },
};

const retentionMaterializer: SkillEvalFixtureMaterializer = {
  id: 'performance-debugging/project-open-close-retention@1',
  realRuntime: true,
  matches: (scenario) => scenario.id === RETENTION_SCENARIO,
  materialize: (destination) => {
    for (const [path, content] of Object.entries(RETENTION_FIXED_FILES)) {
      writeFixtureFile(destination, path, content);
    }
    writeFixtureFile(
      destination,
      'src/lifecycle.ts',
      PERFORMANCE_DEBUGGING_RETENTION_INITIAL_SOURCE,
    );
    writeFixtureFile(
      destination,
      'README.md',
      '# Project open/close retention\n\nFix the lifecycle ownership bug in `src/lifecycle.ts`. The evaluator creates one real 50 MB project and evaluator-owned 18 MB retention tokens, runs 20 open/close cycles in one bounded local process, performs exactly one settle/GC checkpoint per close, and records transient versus settled memory plus live-token evidence at cycles 1, 10, and 20. Preserve reopen semantics. Do not edit `reference/`, `workload/`, or `harness/`; candidate-authored memory claims are not accepted.\n',
    );
  },
};

export const PERFORMANCE_DEBUGGING_SKILL_EVAL_MATERIALIZERS: readonly SkillEvalFixtureMaterializer[] =
  [httpMaterializer, retentionMaterializer];

export const PERFORMANCE_DEBUGGING_SKILL_EVAL_SCORERS: readonly SkillEvalDeterministicScorer[] = [
  {
    id: 'performance-debugging/http-p95-regression-scorer@1',
    scenarioIds: [HTTP_SCENARIO],
    score: ({ workingDirectory }) => scoreHttpRegression(workingDirectory),
  },
  {
    id: 'performance-debugging/project-open-close-retention-scorer@1',
    scenarioIds: [RETENTION_SCENARIO],
    score: ({ workingDirectory }) => scoreRetention(workingDirectory),
  },
];
