// Resource Limits for Command Execution
// Prevents runaway commands from exhausting server resources

import { readdirSync, readFileSync } from 'node:fs';
import { spawnSync } from 'bun';
import { serverLog } from '../logger';

export interface ResourceLimits {
  maxCpuTimeMs?: number; // Maximum CPU time in milliseconds
  maxMemoryMB?: number; // Maximum memory in MB
  maxFileSize?: number; // Maximum file size for writes (bytes)
  maxProcesses?: number; // Maximum number of child processes
  maxNetworkSockets?: number; // Maximum network sockets
  allowNetworkAccess?: boolean; // Whether to allow network access
  maxDiskWriteMB?: number; // Maximum disk write in MB
}

/**
 * Host observations used to translate a relative child-process allowance into
 * the absolute, per-user value expected by RLIMIT_NPROC. Tests can provide
 * these values explicitly so command construction stays deterministic.
 */
export interface ResourceLimitRuntime {
  /** Explicit platform for deterministic construction tests. */
  platform?: NodeJS.Platform;
  /** Existing processes/tasks charged to this real user. `null` means unknown. */
  userProcessBaseline?: number | null;
  /** Inherited hard RLIMIT_NPROC ceiling. `null` means unknown/unbounded. */
  userProcessHardLimit?: number | null;
}

export const DEFAULT_RESOURCE_LIMITS: ResourceLimits = {
  maxCpuTimeMs: 120_000, // 2 minutes
  maxMemoryMB: 512, // 512MB
  maxFileSize: 10 * 1024 * 1024, // 10MB
  maxProcesses: 50, // 50 processes
  maxNetworkSockets: 10, // 10 network connections
  allowNetworkAccess: false, // No network access by default
  maxDiskWriteMB: 100, // 100MB disk write
};

export const AGENT_RESOURCE_LIMITS: ResourceLimits = {
  maxCpuTimeMs: 300_000, // 5 minutes for agent commands
  maxMemoryMB: 1024, // 1GB for agent commands
  maxFileSize: 50 * 1024 * 1024, // 50MB
  maxProcesses: 100,
  maxNetworkSockets: 20,
  allowNetworkAccess: false,
  maxDiskWriteMB: 500,
};

/**
 * Build a command with resource limits applied.
 *
 * Platform support:
 *   - Linux   → `prlimit` (per-process rlimits via the kernel)
 *   - macOS   → `ulimit` (bash builtin; enforced by the kernel for -t/-f/-n/-u)
 *   - Windows → no native per-process rlimit CLI; proceeds with a warning
 *
 * On macOS, `ulimit -v` (virtual memory) and `-m` (resident set) are accepted
 * by bash but NOT enforced by the kernel, so they are intentionally omitted to
 * avoid implying a memory cap that does not actually bind. CPU time (-t), file
 * size (-f), open fds/sockets (-n), and process count (-u) ARE enforced.
 *
 * RLIMIT_NPROC is an absolute per-real-user limit, not a child count and not a
 * session/container boundary. Kory therefore adds the requested process
 * allowance to the user's observed baseline and changes only the soft limit.
 * If the baseline cannot be measured safely, Kory omits NPROC rather than
 * installing a deceptively low absolute value that can make ordinary commands
 * unable to fork. This is best-effort fork headroom, not cgroup isolation.
 */
