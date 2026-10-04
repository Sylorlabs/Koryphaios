import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SkillPromotionGate } from '../skill-evaluations';
import {
  BUNDLED_SKILL_DEFINITIONS,
  V5_SKILL_PACKAGE_CATALOG,
  auditBundledSkillDefinitions,
} from '../skills';
import {
  getV5AuditLedgerPath,
  loadV5AuditLedger,
  reconcileV5AuditLedgerFromEvaluations,
  syncV5AuditLedger,
  updateV5AuditFromEvaluation,
} from '../skill-v5-audit';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const readyGate = (): SkillPromotionGate => ({
  status: 'ready',
  candidateRuns: 18,
  baselineRuns: 18,
  distinctHarnesses: 1,
  distinctProviders: 1,
  distinctModels: 1,
  humanBlindReviews: 0,
  provenancedBlindReviews: 2,
  passRate: 1,
  quality: 0.95,
  verification: 0.95,
  baselineDelta: null,
  pairedBaselineCases: 18,
  pairedBaselineCategories: ['positive', 'negative', 'ambiguous', 'adversarial', 'full-task'],
  pairedBaselineCategoryCounts: {
    positive: 5,
    negative: 5,
    ambiguous: 3,
    adversarial: 3,
    'full-task': 2,
    regression: 0,
  },
  skillBaselinePassRateDelta: 0.2,
  skillBaselineQualityDelta: 0.15,
  skillBaselineVerificationDelta: 0.1,
  routingObservations: 16,
  routingPrecision: 1,
  routingRecall: 1,
  infrastructureFailures: 0,
  regressionCases: 0,
  openRegressions: 0,
  categoryCoverage: {
    positive: 5,
    negative: 5,
    ambiguous: 3,
    adversarial: 3,
    'full-task': 2,
    regression: 0,
  },
  reasons: [],
});

