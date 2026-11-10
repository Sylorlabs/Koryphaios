import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTaskContract } from '../prompts';
import { evaluateSkillTrigger, listSkills, resolveSkills, type SkillRevision } from '../skills';

let root: string;
let previousHome: string | undefined;
let revisions: SkillRevision[];

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'kory-routing-cache-'));
  previousHome = process.env.KORYPHAIOS_SKILLS_HOME;
  process.env.KORYPHAIOS_SKILLS_HOME = join(root, 'personal');
  revisions = listSkills(root);
});

afterAll(() => {
  if (previousHome === undefined) delete process.env.KORYPHAIOS_SKILLS_HOME;
  else process.env.KORYPHAIOS_SKILLS_HOME = previousHome;
  rmSync(root, { recursive: true, force: true });
});

function probeSkill(): SkillRevision {
  const base = revisions.find((skill) => skill.name === 'task-routing')!;
  return {
    ...base,
    name: 'routing-cache-probe',
    metadata: {
      ...base.metadata,
      activation: ['cobalt ledger'],
      excludes: [],
      shouldTrigger: [],
      shouldNotTrigger: [],
      domains: [],
      broader: [],
      requires: [],
      facets: [],
      conflicts: [],
      pathScopes: [],
      invocationMode: 'model-invoked',
    },
  };
}

function selected(skill: SkillRevision, prompt: string): boolean {
  const contract = createTaskContract(prompt);
  const result = resolveSkills(root, prompt, contract, {
    skillRevisions: [...revisions, skill],
    contextBudget: 100_000,
  });
  expect(result.blocked).toBe(false);
  const direct = result.selected.some(
    (row) => row.skill.name === skill.name && row.directSelection,
  );
  expect(direct).toBe(evaluateSkillTrigger(skill, prompt, contract).matched);
  return direct;
}

describe('routing analysis reuse', () => {
  test('keeps clause order, inert quotations, and prompt decisions request-local', () => {
    const skill = probeSkill();
    for (let repeat = 0; repeat < 2; repeat++) {
      expect(selected(skill, 'Inspect the cobalt ledger.')).toBe(true);
      expect(selected(skill, 'Inspect the cobalt ledger. Do not inspect the cobalt ledger.')).toBe(
        false,
      );
      expect(
        selected(skill, 'Do not inspect the cobalt ledger. Inspect the cobalt ledger now.'),
      ).toBe(true);
      expect(
        selected(
          skill,
          'A historical note says "cobalt ledger". The current task is to summarize a poem.',
        ),
      ).toBe(false);
      expect(selected(skill, 'Inspect the "cobalt ledger" now.')).toBe(true);
    }
  });

  test('observes edited activation and exclusions even when the revision object and hash are reused', () => {
    const skill = probeSkill();
    const prompt = 'Inspect the cobalt ledger.';
    expect(selected(skill, prompt)).toBe(true);
    skill.metadata.excludes.push('cobalt ledger');
    expect(selected(skill, prompt)).toBe(false);
    skill.metadata.excludes.length = 0;
    skill.metadata.activation[0] = 'amber journal';
    expect(selected(skill, prompt)).toBe(false);
    expect(selected(skill, 'Inspect the amber journal.')).toBe(true);
    skill.metadata.activation[0] = 'cobalt ledger';
    expect(selected(skill, prompt)).toBe(true);
  });
});
