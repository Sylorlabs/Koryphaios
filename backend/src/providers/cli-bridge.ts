// Generalized CLI-provider deep-integration bridge.
//
// Every native CLI harness (devin, claude-code, codex, cline, cursor,
// antigravity, grok, kimicode) can implement this surface so Koryphaios
// replaces the CLI's internal tool calls, context editing, reasoning, and
// notes/context handling with Koryphaios-owned equivalents as far as the CLI
// allows. The CLI becomes a pluggable harness; Koryphaios stays the
// orchestration / context / permission owner.
//
// Each phase of the deep-integration checklist maps to a method here:
//   Phase 0 → CliCapabilities (probe)
//   Phase 1 → buildAgentConfig / buildPermissionScopes (declarative config)
//   Phase 2 → parseTrajectory (ATIF / NDJSON export)
//   Phase 3 → buildHooks (lifecycle hook bridge)
//   Phase 4 → buildMcpConfig (MCP tool bridge)
//   Phase 5 → transport: 'acp' (structured protocol)
//   Phase 6 → buildRules / buildSkills (rules & skills mirroring)
//
// Providers implement only the levers their CLI exposes; the base
// `ManagedCliBridge` returns null/empty for everything so a provider can opt in
// incrementally without breaking the legacy stdout+export path.

import type { SandboxPolicy, ProviderName } from '@koryphaios/shared';
import type { HarnessRole } from './provider-harness';
import type { ProviderEvent, ProviderToolDef, StreamRequest } from './types';
import type { KoryBridgeGrantLease } from './bridge-grant';

// ─── Capabilities (Phase 0) ────────────────────────────────────────────────

export interface CliCapabilities {
  /** CLI binary path the probe ran against. */
  binaryPath: string;
  /** CLI version string, if discoverable. */
  version: string | null;
  /** Supports a declarative per-turn config file (devin --agent-config). */
  supportsAgentConfig: boolean;
  /** Supports OS-level process sandboxing (devin --sandbox, codex --sandbox). */
  supportsSandbox: boolean;
  /** Supports a trajectory export (devin --export ATIF, codex --json). */
  supportsExport: boolean;
  /** Supports a permission-mode flag. */
  supportsPermissionMode: boolean;
  /** Supports an ACP / structured stdio protocol. */
  supportsAcp: boolean;
  /** Supports connecting MCP servers. */
  supportsMcp: boolean;
  /** Supports always-on rules. */
  supportsRules: boolean;
  /** Supports agent-invocable skills. */
  supportsSkills: boolean;
  /** Supports lifecycle hooks. */
  supportsHooks: boolean;
  /** Probed at (ms); 0 = not yet probed. */
  probedAt: number;
}

export const EMPTY_CLI_CAPABILITIES: CliCapabilities = {
  binaryPath: '',
  version: null,
  supportsAgentConfig: false,
  supportsSandbox: false,
  supportsExport: false,
  supportsPermissionMode: false,
  supportsAcp: false,
  supportsMcp: false,
  supportsRules: false,
  supportsSkills: false,
  supportsHooks: false,
  probedAt: 0,
};

// ─── Permission scopes (Phase 1) ───────────────────────────────────────────

/** A CLI-agnostic permission scope. Each CLI translates this into its own
 *  matcher syntax (Devin `Read(glob)`/`Write(glob)`/`Exec(prefix)`/`Fetch`,
 *  Claude `--allowedTools`/`--disallowedTools`, Codex `--sandbox`). */
export interface CliPermissionScopes {
  allow: string[];
  deny: string[];
  ask: string[];
}

// ─── Agent config (Phase 1) ────────────────────────────────────────────────

/** A declarative per-turn CLI config. Each CLI serializes only the fields it
 *  supports; unsupported fields are dropped by the builder. */
export interface CliAgentConfig {
  systemInstructions: string[];
  allowedTools: string[];
  permissions: CliPermissionScopes;
  /** Free-form provenance metadata the CLI echoes back in its trajectory. */
  extensions: Record<string, unknown>;
}

// ─── Hooks (Phase 3) ───────────────────────────────────────────────────────

