// Sandbox policy for REMOTE CLI-harness turns.
//
// When a guest runs the host's CLI models, the CLI executes on the host's
// machine. A temp folder alone is not a security boundary, so the host can
// impose a real sandbox. This policy is fully customizable, with sensible
// presets. Two enforcement layers:
//   1. OS-level (bubblewrap on Linux): the CLI is jailed to the project dir,
//      cannot read the host's other files, and its network can be cut.
//   2. Tool-level (all platforms): the CLI harness's own tools are gated
//      (edits / shell / web) as defense-in-depth and the cross-platform floor.
//
// The default ("Balanced") is deliberately the LEAST limiting configuration
// that still removes the big risks: the agent keeps network, web search, shell,
// and edits, but is jailed to the project so it can't reach the host's secrets.

export type SandboxPreset = 'balanced' | 'hardened' | 'readonly' | 'trusted' | 'custom';

export interface SandboxPolicy {
  preset: SandboxPreset;
  /** OS-level jail: bind only the project (+ the CLI's own config) so the CLI
   *  cannot read the host's home, keys, or other projects. Requires bubblewrap
   *  on Linux; degrades to tool-level gating where unavailable. */
  filesystemIsolation: boolean;
  /** Allow the sandboxed CLI to reach the network (web search, package installs,
   *  API calls). Kept ON by default — agents often need it. Only truly enforced
   *  when the OS sandbox is active. */
  allowNetwork: boolean;
  /** CLI may run shell commands (Bash tool). Runs on the HOST, so this is the
   *  host's main risk knob — but within the jail when FS isolation is on. */
  allowShell: boolean;
  /** CLI may create/edit files. Edits sync back to the GUEST's project. */
  allowEdits: boolean;
  /** CLI may use its web search / fetch tools. */
  allowWebSearch: boolean;
  /** Best-effort: shell command substrings to hard-refuse (e.g. "rm -rf /").
   *  Enforced at the harness level where the CLI exposes it; not a guarantee. */
  commandBlocklist: string[];
  /** Kill a turn that runs longer than this (seconds). 0 = no limit. */
  maxRuntimeSeconds: number;
}

// A short list of catastrophic command fragments blocked even in permissive
// presets — cheap insurance against the worst accidents.
const CATASTROPHIC = [
  'rm -rf /', 'rm -rf ~', 'mkfs', ':(){', 'shutdown', 'reboot', 'dd if=', '> /dev/sda',
];

export const SANDBOX_PRESETS: Record<Exclude<SandboxPreset, 'custom'>, SandboxPolicy> = {
  // Default. Jailed to the project, but fully capable inside it.
  balanced: {
    preset: 'balanced',
    filesystemIsolation: true,
    allowNetwork: true,
    allowShell: true,
    allowEdits: true,
    allowWebSearch: true,
    commandBlocklist: [...CATASTROPHIC],
    maxRuntimeSeconds: 900,
  },
  // Locked down: jailed, no network, no shell. Read + edit only.
  hardened: {
    preset: 'hardened',
    filesystemIsolation: true,
    allowNetwork: false,
    allowShell: false,
    allowEdits: true,
    allowWebSearch: false,
    commandBlocklist: [...CATASTROPHIC],
    maxRuntimeSeconds: 600,
  },
  // Analysis only: jailed, no network, no shell, no edits.
  readonly: {
    preset: 'readonly',
    filesystemIsolation: true,
    allowNetwork: false,
    allowShell: false,
    allowEdits: false,
    allowWebSearch: false,
    commandBlocklist: [...CATASTROPHIC],
    maxRuntimeSeconds: 600,
  },
  // Full trust: no OS jail, everything on. Only for people you fully trust with
  // your machine — equivalent to running the CLI yourself.
  trusted: {
    preset: 'trusted',
    filesystemIsolation: false,
    allowNetwork: true,
    allowShell: true,
    allowEdits: true,
    allowWebSearch: true,
    commandBlocklist: [],
    maxRuntimeSeconds: 0,
  },
};

export const DEFAULT_SANDBOX_POLICY: SandboxPolicy = SANDBOX_PRESETS.balanced;

/** Combine two policies to the STRICTER of each option (a joining guest's tier
 *  can only tighten the host's base policy, never loosen it). */
export function tightenSandbox(base: SandboxPolicy, limit: Partial<SandboxPolicy>): SandboxPolicy {
  return {
    preset: 'custom',
    filesystemIsolation: base.filesystemIsolation || limit.filesystemIsolation === true,
    allowNetwork: base.allowNetwork && limit.allowNetwork !== false,
    allowShell: base.allowShell && limit.allowShell !== false,
    allowEdits: base.allowEdits && limit.allowEdits !== false,
    allowWebSearch: base.allowWebSearch && limit.allowWebSearch !== false,
    commandBlocklist: [...new Set([...base.commandBlocklist, ...(limit.commandBlocklist ?? [])])],
    maxRuntimeSeconds:
      base.maxRuntimeSeconds === 0
        ? (limit.maxRuntimeSeconds ?? 0)
        : Math.min(base.maxRuntimeSeconds, limit.maxRuntimeSeconds || base.maxRuntimeSeconds),
  };
}
