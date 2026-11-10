import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { createTaskContract } from '../../../backend/src/kory/prompts';
import { validateV5SkillPackage } from '../../../backend/src/kory/skill-packages';
import {
  collectSkillEvidence,
  evaluateSkillTrigger,
  type SkillRevision,
} from '../../../backend/src/kory/skills';
import { lintProse } from '../../dash-free-writing/scripts/check-prose.mjs';

const root = resolve(import.meta.dir, '..');
const validation = validateV5SkillPackage(root);
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

test('package schema, sources, and fixtures validate without warnings', () => {
  expect(validation.errors).toEqual([]);
  expect(validation.warnings).toEqual([]);
});

test('every maintained source has matching provenance and refresh policy in the source map', () => {
  const map = readFileSync(join(root, 'references/sources.md'), 'utf8');
  const entries = map.split(/\n(?=- \*\*)/u).slice(1);
  expect(entries).toHaveLength(sidecar.sources.length);
  for (const source of sidecar.sources) {
    const entry = entries.find((section) => section.split('\n')[0]!.endsWith(source.url));
    expect(entry, source.url).toBeDefined();
    expect(entry).toContain(
      `Verified: ${source.verifiedAt}; refresh after ${source.staleAfterDays} days.`,
    );
    if (source.revision) expect(entry).toContain(source.revision);
  }
  expect(new Set(sidecar.sources.map((source) => source.url)).size).toBe(sidecar.sources.length);
});

test('local Markdown links stay inside the package and resolve to existing resources', () => {
  const files = ['SKILL.md', ...pkg.supportingResources.filter((file) => file.endsWith('.md'))];
  let links = 0;
  for (const file of files) {
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

test('scenario identities and external artifact names remain compatible; assertions cite declared sources', () => {
  expect(pkg.evaluation.tasks.map((task) => task.id)).toEqual([
    'backend-engineering-full-task-1-individual',
    'backend-engineering-full-task-2-individual',
  ]);
  const urls = new Set(sidecar.sources.map((source) => source.url));
  for (const [index, task] of pkg.evaluation.tasks.entries()) {
    expect(task.requiredArtifacts).toEqual([
      `backend-engineering-individual-scenario-${index + 1}-result`,
      `backend-engineering-individual-scenario-${index + 1}-verification`,
      `backend-engineering-individual-scenario-${index + 1}-paired-evaluation`,
    ]);
    expect(new Set(task.falsifiableChecks.map((check) => check.id)).size).toBe(
      task.falsifiableChecks.length,
    );
    for (const check of task.falsifiableChecks) {
      if (check.source) expect(urls.has(check.source), `${task.id}/${check.id}`).toBe(true);
    }
  }
});

test('job example defines payload ownership without changing the public 202 contract', () => {
  const jobTask = pkg.evaluation.tasks.find(
    (task) => task.id === 'backend-engineering-full-task-1-individual',
  );
  expect(jobTask).toBeDefined();
  const operatingContract = jobTask!.falsifiableChecks.find(
    (check) => check.id === 'operating-contract',
  );
  expect(operatingContract?.assertion).toContain('same-key');
  expect(operatingContract?.assertion).toContain('first accepted invoiceId');
  expect(operatingContract?.assertion).toContain('202/jobId');
  expect(operatingContract?.assertion).toContain('original intent');

  const jobs = readFileSync(join(root, 'references/durable-jobs.md'), 'utf8');
  expect(jobs).toContain('The first accepted payload owns the authoritative record.');
  expect(jobs).toContain('without replacing the original payload');
});

test('job regressions require repeated cancellation and one delivery for duplicate submissions', () => {
  const jobTask = pkg.evaluation.tasks.find(
    (task) => task.id === 'backend-engineering-full-task-1-individual',
  );
  expect(jobTask?.prompt).toContain('repeated cancellation');
  expect(jobTask?.prompt).toContain('cancellation queue draining with no second delivery');
  expect(jobTask?.environment.requirements).toContain(
    'duplicate keys, upload interruption, redelivery, repeated cancellation, cancellation queue draining, and stable job/output identities',
  );
  expect(
    jobTask?.falsifiableChecks.find((check) => check.id === 'verification-discipline')?.assertion,
  ).toContain('one queued delivery after duplicate submission');
  expect(
    jobTask?.falsifiableChecks.find((check) => check.id === 'cancellation-and-late-effects')
      ?.assertion,
  ).toContain('repeated cancellation');
});

test('examples distinguish modeled replay from unavailable topology evidence', () => {
  const jobTask = pkg.evaluation.tasks.find(
    (task) => task.id === 'backend-engineering-full-task-1-individual',
  );
  const syncTask = pkg.evaluation.tasks.find(
    (task) => task.id === 'backend-engineering-full-task-2-individual',
  );
  expect(jobTask?.prompt).toContain('Sequential calls and a stable object key are not concurrency');
  expect(syncTask?.prompt).toContain('sequential replay as concurrent ownership');
  expect(
    jobTask?.falsifiableChecks.find((check) => check.id === 'claim-ownership-and-stale-completion')
      ?.assertion,
  ).toContain('unavailable');
  expect(
    syncTask?.falsifiableChecks.find((check) => check.id === 'overlapping-sync-ownership')?.assertion,
  ).toContain('unavailable');

  const readme = readFileSync(join(root, 'evals/README.md'), 'utf8');
  expect(readme).toContain('do not establish parallel claim isolation');
  expect(readme).toContain('Those boundaries are unavailable');
});

test('entry point and references pass the maintained prose signal', () => {
  const files = [
    'SKILL.md',
    ...pkg.supportingResources.filter(
      (file) => file.startsWith('references/') && file.endsWith('.md'),
    ),
  ];
  for (const file of files) {
    expect(lintProse(readFileSync(join(root, file), 'utf8')).findings, file).toEqual([]);
  }
  expect(lintProse(pkg.definition.description).findings, 'description').toEqual([]);
});

const publicCases = [
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
];

for (const [suite, cases] of [
  ['public', publicCases],
  ['fixture', pkg.evaluation.routing],
] as const) {
  for (const row of cases) {
    test(`package-only runtime trigger ${suite}: ${row.id}`, () => {
      const contract = createTaskContract(row.prompt);
      const evidence = collectSkillEvidence(root, row.prompt, contract);
      const result = evaluateSkillTrigger(revision, row.prompt, contract, undefined, evidence);
      expect(result.matched, `${row.prompt}\n${result.reason}`).toBe(row.expectedSelection);
    });
  }
}
