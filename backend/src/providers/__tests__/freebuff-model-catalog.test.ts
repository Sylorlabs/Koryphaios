import { afterEach, describe, expect, it, mock } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  getFreebuffModelCatalog, parseFreebuffAccountCatalog, resetFreebuffModelCatalogCacheForTests,
  type FreebuffModelCatalogDependencies,
} from '../freebuff-model-catalog';

const NOW = 1_790_000_000_000;
const TOKEN = 'synthetic-private-token';
const roots: string[] = [];
const row = { key: 'm-fixture', handle: 'private-handle', displayName: 'Real account model',
  access: 'open', multimodal: true, contextWindow: 1_000_000, efforts: ['low', 'high'], sortOrder: 1 };
const payload = () => ({ protocol: 1, version: 'fixture-v1', issuedAt: NOW, refreshAt: NOW + 60_000,
  fetchId: 'private-fetch-id', authToken: TOKEN, rows: [row,
    { ...row, key: 'm-locked', access: 'locked' },
    { ...row, key: 'm-future', opensAt: NOW + 1 },
  ] });
function profile() {
  const root = mkdtempSync(join(tmpdir(), 'freebuff-models-test-'));
  roots.push(root);
  writeFileSync(join(root, 'credentials.json'), 'synthetic revision', { mode: 0o600 });
  return root;
}
function dependencies(fetcher: typeof fetch): FreebuffModelCatalogDependencies {
  return { now: () => NOW, fetch: fetcher, withToken: async (_profile, use) => use(TOKEN) };
}
afterEach(() => {
  resetFreebuffModelCatalogCacheForTests();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('Freebuff authenticated account catalog', () => {
  it('uses accessible issued rows and separates stable picker IDs from private root evidence', () => {
    const result = parseFreebuffAccountCatalog(payload());
    expect(result.models).toEqual([{ id: 'freebuff/catalog-m-fixture', name: row.displayName,
      multimodal: true, contextWindow: 1_000_000, reasoningLevels: ['low', 'high'], handle: row.handle }]);
    expect(JSON.stringify(result)).not.toContain(TOKEN);
    expect(JSON.stringify(result)).not.toContain('private-fetch-id');
    const missing = parseFreebuffAccountCatalog({ ...payload(), rows: [{ ...row, contextWindow: undefined, efforts: undefined }] });
    expect(missing.models[0]?.contextWindow).toBeUndefined();
    expect(missing.models[0]?.reasoningLevels).toBeUndefined();
  });
  it('fails closed on protocol drift, duplicate keys and malformed access/capabilities', () => {
    for (const value of [null, { ...payload(), protocol: 2 }, { ...payload(), rows: [row, row] },
      ...[{ key: 'bad/key' }, { handle: '\nprivate' }, { access: 'unknown' }, { multimodal: 'yes' },
        { contextWindow: -1 }, { efforts: ['\nprivate'] }].map((change) => ({ ...payload(), rows: [{ ...row, ...change }] })),
    ]) expect(() => parseFreebuffAccountCatalog(value)).toThrow('invalid account model catalog');
  });
  it('makes only a canonical-host GET and coalesces forced requests, respecting server refresh time', async () => {
    const root = profile();
    const fetcher = mock(async (url: string, options: RequestInit) => {
      expect(url).toBe('https://www.codebuff.com/api/v1/freebuff/models');
      expect(options.method).toBe('GET');
      expect(options.redirect).toBe('error');
      expect(options.body).toBeUndefined();
      expect(new Headers(options.headers).get('authorization')).toBe(`Bearer ${TOKEN}`);
      expect(new Headers(options.headers).get('x-freebuff-catalog-protocol')).toBe('1');
      return Response.json(payload());
    });
    const deps = dependencies(fetcher as unknown as typeof fetch);
    const results = await Promise.all([getFreebuffModelCatalog(root, true, deps), getFreebuffModelCatalog(root, true, deps)]);
    expect(results[0]).toEqual(results[1]);
    await getFreebuffModelCatalog(root, false, deps);
    expect(fetcher).toHaveBeenCalledTimes(1);
    deps.now = () => NOW + 60_001;
    await getFreebuffModelCatalog(root, false, deps);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it('discards stale entitlements, redacts failures, negative-caches and permits manual retry', async () => {
    const root = profile();
    const fetcher = mock(async () => Response.json(payload()));
    const deps = dependencies(fetcher as unknown as typeof fetch);
    await getFreebuffModelCatalog(root, true, deps);
    fetcher.mockImplementation(async () => { throw new Error(TOKEN); });
    for (const force of [true, false]) {
      await expect(getFreebuffModelCatalog(root, force, deps)).rejects.toThrow('account models could not be refreshed');
    }
    expect(fetcher).toHaveBeenCalledTimes(2);
    fetcher.mockImplementation(async () => Response.json(payload()));
    expect((await getFreebuffModelCatalog(root, true, deps)).models).toHaveLength(1);
    expect(fetcher).toHaveBeenCalledTimes(3);
  });
  it('never shares account access across profiles or a replaced credential revision', async () => {
    const root = profile();
    const other = profile();
    const fetcher = mock(async () => Response.json(payload()));
    const deps = dependencies(fetcher as unknown as typeof fetch);
    await getFreebuffModelCatalog(root, true, deps);
    writeFileSync(join(root, 'credentials.json'), 'a different login revision');
    fetcher.mockImplementation(async () => new Response(TOKEN, { status: 401 }));
    for (const path of [root, other]) {
      await expect(getFreebuffModelCatalog(path, false, deps)).rejects.toThrow('account models could not be refreshed');
    }
    expect(fetcher).toHaveBeenCalledTimes(3);
  });
});
