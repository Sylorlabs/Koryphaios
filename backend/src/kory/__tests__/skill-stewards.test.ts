import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DEFAULT_SKILL_STEWARD_MODEL,
  SKILL_STEWARD_DISPLAY_PREFIX,
  SKILL_STEWARD_PROVIDER,
  acquireSkillStewardLease,
  ensureSkillSteward,
  getSkillStewardRegistryPath,
  listActiveSkillStewardLeases,
  loadSkillStewardRegistry,
  reconcileExpiredSkillStewardLeases,
  releaseSkillStewardLease,
  resolveSkillStewardLaunch,
  syncSkillStewardRegistry,
} from '../skill-stewards';
import { BUNDLED_SKILL_DEFINITIONS, listSkills } from '../skills';
import { PROFESSIONAL_SKILL_DEFINITIONS } from '../professional-skill-definitions';
import { buildSkillHealthSnapshot } from '../skill-health';
import { recordSkillUsage } from '../skill-usage';

const ORIGINAL_BASE_SKILL_NAMES = [
  'task-routing',
  'repository-environment-discovery',
  'research',
  'planning',
  'plan-mode',
  'implementation',
  'debugging',
  'verification',
  'security-review',
  'frontend-engineering',
  'web-interface',
  'native-interface',
  'terminal-interface',
  'novel-ui-toolkit',
  'game-spatial-interface',
  'embedded-interface',
  'backend-engineering',
  'in-process-backend',
  'local-service-backend',
  'network-service-backend',
  'distributed-backend',
  'compiler-runtime-backend',
  'testing-engineering',
  'deterministic-contract-testing',
  'property-fuzz-differential-testing',
  'integration-fault-testing',
  'interface-usability-testing',
  'performance-testing',
  'simulation-device-testing',
  'data-analysis',
  'documents-communication',
  'skill-authoring-evaluation',
] as const;

const ORIGINAL_SKILL_NAMES = [
  ...ORIGINAL_BASE_SKILL_NAMES,
  ...PROFESSIONAL_SKILL_DEFINITIONS.map((definition) => definition.name),
];

let root = '';
let skillsHome = '';

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'kory-skill-stewards-project-'));
  skillsHome = mkdtempSync(join(tmpdir(), 'kory-skill-stewards-home-'));
  process.env.KORYPHAIOS_SKILLS_HOME = skillsHome;
  mkdirSync(join(root, '.git'));
});

afterEach(() => {
  delete process.env.KORYPHAIOS_SKILLS_HOME;
  rmSync(root, { recursive: true, force: true });
  rmSync(skillsHome, { recursive: true, force: true });
});

