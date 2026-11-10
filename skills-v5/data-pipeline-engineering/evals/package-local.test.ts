// Package contract checks only. These are local fixture checks, not model trials,
// paired runs, qualification evidence, or promotion output.
import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createTaskContract } from '../../../backend/src/kory/prompts';
import {
  auditSkillEvalExecutionReadiness,
  type SkillEvalScenarioV3,
} from '../../../backend/src/kory/skill-eval-execution';
import { buildSkillEvalSuiteV3 } from '../../../backend/src/kory/skill-eval-harness';
import {
  loadV5SkillPackages,
  sourceFreshness,
  validateV5SkillPackage,
} from '../../../backend/src/kory/skill-packages';
import {
  DATA_ENGINEERING_SKILL_EVAL_MATERIALIZERS,
  DATA_ENGINEERING_SKILL_EVAL_SCORERS,
} from '../../../backend/src/kory/skill-eval-data-engineering-fixtures';
import {
  collectSkillEvidence,
  evaluateSkillTrigger,
  isDirectSkillSelection,
  resolveSkills,
  type SkillRevision,
} from '../../../backend/src/kory/skills';

const packageRoot = resolve(import.meta.dir, '..');
const packageName = 'data-pipeline-engineering';
const validation = validateV5SkillPackage(packageRoot);
if (!validation.package) throw new Error(validation.errors.join('\n'));
const pkg = validation.package;

function packageRevisions(): SkillRevision[] {
  const packages = loadV5SkillPackages().packages;
  return packages.map((item) => {
    const hash = createHash('sha256')
      .update(item.sourceContent)
      .update(JSON.stringify(item.sidecar))
      .digest('hex');
    return {
      name: item.sidecar.name,
      description: item.definition.description,
      source: 'project',
      state: 'active',
      path: item.sourcePath,
      storageVersion: 2,
      document: {
        kind: 'markdown',
        extension: 'md',
        renderer: 'markdown',
        mediaType: 'text/markdown',
      },
      sourceContent: item.sourceContent,
      coreInstructions: item.instructions,
      content: item.sourceContent,
      instructions: item.instructions,
      hash,
      validation: { valid: true, errors: [], warnings: [], ignoredAuthorityClaims: [] },
      metadata: {
        version: item.sidecar.version,
        baseVersion: item.sidecar.version,
        baseHash: hash,
        domains: item.sidecar.domains,
        targetMedia: item.sidecar.targetMedia,
        shouldTrigger: item.sidecar.routing.positive,
        shouldNotTrigger: item.sidecar.routing.negative,
        evidence: item.sidecar.evidence,
        contextBudget: item.sidecar.contextBudget,
        sourceScope: 'local-only',
        broader: item.sidecar.broader,
        facets: item.sidecar.facets,
        depth: 0,
        requires: item.sidecar.requires,
        conflicts: item.sidecar.conflicts,
        activation: item.sidecar.activation,
        excludes: item.sidecar.excludes,
        invocationMode: item.sidecar.invocationMode,
        pathScopes: item.sidecar.pathScopes,
      },
    };
  });
}

test('package, source freshness, and fixture boundaries are executable', () => {
  expect(validation.valid).toBe(true);
  expect(validation.errors).toEqual([]);
  expect(validation.warnings).toEqual([]);
  const sourceMap = readFileSync(join(packageRoot, 'references/sources.md'), 'utf8');
  for (const source of pkg.sidecar.sources) {
    expect(sourceFreshness(source, new Date('2026-10-17T12:00:00.000Z'))).toBe('fresh');
    expect(sourceMap).toContain(source.url);
    expect(sourceMap).toContain(
      `Verified: ${source.verifiedAt}; refresh after ${source.staleAfterDays} days.`,
    );
  }
  expect(pkg.evaluation.tasks.map((task) => task.id)).toEqual([
    'data-pipeline-engineering-full-task-1-individual',
    'data-pipeline-engineering-full-task-2-individual',
  ]);
  expect(pkg.evaluation.tasks[0]?.prompt).toContain('in-memory');
  expect(pkg.evaluation.tasks[0]?.prompt).toContain(
    'Schema-evolution behavior is exercised separately',
  );
  expect(pkg.evaluation.tasks[1]?.prompt).toContain('process-durable restart evidence');
  expect(pkg.evaluation.tasks[1]?.prompt).toContain('duplicate file delivery');
});

