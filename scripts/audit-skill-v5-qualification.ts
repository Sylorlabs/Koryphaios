import { resolve } from 'node:path';
import { auditSkillEvalExecutionReadiness } from '../backend/src/eval/skills/skill-eval-execution';
import {
  BUILTIN_SKILL_EVAL_MATERIALIZERS,
  BUILTIN_SKILL_EVAL_SCORERS,
} from '../backend/src/eval/skills/skill-eval-fixtures';
import { evaluateSkillPromotion } from '../backend/src/kory/skill-evaluations';
import { loadV5SkillPackages } from '../backend/src/kory/skill-packages';
import { auditV5SkillLibraryQuality } from '../backend/src/kory/skill-v5-quality';
import { listSkills } from '../backend/src/kory/skills';

const projectRoot = resolve(import.meta.dir, '..');
const catalog = loadV5SkillPackages(resolve(projectRoot, 'skills-v5'));
const quality = auditV5SkillLibraryQuality(catalog, new Date());
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
const qualityBySkill = new Map(quality.rows.map((row) => [row.name, row]));

const rows = catalog.packages.map((skillPackage) => {
  const skill = skillPackage.sidecar.name;
  const revision = revisions.get(skill);
  const packageReadiness = readiness.filter((item) => item.skill === skill);
  const executionReady = packageReadiness.filter((item) => item.ready);
  const executionBlocked = packageReadiness.filter((item) => !item.ready);
  const gate = revision ? evaluateSkillPromotion(projectRoot, skill, revision.hash) : null;
  const qualityRow = qualityBySkill.get(skill)!;
  return {
    skill,
    packageVersion: skillPackage.sidecar.version,
    revisionHash: revision?.hash ?? null,
    staticQuality: {
      authoringMaturity: qualityRow.authoringMaturity,
      authoritativeSources: qualityRow.authoritativeSourceCount,
      staleSources: qualityRow.staleSourceCount,
      heldOutRoutingCases: qualityRow.heldOutRoutingCount,
      fullTasks: qualityRow.fullTaskCount,
      individualFullTasks: qualityRow.individualFullTaskCount,
      deterministicFullTasks: qualityRow.deterministicFullTaskCount,
      blindSemanticFullTasks: qualityRow.blindSemanticFullTaskCount,
      portabilityIssues: [...qualityRow.portabilityIssues],
      genericMarkers: [...qualityRow.genericMarkers],
      genericTaskFixtureIds: [...qualityRow.genericTaskFixtureIds],
    },
    execution: {
      readyScenarios: executionReady.length,
      blockedScenarios: executionBlocked.length,
      blockers: executionBlocked.map((item) => ({
        scenarioId: item.scenarioId,
        startingState: item.startingState,
        reasons: [...item.reasons],
      })),
    },
    promotion: gate
      ? {
          status: gate.status,
          routingPrecision: gate.routingPrecision,
          routingRecall: gate.routingRecall,
          fullTaskCoverage: gate.categoryCoverage['full-task'],
          pairedFullTaskBaselines: gate.pairedBaselineCategoryCounts['full-task'],
          provenancedBlindReviews: gate.provenancedBlindReviews,
          openRegressions: gate.openRegressions,
          excludedEvidence: gate.excludedEvidence,
          uplift: {
            passRate: gate.skillBaselinePassRateDelta,
            quality: gate.skillBaselineQualityDelta,
            verification: gate.skillBaselineVerificationDelta,
          },
          reasons: [...gate.reasons],
        }
      : null,
  };
});

const blockerReasonCounts = new Map<string, number>();
const blockerEnvironmentCounts = new Map<string, number>();
for (const row of rows) {
  for (const blocker of row.execution.blockers) {
    const kind = catalog.packages
      .find((item) => item.sidecar.name === row.skill)!
      .evaluation.tasks.find((task) => task.id === blocker.scenarioId)!.environment.kind;
    blockerEnvironmentCounts.set(kind, (blockerEnvironmentCounts.get(kind) ?? 0) + 1);
    for (const reason of blocker.reasons) {
      const normalized = reason
        .replace(/^no materializer for .+$/u, 'no materializer for declared starting state')
        .replace(/^no registered deterministic scorer$/u, 'no registered deterministic scorer');
      blockerReasonCounts.set(normalized, (blockerReasonCounts.get(normalized) ?? 0) + 1);
    }
  }
}

const promotionCounts = rows.reduce<Record<string, number>>((counts, row) => {
  const status = row.promotion?.status ?? 'unavailable';
  counts[status] = (counts[status] ?? 0) + 1;
  return counts;
}, {});
const summaryOnly = process.argv.includes('--summary');
const report = {
  schemaVersion: 1,
  packages: rows.length,
  staticQualityClean:
    quality.catalogErrors.length === 0 &&
    quality.catalogWarnings.length === 0 &&
    quality.maturityCounts.scaffold === 0 &&
    quality.stalePackages.length === 0 &&
    quality.weakSourceAuthorityPackages.length === 0 &&
    quality.missingIndividualTaskPackages.length === 0 &&
    quality.evaluationCoverageGaps.length === 0 &&
    quality.portabilityViolations.length === 0 &&
    quality.genericBodyPackages.length === 0 &&
    quality.genericTaskPackages.length === 0 &&
    quality.genericRoutingPackages.length === 0 &&
    quality.hierarchyGaps.length === 0,
  execution: {
    scenarios: readiness.length,
    ready: readiness.filter((item) => item.ready).length,
    blocked: readiness.filter((item) => !item.ready).length,
    fullyReadyPackages: rows.filter((row) => row.execution.blockedScenarios === 0).length,
    partiallyReadyPackages: rows.filter(
      (row) => row.execution.readyScenarios > 0 && row.execution.blockedScenarios > 0,
    ).length,
    fullyBlockedPackages: rows.filter((row) => row.execution.readyScenarios === 0).length,
    blockersByEnvironment: Object.fromEntries(
      [...blockerEnvironmentCounts.entries()].sort((left, right) => right[1] - left[1]),
    ),
    blockerReasons: Object.fromEntries(
      [...blockerReasonCounts.entries()].sort((left, right) => right[1] - left[1]),
    ),
  },
  promotion: {
    statusCounts: promotionCounts,
    perfectRoutingPackages: rows.filter(
      (row) => row.promotion?.routingPrecision === 1 && row.promotion?.routingRecall === 1,
    ).length,
    packagesWithTwoFullTasks: rows.filter((row) => (row.promotion?.fullTaskCoverage ?? 0) >= 2)
      .length,
    packagesWithTwoPairedFullTaskBaselines: rows.filter(
      (row) => (row.promotion?.pairedFullTaskBaselines ?? 0) >= 2,
    ).length,
    packagesWithBlindReview: rows.filter((row) => (row.promotion?.provenancedBlindReviews ?? 0) > 0)
      .length,
    packagesWithOpenRegressions: rows.filter((row) => (row.promotion?.openRegressions ?? 0) > 0)
      .length,
  },
  ...(summaryOnly ? {} : { rows }),
};

// Drain large reports before exiting with a nonzero qualification status. Bun
// otherwise may truncate piped JSON when this gate fails.
await new Promise<void>((resolveOutput, rejectOutput) => {
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`, (error) => {
    if (error) rejectOutput(error);
    else resolveOutput();
  });
});

// This command is a qualification gate, not just an inventory. Static quality
// must be clean and every package must have genuinely complete empirical
// promotion evidence before the command exits successfully.
if (
  !report.staticQualityClean ||
  report.execution.blocked > 0 ||
  promotionCounts.ready !== rows.length
) {
  process.exitCode = 1;
}
