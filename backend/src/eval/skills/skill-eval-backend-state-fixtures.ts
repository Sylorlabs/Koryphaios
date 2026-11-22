import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type {
  SkillEvalDeterministicScorer,
  SkillEvalFixtureMaterializer,
} from './skill-eval-execution';
import {
  hasRegressionText,
  packageJson,
  readFixtureText,
  readJsonArtifact,
  runCandidateBunTests,
  runHiddenBunTest,
  writeFixtureFile,
} from './skill-eval-fixture-helpers';

const INPROC_QUEUE = 'in-process-backend-full-task-1-individual';
const INPROC_CACHE = 'in-process-backend-full-task-2-individual';
const LOCAL_AUTH = 'local-service-backend-full-task-1-individual';
const LOCAL_JOBS = 'local-service-backend-full-task-2-individual';
const NETWORK_FRAMING = 'network-service-backend-full-task-1-individual';
const NETWORK_DRAIN = 'network-service-backend-full-task-2-individual';
const REALTIME_WS = 'realtime-systems-full-task-1-individual';
const REALTIME_SSE = 'realtime-systems-full-task-2-individual';
const STREAM_WINDOW = 'stream-processing-full-task-1-individual';
const STREAM_CHECKPOINT = 'stream-processing-full-task-2-individual';

function artifactText(root: string, path: string): { artifact: unknown | null; text: string } {
  const artifact = readJsonArtifact<unknown>(root, path);
  return { artifact, text: JSON.stringify(artifact ?? '').toLowerCase() };
}

function verifyAuthoredRegression(
  workingDirectory: string,
  sourcePath: string,
  originalDefectiveSource: string,
): { passed: boolean; evidence: string[] } {
  const repairedSource = readFixtureText(workingDirectory, sourcePath);
  const repaired = runCandidateBunTests(workingDirectory);
  let detectsDefect = false;
  let brokenEvidence = 'Skipped: candidate tests did not pass the repair.';
  if (repaired.completed && repaired.passed) {
    try {
      writeFixtureFile(workingDirectory, sourcePath, originalDefectiveSource);
      const broken = runCandidateBunTests(workingDirectory);
      detectsDefect = broken.completed && !broken.passed;
      brokenEvidence = broken.evidence;
    } finally {
      writeFixtureFile(workingDirectory, sourcePath, repairedSource);
    }
  }
  return {
    passed: repaired.passed && detectsDefect,
    evidence: [
      `candidate tests pass the repair: ${repaired.passed ? 'yes' : 'no'}`,
      `candidate tests reject the original defect: ${detectsDefect ? 'yes' : 'no'}`,
      repaired.evidence,
      brokenEvidence,
    ],
  };
}

const JOB_QUEUE_SOURCE = `export type JobState='queued'|'claimed'|'running'|'done'|'cancelled'|'retry';
export interface Job{id:string;state:JobState;attempts:number;effectCommitted:boolean;availableAt:number;claimOwner?:string}
export interface DurableStore{jobs:Map<string,Job>}
export class LocalJobQueue{
 constructor(private readonly store:DurableStore,private readonly now:()=>number=Date.now){}
 enqueue(id:string){if(!this.store.jobs.has(id))this.store.jobs.set(id,{id,state:'queued',attempts:0,effectCommitted:false,availableAt:this.now()});}
 cancel(id:string){const j=this.store.jobs.get(id);if(j&&['queued','retry'].includes(j.state))j.state='cancelled';}
 claim(worker:string):Job|undefined{const j=[...this.store.jobs.values()].find(x=>(x.state==='queued'||x.state==='retry')&&x.availableAt<=this.now());if(!j)return; // BUG: claim ownership is returned without atomically changing durable state.
 return {...j,claimOwner:worker};}
 begin(id:string,worker:string){const j=this.store.jobs.get(id);if(!j)throw new Error('missing');j.state='running';j.claimOwner=worker;j.attempts++;}
 commitEffect(id:string){const j=this.store.jobs.get(id)!;if(j.effectCommitted)throw new Error('duplicate-effect');j.effectCommitted=true;}
 finish(id:string){const j=this.store.jobs.get(id)!;j.state='done';delete j.claimOwner;}
 transientFailure(id:string,maxAttempts=3){const j=this.store.jobs.get(id)!;j.state=j.attempts<maxAttempts?'retry':'cancelled';delete j.claimOwner;}
 recoverAfterRestart(){for(const j of this.store.jobs.values())if(j.state==='claimed'||j.state==='running')j.state=j.effectCommitted?'done':'retry';}
 snapshot(){return [...this.store.jobs.values()].map(j=>({...j}));}
}
`;
const inprocQueueMaterializer: SkillEvalFixtureMaterializer = {
  id: 'in-process-backend/sqlite-job-queue@2',
  matches: (s) => s.id === INPROC_QUEUE,
  materialize: (d) => {
    writeFixtureFile(d, 'package.json', packageJson('kory-eval-inproc-queue'));
    writeFixtureFile(d, 'src/job-queue.ts', JOB_QUEUE_SOURCE);
    writeFixtureFile(
      d,
      'tests/job-queue.test.ts',
      `import{expect,test}from'bun:test';import{LocalJobQueue}from'../src/job-queue';test('enqueue',()=>{const q=new LocalJobQueue({jobs:new Map()});q.enqueue('a');expect(q.snapshot()[0].state).toBe('queued');});\n`,
    );
    writeFixtureFile(
      d,
      'README.md',
      `# In-process durable job queue fixture

Repair the queue's local durable state transitions. Claim must atomically move one queued/retry job to \`claimed\` with one owner before returning, so two same-process workers cannot claim the same job. Cancellation before execution is terminal. Begin/run/commit/finish boundaries must survive restart: a crash before committed effect becomes retry; a crash after committed effect recovers as done without repeating the logical effect. Transient retries use bounded backoff. Preserve the supplied deterministic \`now\` clock and schedule retry eligibility through \`availableAt\` so backoff can be verified without sleeping.

Keep the architecture explicitly single-process plus local SQLite-equivalent durable store; do not add a broker or distributed consensus. Add concurrent-claim, cancel, crash-before/after-effect, retry-limit and restart regressions. Write \`.kory-eval/inprocess-queue.json\` with ownership/state-transition evidence, host runtime identity, broader backend-engineering and Bun/Deno neighbor boundary.
`,
    );
  },
};
const inprocQueueScorer: SkillEvalDeterministicScorer = {
  id: 'in-process-backend/sqlite-job-queue-scorer@4',
  scenarioIds: [INPROC_QUEUE],
  score: ({ workingDirectory }) => {
    const hidden = runHiddenBunTest(
      workingDirectory,
      `import{expect,test}from'bun:test';import{LocalJobQueue}from'../src/job-queue';
test('hidden: claim is exclusive and cancel-before-run works',()=>{const store={jobs:new Map()};const q=new LocalJobQueue(store);q.enqueue('a');const a=q.claim('w1');const b=q.claim('w2');expect(a?.id).toBe('a');expect(a?.claimOwner).toBe('w1');expect(b).toBeUndefined();q.enqueue('b');q.cancel('b');expect(q.snapshot().find(j=>j.id==='b')?.state).toBe('cancelled');});
test('hidden: restart distinguishes pre/post committed effect',()=>{let now=1000;const store={jobs:new Map()};const q=new LocalJobQueue(store,()=>now);q.enqueue('x');q.claim('w');q.begin('x','w');q.recoverAfterRestart();const retry=q.snapshot()[0];expect(retry.state).toBe('retry');expect(Number.isFinite(retry.availableAt)).toBe(true);expect(retry.availableAt).toBeGreaterThanOrEqual(now);if(retry.availableAt>now){expect(q.claim('too-early')).toBeUndefined();now=retry.availableAt;}expect(q.claim('w2')?.id).toBe('x');q.begin('x','w2');q.commitEffect('x');q.recoverAfterRestart();expect(q.snapshot()[0].state).toBe('done');expect(q.snapshot()[0].effectCommitted).toBe(true);});
test('hidden: transient retry uses bounded backoff and stops at the retry limit',()=>{let now=1000;const store={jobs:new Map()};const q=new LocalJobQueue(store,()=>now);q.enqueue('r');const delays:number[]=[];for(let i=0;i<3;i++){const claimed=q.claim('w');expect(claimed?.id).toBe('r');q.begin('r','w');q.transientFailure('r',3);const job=q.snapshot()[0];if(i<2){expect(job.state).toBe('retry');expect(Number.isFinite(job.availableAt)).toBe(true);expect(job.availableAt).toBeGreaterThan(now);delays.push(job.availableAt-now);expect(q.claim('too-early')).toBeUndefined();now=job.availableAt;}else{expect(job.state).toBe('cancelled');}}expect(delays).toHaveLength(2);expect(delays[1]).toBeGreaterThanOrEqual(delays[0]);});
`,
    );
    const reg = hasRegressionText(workingDirectory, [
      /claim|concurr/iu,
      /restart|crash/iu,
      /retry|cancel/iu,
    ]);
    const authored = verifyAuthoredRegression(
      workingDirectory,
      'src/job-queue.ts',
      JOB_QUEUE_SOURCE,
    );
    const report = artifactText(workingDirectory, '.kory-eval/inprocess-queue.json');
    const bounded =
      Boolean(report.artifact) &&
      /backend-engineering/u.test(report.text) &&
      /bun|deno/u.test(report.text) &&
      /local|sqlite/u.test(report.text) &&
      !/broker|consensus/u.test(
        report.text.replace(/do not add a broker|no broker|without.*broker/gu, ''),
      );
    const passed = hidden.passed && reg && authored.passed && Boolean(report.artifact);
    return {
      passed,
      quality: passed ? 1 : hidden.passed && reg ? 0.85 : hidden.passed ? 0.6 : 0,
      verification: hidden.passed && authored.passed ? 1 : 0,
      integrityFailure: false,
      evidence: [
        `queue ownership/restart behavior: ${hidden.passed ? 'pass' : 'fail'}`,
        `recovery regressions: ${reg ? 'present' : 'missing'}`,
        `boundary evidence: ${bounded ? 'bounded' : 'present but review'}`,
        ...authored.evidence,
        hidden.evidence,
      ],
    };
  },
};

