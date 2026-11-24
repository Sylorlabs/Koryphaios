import { existsSync, readFileSync } from 'node:fs';
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

const ANALYTICS_ORDERS = 'analytics-engineering-full-task-1-individual';
const ANALYTICS_SCD = 'analytics-engineering-full-task-2-individual';
const PIPELINE_CDC = 'data-pipeline-engineering-full-task-1-individual';
const PIPELINE_DRIFT = 'data-pipeline-engineering-full-task-2-individual';

function candidateTestsRejectKnownBadSource(
  workingDirectory: string,
  path: string,
  knownBadSource: string,
): { rejected: boolean; evidence: string } {
  const candidateSource = readFixtureText(workingDirectory, path);
  try {
    writeFixtureFile(workingDirectory, path, knownBadSource);
    const result = runCandidateBunTests(workingDirectory);
    return {
      rejected: result.completed && !result.passed,
      evidence: result.evidence,
    };
  } finally {
    writeFixtureFile(workingDirectory, path, candidateSource);
  }
}

const ORDERS_MODEL = `export interface Order {
  orderId: string;
  createdDate: string;
}

export interface StatusChange {
  orderId: string;
  status: 'confirmed' | 'cancelled';
  effectiveAt: string;
}

export interface PaymentEvent {
  eventId: string;
  orderId: string;
  amountCents: number;
  kind: 'settled' | 'refund';
}

export interface OrderMartRow {
  orderId: string;
  createdDate: string;
  status: 'confirmed' | 'cancelled';
  netRevenueCents: number;
}

export interface OrdersSource {
  orders: Order[];
  statusChanges: StatusChange[];
  paymentEvents: PaymentEvent[];
}

export function buildOrdersMart(source: OrdersSource): OrderMartRow[] {
  return source.orders.map((order) => {
    const statuses = source.statusChanges.filter((change) => change.orderId === order.orderId);
    // BUG: arrival order is treated as effective order.
    const status = statuses[0]?.status ?? 'confirmed';
    // BUG: replayed payment events are counted twice.
    const paymentTotal = source.paymentEvents
      .filter((event) => event.orderId === order.orderId)
      .reduce((sum, event) => sum + (event.kind === 'refund' ? -event.amountCents : event.amountCents), 0);
    return {
      orderId: order.orderId,
      createdDate: order.createdDate,
      status,
      netRevenueCents: status === 'cancelled' ? 0 : paymentTotal,
    };
  });
}

export function dailyNetRevenue(rows: OrderMartRow[]): Record<string, number> {
  return rows.reduce<Record<string, number>>((totals, row) => {
    totals[row.createdDate] = (totals[row.createdDate] ?? 0) + row.netRevenueCents;
    return totals;
  }, {});
}

export function applyIncremental(
  existing: OrderMartRow[],
  source: OrdersSource,
  changedOrderIds: string[],
): OrderMartRow[] {
  // BUG: historical corrections are ignored unless they introduce a brand-new order.
  const existingIds = new Set(existing.map((row) => row.orderId));
  const additions = buildOrdersMart(source).filter(
    (row) => changedOrderIds.includes(row.orderId) && !existingIds.has(row.orderId),
  );
  return [...existing, ...additions];
}
`;

const ORDERS_SOURCE = `${JSON.stringify(
  {
    base: {
      orders: [
        { orderId: 'o-1', createdDate: '2026-08-01' },
        { orderId: 'o-2', createdDate: '2026-08-01' },
        { orderId: 'o-3', createdDate: '2026-08-02' },
      ],
      statusChanges: [
        { orderId: 'o-1', status: 'confirmed', effectiveAt: '2026-08-01T10:00:00Z' },
        { orderId: 'o-2', status: 'confirmed', effectiveAt: '2026-08-01T11:00:00Z' },
        { orderId: 'o-3', status: 'confirmed', effectiveAt: '2026-08-02T09:00:00Z' },
      ],
      paymentEvents: [
        { eventId: 'pay-1', orderId: 'o-1', amountCents: 10000, kind: 'settled' },
        { eventId: 'pay-1', orderId: 'o-1', amountCents: 10000, kind: 'settled' },
        { eventId: 'pay-2', orderId: 'o-2', amountCents: 7000, kind: 'settled' },
        { eventId: 'pay-3', orderId: 'o-3', amountCents: 4500, kind: 'settled' },
      ],
    },
    corrected: {
      orders: [
        { orderId: 'o-1', createdDate: '2026-08-01' },
        { orderId: 'o-2', createdDate: '2026-08-01' },
        { orderId: 'o-3', createdDate: '2026-08-02' },
      ],
      statusChanges: [
        { orderId: 'o-1', status: 'confirmed', effectiveAt: '2026-08-01T10:00:00Z' },
        { orderId: 'o-2', status: 'confirmed', effectiveAt: '2026-08-01T11:00:00Z' },
        { orderId: 'o-2', status: 'cancelled', effectiveAt: '2026-08-01T18:00:00Z' },
        { orderId: 'o-3', status: 'confirmed', effectiveAt: '2026-08-02T09:00:00Z' },
      ],
      paymentEvents: [
        { eventId: 'pay-1', orderId: 'o-1', amountCents: 10000, kind: 'settled' },
        { eventId: 'pay-1', orderId: 'o-1', amountCents: 10000, kind: 'settled' },
        { eventId: 'pay-2', orderId: 'o-2', amountCents: 7000, kind: 'settled' },
        { eventId: 'pay-3', orderId: 'o-3', amountCents: 4500, kind: 'settled' },
      ],
    },
    metricContract: {
      grain: 'one mart row per order_id',
      paymentIdentity: 'eventId',
      statusSemantics: 'latest status by effectiveAt',
      netRevenue:
        'For each order, sum unique payment events (settled positive, refund negative); cancelled orders contribute zero. Aggregate by order createdDate.',
      correctedSevenDayLedger: {
        '2026-08-01': 10000,
        '2026-08-02': 4500,
      },
    },
  },
  null,
  2,
)}\n`;

