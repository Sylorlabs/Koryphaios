import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTaskContract } from '../prompts';
import { isDirectSkillSelection, listSkills, resolveSkills } from '../skills';

let root = '';
let skillsHome = '';

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'kory-computer-use-v5-'));
  skillsHome = mkdtempSync(join(tmpdir(), 'kory-computer-use-v5-home-'));
  process.env.KORYPHAIOS_SKILLS_HOME = skillsHome;
  mkdirSync(join(root, '.git'));
});

afterEach(() => {
  delete process.env.KORYPHAIOS_SKILLS_HOME;
  rmSync(root, { recursive: true, force: true });
  rmSync(skillsHome, { recursive: true, force: true });
});

function route(prompt: string) {
  return resolveSkills(root, prompt, createTaskContract(prompt), {
    contextBudget: 60_000,
    skillRevisions: listSkills(root),
  });
}

describe('computer-use V5 routing', () => {
  test('selects computer-use directly for a compound repair plus live interface request', () => {
    const prompt =
      'Repair the desktop export bug, then use computer use to operate the authorized app and prove the repaired workflow succeeds in the live interface.';
    const result = route(prompt);
    const selected = result.selected.find((item) => item.skill.name === 'computer-use');
    expect(
      {
        direct: selected ? isDirectSkillSelection(selected) : false,
        rejection: result.rejectedCandidates.find((item) => item.name === 'computer-use') ?? null,
      },
      prompt,
    ).toEqual({ direct: true, rejection: null });
  });

  test('does not select computer-use for explanation only or an archived routing decoy', () => {
    const explanation = route(
      'Explain the computer use permission model and why operating system consent is separate. Do not click or control anything.',
    );
    const archived = route(
      'An archived issue says "desktop automation". For this task, only fix the backend parser and its unit tests.',
    );
    expect(explanation.selected.some((item) => item.skill.name === 'computer-use')).toBe(false);
    expect(archived.selected.some((item) => item.skill.name === 'computer-use')).toBe(false);
  });
});
