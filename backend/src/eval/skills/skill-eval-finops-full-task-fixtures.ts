import { lstatSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type {
  SkillEvalDeterministicScore,
  SkillEvalDeterministicScorer,
  SkillEvalFixtureMaterializer,
} from './skill-eval-execution';
import { readJsonArtifact, writeFixtureFile } from './skill-eval-fixture-helpers';

const SCENARIO_ALLOCATION = 'finops-cloud-cost-full-task-1-individual';
const SCENARIO_COMMITMENT = 'finops-cloud-cost-full-task-2-individual';

type JsonRecord = Record<string, unknown>;

interface FinopsResult {
  scenarioId?: string;
  boundary?: string;
  costContract?: JsonRecord;
  reconciliation?: JsonRecord;
  allocation?: JsonRecord;
  unitEconomics?: JsonRecord;
  recommendationDecision?: JsonRecord;
  realizedSavings?: JsonRecord;
  commitmentDecision?: JsonRecord;
  monitoring?: JsonRecord;
  governance?: JsonRecord;
  uncertainty?: string[];
}

interface FinopsVerification {
  checks?: Array<{ id?: string; status?: string; evidence?: string }>;
  negativePath?: string;
  recovery?: string;
  evidenceLabels?: JsonRecord;
}

const allocationPacket = {
  scenarioId: SCENARIO_ALLOCATION,
  evidenceKind: 'representative-finops-ledger',
  source: {
    provider: 'AWS',
    export: 'CUR-compatible-evaluator-ledger',
    schemaVersion: '2.0',
    billingPeriod: '2026-08',
    currency: 'USD',
    costLens: 'billed-and-effective',
    invoiceTotalBilled: 10000,
  },
  rows: [
    {
      id: 'a-compute',
      owner: 'team-a',
      service: 'compute',
      billed: 3600,
      effective: 3200,
      list: 4500,
    },
    {
      id: 'b-compute',
      owner: 'team-b',
      service: 'compute',
      billed: 2600,
      effective: 2200,
      list: 3300,
    },
    {
      id: 'shared-observability',
      owner: 'shared',
      service: 'observability',
      billed: 2800,
      effective: 2400,
      list: 3300,
    },
    {
      id: 'unallocated-transfer',
      owner: 'unallocated',
      service: 'data-transfer',
      billed: 1000,
      effective: 800,
      list: 1200,
    },
  ],
  sharedAllocationWeights: { 'team-a': 0.6, 'team-b': 0.4 },
  denominators: {
    source: 'product-transaction-ledger',
    period: '2026-08',
    transactions: { 'team-a': 2400, 'team-b': 1200 },
  },
  priorPeriod: {
    period: '2026-07',
    billedAllocated: { 'team-a': 5000, 'team-b': 3500 },
    transactions: { 'team-a': 2500, 'team-b': 1000 },
  },
  recommendations: [
    {
      id: 'R1',
      kind: 'rightsize',
      effectiveSavingsEstimate: 900,
      overlaps: ['R2'],
      lookbackDays: 30,
      evidence: 'memory headroom and p95 CPU leave reversible downsize candidate',
    },
    {
      id: 'R2',
      kind: 'schedule',
      effectiveSavingsEstimate: 600,
      overlaps: ['R1'],
      lookbackDays: 14,
      evidence: 'non-production idle window overlaps part of R1 resource set',
    },
    {
      id: 'C1',
      kind: 'commitment',
      effectiveSavingsEstimate: 1300,
      overlaps: [],
      lookbackDays: 7,
      evidence: 'provider estimate uses list-rate baseline; migration decision is still pending',
    },
  ],
  implementedChange: {
    id: 'schedule-nonprod-v1',
    expectedEffectiveSavings: 850,
    beforeEffectiveCost: 8600,
    afterEffectiveCost: 7900,
    demandBefore: 3500,
    demandAfter: 3640,
    p95LatencyBeforeMs: 180,
    p95LatencyAfterMs: 182,
    errorRateBefore: 0.002,
    errorRateAfter: 0.0021,
    availabilityBefore: 0.9995,
    availabilityAfter: 0.9995,
    rollbackReady: true,
  },
  guardrails: { p95LatencyMaxMs: 200, errorRateMax: 0.003, availabilityMin: 0.999 },
  governance: { owner: 'platform-finops', reviewCadence: 'monthly', unallocatedAlertPercent: 5 },
} as const;

const commitmentPacket = {
  scenarioId: SCENARIO_COMMITMENT,
  evidenceKind: 'representative-finops-commitment-ledger',
  source: {
    provider: 'Azure',
    export: 'FOCUS-compatible-evaluator-ledger',
    schemaVersion: '1.1',
    billingPeriods: ['2026-04', '2026-05', '2026-06', '2026-07', '2026-08'],
    currency: 'USD',
    costLens: 'effective',
    reconciledToInvoice: true,
  },
  stableEligibleHourly: [110, 108, 112, 105, 109],
  existingCommitmentHourly: 25,
  utilizationFloor: 0.8,
  providerRecommendation: {
    proposedHourlyCommit: 70,
    estimatedDiscountPercent: 28,
    lookbackDays: 7,
    basis: 'list-price',
  },
  pendingUsageOptimizationsHourly: 10,
  demandScenarios: {
    steadyAfterOptimization: 95,
    migration: 75,
    seasonalLow: 85,
    growth: 120,
  },
  constraints: {
    migrationDecisionPending: true,
    cashApproved: true,
    termMonths: 12,
    rollback: 'cannot-cancel-after-purchase',
  },
  hypotheticalPostPurchase: {
    commitHourly: 40,
    observedEligibleHourly: 82,
    p95LatencyMs: 185,
    errorRate: 0.0022,
    availability: 0.9994,
  },
  guardrails: { p95LatencyMaxMs: 200, errorRateMax: 0.003, availabilityMin: 0.999 },
  governance: { owner: 'cloud-finops', reviewCadence: 'weekly', renewalReviewDaysBefore: 45 },
} as const;

const json = (value: unknown): string => JSON.stringify(value, null, 2) + '\n';
const allocationResultStarter = json({
  scenarioId: '<string>',
  boundary: '<string>',
  costContract: {
    provider: '<string>',
    export: '<string>',
    schemaVersion: '<string>',
    period: '<string>',
    currency: '<string>',
    costLens: '<string>',
  },
  reconciliation: { billedRowTotal: null, invoiceTotal: null, reconciled: null },
  allocation: {
    allocated: { 'team-a': null, 'team-b': null },
    sharedPool: null,
    unallocated: null,
    unallocatedPercent: null,
  },
  unitEconomics: {
    denominatorSource: '<string>',
    current: { 'team-a': null, 'team-b': null },
    prior: { 'team-a': null, 'team-b': null },
  },
  recommendationDecision: {
    selectedRecommendationIds: [],
    deferredRecommendationIds: [],
  },
  realizedSavings: {
    effectiveSavings: null,
    beforeUnitCost: null,
    afterUnitCost: null,
    guardrailsPass: null,
    rollbackReady: null,
  },
  governance: { owner: '<string>', reviewCadence: '<string>' },
  uncertainty: [],
});
const commitmentResultStarter = json({
  scenarioId: '<string>',
  boundary: '<string>',
  costContract: {
    provider: '<string>',
    export: '<string>',
    schemaVersion: '<string>',
    periods: [],
    currency: '<string>',
    costLens: '<string>',
  },
  reconciliation: { reconciled: null },
  commitmentDecision: {
    existingCommitmentHourly: null,
    worstDemandHourly: null,
    maxSafeNewCommitHourly: null,
    providerProposedHourly: null,
    purchaseAllowedNow: null,
    reasons: ['<reason-code>'],
    providerEstimateBasis: '<string>',
    providerLookbackDays: null,
  },
  monitoring: {
    status: '<status-enum>',
    commitCoverage: null,
    commitUtilization: null,
    guardrailsPass: null,
  },
  governance: {
    owner: '<string>',
    reviewCadence: '<string>',
    renewalReviewDaysBefore: null,
  },
  uncertainty: [],
});
const verificationStarter = json({
  checks: [],
  negativePath: 'TODO',
  recovery: 'TODO',
  evidenceLabels: {},
});

function packetFor(scenarioId: string): unknown {
  if (scenarioId === SCENARIO_ALLOCATION) return allocationPacket;
  if (scenarioId === SCENARIO_COMMITMENT) return commitmentPacket;
  throw new Error('Unknown FinOps scenario: ' + scenarioId);
}

function resultStarterFor(scenarioId: string): string {
  if (scenarioId === SCENARIO_ALLOCATION) return allocationResultStarter;
  if (scenarioId === SCENARIO_COMMITMENT) return commitmentResultStarter;
  throw new Error('Unknown FinOps scenario: ' + scenarioId);
}

function readme(scenarioId: string): string {
  const scenarioSpecific =
    scenarioId === SCENARIO_ALLOCATION
      ? [
          'Scenario 1 must additionally report allocation, unitEconomics, recommendationDecision, and realizedSavings. Reconcile billed rows to the invoice, allocate the shared pool by the declared weights, keep unallocated cost visible, normalize by transactions, deduplicate overlapping recommendations, and judge the implemented change from measured effective cost plus reliability guardrails. Do not call list-price or provider-estimated savings realized. Full commitment purchase-sizing and post-purchase monitoring are outside this fixture beyond correctly deferring C1 and preserving its provenance and unresolved migration risk.',
          '',
          'Exact Scenario 1 result.json keys/types:',
          '- reconciliation.billedRowTotal, invoiceTotal: numbers; reconciliation.reconciled: boolean',
          '- allocation.allocated[team]: numbers; allocation.sharedPool, unallocated, unallocatedPercent: numbers',
          '- unitEconomics.denominatorSource: string; unitEconomics.current[team] and prior[team]: numbers',
          '- recommendationDecision.selectedRecommendationIds and deferredRecommendationIds: string arrays',
          '- realizedSavings.effectiveSavings, beforeUnitCost, afterUnitCost: numbers; guardrailsPass and rollbackReady: booleans',
          '- governance.owner and reviewCadence: strings; uncertainty: string array',
        ].join('\n')
      : [
          'Scenario 2 must additionally report commitmentDecision and monitoring. Model the maximum new commitment against the worst declared demand scenario after the existing commitment, apply the utilization floor, keep pending usage optimization and migration risk explicit, and distinguish a provider list-price recommendation from an authorized purchase. The supplied post-purchase record is hypothetical monitoring evidence, not proof that a purchase occurred. Allocation/unit economics and implemented realized-savings evidence are outside this fixture because no allocation denominator or executed purchase is supplied.',
          '',
          'Exact Scenario 2 result.json keys/types:',
          '- reconciliation.reconciled: boolean',
          '- commitmentDecision.existingCommitmentHourly, worstDemandHourly, maxSafeNewCommitHourly, providerProposedHourly, providerLookbackDays: numbers',
          '- commitmentDecision.purchaseAllowedNow: boolean; reasons: string array; providerEstimateBasis: string',
          '- commitmentDecision.reasons uses machine-readable reason codes. Supported codes for supplied evidence are migration-decision-pending, provider-proposal-above-safe-bound, pending-usage-optimization, and noncancellable-term. Include each code whose condition is present in evidence; explanatory prose belongs in verification.json.',
          '- monitoring.status: string; monitoring.commitCoverage and commitUtilization: numbers; monitoring.guardrailsPass: boolean',
          '- monitoring.status must be exactly hypothetical-not-purchased when the supplied monitoring record is hypothetical and no purchase is evidenced.',
          '- governance.owner and reviewCadence: strings; governance.renewalReviewDaysBefore: number; uncertainty: string array',
          '',
          'Safe-bound formula: worstDemandHourly = min(declared demand scenarios); uncoveredWorstHourly = max(0, worstDemandHourly - existingCommitmentHourly); maxSafeNewCommitHourly = uncoveredWorstHourly * utilizationFloor. Apply the floor after subtracting the existing commitment.',
          'Monitoring semantics: commitCoverage = hypothetical new commitment / observed eligible usage. commitUtilization = min(observed eligible usage / hypothetical new commitment, 1). Coverage and utilization are distinct and both must be recomputed from the hypothetical record.',
        ].join('\n');

  return [
    '# FinOps full-task evaluation',
    '',
    'This repository contains evaluator-owned, representative cloud-cost evidence. Treat it as observed fixture evidence, not live provider state. Do not modify evidence/packet.json.',
    '',
    'Produce result.json and verification.json. The starter files are shape guides only; replace every placeholder with evidence-derived values.',
    '',
    'Required result fields for both scenarios:',
    '- scenarioId',
    '- boundary: exactly finops-cloud-cost',
    '- costContract with provider/export/schemaVersion/period-or-periods/currency/costLens',
    '- reconciliation with the independently reconciled billing conclusion',
    '- governance and uncertainty',
    '',
    scenarioSpecific,
    '',
    'Verification must include these check ids with status=passed and concrete evidence:',
    '- scope-and-hierarchy',
    '- operating-contract',
    '- execution-invariant',
    '- verification-discipline',
    '- anti-pattern-resistance',
    '- evidence-and-uncertainty',
    '',
    'verification.json negativePath and recovery must each be descriptive strings (at least 20 characters), not objects or arrays.',
    '',
    'Evidence labels must include fixture=observed, liveProvider=unavailable, and pairedEvaluation=external-evaluator.',
    '',
  ].join('\n');
}

function fixedFiles(scenarioId: string): Record<string, string> {
  return {
    'README.md': readme(scenarioId),
    'evidence/packet.json': json(packetFor(scenarioId)),
  };
}

function regularText(root: string, relativePath: string): string | null {
  try {
    const path = join(root, relativePath);
    if (!lstatSync(path).isFile()) return null;
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}

function rounded(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function fixedInputsIntact(root: string, scenarioId: string): boolean {
  return Object.entries(fixedFiles(scenarioId)).every(
    ([path, expected]) => regularText(root, path) === expected,
  );
}

function objectValue(value: unknown): JsonRecord | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as JsonRecord) : null;
}

function num(value: JsonRecord | null, key: string): number | null {
  const candidate = value?.[key];
  return typeof candidate === 'number' && Number.isFinite(candidate) ? candidate : null;
}

function str(value: JsonRecord | null, key: string): string | null {
  const candidate = value?.[key];
  return typeof candidate === 'string' ? candidate : null;
}

function bool(value: JsonRecord | null, key: string): boolean | null {
  const candidate = value?.[key];
  return typeof candidate === 'boolean' ? candidate : null;
}

function strings(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];
}

