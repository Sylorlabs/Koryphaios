import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import type {
  SkillEvalDeterministicScorer,
  SkillEvalFixtureMaterializer,
} from './skill-eval-execution';
import {
  hasRegressionText,
  packageJson,
  readJsonArtifact,
  runHiddenBunTest,
  writeFixtureFile,
} from './skill-eval-fixture-helpers';

const TS_WEBHOOK = 'typescript-javascript-engineering-full-task-1-individual';
const TS_TIMEOUT = 'typescript-javascript-engineering-full-task-2-individual';
const NODE_RELOAD = 'nodejs-runtime-full-task-1-individual';
const NODE_STREAM = 'nodejs-runtime-full-task-2-individual';
const PY_ASYNC = 'python-engineering-full-task-1-individual';
const PY_CONFIG = 'python-engineering-full-task-2-individual';

function artifactText(root: string, path: string): { artifact: unknown | null; text: string } {
  const artifact = readJsonArtifact<unknown>(root, path);
  return { artifact, text: JSON.stringify(artifact ?? '').toLowerCase() };
}

function runHiddenPython(root: string, source: string): { passed: boolean; evidence: string } {
  const path = join(root, 'tests', '__kory_hidden_python_test.py');
  writeFileSync(path, source);
  try {
    const result = spawnSync('python3', ['-m', 'unittest', 'tests.__kory_hidden_python_test'], {
      cwd: root,
      encoding: 'utf8',
      timeout: 15_000,
      maxBuffer: 1_000_000,
    });
    return {
      passed: result.status === 0,
      evidence: `${result.stdout ?? ''}\n${result.stderr ?? ''}`.trim().slice(-4_000),
    };
  } finally {
    rmSync(path, { force: true });
  }
}

function runTypeScriptTypecheck(root: string): { passed: boolean; evidence: string } {
  const backendRoot = join(import.meta.dir, '..', '..');
  const compiler = join(backendRoot, 'node_modules', 'typescript', 'bin', 'tsc');
  const typeRoots = join(backendRoot, 'node_modules', '@types');
  if (!existsSync(compiler) || !existsSync(typeRoots)) {
    return {
      passed: false,
      evidence: 'TypeScript typecheck unavailable: evaluator compiler/type roots are missing',
    };
  }
  const result = spawnSync(
    process.execPath,
    [compiler, '--noEmit', '-p', 'tsconfig.json', '--types', 'bun', '--typeRoots', typeRoots],
    {
      cwd: root,
      encoding: 'utf8',
      timeout: 15_000,
      maxBuffer: 1_000_000,
    },
  );
  const evidence = `${result.stdout ?? ''}\n${result.stderr ?? ''}`.trim().slice(-4_000);
  return {
    passed: result.status === 0,
    evidence: evidence || `tsc exited ${result.status ?? 'without status'}`,
  };
}

const WEBHOOK_SOURCE = `export type DomainEvent =
  | { type: 'created'; version: 1; payload: { id: string; amount: number } }
  | { type: 'deleted'; version: 1; payload: { id: string; hard: boolean } };

export type ParseResult =
  | { ok: true; event: DomainEvent }
  | { ok: false; error: 'INVALID_SHAPE' | 'MISSING_DISCRIMINATOR' | 'UNKNOWN_TYPE' | 'UNKNOWN_VERSION' };

export function parseWebhook(input: unknown): ParseResult {
  // BUG: static assertion substitutes for runtime validation of an untrusted boundary.
  return { ok: true, event: input as DomainEvent };
}

export function handleEvent(event: DomainEvent): string {
  switch (event.type) {
    case 'created': return 'created:' + event.payload.id + ':' + event.payload.amount;
    case 'deleted': return 'deleted:' + event.payload.id + ':' + String(event.payload.hard);
    default: return assertNever(event);
  }
}

function assertNever(value: never): never {
  throw new Error('Unhandled event: ' + String(value));
}
`;

const webhookMaterializer: SkillEvalFixtureMaterializer = {
  id: 'typescript-javascript-engineering/runtime-webhook-validation@1',
  matches: (scenario) => scenario.id === TS_WEBHOOK,
  materialize: (destination) => {
    writeFixtureFile(destination, 'package.json', packageJson('kory-eval-ts-webhook'));
    writeFixtureFile(
      destination,
      'tsconfig.json',
      `${JSON.stringify({ compilerOptions: { strict: true, noEmit: true, module: 'ESNext', target: 'ES2022', moduleResolution: 'Bundler' }, include: ['src', 'tests'] }, null, 2)}\n`,
    );
    writeFixtureFile(destination, 'src/webhook.ts', WEBHOOK_SOURCE);
    writeFixtureFile(
      destination,
      'tests/webhook.test.ts',
      `import{expect,test}from'bun:test';import{handleEvent,parseWebhook}from'../src/webhook';test('known created fixture',()=>{const r=parseWebhook({type:'created',version:1,payload:{id:'a',amount:2}});expect(r.ok).toBe(true);if(r.ok)expect(handleEvent(r.event)).toBe('created:a:2');});\n`,
    );
    writeFixtureFile(
      destination,
      'README.md',
      `# TypeScript untrusted webhook boundary

Replace the unsafe assertion with runtime validation that returns the declared \`ParseResult\`. Known variants require exact discriminators and nested field types. Unknown type/version, missing discriminator and malformed nested values return the matching error category without weakening \`DomainEvent\` to \`any\`. Extra top-level fields may be ignored only after the known required shape validates. Keep compile-time exhaustive handling aligned with runtime variants.

Add regressions for both valid variants, unknown type/version, missing discriminator, extra fields, malformed nested values, and round trip. Write \`.kory-eval/typescript-webhook.json\` with runtime-vs-static boundary, Bun/TypeScript module/runtime identity, hierarchy (broader implementation; C/C++ adjacent), and focused typecheck/runtime evidence.
`,
    );
  },
};

const webhookScorer: SkillEvalDeterministicScorer = {
  id: 'typescript-javascript-engineering/runtime-webhook-validation-scorer@3',
  scenarioIds: [TS_WEBHOOK],
  score: ({ workingDirectory }) => {
    const hidden = runHiddenBunTest(
      workingDirectory,
      `import{expect,test}from'bun:test';import{parseWebhook,handleEvent}from'../src/webhook';
test('hidden: known variants validate/narrow',()=>{for(const x of [{type:'created',version:1,payload:{id:'c',amount:3}},{type:'deleted',version:1,payload:{id:'d',hard:true}}]){const r=parseWebhook(x);expect(r.ok).toBe(true);if(r.ok)expect(handleEvent(r.event)).toContain(String(x.payload.id));}});
test('hidden: unknown/missing discriminators fail explicitly',()=>{expect(parseWebhook({version:1,payload:{id:'x'}})).toEqual({ok:false,error:'MISSING_DISCRIMINATOR'});expect(parseWebhook({type:'renamed',version:1,payload:{id:'x'}})).toEqual({ok:false,error:'UNKNOWN_TYPE'});expect(parseWebhook({type:'created',version:2,payload:{id:'x',amount:1}})).toEqual({ok:false,error:'UNKNOWN_VERSION'});});
test('hidden: malformed nested values rejected while benign extra field does not create a new variant',()=>{expect(parseWebhook({type:'created',version:1,payload:{id:'x',amount:'bad'}})).toEqual({ok:false,error:'INVALID_SHAPE'});const r=parseWebhook({type:'deleted',version:1,payload:{id:'x',hard:false},extra:'ok'});expect(r.ok).toBe(true);});
`,
    );
    const source = readFileSync(join(workingDirectory, 'src/webhook.ts'), 'utf8');
    const unsafe = /\bas\s+DomainEvent\b|\bany\b|!\./u.test(source);
    const exhaustive =
      /function\s+assertNever\s*\([^)]*:\s*never\)/u.test(source) &&
      /default\s*:\s*return\s+assertNever\s*\(\s*event\s*\)/u.test(source);
    const regression = hasRegressionText(workingDirectory, [
      /unknown|version/iu,
      /malform|nested|amount|hard/iu,
    ]);
    const typecheck = runTypeScriptTypecheck(workingDirectory);
    const report = artifactText(workingDirectory, '.kory-eval/typescript-webhook.json');
    const bounded =
      Boolean(report.artifact) &&
      /runtime/u.test(report.text) &&
      /static|typecheck/u.test(report.text) &&
      /implementation/u.test(report.text) &&
      /c\/?c\+\+|c-cpp/u.test(report.text);
    const passed =
      hidden.passed && typecheck.passed && !unsafe && exhaustive && regression && bounded;
    return {
      passed,
      quality: passed
        ? 1
        : hidden.passed && typecheck.passed && !unsafe
          ? 0.8
          : hidden.passed && !unsafe
            ? 0.7
            : hidden.passed
              ? 0.6
              : 0,
      verification: hidden.passed && typecheck.passed ? 1 : 0,
      integrityFailure: false,
      evidence: [
        `runtime validation checks: ${hidden.passed ? 'pass' : 'fail'}`,
        `repository typecheck: ${typecheck.passed ? 'pass' : 'fail'}`,
        `unsafe assertion/any absent: ${!unsafe ? 'yes' : 'no'}`,
        `compile-time exhaustive guard: ${exhaustive ? 'present' : 'missing'}`,
        `negative regressions: ${regression ? 'present' : 'missing'}`,
        `hierarchy/evidence report: ${bounded ? 'bounded' : 'missing'}`,
        typecheck.evidence,
        hidden.evidence,
      ],
    };
  },
};

const TIMEOUT_SOURCE = `export interface TimerRuntime { set(callback:()=>void, ms:number):unknown; clear(handle:unknown):void }
const DEFAULT_TIMER:TimerRuntime={set:(callback,ms)=>setTimeout(callback,ms),clear:(handle)=>clearTimeout(handle as ReturnType<typeof setTimeout>)};

export async function withTimeout<T>(
  operation:(signal:AbortSignal)=>Promise<T>,
  timeoutMs:number,
  callerSignal?:AbortSignal,
  timer:TimerRuntime=DEFAULT_TIMER,
):Promise<T>{
  const controller=new AbortController();
  const timeout=new Promise<T>((_,reject)=>{timer.set(()=>reject(new Error('TIMEOUT')),timeoutMs);});
  // BUG: Promise.race owns neither timer cleanup nor cancellation of underlying work/caller abort.
  return Promise.race([operation(controller.signal),timeout]);
}
`;

