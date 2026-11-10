import { resolve } from 'node:path';
import { newRoutingCampaignId, routingComparisonId } from './skill-v5-routing-identity';
import { createTaskContract } from '../backend/src/kory/prompts';
import {
  evaluateSkillPromotion,
  recordSkillEvaluationRuns,
  type SkillEvaluationRun,
} from '../backend/src/kory/skill-evaluations';
import { loadV5SkillPackages } from '../backend/src/kory/skill-packages';
import {
  isDirectSkillSelection,
  listSkills,
  resolveSkills,
  type SkillRevision,
} from '../backend/src/kory/skills';

const projectRoot = resolve(import.meta.dir, '..');
const packages = loadV5SkillPackages(resolve(projectRoot, 'skills-v5')).packages;
const currentRevisions = listSkills(projectRoot).filter(
  (skill) => skill.state === 'active' && skill.validation.valid,
);
const currentByName = new Map(currentRevisions.map((skill) => [skill.name, skill]));
const requested = process.argv
  .filter((argument) => argument.startsWith('--skill='))
  .map((argument) => argument.slice('--skill='.length).trim())
  .filter(Boolean);
const summaryOnly = process.argv.includes('--summary');
const dryRun = process.argv.includes('--dry-run');
const requestedPackages = requested.length
  ? requested.map((name) => {
      const skillPackage = packages.find((item) => item.sidecar.name === name);
      if (!skillPackage) throw new Error(`Unknown V5 skill package ${name}`);
      return skillPackage;
    })
  : packages;
// Do not repeatedly add passing routing observations to already measured revisions.
const selectedPackages = process.argv.includes('--missing-current-only')
  ? requestedPackages.filter((skillPackage) => {
      const revision = currentByName.get(skillPackage.sidecar.name);
      if (!revision) throw new Error(`${skillPackage.sidecar.name} has no active valid revision`);
      const gate = evaluateSkillPromotion(projectRoot, revision.name, revision.hash);
      return gate.routingPrecision === null || gate.routingRecall === null;
    })
  : requestedPackages;

interface RoutingOutcome {
  actual: boolean;
  passed: boolean;
  selected: string[];
  missingExpected: string[];
  selectedForbidden: string[];
  missingHierarchy: string[];
  blocked: boolean;
  hierarchyErrors: string[];
}

function evaluateRouting(input: {
  skill: string;
  expectedSelection: boolean;
  selectionScope: 'direct' | 'bundle';
  expectedSkills: string[];
  forbiddenSkills: string[];
  broader: string[];
  requires: string[];
  prompt: string;
  revisions: readonly SkillRevision[];
  pin: boolean;
}): RoutingOutcome {
  const result = resolveSkills(projectRoot, input.prompt, createTaskContract(input.prompt), {
    contextBudget: 60_000,
    skillRevisions: input.revisions,
    pins: input.pin ? [input.skill] : undefined,
  });
  const selected = result.selected.map((item) => item.skill.name);
  const target = result.selected.find((item) => item.skill.name === input.skill);
  const actual = Boolean(
    target && (input.selectionScope !== 'direct' || isDirectSkillSelection(target)),
  );
  const missingExpected = input.expectedSkills.filter((name) => !selected.includes(name));
  const selectedForbidden = input.forbiddenSkills.filter((name) => selected.includes(name));
  const missingHierarchy = actual
    ? [...input.broader, ...input.requires].filter((name) => !selected.includes(name))
    : [];
  return {
    actual,
    passed:
      actual === input.expectedSelection &&
      !result.blocked &&
      missingExpected.length === 0 &&
      selectedForbidden.length === 0 &&
      missingHierarchy.length === 0,
    selected,
    missingExpected,
    selectedForbidden,
    missingHierarchy,
    blocked: result.blocked,
    hierarchyErrors: [...result.hierarchyErrors],
  };
}

const observations: Array<{
  skill: string;
  caseId: string;
  category: string;
  withSkill: RoutingOutcome;
  withoutSkill: RoutingOutcome;
}> = [];
const runsToPersist: SkillEvaluationRun[] = [];
const now = new Date().toISOString();
const campaignId = newRoutingCampaignId();