const analyticsOrdersMaterializer: SkillEvalFixtureMaterializer = {
  id: 'analytics-engineering/late-arriving-orders-mart@1',
  matches: (scenario) => scenario.id === ANALYTICS_ORDERS,
  materialize: (destination) => {
    writeFixtureFile(destination, 'package.json', packageJson('kory-eval-analytics-orders'));
    writeFixtureFile(destination, 'src/orders-mart.ts', ORDERS_MODEL);
    writeFixtureFile(destination, 'data/orders-source.json', ORDERS_SOURCE);
    writeFixtureFile(destination, 'tests/.gitkeep', '');
    writeFixtureFile(
      destination,
      'README.md',
      `# Analytics engineering — late/corrected orders mart

Repair the existing model without changing its public function names. The contract lives in \`data/orders-source.json\`: mart grain is one row per \`orderId\`; payment-event identity is \`eventId\`; status uses latest \`effectiveAt\`; net revenue has one governed definition there.

Add focused schema/data/regression tests. Prove duplicate payment delivery is deduplicated, the late cancellation restates historical \`o-2\`, and applying the correction incrementally yields the same rows + daily net-revenue totals as a clean full refresh over the supplied slice. Preserve source→mart lineage and do not add dashboards or product-funnel interpretation.

Write \`.kory-eval/analytics-orders.json\` with grain/keys/freshness-status semantics, metric definition ownership, lineage, schema/data tests, incremental-vs-full reconciliation, late-correction evidence, and hierarchy boundary: broader \`data-analysis\`; \`product-analytics\` remains out of scope.
`,
    );
  },
};

const analyticsOrdersScorer: SkillEvalDeterministicScorer = {
  id: 'analytics-engineering/late-arriving-orders-mart-scorer@5',
  scenarioIds: [ANALYTICS_ORDERS],
  score: ({ workingDirectory }) => {
    const hidden = runHiddenBunTest(
      workingDirectory,
      `import { expect,test } from 'bun:test';
import sourceFixture from '../data/orders-source.json';
import { applyIncremental, buildOrdersMart, dailyNetRevenue } from '../src/orders-mart';

test('hidden: mart grain, event dedupe, and latest-effective status are correct',()=>{
  const rows=buildOrdersMart(sourceFixture.corrected as any);
  expect(rows).toHaveLength(3);
  expect(new Set(rows.map((row)=>row.orderId)).size).toBe(3);
  expect(rows.find((row)=>row.orderId==='o-1')?.netRevenueCents).toBe(10000);
  expect(rows.find((row)=>row.orderId==='o-2')).toMatchObject({status:'cancelled',netRevenueCents:0});
  expect(dailyNetRevenue(rows)).toEqual({'2026-08-01':10000,'2026-08-02':4500});
});

test('hidden: historical correction incremental path reconciles exactly to clean full refresh',()=>{
  const before=buildOrdersMart(sourceFixture.base as any);
  const incremental=applyIncremental(before,sourceFixture.corrected as any,['o-2']);
  const full=buildOrdersMart(sourceFixture.corrected as any);
  expect(incremental).toEqual(full);
  expect(dailyNetRevenue(incremental)).toEqual(dailyNetRevenue(full));
});
`,
    );
    const regressionProof = candidateTestsRejectKnownBadSource(
      workingDirectory,
      'src/orders-mart.ts',
      ORDERS_MODEL,
    );
    const regression = regressionProof.rejected;
    const artifact = readJsonArtifact<unknown>(
      workingDirectory,
      '.kory-eval/analytics-orders.json',
    );
    const body = JSON.stringify(artifact ?? '').toLowerCase();
    const boundary =
      /one.*order|order.*grain|orderid/u.test(body) &&
      /eventid/u.test(body) &&
      /effectiveat|effective/u.test(body) &&
      /net[_ -]?revenue/u.test(body) &&
      /lineage/u.test(body) &&
      /data-analysis/u.test(body) &&
      /product-analytics/u.test(body) &&
      /out ?of ?scope|not selected|boundary/u.test(body);
    const reconcile =
      /10,?000|10000/u.test(body) &&
      /4,?500|4500/u.test(body) &&
      /incremental/u.test(body) &&
      /full[_ -]?refresh|full[_ -]?rebuild/u.test(body) &&
      /reconcil|equal|match|incrementalequalsfull/u.test(body);
    const passed = hidden.passed && regression && Boolean(artifact) && boundary && reconcile;
    return {
      passed,
      quality: passed ? 1 : hidden.passed && boundary ? 0.75 : hidden.passed ? 0.5 : 0,
      verification: hidden.passed ? 1 : 0,
      integrityFailure: false,
      evidence: [
        `grain/dedupe/late-correction hidden oracle: ${hidden.passed ? 'pass' : 'fail'}`,
        `known-bad orders model rejected by candidate tests: ${regression ? 'yes' : 'no'}`,
        `grain/metric/lineage + product-analytics boundary: ${boundary ? 'explicit' : 'incomplete'}`,
        `incremental/full-refresh metric reconciliation: ${reconcile ? 'reported' : 'missing'}`,
        regressionProof.evidence,
        hidden.evidence,
      ],
    };
  },
};

