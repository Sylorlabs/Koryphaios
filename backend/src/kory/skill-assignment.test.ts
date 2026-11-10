import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { compilePrompt, createTaskContract } from './prompts';
import {
  normalizeSkillAssignment,
  persistSkillDeliveryEvidence,
  validateSkillDeliveryEvidence,
  type SkillDeliveryEvidence,
} from './skill-assignment';

const roots: string[] = [];

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'kory-skill-assignment-'));
  roots.push(root);
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('skill assignment evidence', () => {
  test('normalizes duplicate manager assignments and rejects invalid names', () => {
    expect(
      normalizeSkillAssignment({
        worker: ['verification', 'verification'],
        critic: ['testing-engineering', 'testing-engineering'],
      }),
    ).toEqual({ worker: ['verification'], critic: ['testing-engineering'] });
    expect(() => normalizeSkillAssignment({ worker: ['Not Valid'], critic: [] })).toThrow();
  });

  test('copies assignments so later manager edits cannot change a delegated contract', () => {
    const source = { worker: ['verification'], critic: ['testing-engineering'] };
    const normalized = normalizeSkillAssignment(source);
    source.worker.push('application-security');
    source.critic.length = 0;
    expect(normalized).toEqual({ worker: ['verification'], critic: ['testing-engineering'] });
  });

  test('missing forced skills block both worker and critic compilation', () => {
    const root = tempRoot();
    for (const role of ['worker', 'critic'] as const) {
      const contract = createTaskContract('Explain the current module', {
        skillAssignment: { worker: [], critic: [], [role]: ['absent-qualification-skill'] },
      });
      expect(() =>
        compilePrompt({
          role,
          provider: 'openai',
          workingDirectory: root,
          taskContract: contract,
        }),
      ).toThrow('Skill resolution blocked');
    }
  });

  test('binds the exact delivered revision and prompt text to the worker contract', () => {
    const root = tempRoot();
    const contract = createTaskContract('Review the module boundary', {
      skillAssignment: { worker: ['verification'], critic: [] },
    });
    const compiled = compilePrompt({
      role: 'worker',
      provider: 'openai',
      workingDirectory: root,
      taskContract: contract,
    });
    expect(validateSkillDeliveryEvidence(compiled.skillDelivery, contract)).toBe(true);

    const changedText = structuredClone(compiled.skillDelivery) as SkillDeliveryEvidence;
    changedText.skills[0]!.promptText += ' changed';
    expect(validateSkillDeliveryEvidence(changedText, contract)).toBe(false);

    const changedAssignment = structuredClone(compiled.skillDelivery) as SkillDeliveryEvidence;
    changedAssignment.skills.find((skill) => skill.name === 'verification')!.assigned = false;
    expect(validateSkillDeliveryEvidence(changedAssignment, contract)).toBe(false);

    const differentContract = createTaskContract('Review a different module boundary', {
      skillAssignment: { worker: ['verification'], critic: [] },
    });
    expect(validateSkillDeliveryEvidence(compiled.skillDelivery, differentContract)).toBe(false);
  });

  test('persists a host owned receipt outside the worker transcript', () => {
    const root = tempRoot();
    const contract = createTaskContract('Verify the release evidence', {
      skillAssignment: { worker: ['verification'], critic: [] },
    });
    const compiled = compilePrompt({
      role: 'worker',
      provider: 'openai',
      workingDirectory: root,
      taskContract: contract,
    });
    const path = persistSkillDeliveryEvidence(root, 'worker-test', compiled.skillDelivery);
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual(compiled.skillDelivery);
    expect(path).toContain(join('.koryphaios', 'skills', 'delivery'));
  });
});