const timeoutMaterializer: SkillEvalFixtureMaterializer = {
  id: 'typescript-javascript-engineering/abortable-timeout-lifecycle@2',
  matches: (scenario) => scenario.id === TS_TIMEOUT,
  materialize: (destination) => {
    writeFixtureFile(
      destination,
      'package.json',
      packageJson('kory-eval-ts-timeout', {
        test: 'bun test',
        typecheck: 'tsc --noEmit -p tsconfig.json',
      }),
    );
    writeFixtureFile(
      destination,
      'tsconfig.json',
      `${JSON.stringify({ compilerOptions: { strict: true, noEmit: true, module: 'ESNext', target: 'ES2022', moduleResolution: 'Bundler' }, include: ['src', 'tests'] }, null, 2)}\n`,
    );
    writeFixtureFile(destination, 'src/timeout.ts', TIMEOUT_SOURCE);
    writeFixtureFile(
      destination,
      'tests/timeout.test.ts',
      `import{expect,test}from'bun:test';import{withTimeout}from'../src/timeout';test('success',async()=>expect(await withTimeout(async()=>7,100)).toBe(7));\n`,
    );
    writeFixtureFile(
      destination,
      'README.md',
      `# Abortable timeout ownership fixture

Repair \`withTimeout\` without changing its signature. Exactly one terminal outcome owns cleanup. The injected timer must be cleared on success, timeout, caller abort, and underlying rejection, even if its valid handle is \`undefined\`. Timeout and caller cancellation propagate to the operation's AbortSignal. Preserve the original underlying rejection object and an explicitly supplied caller abort reason, including \`null\`. An already-aborted caller must not start the operation. Late operation work must observe abort and cannot mutate after timeout/cancel.

The supplied target is Bun running ESM (package \`type: module\`; TypeScript ESNext with Bundler resolution). Run the repository typecheck (\`bun run typecheck\` when available) and Bun runtime tests, and record actual compiler/runtime versions and command results, or explicitly mark a check unavailable. Do not claim other runtime targets were tested unless they were actually exercised.

Add deterministic regressions using an injected timer for success, timeout, caller abort (including pre-aborted and null-reason signals), underlying rejection, undefined timer handles, simultaneous boundary and no timer/listener leak. Write \`.kory-eval/typescript-timeout.json\` with JS runtime lifecycle vs TS type guarantees and hierarchy evidence (broader implementation; C#/.NET adjacent).
`,
    );
  },
};

const timeoutScorer: SkillEvalDeterministicScorer = {
  id: 'typescript-javascript-engineering/abortable-timeout-lifecycle-scorer@2',
  scenarioIds: [TS_TIMEOUT],
  score: ({ workingDirectory }) => {
    const hidden = runHiddenBunTest(
      workingDirectory,
      `import{expect,test}from'bun:test';import{withTimeout,type TimerRuntime}from'../src/timeout';class ManualTimer implements TimerRuntime{callbacks=new Map<number,()=>void>();next=1;clears=0;set(cb:()=>void){const id=this.next++;this.callbacks.set(id,cb);return id;}clear(h:unknown){if(this.callbacks.delete(Number(h)))this.clears++;}fire(){for(const [id,cb] of [...this.callbacks]){this.callbacks.delete(id);cb();}}active(){return this.callbacks.size;}}
test('hidden: success clears timer',async()=>{const t=new ManualTimer();expect(await withTimeout(async()=>9,10,undefined,t)).toBe(9);expect(t.active()).toBe(0);expect(t.clears).toBe(1);});
test('hidden: timeout aborts underlying and clears timer',async()=>{const t=new ManualTimer();let aborted=false;const p=withTimeout(async signal=>new Promise<number>((_,reject)=>signal.addEventListener('abort',()=>{aborted=true;reject(signal.reason);},{once:true})),10,undefined,t);t.fire();await expect(p).rejects.toThrow(/timeout/i);expect(aborted).toBe(true);expect(t.active()).toBe(0);});
test('hidden: caller abort propagates and preserves reason',async()=>{const t=new ManualTimer(),caller=new AbortController(),reason=new Error('caller-stop');let seen:unknown;const p=withTimeout(async signal=>new Promise<number>((_,reject)=>signal.addEventListener('abort',()=>{seen=signal.reason;reject(signal.reason);},{once:true})),10,caller.signal,t);caller.abort(reason);await Promise.resolve();expect(seen).toBe(reason);await expect(p).rejects.toBe(reason);expect(t.active()).toBe(0);});
test('hidden: underlying rejection identity preserved',async()=>{const t=new ManualTimer(),err=new Error('source');await expect(withTimeout(async()=>{throw err},10,undefined,t)).rejects.toBe(err);expect(t.active()).toBe(0);});
test('hidden: pre-aborted caller does not start underlying work',async()=>{const t=new ManualTimer(),caller=new AbortController(),reason=new Error('already-stopped');caller.abort(reason);let started=0;await expect(withTimeout(async()=>{started++;return 1},10,caller.signal,t)).rejects.toBe(reason);expect(started).toBe(0);expect(t.active()).toBe(0);});
test('hidden: explicit null caller abort reason survives',async()=>{const t=new ManualTimer(),caller=new AbortController();let seen:unknown='not-aborted';const p=withTimeout(async signal=>new Promise<number>((_,reject)=>signal.addEventListener('abort',()=>{seen=signal.reason;reject(signal.reason);},{once:true})),10,caller.signal,t);caller.abort(null);await expect(p).rejects.toBe(null);expect(seen).toBe(null);expect(t.active()).toBe(0);});
test('hidden: undefined timer handle still requires cleanup',async()=>{let setCount=0,clearCount=0,cleared:unknown='unset';const timer:TimerRuntime={set:()=>{setCount++;return undefined},clear:(handle)=>{clearCount++;cleared=handle}};expect(await withTimeout(async()=>9,10,undefined,timer)).toBe(9);expect(setCount).toBe(1);expect(clearCount).toBe(1);expect(cleared).toBeUndefined();});
`,
    );
    const regression = hasRegressionText(workingDirectory, [
      /caller|abort/iu,
      /underlying|reject|source/iu,
      /timer|cleanup/iu,
    ]);
    const report = artifactText(workingDirectory, '.kory-eval/typescript-timeout.json');
    const typecheck = runTypeScriptTypecheck(workingDirectory);
    const bounded =
      Boolean(report.artifact) &&
      /runtime/u.test(report.text) &&
      /implementation/u.test(report.text) &&
      /c#|dotnet|\.net/u.test(report.text);
    const passed = hidden.passed && typecheck.passed && regression && bounded;
    return {
      passed,
      quality: passed
        ? 1
        : hidden.passed && typecheck.passed && regression
          ? 0.85
          : hidden.passed && typecheck.passed
            ? 0.6
            : hidden.passed
              ? 0.5
              : 0,
      verification: hidden.passed && typecheck.passed ? 1 : 0,
      integrityFailure: false,
      evidence: [
        `terminal cleanup/cancellation: ${hidden.passed ? 'pass' : 'fail'}`,
        `repository typecheck: ${typecheck.passed ? 'pass' : 'fail'}`,
        `lifecycle regressions: ${regression ? 'present' : 'missing'}`,
        `hierarchy evidence: ${bounded ? 'bounded' : 'missing'}`,
        typecheck.evidence,
        hidden.evidence,
      ],
    };
  },
};

const NODE_RELOAD_SOURCE = `export interface Config{version:number;routes:string[]}
export type Offload=(raw:string,signal:AbortSignal)=>Promise<Config>;
export class ConfigStore{private current:Config={version:1,routes:['/health']};read():Config{return structuredClone(this.current)}async reload(raw:string,offload:Offload,signal:AbortSignal):Promise<void>{// BUG: CPU/sync transform is done on the main path and the supplied offload boundary is ignored.
const parsed=JSON.parse(raw) as Config;let checksum=0;for(let i=0;i<50000;i++)checksum=(checksum+i)%997;if(checksum<0)throw new Error('never');this.current=parsed;void offload;void signal;}}
`;

interface NativeNodeProbe {
  passed: boolean;
  nodeVersion: string | null;
  receipt: Record<string, unknown> | null;
  evidence: string;
}

