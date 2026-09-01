import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, parse, resolve } from 'node:path';
import { ensureDatabaseDirectory, resolveDatabasePath } from './database-path';

const isWindows = process.platform === 'win32';

describe('resolveDatabasePath', () => {
  test('anchors the default database under the resolved runtime project root', () => {
    expect(resolveDatabasePath('/tmp/kory-runtime', {})).toBe(
      join('/tmp/kory-runtime', 'data', 'koryphaios.db'),
    );
  });

  test.each([
    ['sqlite:///tmp/explicit.db', '/tmp/explicit.db'],
    ['sqlite:/tmp/explicit.db', '/tmp/explicit.db'],
    ['/tmp/explicit.db', '/tmp/explicit.db'],
    ['sqlite:C:\\Kory\\koryphaios.db', 'C:\\Kory\\koryphaios.db'],
  ])('honors an explicit DATABASE_URL %s', (databaseUrl, expected) => {
    expect(resolveDatabasePath('/ignored', { DATABASE_URL: databaseUrl })).toBe(expected);
  });

  test('fails closed when a test process has no isolated database', () => {
    expect(() => resolveDatabasePath('/tmp/kory-runtime', { NODE_ENV: 'test' })).toThrow(
      'Refusing to open the default Koryphaios database in a test process',
    );
  });

  test('fails closed when a test process explicitly points at the live default database', () => {
    const projectRoot = resolve('/tmp/kory-runtime');
    const liveDatabase = join(projectRoot, 'data', 'koryphaios.db');

    expect(() =>
      resolveDatabasePath(projectRoot, {
        NODE_ENV: 'test',
        DATABASE_URL: `sqlite:${liveDatabase}`,
      }),
    ).toThrow('Refusing to open the live Koryphaios database in a test process');
  });

  test('allows a test process to use a dedicated database', () => {
    const isolatedDatabase = resolve('/tmp/kory-tests/case.db');

    expect(
      resolveDatabasePath('/tmp/kory-runtime', {
        NODE_ENV: 'test',
        DATABASE_URL: `sqlite:${isolatedDatabase}`,
      }),
    ).toBe(isolatedDatabase);
  });
});

describe('ensureDatabaseDirectory', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'kory-database-path-'));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  test('creates an app-owned default data leaf with 0o700', () => {
    const databasePath = join(root, 'runtime', 'data', 'koryphaios.db');
    ensureDatabaseDirectory(databasePath, {});

    const parent = join(root, 'runtime', 'data');
    expect(existsSync(parent)).toBe(true);
    if (!isWindows) expect(statSync(parent).mode & 0o777).toBe(0o700);
  });

  test('heals the managed default data leaf created by an older build', () => {
    if (isWindows) return;
    const parent = join(root, 'runtime', 'data');
    mkdirSync(parent, { recursive: true, mode: 0o755 });
    chmodSync(parent, 0o755);

    ensureDatabaseDirectory(join(parent, 'koryphaios.db'), {});
    expect(statSync(parent).mode & 0o777).toBe(0o700);
  });

  test('creates a missing dedicated leaf for a configured database', () => {
    const parent = join(root, 'dedicated-database');
    const databasePath = join(parent, 'koryphaios.db');
    ensureDatabaseDirectory(databasePath, { DATABASE_URL: `sqlite://${databasePath}` });

    expect(existsSync(parent)).toBe(true);
    if (!isWindows) expect(statSync(parent).mode & 0o777).toBe(0o700);
  });

  test('accepts an existing owner-only configured leaf without mutating it', () => {
    const parent = join(root, 'private-database');
    mkdirSync(parent, { mode: 0o700 });
    const modeBefore = statSync(parent).mode & 0o7777;
    const databasePath = join(parent, 'koryphaios.db');

    ensureDatabaseDirectory(databasePath, { DATABASE_URL: `sqlite://${databasePath}` });
    expect(statSync(parent).mode & 0o7777).toBe(modeBefore);
  });

  test('fails closed on an existing loose configured parent without chmodding it', () => {
    if (isWindows) return;
    const parent = join(root, 'broad-parent');
    mkdirSync(parent, { mode: 0o755 });
    chmodSync(parent, 0o755);
    const databasePath = join(parent, 'koryphaios.db');

    expect(() =>
      ensureDatabaseDirectory(databasePath, { DATABASE_URL: `sqlite://${databasePath}` }),
    ).toThrow('Configured directory is not private');
    expect(statSync(parent).mode & 0o777).toBe(0o755);
  });

  test.each([
    ['filesystem root', parse(resolve(tmpdir())).root],
    ['home directory', homedir()],
    ['shared temporary root', tmpdir()],
  ])('refuses a configured database directly in %s without mutation', (_label, parent) => {
    const modeBefore = statSync(parent).mode & 0o7777;
    const databasePath = join(parent, 'koryphaios.db');

    expect(() =>
      ensureDatabaseDirectory(databasePath, { DATABASE_URL: `sqlite://${databasePath}` }),
    ).toThrow('Refusing to secure broad filesystem directory');
    expect(statSync(parent).mode & 0o7777).toBe(modeBefore);
  });

  test('rejects a configured cwd-relative database with no dedicated parent', () => {
    expect(() =>
      ensureDatabaseDirectory('koryphaios.db', {
        DATABASE_URL: 'sqlite:koryphaios.db',
      }),
    ).toThrow('dedicated private directory');
  });

  test('leaves the explicit in-memory database alone', () => {
    expect(() =>
      ensureDatabaseDirectory(':memory:', { DATABASE_URL: 'sqlite::memory:' }),
    ).not.toThrow();
  });
});