const SCD_MODEL = `export interface AccountVersion {
  accountId: string;
  plan: string;
  effectiveFrom: string;
  effectiveTo: string | null;
}

export interface InvoiceLine {
  invoiceLineId: string;
  accountId: string;
  invoiceDate: string;
  recurringMonthlyCents: number;
}

export interface SubscriptionMartRow extends InvoiceLine {
  plan: string;
}

export function buildSubscriptionMart(
  accountHistory: AccountVersion[],
  invoiceLines: InvoiceLine[],
): SubscriptionMartRow[] {
  // BUG: direct account-id join fans one invoice line out to every historical plan row.
  return invoiceLines.flatMap((line) =>
    accountHistory
      .filter((version) => version.accountId === line.accountId)
      .map((version) => ({ ...line, plan: version.plan })),
  );
}

/** Governed metric definition: ARR is annualized recurring amount at invoice-line grain. */
export function governedArrCents(rows: SubscriptionMartRow[]): number {
  return rows.reduce((sum, row) => sum + row.recurringMonthlyCents * 12, 0);
}

export function applySubscriptionIncremental(
  existing: SubscriptionMartRow[],
  accountHistory: AccountVersion[],
  invoiceLines: InvoiceLine[],
  changedAccountIds: string[],
  changedInvoiceLineIds: string[],
): SubscriptionMartRow[] {
  // BUG: dimension-history corrections can affect existing invoice lines for an
  // account, but this only rebuilds explicitly changed invoice-line ids.
  const changedLines = new Set(changedInvoiceLineIds);
  return [
    ...existing.filter((row) => !changedLines.has(row.invoiceLineId)),
    ...buildSubscriptionMart(
      accountHistory,
      invoiceLines.filter((line) => changedLines.has(line.invoiceLineId)),
    ),
  ];
}
`;

const SCD_DATA = `${JSON.stringify(
  {
    accountHistory: [
      {
        accountId: 'enterprise-1',
        plan: 'team',
        effectiveFrom: '2026-08-01T00:00:00Z',
        effectiveTo: '2026-08-10T00:00:00Z',
      },
      {
        accountId: 'enterprise-1',
        plan: 'business',
        effectiveFrom: '2026-08-10T00:00:00Z',
        effectiveTo: '2026-08-20T00:00:00Z',
      },
      {
        accountId: 'enterprise-1',
        plan: 'enterprise',
        effectiveFrom: '2026-08-20T00:00:00Z',
        effectiveTo: null,
      },
    ],
    invoiceLines: [
      {
        invoiceLineId: 'line-1',
        accountId: 'enterprise-1',
        invoiceDate: '2026-08-05T00:00:00Z',
        recurringMonthlyCents: 10000,
      },
      {
        invoiceLineId: 'line-2',
        accountId: 'enterprise-1',
        invoiceDate: '2026-08-15T00:00:00Z',
        recurringMonthlyCents: 18000,
      },
      {
        invoiceLineId: 'line-3',
        accountId: 'enterprise-1',
        invoiceDate: '2026-08-25T00:00:00Z',
        recurringMonthlyCents: 30000,
      },
    ],
    expected: {
      invoiceLineCount: 3,
      plansByLine: { 'line-1': 'team', 'line-2': 'business', 'line-3': 'enterprise' },
      governedArrCents: 696000,
    },
    correctedAccountHistory: [
      {
        accountId: 'enterprise-1',
        plan: 'team',
        effectiveFrom: '2026-08-01T00:00:00Z',
        effectiveTo: '2026-08-10T00:00:00Z',
      },
      {
        accountId: 'enterprise-1',
        plan: 'business',
        effectiveFrom: '2026-08-10T00:00:00Z',
        effectiveTo: '2026-08-14T00:00:00Z',
      },
      {
        accountId: 'enterprise-1',
        plan: 'enterprise',
        effectiveFrom: '2026-08-14T00:00:00Z',
        effectiveTo: null,
      },
    ],
    correctedInvoiceLines: [
      {
        invoiceLineId: 'line-1',
        accountId: 'enterprise-1',
        invoiceDate: '2026-08-05T00:00:00Z',
        recurringMonthlyCents: 10000,
      },
      {
        invoiceLineId: 'line-2',
        accountId: 'enterprise-1',
        invoiceDate: '2026-08-15T00:00:00Z',
        recurringMonthlyCents: 18000,
      },
      {
        invoiceLineId: 'line-3',
        accountId: 'enterprise-1',
        invoiceDate: '2026-08-25T00:00:00Z',
        recurringMonthlyCents: 30000,
      },
      {
        invoiceLineId: 'line-4',
        accountId: 'enterprise-1',
        invoiceDate: '2026-08-12T00:00:00Z',
        recurringMonthlyCents: 5000,
      },
    ],
    correctedExpected: {
      invoiceLineCount: 4,
      plansByLine: {
        'line-1': 'team',
        'line-2': 'enterprise',
        'line-3': 'enterprise',
        'line-4': 'business',
      },
      governedArrCents: 756000,
    },
    sourceFreshness: {
      maxAgeMinutes: 60,
      observedAt: '2026-08-31T12:00:00Z',
      extractedAt: '2026-08-31T11:20:00Z',
    },
    downstreamColumns: [
      'invoiceLineId',
      'accountId',
      'invoiceDate',
      'recurringMonthlyCents',
      'plan',
    ],
  },
  null,
  2,
)}\n`;