/** The candidate's ESM runs under Node in a private temp directory; its report is never executed. */
function runNativeNodeProbe(
  root: string,
  entry: string,
  probeSource: string,
  marker: string,
): NativeNodeProbe {
  const probeRoot = mkdtempSync(join(tmpdir(), 'kory-eval-node-probe-'));
  const failure = (evidence: string): NativeNodeProbe => ({
    passed: false,
    nodeVersion: null,
    receipt: null,
    evidence,
  });
  try {
    const bundle = spawnSync(
      process.execPath,
      [
        'build',
        join(root, `src/${entry}.ts`),
        '--target=node',
        '--format=esm',
        '--outfile',
        join(probeRoot, `${entry}.mjs`),
      ],
      { cwd: probeRoot, encoding: 'utf8', timeout: 15_000, maxBuffer: 1_000_000 },
    );
    if (bundle.error || bundle.status !== 0) {
      return failure(
        `Native Node bundle failed: ${bundle.error?.message ?? `${bundle.stdout ?? ''}\n${bundle.stderr ?? ''}`.trim().slice(-1_500)}`,
      );
    }
    const path = join(probeRoot, 'probe.mjs');
    writeFileSync(path, probeSource);
    const result = spawnSync('node', [path], {
      cwd: probeRoot,
      encoding: 'utf8',
      timeout: 20_000,
      maxBuffer: 1_000_000,
      env: {
        PATH: process.env.PATH ?? '',
        HOME: probeRoot,
        TMPDIR: probeRoot,
        NO_COLOR: '1',
      },
    });
    const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`.trim();
    const line = output.split(/\r?\n/u).findLast((item) => item.startsWith(`${marker}=`));
    let receipt: Record<string, unknown> | null = null;
    try {
      const value = JSON.parse(line?.slice(marker.length + 1) ?? 'null') as unknown;
      if (value && typeof value === 'object' && !Array.isArray(value)) {
        receipt = value as Record<string, unknown>;
      }
    } catch {
      // Missing or malformed independent measurement fails closed.
    }
    const runtime = nodeObject(receipt?.runtime);
    const nodeVersion =
      typeof runtime.nodeVersion === 'string' && /^v\d+\.\d+\.\d+$/u.test(runtime.nodeVersion)
        ? runtime.nodeVersion
        : null;
    const passed = !result.error && result.status === 0 && Boolean(nodeVersion);
    return {
      passed,
      nodeVersion,
      receipt,
      evidence: result.error
        ? `Native Node probe failed: ${result.error.message}`
        : `Native Node probe ${passed ? 'passed' : 'failed'} (exit ${result.status ?? 'none'}): ${output.slice(-2_000)}`,
    };
  } catch (error) {
    return failure(`Native Node probe unavailable: ${String(error)}`);
  } finally {
    rmSync(probeRoot, { recursive: true, force: true });
  }
}

function nodeObject(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function nodeCount(value: unknown, minimum = 0): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= minimum;
}

function closeToObserved(claim: unknown, measured: unknown, tolerance: number): boolean {
  return (
    typeof claim === 'number' &&
    Number.isFinite(claim) &&
    typeof measured === 'number' &&
    Number.isFinite(measured) &&
    Math.abs(claim - measured) <= tolerance
  );
}

/**
 * Materialized beside the candidate's public native Node probe. The candidate
 * can collect the same scenario's measurements in its own process; the scorer
 * still runs its separately bundled, fixed probe and checks the report against
 * fresh independent observations. A failed probe cannot create a measured file.
 */
const NODE_PUBLIC_EVIDENCE_COLLECTOR = String.raw`import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const kind = process.argv[2];
assert.ok(kind === 'reload' || kind === 'stream', 'usage: node scripts/collect-evidence.mjs reload|stream');
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const entry = kind === 'reload' ? 'config-store' : 'export';
const name = kind === 'reload' ? 'node-reload' : 'node-stream';
const outputFile = join(root, '.kory-eval', name + '.json');
const transcriptFile = join(root, '.kory-eval', name + '-probe.log');
const marker = kind === 'reload' ? 'KORY_NODE_RELOAD_PROBE=' : 'KORY_NODE_HTTP_PROBE=';
mkdirSync(dirname(outputFile), { recursive: true });
rmSync(outputFile, { force: true });
const transcript = [];

function execute(label, command, args) {
  const result = spawnSync(command, args, {
    cwd: root, encoding: 'utf8', timeout: 20_000, maxBuffer: 1_000_000,
  });
  const output = (result.stdout || '') + '\n' + (result.stderr || '');
  transcript.push(label + ': ' + command + ' ' + args.join(' ') + '\n' + output);
  if (result.error || result.status !== 0) {
    throw new Error(label + ' failed (' + (result.error?.message || 'exit ' + result.status) + '): ' + output.slice(-1200));
  }
  return output;
}

try {
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  assert.equal(pkg.type, 'module', 'native Node fixture requires ESM');
  execute('Public regressions', 'bun', ['test']);
  execute('ESM build', 'bun', ['build', 'src/' + entry + '.ts', '--target=node',
    '--format=esm', '--outfile=scripts/' + entry + '.mjs']);
  const output = execute('Native Node verification', process.execPath, ['scripts/verify-runtime.mjs']);
  const line = output.split(/\r?\n/).findLast(line => line.startsWith(marker));
  assert.ok(line, 'native Node probe did not emit a receipt');
  const receipt = JSON.parse(line.slice(marker.length));
  assert.equal(receipt.runtime?.nodeVersion, process.version);
  assert.equal(receipt.runtime?.moduleMode, 'esm');

  let report;
  if (kind === 'reload') {
    assert.equal(receipt.worker?.method, 'observed');
    assert.equal(receipt.eventLoop?.method, 'observed');
    report = {
      runtime: receipt.runtime,
      measurements: {
        worker: { ...receipt.worker, method: 'measured' },
        eventLoop: { ...receipt.eventLoop, method: 'measured' },
      },
      hierarchy: { broader: 'backend-engineering', neighbor: 'bun-deno-runtime' },
    };
  } else {
    for (const key of ['backpressure', 'abort', 'cancellation', 'shutdown']) {
      assert.equal(receipt[key]?.method, 'observed');
    }
    for (const key of ['transform', 'database', 'destination', 'empty']) {
      assert.equal(receipt.errors?.[key], true);
    }
    report = {
      runtime: receipt.runtime,
      measurements: Object.fromEntries(
        ['backpressure', 'abort', 'cancellation', 'shutdown'].map(key => [
          key, { ...receipt[key], method: 'measured' },
        ]),
      ),
      verification: {
        command: 'bun test && bun build src/export.ts --target=node --format=esm --outfile=scripts/export.mjs && node scripts/verify-runtime.mjs',
        cases: Object.fromEntries([
          'slowClient', 'disconnect', 'serverCancellation', 'transformError',
          'databaseError', 'destinationError', 'empty', 'shutdown',
        ].map(key => [key, 'pass'])),
      },
      hierarchy: { broader: 'backend-engineering', neighbor: 'compiler-runtime-backend' },
    };
  }
  writeFileSync(outputFile, JSON.stringify(report, null, 2) + '\n');
  process.stdout.write(line + '\n');
  process.stdout.write('Measured report: ' + outputFile + '\n');
} finally {
  writeFileSync(transcriptFile, transcript.join('\n\n') + '\n');
}
`;

const NODE_RELOAD_PROBE = String.raw`import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { Worker, isMainThread, threadId } from 'node:worker_threads';
import { ConfigStore } from './config-store.mjs';

assert.equal(isMainThread, true);
const live = new Set();
const starts = new Map();
const listeners = new Map();
const stats = { created: 0, completed: 0, exited: 0, aborted: 0, workerThreads: new Set(), cpuMs: 0 };
const workerCode = '(' + function cpuJob() {
  const { parentPort, workerData, threadId, isMainThread } = require('node:worker_threads');
  const { performance } = require('node:perf_hooks');
  if (isMainThread || threadId <= 0) throw new Error('not running in a Worker');
  parentPort.postMessage({ phase: 'started', threadId, version: workerData.version });
  const start = performance.now();
  let checksum = 13, iterations = 0;
  while (performance.now() - start < workerData.durationMs) {
    checksum = (checksum * 33 + (iterations++ % 251)) % 65521;
  }
  try {
    const config = JSON.parse(workerData.raw);
    if (!config || !Number.isSafeInteger(config.version) || config.version <= 0 ||
      !Array.isArray(config.routes) || !config.routes.every(route => typeof route === 'string')) {
      throw new Error('invalid config');
    }
    parentPort.postMessage({ phase: 'done', threadId, config, iterations, checksum,
      cpuMs: performance.now() - start });
  } catch (error) {
    parentPort.postMessage({ phase: 'error', error: String(error) });
  }
}.toString() + ')()';

function within(promise, name, ms = 2500) {
  let timeout;
  return Promise.race([
    promise.finally(() => clearTimeout(timeout)),
    new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error(name + ' timed out')), ms); }),
  ]);
}
function waitStarted(version) {
  if (starts.has(version)) return Promise.resolve();
  return within(new Promise(resolve => listeners.set(version, resolve)), 'worker start');
}
async function offload(raw, signal) {
  assert.equal(signal instanceof AbortSignal, true);
  assert.equal(signal.aborted, false, 'already aborted work must not start');
  // Read only a scheduling hint here. Parsing and schema validation belong to the Worker.
  const version = Number(raw.match(/"version"\s*:\s*(\d+)/)?.[1] ?? -1);
  const durationMs = version === 20 ? 260 : version === 21 ? 40 : version === 4 ? 260 : 190;
  const worker = new Worker(workerCode, { eval: true, workerData: { raw, version, durationMs } });
  stats.created++;
  live.add(worker);
  try {
    return await new Promise((resolve, reject) => {
      let settled = false;
      const finish = (error, value) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener('abort', onAbort);
        if (error) reject(error); else resolve(value);
      };
      const onAbort = () => { stats.aborted++; finish(signal.reason ?? new Error('aborted')); };
      signal.addEventListener('abort', onAbort, { once: true });
      worker.on('message', message => {
        if (message.phase === 'started') {
          assert.ok(message.threadId > 0 && message.threadId !== threadId);
          stats.workerThreads.add(message.threadId);
          starts.set(message.version, true);
          listeners.get(message.version)?.();
          listeners.delete(message.version);
        } else if (message.phase === 'done') {
          assert.ok(message.iterations > 1000 && message.cpuMs >= durationMs * 0.9);
          assert.equal(message.threadId > 0, true);
          stats.cpuMs += message.cpuMs;
          stats.completed++;
          finish(null, message.config);
        } else if (message.phase === 'error') {
          finish(new Error(message.error));
        }
      });
      worker.once('error', error => finish(error));
      worker.once('exit', code => finish(new Error('worker exited early: ' + code)));
    });
  } finally {
    await worker.terminate();
    live.delete(worker);
    stats.exited++;
  }
}

