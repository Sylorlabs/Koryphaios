// Package-local authoring and evaluator-integrity checks, not qualification evidence.
import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { createTaskContract } from '../../../backend/src/kory/prompts';
import {
  auditSkillEvalExecutionReadiness,
  type SkillEvalFixtureMaterializer,
} from '../../../backend/src/kory/skill-eval-execution';
import {
  BACKEND_STATE_SKILL_EVAL_MATERIALIZERS,
  BACKEND_STATE_SKILL_EVAL_SCORERS,
} from '../../../backend/src/kory/skill-eval-backend-state-fixtures';
import { buildSkillEvalSuiteV3 } from '../../../backend/src/kory/skill-eval-harness';
import { validateV5SkillPackage } from '../../../backend/src/kory/skill-packages';
import {
  collectSkillEvidence,
  evaluateSkillTrigger,
  type SkillRevision,
} from '../../../backend/src/kory/skills';
import { lintProse } from '../../dash-free-writing/scripts/check-prose.mjs';

const packageRoot = resolve(import.meta.dir, '..');
const validation = validateV5SkillPackage(packageRoot);
if (!validation.valid || !validation.package) {
  throw new Error(JSON.stringify({ errors: validation.errors, warnings: validation.warnings }));
}
const pkg = validation.package;
const urls = new Set(pkg.sidecar.sources.map((source) => source.url));

const revision: SkillRevision = {
  name: pkg.sidecar.name,
  description: pkg.definition.description,
  source: 'project',
  state: 'active',
  path: pkg.sourcePath,
  storageVersion: 2,
  document: { kind: 'markdown', extension: 'md', renderer: 'markdown', mediaType: 'text/markdown' },
  sourceContent: pkg.sourceContent,
  coreInstructions: pkg.instructions,
  content: pkg.sourceContent,
  instructions: pkg.instructions,
  hash: createHash('sha256')
    .update(pkg.sourceContent)
    .update(JSON.stringify(pkg.sidecar))
    .digest('hex'),
  validation: { valid: true, errors: [], warnings: [], ignoredAuthorityClaims: [] },
  metadata: {
    version: pkg.sidecar.version,
    baseVersion: pkg.sidecar.version,
    baseHash: '',
    domains: pkg.sidecar.domains,
    targetMedia: pkg.sidecar.targetMedia,
    shouldTrigger: pkg.sidecar.routing.positive,
    shouldNotTrigger: pkg.sidecar.routing.negative,
    evidence: pkg.sidecar.evidence,
    contextBudget: pkg.sidecar.contextBudget,
    sourceScope: 'local-only',
    broader: pkg.sidecar.broader,
    facets: pkg.sidecar.facets,
    depth: 0,
    requires: pkg.sidecar.requires,
    conflicts: pkg.sidecar.conflicts,
    activation: pkg.sidecar.activation,
    excludes: pkg.sidecar.excludes,
    invocationMode: pkg.sidecar.invocationMode,
    pathScopes: pkg.sidecar.pathScopes,
  },
};

function markdownFiles(): string[] {
  return [
    'SKILL.md',
    'references/sources.md',
    'references/lifecycle-contract.md',
    'evals/README.md',
  ];
}

function materializerFor(scenarioId: string): SkillEvalFixtureMaterializer {
  const materializer = BACKEND_STATE_SKILL_EVAL_MATERIALIZERS.find((item) =>
    item.matches({ id: scenarioId } as never),
  );
  if (!materializer) throw new Error(`No materializer registered for ${scenarioId}`);
  return materializer;
}

function scorerFor(scenarioId: string) {
  const scorer = BACKEND_STATE_SKILL_EVAL_SCORERS.find((item) =>
    item.scenarioIds.includes(scenarioId),
  );
  if (!scorer) throw new Error(`No deterministic scorer registered for ${scenarioId}`);
  return scorer;
}

