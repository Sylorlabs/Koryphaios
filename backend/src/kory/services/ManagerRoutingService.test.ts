import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { KoryphaiosConfig, ProviderName } from '@koryphaios/shared';
import type { Provider, ProviderRegistry } from '../../providers';
import { createTaskContract } from '../prompts';
import { resolveSkills } from '../skills';
import { saveHarnessQualification } from '../skill-qualifications';
import { ManagerRoutingService } from './ManagerRoutingService';

let root: string;
let skillsHome: string;
let previousSkillsHome: string | undefined;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'manager-routing-'));
  skillsHome = mkdtempSync(join(tmpdir(), 'manager-routing-skills-'));
  previousSkillsHome = process.env.KORYPHAIOS_SKILLS_HOME;
  process.env.KORYPHAIOS_SKILLS_HOME = skillsHome;
});

afterEach(() => {
  if (previousSkillsHome === undefined) delete process.env.KORYPHAIOS_SKILLS_HOME;
  else process.env.KORYPHAIOS_SKILLS_HOME = previousSkillsHome;
  rmSync(root, { recursive: true, force: true });
  rmSync(skillsHome, { recursive: true, force: true });
});

function setAccess(access: Record<string, string[]>, directory = root) {
  writeFileSync(
    join(directory, 'koryphaios.json'),
    JSON.stringify({ agentSettings: { managerModelAccess: access } }),
  );
}

function fixture() {
  const resolveProvider = mock((model: string, provider?: ProviderName): Provider | undefined => {
    if (model === 'stale') throw new Error('Stale model');
    return model === 'unavailable' ? undefined : ({ name: provider } as Provider);
  });
  const getStatus = mock(() => [
    { name: 'openai', adapterAvailable: false, models: ['unavailable-adapter'] },
    { name: 'anthropic', adapterAvailable: true, models: ['catalog-worker'] },
  ]);
  const service = new ManagerRoutingService({
    config: {
      assignments: {
        general: 'openai:default',
        ui: 'openai:default',
        frontend: 'openai:default',
      },
    } as KoryphaiosConfig,
    providers: { resolveProvider, getStatus } as unknown as ProviderRegistry,
    workingDirectory: root,
  });
  return { service, resolveProvider, getStatus };
}

describe('manager active routing policy', () => {
  test('auto uses the first available enabled model; explicit selection wins', () => {
    setAccess({ general: ['openai:unavailable', 'anthropic:allowed', 'openai:last'] });
    const { service } = fixture();
    expect(service.resolveActiveRouting('auto')).toEqual({
      model: 'allowed',
      provider: 'anthropic',
    });
    expect(service.resolveActiveRouting('openai:manual')).toEqual({
      model: 'manual',
      provider: 'openai',
    });
  });

  test('retains an already allowed model without probing alternatives', () => {
    setAccess({ general: ['anthropic:other', 'default'] });
    const { service, resolveProvider } = fixture();
    expect(service.resolveActiveRouting()).toEqual({ model: 'default', provider: 'openai' });
    expect(resolveProvider).not.toHaveBeenCalled();
  });

  test.each([
    ['ui', 'frontend'],
    ['frontend', 'ui'],
  ] as const)('%s uses the %s alias only when its own entry is absent', (domain, alias) => {
    const { service } = fixture();
    setAccess({ [alias]: ['anthropic:alias'] });
    expect(service.resolveActiveRouting(undefined, domain).model).toBe('alias');
    setAccess({ [domain]: [], [alias]: ['anthropic:alias'] });
    expect(service.resolveActiveRouting(undefined, domain).model).toBe('default');
  });

  test('retains the routed default for exhausted or throwing allowlists', () => {
    const { service } = fixture();
    setAccess({ general: ['openai:unavailable'] });
    expect(service.resolveActiveRouting().model).toBe('default');
    // Active routing intentionally catches around the whole allowlist, whereas
    // independent routing skips each stale entry and continues.
    setAccess({ general: ['openai:stale', 'anthropic:allowed'] });
    expect(service.resolveActiveRouting().model).toBe('default');
  });

  test('loads the supplied workspace policy on each call', () => {
    const other = mkdtempSync(join(tmpdir(), 'manager-routing-other-'));
    try {
      setAccess({ general: ['openai:home'] });
      setAccess({ general: ['anthropic:session'] }, other);
      const { service } = fixture();
      expect(service.resolveActiveRouting().model).toBe('home');
      expect(
        service.resolveActiveRouting(undefined, 'general', false, undefined, undefined, other)
          .model,
      ).toBe('session');
      setAccess({ general: ['anthropic:updated'] }, other);
      expect(
        service.resolveActiveRouting(undefined, 'general', false, undefined, undefined, other)
          .model,
      ).toBe('updated');
    } finally {
      rmSync(other, { recursive: true, force: true });
    }
  });
});

