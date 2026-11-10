import { afterEach, describe, expect, it, mock } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  getFreebuffAccountSnapshot,
  parseFreebuffAccountSnapshot,
  resetFreebuffAccountCacheForTests,
  type FreebuffAccountDependencies,
} from '../freebuff-account';

const roots: string[] = [];
const NOW = 1_790_000_000_000;
const TOKEN = 'synthetic-private-token';
function profile() {
  const root = mkdtempSync(join(tmpdir(), 'freebuff-account-test-'));
  roots.push(root);
  writeFileSync(join(root, 'credentials.json'), 'synthetic revision', { mode: 0o600 });
  return root;
}
function payload(balance = 150) {
  return {
    status: 'none',
    freebucks: {
      balance,
      daily: { remaining: 24, limit: 30, resetAt: '2026-10-07T07:00:00Z' },
      wallet: { balance: 6 },
      prices: { 'm-fixture': 7 },
      claimableGrantFreebucks: 20,
    },
    subscription: { tierName: 'Starter' },
    authToken: TOKEN,
    model: 'private-opaque-model-handle',
  };
}
function dependencies(fetcher: typeof fetch): FreebuffAccountDependencies {
  return { now: () => NOW, fetch: fetcher, withToken: async (_profile, use) => use(TOKEN) };
}
afterEach(() => {
  resetFreebuffAccountCacheForTests();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('Freebuck account reporting', () => {
  it('normalizes live daily allowance plus wallet reserve into provider hours', () => {
    const value = parseFreebuffAccountSnapshot(payload(), NOW);
    expect(value).toMatchObject({
      status: 'fresh',
      updatedAt: NOW,
      planType: 'Starter',
       hours: {
         balance: 30,
         daily: { remaining: 24, limit: 30, resetsAt: Date.parse('2026-10-07T07:00:00Z') },
         wallet: { balance: 6 },
         prices: { 'm-fixture': 7 },
         claimableGrantHours: 20,
      },
    });
    expect(JSON.stringify(value)).not.toContain(TOKEN);
    expect(JSON.stringify(value)).not.toContain('private-opaque');
    expect(parseFreebuffAccountSnapshot(payload(0), NOW).hours?.balance).toBe(30);
  });
  it('keeps absent balances unknown and rejects malformed amounts instead of inventing zero', () => {
    expect(parseFreebuffAccountSnapshot({ freebucks: null }, NOW)).toMatchObject({
      status: 'unavailable',
    });
    expect(parseFreebuffAccountSnapshot({}, NOW).hours).toBeUndefined();
    for (const balance of [-1, NaN, Infinity, '150']) {
      expect(() =>
        parseFreebuffAccountSnapshot(
          { ...payload(), freebucks: { ...payload().freebucks, balance } },
          NOW,
        ),
      ).toThrow();
    }
  });
  it('makes only a canonical-host read, caches it, and coalesces concurrent forced refreshes', async () => {
    const root = profile();
    const fetcher = mock(async (url: string, options: RequestInit) => {
      expect(url).toBe('https://www.codebuff.com/api/v1/freebuff/session');
      expect(options.method).toBe('GET');
      expect(options.body).toBeUndefined();
      expect(options.redirect).toBe('error');
      expect(new Headers(options.headers).get('Authorization')).toBe(`Bearer ${TOKEN}`);
      expect(new Headers(options.headers).get('x-freebuff-instance-id')).toBeNull();
      return Response.json(payload());
    });
    const deps = dependencies(fetcher as unknown as typeof fetch);
    const results = await Promise.all([
      getFreebuffAccountSnapshot(root, true, deps),
      getFreebuffAccountSnapshot(root, true, deps),
    ]);
    expect(results[0]).toEqual(results[1]);
    await getFreebuffAccountSnapshot(root, false, deps);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('refreshes a cached account snapshot after 30 seconds', async () => {
    const root = profile();
    let now = NOW;
    const fetcher = mock(async () => Response.json(payload()));
    const deps = {
      ...dependencies(fetcher as unknown as typeof fetch),
      now: () => now,
    };

    await getFreebuffAccountSnapshot(root, false, deps);
    now += 29_999;
    await getFreebuffAccountSnapshot(root, false, deps);
    expect(fetcher).toHaveBeenCalledTimes(1);

    now += 1;
    await getFreebuffAccountSnapshot(root, false, deps);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it('retains the last good balance as stale and negative-caches a failed probe', async () => {
    const root = profile();
    const fetcher = mock(async () => Response.json(payload()));
    const deps = dependencies(fetcher as unknown as typeof fetch);
    await getFreebuffAccountSnapshot(root, true, deps);
    fetcher.mockImplementation(async () => {
      throw new Error(`request secret ${TOKEN}`);
    });
    const failed = await getFreebuffAccountSnapshot(root, true, deps);
    expect(failed).toMatchObject({ status: 'stale', updatedAt: NOW, hours: { balance: 30 } });
    expect(JSON.stringify(failed)).not.toContain(TOKEN);
    await getFreebuffAccountSnapshot(root, false, deps);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it('does not reuse a previous login balance after credential replacement or between profiles', async () => {
    const root = profile();
    const other = profile();
    const fetcher = mock(async () => Response.json(payload()));
    const deps = dependencies(fetcher as unknown as typeof fetch);
    await getFreebuffAccountSnapshot(root, true, deps);
    writeFileSync(join(root, 'credentials.json'), 'different login with a new revision');
    fetcher.mockImplementation(async () => new Response('unauthorized', { status: 401 }));
    for (const path of [root, other]) {
      const result = await getFreebuffAccountSnapshot(path, false, deps);
      expect(result.status).toBe('unavailable');
       expect(result.hours).toBeUndefined();
    }
  });
  it('a denied credential lookup is unavailable and never leaks the error', async () => {
    const fetcher = mock(async () => Response.json(payload()));
    const deps = dependencies(fetcher as unknown as typeof fetch);
    deps.withToken = async () => {
      throw new Error(TOKEN);
    };
    const result = await getFreebuffAccountSnapshot(profile(), true, deps);
    expect(result.status).toBe('unavailable');
    expect(result.hours).toBeUndefined();
    expect(JSON.stringify(result)).not.toContain(TOKEN);
    expect(fetcher).not.toHaveBeenCalled();
  });
});
