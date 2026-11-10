/** Package-local contract checks; these are not qualification or campaign evidence. */
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

const packageDirectory = resolve(import.meta.dir, '..');
const validation = validateV5SkillPackage(packageDirectory);
if (!validation.package) throw new Error(validation.errors.join('\n'));
const pkg = validation.package;
const sidecar = pkg.sidecar;
const skillContent = readFileSync(join(packageDirectory, 'SKILL.md'), 'utf8');

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

test('package schema and source map are complete without warnings', () => {
  expect(validation.errors).toEqual([]);
  expect(validation.warnings).toEqual([]);

  const sourceMap = readFileSync(join(packageDirectory, 'references/sources.md'), 'utf8');
  expect(new Set(sidecar.sources.map((source) => source.url)).size).toBe(sidecar.sources.length);
  for (const source of sidecar.sources) {
    expect(sourceMap).toContain(source.url);
    expect(sourceMap).toContain(
      `Verified: ${source.verifiedAt}; refresh after ${source.staleAfterDays} days.`,
    );
  }
});

test('local Markdown links resolve inside this package', () => {
  const files = ['SKILL.md', 'references/sources.md'];
  for (const file of files) {
    const markdown = readFileSync(join(packageDirectory, file), 'utf8');
    for (const [, rawLink] of markdown.matchAll(/\[[^\]]+\]\(([^)#]+)(?:#[^)]*)?\)/gu)) {
      const link = rawLink!;
      if (/^[a-z]+:/iu.test(link)) continue;
      const target = resolve(dirname(join(packageDirectory, file)), link);
      const local = relative(packageDirectory, target);
      expect(
        isAbsolute(local) || local === '..' || local.startsWith('../') || local.startsWith('..\\'),
      ).toBe(false);
      expect(existsSync(target), `${file}: ${link}`).toBe(true);
    }
  }
});

test('operating contract names enforcement, evidence, and unsupported-runtime boundaries', () => {
  for (const term of [
    'Isolation boundary',
    'Capability contract',
    'Resource contract',
    'Evidence status',
    'Constrain host authority and escape boundaries',
    'Bound resource consumption',
    'Make denial, exhaustion, and recovery observable',
    'Exercise failure and recovery',
    'unsupported runtime claim remains unverified',
  ]) {
    expect(skillContent.toLowerCase()).toContain(term.toLowerCase());
  }
  expect(sidecar.evidence).toEqual(
    expect.arrayContaining([
      'Isolation and escape-boundary map',
      'Observable limit, effect, and recovery record',
    ]),
  );
  for (const task of pkg.evaluation.tasks) {
    expect(task.requiredEvidence).toEqual(
      expect.arrayContaining([
        'Isolation and escape-boundary map',
        'Observable limit, effect, and recovery record',
        'explicit unavailable, simulated, inferred, stale, or unverified evidence labels',
      ]),
    );
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
  test(`package-local trigger boundary: ${row.id}`, () => {
    const contract = createTaskContract(row.prompt);
    const evidence = collectSkillEvidence(packageDirectory, row.prompt, contract);
    const result = evaluateSkillTrigger(revision, row.prompt, contract, undefined, evidence);
    expect(result.matched, `${row.prompt}\n${result.reason}`).toBe(row.expectedSelection);
  });
}

for (const [index, task] of pkg.evaluation.tasks.entries()) {
  test(`full-task ${task.id} retains stable artifact and check contracts`, () => {
    expect(task.falsifiableChecks).toHaveLength(6);
    expect(new Set(task.falsifiableChecks.map((check) => check.id)).size).toBe(6);
    expect(task.requiredArtifacts).toEqual([
      `language-runtime-security-individual-scenario-${index + 1}-result`,
      `language-runtime-security-individual-scenario-${index + 1}-verification`,
      `language-runtime-security-individual-scenario-${index + 1}-paired-evaluation`,
    ]);
    expect(task.requiredEvidence).toContain(
      'explicit unavailable, simulated, inferred, stale, or unverified evidence labels',
    );
  });
}
