import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildSkillEvaluationCard,
  CURRENT_SKILL_EVAL_CONTRACT_VERSION,
  evaluateSkillPromotion,
  recordSkillEvaluationRun,
} from '../skill-evaluations';
import { listSkills } from '../skills';

let root = '';
let skillsHome = '';

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'kory-v5-regression-closure-'));
  skillsHome = mkdtempSync(join(tmpdir(), 'kory-v5-regression-closure-home-'));
  process.env.KORYPHAIOS_SKILLS_HOME = skillsHome;
  mkdirSync(join(root, '.git'));
});

afterEach(() => {
  delete process.env.KORYPHAIOS_SKILLS_HOME;
  rmSync(root, { recursive: true, force: true });
  rmSync(skillsHome, { recursive: true, force: true });
});

describe('protocol-v3 regression closure', () => {
  test('an integrity-failed no-skill arm is retained as history but cannot block or improve the candidate', () => {
    const skill = listSkills(root).find((item) => item.name === 'skill-authoring-evaluation')!;
    const scenario = buildSkillEvaluationCard(root, skill).suite.categories['full-task'][0]!;

    recordSkillEvaluationRun(root, {
      id: 'corrupted-baseline-without-skill',
      skill: skill.name,
      revisionHash: skill.hash,
      caseId: scenario.id,
      provider: 'baseline-provider',
      model: 'baseline-model',
      harnessVersion: 'v3:baseline-integrity',
      role: 'worker',
      evaluator: 'deterministic',
      passed: false,
      quality: 0,
      verification: 0,
      integrityFailure: true,
      evidence: ['baseline mutated evaluator-owned input'],
      recordedAt: '2026-09-01T12:00:00Z',
      protocolVersion: 3,
      variant: 'without-skill',
      caseCategory: 'full-task',
      comparisonId: 'corrupted-baseline-pair',
      routing: { expectedSelection: true, selected: true },
      suiteId: 'skill-authoring-evaluation:v5.0.0:held-out',
      scenarioId: scenario.id,
      experimentId: 'corrupted-baseline-without-skill',
      evaluationContractHash: '3333333333333333',
      evaluationContractVersion: CURRENT_SKILL_EVAL_CONTRACT_VERSION,
      materializerId: 'fixture@1',
      deterministicScorerId: 'scorer@1',
    });

    const gate = evaluateSkillPromotion(root, skill.name, skill.hash);
    expect(gate.reasons).not.toContain('At least one run recorded an integrity failure.');
    expect(gate.pairedBaselineCases).toBe(0);
  });

  test('current revision paired evidence closes a historical regression across provider and model changes', () => {
    const skill = listSkills(root).find((item) => item.name === 'skill-authoring-evaluation')!;
    const scenario = buildSkillEvaluationCard(root, skill).suite.categories['full-task'][0]!;

    const recordPair = (input: {
      id: string;
      revisionHash: string;
      provider: string;
      model: string;
      candidateQuality: number;
      baselineQuality: number;
      recordedAt: string;
      contractHash: string;
    }) => {
      for (const variant of ['with-skill', 'without-skill'] as const) {
        recordSkillEvaluationRun(root, {
          id: `${input.id}-${variant}`,
          skill: skill.name,
          revisionHash: input.revisionHash,
          caseId: scenario.id,
          provider: input.provider,
          model: input.model,
          harnessVersion: `v3:${input.contractHash}`,
          role: 'worker',
          evaluator: 'deterministic',
          passed: false,
          quality: variant === 'with-skill' ? input.candidateQuality : input.baselineQuality,
          verification: 1,
          integrityFailure: false,
          evidence: [input.id],
          recordedAt: input.recordedAt,
          protocolVersion: 3,
          variant,
          caseCategory: 'full-task',
          comparisonId: `${input.id}-pair`,
          routing: { expectedSelection: true, selected: true },
          suiteId: 'skill-authoring-evaluation:v5.0.0:held-out',
          scenarioId: scenario.id,
          experimentId: `${input.id}-${variant}`,
          evaluationContractHash: input.contractHash,
          evaluationContractVersion: CURRENT_SKILL_EVAL_CONTRACT_VERSION,
          materializerId: 'fixture@1',
          deterministicScorerId: 'scorer@1',
        });
      }
    };

    recordPair({
      id: 'historical-provider-model-regression',
      revisionHash: 'historical-revision',
      provider: 'historical-provider',
      model: 'historical-model',
      candidateQuality: 0.4,
      baselineQuality: 0.5,
      recordedAt: '2026-09-01T11:00:00Z',
      contractHash: '1111111111111111',
    });
    recordPair({
      id: 'current-provider-model-retest',
      revisionHash: skill.hash,
      provider: 'current-provider',
      model: 'current-model',
      candidateQuality: 0.6,
      baselineQuality: 0.5,
      recordedAt: '2026-09-01T12:00:00Z',
      contractHash: '2222222222222222',
    });
    expect(evaluateSkillPromotion(root, skill.name, skill.hash).openRegressions).toBe(0);

    recordPair({
      id: 'current-provider-model-new-regression',
      revisionHash: skill.hash,
      provider: 'current-provider',
      model: 'current-model',
      candidateQuality: 0.3,
      baselineQuality: 0.5,
      recordedAt: '2026-09-01T13:00:00Z',
      contractHash: '2222222222222222',
    });
    expect(evaluateSkillPromotion(root, skill.name, skill.hash).openRegressions).toBe(1);
  });

  test('obsolete protocol-v3 scenario identities remain in history without gating the current package', () => {
    const skill = listSkills(root).find((item) => item.name === 'skill-authoring-evaluation')!;
    const scenario = buildSkillEvaluationCard(root, skill).suite.categories['full-task'][0]!;
    for (const variant of ['with-skill', 'without-skill'] as const) {
      recordSkillEvaluationRun(root, {
        id: `current-active-${variant}`,
        skill: skill.name,
        revisionHash: skill.hash,
        caseId: scenario.id,
        provider: 'current-provider',
        model: 'current-model',
        harnessVersion: 'v3:current',
        role: 'worker',
        evaluator: 'deterministic',
        passed: true,
        quality: 1,
        verification: 1,
        integrityFailure: false,
        evidence: ['current active scenario'],
        recordedAt: '2026-09-01T12:00:00Z',
        protocolVersion: 3,
        variant,
        caseCategory: 'full-task',
        comparisonId: 'current-active-pair',
        routing: { expectedSelection: true, selected: true },
        suiteId: 'skill-authoring-evaluation:v5.0.0:held-out',
        scenarioId: scenario.id,
        experimentId: `current-active-${variant}`,
        evaluationContractHash: '2222222222222222',
        evaluationContractVersion: CURRENT_SKILL_EVAL_CONTRACT_VERSION,
        materializerId: 'fixture@1',
        deterministicScorerId: 'scorer@1',
      });
    }

    const ledgerPath = join(root, '.koryphaios', 'skills', 'evaluations.json');
    const ledger = JSON.parse(readFileSync(ledgerPath, 'utf8'));
    ledger.push({
      id: 'obsolete-historical-full-task:with-skill',
      skill: skill.name,
      revisionHash: 'historical-revision',
      caseId: 'skill-authoring-evaluation-full-task-obsolete',
      provider: 'historical-provider',
      model: 'historical-model',
      harnessVersion: 'v3:legacy',
      role: 'worker',
      evaluator: 'deterministic',
      passed: false,
      quality: 0,
      verification: 0,
      integrityFailure: false,
      evidence: ['historical failure retained for audit'],
      recordedAt: '2026-08-01T12:00:00Z',
      protocolVersion: 3,
      variant: 'with-skill',
      caseCategory: 'full-task',
      comparisonId: 'obsolete-historical-pair',
      routing: { expectedSelection: true, selected: true },
      suiteId: 'skill-authoring-evaluation:v4:held-out',
      scenarioId: 'skill-authoring-evaluation-full-task-obsolete',
      experimentId: 'obsolete-historical-full-task:with-skill',
    });
    writeFileSync(ledgerPath, `${JSON.stringify(ledger, null, 2)}\n`);

    expect(evaluateSkillPromotion(root, skill.name, skill.hash).openRegressions).toBe(0);
  });
});
