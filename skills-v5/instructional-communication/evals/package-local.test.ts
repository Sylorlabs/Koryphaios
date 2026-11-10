// Package-local contract and evaluator-integrity checks, not campaign or qualification evidence.
import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createTaskContract } from '../../../backend/src/kory/prompts';
import {
  REPOSITORY_COMMUNICATION_SKILL_EVAL_MATERIALIZERS,
  REPOSITORY_COMMUNICATION_SKILL_EVAL_SCORERS,
} from '../../../backend/src/kory/skill-eval-repository-communication-fixtures';
import {
  SEALED_EVIDENCE_SKILL_EVAL_MATERIALIZERS,
  SEALED_EVIDENCE_SKILL_EVAL_SCORERS,
} from '../../../backend/src/kory/skill-eval-sealed-evidence-fixtures';
import { buildSkillEvalSuiteV3 } from '../../../backend/src/kory/skill-eval-harness';
import {
  loadV5SkillPackages,
  validateV5SkillPackage,
} from '../../../backend/src/kory/skill-packages';
import {
  isDirectSkillSelection,
  resolveSkills,
  type KorySkillMetadata,
  type SkillRevision,
} from '../../../backend/src/kory/skills';

const packageDirectory = resolve(import.meta.dir, '..');
const packageValidation = validateV5SkillPackage(packageDirectory);
if (!packageValidation.package) throw new Error(packageValidation.errors.join('\n'));
const pkg = packageValidation.package;

function packageRevisions(): SkillRevision[] {
  const catalog = loadV5SkillPackages();
  const byName = new Map(catalog.packages.map((item) => [item.sidecar.name, item]));
  const depth = (name: string, seen = new Set<string>()): number => {
    if (seen.has(name)) return 0;
    const parents = byName.get(name)?.sidecar.broader ?? [];
    return parents.length
      ? 1 + Math.max(...parents.map((parent) => depth(parent, new Set([...seen, name]))))
      : 0;
  };
  return catalog.packages.map((item): SkillRevision => {
    const contentHash = createHash('sha256').update(item.sourceContent).digest('hex');
    return {
      name: item.sidecar.name,
      description: item.definition.description,
      source: 'project',
      state: 'active',
      path: item.sourcePath,
      storageVersion: 1,
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
      metadata: {
        ...item.sidecar,
        baseVersion: item.sidecar.version,
        baseHash: contentHash,
        parent: item.sidecar.broader[0],
        depth: depth(item.sidecar.name),
        sourceScope: 'local-only',
        shouldTrigger: item.sidecar.routing.positive,
        shouldNotTrigger: item.sidecar.routing.negative,
      } as unknown as KorySkillMetadata,
      hash: contentHash,
      validation: { valid: true, errors: [], warnings: [], ignoredAuthorityClaims: [] },
    };
  });
}

test('package, source map, and full-task contracts are promotion-ready locally', () => {
  expect(packageValidation.valid, packageValidation.errors.join('\n')).toBe(true);
  expect(packageValidation.warnings).toEqual([]);
  expect(pkg.sidecar.authoringMaturity).toBe('individual');
  expect(pkg.sidecar.sources.map((source) => source.url)).toEqual(
    expect.arrayContaining([
      'https://developers.google.com/style/accessibility',
      'https://www.w3.org/WAI/fundamentals/accessibility-intro/',
    ]),
  );

  const sourceMap = readFileSync(join(packageDirectory, 'references/sources.md'), 'utf8');
  for (const source of pkg.sidecar.sources) expect(sourceMap).toContain(source.url);

  expect(pkg.evaluation.tasks.map((task) => task.id).sort()).toEqual([
    'instructional-communication-full-task-1-individual',
    'instructional-communication-full-task-2-individual',
  ]);
  for (const task of pkg.evaluation.tasks) {
    expect(task.falsifiableChecks).toHaveLength(6);
    expect(task.falsifiableChecks.map((check) => check.id)).toEqual([
      'scope-and-hierarchy',
      'operating-contract',
      'execution-invariant',
      'verification-discipline',
      'anti-pattern-resistance',
      'evidence-and-uncertainty',
    ]);
    expect(task.prompt).toMatch(/audience|operator|developer/iu);
    expect(task.prompt).toMatch(/feedback/iu);
    expect(task.prompt).toMatch(/recovery|rollback/iu);
    expect(task.requiredEvidence.join('\n')).toMatch(/audience|permissions/iu);
    expect(task.requiredEvidence.join('\n')).toMatch(/feedback|liveness/iu);
    expect(task.requiredEvidence.join('\n')).toMatch(/accessible equivalent/iu);
    expect(task.scorers.reduce((sum, scorer) => sum + scorer.weight, 0)).toBeCloseTo(1);
    expect(
      task.scorers.some(
        (scorer) =>
          scorer.kind === 'blind-semantic' &&
          scorer.blindTo?.includes('skill-variant') &&
          scorer.blindTo?.includes('expected-outcome'),
      ),
    ).toBe(true);
  }
});

