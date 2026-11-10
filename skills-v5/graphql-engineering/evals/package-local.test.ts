import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { createTaskContract } from '../../../backend/src/kory/prompts';
import { validateV5SkillPackage } from '../../../backend/src/kory/skill-packages';
import { buildSkillEvalSuiteV3 } from '../../../backend/src/kory/skill-eval-harness';
import {
  GRAPHQL_ENGINEERING_SKILL_EVAL_MATERIALIZERS,
  GRAPHQL_ENGINEERING_SKILL_EVAL_SCORERS,
} from '../../../backend/src/kory/skill-eval-graphql-engineering-fixtures';
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

test('package validates, sources are mapped, and local links resolve', () => {
  expect(validation.errors).toEqual([]);
  expect(validation.warnings).toEqual([]);
  const sourceMap = readFileSync(join(root, 'references/sources.md'), 'utf8');
  const entries = sourceMap.split(/\n(?=- \*\*)/u).slice(1);
  expect(entries).toHaveLength(sidecar.sources.length);
  for (const source of sidecar.sources) {
    const entry = entries.find((section) => section.split('\n')[0]!.endsWith(source.url));
    expect(entry, source.url).toBeDefined();
    expect(entry).toContain(
      `Verified: ${source.verifiedAt}; refresh after ${source.staleAfterDays} days.`,
    );
  }
  const files = ['SKILL.md', ...pkg.supportingResources.filter((file) => file.endsWith('.md'))];
  let links = 0;
  for (const file of files) {
    const text = readFileSync(join(root, file), 'utf8');
    for (const match of text.matchAll(/\]\(([^)]+)\)/gu)) {
      const target = match[1]!;
      if (/^https?:\/\//u.test(target) || target.startsWith('#')) continue;
      const destination = resolve(root, file, '..', target.split('#')[0]!);
      const escaped = relative(root, destination);
      expect(isAbsolute(escaped) || escaped.split(/[\\/]/u).includes('..')).toBe(false);
      expect(existsSync(destination), `${file}: ${target}`).toBe(true);
      links++;
    }
  }
  expect(links).toBeGreaterThan(0);
});

test('entry point and maintained references pass the prose signal', () => {
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
  ['held-out', pkg.evaluation.routing],
] as const) {
  for (const row of cases) {
    test(`package-only trigger ${suite}: ${row.id}`, () => {
      const contract = createTaskContract(row.prompt);
      const evidence = collectSkillEvidence(root, row.prompt, contract);
      const result = evaluateSkillTrigger(revision, row.prompt, contract, undefined, evidence);
      expect(result.matched, `${row.prompt}\n${result.reason}`).toBe(row.expectedSelection);
    });
  }
}

test('full task identities, artifacts, and falsifiable checks remain complete', () => {
  expect(pkg.evaluation.tasks.map((task) => task.id)).toEqual([
    'graphql-engineering-full-task-1-individual',
    'graphql-engineering-full-task-2-individual',
  ]);
  const sourceUrls = new Set(sidecar.sources.map((source) => source.url));
  for (const [index, task] of pkg.evaluation.tasks.entries()) {
    expect(task.requiredArtifacts).toEqual([
      `graphql-engineering-individual-scenario-${index + 1}-result`,
      `graphql-engineering-individual-scenario-${index + 1}-verification`,
      `graphql-engineering-individual-scenario-${index + 1}-paired-evaluation`,
    ]);
    expect(new Set(task.falsifiableChecks.map((check) => check.id)).size).toBe(
      task.falsifiableChecks.length,
    );
    for (const check of task.falsifiableChecks) {
      if (check.source) expect(sourceUrls.has(check.source), `${task.id}/${check.id}`).toBe(true);
    }
  }
});

test('avatar fixture records explicit dispositions for unrelated boundaries', () => {
  const dispositions = JSON.parse(
    readFileSync(
      join(root, 'evals/fixtures/nullable-field-evolution/boundary-dispositions.json'),
      'utf8',
    ),
  ) as {
    evidenceStatus: string;
    boundaries: Record<string, { status: string; reason: string }>;
    nonClaims: string[];
  };
  expect(dispositions.evidenceStatus).toBe('local-fixture-only');
  expect(Object.keys(dispositions.boundaries).sort()).toEqual([
    'authorization-bypass',
    'mutation-authorization',
    'n-plus-one-and-batching',
    'pagination',
    'query-cost-and-abuse-limits',
  ]);
  for (const boundary of Object.values(dispositions.boundaries)) {
    expect(['exercised', 'not-applicable', 'unavailable']).toContain(boundary.status);
    expect(boundary.reason.length).toBeGreaterThan(20);
  }
  expect(dispositions.nonClaims).toHaveLength(2);
});

for (const task of pkg.evaluation.tasks) {
  test(`registered negative control rejects starter: ${task.id}`, async () => {
    const scenario = buildSkillEvalSuiteV3(pkg).scenarios.find((row) => row.id === task.id)!;
    const materializers = GRAPHQL_ENGINEERING_SKILL_EVAL_MATERIALIZERS.filter((item) =>
      item.matches(scenario),
    );
    const scorers = GRAPHQL_ENGINEERING_SKILL_EVAL_SCORERS.filter((item) =>
      item.scenarioIds.includes(task.id),
    );
    expect(materializers).toHaveLength(1);
    expect(scorers).toHaveLength(1);
    const workspace = mkdtempSync(join(tmpdir(), 'graphql-engineering-starter-'));
    try {
      await materializers[0]!.materialize(workspace, scenario);
      const score = await scorers[0]!.score({
        scenario,
        experiment: {} as never,
        workingDirectory: workspace,
        observation: { output: '', evidence: [], artifacts: [], durationMs: 0 },
      });
      expect(score.passed).toBe(false);
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });
}