describe('independent routing policy', () => {
  test('excludes producer and additional identities, skips stale models, and prefers another provider', () => {
    setAccess({
      critic: [
        'openai:producer',
        'openai:sibling',
        'anthropic:manager',
        'anthropic:stale',
        'anthropic:unavailable',
        'anthropic:reviewer',
      ],
    });
    const { service, getStatus } = fixture();
    expect(
      service.resolveIndependentRouting('producer', 'openai', 'critic', [
        { model: 'manager', provider: 'anthropic' },
      ]),
    ).toEqual({ model: 'reviewer', provider: 'anthropic' });
    expect(getStatus).not.toHaveBeenCalled();
  });

  test('an explicit manager model is honored, never replaced, and an unknown one fails with the pool', () => {
    setAccess({ general: ['openai:producer', 'anthropic:alpha', 'anthropic:beta'] });
    const { service } = fixture();
    const args = ['producer', 'openai', 'general', [], undefined, 'worker', root] as const;
    expect(service.resolveIndependentRouting(...args, 'anthropic:beta')).toEqual({
      model: 'beta',
      provider: 'anthropic',
    });
    // Even the avoided identity is honored when the manager names it.
    expect(service.resolveIndependentRouting(...args, 'openai:producer')).toEqual({
      model: 'producer',
      provider: 'openai',
    });
    expect(() => service.resolveIndependentRouting(...args, 'anthropic:missing')).toThrow(
      /anthropic:alpha, anthropic:beta/,
    );
  });

  test('falls back to a different model on the same provider, reuses the only eligible identity', () => {
    const { service } = fixture();
    setAccess({ general: ['openai:producer', 'openai:sibling'] });
    expect(service.resolveIndependentRouting('producer', 'openai', 'general')).toEqual({
      model: 'sibling',
      provider: 'openai',
    });
    setAccess({ general: ['openai:producer'] });
    expect(service.resolveIndependentRouting('producer', 'openai', 'general')).toEqual({ model: 'producer', provider: 'openai' });
  });

  test('uses category aliases, but an explicit empty category falls back to available adapters', () => {
    const { service } = fixture();
    setAccess({ frontend: ['anthropic:alias'] });
    expect(service.resolveIndependentRouting('producer', 'openai', 'ui')?.model).toBe('alias');
    setAccess({ ui: [], frontend: ['anthropic:alias'] });
    expect(service.resolveIndependentRouting('producer', 'openai', 'ui')).toEqual({
      model: 'catalog-worker',
      provider: 'anthropic',
    });
  });

  test('ranks the independent pool by qualifications for the requested role and task', () => {
    const task = 'Implement a backend API endpoint';
    const contract = createTaskContract(task);
    const skills = resolveSkills(root, contract.goal, contract);
    expect(skills.selected.length).toBeGreaterThan(0);
    for (const [model, quality] of [
      ['first', 0],
      ['qualified', 1],
    ] as const) {
      saveHarnessQualification(root, {
        provider: 'anthropic',
        model,
        harnessVersion: 'test',
        skill: skills.selected[0]!.skill.name,
        role: 'critic',
        medium: skills.evidence.declaredMedia[0],
        sampleSize: 5,
        successes: quality * 5,
        quality,
        verification: quality,
        updatedAt: new Date().toISOString(),
        evidence: ['routing regression fixture'],
      });
    }
    setAccess({ critic: ['anthropic:first', 'anthropic:qualified'] });
    const { service } = fixture();
    expect(
      service.resolveIndependentRouting('producer', 'openai', 'critic', [], task, 'critic')?.model,
    ).toBe('qualified');
    expect(
      service.resolveIndependentRouting('producer', 'openai', 'critic', [], task, 'worker')?.model,
    ).toBe('first');
  });
});


test('prefers a different model over the same model on another provider for critics', () => {
  setAccess({ critic: ['anthropic:producer', 'openai:sibling'] });
  const { service } = fixture();
  expect(service.resolveIndependentRouting('producer', 'openai', 'critic'))
    .toEqual({ model: 'sibling', provider: 'openai' });
});

test('hardExclude removes a route even when it is the only reachable one', () => {
  setAccess({ critic: ['openai:sibling'] });
  const { service } = fixture();
  expect(
    service.resolveIndependentRouting(
      'producer',
      'openai',
      'critic',
      [],
      undefined,
      'critic',
      root,
      undefined,
      ['openai:sibling'],
    ),
  ).toBeNull();
});

test('a hard-excluded preferred model throws instead of silently rerouting', () => {
  setAccess({ critic: ['openai:critic-a', 'openai:critic-b'] });
  const { service } = fixture();
  expect(() =>
    service.resolveIndependentRouting(
      'producer',
      'openai',
      'critic',
      [],
      undefined,
      'critic',
      root,
      'openai:critic-a',
      ['openai:critic-a'],
    ),
  ).toThrow(/not available/);
  // Without the exclusion the same pick resolves normally.
  expect(
    service.resolveIndependentRouting(
      'producer',
      'openai',
      'critic',
      [],
      undefined,
      'critic',
      root,
      'openai:critic-a',
    ),
  ).toEqual({ model: 'critic-a', provider: 'openai' });
});