export type CliHookEvent =
  | 'PreToolUse'
  | 'PostToolUse'
  | 'PermissionRequest'
  | 'UserPromptSubmit'
  | 'Stop'
  | 'SessionStart'
  | 'SessionEnd';

export interface CliHookConfig {
  events: CliHookEvent[];
  /** Command the CLI runs per matching event (receives event JSON on stdin). */
  command: string;
  /** Regex matcher on the hook event's tool_name (empty = all). */
  matcher?: string;
}

// ─── MCP (Phase 4) ─────────────────────────────────────────────────────────

export interface CliMcpServerConfig {
  /** Server name the CLI exposes tools under (`mcp__<name>__<tool>`). */
  name: string;
  command: string;
  args: string[];
  env?: Record<string, string>;
  transport: 'stdio' | 'http' | 'sse';
  url?: string;
}

// ─── Rules & skills (Phase 6) ──────────────────────────────────────────────

export interface CliRuleFile {
  /** Absolute path to write (e.g. <home>/AGENTS.md or <home>/.devin/AGENTS.md). */
  path: string;
  content: string;
}

export interface CliSkillFile {
  /** Absolute path to the SKILL.md (e.g. <home>/.devin/skills/<name>/SKILL.md). */
  path: string;
  content: string;
}

// ─── Trajectory parsing (Phase 2) ──────────────────────────────────────────

export interface CliTrajectoryStep {
  source: 'system' | 'user' | 'agent' | 'tool' | string;
  message?: string;
  reasoning?: string;
  toolCalls?: Array<{ name: string; input: Record<string, unknown>; output?: string }>;
  modelName?: string;
  generationModel?: string;
  metrics?: Record<string, unknown>;
}

export interface CliTrajectory {
  schemaVersion?: string;
  sessionId?: string;
  agentName?: string;
  agentVersion?: string;
  modelName?: string;
  toolDefinitions?: Array<{ name: string }>;
  steps: CliTrajectoryStep[];
  finalMetrics?: {
    promptTokens?: number;
    completionTokens?: number;
    cachedTokens?: number;
    totalSteps?: number;
  };
  /** Raw provenance metadata echoed from the agent-config extensions. */
  extensions?: Record<string, unknown>;
}

// ─── Bridge interface ──────────────────────────────────────────────────────

export interface CliBridgeContext {
  provider: ProviderName;
  role: HarnessRole;
  sandbox: SandboxPolicy | undefined;
  workingDirectory: string;
  sessionId?: string;
  systemPrompt: string;
  tools: ProviderToolDef[];
  promptManifestHash?: string;
  taskContractHash?: string;
  /** Per-provider-turn ownership for short-lived MCP/hook capabilities. */
  bridgeGrantLease?: KoryBridgeGrantLease;
}

export interface CliBridge {
  readonly provider: ProviderName;
  /** Probe the installed CLI for its capabilities (Phase 0). */
  getCapabilities(): CliCapabilities;
  /** Translate a Kory SandboxPolicy + role into CLI permission scopes (Phase 1). */
  buildPermissionScopes(ctx: CliBridgeContext): CliPermissionScopes;
  /** Build the declarative per-turn config (Phase 1). Returns null if the CLI
   *  has no agent-config support. */
  buildAgentConfig(ctx: CliBridgeContext): CliAgentConfig | null;
  /** Serialize the agent config to the CLI's file format. */
  serializeAgentConfig(config: CliAgentConfig): string;
  /** Build lifecycle hooks (Phase 3). Returns null if the CLI has no hooks. */
  buildHooks(ctx: CliBridgeContext): CliHookConfig[] | null;
  /** Serialize hooks to the CLI's file format. */
  serializeHooks(hooks: CliHookConfig[]): string;
  /** Build MCP server configs (Phase 4). Returns null if the CLI has no MCP. */
  buildMcpConfig(ctx: CliBridgeContext): CliMcpServerConfig[] | null;
  /** Build rules files (Phase 6). Returns null if the CLI has no rules. */
  buildRules(ctx: CliBridgeContext): CliRuleFile[] | null;
  /** Build skill files (Phase 6). Returns null if the CLI has no skills. */
  buildSkills(ctx: CliBridgeContext): CliSkillFile[] | null;
  /** Parse a trajectory export into ProviderEvents (Phase 2). */
  parseTrajectory(raw: string): { trajectory: CliTrajectory; events: ProviderEvent[] };
  /** The CLI's preferred transport when available (Phase 5). */
  preferredTransport: 'acp' | 'agent-config' | 'legacy';
}