export function buildCommandWithLimits(
  command: string,
  limits: Partial<ResourceLimits> = {},
  runtime: ResourceLimitRuntime = {},
): string {
  const finalLimits = { ...DEFAULT_RESOURCE_LIMITS, ...limits };
  const platform = runtime.platform ?? process.platform;

  // ─── Linux: prlimit ──────────────────────────────────────────────────────
  if (platform === 'linux') {
    const limitCommands: string[] = [];

    if (finalLimits.maxCpuTimeMs) {
      const cpuSec = Math.floor(finalLimits.maxCpuTimeMs / 1000);
      limitCommands.push(`prlimit --cpu=${cpuSec}`);
    }
    if (finalLimits.maxMemoryMB) {
      const memBytes = finalLimits.maxMemoryMB * 1024 * 1024;
      limitCommands.push(`prlimit --as=${memBytes}`);
    }
    if (finalLimits.maxFileSize) {
      limitCommands.push(`prlimit --fsize=${finalLimits.maxFileSize}`);
    }
    if (finalLimits.maxProcesses) {
      const processLimit = resolvePerUserProcessSoftLimit(
        finalLimits.maxProcesses,
        platform,
        runtime,
      );
      if (processLimit !== null) {
        // Trailing ':' changes the soft limit only and preserves the inherited
        // hard ceiling, so the command cannot permanently narrow its subtree.
        limitCommands.push(`prlimit --nproc=${processLimit}:`);
      }
    }
    if (finalLimits.maxNetworkSockets) {
      limitCommands.push(`prlimit --nofile=${finalLimits.maxNetworkSockets}`);
    }

    if (limitCommands.length === 0) return command;

    // Wrap the command with all limit commands
    // We use bash -c to chain the prlimit commands and then execute the actual command
    return `${limitCommands.join(' ')} -- bash -c ${JSON.stringify(command)}`;
  }

  // ─── macOS: ulimit (bash builtin) ────────────────────────────────────────
  if (platform === 'darwin') {
    // ulimit settings apply to the current shell and its children. Since
    // bash.ts spawns `bash -c <limitedCommand>`, we prepend ulimit calls that
    // take effect before the user command runs in the same shell.
    const ulimitCalls: string[] = [];

    if (finalLimits.maxCpuTimeMs) {
      const cpuSec = Math.floor(finalLimits.maxCpuTimeMs / 1000);
      ulimitCalls.push(`ulimit -t ${cpuSec}`);
    }
    // ulimit -f is in 512-byte blocks on macOS
    if (finalLimits.maxFileSize) {
      const fileBlocks = Math.ceil(finalLimits.maxFileSize / 512);
      ulimitCalls.push(`ulimit -f ${fileBlocks}`);
    }
    if (finalLimits.maxProcesses) {
      const processLimit = resolvePerUserProcessSoftLimit(
        finalLimits.maxProcesses,
        platform,
        runtime,
      );
      if (processLimit !== null) {
        // -S changes only the soft limit; RLIMIT_NPROC remains per user.
        ulimitCalls.push(`ulimit -S -u ${processLimit}`);
      }
    }
    // open fds covers network sockets too
    if (finalLimits.maxNetworkSockets) {
      ulimitCalls.push(`ulimit -n ${finalLimits.maxNetworkSockets}`);
    }
    // NOTE: maxMemoryMB is intentionally skipped — macOS does not enforce
    // ulimit -v/-m. Logging at debug so the gap is discoverable without noise.
    if (finalLimits.maxMemoryMB) {
      serverLog.debug(
        { maxMemoryMB: finalLimits.maxMemoryMB },
        'macOS does not enforce ulimit -v/-m; memory limit not applied',
      );
    }

    if (ulimitCalls.length === 0) return command;

    return `${ulimitCalls.join('; ')}; ${command}`;
  }

  // ─── Other platforms (Windows, etc.) ─────────────────────────────────────
  serverLog.warn(
    { platform },
    'Resource limits not supported on this platform; proceeding without limits',
  );
  return command;
}

/**
 * Count the host work already charged to this real user for RLIMIT_NPROC.
 * Linux charges threads/tasks, so counting only `/proc/<pid>` would still
 * understate the baseline for browsers, Bun, and language servers.
 */
