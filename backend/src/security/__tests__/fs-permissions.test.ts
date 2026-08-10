import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  chmodSync,
  statSync,
  rmSync,
  symlinkSync,
} from 'node:fs';
import { join, parse, resolve } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { ensureSecureDir, hardenFilePermissions } from '../fs-permissions';

// Windows doesn't support POSIX permission modes — chmod only toggles
// read-only/read-write. Skip exact mode assertions on Windows.
const isWindows = process.platform === 'win32';

describe('ensureSecureDir', () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'kory-fsperm-'));
  });
  afterEach(() => {
    try {
      rmSync(root, { recursive: true, force: true });
    } catch (err: unknown) {
      // Best-effort temp dir cleanup — tests don't need serverLog.
      console.debug(
        'fs-permissions test cleanup failed:',
        err instanceof Error ? err.message : String(err),
      );
    }
  });

  test('creates a new directory with 0o700', () => {
    const dir = join(root, 'secure');
    ensureSecureDir(dir);
    if (isWindows) return; // chmod is a no-op on Windows; just verify it exists
    const mode = statSync(dir).mode & 0o777;
    expect(mode).toBe(0o700);
  });

  test('creates nested directories with 0o700 on the leaf', () => {
    const dir = join(root, 'a', 'b', 'c');
    ensureSecureDir(dir);
    if (isWindows) return;
    const mode = statSync(dir).mode & 0o777;
    expect(mode).toBe(0o700);
  });

  test('heals an existing directory with looser permissions to 0o700', () => {
    const dir = join(root, 'loose');
    // Create with intentionally loose perms (simulate an older build that
    // used mkdirSync without an explicit mode under a permissive umask).
    mkdirSync(dir, { recursive: true, mode: 0o777 });
    if (!isWindows) {
      chmodSync(dir, 0o775);
      expect(statSync(dir).mode & 0o777).toBe(0o775);
    }

    ensureSecureDir(dir);
    if (isWindows) return;
    expect(statSync(dir).mode & 0o777).toBe(0o700);
  });

  test('is idempotent — calling twice on a 0o700 dir keeps 0o700', () => {
    const dir = join(root, 'idempotent');
    ensureSecureDir(dir);
    ensureSecureDir(dir);
    if (isWindows) return;
    expect(statSync(dir).mode & 0o777).toBe(0o700);
  });

  test.each([
    ['filesystem root', parse(resolve(tmpdir())).root],
    ['home directory', homedir()],
    ['shared temporary root', tmpdir()],
  ])('refuses %s without changing its permissions', (_label, protectedPath) => {
    const modeBefore = statSync(protectedPath).mode & 0o7777;
    expect(() => ensureSecureDir(protectedPath)).toThrow(
      'Refusing to secure broad filesystem directory',
    );
    expect(statSync(protectedPath).mode & 0o7777).toBe(modeBefore);
  });

  test('validates an existing configured directory without repairing it', () => {
    if (isWindows) return;
    const dir = join(root, 'configured-loose');
    mkdirSync(dir, { mode: 0o755 });
    chmodSync(dir, 0o755);

    expect(() => ensureSecureDir(dir, { repairExistingPermissions: false })).toThrow(
      'Configured directory is not private',
    );
    expect(statSync(dir).mode & 0o777).toBe(0o755);
  });

  test('refuses a symbolic-link leaf without touching its target', () => {
    if (isWindows) return;
    const target = join(root, 'symlink-target');
    const link = join(root, 'symlink-leaf');
    mkdirSync(target, { mode: 0o755 });
    chmodSync(target, 0o755);
    symlinkSync(target, link, 'dir');

    expect(() => ensureSecureDir(link)).toThrow('symbolic-link directory');
    expect(statSync(target).mode & 0o777).toBe(0o755);
  });
});

describe('hardenFilePermissions', () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'kory-fsperm-file-'));
  });
  afterEach(() => {
    try {
      rmSync(root, { recursive: true, force: true });
    } catch (err: unknown) {
      // Best-effort temp dir cleanup — tests don't need serverLog.
      console.debug(
        'fs-permissions test cleanup failed:',
        err instanceof Error ? err.message : String(err),
      );
    }
  });

  test('tightens an existing file to 0o600', () => {
    const file = join(root, 'secrets.json');
    writeFileSync(file, '{}', { mode: 0o644 });
    if (!isWindows) {
      expect(statSync(file).mode & 0o777).toBe(0o644);
    }

    hardenFilePermissions(file);
    if (isWindows) return;
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  test('is idempotent on an already-0o600 file', () => {
    const file = join(root, 'already-tight.json');
    writeFileSync(file, '{}', { mode: 0o600 });
    hardenFilePermissions(file);
    hardenFilePermissions(file);
    if (isWindows) return;
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  test('does not throw when the path does not exist (best-effort)', () => {
    const missing = join(root, 'nope.json');
    expect(() => hardenFilePermissions(missing)).not.toThrow();
  });
});
