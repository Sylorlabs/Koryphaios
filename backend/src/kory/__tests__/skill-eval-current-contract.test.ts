import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  BUILTIN_SKILL_EVAL_MATERIALIZERS,
  BUILTIN_SKILL_EVAL_SCORERS,
} from '../../eval/skills/skill-eval-fixtures';
import { skillEvaluationV5ContractHash } from '../../eval/skills/skill-eval-contract-hash';
import { currentV5SkillEvaluationContracts } from '../../eval/skills/skill-eval-current-contract';
import { speechAudioHarnessReadiness } from '../../eval/skills/skill-eval-speech-audio-harness';
import { buildSkillEvalSuiteV3 } from '../../eval/skills/skill-eval-harness';
import {
  CURRENT_SKILL_EVAL_CONTRACT_VERSION,
  evaluateSkillPromotion,
  listOpenSkillRegressionSources,
  recordSkillEvaluationRun,
  type SkillEvaluationRun,
} from '../skill-evaluations';
import { loadV5SkillPackages } from '../skill-packages';
import { listSkills } from '../skills';
import { buildSkillStewardDisplayLabel, ensureSkillSteward } from '../skill-stewards';

let root = '';
let home = '';
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'kory-current-contract-'));
  home = mkdtempSync(join(tmpdir(), 'kory-current-contract-home-'));
  process.env.KORYPHAIOS_SKILLS_HOME = home;
  mkdirSync(join(root, '.git'));
});
afterEach(() => {
  delete process.env.KORYPHAIOS_SKILLS_HOME;
  rmSync(root, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
});

function setup(skillName = 'debugging') {
  const skill = listSkills(root).find((item) => item.name === skillName)!;
  ensureSkillSteward(root, skill.name);
  const pkg = loadV5SkillPackages().packages.find((item) => item.sidecar.name === skill.name)!;
  const task = pkg.evaluation.tasks[0]!;
  const scenario = buildSkillEvalSuiteV3(pkg).scenarios.find((item) => item.id === task.id)!;
  const materializerIds = BUILTIN_SKILL_EVAL_MATERIALIZERS.filter((item) =>
    item.matches(scenario),
  ).map((item) => item.id);
  const scorerIds = BUILTIN_SKILL_EVAL_SCORERS.filter((item) =>
    item.scenarioIds.includes(task.id),
  ).map((item) => item.id);
  const identity = {
    evaluationContractVersion: CURRENT_SKILL_EVAL_CONTRACT_VERSION,
    evaluationContractHash: skillEvaluationV5ContractHash({
      contractVersion: CURRENT_SKILL_EVAL_CONTRACT_VERSION,
      skill: skill.name,
      packageVersion: pkg.sidecar.version,
      scenario: task,
      materializerIds,
      scorerIds,
    }),
    materializerId: materializerIds[0]!,
    deterministicScorerId: scorerIds[0]!,
  };
  function pair(label: string, override: Partial<SkillEvaluationRun> = {}, candidatePassed = true) {
    for (const variant of ['with-skill', 'without-skill'] as const) {
      recordSkillEvaluationRun(root, {
        id: `${label}-${variant}`,
        skill: skill.name,
        revisionHash: skill.hash,
        caseId: task.id,
        provider: 'test-provider',
        model: 'subject',
        harnessVersion: 'current-contract-test@1',
        role: 'worker',
        evaluator: 'deterministic',
        passed: variant === 'with-skill' ? candidatePassed : !candidatePassed,
        quality: (variant === 'with-skill' ? candidatePassed : !candidatePassed) ? 1 : 0,
        verification: 1,
        integrityFailure: false,
        evidence: [label],
        recordedAt: '2026-10-23T12:00:00Z',
        protocolVersion: 3,
        variant,
        caseCategory: 'full-task',
        comparisonId: label,
        routing: { expectedSelection: true, selected: variant === 'with-skill' },
        suiteId: `${skill.name}:v5:held-out`,
        scenarioId: task.id,
        experimentId: `${label}-${variant}`,
        ...identity,
        ...override,
      });
    }
  }
  function blind(label: string, override: Partial<SkillEvaluationRun> = {}) {
    recordSkillEvaluationRun(root, {
      id: `${label}-review`,
      skill: skill.name,
      revisionHash: skill.hash,
      caseId: task.id,
      provider: 'test-provider',
      model: 'reviewer',
      harnessVersion: 'blind-test@1',
      role: 'critic',
      evaluator: 'blind-review',
      passed: true,
      quality: 1,
      verification: 1,
      integrityFailure: false,
      evidence: [label],
      recordedAt: '2026-10-23T12:01:00Z',
      protocolVersion: 3,
      variant: 'with-skill',
      caseCategory: 'full-task',
      comparisonId: label,
      routing: { expectedSelection: true, selected: true },
      suiteId: `${skill.name}:v5:held-out`,
      scenarioId: task.id,
      experimentId: `${label}-review`,
      evaluatorProvenance: {
        evaluatorId: 'independent-test',
        kind: 'model',
        provider: 'test-provider',
        model: 'reviewer',
        agentId: 'independent-reviewer',
        displayLabel: buildSkillStewardDisplayLabel(skill.name),
        blindTo: ['skill-variant'],
        evidence: [label],
      },
      ...identity,
      ...override,
    });
  }
  return { skill, task, identity, pair, blind };
}

describe('current source V5 promotion contracts', () => {
  test.each(
    ['debugging', 'data-visualization'].flatMap((skillName) =>
      ['scorer', 'materializer', 'task-hash', 'hashless'].map((change) => [skillName, change]),
    ),
  )('does not credit %s %s evidence when no current observation exists', (skillName, change) => {
    const { skill, identity, pair, blind } = setup(skillName);
    const override: Partial<SkillEvaluationRun> =
      change === 'scorer'
        ? { deterministicScorerId: `${identity.deterministicScorerId}-obsolete@0` }
        : change === 'materializer'
          ? { materializerId: `${identity.materializerId}-obsolete@0` }
          : change === 'task-hash'
            ? { evaluationContractHash: '0000000000000000' }
            : {
                evaluationContractHash: undefined,
                materializerId: undefined,
                deterministicScorerId: undefined,
              };
    pair('old', override);
    blind('old', override);
    const ledger = join(root, '.koryphaios', 'skills', 'evaluations.json');
    const before = readFileSync(ledger, 'utf8');
    const gate = evaluateSkillPromotion(root, skill.name, skill.hash);
    expect(gate.categoryCoverage['full-task']).toBe(0);
    expect(gate.pairedBaselineCategoryCounts['full-task']).toBe(0);
    expect(gate.provenancedBlindReviews).toBe(0);
    expect(gate.candidateRuns).toBe(0);
    expect(gate.excludedEvidence).toHaveLength(3);
    expect(
      gate.excludedEvidence.every((item) => item.reason.includes('exact current source')),
    ).toBe(true);
    expect(readFileSync(ledger, 'utf8')).toBe(before);
  });

  test.each(['debugging', 'data-visualization'])(
    'credits %s exact current deterministic pairs and their inherited blind contract',
    (skillName) => {
      const { skill, pair, blind } = setup(skillName);
      pair('current');
      blind('current');
      const gate = evaluateSkillPromotion(root, skill.name, skill.hash);
      expect(gate.categoryCoverage['full-task']).toBe(1);
      expect(gate.pairedBaselineCategoryCounts['full-task']).toBe(1);
      expect(gate.provenancedBlindReviews).toBe(1);
    },
  );

  test('promotion scores the most recent runs per case instead of the whole history', () => {
    const { skill, pair, blind } = setup();
    ['old-1', 'old-2', 'old-3'].forEach((label, index) => {
      pair(label, { recordedAt: `2026-10-0${index + 1}T12:00:00Z` }, false);
    });
    ['new-1', 'new-2', 'new-3'].forEach((label, index) => {
      pair(label, { recordedAt: `2026-10-1${index + 1}T12:00:00Z` }, true);
    });
    blind('current', { recordedAt: '2026-10-20T12:00:00Z' });
    const gate = evaluateSkillPromotion(root, skill.name, skill.hash);
    expect(gate.candidateRuns).toBe(6);
    expect(gate.passRate).toBe(1);
    expect(gate.quality).toBe(1);
    expect(gate.verification).toBe(1);
  });

  test('a tampering run older than the evidence window no longer blocks promotion', () => {
    const { skill, pair, blind } = setup();
    pair('old-tamper', { recordedAt: '2026-10-01T12:00:00Z', integrityFailure: true }, false);
    ['r1', 'r2', 'r3'].forEach((label, index) => {
      pair(label, { recordedAt: `2026-10-1${index}T12:00:00Z` }, true);
    });
    blind('current', { recordedAt: '2026-10-20T12:00:00Z' });
    const gate = evaluateSkillPromotion(root, skill.name, skill.hash);
    expect(gate.reasons.some((reason) => /integrity/iu.test(reason))).toBe(false);
  });

  test('does not restore hashless blind reviews beside a current pair', () => {
    const { skill, pair, blind } = setup();
    pair('current');
    blind('current', {
      evaluationContractHash: undefined,
      materializerId: undefined,
      deterministicScorerId: undefined,
    });
    expect(evaluateSkillPromotion(root, skill.name, skill.hash).provenancedBlindReviews).toBe(0);
  });

  test('same-generation renamed scorer cannot lend current blind-review credit', () => {
    const { skill, identity, pair, blind } = setup();
    pair('current');
    blind('current', { deterministicScorerId: `renamed-${identity.deterministicScorerId}` });
    const gate = evaluateSkillPromotion(root, skill.name, skill.hash);
    expect(gate.categoryCoverage['full-task']).toBe(1);
    expect(gate.provenancedBlindReviews).toBe(0);
  });

  test('current source does not erase existing same-generation hash conflicts', () => {
    const { skill, pair } = setup();
    pair('current');
    pair('conflicting', { evaluationContractHash: '0000000000000000' });
    const gate = evaluateSkillPromotion(root, skill.name, skill.hash);
    expect(gate.candidateRuns).toBe(0);
    expect(gate.status).toBe('unmeasured');
    expect(gate.reasons.join(' ')).toContain('conflicting evaluation contracts');
  });

  test('superseded planning contract conflicts do not masquerade as current conflicts', () => {
    const { skill, pair } = setup('planning');
    const oldIdentity = {
      materializerId: 'sealed-evidence/professional-judgment@1',
      deterministicScorerId: 'sealed-evidence/professional-judgment-scorer@1',
    };
    pair('historical-a', { ...oldIdentity, evaluationContractHash: '1111111111111111' }, false);
    pair('historical-b', { ...oldIdentity, evaluationContractHash: '2222222222222222' });

    const gate = evaluateSkillPromotion(root, skill.name, skill.hash);
    expect(gate.categoryCoverage['full-task']).toBe(0);
    expect(gate.pairedBaselineCategoryCounts['full-task']).toBe(0);
    expect(gate.candidateRuns).toBe(0);
    expect(gate.reasons.join(' ')).not.toContain('Evaluation contract conflict');
    expect(gate.openRegressions).toBe(1);
  });

  test('an incomparable historical generation cannot suppress an exact current planning pair', () => {
    const { skill, pair } = setup('planning');
    pair(
      'obsolete-failure',
      {
        materializerId: 'sealed-evidence/professional-judgment@99',
        deterministicScorerId: 'sealed-evidence/professional-judgment-scorer@1',
        evaluationContractHash: '1111111111111111',
        recordedAt: '2026-10-23T11:00:00Z',
      },
      false,
    );
    pair('current');

    const gate = evaluateSkillPromotion(root, skill.name, skill.hash);
    expect(gate.categoryCoverage['full-task']).toBe(1);
    expect(gate.pairedBaselineCategoryCounts['full-task']).toBe(1);
    expect(gate.candidateRuns).toBe(1);
    expect(gate.reasons.join(' ')).not.toContain('Evaluation contract conflict');
    expect(gate.openRegressions).toBe(1);
    // The exclusion itself is forgiven once the same case has fresh current
    // evidence, but the obsolete failure stays an open regression source.
    expect(
      listOpenSkillRegressionSources(root, skill.name, skill.hash).map((run) => run.id),
    ).toContain('obsolete-failure-with-skill');
  });

  test('a dominating current generation closes a historical scorer regression the excluded stale success cannot reopen', () => {
    const { skill, identity, pair } = setup();
    const obsolete = {
      deterministicScorerId: `${identity.deterministicScorerId}-obsolete@0`,
      evaluationContractHash: '0000000000000000',
    };
    pair('old-failure', { ...obsolete, recordedAt: '2026-10-23T11:00:00Z' }, false);
    pair('current');
    pair('old-success', { ...obsolete, recordedAt: '2026-10-23T13:00:00Z' });
    const gate = evaluateSkillPromotion(root, skill.name, skill.hash);
    expect(gate.categoryCoverage['full-task']).toBe(1);
    // A retired scorer generation can never be re-run, so the newer current
    // generation dominates it and closes the regression; the excluded stale
    // success (same obsolete generation) cannot supersede that history.
    expect(gate.openRegressions).toBe(0);
    expect(
      listOpenSkillRegressionSources(root, skill.name, skill.hash).map((run) => run.id),
    ).not.toContain('old-failure-with-skill');
  });

  test.each(['hashless', 'stale'])(
    '%s explicit full-task regression retests cannot restore closure credit',
    (kind) => {
      const { skill, pair } = setup();
      pair('old-failure', { evaluationContractHash: '0000000000000000' }, false);
      pair('invalid-retest', {
        caseId: 'explicit-task-regression',
        scenarioId: 'explicit-task-regression',
        caseCategory: 'regression',
        regressionId: 'old-failure-with-skill',
        recordedAt: '2026-10-23T13:00:00Z',
        ...(kind === 'hashless'
          ? {
              evaluationContractHash: undefined,
              materializerId: undefined,
              deterministicScorerId: undefined,
            }
          : { evaluationContractHash: '0000000000000000' }),
      });
      expect(evaluateSkillPromotion(root, skill.name, skill.hash).openRegressions).toBe(1);
    },
  );

  test('exact current explicit retests retain full-task regression closure authority', () => {
    const { skill, pair } = setup();
    pair('old-failure', { evaluationContractHash: '0000000000000000' }, false);
    pair('current-retest', {
      caseId: 'explicit-task-regression',
      scenarioId: 'explicit-task-regression',
      caseCategory: 'regression',
      regressionId: 'old-failure-with-skill',
      recordedAt: '2026-10-23T13:00:00Z',
    });
    expect(evaluateSkillPromotion(root, skill.name, skill.hash).openRegressions).toBe(0);
  });

  test('exact current full-task regression closure requires a non-regressing observed baseline', () => {
    const { skill, task, identity, pair } = setup();
    pair(
      'old-failure',
      {
        evaluationContractHash: '0000000000000000',
        deterministicScorerId: `${identity.deterministicScorerId}-obsolete@0`,
        recordedAt: '2026-10-23T11:00:00Z',
      },
      false,
    );
    expect(
      listOpenSkillRegressionSources(root, skill.name, skill.hash).map((run) => run.id),
    ).toContain('old-failure-with-skill');

    const retest = (
      label: string,
      withQuality: number,
      withoutQuality: number,
      recordedAt: string,
      baselineScorerId?: string,
    ) => {
      for (const variant of ['with-skill', 'without-skill'] as const) {
        recordSkillEvaluationRun(root, {
          id: `${label}-${variant}`,
          skill: skill.name,
          revisionHash: skill.hash,
          caseId: task.id,
          scenarioId: task.id,
          provider: 'test-provider',
          model: 'subject',
          harnessVersion: 'current-contract-retest@1',
          role: 'worker',
          evaluator: 'deterministic',
          passed: true,
          quality: variant === 'with-skill' ? withQuality : withoutQuality,
          verification: 1,
          integrityFailure: false,
          evidence: [label],
          recordedAt,
          protocolVersion: 3,
          variant,
          caseCategory: 'full-task',
          comparisonId: label,
          routing: { expectedSelection: true, selected: variant === 'with-skill' },
          suiteId: `${skill.name}:v5:held-out`,
          experimentId: `${label}-${variant}`,
          ...(variant === 'with-skill' ? { regressionId: 'old-failure-with-skill' } : {}),
          ...identity,
          ...(variant === 'without-skill' && baselineScorerId
            ? { deterministicScorerId: baselineScorerId }
            : {}),
        });
      }
    };

    retest('worse-baseline-retest', 0.7, 0.9, '2026-10-23T13:00:00Z');
    expect(evaluateSkillPromotion(root, skill.name, skill.hash).openRegressions).toBe(1);
    retest(
      'stale-baseline-retest',
      1,
      0.9,
      '2026-10-23T13:30:00Z',
      `${identity.deterministicScorerId}-obsolete@0`,
    );
    expect(evaluateSkillPromotion(root, skill.name, skill.hash).openRegressions).toBe(1);
    retest('passing-current-retest', 1, 0.9, '2026-10-23T14:00:00Z');
    expect(evaluateSkillPromotion(root, skill.name, skill.hash).openRegressions).toBe(0);
  });

  test('source contract invalidation preserves failed historical observations and open regressions', () => {
    const { skill, pair } = setup();
    pair('old-failure', { evaluationContractHash: '0000000000000000' }, false);
    const gate = evaluateSkillPromotion(root, skill.name, skill.hash);
    expect(gate.categoryCoverage['full-task']).toBe(0);
    expect(gate.openRegressions).toBe(1);
    expect(
      listOpenSkillRegressionSources(root, skill.name, skill.hash).map((run) => run.id),
    ).toContain('old-failure-with-skill');
  });

  test('names the evaluator environment boundary instead of demanding unreachable full-task evidence', () => {
    const gated = setup('gpu-compute');
    gated.pair('gated-current');
    const gate = evaluateSkillPromotion(root, gated.skill.name, gated.skill.hash);
    expect(gate.categoryCoverage['full-task']).toBe(1);
    const boundary = gate.reasons.find((reason) =>
      reason.startsWith('Every full-task scenario is a registered evaluator environment boundary'),
    );
    expect(boundary).toContain('GPU/CUDA');
    // The scenario cannot execute anywhere, so the paired full-task baseline and the
    // blind review of one are not missing work: they are impossible work.
    expect(gate.reasons).not.toContain(
      'At least one blind review with persisted evaluator provenance is required.',
    );
    expect(gate.reasons).not.toContain(
      'V5 promotion requires at least two observed full-task candidate evaluations.',
    );
    expect(
      gate.reasons.some((reason) => reason.includes('baselines are missing for: full-task')),
    ).toBe(false);
  });

  test('exposes the readiness a materializer declares, so the gate can name the boundary', () => {
    // accessibility-verification now replays recorded live sessions, so its
    // scenarios declare no environment boundary. The declaration is a statement
    // about the evaluator rather than something every fixture carries.
    const accessibility = currentV5SkillEvaluationContracts(
      loadV5SkillPackages().packages.find(
        (item) => item.sidecar.name === 'accessibility-verification',
      )!,
      CURRENT_SKILL_EVAL_CONTRACT_VERSION,
    );
    expect(
      [...accessibility.values()].every((contract) => !(contract.readinessBlockers ?? []).length),
    ).toBe(true);
    // A scenario the evaluator can execute declares nothing.
    const executable = currentV5SkillEvaluationContracts(
      loadV5SkillPackages().packages.find((item) => item.sidecar.name === 'debugging')!,
      CURRENT_SKILL_EVAL_CONTRACT_VERSION,
    );
    expect([...executable.values()].every((contract) => !contract.readinessBlockers?.length)).toBe(
      true,
    );
    // A real-runtime harness still declares exactly what its own availability
    // probe reports on this host, verbatim.
    const speech = currentV5SkillEvaluationContracts(
      loadV5SkillPackages().packages.find((item) => item.sidecar.name === 'speech-audio-ai')!,
      CURRENT_SKILL_EVAL_CONTRACT_VERSION,
    );
    const declared = speechAudioHarnessReadiness();
    expect(
      [...speech.values()].every(
        (contract) => (contract.readinessBlockers ?? []).join('|') === declared.join('|'),
      ),
    ).toBe(true);
  });

  test('a registered real harness outranks the external environment placeholder', () => {
    // speech-audio-ai has a measured corpus harness registered against the same
    // scenario the gate placeholder names. The placeholder is the absence of an
    // evaluator, so its blocker must stand down once a real one covers the scenario.
    const speech = currentV5SkillEvaluationContracts(
      loadV5SkillPackages().packages.find((item) => item.sidecar.name === 'speech-audio-ai')!,
      CURRENT_SKILL_EVAL_CONTRACT_VERSION,
    );
    expect(
      [...speech.values()].every(
        (contract) =>
          (contract.readinessBlockers ?? []).join('|') === speechAudioHarnessReadiness().join('|'),
      ),
    ).toBe(true);
    expect(
      [...speech.values()]
        .flatMap((contract) => contract.materializerIds)
        .some((id) => id.includes('/measured-')),
    ).toBe(true);
    // computer-use now replays recorded desktop sessions, so it declares no
    // environment boundary either.
    const computerUse = currentV5SkillEvaluationContracts(
      loadV5SkillPackages().packages.find((item) => item.sidecar.name === 'computer-use')!,
      CURRENT_SKILL_EVAL_CONTRACT_VERSION,
    );
    expect(
      [...computerUse.values()].every((contract) => !(contract.readinessBlockers ?? []).length),
    ).toBe(true);
  });

  test('keeps the full-task checklist for a skill whose scenarios can execute', () => {
    const executable = setup('debugging');
    executable.pair('current');
    const gate = evaluateSkillPromotion(root, executable.skill.name, executable.skill.hash);
    expect(gate.reasons.some((reason) => reason.startsWith('Every full-task scenario'))).toBe(
      false,
    );
    expect(gate.reasons).toContain(
      'At least one blind review with persisted evaluator provenance is required.',
    );
  });

  test('retires a retired executor family instead of anchoring the uplift to it', () => {
    const { skill, pair } = setup();
    // An old executor family produced a pair where the skill arm failed verification.
    pair(
      'retired-executor',
      { provider: 'retired-provider', model: 'retired-model', recordedAt: '2026-10-01T00:00:00Z' },
      false,
    );
    // The current executor produces a clean pair for the same case.
    pair('current-executor', {
      provider: 'current-provider',
      model: 'current-model',
      recordedAt: '2026-10-23T00:00:00Z',
    });
    const gate = evaluateSkillPromotion(root, skill.name, skill.hash);
    expect(gate.skillBaselineVerificationDelta).toBe(0);
    expect(gate.reasons).not.toContain(
      'Candidate regressed against the matched no-skill baseline.',
    );
  });

  test('a newer regressing pair still blocks, so the latest evidence is what counts', () => {
    const { skill, task, identity, pair } = setup();
    pair('clean-earlier', {
      provider: 'current-provider',
      model: 'current-model',
      recordedAt: '2026-10-01T00:00:00Z',
    });
    // The arms must share an execution identity to form a pair, so the newer pair is a
    // different pair of the same case whose skill arm verifies less than its baseline.
    for (const variant of ['with-skill', 'without-skill'] as const) {
      recordSkillEvaluationRun(root, {
        id: `regresses-later-${variant}`,
        skill: skill.name,
        revisionHash: skill.hash,
        caseId: task.id,
        provider: 'other-provider',
        model: 'other-model',
        harnessVersion: 'current-contract-test@1',
        role: 'worker',
        evaluator: 'deterministic',
        passed: false,
        quality: 0.4,
        verification: variant === 'with-skill' ? 0.1 : 1,
        integrityFailure: false,
        evidence: [`regresses-later-${variant}`],
        recordedAt: '2026-10-23T00:00:00Z',
        protocolVersion: 3,
        variant,
        caseCategory: 'full-task',
        comparisonId: 'regresses-later',
        routing: { expectedSelection: true, selected: variant === 'with-skill' },
        suiteId: `${skill.name}:v5:held-out`,
        scenarioId: task.id,
        experimentId: `regresses-later-${variant}`,
        ...identity,
      });
    }
    const gate = evaluateSkillPromotion(root, skill.name, skill.hash);
    expect(gate.skillBaselineVerificationDelta).toBeLessThan(0);
    expect(gate.status).not.toBe('ready');
  });
});
