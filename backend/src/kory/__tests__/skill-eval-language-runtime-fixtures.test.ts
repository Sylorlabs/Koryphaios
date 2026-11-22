import { afterEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildSkillEvalSuiteV3 } from '../../eval/skills/skill-eval-harness';
import { writeFixtureFile } from '../../eval/skills/skill-eval-fixture-helpers';
import {
  LANGUAGE_RUNTIME_SKILL_EVAL_MATERIALIZERS,
  LANGUAGE_RUNTIME_SKILL_EVAL_SCORERS,
} from '../../eval/skills/skill-eval-language-runtime-fixtures';
import { loadV5SkillPackages } from '../skill-packages';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function pythonFixture(scenarioId: string) {
  const skill = loadV5SkillPackages().packages.find(
    (item) => item.sidecar.name === 'python-engineering',
  )!;
  const scenario = buildSkillEvalSuiteV3(skill).scenarios.find((item) => item.id === scenarioId)!;
  const root = mkdtempSync(join(tmpdir(), 'kory-python-runtime-'));
  roots.push(root);
  const materializer = LANGUAGE_RUNTIME_SKILL_EVAL_MATERIALIZERS.find((item) =>
    item.matches(scenario),
  )!;
  const scorer = LANGUAGE_RUNTIME_SKILL_EVAL_SCORERS.find((item) =>
    item.scenarioIds.includes(scenario.id),
  )!;
  await materializer.materialize(root, scenario);
  return {
    root,
    scorer,
    input: {
      scenario,
      experiment: {} as never,
      workingDirectory: root,
      observation: { output: '', evidence: [], artifacts: [], durationMs: 0 },
    },
  };
}

async function nodeFixture(scenarioId: string) {
  const skill = loadV5SkillPackages().packages.find(
    (item) => item.sidecar.name === 'nodejs-runtime',
  )!;
  const scenario = buildSkillEvalSuiteV3(skill).scenarios.find((item) => item.id === scenarioId)!;
  const root = mkdtempSync(join(tmpdir(), 'kory-node-runtime-'));
  roots.push(root);
  const materializer = LANGUAGE_RUNTIME_SKILL_EVAL_MATERIALIZERS.find((item) =>
    item.matches(scenario),
  )!;
  const scorer = LANGUAGE_RUNTIME_SKILL_EVAL_SCORERS.find((item) =>
    item.scenarioIds.includes(scenario.id),
  )!;
  await materializer.materialize(root, scenario);
  return {
    root,
    materializer,
    scorer,
    input: {
      scenario,
      experiment: {} as never,
      workingDirectory: root,
      observation: { output: '', evidence: [], artifacts: [], durationMs: 0 },
    },
  };
}

const nodeStreamFixture = () => nodeFixture('nodejs-runtime-full-task-2-individual');
const nodeReloadFixture = () => nodeFixture('nodejs-runtime-full-task-1-individual');

/** Receipts are taken from the evaluator's executed Node process, never from the candidate report. */
function nativeReceipt(evidence: string[], marker: string): Record<string, unknown> {
  const matched = evidence.join('\n').match(new RegExp(`${marker}=(\\{[^\\r\\n]+\\})`, 'u'));
  expect(matched).toBeTruthy();
  return JSON.parse(matched![1]!) as Record<string, unknown>;
}

const FIXED_NODE_RELOAD = `export interface Config { version: number; routes: string[] }
export type Offload = (raw: string, signal: AbortSignal) => Promise<Config>;
export class ConfigStore {
  private current: Config = { version: 1, routes: ['/health'] };
  private generation = 0;
  read(): Config { return structuredClone(this.current); }
  async reload(raw: string, offload: Offload, signal: AbortSignal): Promise<void> {
    if (signal.aborted) throw signal.reason;
    const generation = ++this.generation;
    const config = await offload(raw, signal);
    if (signal.aborted) throw signal.reason;
    if (generation === this.generation) this.current = structuredClone(config);
  }
}
`;

const NODE_RELOAD_REGRESSIONS = `import {expect,test} from 'bun:test';
import {ConfigStore} from '../src/config-store';
test('old snapshot is readable until asynchronous worker completes, and cannot be mutated', async () => {
  const store = new ConfigStore();
  let finish!: (value: {version: number; routes: string[]}) => void;
  const pending = store.reload('{"version":2}', () => new Promise(resolve => {finish = resolve;}), new AbortController().signal);
  expect(store.read().version).toBe(1);
  finish({version:2,routes:['/v2']});
  await pending;
  const value = store.read(); value.routes.push('/bad');
  expect(store.read().routes).toEqual(['/v2']);
});
test('abort and malformed offload keep the last good configuration', async () => {
  const store = new ConfigStore();
  await expect(store.reload('bad', async () => {throw new Error('malformed')}, new AbortController().signal)).rejects.toThrow('malformed');
  const caller = new AbortController(); caller.abort(new Error('cancelled'));
  await expect(store.reload('{}', async () => ({version:9,routes:[]}), caller.signal)).rejects.toThrow('cancelled');
  expect(store.read().version).toBe(1);
});
test('concurrent newest wins when older worker completes after newer', async () => {
  const store = new ConfigStore();
  let finishOlder!: (value: {version:number;routes:string[]}) => void;
  const older = store.reload('old', () => new Promise(resolve => {finishOlder=resolve}), new AbortController().signal);
  await store.reload('new', async () => ({version:7,routes:['/new']}), new AbortController().signal);
  finishOlder({version:6,routes:['/old']});
  await older;
  expect(store.read().version).toBe(7);
});
`;