test('public and held-out routing cases select only the live pipeline responsibility', () => {
  const root = mkdtempSync(join(tmpdir(), 'kory-data-pipeline-routing-'));
  try {
    const revisions = packageRevisions();
    const cases = [
      ...pkg.sidecar.routing.positive.map((prompt) => ({ prompt, expectedSelection: true })),
      ...pkg.sidecar.routing.negative.map((prompt) => ({ prompt, expectedSelection: false })),
      ...pkg.sidecar.routing.ambiguous,
      ...pkg.sidecar.routing.adversarial,
      ...pkg.evaluation.routing,
    ];
    for (const row of cases) {
      const contract = createTaskContract(row.prompt);
      const result = resolveSkills(root, row.prompt, contract, {
        skillRevisions: revisions,
        contextBudget: 60_000,
      });
      const target = result.selected.find((item) => item.skill.name === packageName);
      const selected = Boolean(target && isDirectSkillSelection(target));
      expect(selected, `${row.id ?? row.prompt}\n${target?.reason ?? 'not selected'}`).toBe(
        row.expectedSelection,
      );
      expect(result.blocked).toBe(false);
      expect(result.hierarchyErrors).toEqual([]);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('registered scenarios have one ready scorer and reject each vulnerable starter', async () => {
  const readiness = auditSkillEvalExecutionReadiness(
    [pkg],
    DATA_ENGINEERING_SKILL_EVAL_MATERIALIZERS,
    DATA_ENGINEERING_SKILL_EVAL_SCORERS,
  );
  expect(readiness).toHaveLength(2);
  expect(readiness.every((row) => row.ready && row.reasons.length === 0)).toBe(true);

  const suite = buildSkillEvalSuiteV3(pkg);
  for (const task of pkg.evaluation.tasks) {
    const scenario = suite.scenarios.find((item) => item.id === task.id)! as SkillEvalScenarioV3;
    const materializers = DATA_ENGINEERING_SKILL_EVAL_MATERIALIZERS.filter((item) =>
      item.matches(scenario),
    );
    const scorers = DATA_ENGINEERING_SKILL_EVAL_SCORERS.filter((item) =>
      item.scenarioIds.includes(task.id),
    );
    expect(materializers).toHaveLength(1);
    expect(scorers).toHaveLength(1);
    const root = mkdtempSync(join(tmpdir(), `kory-${task.id}-starter-`));
    try {
      await materializers[0]!.materialize(root, scenario);
      expect(existsSync(join(root, 'README.md'))).toBe(true);
      const score = await scorers[0]!.score({
        scenario,
        experiment: {} as never,
        workingDirectory: root,
        observation: { output: '', evidence: [], artifacts: [], durationMs: 0 },
      });
      expect(score.passed).toBe(false);
      expect(score.integrityFailure).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test('package-only trigger evidence recognizes the specialized recovery vocabulary', () => {
  const item = packageRevisions().find((revision) => revision.name === packageName)!;
  for (const prompt of [
    'Repair schema drift quarantine in a partner feed.',
    'Fix CDC replay and partition checkpoint handling.',
    'Make quarantine reprocessing and pipeline reconciliation idempotent.',
  ]) {
    const contract = createTaskContract(prompt);
    const evidence = collectSkillEvidence(packageRoot, prompt, contract);
    expect(evaluateSkillTrigger(item, prompt, contract, undefined, evidence).matched).toBe(true);
  }
});