function approximately(actual: number | null, expected: number, tolerance = 0.001): boolean {
  return actual !== null && Math.abs(actual - expected) <= tolerance;
}

function scoreVerification(verification: FinopsVerification | null): Array<[string, boolean]> {
  const required = new Set([
    'scope-and-hierarchy',
    'operating-contract',
    'execution-invariant',
    'verification-discipline',
    'anti-pattern-resistance',
    'evidence-and-uncertainty',
  ]);
  const rows = Array.isArray(verification?.checks) ? verification.checks : [];
  const covered = new Set(
    rows
      .filter(
        (row) =>
          typeof row?.id === 'string' &&
          row.status === 'passed' &&
          typeof row.evidence === 'string' &&
          row.evidence.trim().length >= 12,
      )
      .map((row) => row.id as string),
  );
  const labels = objectValue(verification?.evidenceLabels);
  return [
    ['all falsifiable checks evidenced', [...required].every((id) => covered.has(id))],
    [
      'negative path recorded',
      typeof verification?.negativePath === 'string' &&
        verification.negativePath.trim().length >= 20,
    ],
    [
      'recovery path recorded',
      typeof verification?.recovery === 'string' && verification.recovery.trim().length >= 20,
    ],
    ['fixture evidence labeled observed', str(labels, 'fixture') === 'observed'],
    ['live provider evidence labeled unavailable', str(labels, 'liveProvider') === 'unavailable'],
    [
      'paired evaluation labeled external evaluator',
      str(labels, 'pairedEvaluation') === 'external-evaluator',
    ],
  ];
}

