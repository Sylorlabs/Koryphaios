import { describe, expect, test } from 'bun:test';
import { CrossAgentEvidenceCache, stableEvidenceVariant } from './evidence-cache';
describe('CrossAgentEvidenceCache', () => {
  test('single-flights identical evidence and records hits', async () => {
    const c = new CrossAgentEvidenceCache();
    let loads = 0;
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const key = {
      scope: 's',
      operation: 'grep',
      revision: 'tree:a',
      variant: stableEvidenceVariant({ q: 'x' }),
    };
    const loader = async () => {
      loads++;
      await gate;
      return 'ok';
    };
    const a = c.getOrLoad(key, loader),
      b = c.getOrLoad(key, loader);
    release();
    expect(await Promise.all([a, b])).toEqual(['ok', 'ok']);
    expect(loads).toBe(1);
    expect(await c.getOrLoad(key, async () => 'bad')).toBe('ok');
    expect(c.getStats()).toMatchObject({ hits: 1, misses: 1, waits: 1, loads: 1, size: 1 });
  });
  test('invalidation prevents stale in-flight repopulation', async () => {
    const c = new CrossAgentEvidenceCache();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const key = { scope: 's', operation: 'grep', revision: 'tree:a' };
    const old = c.getOrLoad(key, async () => {
      await gate;
      return 'old';
    });
    c.invalidateScope('s');
    expect(await c.getOrLoad(key, async () => 'new')).toBe('new');
    release();
    expect(await old).toBe('old');
    expect(await c.getOrLoad(key, async () => 'newer')).toBe('new');
  });
  test('bounds completed entries', async () => {
    const c = new CrossAgentEvidenceCache(2);
    for (const revision of ['a', 'b', 'c'])
      await c.getOrLoad({ scope: 's', operation: 'read_file', revision }, async () => revision);
    expect(c.getStats()).toMatchObject({ size: 2, evictions: 1 });
  });
});
