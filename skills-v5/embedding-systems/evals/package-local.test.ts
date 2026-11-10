/**
 * Package-local authoring and evaluator-contract checks. These are not provider
 * probes, benchmark results, or qualification/campaign evidence.
 */
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
if (!validation.package) throw new Error(validation.errors.join('\n'));
const pkg = validation.package;
const sidecar = pkg.sidecar;

const revision: SkillRevision = {
  name: sidecar.name,
  description: pkg.definition.description,
  source: 'project',
  state: 'active',
  path: pkg.sourcePath,
  storageVersion: 1,
  document: { kind: 'markdown', extension: 'md', renderer: 'markdown', mediaType: 'text/markdown' },
  sourceContent: pkg.sourceContent,
  coreInstructions: pkg.instructions,
  content: pkg.sourceContent,
  instructions: pkg.instructions,
  hash: createHash('sha256').update(pkg.sourceContent).digest('hex'),
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

test('package validates, cites every source, and keeps the evidence contract local', () => {
  expect(validation.errors).toEqual([]);
  expect(validation.warnings).toEqual([]);
  expect(sidecar.broader).toEqual(['implementation']);
  expect(sidecar.requires).toContain('ml-evaluation');
  expect(sidecar.routing.ambiguous.map((item) => item.adjacentSkills).flat()).toEqual(
    expect.arrayContaining(['vector-search-systems', 'rag-retrieval-systems', 'computer-vision']),
  );
  expect(sidecar.routing.negative.join('\n')).toContain('HNSW');
  expect(pkg.supportingResources).toContain('references/evidence-contract.md');

  const sourceMap = readFileSync(join(packageRoot, 'references/sources.md'), 'utf8');
  expect(sourceMap).toContain('[the evidence contract](evidence-contract.md)');
  expect(sourceMap).toContain('documented provider/model fact');
  expect(sourceMap).toContain('stable representation ID');
  for (const source of sidecar.sources) {
    expect(sourceMap).toContain(source.url);
    expect(sourceMap).toContain(
      `Verified: ${source.verifiedAt}; refresh after ${source.staleAfterDays} days.`,
    );
  }
});

test('authored Markdown links stay inside the package', () => {
  for (const file of [
    'SKILL.md',
    ...pkg.supportingResources.filter((item) => item.endsWith('.md')),
  ]) {
    const absolute = join(packageRoot, file);
    const markdown = readFileSync(absolute, 'utf8');
    for (const [, link] of markdown.matchAll(/\[[^\]]+\]\(([^)#]+)(?:#[^)]*)?\)/gu)) {
      if (/^[a-z]+:\/\//iu.test(link!)) continue;
      const target = resolve(dirname(absolute), link!);
      const local = relative(packageRoot, target);
      expect(isAbsolute(local) || local === '..' || local.startsWith('../')).toBe(false);
      expect(existsSync(target), `${file}: ${link}`).toBe(true);
    }
  }
});

const routingCases = [
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

for (const row of routingCases) {
  test(`package-local routing boundary: ${row.id}`, () => {
    const contract = createTaskContract(row.prompt);
    const evidence = collectSkillEvidence(packageRoot, row.prompt, contract);
    const result = evaluateSkillTrigger(revision, row.prompt, contract, undefined, evidence);
    expect(result.matched, `${row.prompt}\n${result.reason}`).toBe(row.expectedSelection);
  });
}

test('full-task fixtures require the representation/index seam and evidence separation', () => {
  expect(pkg.evaluation.tasks.map((task) => task.id)).toEqual([
    'embedding-systems-full-task-1-individual',
    'embedding-systems-full-task-2-individual',
  ]);

  const requiredEvidence = [
    'Documented provider/model facts separated from observed behavior, empirical results and unavailable evidence',
    'Representation manifest and explicit embedding/index compatibility checks',
  ];
  for (const task of pkg.evaluation.tasks) {
    expect(new Set(task.falsifiableChecks.map((check) => check.id)).size).toBe(
      task.falsifiableChecks.length,
    );
    expect(task.falsifiableChecks).toHaveLength(6);
    for (const evidence of requiredEvidence) expect(task.requiredEvidence).toContain(evidence);
    expect(task.environment.requirements.join('\n')).toContain('representation manifest');
    expect(task.environment.requirements.join('\n')).toContain('provider fact');
    expect(task.prompt).toContain('embedding-systems');
  }
});
