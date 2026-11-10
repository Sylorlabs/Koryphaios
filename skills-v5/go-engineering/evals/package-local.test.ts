// Package-local contract checks. This is not model evaluation or qualification evidence.
import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import {
  collectSkillEvidence,
  evaluateSkillTrigger,
  type SkillRevision,
} from '../../../backend/src/kory/skills';
import { sourceFreshness, validateV5SkillPackage } from '../../../backend/src/kory/skill-packages';
import { createTaskContract } from '../../../backend/src/kory/prompts';
import { lintProse } from '../../dash-free-writing/scripts/check-prose.mjs';

const root = resolve(import.meta.dir, '..');
const validation = validateV5SkillPackage(root, { now: new Date('2026-10-17T12:00:00.000Z') });
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

test('package schema, source freshness, and maintained prose are clean', () => {
  expect(validation.errors).toEqual([]);
  expect(validation.warnings).toEqual([]);
  expect(sidecar.version).toBe('5.2.0');
  expect(
    sidecar.sources.every(
      (source) => sourceFreshness(source, new Date('2026-10-17T12:00:00.000Z')) === 'fresh',
    ),
  ).toBe(true);

  for (const file of ['SKILL.md', 'references/sources.md']) {
    expect(lintProse(readFileSync(join(root, file), 'utf8')).findings, file).toEqual([]);
  }
  expect(lintProse(pkg.definition.description).findings, 'description').toEqual([]);
});

test('source map records every sidecar source with a refresh policy', () => {
  const map = readFileSync(join(root, 'references/sources.md'), 'utf8');
  const entries = map.split(/\n(?=- \*\*)/u).slice(1);
  expect(entries).toHaveLength(sidecar.sources.length);
  expect(new Set(sidecar.sources.map((source) => source.url)).size).toBe(sidecar.sources.length);

  for (const source of sidecar.sources) {
    const entry = entries.find((section) => section.split('\n')[0]!.endsWith(source.url));
    expect(entry, source.url).toBeDefined();
    expect(entry).toContain(
      `Verified: ${source.verifiedAt}; refresh after ${source.staleAfterDays} days.`,
    );
  }
});

test('local Markdown links stay inside the package and resolve', () => {
  let links = 0;
  for (const file of ['SKILL.md', 'references/sources.md']) {
    const text = readFileSync(join(root, file), 'utf8');
    for (const match of text.matchAll(/\]\(([^)]+)\)/gu)) {
      const target = match[1]!;
      if (/^https?:\/\//u.test(target) || target.startsWith('#')) continue;
      const destination = resolve(root, file, '..', target.split('#')[0]!);
      const inside = relative(root, destination);
      expect(
        isAbsolute(inside) || inside.split(/[\\/]/u).includes('..'),
        `${file}: ${target}`,
      ).toBe(false);
      expect(existsSync(destination), `${file}: ${target}`).toBe(true);
      links++;
    }
  }
  expect(links).toBeGreaterThan(0);
});

test('task fixtures preserve external identities and package-local Go boundaries', () => {
  const urls = new Set(sidecar.sources.map((source) => source.url));
  expect(pkg.evaluation.tasks.map((task) => task.id)).toEqual([
    'go-engineering-full-task-1-individual',
    'go-engineering-full-task-2-individual',
  ]);

  for (const [index, task] of pkg.evaluation.tasks.entries()) {
    expect(task.requiredArtifacts).toEqual([
      `go-engineering-individual-scenario-${index + 1}-result`,
      `go-engineering-individual-scenario-${index + 1}-verification`,
      `go-engineering-individual-scenario-${index + 1}-paired-evaluation`,
    ]);
    expect(task.prompt).toContain('Go');
    expect(task.environment.requirements.join('\n')).toContain('paired same-model skill/no-skill');
    expect(task.requiredEvidence.join('\n')).toMatch(/unavailable|unsupported/u);
    expect(new Set(task.falsifiableChecks.map((check) => check.id)).size).toBe(
      task.falsifiableChecks.length,
    );
    for (const check of task.falsifiableChecks) {
      if (check.source) expect(urls.has(check.source), `${task.id}/${check.id}`).toBe(true);
    }
  }
});

const packageCases = [
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

for (const row of packageCases) {
  test(`package-only routing contract: ${row.id}`, () => {
    const contract = createTaskContract(row.prompt);
    const evidence = collectSkillEvidence(root, row.prompt, contract);
    const result = evaluateSkillTrigger(revision, row.prompt, contract, undefined, evidence);
    expect(result.matched, `${row.prompt}\n${result.reason}`).toBe(row.expectedSelection);
  });
}
