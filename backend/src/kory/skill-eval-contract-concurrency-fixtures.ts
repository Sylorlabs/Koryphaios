import { existsSync, readFileSync, writeFileSync } from 'node:fs';
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

const LEASE = 'deterministic-contract-testing-full-task-1';
const JOB_SCHEMA = 'deterministic-contract-testing-full-task-2';
const CONCURRENT_SAVE = 'concurrency-debugging-full-task-1';
const DEADLOCK = 'concurrency-debugging-full-task-2';

function runTests(root: string, path: string): { status: number | null; output: string } {
  const result = spawnSync('bun', ['test', path], {
    cwd: root,
    encoding: 'utf8',
    timeout: 15_000,
    maxBuffer: 1_000_000,
  });
  return { status: result.status, output: `${result.stdout ?? ''}\n${result.stderr ?? ''}` };
}

function firstExistingPath(root: string, candidates: readonly string[]): string | null {
  return candidates.find((path) => existsSync(join(root, path))) ?? null;
}

const LEASE_SOURCE = `export interface Lease { token: string; expiresAt: string }
export interface Clock { now(): Date }
export interface NonceSource { nextBytes(): Uint8Array; consumed(): number }

export type RenewResult =
  | { ok: true; lease: Lease }
  | { ok: false; error: 'LEASE_EXPIRED' };

function hex(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

export function renewLease(lease: Lease, clock: Clock, nonceSource: NonceSource): RenewResult {
  const now = clock.now();
  if (now.getTime() >= new Date(lease.expiresAt).getTime()) return { ok: false, error: 'LEASE_EXPIRED' };
  const expiresAt = new Date(now.getTime() + 15 * 60 * 1000).toISOString();
  return { ok: true, lease: { token: 'lease-' + hex(nonceSource.nextBytes()), expiresAt } };
}
`;

const FIXTURES_SOURCE = `import type { Clock, NonceSource } from './lease';

export class FixedClock implements Clock {
  constructor(private readonly instant: string) {}
  now(): Date { return new Date(this.instant); }
}

export class FixedNonceSource implements NonceSource {
  private reads = 0;
  constructor(private readonly bytes = new Uint8Array([0x01, 0x02, 0xa0, 0xff])) {}
  nextBytes(): Uint8Array { this.reads += 1; return this.bytes; }
  consumed(): number { return this.reads; }
}
`;

const leaseMaterializer: SkillEvalFixtureMaterializer = {
  id: 'deterministic-contract-testing/lease-renewal-boundaries@1',
  matches: (scenario) => scenario.id === LEASE,
  materialize: (destination) => {
    writeFixtureFile(destination, 'package.json', packageJson('kory-eval-contract-lease'));
    writeFixtureFile(destination, 'src/lease.ts', LEASE_SOURCE);
    writeFixtureFile(destination, 'src/fixtures.ts', FIXTURES_SOURCE);
    writeFixtureFile(
      destination,
      'README.md',
      `# Deterministic lease contract fixture

Production behavior is already implemented. Add focused tests only; do not redesign it. Base lease: token \`old-token\`, expiry \`2026-09-05T12:00:00.000Z\`. Use \`FixedClock\` and \`FixedNonceSource\`.

Cover 11:59:59.999Z (success, expiry exactly 15 minutes later, token \`lease-0102a0ff\`, one nonce read), exact 12:00:00.000Z (LEASE_EXPIRED, zero nonce reads), and 12:00:00.001Z (same rejection/no nonce). Demonstrate the controlled production comparison mutation \`>=\` → \`>\` makes the equality regression red, restore the implementation, then run the focused suite twice. No sleeps, wall-clock assertions, network/database, or fuzzing.

Write \`.kory-eval/deterministic-lease.json\` with contract→case matrix, fixed fixture identity, mutation red/green evidence, two restored fresh-run results, and synthetic/local-boundary label.
`,
    );
  },
};

