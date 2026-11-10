import { afterEach, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  LANGUAGE_RUNTIME_SKILL_EVAL_MATERIALIZERS,
  LANGUAGE_RUNTIME_SKILL_EVAL_SCORERS,
} from '../../../backend/src/kory/skill-eval-language-runtime-fixtures';
import { writeFixtureFile } from '../../../backend/src/kory/skill-eval-fixture-helpers';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function fixture(id: string) {
  const root = mkdtempSync(join(tmpdir(), 'node-public-probe-'));
  roots.push(root);
  const scenario = { id } as never;
  const materializer = LANGUAGE_RUNTIME_SKILL_EVAL_MATERIALIZERS.find((item) =>
    item.matches(scenario),
  );
  const scorer = LANGUAGE_RUNTIME_SKILL_EVAL_SCORERS.find((item) => item.scenarioIds.includes(id));
  expect(materializer).toBeDefined();
  expect(scorer).toBeDefined();
  await materializer!.materialize(root, scenario);
  return { root, scorer: scorer!, scenario };
}

function collect(root: string, kind: 'reload' | 'stream') {
  return spawnSync('node', ['scripts/collect-evidence.mjs', kind], {
    cwd: root,
    encoding: 'utf8',
    timeout: 30_000,
    maxBuffer: 1_000_000,
  });
}

function receipt(root: string, name: 'reload' | 'stream', marker: string) {
  const log = readFileSync(join(root, '.kory-eval', 'node-' + name + '-probe.log'), 'utf8');
  const line = log.split(/\r?\n/u).find((part) => part.startsWith(marker + '='));
  expect(line).toBeDefined();
  return JSON.parse(line!.slice(marker.length + 1)) as Record<string, Record<string, unknown>>;
}

const reloadImplementation = `export interface Config { version: number; routes: string[] }
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

const streamImplementation = `import { Readable, Transform, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
export function csvTransform(): Transform {
  return new Transform({ objectMode: true, transform(row, _encoding, done) {
    if (row?.fail) return done(new Error('transform-error'));
    done(null, String(row?.value ?? row) + '\\n');
  } });
}
export async function exportCsv(source: Readable, sink: Writable, signal: AbortSignal): Promise<void> {
  await pipeline(source, csvTransform(), sink, { signal });
}
`;

test('public Node reload probe writes only executed Worker/timing observations and independent scoring agrees', async () => {
  const { root, scorer, scenario } = await fixture('nodejs-runtime-full-task-1-individual');
  writeFixtureFile(root, 'src/config-store.ts', reloadImplementation);
  writeFixtureFile(
    root,
    'tests/config-store.test.ts',
    `import { expect, test } from 'bun:test';
import { ConfigStore } from '../src/config-store';
test('atomic concurrent old snapshot and cancellation', async () => {
  const store = new ConfigStore();
  let resolve!: (value: {version:number; routes:string[]}) => void;
  const pending = store.reload('old', async () => new Promise(done => {resolve = done}), new AbortController().signal);
  expect(store.read().version).toBe(1);
  await store.reload('new', async () => ({version:3,routes:['/new']}), new AbortController().signal);
  resolve({version:2,routes:['/old']});
  await pending;
  expect(store.read().version).toBe(3);
  const reason = new Error('pre-aborted');
  const aborted = new AbortController(); aborted.abort(reason);
  await expect(store.reload('{}', async () => ({version:4,routes:[]}), aborted.signal)).rejects.toBe(reason);
});
`,
  );
  const executed = collect(root, 'reload');
  expect(executed.status).toBe(0);
  const observation = receipt(root, 'reload', 'KORY_NODE_RELOAD_PROBE');
  const report = JSON.parse(readFileSync(join(root, '.kory-eval/node-reload.json'), 'utf8'));
  expect(report.measurements.worker).toMatchObject({
    ...observation.worker,
    method: 'measured',
    liveAfterShutdown: 0,
  });
  expect(report.measurements.eventLoop).toMatchObject({
    ...observation.eventLoop,
    method: 'measured',
  });
  const scored = await scorer.score({ scenario, workingDirectory: root } as never);
  expect(scored.passed).toBe(true);
  expect(scored.verification).toBe(1);
}, 45_000);

test('public Node HTTP probe requires a real socket result and preserves a failed attempt', async () => {
  const { root, scorer, scenario } = await fixture('nodejs-runtime-full-task-2-individual');
  writeFixtureFile(root, 'src/export.ts', streamImplementation);
  writeFixtureFile(
    root,
    'tests/export.test.ts',
    `import { expect, test } from 'bun:test';
import { Readable, Writable } from 'node:stream';
import { exportCsv } from '../src/export';
test('slow writable backpressure and empty result', async () => {
  let out = '';
  const sink = new Writable({highWaterMark: 1, write(chunk, _encoding, done) {out += chunk.toString(); setTimeout(done, 1);}});
  await exportCsv(Readable.from([{value:'ok'}]), sink, new AbortController().signal);
  expect(out).toBe('ok\\n');
});
test('abort disconnect destroys source and sink', async () => {
  const signal = new AbortController();
  const source = Readable.from(Array.from({length: 100}, (_, i) => ({value: i})));
  const sink = new Writable({write(_chunk, _encoding, done) {signal.abort(new Error('disconnect')); done();}});
  await expect(exportCsv(source, sink, signal.signal)).rejects.toThrow();
  expect(source.destroyed).toBe(true);
});
test('database transform error and destination failure propagate', async () => {
  await expect(exportCsv(Readable.from([{fail:true}]), new Writable({write(_c,_e,done){done();}}), new AbortController().signal)).rejects.toThrow('transform-error');
});
`,
  );
  const executed = collect(root, 'stream');
  expect(executed.status).toBe(0);
  const observation = receipt(root, 'stream', 'KORY_NODE_HTTP_PROBE');
  const report = JSON.parse(readFileSync(join(root, '.kory-eval/node-stream.json'), 'utf8'));
  expect(report.measurements.backpressure).toMatchObject({
    ...observation.backpressure,
    method: 'measured',
    clientPaused: true,
  });
  expect(report.measurements.abort.readsAfterAbort).toBe(0);
  const scored = await scorer.score({ scenario, workingDirectory: root } as never);
  expect(scored.passed).toBe(true);
  expect(scored.verification).toBe(1);

  // Simulate the observed denied socket *only* to assert the receipt writer
  // fails closed. A marker before denial cannot become candidate HTTP evidence.
  writeFixtureFile(
    root,
    'scripts/verify-runtime.mjs',
    "console.log('KORY_NODE_HTTP_PROBE=' + JSON.stringify({runtime:{nodeVersion:process.version,moduleMode:'esm'},sourceOnly:{method:'observed'}})); throw new Error('listen EPERM');\n",
  );
  const denied = collect(root, 'stream');
  expect(denied.status).not.toBe(0);
  expect(existsSync(join(root, '.kory-eval/node-stream.json'))).toBe(false);
  const deniedLog = readFileSync(join(root, '.kory-eval/node-stream-probe.log'), 'utf8');
  expect(deniedLog).toContain('KORY_NODE_HTTP_PROBE=');
  expect(deniedLog).toContain('sourceOnly');
  expect(deniedLog).toContain('listen EPERM');
  const failed = await scorer.score({ scenario, workingDirectory: root } as never);
  expect(failed.passed).toBe(false);
  expect(failed.verification).toBe(1);
}, 45_000);
