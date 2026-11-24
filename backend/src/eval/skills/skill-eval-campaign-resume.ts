import type { SkillEvaluationRun } from '../../kory/skill-evaluations';
import { skillEvaluationExecutionExclusionReason } from './skill-eval-eligibility';

/**
 * Only skip a scenario when both arms ran under the exact requested evaluator
 * identity and benchmark contract. A previous model's pair is still useful
 * history, but cannot stand in for a pair requested with another model.
 */
export function hasCompleteCurrentSkillPair(
  runs: readonly SkillEvaluationRun[],
  expected: {
    skill: string;
    revisionHash: string;
    scenarioId: string;
    evaluationContractHash: string;
    evaluationContractVersion: number;
    harnessVersion: string;
    provider: string;
    model: string;
  },
): boolean {
  const byPair = new Map<string, SkillEvaluationRun[]>();
  for (const run of runs) {
    if (
      skillEvaluationExecutionExclusionReason(run) ||
      run.skill !== expected.skill ||
      run.revisionHash !== expected.revisionHash ||
      run.protocolVersion !== 3 ||
      run.evaluator !== 'deterministic' ||
      run.caseCategory !== 'full-task' ||
      run.scenarioId !== expected.scenarioId ||
      run.caseId !== expected.scenarioId ||
      run.evaluationContractHash !== expected.evaluationContractHash ||
      run.evaluationContractVersion !== expected.evaluationContractVersion ||
      run.harnessVersion !== expected.harnessVersion ||
      run.provider !== expected.provider ||
      run.model !== expected.model ||
      run.integrityFailure ||
      run.infrastructureFailure ||
      !run.comparisonId ||
      !run.variant ||
      !run.suiteId ||
      !run.materializerId ||
      !run.deterministicScorerId
    )
      continue;
    byPair.set(run.comparisonId, [...(byPair.get(run.comparisonId) ?? []), run]);
  }
  return [...byPair.values()].some((pairRuns) =>
    pairRuns.some(
      (withSkill) =>
        withSkill.variant === 'with-skill' &&
        pairRuns.some(
          (withoutSkill) =>
            withoutSkill.variant === 'without-skill' &&
            withoutSkill.skill === withSkill.skill &&
            withoutSkill.caseId === withSkill.caseId &&
            withoutSkill.suiteId === withSkill.suiteId &&
            withoutSkill.evaluationContractVersion === withSkill.evaluationContractVersion &&
            withoutSkill.materializerId === withSkill.materializerId &&
            withoutSkill.deterministicScorerId === withSkill.deterministicScorerId,
        ),
    ),
  );
}
