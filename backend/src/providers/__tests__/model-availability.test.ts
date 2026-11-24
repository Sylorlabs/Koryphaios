import { afterAll, describe, expect, mock, test } from 'bun:test';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  isModelEnabledInCatalog,
  resolveCatalogModelId,
  resolveEnabledModelIds,
} from '../model-availability';
import { KoryManager } from '../../kory/manager';
import { ProviderRegistry } from '../../providers';
import type { ToolRegistry } from '../../tools';

mock.module('../../pubsub', () => ({
  wsBroker: { publish: mock() },
}));

const catalog = [
  { id: 'swe-1-6', aliases: ['swe-1-6-fast', 'swe-1-6-slow'] },
  { id: 'swe-2', aliases: ['swe-2-priority'] },
];

describe('resolveEnabledModelIds', () => {
  test('empty selection means the whole catalog', () => {
    expect(resolveEnabledModelIds(catalog, [])).toEqual(['swe-1-6', 'swe-2']);
  });

  test('an all-stale selection is treated as unfiltered', () => {
    // Devin's saved list referenced a removed model id, so the enabled list
    // came back empty while the picker showed "all". Match the picker.
    expect(resolveEnabledModelIds(catalog, ['swe-1-6-removed-id'])).toEqual(['swe-1-6', 'swe-2']);
  });

  test('selections resolve through aliases to catalog ids', () => {
    expect(resolveEnabledModelIds(catalog, ['swe-1-6-slow'])).toEqual(['swe-1-6']);
  });
});

describe('isModelEnabledInCatalog', () => {
  test('an alias resolves to its enabled catalog id', () => {
    expect(isModelEnabledInCatalog(catalog, ['swe-1-6', 'swe-2'], 'swe-2-priority')).toBe(true);
    expect(resolveCatalogModelId(catalog, 'swe-1-6-fast')).toBe('swe-1-6');
  });

  test('a genuinely disabled model is still rejected', () => {
    const enabled = resolveEnabledModelIds(catalog, ['swe-1-6']);
    expect(isModelEnabledInCatalog(catalog, enabled, 'swe-2')).toBe(false);
    expect(isModelEnabledInCatalog(catalog, enabled, 'swe-2-priority')).toBe(false);
  });

  test('a model absent from the live catalog is rejected', () => {
    expect(isModelEnabledInCatalog(catalog, ['swe-1-6', 'swe-2'], 'swe-9')).toBe(false);
  });
});

// Compaction's availability check must treat an all-stale selectedModels list
// the way the picker does — the enabled list falls back to the live catalog —
// and must resolve aliases before checking membership.
describe('compaction availability under a stale provider selection', () => {
  const testWorkDir = realpathSync(mkdtempSync(join(tmpdir(), 'kory-avail-')));
  afterAll(() => rmSync(testWorkDir, { recursive: true, force: true }));

  const devinStatus = {
    name: 'devin',
    adapterAvailable: true,
    // What the registry reports once the stale saved selection resolves to
    // zero live entries and falls back to the full catalog.
    models: ['swe-1-6', 'swe-2'],
    allAvailableModels: catalog,
  };
  const mockProviderRegistry = {
    resolveProvider: mock(() => undefined),
    getAvailable: mock(() => []),
    getStatus: mock(() => [devinStatus]),
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
    testWorkDir,
    { agents: { manager: { model: 'mock-model' } }, assignments: {}, fallbacks: {} } as never,
    sessions as never,
    { getRecent: () => [], add: () => {}, getContextMessages: () => [] } as never,
  );
  manager['messages'] = {} as never;

  const availabilityError = 'The selected model is no longer available';

  test('devin:swe-2 passes the availability check under the stale list', async () => {
    try {
      await manager['compactSessionWithClaim'](
        { sessionId: 's1', selectedModel: 'devin:swe-2' },
        new AbortController(),
      );
      expect.unreachable('resolveProvider is stubbed to fail');
    } catch (error) {
      // The availability gate passed; resolution then fails on the stub.
      expect(String(error)).not.toContain(availabilityError);
      expect(String(error)).toContain('provider is unavailable');
    }
  });

  test('a catalog alias passes the availability check', async () => {
    try {
      await manager['compactSessionWithClaim'](
        { sessionId: 's1', selectedModel: 'devin:swe-1-6-fast' },
        new AbortController(),
      );
      expect.unreachable();
    } catch (error) {
      expect(String(error)).not.toContain(availabilityError);
    }
  });

  test('a model missing from the catalog is still refused', async () => {
    await expect(
      manager['compactSessionWithClaim'](
        { sessionId: 's1', selectedModel: 'devin:no-such-model' },
        new AbortController(),
      ),
    ).rejects.toThrow(availabilityError);
  });
});
