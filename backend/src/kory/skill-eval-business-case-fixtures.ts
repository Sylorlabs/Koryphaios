import { createHash } from 'node:crypto';
import { lstatSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import type {
  SkillEvalDeterministicScore,
  SkillEvalDeterministicScorer,
  SkillEvalFixtureMaterializer,
} from './skill-eval-execution';
import { writeFixtureFile } from './skill-eval-fixture-helpers';

export const BUSINESS_CASE_SCENARIOS = [
  'business-case-analysis-full-task-1-individual',
  'business-case-analysis-full-task-2-individual',
] as const;

export interface BusinessOption {
  id: string;
  sourceId: string;
  startYear: number;
  upfrontYear: number;
  upfront: Record<string, number>;
  license: number;
  escalation: number;
  support: number;
  monitoring: number;
  retainedLegacyFraction: number;
  coverage: number;
  exitCost: number;
  engineeringMonths: number;
  foregoneCapitalValue: number;
  security: 'cleared' | 'pending';
  strategicFit: 'satisfies' | 'gap';
  lockIn: string;
}

export interface BusinessAssumptions {
  id: string;
  adoption: number[];
  demand: number[];
  implementationMultiplier: number;
  handlingReduction: number;
  incrementalExceptionRate: number;
}

export interface BusinessPacket {
  scenarioId: string;
  evidenceKind: 'synthetic-decision-packet';
  currency: 'USD';
  horizonYears: number;
  discountRate: number;
  baselineAnnualCost: number;
  annualTasks: number;
  annualHandlingHours: number;
  approvedContractorAvoidance: number;
  exceptionUnitCashCost: number;
  availableEngineeringMonths: number;
  engineeringShadowPrice: number;
  legacySunkCost: number;
  sources: Record<string, { kind: string; confidence: string; evidence: string }>;
  options: BusinessOption[];
  cases: BusinessAssumptions[];
  expansionGates: Array<{
    id: string;
    metric: string;
    operator: 'gte' | 'lte';
    threshold: number;
    observed: number | null;
    sourceId: string;
  }>;
}

const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;
const sum = (values: number[]) => values.reduce((a, b) => a + b, 0);

/** All amounts are authored experiment data, not vendor quotes or investment advice. */
export function businessCasePacket(scenarioId: string): BusinessPacket {
  if (!BUSINESS_CASE_SCENARIOS.some((id) => id === scenarioId))
    throw new Error(`Unknown business-case scenario: ${scenarioId}`);
  const automation = scenarioId === BUSINESS_CASE_SCENARIOS[1];
  const option = (id: string, changes: Partial<BusinessOption> = {}): BusinessOption => ({
    id,
    sourceId: `option-${id}`,
    startYear: 1,
    upfrontYear: 0,
    upfront: { implementation: 0, migration: 0, integration: 0, training: 0, regulatory: 0 },
    license: 0,
    escalation: 0,
    support: 0,
    monitoring: 0,
    retainedLegacyFraction: 0,
    coverage: 1,
    exitCost: 0,
    engineeringMonths: 0,
    foregoneCapitalValue: 0,
    security: 'cleared',
    strategicFit: 'satisfies',
    lockIn: 'none',
    ...changes,
  });
  const statusQuo = option('status-quo', {
    coverage: 0,
    retainedLegacyFraction: 1,
    strategicFit: automation ? 'satisfies' : 'gap',
    lockIn: 'legacy maintenance dependency',
  });
  const options = automation
    ? [
        statusQuo,
        option('full', {
          upfront: {
            implementation: 3_000_000,
            migration: 250_000,
            integration: 400_000,
            training: 400_000,
            regulatory: 150_000,
          },
          license: 600_000,
          escalation: 0.06,
          support: 180_000,
          monitoring: 80_000,
          retainedLegacyFraction: 0.25,
          exitCost: 250_000,
          engineeringMonths: 36,
          foregoneCapitalValue: 500_000,
          security: 'pending',
          lockIn: 'proprietary workflow and export format',
        }),
        option('stage', {
          upfront: {
            implementation: 240_000,
            migration: 40_000,
            integration: 60_000,
            training: 70_000,
            regulatory: 40_000,
          },
          license: 80_000,
          support: 30_000,
          monitoring: 40_000,
          retainedLegacyFraction: 1,
          coverage: 0.1,
          exitCost: 15_000,
          engineeringMonths: 6,
          lockIn: 'reversible; no rollout commitment',
        }),
        option('defer', {
          startYear: 2,
          upfrontYear: 1,
          upfront: {
            implementation: 3_000_000,
            migration: 250_000,
            integration: 400_000,
            training: 400_000,
            regulatory: 150_000,
          },
          license: 600_000,
          escalation: 0.06,
          support: 180_000,
          monitoring: 80_000,
          retainedLegacyFraction: 0.25,
          exitCost: 250_000,
          engineeringMonths: 36,
          security: 'pending',
          lockIn: 'capital preserved now; future rollout remains conditional',
        }),
      ]
    : [
        statusQuo,
        option('build', {
          upfront: {
            implementation: 1_200_000,
            migration: 180_000,
            integration: 200_000,
            training: 80_000,
            regulatory: 40_000,
          },
          support: 280_000,
          monitoring: 30_000,
          exitCost: 120_000,
          engineeringMonths: 72,
          lockIn: 'internal code and scarce maintainer knowledge',
        }),
        option('vendor-a', {
          upfront: {
            implementation: 180_000,
            migration: 160_000,
            integration: 120_000,
            training: 90_000,
            regulatory: 50_000,
          },
          license: 210_000,
          escalation: 0.09,
          support: 80_000,
          monitoring: 30_000,
          exitCost: 220_000,
          engineeringMonths: 14,
          security: 'pending',
          lockIn: 'paid export and annual renewal',
        }),
        option('vendor-b', {
          upfront: {
            implementation: 300_000,
            migration: 100_000,
            integration: 130_000,
            training: 70_000,
            regulatory: 40_000,
          },
          license: 150_000,
          escalation: 0.15,
          support: 70_000,
          monitoring: 25_000,
          exitCost: 300_000,
          engineeringMonths: 10,
          strategicFit: 'gap',
          lockIn: 'workflow customization unavailable',
        }),
        option('hybrid', {
          upfront: {
            implementation: 420_000,
            migration: 100_000,
            integration: 150_000,
            training: 80_000,
            regulatory: 50_000,
          },
          license: 110_000,
          escalation: 0.05,
          support: 140_000,
          monitoring: 35_000,
          retainedLegacyFraction: 0.15,
          exitCost: 100_000,
          engineeringMonths: 24,
          lockIn: 'portable workflow layer; vendor data export still required',
        }),
      ];
  const base: BusinessAssumptions = {
    id: 'base',
    adoption: automation ? [0.62, 0.72, 0.8] : [0.4, 0.65, 0.8],
    demand: [1, 1.1, 1.2],
    implementationMultiplier: 1,
    handlingReduction: 0.18,
    incrementalExceptionRate: 0,
  };
  const sources: BusinessPacket['sources'] = {
    finance: {
      kind: 'synthetic-ledger',
      confidence: 'measured',
      evidence:
        'Baseline system/support cash costs exclude staff payroll. No workforce reduction is planned. Prior legacy spending is irrecoverable.',
    },
    pilot: {
      kind: 'synthetic-observation',
      confidence: 'small-sample',
      evidence:
        '62% pilot task adoption; 18% handling-time reduction. Exception effects unresolved. These observations are not a forecast.',
    },
    forecast: {
      kind: 'synthetic-assumptions',
      confidence: 'uncertain',
      evidence:
        'Cases are conditional trajectories, not probabilities. Demand, implementation and adoption may move together; single-driver stresses also supplied.',
    },
    sponsor: {
      kind: 'synthetic-claim',
      confidence: 'unsupported',
      evidence: automation
        ? '41% ROI assumes immediate 100% adoption and counts released hours as payroll savings.'
        : 'Vendor promises 90% month-one adoption; executive counts hours saved and avoided headcount twice; cites $600k already spent.',
    },
    capacity: {
      kind: 'synthetic-planning',
      confidence: 'estimate',
      evidence:
        'Engineering shadow cost and foregone capital value are resource opportunity costs, not additional cash expenditure. Existing commitments consume remaining capacity.',
    },
    governance: {
      kind: 'synthetic-decision-constraints',
      confidence: 'specified',
      evidence:
        'Expansion requires adoption >=75%, handling reduction >=15%, incremental exception rate <=0.005 and resolved security/strategy/capacity dependencies. Pilot permission does not authorize rollout. Review benefits within 12 months.',
    },
    contractor: {
      kind: 'synthetic-finance-authorization',
      confidence: 'specified',
      evidence: automation
        ? 'No cancelable contractor spend or workforce reduction; all time released remains capacity.'
        : 'At baseline demand and full adoption, $160k annual external contractor spend is avoidable. This amount scales with the stated demand and adoption assumptions and is separate from staff hours.',
    },
  };
  for (const item of options)
    sources[item.sourceId] = {
      kind: 'synthetic-option-estimate',
      confidence: item.id === 'build' ? 'wide-range' : 'estimate',
      evidence: `${item.id}: full lifecycle estimates and constraints supplied in options; scope is not a real supplier quotation.`,
    };
  return {
    scenarioId,
    evidenceKind: 'synthetic-decision-packet',
    currency: 'USD',
    horizonYears: 3,
    discountRate: 0.08,
    baselineAnnualCost: automation ? 900_000 : 600_000,
    annualTasks: automation ? 2_000_000 : 400_000,
    annualHandlingHours: automation ? 300_000 : 90_000,
    approvedContractorAvoidance: automation ? 0 : 160_000,
    exceptionUnitCashCost: 12,
    availableEngineeringMonths: 24,
    engineeringShadowPrice: 12_000,
    legacySunkCost: automation ? 0 : 600_000,
    sources,
    options,
    cases: [
      base,
      {
        ...base,
        id: 'downside',
        adoption: [0.25, 0.4, 0.5],
        demand: [0.7, 0.8, 0.9],
        implementationMultiplier: 1.6,
        handlingReduction: 0.1,
        incrementalExceptionRate: 0.02,
      },
      {
        ...base,
        id: 'upside',
        adoption: [0.65, 0.8, 0.9],
        demand: [1.1, 1.3, 1.5],
        implementationMultiplier: 0.9,
        handlingReduction: 0.22,
        incrementalExceptionRate: -0.002,
      },
      { ...base, id: 'adoption-only', adoption: base.adoption.map((n) => n / 2) },
      { ...base, id: 'implementation-only', implementationMultiplier: 1.75 },
      { ...base, id: 'demand-only', demand: [0.5, 0.6, 0.7] },
      { ...base, id: 'handling-only', handlingReduction: 0.09 },
      { ...base, id: 'exceptions-only', incrementalExceptionRate: 0.02 },
    ],
    expansionGates: [
      {
        id: 'adoption',
        metric: 'adoption',
        operator: 'gte',
        threshold: 0.75,
        observed: 0.62,
        sourceId: 'governance',
      },
      {
        id: 'handling',
        metric: 'handling-reduction',
        operator: 'gte',
        threshold: 0.15,
        observed: 0.18,
        sourceId: 'governance',
      },
      {
        id: 'exceptions',
        metric: 'incremental-exception-rate',
        operator: 'lte',
        threshold: 0.005,
        observed: null,
        sourceId: 'governance',
      },
    ],
  };
}

export interface BusinessEconomicRow {
  optionId: string;
  caseId: string;
  upfrontCash: number;
  annualCosts: number[];
  cashBenefits: number[];
  exceptionCashCosts: number[];
  releasedHours: number[];
  cashFlows: number[];
  cashNPV: number;
  opportunityCostPV: number;
  resourceAdjustedNPV: number;
}

// Evaluator-owned arithmetic. Never materialized in the subject workspace.
function economics(
  p: BusinessPacket,
  o: BusinessOption,
  c: BusinessAssumptions,
): BusinessEconomicRow {
  const upfrontCash = sum(Object.values(o.upfront)) * c.implementationMultiplier;
  const annualCosts: number[] = [],
    cashBenefits: number[] = [],
    exceptionCashCosts: number[] = [],
    releasedHours: number[] = [];
  const cashFlows = [-(o.upfrontYear === 0 ? upfrontCash : 0)];
  for (let year = 1; year <= p.horizonYears; year++) {
    const i = year - 1,
      active = year >= o.startYear;
    const baseline = p.baselineAnnualCost * c.demand[i]!;
    const exposure = active ? c.adoption[i]! * c.demand[i]! * o.coverage : 0;
    const operating = active
      ? baseline * o.retainedLegacyFraction +
        o.license * (1 + o.escalation) ** (year - o.startYear) +
        o.support +
        o.monitoring
      : baseline;
    const benefit = p.approvedContractorAvoidance * exposure;
    const exception =
      p.annualTasks * exposure * c.incrementalExceptionRate * p.exceptionUnitCashCost;
    annualCosts.push(operating);
    cashBenefits.push(benefit);
    exceptionCashCosts.push(exception);
    releasedHours.push(p.annualHandlingHours * exposure * c.handlingReduction);
    cashFlows.push(
      baseline -
        operating +
        benefit -
        exception -
        (year === o.upfrontYear ? upfrontCash : 0) -
        (year === p.horizonYears ? o.exitCost : 0),
    );
  }
  const cashNPV = sum(cashFlows.map((v, t) => v / (1 + p.discountRate) ** t));
  const opportunityCostPV =
    (o.engineeringMonths * p.engineeringShadowPrice + o.foregoneCapitalValue) /
    (1 + p.discountRate) ** o.upfrontYear;
  return {
    optionId: o.id,
    caseId: c.id,
    upfrontCash,
    annualCosts,
    cashBenefits,
    exceptionCashCosts,
    releasedHours,
    cashFlows,
    cashNPV,
    opportunityCostPV,
    resourceAdjustedNPV: cashNPV - opportunityCostPV,
  };
}

function blockedBy(p: BusinessPacket, o: BusinessOption): string[] {
  if (o.id === 'status-quo') return [];
  return [
    ...(o.security !== 'cleared' ? ['security'] : []),
    ...(o.strategicFit !== 'satisfies' ? ['strategy'] : []),
    ...(o.engineeringMonths > p.availableEngineeringMonths ? ['engineering-capacity'] : []),
  ];
}
function gateState(g: BusinessPacket['expansionGates'][number]): string {
  return g.observed === null
    ? 'unknown'
    : (g.operator === 'gte' ? g.observed >= g.threshold : g.observed <= g.threshold)
      ? 'met'
      : 'not-met';
}

const CONTRACT = `# Business-case evaluation contract

Use evidence-packet.json to produce a decision memo (decision.md) and a machine-readable calculation appendix (.kory-eval/business-case.json). This is a synthetic decision task, not a coding task: use any calculation method and memo structure. No external account, vendor contact, purchase, or approval is authorized. The scenario prompt and evidence remain authoritative. Do not modify fixed inputs.

The appendix has schemaVersion:1, evidenceKind:"synthetic-decision-packet", currency:"USD", horizonYears, discountRate, sourceIds (all packet source IDs), excludedClaims:{legacySpend:"sunk",staffTime:"capacity-not-cash",headcount:"duplicate-or-unsupported",sponsorROI:"unverified"}, rows, breakEvenAdoption, constraints, decision, expansionGates and review.

rows contains every option/case combination exactly once, identified by optionId and caseId. Each row has upfrontCash, annualCosts, cashBenefits, exceptionCashCosts, releasedHours, cashFlows, cashNPV, opportunityCostPV, resourceAdjustedNPV. CashFlows includes year zero then years 1..3; other arrays cover years 1..3. Use packet currency and horizon consistently; tolerate cent rounding. Do not put noncash staff capacity, duplicate headcount, sunk costs, or guessed option value into cash benefits.

Reconciliation conventions (specific to this experiment, not mandatory business-case methodology): upfront components are paid at upfrontYear and multiplied by the case implementationMultiplier. Legacy annual cost equals baselineAnnualCost*demand[year-1]. Before startYear, an option retains that entire cost and produces no benefits. From startYear it pays retainedLegacyFraction*legacyCost plus license*(1+escalation)^(year-startYear), support and monitoring. Scope exposure = coverage*adoption[year-1]*demand[year-1]. Cash benefits are finance-authorized contractor avoidance*exposure. Incremental exception cash costs = annualTasks*exposure*incrementalExceptionRate*exceptionUnitCashCost (negative means avoided cash cost). Capacity hours = annualHandlingHours*exposure*handlingReduction. Cash flows are incremental to status quo: legacy cost less option annual cost plus cash benefits less exception costs, upfront payment and terminal exitCost. Terminal exit cost is paid at horizon; no residual value is evidenced. Annual amounts occur at year-end. Discount at the supplied experiment rate, which is not a recommended hurdle rate. Engineering months*shadow price plus foregoneCapitalValue is a separate opportunity cost discounted at upfrontYear; resourceAdjustedNPV subtracts it once from cashNPV, not from cash flows.

breakEvenAdoption has {optionId,rate} for each option: rate is a JSON number or null. Use base-case assumptions but replace every annual adoption with the same rate and solve cashNPV=0 on [0,1]. Preserve enough machine precision for the appendix to reconcile to the supplied model; presentation prose may round separately. Return null when there is no unique root in that interval, including a flat zero-difference comparator with no unique crossing. A mathematical break-even does not establish desirability or approval.

constraints has {optionId,blockedBy,lockInSourceId,lockIn} for every option. blockedBy is always a JSON string array, including [] when there are no blockers. It uses security for pending review, strategy for a fit gap, engineering-capacity for months beyond availability; status quo is the comparison baseline with no new-funding blockers. Cite the option sourceId in lockInSourceId; explain lock-in in your own words. expansionGates preserves every packet gate field and adds status:"met"|"not-met"|"unknown" computed from observed versus threshold; missing evidence cannot pass.

decision has optionId, action:"approve"|"conditional"|"stage"|"defer"|"reject", confidence:"low"|"medium"|"high", fundingNow (upfront authorization only), conditions (dependency/gate IDs), rationale (your reasoning) and alternatives:[{optionId,reason}] for every other option. Multiple defensible recommendations are allowed; maximizing NPV is not mandatory. Approve cannot bypass unresolved option dependencies or expansion gates. Conditional/defer/reject releases no funding now; conditional lists all unresolved dependencies/gates. Stage applies only to the reversible stage option, with its upfront cap and no rollout authorization. Assumed future clearance is not present-day evidence.

review contains ownerRole; monthsAfterDecision as a JSON number array with one or more entries, each within 12 months; metrics as the JSON string array ["adoption","realized-cash","released-hours","cost","exceptions"]; and optionValueCash:null (information value is unpriced, not zero or invented). Explain strategic fit, opportunity cost, lock-in, sensitivity, uncertainty, stop/expand evidence and reconsideration in the memo. Include any alternative methodology separately without replacing the reconciled appendix.

The deterministic scorer independently recomputes amounts, checks traceability and decision constraints, and rejects forged success or modified evidence. It does not grade prose by keyword matching. The memo's reasoning, forecast adequacy, defensibility of a recommendation, and comparative quality still require the scenario's independent blind-semantic judge. Self-tests are not model runs or skill qualification.
`;

const fixedFiles = (p: BusinessPacket) => ({
  'evidence-packet.json': json(p),
  'README.md': CONTRACT,
});

/** Never follow candidate-controlled artifact/ancestor symlinks or read unbounded reports. */
function regularText(root: string, path: string): string | null {
  if (!lstatSync(root).isDirectory()) throw new Error('Workspace is not a regular directory');
  let current = root;
  for (const part of path.split('/')) {
    current = join(current, part);
    let stat;
    try {
      stat = lstatSync(current);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
    if (stat.isSymbolicLink()) throw new Error(`Symlink in ${path}`);
  }
  const stat = lstatSync(current);
  if (!stat.isFile() || stat.size > 512_000)
    throw new Error(`Invalid or oversized artifact ${path}`);
  return readFileSync(current, 'utf8');
}

const record = (v: unknown): Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
const array = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const text = (v: unknown): boolean => typeof v === 'string' && v.trim().length > 0;
function equal(actual: unknown, expected: unknown): boolean {
  if (typeof expected === 'number')
    return (
      typeof actual === 'number' &&
      Number.isFinite(actual) &&
      Math.abs(actual - expected) <= Math.max(0.02, Math.abs(expected) * 1e-9)
    );
  if (Array.isArray(expected))
    return (
      Array.isArray(actual) &&
      actual.length === expected.length &&
      expected.every((v, i) => equal(actual[i], v))
    );
  return isDeepStrictEqual(actual, expected);
}
function exactSet(actual: unknown, expected: string[]): boolean {
  return (
    Array.isArray(actual) &&
    actual.every((v) => typeof v === 'string') &&
    actual.length === expected.length &&
    new Set(actual).size === expected.length &&
    expected.every((v) => actual.includes(v))
  );
}

export function scoreBusinessCase(root: string, scenarioId: string): SkillEvalDeterministicScore {
  const p = businessCasePacket(scenarioId);
  const checks: Array<{ name: string; passed: boolean }> = [];
  const check = (name: string, passed: boolean) => checks.push({ name, passed });
  const failed = (message: string, integrityFailure: boolean): SkillEvalDeterministicScore => ({
    passed: false,
    quality: 0,
    verification: 0,
    integrityFailure,
    evidence: [message],
  });
  let raw: string | null, memo: string | null;
  try {
    for (const [path, expected] of Object.entries(fixedFiles(p)))
      if (regularText(root, path) !== expected)
        return failed(`Fixed input missing or changed: ${path}`, true);
    raw = regularText(root, '.kory-eval/business-case.json');
    memo = regularText(root, 'decision.md');
    // Check the evaluator-owned output target before writing anything.
    regularText(root, '.kory-eval/business-case-evidence.json');
  } catch (error) {
    return failed(String(error), true);
  }
  if (!raw) return failed('Missing business-case appendix; no completion evidence.', false);
  let artifact: Record<string, unknown>;
  try {
    artifact = record(JSON.parse(raw));
  } catch {
    return failed('Malformed calculation appendix.', false);
  }
  check(
    'synthetic identity and consistent appraisal basis',
    artifact.schemaVersion === 1 &&
      artifact.evidenceKind === p.evidenceKind &&
      artifact.currency === p.currency &&
      artifact.horizonYears === p.horizonYears &&
      artifact.discountRate === p.discountRate,
  );
  check(
    'source provenance without invented IDs',
    exactSet(artifact.sourceIds, Object.keys(p.sources)),
  );
  check(
    'sunk, capacity, duplication and unsupported ROI treatment',
    isDeepStrictEqual(artifact.excludedClaims, {
      legacySpend: 'sunk',
      staffTime: 'capacity-not-cash',
      headcount: 'duplicate-or-unsupported',
      sponsorROI: 'unverified',
    }),
  );
  const rows = array(artifact.rows).map(record);
  check(
    'complete unique alternative/scenario matrix',
    rows.length === p.options.length * p.cases.length &&
      new Set(rows.map((r) => `${r.optionId}/${r.caseId}`)).size === rows.length,
  );
  for (const option of p.options)
    for (const assumptions of p.cases) {
      const expected = economics(p, option, assumptions);
      const row = rows.find((r) => r.optionId === option.id && r.caseId === assumptions.id);
      check(
        `economics ${option.id}/${assumptions.id}`,
        !!row && Object.entries(expected).every(([key, value]) => equal(row[key], value)),
      );
    }
  const roots = array(artifact.breakEvenAdoption).map(record);
  check(
    'unique break-even alternative set',
    exactSet(
      roots.map((r) => r.optionId),
      p.options.map((o) => o.id),
    ),
  );
  for (const o of p.options) {
    const base = p.cases[0]!;
    const low = economics(p, o, { ...base, adoption: [0, 0, 0] }).cashNPV;
    const high = economics(p, o, { ...base, adoption: [1, 1, 1] }).cashNPV;
    const crossing = Math.abs(high - low) > 1e-9 ? -low / (high - low) : NaN;
    const expected = Number.isFinite(crossing) && crossing >= 0 && crossing <= 1 ? crossing : null;
    const actual = roots.find((r) => r.optionId === o.id)?.rate;
    check(
      `bounded break-even ${o.id}`,
      expected === null
        ? actual === null
        : typeof actual === 'number' &&
            Number.isFinite(actual) &&
            actual >= 0 &&
            actual <= 1 &&
            Math.abs(actual - expected) < 1e-6,
    );
  }
  const constraints = array(artifact.constraints).map(record);
  check(
    'unique constraint alternative set',
    exactSet(
      constraints.map((c) => c.optionId),
      p.options.map((o) => o.id),
    ),
  );
  for (const o of p.options) {
    const actual = constraints.find((c) => c.optionId === o.id);
    check(
      `dependencies and lock-in ${o.id}`,
      !!actual &&
        exactSet(actual.blockedBy, blockedBy(p, o)) &&
        actual.lockInSourceId === o.sourceId &&
        text(actual.lockIn),
    );
  }
  const gates = array(artifact.expansionGates).map(record);
  check(
    'complete gate set',
    exactSet(
      gates.map((g) => g.id),
      p.expansionGates.map((g) => g.id),
    ),
  );
  for (const g of p.expansionGates) {
    const actual = gates.find((a) => a.id === g.id);
    check(
      `evidence-based gate ${g.id}`,
      !!actual &&
        Object.entries(g).every(([k, v]) => isDeepStrictEqual(actual[k], v)) &&
        actual.status === gateState(g),
    );
  }
  const d = record(artifact.decision),
    chosen = p.options.find((o) => o.id === d.optionId);
  const other = array(d.alternatives).map(record);
  check(
    'recommendation and alternative reasons present for blind review',
    !!chosen &&
      text(d.rationale) &&
      ['low', 'medium', 'high'].includes(String(d.confidence)) &&
      exactSet(
        other.map((o) => o.optionId),
        p.options.filter((o) => o.id !== chosen?.id).map((o) => o.id),
      ) &&
      other.every((o) => text(o.reason)),
  );
  const unresolved = chosen
    ? [
        ...blockedBy(p, chosen),
        ...(chosen.id === 'status-quo' || chosen.id === 'stage'
          ? []
          : p.expansionGates.filter((g) => gateState(g) !== 'met').map((g) => g.id)),
      ]
    : [];
  const conditions = array(d.conditions);
  const funding = d.fundingNow;
  const cap = chosen?.upfrontYear === 0 ? sum(Object.values(chosen.upfront)) : 0;
  const knownConditions = new Set([
    'security',
    'strategy',
    'engineering-capacity',
    ...p.expansionGates.map((g) => g.id),
  ]);
  const boundedFunding =
    typeof funding === 'number' && Number.isFinite(funding) && funding >= 0 && funding <= cap;
  const actionValid =
    d.action === 'approve'
      ? unresolved.length === 0
      : d.action === 'conditional'
        ? funding === 0 && unresolved.every((g) => conditions.includes(g))
        : d.action === 'stage'
          ? chosen?.id === 'stage' && unresolved.length === 0
          : ['defer', 'reject'].includes(String(d.action)) && funding === 0;
  check(
    'funding respects unresolved evidence and scope',
    !!chosen &&
      boundedFunding &&
      actionValid &&
      Array.isArray(d.conditions) &&
      conditions.every((g) => typeof g === 'string' && knownConditions.has(g)),
  );
  const review = record(artifact.review);
  check(
    'bounded benefits review and unpriced information value',
    text(review.ownerRole) &&
      array(review.monthsAfterDecision).length > 0 &&
      array(review.monthsAfterDecision).every(
        (v) => typeof v === 'number' && Number.isFinite(v) && v > 0 && v <= 12,
      ) &&
      exactSet(review.metrics, [
        'adoption',
        'realized-cash',
        'released-hours',
        'cost',
        'exceptions',
      ]) &&
      review.optionValueCash === null,
  );
  check('decision memo exists for independent semantic evaluation', !!memo?.trim());
  const passed = checks.every((c) => c.passed);
  const evidence = {
    evidenceKind: p.evidenceKind,
    scenarioId,
    packetSha256: createHash('sha256').update(json(p)).digest('hex'),
    appendixSha256: createHash('sha256').update(raw).digest('hex'),
    memoSha256: memo ? createHash('sha256').update(memo).digest('hex') : null,
    checks,
    deterministicPassed: passed,
    blindSemanticStatus: 'not-run',
    liveModelUplift: 'not-established',
    limits:
      'Authored synthetic packet and bounded deterministic reconciliation; memo quality, real forecasts, independent blind judging and paired skill uplift are not established.',
  };
  writeFixtureFile(root, '.kory-eval/business-case-evidence.json', json(evidence));
  return {
    passed,
    quality: checks.filter((c) => c.passed).length / checks.length,
    verification: passed ? 1 : 0,
    integrityFailure: false,
    evidence: [...checks.map((c) => `${c.name}: ${c.passed ? 'pass' : 'fail'}`), evidence.limits],
  };
}

export const BUSINESS_CASE_SKILL_EVAL_MATERIALIZERS: readonly SkillEvalFixtureMaterializer[] =
  BUSINESS_CASE_SCENARIOS.map((scenarioId) => ({
    id: `${scenarioId}/evidence-packet@2`,
    matches: (scenario) => scenario.id === scenarioId,
    materialize: (root) => {
      for (const [path, contents] of Object.entries(fixedFiles(businessCasePacket(scenarioId))))
        writeFixtureFile(root, path, contents);
    },
  }));
export const BUSINESS_CASE_SKILL_EVAL_SCORERS: readonly SkillEvalDeterministicScorer[] =
  BUSINESS_CASE_SCENARIOS.map((scenarioId) => ({
    id: `${scenarioId}/reconciliation-scorer@2`,
    scenarioIds: [scenarioId],
    score: ({ workingDirectory }) => scoreBusinessCase(workingDirectory, scenarioId),
  }));