function scoreAllocation(result: FinopsResult | null): Array<[string, boolean]> {
  const reconciliation = objectValue(result?.reconciliation);
  const allocation = objectValue(result?.allocation);
  const allocated = objectValue(allocation?.allocated);
  const unit = objectValue(result?.unitEconomics);
  const current = objectValue(unit?.current);
  const prior = objectValue(unit?.prior);
  const recommendation = objectValue(result?.recommendationDecision);
  const realized = objectValue(result?.realizedSavings);
  const governance = objectValue(result?.governance);
  const contract = objectValue(result?.costContract);

  const billed = allocationPacket.rows.reduce((sum, row) => sum + row.billed, 0);
  const shared = allocationPacket.rows.find((row) => row.owner === 'shared')!.billed;
  const directA = allocationPacket.rows.find((row) => row.owner === 'team-a')!.billed;
  const directB = allocationPacket.rows.find((row) => row.owner === 'team-b')!.billed;
  const unallocated = allocationPacket.rows.find((row) => row.owner === 'unallocated')!.billed;
  const allocatedA = directA + shared * allocationPacket.sharedAllocationWeights['team-a'];
  const allocatedB = directB + shared * allocationPacket.sharedAllocationWeights['team-b'];
  const currentA = rounded(allocatedA / allocationPacket.denominators.transactions['team-a']);
  const currentB = rounded(allocatedB / allocationPacket.denominators.transactions['team-b']);
  const priorA = rounded(
    allocationPacket.priorPeriod.billedAllocated['team-a'] /
      allocationPacket.priorPeriod.transactions['team-a'],
  );
  const priorB = rounded(
    allocationPacket.priorPeriod.billedAllocated['team-b'] /
      allocationPacket.priorPeriod.transactions['team-b'],
  );
  const measuredSavings =
    allocationPacket.implementedChange.beforeEffectiveCost -
    allocationPacket.implementedChange.afterEffectiveCost;
  const beforeUnit = rounded(
    allocationPacket.implementedChange.beforeEffectiveCost /
      allocationPacket.implementedChange.demandBefore,
  );
  const afterUnit = rounded(
    allocationPacket.implementedChange.afterEffectiveCost /
      allocationPacket.implementedChange.demandAfter,
  );
  const guardrailsPass =
    allocationPacket.implementedChange.p95LatencyAfterMs <=
      allocationPacket.guardrails.p95LatencyMaxMs &&
    allocationPacket.implementedChange.errorRateAfter <= allocationPacket.guardrails.errorRateMax &&
    allocationPacket.implementedChange.availabilityAfter >=
      allocationPacket.guardrails.availabilityMin;
  const selected = new Set(strings(recommendation?.selectedRecommendationIds));
  const deferred = new Set(strings(recommendation?.deferredRecommendationIds));
  const uncertainty = strings(result?.uncertainty);

  return [
    ['scenario identity', result?.scenarioId === SCENARIO_ALLOCATION],
    ['skill boundary', result?.boundary === 'finops-cloud-cost'],
    ['cost provider', str(contract, 'provider') === allocationPacket.source.provider],
    ['cost export', str(contract, 'export') === allocationPacket.source.export],
    ['cost schema', str(contract, 'schemaVersion') === allocationPacket.source.schemaVersion],
    ['cost period', str(contract, 'period') === allocationPacket.source.billingPeriod],
    ['cost currency', str(contract, 'currency') === allocationPacket.source.currency],
    ['cost lens', str(contract, 'costLens') === allocationPacket.source.costLens],
    ['billed rows reconcile', approximately(num(reconciliation, 'billedRowTotal'), billed)],
    [
      'invoice total reconciled',
      bool(reconciliation, 'reconciled') === true &&
        approximately(
          num(reconciliation, 'invoiceTotal'),
          allocationPacket.source.invoiceTotalBilled,
        ),
    ],
    ['team-a allocation', approximately(num(allocated, 'team-a'), allocatedA)],
    ['team-b allocation', approximately(num(allocated, 'team-b'), allocatedB)],
    ['unallocated preserved', approximately(num(allocation, 'unallocated'), unallocated)],
    [
      'unallocated percentage',
      approximately(num(allocation, 'unallocatedPercent'), rounded((unallocated / billed) * 100)),
    ],
    ['shared pool visible', approximately(num(allocation, 'sharedPool'), shared)],
    ['team-a current unit cost', approximately(num(current, 'team-a'), currentA)],
    ['team-b current unit cost', approximately(num(current, 'team-b'), currentB)],
    ['team-a prior unit cost', approximately(num(prior, 'team-a'), priorA)],
    ['team-b prior unit cost', approximately(num(prior, 'team-b'), priorB)],
    ['denominator source', str(unit, 'denominatorSource') === allocationPacket.denominators.source],
    [
      'overlap deduplicated',
      !(
        (selected.has('R1') && selected.has('R2')) ||
        (!selected.has('R1') && !selected.has('R2') && !deferred.has('R1') && !deferred.has('R2'))
      ),
    ],
    ['commitment estimate deferred', deferred.has('C1')],
    [
      'measured effective savings',
      approximately(num(realized, 'effectiveSavings'), measuredSavings),
    ],
    [
      'measured savings differs from estimate',
      measuredSavings !== allocationPacket.implementedChange.expectedEffectiveSavings,
    ],
    ['before unit cost', approximately(num(realized, 'beforeUnitCost'), beforeUnit)],
    ['after unit cost', approximately(num(realized, 'afterUnitCost'), afterUnit)],
    ['reliability guardrails', bool(realized, 'guardrailsPass') === guardrailsPass],
    [
      'rollback readiness',
      bool(realized, 'rollbackReady') === allocationPacket.implementedChange.rollbackReady,
    ],
    ['governance owner', str(governance, 'owner') === allocationPacket.governance.owner],
    [
      'governance cadence',
      str(governance, 'reviewCadence') === allocationPacket.governance.reviewCadence,
    ],
    [
      'unallocated alert recognized',
      (num(allocation, 'unallocatedPercent') ?? -1) >
        allocationPacket.governance.unallocatedAlertPercent,
    ],
    [
      'live-provider uncertainty preserved',
      uncertainty.some((item) => /live|provider|fixture|unavailable/iu.test(item)),
    ],
  ];
}

