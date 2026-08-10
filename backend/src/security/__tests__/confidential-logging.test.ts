import { afterEach, describe, expect, test } from 'bun:test';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { ensurePrivateLogStorage, writePrivateLogFile } from '../../../../scripts/backend-watchdog';

const isWindows = process.platform === 'win32';
const roots: string[] = [];

function fixture(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('confidential operational logging', () => {
  test('assistant persistence and native-command diagnostics retain metadata only', () => {
    const sentinel = 'SYNTHETIC_CONFIDENTIAL_LOG_SENTINEL';
    const manager = readFileSync(resolve(import.meta.dir, '../../kory/manager.ts'), 'utf8');
    const nativeCommands = readFileSync(
      resolve(import.meta.dir, '../../routes/v1/native-commands.ts'),
      'utf8',
    );

    expect(manager).not.toContain('koryLog.debug({ toPersist, sessionId }');
    expect(manager).toContain('contentLength: toPersist.length');
    expect(nativeCommands).not.toContain('command: body.command');
    expect(nativeCommands).not.toContain('serverLog.warn({ err');
    expect(nativeCommands).toContain('commandLength: body.command.length');
    expect(manager + nativeCommands).not.toContain(sentinel);
  });

  test('heals an existing log directory and regular files without following symlinks', () => {
    const root = fixture('kory-watchdog-logs-');
    const logDir = join(root, 'logs');
    const existing = join(logDir, 'backend-dev.log');
    const outside = join(root, 'outside.txt');
    const link = join(logDir, 'outside-link');
    mkdirSync(logDir, { recursive: true, mode: 0o777 });
    writeFileSync(existing, 'synthetic log line', { mode: 0o666 });
    writeFileSync(outside, 'not a log', { mode: 0o644 });
    if (!isWindows) {
      chmodSync(logDir, 0o775);
      chmodSync(existing, 0o664);
      chmodSync(outside, 0o644);
      symlinkSync(outside, link);
    }

    ensurePrivateLogStorage(logDir);

    expect(existsSync(existing)).toBe(true);
    expect(readFileSync(existing, 'utf8')).toBe('synthetic log line');
    if (isWindows) return;
    expect(statSync(logDir).mode & 0o777).toBe(0o700);
    expect(statSync(existing).mode & 0o777).toBe(0o600);
    expect(statSync(outside).mode & 0o777).toBe(0o644);
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
  });

  test('creates and replaces diagnostics with mode 0o600', () => {
    const root = fixture('kory-watchdog-write-');
    const diagnostic = join(root, 'watchdog-test-proc.txt');
    writePrivateLogFile(diagnostic, 'first synthetic diagnostic');
    if (!isWindows) chmodSync(diagnostic, 0o664);

    writePrivateLogFile(diagnostic, 'replacement synthetic diagnostic');

    expect(readFileSync(diagnostic, 'utf8')).toBe('replacement synthetic diagnostic');
    if (!isWindows) expect(statSync(diagnostic).mode & 0o777).toBe(0o600);
  });
});
