/**
 * Package-local authoring and evaluator-integrity checks only.
 *
 * These checks use synthetic fixtures and registered scorers. They are not model
 * runs, paired qualification evidence, blind review, or a promotion result.
 */
import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { createTaskContract } from '../../../backend/src/kory/prompts';
import {
  CONTRACT_CONCURRENCY_SKILL_EVAL_MATERIALIZERS,
  CONTRACT_CONCURRENCY_SKILL_EVAL_SCORERS,
} from '../../../backend/src/kory/skill-eval-contract-concurrency-fixtures';
import { auditSkillEvalExecutionReadiness } from '../../../backend/src/kory/skill-eval-execution';
import {
  buildSkillEvalSuiteV3,
  type SkillEvalScenarioV3,
} from '../../../backend/src/kory/skill-eval-harness';
import {
  loadV5SkillPackages,
  validateV5SkillPackage,
  type V5CompiledSkillPackage,
} from '../../../backend/src/kory/skill-packages';
import {
  isDirectSkillSelection,
  resolveSkills,
  type SkillRevision,
} from '../../../backend/src/kory/skills';

const packageDirectory = resolve(import.meta.dir, '..');
const projectRoot = resolve(packageDirectory, '../..');

function validatedPackage(): V5CompiledSkillPackage {
  const result = validateV5SkillPackage(packageDirectory);
  expect(result.valid, result.errors.join('\n')).toBe(true);
  expect(result.errors).toEqual([]);
  expect(result.warnings).toEqual([]);
  expect(result.package).toBeDefined();
  return result.package!;
}

function packageRevisions(): SkillRevision[] {
  const catalog = loadV5SkillPackages();
  const byName = new Map(catalog.packages.map((pkg) => [pkg.sidecar.name, pkg]));
  const depth = (name: string): number => {
    const parents = byName.get(name)?.sidecar.broader ?? [];
    return parents.length ? 1 + Math.max(...parents.map(depth)) : 0;
  };
  return catalog.packages.map((pkg) => {
    const hash = createHash('sha256').update(pkg.sourceContent).digest('hex');
    return {
      name: pkg.sidecar.name,
      description: pkg.definition.description,
      source: 'project',
      state: 'active',
      path: pkg.sourcePath,
      storageVersion: 1,
      document: {
        format: 'markdown',
        extension: '.md',
        renderer: 'markdown',
        mediaType: 'text/markdown',
      },
      sourceContent: pkg.sourceContent,
      coreInstructions: pkg.instructions,
      content: pkg.sourceContent,
      instructions: pkg.instructions,
      metadata: {
        ...pkg.sidecar,
        baseVersion: pkg.sidecar.version,
        baseHash: hash,
        parent: pkg.sidecar.broader[0],
        depth: depth(pkg.sidecar.name),
        sourceScope: 'local-only',
        shouldTrigger: pkg.sidecar.routing.positive,
        shouldNotTrigger: pkg.sidecar.routing.negative,
      },
      hash,
      validation: { valid: true, errors: [], warnings: [], ignoredAuthorityClaims: [] },
    };
  });
}