function scoreCommitment(result: FinopsResult | null): Array<[string, boolean]> {
  const reconciliation = objectValue(result?.reconciliation);
  const decision = objectValue(result?.commitmentDecision);
  const monitoring = objectValue(result?.monitoring);
  const governance = objectValue(result?.governance);
  const contract = objectValue(result?.costContract);
  const minDemand = Math.min(...Object.values(commitmentPacket.demandScenarios));
  const netWorst = Math.max(0, minDemand - commitmentPacket.existingCommitmentHourly);
  const maxSafe = rounded(netWorst * commitmentPacket.utilizationFloor);
  const reasons = new Set(strings(decision?.reasons));
  const uncertainty = strings(result?.uncertainty);
  const coverage = rounded(
    commitmentPacket.hypotheticalPostPurchase.commitHourly /
      commitmentPacket.hypotheticalPostPurchase.observedEligibleHourly,
  );
  const utilization = rounded(
    Math.min(
      commitmentPacket.hypotheticalPostPurchase.observedEligibleHourly /
        commitmentPacket.hypotheticalPostPurchase.commitHourly,
      1,
    ),
  );
  const guardrailsPass =
    commitmentPacket.hypotheticalPostPurchase.p95LatencyMs <=
      commitmentPacket.guardrails.p95LatencyMaxMs &&
    commitmentPacket.hypotheticalPostPurchase.errorRate <=
      commitmentPacket.guardrails.errorRateMax &&
    commitmentPacket.hypotheticalPostPurchase.availability >=
      commitmentPacket.guardrails.availabilityMin;

  return [
    ['scenario identity', result?.scenarioId === SCENARIO_COMMITMENT],
    ['skill boundary', result?.boundary === 'finops-cloud-cost'],
    ['cost provider', str(contract, 'provider') === commitmentPacket.source.provider],
    ['cost export', str(contract, 'export') === commitmentPacket.source.export],
    ['cost schema', str(contract, 'schemaVersion') === commitmentPacket.source.schemaVersion],
    ['cost currency', str(contract, 'currency') === commitmentPacket.source.currency],
    ['cost lens', str(contract, 'costLens') === commitmentPacket.source.costLens],
    [
      'period history captured',
      Array.isArray(contract?.periods) &&
        contract.periods.length === commitmentPacket.source.billingPeriods.length,
    ],
    [
      'invoice history reconciled',
      bool(reconciliation, 'reconciled') === commitmentPacket.source.reconciledToInvoice,
    ],
    [
      'existing commitment recorded',
      approximately(
        num(decision, 'existingCommitmentHourly'),
        commitmentPacket.existingCommitmentHourly,
      ),
    ],
    ['worst demand modeled', approximately(num(decision, 'worstDemandHourly'), minDemand)],
    ['safe commitment bounded', approximately(num(decision, 'maxSafeNewCommitHourly'), maxSafe)],
    [
      'provider proposal recorded',
      approximately(
        num(decision, 'providerProposedHourly'),
        commitmentPacket.providerRecommendation.proposedHourlyCommit,
      ),
    ],
    ['purchase blocked now', bool(decision, 'purchaseAllowedNow') === false],
    ['migration risk represented', reasons.has('migration-decision-pending')],
    ['provider proposal above safe bound', reasons.has('provider-proposal-above-safe-bound')],
    ['pending usage optimization represented', reasons.has('pending-usage-optimization')],
    ['irreversible term represented', reasons.has('noncancellable-term')],
    [
      'provider estimate basis',
      str(decision, 'providerEstimateBasis') === commitmentPacket.providerRecommendation.basis,
    ],
    [
      'provider lookback',
      approximately(
        num(decision, 'providerLookbackDays'),
        commitmentPacket.providerRecommendation.lookbackDays,
      ),
    ],
    ['monitoring remains hypothetical', str(monitoring, 'status') === 'hypothetical-not-purchased'],
    ['monitor coverage recomputed', approximately(num(monitoring, 'commitCoverage'), coverage)],
    [
      'monitor utilization recomputed',
      approximately(num(monitoring, 'commitUtilization'), utilization),
    ],
    ['monitor guardrails recomputed', bool(monitoring, 'guardrailsPass') === guardrailsPass],
    ['governance owner', str(governance, 'owner') === commitmentPacket.governance.owner],
    [
      'governance cadence',
      str(governance, 'reviewCadence') === commitmentPacket.governance.reviewCadence,
    ],
    [
      'renewal review captured',
      approximately(
        num(governance, 'renewalReviewDaysBefore'),
        commitmentPacket.governance.renewalReviewDaysBefore,
      ),
    ],
    [
      'live-provider uncertainty preserved',
      uncertainty.some((item) => /live|provider|fixture|unavailable/iu.test(item)),
    ],
  ];
}

