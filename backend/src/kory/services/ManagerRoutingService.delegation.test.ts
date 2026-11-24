import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { KoryphaiosConfig, ProviderName } from '@koryphaios/shared';
import type { Provider, ProviderRegistry } from '../../providers';
import { ManagerRoutingService } from './ManagerRoutingService';

let root: string;
let skillsHome: string;
let previousSkillsHome: string | undefined;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'delegation-routing-'));
  skillsHome = mkdtempSync(join(tmpdir(), 'delegation-routing-skills-'));
  previousSkillsHome = process.env.KORYPHAIOS_SKILLS_HOME;
  process.env.KORYPHAIOS_SKILLS_HOME = skillsHome;
});

afterEach(() => {
  if (previousSkillsHome === undefined) delete process.env.KORYPHAIOS_SKILLS_HOME;
  else process.env.KORYPHAIOS_SKILLS_HOME = previousSkillsHome;
  rmSync(root, { recursive: true, force: true });
  rmSync(skillsHome, { recursive: true, force: true });
});

function writeSettings(agentSettings: Record<string, unknown>) {
  writeFileSync(join(root, 'koryphaios.json'), JSON.stringify({ agentSettings }));
}

type Row = {
  name: string;
  adapterAvailable: boolean;
  authenticated: boolean;
  connectionState: string;
  models: string[];
  allAvailableModels: Array<{ id: string; aliases?: string[] }>;
};

function row(name: string, ids: string[], overrides: Partial<Row> = {}): Row {
  return {
    name,
    adapterAvailable: true,
    authenticated: true,
    connectionState: 'verified',
    models: ids,
    allAvailableModels: ids.map((id) => ({ id })),
    ...overrides,
  };
}

function fixture(rows: Row[]) {
  const resolveProvider = mock(
    (_model: string, provider?: ProviderName): Provider | undefined =>
      ({ name: provider }) as Provider,
  );
  const getStatus = mock(() => rows);
  const service = new ManagerRoutingService({
    config: { assignments: {} } as KoryphaiosConfig,
    providers: { resolveProvider, getStatus } as unknown as ProviderRegistry,
    workingDirectory: root,
  });
  return { service, resolveProvider };
}

const ROWS: Row[] = [
  row('openai', ['gpt-pool', 'gpt-other']),
  row('anthropic', ['claude-pool', 'claude-unlisted']),
  row('numes', ['model:free']),
  row('replicate', ['flux-chat']),
  row('ollama', ['local-llama'], { connectionState: 'detected', authenticated: false }),
  row('elevenlabs', ['voice-1']),
  row('openai-images', ['gpt-image-1']),
];

describe('delegated worker routing', () => {
  test('no model named: the domain pool is the default', () => {
    writeSettings({ managerModelAccess: { general: ['anthropic:claude-pool'] } });
    const { service } = fixture(ROWS);
    expect(
      service.resolveDelegatedWorkerRouting({ domain: 'general', workingDirectory: root }),
    ).toEqual({ provider: 'anthropic', model: 'claude-pool' });
  });

  test('explicit provider:model outside the pool resolves when connected', () => {
    writeSettings({ managerModelAccess: { general: ['anthropic:claude-pool'] } });
    const { service } = fixture(ROWS);
    expect(
      service.resolveDelegatedWorkerRouting({
        domain: 'general',
        workingDirectory: root,
        requestedModel: 'openai:gpt-other',
      }),
    ).toEqual({ provider: 'openai', model: 'gpt-other' });
  });

  test('a model with a colon in its id resolves by its qualified name', () => {
    writeSettings({});
    const { service } = fixture(ROWS);
    expect(
      service.resolveDelegatedWorkerRouting({
        domain: 'general',
        workingDirectory: root,
        requestedModel: 'numes:model:free',
      }),
    ).toEqual({ provider: 'numes', model: 'model:free' });
  });

  test('a bare model id resolves when exactly one connected provider lists it', () => {
    writeSettings({});
    const { service } = fixture(ROWS);
    expect(
      service.resolveDelegatedWorkerRouting({
        domain: 'general',
        workingDirectory: root,
        requestedModel: 'claude-unlisted',
      }),
    ).toEqual({ provider: 'anthropic', model: 'claude-unlisted' });
  });

  test('an unknown model fails with the closest connected matches', () => {
    writeSettings({});
    const { service } = fixture(ROWS);
    expect(() =>
      service.resolveDelegatedWorkerRouting({
        domain: 'general',
        workingDirectory: root,
        requestedModel: 'anthropic:claude-pol',
      }),
    ).toThrow(/Closest connected models: anthropic:claude-pool/);
  });

  test('a model on an unconnected provider is rejected, not routed', () => {
    writeSettings({});
    const { service } = fixture(ROWS);
    expect(() =>
      service.resolveDelegatedWorkerRouting({
        domain: 'general',
        workingDirectory: root,
        requestedModel: 'ollama:local-llama',
      }),
    ).toThrow(/not a connected chat model/);
  });

  test('capability-only providers and non-chat model ids never qualify', () => {
    writeSettings({});
    const { service } = fixture(ROWS);
    expect(() =>
      service.resolveDelegatedWorkerRouting({
        domain: 'general',
        workingDirectory: root,
        requestedModel: 'replicate:flux-chat',
      }),
    ).toThrow(/not a connected chat model/);
    expect(() =>
      service.resolveDelegatedWorkerRouting({
        domain: 'general',
        workingDirectory: root,
        requestedModel: 'elevenlabs:voice-1',
      }),
    ).toThrow(/not a connected chat model/);
    expect(() =>
      service.resolveDelegatedWorkerRouting({
        domain: 'general',
        workingDirectory: root,
        requestedModel: 'openai-images:gpt-image-1',
      }),
    ).toThrow(/not a connected chat model/);
  });

  test('restrictDelegationToPools restores the pool gate for explicit models', () => {
    writeSettings({
      restrictDelegationToPools: true,
      managerModelAccess: { general: ['anthropic:claude-pool'] },
    });
    const { service } = fixture(ROWS);
    expect(() =>
      service.resolveDelegatedWorkerRouting({
        domain: 'general',
        workingDirectory: root,
        requestedModel: 'openai:gpt-other',
      }),
    ).toThrow(/is not available/);
    expect(
      service.resolveDelegatedWorkerRouting({
        domain: 'general',
        workingDirectory: root,
        requestedModel: 'anthropic:claude-pool',
      }),
    ).toEqual({ provider: 'anthropic', model: 'claude-pool' });
  });

  test('connectedWorkerRoutes lists only verified, chat-capable provider models', () => {
    writeSettings({});
    const { service } = fixture(ROWS);
    const keys = service.connectedWorkerRoutes().map((route) => `${route.provider}:${route.model}`);
    expect(keys).toEqual([
      'openai:gpt-pool',
      'openai:gpt-other',
      'anthropic:claude-pool',
      'anthropic:claude-unlisted',
      'numes:model:free',
    ]);
  });
});
