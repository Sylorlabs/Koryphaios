import type {
  SkillEvalDeterministicScore,
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

const BACKEND_JOB = 'backend-engineering-full-task-1-individual';
const BACKEND_SYNC = 'backend-engineering-full-task-2-individual';
const DATA_AOV = 'data-analysis-full-task-1-individual';
const DATA_RETENTION = 'data-analysis-full-task-2-individual';
const AGENT_REMEDIATION = 'agentic-systems-full-task-1';
const AGENT_MANAGER = 'agentic-systems-full-task-2';
const APPSEC_IMPORT = 'application-security-full-task-1';
const APPSEC_DESKTOP = 'application-security-full-task-2';
const IX_CONTROL = 'interaction-design-full-task-high-consequence-control';
const IX_IMPORT = 'interaction-design-full-task-resumable-import';

function hiddenScore(input: {
  root: string;
  source: string;
  coverage?: RegExp[];
  coverageLabel?: string;
  extraPassed?: boolean;
  extraEvidence?: string[];
}): SkillEvalDeterministicScore {
  const hidden = runHiddenBunTest(input.root, input.source);
  const coverage = input.coverage?.length ? hasRegressionText(input.root, input.coverage) : true;
  const extraPassed = input.extraPassed ?? true;
  const passed = hidden.passed && coverage && extraPassed;
  return {
    passed,
    quality: hidden.passed ? (coverage && extraPassed ? 1 : 0.75) : 0,
    verification: hidden.passed ? 1 : 0,
    integrityFailure: false,
    evidence: [
      `hidden behavior checks: ${hidden.passed ? 'pass' : 'fail'}`,
      ...(input.coverage?.length
        ? [`${input.coverageLabel ?? 'regression coverage'}: ${coverage ? 'present' : 'missing'}`]
        : []),
      ...(input.extraEvidence ?? []),
      hidden.evidence,
    ],
  };
}

const backendJobMaterializer: SkillEvalFixtureMaterializer = {
  id: 'backend-engineering/idempotent-job-state-machine@1',
  matches: (scenario) => scenario.id === BACKEND_JOB,
  materialize: (destination) => {
    writeFixtureFile(destination, 'package.json', packageJson('kory-eval-backend-job'));
    writeFixtureFile(
      destination,
      'src/system.ts',
      `export type JobState = 'pending' | 'processing' | 'committed' | 'cancelled';

export interface Job {
  id: string;
  idempotencyKey: string;
  invoiceId: string;
  state: JobState;
  claimedBy: string | null;
  objectKey: string | null;
}

export interface CreateResponse {
  status: 202;
  jobId: string;
}

export class InvoiceJobSystem {
  private sequence = 0;
  private readonly jobs = new Map<string, Job>();
  private readonly idempotency = new Map<string, string>();
  private readonly queue: string[] = [];
  private readonly objects = new Map<string, string>();

  createInvoiceJob(idempotencyKey: string, invoiceId: string): CreateResponse {
    // BUG: the request retry path ignores the existing idempotency owner.
    const jobId = \`job-\${++this.sequence}\`;
    this.jobs.set(jobId, {
      id: jobId,
      idempotencyKey,
      invoiceId,
      state: 'pending',
      claimedBy: null,
      objectKey: null,
    });
    this.idempotency.set(idempotencyKey, jobId);
    this.queue.push(jobId);
    return { status: 202, jobId };
  }

  requestCancel(jobId: string): boolean {
    const job = this.jobs.get(jobId);
    if (!job || job.state !== 'pending') return false;
    job.state = 'cancelled';
    return true;
  }

  redeliver(jobId: string): void {
    this.queue.push(jobId);
  }

  runWorkerOnce(workerId: string, fault?: 'after-upload'): { jobId: string | null; crashed: boolean } {
    const jobId = this.queue.shift() ?? null;
    if (!jobId) return { jobId: null, crashed: false };
    const job = this.jobs.get(jobId);
    if (!job || job.state === 'cancelled' || job.state === 'committed') return { jobId, crashed: false };

    // BUG: a redelivery can take over processing without reconciling the first attempt.
    job.state = 'processing';
    job.claimedBy = workerId;
    const objectKey = \`invoices/\${job.id}/\${Date.now()}-\${workerId}.pdf\`;
    this.objects.set(objectKey, \`invoice=\${job.invoiceId}\`);
    if (fault === 'after-upload') return { jobId, crashed: true };

    job.objectKey = objectKey;
    job.state = 'committed';
    return { jobId, crashed: false };
  }

  getJob(jobId: string): Job | undefined {
    const job = this.jobs.get(jobId);
    return job ? { ...job } : undefined;
  }

  jobCount(): number {
    return this.jobs.size;
  }

  objectKeys(): string[] {
    return [...this.objects.keys()].sort();
  }
}
`,
    );
    writeFixtureFile(
      destination,
      'tests/system.test.ts',
      `import { expect, test } from 'bun:test';
import { InvoiceJobSystem } from '../src/system';

test('normal request creates and commits one job', () => {
  const system = new InvoiceJobSystem();
  const created = system.createInvoiceJob('idem-1', 'inv-1');
  expect(created.status).toBe(202);
  expect(system.runWorkerOnce('worker-a').jobId).toBe(created.jobId);
  expect(system.getJob(created.jobId)?.state).toBe('committed');
});

test('pending jobs can be cancelled', () => {
  const system = new InvoiceJobSystem();
  const created = system.createInvoiceJob('idem-1', 'inv-1');
  expect(system.requestCancel(created.jobId)).toBe(true);
  expect(system.getJob(created.jobId)?.state).toBe('cancelled');
});
`,
    );
    writeFixtureFile(
      destination,
      'README.md',
      `# Invoice job recovery fixture

The public request contract is fixed: \`createInvoiceJob(key, invoiceId) -> { status: 202, jobId }\`.
The queue is at-least-once and can redeliver the same job. Object storage is durable across worker failure. A timeout/crash after upload does not prove the upload failed. Cancellation is supported only before processing commits.

Repair the implementation and add regression tests. A correct design gives one stable logical job and one stable output identity per idempotency key, reconciles uncertain upload outcomes, and makes redelivery harmless without assuming exactly-once queue delivery.
`,
    );
  },
};

const backendJobScorer: SkillEvalDeterministicScorer = {
  id: 'backend-engineering/idempotent-job-state-machine-scorer@2',
  scenarioIds: [BACKEND_JOB],
  score: ({ workingDirectory }) =>
    hiddenScore({
      root: workingDirectory,
      // The hidden checks establish idempotency/correctness. For the user-authored
      // regression suite, require observable recovery exercises rather than
      // particular words such as "idempotent" or "recovery" in test names.
      coverage: [/\bredeliver\s*\(/u, /runWorkerOnce\s*\([^,\n]+,\s*['"](?:after-|before-)/u],
      coverageLabel: 'recovery regression behavior coverage',
      source: `import { expect, test } from 'bun:test';
import { InvoiceJobSystem } from '../src/system';

test('hidden: duplicate HTTP retries reuse the logical job identity', () => {
  const system = new InvoiceJobSystem();
  const first = system.createInvoiceJob('same-key', 'inv-1');
  const second = system.createInvoiceJob('same-key', 'inv-1');
  expect(second).toEqual(first);
  expect(system.jobCount()).toBe(1);
});

test('hidden: crash after upload reconciles to one stable output', () => {
  const system = new InvoiceJobSystem();
  const created = system.createInvoiceJob('crash-key', 'inv-2');
  expect(system.runWorkerOnce('worker-a', 'after-upload').crashed).toBe(true);
  system.redeliver(created.jobId);
  system.runWorkerOnce('worker-b');
  expect(system.getJob(created.jobId)?.state).toBe('committed');
  expect(system.objectKeys()).toHaveLength(1);
  expect(system.getJob(created.jobId)?.objectKey).toBe(system.objectKeys()[0]);
});

test('hidden: duplicate delivery after commit is harmless', () => {
  const system = new InvoiceJobSystem();
  const created = system.createInvoiceJob('race-key', 'inv-3');
  system.redeliver(created.jobId);
  system.runWorkerOnce('worker-a');
  system.runWorkerOnce('worker-b');
  expect(system.objectKeys()).toHaveLength(1);
  expect(system.getJob(created.jobId)?.state).toBe('committed');
});

test('hidden: cancellation before commit never creates output', () => {
  const system = new InvoiceJobSystem();
  const created = system.createInvoiceJob('cancel-key', 'inv-4');
  expect(system.requestCancel(created.jobId)).toBe(true);
  system.runWorkerOnce('worker-a');
  expect(system.objectKeys()).toHaveLength(0);
});
`,
    }),
};

const backendSyncMaterializer: SkillEvalFixtureMaterializer = {
  id: 'backend-engineering/restart-safe-sync-checkpoint@1',
  matches: (scenario) => scenario.id === BACKEND_SYNC,
  materialize: (destination) => {
    writeFixtureFile(destination, 'package.json', packageJson('kory-eval-backend-sync'));
    writeFixtureFile(
      destination,
      'src/sync.ts',
      `export interface Change {
  id: string;
  entityId: string;
  version: number;
  value: string;
}

export interface ChangePage {
  cursor: string | null;
  nextCursor: string;
  changes: Change[];
}

export interface SyncState {
  cursor: string | null;
  entities: Record<string, { version: number; value: string }>;
  counters: { applied: number };
  sideEffects: Array<{ changeId: string; entityId: string }>;
}

export function emptyState(): SyncState {
  return { cursor: null, entities: {}, counters: { applied: 0 }, sideEffects: [] };
}

export function applyPage(
  state: SyncState,
  page: ChangePage,
  options: { interruptAfter?: number; cancelAfter?: number } = {},
): { completed: boolean; cancelled: boolean } {
  for (let index = 0; index < page.changes.length; index += 1) {
    const change = page.changes[index]!;
    const current = state.entities[change.entityId];
    if (!current || change.version >= current.version) {
      state.entities[change.entityId] = { version: change.version, value: change.value };
    }
    // BUG: replay repeats logical side effects even when the entity write is idempotent.
    state.counters.applied += 1;
    state.sideEffects.push({ changeId: change.id, entityId: change.entityId });
    if (options.interruptAfter === index + 1) throw new Error('synthetic interruption');
    if (options.cancelAfter === index + 1) return { completed: false, cancelled: true };
  }
  state.cursor = page.nextCursor;
  return { completed: true, cancelled: false };
}
`,
    );
    writeFixtureFile(
      destination,
      'tests/sync.test.ts',
      `import { expect, test } from 'bun:test';
import { applyPage, emptyState } from '../src/sync';

test('clean page advances its opaque cursor', () => {
  const state = emptyState();
  applyPage(state, {
    cursor: null,
    nextCursor: 'cursor-2',
    changes: [{ id: 'c1', entityId: 'a', version: 1, value: 'one' }],
  });
  expect(state.cursor).toBe('cursor-2');
  expect(state.entities.a?.value).toBe('one');
});
`,
    );
    writeFixtureFile(
      destination,
      'README.md',
      `# Restart-safe page application fixture

Remote change ids are stable and cursors are opaque. The local schema already persists \`entities\`, \`counters\`, \`sideEffects\`, and \`cursor\`; keep that shape compatible. Entity writes are versioned. \`counters.applied\` and \`sideEffects\` count effective logical updates, not delivery attempts. A page cursor may advance only after the whole page is safely accounted for.

Interruption or cancellation before the page checkpoint causes the remote page to be replayed after restart. Stale changes and duplicate change ids must not create new logical effects.
`,
    );
  },
};

const backendSyncScorer: SkillEvalDeterministicScorer = {
  id: 'backend-engineering/restart-safe-sync-checkpoint-scorer@1',
  scenarioIds: [BACKEND_SYNC],
  score: ({ workingDirectory }) =>
    hiddenScore({
      root: workingDirectory,
      coverage: [/interrupt|restart|replay/i, /duplicate|stale|changeId/i],
      coverageLabel: 'replay/stale regression coverage',
      source: `import { expect, test } from 'bun:test';
import { applyPage, emptyState, type ChangePage } from '../src/sync';

const page: ChangePage = {
  cursor: null,
  nextCursor: 'next-1',
  changes: [
    { id: 'c1', entityId: 'a', version: 1, value: 'one' },
    { id: 'c2', entityId: 'b', version: 1, value: 'two' },
    { id: 'c3', entityId: 'a', version: 2, value: 'three' },
  ],
};

test('hidden: restart after every record boundary is logically exactly-once', () => {
  for (const boundary of [1, 2, 3]) {
    const state = emptyState();
    try { applyPage(state, page, { interruptAfter: boundary }); } catch {}
    expect(state.cursor).toBe(null);
    applyPage(state, page);
    expect(state.cursor).toBe('next-1');
    expect(state.counters.applied).toBe(3);
    expect(state.sideEffects.map((item) => item.changeId)).toEqual(['c1', 'c2', 'c3']);
    expect(state.entities.a).toEqual({ version: 2, value: 'three' });
  }
});

test('hidden: duplicate ids and stale versions do not create logical effects', () => {
  const state = emptyState();
  applyPage(state, page);
  applyPage(state, {
    cursor: 'next-1',
    nextCursor: 'next-2',
    changes: [
      { id: 'c3', entityId: 'a', version: 2, value: 'three' },
      { id: 'c4', entityId: 'a', version: 1, value: 'stale' },
    ],
  });
  expect(state.entities.a).toEqual({ version: 2, value: 'three' });
  expect(state.counters.applied).toBe(3);
  expect(state.sideEffects.map((item) => item.changeId)).toEqual(['c1', 'c2', 'c3']);
  expect(state.cursor).toBe('next-2');
});

test('hidden: cancellation leaves cursor replayable without double effects', () => {
  const state = emptyState();
  expect(applyPage(state, page, { cancelAfter: 1 }).cancelled).toBe(true);
  expect(state.cursor).toBe(null);
  applyPage(state, page);
  expect(state.counters.applied).toBe(3);
  expect(state.cursor).toBe('next-1');
});
`,
    }),
};

const dataAovMaterializer: SkillEvalFixtureMaterializer = {
  id: 'data-analysis/unit-grain-revenue-reconciliation@1',
  matches: (scenario) => scenario.id === DATA_AOV,
  materialize: (destination) => {
    writeFixtureFile(
      destination,
      'package.json',
      packageJson('kory-eval-data-aov', { test: 'bun test', analyze: 'bun src/analyze.ts' }),
    );
    writeFixtureFile(
      destination,
      'data/orders.csv',
      `row_id,order_id,line_id,created_at,source_version,legacy_total,status,line_amount_dollars
r1,P1,L1,2026-06-10,v1,10000,paid,60
r2,P1,L2,2026-06-10,v1,10000,paid,40
r2,P1,L2,2026-06-10,v1,10000,paid,40
r3,P2,L1,2026-06-20,v2,80,paid,80
r4,P3,L1,2026-06-25,v1,12000,refunded,70
r5,P3,L2,2026-06-25,v1,12000,refunded,50
r6,Q1,L1,2026-07-05,v2,90,paid,30
r7,Q1,L2,2026-07-05,v2,90,paid,30
r8,Q1,L3,2026-07-05,v2,90,paid,30
r9,Q2,L1,2026-07-10,v1,7000,paid,70
r10,Q3,L1,2026-07-15,v2,60,refunded,20
r11,Q3,L2,2026-07-15,v2,60,refunded,40
`,
    );
    writeFixtureFile(
      destination,
      'src/analyze.ts',
      `import { readFileSync, writeFileSync } from 'node:fs';

const rows = readFileSync('data/orders.csv', 'utf8').trim().split('\\n').slice(1).map((line) => {
  const [rowId, orderId, lineId, createdAt, sourceVersion, legacyTotal, status, lineAmount] = line.split(',');
  return { rowId, orderId, lineId, createdAt, sourceVersion, legacyTotal: Number(legacyTotal), status, lineAmount: Number(lineAmount) };
});

const pre = rows.filter((row) => row.createdAt < '2026-07-01');
const post = rows.filter((row) => row.createdAt >= '2026-07-01');
const average = (values: number[]) => values.reduce((sum, value) => sum + value, 0) / Math.max(1, values.length);

// BUG: row grain, mixed units, duplicates, and refunds are all treated as if they were clean orders.
const result = {
  grain: 'row',
  duplicateRowsRemoved: 0,
  refundedOrdersExcludedFromAov: 0,
  reconciliation: {},
  aov: { pre: average(pre.map((row) => row.legacyTotal)), post: average(post.map((row) => row.legacyTotal)) },
  naiveRowAverage: { pre: average(pre.map((row) => row.legacyTotal)), post: average(post.map((row) => row.legacyTotal)) },
  uncertainty: { method: 'none', sampleSizePre: pre.length, sampleSizePost: post.length },
  conclusion: { direction: 'unknown', causal: true },
};

writeFileSync('analysis.json', JSON.stringify(result, null, 2) + '\\n');
`,
    );
    writeFixtureFile(
      destination,
      'tests/analyze.test.ts',
      `import { expect, test } from 'bun:test';

test('fixture documents the pricing boundary', () => {
  expect('2026-07-01').toMatch(/^2026-07-01$/);
});
`,
    );
    writeFixtureFile(
      destination,
      'README.md',
      `# Pricing-change AOV analysis fixture

Pricing changed at 2026-07-01. The export is line-item grain and repeats the order total on each line. \`row_id\` identifies ingestion rows; exact duplicate row ids are duplicate ingestion records. Source version \`v1\` stores \`legacy_total\` in cents and \`v2\` stores it in dollars. Refunded orders remain in gross reconciliation but are excluded from the paid-order AOV comparison.

Make \`bun run analyze\` write \`analysis.json\` with these fields: \`grain\`, \`duplicateRowsRemoved\`, \`refundedOrdersExcludedFromAov\`, \`reconciliation.pre/post.{orders,grossRevenue,netRevenue}\`, \`aov.{pre,post,difference,percentChange}\`, \`naiveRowAverage.{pre,post}\`, \`uncertainty.{method,sampleSizePre,sampleSizePost}\`, and \`conclusion.{direction,causal}\`. Calculations must be reproducible from the CSV; do not hard-code the expected totals.
`,
    );
  },
};

interface AovArtifact {
  grain?: string;
  duplicateRowsRemoved?: number;
  refundedOrdersExcludedFromAov?: number;
  reconciliation?: {
    pre?: { orders?: number; grossRevenue?: number; netRevenue?: number };
    post?: { orders?: number; grossRevenue?: number; netRevenue?: number };
  };
  aov?: { pre?: number; post?: number; difference?: number; percentChange?: number };
  naiveRowAverage?: { pre?: number; post?: number };
  uncertainty?: { method?: string; sampleSizePre?: number; sampleSizePost?: number };
  conclusion?: { direction?: string; causal?: boolean };
}

function close(actual: number | undefined, expected: number, tolerance = 1e-6): boolean {
  return typeof actual === 'number' && Math.abs(actual - expected) <= tolerance;
}

const dataAovScorer: SkillEvalDeterministicScorer = {
  id: 'data-analysis/unit-grain-revenue-reconciliation-scorer@2',
  scenarioIds: [DATA_AOV],
  score: ({ workingDirectory }) => {
    const hidden = runHiddenBunTest(
      workingDirectory,
      `import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';

test('hidden: analysis command completes', () => {
  const result = spawnSync('bun', ['run', 'analyze'], { cwd: process.cwd(), encoding: 'utf8' });
  expect(result.status).toBe(0);
});
`,
    );
    const artifact = readJsonArtifact<AovArtifact>(workingDirectory, 'analysis.json');
    const grain = artifact?.grain?.trim().toLowerCase() ?? '';
    const direction = artifact?.conclusion?.direction?.trim().toLowerCase() ?? '';
    const checks =
      artifact !== null &&
      /\border\b/u.test(grain) &&
      artifact.duplicateRowsRemoved === 1 &&
      artifact.refundedOrdersExcludedFromAov === 2 &&
      artifact.reconciliation?.pre?.orders === 3 &&
      close(artifact.reconciliation?.pre?.grossRevenue, 300) &&
      close(artifact.reconciliation?.pre?.netRevenue, 180) &&
      artifact.reconciliation?.post?.orders === 3 &&
      close(artifact.reconciliation?.post?.grossRevenue, 220) &&
      close(artifact.reconciliation?.post?.netRevenue, 160) &&
      close(artifact.aov?.pre, 90) &&
      close(artifact.aov?.post, 80) &&
      close(artifact.aov?.difference, -10) &&
      close(artifact.aov?.percentChange, -11.11111111111111, 0.02) &&
      close(artifact.naiveRowAverage?.pre, 9013.333333333334, 0.02) &&
      close(artifact.naiveRowAverage?.post, 1231.6666666666667, 0.02) &&
      artifact.uncertainty?.sampleSizePre === 2 &&
      artifact.uncertainty?.sampleSizePost === 2 &&
      Boolean(artifact.uncertainty?.method && artifact.uncertainty.method !== 'none') &&
      /^(down|fell|decreas(?:e|ed))$/u.test(direction) &&
      artifact.conclusion?.causal === false;
    return {
      passed: hidden.passed && checks,
      quality: hidden.passed ? (checks ? 1 : 0.5) : 0,
      verification: hidden.passed && artifact ? 1 : 0,
      integrityFailure: false,
      evidence: [
        `analysis command: ${hidden.passed ? 'pass' : 'fail'}`,
        `grain/unit/reconciliation contract: ${checks ? 'pass' : 'fail'}`,
        hidden.evidence,
      ],
    };
  },
};

const dataRetentionMaterializer: SkillEvalFixtureMaterializer = {
  id: 'data-analysis/subgroup-retention-uncertainty@1',
  matches: (scenario) => scenario.id === DATA_RETENTION,
  materialize: (destination) => {
    writeFixtureFile(
      destination,
      'package.json',
      packageJson('kory-eval-data-retention', { test: 'bun test', analyze: 'bun src/analyze.ts' }),
    );
    const rows: string[] = ['customer_id,account_id,cohort_month,device,retained_30d'];
    for (let index = 1; index <= 15; index += 1) {
      rows.push(`m-mega-${index},mega,2026-06,mobile,${index <= 14 ? 1 : 0}`);
    }
    for (let index = 1; index <= 10; index += 1) {
      rows.push(`m-small-${index},small-${index},2026-06,mobile,${index <= 6 ? 1 : 0}`);
    }
    for (let index = 1; index <= 25; index += 1) {
      rows.push(`d-${index},desktop-${index},2026-06,desktop,${index <= 17 ? 1 : 0}`);
    }
    for (let index = 1; index <= 5; index += 1) {
      rows.push(`a-m-${index},aug-mobile-${index},2026-08,mobile,${index <= 3 ? 1 : 0}`);
      rows.push(`a-d-${index},aug-desktop-${index},2026-08,desktop,${index <= 3 ? 1 : 0}`);
    }
    for (let index = 1; index <= 20; index += 1) {
      rows.push(`a-null-${index},aug-null-${index},2026-08,,${index <= 12 ? 1 : 0}`);
    }
    writeFixtureFile(destination, 'data/retention.csv', `${rows.join('\n')}\n`);
    writeFixtureFile(
      destination,
      'src/analyze.ts',
      `import { readFileSync, writeFileSync } from 'node:fs';

const rows = readFileSync('data/retention.csv', 'utf8').trim().split('\\n').slice(1).map((line) => {
  const [customerId, accountId, cohortMonth, device, retained] = line.split(',');
  return { customerId, accountId, cohortMonth, device, retained: Number(retained) };
});
const june = rows.filter((row) => row.cohortMonth === '2026-06');
const rate = (subset: typeof rows) => subset.reduce((sum, row) => sum + row.retained, 0) / Math.max(1, subset.length);
const mobile = june.filter((row) => row.device === 'mobile');
const desktop = june.filter((row) => row.device === 'desktop');

// BUG: reports the headline subgroup difference without checking missingness or account concentration.
writeFileSync('analysis.json', JSON.stringify({
  claimCohort: '2026-06',
  naiveKnownDevice: { mobileRate: rate(mobile), desktopRate: rate(desktop), differencePoints: (rate(mobile) - rate(desktop)) * 100 },
  missingness: { before: 0, after: 0 },
  mobileConcentration: { dominantAccount: null, share: 0 },
  sensitivityWithoutDominant: { mobileRate: rate(mobile), desktopRate: rate(desktop), differencePoints: (rate(mobile) - rate(desktop)) * 100 },
  conclusion: { robust: true, causal: true },
}, null, 2) + '\\n');
`,
    );
    writeFixtureFile(
      destination,
      'tests/analyze.test.ts',
      `import { expect, test } from 'bun:test';\ntest('claim cohort is fixed', () => expect('2026-06').toBe('2026-06'));\n`,
    );
    writeFixtureFile(
      destination,
      'README.md',
      `# Subgroup retention uncertainty fixture

The product claim refers to the 2026-06 cohort. Retention means activity within 30 days. Instrumentation changed before the 2026-08 cohort and the device field can then be missing. The question is descriptive subgroup evidence, not experiment design or a causal effect estimate.

Make \`bun run analyze\` write \`analysis.json\` with \`claimCohort\`, \`naiveKnownDevice.{mobileRate,desktopRate,differencePoints}\`, \`missingness.{before,after}\`, \`mobileConcentration.{dominantAccount,share}\`, \`sensitivityWithoutDominant.{mobileRate,desktopRate,differencePoints}\`, and \`conclusion.{robust,causal}\`. Base every number on the CSV and expose the sensitivity result rather than averaging it away.
`,
    );
  },
};

interface RetentionArtifact {
  claimCohort?: string;
  naiveKnownDevice?: { mobileRate?: number; desktopRate?: number; differencePoints?: number };
  missingness?: { before?: number; after?: number };
  mobileConcentration?: { dominantAccount?: string | null; share?: number };
  sensitivityWithoutDominant?: {
    mobileRate?: number;
    desktopRate?: number;
    differencePoints?: number;
  };
  conclusion?: { robust?: boolean; causal?: boolean };
}

const dataRetentionScorer: SkillEvalDeterministicScorer = {
  id: 'data-analysis/subgroup-retention-uncertainty-scorer@1',
  scenarioIds: [DATA_RETENTION],
  score: ({ workingDirectory }) => {
    const hidden = runHiddenBunTest(
      workingDirectory,
      `import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
test('hidden: analysis command completes', () => {
  expect(spawnSync('bun', ['run', 'analyze'], { cwd: process.cwd() }).status).toBe(0);
});
`,
    );
    const artifact = readJsonArtifact<RetentionArtifact>(workingDirectory, 'analysis.json');
    const checks =
      artifact !== null &&
      artifact.claimCohort === '2026-06' &&
      close(artifact.naiveKnownDevice?.mobileRate, 0.8) &&
      close(artifact.naiveKnownDevice?.desktopRate, 0.68) &&
      close(artifact.naiveKnownDevice?.differencePoints, 12) &&
      close(artifact.missingness?.before, 0) &&
      close(artifact.missingness?.after, 2 / 3, 1e-6) &&
      artifact.mobileConcentration?.dominantAccount === 'mega' &&
      close(artifact.mobileConcentration?.share, 0.6) &&
      close(artifact.sensitivityWithoutDominant?.mobileRate, 0.6) &&
      close(artifact.sensitivityWithoutDominant?.desktopRate, 0.68) &&
      close(artifact.sensitivityWithoutDominant?.differencePoints, -8) &&
      artifact.conclusion?.robust === false &&
      artifact.conclusion?.causal === false;
    return {
      passed: hidden.passed && checks,
      quality: hidden.passed ? (checks ? 1 : 0.5) : 0,
      verification: hidden.passed && artifact ? 1 : 0,
      integrityFailure: false,
      evidence: [
        `analysis command: ${hidden.passed ? 'pass' : 'fail'}`,
        `missingness/concentration/sensitivity contract: ${checks ? 'pass' : 'fail'}`,
        hidden.evidence,
      ],
    };
  },
};

const appsecImportMaterializer: SkillEvalFixtureMaterializer = {
  id: 'application-security/media-import-boundaries@3',
  matches: (scenario) => scenario.id === APPSEC_IMPORT,
  materialize: (destination) => {
    writeFixtureFile(destination, 'package.json', packageJson('kory-eval-appsec-import'));
    writeFixtureFile(
      destination,
      'src/importer.ts',
      `import { join } from 'node:path';

export interface FetchHop {
  url: string;
  resolvedIp: string;
}

export interface ArchiveMetadata {
  entries: number;
  totalUncompressedBytes: number;
  maxEntryBytes: number;
  maxDepth: number;
}

export interface ConverterInvocation {
  file: string;
  args: string[];
  shell: boolean;
}

export const LIMITS = {
  maxRedirects: 8,
  maxEntries: 10_000,
  maxTotalUncompressedBytes: 2_000_000_000,
  maxEntryBytes: 1_000_000_000,
  maxDepth: 32,
};

export function validateFetchChain(hops: FetchHop[]): boolean {
  // BUG: validates only the first URL string and trusts later redirects/resolution.
  const first = hops[0];
  return Boolean(first && first.url.startsWith('https://'));
}

export function archiveDestination(jobRoot: string, entryName: string): string {
  // BUG: lexical joining allows traversal and absolute-path surprises.
  return join(jobRoot, entryName);
}

export function validateArchive(metadata: ArchiveMetadata): boolean {
  // BUG: no resource limits are actually enforced.
  return metadata.entries > 0;
}

export function converterInvocation(input: string, output: string, options: string[]): ConverterInvocation {
  // BUG: shell interpolation turns option/file values into command syntax.
  return {
    file: 'sh',
    args: ['-c', \`media-converter \${options.join(' ')} \${input} -o \${output}\`],
    shell: true,
  };
}

export function sanitizeDiagnostic(message: string): string {
  // BUG: raw secrets and control sequences flow into logs.
  return message;
}
`,
    );
    writeFixtureFile(
      destination,
      'tests/importer.test.ts',
      `import { expect, test } from 'bun:test';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { archiveDestination, converterInvocation, validateArchive, validateFetchChain } from '../src/importer';

test('happy-path public input remains accepted', () => {
  const root = mkdtempSync(join(tmpdir(), 'kory-appsec-import-'));
  try {
    expect(validateFetchChain([{ url: 'https://media.example/file.zip', resolvedIp: '1.1.1.1' }])).toBe(true);
    expect(archiveDestination(root, 'a.wav')).toBe(join(realpathSync(root), 'a.wav'));
    expect(validateArchive({ entries: 3, totalUncompressedBytes: 1000, maxEntryBytes: 800, maxDepth: 2 })).toBe(true);
    expect(converterInvocation('a.wav', 'a.mp3', ['--quality', 'high']).args.length).toBeGreaterThan(0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
`,
    );
    writeFixtureFile(
      destination,
      'README.md',
      `# Media-import security fixture

The caller is already authorized; do not redesign authorization. The service may fetch only HTTPS public-network sources. Every redirect target and resolved address must satisfy the same destination policy. Archive and output paths must remain inside the job root after normalization/canonicalization. The converter executable is fixed and must receive attacker-controlled values as structured argv entries, never shell syntax.

The supplied happy-path job root exists before path confinement is evaluated. Resolve that real root (and existing ancestors for new targets) rather than assuming an invented absolute path exists. The fixture requires the existing \`--quality low|medium|high\` option contract; implementations may reject unsupported converter flags. Safe argument separation is proved with supported options plus attacker-controlled file/operand values, not by requiring arbitrary flags to be accepted.

Resource limits must cover redirect count, archive entry count, total expanded bytes, per-entry bytes, and nesting depth. Failures are fail-closed and user-visible diagnostics must not leak credentials or terminal/control sequences. Add reproducible negative tests for the privileged sinks you harden.
`,
    );
  },
};

const appsecImportScorer: SkillEvalDeterministicScorer = {
  id: 'application-security/media-import-boundaries-scorer@3',
  scenarioIds: [APPSEC_IMPORT],
  score: ({ workingDirectory }) =>
    hiddenScore({
      root: workingDirectory,
      coverage: [
        /redirect|private|localhost|ssrf/i,
        /travers|archive|path/i,
        /shell|argv|converter/i,
      ],
      coverageLabel: 'security negative-case coverage',
      source: `import { expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { archiveDestination, converterInvocation, sanitizeDiagnostic, validateArchive, validateFetchChain } from '../src/importer';

test('hidden: every redirect and resolved address is revalidated', () => {
  expect(validateFetchChain([
    { url: 'https://media.example/a.zip', resolvedIp: '1.1.1.1' },
    { url: 'https://internal.example/a.zip', resolvedIp: '127.0.0.1' },
  ])).toBe(false);
  expect(validateFetchChain([{ url: 'http://media.example/a.zip', resolvedIp: '1.1.1.1' }])).toBe(false);
  expect(validateFetchChain([{ url: 'https://user:secret@media.example/a.zip', resolvedIp: '1.1.1.1' }])).toBe(false);
  expect(validateFetchChain([{ url: 'https://media.example/a.zip', resolvedIp: '203.0.113.10' }])).toBe(false);
  expect(validateFetchChain([{ url: 'https://media.example/a.zip', resolvedIp: '10.1.2.3' }])).toBe(false);
  expect(validateFetchChain([{ url: 'https://media.example/a.zip', resolvedIp: '169.254.1.1' }])).toBe(false);
});

test('hidden: archive paths cannot escape the job root', () => {
  const root = mkdtempSync(join(tmpdir(), 'kory-appsec-root-'));
  const outside = mkdtempSync(join(tmpdir(), 'kory-appsec-outside-'));
  try {
    mkdirSync(join(root, 'nested'));
    symlinkSync(outside, join(root, 'escape-link'), process.platform === 'win32' ? 'junction' : 'dir');
    expect(() => archiveDestination(root, '../escape.txt')).toThrow();
    expect(() => archiveDestination(root, '/etc/passwd')).toThrow();
    expect(() => archiveDestination(root, 'escape-link/file.wav')).toThrow();
    expect(archiveDestination(root, 'nested/file.wav')).toBe(
      join(realpathSync(root), 'nested', 'file.wav'),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test('hidden: declared archive limits fail closed', () => {
  expect(validateArchive({ entries: 10_001, totalUncompressedBytes: 100, maxEntryBytes: 100, maxDepth: 1 })).toBe(false);
  expect(validateArchive({ entries: 1, totalUncompressedBytes: 2_000_000_001, maxEntryBytes: 100, maxDepth: 1 })).toBe(false);
  expect(validateArchive({ entries: 1, totalUncompressedBytes: 100, maxEntryBytes: 1_000_000_001, maxDepth: 1 })).toBe(false);
  expect(validateArchive({ entries: 1, totalUncompressedBytes: 100, maxEntryBytes: 100, maxDepth: 33 })).toBe(false);
});

test('hidden: converter values remain argv data and executable stays fixed', () => {
  const call = converterInvocation('input;touch pwn', 'out;rm -rf nope.mp3', ['--quality', 'high']);
  expect(call.file).toBe('media-converter');
  expect(call.shell).toBe(false);
  expect(call.args).toContain('input;touch pwn');
  expect(call.args).toContain('out;rm -rf nope.mp3');
  expect(call.args).toContain('high');
});

test('hidden: diagnostics redact secrets and terminal controls', () => {
  const result = sanitizeDiagnostic('Authorization: Bearer top-secret\\nname=bad\\u001b[31m');
  expect(result).not.toContain('top-secret');
  expect(result).not.toContain('\\u001b');
  expect(result.length).toBeLessThanOrEqual(1024);
});
`,
    }),
};

const appsecDesktopMaterializer: SkillEvalFixtureMaterializer = {
  id: 'application-security/desktop-sync-client-boundaries@2',
  matches: (scenario) => scenario.id === APPSEC_DESKTOP,
  materialize: (destination) => {
    writeFixtureFile(destination, 'package.json', packageJson('kory-eval-appsec-desktop'));
    writeFixtureFile(
      destination,
      'src/security.ts',
      `import { join } from 'node:path';

export type Command =
  | { version: 1; op: 'sync'; accountId: string }
  | { version: 1; op: 'open-path'; path: string }
  | { version: 1; op: 'export-recovery' };

export interface Session {
  accountId: string;
  credentialHandle: string;
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  revoked: boolean;
  reauthenticatedAt: number | null;
}

export interface QueuedOperation {
  version: 1;
  id: string;
  op: 'sync' | 'open-path';
  path?: string;
}

export function parseCommand(raw: string): Command {
  // BUG: arbitrary JSON is trusted as a privileged command.
  return JSON.parse(raw) as Command;
}

export function resolveAuthorizedPath(root: string, requested: string): string {
  // BUG: lexical join does not enforce the authorized root.
  return join(root, requested);
}

export function restoreQueue(raw: string): QueuedOperation[] {
  // BUG: persisted entries bypass current validation.
  return JSON.parse(raw) as QueuedOperation[];
}

export function serializeSession(session: Session): string {
  // BUG: access and refresh credentials are persisted into ordinary app state.
  return JSON.stringify(session);
}

export function redactDiagnostic(message: string): string {
  return message;
}

export function canExportRecovery(session: Session, now: number): boolean {
  // BUG: cached local authority ignores expiry, revocation, and fresh reauthentication.
  return Boolean(session.accessToken) && now >= 0;
}
`,
    );
    writeFixtureFile(
      destination,
      'tests/security.test.ts',
      `import { expect, test } from 'bun:test';
import { canExportRecovery, parseCommand } from '../src/security';

test('valid sync command parses', () => {
  expect(parseCommand(JSON.stringify({ version: 1, op: 'sync', accountId: 'acct-1' }))).toEqual({ version: 1, op: 'sync', accountId: 'acct-1' });
});

test('fresh active session can export', () => {
  const now = 1_000_000;
  expect(canExportRecovery({ accountId: 'a', credentialHandle: 'keychain:a', accessToken: 'x', refreshToken: 'y', expiresAt: now + 60_000, revoked: false, reauthenticatedAt: now }, now)).toBe(true);
});
`,
    );
    writeFixtureFile(
      destination,
      'README.md',
      `# Desktop sync application-security fixture

Deep-link/IPC payloads are untrusted serialized input. Only version 1 operations in the exported \`Command\` union are supported, with bounded payload/string sizes; unknown privileged operations fail closed. Filesystem access is limited to a user-selected authorized root after canonical path checks.

Persisted queue entries are revalidated on load. Ordinary serialized session state may retain only the protected credential handle, never access/refresh token values. Recovery export requires an unrevoked, unexpired session plus reauthentication within the last 60 seconds. Diagnostics must redact token-like secrets and control characters.
`,
    );
    writeFixtureFile(destination, 'authorized/docs/readme.md', 'authorized fixture file\n');
  },
};

const appsecDesktopScorer: SkillEvalDeterministicScorer = {
  id: 'application-security/desktop-sync-client-boundaries-scorer@2',
  scenarioIds: [APPSEC_DESKTOP],
  score: ({ workingDirectory }) =>
    hiddenScore({
      root: workingDirectory,
      coverage: [
        /malformed|unknown|payload|schema/i,
        /revok|expir|reauth/i,
        /travers|authorized.*root|canonical/i,
      ],
      coverageLabel: 'desktop trust-boundary regression coverage',
      source: `import { expect, test } from 'bun:test';
import { join } from 'node:path';
import { canExportRecovery, parseCommand, redactDiagnostic, resolveAuthorizedPath, restoreQueue, serializeSession, type Session } from '../src/security';

test('hidden: malformed, oversized, and unknown commands fail closed', () => {
  expect(() => parseCommand('{bad')).toThrow();
  expect(() => parseCommand(JSON.stringify({ version: 1, op: 'delete-everything' }))).toThrow();
  expect(() => parseCommand(JSON.stringify({ version: 2, op: 'sync', accountId: 'a' }))).toThrow();
  expect(() => parseCommand(JSON.stringify({ version: 1, op: 'sync', accountId: 'x'.repeat(5000) }))).toThrow();
});

test('hidden: requested files stay within the authorized root', () => {
  const root = join(process.cwd(), 'authorized');
  expect(() => resolveAuthorizedPath(root, '../secret.txt')).toThrow();
  expect(() => resolveAuthorizedPath(root, '/etc/passwd')).toThrow();
  expect(resolveAuthorizedPath(root, 'docs/readme.md')).toBe(join(root, 'docs', 'readme.md'));
});

test('hidden: malformed persisted queue entries never regain authority', () => {
  expect(() => restoreQueue(JSON.stringify([{ version: 1, id: '1', op: 'delete-everything' }]))).toThrow();
  expect(() => restoreQueue(JSON.stringify([{ version: 9, id: '1', op: 'sync' }]))).toThrow();
  expect(restoreQueue(JSON.stringify([{ version: 1, id: '1', op: 'sync' }]))).toHaveLength(1);
});

test('hidden: ordinary session serialization excludes bearer credentials', () => {
  const session: Session = { accountId: 'a', credentialHandle: 'keychain:a', accessToken: 'access-secret', refreshToken: 'refresh-secret', expiresAt: 1000, revoked: false, reauthenticatedAt: 900 };
  const serialized = serializeSession(session);
  expect(serialized).toContain('keychain:a');
  expect(serialized).not.toContain('access-secret');
  expect(serialized).not.toContain('refresh-secret');
});

test('hidden: recovery export requires live authority plus fresh reauthentication', () => {
  const now = 1_000_000;
  const base: Session = { accountId: 'a', credentialHandle: 'keychain:a', accessToken: 'x', refreshToken: 'y', expiresAt: now + 1000, revoked: false, reauthenticatedAt: now - 30_000 };
  expect(canExportRecovery(base, now)).toBe(true);
  expect(canExportRecovery({ ...base, revoked: true }, now)).toBe(false);
  expect(canExportRecovery({ ...base, expiresAt: now - 1 }, now)).toBe(false);
  expect(canExportRecovery({ ...base, reauthenticatedAt: now - 60_001 }, now)).toBe(false);
  expect(canExportRecovery({ ...base, reauthenticatedAt: null }, now)).toBe(false);
});

test('hidden: diagnostics redact credential-looking content and controls', () => {
  const value = redactDiagnostic('access_token=secret-value\\nrefresh=other-secret\\u001b[2J');
  expect(value).not.toContain('secret-value');
  expect(value).not.toContain('other-secret');
  expect(value).not.toContain('\\u001b');
});
`,
    }),
};

const agentRemediationMaterializer: SkillEvalFixtureMaterializer = {
  id: 'agentic-systems/bounded-remediation-agent@1',
  matches: (scenario) => scenario.id === AGENT_REMEDIATION,
  materialize: (destination) => {
    writeFixtureFile(destination, 'package.json', packageJson('kory-eval-agent-remediation'));
    writeFixtureFile(
      destination,
      'src/agent.ts',
      `export interface HealthState { healthy: boolean; revision: string }
export interface DeploymentState { revision: string }
export interface MutationReceipt { applied: boolean; idempotencyKey: string }

export interface RemediationTools {
  readHealth(): HealthState;
  readDeployment(): DeploymentState;
  readFeatureFlag(name: string): boolean;
  requestApproval(action: { kind: 'restart_revision' | 'set_feature_flag'; target: string }): boolean;
  restartRevision(revision: string, idempotencyKey: string): MutationReceipt;
  setFeatureFlag(name: string, enabled: boolean, idempotencyKey: string): MutationReceipt;
  independentHealth(): HealthState;
}

export interface RunRecord {
  status: 'success' | 'blocked' | 'failure' | 'unverified';
  steps: number;
  toolCalls: number;
  records: Array<{ kind: string; detail: string }>;
}

export function remediate(
  tools: RemediationTools,
  budget: { maxSteps: number; maxToolCalls: number } = { maxSteps: 12, maxToolCalls: 24 },
): RunRecord {
  const records: RunRecord['records'] = [];
  let toolCalls = 0;
  const health = tools.readHealth(); toolCalls += 1;
  if (health.healthy) return { status: 'success', steps: 1, toolCalls, records };
  const deployment = tools.readDeployment(); toolCalls += 1;
  const approved = tools.requestApproval({ kind: 'restart_revision', target: deployment.revision }); toolCalls += 1;
  records.push({ kind: 'approval', detail: approved ? 'approved' : 'denied' });
  if (!approved) return { status: 'blocked', steps: 2, toolCalls, records };

  // BUG: mutation uses stale state, retries uncertain outcomes blindly, and self-certifies success.
  try {
    tools.restartRevision(deployment.revision, 'restart-1'); toolCalls += 1;
  } catch {
    tools.restartRevision(deployment.revision, 'restart-2'); toolCalls += 1;
  }
  records.push({ kind: 'mutation', detail: deployment.revision });
  return { status: 'success', steps: Math.min(3, budget.maxSteps), toolCalls, records };
}
`,
    );
    writeFixtureFile(
      destination,
      'tests/agent.test.ts',
      `import { expect, test } from 'bun:test';
import { remediate, type RemediationTools } from '../src/agent';

test('healthy service is a no-mutation success', () => {
  const tools: RemediationTools = {
    readHealth: () => ({ healthy: true, revision: 'r1' }),
    readDeployment: () => ({ revision: 'r1' }),
    readFeatureFlag: () => false,
    requestApproval: () => true,
    restartRevision: (_revision, idempotencyKey) => ({ applied: true, idempotencyKey }),
    setFeatureFlag: (_name, _enabled, idempotencyKey) => ({ applied: true, idempotencyKey }),
    independentHealth: () => ({ healthy: true, revision: 'r1' }),
  };
  expect(remediate(tools).status).toBe('success');
});
`,
    );
    writeFixtureFile(
      destination,
      'README.md',
      `# Bounded remediation-agent fixture

Read-only observation tools do not require approval. \`restartRevision\` and \`setFeatureFlag\` are mutations and require approval immediately before the concrete action. External deployment/flag state can change between planning and mutation, so relevant state must be re-read after approval and before execution.

A mutation call may throw \`Error('timeout-after-apply')\` after the external mutation actually succeeded. Reconcile current state before any retry and reuse a stable idempotency key. Final success requires \`independentHealth()\`; a self-issued mutation receipt is not completion evidence. Return a finite \`RunRecord\` for denial, repeated tool errors, exhausted budgets, and unverified final state. Record approvals, proposals/executions, reconciliation, and budget use sufficiently for resume/audit.
`,
    );
  },
};

const agentRemediationScorer: SkillEvalDeterministicScorer = {
  id: 'agentic-systems/bounded-remediation-agent-scorer@2',
  scenarioIds: [AGENT_REMEDIATION],
  score: ({ workingDirectory }) =>
    hiddenScore({
      root: workingDirectory,
      coverage: [/approval|denied/i, /timeout|reconcil|idemp/i, /independent.*health|unverified/i],
      coverageLabel: 'agent authority/recovery regression coverage',
      source: `import { expect, test } from 'bun:test';
import { remediate, type RemediationTools } from '../src/agent';

function baseTools(overrides: Partial<RemediationTools> = {}): RemediationTools {
  return {
    readHealth: () => ({ healthy: false, revision: 'r1' }),
    readDeployment: () => ({ revision: 'r1' }),
    readFeatureFlag: () => false,
    requestApproval: () => true,
    restartRevision: (_revision, idempotencyKey) => ({ applied: true, idempotencyKey }),
    setFeatureFlag: (_name, _enabled, idempotencyKey) => ({ applied: true, idempotencyKey }),
    independentHealth: () => ({ healthy: true, revision: 'r1' }),
    ...overrides,
  };
}

test('hidden: denied approval blocks every mutation', () => {
  let mutations = 0;
  const result = remediate(baseTools({
    requestApproval: () => false,
    restartRevision: (_revision, idempotencyKey) => { mutations += 1; return { applied: true, idempotencyKey }; },
  }));
  expect(result.status).toBe('blocked');
  expect(mutations).toBe(0);
});

test('hidden: deployment is re-read immediately before mutation', () => {
  let reads = 0;
  let restarted: string | null = null;
  const result = remediate(baseTools({
    readDeployment: () => ({ revision: ++reads === 1 ? 'r1' : 'r2' }),
    restartRevision: (revision, idempotencyKey) => { restarted = revision; return { applied: true, idempotencyKey }; },
    independentHealth: () => ({ healthy: true, revision: 'r2' }),
  }));
  expect(reads).toBeGreaterThanOrEqual(2);
  expect(restarted).toBe('r2');
  expect(result.status).toBe('success');
});

test('hidden: uncertain mutation outcome is reconciled before retry', () => {
  let mutations = 0;
  let healthy = false;
  const result = remediate(baseTools({
    restartRevision: (_revision, idempotencyKey) => {
      mutations += 1;
      healthy = true;
      if (mutations === 1) throw new Error('timeout-after-apply');
      return { applied: true, idempotencyKey };
    },
    readHealth: () => ({ healthy, revision: 'r1' }),
    independentHealth: () => ({ healthy, revision: 'r1' }),
  }));
  expect(mutations).toBe(1);
  expect(result.status).toBe('success');
  const trace = JSON.stringify(result.records);
  expect(trace).toMatch(/uncertain/i);
  expect(trace).toMatch(/independent health|independently verified/i);
});

test('hidden: independent health evidence gates completion', () => {
  const result = remediate(baseTools({ independentHealth: () => ({ healthy: false, revision: 'r1' }) }));
  expect(result.status).not.toBe('success');
});

test('hidden: repeated observation failures terminate within finite budgets', () => {
  let calls = 0;
  const result = remediate(baseTools({
    readHealth: () => { calls += 1; throw new Error('temporary read failure'); },
  }), { maxSteps: 4, maxToolCalls: 5 });
  expect(['failure', 'blocked', 'unverified']).toContain(result.status);
  expect(result.steps).toBeLessThanOrEqual(4);
  expect(result.toolCalls).toBeLessThanOrEqual(5);
  expect(calls).toBeLessThanOrEqual(5);
});
`,
    }),
};

const agentManagerMaterializer: SkillEvalFixtureMaterializer = {
  id: 'agentic-systems/multi-agent-investigation-manager@2',
  matches: (scenario) => scenario.id === AGENT_MANAGER,
  materialize: (destination) => {
    writeFixtureFile(destination, 'package.json', packageJson('kory-eval-agent-manager'));
    writeFixtureFile(
      destination,
      'src/manager.ts',
      `export type SpecialistName = 'dependency-analysis' | 'test-evidence';

export interface SpecialistContract {
  name: SpecialistName;
  objective: string;
  allowedTools: string[];
  maxSteps: number;
  maxCost: number;
  requiredArtifact: string;
  maxDelegationDepth: number;
}

export interface SpecialistResult {
  name: SpecialistName;
  status: 'complete' | 'partial' | 'failed';
  conclusion: string;
  evidenceRefs: string[];
  artifact: string | null;
  requestedScopeExpansion?: boolean;
}

export interface InvestigationState {
  results: Partial<Record<SpecialistName, SpecialistResult>>;
}

export interface InvestigationTools {
  runSpecialist(contract: SpecialistContract): SpecialistResult;
  readPrimaryEvidence(ref: string): string;
}

export interface InvestigationResult extends InvestigationState {
  status: 'complete' | 'partial' | 'blocked';
  contracts: SpecialistContract[];
  contradictions: string[];
  primaryEvidenceRead: string[];
  staleMemoryUsed: boolean;
}

export function investigate(
  tools: InvestigationTools,
  previousMemory: { conclusion: string; timestamp: number } | null,
  resume: InvestigationState = { results: {} },
): InvestigationResult {
  const contracts: SpecialistContract[] = [
    { name: 'dependency-analysis', objective: 'find dependency cause', allowedTools: ['read-repo', 'run-tests', 'mutate'], maxSteps: 1000, maxCost: 1000, requiredArtifact: 'dependency.json', maxDelegationDepth: 5 },
    { name: 'test-evidence', objective: 'inspect tests', allowedTools: ['read-repo', 'run-tests', 'message-user'], maxSteps: 1000, maxCost: 1000, requiredArtifact: 'tests.json', maxDelegationDepth: 5 },
  ];
  const results = { ...resume.results };
  for (const contract of contracts) {
    // BUG: completed resume state is ignored and specialists are always rerun.
    results[contract.name] = tools.runSpecialist(contract);
  }
  const conclusions = Object.values(results).map((item) => item?.conclusion).filter(Boolean) as string[];
  const contradictions = new Set(conclusions).size > 1 ? conclusions : [];
  return {
    status: 'complete',
    contracts,
    results,
    contradictions,
    primaryEvidenceRead: [],
    staleMemoryUsed: Boolean(previousMemory),
  };
}
`,
    );
    writeFixtureFile(
      destination,
      'tests/manager.test.ts',
      `import { expect, test } from 'bun:test';
import { investigate, type InvestigationTools } from '../src/manager';

test('manager delegates both named specialties', () => {
  const tools: InvestigationTools = {
    runSpecialist: (contract) => ({ name: contract.name, status: 'complete', conclusion: 'same cause', evidenceRefs: ['repo:1'], artifact: contract.requiredArtifact }),
    readPrimaryEvidence: () => 'current evidence',
  };
  expect(Object.keys(investigate(tools, null).results).sort()).toEqual(['dependency-analysis', 'test-evidence']);
});
`,
    );
    writeFixtureFile(
      destination,
      'README.md',
      `# Multi-agent incident-investigation fixture

The manager may delegate exactly two first-level tasks: dependency/regression analysis and test-evidence analysis. Specialists receive only \`read-repo\` and \`run-tests\`; they never inherit mutation, user-communication, or further delegation authority. Each contract must have finite step/cost limits, \`maxDelegationDepth: 0\`, and a required evidence artifact. Aggregate parallelism is at most two.

Resume must preserve already completed/partial specialist results. A requested scope expansion is rejected rather than silently broadening the contract. Contradictory causal conclusions must be checked against each cited primary evidence ref through \`readPrimaryEvidence\`. In this synthetic fixture, primary evidence uses explicit decision markers: \`supports:<exact specialist conclusion>\` means the evidence supports that conclusion, while \`ambiguous\` means it cannot decide between competing conclusions. If all material primary evidence supports one exact conclusion, the contradiction is resolved; if material evidence is ambiguous, disagreement remains explicit and completion is withheld. Previous-incident memory is advisory only and must be marked unused/superseded when current evidence conflicts. Completion requires both required artifacts and a reconciled evidence contract; missing/partial evidence cannot become fabricated certainty.
`,
    );
  },
};

const agentManagerScorer: SkillEvalDeterministicScorer = {
  id: 'agentic-systems/multi-agent-investigation-manager-scorer@2',
  scenarioIds: [AGENT_MANAGER],
  score: ({ workingDirectory }) =>
    hiddenScore({
      root: workingDirectory,
      coverage: [
        /read-only|allowedTools|delegat/i,
        /resume|partial|timeout/i,
        /contradict|primary.*evidence|stale/i,
      ],
      coverageLabel: 'delegation/evidence regression coverage',
      source: `import { expect, test } from 'bun:test';
import { investigate, type InvestigationTools, type SpecialistContract, type SpecialistResult } from '../src/manager';

function result(name: SpecialistContract['name'], conclusion: string, artifact: string | null, extra: Partial<SpecialistResult> = {}): SpecialistResult {
  return { name, status: artifact ? 'complete' : 'partial', conclusion, evidenceRefs: [name === 'dependency-analysis' ? 'repo:dep' : 'test:fail'], artifact, ...extra };
}

test('hidden: delegated contracts are bounded and read-only', () => {
  const seen: SpecialistContract[] = [];
  const tools: InvestigationTools = {
    runSpecialist: (contract) => { seen.push(contract); return result(contract.name, 'cause-a', contract.requiredArtifact); },
    readPrimaryEvidence: () => 'cause-a',
  };
  investigate(tools, null);
  expect(seen).toHaveLength(2);
  for (const contract of seen) {
    expect(contract.allowedTools.sort()).toEqual(['read-repo', 'run-tests']);
    expect(contract.maxSteps).toBeGreaterThan(0);
    expect(contract.maxSteps).toBeLessThanOrEqual(50);
    expect(contract.maxCost).toBeGreaterThan(0);
    expect(contract.maxCost).toBeLessThanOrEqual(100);
    expect(contract.maxDelegationDepth).toBe(0);
    expect(contract.requiredArtifact.length).toBeGreaterThan(0);
  }
});

test('hidden: resume does not discard completed work', () => {
  let dependencyRuns = 0;
  const prior = result('dependency-analysis', 'cause-a', 'dependency.json');
  const tools: InvestigationTools = {
    runSpecialist: (contract) => {
      if (contract.name === 'dependency-analysis') dependencyRuns += 1;
      return result(contract.name, 'cause-a', contract.requiredArtifact);
    },
    readPrimaryEvidence: () => 'cause-a',
  };
  const outcome = investigate(tools, null, { results: { 'dependency-analysis': prior } });
  expect(dependencyRuns).toBe(0);
  expect(outcome.results['dependency-analysis']).toEqual(prior);
});

test('hidden: scope expansion and partial evidence cannot self-promote to complete', () => {
  const tools: InvestigationTools = {
    runSpecialist: (contract) => contract.name === 'dependency-analysis'
      ? result(contract.name, 'cause-a', null, { requestedScopeExpansion: true, status: 'partial' })
      : result(contract.name, 'cause-a', contract.requiredArtifact),
    readPrimaryEvidence: () => 'cause-a',
  };
  const outcome = investigate(tools, null);
  expect(outcome.status).not.toBe('complete');
});

test('hidden: contradictory claims are reconciled against primary evidence', () => {
  const reads: string[] = [];
  const tools: InvestigationTools = {
    runSpecialist: (contract) => contract.name === 'dependency-analysis'
      ? result(contract.name, 'dependency regression', contract.requiredArtifact)
      : result(contract.name, 'test fixture bug', contract.requiredArtifact),
    readPrimaryEvidence: (ref) => { reads.push(ref); return 'supports:dependency regression'; },
  };
  const outcome = investigate(tools, { conclusion: 'old unrelated cause', timestamp: 1 });
  expect(reads.sort()).toEqual(['repo:dep', 'test:fail']);
  expect(outcome.primaryEvidenceRead.sort()).toEqual(['repo:dep', 'test:fail']);
  expect(outcome.staleMemoryUsed).toBe(false);
  expect(outcome.contradictions).toEqual([]);
  expect(outcome.status).toBe('complete');
});

test('hidden: disagreement remains explicit when primary evidence cannot decide it', () => {
  const tools: InvestigationTools = {
    runSpecialist: (contract) => contract.name === 'dependency-analysis'
      ? result(contract.name, 'dependency regression', contract.requiredArtifact)
      : result(contract.name, 'test fixture bug', contract.requiredArtifact),
    readPrimaryEvidence: () => 'ambiguous',
  };
  const outcome = investigate(tools, null);
  expect(outcome.primaryEvidenceRead.sort()).toEqual(['repo:dep', 'test:fail']);
  expect(outcome.contradictions.length).toBeGreaterThan(0);
  expect(outcome.status).not.toBe('complete');
});
`,
    }),
};

interface InteractionContractArtifact {
  states?: Array<string | { id?: string; description?: string; availableActions?: string[] }>;
  actions?: Array<{
    id?: string;
    allowedIn?: string[];
    allowedFrom?: string[];
    blockedIn?: string[];
    description?: string;
    preconditions?: string[];
  }>;
  transitions?: Array<{
    from?: string;
    event?: string;
    action?: string;
    to?: string;
    guard?: string;
    effect?: string;
  }>;
  invariants?: Array<string | { id?: string; rule?: string; description?: string }>;
  acceptanceTests?: Array<Record<string, unknown>>;
}

function interactionStateIds(artifact: InteractionContractArtifact): Set<string> {
  return new Set(
    (artifact.states ?? [])
      .map((state) => (typeof state === 'string' ? state : (state.id ?? '')))
      .filter(Boolean),
  );
}

function interactionInvariantText(artifact: InteractionContractArtifact): string {
  return (artifact.invariants ?? [])
    .map((invariant) =>
      typeof invariant === 'string'
        ? invariant
        : [invariant.id, invariant.rule, invariant.description].filter(Boolean).join(' '),
    )
    .join(' ');
}

function transitionEdge(
  artifact: InteractionContractArtifact,
  from: string,
  to: string | string[],
): boolean {
  const destinations = Array.isArray(to) ? to : [to];
  return Boolean(
    artifact.transitions?.some(
      (transition) => transition.from === from && destinations.includes(transition.to ?? ''),
    ),
  );
}

function interactionArtifactScore(input: {
  root: string;
  validate: (artifact: InteractionContractArtifact) => boolean;
  forbidden?: RegExp;
}): SkillEvalDeterministicScore {
  const artifact = readJsonArtifact<InteractionContractArtifact>(
    input.root,
    'interaction-contract.json',
  );
  const serialized = artifact ? JSON.stringify(artifact) : '';
  const structure = Boolean(
    artifact &&
    artifact.states?.length &&
    artifact.actions?.length &&
    artifact.transitions?.length &&
    artifact.invariants?.length &&
    artifact.acceptanceTests?.length,
  );
  const semantic = Boolean(artifact && input.validate(artifact));
  const boundary = !input.forbidden?.test(serialized);
  const passed = structure && semantic && boundary;
  return {
    passed,
    quality: passed ? 1 : structure ? 0.5 : 0,
    verification: artifact ? 1 : 0,
    integrityFailure: false,
    evidence: [
      `machine-readable interaction contract: ${structure ? 'present' : 'missing/incomplete'}`,
      `state/recovery invariants: ${semantic ? 'pass' : 'fail'}`,
      `boundary discipline: ${boundary ? 'pass' : 'fail'}`,
    ],
  };
}

const ixControlMaterializer: SkillEvalFixtureMaterializer = {
  id: 'interaction-design/high-consequence-control@1',
  matches: (scenario) => scenario.id === IX_CONTROL,
  materialize: (destination) => {
    writeFixtureFile(
      destination,
      'constraints.json',
      `${JSON.stringify(
        {
          controlKind: 'production-stop-not-certified-emergency-stop',
          confirmedInputs: ['pointer', 'keyboard'],
          canonicalStates: [
            'ready',
            'precondition-blocked',
            'armed',
            'stop-pending',
            'outcome-unknown',
            'stopped',
            'recoverable-failure',
            'handoff',
          ],
          facts: [
            'preconditions must be satisfied before arming',
            'the stop command is not instantly reversible',
            'connectivity loss after submission creates an unknown-outcome state',
            'another operator may take over while the incident is unresolved',
            'hardware delivery/actuation guarantees are unavailable to this interface contract',
          ],
        },
        null,
        2,
      )}\n`,
    );
    writeFixtureFile(
      destination,
      'README.md',
      `# High-consequence production-stop interaction fixture

Read \`constraints.json\`. This is an operator production-stop control, not a certified emergency-stop device. Use the canonical state ids so engineering can consume the result directly. Produce \`interaction-contract.json\` with arrays named \`states\`, \`actions\`, \`transitions\`, \`invariants\`, and \`acceptanceTests\`.

Model precondition blocking, deliberate arm/commit, immediate submission feedback, degraded-connectivity unknown outcome, evidence-based resolution, recoverable failure, and operator handoff. The stopped state has no fabricated undo. Keep visual styling and hardware-delivery guarantees out of the contract.
`,
    );
  },
};

const ixControlScorer: SkillEvalDeterministicScorer = {
  id: 'interaction-design/high-consequence-control-scorer@3',
  scenarioIds: [IX_CONTROL],
  score: ({ workingDirectory }) =>
    interactionArtifactScore({
      root: workingDirectory,
      forbidden: /#[0-9a-f]{3,8}|css|pixel|kafka|redis|guaranteed hardware|certified e-?stop/iu,
      validate: (artifact) => {
        const states = interactionStateIds(artifact);
        const required = [
          'ready',
          'precondition-blocked',
          'armed',
          'stop-pending',
          'outcome-unknown',
          'stopped',
          'recoverable-failure',
          'handoff',
        ];
        const stoppedState = artifact.states?.find(
          (state) => typeof state !== 'string' && state.id === 'stopped',
        );
        const stoppedActionText =
          typeof stoppedState === 'object' ? (stoppedState.availableActions ?? []).join(' ') : '';
        const stoppedUndo =
          /undo|restart|resume|reverse|cancel.?stop/iu.test(stoppedActionText) ||
          artifact.transitions?.some(
            (transition) =>
              transition.from === 'stopped' &&
              /undo|resume|reverse/iu.test(
                [transition.event, transition.action, transition.effect].filter(Boolean).join(' '),
              ),
          );
        const postCommitRollback = artifact.transitions?.some(
          (transition) =>
            ['stop-pending', 'outcome-unknown', 'stopped'].includes(transition.from ?? '') &&
            ['ready', 'armed', 'precondition-blocked'].includes(transition.to ?? ''),
        );
        const handoff = artifact.transitions?.some((transition) => transition.to === 'handoff');
        const text = interactionInvariantText(artifact);
        return (
          required.every((state) => states.has(state)) &&
          transitionEdge(artifact, 'ready', 'precondition-blocked') &&
          transitionEdge(artifact, 'ready', 'armed') &&
          transitionEdge(artifact, 'armed', 'stop-pending') &&
          transitionEdge(artifact, 'stop-pending', 'outcome-unknown') &&
          transitionEdge(artifact, 'outcome-unknown', 'stopped') &&
          transitionEdge(artifact, 'outcome-unknown', 'recoverable-failure') &&
          Boolean(handoff) &&
          !stoppedUndo &&
          !postCommitRollback &&
          /evidence|confirm|observ/iu.test(text)
        );
      },
    }),
};

const ixImportMaterializer: SkillEvalFixtureMaterializer = {
  id: 'interaction-design/resumable-import@1',
  matches: (scenario) => scenario.id === IX_IMPORT,
  materialize: (destination) => {
    writeFixtureFile(
      destination,
      'constraints.json',
      `${JSON.stringify(
        {
          canonicalStates: [
            'selected',
            'validating',
            'reviewing-partial',
            'processing-precommit',
            'committing',
            'disconnected',
            'partial-result',
            'completed',
            'reopened',
            'cancelled',
            'failed',
          ],
          facts: [
            'validation may yield a mixture of valid and invalid rows',
            'processing is asynchronous',
            'network loss does not imply that server-side work stopped',
            'cancellation is possible only before commit starts',
            'partial results can remain useful',
            'a completed import can be reopened later by its stable import identity',
          ],
        },
        null,
        2,
      )}\n`,
    );
    writeFixtureFile(
      destination,
      'README.md',
      `# Resumable import interaction fixture

Read \`constraints.json\` and use its canonical state ids. Produce \`interaction-contract.json\` with \`states\`, \`actions\`, \`transitions\`, \`invariants\`, and \`acceptanceTests\` arrays.

The contract must distinguish mixed validation, processing before commit, commit, disconnected/reattachment, partial result, completion/reopen, cancellation, and failure. Cancellation may reach \`cancelled\` before commit only; once \`committing\` starts, a cancel request must be blocked rather than pretending rollback exists. A connection drop preserves remote work and can resolve to still-processing or already-completed after reconnect. Do not prescribe visual styling or a queue implementation.
`,
    );
  },
};

const ixImportScorer: SkillEvalDeterministicScorer = {
  id: 'interaction-design/resumable-import-scorer@3',
  scenarioIds: [IX_IMPORT],
  score: ({ workingDirectory }) =>
    interactionArtifactScore({
      root: workingDirectory,
      forbidden: /#[0-9a-f]{3,8}|css|pixel|kafka|rabbitmq|redis queue/iu,
      validate: (artifact) => {
        const states = interactionStateIds(artifact);
        const required = [
          'selected',
          'validating',
          'reviewing-partial',
          'processing-precommit',
          'committing',
          'disconnected',
          'partial-result',
          'completed',
          'reopened',
          'cancelled',
          'failed',
        ];
        const cancel = artifact.actions?.find((action) => /cancel/iu.test(action.id ?? ''));
        const cancelAllowed = new Set([
          ...(cancel?.allowedIn ?? []),
          ...(cancel?.allowedFrom ?? []),
        ]);
        const cancelBeforeCommit =
          cancelAllowed.has('processing-precommit') ||
          transitionEdge(artifact, 'processing-precommit', 'cancelled') ||
          Boolean(cancel?.preconditions?.some((item) => /processing-precommit/iu.test(item)));
        const postCommitCancellation = artifact.transitions?.some(
          (transition) =>
            ['committing', 'completed', 'reopened'].includes(transition.from ?? '') &&
            /cancel/iu.test(
              [transition.event, transition.action, transition.effect].filter(Boolean).join(' '),
            ) &&
            transition.to === 'cancelled',
        );
        const commitCancelBlocked =
          Boolean(cancel?.blockedIn?.includes('committing')) ||
          Boolean(
            artifact.transitions?.some(
              (transition) =>
                transition.from === 'committing' &&
                transition.to === 'committing' &&
                /cancel/iu.test(
                  [transition.event, transition.action, transition.effect]
                    .filter(Boolean)
                    .join(' '),
                ),
            ),
          ) ||
          /commit.{0,80}(?:cancel|cancellation).{0,80}(?:block|disable|not allowed)|(?:cancel|cancellation).{0,80}commit.{0,80}(?:block|disable|not allowed)/iu.test(
            [cancel?.description, interactionInvariantText(artifact)].filter(Boolean).join(' '),
          );
        const text = interactionInvariantText(artifact);
        return (
          required.every((state) => states.has(state)) &&
          transitionEdge(artifact, 'selected', 'validating') &&
          transitionEdge(artifact, 'validating', 'reviewing-partial') &&
          transitionEdge(artifact, 'reviewing-partial', 'processing-precommit') &&
          transitionEdge(artifact, 'processing-precommit', 'committing') &&
          transitionEdge(artifact, 'processing-precommit', 'disconnected') &&
          transitionEdge(artifact, 'disconnected', 'processing-precommit') &&
          transitionEdge(artifact, 'disconnected', 'completed') &&
          transitionEdge(artifact, 'committing', 'partial-result') &&
          transitionEdge(artifact, 'completed', 'reopened') &&
          cancelBeforeCommit &&
          commitCancelBlocked &&
          !postCommitCancellation &&
          /connection|disconnect|reattach|reconnect/iu.test(text) &&
          /commit.*cancel|cancel.*commit/iu.test(text)
        );
      },
    }),
};

export const PILOT_SKILL_EVAL_MATERIALIZERS: readonly SkillEvalFixtureMaterializer[] = [
  backendJobMaterializer,
  backendSyncMaterializer,
  dataAovMaterializer,
  dataRetentionMaterializer,
  agentRemediationMaterializer,
  agentManagerMaterializer,
  appsecImportMaterializer,
  appsecDesktopMaterializer,
  ixControlMaterializer,
  ixImportMaterializer,
];

export const PILOT_SKILL_EVAL_SCORERS: readonly SkillEvalDeterministicScorer[] = [
  backendJobScorer,
  backendSyncScorer,
  dataAovScorer,
  dataRetentionScorer,
  agentRemediationScorer,
  agentManagerScorer,
  appsecImportScorer,
  appsecDesktopScorer,
  ixControlScorer,
  ixImportScorer,
];