const FIXED_NODE_STREAM = `import { Readable, Transform, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

export function csvTransform(): Transform {
  return new Transform({ objectMode: true, transform(row, _encoding, cb) {
    if (row?.fail) return cb(new Error('transform-error'));
    cb(null, String(row?.value ?? row) + '\\n');
  } });
}

export async function exportCsv(source: Readable, destination: Writable, signal: AbortSignal): Promise<void> {
  await pipeline(source, csvTransform(), destination, { signal });
}
`;

const NODE_STREAM_REGRESSIONS = `import { expect, test } from 'bun:test';
import { Readable, Writable } from 'node:stream';
import { exportCsv } from '../src/export';

class Rows extends Readable {
  reads = 0;
  constructor(readonly total: number) { super({ objectMode: true, highWaterMark: 2 }); }
  _read() { this.reads++; this.push(this.reads <= this.total ? { value: 'row' + this.reads } : null); }
}

test('slow client observes bounded backpressure and drains all rows', async () => {
  const source = new Rows(120);
  const controller = new AbortController();
  let writeCount = 0;
  let resume: (() => void) | undefined;
  let started!: () => void;
  const firstWrite = new Promise<void>(resolve => { started = resolve; });
  const chunks: string[] = [];
  const dest = new Writable({ highWaterMark: 1, write(chunk, _enc, cb) {
    writeCount++;
    chunks.push(chunk.toString());
    if (writeCount === 1) { resume = cb; started(); } else cb();
  } });
  const pending = exportCsv(source, dest, controller.signal);
  await firstWrite;
  await Bun.sleep(30);
  const readsWhileBlocked = source.reads;
  const peakBufferedRows = readsWhileBlocked - writeCount;
  const peakBufferedBytes = dest.writableLength;
  resume!();
  await pending;
  expect(readsWhileBlocked).toBeLessThan(40);
  expect(chunks.join('')).toBe(Array.from({length: 120}, (_, i) => 'row' + (i + 1) + '\\n').join(''));
  expect(dest.writableFinished).toBe(true);
  console.log('KORY_PRESSURE=' + JSON.stringify({totalRows: 120, readsWhileBlocked, peakBufferedRows, peakBufferedBytes}));
});

test('abort disconnect stops source reads and destroys both endpoints', async () => {
  const source = new Rows(120);
  const controller = new AbortController();
  let started!: () => void;
  const firstWrite = new Promise<void>(resolve => { started = resolve; });
  const dest = new Writable({ highWaterMark: 1, write(_chunk, _enc, cb) {
    started();
    queueMicrotask(cb);
  } });
  const pending = exportCsv(source, dest, controller.signal);
  await firstWrite;
  const readsAtAbort = source.reads;
  controller.abort(new Error('disconnect'));
  await expect(pending).rejects.toThrow(/abort|disconnect/i);
  await Bun.sleep(0);
  const readsAfterAbort = source.reads - readsAtAbort;
  expect(readsAfterAbort).toBe(0);
  expect(source.destroyed).toBe(true);
  expect(dest.destroyed).toBe(true);
  console.log('KORY_ABORT=' + JSON.stringify({readsAtAbort, readsAfterAbort, sourceDestroyed: source.destroyed, destinationDestroyed: dest.destroyed}));
});

test('destination close propagates a disconnect', async () => {
  const source = new Rows(20);
  const dest = new Writable({ write(_c, _e, cb) { dest.destroy(); cb(); } });
  await expect(exportCsv(source, dest, new AbortController().signal)).rejects.toThrow();
  expect(source.destroyed).toBe(true);
});

test('transform error rejects and tears down the pipeline', async () => {
  await expect(exportCsv(Readable.from([{fail: true}]), new Writable({write(_c, _e, cb) { cb(); }}), new AbortController().signal)).rejects.toThrow('transform-error');
});

test('database source error propagates', async () => {
  const source = Readable.from((async function*() {yield {value:'ok'};throw new Error('database-error');})());
  await expect(exportCsv(source, new Writable({write(_c, _e, cb) { cb(); }}), new AbortController().signal)).rejects.toThrow('database-error');
});

test('destination write errors propagate', async () => {
  const source = Readable.from([{value:'ok'}]);
  await expect(exportCsv(source, new Writable({write(_c, _e, cb) { cb(new Error('destination-error')); }}), new AbortController().signal)).rejects.toThrow('destination-error');
});

test('empty result completes with clean shutdown', async () => {
  let pendingWrites = 0;
  let text = '';
  const dest = new Writable({ write(chunk, _enc, cb) { pendingWrites++; text += chunk.toString(); pendingWrites--; cb(); } });
  await exportCsv(Readable.from([]), dest, new AbortController().signal);
  expect(text).toBe('');
  expect(dest.writableFinished).toBe(true);
  expect(pendingWrites).toBe(0);
  console.log('KORY_SHUTDOWN=' + JSON.stringify({cleanFinish: dest.writableFinished, pendingWrites}));
});
`;

