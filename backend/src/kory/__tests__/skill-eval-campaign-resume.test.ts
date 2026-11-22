import { describe, expect, test } from 'bun:test';
import { hasCompleteCurrentSkillPair } from '../../eval/skills/skill-eval-campaign-resume';
import type { SkillEvaluationRun } from '../skill-evaluations';

const expected = {
  skill: 'test',
  revisionHash: 'revision-1',
  scenarioId: 'full-task-1',
  evaluationContractHash: 'contract-1',
  evaluationContractVersion: 3,
  harnessVersion: 'harness-1',
  provider: 'codex',
  model: 'gpt-5.6-sol',
};

function run(variant: 'with-skill' | 'without-skill', changes: Partial<SkillEvaluationRun> = {}): SkillEvaluationRun {
  return {
    id: variant,
    skill: 'test',
    revisionHash: expected.revisionHash,
    caseId: expected.scenarioId,
    provider: expected.provider,
    model: expected.model,
    harnessVersion: expected.harnessVersion,
    role: 'worker',
    evaluator: 'deterministic',
    passed: true,
    quality: 1,
    verification: 1,
    integrityFailure: false,
    evidence: [],
    recordedAt: '2026-10-09T00:00:00Z',
    protocolVersion: 3,
    variant,
    caseCategory: 'full-task',
    comparisonId: 'pair-1',
    scenarioId: expected.scenarioId,
    suiteId: 'suite-1',
    evaluationContractVersion: expected.evaluationContractVersion,
    materializerId: 'fixture@1',
    deterministicScorerId: 'scorer@1',
    evaluationContractHash: expected.evaluationContractHash,
    ...changes,
  };
}

describe('qualification campaign resume', () => {
  test('skips only an actual current, same-model skill/no-skill pair', () => {
    expect(hasCompleteCurrentSkillPair([run('with-skill'), run('without-skill')], expected)).toBe(true);
  });

  test('does not use a previous model or a different provider for requested model', () => {
    expect(hasCompleteCurrentSkillPair([
      run('with-skill', { model: 'gpt-5.5-sol' }),
      run('without-skill', { model: 'gpt-5.5-sol' }),
    ], expected)).toBe(false);
    expect(hasCompleteCurrentSkillPair([
      run('with-skill'), run('without-skill', { model: 'gpt-5.5-sol' }),
    ], expected)).toBe(false);
    expect(hasCompleteCurrentSkillPair([
      run('with-skill', { provider: 'other' }),
      run('without-skill', { provider: 'other' }),
    ], expected)).toBe(false);
  });

  test('does not combine distinct pairs, failed infrastructure, stale revisions or contracts', () => {
    expect(hasCompleteCurrentSkillPair([
      run('with-skill'), run('without-skill', { comparisonId: 'pair-2' }),
    ], expected)).toBe(false);
    expect(hasCompleteCurrentSkillPair([
      run('with-skill'), run('without-skill', {
        infrastructureFailure: { kind: 'provider', retryable: true, evidence: ['timeout'], detail: 'timeout' },
      }),
    ], expected)).toBe(false);
    expect(hasCompleteCurrentSkillPair([
      run('with-skill'), run('without-skill', { integrityFailure: true }),
    ], expected)).toBe(false);
    for (const field of ['revisionHash', 'evaluationContractHash', 'harnessVersion', 'scenarioId'] as const) {
      expect(hasCompleteCurrentSkillPair([
        run('with-skill'), run('without-skill', { [field]: 'stale' }),
      ], expected)).toBe(false);
    }
  });

  test('never skips qualification using two arms from different task or evaluator identities', () => {
    for (const field of [
      'skill', 'caseId', 'suiteId',
      'materializerId', 'deterministicScorerId',
    ] as const) {
      expect(hasCompleteCurrentSkillPair([
        run('with-skill'), run('without-skill', { [field]: 'other' }),
      ], expected)).toBe(false);
    }
    expect(hasCompleteCurrentSkillPair([
      run('with-skill'), run('without-skill', { evaluationContractVersion: 2 }),
    ], expected)).toBe(false);
    expect(hasCompleteCurrentSkillPair([
      run('with-skill', { skill: 'other' }),
      run('without-skill', { skill: 'other' }),
    ], expected)).toBe(false);
    expect(hasCompleteCurrentSkillPair([
      run('with-skill', { evaluationContractVersion: 2 }),
      run('without-skill', { evaluationContractVersion: 2 }),
    ], expected)).toBe(false);
    for (const field of ['suiteId', 'evaluationContractVersion', 'materializerId', 'deterministicScorerId'] as const) {
      expect(hasCompleteCurrentSkillPair([
        run('with-skill', { [field]: undefined }),
        run('without-skill', { [field]: undefined }),
      ], expected)).toBe(false);
    }
  });
});