async function main() {
  const store = new ConfigStore();
  assert.deepEqual(store.read(), { version: 1, routes: ['/health'] });
  const ticks = [];
  const began = performance.now();
  let previous = began;
  const ticker = setInterval(() => { const now = performance.now(); ticks.push(now - previous); previous = now; }, 5);
  let firstDuration;
  try {
    const pending = store.reload(JSON.stringify({ version: 2, routes: ['/v2'] }), offload, new AbortController().signal);
    await waitStarted(2);
    assert.equal(store.read().version, 1, 'old snapshot must remain during Worker CPU work');
    const before = store.read();
    before.routes.push('/mutated');
    assert.deepEqual(store.read().routes, ['/health']);
    await within(pending, 'initial reload');
    firstDuration = performance.now() - began;
    assert.deepEqual(store.read(), { version: 2, routes: ['/v2'] });
  } finally { clearInterval(ticker); }
  const maxGapMs = Math.max(...ticks);
  assert.ok(firstDuration >= 150, 'Worker CPU workload did not complete');
  assert.ok(ticks.length >= 12 && maxGapMs < 90,
    'main event loop was blocked: ' + JSON.stringify({ ticks: ticks.length, maxGapMs }));
  await assert.rejects(store.reload('not-json', offload, new AbortController().signal), /syntax|json|unexpected/i);
  assert.equal(store.read().version, 2);
  await assert.rejects(store.reload(JSON.stringify({version:3,routes:[1]}), offload, new AbortController().signal), /invalid config/);
  assert.equal(store.read().version, 2);

  const canceled = new AbortController();
  const cancelled = store.reload(JSON.stringify({version:4,routes:['/cancelled']}), offload, canceled.signal);
  await waitStarted(4);
  const cancellationReason = new Error('cancelled by caller');
  canceled.abort(cancellationReason);
  await assert.rejects(within(cancelled, 'cancellation'), error => error === cancellationReason);
  assert.equal(store.read().version, 2);
  const already = new AbortController();
  already.abort(new Error('pre-aborted'));
  const beforePreAbort = stats.created;
  await assert.rejects(store.reload('{}', offload, already.signal), /pre-aborted/);
  assert.equal(stats.created, beforePreAbort, 'pre-aborted call spawned Worker');

  const stale = store.reload(JSON.stringify({version:20,routes:['/old']}), offload, new AbortController().signal);
  await waitStarted(20);
  const newer = store.reload(JSON.stringify({version:21,routes:['/latest']}), offload, new AbortController().signal);
  await within(newer, 'newer reload');
  assert.equal(store.read().version, 21);
  await within(stale, 'stale reload');
  assert.deepEqual(store.read(), {version:21,routes:['/latest']});
  assert.equal(live.size, 0, 'Worker resources remain live after shutdown');
  assert.equal(stats.created, stats.exited, 'Worker termination was not observed');
  assert.ok(stats.created >= 6 && stats.completed >= 3 && stats.aborted === 1);
  assert.ok(stats.workerThreads.size >= 2);
  console.log('KORY_NODE_RELOAD_PROBE=' + JSON.stringify({
    runtime: {nodeVersion: process.version, moduleMode: 'esm'},
    worker: {method: 'observed', created: stats.created, completed: stats.completed,
      exited: stats.exited, aborted: stats.aborted, distinctThreads: stats.workerThreads.size,
      cpuMs: Math.round(stats.cpuMs), liveAfterShutdown: live.size},
    eventLoop: {method: 'observed', ticks: ticks.length, maxGapMs: Math.round(maxGapMs * 10) / 10,
      wallMs: Math.round(firstDuration)},
    race: {winner: store.read().version, staleIgnored: true},
  }));
}
main().catch(error => { console.error(error); process.exitCode = 1; });
`;

function runNodeReloadProbe(root: string): NativeNodeProbe {
  return runNativeNodeProbe(root, 'config-store', NODE_RELOAD_PROBE, 'KORY_NODE_RELOAD_PROBE');
}

function hasNodeReloadEvidence(root: string, probe: NativeNodeProbe): boolean {
  const report = nodeObject(readJsonArtifact<unknown>(root, '.kory-eval/node-reload.json'));
  const runtime = nodeObject(report.runtime);
  const worker = nodeObject(nodeObject(report.measurements).worker);
  const loop = nodeObject(nodeObject(report.measurements).eventLoop);
  const observedWorker = nodeObject(probe.receipt?.worker);
  const observedLoop = nodeObject(probe.receipt?.eventLoop);
  const hierarchy = nodeObject(report.hierarchy);
  return (
    probe.passed &&
    runtime.nodeVersion === probe.nodeVersion &&
    runtime.moduleMode === 'esm' &&
    worker.method === 'measured' &&
    loop.method === 'measured' &&
    worker.created === observedWorker.created &&
    worker.completed === observedWorker.completed &&
    worker.exited === observedWorker.exited &&
    worker.aborted === observedWorker.aborted &&
    nodeCount(worker.distinctThreads, 2) &&
    worker.distinctThreads === observedWorker.distinctThreads &&
    nodeCount(worker.cpuMs, 150) &&
    closeToObserved(worker.cpuMs, observedWorker.cpuMs, 150) &&
    worker.liveAfterShutdown === 0 &&
    observedWorker.liveAfterShutdown === 0 &&
    nodeCount(loop.ticks, 12) &&
    closeToObserved(loop.ticks, observedLoop.ticks, 15) &&
    typeof loop.maxGapMs === 'number' &&
    loop.maxGapMs > 0 &&
    loop.maxGapMs < 90 &&
    closeToObserved(loop.maxGapMs, observedLoop.maxGapMs, 30) &&
    typeof loop.wallMs === 'number' &&
    loop.wallMs >= 150 &&
    closeToObserved(loop.wallMs, observedLoop.wallMs, 150) &&
    hierarchy.broader === 'backend-engineering' &&
    ['bun-deno-runtime', 'bun-deno'].includes(String(hierarchy.neighbor))
  );
}
const nodeReloadMaterializer: SkillEvalFixtureMaterializer = {
  id: 'nodejs-runtime/config-reload-offload@1',
  matches: (s) => s.id === NODE_RELOAD,
  materialize: (d) => {
    writeFixtureFile(d, 'package.json', packageJson('kory-eval-node-reload'));
    writeFixtureFile(d, 'src/config-store.ts', NODE_RELOAD_SOURCE);
    writeFixtureFile(d, 'scripts/verify-runtime.mjs', NODE_RELOAD_PROBE);
    writeFixtureFile(d, 'scripts/collect-evidence.mjs', NODE_PUBLIC_EVIDENCE_COLLECTOR);
    writeFixtureFile(
      d,
      'tests/config-store.test.ts',
      `import{expect,test}from'bun:test';import{ConfigStore}from'../src/config-store';test('initial config',()=>expect(new ConfigStore().read().version).toBe(1));\n`,
    );
    writeFixtureFile(
      d,
      'README.md',
      `# Node.js config reload and Worker CPU offload

Use the supplied \`offload(raw, signal)\` boundary. The evaluator supplies a **real Node worker_threads Worker** that parses, validates, and performs CPU work for each reload. Your store must await that offload without blocking the event loop itself. Keep the old config readable during work, atomically publish only validated results, prevent an older concurrent reload from overwriting the newer result, and propagate cancellation to the supplied AbortSignal. Failure, malformed input, cancellation (including a pre-aborted caller), and stale completion must not corrupt current state. No Worker construction is required in your store: this fixture verifies that the provided boundary actually does work on a separate Worker.

Add regressions for concurrent reads, invalid/malformed config, cancellation, latest-wins races, and Worker resource shutdown. A pre-aborted caller must retain its exact \`signal.reason\` (for example the original \`Error('pre-aborted')\`) without spawning a Worker or invalidating an active generation. In-flight cancellation must also preserve its supplied reason, not replace it with a generic AbortError.

Run \`node scripts/collect-evidence.mjs reload\` after implementing and testing the store. This runs Bun regressions, bundles ESM for native Node, executes the supplied real Worker/latency/race/shutdown probe, including event-loop timer gaps during CPU work, and writes a measured report only if its assertions pass. Keep \`.kory-eval/node-reload-probe.log\` as the receipt. This verifies the same workload, Worker counts, and time window the independent evaluator will separately exercise; do not substitute numbers from an unrelated benchmark. The evaluator runs the candidate ESM with its own copy of the probe and does not trust self-reported worker activity without that measurement.

The generated \`.kory-eval/node-reload.json\` contains \`runtime: {nodeVersion, moduleMode: "esm"}\`, \`measurements: {worker: {method: "measured", created, completed, exited, aborted, distinctThreads, cpuMs, liveAfterShutdown}, eventLoop: {method: "measured", ticks, maxGapMs, wallMs}}\`, and \`hierarchy: {broader: "backend-engineering", neighbor: "bun-deno-runtime"}\`. If the probe fails, the reporter leaves only its failure log and no measured report. Additional CPU profiles, real before/after request latency, and memory measurements remain separate work; label them with their own commands and sample counts. Synthetic or unavailable measurements cannot qualify as native Node observations.
`,
    );
  },
};
const nodeReloadScorer: SkillEvalDeterministicScorer = {
  id: 'nodejs-runtime/config-reload-offload-scorer@1',
  scenarioIds: [NODE_RELOAD],
  score: ({ workingDirectory }) => {
    const hidden = runHiddenBunTest(
      workingDirectory,
      `import{expect,test}from'bun:test';import{ConfigStore}from'../src/config-store';
test('hidden: offload boundary owns expensive work and swap is atomic',async()=>{const s=new ConfigStore();let resolve!:(v:any)=>void,calls=0;const offload=async()=>{calls++;return await new Promise<any>(r=>resolve=r)};const p=s.reload('{"version":2,"routes":["/v2"]}',offload,new AbortController().signal);expect(s.read().version).toBe(1);resolve({version:2,routes:['/v2']});await p;expect(calls).toBe(1);expect(s.read()).toEqual({version:2,routes:['/v2']});});
test('hidden: offload failure and abort leave old config',async()=>{const s=new ConfigStore();await expect(s.reload('bad',async()=>{throw new Error('malformed')},new AbortController().signal)).rejects.toThrow('malformed');expect(s.read().version).toBe(1);const c=new AbortController();const p=s.reload('{}',async(_r,signal)=>new Promise<any>((_,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true})),c.signal);c.abort(new Error('stop'));await expect(p).rejects.toThrow('stop');expect(s.read().version).toBe(1);});
`,
    );
    const reg = hasRegressionText(workingDirectory, [
      /atomic|concurrent|old/iu,
      /abort|cancel|malform/iu,
    ]);
    const nativeNode = runNodeReloadProbe(workingDirectory);
    const bounded = hasNodeReloadEvidence(workingDirectory, nativeNode);
    const verified = hidden.passed && nativeNode.passed;
    const passed = verified && reg && bounded;
    return {
      passed,
      quality: passed ? 1 : verified && reg ? 0.85 : verified ? 0.6 : 0,
      verification: verified ? 1 : 0,
      integrityFailure: false,
      evidence: [
        `offload/atomic reload behavior: ${hidden.passed ? 'pass' : 'fail'}`,
        `native Node Worker/latency/race/shutdown: ${nativeNode.passed ? 'pass' : 'fail'}`,
        `failure/cancel regressions: ${reg ? 'present' : 'missing'}`,
        `independently checked runtime measurements: ${bounded ? 'bounded' : 'missing or inconsistent'}`,
        nativeNode.evidence,
        hidden.evidence,
      ],
    };
  },
};