const analyticsScdMaterializer: SkillEvalFixtureMaterializer = {
  id: 'analytics-engineering/subscription-scd-metric-contract@2',
  matches: (scenario) => scenario.id === ANALYTICS_SCD,
  materialize: (destination) => {
    writeFixtureFile(destination, 'package.json', packageJson('kory-eval-analytics-scd'));
    writeFixtureFile(destination, 'src/subscription-mart.ts', SCD_MODEL);
    writeFixtureFile(destination, 'data/subscriptions.json', SCD_DATA);
    writeFixtureFile(destination, 'tests/.gitkeep', '');
    writeFixtureFile(
      destination,
      'README.md',
      `# Analytics engineering — subscription SCD + governed metric

Repair the analytical join without changing downstream mart column names. Invoice facts remain exactly one row per \`invoiceLineId\`. Account plan history is a time-valid dimension: each invoice line receives the plan version whose \`effectiveFrom <= invoiceDate < effectiveTo\` (or open-ended). Do not join every snapshot by account id.

Keep ARR in the single governed \`governedArrCents\` definition. Add data/regression tests proving no fan-out for both intra-month plan changes, exact line→plan assignment, and known ARR. The fixture also supplies a corrected account-history snapshot plus one late invoice line: repair \`applySubscriptionIncremental\` and prove its output is exactly equal to a clean full rebuild, including row order and governed ARR. Describe migration/backfill, historical restatement policy, compatibility checks, and rollback/forward-repair boundary. Do not drift into application-database tuning.

The supplied source-freshness contract allows at most 60 minutes of age; the observed extract is 40 minutes old. Verify and record that result rather than treating freshness as an unspecified external assumption.

Write \`.kory-eval/analytics-scd.json\` with fact/dimension grains, effective-time semantics, source freshness, governed metric ownership, reconciliation, incremental/full-rebuild equivalence, late/corrected-record behavior, migration/restatement/rollback checks, downstream-column compatibility, and hierarchy boundary: broader \`data-analysis\`; neighbor \`data-pipeline-engineering\` is not being absorbed.
`,
    );
  },
};

const analyticsScdScorer: SkillEvalDeterministicScorer = {
  id: 'analytics-engineering/subscription-scd-metric-contract-scorer@4',
  scenarioIds: [ANALYTICS_SCD],
  score: ({ workingDirectory }) => {
    const hidden = runHiddenBunTest(
      workingDirectory,
      `import { expect,test } from 'bun:test'; import fixture from '../data/subscriptions.json';
import { applySubscriptionIncremental, buildSubscriptionMart, governedArrCents } from '../src/subscription-mart';
test('hidden: temporal dimension join preserves invoice-line grain and correct plan',()=>{
  const rows=buildSubscriptionMart(fixture.accountHistory as any,fixture.invoiceLines as any);
  expect(rows).toHaveLength(3); expect(new Set(rows.map((row)=>row.invoiceLineId)).size).toBe(3);
  expect(Object.fromEntries(rows.map((row)=>[row.invoiceLineId,row.plan]))).toEqual(fixture.expected.plansByLine);
  expect(Object.keys(rows[0]!).sort()).toEqual([...fixture.downstreamColumns].sort());
});
test('hidden: governed ARR reconciles once at invoice-line grain',()=>{
  const rows=buildSubscriptionMart(fixture.accountHistory as any,fixture.invoiceLines as any);
  expect(governedArrCents(rows)).toBe(fixture.expected.governedArrCents);
});
test('hidden: corrected history plus a late line reconciles incrementally to a clean rebuild',()=>{
  const before=buildSubscriptionMart(fixture.accountHistory as any,fixture.invoiceLines as any);
  const incremental=applySubscriptionIncremental(
    before,
    fixture.correctedAccountHistory as any,
    fixture.correctedInvoiceLines as any,
    ['enterprise-1'],
    ['line-4'],
  );
  const full=buildSubscriptionMart(fixture.correctedAccountHistory as any,fixture.correctedInvoiceLines as any);
  expect(incremental).toEqual(full);
  expect(incremental).toHaveLength(fixture.correctedExpected.invoiceLineCount);
  expect(Object.fromEntries(incremental.map((row)=>[row.invoiceLineId,row.plan]))).toEqual(fixture.correctedExpected.plansByLine);
  expect(governedArrCents(incremental)).toBe(fixture.correctedExpected.governedArrCents);
});
`,
    );
    const regressionProof = candidateTestsRejectKnownBadSource(
      workingDirectory,
      'src/subscription-mart.ts',
      SCD_MODEL,
    );
    const regression = regressionProof.rejected;
    const artifact = readJsonArtifact<unknown>(workingDirectory, '.kory-eval/analytics-scd.json');
    const body = JSON.stringify(artifact ?? '').toLowerCase();
    const contract =
      /invoice.*line.*grain|grain.*invoice/u.test(body) &&
      /effectivefrom|effective.*time|temporal|slowly changing|scd/u.test(body) &&
      /governed|single.*metric|metric.*source/u.test(body) &&
      /696,?000|696000/u.test(body) &&
      /restat/u.test(body) &&
      /migration/u.test(body) &&
      /rollback|forward repair/u.test(body) &&
      /compatib/u.test(body);
    const verificationContract =
      /fresh/u.test(body) &&
      /60/u.test(body) &&
      /incremental/u.test(body) &&
      /full.?refresh|full.?rebuild|full recomputation/u.test(body) &&
      /late|correct/u.test(body);
    const hierarchy =
      /data-analysis/u.test(body) &&
      /data-pipeline-engineering/u.test(body) &&
      /not selected|not absorbed|notabsorbed|boundary|out ?of ?scope/u.test(body);
    const passed =
      hidden.passed &&
      regression &&
      Boolean(artifact) &&
      contract &&
      verificationContract &&
      hierarchy;
    return {
      passed,
      quality: passed
        ? 1
        : hidden.passed && contract && verificationContract
          ? 0.75
          : hidden.passed
            ? 0.5
            : 0,
      verification: hidden.passed ? 1 : 0,
      integrityFailure: false,
      evidence: [
        `temporal SCD/no-fanout + governed ARR oracle: ${hidden.passed ? 'pass' : 'fail'}`,
        `known-bad SCD model rejected by candidate tests: ${regression ? 'yes' : 'no'}`,
        `migration/restatement/rollback compatibility contract: ${contract ? 'complete' : 'incomplete'}`,
        `freshness + incremental/full-rebuild correction evidence: ${verificationContract ? 'complete' : 'incomplete'}`,
        `analytics-vs-pipeline/database boundary: ${hierarchy ? 'explicit' : 'missing'}`,
        regressionProof.evidence,
        hidden.evidence,
      ],
    };
  },
};

