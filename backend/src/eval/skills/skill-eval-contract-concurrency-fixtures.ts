import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import type {
  SkillEvalDeterministicScorer,
  SkillEvalFixtureMaterializer,
  SkillEvalPreDispatchCapture,
} from './skill-eval-execution';
import {
  candidateBunTestFiles,
  hasRegressionText,
  packageJson,
  readFixtureText,
  readJsonArtifact,
  runCandidateBunTests,
  runHiddenBunTest,
  writeFixtureFile,
} from './skill-eval-fixture-helpers';

const LEASE = 'deterministic-contract-testing-full-task-1';
const JOB_SCHEMA = 'deterministic-contract-testing-full-task-2';
const CONCURRENT_SAVE = 'concurrency-debugging-full-task-1';
const DEADLOCK = 'concurrency-debugging-full-task-2';
const PRE_DISPATCH_PATH = '.kory-eval/original-source-observation.json';
const PRE_DISPATCH_SCRIPT = 'scripts/observe-original.ts';
const PRE_DISPATCH_COMMAND = ['npx', '--no-install', 'bun', 'run', PRE_DISPATCH_SCRIPT] as const;
const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');

interface OriginalSourceObservation {
  schemaVersion: 1;
  scenarioId: string;
  provenance: 'evaluator executed before candidate dispatch; not an agent action';
  sourcePath: string;
  sourceSha256: string;
  scriptPath: string;
  scriptSha256: string;
  command: string[];
  exitStatus: number;
  stdout: string;
  stderr: string;
  outcomes: unknown;
}

function captureOriginalSource(
  root: string, scenarioId: string, sourcePath: string, original: string,
  script: string, expected: unknown,
): { relativePath: string; text: string } {
  const referencePath = `reference/${sourcePath.slice('src/'.length).replace('.ts', '.before.ts')}`;
  if (readFixtureText(root, sourcePath) !== original ||
    readFixtureText(root, referencePath) !== original ||
    readFixtureText(root, PRE_DISPATCH_SCRIPT) !== script) {
    throw new Error('Original-source pre-dispatch capture has a mismatched source or observer');
  }
  const execution = spawnSync(PRE_DISPATCH_COMMAND[0], PRE_DISPATCH_COMMAND.slice(1), {
    cwd: root, encoding: 'utf8', timeout: 15_000, maxBuffer: 1_000_000,
  });
  if (execution.error || execution.signal || execution.status !== 0 ||
    readFixtureText(root, sourcePath) !== original ||
    readFixtureText(root, referencePath) !== original ||
    readFixtureText(root, PRE_DISPATCH_SCRIPT) !== script) {
    throw new Error(`Original-source observation execution failed: ${execution.error?.message ?? execution.stderr ?? execution.signal ?? execution.status}`);
  }
  const stdout = execution.stdout ?? '';
  let outcomes: unknown;
  try { outcomes = JSON.parse(stdout.trim()); } catch {
    throw new Error('Original-source observation did not emit valid JSON');
  }
  if (JSON.stringify(outcomes) !== JSON.stringify(expected)) {
    throw new Error('Original-source observation outcomes do not match the defective starting behavior');
  }
  const receipt: OriginalSourceObservation = {
    schemaVersion: 1, scenarioId,
    provenance: 'evaluator executed before candidate dispatch; not an agent action',
    sourcePath, sourceSha256: sha256(original),
    scriptPath: PRE_DISPATCH_SCRIPT, scriptSha256: sha256(script),
    command: [...PRE_DISPATCH_COMMAND], exitStatus: execution.status,
    stdout, stderr: execution.stderr ?? '', outcomes,
  };
  const text = `${JSON.stringify(receipt, null, 2)}\n`;
  writeFixtureFile(root, PRE_DISPATCH_PATH, text);
  return { relativePath: PRE_DISPATCH_PATH, text };
}

