import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ProviderRegistry } from '../registry';
import { AcpAgentProvider } from '../acp/provider';
import { saveAcpAgent } from '../acp/agent-store';
import type { AcpAgentDefinition } from '../acp/agent-definitions';

let root: string;
const savedEnv: Record<string, string | undefined> = {};

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'kory-acp-registry-int-'));
  for (const key of [
    'KORYPHAIOS_DATA_DIR',
    'KORY_DISABLE_CLI_AUTODETECT',
    'KORY_DISABLE_PROVIDER_AUTODETECT',
  ]) {
    savedEnv[key] = process.env[key];
  }
  process.env.KORYPHAIOS_DATA_DIR = root;
  process.env.KORY_DISABLE_CLI_AUTODETECT = '1';
  process.env.KORY_DISABLE_PROVIDER_AUTODETECT = '1';
  writeFileSync(join(root, 'koryphaios.json'), '{}');
});

afterAll(() => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(root, { recursive: true, force: true });
});

const def = (id: string): AcpAgentDefinition => ({
  id,
  label: `Agent ${id}`,
  command: process.execPath,
  args: ['acp'],
  envNames: [],
  cwdPolicy: 'workspace',
  permissionProfile: 'bridge-only',
  source: 'manual',
  createdAt: 1,
  updatedAt: 1,
});

describe('ProviderRegistry acp:<id> integration', () => {
  it('registers an agent as a provider once probed, and removes it cleanly', () => {
    const registry = new ProviderRegistry();
    registry.registerAcpAgentProvider(def('reg-int'), {
      ok: true,
      checkedAt: 1,
      durationMs: 1,
      models: ['m1'],
      protocolVersion: 1,
    });

    const provider = registry.get('acp:reg-int' as never);
    expect(provider).toBeInstanceOf(AcpAgentProvider);
    expect(provider?.listModels().map((m) => m.id)).toEqual(['m1']);
    expect(registry.isTrustedForRouting('acp:reg-int' as never)).toBe(true);

    const status = registry.getStatus();
    expect(JSON.stringify(status)).toContain('acp:reg-int');

    registry.removeAcpAgentProvider('reg-int');
    expect(registry.get('acp:reg-int' as never)).toBeUndefined();
  });

  it('keeps an unprobed agent listed but unavailable', () => {
    const registry = new ProviderRegistry();
    registry.registerAcpAgentProvider(def('unprobed-int'));
    const provider = registry.get('acp:unprobed-int' as never);
    expect(provider?.isAvailable()).toBe(false);
  });

  it('restores persisted agents from koryphaios.json at construction', () => {
    saveAcpAgent(def('persisted-int'), {}, root);
    const registry = new ProviderRegistry();
    expect(registry.getConfigs()['acp:persisted-int' as never]?.acpAgent?.id).toBe('persisted-int');
  });
});