describe('Skill Steward registry', () => {
  test('persists one logical ChatGPT Web steward for every bundled skill without changing skills', () => {
    const before = listSkills(root)
      .filter((skill) => skill.state === 'active')
      .map((skill) => [skill.name, skill.hash])
      .sort();
    expect(ORIGINAL_SKILL_NAMES).toHaveLength(79);
    expect(before).toHaveLength(BUNDLED_SKILL_DEFINITIONS.length);
    const beforeNames = new Set(before.map(([name]) => name));
    expect(ORIGINAL_SKILL_NAMES.every((name) => beforeNames.has(name))).toBe(true);

    const first = syncSkillStewardRegistry(root, { now: '2026-08-31T20:00:00.000Z' });
    expect(first.stewards).toHaveLength(BUNDLED_SKILL_DEFINITIONS.length);
    expect(first.leases).toEqual([]);
    expect(
      first.stewards.every(
        (steward) =>
          steward.displayLabel.startsWith(SKILL_STEWARD_DISPLAY_PREFIX) &&
          steward.provider === SKILL_STEWARD_PROVIDER &&
          steward.model === DEFAULT_SKILL_STEWARD_MODEL &&
          steward.status === 'active',
      ),
    ).toBe(true);
    const stewardNames = new Set(first.stewards.map((steward) => steward.skill));
    expect(ORIGINAL_SKILL_NAMES.every((name) => stewardNames.has(name))).toBe(true);

    const second = syncSkillStewardRegistry(root, { now: '2026-08-31T21:00:00.000Z' });
    expect(second.revision).toBe(first.revision);
    expect(second.updatedAt).toBe(first.updatedAt);
    expect(second.stewards.map((steward) => steward.assignedAt)).toEqual(
      first.stewards.map((steward) => steward.assignedAt),
    );

    const after = listSkills(root)
      .filter((skill) => skill.state === 'active')
      .map((skill) => [skill.name, skill.hash])
      .sort();
    expect(after).toEqual(before);
  });

  test('never substitutes GPT-5.6 Sol when ChatGPT Web is unavailable', () => {
    const steward = ensureSkillSteward(root, 'planning', {
      now: '2026-08-31T20:00:00.000Z',
    });
    expect(steward.displayLabel).toBe('ChatGPT web — planning');
    expect(() =>
      ensureSkillSteward(root, 'planning', {
        model: 'gpt-5.6-sol',
        now: '2026-08-31T20:00:01.000Z',
      }),
    ).toThrow('ChatGPT Web model identity');

    expect(
      resolveSkillStewardLaunch(steward, [
        { provider: 'codex-auth', model: 'gpt-5.6-sol' },
        { provider: 'codex', model: 'gpt-5.6-sol' },
      ]),
    ).toMatchObject({ mode: 'self' });
    expect(
      resolveSkillStewardLaunch(steward, [
        { provider: 'chatgpt-web', model: 'chatgpt-web/extra-high' },
      ]),
    ).toEqual({
      mode: 'delegated',
      displayLabel: 'ChatGPT web — planning',
      provider: 'chatgpt-web',
      model: 'chatgpt-web/extra-high',
    });
  });

  test('reports steward coverage and aggregate runtime usage without storing prompts', () => {
    syncSkillStewardRegistry(root, { now: '2026-08-31T20:00:00.000Z' });
    recordSkillUsage(root, ['planning', 'planning', 'verification'], '2026-08-31T20:01:00.000Z');
    recordSkillUsage(root, ['planning'], '2026-08-31T20:02:00.000Z');

    const health = buildSkillHealthSnapshot(root);
    expect(health.summary.active).toBe(BUNDLED_SKILL_DEFINITIONS.length);
    expect(health.summary.stewarded).toBe(BUNDLED_SKILL_DEFINITIONS.length);
    expect(health.records.find((record) => record.name === 'planning')).toMatchObject({
      usageCount: 2,
      lastUsedAt: '2026-08-31T20:02:00.000Z',
      steward: {
        displayLabel: 'ChatGPT web — planning',
        model: DEFAULT_SKILL_STEWARD_MODEL,
      },
    });
    expect(health.records.find((record) => record.name === 'verification')?.usageCount).toBe(1);
    expect(readFileSync(join(root, '.koryphaios', 'skills', 'usage.json'), 'utf8')).not.toContain(
      'prompt',
    );
  });

  test('uses exclusive self-expiring leases so logical owners do not become permanent processes', () => {
    const first = acquireSkillStewardLease(root, 'planning', 'run-one', {
      now: '2026-08-31T20:00:00.000Z',
      leaseMs: 1_000,
    });
    expect(loadSkillStewardRegistry(root).leases).toEqual([first]);
    expect(() =>
      acquireSkillStewardLease(root, 'planning', 'run-two', {
        now: '2026-08-31T20:00:00.500Z',
        leaseMs: 1_000,
      }),
    ).toThrow('active steward lease');

    const reconciled = reconcileExpiredSkillStewardLeases(root, '2026-08-31T20:00:02.000Z');
    expect(reconciled.leases).toEqual([]);
    expect(reconciled.stewards.find((item) => item.skill === 'planning')).toMatchObject({
      lastOutcome: 'expired',
      lastCompletedAt: first.expiresAt,
    });

    const second = acquireSkillStewardLease(root, 'planning', 'run-two', {
      now: '2026-08-31T20:00:03.000Z',
      leaseMs: 2_000,
    });
    expect(listActiveSkillStewardLeases(root, '2026-08-31T20:00:03.500Z')).toEqual([second]);
    const completed = releaseSkillStewardLease(root, second.id, 'succeeded', {
      now: '2026-08-31T20:00:04.000Z',
      evidence: ['focused tests passed'],
    });
    expect(completed).toMatchObject({
      lastOutcome: 'succeeded',
      lastEvidence: ['focused tests passed'],
    });
    expect(loadSkillStewardRegistry(root).leases).toEqual([]);
  });

  test('fails closed and preserves a malformed persistent registry', () => {
    syncSkillStewardRegistry(root, { now: '2026-08-31T20:00:00.000Z' });
    const path = getSkillStewardRegistryPath(root);
    writeFileSync(path, '{ malformed registry');
    expect(() => loadSkillStewardRegistry(root)).toThrow('existing file was preserved');
    expect(readFileSync(path, 'utf8')).toBe('{ malformed registry');
  });
});