const CACHE_SOURCE = `export interface Entry<T>{value:T;expiresAt:number;staleUntil:number}
export class MetadataCache<T>{private entries=new Map<string,Entry<T>>();constructor(private readonly maxEntries:number,private readonly now:()=>number){}
 async get(key:string,loader:(signal:AbortSignal)=>Promise<T>,ttlMs:number,staleMs:number,signal:AbortSignal,allowStaleOnError=false):Promise<T>{const existing=this.entries.get(key);if(existing&&existing.expiresAt>this.now())return existing.value; // BUG: every miss independently reloads and eviction is absent.
 try{const value=await loader(signal);this.entries.set(key,{value,expiresAt:this.now()+ttlMs,staleUntil:this.now()+ttlMs+staleMs});return value;}catch(error){if(allowStaleOnError&&existing&&existing.staleUntil>=this.now())return existing.value;throw error;}}
 size(){return this.entries.size}}
`;
const inprocCacheMaterializer: SkillEvalFixtureMaterializer = {
  id: 'in-process-backend/cache-refresh-coalescing@2',
  matches: (s) => s.id === INPROC_CACHE,
  materialize: (d) => {
    writeFixtureFile(d, 'package.json', packageJson('kory-eval-inproc-cache'));
    writeFixtureFile(d, 'src/cache.ts', CACHE_SOURCE);
    writeFixtureFile(
      d,
      'tests/cache.test.ts',
      `import{expect,test}from'bun:test';import{MetadataCache}from'../src/cache';test('load',async()=>{const c=new MetadataCache(2,()=>0);expect(await c.get('a',async()=>1,10,0,new AbortController().signal)).toBe(1);});\n`,
    );
    writeFixtureFile(
      d,
      'README.md',
      `# Process-local cache coalescing fixture

Repair the process-local cache without introducing Redis/network state. Concurrent misses/expired reads for one key coalesce behind one refresh. Bound memory to \`maxEntries\` using deterministic eviction. Caller cancellation/timeouts must not cancel a shared refresh merely because one waiter leaves, but abandoned refreshes cannot leak forever even when a loader ignores AbortSignal. A cancelled or timed-out refresh must release its slot, reject abandoned waiters, and prevent late writes. Stale-on-error is served only when explicitly requested and only through \`staleUntil\`.

Add deterministic-clock tests for one-key herd coalescing, tenant churn/eviction, waiter cancellation (including a loader ignoring abort), timeout/recovery, loader error, safe stale window and stale expiry. Write \`.kory-eval/inprocess-cache.json\` with ownership/lifetime model, host-runtime evidence, broader backend-engineering/compiler-runtime-backend neighbor boundary.
`,
    );
  },
};
const inprocCacheScorer: SkillEvalDeterministicScorer = {
  id: 'in-process-backend/cache-refresh-coalescing-scorer@3',
  scenarioIds: [INPROC_CACHE],
  score: ({ workingDirectory }) => {
    const hidden = runHiddenBunTest(
      workingDirectory,
      `import{expect,test}from'bun:test';import{MetadataCache}from'../src/cache';
test('hidden: concurrent same-key refresh coalesces',async()=>{let now=0,calls=0,release!:(v:number)=>void;const c=new MetadataCache<number>(2,()=>now);const loader=async()=>{calls++;return await new Promise<number>(r=>release=r)};const s=new AbortController().signal;const a=c.get('x',loader,10,5,s),b=c.get('x',loader,10,5,s);await Promise.resolve();expect(calls).toBe(1);release(7);expect(await a).toBe(7);expect(await b).toBe(7);});
test('hidden: tenant churn remains bounded',async()=>{let now=0;const c=new MetadataCache<number>(2,()=>now);for(const k of ['a','b','c','d'])await c.get(k,async()=>1,10,0,new AbortController().signal);expect(c.size()).toBeLessThanOrEqual(2);});
test('hidden: stale-on-error respects explicit bounded policy',async()=>{let now=0;const c=new MetadataCache<number>(2,()=>now);await c.get('x',async()=>5,10,5,new AbortController().signal);now=11;expect(await c.get('x',async()=>{throw new Error('down')},10,5,new AbortController().signal,true)).toBe(5);now=16;await expect(c.get('x',async()=>{throw new Error('down')},10,5,new AbortController().signal,true)).rejects.toThrow('down');});
test('hidden: abort-ignoring loader relinquishes refresh ownership',async()=>{const c=new MetadataCache<number>(2,()=>0);const abort=new AbortController();let calls=0;const first=c.get('z',async()=>{calls++;return new Promise<number>(()=>{});},10,0,abort.signal);await Promise.resolve();abort.abort();await expect(first).rejects.toBeDefined();await new Promise(resolve=>setTimeout(resolve,0));const retry=c.get('z',async()=>{calls++;return 9;},10,0,new AbortController().signal);let timer:ReturnType<typeof setTimeout>|undefined;try{const outcome=await Promise.race([retry,new Promise<number>((_,reject)=>{timer=setTimeout(()=>reject(new Error('abandoned refresh retained key')),150);})]);expect(outcome).toBe(9);expect(calls).toBe(2);}finally{if(timer!==undefined)clearTimeout(timer);void retry.catch(()=>{});}});
`,
    );
    const reg = hasRegressionText(workingDirectory, [
      /coalesc|herd/iu,
      /evict|bounded/iu,
      /stale|cancel/iu,
    ]);
    const authored = verifyAuthoredRegression(workingDirectory, 'src/cache.ts', CACHE_SOURCE);
    const report = artifactText(workingDirectory, '.kory-eval/inprocess-cache.json');
    const passed = hidden.passed && reg && authored.passed && Boolean(report.artifact);
    return {
      passed,
      quality: passed ? 1 : hidden.passed && reg ? 0.85 : hidden.passed ? 0.6 : 0,
      verification: hidden.passed && authored.passed ? 1 : 0,
      integrityFailure: false,
      evidence: [
        `cache coalescing/bounds: ${hidden.passed ? 'pass' : 'fail'}`,
        `clock/lifecycle regressions: ${reg ? 'present' : 'missing'}`,
        ...authored.evidence,
        hidden.evidence,
      ],
    };
  },
};