const NODE_STREAM_SOURCE = `import { Readable,Transform,Writable } from 'node:stream';
export async function exportCsv(source:Readable,destination:Writable,signal:AbortSignal):Promise<void>{
  // BUG: manual writes ignore backpressure and request abort; source keeps reading after disconnect.
  return await new Promise<void>((resolve,reject)=>{
    source.on('data',(row)=>{const value=typeof row==='string'?row:row.toString();destination.write(value+'\\n');});
    source.on('error',reject);destination.on('error',reject);source.on('end',()=>{destination.end();resolve();});void signal;
  });
}
export function csvTransform():Transform{return new Transform({objectMode:true,transform(row,_enc,cb){if(row?.fail)return cb(new Error('transform-error'));cb(null,String(row?.value??row)+'\\n');}})};
`;

/** Runs a real loopback HTTP server/client in native Node with an intentionally paused socket. */
const NODE_HTTP_PROBE = String.raw`import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer, get, Agent } from 'node:http';
import { Readable, Writable } from 'node:stream';
import { exportCsv } from './export.mjs';

const TOTAL = 640;
const PAYLOAD = 'x'.repeat(65536);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
class Rows extends Readable {
  constructor(total = TOTAL) { super({ objectMode: true, highWaterMark: 2 }); this.total = total; this.reads = 0; }
  _read() {
    this.reads++;
    if (this.reads > this.total) this.push(null);
    else this.push({value: 'row' + this.reads + ':' + PAYLOAD});
  }
}
function within(promise, label, ms = 8000) {
  let timeout;
  return Promise.race([
    promise.finally(() => clearTimeout(timeout)),
    new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error(label + ' timed out')), ms); }),
  ]);
}
async function checkErrors() {
  function sink(write = (_chunk, _encoding, cb) => cb()) {
    return new Writable({ highWaterMark: 1, write });
  }
  await assert.rejects(exportCsv(Readable.from([{ value: 'ok' }, { fail: true }]),
    sink(), new AbortController().signal), /transform-error/);
  await assert.rejects(exportCsv(Readable.from((async function*() {
    yield {value:'ok'}; throw new Error('database-error');
  })()), sink(), new AbortController().signal), /database-error/);
  await assert.rejects(exportCsv(Readable.from([{value:'ok'}]),
    sink((_chunk, _encoding, cb) => cb(new Error('destination-error'))),
    new AbortController().signal), /destination-error/);
  let emptyBytes = 0;
  const empty = sink((chunk, _encoding, cb) => { emptyBytes += chunk.length; cb(); });
  await within(exportCsv(Readable.from([]), empty, new AbortController().signal), 'empty');
  assert.equal(emptyBytes, 0);
  assert.equal(empty.writableFinished, true);
  return empty.writableFinished;
}

async function main() {
  const records = new Map();
  let activePipelines = 0;
  const server = createServer((req, res) => {
    const key = req.url;
    const source = new Rows();
    const controller = new AbortController();
    const state = {
      source, res, controller, falseWrites: 0, closeSeen: false,
      disconnect: false, readsAtAbort: null, outcome: null, done: null,
    };
    records.set(key, state);
    const originalWrite = res.write;
    res.write = function (...args) {
      const ok = originalWrite.apply(this, args);
      if (!ok) state.falseWrites++;
      return ok;
    };
    res.once('close', () => {
      state.closeSeen = true;
      if (!res.writableFinished) {
        state.disconnect = true;
        state.readsAtAbort = source.reads;
        controller.abort(new Error('HTTP client disconnected'));
      }
    });
    req.once('aborted', () => controller.abort(new Error('HTTP request aborted')));
    activePipelines++;
    state.done = Promise.resolve()
      .then(() => exportCsv(source, res, controller.signal))
      .then(() => { state.outcome = 'success'; }, error => {
        state.outcome = 'failed: ' + String(error);
      })
      .finally(() => { activePipelines--; });
  });
  const agent = new Agent({ keepAlive: false });
  try {
    await within(new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    }), 'HTTP listen');
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    const open = path => within(new Promise((resolve, reject) => {
      const req = get({ hostname: '127.0.0.1', port: address.port, path, agent }, res => {
        res.once('error', () => {});
        resolve({req, response: res});
      });
      req.once('error', reject);
    }), 'HTTP headers');

    const {response: paused} = await open('/slow');
    paused.pause();
    const slow = records.get('/slow');
    assert.ok(slow);
    // Sample once the real paused socket has stayed backpressured for several
    // consecutive reads. A fixed delay alone makes the counters depend on
    // scheduler load and the host TCP receive window.
    let stalledSamples = 0;
    for (let attempt = 0; attempt < 80 && stalledSamples < 4; attempt++) {
      const priorReads = slow.source.reads;
      await sleep(25);
      stalledSamples = slow.falseWrites > 0 && slow.res.writableLength > 0 &&
        slow.source.reads === priorReads ? stalledSamples + 1 : 0;
    }
    assert.equal(stalledSamples, 4, 'paused HTTP socket never reached sustained backpressure');
    const readsWhilePaused = slow.source.reads;
    const bufferedBytes = slow.res.writableLength;
    const falseWritesWhilePaused = slow.falseWrites;
    assert.equal(paused.isPaused(), true);
    assert.ok(readsWhilePaused > 0 && readsWhilePaused < TOTAL / 2,
      'source outran a paused HTTP socket: ' + readsWhilePaused);
    assert.ok(falseWritesWhilePaused > 0 && bufferedBytes > 0,
      'no observable HTTP response backpressure');
    assert.equal(slow.outcome, null, 'stream completed while client was paused');

    const receivedHash = createHash('sha256');
    let receivedBytes = 0;
    const received = new Promise((resolve, reject) => {
      paused.on('data', chunk => { receivedHash.update(chunk); receivedBytes += chunk.length; });
      paused.once('end', resolve);
      paused.once('error', reject);
      paused.once('aborted', () => reject(new Error('slow HTTP response aborted')));
    });
    paused.resume();
    await within(received, 'slow HTTP response');
    await within(slow.done, 'slow server completion');
    assert.equal(slow.outcome, 'success');
    assert.equal(slow.res.writableFinished, true);
    assert.equal(slow.source.reads, TOTAL + 1);
    const expectedHash = createHash('sha256');
    let expectedBytes = 0;
    for (let i = 1; i <= TOTAL; i++) {
      const row = 'row' + i + ':' + PAYLOAD + '\n';
      expectedHash.update(row);
      expectedBytes += Buffer.byteLength(row);
    }
    assert.equal(receivedBytes, expectedBytes);
    assert.equal(receivedHash.digest('hex'), expectedHash.digest('hex'));

    const {response: disconnectResponse} = await open('/disconnect');
    const disconnect = records.get('/disconnect');
    assert.ok(disconnect);
    // Receiving headers proves that HTTP streaming has begun. Disconnecting
    // immediately at this observable boundary avoids variable extra database
    // reads while a data handler waits for scheduling.
    assert.equal(disconnectResponse.statusCode, 200);
    assert.equal(disconnectResponse.destroyed, false);
    disconnectResponse.destroy();
    await within(disconnect.done, 'server disconnect cancellation');
    await sleep(25);
    const readsAfterAbort = disconnect.source.reads - disconnect.readsAtAbort;
    assert.equal(disconnect.closeSeen, true, 'HTTP response close was not observed');
    assert.equal(disconnect.disconnect, true, 'server did not detect the socket disconnect');
    assert.equal(disconnect.controller.signal.aborted, true, 'disconnect did not propagate abort');
    assert.ok(disconnect.readsAtAbort > 0 && disconnect.readsAtAbort < TOTAL / 2);
    assert.equal(readsAfterAbort, 0, 'database reads continued after HTTP disconnect');
    assert.equal(disconnect.source.destroyed, true);
    assert.equal(disconnect.res.destroyed, true);
    assert.match(disconnect.outcome, /^failed:/);
    assert.equal(activePipelines, 0);

    // Cancel an in-flight HTTP response with the socket still connected. A pipeline
    // that ignores the supplied AbortSignal will continue reading and fail here.
    const {response: cancellationResponse} = await open('/cancel');
    const cancellation = records.get('/cancel');
    assert.ok(cancellation);
    assert.equal(cancellationResponse.statusCode, 200);
    assert.equal(cancellationResponse.destroyed, false);
    assert.equal(cancellation.closeSeen, false, 'connection closed before independent abort');
    assert.equal(cancellation.res.writableFinished, false);
    const readsAtCancellation = cancellation.source.reads;
    assert.ok(readsAtCancellation > 0 && readsAtCancellation < TOTAL / 2);
    const abortReason = new Error('server-request-canceled');
    cancellation.controller.abort(abortReason);
    await within(cancellation.done, 'HTTP server-side cancellation', 2000);
    await sleep(25);
    const readsAfterCancellation = cancellation.source.reads - readsAtCancellation;
    assert.equal(cancellation.controller.signal.reason, abortReason);
    assert.equal(readsAfterCancellation, 0, 'source reads continued after live HTTP cancellation');
    assert.equal(cancellation.source.destroyed, true);
    assert.equal(cancellation.res.destroyed, true);
    assert.match(cancellation.outcome, /^failed:/);
    cancellationResponse.destroy();
    assert.equal(activePipelines, 0);

    const emptyFinished = await checkErrors();
    await within(new Promise((resolve, reject) => {
      server.close(error => error ? reject(error) : resolve());
    }), 'HTTP server shutdown');
    const openConnections = await within(new Promise((resolve, reject) => {
      server.getConnections((error, count) => error ? reject(error) : resolve(count));
    }), 'connection count');
    assert.equal(openConnections, 0);
    assert.equal(activePipelines, 0);
    assert.equal(slow.res.writableLength, 0);
    console.log('KORY_NODE_HTTP_PROBE=' + JSON.stringify({
      runtime: {nodeVersion: process.version, moduleMode: 'esm'},
      backpressure: {transport: 'http', method: 'observed', totalRows: TOTAL, clientPaused: true,
        readsWhilePaused, bufferedBytes, falseWritesWhilePaused, receivedBytes},
      abort: {transport: 'http', method: 'observed', socketClosed: disconnect.closeSeen,
        signalAborted: disconnect.controller.signal.aborted, readsAtAbort: disconnect.readsAtAbort,
        readsAfterAbort, sourceDestroyed: disconnect.source.destroyed,
        destinationDestroyed: disconnect.res.destroyed},
      cancellation: {transport: 'http', method: 'observed', abortedWithOpenSocket: true,
        signalAborted: cancellation.controller.signal.aborted, readsAtCancellation,
        readsAfterCancellation, sourceDestroyed: cancellation.source.destroyed,
        destinationDestroyed: cancellation.res.destroyed},
      shutdown: {method: 'observed', cleanFinish: slow.res.writableFinished && emptyFinished,
        pendingWrites: slow.res.writableLength, activePipelines, openConnections},
      errors: {transform: true, database: true, destination: true, empty: true},
    }));
  } finally {
    agent.destroy();
    server.closeAllConnections();
    if (server.listening) server.close();
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
`;