describe('language runtime skill fixtures', () => {
  test('Node.js reload scorer independently observes real Worker CPU, latency, abort, race and shutdown', async () => {
    const { root, scorer, input } = await nodeReloadFixture();
    expect(scorer.id).toEndWith('@1');
    const instructions = readFileSync(join(root, 'README.md'), 'utf8');
    expect(instructions).toContain('worker_threads Worker');
    expect(instructions).toContain('event-loop timer gaps');

    const starter = await scorer.score(input);
    expect(starter.passed).toBe(false);
    expect(starter.verification).toBe(0);

    writeFixtureFile(root, 'src/config-store.ts', FIXED_NODE_RELOAD);
    writeFixtureFile(root, 'tests/config-store.test.ts', NODE_RELOAD_REGRESSIONS);
    const executed = spawnSync(process.execPath, ['test', 'tests/config-store.test.ts'], {
      cwd: root,
      encoding: 'utf8',
      timeout: 15_000,
      maxBuffer: 1_000_000,
    });
    expect(executed.status).toBe(0);
    expect(`${executed.stdout}\n${executed.stderr}`).toContain('3 pass');

    const missing = await scorer.score(input);
    expect(missing.passed).toBe(false);
    expect(missing.quality).toBe(0.85);
    expect(missing.verification).toBe(1);
    expect(missing.evidence).toContain('native Node Worker/latency/race/shutdown: pass');
    const observed = nativeReceipt(missing.evidence, 'KORY_NODE_RELOAD_PROBE');
    const runtime = observed.runtime as { nodeVersion: string; moduleMode: string };
    const worker = observed.worker as Record<string, unknown>;
    const loop = observed.eventLoop as Record<string, unknown>;
    const race = observed.race as Record<string, unknown>;
    expect(worker).toMatchObject({ method: 'observed', liveAfterShutdown: 0, aborted: 1 });
    expect(Number(worker.created)).toBeGreaterThanOrEqual(6);
    expect(worker.created).toBe(worker.exited);
    expect(Number(worker.distinctThreads)).toBeGreaterThanOrEqual(2);
    expect(Number(worker.cpuMs)).toBeGreaterThan(150);
    expect(Number(loop.ticks)).toBeGreaterThanOrEqual(12);
    expect(Number(loop.maxGapMs)).toBeLessThan(90);
    expect(race).toMatchObject({ winner: 21, staleIgnored: true });
    const report = {
      runtime,
      measurements: {
        worker: { ...worker, method: 'measured' },
        eventLoop: { ...loop, method: 'measured' },
      },
      hierarchy: { broader: 'backend-engineering', neighbor: 'bun-deno-runtime' },
    };
    writeFixtureFile(root, '.kory-eval/node-reload.json', JSON.stringify(report));
    const passing = await scorer.score(input);
    if (!passing.passed) {
      throw new Error(`Native Node reload verification unexpectedly failed:\n${passing.evidence.join('\n')}`);
    }
    expect(passing.passed).toBe(true);
    expect(passing.quality).toBe(1);
    expect(passing.verification).toBe(1);

    // Identical candidate behavior cannot authenticate invented Worker counters.
    writeFixtureFile(
      root,
      '.kory-eval/node-reload.json',
      JSON.stringify({
        ...report,
        measurements: {
          ...report.measurements,
          worker: { ...report.measurements.worker, cpuMs: 999_999 },
        },
      }),
    );
    const inventedCpu = await scorer.score(input);
    expect(inventedCpu.passed).toBe(false);
    expect(inventedCpu.verification).toBe(1);

    writeFixtureFile(
      root,
      '.kory-eval/node-reload.json',
      JSON.stringify({
        ...report,
        measurements: {
          ...report.measurements,
          worker: { ...report.measurements.worker, method: 'synthetic' },
        },
      }),
    );
    const fakeMeasurement = await scorer.score(input);
    expect(fakeMeasurement.passed).toBe(false);

    writeFixtureFile(
      root,
      '.kory-eval/node-reload.json',
      JSON.stringify({
        ...report,
        runtime: { ...report.runtime, nodeVersion: 'v0.0.0' },
      }),
    );
    const claimedVersion = await scorer.score(input);
    expect(claimedVersion.passed).toBe(false);

    writeFixtureFile(root, '.kory-eval/node-reload.json', JSON.stringify(report));
    // A forged report cannot hide synchronous CPU work on the main event loop.
    writeFixtureFile(
      root,
      'src/config-store.ts',
      FIXED_NODE_RELOAD.replace(
        'const config = await offload(raw, signal);',
        'const start = performance.now(); while (performance.now() - start < 220) {} const config = await offload(raw, signal);',
      ),
    );
    const blockedEventLoop = await scorer.score(input);
    expect(blockedEventLoop.passed).toBe(false);
    expect(blockedEventLoop.verification).toBe(0);
    expect(blockedEventLoop.evidence).toContain('native Node Worker/latency/race/shutdown: fail');

    // Awaiting real offload work is insufficient if a stale result overwrites the winner.
    writeFixtureFile(
      root,
      'src/config-store.ts',
      FIXED_NODE_RELOAD.replace(
        'if (generation === this.generation) this.current = structuredClone(config);',
        'this.current = structuredClone(config);',
      ),
    );
    const staleWins = await scorer.score(input);
    expect(staleWins.passed).toBe(false);
    expect(staleWins.verification).toBe(0);
    expect(staleWins.evidence).toContain('native Node Worker/latency/race/shutdown: fail');
  }, 90_000);

  test('Node.js stream scorer accepts a truthful unavailable HTTP report when the candidate sandbox denies loopback listen', async () => {
    const { root, scorer, input } = await nodeStreamFixture();
    writeFixtureFile(root, 'src/export.ts', FIXED_NODE_STREAM);
    writeFixtureFile(root, 'tests/export.test.ts', NODE_STREAM_REGRESSIONS);
    const nodeVersion = spawnSync('node', ['--version'], { encoding: 'utf8' }).stdout.trim();

    // The candidate turn runs under an executor sandbox that refuses loopback listen().
    writeFixtureFile(
      root,
      '.kory-eval/node-stream-probe.log',
      `Native Node verification: ${nodeVersion} scripts/verify-runtime.mjs\nError: listen EPERM: operation not permitted 127.0.0.1\n`,
    );
    const unavailableReport = (backpressure: Record<string, unknown>) => ({
      runtime: { nodeVersion, moduleMode: 'esm' },
      measurements: {
        backpressure,
        abort: { transport: 'http', method: 'unavailable' },
        cancellation: { transport: 'http', method: 'unavailable' },
        shutdown: { transport: 'http', method: 'unavailable' },
      },
      verification: {
        command: 'bun test tests/export.test.ts',
        cases: {
          slowClient: 'unavailable',
          disconnect: 'unavailable',
          serverCancellation: 'unavailable',
          transformError: 'pass',
          databaseError: 'pass',
          destinationError: 'pass',
          empty: 'pass',
          shutdown: 'pass',
        },
      },
      hierarchy: { broader: 'backend-engineering', neighbor: 'compiler-runtime-backend' },
    });

    // An honest unavailable report is accepted, and the evaluator's own probe supplies HTTP evidence.
    writeFixtureFile(
      root,
      '.kory-eval/node-stream.json',
      JSON.stringify(unavailableReport({ transport: 'http', method: 'unavailable' })),
    );
    const honest = await scorer.score(input);
    expect(honest.passed, honest.evidence.join('\n')).toBe(true);
    expect(honest.evidence).toContain('measured runtime evidence: bounded');
    expect(honest.evidence).toContain('native Node HTTP backpressure/disconnect/errors: pass');

    // Fabricated HTTP counters are still rejected even when the denial is recorded.
    writeFixtureFile(
      root,
      '.kory-eval/node-stream.json',
      JSON.stringify(
        unavailableReport({ transport: 'http', method: 'measured', readsWhilePaused: 7 }),
      ),
    );
    const fabricated = await scorer.score(input);
    expect(fabricated.passed).toBe(false);
    expect(fabricated.verification).toBe(1);

    // Without the recorded denial the measured-report gate applies again.
    writeFixtureFile(root, '.kory-eval/node-stream-probe.log', 'native probe did not run\n');
    writeFixtureFile(
      root,
      '.kory-eval/node-stream.json',
      JSON.stringify(unavailableReport({ transport: 'http', method: 'unavailable' })),
    );
    const noDenial = await scorer.score(input);
    expect(noDenial.passed).toBe(false);
    expect(noDenial.evidence).toContain('measured runtime evidence: missing or invalid');
  }, 90_000);

  test('Node.js stream scorer requires measured evidence as well as native bounded flow and abort', async () => {
    const { root, materializer, scorer, input } = await nodeStreamFixture();
    expect(materializer.id).toEndWith('@4');
    expect(scorer.id).toEndWith('@4');
    expect(readFileSync(join(root, 'README.md'), 'utf8')).toContain('readsWhilePaused');
    expect(readFileSync(join(root, 'README.md'), 'utf8')).toContain('HTTP client');
    expect(readFileSync(join(root, 'README.md'), 'utf8')).toContain('node --version');
    const starter = await scorer.score(input);
    expect(starter.passed).toBe(false);
    expect(starter.verification).toBe(0);

    writeFixtureFile(root, 'src/export.ts', FIXED_NODE_STREAM);
    writeFixtureFile(root, 'tests/export.test.ts', NODE_STREAM_REGRESSIONS);

    // The report is written from counters emitted by actually executed tests.
    const executed = spawnSync(process.execPath, ['test', 'tests/export.test.ts'], {
      cwd: root,
      encoding: 'utf8',
      timeout: 15_000,
      maxBuffer: 1_000_000,
    });
    const output = `${executed.stdout ?? ''}\n${executed.stderr ?? ''}`;
    expect(executed.status).toBe(0);
    expect(output).toContain('7 pass');
    const nodeVersion = spawnSync('node', ['--version'], { encoding: 'utf8' });
    expect(nodeVersion.status).toBe(0);

    const missing = await scorer.score(input);
    expect(missing.passed).toBe(false);
    expect(missing.quality).toBe(0.85);
    expect(missing.verification).toBe(1);
    expect(missing.evidence).toContain('measured runtime evidence: missing or invalid');
    expect(missing.evidence).toContain('native Node HTTP backpressure/disconnect/errors: pass');
    const observed = nativeReceipt(missing.evidence, 'KORY_NODE_HTTP_PROBE');
    const runtime = observed.runtime as { nodeVersion: string; moduleMode: string };
    expect(runtime.nodeVersion).toBe(nodeVersion.stdout.trim());
    const pressure = observed.backpressure as Record<string, unknown>;
    const abort = observed.abort as Record<string, unknown>;
    const cancellation = observed.cancellation as Record<string, unknown>;
    const shutdown = observed.shutdown as Record<string, unknown>;
    expect(pressure).toMatchObject({ transport: 'http', clientPaused: true, totalRows: 640 });
    expect(abort).toMatchObject({ transport: 'http', socketClosed: true, signalAborted: true });
    expect(cancellation).toMatchObject({
      transport: 'http',
      abortedWithOpenSocket: true,
      signalAborted: true,
      readsAfterCancellation: 0,
      sourceDestroyed: true,
      destinationDestroyed: true,
    });
    expect(shutdown).toMatchObject({ openConnections: 0, activePipelines: 0 });
    const report = {
      runtime,
      measurements: {
        backpressure: { ...pressure, method: 'measured' },
        abort: { ...abort, method: 'measured' },
        cancellation: { ...cancellation, method: 'measured' },
        shutdown: { ...shutdown, method: 'measured' },
      },
      verification: {
        command: 'bun test tests/export.test.ts && node probe.mjs',
        cases: {
          slowClient: 'pass',
          disconnect: 'pass',
          serverCancellation: 'pass',
          transformError: 'pass',
          databaseError: 'pass',
          destinationError: 'pass',
          empty: 'pass',
          shutdown: 'pass',
        },
      },
      hierarchy: { broader: 'backend-engineering', neighbor: 'compiler-runtime-backend' },
    };

    writeFixtureFile(root, '.kory-eval/node-stream.json', JSON.stringify(report));
    const passing = await scorer.score(input);
    expect(
      passing.passed,
      JSON.stringify({
        claimed: report.measurements,
        native:
          passing.evidence.find((item) => item.includes('KORY_NODE_HTTP_PROBE=')) ?? 'missing',
        checks: passing.evidence.slice(0, 4),
      }),
    ).toBe(true);
    expect(passing.quality).toBe(1);
    expect(passing.verification).toBe(1);
    expect(passing.evidence).toContain('measured runtime evidence: bounded');

    // A claimed Node version must agree with the runtime that executed the oracle.
    writeFixtureFile(
      root,
      '.kory-eval/node-stream.json',
      JSON.stringify({
        ...report,
        runtime: { ...report.runtime, nodeVersion: 'v0.0.0' },
      }),
    );
    const falseVersion = await scorer.score(input);
    expect(falseVersion.passed).toBe(false);
    expect(falseVersion.verification).toBe(1);

    // Keywords and unmeasured placeholders cannot satisfy explicit runtime evidence.
    writeFixtureFile(
      root,
      '.kory-eval/node-stream.json',
      JSON.stringify({
        ...report,
        measurements: {
          ...report.measurements,
          backpressure: {
            ...report.measurements.backpressure,
            method: 'unavailable',
            bufferedBytes: '<observed>',
          },
        },
      }),
    );
    const unmeasured = await scorer.score(input);
    expect(unmeasured.passed).toBe(false);
    expect(unmeasured.quality).toBe(0.85);
    expect(unmeasured.verification).toBe(1);

    // A truthful-looking report with invented HTTP counters must not qualify.
    writeFixtureFile(
      root,
      '.kory-eval/node-stream.json',
      JSON.stringify({
        ...report,
        measurements: {
          ...report.measurements,
          backpressure: { ...report.measurements.backpressure, readsWhilePaused: 1_000_000 },
        },
      }),
    );
    const inventedReads = await scorer.score(input);
    expect(inventedReads.passed).toBe(false);
    expect(inventedReads.verification).toBe(1);
    expect(inventedReads.evidence.join('\n')).toMatch(
      /HTTP report rejected:.*readsWhilePaused \(claimed 1000000; observed \d+\)/u,
    );

    writeFixtureFile(
      root,
      '.kory-eval/node-stream.json',
      JSON.stringify({
        ...report,
        measurements: {
          ...report.measurements,
          backpressure: { ...report.measurements.backpressure, transport: 'memory' },
        },
      }),
    );
    const fakeTransport = await scorer.score(input);
    expect(fakeTransport.passed).toBe(false);
    expect(fakeTransport.verification).toBe(1);

    writeFixtureFile(
      root,
      '.kory-eval/node-stream.json',
      JSON.stringify({
        ...report,
        verification: {
          ...report.verification,
          cases: { ...report.verification.cases, disconnect: 'not-run' },
        },
      }),
    );
    const unrunDisconnect = await scorer.score(input);
    expect(unrunDisconnect.passed).toBe(false);
    expect(unrunDisconnect.verification).toBe(1);

    writeFixtureFile(
      root,
      '.kory-eval/node-stream.json',
      JSON.stringify({
        ...report,
        measurements: {
          ...report.measurements,
          cancellation: { ...report.measurements.cancellation, signalAborted: false },
        },
      }),
    );
    const inventedCancellation = await scorer.score(input);
    expect(inventedCancellation.passed).toBe(false);
    expect(inventedCancellation.verification).toBe(1);

    // Fabricated perfect-looking report cannot rescue a broken implementation.
    writeFixtureFile(root, '.kory-eval/node-stream.json', JSON.stringify(report));
    writeFixtureFile(
      root,
      'src/export.ts',
      `import { Readable, Writable, Transform } from 'node:stream';
export async function exportCsv(source: Readable, destination: Writable, signal: AbortSignal): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    source.on('data', row => { destination.write(String(row?.value ?? row) + '\\n'); });
    source.on('error', reject);
    source.on('end', () => { destination.end(); resolve(); });
    destination.on('error', reject);
    void signal;
  });
}
export function csvTransform(): Transform { return new Transform({objectMode: true}); }
`,
    );
    const noPressure = await scorer.score(input);
    expect(noPressure.passed).toBe(false);
    expect(noPressure.verification).toBe(0);
    expect(noPressure.evidence).toContain('native Node HTTP backpressure/disconnect/errors: fail');

    // A pipeline that disregards the AbortSignal must fail the live-socket
    // cancellation probe even though Node cleans up after ordinary disconnection.
    writeFixtureFile(
      root,
      'src/export.ts',
      FIXED_NODE_STREAM.replace(
        'pipeline(source, csvTransform(), destination, { signal })',
        'pipeline(source, csvTransform(), destination)',
      ),
    );
    const ignoredSignal = await scorer.score(input);
    expect(ignoredSignal.passed).toBe(false);
    expect(ignoredSignal.verification).toBe(0);
    expect(ignoredSignal.evidence).toContain(
      'native Node HTTP backpressure/disconnect/errors: fail',
    );
  }, 60_000);

  test('TypeScript webhook scorer observes the repository typecheck', async () => {
    const skill = loadV5SkillPackages().packages.find(
      (item) => item.sidecar.name === 'typescript-javascript-engineering',
    )!;
    const scenario = buildSkillEvalSuiteV3(skill).scenarios.find(
      (item) => item.id === 'typescript-javascript-engineering-full-task-1-individual',
    )!;
    const root = mkdtempSync(join(tmpdir(), 'kory-ts-runtime-green-'));
    roots.push(root);
    const materializer = LANGUAGE_RUNTIME_SKILL_EVAL_MATERIALIZERS.find((item) =>
      item.matches(scenario),
    )!;
    const scorer = LANGUAGE_RUNTIME_SKILL_EVAL_SCORERS.find((item) =>
      item.scenarioIds.includes(scenario.id),
    )!;
    await materializer.materialize(root, scenario);

    const validSource = `export type DomainEvent =
  | { type: 'created'; version: 1; payload: { id: string; amount: number } }
  | { type: 'deleted'; version: 1; payload: { id: string; hard: boolean } };
export type ParseResult =
  | { ok: true; event: DomainEvent }
  | { ok: false; error: 'INVALID_SHAPE' | 'MISSING_DISCRIMINATOR' | 'UNKNOWN_TYPE' | 'UNKNOWN_VERSION' };
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
export function parseWebhook(input: unknown): ParseResult {
  if (!isRecord(input)) return { ok: false, error: 'INVALID_SHAPE' };
  if (!Object.prototype.hasOwnProperty.call(input, 'type') || !Object.prototype.hasOwnProperty.call(input, 'version')) return { ok: false, error: 'MISSING_DISCRIMINATOR' };
  if (input.type !== 'created' && input.type !== 'deleted') return { ok: false, error: 'UNKNOWN_TYPE' };
  if (input.version !== 1) return { ok: false, error: 'UNKNOWN_VERSION' };
  if (!isRecord(input.payload) || typeof input.payload.id !== 'string') return { ok: false, error: 'INVALID_SHAPE' };
  if (input.type === 'created') {
    if (typeof input.payload.amount !== 'number' || !Number.isFinite(input.payload.amount)) return { ok: false, error: 'INVALID_SHAPE' };
    return { ok: true, event: { type: 'created', version: 1, payload: { id: input.payload.id, amount: input.payload.amount } } };
  }
  if (typeof input.payload.hard !== 'boolean') return { ok: false, error: 'INVALID_SHAPE' };
  return { ok: true, event: { type: 'deleted', version: 1, payload: { id: input.payload.id, hard: input.payload.hard } } };
}
export function handleEvent(event: DomainEvent): string {
  switch (event.type) {
    case 'created': return 'created:' + event.payload.id + ':' + event.payload.amount;
    case 'deleted': return 'deleted:' + event.payload.id + ':' + String(event.payload.hard);
    default: return assertNever(event);
  }
}
function assertNever(value: never): never { throw new Error('Unhandled event: ' + String(value)); }
`;
    writeFixtureFile(root, 'src/webhook.ts', validSource);
    writeFixtureFile(
      root,
      'tests/webhook.test.ts',
      `import { expect, test } from 'bun:test';
import { parseWebhook } from '../src/webhook';
test('unknown version and malformed nested amount are rejected', () => {
  expect(parseWebhook({ type: 'created', version: 2, payload: { id: 'a', amount: 1 } })).toEqual({ ok: false, error: 'UNKNOWN_VERSION' });
  expect(parseWebhook({ type: 'created', version: 1, payload: { id: 'a', amount: 'bad' } })).toEqual({ ok: false, error: 'INVALID_SHAPE' });
});
`,
    );
    writeFixtureFile(
      root,
      '.kory-eval/typescript-webhook.json',
      `${JSON.stringify(
        {
          boundary: { runtime: 'validated unknown input', static: 'strict discriminated union' },
          moduleRuntime: { runtime: 'Bun', module: 'ESNext' },
          hierarchy: { broader: 'implementation', adjacent: 'c-cpp-systems-engineering' },
          evidence: {
            typecheck: 'repository strict noEmit',
            runtime: 'negative and success tests',
          },
        },
        null,
        2,
      )}\n`,
    );
    const input = {
      scenario,
      experiment: {} as never,
      workingDirectory: root,
      observation: { output: '', evidence: [], artifacts: [], durationMs: 0 },
    };
    const green = await scorer.score(input);
    expect(scorer.id).toEndWith('@3');
    expect(green.passed).toBe(true);
    expect(green.verification).toBe(1);
    expect(green.evidence).toContain('repository typecheck: pass');
    expect(green.evidence).toContain('compile-time exhaustive guard: present');

    writeFixtureFile(
      root,
      'src/webhook.ts',
      `${validSource}\nconst typecheckOnlyFailure: string = 1;\n`,
    );
    const staticFailure = await scorer.score(input);
    expect(staticFailure.passed).toBe(false);
    expect(staticFailure.verification).toBe(0);
    expect(staticFailure.evidence).toContain('repository typecheck: fail');
  }, 30_000);

  test('webhook scorer rejects runtime validation without a compile-time exhaustive guard', async () => {
    const skill = loadV5SkillPackages().packages.find(
      (item) => item.sidecar.name === 'typescript-javascript-engineering',
    )!;
    const scenario = buildSkillEvalSuiteV3(skill).scenarios.find(
      (item) => item.id === 'typescript-javascript-engineering-full-task-1-individual',
    )!;
    const root = mkdtempSync(join(tmpdir(), 'kory-ts-webhook-exhaustive-'));
    roots.push(root);
    const materializer = LANGUAGE_RUNTIME_SKILL_EVAL_MATERIALIZERS.find((item) =>
      item.matches(scenario),
    )!;
    const scorer = LANGUAGE_RUNTIME_SKILL_EVAL_SCORERS.find((item) =>
      item.scenarioIds.includes(scenario.id),
    )!;
    await materializer.materialize(root, scenario);
    const source = readFileSync(join(root, 'src/webhook.ts'), 'utf8');
    writeFixtureFile(
      root,
      'src/webhook.ts',
      source
        .replace(
          /export function parseWebhook[\s\S]*?\n\}\n\nexport function handleEvent/u,
          `function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function parseWebhook(input: unknown): ParseResult {
  if (!isRecord(input)) return { ok: false, error: 'INVALID_SHAPE' };
  if (!Object.prototype.hasOwnProperty.call(input, 'type') || !Object.prototype.hasOwnProperty.call(input, 'version')) return { ok: false, error: 'MISSING_DISCRIMINATOR' };
  if (input.type !== 'created' && input.type !== 'deleted') return { ok: false, error: 'UNKNOWN_TYPE' };
  if (input.version !== 1) return { ok: false, error: 'UNKNOWN_VERSION' };
  if (!isRecord(input.payload) || typeof input.payload.id !== 'string') return { ok: false, error: 'INVALID_SHAPE' };
  if (input.type === 'created') {
    if (typeof input.payload.amount !== 'number' || !Number.isFinite(input.payload.amount)) return { ok: false, error: 'INVALID_SHAPE' };
    return { ok: true, event: { type: 'created', version: 1, payload: { id: input.payload.id, amount: input.payload.amount } } };
  }
  if (typeof input.payload.hard !== 'boolean') return { ok: false, error: 'INVALID_SHAPE' };
  return { ok: true, event: { type: 'deleted', version: 1, payload: { id: input.payload.id, hard: input.payload.hard } } };
}

export function handleEvent`,
        )
        .replace(
          '    default: return assertNever(event);',
          "    default: throw new Error('unreachable');",
        )
        .replace(
          "function assertNever(value: never): never {\n  throw new Error('Unhandled event: ' + String(value));\n}\n",
          '',
        ),
    );
    writeFixtureFile(
      root,
      '.kory-eval/typescript-webhook.json',
      JSON.stringify({
        boundary: { runtime: 'validated unknown input', static: 'strict discriminated union' },
        moduleRuntime: { runtime: 'Bun', module: 'ESNext' },
        hierarchy: { broader: 'implementation', adjacent: 'c-cpp-systems-engineering' },
        evidence: { typecheck: 'repository strict noEmit', runtime: 'negative and success tests' },
      }),
    );
    const result = await scorer.score({
      scenario,
      experiment: {} as never,
      workingDirectory: root,
      observation: { output: '', evidence: [], artifacts: [], durationMs: 0 },
    });
    expect(result.passed).toBe(false);
    expect(result.verification, result.evidence.join('\n')).toBe(1);
    expect(result.evidence).toContain('compile-time exhaustive guard: missing');
  }, 20_000);

  test('Python asyncio scorer observes cancellation after a child starts and timeout cleanup', async () => {
    const { root, scorer, input } = await pythonFixture(
      'python-engineering-full-task-1-individual',
    );
    expect(scorer.id).toEndWith('@2');
    const original = await scorer.score(input);
    expect(original.passed).toBe(false);
    expect(original.verification).toBe(0);

    writeFixtureFile(
      root,
      'src/fetcher.py',
      `import asyncio

async def fetch_all(urls, fetch_one, limit=3):
    if limit < 1:
        raise ValueError('invalid limit')
    results = [None] * len(urls)
    next_index = 0

    async def worker():
        nonlocal next_index
        while next_index < len(urls):
            index = next_index
            next_index += 1
            results[index] = await fetch_one(urls[index])

    workers = [asyncio.create_task(worker()) for _ in range(min(limit, len(urls)))]
    try:
        await asyncio.gather(*workers)
    finally:
        for task in workers:
            if not task.done():
                task.cancel()
        await asyncio.gather(*workers, return_exceptions=True)
    return results
`,
    );
    writeFixtureFile(
      root,
      'tests/test_fetcher.py',
      `import asyncio
import unittest
from src.fetcher import fetch_all

class T(unittest.IsolatedAsyncioTestCase):
    async def test_caller_cancellation(self):
        started = asyncio.Event()
        stopped = asyncio.Event()
        async def fetch(_):
            started.set()
            try:
                await asyncio.Event().wait()
            finally:
                stopped.set()
        task = asyncio.create_task(fetch_all(['a'], fetch))
        await started.wait()
        task.cancel()
        with self.assertRaises(asyncio.CancelledError):
            await task
        self.assertTrue(stopped.is_set())
`,
    );
    writeFixtureFile(
      root,
      '.kory-eval/python-async.json',
      JSON.stringify({
        python: { version: '3.9', interpreter: 'python3' },
        async_model: 'asyncio workers cancelled and awaited at the owner boundary',
        boundaries: { broader: 'implementation', neighbor: 'No C or C++ components present' },
      }),
    );

    const corrected = await scorer.score(input);
    expect(corrected.passed).toBe(true);
    expect(corrected.verification).toBe(1);
    expect(corrected.evidence).toContain('runtime/hierarchy evidence: bounded');

    // Passing runtime checks must not compensate for omitted hierarchy evidence.
    writeFixtureFile(
      root,
      '.kory-eval/python-async.json',
      JSON.stringify({ python: '3.9', async_model: 'asyncio', broader: 'implementation' }),
    );
    const missingBoundary = await scorer.score(input);
    expect(missingBoundary.passed).toBe(false);
    expect(missingBoundary.quality).toBe(0.85);
    expect(missingBoundary.evidence).toContain('runtime/hierarchy evidence: missing');
  });

  test('Python config scorer accepts equivalent typing/C# labels without waiving evidence gates', async () => {
    const { root, scorer, input } = await pythonFixture(
      'python-engineering-full-task-2-individual',
    );
    expect(scorer.id).toEndWith('@2');
    writeFixtureFile(
      root,
      'src/config.py',
      `from dataclasses import dataclass, field
from typing import Any, Optional

@dataclass
class Config:
    name: str
    endpoint: Optional[str] = None
    options: dict[str, Any] = field(default_factory=lambda: {'headers': {}, 'retries': []})

    @classmethod
    def from_json(cls, value):
        if not isinstance(value, dict) or set(value) - {'name', 'endpoint', 'options'}:
            raise ValueError('unexpected configuration keys or type')
        name = value.get('name', 'default')
        endpoint = value.get('endpoint')
        options = value.get('options', {})
        if not isinstance(name, str) or (endpoint is not None and not isinstance(endpoint, str)):
            raise ValueError('invalid fields')
        if not isinstance(options, dict) or set(options) - {'headers', 'retries'}:
            raise ValueError('unexpected option keys or type')
        headers, retries = options.get('headers', {}), options.get('retries', [])
        if not isinstance(headers, dict) or not isinstance(retries, list):
            raise ValueError('invalid option types')
        return cls(name, endpoint, {'headers': dict(headers), 'retries': list(retries)})

    def to_json(self):
        return {'name': self.name, 'endpoint': self.endpoint, 'options': self.options}
`,
    );
    writeFixtureFile(
      root,
      'tests/test_config.py',
      `import unittest
from src.config import Config

class T(unittest.TestCase):
    def test_instance_ownership(self):
        first = Config.from_json({'name': 'first'})
        second = Config.from_json({'name': 'second'})
        first.options['headers']['a'] = 1
        self.assertEqual(second.options['headers'], {})
`,
    );

    const withSkillReport = {
      supportedPython: '>=3.9',
      typingPolicy: 'Runtime validation and Python annotation policy',
      implementationBoundary: 'Python Config ownership and verification',
      csharpNeighborBoundary: 'No C# implementation present',
    };
    writeFixtureFile(root, '.kory-eval/python-config.json', JSON.stringify(withSkillReport));
    const typed = await scorer.score(input);
    expect(typed.passed).toBe(true);
    expect(typed.verification).toBe(1);
    expect(typed.evidence.join('\n')).not.toContain('ResourceWarning');

    const baselineReport = {
      language: 'python',
      typeCheck: 'optional',
      boundary: ['implementation', 'csharp-neighbor'],
    };
    writeFixtureFile(root, '.kory-eval/python-config.json', JSON.stringify(baselineReport));
    const baseline = await scorer.score(input);
    expect(baseline.passed).toBe(true);
    expect(baseline.verification).toBe(1);

    // The required neighboring-language rationale and immutable corpus remain gates.
    writeFixtureFile(
      root,
      '.kory-eval/python-config.json',
      JSON.stringify({ language: 'python', typeCheck: 'optional', boundary: 'implementation' }),
    );
    const missingNeighbor = await scorer.score(input);
    expect(missingNeighbor.passed).toBe(false);
    expect(missingNeighbor.quality).toBe(0.85);

    writeFixtureFile(root, '.kory-eval/python-config.json', JSON.stringify(withSkillReport));
    writeFixtureFile(root, 'evidence/old-config.json', '{}\n');
    const modifiedCorpus = await scorer.score(input);
    expect(modifiedCorpus.passed).toBe(false);
    expect(modifiedCorpus.integrityFailure).toBe(true);
  });
});