export function detectCurrentUserProcessBaseline(
  platform: NodeJS.Platform = process.platform,
): number | null {
  const uid = typeof process.getuid === 'function' ? process.getuid() : null;
  if (uid === null) return null;

  if (platform === 'linux') {
    let total = 0;
    try {
      for (const entry of readdirSync('/proc', { withFileTypes: true })) {
        if (!entry.isDirectory() || !/^\d+$/.test(entry.name)) continue;
        try {
          const status = readFileSync(`/proc/${entry.name}/status`, 'utf8');
          const owner = status.match(/^Uid:\s+(\d+)/m);
          if (!owner || Number(owner[1]) !== uid) continue;
          total += readdirSync(`/proc/${entry.name}/task`, { withFileTypes: true }).filter(
            (task) => task.isDirectory() && /^\d+$/.test(task.name),
          ).length;
        } catch {
          // Processes can exit between the directory and status/task reads.
        }
      }
    } catch {
      return null;
    }
    return total > 0 ? total : null;
  }

  if (platform === 'darwin') {
    try {
      const result = spawnSync(['ps', '-axo', 'uid='], { stdout: 'pipe', stderr: 'pipe' });
      if (result.exitCode !== 0) return null;
      const total = result.stdout
        .toString()
        .split(/\r?\n/)
        .reduce((count, value) => count + (Number(value.trim()) === uid ? 1 : 0), 0);
      return total > 0 ? total : null;
    } catch {
      return null;
    }
  }

  return null;
}

/** Read the inherited hard ceiling when the host exposes it without mutation. */
export function detectCurrentUserProcessHardLimit(
  platform: NodeJS.Platform = process.platform,
): number | null {
  if (platform === 'linux') {
    try {
      const limits = readFileSync('/proc/self/limits', 'utf8');
      const row = limits.match(/^Max processes\s+(\S+)\s+(\S+)/m);
      if (!row || row[2] === 'unlimited') return null;
      const hard = Number(row[2]);
      return Number.isSafeInteger(hard) && hard > 0 ? hard : null;
    } catch {
      return null;
    }
  }

  if (platform === 'darwin') {
    try {
      const result = spawnSync(['/bin/bash', '-c', 'ulimit -H -u'], {
        stdout: 'pipe',
        stderr: 'pipe',
      });
      if (result.exitCode !== 0) return null;
      const value = result.stdout.toString().trim();
      if (value === 'unlimited') return null;
      const hard = Number(value);
      return Number.isSafeInteger(hard) && hard > 0 ? hard : null;
    } catch {
      return null;
    }
  }

  return null;
}

function runtimeObservation(
  runtime: ResourceLimitRuntime,
  key: 'userProcessBaseline' | 'userProcessHardLimit',
  detect: () => number | null,
): number | null {
  return Object.prototype.hasOwnProperty.call(runtime, key) ? (runtime[key] ?? null) : detect();
}

function resolvePerUserProcessSoftLimit(
  requestedHeadroom: number,
  platform: NodeJS.Platform,
  runtime: ResourceLimitRuntime,
): number | null {
  const baseline = runtimeObservation(runtime, 'userProcessBaseline', () =>
    detectCurrentUserProcessBaseline(platform),
  );
  if (!Number.isSafeInteger(baseline) || baseline === null || baseline < 1) {
    serverLog.warn(
      { platform, requestedHeadroom },
      'Per-user process baseline unavailable; RLIMIT_NPROC was not applied',
    );
    return null;
  }

  const hardLimit = runtimeObservation(runtime, 'userProcessHardLimit', () =>
    detectCurrentUserProcessHardLimit(platform),
  );
  const desired = baseline + Math.max(1, Math.floor(requestedHeadroom));
  const softLimit =
    hardLimit !== null && Number.isSafeInteger(hardLimit) ? Math.min(desired, hardLimit) : desired;

  if (softLimit <= baseline) {
    serverLog.warn(
      { baseline, hardLimit, requestedHeadroom },
      'No safe RLIMIT_NPROC headroom remains; per-user process limit was not changed',
    );
    return null;
  }
  if (softLimit < desired) {
    serverLog.warn(
      { baseline, hardLimit, requestedHeadroom, effectiveHeadroom: softLimit - baseline },
      'RLIMIT_NPROC headroom was capped by the inherited hard limit',
    );
  }
  return softLimit;
}

