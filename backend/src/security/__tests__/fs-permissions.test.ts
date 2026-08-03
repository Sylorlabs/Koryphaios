import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, statSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ensureSecureDir, hardenFilePermissions } from '../fs-permissions';

describe('ensureSecureDir', () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'kory-fsperm-'));
  });
  afterEach(() => {
    try { rmSync(root, { recursive: true, force: true }); } catch { /* best effort */ }
  });

  test('creates a new directory with 0o700', () => {
    const dir = join(root, 'secure');
    ensureSecureDir(dir);
    const mode = statSync(dir).mode & 0o777;
    expect(mode).toBe(0o700);
  });

  test('creates nested directories with 0o700 on the leaf', () => {
    const dir = join(root, 'a', 'b', 'c');
    ensureSecureDir(dir);
    const mode = statSync(dir).mode & 0o777;
    expect(mode).toBe(0o700);
  });

  test('heals an existing directory with looser permissions to 0o700', () => {
    const dir = join(root, 'loose');
    // Create with intentionally loose perms (simulate an older build that
    // used mkdirSync without an explicit mode under a permissive umask).
    mkdirSync(dir, { recursive: true, mode: 0o777 });
    chmodSync(dir, 0o775);
    expect(statSync(dir).mode & 0o777).toBe(0o775);

    ensureSecureDir(dir);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
  });

  test('is idempotent — calling twice on a 0o700 dir keeps 0o700', () => {
    const dir = join(root, 'idempotent');
    ensureSecureDir(dir);
    ensureSecureDir(dir);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
  });
});

describe('hardenFilePermissions', () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'kory-fsperm-file-'));
  });
  afterEach(() => {
    try { rmSync(root, { recursive: true, force: true }); } catch { /* best effort */ }
  });

  test('tightens an existing file to 0o600', () => {
    const file = join(root, 'secrets.json');
    writeFileSync(file, '{}', { mode: 0o644 });
    expect(statSync(file).mode & 0o777).toBe(0o644);

    hardenFilePermissions(file);
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  test('is idempotent on an already-0o600 file', () => {
    const file = join(root, 'already-tight.json');
    writeFileSync(file, '{}', { mode: 0o600 });
    hardenFilePermissions(file);
    hardenFilePermissions(file);
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  test('does not throw when the path does not exist (best-effort)', () => {
    const missing = join(root, 'nope.json');
    expect(() => hardenFilePermissions(missing)).not.toThrow();
  });
});
