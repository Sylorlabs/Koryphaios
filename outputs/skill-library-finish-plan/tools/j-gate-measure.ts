import { resolve } from 'node:path';
import { auditSkillEvalExecutionReadiness } from '../../../backend/src/kory/skill-eval-execution';
import {
  BUILTIN_SKILL_EVAL_MATERIALIZERS,
  BUILTIN_SKILL_EVAL_SCORERS,
} from '../../../backend/src/kory/skill-eval-fixtures';
import { evaluateSkillPromotion } from '../../../backend/src/kory/skill-evaluations';
import { listSkills } from '../../../backend/src/kory/skills';
import { loadV5SkillPackages } from '../../../backend/src/kory/skill-packages';

const GROUP = [
  'architecture-planning',
  'planning',
  'feature-implementation',
  'refactor-implementation',
  'implementation',
  'integration-implementation',
  'developer-experience',
  'repository-environment-discovery',
  'repository-research',
  'research',
  'literature-research',
  'factual-research',
  'market-competitive-research',
];

const projectRoot = resolve(import.meta.dir, '../../..');
const catalog = loadV5SkillPackages(resolve(projectRoot, 'skills-v5'));
const readiness = auditSkillEvalExecutionReadiness(
  catalog.packages,
  BUILTIN_SKILL_EVAL_MATERIALIZERS,
  BUILTIN_SKILL_EVAL_SCORERS,
);
const revisions = new Map(
  listSkills(projectRoot)
    .filter((skill) => skill.state === 'active' && skill.validation.valid)
    .map((skill) => [skill.name, skill]),
);

const out: Record<string, unknown> = {};
for (const name of GROUP) {
  const revision = revisions.get(name);
  if (!revision) {
    out[name] = { error: 'no active valid revision' };
    continue;
  }
  const gate = evaluateSkillPromotion(projectRoot, name, revision.hash);
  const scenarios = readiness.filter((item) => item.skill === name);
  out[name] = {
    revisionHash: revision.hash,
    status: gate.status,
    candidateRuns: gate.candidateRuns,
    baselineRuns: gate.baselineRuns,
    passRate: gate.passRate,
    quality: gate.quality,
    verification: gate.verification,
    fullTaskCoverage: gate.categoryCoverage['full-task'],
    categoryCoverage: gate.categoryCoverage,
    pairedCases: gate.pairedBaselineCases,
    pairedFullTask: gate.pairedBaselineCategoryCounts['full-task'],
    pairedCategories: gate.pairedBaselineCategories,
    routing: { precision: gate.routingPrecision, recall: gate.routingRecall, n: gate.routingObservations },
    blind: { provenanced: gate.provenancedBlindReviews, human: gate.humanBlindReviews },
    regressions: { total: gate.regressionCases, open: gate.openRegressions },
    deltas: {
      pass: gate.skillBaselinePassRateDelta,
      quality: gate.skillBaselineQualityDelta,
      verification: gate.skillBaselineVerificationDelta,
    },
    infrastructureFailures: gate.infrastructureFailures,
    excluded: gate.excludedEvidence.map((item) => item.reason),
    reasons: gate.reasons,
    execution: {
      ready: scenarios.filter((item) => item.ready).length,
      blocked: scenarios.filter((item) => !item.ready).map((item) => ({
        scenarioId: item.scenarioId,
        reasons: [...item.reasons],
      })),
    },
  };
}

await new Promise<void>((done) => {
  process.stdout.write(`${JSON.stringify(out, null, 2)}\n`, () => done());
});