const LOCAL_AUTH_SOURCE = `export interface Client{clientId:string;token?:string;host:string;origin?:string;now:number}
export interface TokenRecord{token:string;clientId:string;expiresAt:number;fileMode:number}
export class LocalCompanionService{private tokens=new Map<string,TokenRecord>();bootstrap(clientId:string,now:number):TokenRecord{const rec={token:'static-local-token',clientId,expiresAt:Number.MAX_SAFE_INTEGER,fileMode:0o644};this.tokens.set(rec.token,rec);return rec;}authorize(client:Client):boolean{// BUG: loopback/local presence is treated as authentication.
return client.host==='127.0.0.1'||client.host==='localhost';}rotate(_clientId:string,_now:number){return this.bootstrap(_clientId,_now)}shutdown(){}}
`;
const localAuthMaterializer: SkillEvalFixtureMaterializer = {
  id: 'local-service-backend/localhost-client-auth@1',
  matches: (s) => s.id === LOCAL_AUTH,
  materialize: (d) => {
    writeFixtureFile(d, 'package.json', packageJson('kory-eval-local-auth'));
    writeFixtureFile(d, 'src/service.ts', LOCAL_AUTH_SOURCE);
    writeFixtureFile(
      d,
      'tests/service.test.ts',
      `import{expect,test}from'bun:test';import{LocalCompanionService}from'../src/service';test('starts local',()=>expect(new LocalCompanionService()).toBeTruthy());\n`,
    );
    writeFixtureFile(
      d,
      'README.md',
      `# Local companion-service authentication fixture

Keep the service local-only, but do not treat loopback as identity. \`bootstrap(clientId, now)\` issues a unique time-bounded token stored with file mode 0600-equivalent. \`authorize\` requires loopback host, an allowed local origin when present, and a matching unexpired token/client binding. \`rotate\` invalidates prior authority and issues new bounded authority. Restart/shutdown cannot leave broad token files or accept stale authority.

Add bootstrapped/unbootstrapped, wrong-client, expiry, rotation, host/origin, restart and clean-shutdown regressions. Write \`.kory-eval/local-auth.json\` with process/IPC topology, token storage path/mode/lifetime, broader backend-engineering/Bun-Deno neighbor boundary; do not redesign this as a remote network service.
`,
    );
  },
};
const localAuthScorer: SkillEvalDeterministicScorer = {
  id: 'local-service-backend/localhost-client-auth-scorer@2',
  scenarioIds: [LOCAL_AUTH],
  score: ({ workingDirectory }) => {
    const hidden = runHiddenBunTest(
      workingDirectory,
      `import{expect,test}from'bun:test';import{LocalCompanionService}from'../src/service';
test('hidden: loopback alone is insufficient and token is scoped/bounded',()=>{const s=new LocalCompanionService();expect(s.authorize({clientId:'a',host:'127.0.0.1',now:0})).toBe(false);const t=s.bootstrap('a',100);expect(t.fileMode).toBe(0o600);expect(t.expiresAt).toBeGreaterThan(100);expect(t.expiresAt).toBeLessThanOrEqual(100+3600_000);expect(s.authorize({clientId:'a',token:t.token,host:'127.0.0.1',origin:'app://desktop',now:101})).toBe(true);expect(s.authorize({clientId:'b',token:t.token,host:'127.0.0.1',origin:'app://desktop',now:101})).toBe(false);});
test('hidden: rotation invalidates old token and host/origin stay local',()=>{const s=new LocalCompanionService();const a=s.bootstrap('a',0);const b=s.rotate('a',10);expect(b.token).not.toBe(a.token);expect(s.authorize({clientId:'a',token:a.token,host:'127.0.0.1',origin:'app://desktop',now:11})).toBe(false);expect(s.authorize({clientId:'a',token:b.token,host:'evil.example',origin:'https://evil.example',now:11})).toBe(false);});
`,
    );
    const reg = hasRegressionText(workingDirectory, [
      /rotation|expiry|token/iu,
      /origin|host|loopback/iu,
      /restart|shutdown/iu,
    ]);
    const authored = verifyAuthoredRegression(
      workingDirectory,
      'src/service.ts',
      LOCAL_AUTH_SOURCE,
    );
    const report = artifactText(workingDirectory, '.kory-eval/local-auth.json');
    const passed = hidden.passed && reg && authored.passed && Boolean(report.artifact);
    return {
      passed,
      quality: passed ? 1 : hidden.passed && reg ? 0.85 : hidden.passed ? 0.6 : 0,
      verification: hidden.passed && authored.passed ? 1 : 0,
      integrityFailure: false,
      evidence: [
        `local auth/token lifecycle: ${hidden.passed ? 'pass' : 'fail'}`,
        `IPC lifecycle regressions: ${reg ? 'present' : 'missing'}`,
        ...authored.evidence,
        hidden.evidence,
      ],
    };
  },
};