export function scoreFinopsFullTask(scenarioId: string, root: string): SkillEvalDeterministicScore {
  if (!fixedInputsIntact(root, scenarioId)) {
    return {
      passed: false,
      quality: 0,
      verification: 0,
      integrityFailure: true,
      evidence: ['Evaluator-owned FinOps evidence was altered or missing; results discarded.'],
    };
  }

  const resultText = regularText(root, 'result.json');
  const verificationText = regularText(root, 'verification.json');
  const result =
    resultText && resultText !== resultStarterFor(scenarioId)
      ? readJsonArtifact<FinopsResult>(root, 'result.json')
      : null;
  const verification =
    verificationText && verificationText !== verificationStarter
      ? readJsonArtifact<FinopsVerification>(root, 'verification.json')
      : null;
  const checks: Array<[string, boolean]> = [
    ['substantive result artifact', result !== null],
    ['substantive verification artifact', verification !== null],
    ...(scenarioId === SCENARIO_ALLOCATION ? scoreAllocation(result) : scoreCommitment(result)),
    ...scoreVerification(verification),
  ];
  const passing = checks.filter(([, ok]) => ok).length;
  const passed = checks.every(([, ok]) => ok);
  return {
    passed,
    quality: passing / checks.length,
    verification: passed ? 1 : 0,
    integrityFailure: false,
    evidence: [
      ...checks.map(([name, ok]) => name + ': ' + (ok ? 'pass' : 'fail')),
      'Independent scorer recomputed FinOps reconciliation and decision metrics from immutable evidence.',
      'Fixture data is representative evidence; live provider state remains unavailable and is never claimed.',
    ],
  };
}

