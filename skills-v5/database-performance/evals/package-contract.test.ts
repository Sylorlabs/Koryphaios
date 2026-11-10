/**
 * Package-local authoring and contract checks only. These are not qualification
 * runs, paired baselines, blind reviews, or production database evidence.
 */
import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { createTaskContract } from '../../../backend/src/kory/prompts';
import { buildSkillEvalSuiteV3 } from '../../../backend/src/kory/skill-eval-harness';
import { validateV5SkillPackage } from '../../../backend/src/kory/skill-packages';
import {
  collectSkillEvidence,
  evaluateSkillTrigger,
  type SkillRevision,
} from '../../../backend/src/kory/skills';

const packageRoot = resolve(import.meta.dir, '..');
const validation = validateV5SkillPackage(packageRoot);
if (!validation.package) {
  throw new Error(JSON.stringify({ errors: validation.errors, warnings: validation.warnings }));
}
const pkg = validation.package;
const sidecar = pkg.sidecar;

const revision: SkillRevision = {
  name: sidecar.name,
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
    .update(JSON.stringify(sidecar))
    .digest('hex'),
  validation: { valid: true, errors: [], warnings: [], ignoredAuthorityClaims: [] },
  metadata: {
    version: sidecar.version,
    baseVersion: sidecar.version,
    baseHash: '',
    domains: sidecar.domains,
    targetMedia: sidecar.targetMedia,
    shouldTrigger: sidecar.routing.positive,
    shouldNotTrigger: sidecar.routing.negative,
    evidence: sidecar.evidence,
    contextBudget: sidecar.contextBudget,
    sourceScope: 'local-only',
    broader: sidecar.broader,
    facets: sidecar.facets,
    depth: 0,
    requires: sidecar.requires,
    conflicts: sidecar.conflicts,
    activation: sidecar.activation,
    excludes: sidecar.excludes,
    invocationMode: sidecar.invocationMode,
    pathScopes: sidecar.pathScopes,
  },
};

test('package schema and source freshness validate without warnings', () => {
  expect(validation.valid).toBe(true);
  expect(validation.errors).toEqual([]);
  expect(validation.warnings).toEqual([]);
});

test('source map covers every sidecar source and states evidence limits', () => {
  const sourceMap = readFileSync(resolve(packageRoot, 'references/sources.md'), 'utf8');
  for (const source of sidecar.sources) {
    expect(sourceMap, source.url).toContain(source.url);
    expect(sourceMap, source.url).toContain(
      `Verified: ${source.verifiedAt}; refresh after ${source.staleAfterDays} days.`,
    );
  }
  expect(sourceMap).toContain('**Synthetic**');
  expect(sourceMap).toContain('**Observed live**');
  expect(sourceMap).toContain('**Unavailable**');
  expect(sourceMap).toContain('not real database runs');
});

test('all authored local Markdown links stay inside the package and resolve', () => {
  const files = ['SKILL.md', ...pkg.supportingResources.filter((file) => file.endsWith('.md'))];
  let localLinks = 0;
  for (const file of files) {
    const absolute = resolve(packageRoot, file);
    const markdown = readFileSync(absolute, 'utf8');
    for (const match of markdown.matchAll(/\[[^\]]+\]\(([^)#]+)(?:#[^)]*)?\)/gu)) {
      const link = match[1]!;
      if (/^[a-z]+:\/\//iu.test(link)) continue;
      const target = resolve(dirname(absolute), link);
      const local = relative(packageRoot, target);
      expect(isAbsolute(local) || local.startsWith('..'), `${file}: ${link}`).toBe(false);
      expect(existsSync(target), `${file}: ${link}`).toBe(true);
      localLinks++;
    }
  }
  expect(localLinks).toBeGreaterThan(0);
});

test('routing cases exercise live ownership and explicit verification-only boundary', () => {
  const cases = [
    ...sidecar.routing.positive.map((prompt) => ({ prompt, expected: true })),
    ...sidecar.routing.negative.map((prompt) => ({ prompt, expected: false })),
    ...sidecar.routing.ambiguous,
    ...sidecar.routing.adversarial,
    ...pkg.evaluation.routing,
  ];
  const failures: Array<{ prompt: string; expected: boolean; actual: boolean; reason: string }> =
    [];
  for (const row of cases) {
    const contract = createTaskContract(row.prompt);
    const evidence = collectSkillEvidence(packageRoot, row.prompt, contract);
    const result = evaluateSkillTrigger(revision, row.prompt, contract, undefined, evidence);
    if (result.matched !== row.expectedSelection && result.matched !== row.expected) {
      failures.push({
        prompt: row.prompt,
        expected: 'expectedSelection' in row ? row.expectedSelection : row.expected,
        actual: result.matched,
        reason: result.reason,
      });
    }
  }
  expect(failures).toEqual([]);
  const verificationOnly = pkg.evaluation.routing.find(
    (row) => row.id === 'database-performance-regression-verification-only',
  );
  expect(verificationOnly).toMatchObject({ expectedSelection: false, selectionScope: 'direct' });
});

test('full-task contracts preserve synthetic limits and promotion evidence boundaries', () => {
  const suite = buildSkillEvalSuiteV3(pkg);
  const tasks = suite.scenarios.filter((scenario) => scenario.category === 'full-task');
  expect(tasks.map((task) => task.id)).toEqual([
    'database-performance-full-task-1-individual',
    'database-performance-full-task-2-individual',
  ]);
  expect(tasks.every((task) => task.environment.kind === 'synthetic')).toBe(true);
  for (const task of tasks) {
    expect(task.requiredArtifacts).toEqual([
      `database-performance-individual-scenario-${task.id.endsWith('-1-individual') ? 1 : 2}-result`,
      `database-performance-individual-scenario-${task.id.endsWith('-1-individual') ? 1 : 2}-verification`,
      `database-performance-individual-scenario-${task.id.endsWith('-1-individual') ? 1 : 2}-paired-evaluation`,
    ]);
    expect(task.prompt).toContain('synthetic');
    expect(task.prompt).toMatch(/actual (?:engine\/version|database engine\/version)/u);
    expect(task.requiredEvidence.join('\n')).toContain('unavailable');
    expect(task.falsifiableChecks.map((check) => check.id)).toEqual(
      expect.arrayContaining([
        'scope-and-hierarchy',
        'operating-contract',
        'evidence-and-uncertainty',
      ]),
    );
    expect(new Set(task.falsifiableChecks.map((check) => check.id)).size).toBe(
      task.falsifiableChecks.length,
    );
    for (const check of task.falsifiableChecks) {
      if (check.source)
        expect(sidecar.sources.some((source) => source.url === check.source)).toBe(true);
    }
  }
});