describe('V5 skill audit ledger', () => {
  test('initializes all 182 stable skills and marks migrated packages as candidates', () => {
    const root = mkdtempSync(join(tmpdir(), 'kory-v5-audit-'));
    roots.push(root);
    const definitionAudit = auditBundledSkillDefinitions();
    const ledger = syncV5AuditLedger(
      root,
      BUNDLED_SKILL_DEFINITIONS,
      V5_SKILL_PACKAGE_CATALOG.packages,
      {
        baseCount: definitionAudit.baseCount,
        professionalCount: definitionAudit.professionalCount,
        now: new Date('2026-09-01T12:00:00Z'),
      },
    );
    expect(ledger.librarySize).toBe(182);
    expect(ledger.records).toHaveLength(182);
    expect(ledger.records.filter((record) => record.cohort === 'base')).toHaveLength(35);
    expect(ledger.records.filter((record) => record.cohort === 'professional')).toHaveLength(47);
    expect(ledger.records.filter((record) => record.cohort === 'specialist-v4')).toHaveLength(100);
    for (const skillPackage of V5_SKILL_PACKAGE_CATALOG.packages) {
      expect(
        ledger.records.find((record) => record.skill === skillPackage.sidecar.name),
      ).toMatchObject({
        packageVersion: skillPackage.sidecar.version,
        v5Status: 'candidate',
      });
    }
    const migrated = ledger.records.find(
      (record) => record.skill === 'skill-authoring-evaluation',
    )!;
    expect(migrated).toMatchObject({
      v5Status: 'candidate',
      freshness: 'fresh',
      packageVersion: '5.2.6',
      routing: { positive: 5, negative: 5, ambiguous: 3, adversarial: 3 },
    });
    expect(migrated.steward).toBe('ChatGPT web — skill-authoring-evaluation');
    const routing = ledger.records.find((record) => record.skill === 'task-routing')!;
    expect(routing).toMatchObject({
      v5Status: 'candidate',
      freshness: 'fresh',
      packageVersion: '5.1.0',
      routing: { positive: 5, negative: 5, ambiguous: 3, adversarial: 3 },
    });
    expect(routing.steward).toBe('ChatGPT web — task-routing');
    const repositoryDiscovery = ledger.records.find(
      (record) => record.skill === 'repository-environment-discovery',
    )!;
    expect(repositoryDiscovery).toMatchObject({
      v5Status: 'candidate',
      freshness: 'fresh',
      packageVersion: '5.0.0',
      routing: { positive: 5, negative: 5, ambiguous: 3, adversarial: 3 },
    });
    expect(repositoryDiscovery.steward).toBe('ChatGPT web — repository-environment-discovery');
    const planMode = ledger.records.find((record) => record.skill === 'plan-mode')!;
    expect(planMode).toMatchObject({
      v5Status: 'candidate',
      freshness: 'fresh',
      packageVersion: '5.1.0',
      routing: { positive: 5, negative: 5, ambiguous: 3, adversarial: 3 },
    });
    expect(planMode.steward).toBe('ChatGPT web — plan-mode');
    const humanExperience = ledger.records.find((record) => record.skill === 'human-experience')!;
    expect(humanExperience).toMatchObject({
      v5Status: 'candidate',
      freshness: 'fresh',
      packageVersion: '5.0.0',
      routing: { positive: 5, negative: 5, ambiguous: 3, adversarial: 3 },
    });
    expect(humanExperience.steward).toBe('ChatGPT web — human-experience');
    const userResearch = ledger.records.find((record) => record.skill === 'user-research')!;
    expect(userResearch).toMatchObject({
      v5Status: 'candidate',
      freshness: 'fresh',
      packageVersion: '5.0.0',
      routing: { positive: 5, negative: 5, ambiguous: 3, adversarial: 3 },
    });
    expect(userResearch.steward).toBe('ChatGPT web — user-research');
    const interactionDesign = ledger.records.find(
      (record) => record.skill === 'interaction-design',
    )!;
    expect(interactionDesign).toMatchObject({
      v5Status: 'candidate',
      freshness: 'fresh',
      packageVersion: '5.0.0',
      routing: { positive: 5, negative: 5, ambiguous: 3, adversarial: 3 },
    });
    expect(interactionDesign.steward).toBe('ChatGPT web — interaction-design');
    const informationArchitecture = ledger.records.find(
      (record) => record.skill === 'information-architecture',
    )!;
    expect(informationArchitecture).toMatchObject({
      v5Status: 'candidate',
      freshness: 'fresh',
      packageVersion: '5.0.1',
      routing: { positive: 5, negative: 5, ambiguous: 3, adversarial: 3 },
    });
    expect(informationArchitecture.steward).toBe('ChatGPT web — information-architecture');
    const visualInterfaceDesign = ledger.records.find(
      (record) => record.skill === 'visual-interface-design',
    )!;
    expect(visualInterfaceDesign).toMatchObject({
      v5Status: 'candidate',
      freshness: 'fresh',
      packageVersion: '5.0.0',
      routing: { positive: 5, negative: 5, ambiguous: 3, adversarial: 3 },
    });
    expect(visualInterfaceDesign.steward).toBe('ChatGPT web — visual-interface-design');
    const contentErrorDesign = ledger.records.find(
      (record) => record.skill === 'content-error-design',
    )!;
    expect(contentErrorDesign).toMatchObject({
      v5Status: 'candidate',
      freshness: 'fresh',
      packageVersion: '5.0.0',
      routing: { positive: 5, negative: 5, ambiguous: 3, adversarial: 3 },
    });
    expect(contentErrorDesign.steward).toBe('ChatGPT web — content-error-design');
    const accessibilityPractice = ledger.records.find(
      (record) => record.skill === 'accessibility-practice',
    )!;
    expect(accessibilityPractice).toMatchObject({
      v5Status: 'candidate',
      freshness: 'fresh',
      packageVersion: '5.0.0',
      routing: { positive: 5, negative: 5, ambiguous: 3, adversarial: 3 },
    });
    expect(accessibilityPractice.steward).toBe('ChatGPT web — accessibility-practice');
    const usabilityEvaluation = ledger.records.find(
      (record) => record.skill === 'usability-evaluation',
    )!;
    expect(usabilityEvaluation).toMatchObject({
      v5Status: 'candidate',
      freshness: 'fresh',
      packageVersion: '5.0.0',
      routing: { positive: 5, negative: 5, ambiguous: 3, adversarial: 3 },
    });
    expect(usabilityEvaluation.steward).toBe('ChatGPT web — usability-evaluation');
    const developerExperience = ledger.records.find(
      (record) => record.skill === 'developer-experience',
    )!;
    expect(developerExperience).toMatchObject({
      v5Status: 'candidate',
      freshness: 'fresh',
      packageVersion: '5.0.0',
      routing: { positive: 5, negative: 5, ambiguous: 3, adversarial: 3 },
    });
    expect(developerExperience.steward).toBe('ChatGPT web — developer-experience');
    const frontendEngineering = ledger.records.find(
      (record) => record.skill === 'frontend-engineering',
    )!;
    expect(frontendEngineering).toMatchObject({
      v5Status: 'candidate',
      freshness: 'fresh',
      packageVersion: '5.0.0',
      routing: { positive: 5, negative: 5, ambiguous: 3, adversarial: 3 },
    });
    expect(frontendEngineering.steward).toBe('ChatGPT web — frontend-engineering');
    const webInterface = ledger.records.find((record) => record.skill === 'web-interface')!;
    expect(webInterface).toMatchObject({
      v5Status: 'candidate',
      freshness: 'fresh',
      packageVersion: '5.0.0',
      routing: { positive: 5, negative: 5, ambiguous: 3, adversarial: 3 },
    });
    expect(webInterface.steward).toBe('ChatGPT web — web-interface');
    const nativeInterface = ledger.records.find((record) => record.skill === 'native-interface')!;
    expect(nativeInterface).toMatchObject({
      v5Status: 'candidate',
      freshness: 'fresh',
      packageVersion: '5.0.0',
      routing: { positive: 5, negative: 5, ambiguous: 3, adversarial: 3 },
      taskMaturity: { individual: 2, scaffold: 0 },
    });
    expect(nativeInterface.steward).toBe('ChatGPT web — native-interface');
    const typescriptJavascript = ledger.records.find(
      (record) => record.skill === 'typescript-javascript-engineering',
    )!;
    expect(typescriptJavascript).toMatchObject({
      taskMaturity: { individual: 2, scaffold: 0 },
      nextAction: 'run held-out routing and paired full-task V5 evaluation suite',
    });
    expect(ledger.records.filter((record) => record.v5Status === 'candidate')).toHaveLength(182);
    // Bundled skills appear as package candidates once a skills-v5 package
    // exists. Records stay 'unreviewed' when there is no package to qualify:
    // user-scoped personal skills are seeded into the personal library rather
    // than the bundled catalog. Every bundled skill with a V5 package is at
    // least a package candidate.
    expect(
      ledger.records
        .filter((record) => record.v5Status === 'unreviewed')
        .map((record) => record.skill)
        .sort(),
    ).toEqual([]);

    const firstSerialized = readFileSync(getV5AuditLedgerPath(root), 'utf8');
    syncV5AuditLedger(root, BUNDLED_SKILL_DEFINITIONS, V5_SKILL_PACKAGE_CATALOG.packages, {
      baseCount: definitionAudit.baseCount,
      professionalCount: definitionAudit.professionalCount,
      now: new Date('2026-09-02T12:00:00Z'),
    });
    expect(readFileSync(getV5AuditLedgerPath(root), 'utf8')).toBe(firstSerialized);
  });

  test('promotes audit status only when evaluation is ready and sources are fresh', () => {
    const root = mkdtempSync(join(tmpdir(), 'kory-v5-audit-'));
    roots.push(root);
    const definitionAudit = auditBundledSkillDefinitions();
    syncV5AuditLedger(root, BUNDLED_SKILL_DEFINITIONS, V5_SKILL_PACKAGE_CATALOG.packages, {
      baseCount: definitionAudit.baseCount,
      professionalCount: definitionAudit.professionalCount,
      now: new Date('2026-09-01T12:00:00Z'),
    });
    const updated = updateV5AuditFromEvaluation(
      root,
      'skill-authoring-evaluation',
      readyGate(),
      new Date('2026-09-01T12:01:00Z'),
    );
    expect(updated.v5Status).toBe('qualified');
    expect(updated.fullTaskEvals).toBe(2);
    expect(updated.uplift?.qualityDelta).toBe(0.15);
    expect(updated.nextAction).toContain('monitor regressions');
  });

  test('atomically reconciles persisted status from current promotion gates', () => {
    const root = mkdtempSync(join(tmpdir(), 'kory-v5-audit-'));
    roots.push(root);
    const definitionAudit = auditBundledSkillDefinitions();
    syncV5AuditLedger(root, BUNDLED_SKILL_DEFINITIONS, V5_SKILL_PACKAGE_CATALOG.packages, {
      baseCount: definitionAudit.baseCount,
      professionalCount: definitionAudit.professionalCount,
      now: new Date('2026-09-01T12:00:00Z'),
    });
    const blockedGate: SkillPromotionGate = {
      ...readyGate(),
      status: 'blocked',
      openRegressions: 1,
      reasons: ['current regression remains open'],
    };
    const insufficientGate: SkillPromotionGate = {
      ...readyGate(),
      status: 'insufficient-evidence',
      categoryCoverage: { ...readyGate().categoryCoverage, 'full-task': 0 },
      pairedBaselineCategoryCounts: {
        ...readyGate().pairedBaselineCategoryCounts,
        'full-task': 0,
      },
      skillBaselinePassRateDelta: null,
      skillBaselineQualityDelta: null,
      skillBaselineVerificationDelta: null,
      reasons: ['needs two current-revision full-task comparisons'],
    };
    const reconciled = reconcileV5AuditLedgerFromEvaluations(
      root,
      new Map([
        ['skill-authoring-evaluation', readyGate()],
        ['task-routing', blockedGate],
        ['repository-environment-discovery', insufficientGate],
      ]),
      new Date('2026-09-01T12:02:00Z'),
    );
    expect(
      reconciled.records.find((record) => record.skill === 'skill-authoring-evaluation'),
    ).toMatchObject({ v5Status: 'qualified', fullTaskEvals: 2, openRegressions: 0 });
    expect(reconciled.records.find((record) => record.skill === 'task-routing')).toMatchObject({
      v5Status: 'blocked',
      openRegressions: 1,
      nextAction: 'current regression remains open',
    });
    expect(
      reconciled.records.find((record) => record.skill === 'repository-environment-discovery'),
    ).toMatchObject({
      v5Status: 'evaluating',
      fullTaskEvals: 0,
      uplift: null,
      nextAction: 'needs two current-revision full-task comparisons',
    });
    expect(reconciled.records.find((record) => record.skill === 'planning')?.v5Status).toBe(
      'candidate',
    );

    const firstSerialized = readFileSync(getV5AuditLedgerPath(root), 'utf8');
    reconcileV5AuditLedgerFromEvaluations(
      root,
      new Map([
        ['skill-authoring-evaluation', readyGate()],
        ['task-routing', blockedGate],
        ['repository-environment-discovery', insufficientGate],
      ]),
      new Date('2026-09-01T13:00:00Z'),
    );
    expect(readFileSync(getV5AuditLedgerPath(root), 'utf8')).toBe(firstSerialized);
  });

  test('fails closed without overwriting a malformed persistent ledger', () => {
    const root = mkdtempSync(join(tmpdir(), 'kory-v5-audit-'));
    roots.push(root);
    const definitionAudit = auditBundledSkillDefinitions();
    syncV5AuditLedger(root, BUNDLED_SKILL_DEFINITIONS, V5_SKILL_PACKAGE_CATALOG.packages, {
      baseCount: definitionAudit.baseCount,
      professionalCount: definitionAudit.professionalCount,
      now: new Date('2026-09-01T12:00:00Z'),
    });
    const path = getV5AuditLedgerPath(root);
    writeFileSync(path, '{ malformed ledger');
    expect(() => loadV5AuditLedger(root)).toThrow('was preserved');
    expect(readFileSync(path, 'utf8')).toBe('{ malformed ledger');
  });
});
