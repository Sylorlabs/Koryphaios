/**
 * Package-local authoring and evaluator-contract checks. These checks validate
 * the Java/JVM skill package and resolver contracts; they are not qualification,
 * blind review, or JVM benchmark evidence.
 */
import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
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
  document: {
    kind: 'markdown',
    extension: 'md',
    renderer: 'markdown',
    mediaType: 'text/markdown',
  },
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

test('package validates and every maintained source has local provenance', () => {
  expect(validation.errors).toEqual([]);
  expect(validation.warnings).toEqual([]);
  const sourceMap = readFileSync(resolve(packageRoot, 'references/sources.md'), 'utf8');
  for (const source of sidecar.sources) {
    expect(sourceMap).toContain(source.url);
    expect(sourceMap).toContain(
      `Verified: ${source.verifiedAt}; refresh after ${source.staleAfterDays} days.`,
    );
  }
  expect(sidecar.sources.some((source) => source.sourceType === 'spec')).toBe(true);
  expect(sidecar.sources.some((source) => source.sourceType === 'official-docs')).toBe(true);
});

test('authored Markdown links stay inside the package and resolve', () => {
  for (const file of ['SKILL.md', 'references/sources.md']) {
    const absolute = resolve(packageRoot, file);
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

test('full-task fixtures preserve concurrency, compatibility, performance, and recovery contracts', () => {
  expect(pkg.evaluation.tasks.map((task) => task.id)).toEqual([
    'java-jvm-engineering-full-task-1-individual',
    'java-jvm-engineering-full-task-2-individual',
  ]);
  const sourceUrls = new Set(sidecar.sources.map((source) => source.url));
  for (const task of pkg.evaluation.tasks) {
    expect(new Set(task.falsifiableChecks.map((check) => check.id)).size).toBe(
      task.falsifiableChecks.length,
    );
    expect(task.prompt).toContain('supported');
    expect(task.requiredEvidence.join('\n')).toContain('explicit unavailable');
    expect(task.environment.requirements.join('\n')).toMatch(/JVM|JDK|consumer|record|thread/i);
    for (const check of task.falsifiableChecks) {
      if (check.source) expect(sourceUrls.has(check.source), `${task.id}/${check.id}`).toBe(true);
    }
  }

  const scheduler = pkg.evaluation.tasks[0]!;
  expect(scheduler.prompt).toMatch(/idempotent|shutdown/i);
  expect(scheduler.prompt).toMatch(/thread-leak|thread/i);
  expect(scheduler.falsifiableChecks.map((check) => check.id)).toEqual([
    'scope-and-hierarchy',
    'operating-contract',
    'execution-invariant',
    'verification-discipline',
    'anti-pattern-resistance',
    'evidence-and-uncertainty',
  ]);

  const compatibility = pkg.evaluation.tasks[1]!;
  expect(compatibility.prompt).toMatch(/old producer|old consumer|previous version/i);
  expect(compatibility.environment.requirements.join('\n')).toMatch(
    /source\/binary|prior source\/binary|old producer|old consumer/i,
  );
  expect(compatibility.falsifiableChecks.map((check) => check.id)).toEqual(
    scheduler.falsifiableChecks.map((check) => check.id),
  );
});