const LOCAL_JOBS_SOURCE = `export type Status='queued'|'running'|'done'|'cancelled';export interface Job{id:string;requestKey:string;status:Status;artifact?:string}
export interface DurableJobs{jobs:Map<string,Job>}
export class ConversionService{private memory=new Map<string,Job>();constructor(private durable:DurableJobs){}submit(requestKey:string):Job{// BUG: only memory remembers request identity, so restart loses status and duplicate suppression.
const old=[...this.memory.values()].find(j=>j.requestKey===requestKey);if(old)return{...old};const j={id:'job-'+(this.memory.size+1),requestKey,status:'queued' as const};this.memory.set(j.id,j);return{...j};}status(id:string){return this.memory.get(id)}start(id:string){const j=this.memory.get(id);if(j)j.status='running'}complete(id:string,artifact:string){const j=this.memory.get(id);if(j){j.status='done';j.artifact=artifact}}cancel(id:string){const j=this.memory.get(id);if(j&&j.status!=='done')j.status='cancelled'}cleanup(id:string){const j=this.memory.get(id);if(j?.status==='done')this.memory.delete(id)} }
`;
const localJobsMaterializer: SkillEvalFixtureMaterializer = {
  id: 'local-service-backend/durable-reconnect-jobs@1',
  matches: (s) => s.id === LOCAL_JOBS,
  materialize: (d) => {
    writeFixtureFile(d, 'package.json', packageJson('kory-eval-local-jobs'));
    writeFixtureFile(d, 'src/conversion.ts', LOCAL_JOBS_SOURCE);
    writeFixtureFile(
      d,
      'tests/conversion.test.ts',
      `import{expect,test}from'bun:test';import{ConversionService}from'../src/conversion';test('submit',()=>{const s=new ConversionService({jobs:new Map()});expect(s.submit('a').status).toBe('queued');});\n`,
    );
    writeFixtureFile(
      d,
      'README.md',
      `# Local conversion-service restart fixture

Move bounded job metadata to the supplied durable local store. Stable \`requestKey\` makes resubmission idempotent across process restart. New service instances reconstruct status from durable records; a stale client connection can reconnect by job id/request key. Process kill during running leaves a recoverable queued/running status according to one documented local restart rule, without introducing distributed coordination.

Cancellation is durable. Completed artifacts remain addressable until cleanup, then metadata/artifact cleanup is bounded. Add restart, duplicate-resubmit, stale-connection, cancellation and completed-cleanup regressions. Write \`.kory-eval/local-jobs.json\` with local process/IPC/durability boundary and backend-engineering/compiler-runtime-backend hierarchy.
`,
    );
  },
};
const localJobsScorer: SkillEvalDeterministicScorer = {
  id: 'local-service-backend/durable-reconnect-jobs-scorer@2',
  scenarioIds: [LOCAL_JOBS],
  score: ({ workingDirectory }) => {
    const hidden = runHiddenBunTest(
      workingDirectory,
      `import{expect,test}from'bun:test';import{ConversionService}from'../src/conversion';
test('hidden: restart preserves identity and duplicate resubmit',()=>{const durable={jobs:new Map()};const a=new ConversionService(durable);const j=a.submit('req-1');a.start(j.id);const b=new ConversionService(durable);const same=b.submit('req-1');expect(same.id).toBe(j.id);expect(b.status(j.id)).toBeTruthy();});
test('hidden: cancellation/completion cleanup durable',()=>{const durable={jobs:new Map()};let s=new ConversionService(durable);const c=s.submit('cancel');s.cancel(c.id);s=new ConversionService(durable);expect(s.status(c.id)?.status).toBe('cancelled');const d=s.submit('done');s.start(d.id);s.complete(d.id,'artifact.bin');s=new ConversionService(durable);expect(s.status(d.id)?.artifact).toBe('artifact.bin');s.cleanup(d.id);expect(s.status(d.id)).toBeUndefined();});
`,
    );
    const reg = hasRegressionText(workingDirectory, [
      /restart|kill|reconnect/iu,
      /duplicate|resubmit|request/iu,
      /cancel|cleanup/iu,
    ]);
    const authored = verifyAuthoredRegression(
      workingDirectory,
      'src/conversion.ts',
      LOCAL_JOBS_SOURCE,
    );
    const report = artifactText(workingDirectory, '.kory-eval/local-jobs.json');
    const passed = hidden.passed && reg && authored.passed && Boolean(report.artifact);
    return {
      passed,
      quality: passed ? 1 : hidden.passed && reg ? 0.85 : hidden.passed ? 0.6 : 0,
      verification: hidden.passed && authored.passed ? 1 : 0,
      integrityFailure: false,
      evidence: [
        `local restart/idempotency: ${hidden.passed ? 'pass' : 'fail'}`,
        `restart/cancel regressions: ${reg ? 'present' : 'missing'}`,
        ...authored.evidence,
        hidden.evidence,
      ],
    };
  },
};