function runNodeStreamProbe(root: string): NativeNodeProbe {
  return runNativeNodeProbe(root, 'export', NODE_HTTP_PROBE, 'KORY_NODE_HTTP_PROBE');
}

/** Claim consistency is secondary: only the evaluator's independent live HTTP probe can verify it. */
function hasNodeStreamEvidence(
  root: string,
  probe: NativeNodeProbe,
): {
  bounded: boolean;
  issues: string[];
} {
  const report = nodeObject(readJsonArtifact<unknown>(root, '.kory-eval/node-stream.json'));
  const runtime = nodeObject(report.runtime);
  const measured = nodeObject(report.measurements);
  const pressure = nodeObject(measured.backpressure);
  const abort = nodeObject(measured.abort);
  const cancellation = nodeObject(measured.cancellation);
  const shutdown = nodeObject(measured.shutdown);
  const verification = nodeObject(report.verification);
  const cases = nodeObject(verification.cases);
  const hierarchy = nodeObject(report.hierarchy);
  const observedPressure = nodeObject(probe.receipt?.backpressure);
  const observedAbort = nodeObject(probe.receipt?.abort);
  const observedCancellation = nodeObject(probe.receipt?.cancellation);
  const observedShutdown = nodeObject(probe.receipt?.shutdown);
  const packageSettings = nodeObject(readJsonArtifact<unknown>(root, 'package.json'));
  // Evaluate every gate so a flaky HTTP counter or a fabricated report has a
  // precise rejection reason. No gate is skipped after an earlier failure.
  const checks: Array<[string, boolean]> = [
    ['native Node probe', probe.passed],
    [
      `Node version (claimed ${String(runtime.nodeVersion)}; actual ${String(probe.nodeVersion)})`,
      runtime.nodeVersion === probe.nodeVersion,
    ],
    ['ESM module mode', runtime.moduleMode === 'esm' && packageSettings.type === 'module'],
    [
      'executed test command',
      typeof verification.command === 'string' &&
        /\b(?:bun|node|npm|pnpm)\b.*\b(?:test|probe|verify)\b/iu.test(verification.command),
    ],
    [
      'all HTTP and failure regressions',
      [
        'slowClient',
        'disconnect',
        'serverCancellation',
        'transformError',
        'databaseError',
        'destinationError',
        'empty',
        'shutdown',
      ].every((key) => cases[key] === 'pass'),
    ],
    [
      'real paused HTTP client',
      pressure.transport === 'http' &&
        pressure.method === 'measured' &&
        pressure.clientPaused === true &&
        pressure.totalRows === observedPressure.totalRows,
    ],
    [
      'bounded paused reads',
      nodeCount(pressure.readsWhilePaused, 1) &&
        pressure.readsWhilePaused < (pressure.totalRows as number) / 2,
    ],
    [
      `readsWhilePaused (claimed ${String(pressure.readsWhilePaused)}; observed ${String(observedPressure.readsWhilePaused)})`,
      closeToObserved(pressure.readsWhilePaused, observedPressure.readsWhilePaused, 100),
    ],
    ['buffered HTTP bytes observed', nodeCount(pressure.bufferedBytes, 1)],
    [
      `bufferedBytes (claimed ${String(pressure.bufferedBytes)}; observed ${String(observedPressure.bufferedBytes)})`,
      closeToObserved(pressure.bufferedBytes, observedPressure.bufferedBytes, 131_072),
    ],
    ['HTTP writes returning false', nodeCount(pressure.falseWritesWhilePaused, 1)],
    [
      `falseWritesWhilePaused (claimed ${String(pressure.falseWritesWhilePaused)}; observed ${String(observedPressure.falseWritesWhilePaused)})`,
      closeToObserved(
        pressure.falseWritesWhilePaused,
        observedPressure.falseWritesWhilePaused,
        150,
      ),
    ],
    [
      'received HTTP response byte count',
      nodeCount(pressure.receivedBytes, 1) &&
        pressure.receivedBytes === observedPressure.receivedBytes,
    ],
    [
      'HTTP disconnect and propagated AbortSignal',
      abort.transport === 'http' &&
        abort.method === 'measured' &&
        abort.socketClosed === true &&
        abort.signalAborted === true,
    ],
    [
      'bounded reads before disconnect',
      nodeCount(abort.readsAtAbort, 1) && abort.readsAtAbort < (pressure.totalRows as number) / 2,
    ],
    [
      `readsAtAbort (claimed ${String(abort.readsAtAbort)}; observed ${String(observedAbort.readsAtAbort)})`,
      closeToObserved(abort.readsAtAbort, observedAbort.readsAtAbort, 100),
    ],
    [
      'disconnect stopped reads and destroyed streams',
      abort.readsAfterAbort === 0 &&
        abort.sourceDestroyed === true &&
        abort.destinationDestroyed === true,
    ],
    [
      'cancellation with live HTTP socket',
      cancellation.transport === 'http' &&
        cancellation.method === 'measured' &&
        cancellation.abortedWithOpenSocket === true &&
        cancellation.signalAborted === true,
    ],
    [
      'bounded reads before cancellation',
      nodeCount(cancellation.readsAtCancellation, 1) &&
        cancellation.readsAtCancellation < (pressure.totalRows as number) / 2,
    ],
    [
      `readsAtCancellation (claimed ${String(cancellation.readsAtCancellation)}; observed ${String(observedCancellation.readsAtCancellation)})`,
      closeToObserved(
        cancellation.readsAtCancellation,
        observedCancellation.readsAtCancellation,
        100,
      ),
    ],
    [
      'cancellation stopped reads and destroyed streams',
      cancellation.readsAfterCancellation === 0 &&
        cancellation.sourceDestroyed === true &&
        cancellation.destinationDestroyed === true,
    ],
    [
      'clean shutdown without pending writes, pipelines or connections',
      shutdown.method === 'measured' &&
        shutdown.cleanFinish === true &&
        shutdown.pendingWrites === 0 &&
        shutdown.activePipelines === 0 &&
        shutdown.openConnections === 0,
    ],
    [
      'independent disconnect, cancellation and shutdown',
      observedAbort.socketClosed === true &&
        observedCancellation.abortedWithOpenSocket === true &&
        observedShutdown.cleanFinish === true,
    ],
    [
      'hierarchy',
      hierarchy.broader === 'backend-engineering' &&
        hierarchy.neighbor === 'compiler-runtime-backend',
    ],
  ];
  // The candidate turn may run in a sandbox that forbids loopback listen() (codex
  // read-only turns do). The fixture contract then asks for the HTTP cases to be
  // reported as unavailable with the preserved probe log instead of invented
  // counters, and the evaluator's own native probe (run outside that sandbox)
  // supplies the measured HTTP evidence. Accepting that path is not a waiver: the
  // independent probe gate above still has to pass, and a report that claims HTTP
  // execution it did not perform is still rejected.
  let sandboxUnavailable = false;
  try {
    const log = readFileSync(join(root, '.kory-eval/node-stream-probe.log'), 'utf8');
    sandboxUnavailable = /listen EPERM|EPERM: operation not permitted/iu.test(log);
  } catch {
    sandboxUnavailable = false;
  }
  const httpReportGate = (label: string) =>
    /HTTP|paused|bufferedBytes|falseWrites|readsAt|reads before|stopped reads|cancellation|abort|shutdown|disconnect/iu.test(
      label,
    );
  const effective = sandboxUnavailable
    ? checks.filter(([label]) => !httpReportGate(label))
    : checks;
  if (sandboxUnavailable)
    effective.push(
      [
        'HTTP measurements reported unavailable instead of fabricated',
        pressure.method === 'unavailable' &&
          abort.method === 'unavailable' &&
          cancellation.method === 'unavailable' &&
          shutdown.method === 'unavailable',
      ],
      [
        'non-HTTP regressions executed',
        ['transformError', 'databaseError', 'destinationError', 'empty'].every(
          (key) => cases[key] === 'pass',
        ),
      ],
    );
  const issues = effective.filter(([, okay]) => !okay).map(([label]) => label);
  return { bounded: issues.length === 0, issues };
}