const CDC_SOURCE = `export interface CdcEvent {
  eventId: string;
  sourceLsn: number;
  recordId: string;
  operation: 'upsert' | 'delete';
  value?: string;
  valid?: boolean;
}

export interface SinkRow { recordId: string; value: string | null; sourceLsn: number; deleted: boolean }

export class CdcPipeline {
  private latest = new Map<string, SinkRow>();
  private audit: CdcEvent[] = [];
  private quarantine: Array<{ event: CdcEvent; reason: string }> = [];
  private checkpointLsn = 0;

  process(events: CdcEvent[]): void {
    for (const event of events) {
      if (event.valid === false) {
        // BUG: poison records disappear without accounting/provenance.
        continue;
      }
      // BUG: replay creates another logical audit record and late backfill overwrites newer state by arrival.
      this.audit.push(structuredClone(event));
      this.latest.set(event.recordId, {
        recordId: event.recordId,
        value: event.operation === 'delete' ? null : String(event.value ?? ''),
        sourceLsn: event.sourceLsn,
        deleted: event.operation === 'delete',
      });
      this.checkpointLsn = Math.max(this.checkpointLsn, event.sourceLsn);
    }
  }

  rollbackCheckpoint(lsn: number): void { this.checkpointLsn = lsn; }
  checkpoint(): number { return this.checkpointLsn; }
  snapshot() {
    return {
      latest: [...this.latest.values()].sort((a,b)=>a.recordId.localeCompare(b.recordId)),
      audit: this.audit.map((event)=>structuredClone(event)),
      quarantine: this.quarantine.map((item)=>structuredClone(item)),
      checkpointLsn: this.checkpointLsn,
    };
  }
}
`;

const CDC_EVENTS = `${JSON.stringify(
  {
    initial: [
      { eventId: 'e-100', sourceLsn: 100, recordId: 'r-1', operation: 'upsert', value: 'v1' },
      { eventId: 'e-101', sourceLsn: 101, recordId: 'r-1', operation: 'upsert', value: 'v2' },
      { eventId: 'e-102', sourceLsn: 102, recordId: 'r-2', operation: 'upsert', value: 'x1' },
    ],
    replayAfterCheckpointLoss: [
      { eventId: 'e-101', sourceLsn: 101, recordId: 'r-1', operation: 'upsert', value: 'v2' },
      { eventId: 'e-102', sourceLsn: 102, recordId: 'r-2', operation: 'upsert', value: 'x1' },
    ],
    lateBackfill: [
      {
        eventId: 'e-090',
        sourceLsn: 90,
        recordId: 'r-1',
        operation: 'upsert',
        value: 'historical-v0',
      },
    ],
    poison: [
      {
        eventId: 'e-103',
        sourceLsn: 103,
        recordId: 'r-bad',
        operation: 'upsert',
        value: 'bad',
        valid: false,
      },
    ],
    expected: {
      latest: [
        { recordId: 'r-1', value: 'v2', sourceLsn: 101, deleted: false },
        { recordId: 'r-2', value: 'x1', sourceLsn: 102, deleted: false },
      ],
      uniqueAuditEventIds: ['e-100', 'e-101', 'e-102', 'e-090'],
      poisonReason: 'INVALID_RECORD',
    },
  },
  null,
  2,
)}\n`;