function localMarkdownTargets(path: string): string[] {
  const markdown = readFileSync(path, 'utf8');
  return [...markdown.matchAll(/\[[^\]]+\]\(([^)#]+)(?:#[^)]*)?\)/g)]
    .map((match) => match[1]!)
    .filter((target) => !/^[a-z]+:\/\//i.test(target));
}

test('package structure, source provenance, and evidence boundary validate cleanly', () => {
  const pkg = validatedPackage();
  expect(pkg.sidecar.authoringMaturity).toBe('individual');
  expect(pkg.evaluation.tasks.map((task) => task.id)).toEqual([
    'deterministic-contract-testing-full-task-1',
    'deterministic-contract-testing-full-task-2',
  ]);
  expect(pkg.supportingResources).toContain('evals/README.md');
  expect(pkg.supportingResources).toContain('evals/fixture-integrity.test.ts');

  const sourceMap = readFileSync(join(packageDirectory, 'references/sources.md'), 'utf8');
  for (const source of pkg.sidecar.sources) {
    expect(sourceMap).toContain(source.url);
    expect(sourceMap).toContain(source.verifiedAt);
    expect(sourceMap).toContain(`Refresh: ${source.staleAfterDays} days`);
  }

  for (const file of ['SKILL.md', 'references/sources.md', 'evals/README.md']) {
    const absolute = join(packageDirectory, file);
    for (const target of localMarkdownTargets(absolute)) {
      const destination = resolve(dirname(absolute), target);
      const withinPackage = relative(packageDirectory, destination);
      expect(withinPackage === '..' || withinPackage.startsWith('../')).toBe(false);
      expect(existsSync(destination), `${file}: ${target}`).toBe(true);
    }
  }

  for (const task of pkg.evaluation.tasks) {
    expect(task.scorers.reduce((sum, scorer) => sum + scorer.weight, 0)).toBeCloseTo(1);
    expect(task.scorers.some((scorer) => scorer.kind === 'deterministic')).toBe(true);
    expect(
      task.scorers.some(
        (scorer) =>
          scorer.kind === 'blind-semantic' &&
          scorer.blindTo?.includes('skill-variant') &&
          scorer.blindTo?.includes('expected-outcome'),
      ),
    ).toBe(true);
    expect(task.requiredEvidence.join('\n')).toContain('synthetic/local');
    expect(task.requiredEvidence.join('\n')).toContain('unavailable');
    expect(task.requiredEvidence.join('\n')).toContain('unexecuted');
    expect(task.requiredEvidence.join('\n')).toContain('blind-review');
  }
});

test('authored and held-out routing cases use the real resolver with direct ownership checks', () => {
  const pkg = validatedPackage();
  const revisions = packageRevisions();
  const cases = [
    ...pkg.sidecar.routing.positive.map((prompt, index) => ({
      id: `public-positive-${index}`,
      prompt,
      expectedSelection: true,
      expectedSkills: [] as string[],
      forbiddenSkills: [] as string[],
      selectionScope: undefined,
    })),
    ...pkg.sidecar.routing.negative.map((prompt, index) => ({
      id: `public-negative-${index}`,
      prompt,
      expectedSelection: false,
      expectedSkills: [] as string[],
      forbiddenSkills: [] as string[],
      selectionScope: undefined,
    })),
    ...pkg.sidecar.routing.ambiguous,
    ...pkg.sidecar.routing.adversarial,
    ...pkg.evaluation.routing,
  ];
  const failures: unknown[] = [];
  for (const row of cases) {
    const result = resolveSkills(projectRoot, row.prompt, createTaskContract(row.prompt), {
      skillRevisions: revisions,
      contextBudget: 60_000,
    });
    const selected = result.selected.map((item) => item.skill.name);
    const target = result.selected.find((item) => item.skill.name === pkg.sidecar.name);
    const actual = Boolean(target && isDirectSkillSelection(target));
    const missing = row.expectedSkills.filter((name) => !selected.includes(name));
    const forbidden = row.forbiddenSkills.filter((name) => selected.includes(name));
    if (
      result.blocked ||
      result.hierarchyErrors.length ||
      actual !== row.expectedSelection ||
      missing.length ||
      forbidden.length
    ) {
      failures.push({
        id: row.id,
        blocked: result.blocked,
        hierarchyErrors: result.hierarchyErrors,
        expected: row.expectedSelection,
        actual,
        missing,
        forbidden,
        selected,
        reason: target?.reason,
      });
    }
  }
  expect(failures).toEqual([]);
});

test('registered full-task fixtures are ready and remain explicitly synthetic', () => {
  const pkg = validatedPackage();
  const readiness = auditSkillEvalExecutionReadiness(
    [pkg],
    CONTRACT_CONCURRENCY_SKILL_EVAL_MATERIALIZERS,
    CONTRACT_CONCURRENCY_SKILL_EVAL_SCORERS,
  );
  expect(readiness).toHaveLength(2);
  for (const row of readiness) {
    expect(row.ready, row.reasons.join('\n')).toBe(true);
    expect(row.reasons).toEqual([]);
    expect(row.startingState).toMatch(/^fixture:\//u);
    expect(row.materializerId).toBeTruthy();
    expect(row.deterministicScorerId).toBeTruthy();
  }

  const suite = buildSkillEvalSuiteV3(pkg);
  expect(suite.scenarios.filter((scenario) => scenario.category === 'full-task')).toHaveLength(2);
  for (const scenario of suite.scenarios.filter((item) => item.category === 'full-task')) {
    expect(scenario.environment.kind).toBe('synthetic');
    expect(scenario.prompt).toContain('Do not');
    expect(scenario.requiredEvidence.join('\n')).toContain('synthetic/local');
    expect(scenario.requiredEvidence.join('\n')).toContain('unavailable');
  }
});

test('registered scorers reject missing evidence and detect evaluator-input tampering', async () => {
  const pkg = validatedPackage();
  const roots: string[] = [];
  try {
    for (const task of pkg.evaluation.tasks) {
      const scenario = buildSkillEvalSuiteV3(pkg).scenarios.find(
        (item) => item.id === task.id,
      ) as SkillEvalScenarioV3;
      const materializer = CONTRACT_CONCURRENCY_SKILL_EVAL_MATERIALIZERS.find((item) =>
        item.matches(scenario),
      );
      const scorer = CONTRACT_CONCURRENCY_SKILL_EVAL_SCORERS.find((item) =>
        item.scenarioIds.includes(task.id),
      );
      expect(materializer).toBeDefined();
      expect(scorer).toBeDefined();
      const root = mkdtempSync(join(tmpdir(), 'kory-deterministic-contract-integrity-'));
      roots.push(root);
      await materializer!.materialize(root, scenario);
      const score = () =>
        scorer!.score({ workingDirectory: root } as Parameters<typeof scorer.score>[0]);

      const missing = await score();
      expect(missing.passed).toBe(false);
      expect(missing.integrityFailure).toBe(false);

      const immutablePath = task.id.endsWith('-1')
        ? 'src/lease.ts'
        : 'schema/job-command.schema.json';
      const original = readFileSync(join(root, immutablePath), 'utf8');
      writeFileSync(join(root, immutablePath), `${original}\n// evaluator-integrity mutation\n`);
      const tampered = await score();
      expect(tampered.passed).toBe(false);
      expect(tampered.integrityFailure).toBe(true);
      writeFileSync(join(root, immutablePath), original);
    }
  } finally {
    for (const root of roots) rmSync(root, { recursive: true, force: true });
  }
});