test('package schema, sources, fixtures, and local links validate without warnings', () => {
  expect(validation.errors).toEqual([]);
  expect(validation.warnings).toEqual([]);
  expect(pkg.supportingResources).toContain('references/lifecycle-contract.md');
  expect(pkg.evaluation.tasks).toHaveLength(2);

  const sourceMap = readFileSync(join(packageRoot, 'references/sources.md'), 'utf8');
  for (const source of pkg.sidecar.sources) {
    expect(sourceMap).toContain(source.url);
    expect(sourceMap).toContain(
      `Verified: ${source.verifiedAt}; refresh after ${source.staleAfterDays} days.`,
    );
  }
  for (const task of pkg.evaluation.tasks) {
    expect(new Set(task.falsifiableChecks.map((check) => check.id)).size).toBe(
      task.falsifiableChecks.length,
    );
    for (const check of task.falsifiableChecks) {
      if (check.source) expect(urls.has(check.source), `${task.id}/${check.id}`).toBe(true);
    }
  }

  for (const file of markdownFiles()) {
    const absolute = join(packageRoot, file);
    const markdown = readFileSync(absolute, 'utf8');
    expect(lintProse(markdown).findings, file).toEqual([]);
    for (const match of markdown.matchAll(/\[[^\]]+\]\(([^)#]+)(?:#[^)]*)?\)/gu)) {
      const link = match[1]!;
      if (/^[a-z]+:/iu.test(link)) continue;
      const target = resolve(dirname(absolute), link);
      const local = relative(packageRoot, target);
      expect(
        isAbsolute(local) || local === '..' || local.startsWith('../'),
        `${file}: ${link}`,
      ).toBe(false);
      expect(existsSync(target), `${file}: ${link}`).toBe(true);
    }
  }
});

test('routing cases preserve the live in-process boundary and do not activate explicit exclusions', () => {
  const cases = [
    ...pkg.sidecar.routing.positive.map((prompt, index) => ({
      id: `positive-${index}`,
      prompt,
      expectedSelection: true,
    })),
    ...pkg.sidecar.routing.negative.map((prompt, index) => ({
      id: `negative-${index}`,
      prompt,
      expectedSelection: false,
    })),
    ...pkg.sidecar.routing.ambiguous,
    ...pkg.sidecar.routing.adversarial,
    ...pkg.evaluation.routing,
  ];
  const failures: unknown[] = [];
  for (const row of cases) {
    const contract = createTaskContract(row.prompt);
    const evidence = collectSkillEvidence(packageRoot, row.prompt, contract);
    const result = evaluateSkillTrigger(revision, row.prompt, contract, undefined, evidence);
    if (result.matched !== row.expectedSelection) {
      failures.push({
        id: row.id,
        prompt: row.prompt,
        expected: row.expectedSelection,
        reason: result.reason,
      });
    }
  }
  expect(failures).toEqual([]);
});

test('registered synthetic exercises are ready and reject their supplied defective candidates', async () => {
  const readiness = auditSkillEvalExecutionReadiness(
    [pkg],
    BACKEND_STATE_SKILL_EVAL_MATERIALIZERS,
    BACKEND_STATE_SKILL_EVAL_SCORERS,
  );
  expect(readiness).toHaveLength(2);
  expect(
    readiness.filter((row) => !row.ready),
    JSON.stringify(readiness, null, 2),
  ).toEqual([]);

  const suite = buildSkillEvalSuiteV3(pkg);
  for (const scenario of suite.scenarios.filter((item) => item.category === 'full-task')) {
    const root = mkdtempSync(join(tmpdir(), 'kory-inprocess-package-check-'));
    try {
      await materializerFor(scenario.id).materialize(root, scenario);
      expect(existsSync(join(root, 'README.md'))).toBe(true);
      expect(existsSync(join(root, '.kory-eval'))).toBe(false);
      const score = await scorerFor(scenario.id).score({
        scenario,
        experiment: {} as never,
        workingDirectory: root,
        observation: { output: '', evidence: [], artifacts: [], durationMs: 0 },
      });
      expect(score.passed, `${scenario.id}: ${score.evidence.join('\n')}`).toBe(false);
      expect(score.integrityFailure).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});
