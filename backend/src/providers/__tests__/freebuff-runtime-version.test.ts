import { afterEach, describe, expect, it } from 'bun:test';
import {
  FREEBUFF_MIN_RUNTIME_VERSION,
  compareFreebuffVersions,
  isValidFreebuffVersion,
  resetFreebuffVersionCacheForTests,
  resolveLatestFreebuffVersion,
} from '../freebuff-runtime-version';

afterEach(resetFreebuffVersionCacheForTests);

const registryBody = (version: string) =>
  new Response(JSON.stringify({ version }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });

describe('Freebuff latest-version resolution', () => {
  it('parses strict numeric dotted-triplet versions only', () => {
    expect(isValidFreebuffVersion('0.2.36')).toBe(true);
    expect(isValidFreebuffVersion('1234.5678.123456')).toBe(true);
    for (const bad of [
      '0.2.36; rm -rf /',
      'latest',
      '1.2',
      '1.2.3.4',
      'v0.2.36',
      '0.2.36 ',
      ' 0.2.36',
      '0.2.36-beta',
      '0.2.',
      '',
      '12345.1.1',
      '1.1.1234567',
      null,
      undefined,
      36,
    ]) {
      expect(isValidFreebuffVersion(bad)).toBe(false);
    }
  });

  it('compares versions numerically per component', () => {
    expect(compareFreebuffVersions('0.2.36', '0.2.36')).toBe(0);
    expect(compareFreebuffVersions('0.2.37', '0.2.36')).toBe(1);
    expect(compareFreebuffVersions('0.2.9', '0.2.36')).toBe(-1);
    expect(compareFreebuffVersions('0.10.0', '0.2.99')).toBe(1);
  });

  it('returns a valid latest version at or above the minimum', async () => {
    let calls = 0;
    const fetchImpl = async () => {
      calls += 1;
      return registryBody('0.2.40');
    };
    expect(await resolveLatestFreebuffVersion({ fetchImpl })).toBe('0.2.40');
    expect(calls).toBe(1);
  });

  it('rejects malformed, malformed-looking and below-minimum registry versions', async () => {
    for (const version of ['0.2.36; rm -rf /', 'latest', '1.2', '0.2.16', '0.2.35']) {
      resetFreebuffVersionCacheForTests();
      const fetchImpl = async () => registryBody(version);
      expect(await resolveLatestFreebuffVersion({ fetchImpl })).toBeNull();
    }
  });

  it('negative-caches failures for ten minutes and force bypasses it', async () => {
    let calls = 0;
    let now = 1_000_000;
    const fetchImpl = async () => {
      calls += 1;
      throw new Error('offline');
    };
    expect(await resolveLatestFreebuffVersion({ fetchImpl, now: () => now })).toBeNull();
    expect(await resolveLatestFreebuffVersion({ fetchImpl, now: () => now + 60_000 })).toBeNull();
    expect(calls).toBe(1);
    now += 11 * 60_000;
    expect(await resolveLatestFreebuffVersion({ fetchImpl, now: () => now })).toBeNull();
    expect(calls).toBe(2);
    // A forced call bypasses the negative cache.
    const forced = async () => registryBody('0.2.36');
    expect(
      await resolveLatestFreebuffVersion({ fetchImpl: forced, now: () => now, force: true }),
    ).toBe('0.2.36');
  });

  it('caches success for six hours and expires it afterward', async () => {
    let calls = 0;
    let now = 1_000_000;
    const fetchImpl = async () => {
      calls += 1;
      return registryBody(FREEBUFF_MIN_RUNTIME_VERSION);
    };
    const opts = { fetchImpl, now: () => now };
    expect(await resolveLatestFreebuffVersion(opts)).toBe(FREEBUFF_MIN_RUNTIME_VERSION);
    now += 5 * 60 * 60_000;
    expect(await resolveLatestFreebuffVersion(opts)).toBe(FREEBUFF_MIN_RUNTIME_VERSION);
    expect(calls).toBe(1);
    now += 2 * 60 * 60_000;
    expect(await resolveLatestFreebuffVersion(opts)).toBe(FREEBUFF_MIN_RUNTIME_VERSION);
    expect(calls).toBe(2);
  });

  it('never honors a redirect, including a non-https one', async () => {
    for (const location of ['http://evil.example/latest', 'https://registry.npmjs.org/other']) {
      resetFreebuffVersionCacheForTests();
      const fetchImpl = async () => new Response('', { status: 302, headers: { location } });
      expect(await resolveLatestFreebuffVersion({ fetchImpl })).toBeNull();
    }
  });
});
