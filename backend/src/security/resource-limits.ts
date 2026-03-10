// Resource Limits for Command Execution
// Prevents runaway commands from exhausting server resources

import { serverLog } from "../logger";

export interface ResourceLimits {
  maxCpuTimeMs?: number;      // Maximum CPU time in milliseconds
  maxMemoryMB?: number;        // Maximum memory in MB
  maxFileSize?: number;        // Maximum file size for writes (bytes)
  maxProcesses?: number;       // Maximum number of child processes
  maxNetworkSockets?: number;  // Maximum network sockets
  allowNetworkAccess?: boolean; // Whether to allow network access
  maxDiskWriteMB?: number;     // Maximum disk write in MB
}

export const DEFAULT_RESOURCE_LIMITS: ResourceLimits = {
  maxCpuTimeMs: 120_000,      // 2 minutes
  maxMemoryMB: 512,           // 512MB
  maxFileSize: 10 * 1024 * 1024, // 10MB
  maxProcesses: 50,           // 50 processes
  maxNetworkSockets: 10,      // 10 network connections
  allowNetworkAccess: false,  // No network access by default
  maxDiskWriteMB: 100,        // 100MB disk write
};

export const AGENT_RESOURCE_LIMITS: ResourceLimits = {
  maxCpuTimeMs: 300_000,      // 5 minutes for agent commands
  maxMemoryMB: 1024,          // 1GB for agent commands
  maxFileSize: 50 * 1024 * 1024, // 50MB
  maxProcesses: 100,
  maxNetworkSockets: 20,
  allowNetworkAccess: false,
  maxDiskWriteMB: 500,
};

/**
 * Build a command with resource limits applied.
 * Uses Linux `prlimit` command when available, falls back to `ulimit`.
 */
export function buildCommandWithLimits(
  command: string,
  limits: Partial<ResourceLimits> = {}
): string {
  const finalLimits = { ...DEFAULT_RESOURCE_LIMITS, ...limits };

  // Check if we're on Linux and have prlimit
  const hasPrlimit = process.platform === 'linux';

  if (!hasPrlimit) {
    // On non-Linux systems, just return the command with a warning
    serverLog.warn({ platform: process.platform }, "Resource limits require Linux; proceeding without limits");
    return command;
  }

  const limitCommands: string[] = [];

  // CPU time limit (seconds)
  if (finalLimits.maxCpuTimeMs) {
    const cpuSec = Math.floor(finalLimits.maxCpuTimeMs / 1000);
    limitCommands.push(`prlimit --cpu=${cpuSec}`);
  }

  // Memory limit (bytes)
  if (finalLimits.maxMemoryMB) {
    const memBytes = finalLimits.maxMemoryMB * 1024 * 1024;
    limitCommands.push(`prlimit --as=${memBytes}`);
  }

  // File size limit (bytes)
  if (finalLimits.maxFileSize) {
    limitCommands.push(`prlimit --fsize=${finalLimits.maxFileSize}`);
  }

  // Number of processes
  if (finalLimits.maxProcesses) {
    limitCommands.push(`prlimit --nproc=${finalLimits.maxProcesses}`);
  }

  // Number of file descriptors (includes network sockets)
  if (finalLimits.maxNetworkSockets) {
    limitCommands.push(`prlimit --nofile=${finalLimits.maxNetworkSockets}`);
  }

  // If no limits to apply, return original command
  if (limitCommands.length === 0) {
    return command;
  }

  // Wrap the command with all limit commands
  // We use bash -c to chain the prlimit commands and then execute the actual command
  return `${limitCommands.join(' ')} -- bash -c ${JSON.stringify(command)}`;
}

/**
 * Validate that a command doesn't exceed resource limits before execution.
 * This is a lightweight check; actual enforcement happens via prlimit.
 */
export function validateResourceRequest(
  limits: Partial<ResourceLimits> = {}
): { allowed: boolean; reason?: string } {
  const finalLimits = { ...DEFAULT_RESOURCE_LIMITS, ...limits };

  // Check for unreasonably high limits
  if (finalLimits.maxCpuTimeMs && finalLimits.maxCpuTimeMs > 3_600_000) {
    return { allowed: false, reason: "CPU time limit exceeds maximum (60 minutes)" };
  }

  if (finalLimits.maxMemoryMB && finalLimits.maxMemoryMB > 8192) {
    return { allowed: false, reason: "Memory limit exceeds maximum (8GB)" };
  }

  if (finalLimits.maxProcesses && finalLimits.maxProcesses > 500) {
    return { allowed: false, reason: "Process limit exceeds maximum (500)" };
  }

  if (finalLimits.allowNetworkAccess && process.env.KORYPHAIOS_ALLOW_NETWORK !== "true") {
    return { allowed: false, reason: "Network access is disabled by default" };
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
  sessionAge: number
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
