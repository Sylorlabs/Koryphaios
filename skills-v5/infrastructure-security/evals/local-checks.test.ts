import { afterAll, beforeAll, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createTaskContract } from '../../../backend/src/kory/prompts';
import {
  getBundledSkillContent,
  isDirectSkillSelection,
  resolveSkills,
  validateSkillContent,
  BUNDLED_SKILL_DEFINITIONS,
  type KorySkillMetadata,
  type SkillRevision,
} from '../../../backend/src/kory/skills';
import { validateV5SkillPackage } from '../../../backend/src/kory/skill-packages';
import { buildSkillEvalSuiteV3 } from '../../../backend/src/kory/skill-eval-harness';
import {
  SECURITY_REVIEW_RUNTIME_SKILL_EVAL_MATERIALIZERS,
  SECURITY_REVIEW_RUNTIME_SKILL_EVAL_SCORERS,
} from '../../../backend/src/kory/skill-eval-security-review-runtime-fixtures';

const packageDirectory = resolve(import.meta.dir, '..');
const validation = validateV5SkillPackage(packageDirectory);
if (!validation.package) throw new Error(validation.errors.join('\n'));
const pkg = validation.package;
let scratch: string;
let revisions: SkillRevision[];

beforeAll(() => {
  scratch = mkdtempSync(join(tmpdir(), 'infrastructure-security-local-'));
  revisions = BUNDLED_SKILL_DEFINITIONS.map((definition): SkillRevision => {
    const content = getBundledSkillContent(definition.name)!;
    const [, frontmatter, instructions] = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/)!;
    const metadata = Object.fromEntries(
      [...frontmatter!.matchAll(/^    (\w+):[ \t]*(.*)$/gm)].map(([, key, raw]) => [
        key,
        raw!.startsWith('[')
          ? JSON.parse(raw!)
          : key === 'depth' || key === 'contextBudget'
            ? Number(raw)
            : raw,
      ]),
    ) as unknown as KorySkillMetadata;
    return {
      name: definition.name,
      description: definition.description,
      source: 'project',
      state: 'active',
      path: join(scratch, definition.name, 'SKILL.md'),
      storageVersion: 1,
      document: {
        kind: 'markdown',
        extension: 'md',
        renderer: 'markdown',
        mediaType: 'text/markdown',
      },
      sourceContent: content,
      coreInstructions: instructions!.trim(),
      content,
      instructions: instructions!.trim(),
      metadata,
      hash: createHash('sha256').update(content).digest('hex'),
      validation: validateSkillContent(content),
    };
  });
});

afterAll(() => {
  if (scratch) rmSync(scratch, { recursive: true, force: true });
});

test('package validates, citations resolve, and every task has the evidence contract', () => {
  expect(validation.valid).toBe(true);
  expect(validation.errors).toEqual([]);
  const sourceMap = readFileSync(join(packageDirectory, 'references/sources.md'), 'utf8');
  const urls = new Set(pkg.sidecar.sources.map((source) => source.url));
  for (const url of urls) expect(sourceMap).toContain(url);
  expect(pkg.evaluation.tasks).toHaveLength(2);
  expect(pkg.instructions).toMatch(/default-deny ingress and egress/u);
  expect(pkg.instructions).toMatch(/canonical port map/u);
  expect(pkg.instructions).toMatch(/Role\/RoleBinding/u);
  expect(pkg.instructions).toMatch(/short-lived, audience-bound projected token/u);
  expect(pkg.instructions).toMatch(/unavailable.*unverified/u);
  for (const task of pkg.evaluation.tasks) {
    expect(task.falsifiableChecks.length).toBeGreaterThanOrEqual(7);
    expect(task.falsifiableChecks.some((check) => /allowed|permitted/u.test(check.assertion))).toBe(
      true,
    );
    expect(
      task.falsifiableChecks.some((check) => /denied|reject|negative/u.test(check.assertion)),
    ).toBe(true);
    expect(task.falsifiableChecks.some((check) => /rollback|recovery/u.test(check.assertion))).toBe(
      true,
    );
    expect(
      task.falsifiableChecks.some((check) => /unavailable|unverified/u.test(check.assertion)),
    ).toBe(true);
    expect(task.prompt).toMatch(/runtime|effective|enforc|running/u);
    expect(task.prompt).toMatch(/port|control-plane/u);
    expect(task.prompt).toMatch(/default-deny|dependency/u);
    expect(task.environment.requirements.join(' ')).toMatch(/synthetic|no live|unavailable/u);
    for (const check of task.falsifiableChecks) {
      if (check.source) expect(urls.has(check.source)).toBe(true);
    }
  }
});

for (const row of pkg.evaluation.routing) {
  test(`local resolver: ${row.id}`, () => {
    const result = resolveSkills(scratch, row.prompt, createTaskContract(row.prompt), {
      skillRevisions: revisions,
      contextBudget: 60_000,
    });
    const selected = result.selected.map((item) => item.skill.name);
    const target = result.selected.find((item) => item.skill.name === pkg.sidecar.name);
    const actual = Boolean(
      target && (row.selectionScope !== 'direct' || isDirectSkillSelection(target)),
    );
    expect(result.blocked).toBe(false);
    expect(result.hierarchyErrors).toEqual([]);
    expect(actual, target?.reason ?? 'not selected').toBe(row.expectedSelection);
    for (const name of row.expectedSkills) expect(selected).toContain(name);
    for (const name of row.forbiddenSkills) expect(selected).not.toContain(name);
    if (actual) {
      for (const name of [...pkg.sidecar.broader, ...pkg.sidecar.requires]) {
        expect(selected).toContain(name);
      }
    }
  });
}

for (const task of pkg.evaluation.tasks) {
  test(`registered scorer rejects vulnerable starter: ${task.id}`, async () => {
    const scenario = buildSkillEvalSuiteV3(pkg).scenarios.find((row) => row.id === task.id)!;
    const materializers = SECURITY_REVIEW_RUNTIME_SKILL_EVAL_MATERIALIZERS.filter((item) =>
      item.matches(scenario),
    );
    const scorers = SECURITY_REVIEW_RUNTIME_SKILL_EVAL_SCORERS.filter((item) =>
      item.scenarioIds.includes(task.id),
    );
    expect(materializers).toHaveLength(1);
    expect(scorers).toHaveLength(1);
    const root = mkdtempSync(join(scratch, 'starter-'));
    try {
      await materializers[0]!.materialize(root, scenario);
      const score = await scorers[0]!.score({
        scenario,
        experiment: {} as never,
        workingDirectory: root,
        observation: { output: '', evidence: [], artifacts: [], durationMs: 0 },
      });
      expect(score.passed).toBe(false);
      expect(score.evidence.join('\n')).toMatch(/fail|preserved/u);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}