const pipelineCdcMaterializer: SkillEvalFixtureMaterializer = {
  id: 'data-pipeline-engineering/idempotent-cdc-backfill@3',
  matches: (scenario) => scenario.id === PIPELINE_CDC,
  materialize: (destination) => {
    writeFixtureFile(destination, 'package.json', packageJson('kory-eval-pipeline-cdc'));
    writeFixtureFile(destination, 'src/cdc-pipeline.ts', CDC_SOURCE);
    writeFixtureFile(destination, 'data/events.json', CDC_EVENTS);
    writeFixtureFile(destination, 'tests/.gitkeep', '');
    writeFixtureFile(
      destination,
      'README.md',
      `# Data pipeline engineering — CDC replay/backfill

Repair the existing \`CdcPipeline\` without changing its public methods. This fixture represents exactly one Kafka partition, \`p0\`; \`sourceLsn\` is authoritative only within that partition and the scalar checkpoint is therefore partition-local. Logical event identity is \`eventId\` across accepted and quarantined dispositions. Sink latest-state must never regress to an older LSN merely because a backfill arrives later. Replayed event IDs are idempotent at sink/audit semantics. Poison records are accounted for in quarantine with raw event provenance and stable reason \`INVALID_RECORD\`.

Add deterministic tests for initial load, checkpoint rollback + duplicate replay, older backfill after newer state, poison record, bounded rerun, and a representative partial-failure/replay boundary. The fixture's checkpoint, sink state, and deduplication state are in memory: rollback reproduces replay but does not prove persistence across process reconstruction. Label process-durable restart verification unavailable unless you add and test an actual durable state mechanism. Schema evolution is not present in this fixture; it is exercised independently by the schema-drift scenario. Do not redefine analytics marts/metrics.

Keep executable regression tests in \`tests/\` that name the incompatible-timestamp or epoch case, the quarantine path, duplicate or rerun idempotency, and the replay or parser-v2 recovery path; the host reads that test text, so a checked box in the report is not enough.

Write \`.kory-eval/pipeline-cdc.json\` with partition-local event identity/order, checkpoint/replay semantics, sink guarantees, quarantine/provenance, lineage/reconciliation, the observed partial-failure/replay + late/backfill evidence, the durable-restart limitation, the separate schema-evolution boundary, and hierarchy boundary: broader \`data-analysis\`; \`analytics-engineering\` remains a downstream neighbor rather than owned here.
`,
    );
  },
};

const pipelineCdcScorer: SkillEvalDeterministicScorer = {
  id: 'data-pipeline-engineering/idempotent-cdc-backfill-scorer@4',
  scenarioIds: [PIPELINE_CDC],
  score: ({ workingDirectory }) => {
    const hidden = runHiddenBunTest(
      workingDirectory,
      `import { expect,test } from 'bun:test'; import fixture from '../data/events.json'; import { CdcPipeline } from '../src/cdc-pipeline';
test('hidden: checkpoint loss replay is logically idempotent',()=>{
  const p=new CdcPipeline(); p.process(fixture.initial as any); p.rollbackCheckpoint(100); p.process(fixture.replayAfterCheckpointLoss as any);
  const s=p.snapshot(); expect(s.latest).toEqual(fixture.expected.latest); expect(s.audit.map((e)=>e.eventId)).toEqual(['e-100','e-101','e-102']); expect(p.checkpoint()).toBe(102);
});
test('hidden: older backfill cannot regress latest state and poison is accounted',()=>{
  const p=new CdcPipeline(); p.process(fixture.initial as any); p.process(fixture.lateBackfill as any); p.process(fixture.poison as any);
  const s=p.snapshot(); expect(s.latest).toEqual(fixture.expected.latest); expect(new Set(s.audit.map((e)=>e.eventId)).size).toBe(s.audit.length);
  expect(s.audit.map((e)=>e.eventId)).toContain('e-090'); expect(s.quarantine).toHaveLength(1); expect(s.quarantine[0]).toMatchObject({reason:'INVALID_RECORD'}); expect(s.quarantine[0]?.event.eventId).toBe('e-103');
});
test('hidden: event identity spans accepted and quarantined dispositions',()=>{
  const p=new CdcPipeline(); const accepted={...(fixture.initial as any[])[0]}; p.process([accepted] as any); p.rollbackCheckpoint(0);
  p.process([{...accepted,valid:false}] as any); const s=p.snapshot();
  expect(s.audit.filter((e)=>e.eventId===accepted.eventId)).toHaveLength(1); expect(s.quarantine.filter((q)=>q.event.eventId===accepted.eventId)).toHaveLength(0);
});
`,
    );
    const regression = hasRegressionText(workingDirectory, [
      /checkpoint|replay/iu,
      /backfill|late/iu,
      /poison|quarantine/iu,
      /eventId|sourceLsn/iu,
    ]);
    const artifact = readJsonArtifact<unknown>(workingDirectory, '.kory-eval/pipeline-cdc.json');
    const body = JSON.stringify(artifact ?? '').toLowerCase();
    const idempotency =
      /idempoten|dedup/u.test(body) ||
      (/eventid/u.test(body) &&
        /already.?seen|does not write|not written|without duplicate|at most one|once/u.test(body));
    const contract =
      /eventid/u.test(body) &&
      /sourcelsn|source lsn/u.test(body) &&
      /partition/u.test(body) &&
      /\bp0\b|single.?partition|partition.?local/u.test(body) &&
      idempotency &&
      /checkpoint/u.test(body) &&
      /replay/u.test(body) &&
      /backfill|late/u.test(body) &&
      /quarantine/u.test(body) &&
      /invalid_record/u.test(body) &&
      /provenance|lineage/u.test(body);
    const evidenceBoundary =
      /in.?memory|memory.?only|simulat/u.test(body) &&
      /durab|process.?restart|process reconstruction/u.test(body) &&
      /schema/u.test(body) &&
      /scenario.?2|separate|not present|not supplied|unavailable/u.test(body);
    const boundary =
      /data-analysis/u.test(body) &&
      /analytics-engineering/u.test(body) &&
      /downstream|not owned|not selected|boundary/u.test(body) &&
      // Negative guard targets analytics-drift vocabulary (ARR, funnels, business
      // metrics). It must match the standalone token, not the substring: ordinary
      // CDC language such as "a backfill arrives later" contains "arr" and must
      // not fail the boundary criterion. (Scorer @3 failed every report that used
      // the fixture's own "arrives" phrasing.)
      !/\barr\b|funnel|business metric/u.test(body);
    const passed =
      hidden.passed && regression && Boolean(artifact) && contract && evidenceBoundary && boundary;
    return {
      passed,
      quality: passed
        ? 1
        : hidden.passed && contract && evidenceBoundary
          ? 0.75
          : hidden.passed
            ? 0.5
            : 0,
      verification: hidden.passed ? 1 : 0,
      integrityFailure: false,
      evidence: [
        `replay/backfill/poison hidden oracle: ${hidden.passed ? 'pass' : 'fail'}`,
        `representative recovery regressions: ${regression ? 'present' : 'missing'}`,
        `identity/order/checkpoint/quarantine contract: ${contract ? 'complete' : 'incomplete'}`,
        `single-partition + durable-restart/schema evidence boundary: ${evidenceBoundary ? 'explicit' : 'missing'}`,
        `pipeline-vs-analytics boundary: ${boundary ? 'explicit' : 'missing'}`,
        hidden.evidence,
      ],
    };
  },
};

