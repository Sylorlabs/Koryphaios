// Package-local authoring and evaluator-integrity checks, not training runs or qualification evidence.
import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { createTaskContract } from '../../../backend/src/kory/prompts';
import {
  MODEL_DATA_SKILL_EVAL_MATERIALIZERS,
  MODEL_DATA_SKILL_EVAL_SCORERS,
} from '../../../backend/src/kory/skill-eval-model-data-concept-fixtures';
import { buildSkillEvalSuiteV3 } from '../../../backend/src/kory/skill-eval-harness';
import {
  loadV5SkillPackages,
  validateV5SkillPackage,
} from '../../../backend/src/kory/skill-packages';
import {
  isDirectSkillSelection,
  resolveSkills,
  type SkillRevision,
} from '../../../backend/src/kory/skills';

const packageDirectory = resolve(import.meta.dir, '..');
const projectRoot = resolve(packageDirectory, '../..');
const validation = validateV5SkillPackage(packageDirectory);
if (!validation.package) throw new Error(validation.errors.join('\n'));
const pkg = validation.package;

function packageRevisions(): SkillRevision[] {
  const packages = loadV5SkillPackages().packages;
  const byName = new Map(packages.map((item) => [item.sidecar.name, item]));
  const depth = (name: string): number => {
    const parents = byName.get(name)!.sidecar.broader;
    return parents.length ? 1 + Math.max(...parents.map(depth)) : 0;
  };
  return packages.map((item) => {
    const hash = createHash('sha256').update(item.sourceContent).digest('hex');
    return {
      name: item.sidecar.name,
      description: item.definition.description,
      source: 'project',
      state: 'active',
      path: item.sourcePath,
      storageVersion: 1,
      document: {
        format: 'markdown',
        extension: '.md',
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
        baseHash: hash,
        parent: item.sidecar.broader[0],
        depth: depth(item.sidecar.name),
        sourceScope: 'local-only',
        shouldTrigger: item.sidecar.routing.positive,
        shouldNotTrigger: item.sidecar.routing.negative,
      },
      hash,
      validation: { valid: true, errors: [], warnings: [], ignoredAuthorityClaims: [] },
    } as SkillRevision;
  });
}

test('package, sources, task contracts, and local links are promotion-oriented and current', () => {
  expect(validation.valid, validation.errors.join('\n')).toBe(true);
  expect(validation.errors).toEqual([]);
  expect(validation.warnings).toEqual([]);
  expect(pkg.sidecar.name).toBe('fine-tuning-training');
  expect(pkg.sidecar.broader).toEqual(['implementation']);
  expect(pkg.sidecar.requires).toEqual(['verification', 'ml-evaluation']);
  expect(pkg.evaluation.tasks.map((task) => task.id)).toEqual([
    'fine-tuning-training-full-task-1-individual',
    'fine-tuning-training-full-task-2-individual',
  ]);

  const sourceMap = readFileSync(join(packageDirectory, 'references/sources.md'), 'utf8');
  for (const source of pkg.sidecar.sources) {
    expect(sourceMap).toContain(`: ${source.url}`);
    expect(sourceMap).toContain(
      `Verified: ${source.verifiedAt}; refresh after ${source.staleAfterDays} days.`,
    );
  }

  const markdownFiles = ['SKILL.md', 'references/sources.md', 'evals/README.md'];
  for (const path of markdownFiles) {
    const absolutePath = join(packageDirectory, path);
    const markdown = readFileSync(absolutePath, 'utf8');
    for (const [, link] of markdown.matchAll(/\[[^\]]+\]\(([^)#]+)(?:#[^)]*)?\)/g)) {
      if (/^[a-z]+:/i.test(link!)) continue;
      const target = resolve(dirname(absolutePath), link!);
      expect(isAbsolute(relative(packageDirectory, target))).toBe(false);
      expect(relative(packageDirectory, target).startsWith('..')).toBe(false);
      expect(existsSync(target), target).toBe(true);
    }
  }
});

test('routing cases use the real resolver and preserve conditional ownership', () => {
  const root = mkdtempSync(join(tmpdir(), 'fine-tuning-training-routing-'));
  const previousHome = process.env.KORYPHAIOS_SKILLS_HOME;
  try {
    process.env.KORYPHAIOS_SKILLS_HOME = join(root, 'skills');
    const revisions = packageRevisions();
    const failures: unknown[] = [];
    for (const row of pkg.evaluation.routing) {
      const result = resolveSkills(projectRoot, row.prompt, createTaskContract(row.prompt), {
        skillRevisions: revisions,
        contextBudget: 60_000,
      });
      const target = result.selected.find((item) => item.skill.name === pkg.sidecar.name);
      const selected = result.selected.map((item) => item.skill.name);
      const direct = Boolean(target && isDirectSkillSelection(target));
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
          selected,
          missing,
          forbidden,
          reason: target?.reason,
        });
      }
    }
    expect(failures).toEqual([]);
  } finally {
    if (previousHome === undefined) delete process.env.KORYPHAIOS_SKILLS_HOME;
    else process.env.KORYPHAIOS_SKILLS_HOME = previousHome;
    rmSync(root, { recursive: true, force: true });
  }
});

test('task contracts name leakage, fixed-boundary comparison, and explicit evidence gaps', () => {
  const suite = buildSkillEvalSuiteV3(pkg);
  const tasks = suite.scenarios.filter((scenario) => scenario.category === 'full-task');
  expect(tasks).toHaveLength(2);
  for (const task of tasks) {
    const text = [task.prompt, ...task.falsifiableChecks.map((check) => check.assertion)].join(
      '\n',
    );
    expect(text).toMatch(/holdout|hold-out/i);
    expect(text).toMatch(/leak|contaminat/i);
    expect(text).toMatch(/base model/i);
    expect(text).toMatch(/serving|latency|memory|cost/i);
    expect(text).toMatch(/rollback/i);
    expect(text).toMatch(/simulated|unavailable|inferred|stale|unresolved/i);
    expect(task.requiredEvidence.join('\n')).toMatch(/provenance|leakage/i);
  }
});

test('synthetic scorers reject incomplete candidates and fail closed on fixed-input tampering', async () => {
  const suite = buildSkillEvalSuiteV3(pkg);
  for (const scenario of suite.scenarios.filter((item) => item.category === 'full-task')) {
    const materializer = MODEL_DATA_SKILL_EVAL_MATERIALIZERS.find((item) => item.matches(scenario));
    const scorer = MODEL_DATA_SKILL_EVAL_SCORERS.find((item) =>
      item.scenarioIds.includes(scenario.id),
    );
    expect(materializer).toBeDefined();
    expect(scorer).toBeDefined();
    const root = mkdtempSync(join(tmpdir(), 'fine-tuning-training-integrity-'));
    try {
      await materializer!.materialize(root, scenario);
      const contract = JSON.parse(readFileSync(join(root, 'contract.json'), 'utf8'));
      expect(contract).toMatchObject({ scenarioId: scenario.id, evidence: 'synthetic' });
      expect(readFileSync(join(root, 'README.md'), 'utf8')).toMatch(/synthetic|no network/i);

      const score = () =>
        scorer!.score({
          scenario,
          experiment: {} as never,
          workingDirectory: root,
          observation: { output: '', evidence: [], artifacts: [], durationMs: 0 },
        });
      const incomplete = await score();
      expect(incomplete.passed).toBe(false);
      expect(incomplete.integrityFailure).toBe(false);

      writeFileSync(join(root, 'README.md'), 'tampered evaluator contract\n');
      const tampered = await score();
      expect(tampered.passed).toBe(false);
      expect(tampered.integrityFailure).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});
