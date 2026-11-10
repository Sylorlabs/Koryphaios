/** Package-local contract checks; these are not qualification or blind-review runs. */
import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { createTaskContract } from '../../../backend/src/kory/prompts';
import { validateV5SkillPackage } from '../../../backend/src/kory/skill-packages';
import {
  collectSkillEvidence,
  evaluateSkillTrigger,
  type SkillRevision,
} from '../../../backend/src/kory/skills';

const packageRoot = resolve(import.meta.dir, '..');
const validation = validateV5SkillPackage(packageRoot);
if (!validation.valid || !validation.package) {
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

const sourceUrls = new Set(sidecar.sources.map((source) => source.url));
const sourceMap = readFileSync(join(packageRoot, 'references/sources.md'), 'utf8');

test('package schema and maintained source provenance validate without warnings', () => {
  expect(validation.errors).toEqual([]);
  expect(validation.warnings).toEqual([]);
  expect(sidecar.version).toBe('5.1.5');
  expect(new Set(sidecar.sources.map((source) => source.url)).size).toBe(sidecar.sources.length);
  for (const source of sidecar.sources) {
    expect(sourceMap).toContain(source.url);
    expect(sourceMap).toContain(
      `Verified: ${source.verifiedAt}; refresh after ${source.staleAfterDays} days.`,
    );
  }
});

test('package Markdown links stay inside the package and pass the maintained prose signal', () => {
  const files = ['SKILL.md', 'references/sources.md'];
  let localLinks = 0;
  for (const file of files) {
    const markdown = readFileSync(join(packageRoot, file), 'utf8');
    for (const match of markdown.matchAll(/\[[^\]]+\]\(([^)#]+)(?:#[^)]*)?\)/gu)) {
      const link = match[1]!;
      if (/^[a-z]+:\/\//iu.test(link)) continue;
      const target = resolve(dirname(join(packageRoot, file)), link);
      const local = relative(packageRoot, target);
      expect(isAbsolute(local) || local === '..' || local.startsWith('../')).toBe(false);
      expect(existsSync(target), `${file}: ${link}`).toBe(true);
      localLinks++;
    }
  }
  expect(localLinks).toBeGreaterThan(0);
});

const packageRoutingCases = [
  ...sidecar.routing.positive.map((prompt, index) => ({
    id: `positive-${index + 1}`,
    prompt,
    expectedSelection: true,
  })),
  ...sidecar.routing.negative.map((prompt, index) => ({
    id: `negative-${index + 1}`,
    prompt,
    expectedSelection: false,
  })),
  ...sidecar.routing.ambiguous,
  ...sidecar.routing.adversarial,
  ...pkg.evaluation.routing,
];

for (const row of packageRoutingCases) {
  test(`package-only trigger boundary: ${row.id}`, () => {
    const contract = createTaskContract(row.prompt);
    const evidence = collectSkillEvidence(packageRoot, row.prompt, contract);
    const result = evaluateSkillTrigger(revision, row.prompt, contract, undefined, evidence);
    expect(result.matched, `${row.prompt}\n${result.reason}`).toBe(row.expectedSelection);
  });
}

test('routing corpus covers operational failure modes and scope boundaries', () => {
  expect(pkg.evaluation.routing).toHaveLength(16);
  expect(pkg.evaluation.routing.filter((row) => row.category === 'positive')).toHaveLength(5);
  expect(pkg.evaluation.routing.filter((row) => row.category === 'negative')).toHaveLength(5);
  expect(pkg.evaluation.routing.filter((row) => row.category === 'ambiguous')).toHaveLength(3);
  expect(pkg.evaluation.routing.filter((row) => row.category === 'adversarial')).toHaveLength(3);
  const routingText = pkg.evaluation.routing
    .map((row) => row.prompt)
    .join('\n')
    .toLowerCase();
  for (const term of [
    'partition',
    'fencing',
    'retry',
    'idempot',
    'duplicate',
    'replay',
    'reconciliation',
    'failover',
    'local ipc',
    'compiler runtime',
    'dns',
    'historical',
  ]) {
    expect(routingText, term).toContain(term);
  }
});

test('full-task fixtures require falsifiable authority, retry, replay, and recovery evidence', () => {
  expect(pkg.evaluation.tasks.map((task) => task.id)).toEqual([
    'distributed-backend-full-task-1-individual',
    'distributed-backend-full-task-2-individual',
  ]);
  for (const [index, task] of pkg.evaluation.tasks.entries()) {
    expect(task.requiredArtifacts).toEqual([
      `distributed-backend-individual-scenario-${index + 1}-result`,
      `distributed-backend-individual-scenario-${index + 1}-verification`,
      `distributed-backend-individual-scenario-${index + 1}-paired-evaluation`,
    ]);
    expect(task.scorers.reduce((sum, scorer) => sum + scorer.weight, 0)).toBeCloseTo(1);
    expect(task.scorers.find((scorer) => scorer.kind === 'blind-semantic')?.blindTo).toEqual([
      'skill-variant',
      'expected-outcome',
    ]);
    const ids = task.falsifiableChecks.map((check) => check.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const check of task.falsifiableChecks) {
      if (check.source) expect(sourceUrls.has(check.source), `${task.id}/${check.id}`).toBe(true);
    }
    const contract = [
      task.prompt,
      task.environment.requirements.join(' '),
      task.requiredEvidence.join(' '),
      task.falsifiableChecks.map((check) => check.assertion).join(' '),
    ]
      .join('\n')
      .toLowerCase();
    for (const term of [
      'partition',
      'authority',
      'consistency',
      'idempot',
      'retry',
      'unknown',
      'replay',
      'reconcil',
      'recovery',
      'observed',
      'simulated',
      'unavailable',
    ]) {
      expect(contract, `${task.id}: ${term}`).toContain(term);
    }
  }
});