for (const skillPackage of selectedPackages) {
  const target = currentByName.get(skillPackage.sidecar.name);
  if (!target) throw new Error(`${skillPackage.sidecar.name} has no active valid runtime revision`);
  const withoutTarget = currentRevisions.filter(
    (skill) => skill.name !== skillPackage.sidecar.name,
  );
  for (const testCase of skillPackage.evaluation.routing) {
    const shared = {
      skill: skillPackage.sidecar.name,
      expectedSelection: testCase.expectedSelection,
      selectionScope: testCase.selectionScope,
      expectedSkills: [...testCase.expectedSkills],
      forbiddenSkills: [...testCase.forbiddenSkills],
      broader: [...skillPackage.sidecar.broader],
      requires: [...skillPackage.sidecar.requires],
      prompt: testCase.prompt,
    };
    const withSkill = evaluateRouting({
      ...shared,
      revisions: currentRevisions,
      pin: skillPackage.sidecar.invocationMode === 'user-invoked' && testCase.expectedSelection,
    });
    const withoutSkill = evaluateRouting({
      ...shared,
      revisions: withoutTarget,
      pin: false,
    });
    observations.push({
      skill: skillPackage.sidecar.name,
      caseId: testCase.id,
      category: testCase.category,
      withSkill,
      withoutSkill,
    });
    if (dryRun) continue;

    const comparisonId = routingComparisonId(
      skillPackage.sidecar.name,
      testCase.id,
      target.hash,
      campaignId,
    );
    for (const [variant, outcome] of [
      ['with-skill', withSkill],
      ['without-skill', withoutSkill],
    ] as const) {
      runsToPersist.push({
        id: `${comparisonId}:${variant}`,
        skill: skillPackage.sidecar.name,
        revisionHash: target.hash,
        caseId: testCase.id,
        provider: 'kory-resolver',
        model: 'deterministic-v5',
        harnessVersion: 'v5-routing-evidence@1',
        role: 'worker',
        evaluator: 'deterministic',
        passed: outcome.passed,
        quality: outcome.passed ? 1 : 0,
        verification: 1,
        integrityFailure: false,
        evidence: [
          `target selection expected=${String(testCase.expectedSelection)} observed=${String(outcome.actual)}`,
          `selected skills: ${outcome.selected.join(', ') || '(none)'}`,
          `missing expected: ${outcome.missingExpected.join(', ') || '(none)'}`,
          `forbidden selected: ${outcome.selectedForbidden.join(', ') || '(none)'}`,
          `missing hierarchy: ${outcome.missingHierarchy.join(', ') || '(none)'}`,
          `resolver blocked=${String(outcome.blocked)}`,
          ...(outcome.hierarchyErrors.length
            ? [`hierarchy errors: ${outcome.hierarchyErrors.join('; ')}`]
            : []),
        ],
        recordedAt: now,
        protocolVersion: 3,
        variant,
        caseCategory: testCase.category,
        comparisonId,
        routing: {
          expectedSelection: testCase.expectedSelection,
          selected: outcome.actual,
          selectionScope: testCase.selectionScope,
          selectedSkills: [...outcome.selected],
          expectedSkills: [...testCase.expectedSkills],
          forbiddenSkills: [...testCase.forbiddenSkills],
        },
        suiteId: `${skillPackage.sidecar.name}:v${skillPackage.sidecar.version}:held-out`,
        scenarioId: testCase.id,
        experimentId: `${comparisonId}:${variant}`,
      });
    }
  }
}

if (!dryRun && runsToPersist.length) recordSkillEvaluationRuns(projectRoot, runsToPersist);

const failures = observations.filter((item) => !item.withSkill.passed);
const bySkill = new Map<
  string,
  {
    cases: number;
    passed: number;
    positives: number;
    truePositives: number;
    falsePositives: number;
  }
>();
for (const observation of observations) {
  const skillPackage = selectedPackages.find((item) => item.sidecar.name === observation.skill)!;
  const testCase = skillPackage.evaluation.routing.find((item) => item.id === observation.caseId)!;
  const bucket = bySkill.get(observation.skill) ?? {
    cases: 0,
    passed: 0,
    positives: 0,
    truePositives: 0,
    falsePositives: 0,
  };
  bucket.cases += 1;
  if (observation.withSkill.passed) bucket.passed += 1;
  if (testCase.expectedSelection) {
    bucket.positives += 1;
    if (observation.withSkill.actual) bucket.truePositives += 1;
  } else if (observation.withSkill.actual) {
    bucket.falsePositives += 1;
  }
  bySkill.set(observation.skill, bucket);
}
const skillSummaries = [...bySkill.entries()].map(([skill, bucket]) => ({
  skill,
  cases: bucket.cases,
  passed: bucket.passed,
  precision:
    bucket.truePositives + bucket.falsePositives
      ? bucket.truePositives / (bucket.truePositives + bucket.falsePositives)
      : null,
  recall: bucket.positives ? bucket.truePositives / bucket.positives : null,
}));

console.log(
  JSON.stringify(
    {
      schemaVersion: 1,
      dryRun,
      skills: selectedPackages.length,
      cases: observations.length,
      passedCases: observations.length - failures.length,
      failedCases: failures.length,
      ...(summaryOnly
        ? {
            failingSkills: [...new Set(failures.map((item) => item.skill))].sort(),
            failures: failures.slice(0, 40).map((item) => ({
              skill: item.skill,
              caseId: item.caseId,
              selected: item.withSkill.selected,
              missingExpected: item.withSkill.missingExpected,
              selectedForbidden: item.withSkill.selectedForbidden,
              missingHierarchy: item.withSkill.missingHierarchy,
              blocked: item.withSkill.blocked,
            })),
            gatesBelow95: skillSummaries.filter(
              (item) =>
                item.precision === null ||
                item.recall === null ||
                item.precision < 0.95 ||
                item.recall < 0.95,
            ),
          }
        : { skillSummaries, observations }),
    },
    null,
    2,
  ),
);

if (failures.length) process.exitCode = 1;
