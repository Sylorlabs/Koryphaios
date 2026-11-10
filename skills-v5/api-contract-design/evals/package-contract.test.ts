// Local package and evaluator-contract checks, not model trials or qualification evidence.
import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import {
  API_CONTRACT_DESIGN_SKILL_EVAL_MATERIALIZERS,
  API_CONTRACT_DESIGN_SKILL_EVAL_SCORERS,
} from '../../../backend/src/kory/skill-eval-api-contract-design-fixtures';
import { auditSkillEvalExecutionReadiness } from '../../../backend/src/kory/skill-eval-execution';
import { buildSkillEvalSuiteV3 } from '../../../backend/src/kory/skill-eval-harness';
import {
  loadV5SkillPackages,
  validateV5SkillPackage,
} from '../../../backend/src/kory/skill-packages';
import { createTaskContract } from '../../../backend/src/kory/prompts';
import {
  isDirectSkillSelection,
  resolveSkills,
  type SkillRevision,
} from '../../../backend/src/kory/skills';

const packageRoot = resolve(import.meta.dir, '..');
const unquotedHistoryRegression = 'api-contract-design-heldout-adversarial-unquoted-history';

function validatedPackage() {
  const result = validateV5SkillPackage(packageRoot);
  expect(result.errors).toEqual([]);
  expect(result.warnings).toEqual([]);
  expect(result.valid).toBe(true);
  return result.package!;
}

