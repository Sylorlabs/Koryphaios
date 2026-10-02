import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  BUSINESS_CASE_SCENARIOS,
  BUSINESS_CASE_SKILL_EVAL_MATERIALIZERS,
  businessCasePacket,
  scoreBusinessCase,
  type BusinessAssumptions,
  type BusinessOption,
  type BusinessPacket,
} from '../skill-eval-business-case-fixtures';
import {
  BUILTIN_SKILL_EVAL_MATERIALIZERS,
  BUILTIN_SKILL_EVAL_SCORERS,
} from '../skill-eval-fixtures';
import { auditSkillEvalExecutionReadiness } from '../skill-eval-execution';
import { loadV5SkillPackages } from '../skill-packages';
import type { SkillEvalScenarioV3 } from '../skill-eval-harness';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const temporary = () => {
  const root = mkdtempSync(join(tmpdir(), 'kory-business-control-'));
  roots.push(root);
  return root;
};

// Independently arranged author-owned spreadsheet-style calculations. The scorer's oracle
// is not imported, and none of these controls is materialized for evaluation subjects.
function controlRow(p: BusinessPacket, o: BusinessOption, c: BusinessAssumptions) {
  const annualCosts = [1, 2, 3].map((year) =>
    year < o.startYear
      ? p.baselineAnnualCost * c.demand[year - 1]!
      : p.baselineAnnualCost * c.demand[year - 1]! * o.retainedLegacyFraction +
        o.license * (1 + o.escalation) ** (year - o.startYear) +
        o.support +
        o.monitoring,
  );
  const exposure = c.adoption.map((adoption, i) =>
    i + 1 < o.startYear ? 0 : adoption * c.demand[i]! * o.coverage,
  );
  const cashBenefits = exposure.map((e) => p.approvedContractorAvoidance * e);
  const exceptionCashCosts = exposure.map(
    (e) => p.annualTasks * e * c.incrementalExceptionRate * p.exceptionUnitCashCost,
  );
  const releasedHours = exposure.map((e) => e * p.annualHandlingHours * c.handlingReduction);
  const upfrontCash =
    Object.values(o.upfront).reduce((a, b) => a + b, 0) * c.implementationMultiplier;
  const cashFlows = [0, 1, 2, 3].map(
    (year) =>
      (year > 0
        ? p.baselineAnnualCost * c.demand[year - 1]! -
          annualCosts[year - 1]! +
          cashBenefits[year - 1]! -
          exceptionCashCosts[year - 1]!
        : 0) -
      (year === o.upfrontYear ? upfrontCash : 0) -
      (year === 3 ? o.exitCost : 0),
  );
  const cashNPV = cashFlows.reduce(
    (total, value, year) => total + value / (1 + p.discountRate) ** year,
    0,
  );
  const opportunityCostPV =
    (o.foregoneCapitalValue + o.engineeringMonths * p.engineeringShadowPrice) /
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
function dependencies(p: BusinessPacket, o: BusinessOption) {
  if (o.id === 'status-quo') return [];
  const result: string[] = [];
  if (o.security === 'pending') result.push('security');
  if (o.strategicFit === 'gap') result.push('strategy');
  if (o.engineeringMonths > p.availableEngineeringMonths) result.push('engineering-capacity');
  return result;
}
function controlArtifact(p: BusinessPacket) {
  const chosen = p.options.find((o) => o.id === 'stage' || o.id === 'hybrid')!;
  const expansionGates = p.expansionGates.map((g) => ({
    ...g,
    status:
      g.observed === null
        ? 'unknown'
        : (g.operator === 'gte' ? g.observed >= g.threshold : g.observed <= g.threshold)
          ? 'met'
          : 'not-met',
  }));
  return {
    schemaVersion: 1,
    evidenceKind: p.evidenceKind,
    currency: p.currency,
    horizonYears: p.horizonYears,
    discountRate: p.discountRate,
    sourceIds: Object.keys(p.sources),
    excludedClaims: {
      legacySpend: 'sunk',
      staffTime: 'capacity-not-cash',
      headcount: 'duplicate-or-unsupported',
      sponsorROI: 'unverified',
    },
    rows: p.options.flatMap((o) => p.cases.map((c) => controlRow(p, o, c))),
    breakEvenAdoption: p.options.map((o) => {
      // Bisection rather than the scorer's analytic interpolation.
      const value = (rate: number) =>
        controlRow(p, o, { ...p.cases[0]!, adoption: [rate, rate, rate] }).cashNPV;
      let low = 0,
        high = 1;
      if (value(low) === value(high) || value(low) * value(high) > 0)
        return { optionId: o.id, rate: null as number | null };
      for (let i = 0; i < 60; i++) {
        const middle = (low + high) / 2;
        if (value(middle) >= 0 === value(low) >= 0) low = middle;
        else high = middle;
      }
      return { optionId: o.id, rate: ((low + high) / 2) as number | null };
    }),
    constraints: p.options.map((o) => ({
      optionId: o.id,
      blockedBy: dependencies(p, o),
      lockInSourceId: o.sourceId,
      lockIn: o.lockIn,
    })),
    expansionGates,
    decision: {
      optionId: chosen.id,
      action: chosen.id === 'stage' ? 'stage' : 'conditional',
      confidence: 'medium',
      fundingNow: chosen.id === 'stage' ? 450_000 : 0,
      conditions:
        chosen.id === 'stage'
          ? []
          : [
              ...dependencies(p, chosen),
              ...expansionGates.filter((g) => g.status !== 'met').map((g) => g.id),
            ],
      rationale:
        chosen.id === 'stage'
          ? 'Authorize only the reversible pilot to resolve adoption and exception uncertainty; do not pre-authorize rollout.'
          : 'Preserve a portable workflow boundary without promising immediate funding before evidence gates clear.',
      alternatives: p.options
        .filter((o) => o.id !== chosen.id)
        .map((o) => ({
          optionId: o.id,
          reason: `${o.id} remains a comparator: its cost, delivery capacity and reversibility differ; the memo must justify the tradeoff.`,
        })),
    },
    review: {
      ownerRole: 'Finance and operations',
      monthsAfterDecision: [3, 6, 12],
      metrics: ['adoption', 'realized-cash', 'released-hours', 'cost', 'exceptions'],
      optionValueCash: null as number | null,
    },
  };
}
type Artifact = ReturnType<typeof controlArtifact>;
async function fixture(id: string) {
  const root = temporary();
  const task = loadV5SkillPackages()
    .packages.find((p) => p.sidecar.name === 'business-case-analysis')!
    .evaluation.tasks.find((t) => t.id === id)!;
  const scenario = {
    ...task,
    skill: 'business-case-analysis',
    category: 'full-task',
    expectedSelection: true,
    expectedSkills: [],
    forbiddenSkills: [],
    heldOut: true,
    adjacentSkills: [],
    tags: [],
  } as SkillEvalScenarioV3;
  const m = BUSINESS_CASE_SKILL_EVAL_MATERIALIZERS.find((candidate) =>
    candidate.matches(scenario),
  )!;
  await m.materialize(root, scenario);
  return { root, scenario, packet: businessCasePacket(id) };
}
function save(root: string, artifact: unknown) {
  mkdirSync(join(root, '.kory-eval'), { recursive: true });
  writeFileSync(join(root, '.kory-eval/business-case.json'), JSON.stringify(artifact));
  writeFileSync(
    join(root, 'decision.md'),
    'Synthetic evaluator control, not an independent business recommendation.\n\nCompare the full appendix, retain unknown exception effects, and release only scoped funding after the relevant gates. Staff hours are capacity; contractor cash avoidance has a separate source. The pilot buys information, not assured savings. Review adoption, actual costs and exception outcomes with finance and operations.',
  );
}

describe('business-case evidence and arithmetic evaluator', () => {
  for (const id of BUSINESS_CASE_SCENARIOS) {
    test(`${id}: red start and independent calculation control`, async () => {
      const { root, scenario, packet } = await fixture(id);
      expect(BUILTIN_SKILL_EVAL_MATERIALIZERS.filter((m) => m.matches(scenario))).toHaveLength(1);
      expect(BUILTIN_SKILL_EVAL_SCORERS.filter((s) => s.scenarioIds.includes(id))).toHaveLength(1);
      expect(scoreBusinessCase(root, id).passed).toBe(false);
      save(root, controlArtifact(packet));
      const result = scoreBusinessCase(root, id);
      expect(result.passed, result.evidence.join('\n')).toBe(true);
      expect(result.integrityFailure).toBe(false);
      const evidence = JSON.parse(
        readFileSync(join(root, '.kory-eval/business-case-evidence.json'), 'utf8'),
      );
      expect(evidence.blindSemanticStatus).toBe('not-run');
      expect(evidence.liveModelUplift).toBe('not-established');
      expect(evidence.packetSha256).toHaveLength(64);
    });
    test(`${id}: reordered appendix and different recommendation are accepted`, async () => {
      const { root, packet } = await fixture(id);
      const a = controlArtifact(packet);
      a.rows.reverse();
      a.sourceIds.reverse();
      a.constraints.reverse();
      a.breakEvenAdoption.reverse();
      a.constraints.forEach((c) => {
        c.lockIn = `Assess the exit and ownership obligations documented by ${c.lockInSourceId}.`;
      });
      a.decision = {
        ...a.decision,
        optionId: 'status-quo',
        action: 'defer',
        fundingNow: 0,
        conditions: [],
        rationale:
          'Preserve capital while obtaining missing evidence; accept the documented cost of delay.',
        alternatives: packet.options
          .filter((o) => o.id !== 'status-quo')
          .map((o) => ({
            optionId: o.id,
            reason: 'Not funded now; revisit after uncertainty narrows.',
          })),
      };
      save(root, a);
      expect(scoreBusinessCase(root, id).passed).toBe(true);
    });
  }
  test('hand-calculated anchors protect time, escalation, capacity and exit conventions', () => {
    const platform = controlArtifact(businessCasePacket(BUSINESS_CASE_SCENARIOS[0]));
    const hybrid = platform.rows.find((r) => r.optionId === 'hybrid' && r.caseId === 'base')!;
    for (const [i, value] of [-800_000, 289_000, 384_900, 369_325].entries())
      expect(hybrid.cashFlows[i]!).toBeCloseTo(value, 6);
    expect(hybrid.annualCosts[2]!).toBeCloseTo(404_275, 6);
    expect(hybrid.opportunityCostPV).toBe(288_000);
    const automation = controlArtifact(businessCasePacket(BUSINESS_CASE_SCENARIOS[1]));
    const full = automation.rows.find((r) => r.optionId === 'full' && r.caseId === 'base')!;
    expect(full.upfrontCash).toBe(4_200_000);
    expect(full.cashBenefits).toEqual([0, 0, 0]);
    expect(full.releasedHours[0]!).toBeCloseTo(33_480, 6);
    expect(full.cashFlows[1]!).toBeCloseTo(-185_000, 6);
    const stage = automation.rows.find((r) => r.optionId === 'stage' && r.caseId === 'base')!;
    for (const [i, value] of [-450_000, -150_000, -150_000, -165_000].entries())
      expect(stage.cashFlows[i]!).toBeCloseTo(value, 6);
  });

  const mutants: Array<[string, (a: Artifact) => void]> = [
    [
      'sunk cost smuggled into the future',
      (a) => {
        a.rows[1]!.cashFlows[0]! -= 600_000;
      },
    ],
    [
      'staff capacity counted as cash',
      (a) => {
        const r = a.rows.find((r) => r.optionId !== 'status-quo')!;
        r.cashBenefits[0]! += r.releasedHours[0]! * 60;
      },
    ],
    [
      'duplicate alternatives hide a missing case',
      (a) => {
        a.rows[1] = a.rows[0]!;
      },
    ],
    [
      'one scenario reused for every sensitivity',
      (a) => {
        const r = a.rows.find((r) => r.optionId !== 'status-quo' && r.caseId === 'downside')!;
        r.cashNPV = a.rows.find((x) => x.optionId === r.optionId && x.caseId === 'base')!.cashNPV;
      },
    ],
    [
      'opportunity cost silently removed',
      (a) => {
        a.rows.find((r) => r.opportunityCostPV > 0)!.opportunityCostPV = 0;
      },
    ],
    [
      'exit cost ignored',
      (a) => {
        a.rows.find((r) => r.optionId !== 'status-quo')!.cashFlows[3]! += 10_000;
      },
    ],
    [
      'unknown regulatory evidence treated as approval',
      (a) => {
        a.decision.action = 'approve';
        a.decision.conditions = [];
      },
    ],
    [
      'unknown exception evidence marked met',
      (a) => {
        a.expansionGates.find((g) => g.id === 'exceptions')!.status = 'met';
      },
    ],
    [
      'fabricated evidence citation',
      (a) => {
        a.sourceIds[0] = 'invented-audit';
      },
    ],
    [
      'unpriced information assigned cash value',
      (a) => {
        a.review.optionValueCash = 300_000;
      },
    ],
    [
      'inconsistent horizon',
      (a) => {
        a.horizonYears = 5;
      },
    ],
    [
      'unbounded benefits review',
      (a) => {
        a.review.monthsAfterDecision = [36];
      },
    ],
    [
      'conditional funding released early',
      (a) => {
        a.decision.fundingNow = 1;
      },
    ],
    [
      'unresolved gate omitted',
      (a) => {
        a.decision.conditions = [];
      },
    ],
    [
      'impossible break-even rate',
      (a) => {
        a.breakEvenAdoption.find((r) => r.optionId === 'hybrid')!.rate = 1.1;
      },
    ],
  ];
  for (const [name, mutate] of mutants)
    test(`rejects ${name}`, async () => {
      const id = BUSINESS_CASE_SCENARIOS[0],
        { root, packet } = await fixture(id);
      const a = controlArtifact(packet);
      mutate(a);
      save(root, a);
      const result = scoreBusinessCase(root, id);
      expect(result.passed, name).toBe(false);
      expect(result.verification).toBe(0);
    });
  test('a pilot cannot authorize the full program or exceed its cap', async () => {
    const id = BUSINESS_CASE_SCENARIOS[1],
      { root, packet } = await fixture(id);
    const a = controlArtifact(packet);
    a.decision.fundingNow = 4_200_000;
    save(root, a);
    expect(scoreBusinessCase(root, id).passed).toBe(false);
    a.decision.fundingNow = 450_000;
    a.decision.optionId = 'full';
    save(root, a);
    expect(scoreBusinessCase(root, id).passed).toBe(false);
  });
  test('self-attested success, invalid JSON and absent memo cannot pass', async () => {
    const id = BUSINESS_CASE_SCENARIOS[0],
      { root, packet } = await fixture(id);
    save(root, { passed: true, quality: 1, verification: 1 });
    expect(scoreBusinessCase(root, id).passed).toBe(false);
    writeFileSync(join(root, '.kory-eval/business-case.json'), '{broken');
    expect(scoreBusinessCase(root, id).passed).toBe(false);
    save(root, controlArtifact(packet));
    rmSync(join(root, 'decision.md'));
    expect(scoreBusinessCase(root, id).passed).toBe(false);
  });
  test('changed fixed inputs and artifact ancestor symlinks fail without overwriting targets', async () => {
    const id = BUSINESS_CASE_SCENARIOS[0];
    const changed = await fixture(id);
    save(changed.root, controlArtifact(changed.packet));
    writeFileSync(join(changed.root, 'evidence-packet.json'), '{}');
    expect(scoreBusinessCase(changed.root, id).integrityFailure).toBe(true);
    const linked = await fixture(id),
      target = temporary();
    writeFileSync(join(target, 'business-case-evidence.json'), 'preserve');
    symlinkSync(target, join(linked.root, '.kory-eval'));
    expect(scoreBusinessCase(linked.root, id).integrityFailure).toBe(true);
    expect(readFileSync(join(target, 'business-case-evidence.json'), 'utf8')).toBe('preserve');
    const report = await fixture(id);
    save(report.root, controlArtifact(report.packet));
    symlinkSync(
      join(target, 'business-case-evidence.json'),
      join(report.root, '.kory-eval/business-case-evidence.json'),
    );
    expect(scoreBusinessCase(report.root, id).integrityFailure).toBe(true);
    expect(readFileSync(join(target, 'business-case-evidence.json'), 'utf8')).toBe('preserve');
  });
  test('oversized artifacts fail closed before parsing', async () => {
    const id = BUSINESS_CASE_SCENARIOS[0],
      { root, packet } = await fixture(id);
    save(root, controlArtifact(packet));
    writeFileSync(join(root, '.kory-eval/business-case.json'), ' '.repeat(512_001));
    expect(scoreBusinessCase(root, id).integrityFailure).toBe(true);
  });
  test('both synthetic full-task packets are runnable but carry no qualification claim', () => {
    const p = loadV5SkillPackages().packages.filter(
      (p) => p.sidecar.name === 'business-case-analysis',
    );
    const rows = auditSkillEvalExecutionReadiness(
      p,
      BUILTIN_SKILL_EVAL_MATERIALIZERS,
      BUILTIN_SKILL_EVAL_SCORERS,
    );
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.ready)).toBe(true);
  });
});