function verifiedOriginalSourceCapture(
  root: string, capture: SkillEvalPreDispatchCapture | undefined,
  scenarioId: string, sourcePath: string, original: string, script: string, expected: unknown,
): { passed: boolean; tampered: boolean; evidence: string } {
  if (!capture) return { passed: false, tampered: false, evidence: 'No trusted evaluator pre-dispatch observation was provided.' };
  try {
    const publicText = readFixtureText(root, PRE_DISPATCH_PATH);
    const receipt = JSON.parse(capture.text) as OriginalSourceObservation;
    const good = capture.relativePath === PRE_DISPATCH_PATH &&
      capture.sha256 === sha256(capture.text) && publicText === capture.text &&
      readFixtureText(root, `reference/${sourcePath.slice('src/'.length).replace('.ts', '.before.ts')}`) === original &&
      readFixtureText(root, PRE_DISPATCH_SCRIPT) === script &&
      receipt.schemaVersion === 1 && receipt.scenarioId === scenarioId &&
      receipt.provenance === 'evaluator executed before candidate dispatch; not an agent action' &&
      receipt.sourcePath === sourcePath && receipt.sourceSha256 === sha256(original) &&
      receipt.scriptPath === PRE_DISPATCH_SCRIPT && receipt.scriptSha256 === sha256(script) &&
      JSON.stringify(receipt.command) === JSON.stringify(PRE_DISPATCH_COMMAND) &&
      receipt.exitStatus === 0 &&
      JSON.stringify(JSON.parse(receipt.stdout.trim())) === JSON.stringify(expected) &&
      JSON.stringify(receipt.outcomes) === JSON.stringify(expected);
    return { passed: good, tampered: !good,
      evidence: good ? `Sealed pre-dispatch source=${receipt.sourceSha256}; command=${receipt.command.join(' ')}; status=0; public receipt intact; expected original-source outcomes verified.` : 'Pre-dispatch source, command, status, outcomes, observer or public receipt failed verification.' };
  } catch {
    return { passed: false, tampered: true, evidence: 'Trusted pre-dispatch capture or candidate-visible receipt missing, malformed or modified.' };
  }
}