const nodeStreamMaterializer: SkillEvalFixtureMaterializer = {
  id: 'nodejs-runtime/stream-backpressure-abort@4',
  matches: (s) => s.id === NODE_STREAM,
  materialize: (d) => {
    writeFixtureFile(d, 'package.json', packageJson('kory-eval-node-stream'));
    writeFixtureFile(d, 'src/export.ts', NODE_STREAM_SOURCE);
    writeFixtureFile(d, 'scripts/verify-runtime.mjs', NODE_HTTP_PROBE);
    writeFixtureFile(d, 'scripts/collect-evidence.mjs', NODE_PUBLIC_EVIDENCE_COLLECTOR);
    writeFixtureFile(
      d,
      'tests/export.test.ts',
      `import{expect,test}from'bun:test';import{Readable,Writable}from'node:stream';import{exportCsv}from'../src/export';test('empty',async()=>{let out='';await exportCsv(Readable.from([]),new Writable({write(c,_e,cb){out+=c.toString();cb();}}),new AbortController().signal);expect(out).toBe('');});\n`,
    );
    writeFixtureFile(
      d,
      'README.md',
      `# Node stream backpressure/abort fixture

Repair \`exportCsv(source, destination, signal)\` with supported Node stream/AbortSignal lifecycle. Keep the CSV transform in the data path, including its \`row.fail\` error. Backpressure must propagate from destination to source so database rows cannot outrun bounded stream buffers. Client/request abort and destination close must stop/destroy the source and destination and cease external reads. Transform/database/destination errors propagate once; empty result and clean shutdown complete normally.

Use standard stream APIs (for example \`node:stream/promises\` \`pipeline(source, csvTransform(), destination, {signal})\`) rather than undocumented internals. Add executed tests for slow client, disconnect, independent server cancellation, transform error, database error, destination error, empty result and shutdown. Exercise a real loopback Node HTTP server and client: send a large response while the client pauses its IncomingMessage socket, then resume and verify the complete payload. Measure \`ServerResponse.write()\` returning false, the server's buffered bytes and bounded database reads *while the HTTP client is paused*. Disconnect a second HTTP client mid-response; verify the server detects socket closure, aborts the export, destroys both streams and stops new reads. Abort a third live HTTP response while the socket is still connected; verify the cancellation signal tears down the source and destination without new reads. Verify no active pipelines or open HTTP connections remain after shutdown.

Run \`node scripts/collect-evidence.mjs stream\` after fixing the export. It executes Bun regressions, builds native Node ESM, and runs the included real HTTP probe; \`.kory-eval/node-stream-probe.log\` preserves that actual output. Only an executed, passing probe creates a measured report. Record the *actual* \`node --version\` and ESM mode from \`package.json\`. If the candidate sandbox refuses loopback \`listen()\` with \`EPERM\`, preserve the log and report those HTTP cases **unavailable**: the collector cannot certify them, even if native Node independently passes in the evaluator's separate environment. The unavailable report keeps the runtime, hierarchy and executed non-HTTP cases, sets \`measurements.backpressure\`, \`measurements.abort\`, \`measurements.cancellation\` and \`measurements.shutdown\` to \`{"transport": "http", "method": "unavailable"}\` with no invented counters, and marks the HTTP-only cases \`slowClient\`, \`disconnect\` and \`serverCancellation\` as \`"unavailable"\` in \`verification.cases\` while the in-memory cases stay \`"pass"\`. Writing fabricated HTTP numbers instead is rejected. The evaluator runs its own native probe outside that sandbox, so an honest unavailable report is accepted when that independent measurement passes. Do not copy an independent grader's measurements into this report. Bun and in-memory Writable tests establish only their actual boundary.

The collector writes \`.kory-eval/node-stream.json\` with actual observed HTTP counters only after every check passes. Required shape (the collector replaces each placeholder with an observed integer):

\`\`\`json
{
  "runtime": {"nodeVersion": "vX.Y.Z", "moduleMode": "esm"},
  "measurements": {
    "backpressure": {"transport": "http", "method": "measured", "totalRows": 640, "clientPaused": true, "readsWhilePaused": "<observed>", "bufferedBytes": "<observed>", "falseWritesWhilePaused": "<observed>", "receivedBytes": "<observed>"},
    "abort": {"transport": "http", "method": "measured", "socketClosed": true, "signalAborted": true, "readsAtAbort": "<observed>", "readsAfterAbort": 0, "sourceDestroyed": true, "destinationDestroyed": true},
    "cancellation": {"transport": "http", "method": "measured", "abortedWithOpenSocket": true, "signalAborted": true, "readsAtCancellation": "<observed>", "readsAfterCancellation": 0, "sourceDestroyed": true, "destinationDestroyed": true},
    "shutdown": {"method": "measured", "cleanFinish": true, "pendingWrites": 0, "activePipelines": 0, "openConnections": 0}
  },
  "verification": {"command": "bun test", "cases": {"slowClient": "pass", "disconnect": "pass", "serverCancellation": "pass", "transformError": "pass", "databaseError": "pass", "destinationError": "pass", "empty": "pass", "shutdown": "pass"}},
  "hierarchy": {"broader": "backend-engineering", "neighbor": "compiler-runtime-backend"}
}
\`\`\`

The \`<observed>\` strings are invalid placeholders; replace them with recorded integer counters. All cases marked \`pass\` must actually be executed. Record any unavailable or synthetic checks as such outside the measured fields. The evaluator independently verifies streamed response bytes, the bounded paused producer, HTTP socket closure, live-socket cancellation propagation, error handling and clean shutdown before accepting the report.
`,
    );
  },
};
const nodeStreamScorer: SkillEvalDeterministicScorer = {
  id: 'nodejs-runtime/stream-backpressure-abort-scorer@4',
  scenarioIds: [NODE_STREAM],
  score: ({ workingDirectory }) => {
    const hidden = runHiddenBunTest(
      workingDirectory,
      `import{expect,test}from'bun:test';import{Readable,Writable}from'node:stream';import{exportCsv}from'../src/export';
class Rows extends Readable{reads=0;destroyedObserved=false;constructor(){super({highWaterMark:2});} _read(){this.reads++;if(this.reads<=50)this.push('row'+this.reads);else this.push(null);} _destroy(err:any,cb:any){this.destroyedObserved=true;cb(err);}}
test('hidden: abort stops source rather than continuing DB reads',async()=>{const src=new Rows(),c=new AbortController();let writes=0;const dest=new Writable({highWaterMark:1,write(_c,_e,cb){writes++;if(writes===1)c.abort(new Error('client-gone'));setTimeout(cb,1);}});await expect(exportCsv(src,dest,c.signal)).rejects.toThrow();expect(src.destroyedObserved||src.destroyed).toBe(true);expect(src.reads).toBeLessThan(50);});
test('hidden: source/destination errors reject once and empty completes',async()=>{const bad=Readable.from((async function*(){yield 'a';throw new Error('db-error')})());await expect(exportCsv(bad,new Writable({write(_c,_e,cb){cb();}}),new AbortController().signal)).rejects.toThrow('db-error');let out='';await exportCsv(Readable.from([]),new Writable({write(c,_e,cb){out+=c;cb();}}),new AbortController().signal);expect(out).toBe('');});
`,
    );
    const reg = hasRegressionText(workingDirectory, [
      /slow|backpressure|buffer/iu,
      /abort|disconnect/iu,
      /database|transform|error/iu,
    ]);
    const nativeNode = runNodeStreamProbe(workingDirectory);
    const reportCheck = hasNodeStreamEvidence(workingDirectory, nativeNode);
    const bounded = reportCheck.bounded;
    const verified = hidden.passed && nativeNode.passed;
    const passed = verified && reg && bounded;
    return {
      passed,
      quality: passed ? 1 : verified && reg ? 0.85 : verified ? 0.6 : 0,
      verification: verified ? 1 : 0,
      integrityFailure: false,
      evidence: [
        `stream abort/error behavior: ${hidden.passed ? 'pass' : 'fail'}`,
        `native Node HTTP backpressure/disconnect/errors: ${nativeNode.passed ? 'pass' : 'fail'}`,
        `backpressure/error regressions: ${reg ? 'present' : 'missing'}`,
        `measured runtime evidence: ${bounded ? 'bounded' : 'missing or invalid'}`,
        ...(!bounded ? [`HTTP report rejected: ${reportCheck.issues.slice(0, 8).join('; ')}`] : []),
        nativeNode.evidence,
        hidden.evidence,
      ],
    };
  },
};

