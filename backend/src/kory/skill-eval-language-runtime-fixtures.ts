import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
  }
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
  id: 'typescript-javascript-engineering/runtime-webhook-validation-scorer@2',
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
    const passed = hidden.passed && typecheck.passed && !unsafe && regression && bounded;
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
  id: 'typescript-javascript-engineering/abortable-timeout-lifecycle@1',
  matches: (scenario) => scenario.id === TS_TIMEOUT,
  materialize: (destination) => {
    writeFixtureFile(destination, 'package.json', packageJson('kory-eval-ts-timeout'));
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

Repair \`withTimeout\` without changing its signature. Exactly one terminal outcome owns cleanup. The injected timer must be cleared on success, timeout, caller abort, and underlying rejection. Timeout and caller cancellation propagate to the operation's AbortSignal. Preserve the original underlying rejection object; caller abort should preserve its reason when available. Late operation work must observe abort and cannot mutate after timeout/cancel.

Add deterministic regressions using an injected timer for success, timeout, caller abort, underlying rejection, simultaneous boundary and no timer/listener leak. Write \`.kory-eval/typescript-timeout.json\` with JS runtime lifecycle vs TS type guarantees and hierarchy evidence (broader implementation; C#/.NET adjacent).
`,
    );
  },
};

const timeoutScorer: SkillEvalDeterministicScorer = {
  id: 'typescript-javascript-engineering/abortable-timeout-lifecycle-scorer@1',
  scenarioIds: [TS_TIMEOUT],
  score: ({ workingDirectory }) => {
    const hidden = runHiddenBunTest(
      workingDirectory,
      `import{expect,test}from'bun:test';import{withTimeout,type TimerRuntime}from'../src/timeout';class ManualTimer implements TimerRuntime{callbacks=new Map<number,()=>void>();next=1;clears=0;set(cb:()=>void){const id=this.next++;this.callbacks.set(id,cb);return id;}clear(h:unknown){if(this.callbacks.delete(Number(h)))this.clears++;}fire(){for(const [id,cb] of [...this.callbacks]){this.callbacks.delete(id);cb();}}active(){return this.callbacks.size;}}
test('hidden: success clears timer',async()=>{const t=new ManualTimer();expect(await withTimeout(async()=>9,10,undefined,t)).toBe(9);expect(t.active()).toBe(0);expect(t.clears).toBe(1);});
test('hidden: timeout aborts underlying and clears timer',async()=>{const t=new ManualTimer();let aborted=false;const p=withTimeout(async signal=>new Promise<number>((_,reject)=>signal.addEventListener('abort',()=>{aborted=true;reject(signal.reason);},{once:true})),10,undefined,t);t.fire();await expect(p).rejects.toThrow(/timeout/i);expect(aborted).toBe(true);expect(t.active()).toBe(0);});
test('hidden: caller abort propagates and preserves reason',async()=>{const t=new ManualTimer(),caller=new AbortController(),reason=new Error('caller-stop');let seen:unknown;const p=withTimeout(async signal=>new Promise<number>((_,reject)=>signal.addEventListener('abort',()=>{seen=signal.reason;reject(signal.reason);},{once:true})),10,caller.signal,t);caller.abort(reason);await Promise.resolve();expect(seen).toBe(reason);await expect(p).rejects.toBe(reason);expect(t.active()).toBe(0);});
test('hidden: underlying rejection identity preserved',async()=>{const t=new ManualTimer(),err=new Error('source');await expect(withTimeout(async()=>{throw err},10,undefined,t)).rejects.toBe(err);expect(t.active()).toBe(0);});
`,
    );
    const regression = hasRegressionText(workingDirectory, [
      /caller|abort/iu,
      /underlying|reject|source/iu,
      /timer|cleanup/iu,
    ]);
    const report = artifactText(workingDirectory, '.kory-eval/typescript-timeout.json');
    const bounded =
      Boolean(report.artifact) &&
      /runtime/u.test(report.text) &&
      /implementation/u.test(report.text) &&
      /c#|dotnet|\.net/u.test(report.text);
    const passed = hidden.passed && regression && bounded;
    return {
      passed,
      quality: passed ? 1 : hidden.passed && regression ? 0.85 : hidden.passed ? 0.6 : 0,
      verification: hidden.passed ? 1 : 0,
      integrityFailure: false,
      evidence: [
        `terminal cleanup/cancellation: ${hidden.passed ? 'pass' : 'fail'}`,
        `lifecycle regressions: ${regression ? 'present' : 'missing'}`,
        `hierarchy evidence: ${bounded ? 'bounded' : 'missing'}`,
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
const nodeReloadMaterializer: SkillEvalFixtureMaterializer = {
  id: 'nodejs-runtime/config-reload-offload@1',
  matches: (s) => s.id === NODE_RELOAD,
  materialize: (d) => {
    writeFixtureFile(d, 'package.json', packageJson('kory-eval-node-reload'));
    writeFixtureFile(d, 'src/config-store.ts', NODE_RELOAD_SOURCE);
    writeFixtureFile(
      d,
      'tests/config-store.test.ts',
      `import{expect,test}from'bun:test';import{ConfigStore}from'../src/config-store';test('initial config',()=>expect(new ConfigStore().read().version).toBe(1));\n`,
    );
    writeFixtureFile(
      d,
      'README.md',
      `# Node.js config reload runtime fixture

Use the supplied \`offload(raw, signal)\` boundary for expensive parse/transform work; do not add worker threads merely by assumption. The main event-loop path should await that evidence-backed offload while reads continue to see the prior complete config. Atomically swap only after the offload returns a fully validated config. Malformed/offload failure/cancellation leaves the old config visible.

Add concurrent-read, malformed, abort and atomic-swap regressions. Write \`.kory-eval/node-reload.json\` with exact Node version/module mode, measured/synthetic event-loop-delay and before/after latency evidence, memory, shutdown/cancellation checks, selected offload rationale, broader backend-engineering and Bun/Deno neighbor boundary. If worker-thread/process profiling was not actually run, label it unavailable.
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
    const report = artifactText(workingDirectory, '.kory-eval/node-reload.json');
    const bounded =
      Boolean(report.artifact) &&
      /node/u.test(report.text) &&
      /module/u.test(report.text) &&
      /event.?loop/u.test(report.text) &&
      /latency|p99/u.test(report.text) &&
      /backend-engineering/u.test(report.text) &&
      /bun|deno/u.test(report.text);
    const passed = hidden.passed && reg && bounded;
    return {
      passed,
      quality: passed ? 1 : hidden.passed && reg ? 0.8 : hidden.passed ? 0.6 : 0,
      verification: hidden.passed ? 1 : 0,
      integrityFailure: false,
      evidence: [
        `offload/atomic reload behavior: ${hidden.passed ? 'pass' : 'fail'}`,
        `failure/cancel regressions: ${reg ? 'present' : 'missing'}`,
        `runtime measurement boundary: ${bounded ? 'bounded' : 'missing'}`,
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
const nodeStreamMaterializer: SkillEvalFixtureMaterializer = {
  id: 'nodejs-runtime/stream-backpressure-abort@1',
  matches: (s) => s.id === NODE_STREAM,
  materialize: (d) => {
    writeFixtureFile(d, 'package.json', packageJson('kory-eval-node-stream'));
    writeFixtureFile(d, 'src/export.ts', NODE_STREAM_SOURCE);
    writeFixtureFile(
      d,
      'tests/export.test.ts',
      `import{expect,test}from'bun:test';import{Readable,Writable}from'node:stream';import{exportCsv}from'../src/export';test('empty',async()=>{let out='';await exportCsv(Readable.from([]),new Writable({write(c,_e,cb){out+=c.toString();cb();}}),new AbortController().signal);expect(out).toBe('');});\n`,
    );
    writeFixtureFile(
      d,
      'README.md',
      `# Node stream backpressure/abort fixture

Repair \`exportCsv\` with supported Node stream/AbortSignal lifecycle. Backpressure must propagate from destination to source so database rows cannot outrun bounded stream buffers. Client/request abort must stop/destroy the source and destination and cease external reads. Transform/database/destination errors propagate once; empty result and clean shutdown complete normally.

Use standard stream APIs (for example pipeline) rather than undocumented internals. Add slow-client, disconnect, transform error, database error, empty result and shutdown regressions. Write \`.kory-eval/node-stream.json\` with Node version/module mode, peak buffered bytes/rows under the synthetic slow client, abort read-count evidence, active-handle cleanup, broader backend-engineering and compiler-runtime-backend neighbor boundary.
`,
    );
  },
};
const nodeStreamScorer: SkillEvalDeterministicScorer = {
  id: 'nodejs-runtime/stream-backpressure-abort-scorer@1',
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
    const report = artifactText(workingDirectory, '.kory-eval/node-stream.json');
    const bounded =
      Boolean(report.artifact) &&
      /node/u.test(report.text) &&
      /buffer/u.test(report.text) &&
      /abort/u.test(report.text) &&
      /handle|shutdown/u.test(report.text) &&
      /backend-engineering/u.test(report.text) &&
      /compiler-runtime-backend/u.test(report.text);
    const passed = hidden.passed && reg && bounded;
    return {
      passed,
      quality: passed ? 1 : hidden.passed && reg ? 0.85 : hidden.passed ? 0.6 : 0,
      verification: hidden.passed ? 1 : 0,
      integrityFailure: false,
      evidence: [
        `stream abort/error behavior: ${hidden.passed ? 'pass' : 'fail'}`,
        `backpressure/error regressions: ${reg ? 'present' : 'missing'}`,
        `runtime evidence: ${bounded ? 'bounded' : 'missing'}`,
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
  id: 'python-engineering/structured-async-batch-scorer@1',
  scenarioIds: [PY_ASYNC],
  score: ({ workingDirectory }) => {
    const hidden = runHiddenPython(
      workingDirectory,
      `import asyncio, unittest\nfrom src.fetcher import fetch_all\nclass T(unittest.IsolatedAsyncioTestCase):\n async def test_bound_order(self):\n  active=0; peak=0\n  async def f(x):\n   nonlocal active,peak\n   active+=1;peak=max(peak,active);await asyncio.sleep(0);active-=1;return x\n  self.assertEqual(await fetch_all(['a','b','c','d'],f,2),['a','b','c','d']);self.assertLessEqual(peak,2)\n async def test_failure_cleans_siblings(self):\n  stopped=asyncio.Event()\n  async def f(x):\n   if x=='bad': raise RuntimeError('boom')\n   try: await asyncio.Event().wait()\n   finally: stopped.set()\n  with self.assertRaises(RuntimeError): await fetch_all(['bad','slow'],f,2)\n  await asyncio.wait_for(stopped.wait(),0.5)\n  self.assertFalse([t for t in asyncio.all_tasks() if t is not asyncio.current_task() and not t.done()])\n async def test_caller_cancel_cleans_children(self):\n  stopped=asyncio.Event()\n  async def f(_):\n   try: await asyncio.Event().wait()\n   finally: stopped.set()\n  task=asyncio.create_task(fetch_all(['a','b'],f,1));await asyncio.sleep(0);task.cancel()\n  with self.assertRaises(asyncio.CancelledError): await task\n  await asyncio.wait_for(stopped.wait(),0.5)\n`,
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
      /c\/?c\+\+|c-cpp/u.test(report.text);
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
  id: 'python-engineering/config-boundary-ownership-scorer@1',
  scenarioIds: [PY_CONFIG],
  score: ({ workingDirectory }) => {
    const hidden = runHiddenPython(
      workingDirectory,
      `import json,unittest\nfrom src.config import Config\nclass T(unittest.TestCase):\n def test_instance_ownership(self):\n  a=Config.from_json({'name':'a','options':{'headers':{},'retries':[]}});b=Config.from_json({'name':'b','options':{'headers':{},'retries':[]}});a.options['headers']['x']='1';a.options['retries'].append('r');self.assertEqual(b.options,{'headers':{},'retries':[]})\n def test_missing_null_unknown(self):\n  self.assertIsNone(Config.from_json({'name':'a','endpoint':None}).endpoint)\n  with self.assertRaises(ValueError): Config.from_json({'name':'a','typo':1})\n  with self.assertRaises(ValueError): Config.from_json({'name':'a','options':{'headers':{},'retries':[],'typo':1}})\n def test_round_trip_old(self):\n  raw=json.load(open('evidence/old-config.json'));self.assertEqual(Config.from_json(raw).to_json(),raw)\n`,
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
      /type/u.test(report.text) &&
      /implementation/u.test(report.text) &&
      /c#|dotnet|\.net/u.test(report.text);
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
