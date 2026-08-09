import type { AgentSettings, SandboxSettings } from '../agent-settings';
import { DEFAULT_SANDBOX_SETTINGS } from '../agent-settings';

export type PermissionMode = AgentSettings['permissionMode'] | 'sub-agent-user';

/** Effective sandbox flags handed to ToolContext. `isSandboxed` is the
 *  master switch; the granular flags only suppress checks while it is true. */
export interface ResolvedSandboxOptions {
  isSandboxed: boolean;
  commandWhitelist: boolean;
  metacharacters: boolean;
  pathConfinement: boolean;
  network: boolean;
  containerTools: boolean;
}

/** Resolve the effective sandbox flags for a tool execution context.
 *
 *  `naturalSandboxed` is whether the execution path would normally be
 *  sandboxed (plan/critic/worker = true, direct manager = false). The
 *  configured `sandbox.mode` overrides this:
 *  - 'off'    → never sandbox (isSandboxed = false, granular flags inert)
 *  - 'always' → sandbox every agent bash call
 *  - 'auto'   → honor the natural per-path behavior
 *
 *  YOLO permission mode bypasses the sandbox entirely — including for
 *  sub-agents (workers, critic) — so nothing prompts or blocks while the
 *  user has opted into full autonomy. Catastrophic-command hard floors in
 *  the bash validator still apply, but the sandbox confinement checks do not.
 *
 *  Granular toggles are taken from settings but only matter while sandboxed. */
export function resolveSandboxOptions(
  settings: Pick<AgentSettings, 'sandbox' | 'permissionMode'> | undefined,
  naturalSandboxed: boolean,
): ResolvedSandboxOptions {
  const sandbox: SandboxSettings = settings?.sandbox ?? DEFAULT_SANDBOX_SETTINGS;
  const isYolo = settings?.permissionMode === 'yolo';
  const isSandboxed = isYolo
    ? false
    : sandbox.mode === 'off'
      ? false
      : sandbox.mode === 'always'
        ? true
        : naturalSandboxed;
  return {
    isSandboxed,
    commandWhitelist: sandbox.commandWhitelist,
    metacharacters: sandbox.metacharacters,
    pathConfinement: sandbox.pathConfinement,
    network: sandbox.network,
    containerTools: sandbox.containerTools,
  };
}

export interface ToolPermissionPolicy {
  mode: PermissionMode;
  autoRunTools: boolean;
  autoApplySafeFixes: boolean;
  confirmRiskyActions: boolean;
  autonomyLimitsEnabled: boolean;
  approvalThresholdFiles: number;
  approvalThresholdLines: number;
  /** Tool names that always bypass approval (checked after blocklist). */
  toolAllowlist: string[];
  /** Tool names that are always denied (checked before everything else). */
  toolBlocklist: string[];
}

export type SubAgentApprovalMode = 'manager' | 'user' | 'auto';

/** Resolve the effective permission policy for a sub-agent (worker).
 *
 *  - 'manager' → inherit the manager's permission preset (default; current behavior)
 *  - 'user'    → use the dedicated sub-agent-user mode: reads and searches are
 *                free, but file edits, risky tools, and bash prompt the user
 *  - 'auto'    → force YOLO mode so workers run with no approval prompts
 *
 *  The returned policy is what the worker's ToolContext should carry. */
export function resolveSubAgentPermissionPolicy(
  baseSettings: AgentSettings,
  subAgentApproval: SubAgentApprovalMode | undefined,
): ToolPermissionPolicy {
  const mode =
    subAgentApproval === 'user'
      ? 'sub-agent-user'
      : subAgentApproval === 'auto'
        ? 'yolo'
        : baseSettings.permissionMode;
  // 'sub-agent-user' is a valid policy mode but not a user-configurable
  // AgentSettings value — cast through unknown to satisfy the settings type.
  return resolveToolPermissionPolicy(
    { ...baseSettings, permissionMode: mode as unknown as AgentSettings['permissionMode'] },
    'act',
  );
}

/** Resolve the effective sandbox options for a sub-agent (worker).
 *
 *  'auto' approval bypasses the sandbox (YOLO-equivalent), regardless of the
 *  sandbox.mode setting. 'user' and 'manager' honor the sandbox settings.
 *
 *  The permissionMode is rewritten to match the effective policy mode so that
 *  resolveSandboxOptions's YOLO bypass fires naturally for 'auto', keeping the
 *  two sub-agent resolvers consistent. 'sub-agent-user' is not YOLO, so the
 *  sandbox stays active for 'user' mode. */
export function resolveSubAgentSandboxOptions(
  baseSettings: AgentSettings,
  subAgentApproval: SubAgentApprovalMode | undefined,
  naturalSandboxed: boolean,
): ResolvedSandboxOptions {
  const effectiveMode =
    subAgentApproval === 'user'
      ? 'sub-agent-user'
      : subAgentApproval === 'auto'
        ? 'yolo'
        : baseSettings.permissionMode;
  return resolveSandboxOptions(
    { ...baseSettings, permissionMode: effectiveMode as unknown as AgentSettings['permissionMode'] },
    naturalSandboxed,
  );
}

export type ToolPermissionDecision =
  | { action: 'allow'; reason: string }
  | { action: 'ask'; reason: string }
  | { action: 'deny'; reason: string };

const INTERACTION_TOOLS = new Set(['ask_user', 'ask_manager']);