const DRIFT_SOURCE = `export interface PartnerRow { recordId:string; timestamp:unknown; amount:number; metadata?:unknown }
export interface NormalizedRow { recordId:string; eventTime:string; amount:number; rawFileId:string }
export interface QuarantineRow { fileId:string; raw:PartnerRow; reason:string }

export class PartnerFeedPipeline {
  private normalized = new Map<string,NormalizedRow>();
  private quarantineRows: QuarantineRow[]=[];
  private rawFiles = new Map<string,PartnerRow[]>();

  ingestFile(fileId:string, rows:PartnerRow[], parserVersion:1|2=1): void {
    this.rawFiles.set(fileId,structuredClone(rows));
    for(const row of rows){
      // BUG: silently coerces incompatible timestamps to null-like state instead of quarantining.
      const parsed=new Date(row.timestamp as any);
      this.normalized.set(row.recordId,{recordId:row.recordId,eventTime:Number.isNaN(parsed.getTime())?'':parsed.toISOString(),amount:row.amount,rawFileId:fileId});
    }
    void parserVersion;
  }

  reprocessQuarantine(parserVersion:1|2): void { void parserVersion; }
  snapshot(){return {normalized:[...this.normalized.values()].sort((a,b)=>a.recordId.localeCompare(b.recordId)),quarantine:structuredClone(this.quarantineRows),rawFiles:[...this.rawFiles.keys()].sort()};}
}
`;

const DRIFT_DATA = `${JSON.stringify(
  {
    fileId: 'partner-2026-09-05.jsonl',
    rows: [
      {
        recordId: 'r-1',
        timestamp: '2026-09-05T10:00:00.000Z',
        amount: 10,
        metadata: { nested: { source: 'v2' } },
      },
      {
        recordId: 'r-2',
        timestamp: '2026-09-05T10:05:00.000Z',
        amount: 20,
        metadata: { nested: { source: 'v2' } },
      },
      {
        recordId: 'r-3',
        timestamp: 1788603000000,
        amount: 30,
        metadata: { nested: { source: 'v2' } },
      },
    ],
    contract: {
      parserV1:
        'ISO-8601 timestamp only; unknown additive nested metadata is compatible/preserved in raw provenance',
      parserV2: 'ISO-8601 or epoch milliseconds; reprocess quarantined epoch rows exactly once',
      incompatibleReason: 'TIMESTAMP_FORMAT_INCOMPATIBLE',
      sourceIdentity: 'fileId + recordId',
    },
  },
  null,
  2,
)}\n`;

const pipelineDriftMaterializer: SkillEvalFixtureMaterializer = {
  id: 'data-pipeline-engineering/schema-drift-quarantine@2',
  matches: (scenario) => scenario.id === PIPELINE_DRIFT,
  materialize: (destination) => {
    writeFixtureFile(destination, 'package.json', packageJson('kory-eval-pipeline-drift'));
    writeFixtureFile(destination, 'src/partner-pipeline.ts', DRIFT_SOURCE);
    writeFixtureFile(destination, 'data/feed.json', DRIFT_DATA);
    writeFixtureFile(destination, 'tests/.gitkeep', '');
    writeFixtureFile(
      destination,
      'README.md',
      `# Data pipeline engineering — schema drift + quarantine

Repair the existing \`PartnerFeedPipeline\` while preserving its public API. Parser v1 accepts ISO-8601 timestamps and additive nested metadata, but epoch-millisecond timestamps are incompatible and must be quarantined with raw row/file provenance + reason \`TIMESTAMP_FORMAT_INCOMPATIBLE\`; never silently normalize them to an empty/null event time. Parser v2 explicitly adds epoch-millisecond support.

Duplicate delivery of the same \`fileId + recordId\` is idempotent. After the parser update, \`reprocessQuarantine(2)\` moves the previously quarantined epoch row into normalized output exactly once and clears/resolves that quarantine record without duplicating valid rows. Keep raw landing provenance.

Keep executable regression tests in \`tests/\` that name the incompatible-timestamp or epoch row, the quarantine record, duplicate or rerun idempotency, and the parser-v2 reprocess or recovery path; the host reads that test text, so a report row alone is not enough.

Write \`.kory-eval/pipeline-drift.json\` with source/schema versions, compatibility boundary, raw provenance, reason-coded quarantine, rerun idempotency, parser-update recovery/reprocessing, lineage/reconciliation, explicit synthetic evidence label, and hierarchy boundary: broader \`data-analysis\`; \`data-visualization\` and business metrics remain out of scope.
`,
    );
  },
};