export const FINOPS_FULL_TASK_SKILL_EVAL_MATERIALIZERS: readonly SkillEvalFixtureMaterializer[] = [
  {
    id: 'finops-cloud-cost/reconciled-ledger-full-task@3',
    matches: (scenario) => scenario.id === SCENARIO_ALLOCATION,
    materialize: (root) => {
      for (const [path, content] of Object.entries(fixedFiles(SCENARIO_ALLOCATION))) {
        writeFixtureFile(root, path, content);
      }
      writeFixtureFile(root, 'result.json', allocationResultStarter);
      writeFixtureFile(root, 'verification.json', verificationStarter);
    },
  },
  {
    id: 'finops-cloud-cost/commitment-ledger-full-task@4',
    matches: (scenario) => scenario.id === SCENARIO_COMMITMENT,
    materialize: (root) => {
      for (const [path, content] of Object.entries(fixedFiles(SCENARIO_COMMITMENT))) {
        writeFixtureFile(root, path, content);
      }
      writeFixtureFile(root, 'result.json', commitmentResultStarter);
      writeFixtureFile(root, 'verification.json', verificationStarter);
    },
  },
];

export const FINOPS_FULL_TASK_SKILL_EVAL_SCORERS: readonly SkillEvalDeterministicScorer[] = [
  {
    id: 'finops-cloud-cost/reconciled-ledger-full-task-scorer@3',
    scenarioIds: [SCENARIO_ALLOCATION],
    score: ({ workingDirectory }) => scoreFinopsFullTask(SCENARIO_ALLOCATION, workingDirectory),
  },
  {
    id: 'finops-cloud-cost/commitment-ledger-full-task-scorer@4',
    scenarioIds: [SCENARIO_COMMITMENT],
    score: ({ workingDirectory }) => scoreFinopsFullTask(SCENARIO_COMMITMENT, workingDirectory),
  },
];

export const FINOPS_FULL_TASK_EVAL_CONSTANTS = {
  scenarioAllocation: SCENARIO_ALLOCATION,
  scenarioCommitment: SCENARIO_COMMITMENT,
  allocationPacket,
  commitmentPacket,
  allocationResultStarter,
  commitmentResultStarter,
  verificationStarter,
} as const;