// ─── Base implementation (opt-in) ──────────────────────────────────────────

/** A no-op base so providers can override only the levers their CLI exposes.
 *  Every method returns null/empty, preserving the legacy stdout+export path. */
export abstract class ManagedCliBridge implements CliBridge {
  abstract readonly provider: ProviderName;
  abstract getCapabilities(): CliCapabilities;
  abstract preferredTransport: 'acp' | 'agent-config' | 'legacy';

  buildPermissionScopes(_ctx: CliBridgeContext): CliPermissionScopes {
    return { allow: [], deny: [], ask: [] };
  }
  buildAgentConfig(_ctx: CliBridgeContext): CliAgentConfig | null {
    return null;
  }
  serializeAgentConfig(_config: CliAgentConfig): string {
    return '{}';
  }
  buildHooks(_ctx: CliBridgeContext): CliHookConfig[] | null {
    return null;
  }
  serializeHooks(_hooks: CliHookConfig[]): string {
    return '{}';
  }
  buildMcpConfig(_ctx: CliBridgeContext): CliMcpServerConfig[] | null {
    return null;
  }
  buildRules(_ctx: CliBridgeContext): CliRuleFile[] | null {
    return null;
  }
  buildSkills(_ctx: CliBridgeContext): CliSkillFile[] | null {
    return null;
  }
  parseTrajectory(_raw: string): { trajectory: CliTrajectory; events: ProviderEvent[] } {
    return { trajectory: { steps: [] }, events: [] };
  }
}

// ─── Shared permission-scope translator ────────────────────────────────────

/** Translate a Kory SandboxPolicy into the CLI-agnostic scope form. Each CLI's
 *  bridge maps these to its own matcher syntax. The mapping is conservative:
 *  a denied capability becomes a deny scope; an allowed capability is left
 *  open (the CLI's own defaults apply) unless the role tightens it. */
export function sandboxToScopes(
  sandbox: SandboxPolicy | undefined,
  role: HarnessRole,
): CliPermissionScopes {
  const deny: string[] = [];
  const allow: string[] = [];
  const ask: string[] = [];

  if (sandbox) {
    if (!sandbox.allowEdits) deny.push('Write(**)');
    if (!sandbox.allowShell) deny.push('Exec(*)');
    if (!sandbox.allowWebSearch) deny.push('Fetch(*)');
    for (const fragment of sandbox.commandBlocklist) {
      // Blocklist fragments map to Exec prefix denies where the CLI supports it.
      deny.push(`Exec(${fragment})`);
    }
  }

  // The critic role is read-only regardless of sandbox.
  if (role === 'critic') {
    deny.push('Write(**)');
    deny.push('Exec(*)');
  }

  return { allow, deny: [...new Set(deny)], ask };
}

/** Map a Kory harness role to a CLI permission mode string. Each CLI's bridge
 *  can override; this gives the common mapping. */
export function roleToPermissionMode(
  role: HarnessRole,
  sandbox: SandboxPolicy | undefined,
): 'plan' | 'accept-edits' | 'auto' | 'dangerous' | 'read-only' | 'workspace-write' {
  if (role === 'critic') return 'plan';
  if (sandbox?.preset === 'readonly') return 'read-only';
  if (sandbox?.preset === 'hardened') return 'read-only';
  // Manager/worker with edits allowed.
  return 'accept-edits';
}

/** Common provenance extensions written into every agent-config so the CLI
 *  echoes them back in its trajectory for correlation. */
export function koryProvenanceExtensions(ctx: CliBridgeContext): Record<string, unknown> {
  return {
    kory_provider: ctx.provider,
    kory_role: ctx.role,
    kory_session_id: ctx.sessionId,
    kory_prompt_manifest_hash: ctx.promptManifestHash,
    kory_task_contract_hash: ctx.taskContractHash,
    kory_working_directory: ctx.workingDirectory,
  };
}