// Feed validated, current package metadata through the resolver's injection seam.
// This intentionally does not seed personal skills or exercise the shared store loader.
function packageRevisions(): SkillRevision[] {
  const packages = loadV5SkillPackages().packages;
  const byName = new Map(packages.map((pkg) => [pkg.sidecar.name, pkg]));
  const depth = (name: string): number => {
    const parents = byName.get(name)!.sidecar.broader;
    return parents.length ? 1 + Math.max(...parents.map(depth)) : 0;
  };
  return packages.map((pkg) => {
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

test('package resources, source provenance, and hierarchy remain coherent', () => {
  const pkg = validatedPackage();
  expect(pkg.sidecar.broader).toEqual(['developer-experience']);
  expect(pkg.sidecar.requires).toEqual(['verification']);
  expect(pkg.supportingResources).toContain('references/caller-compatibility.md');
  expect(pkg.evaluation.routing.find((row) => row.id === unquotedHistoryRegression)).toMatchObject({
    expectedSelection: false,
    selectionScope: 'direct',
    tags: expect.arrayContaining(['regression', 'unquoted-history']),
  });
  const sourceMap = readFileSync(join(packageRoot, 'references/sources.md'), 'utf8');
  for (const source of pkg.sidecar.sources) expect(sourceMap).toContain(source.url);

  for (const path of ['SKILL.md', 'references/caller-compatibility.md', 'references/sources.md']) {
    const absolute = join(packageRoot, path);
    const markdown = readFileSync(absolute, 'utf8');
    for (const match of markdown.matchAll(/\[[^\]]+\]\(([^)#]+)(?:#[^)]*)?\)/g)) {
      const link = match[1]!;
      if (/^[a-z]+:\/\//i.test(link)) continue;
      const target = resolve(dirname(absolute), link);
      expect(relative(packageRoot, target).startsWith('..'), `${path}: ${link}`).toBe(false);
      expect(existsSync(target), `${path}: ${link}`).toBe(true);
    }
  }
});

test('public and held-out cases route through the real resolver with compiled package metadata', () => {
  const pkg = validatedPackage();
  const root = mkdtempSync(join(tmpdir(), 'kory-api-package-routing-'));
  try {
    const skillRevisions = packageRevisions();
    const cases = [
      ...pkg.sidecar.routing.positive.map((prompt, index) => ({
        id: `public-positive-${index}`,
        prompt,
        expectedSelection: true,
        expectedSkills: [],
      })),
      ...pkg.sidecar.routing.negative.map((prompt, index) => ({
        id: `public-negative-${index}`,
        prompt,
        expectedSelection: false,
        expectedSkills: [],
      })),
      ...pkg.sidecar.routing.ambiguous,
      ...pkg.sidecar.routing.adversarial,
      ...pkg.evaluation.routing,
    ];
    const failures: Array<Record<string, unknown>> = [];
    for (const row of cases) {
      const result = resolveSkills(root, row.prompt, createTaskContract(row.prompt), {
        skillRevisions,
        contextBudget: 60_000,
      });
      const target = result.selected.find((item) => item.skill.name === pkg.sidecar.name);
      const direct = Boolean(target && isDirectSkillSelection(target));
      const selected = result.selected.map((item) => item.skill.name);
      const missing = [
        ...row.expectedSkills,
        ...(direct ? [...pkg.sidecar.broader, ...pkg.sidecar.requires] : []),
      ].filter((name) => !selected.includes(name));
      if (result.blocked || direct !== row.expectedSelection || missing.length) {
        failures.push({
          id: row.id,
          prompt: row.prompt,
          expected: row.expectedSelection,
          direct,
          missing,
          reason: target?.reason,
          selected,
        });
      }
    }
    expect(failures).toEqual([]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('unquoted historical API design must not become direct live ownership', () => {
  const pkg = validatedPackage();
  const row = pkg.evaluation.routing.find((item) => item.id === unquotedHistoryRegression)!;
  const root = mkdtempSync(join(tmpdir(), 'kory-api-history-regression-'));
  try {
    const result = resolveSkills(root, row.prompt, createTaskContract(row.prompt), {
      skillRevisions: packageRevisions(),
      contextBudget: 60_000,
    });
    const target = result.selected.find((item) => item.skill.name === pkg.sidecar.name);
    expect(Boolean(target && isDirectSkillSelection(target)), target?.reason).toBe(false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('task ownership matches registered fixtures and scorers reject defective or rewritten caller contracts', async () => {
  const pkg = validatedPackage();
  const readiness = auditSkillEvalExecutionReadiness(
    [pkg],
    API_CONTRACT_DESIGN_SKILL_EVAL_MATERIALIZERS,
    API_CONTRACT_DESIGN_SKILL_EVAL_SCORERS,
  );
  expect(readiness).toHaveLength(2);
  for (const row of readiness) {
    expect(row.ready, row.reasons.join('\n')).toBe(true);
    expect(row.reasons).toEqual([]);
  }

  const suite = buildSkillEvalSuiteV3(pkg);
  for (const scenario of suite.scenarios.filter((item) => item.category === 'full-task')) {
    const isExport = scenario.id === 'api-contract-design-full-task-1-individual';
    const normative = isExport ? 'contract-context.md' : 'compatibility-contract.md';
    const source = isExport ? 'src/export-contract.ts' : 'src/events-contract.ts';
    const tests = isExport ? 'tests/export-contract.test.ts' : 'tests/events-contract.test.ts';
    for (const path of [normative, source, tests]) expect(scenario.prompt).toContain(path);
    expect(scenario.requiredArtifacts).toContain(source);
    expect(scenario.requiredArtifacts).toContain(tests);
    expect(
      scenario.falsifiableChecks.some((check) => check.id === 'normative-input-integrity'),
    ).toBe(true);
    expect(
      scenario.falsifiableChecks.some((check) => check.id === 'executed-regression-rejection'),
    ).toBe(true);
    expect(scenario.requiredEvidence.join('\n')).toContain('supplied by the evaluator');

    const materializer = API_CONTRACT_DESIGN_SKILL_EVAL_MATERIALIZERS.find((item) =>
      item.matches(scenario),
    )!;
    const scorer = API_CONTRACT_DESIGN_SKILL_EVAL_SCORERS.find((item) =>
      item.scenarioIds.includes(scenario.id),
    )!;
    const root = mkdtempSync(join(tmpdir(), 'kory-api-package-fixture-'));
    try {
      await materializer.materialize(root, scenario);
      for (const path of [normative, source, tests])
        expect(existsSync(join(root, path))).toBe(true);
      const originalSource = readFileSync(join(root, source), 'utf8');
      const originalContract = readFileSync(join(root, normative), 'utf8');
      const score = () =>
        scorer.score({ workingDirectory: root } as Parameters<typeof scorer.score>[0]);
      const defective = await score();
      expect(defective.passed).toBe(false);
      expect(defective.integrityFailure).toBe(false);
      expect(readFileSync(join(root, source), 'utf8')).toBe(originalSource);
      expect(readFileSync(join(root, normative), 'utf8')).toBe(originalContract);

      writeFileSync(join(root, normative), `${originalContract}\nExtra rollout notes\n`);
      const rewritten = await score();
      expect(rewritten).toMatchObject({ passed: false, integrityFailure: true });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});