export const READ_ONLY_TOOLS = new Set([
  'read_file',
  'grep',
  'glob',
  'ls',
  'diff',
  'web_search',
  'web_fetch',
  'view_image',
  'fetch_context',
  'get_resource_budget',
  'load_skill_detail',
  'list_notes',
  'search_notes',
  'read_note',
  'recall_notes',
  'render_note',
  'get_note_backlinks',
  'get_note_graph_summary',
  'detect-errors',
  'analyze-error',
  'suggest-fixes',
]);

export const FILE_EDIT_TOOLS = new Set([
  'write_file',
  'edit_file',
  'batch_edit',
  'patch',
  'move_file',
]);

const RISKY_TOOLS = new Set([
  'delete_file',
  'delete_note',
  'shell_manage',
  'delegate_to_jules',
  'commit_and_create_pr',
]);

export function resolveToolPermissionPolicy(
  settings: AgentSettings,
  interactionMode: 'act' | 'plan' = 'act',
): ToolPermissionPolicy {
  return {
    mode: (interactionMode === 'plan' ? 'plan' : settings.permissionMode) as PermissionMode,
    autoRunTools: settings.autoRunTools !== false,
    autoApplySafeFixes: settings.autoApplySafeFixes === true,
    confirmRiskyActions: settings.confirmRuleViolations !== false,
    autonomyLimitsEnabled: settings.autonomyLimitsEnabled === true,
    approvalThresholdFiles: settings.approvalThresholdFiles,
    approvalThresholdLines: settings.approvalThresholdLines,
    toolAllowlist: settings.toolAllowlist ?? [],
    toolBlocklist: settings.toolBlocklist ?? [],
  };
}

export function decideToolPermission(
  policy: ToolPermissionPolicy | undefined,
  toolName: string,
  change?: { fileCount: number; linesChanged: number },
): ToolPermissionDecision {
  if (!policy || INTERACTION_TOOLS.has(toolName)) {
    return { action: 'allow', reason: 'No host approval is required' };
  }

  // Blocklist takes absolute precedence — a blocked tool is never allowed,
  // regardless of permissionMode or allowlist membership.
  if (policy.toolBlocklist?.includes(toolName)) {
    return { action: 'deny', reason: `Tool '${toolName}' is blocked by the tool blocklist` };
  }

  // Allowlist bypasses all mode-based approval prompts. A tool here always
  // runs without asking (but the sandbox/bash validator still applies).
  if (policy.toolAllowlist?.includes(toolName)) {
    return { action: 'allow', reason: `Tool '${toolName}' is on the tool allowlist` };
  }

  const readOnly = READ_ONLY_TOOLS.has(toolName);
  const fileEdit = FILE_EDIT_TOOLS.has(toolName);
  const risky = RISKY_TOOLS.has(toolName);
  const exceedsAutonomyLimits = Boolean(
    change && policy.autonomyLimitsEnabled &&
      (change.fileCount > policy.approvalThresholdFiles ||
        change.linesChanged > policy.approvalThresholdLines),
  );

  if (policy.mode === 'plan') {
    return readOnly
      ? { action: 'allow', reason: 'Read-only action in Plan mode' }
      : { action: 'deny', reason: `Plan mode blocked write-capable tool ${toolName}` };
  }
  if (policy.mode === 'yolo') {
    return { action: 'allow', reason: 'YOLO mode bypasses local approval prompts' };
  }
  if (policy.mode === 'sub-agent-user') {
    // Sub-agent "I decide" mode: reads and searches are free, everything that
    // can mutate state (file edits, risky tools, bash, etc.) prompts the user.
    return readOnly
      ? { action: 'allow', reason: 'Read-only action allowed for sub-agent' }
      : { action: 'ask', reason: 'Sub-agent user mode requires approval for mutating actions' };
  }
  if (policy.mode === 'ask') {
    return { action: 'ask', reason: 'Ask mode requires approval for every tool action' };
  }
  if (policy.mode === 'edits') {
    return readOnly || fileEdit
      ? { action: 'allow', reason: fileEdit ? 'Accept Edits allows file changes' : 'Read-only action' }
      : { action: 'ask', reason: 'Accept Edits requires approval for non-file actions' };
  }
  if (policy.mode === 'guarded') {
    if (fileEdit) {
      return { action: 'allow', reason: 'Guarded mode allows all file edits' };
    }
    return risky || exceedsAutonomyLimits
      ? { action: 'ask', reason: 'Guarded mode requires approval for risky actions' }
      : { action: 'allow', reason: 'Routine action in Guarded mode' };
  }

  // Custom: every visible switch participates in the host decision.
  if ((risky || exceedsAutonomyLimits) && policy.confirmRiskyActions) {
    return { action: 'ask', reason: 'Custom policy asks before risky actions' };
  }
  if (fileEdit) {
    return policy.autoApplySafeFixes
      ? { action: 'allow', reason: 'Custom policy allows safe file edits' }
      : { action: 'ask', reason: 'Custom policy asks before file edits' };
  }
  if (!policy.autoRunTools) {
    return { action: 'ask', reason: 'Custom policy asks before routine tools' };
  }
  return { action: 'allow', reason: 'Custom policy allows this action' };
}

export function bypassLocalRiskPrompts(policy: ToolPermissionPolicy | undefined): boolean {
  return policy?.mode === 'yolo' ||
    (policy?.mode === 'custom' && policy.confirmRiskyActions === false);
}