const pipelineDriftScorer: SkillEvalDeterministicScorer = {
  id: 'data-pipeline-engineering/schema-drift-quarantine-scorer@3',
  scenarioIds: [PIPELINE_DRIFT],
  score: ({ workingDirectory }) => {
    const hidden = runHiddenBunTest(
      workingDirectory,
      `import { expect,test } from 'bun:test'; import fixture from '../data/feed.json'; import { PartnerFeedPipeline } from '../src/partner-pipeline';
test('hidden: v1 preserves valid rows and quarantines incompatible epoch row with provenance',()=>{
 const p=new PartnerFeedPipeline(); p.ingestFile(fixture.fileId,fixture.rows as any,1); const s=p.snapshot();
 expect(s.normalized.map((r)=>r.recordId)).toEqual(['r-1','r-2']); expect(s.normalized.every((r)=>r.eventTime.length>0)).toBe(true);
 expect(s.quarantine).toHaveLength(1); expect(s.quarantine[0]).toMatchObject({fileId:fixture.fileId,reason:'TIMESTAMP_FORMAT_INCOMPATIBLE'}); expect(s.quarantine[0]?.raw.recordId).toBe('r-3');
});
test('hidden: duplicate file rerun is idempotent and v2 recovery moves epoch row exactly once',()=>{
 const p=new PartnerFeedPipeline(); p.ingestFile(fixture.fileId,fixture.rows as any,1); p.ingestFile(fixture.fileId,fixture.rows as any,1);
 expect(p.snapshot().normalized).toHaveLength(2); expect(p.snapshot().quarantine).toHaveLength(1);
 p.reprocessQuarantine(2); p.reprocessQuarantine(2); const s=p.snapshot(); expect(s.normalized.map((r)=>r.recordId)).toEqual(['r-1','r-2','r-3']); expect(s.quarantine).toHaveLength(0); expect(s.normalized.find((r)=>r.recordId==='r-3')?.eventTime).toMatch(/^2026-/);
});
`,
    );
    const regression = hasRegressionText(workingDirectory, [
      /TIMESTAMP_FORMAT_INCOMPATIBLE|epoch/iu,
      /quarantine/iu,
      /rerun|duplicate|idempoten/iu,
      /reprocess|parser.*2|recovery/iu,
    ]);
    const artifact = readJsonArtifact<unknown>(workingDirectory, '.kory-eval/pipeline-drift.json');
    const body = JSON.stringify(artifact ?? '').toLowerCase();
    const contract =
      /iso-8601|iso/u.test(body) &&
      /epoch/u.test(body) &&
      /parser.*v?1|version 1/u.test(body) &&
      /parser.*v?2|version 2/u.test(body) &&
      /timestamp_format_incompatible/u.test(body) &&
      /provenance|raw/u.test(body) &&
      /idempoten/u.test(body) &&
      /reprocess|recovery/u.test(body);
    const boundary =
      /data[\s_-]?analysis/u.test(body) &&
      /data[\s_-]?visuali[sz]ation/u.test(body) &&
      /out of scope|not selected|boundary/u.test(body) &&
      /synthetic|fixture/u.test(body) &&
      !/\barr\b|conversion metric|business metric definition/u.test(body);
    const passed = hidden.passed && regression && Boolean(artifact) && contract && boundary;
    return {
      passed,
      quality: passed ? 1 : hidden.passed && contract ? 0.75 : hidden.passed ? 0.5 : 0,
      verification: hidden.passed ? 1 : 0,
      integrityFailure: false,
      evidence: [
        `schema-drift/quarantine/recovery hidden oracle: ${hidden.passed ? 'pass' : 'fail'}`,
        `negative/recovery regressions: ${regression ? 'present' : 'missing'}`,
        `versioned compatibility/provenance contract: ${contract ? 'complete' : 'incomplete'}`,
        `pipeline-vs-visual/business boundary: ${boundary ? 'explicit' : 'missing'}`,
        hidden.evidence,
      ],
    };
  },
};

export const DATA_ENGINEERING_SKILL_EVAL_MATERIALIZERS: readonly SkillEvalFixtureMaterializer[] = [
  analyticsOrdersMaterializer,
  analyticsScdMaterializer,
  pipelineCdcMaterializer,
  pipelineDriftMaterializer,
];

export const DATA_ENGINEERING_SKILL_EVAL_SCORERS: readonly SkillEvalDeterministicScorer[] = [
  analyticsOrdersScorer,
  analyticsScdScorer,
  pipelineCdcScorer,
  pipelineDriftScorer,
];