test('all public and held-out routing cases preserve the package boundary', () => {
  const root = mkdtempSync(join(tmpdir(), 'instructional-communication-routing-'));
  try {
    const revisions = packageRevisions();
    const cases = [
      ...pkg.sidecar.routing.positive.map((prompt, index) => ({
        id: `public-positive-${index}`,
        prompt,
        expectedSelection: true,
        expectedSkills: [],
        forbiddenSkills: [],
      })),
      ...pkg.sidecar.routing.negative.map((prompt, index) => ({
        id: `public-negative-${index}`,
        prompt,
        expectedSelection: false,
        expectedSkills: [],
        forbiddenSkills: [],
      })),
      ...pkg.sidecar.routing.ambiguous,
      ...pkg.sidecar.routing.adversarial,
      ...pkg.evaluation.routing,
    ];
    const failures: unknown[] = [];
    for (const row of cases) {
      const result = resolveSkills(root, row.prompt, createTaskContract(row.prompt), {
        skillRevisions: revisions,
        contextBudget: 60_000,
      });
      const target = result.selected.find((item) => item.skill.name === pkg.sidecar.name);
      const direct = Boolean(target && isDirectSkillSelection(target));
      const selected = result.selected.map((item) => item.skill.name);
      const missing = row.expectedSkills.filter((name) => !selected.includes(name));
      const forbidden = row.forbiddenSkills.filter((name) => selected.includes(name));
      if (
        result.blocked ||
        direct !== row.expectedSelection ||
        missing.length ||
        forbidden.length
      ) {
        failures.push({
          id: row.id,
          direct,
          missing,
          forbidden,
          selected,
          reason: target?.reason,
        });
      }
    }
    expect(failures).toEqual([]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('both full-task evaluator starters are registered and reject incomplete output', async () => {
  const scenarios = buildSkillEvalSuiteV3(pkg).scenarios.filter(
    (scenario) => scenario.category === 'full-task',
  );
  expect(scenarios).toHaveLength(2);
  const roots: string[] = [];
  try {
    for (const scenario of scenarios) {
      const repositoryFixture = REPOSITORY_COMMUNICATION_SKILL_EVAL_MATERIALIZERS.find((item) =>
        item.matches(scenario),
      );
      const sealedFixture = SEALED_EVIDENCE_SKILL_EVAL_MATERIALIZERS.find((item) =>
        item.matches(scenario),
      );
      const materializer = repositoryFixture ?? sealedFixture;
      const repositoryScorer = REPOSITORY_COMMUNICATION_SKILL_EVAL_SCORERS.find((item) =>
        item.scenarioIds.includes(scenario.id),
      );
      const sealedScorer = SEALED_EVIDENCE_SKILL_EVAL_SCORERS.find((item) =>
        item.scenarioIds.includes(scenario.id),
      );
      const scorer = repositoryScorer ?? sealedScorer;
      expect(materializer, scenario.id).toBeDefined();
      expect(scorer, scenario.id).toBeDefined();
      const root = mkdtempSync(join(tmpdir(), 'instructional-communication-eval-'));
      roots.push(root);
      await materializer!.materialize(root, scenario);
      const score = await scorer!.score({
        scenario,
        experiment: {} as never,
        workingDirectory: root,
        observation: { output: '', evidence: [], artifacts: [], durationMs: 0 },
      });
      expect(score.passed, scenario.id).toBe(false);
      expect(score.integrityFailure, scenario.id).toBe(false);
    }
  } finally {
    for (const root of roots) rmSync(root, { recursive: true, force: true });
  }
});