const leaseScorer: SkillEvalDeterministicScorer = {
  id: 'deterministic-contract-testing/lease-renewal-boundaries-scorer@2',
  scenarioIds: [LEASE],
  score: ({ workingDirectory }) => {
    const path = join(workingDirectory, 'src/lease.ts');
    const source = readFileSync(path, 'utf8');
    const sourcePreserved = source === LEASE_SOURCE;
    const regression = hasRegressionText(workingDirectory, [
      /11:59:59\.999|before/iu,
      /12:00:00\.000|equality|exact/iu,
      /12:00:00\.001|after/iu,
      /nonce/iu,
    ]);
    const leaseTestPath = firstExistingPath(workingDirectory, [
      'tests/lease.test.ts',
      'src/lease.test.ts',
    ]);
    const first = leaseTestPath
      ? runTests(workingDirectory, leaseTestPath)
      : { status: null, output: '' };
    let mutationRed = false;
    let restoredFirst: ReturnType<typeof runTests> = { status: null, output: '' };
    let restoredSecond: ReturnType<typeof runTests> = { status: null, output: '' };
    if (leaseTestPath && sourcePreserved) {
      try {
        writeFileSync(
          path,
          source.replace(
            '>= new Date(lease.expiresAt).getTime()',
            '> new Date(lease.expiresAt).getTime()',
          ),
        );
        mutationRed = runTests(workingDirectory, leaseTestPath).status !== 0;
      } finally {
        writeFileSync(path, source);
      }
      restoredFirst = runTests(workingDirectory, leaseTestPath);
      restoredSecond = runTests(workingDirectory, leaseTestPath);
    }
    const noAmbient = !/setTimeout|sleep\s*\(|Date\.now\(\)|Math\.random|crypto\.random/iu.test(
      `${source}\n${leaseTestPath ? readFileSync(join(workingDirectory, leaseTestPath), 'utf8') : ''}`,
    );
    const artifact = readJsonArtifact<unknown>(
      workingDirectory,
      '.kory-eval/deterministic-lease.json',
    );
    const body = JSON.stringify(artifact ?? '').toLowerCase();
    const report =
      /0102a0ff/u.test(body) &&
      /lease_expired/u.test(body) &&
      /nonce/u.test(body) &&
      /mutation/u.test(body) &&
      /red|fail/u.test(body) &&
      /restore|green|pass/u.test(body) &&
      /twice|two.*run|run.*2/u.test(body) &&
      /synthetic|local/u.test(body);
    const passed =
      sourcePreserved &&
      regression &&
      first.status === 0 &&
      mutationRed &&
      restoredFirst.status === 0 &&
      restoredSecond.status === 0 &&
      noAmbient &&
      Boolean(artifact) &&
      report;
    return {
      passed,
      quality: passed
        ? 1
        : first.status === 0 && mutationRed && noAmbient
          ? 0.75
          : first.status === 0
            ? 0.5
            : 0,
      verification:
        first.status === 0 &&
        mutationRed &&
        restoredFirst.status === 0 &&
        restoredSecond.status === 0
          ? 1
          : 0,
      integrityFailure: !sourcePreserved,
      evidence: [
        `production implementation restored exactly: ${sourcePreserved ? 'yes' : 'no'}`,
        `before/equal/after + nonce regressions: ${first.status === 0 && regression ? 'pass' : 'fail'}`,
        `>=→> equality mutation kills regression: ${mutationRed ? 'yes' : 'no'}`,
        `restored focused suite twice: ${restoredFirst.status === 0 && restoredSecond.status === 0 ? 'pass' : 'fail'}`,
        `ambient time/entropy/sleep: ${noAmbient ? 'absent' : 'present'}`,
      ],
    };
  },
};

const JOB_SCHEMA_JSON = `${JSON.stringify(
  {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    type: 'object',
    required: ['version', 'jobId', 'command'],
    additionalProperties: false,
    properties: {
      version: { enum: [1, 2] },
      jobId: { type: 'string', minLength: 1 },
      command: { enum: ['start', 'cancel', 'succeed'] },
    },
  },
  null,
  2,
)}\n`;

const JOB_SOURCE = `import { readFileSync } from 'node:fs';

export type DecodeError = 'INVALID_JOB_ID' | 'UNKNOWN_COMMAND' | 'EXTRA_PROPERTY' | 'INVALID_ENVELOPE';
export type Envelope = { version: 1 | 2; jobId: string; command: 'start' | 'cancel' | 'succeed' };

export function decodeEnvelope(input: unknown): { ok: true; value: Envelope } | { ok: false; error: DecodeError } {
  const schema = JSON.parse(readFileSync('schema/job-command.schema.json','utf8')) as { additionalProperties?: boolean };
  if (!input || typeof input !== 'object' || Array.isArray(input)) return { ok:false, error:'INVALID_ENVELOPE' };
  const value = input as Record<string, unknown>;
  if (typeof value.jobId !== 'string' || value.jobId.length === 0) return { ok:false, error:'INVALID_JOB_ID' };
  if (!['start','cancel','succeed'].includes(String(value.command))) return { ok:false, error:'UNKNOWN_COMMAND' };
  if (schema.additionalProperties === false && Object.keys(value).some((key)=>!['version','jobId','command'].includes(key))) {
    return { ok:false, error:'EXTRA_PROPERTY' };
  }
  if (![1,2].includes(Number(value.version))) return { ok:false, error:'INVALID_ENVELOPE' };
  return { ok:true, value:value as Envelope };
}

export type JobState = 'Queued' | 'Running' | 'Succeeded' | 'Cancelled';
export function reduceJob(state: JobState, command: 'start'|'cancel'|'succeed'):
  | { ok:true; state:JobState; effects:string[] }
  | { ok:false; error:'ILLEGAL_TRANSITION'; effects:[] } {
  if (state === 'Cancelled' && command === 'cancel') return { ok:true, state:'Cancelled', effects:[] };
  if (state === 'Queued' && command === 'start') return { ok:true, state:'Running', effects:['job-started'] };
  if (state === 'Queued' && command === 'cancel') return { ok:true, state:'Cancelled', effects:['job-cancelled'] };
  if (state === 'Running' && command === 'succeed') return { ok:true, state:'Succeeded', effects:['job-succeeded'] };
  if (state === 'Running' && command === 'cancel') return { ok:true, state:'Cancelled', effects:['job-cancelled'] };
  return { ok:false, error:'ILLEGAL_TRANSITION', effects:[] };
}
`;

const jobSchemaMaterializer: SkillEvalFixtureMaterializer = {
  id: 'deterministic-contract-testing/job-command-schema-state-machine@1',
  matches: (scenario) => scenario.id === JOB_SCHEMA,
  materialize: (destination) => {
    writeFixtureFile(destination, 'package.json', packageJson('kory-eval-contract-job'));
    writeFixtureFile(destination, 'schema/job-command.schema.json', JOB_SCHEMA_JSON);
    writeFixtureFile(destination, 'src/job-contract.ts', JOB_SOURCE);
    writeFixtureFile(
      destination,
      'examples/legacy-v1.json',
      '{"version":1,"jobId":"legacy-1","command":"cancel"}\n',
    );
    writeFixtureFile(
      destination,
      'examples/current-v2.json',
      '{"version":2,"jobId":"current-2","command":"start"}\n',
    );
    writeFixtureFile(
      destination,
      'README.md',
      `# Deterministic job contract fixture

Add local deterministic tests; do not change production schema/reducer behavior. Pin/assert Draft 2020-12. Cover both supplied valid examples; missing/empty jobId → INVALID_JOB_ID; unknown command → UNKNOWN_COMMAND; extra top-level property → EXTRA_PROPERTY; every declared legal transition; illegal transitions from Succeeded/Cancelled with zero effects; and Cancelled→Cancelled idempotent no-op.

Controlled mutation: change schema \`additionalProperties\` false→true, prove the dedicated extra-property regression fails, restore schema, rerun. Do not claim fuzz/broker/database coverage.

Write \`.kory-eval/deterministic-job.json\` with case matrix, dialect identity, stable semantic error categories, state table, mutation red/green evidence, and explicit local/synthetic evidence boundary.
`,
    );
  },
};

const jobSchemaScorer: SkillEvalDeterministicScorer = {
  id: 'deterministic-contract-testing/job-command-schema-state-machine-scorer@2',
  scenarioIds: [JOB_SCHEMA],
  score: ({ workingDirectory }) => {
    const sourcePath = join(workingDirectory, 'src/job-contract.ts');
    const schemaPath = join(workingDirectory, 'schema/job-command.schema.json');
    const sourcePreserved = readFileSync(sourcePath, 'utf8') === JOB_SOURCE;
    const schema = readFileSync(schemaPath, 'utf8');
    const schemaPreserved = schema === JOB_SCHEMA_JSON;
    const regression = hasRegressionText(workingDirectory, [
      /legacy|v1/iu,
      /extra.*propert|EXTRA_PROPERTY/iu,
      /Queued|Running/iu,
      /Cancelled.*Cancelled|idempoten/iu,
    ]);
    const first = runTests(workingDirectory, 'tests/job-contract.test.ts');
    let mutationRed = false;
    if (
      sourcePreserved &&
      schemaPreserved &&
      existsSync(join(workingDirectory, 'tests/job-contract.test.ts'))
    ) {
      try {
        writeFileSync(
          schemaPath,
          schema.replace('"additionalProperties": false', '"additionalProperties": true'),
        );
        mutationRed = runTests(workingDirectory, 'tests/job-contract.test.ts').status !== 0;
      } finally {
        writeFileSync(schemaPath, schema);
      }
    }
    const restored = runTests(workingDirectory, 'tests/job-contract.test.ts');
    const artifact = readJsonArtifact<{
      stateTable?: { legal?: unknown[] };
    }>(workingDirectory, '.kory-eval/deterministic-job.json');
    const body = JSON.stringify(artifact ?? '').toLowerCase();
    const idempotentCancellationEncoded =
      /idempoten/u.test(body) ||
      artifact?.stateTable?.legal?.some(
        (row) =>
          Array.isArray(row) &&
          row[0] === 'Cancelled' &&
          row[1] === 'cancel' &&
          row[2] === 'Cancelled' &&
          Array.isArray(row[3]) &&
          row[3].length === 0,
      ) === true;
    const report =
      /2020-12/u.test(body) &&
      /invalid_job_id/u.test(body) &&
      /unknown_command/u.test(body) &&
      /extra_property/u.test(body) &&
      /queued/u.test(body) &&
      /running/u.test(body) &&
      /succeeded/u.test(body) &&
      /cancelled/u.test(body) &&
      idempotentCancellationEncoded &&
      /mutation/u.test(body) &&
      /red|fail/u.test(body) &&
      /restore|green|pass/u.test(body) &&
      /local|synthetic/u.test(body) &&
      !/fuzz.*(?:proved|covered)|broker.*(?:proved|covered)|database.*(?:proved|covered)/u.test(
        body,
      );
    const passed =
      sourcePreserved &&
      schemaPreserved &&
      regression &&
      first.status === 0 &&
      mutationRed &&
      restored.status === 0 &&
      Boolean(artifact) &&
      report;
    return {
      passed,
      quality: passed ? 1 : first.status === 0 && mutationRed ? 0.75 : first.status === 0 ? 0.5 : 0,
      verification: first.status === 0 && mutationRed && restored.status === 0 ? 1 : 0,
      integrityFailure: !sourcePreserved || !schemaPreserved,
      evidence: [
        `production source/schema restored exactly: ${sourcePreserved && schemaPreserved ? 'yes' : 'no'}`,
        `compatibility/rejection/state transition suite: ${first.status === 0 && regression ? 'pass' : 'fail'}`,
        `additionalProperties mutation proof: ${mutationRed ? 'red as required' : 'missing'}`,
        `restored suite: ${restored.status === 0 ? 'green' : 'fail'}`,
        `local evidence boundary: ${report ? 'bounded' : 'missing'}`,
      ],
    };
  },
};

const SAVE_SOURCE = `export interface Document { id:string; revision:number; title:string; tags:string[] }
export type PendingUpdate = { id:string; baseRevision:number; field:'title'|'tags'; value:string|string[]; snapshot:Document };

export class DocumentStore {
  private docs = new Map<string, Document>([
    ['doc-1', { id:'doc-1', revision:7, title:'Old', tags:['base'] }],
    ['doc-2', { id:'doc-2', revision:3, title:'Other', tags:[] }],
  ]);
  read(id='doc-1'): Document { return structuredClone(this.docs.get(id)!); }
  beginTitle(title:string,id='doc-1'): PendingUpdate { const d=this.read(id); return { id,baseRevision:d.revision,field:'title',value:title,snapshot:d }; }
  beginTags(tags:string[],id='doc-1'): PendingUpdate { const d=this.read(id); return { id,baseRevision:d.revision,field:'tags',value:[...tags],snapshot:d }; }
  commit(update:PendingUpdate): void {
    const current=this.docs.get(update.id)!;
    // BUG: overwrites from stale snapshot; the existing revision boundary is observed but not enforced.
    const next={...update.snapshot,revision:current.revision+1};
    if(update.field==='title') next.title=String(update.value); else next.tags=[...(update.value as string[])];
    this.docs.set(update.id,next);
  }
}

export function runOverlap(order:'title-first'|'tags-first') {
  const store=new DocumentStore(); const title=store.beginTitle('New'); const tags=store.beginTags(['base','x']);
  if(order==='title-first'){store.commit(title);store.commit(tags);} else {store.commit(tags);store.commit(title);}
  return store.read();
}
`;

const saveMaterializer: SkillEvalFixtureMaterializer = {
  id: 'concurrency-debugging/concurrent-document-saves@2',
  matches: (scenario) => scenario.id === CONCURRENT_SAVE,
  materialize: (destination) => {
    writeFixtureFile(destination, 'package.json', packageJson('kory-eval-concurrency-save'));
    writeFixtureFile(destination, 'src/document-store.ts', SAVE_SOURCE);
    writeFixtureFile(destination, 'reference/document-store.before.ts', SAVE_SOURCE);
    writeFixtureFile(
      destination,
      'tests/sequential.test.ts',
      `import { expect,test } from 'bun:test'; import { DocumentStore } from '../src/document-store';
test('sequential updates are correct',()=>{const s=new DocumentStore(); s.commit(s.beginTitle('New')); s.commit(s.beginTags(['base','x'])); expect(s.read()).toMatchObject({title:'New',tags:['base','x']});});
`,
    );
    writeFixtureFile(
      destination,
      'README.md',
      `# Concurrent document save fixture

Before editing the implementation, execute \`runOverlap('title-first')\` and \`runOverlap('tags-first')\` against the starting source and record their observed final states. The preserved \`reference/document-store.before.ts\` exists only so the original behavior can still be executed after the working source changes. Both pending updates read revision 7 before either commit. Trace actor read/modify/write timelines and identify the revision/ownership invariant violation. Repair narrowly at the per-document optimistic-concurrency boundary so both independent field updates survive; do not use sleeps or a global lock/serialization across unrelated documents. Add regressions for both orders plus sequential control, then add a bounded repeated run of both overlap orders as maintained stress evidence.

Write \`.kory-eval/concurrency-save.json\` with both observed pre-fix timelines/outcomes, violated revision invariant, owning correction, post-fix alternate-interleaving results, bounded stress result, and diff scope. Distinguish executed pre-fix evidence from reconstructed explanation.
`,
    );
  },
};

const saveScorer: SkillEvalDeterministicScorer = {
  id: 'concurrency-debugging/concurrent-document-saves-scorer@6',
  scenarioIds: [CONCURRENT_SAVE],
  score: ({ workingDirectory }) => {
    const referencePath = join(workingDirectory, 'reference/document-store.before.ts');
    const referencePreserved =
      existsSync(referencePath) && readFileSync(referencePath, 'utf8') === SAVE_SOURCE;
    const preFix = referencePreserved
      ? runHiddenBunTest(
          workingDirectory,
          `import { expect,test } from 'bun:test'; import { runOverlap } from '../reference/document-store.before';
test('hidden: starting source reproduces both lost-update orders',()=>{expect(runOverlap('title-first')).toMatchObject({title:'Old',tags:['base','x']});expect(runOverlap('tags-first')).toMatchObject({title:'New',tags:['base']});});
`,
        )
      : { passed: false, evidence: 'preserved starting source missing or changed' };
    const hidden = runHiddenBunTest(
      workingDirectory,
      `import { expect,test } from 'bun:test'; import { DocumentStore,runOverlap } from '../src/document-store';
test('hidden: both overlap orders preserve both fields',()=>{for(const order of ['title-first','tags-first'] as const){expect(runOverlap(order)).toMatchObject({title:'New',tags:['base','x']});}});
test('hidden: sequential and unrelated document remain independent',()=>{const s=new DocumentStore(); s.commit(s.beginTitle('New')); s.commit(s.beginTags(['base','x'])); expect(s.read()).toMatchObject({title:'New',tags:['base','x']}); expect(s.read('doc-2')).toMatchObject({revision:3,title:'Other'});});
`,
    );
    const source = readFileSync(join(workingDirectory, 'src/document-store.ts'), 'utf8');
    const noBadSync = !/setTimeout|sleep\s*\(|globalLock|global.*mutex|serializeAll/iu.test(source);
    const regression = hasRegressionText(workingDirectory, [
      /title-first/u,
      /tags-first/u,
      /sequential/u,
    ]);
    const stressRegression = hasRegressionText(workingDirectory, [
      /stress|repeat|iteration|loop/iu,
      /title-first/u,
      /tags-first/u,
    ]);
    const artifact = readJsonArtifact<unknown>(
      workingDirectory,
      '.kory-eval/concurrency-save.json',
    );
    const body = JSON.stringify(artifact ?? '').toLowerCase();
    const titleFirst = /title(?:-|_|\s)?first/u.test(body);
    const tagsFirst = /tags(?:-|_|\s)?first/u.test(body);
    const causal =
      /revision 7|revision.*7/u.test(body) &&
      /stale|lost update|overwrite/u.test(body) &&
      titleFirst &&
      tagsFirst &&
      /invariant|ownership|compare-and-swap|cas/u.test(body);
    const preFixReport =
      /pre.?fix|before.?fix|starting.?source/u.test(body) &&
      /observed|executed|execution|actual|reproduced|reproduction|reconstructed|not executed|unavailable/u.test(
        body,
      ) &&
      titleFirst &&
      tagsFirst &&
      /old/u.test(body) &&
      /new/u.test(body) &&
      /base/u.test(body) &&
      /stale|lost|overwrite|overwrote|replace|erase|clobber/u.test(body);
    const stressPlan = /stress|repeat|iteration|loop/u.test(body) && /\b\d{2,}\b/u.test(body);
    const passed =
      referencePreserved &&
      preFix.passed &&
      hidden.passed &&
      noBadSync &&
      regression &&
      stressRegression &&
      Boolean(artifact) &&
      causal &&
      preFixReport &&
      stressPlan;
    return {
      passed,
      quality: passed
        ? 1
        : preFix.passed && hidden.passed && noBadSync && regression
          ? 0.75
          : hidden.passed
            ? 0.5
            : 0,
      verification: preFix.passed && hidden.passed && stressRegression && stressPlan ? 1 : 0,
      integrityFailure: !referencePreserved,
      evidence: [
        `preserved starting source: ${referencePreserved ? 'exact' : 'missing or changed'}`,
        `controlled pre-fix reproduction: ${preFix.passed ? 'pass' : 'fail'}`,
        `both controlled interleavings + sequential control: ${hidden.passed ? 'pass' : 'fail'}`,
        `global serialization/timing hack: ${noBadSync ? 'absent' : 'present'}`,
        `alternate-order regression coverage: ${regression ? 'present' : 'missing'}`,
        `bounded stress regression: ${stressRegression && stressPlan && hidden.passed ? 'executed and passed' : 'missing or failed'}`,
        `pre-fix outcomes and provenance: ${preFixReport ? 'recorded' : 'missing'}`,
        `revision/ownership causal trace: ${causal ? 'complete' : 'incomplete'}`,
        preFix.evidence,
        hidden.evidence,
      ],
    };
  },
};

const DEADLOCK_SOURCE = `export type Lock='sessionLock'|'queueLock';
export interface ShutdownResult { deadlocked:boolean; waitFor:string[]; pendingFlushes:number; drained:boolean; order:{shutdown:Lock[];flush:Lock[]} }

export const shutdownOrder: Lock[]=['sessionLock','queueLock'];
export const flushOrder: Lock[]=['queueLock','sessionLock'];

export function simulateConflictingSchedule(pendingFlushes=1): ShutdownResult {
  const firstShutdown=shutdownOrder[0]!; const firstFlush=flushOrder[0]!;
  const secondShutdown=shutdownOrder[1]!; const secondFlush=flushOrder[1]!;
  const cycle=firstShutdown===secondFlush && firstFlush===secondShutdown;
  return {
    deadlocked:cycle,
    waitFor:cycle?['shutdown waits queueLock held by flush','flush waits sessionLock held by shutdown']:[],
    pendingFlushes,
    drained:!cycle,
    order:{shutdown:[...shutdownOrder],flush:[...flushOrder]},
  };
}

export function simulateNormalShutdown(pendingFlushes=2): ShutdownResult {
  return { deadlocked:false,waitFor:[],pendingFlushes,drained:true,order:{shutdown:[...shutdownOrder],flush:[...flushOrder]} };
}
`;

const deadlockMaterializer: SkillEvalFixtureMaterializer = {
  id: 'concurrency-debugging/shutdown-flush-deadlock@1',
  matches: (scenario) => scenario.id === DEADLOCK,
  materialize: (destination) => {
    writeFixtureFile(destination, 'package.json', packageJson('kory-eval-concurrency-deadlock'));
    writeFixtureFile(destination, 'src/worker-pool.ts', DEADLOCK_SOURCE);
    writeFixtureFile(
      destination,
      'tests/normal-shutdown.test.ts',
      `import { expect,test } from 'bun:test'; import { simulateNormalShutdown } from '../src/worker-pool';
test('normal shutdown drains pending flushes',()=>{expect(simulateNormalShutdown(2)).toMatchObject({deadlocked:false,pendingFlushes:2,drained:true});});
`,
    );
    writeFixtureFile(
      destination,
      'README.md',
      `# Shutdown/flush deadlock fixture

\`simulateConflictingSchedule()\` deterministically represents the barrier state after shutdown acquires its first lock and flush acquires its first lock. Reconstruct the wait-for graph and inconsistent acquisition order. Repair the shared ownership/order rule so the conflicting schedule completes and pending flushes drain; preserve normal shutdown. Do not use polling, sleeps, or timeouts as correctness.

Write \`.kory-eval/concurrency-deadlock.json\` with the pre-fix wait-for cycle, each actor's lock order, violated ordering invariant, correction at the owning boundary, post-fix conflicting schedule, pending-flush preservation, and normal drain control.
`,
    );
  },
};

const deadlockScorer: SkillEvalDeterministicScorer = {
  id: 'concurrency-debugging/shutdown-flush-deadlock-scorer@1',
  scenarioIds: [DEADLOCK],
  score: ({ workingDirectory }) => {
    const hidden = runHiddenBunTest(
      workingDirectory,
      `import { expect,test } from 'bun:test'; import { shutdownOrder,flushOrder,simulateConflictingSchedule,simulateNormalShutdown } from '../src/worker-pool';
test('hidden: conflicting schedule has one coherent lock order and drains',()=>{expect(shutdownOrder).toEqual(flushOrder); expect(simulateConflictingSchedule(3)).toMatchObject({deadlocked:false,pendingFlushes:3,drained:true,waitFor:[]});});
test('hidden: normal shutdown still drains',()=>expect(simulateNormalShutdown(2)).toMatchObject({deadlocked:false,pendingFlushes:2,drained:true}));
`,
    );
    const source = readFileSync(join(workingDirectory, 'src/worker-pool.ts'), 'utf8');
    const noTimeout = !/setTimeout|sleep\s*\(|poll|timeout/iu.test(source);
    const regression = hasRegressionText(workingDirectory, [
      /conflict|deadlock/iu,
      /pending.*flush|drain/iu,
      /normal.*shutdown/iu,
    ]);
    const artifact = readJsonArtifact<unknown>(
      workingDirectory,
      '.kory-eval/concurrency-deadlock.json',
    );
    const body = JSON.stringify(artifact ?? '').toLowerCase();
    const causal =
      /sessionlock/u.test(body) &&
      /queuelock/u.test(body) &&
      /wait.?for|cycle/u.test(body) &&
      /shutdown/u.test(body) &&
      /flush/u.test(body) &&
      /order|ordering/u.test(body) &&
      /pending/u.test(body);
    const passed = hidden.passed && noTimeout && regression && Boolean(artifact) && causal;
    return {
      passed,
      quality: passed ? 1 : hidden.passed && noTimeout ? 0.75 : hidden.passed ? 0.5 : 0,
      verification: hidden.passed ? 1 : 0,
      integrityFailure: false,
      evidence: [
        `conflicting schedule + normal drain: ${hidden.passed ? 'pass' : 'fail'}`,
        `poll/sleep/timeout correctness: ${noTimeout ? 'absent' : 'present'}`,
        `deadlock/pending-flush regression coverage: ${regression ? 'present' : 'missing'}`,
        `wait-for graph and lock-order causal trace: ${causal ? 'complete' : 'incomplete'}`,
        hidden.evidence,
      ],
    };
  },
};

export const CONTRACT_CONCURRENCY_SKILL_EVAL_MATERIALIZERS: readonly SkillEvalFixtureMaterializer[] =
  [leaseMaterializer, jobSchemaMaterializer, saveMaterializer, deadlockMaterializer];

export const CONTRACT_CONCURRENCY_SKILL_EVAL_SCORERS: readonly SkillEvalDeterministicScorer[] = [
  leaseScorer,
  jobSchemaScorer,
  saveScorer,
  deadlockScorer,
];
