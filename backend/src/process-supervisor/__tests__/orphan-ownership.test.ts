import { describe, expect, it } from 'bun:test';
import { shouldKillRecoveredProcess } from '../supervisor';

const persisted = { pid: 4242, command: 'bun run job.ts', cwd: '/work/project' };

describe('recovered process ownership verification', () => {
  it('never kills the backend or one of its ancestor processes', () => {
    expect(
      shouldKillRecoveredProcess(
        persisted,
        { cmdline: 'bun\0run\0job.ts', cwd: '/work/project' },
        new Set([4242]),
      ),
    ).toBe(false);
  });

  it('rejects PID reuse when command or cwd no longer matches', () => {
    expect(
      shouldKillRecoveredProcess(
        persisted,
        { cmdline: 'node\0server.js', cwd: '/work/project' },
        new Set(),
      ),
    ).toBe(false);
    expect(
      shouldKillRecoveredProcess(
        persisted,
        { cmdline: 'bun\0run\0job.ts', cwd: '/someone/else' },
        new Set(),
      ),
    ).toBe(false);
  });

  it('allows cleanup only when command and cwd prove ownership', () => {
    expect(
      shouldKillRecoveredProcess(
        persisted,
        { cmdline: '/usr/bin/bun\0run\0job.ts', cwd: '/work/project' },
        new Set(),
      ),
    ).toBe(true);
  });
});