function runTests(root: string, path: string): { status: number | null; output: string } {
  // The campaign may be launched through npx with Bun absent from PATH.
  // Reuse the runtime already executing this evaluator.
  const result = spawnSync(process.execPath, ['test', path], {
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

/** Prose counts are not execution receipts. Require tests to regenerate the record. */
function executedConcurrencyRepeatability(
  root: string,
  artifactPath: string,
  requiredSchedules: readonly string[],
  replaySource: (iterations: number, outcomes: unknown[]) => string,
): { passed: boolean; evidence: string } {
  let original: string | undefined;
  try {
    original = readFixtureText(root, artifactPath);
    const artifact = JSON.parse(original) as Record<string, unknown>;
    if (!artifact || typeof artifact !== 'object' || Array.isArray(artifact))
      throw new Error('Repeatability artifact must be an object');
    // A candidate-supplied static receipt cannot prove a loop ran. Remove it
    // before executing authored tests, then inspect only freshly written data.
    const cleared = { ...artifact };
    delete cleared.repeatabilityRegression;
    delete cleared.stressRegression;
    writeFixtureFile(root, artifactPath, JSON.stringify(cleared));
    const run = runCandidateBunTests(root);
    const fresh = readJsonArtifact<Record<string, unknown>>(root, artifactPath);
    const record = (fresh?.repeatabilityRegression ?? fresh?.stressRegression) as
      Record<string, unknown> | undefined;
    const iterations = record?.iterations;
    const ids = record?.scheduleIds ?? record?.orders ?? record?.schedules;
    const counts = record?.scheduleCounts as Record<string, unknown> | undefined;
    let outcomes = record?.outcomes ?? record?.perIterationOutcomes;
    // The task also allows a linked receipt instead of inline outcomes.
    if (!outcomes && typeof record?.testReceipt === 'string') {
      const receipt = readJsonArtifact<Record<string, unknown>>(root, record.testReceipt);
      outcomes = receipt?.outcomes ?? receipt?.perIterationOutcomes;
    }
    const valid = run.completed && run.passed && record &&
      Number.isSafeInteger(iterations) && Number(iterations) >= 2 && Number(iterations) <= 1_000 &&
      Array.isArray(ids) && ids.length === requiredSchedules.length &&
      new Set(ids).size === requiredSchedules.length &&
      requiredSchedules.every((id) => ids.includes(id) && counts?.[id] === iterations) &&
      Array.isArray(outcomes) && outcomes.length === iterations &&
      outcomes.every((row, index) => row && typeof row === 'object' &&
        (row as Record<string, unknown>).iteration === index + 1 &&
        requiredSchedules.every((id) => {
          const schedules = (row as Record<string, unknown>).schedules;
          return schedules && typeof schedules === 'object' &&
            Object.hasOwn(schedules, id);
        })) &&
      Array.isArray(record.failures) && record.failures.length === 0 &&
      (record.exitStatus ?? record.exitCode) === run.exitStatus &&
      typeof record.command === 'string' && /\bbun\s+test\b/u.test(record.command) &&
      typeof (record.name ?? record.testName ?? record.testReceipt) === 'string' &&
      String(record.name ?? record.testName ?? record.testReceipt).trim().length > 0;
    if (!valid) return {
      passed: false,
      evidence: `Executed repeatability: missing/invalid runtime-regenerated record (2–1000 iterations, exact schedule IDs/counts, per-iteration outcomes or linked receipt, named loop, command/exit status, failures).\n${run.evidence}`,
    };
    // Independently assert the complete invariant at every recorded iteration.
    // This is evaluator-owned fixed-simulation replay, not agent observations,
    // varied scheduling stress, a race detector, or production recovery.
    const replay = runHiddenBunTest(root, replaySource(Number(iterations), outcomes as unknown[]));
    return {
      passed: replay.passed,
      evidence: `Evaluator-owned fixed-simulation repeatability: ${replay.passed ? `${iterations} completed iterations; ${requiredSchedules.map((id) => `${id}=${iterations}`).join(', ')}; zero assertion failures` : 'failed'}. Candidate record regenerated by tests (exit ${String(run.exitStatus)}).\n${run.evidence}\n${replay.evidence}`,
    };
  } catch {
    return { passed: false, evidence: 'Executed repeatability: missing or unsafe runtime record.' };
  } finally {
    if (original !== undefined) writeFixtureFile(root, artifactPath, original);
  }
}

function concurrencyTestsRejectOriginal(root: string, sourcePath: string, original: string, artifactPath: string): {
  passed: boolean; rejectsDefect: boolean; evidence: string;
} {
  const authored = runCandidateBunTests(root);
  if (!authored.completed || !authored.passed)
    return { passed: false, rejectsDefect: false, evidence: authored.evidence };
  const repaired = readFixtureText(root, sourcePath);
  const artifact = existsSync(join(root, artifactPath)) ? readFixtureText(root, artifactPath) : undefined;
  try {
    writeFixtureFile(root, sourcePath, original);
    const defective = runCandidateBunTests(root);
    return { passed: true, rejectsDefect: defective.completed && !defective.passed,
      evidence: `${authored.evidence}\nOriginal-source replay: ${defective.evidence}` };
  } finally {
    writeFixtureFile(root, sourcePath, repaired);
    if (artifact !== undefined) writeFixtureFile(root, artifactPath, artifact);
  }
}

function hasConcurrencyModelLimits(body: string, deadlock = false): boolean {
  return /simulat|two.phase|modeled|modelled/u.test(body) &&
    /repeatability/u.test(body) &&
    /(?:not|no|unverified|unavailable|does not|cannot)[^.\n]{0,160}(?:real|native|varied|production|cleanup|recovery)/u.test(body) &&
    (!deadlock || /(?:not|no|unverified|unavailable|does not|cannot)[^.\n]{0,200}(?:completion|acknowledg|cleanup|recovery)/u.test(body));
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
  id: 'deterministic-contract-testing/job-command-schema-state-machine-scorer@3',
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
    // The task does not prescribe a test directory. Discover the candidate's
    // authored tests instead of assuming one hardcoded path; a candidate that
    // writes test/job-contract.test.ts and passes bun test must not score zero
    // because the evaluator only looked in tests/job-contract.test.ts.
    const discoveredTests = candidateBunTestFiles(workingDirectory);
    const first = runCandidateBunTests(workingDirectory, discoveredTests);
    let mutationRed = false;
    if (sourcePreserved && schemaPreserved && discoveredTests.length) {
      try {
        writeFileSync(
          schemaPath,
          schema.replace('"additionalProperties": false', '"additionalProperties": true'),
        );
        mutationRed = !runCandidateBunTests(workingDirectory, discoveredTests).passed;
      } finally {
        writeFileSync(schemaPath, schema);
      }
    }
    const restored = runCandidateBunTests(workingDirectory, discoveredTests);
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
      first.passed &&
      mutationRed &&
      restored.passed &&
      Boolean(artifact) &&
      report;
    return {
      passed,
      quality: passed ? 1 : first.passed && mutationRed ? 0.75 : first.passed ? 0.5 : 0,
      verification: first.passed && mutationRed && restored.passed ? 1 : 0,
      integrityFailure: !sourcePreserved || !schemaPreserved,
      evidence: [
        `production source/schema restored exactly: ${sourcePreserved && schemaPreserved ? 'yes' : 'no'}`,
        `compatibility/rejection/state transition suite: ${first.passed && regression ? 'pass' : 'fail'}`,
        `additionalProperties mutation proof: ${mutationRed ? 'red as required' : 'missing'}`,
        `restored suite: ${restored.passed ? 'green' : 'fail'}`,
        `local evidence boundary: ${report ? 'bounded' : 'missing'}`,
        `discovered candidate test files: ${discoveredTests.length}`,
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

const SAVE_OBSERVER = `import {DocumentStore,runOverlap} from '../src/document-store';
const s=new DocumentStore();const title=s.beginTitle('New');const tags=s.beginTags(['base','x']);
const sequential=new DocumentStore();sequential.commit(sequential.beginTitle('New'));sequential.commit(sequential.beginTags(['base','x']));
console.log(JSON.stringify({
  reads:{title:{revision:title.baseRevision,snapshot:title.snapshot},tags:{revision:tags.baseRevision,snapshot:tags.snapshot}},
  intendedDeltas:{title:{field:title.field,value:title.value},tags:{field:tags.field,value:tags.value}},
  commitOrders:{'title-first':['title','tags'],'tags-first':['tags','title']},
  outcomes:{'title-first':runOverlap('title-first'),'tags-first':runOverlap('tags-first')},
  sequential:sequential.read(),
}));
`;

const SAVE_EXPECTED = {
  reads: {
    title: { revision: 7, snapshot: { id: 'doc-1', revision: 7, title: 'Old', tags: ['base'] } },
    tags: { revision: 7, snapshot: { id: 'doc-1', revision: 7, title: 'Old', tags: ['base'] } },
  },
  intendedDeltas: { title: { field: 'title', value: 'New' }, tags: { field: 'tags', value: ['base', 'x'] } },
  commitOrders: { 'title-first': ['title', 'tags'], 'tags-first': ['tags', 'title'] },
  outcomes: {
    'title-first': { id: 'doc-1', revision: 9, title: 'Old', tags: ['base', 'x'] },
    'tags-first': { id: 'doc-1', revision: 9, title: 'New', tags: ['base'] },
  },
  sequential: { id: 'doc-1', revision: 9, title: 'New', tags: ['base', 'x'] },
};

const saveMaterializer: SkillEvalFixtureMaterializer = {
  id: 'concurrency-debugging/concurrent-document-saves@4',
  matches: (scenario) => scenario.id === CONCURRENT_SAVE,
  captureBeforeCandidateDispatch: (root) => captureOriginalSource(
    root, CONCURRENT_SAVE, 'src/document-store.ts', SAVE_SOURCE, SAVE_OBSERVER, SAVE_EXPECTED,
  ),
  materialize: (destination) => {
    writeFixtureFile(destination, 'package.json', packageJson('kory-eval-concurrency-save'));
    writeFixtureFile(destination, 'src/document-store.ts', SAVE_SOURCE);
    writeFixtureFile(destination, 'reference/document-store.before.ts', SAVE_SOURCE);
    writeFixtureFile(destination, PRE_DISPATCH_SCRIPT, SAVE_OBSERVER);
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

The evaluator executes \`scripts/observe-original.ts\` on the original \`src/document-store.ts\` before candidate dispatch. Read \`.kory-eval/original-source-observation.json\` before editing: it records both overlap orders, sequential control, revision-7 reads, intended deltas, full outcomes, exact source hash, invoked command and exit status. The evaluator seals a separate copy and rejects a modified or fabricated public receipt. This is an evaluator pre-dispatch observation, not an agent-executed action. You may execute the commands yourself before editing; report any such agent action separately. The \`reference/document-store.before.ts\` file allows post-edit original-source replay, which is not pre-edit agent evidence.

Repair the stale-snapshot overwrite at the per-document atomic-delta or compare-and-swap boundary. Preserve both independent updates, revision increments, sequential behavior, unrelated-document independence, and a fresh same-document update after handling stale work. Authored tests must pass the repair and reject the original source. No sleeps or global serialization.

Write \`.kory-eval/concurrency-save.json\` with pre-fix timelines/outcomes and provenance, violated invariant, correction/diff scope, controls and explicit evidence limits. These are fixed two-phase simulations, not real async barriers, varied scheduling stress, native race-detector evidence, or production recovery.

Public repeatability receipt contract: a named authored test must execute a bounded loop and regenerate a \`repeatabilityRegression\` (or \`stressRegression\`) object in this artifact when tests run. Include \`name\` (or \`testName\`), integer completed \`iterations\` from 2 through 1000, \`scheduleIds: ['title-first','tags-first']\` (\`orders\`/\`schedules\` are aliases), \`scheduleCounts\` mapping each ID to iterations, \`command\` naming the Bun test invocation, numeric \`exitStatus\` (or \`exitCode\`), and \`failures: []\`. Include \`outcomes\` (or \`perIterationOutcomes\`): one row per iteration, numbered from 1, with \`schedules\` mapping each ID to the complete returned document. A relative JSON \`testReceipt\` path with that outcomes array is also allowed. The evaluator removes stale repeatability records, runs tests, and independently executes/asserts every schedule and compares each full outcome; candidate JSON/stdout alone proves no execution. Label this fixed-schedule evidence repeatability, not varied stress.
`,
    );
  },
};

const saveScorer: SkillEvalDeterministicScorer = {
  id: 'concurrency-debugging/concurrent-document-saves-scorer@8',
  scenarioIds: [CONCURRENT_SAVE],
  score: ({ workingDirectory, preDispatchCapture }) => {
    const capture = verifiedOriginalSourceCapture(
      workingDirectory, preDispatchCapture, CONCURRENT_SAVE,
      'src/document-store.ts', SAVE_SOURCE, SAVE_OBSERVER, SAVE_EXPECTED,
    );
    const referencePath = join(workingDirectory, 'reference/document-store.before.ts');
    const referencePreserved =
      existsSync(referencePath) && readFileSync(referencePath, 'utf8') === SAVE_SOURCE;
    const preFix = referencePreserved
      ? runHiddenBunTest(
          workingDirectory,
          `import { expect,test } from 'bun:test'; import { runOverlap } from '../reference/document-store.before';
test('hidden: starting source reproduces both lost-update orders',()=>{expect(runOverlap('title-first')).toEqual({id:'doc-1',revision:9,title:'Old',tags:['base','x']});expect(runOverlap('tags-first')).toEqual({id:'doc-1',revision:9,title:'New',tags:['base']});});
`,
        )
      : { passed: false, evidence: 'preserved starting source missing or changed' };
    const hidden = runHiddenBunTest(
      workingDirectory,
      `import { expect,test } from 'bun:test'; import { DocumentStore,runOverlap } from '../src/document-store';
test('hidden: both overlap orders preserve complete document and revision',()=>{for(const order of ['title-first','tags-first'] as const){expect(runOverlap(order)).toEqual({id:'doc-1',revision:9,title:'New',tags:['base','x']});}});
test('hidden: sequential, unrelated document and fresh same-document update',()=>{const s=new DocumentStore(); const title=s.beginTitle('New'); const tags=s.beginTags(['base','x']); s.commit(title); s.commit(s.beginTitle('Independent','doc-2')); s.commit(tags); expect(s.read()).toEqual({id:'doc-1',revision:9,title:'New',tags:['base','x']}); expect(s.read('doc-2')).toEqual({id:'doc-2',revision:4,title:'Independent',tags:[]}); s.commit(s.beginTitle('Fresh')); expect(s.read()).toEqual({id:'doc-1',revision:10,title:'Fresh',tags:['base','x']}); const seq=new DocumentStore(); seq.commit(seq.beginTitle('New')); seq.commit(seq.beginTags(['base','x'])); expect(seq.read()).toEqual({id:'doc-1',revision:9,title:'New',tags:['base','x']});});
`,
    );
    const source = readFileSync(join(workingDirectory, 'src/document-store.ts'), 'utf8');
    const noBadSync = !/setTimeout|sleep\s*\(|globalLock|global.*mutex|serializeAll/iu.test(source);
    const regression = hasRegressionText(workingDirectory, [
      /title-first/u,
      /tags-first/u,
      /sequential/u,
    ]);
    const repeatability = executedConcurrencyRepeatability(
      workingDirectory, '.kory-eval/concurrency-save.json', ['title-first', 'tags-first'],
      (iterations, outcomes) => `import { expect,test } from 'bun:test'; import {runOverlap} from '../src/document-store';
test('evaluator-owned bounded fixed-simulation save repeatability',()=>{const recorded=${JSON.stringify(outcomes)};let completed=0;for(let i=0;i<${iterations};i++){for(const order of ['title-first','tags-first'] as const){const actual=runOverlap(order);expect(actual).toEqual({id:'doc-1',revision:9,title:'New',tags:['base','x']});expect(recorded[i].schedules[order]).toEqual(actual);}completed++;}expect(completed).toBe(${iterations});});
`,
    );
    const authored = hidden.passed
      ? concurrencyTestsRejectOriginal(workingDirectory, 'src/document-store.ts', SAVE_SOURCE,
          '.kory-eval/concurrency-save.json')
      : { passed: false, rejectsDefect: false, evidence: 'Repair did not pass invariant checks.' };
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
    const modelLimits = hasConcurrencyModelLimits(body);
    const postEditChecksPassed =
      referencePreserved && preFix.passed && hidden.passed && noBadSync && regression &&
      authored.passed && authored.rejectsDefect && repeatability.passed && Boolean(artifact) &&
      causal && preFixReport && modelLimits;
    return {
      passed: capture.passed && postEditChecksPassed,
      quality: capture.passed && postEditChecksPassed ? 1 : postEditChecksPassed ? 0.75 : hidden.passed ? 0.5 : 0,
      verification: capture.passed && postEditChecksPassed ? 1 : 0,
      integrityFailure: !referencePreserved || capture.tampered,
      evidence: [
        `trusted pre-dispatch original-source observation: ${capture.passed ? 'verified' : 'unavailable or invalid'}`,
        capture.evidence,
        `post-edit deterministic checks: ${postEditChecksPassed ? 'pass' : 'incomplete'}`,
        `preserved starting source: ${referencePreserved ? 'exact' : 'missing or changed'}`,
        `controlled pre-fix reproduction: ${preFix.passed ? 'pass' : 'fail'}`,
        `both full-state/revision schedules + sequential/unrelated/fresh-update controls: ${hidden.passed ? 'pass' : 'fail'}`,
        `global serialization/timing hack: ${noBadSync ? 'absent' : 'present'}`,
        `alternate-order regression coverage: ${regression ? 'present' : 'missing'}`,
        `candidate tests fail original lost update: ${authored.rejectsDefect ? 'yes' : 'no'}`,
        `bounded fixed-simulation repeatability: ${repeatability.passed ? 'evaluator-executed and compared' : 'missing or failed'}`,
        `pre-fix explanation: ${preFixReport ? 'recorded; separately verified by evaluator pre-dispatch capture' : 'missing'}`,
        `simulation/repeatability/runtime limits: ${modelLimits ? 'recorded' : 'missing'}`,
        authored.evidence,
        repeatability.evidence,
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

const DEADLOCK_OBSERVER = `import {shutdownOrder,flushOrder,simulateConflictingSchedule,simulateNormalShutdown} from '../src/worker-pool';
console.log(JSON.stringify({lockOrders:{shutdown:shutdownOrder,flush:flushOrder},
  conflicting:simulateConflictingSchedule(3),normalShutdown:simulateNormalShutdown(2),
  waitForCycle:['shutdown waits queueLock held by flush','flush waits sessionLock held by shutdown']}));
`;

const DEADLOCK_EXPECTED = {
  lockOrders: { shutdown: ['sessionLock', 'queueLock'], flush: ['queueLock', 'sessionLock'] },
  conflicting: {
    deadlocked: true,
    waitFor: ['shutdown waits queueLock held by flush', 'flush waits sessionLock held by shutdown'],
    pendingFlushes: 3, drained: false,
    order: { shutdown: ['sessionLock', 'queueLock'], flush: ['queueLock', 'sessionLock'] },
  },
  normalShutdown: {
    deadlocked: false, waitFor: [], pendingFlushes: 2, drained: true,
    order: { shutdown: ['sessionLock', 'queueLock'], flush: ['queueLock', 'sessionLock'] },
  },
  waitForCycle: ['shutdown waits queueLock held by flush', 'flush waits sessionLock held by shutdown'],
};

const deadlockMaterializer: SkillEvalFixtureMaterializer = {
  id: 'concurrency-debugging/shutdown-flush-deadlock@3',
  matches: (scenario) => scenario.id === DEADLOCK,
  captureBeforeCandidateDispatch: (root) => captureOriginalSource(
    root, DEADLOCK, 'src/worker-pool.ts', DEADLOCK_SOURCE, DEADLOCK_OBSERVER, DEADLOCK_EXPECTED,
  ),
  materialize: (destination) => {
    writeFixtureFile(destination, 'package.json', packageJson('kory-eval-concurrency-deadlock'));
    writeFixtureFile(destination, 'src/worker-pool.ts', DEADLOCK_SOURCE);
    writeFixtureFile(destination, 'reference/worker-pool.before.ts', DEADLOCK_SOURCE);
    writeFixtureFile(destination, PRE_DISPATCH_SCRIPT, DEADLOCK_OBSERVER);
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

The evaluator runs \`scripts/observe-original.ts\` against the original \`src/worker-pool.ts\` before candidate dispatch. Read \`.kory-eval/original-source-observation.json\` before editing: it binds exact original-source hash, command, exit status, conflicting/normal schedule outcomes and the wait-for cycle. The evaluator seals a separate receipt and rejects public receipt edits or forgery. This is an evaluator pre-dispatch observation, not an agent-executed action; record any agent actions separately. Post-edit replay of \`reference/worker-pool.before.ts\` is not evidence of pre-edit agent commands.

Construct the shutdown → queueLock → flush → sessionLock → shutdown waiter/resource/holder cycle and each acquisition sequence. Repair one coherent shared lock order without discarding pending flushes. Authored regressions must reject the original defect and pass the repair; retain a normal control with positive pending work. No polling, sleeps or timeout correctness fixes.

Write \`.kory-eval/concurrency-deadlock.json\` with those timelines, violated invariant, actual correction/diff, pending-work preservation and model limits. These functions simulate a wait graph and drain flag, not real workers, blocked lock waits, completion acknowledgments, watchdog cleanup, injected failure/recovery, alternate runtime orderings or varied scheduling stress. State those unavailable checks explicitly.

Public repeatability receipt contract: a named authored test must execute a bounded loop and regenerate a \`repeatabilityRegression\` (or \`stressRegression\`) object in the artifact when tests run. Include \`name\` (or \`testName\`), integer completed \`iterations\` from 2 through 1000, \`scheduleIds: ['conflicting','normal-shutdown']\` (\`orders\`/\`schedules\` are aliases), \`scheduleCounts\` mapping both IDs to iterations, \`command\` naming the Bun test invocation, numeric \`exitStatus\` (or \`exitCode\`), and \`failures: []\`. Each \`outcomes\` (or \`perIterationOutcomes\`) row is numbered from 1 and has \`schedules\` containing each complete returned ShutdownResult; use positive pending work and retain its count. A relative JSON \`testReceipt\` path containing the outcomes array is also allowed. The evaluator removes stale records, runs tests, independently replays/asserts every recorded schedule with its pending-work count and compares complete outcomes; candidate JSON/stdout alone is not execution evidence. Call this fixed-schedule repeatability, not varied stress.
`,
    );
  },
};

const deadlockScorer: SkillEvalDeterministicScorer = {
  id: 'concurrency-debugging/shutdown-flush-deadlock-scorer@4',
  scenarioIds: [DEADLOCK],
  score: ({ workingDirectory, preDispatchCapture }) => {
    const capture = verifiedOriginalSourceCapture(
      workingDirectory, preDispatchCapture, DEADLOCK,
      'src/worker-pool.ts', DEADLOCK_SOURCE, DEADLOCK_OBSERVER, DEADLOCK_EXPECTED,
    );
    const referencePreserved = existsSync(join(workingDirectory, 'reference/worker-pool.before.ts')) &&
      readFixtureText(workingDirectory, 'reference/worker-pool.before.ts') === DEADLOCK_SOURCE;
    const preFix = referencePreserved ? runHiddenBunTest(workingDirectory,
      `import {expect,test} from 'bun:test'; import {simulateConflictingSchedule,simulateNormalShutdown} from '../reference/worker-pool.before';
test('evaluator-owned original-source deadlock and normal-control replay',()=>{expect(simulateConflictingSchedule(3)).toEqual({deadlocked:true,waitFor:['shutdown waits queueLock held by flush','flush waits sessionLock held by shutdown'],pendingFlushes:3,drained:false,order:{shutdown:['sessionLock','queueLock'],flush:['queueLock','sessionLock']}});expect(simulateNormalShutdown(2)).toMatchObject({deadlocked:false,pendingFlushes:2,drained:true,waitFor:[]});});
`) : { passed: false, evidence: 'Preserved original deadlock source missing or changed.' };
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
    // Candidate-authored regression tests must distinguish the repaired code
    // from the original deadlocking implementation. Keyword-only tests that
    // assert normal shutdown must not count as proof of the concurrency fix.
    const authored = hidden.passed
      ? concurrencyTestsRejectOriginal(workingDirectory, 'src/worker-pool.ts', DEADLOCK_SOURCE,
          '.kory-eval/concurrency-deadlock.json')
      : { passed: false, rejectsDefect: false, evidence: 'Repair did not pass invariant checks.' };
    const rejectsDefect = authored.rejectsDefect;
    const repeatability = executedConcurrencyRepeatability(
      workingDirectory, '.kory-eval/concurrency-deadlock.json', ['conflicting', 'normal-shutdown'],
      (iterations, outcomes) => `import {expect,test} from 'bun:test'; import {shutdownOrder,flushOrder,simulateConflictingSchedule,simulateNormalShutdown} from '../src/worker-pool';
test('evaluator-owned bounded fixed-simulation shutdown repeatability',()=>{const recorded=${JSON.stringify(outcomes)};let completed=0;for(let i=0;i<${iterations};i++){for(const id of ['conflicting','normal-shutdown'] as const){const prior=recorded[i].schedules[id];expect(Number.isSafeInteger(prior.pendingFlushes)).toBe(true);expect(prior.pendingFlushes).toBeGreaterThan(0);const actual=id==='conflicting'?simulateConflictingSchedule(prior.pendingFlushes):simulateNormalShutdown(prior.pendingFlushes);expect(shutdownOrder).toEqual(flushOrder);expect(actual).toMatchObject({deadlocked:false,waitFor:[],pendingFlushes:prior.pendingFlushes,drained:true});expect(prior).toEqual(actual);}completed++;}expect(completed).toBe(${iterations});});
`,
    );
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
    const modelLimits = hasConcurrencyModelLimits(body, true);
    const postEditChecksPassed =
      referencePreserved && preFix.passed && hidden.passed && noTimeout && regression &&
      authored.passed && rejectsDefect && repeatability.passed &&
      Boolean(artifact) && causal && modelLimits;
    return {
      passed: capture.passed && postEditChecksPassed,
      quality: capture.passed && postEditChecksPassed ? 1 : postEditChecksPassed ? 0.75 : hidden.passed ? 0.5 : 0,
      verification: capture.passed && postEditChecksPassed ? 1 : 0,
      integrityFailure: !referencePreserved || capture.tampered,
      evidence: [
        `trusted pre-dispatch original-source observation: ${capture.passed ? 'verified' : 'unavailable or invalid'}`,
        capture.evidence,
        `post-edit deterministic checks: ${postEditChecksPassed ? 'pass' : 'incomplete'}`,
        `preserved original source: ${referencePreserved ? 'exact' : 'missing or changed'}`,
        `evaluator-owned original-source conflicting/normal replay: ${preFix.passed ? 'pass' : 'fail'}; not proof of agent pre-edit execution`,
        `conflicting schedule + normal drain: ${hidden.passed ? 'pass' : 'fail'}`,
        `poll/sleep/timeout correctness: ${noTimeout ? 'absent' : 'present'}`,
        `deadlock/pending-flush regression coverage: ${regression ? 'present' : 'missing'}`,
        `candidate tests pass repaired code: ${authored.passed ? 'yes' : 'no'}`,
        `candidate tests fail original deadlock: ${rejectsDefect ? 'yes' : 'no'}`,
        `wait-for graph and lock-order causal trace: ${causal ? 'complete' : 'incomplete'}`,
        `bounded fixed-simulation repeatability: ${repeatability.passed ? 'evaluator-executed and compared' : 'missing or failed'}`,
        `simulation/completion/cleanup/recovery limits: ${modelLimits ? 'recorded' : 'missing'}`,
        authored.evidence,
        repeatability.evidence,
        preFix.evidence,
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