const PY_ASYNC_SOURCE = `import asyncio
from collections.abc import Awaitable, Callable
from typing import TypeVar

T = TypeVar("T")

async def fetch_all(urls: list[str], fetch_one: Callable[[str], Awaitable[T]], limit: int = 3) -> list[T]:
    # BUG: creates every task immediately; returning on one failure leaves sibling work running.
    tasks = [asyncio.create_task(fetch_one(url)) for url in urls]
    results: list[T] = []
    for task in tasks:
        results.append(await task)
    return results
`;
const pyAsyncMaterializer: SkillEvalFixtureMaterializer = {
  id: 'python-engineering/structured-async-batch@1',
  matches: (s) => s.id === PY_ASYNC,
  materialize: (d) => {
    writeFixtureFile(d, 'package.json', packageJson('kory-eval-python-async'));
    writeFixtureFile(d, 'src/__init__.py', '');
    writeFixtureFile(d, 'src/fetcher.py', PY_ASYNC_SOURCE);
    writeFixtureFile(d, 'tests/__init__.py', '');
    writeFixtureFile(
      d,
      'tests/test_fetcher.py',
      `import unittest\nfrom src.fetcher import fetch_all\nclass T(unittest.IsolatedAsyncioTestCase):\n async def test_order(self):\n  async def f(x): return x.upper()\n  self.assertEqual(await fetch_all(['a','b'],f,1),['A','B'])\n`,
    );
    writeFixtureFile(
      d,
      'README.md',
      `# Python asyncio structured-lifetime fixture

Repair \`fetch_all\` with bounded concurrency while preserving input result order. All spawned work must live inside one structured lifetime: success returns all results; the first failure/caller cancellation cancels and awaits siblings before returning; externally imposed timeout leaves no orphan tasks. Do not switch to threads.

Add all-success, concurrency-limit, one-failure, caller-cancel and timeout regressions. Write \`.kory-eval/python-async.json\` with exact Python version/interpreter/packaging/async model, static-check availability, focused unittest evidence, no-pending-task/resource proof, broader implementation and C/C++ neighbor boundary.
`,
    );
  },
};
const pyAsyncScorer: SkillEvalDeterministicScorer = {
  id: 'python-engineering/structured-async-batch-scorer@2',
  scenarioIds: [PY_ASYNC],
  score: ({ workingDirectory }) => {
    const hidden = runHiddenPython(
      workingDirectory,
      `import asyncio, unittest
from src.fetcher import fetch_all
class T(unittest.IsolatedAsyncioTestCase):
 async def test_bound_order(self):
  active=0; peak=0
  async def f(x):
   nonlocal active,peak
   active+=1;peak=max(peak,active);await asyncio.sleep(0);active-=1;return x
  self.assertEqual(await fetch_all(['a','b','c','d'],f,2),['a','b','c','d']);self.assertLessEqual(peak,2)
 async def test_failure_cleans_siblings(self):
  stopped=asyncio.Event()
  async def f(x):
   if x=='bad': raise RuntimeError('boom')
   try: await asyncio.Event().wait()
   finally: stopped.set()
  with self.assertRaises(RuntimeError): await fetch_all(['bad','slow'],f,2)
  await asyncio.wait_for(stopped.wait(),0.5)
  self.assertFalse([t for t in asyncio.all_tasks() if t is not asyncio.current_task() and not t.done()])
 async def test_caller_cancel_cleans_children(self):
  started=asyncio.Event();stopped=asyncio.Event()
  async def f(_):
   started.set()
   try: await asyncio.Event().wait()
   finally: stopped.set()
  task=asyncio.create_task(fetch_all(['a','b'],f,1))
  await asyncio.wait_for(started.wait(),0.5)
  task.cancel()
  with self.assertRaises(asyncio.CancelledError): await task
  self.assertTrue(stopped.is_set())
  self.assertFalse([t for t in asyncio.all_tasks() if t is not asyncio.current_task() and not t.done()])
 async def test_timeout_cleans_children(self):
  started=asyncio.Event();stopped=asyncio.Event()
  async def f(_):
   started.set()
   try: await asyncio.Event().wait()
   finally: stopped.set()
  task=asyncio.create_task(fetch_all(['a'],f,1))
  await asyncio.wait_for(started.wait(),0.5)
  with self.assertRaises(asyncio.TimeoutError): await asyncio.wait_for(task,0.01)
  self.assertTrue(stopped.is_set())
  self.assertFalse([t for t in asyncio.all_tasks() if t is not asyncio.current_task() and not t.done()])
`,
    );
    const reg =
      existsSync(join(workingDirectory, 'tests/test_fetcher.py')) &&
      /fail|cancel|timeout|concurr|limit/i.test(
        readFileSync(join(workingDirectory, 'tests/test_fetcher.py'), 'utf8'),
      );
    const report = artifactText(workingDirectory, '.kory-eval/python-async.json');
    const bounded =
      Boolean(report.artifact) &&
      /python/u.test(report.text) &&
      /async/u.test(report.text) &&
      /implementation/u.test(report.text) &&
      /c\/c\+\+|c[-_]cpp|c\s+(?:or|and)\s+c\+\+/u.test(report.text);
    const passed = hidden.passed && reg && bounded;
    return {
      passed,
      quality: passed ? 1 : hidden.passed && reg ? 0.85 : hidden.passed ? 0.6 : 0,
      verification: hidden.passed ? 1 : 0,
      integrityFailure: false,
      evidence: [
        `Python structured concurrency: ${hidden.passed ? 'pass' : 'fail'}`,
        `failure/cancel regressions: ${reg ? 'present' : 'missing'}`,
        `runtime/hierarchy evidence: ${bounded ? 'bounded' : 'missing'}`,
        hidden.evidence,
      ],
    };
  },
};

const PY_CONFIG_SOURCE = `from dataclasses import dataclass
from typing import Any

_SHARED = {"headers": {}, "retries": []}

@dataclass
class Config:
    name: str
    endpoint: str | None
    options: dict[str, Any]

    @classmethod
    def from_json(cls, value: dict[str, Any]) -> "Config":
        # BUG: unknown keys are dropped and all instances reuse the same nested mutable object.
        return cls(name=str(value.get("name", "default")), endpoint=value.get("endpoint"), options=_SHARED)

    def to_json(self) -> dict[str, Any]:
        return {"name": self.name, "endpoint": self.endpoint, "options": self.options}
`;
const pyConfigMaterializer: SkillEvalFixtureMaterializer = {
  id: 'python-engineering/config-boundary-ownership@1',
  matches: (s) => s.id === PY_CONFIG,
  materialize: (d) => {
    writeFixtureFile(d, 'package.json', packageJson('kory-eval-python-config'));
    writeFixtureFile(d, 'src/__init__.py', '');
    writeFixtureFile(d, 'src/config.py', PY_CONFIG_SOURCE);
    writeFixtureFile(d, 'tests/__init__.py', '');
    writeFixtureFile(
      d,
      'tests/test_config.py',
      `import unittest\nfrom src.config import Config\nclass T(unittest.TestCase):\n def test_old_shape(self): self.assertEqual(Config.from_json({'name':'a'}).to_json()['name'],'a')\n`,
    );
    writeFixtureFile(
      d,
      'evidence/old-config.json',
      '{"name":"legacy","endpoint":null,"options":{"headers":{},"retries":[]}}\n',
    );
    writeFixtureFile(
      d,
      'README.md',
      `# Python configuration ownership/validation fixture

Repair \`Config.from_json\` so nested mutable state is owned independently by each instance and external JSON validates allowed keys/types. Supported keys are exactly \`name\`, optional/nullable \`endpoint\`, and optional \`options\` with \`headers\` mapping and \`retries\` list. Missing optional values keep the documented defaults; explicit null endpoint remains null. Unknown top-level/nested keys or wrong types raise \`ValueError\` rather than disappearing silently.

Preserve serialized shape and the supplied old corpus. Add two-instance mutation, missing/null, unknown-key, nested-type and round-trip regressions. Write \`.kory-eval/python-config.json\` with supported Python/interpreter/type-check policy and broader implementation/C# neighbor boundary.
`,
    );
  },
};
const pyConfigScorer: SkillEvalDeterministicScorer = {
  id: 'python-engineering/config-boundary-ownership-scorer@2',
  scenarioIds: [PY_CONFIG],
  score: ({ workingDirectory }) => {
    const hidden = runHiddenPython(
      workingDirectory,
      `import json,unittest
from src.config import Config
class T(unittest.TestCase):
 def test_instance_ownership(self):
  a=Config.from_json({'name':'a','options':{'headers':{},'retries':[]}});b=Config.from_json({'name':'b','options':{'headers':{},'retries':[]}});a.options['headers']['x']='1';a.options['retries'].append('r');self.assertEqual(b.options,{'headers':{},'retries':[]})
 def test_missing_null_unknown(self):
  self.assertIsNone(Config.from_json({'name':'a','endpoint':None}).endpoint)
  with self.assertRaises(ValueError): Config.from_json({'name':'a','typo':1})
  with self.assertRaises(ValueError): Config.from_json({'name':'a','options':{'headers':{},'retries':[],'typo':1}})
 def test_round_trip_old(self):
  with open('evidence/old-config.json',encoding='utf-8') as corpus: raw=json.load(corpus)
  self.assertEqual(Config.from_json(raw).to_json(),raw)
`,
    );
    const corpus =
      readFileSync(join(workingDirectory, 'evidence/old-config.json'), 'utf8') ===
      '{"name":"legacy","endpoint":null,"options":{"headers":{},"retries":[]}}\n';
    const reg =
      existsSync(join(workingDirectory, 'tests/test_config.py')) &&
      /instance|unknown|round|mutation|nested/i.test(
        readFileSync(join(workingDirectory, 'tests/test_config.py'), 'utf8'),
      );
    const report = artifactText(workingDirectory, '.kory-eval/python-config.json');
    const bounded =
      Boolean(report.artifact) &&
      /python/u.test(report.text) &&
      /type|typing/u.test(report.text) &&
      /implementation/u.test(report.text) &&
      /c#|csharp|dotnet|\.net/u.test(report.text);
    const passed = hidden.passed && corpus && reg && bounded;
    return {
      passed,
      quality: passed ? 1 : hidden.passed && corpus ? 0.85 : hidden.passed ? 0.6 : 0,
      verification: hidden.passed ? 1 : 0,
      integrityFailure: !corpus,
      evidence: [
        `Python ownership/validation: ${hidden.passed ? 'pass' : 'fail'}`,
        `old corpus preserved: ${corpus ? 'yes' : 'no'}`,
        `regressions/hierarchy: ${reg && bounded ? 'present' : 'missing'}`,
        hidden.evidence,
      ],
    };
  },
};

export const LANGUAGE_RUNTIME_SKILL_EVAL_MATERIALIZERS: readonly SkillEvalFixtureMaterializer[] = [
  webhookMaterializer,
  timeoutMaterializer,
  nodeReloadMaterializer,
  nodeStreamMaterializer,
  pyAsyncMaterializer,
  pyConfigMaterializer,
];
export const LANGUAGE_RUNTIME_SKILL_EVAL_SCORERS: readonly SkillEvalDeterministicScorer[] = [
  webhookScorer,
  timeoutScorer,
  nodeReloadScorer,
  nodeStreamScorer,
  pyAsyncScorer,
  pyConfigScorer,
];
