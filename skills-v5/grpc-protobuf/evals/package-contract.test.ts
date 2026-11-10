// Local package and evaluator-contract checks, not model trials or qualification evidence.
import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { createTaskContract } from '../../../backend/src/kory/prompts';
import {
  loadV5SkillPackages,
  validateV5SkillPackage,
} from '../../../backend/src/kory/skill-packages';
import {
  isDirectSkillSelection,
  resolveSkills,
  type SkillRevision,
} from '../../../backend/src/kory/skills';

const packageRoot = resolve(import.meta.dir, '..');

function validatedPackage() {
  const result = validateV5SkillPackage(packageRoot);
  expect(result.valid).toBe(true);
  expect(result.errors).toEqual([]);
  expect(result.package).toBeDefined();
  return result.package!;
}

function packageRevisions(): SkillRevision[] {
  const packages = loadV5SkillPackages().packages;
  const byName = new Map(packages.map((pkg) => [pkg.sidecar.name, pkg]));
  const depth = (name: string): number => {
    const parents = byName.get(name)?.sidecar.broader ?? [];
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

test('package validates, all source records are maintained, and task contracts cover the expanded boundary', () => {
  const pkg = validatedPackage();
  const sourceMap = readFileSync(resolve(packageRoot, 'references/sources.md'), 'utf8');

  for (const source of pkg.sidecar.sources) expect(sourceMap).toContain(source.url);
  const sourceUrls = new Set(pkg.sidecar.sources.map((source) => source.url));
  for (const task of pkg.evaluation.tasks) {
    for (const check of task.falsifiableChecks) {
      if (check.source) expect(sourceUrls.has(check.source)).toBe(true);
    }
  }
  expect(pkg.sidecar.broader).toEqual(['api-contract-design']);
  expect(pkg.sidecar.facets).toContain('application-security');
  expect(pkg.sidecar.requires).toEqual(['verification']);
  expect(pkg.sidecar.activation).toEqual(
    expect.arrayContaining([
      'grpc interceptor',
      'protobuf wire compatibility',
      'grpc method routing',
      'grpc metadata security',
    ]),
  );

  const fieldTask = pkg.evaluation.tasks.find((task) => task.id.endsWith('task-1-individual'))!;
  const streamTask = pkg.evaluation.tasks.find((task) => task.id.endsWith('task-2-individual'))!;
  expect(fieldTask.falsifiableChecks.map((check) => check.id)).toEqual(
    expect.arrayContaining(['descriptor-identity', 'migration-precedence']),
  );
  expect(streamTask.falsifiableChecks.map((check) => check.id)).toEqual(
    expect.arrayContaining(['interceptor-and-security', 'routing-and-status']),
  );
  expect(fieldTask.environment.requirements.join('\n')).toContain(
    'normal application decode and encode path',
  );
  expect(streamTask.environment.requirements.join('\n')).toContain(
    'ordered server interceptor harness',
  );
});

test('positive and negative routing cases exercise the real resolver with hierarchy dependencies', () => {
  const pkg = validatedPackage();
  const revisions = packageRevisions();
  const cases = [
    ...pkg.sidecar.routing.positive.map((prompt) => ({ prompt, expected: true })),
    ...pkg.sidecar.routing.negative.map((prompt) => ({ prompt, expected: false })),
    ...pkg.sidecar.routing.ambiguous.map((row) => ({
      prompt: row.prompt,
      expected: row.expectedSelection,
    })),
    ...pkg.sidecar.routing.adversarial.map((row) => ({
      prompt: row.prompt,
      expected: row.expectedSelection,
    })),
    ...pkg.evaluation.routing.map((row) => ({
      prompt: row.prompt,
      expected: row.expectedSelection,
    })),
  ];
  const scratch = mkdtempSync(`${tmpdir()}/grpc-protobuf-package-routing-`);
  const failures: string[] = [];

  try {
    for (const row of cases) {
      const result = resolveSkills(scratch, row.prompt, createTaskContract(row.prompt), {
        skillRevisions: revisions,
        contextBudget: 60_000,
      });
      const target = result.selected.find((item) => item.skill.name === pkg.sidecar.name);
      const actual = Boolean(target && isDirectSkillSelection(target));
      if (result.blocked || actual !== row.expected || result.hierarchyErrors.length) {
        failures.push(
          `${row.prompt}: expected ${row.expected}, got ${actual}; ${target?.reason ?? 'not selected'}`,
        );
      }
      if (actual) {
        for (const dependency of [...pkg.sidecar.broader, ...pkg.sidecar.requires]) {
          if (!result.selected.some((item) => item.skill.name === dependency)) {
            failures.push(`${row.prompt}: missing required dependency ${dependency}`);
          }
        }
      }
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }

  expect(failures).toEqual([]);
});
