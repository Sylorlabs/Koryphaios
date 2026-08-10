// Tests for buildCommandWithLimits across platforms.
// We inject the platform to exercise Linux (prlimit) and macOS (ulimit)
// without mutating process-wide state or depending on the host OS.

import { describe, it, expect } from 'bun:test';
import { spawnSync } from 'bun';
import {
  buildCommandWithLimits,
  DEFAULT_RESOURCE_LIMITS,
  AGENT_RESOURCE_LIMITS,
  detectCurrentUserProcessBaseline,
  validateResourceRequest,
} from '../resource-limits';

describe('buildCommandWithLimits', () => {
  describe('Linux (prlimit)', () => {
    it('wraps the command with prlimit flags', () => {
      const result = buildCommandWithLimits(
        'echo hello',
        {
          maxCpuTimeMs: 5000,
          maxFileSize: 1024,
          maxProcesses: 10,
          maxNetworkSockets: 5,
        },
        {
          platform: 'linux',
          userProcessBaseline: 250,
          userProcessHardLimit: 1_000,
        },
      );
      expect(result).toContain('prlimit --cpu=5');
      expect(result).toContain('prlimit --fsize=1024');
      expect(result).toContain('prlimit --nproc=260:');
      expect(result).toContain('prlimit --nofile=5');
      expect(result).toContain('-- bash -c');
      expect(result).toContain('echo hello');
    });

    it('applies memory limit via --as on Linux', () => {
      const result = buildCommandWithLimits(
        'ls',
        { maxMemoryMB: 256 },
        { platform: 'linux', userProcessBaseline: 250, userProcessHardLimit: 1_000 },
      );
      expect(result).toContain('prlimit --as=268435456'); // 256 * 1024 * 1024
    });

    it('returns the command unchanged when no limits are set', () => {
      const result = buildCommandWithLimits(
        'echo hi',
        {
          maxCpuTimeMs: undefined,
          maxMemoryMB: undefined,
          maxFileSize: undefined,
          maxProcesses: undefined,
          maxNetworkSockets: undefined,
        },
        { platform: 'linux' },
      );
      expect(result).toBe('echo hi');
    });
  });

  describe('macOS (ulimit)', () => {
    it('wraps the command with ulimit calls', () => {
      const result = buildCommandWithLimits(
        'echo hello',
        {
          maxCpuTimeMs: 5000,
          maxFileSize: 1024,
          maxProcesses: 10,
          maxNetworkSockets: 5,
        },
        {
          platform: 'darwin',
          userProcessBaseline: 250,
          userProcessHardLimit: 1_000,
        },
      );
      expect(result).toContain('ulimit -t 5');
      // 1024 bytes / 512 = 2 blocks
      expect(result).toContain('ulimit -f 2');
      expect(result).toContain('ulimit -S -u 260');
      expect(result).toContain('ulimit -n 5');
      // ulimit calls are semicolon-chained before the command
      expect(result).toMatch(/^ulimit.*; echo hello$/);
      // must NOT use prlimit
      expect(result).not.toContain('prlimit');
    });

    it('does NOT apply memory limit (macOS kernel ignores ulimit -v/-m)', () => {
      const result = buildCommandWithLimits('ls', { maxMemoryMB: 256 }, { platform: 'darwin' });
      expect(result).not.toContain('ulimit -v');
      expect(result).not.toContain('ulimit -m');
    });

    it('converts file size to 512-byte blocks (rounds up)', () => {
      const result = buildCommandWithLimits('ls', { maxFileSize: 513 }, { platform: 'darwin' });
      // 513 bytes / 512 = 1.002 → ceil → 2 blocks
      expect(result).toContain('ulimit -f 2');
    });

    it('converts file size to 512-byte blocks (exact)', () => {
      const result = buildCommandWithLimits('ls', { maxFileSize: 2048 }, { platform: 'darwin' });
      // 2048 / 512 = 4 blocks exactly
      expect(result).toContain('ulimit -f 4');
    });

    it('returns the command unchanged when no enforceable limits are set', () => {
      const result = buildCommandWithLimits(
        'echo hi',
        {
          maxCpuTimeMs: undefined,
          maxFileSize: undefined,
          maxProcesses: undefined,
          maxNetworkSockets: undefined,
          maxMemoryMB: 256, // not enforceable on macOS
        },
        { platform: 'darwin' },
      );
      expect(result).toBe('echo hi');
    });

    it('applies default limits from DEFAULT_RESOURCE_LIMITS', () => {
      const result = buildCommandWithLimits(
        'ls',
        {},
        {
          platform: 'darwin',
          userProcessBaseline: 250,
          userProcessHardLimit: 1_000,
        },
      );
      // Defaults: 120s CPU, 10MB file, 50-process headroom, 10 fds
      expect(result).toContain('ulimit -t 120');
      expect(result).toContain('ulimit -f 20480'); // 10MB / 512 = 20480
      expect(result).toContain('ulimit -S -u 300');
      expect(result).toContain('ulimit -n 10');
    });

    it('applies agent limits from AGENT_RESOURCE_LIMITS', () => {
      const result = buildCommandWithLimits('cargo build', AGENT_RESOURCE_LIMITS, {
        platform: 'darwin',
        userProcessBaseline: 250,
        userProcessHardLimit: 1_000,
      });
      expect(result).toContain('ulimit -t 300'); // 5 min
      expect(result).toContain('ulimit -S -u 350');
      expect(result).toContain('ulimit -n 20');
    });
  });

  describe('unsupported platform', () => {
    it('returns the command unchanged', () => {
      const result = buildCommandWithLimits(
        'echo hi',
        { maxCpuTimeMs: 5000 },
        { platform: 'win32' },
      );
      expect(result).toBe('echo hi');
    });
  });

  it('omits an unsafe absolute process limit when the per-user baseline is unknown', () => {
    const result = buildCommandWithLimits(
      'echo safe',
      {
        maxCpuTimeMs: undefined,
        maxMemoryMB: undefined,
        maxFileSize: undefined,
        maxProcesses: 100,
        maxNetworkSockets: undefined,
      },
      { platform: 'linux', userProcessBaseline: null, userProcessHardLimit: null },
    );
    expect(result).toBe('echo safe');
  });

  it('caps only the soft process limit at the inherited hard ceiling', () => {
    const result = buildCommandWithLimits(
      'echo bounded',
      {
        maxCpuTimeMs: undefined,
        maxMemoryMB: undefined,
        maxFileSize: undefined,
        maxProcesses: 100,
        maxNetworkSockets: undefined,
      },
      { platform: 'linux', userProcessBaseline: 250, userProcessHardLimit: 300 },
    );
    expect(result).toContain('prlimit --nproc=300:');
    expect(result).not.toContain('prlimit --nproc=300 --');
  });

  it('executes a real post-limit fork with the measured Linux user-task baseline', () => {
    if (process.platform !== 'linux') return;
    const baseline = detectCurrentUserProcessBaseline('linux');
    expect(baseline).not.toBeNull();

    const command = buildCommandWithLimits(
      "sh -c 'printf fork-ok | cat'",
      {
        maxCpuTimeMs: undefined,
        maxMemoryMB: undefined,
        maxFileSize: undefined,
        maxProcesses: 100,
        maxNetworkSockets: undefined,
      },
      { platform: 'linux', userProcessBaseline: baseline, userProcessHardLimit: null },
    );
    const result = spawnSync(['/bin/bash', '-c', command], {
      stdout: 'pipe',
      stderr: 'pipe',
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString()).toBe('fork-ok');
    expect(result.stderr.toString()).not.toContain('Resource temporarily unavailable');
  });
});

describe('validateResourceRequest', () => {
  it('rejects CPU time over 60 minutes', () => {
    const r = validateResourceRequest({ maxCpuTimeMs: 3_600_001 });
    expect(r.allowed).toBe(false);
    expect(r.reason).toContain('CPU time');
  });

  it('rejects memory over 8GB', () => {
    const r = validateResourceRequest({ maxMemoryMB: 8193 });
    expect(r.allowed).toBe(false);
    expect(r.reason).toContain('Memory');
  });

  it('rejects process count over 500', () => {
    const r = validateResourceRequest({ maxProcesses: 501 });
    expect(r.allowed).toBe(false);
    expect(r.reason).toContain('Process');
  });

  it('allows reasonable limits', () => {
    const r = validateResourceRequest({ maxCpuTimeMs: 60_000, maxMemoryMB: 512 });
    expect(r.allowed).toBe(true);
  });
});
