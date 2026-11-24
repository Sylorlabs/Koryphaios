import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  clearStartupStatus,
  markStartupReady,
  reportStartupPhase,
  setStartupStatusPathForTesting,
  type StartupStatus,
} from './startup-status';

let scratchDir = '';

afterEach(() => {
  setStartupStatusPathForTesting(null);
  if (scratchDir) {
    rmSync(scratchDir, { recursive: true, force: true });
    scratchDir = '';
  }
});

function useScratchPath(): string {
  scratchDir = mkdtempSync(join(tmpdir(), 'kory-startup-status-'));
  const path = join(scratchDir, '.koryphaios', '.startup-status.json');
  setStartupStatusPathForTesting(path);
  return path;
}

function readStatus(path: string): StartupStatus {
  return JSON.parse(readFileSync(path, 'utf-8')) as StartupStatus;
}

describe('startup status marker', () => {
  test('reportStartupPhase writes this process pid, phase, and detail', () => {
    const path = useScratchPath();
    reportStartupPhase('database-migrations', 'Applying migration 0059: notes');
    const status = readStatus(path);
    expect(status.pid).toBe(process.pid);
    expect(status.phase).toBe('database-migrations');
    expect(status.detail).toBe('Applying migration 0059: notes');
    expect(status.ready).toBe(false);
    expect(status.startedAt).toBeGreaterThan(0);
    expect(status.phaseStartedAt).toBeGreaterThanOrEqual(status.startedAt);
    expect(status.updatedAt).toBeGreaterThanOrEqual(status.phaseStartedAt);
  });

  test('a later phase keeps the original startedAt', () => {
    const path = useScratchPath();
    reportStartupPhase('configuration');
    const first = readStatus(path);
    reportStartupPhase('encryption');
    const second = readStatus(path);
    expect(second.startedAt).toBe(first.startedAt);
    expect(second.phase).toBe('encryption');
    expect(second.detail).toBeNull();
    expect(second.phaseStartedAt).toBeGreaterThanOrEqual(first.phaseStartedAt);
  });

  test('markStartupReady flips phase to ready', () => {
    const path = useScratchPath();
    reportStartupPhase('background-services');
    markStartupReady();
    const status = readStatus(path);
    expect(status.phase).toBe('ready');
    expect(status.ready).toBe(true);
    expect(status.pid).toBe(process.pid);
  });

  test('clearStartupStatus removes the file this process wrote', () => {
    const path = useScratchPath();
    reportStartupPhase('configuration');
    expect(existsSync(path)).toBe(true);
    clearStartupStatus();
    expect(existsSync(path)).toBe(false);
  });

  test('clearStartupStatus never removes a marker owned by another pid', () => {
    const path = useScratchPath();
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(
      path,
      JSON.stringify({
        pid: process.pid + 1,
        phase: 'ready',
        detail: null,
        startedAt: 1,
        phaseStartedAt: 1,
        updatedAt: 1,
        ready: true,
      }),
    );
    clearStartupStatus();
    expect(existsSync(path)).toBe(true);
  });
});

describe('startup launch marker', () => {
  test('server.ts evaluates the launch marker before every other import', () => {
    const source = readFileSync(join(import.meta.dir, '..', 'server.ts'), 'utf8');
    const firstImport = source
      .split('\n')
      .map((line) => line.trim())
      .find((line) => line.startsWith('import'));
    expect(firstImport).toBe("import './runtime/startup-launch-marker';");
  });
});
