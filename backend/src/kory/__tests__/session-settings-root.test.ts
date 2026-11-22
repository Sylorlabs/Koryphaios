import { afterAll, describe, expect, mock, test } from 'bun:test';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { KoryManager } from '../manager';
import { ProviderRegistry } from '../../providers';
import type { ToolRegistry } from '../../tools';
import {
  resetSessionAgentOverridesCache,
  setSessionAgentOverrides,
} from '../../stores/session-agent-overrides';

mock.module('../../pubsub', () => ({
  wsBroker: { publish: mock() },
}));

// Regression: the composer reads the chat's permission preset from the
// session's project root (the `x-koryphaios-project` path), but the manager
// used to read `loadAgentSettingsForSession` against the backend process root
// and workers against their own cwd, so one chat could show YOLO while the
// manager ran Guarded — and a worker's worktree could read yet another root.
// Every session settings read must resolve to the session's project root.

const projectA = realpathSync(mkdtempSync(join(tmpdir(), 'kory-rootA-')));
const backendB = realpathSync(mkdtempSync(join(tmpdir(), 'kory-rootB-')));
writeFileSync(
  join(projectA, 'koryphaios.json'),
  JSON.stringify({ agentSettings: { permissionMode: 'yolo', worktreeMode: 'never' } }),
);
writeFileSync(
  join(backendB, 'koryphaios.json'),
  JSON.stringify({ agentSettings: { permissionMode: 'guarded' } }),
);

const mockProviderRegistry = {
  resolveProvider: mock(),
  getAvailable: mock(() => []),
  getStatus: mock(() => []),
  get: mock(),
} as unknown as ProviderRegistry;
const mockToolRegistry = {
  getToolDefs: mock(() => []),
  execute: mock(),
} as unknown as ToolRegistry;
const sessions = { get: async () => undefined, update: async () => undefined };

const manager = new KoryManager(
  mockProviderRegistry,
  mockToolRegistry,
  backendB, // the backend process root — NOT the session's project
  { agents: { manager: { model: 'mock-model' } }, assignments: {}, fallbacks: {} } as never,
  sessions as never,
  { getRecent: () => [], add: () => {}, getContextMessages: () => [] } as never,
);

afterAll(() => {
  resetSessionAgentOverridesCache();
  rmSync(projectA, { recursive: true, force: true });
  rmSync(backendB, { recursive: true, force: true });
});

describe('session-scoped agent settings root', () => {
  test('a session whose runtime resolved project A reads A, not the backend root B', () => {
    manager['runtimes'].get('sess-a').workingDir = projectA;

    expect(manager.getIsYoloMode('sess-a')).toBe(true);
    expect(manager.getWorktreeMode('sess-a')).toBe('never');
    expect(manager.settingsForSession('sess-a').permissionMode).toBe('yolo');

    const snapshots = manager.agentControlSnapshots('sess-a');
    const mgr = snapshots.find((s) => s.role === 'manager');
    expect(mgr?.permissionMode).toBe('yolo');
    expect(mgr?.worktreeMode).toBe('never');
  });

  test('an explicit durable session override still wins over the project preset', () => {
    manager['runtimes'].get('sess-b').workingDir = projectA;
    setSessionAgentOverrides('sess-b', { permissionMode: 'guarded' });
    try {
      expect(manager.getIsYoloMode('sess-b')).toBe(false);
      const mgr = manager.agentControlSnapshots('sess-b').find((s) => s.role === 'manager');
      expect(mgr?.permissionMode).toBe('guarded');
    } finally {
      setSessionAgentOverrides('sess-b', undefined);
    }
  });
});