/**
 * Validate that a command doesn't exceed resource limits before execution.
 * This is a lightweight check; actual enforcement happens via prlimit (Linux)
 * or ulimit (macOS).
 */
export function validateResourceRequest(limits: Partial<ResourceLimits> = {}): {
  allowed: boolean;
  reason?: string;
} {
  const finalLimits = { ...DEFAULT_RESOURCE_LIMITS, ...limits };

  // Check for unreasonably high limits
  if (finalLimits.maxCpuTimeMs && finalLimits.maxCpuTimeMs > 3_600_000) {
    return { allowed: false, reason: 'CPU time limit exceeds maximum (60 minutes)' };
  }

  if (finalLimits.maxMemoryMB && finalLimits.maxMemoryMB > 8192) {
    return { allowed: false, reason: 'Memory limit exceeds maximum (8GB)' };
  }

  if (finalLimits.maxProcesses && finalLimits.maxProcesses > 500) {
    return { allowed: false, reason: 'Process limit exceeds maximum (500)' };
  }

  if (finalLimits.allowNetworkAccess && process.env.KORYPHAIOS_ALLOW_NETWORK !== 'true') {
    return { allowed: false, reason: 'Network access is disabled by default' };
  }

  return { allowed: true };
}

/**
 * Get the current resource usage for a session.
 * Returns estimated usage based on session activity.
 */
export interface SessionResourceUsage {
  commandCount: number;
  totalCpuTimeMs: number;
  peakMemoryMB: number;
  diskWriteMB: number;
  networkSockets: number;
}

export interface SessionQuota {
  maxDailyCommands: number;
  maxHourlyTokens: number;
  maxDailySpend: number; // In cents
  maxSessionDuration: number; // In milliseconds
}

export const DEFAULT_SESSION_QUOTA: SessionQuota = {
  maxDailyCommands: 1000,
  maxHourlyTokens: 100_000,
  maxDailySpend: 5000, // $50.00
  maxSessionDuration: 8 * 60 * 60 * 1000, // 8 hours
};

export const FREE_TIER_QUOTA: SessionQuota = {
  maxDailyCommands: 100,
  maxHourlyTokens: 10_000,
  maxDailySpend: 500, // $5.00
  maxSessionDuration: 1 * 60 * 60 * 1000, // 1 hour
};

/**
 * Check if a session has exceeded its quota.
 */
export function checkSessionQuota(
  sessionId: string,
  quota: SessionQuota,
  usage: SessionResourceUsage,
  sessionAge: number,
): { allowed: boolean; reason?: string; retryAfter?: number } {
  // Check command count
  if (usage.commandCount >= quota.maxDailyCommands) {
    const retryAfter = 86400 - Math.floor(sessionAge / 1000);
    return {
      allowed: false,
      reason: `Daily command limit exceeded (${usage.commandCount}/${quota.maxDailyCommands})`,
      retryAfter,
    };
  }

  // Check session duration
  if (sessionAge >= quota.maxSessionDuration) {
    return {
      allowed: false,
      reason: `Maximum session duration exceeded (${Math.floor(sessionAge / 60000)} minutes)`,
    };
  }

  return { allowed: true };
}

/**
 * Calculate the cost of a request in cents.
 * This is a simplified model based on token usage.
 */
export function calculateRequestCost(inputTokens: number, outputTokens: number): number {
  // Simplified pricing (adjust based on actual provider rates)
  // This is an average across major providers
  const INPUT_COST_PER_1K = 0.0003; // $0.0003 per 1k input tokens
  const OUTPUT_COST_PER_1K = 0.001; // $0.001 per 1k output tokens

  const inputCost = (inputTokens / 1000) * INPUT_COST_PER_1K;
  const outputCost = (outputTokens / 1000) * OUTPUT_COST_PER_1K;

  // Return cost in cents
  return Math.ceil((inputCost + outputCost) * 100);
}

/**
 * Format cost for display.
 */
export function formatCost(cents: number): string {
  if (cents < 100) {
    return `${cents}¢`;
  }
  return `$${(cents / 100).toFixed(2)}`;
}
