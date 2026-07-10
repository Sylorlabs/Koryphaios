import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, renameSync } from 'node:fs';
import { resolve } from 'node:path';

// The repo-root compat-hash.json pins a real hash in some checkouts; tests
// that exercise the "no env, no file" path need a controlled filesystem. We
// shuffle the file aside for the dev/null sentinel tests and put it back.

const PROJECT_ROOT = resolve(import.meta.dir, '..', '..', '..', '..');
const FILE = resolve(PROJECT_ROOT, 'compat-hash.json');
const STASHED = resolve(PROJECT_ROOT, 'compat-hash.json.stashed-by-test');

let fileWasPresent = false;

beforeAll(() => {
  fileWasPresent = existsSync(FILE);
  if (fileWasPresent) renameSync(FILE, STASHED);
});

afterAll(() => {
  if (fileWasPresent && existsSync(STASHED)) renameSync(STASHED, FILE);
});

describe('config/compat', () => {
  const originalEnv = process.env.KORYPHAIOS_FRONTEND_BUNDLE_HASH;

  beforeEach(() => {
    delete process.env.KORYPHAIOS_FRONTEND_BUNDLE_HASH;
  });

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.KORYPHAIOS_FRONTEND_BUNDLE_HASH;
    } else {
      process.env.KORYPHAIOS_FRONTEND_BUNDLE_HASH = originalEnv;
    }
  });

  async function importFresh() {
    return (await import(`../compat?t=${Math.random()}`)) as typeof import('../compat');
  }

  test('env hash wins and is cached', async () => {
    process.env.KORYPHAIOS_FRONTEND_BUNDLE_HASH = 'abc123def';
    const { resolveBundleHash } = await importFresh();
    expect(resolveBundleHash()).toBe('abc123def');
    expect(resolveBundleHash()).toBe('abc123def');
  });

  test('dev sentinel falls through to file resolution (null when no file)', async () => {
    process.env.KORYPHAIOS_FRONTEND_BUNDLE_HASH = 'dev';
    const { resolveBundleHash, isBundleHashEnforced } = await importFresh();
    expect(resolveBundleHash()).toBeNull();
    expect(isBundleHashEnforced()).toBe(false);
  });

  test('"null" sentinel falls through to file resolution (null when no file)', async () => {
    process.env.KORYPHAIOS_FRONTEND_BUNDLE_HASH = 'null';
    const { resolveBundleHash, isBundleHashEnforced } = await importFresh();
    expect(resolveBundleHash()).toBeNull();
    expect(isBundleHashEnforced()).toBe(false);
  });

  test('a real env hash is enforced', async () => {
    process.env.KORYPHAIOS_FRONTEND_BUNDLE_HASH = '15314e1';
    const { resolveBundleHash, isBundleHashEnforced } = await importFresh();
    expect(resolveBundleHash()).toBe('15314e1');
    expect(isBundleHashEnforced()).toBe(true);
  });
});

describe('/api/health compat block', () => {
  test('COMPAT and resolver are exported correctly', async () => {
    const compatMod = await import('../compat');
    expect(compatMod.resolveBundleHash).toBeTypeOf('function');
    expect(compatMod.isBundleHashEnforced).toBeTypeOf('function');
    const constants = await import('../../constants');
    expect(constants.COMPAT.minFrontend).toMatch(/^\d+\.\d+\.\d+$/);
    expect(constants.COMPAT.currentFrontend).toMatch(/^\d+\.\d+\.\d+$/);
  });
});
