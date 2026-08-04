// Tests for buildCommandWithLimits across platforms.
// We stub process.platform to exercise the Linux (prlimit) and macOS (ulimit)
// code paths regardless of the host OS the test runs on.

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import {
  buildCommandWithLimits,
  DEFAULT_RESOURCE_LIMITS,
  AGENT_RESOURCE_LIMITS,
  validateResourceRequest,
} from '../resource-limits';

const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform');

function setPlatform(platform: string) {
  Object.defineProperty(process, 'platform', { value: platform, configurable: true });
}

function restorePlatform() {
  if (originalPlatform) {
    Object.defineProperty(process, 'platform', originalPlatform);
  }
}

describe('buildCommandWithLimits', () => {
  afterEach(() => restorePlatform());

  describe('Linux (prlimit)', () => {
    beforeEach(() => setPlatform('linux'));

    it('wraps the command with prlimit flags', () => {
      const result = buildCommandWithLimits('echo hello', {
        maxCpuTimeMs: 5000,
        maxFileSize: 1024,
        maxProcesses: 10,
        maxNetworkSockets: 5,
      });
      expect(result).toContain('prlimit --cpu=5');
      expect(result).toContain('prlimit --fsize=1024');
      expect(result).toContain('prlimit --nproc=10');
      expect(result).toContain('prlimit --nofile=5');
      expect(result).toContain('-- bash -c');
      expect(result).toContain('echo hello');
    });

    it('applies memory limit via --as on Linux', () => {
      const result = buildCommandWithLimits('ls', { maxMemoryMB: 256 });
      expect(result).toContain('prlimit --as=268435456'); // 256 * 1024 * 1024
    });

    it('returns the command unchanged when no limits are set', () => {
      const result = buildCommandWithLimits('echo hi', {
        maxCpuTimeMs: undefined,
        maxMemoryMB: undefined,
        maxFileSize: undefined,
        maxProcesses: undefined,
        maxNetworkSockets: undefined,
      });
      expect(result).toBe('echo hi');
    });
  });

  describe('macOS (ulimit)', () => {
    beforeEach(() => setPlatform('darwin'));

    it('wraps the command with ulimit calls', () => {
      const result = buildCommandWithLimits('echo hello', {
        maxCpuTimeMs: 5000,
        maxFileSize: 1024,
        maxProcesses: 10,
        maxNetworkSockets: 5,
      });
      expect(result).toContain('ulimit -t 5');
      // 1024 bytes / 512 = 2 blocks
      expect(result).toContain('ulimit -f 2');
      expect(result).toContain('ulimit -u 10');
      expect(result).toContain('ulimit -n 5');
      // ulimit calls are semicolon-chained before the command
      expect(result).toMatch(/^ulimit.*; echo hello$/);
      // must NOT use prlimit
      expect(result).not.toContain('prlimit');
    });

    it('does NOT apply memory limit (macOS kernel ignores ulimit -v/-m)', () => {
      const result = buildCommandWithLimits('ls', { maxMemoryMB: 256 });
      expect(result).not.toContain('ulimit -v');
      expect(result).not.toContain('ulimit -m');
    });

    it('converts file size to 512-byte blocks (rounds up)', () => {
      const result = buildCommandWithLimits('ls', { maxFileSize: 513 });
      // 513 bytes / 512 = 1.002 → ceil → 2 blocks
      expect(result).toContain('ulimit -f 2');
    });

    it('converts file size to 512-byte blocks (exact)', () => {
      const result = buildCommandWithLimits('ls', { maxFileSize: 2048 });
      // 2048 / 512 = 4 blocks exactly
      expect(result).toContain('ulimit -f 4');
    });

    it('returns the command unchanged when no enforceable limits are set', () => {
      const result = buildCommandWithLimits('echo hi', {
        maxCpuTimeMs: undefined,
        maxFileSize: undefined,
        maxProcesses: undefined,
        maxNetworkSockets: undefined,
        maxMemoryMB: 256, // not enforceable on macOS
      });
      expect(result).toBe('echo hi');
    });

    it('applies default limits from DEFAULT_RESOURCE_LIMITS', () => {
      const result = buildCommandWithLimits('ls', {});
      // Defaults: 120s CPU, 10MB file, 50 procs, 10 fds
      expect(result).toContain('ulimit -t 120');
      expect(result).toContain('ulimit -f 20480'); // 10MB / 512 = 20480
      expect(result).toContain('ulimit -u 50');
      expect(result).toContain('ulimit -n 10');
    });

    it('applies agent limits from AGENT_RESOURCE_LIMITS', () => {
      const result = buildCommandWithLimits('cargo build', AGENT_RESOURCE_LIMITS);
      expect(result).toContain('ulimit -t 300'); // 5 min
      expect(result).toContain('ulimit -u 100');
      expect(result).toContain('ulimit -n 20');
    });
  });

  describe('unsupported platform', () => {
    beforeEach(() => setPlatform('win32'));

    it('returns the command unchanged', () => {
      const result = buildCommandWithLimits('echo hi', { maxCpuTimeMs: 5000 });
      expect(result).toBe('echo hi');
    });
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