const FRAME_SOURCE = `export class FrameDecoder{private buffered=new Uint8Array();constructor(readonly maxFrame:number){}push(chunk:Uint8Array):Uint8Array[]{// BUG: assumes one read contains exactly one complete frame.
if(chunk.length<4)return[];const view=new DataView(chunk.buffer,chunk.byteOffset,chunk.byteLength);const len=view.getUint32(0);if(len>this.maxFrame)throw new Error('FRAME_TOO_LARGE');return [chunk.slice(4,4+len)];}bufferedBytes(){return this.buffered.length}}
export class OutboundQueue{queued=0;constructor(readonly maxBytes:number){}enqueue(bytes:number){this.queued+=bytes;return true}drain(bytes:number){this.queued=Math.max(0,this.queued-bytes)}close(){this.queued=0}}
`;
const networkFramingMaterializer: SkillEvalFixtureMaterializer = {
  id: 'network-service-backend/framing-backpressure@1',
  matches: (s) => s.id === NETWORK_FRAMING,
  materialize: (d) => {
    writeFixtureFile(d, 'package.json', packageJson('kory-eval-network-framing'));
    writeFixtureFile(d, 'src/framing.ts', FRAME_SOURCE);
    writeFixtureFile(
      d,
      'tests/framing.test.ts',
      `import{expect,test}from'bun:test';import{FrameDecoder}from'../src/framing';test('whole frame',()=>{const b=new Uint8Array([0,0,0,1,65]);expect(new FrameDecoder(8).push(b)[0][0]).toBe(65);});\n`,
    );
    writeFixtureFile(
      d,
      'README.md',
      `# TCP framing/backpressure fixture

Repair incremental length-prefix framing: reads may fragment or coalesce frames. Buffer only enough for the declared max frame and reject oversized lengths before allocating/copying payload. Return every complete frame and retain only an incomplete suffix. Outbound queue must refuse/pressure writes that would exceed \`maxBytes\`; disconnect/idle timeout/half-close performs deterministic cleanup.

Add fragmented/coalesced/oversized/truncated, slow-reader, disconnect-during-write and restart tests. Write \`.kory-eval/network-framing.json\` with protocol/trust contract, timeout/half-close behavior, bounded input/output memory, broader backend-engineering children (edge-CDN/networking/realtime/serverless) and Bun/Deno neighbor boundary.
`,
    );
  },
};
const networkFramingScorer: SkillEvalDeterministicScorer = {
  id: 'network-service-backend/framing-backpressure-scorer@2',
  scenarioIds: [NETWORK_FRAMING],
  score: ({ workingDirectory }) => {
    const hidden = runHiddenBunTest(
      workingDirectory,
      `import{expect,test}from'bun:test';import{FrameDecoder,OutboundQueue}from'../src/framing';const f=(s:string)=>{const p=new TextEncoder().encode(s),b=new Uint8Array(4+p.length);new DataView(b.buffer).setUint32(0,p.length);b.set(p,4);return b};
test('hidden: fragmented and coalesced frames independent of reads',()=>{const d=new FrameDecoder(10),a=f('a'),b=f('bc');expect(d.push(a.slice(0,2))).toEqual([]);expect(d.push(a.slice(2))).toHaveLength(1);const both=new Uint8Array(a.length+b.length);both.set(a);both.set(b,a.length);expect(d.push(both).map(x=>new TextDecoder().decode(x))).toEqual(['a','bc']);});
test('hidden: max frame enforced before buffering unbounded payload',()=>{const d=new FrameDecoder(4);const h=new Uint8Array([0,0,0,255]);expect(()=>d.push(h)).toThrow(/too|large/i);expect(d.bufferedBytes()).toBeLessThanOrEqual(8);});
test('hidden: outbound queue is bounded',()=>{const q=new OutboundQueue(8);expect(q.enqueue(4)).toBe(true);expect(q.enqueue(5)).toBe(false);expect(q.queued).toBeLessThanOrEqual(8);q.close();expect(q.queued).toBe(0);});
`,
    );
    const reg = hasRegressionText(workingDirectory, [
      /fragment|coalesc|frame/iu,
      /slow|backpressure|bounded/iu,
      /half|disconnect|timeout/iu,
    ]);
    const authored = verifyAuthoredRegression(workingDirectory, 'src/framing.ts', FRAME_SOURCE);
    const report = artifactText(workingDirectory, '.kory-eval/network-framing.json');
    const passed = hidden.passed && reg && authored.passed && Boolean(report.artifact);
    return {
      passed,
      quality: passed ? 1 : hidden.passed && reg ? 0.85 : hidden.passed ? 0.6 : 0,
      verification: hidden.passed && authored.passed ? 1 : 0,
      integrityFailure: false,
      evidence: [
        `framing/backpressure behavior: ${hidden.passed ? 'pass' : 'fail'}`,
        `transport regressions: ${reg ? 'present' : 'missing'}`,
        ...authored.evidence,
        hidden.evidence,
      ],
    };
  },
};

const DRAIN_SOURCE = `export type RequestKind='idle'|'streaming'|'non-idempotent'|'tls-handshake';export interface Active{id:string;kind:RequestKind;committed:boolean;done:boolean}
export class Daemon{accepting=true;draining=false;active=new Map<string,Active>();effects=new Set<string>();admit(id:string,kind:RequestKind){if(!this.accepting)return false;this.active.set(id,{id,kind,committed:false,done:false});return true}commit(id:string){const r=this.active.get(id);if(!r)return false;if(r.committed)return false;r.committed=true;if(r.kind==='non-idempotent')this.effects.add(id);return true}finish(id:string){const r=this.active.get(id);if(r)r.done=true}beginDrain(){this.accepting=false;this.draining=true;// BUG: immediately closes every active connection/request boundary.
this.active.clear()}deadline(){this.active.clear()}status(id:string){return this.active.get(id)}}
`;
const networkDrainMaterializer: SkillEvalFixtureMaterializer = {
  id: 'network-service-backend/graceful-drain@1',
  matches: (s) => s.id === NETWORK_DRAIN,
  materialize: (d) => {
    writeFixtureFile(d, 'package.json', packageJson('kory-eval-network-drain'));
    writeFixtureFile(d, 'src/daemon.ts', DRAIN_SOURCE);
    writeFixtureFile(
      d,
      'tests/daemon.test.ts',
      `import{expect,test}from'bun:test';import{Daemon}from'../src/daemon';test('accept',()=>expect(new Daemon().admit('a','idle')).toBe(true));\n`,
    );
    writeFixtureFile(
      d,
      'README.md',
      `# Network daemon graceful-drain fixture

Repair shutdown state transitions. \`beginDrain\` closes admission immediately but preserves already admitted request/TLS/stream boundaries. New work is rejected. Active requests may finish during a bounded drain; only \`deadline\` force-terminates leftovers. A non-idempotent request's logical effect cannot be committed twice through retry/restart ambiguity.

Add idle, streaming, non-idempotent, disconnect, TLS-handshake, force-deadline and restart regressions. Write \`.kory-eval/network-drain.json\` with admission/deadline contract, observed active-request outcomes, hard deadline, broader backend-engineering children and compiler-runtime-backend neighbor boundary; do not invent distributed failover.
`,
    );
  },
};
const networkDrainScorer: SkillEvalDeterministicScorer = {
  id: 'network-service-backend/graceful-drain-scorer@2',
  scenarioIds: [NETWORK_DRAIN],
  score: ({ workingDirectory }) => {
    const hidden = runHiddenBunTest(
      workingDirectory,
      `import{expect,test}from'bun:test';import{Daemon}from'../src/daemon';
test('hidden: drain stops admission but preserves admitted boundaries',()=>{const d=new Daemon();for(const [id,k] of [['i','idle'],['s','streaming'],['n','non-idempotent'],['t','tls-handshake']] as const)expect(d.admit(id,k)).toBe(true);d.beginDrain();expect(d.admit('new','idle')).toBe(false);for(const id of ['i','s','n','t'])expect(d.status(id)).toBeTruthy();d.commit('n');d.finish('n');expect(d.effects.size).toBe(1);expect(d.commit('n')).toBe(false);});
test('hidden: hard deadline terminates leftovers observably',()=>{const d=new Daemon();d.admit('stream','streaming');d.beginDrain();expect(d.status('stream')).toBeTruthy();d.deadline();expect(d.status('stream')).toBeUndefined();});
`,
    );
    const reg = hasRegressionText(workingDirectory, [
      /drain|shutdown|deadline/iu,
      /non.?idemp|stream|tls/iu,
    ]);
    const authored = verifyAuthoredRegression(workingDirectory, 'src/daemon.ts', DRAIN_SOURCE);
    const report = artifactText(workingDirectory, '.kory-eval/network-drain.json');
    const passed = hidden.passed && reg && authored.passed && Boolean(report.artifact);
    return {
      passed,
      quality: passed ? 1 : hidden.passed && reg ? 0.85 : hidden.passed ? 0.6 : 0,
      verification: hidden.passed && authored.passed ? 1 : 0,
      integrityFailure: false,
      evidence: [
        `drain admission/request boundaries: ${hidden.passed ? 'pass' : 'fail'}`,
        `shutdown regressions: ${reg ? 'present' : 'missing'}`,
        ...authored.evidence,
        hidden.evidence,
      ],
    };
  },
};

const REALTIME_SOURCE = `export interface Event{id:string;sequence:number;body:string}
export class Feed{constructor(private events:Event[],readonly retentionStart:number){}resume(after:number):{events:Event[];resync:boolean}{if(after< this.retentionStart-1)return{events:[],resync:true};return{events:this.events.filter(e=>e.sequence>after),resync:false}}}
export class FeedClient{lastSequence=0;rendered:string[]=[];seen=new Set<string>();receive(events:Event[]){for(const e of events){// BUG: replay/live overlap is rendered without identity de-dup and reordering can move cursor backward.
this.rendered.push(e.id);this.seen.add(e.id);this.lastSequence=e.sequence;}}}
export interface SseState{lastEventId:string|null;authToken:string;authValid:boolean;attempts:number;terminal:boolean}
export function onSseDisconnect(state:SseState,refresh:()=>{ok:boolean;token?:string},maxAttempts=4):SseState{// BUG: immediately reconnects with the same expired token and does not preserve a distinct auth recovery state.
return{...state,attempts:state.attempts+1};}
`;
const realtimeWsMaterializer: SkillEvalFixtureMaterializer = {
  id: 'realtime-systems/websocket-resume-cursor@1',
  matches: (s) => s.id === REALTIME_WS,
  materialize: (d) => {
    writeFixtureFile(d, 'package.json', packageJson('kory-eval-realtime-ws'));
    writeFixtureFile(d, 'src/realtime.ts', REALTIME_SOURCE);
    writeFixtureFile(
      d,
      'tests/realtime.test.ts',
      `import{expect,test}from'bun:test';import{Feed}from'../src/realtime';test('resume',()=>expect(new Feed([{id:'a',sequence:1,body:'x'}],1).resume(0).events).toHaveLength(1));\n`,
    );
    writeFixtureFile(
      d,
      'README.md',
      `# WebSocket resume/cursor fixture

Repair client replay/live overlap. Stable event id + monotonically increasing sequence is the logical feed identity. Duplicate/reordered replay cannot render twice or move the resume cursor backward. Reconnect requests \`after=lastSequence\`; bounded server retention returns \`resync:true\` when cursor is too old, requiring authoritative-state resync rather than pretending continuity.

Add disconnect-window, duplicate, reordered overlap, server restart, slow-client/backpressure and too-old cursor regressions. Write \`.kory-eval/realtime-websocket.json\` with connection/auth/heartbeat/backoff/bounded-queue semantics, retention scope, server restart evidence, broader network-service-backend and edge-CDN neighbor boundary.
`,
    );
  },
};
const realtimeWsScorer: SkillEvalDeterministicScorer = {
  id: 'realtime-systems/websocket-resume-cursor-scorer@3',
  scenarioIds: [REALTIME_WS],
  score: ({ workingDirectory }) => {
    const hidden = runHiddenBunTest(
      workingDirectory,
      `import{expect,test}from'bun:test';import{Feed,FeedClient}from'../src/realtime';const events=[1,2,3,4].map(n=>({id:'e'+n,sequence:n,body:String(n)}));
test('hidden: replay/live overlap converges without duplicate logical events',()=>{const c=new FeedClient();c.receive(events.slice(0,2));c.receive([events[1],events[3],events[2],events[3]]);expect([...c.rendered].sort()).toEqual(['e1','e2','e3','e4']);expect(new Set(c.rendered).size).toBe(c.rendered.length);expect(c.lastSequence).toBe(4);});
test('hidden: disconnect across an open gap cannot skip a missing event',()=>{const c=new FeedClient();c.receive(events.slice(0,2));c.receive([events[3]]);expect(c.lastSequence).toBe(2);const replay=new Feed(events,1).resume(c.lastSequence);expect(replay.resync).toBe(false);c.receive(replay.events);expect([...c.rendered].sort()).toEqual(['e1','e2','e3','e4']);expect(c.lastSequence).toBe(4);c.receive([events[2],events[3]]);expect(c.rendered).toHaveLength(4);});
test('hidden: bounded retention forces resync when cursor too old',()=>{const f=new Feed(events.slice(2),3);expect(f.resume(1).resync).toBe(true);const resumed=f.resume(2);expect(resumed.resync).toBe(false);expect(resumed.events).toEqual([events[2],events[3]]);});
`,
    );
    const reg = hasRegressionText(workingDirectory, [
      /disconnect|reconnect|cursor/iu,
      /duplicate|reorder/iu,
      /slow|backpressure|restart/iu,
    ]);
    const authored = verifyAuthoredRegression(workingDirectory, 'src/realtime.ts', REALTIME_SOURCE);
    const report = artifactText(workingDirectory, '.kory-eval/realtime-websocket.json');
    const passed = hidden.passed && reg && authored.passed && Boolean(report.artifact);
    return {
      passed,
      quality: passed ? 1 : hidden.passed && reg ? 0.85 : hidden.passed ? 0.6 : 0,
      verification: hidden.passed && authored.passed ? 1 : 0,
      integrityFailure: false,
      evidence: [
        `resume/dedup behavior: ${hidden.passed ? 'pass' : 'fail'}`,
        `realtime recovery regressions: ${reg ? 'present' : 'missing'}`,
        ...authored.evidence,
        hidden.evidence,
      ],
    };
  },
};

const realtimeSseMaterializer: SkillEvalFixtureMaterializer = {
  id: 'realtime-systems/sse-auth-refresh@1',
  matches: (s) => s.id === REALTIME_SSE,
  materialize: (d) => {
    writeFixtureFile(d, 'package.json', packageJson('kory-eval-realtime-sse'));
    writeFixtureFile(d, 'src/realtime.ts', REALTIME_SOURCE);
    writeFixtureFile(d, 'tests/.gitkeep', '');
    writeFixtureFile(
      d,
      'README.md',
      `# SSE auth-refresh/reconnect fixture

Repair \`onSseDisconnect\`. Persist \`lastEventId\` across refresh/reconnect. Authentication recovery and transport backoff are separate bounded state transitions: if token authority is invalid, refresh exactly once per auth transition before reconnect; successful refresh installs the new token without losing cursor. Refresh failure becomes terminal authorization failure rather than an infinite same-token storm. Transport-only disconnects use bounded jittered backoff with a max-attempt/terminal rule.

Write \`.kory-eval/sse-policy.json\` with max attempts/backoff bounds, Last-Event-ID persistence, proxy idle-close/browser refresh/duplicate replay cases, auth refresh success/failure outcomes and broader network-service-backend/networking-systems neighbor boundary.
`,
    );
  },
};
const realtimeSseScorer: SkillEvalDeterministicScorer = {
  id: 'realtime-systems/sse-auth-refresh-scorer@2',
  scenarioIds: [REALTIME_SSE],
  score: ({ workingDirectory }) => {
    const hidden = runHiddenBunTest(
      workingDirectory,
      `import{expect,test}from'bun:test';import{onSseDisconnect,type SseState}from'../src/realtime';
test('hidden: expired token refresh succeeds while preserving cursor',()=>{const s:SseState={lastEventId:'42',authToken:'old',authValid:false,attempts:0,terminal:false};let calls=0;const n=onSseDisconnect(s,()=>{calls++;return{ok:true,token:'new'}},4);expect(calls).toBe(1);expect(n.authToken).toBe('new');expect(n.authValid).toBe(true);expect(n.lastEventId).toBe('42');expect(n.terminal).toBe(false);});
test('hidden: refresh failure is terminal, not retry storm',()=>{const s:SseState={lastEventId:'9',authToken:'expired',authValid:false,attempts:3,terminal:false};let calls=0;const n=onSseDisconnect(s,()=>{calls++;return{ok:false}},4);expect(calls).toBe(1);expect(n.terminal).toBe(true);expect(n.lastEventId).toBe('9');});
`,
    );
    const policy = artifactText(workingDirectory, '.kory-eval/sse-policy.json');
    const bounded =
      Boolean(policy.artifact) &&
      /backoff/u.test(policy.text) &&
      /jitter/u.test(policy.text) &&
      /last-event-id|lasteventid/u.test(policy.text) &&
      /proxy/u.test(policy.text) &&
      /browser/u.test(policy.text) &&
      /duplicate/u.test(policy.text);
    const authored = verifyAuthoredRegression(workingDirectory, 'src/realtime.ts', REALTIME_SOURCE);
    const passed = hidden.passed && authored.passed && bounded;
    return {
      passed,
      quality: passed ? 1 : hidden.passed ? 0.75 : 0,
      verification: hidden.passed && authored.passed ? 1 : 0,
      integrityFailure: false,
      evidence: [
        `SSE auth/reconnect state machine: ${hidden.passed ? 'pass' : 'fail'}`,
        `bounded reconnect policy: ${bounded ? 'present' : 'missing'}`,
        ...authored.evidence,
        hidden.evidence,
      ],
    };
  },
};

const STREAM_SOURCE = `export interface StreamEvent{id:string;key:string;eventTimeMs:number;value:number}
export class WindowCounter{private seen=new Map<string,number>();private counts=new Map<number,number>();constructor(readonly windowMs:number,readonly allowedLatenessMs:number){}ingest(event:StreamEvent,watermarkMs:number):'applied'|'duplicate'|'too-late'{// BUG: arrival/watermark is used as processing time and duplicate identity is ignored.
if(event.eventTimeMs<watermarkMs)return'too-late';const bucket=Math.floor(watermarkMs/this.windowMs)*this.windowMs;this.counts.set(bucket,(this.counts.get(bucket)??0)+event.value);return'applied'}count(bucket:number){return this.counts.get(bucket)??0}retainedIds(){return this.seen.size}checkpoint(){return{seen:[...this.seen],counts:[...this.counts]}}restore(s:{seen:[string,number][];counts:[number,number][]}){this.seen=new Map(s.seen);this.counts=new Map(s.counts)}}
export interface Sink{effects:Map<string,number>}
export class CheckpointProcessor{offset=0;constructor(readonly sink:Sink){}process(event:{id:string;offset:number;delta:number},crash:'none'|'after-sink-before-checkpoint'|'before-sink'='none'){if(crash==='before-sink')throw new Error('crash');this.sink.effects.set(event.id,(this.sink.effects.get(event.id)??0)+event.delta);if(crash==='after-sink-before-checkpoint')throw new Error('crash');this.offset=event.offset} }
`;
const streamWindowMaterializer: SkillEvalFixtureMaterializer = {
  id: 'stream-processing/event-time-window-dedup@1',
  matches: (s) => s.id === STREAM_WINDOW,
  materialize: (d) => {
    writeFixtureFile(d, 'package.json', packageJson('kory-eval-stream-window'));
    writeFixtureFile(d, 'src/stream.ts', STREAM_SOURCE);
    writeFixtureFile(
      d,
      'tests/stream.test.ts',
      `import{expect,test}from'bun:test';import{WindowCounter}from'../src/stream';test('construct',()=>expect(new WindowCounter(60000,720000)).toBeTruthy());\n`,
    );
    writeFixtureFile(
      d,
      'README.md',
      `# Event-time window/dedup fixture

Repair \`WindowCounter\` so bucket assignment uses event time, not arrival/processing time. Stable event id is deduplicated. Watermark closes events only when \`eventTimeMs < watermarkMs - allowedLatenessMs\`; this fixture publishes 12 minutes allowed lateness. Accepted out-of-order/late-within-policy events update the original event-time window; too-late events are explicitly rejected. Dedup state is retained only as long as needed for the lateness/replay contract and checkpoints restore counts+identity state.

Add on-time, late-within, too-late, duplicate, reordered, restart/checkpoint and bounded-state regressions. Write \`.kory-eval/stream-window.json\` with key/order/watermark/state-retention semantics, broader distributed-backend/event-driven neighbor boundary and no global-order claim.
`,
    );
  },
};
const streamWindowScorer: SkillEvalDeterministicScorer = {
  id: 'stream-processing/event-time-window-dedup-scorer@3',
  scenarioIds: [STREAM_WINDOW],
  score: ({ workingDirectory }) => {
    const hidden = runHiddenBunTest(
      workingDirectory,
      `import{expect,test}from'bun:test';import{WindowCounter}from'../src/stream';const m=60000;
test('hidden: event-time bucketing, lateness and dedup',()=>{const c=new WindowCounter(m,12*m);expect(c.ingest({id:'a',key:'k',eventTimeMs:2*m+1,value:1},10*m)).toBe('applied');expect(c.ingest({id:'a',key:'k',eventTimeMs:2*m+1,value:1},10*m)).toBe('duplicate');expect(c.count(2*m)).toBe(1);expect(c.ingest({id:'old',key:'k',eventTimeMs:1*m,value:1},14*m)).toBe('too-late');});
test('hidden: checkpoint/restart preserves logical state',()=>{const c=new WindowCounter(m,12*m);c.ingest({id:'a',key:'k',eventTimeMs:5,value:2},m);const s=c.checkpoint();const d=new WindowCounter(m,12*m);d.restore(s);expect(d.ingest({id:'a',key:'k',eventTimeMs:5,value:2},m)).toBe('duplicate');expect(d.count(0)).toBe(2);});
test('hidden: advancing watermark evicts expired aggregate and dedup state',()=>{const c=new WindowCounter(m,12*m);expect(c.ingest({id:'old',key:'k',eventTimeMs:1,value:2},m)).toBe('applied');expect(c.count(0)).toBe(2);expect(c.ingest({id:'new',key:'k',eventTimeMs:20*m+1,value:1},20*m)).toBe('applied');expect(c.count(0)).toBe(0);expect(c.retainedIds()).toBeLessThanOrEqual(1);});
test('hidden: out-of-order arrival remains in its event-time window',()=>{const c=new WindowCounter(m,12*m);expect(c.ingest({id:'later',key:'k',eventTimeMs:10*m+1,value:1},10*m)).toBe('applied');expect(c.ingest({id:'earlier',key:'k',eventTimeMs:9*m+1,value:3},10*m)).toBe('applied');expect(c.count(9*m)).toBe(3);expect(c.count(10*m)).toBe(1);});
`,
    );
    const reg = hasRegressionText(workingDirectory, [
      /late|watermark|event.?time/iu,
      /duplicate|dedup/iu,
      /checkpoint|restart/iu,
    ]);
    const authored = verifyAuthoredRegression(workingDirectory, 'src/stream.ts', STREAM_SOURCE);
    const report = artifactText(workingDirectory, '.kory-eval/stream-window.json');
    const passed = hidden.passed && reg && authored.passed && Boolean(report.artifact);
    return {
      passed,
      quality: passed ? 1 : hidden.passed && reg ? 0.85 : hidden.passed ? 0.6 : 0,
      verification: hidden.passed && authored.passed ? 1 : 0,
      integrityFailure: false,
      evidence: [
        `event-time/dedup behavior: ${hidden.passed ? 'pass' : 'fail'}`,
        `replay/state regressions: ${reg ? 'present' : 'missing'}`,
        ...authored.evidence,
        hidden.evidence,
      ],
    };
  },
};

const streamCheckpointMaterializer: SkillEvalFixtureMaterializer = {
  id: 'stream-processing/checkpoint-sink-idempotency@1',
  matches: (s) => s.id === STREAM_CHECKPOINT,
  materialize: (d) => {
    writeFixtureFile(d, 'package.json', packageJson('kory-eval-stream-checkpoint'));
    writeFixtureFile(d, 'src/stream.ts', STREAM_SOURCE);
    writeFixtureFile(d, 'tests/.gitkeep', '');
    writeFixtureFile(
      d,
      'README.md',
      `# Stream checkpoint/external-sink fixture

Repair \`CheckpointProcessor\` for the capabilities actually supplied: source delivery is at-least-once and the external sink supports conditional/idempotent update by stable event id, but is not transactionally coupled to the source checkpoint. Replaying after a crash between sink write and checkpoint may execute code again but cannot increment the logical aggregate twice. Advance checkpoint only after durable sink success.

Add crash-before-sink, crash-after-sink-before-checkpoint, replay, duplicate, partial-batch and recovery regressions. Write \`.kory-eval/stream-checkpoint.json\` with actual guarantee \`logicalExactlyOnceEffects:true\`, \`transportExactlyOnce:false\`, sink/idempotency/checkpoint boundaries, broader distributed-backend/analytics-engineering neighbor boundary and explicit replay evidence.
`,
    );
  },
};
const streamCheckpointScorer: SkillEvalDeterministicScorer = {
  id: 'stream-processing/checkpoint-sink-idempotency-scorer@3',
  scenarioIds: [STREAM_CHECKPOINT],
  score: ({ workingDirectory }) => {
    const hidden = runHiddenBunTest(
      workingDirectory,
      `import{expect,test}from'bun:test';import{CheckpointProcessor}from'../src/stream';
function sink(){const effects=new Map<string,number>();return{effects,applyOnce(id:string,delta:number){if(effects.has(id))return false;effects.set(id,delta);return true}}}
async function run(p:any,e:any,crash:'none'|'after-sink-before-checkpoint'|'before-sink'='none'){return await p.process(e,crash)}
test('hidden: crash after sink then replay is logically idempotent',async()=>{const s=sink();let p=new CheckpointProcessor(s);const e={id:'e1',offset:1,delta:5};await expect(run(p,e,'after-sink-before-checkpoint')).rejects.toThrow();expect(p.offset).toBe(0);p=new CheckpointProcessor(s);expect(await run(p,e)).toMatch(/applied|duplicate/);expect(s.effects.get('e1')).toBe(5);expect(p.offset).toBe(1);});
test('hidden: crash before sink has no effect/checkpoint',async()=>{const s=sink();const p=new CheckpointProcessor(s);await expect(run(p,{id:'e2',offset:2,delta:3},'before-sink')).rejects.toThrow();expect(s.effects.size).toBe(0);expect(p.offset).toBe(0);});
`,
    );
    const reg = hasRegressionText(workingDirectory, [
      /after.*sink|checkpoint|replay/iu,
      /partial|duplicate|idempoten/iu,
    ]);
    const authored = verifyAuthoredRegression(workingDirectory, 'src/stream.ts', STREAM_SOURCE);
    const report = artifactText(workingDirectory, '.kory-eval/stream-checkpoint.json');
    const bounded =
      Boolean(report.artifact) &&
      nestedBool(report.artifact, 'transportExactlyOnce', false) &&
      nestedBool(report.artifact, 'logicalExactlyOnceEffects', true);
    function nestedBool(v: any, k: string, e: boolean): boolean {
      if (Array.isArray(v)) return v.some((x) => nestedBool(x, k, e));
      if (!v || typeof v !== 'object') return false;
      if (v[k] === e) return true;
      return Object.values(v).some((x) => nestedBool(x, k, e));
    }
    const passed = hidden.passed && reg && authored.passed && bounded;
    return {
      passed,
      quality: passed ? 1 : hidden.passed && reg ? 0.8 : hidden.passed ? 0.6 : 0,
      verification: hidden.passed && authored.passed ? 1 : 0,
      integrityFailure: false,
      evidence: [
        `checkpoint/sink recovery: ${hidden.passed ? 'pass' : 'fail'}`,
        `crash/replay regressions: ${reg ? 'present' : 'missing'}`,
        `guarantee precision: ${bounded ? 'bounded' : 'missing'}`,
        ...authored.evidence,
        hidden.evidence,
      ],
    };
  },
};

export const BACKEND_STATE_SKILL_EVAL_MATERIALIZERS: readonly SkillEvalFixtureMaterializer[] = [
  inprocQueueMaterializer,
  inprocCacheMaterializer,
  localAuthMaterializer,
  localJobsMaterializer,
  networkFramingMaterializer,
  networkDrainMaterializer,
  realtimeWsMaterializer,
  realtimeSseMaterializer,
  streamWindowMaterializer,
  streamCheckpointMaterializer,
];
export const BACKEND_STATE_SKILL_EVAL_SCORERS: readonly SkillEvalDeterministicScorer[] = [
  inprocQueueScorer,
  inprocCacheScorer,
  localAuthScorer,
  localJobsScorer,
  networkFramingScorer,
  networkDrainScorer,
  realtimeWsScorer,
  realtimeSseScorer,
  streamWindowScorer,
  streamCheckpointScorer,
];
