import type { AgentSettings, SandboxSettings } from '../agent-settings';
import { DEFAULT_SANDBOX_SETTINGS } from '../agent-settings';
import { osSandboxAvailable } from '../security/os-sandbox';
import { serverLog } from '../logger';

export type PermissionMode = AgentSettings['permissionMode'] | 'sub-agent-user';

/** Kernel sandbox policy for delegated agents, from `workspace.sandbox`. */
export type WorkspaceSandboxMode = 'auto' | 'always' | 'off';

/** Effective sandbox flags handed to ToolContext. `isSandboxed` is the
 *  master switch; the granular flags only suppress checks while it is true. */
export interface ResolvedSandboxOptions {
  isSandboxed: boolean;
  commandWhitelist: boolean;
  metacharacters: boolean;
  pathConfinement: boolean;
  network: boolean;
  containerTools: boolean;
  /** True when sandboxing was requested but no engine can enforce it. The
   *  command still runs unconfined, so callers should report the turn as
   *  unverified rather than claiming isolation. */
  degraded: boolean;
}

let warnedSandboxUnavailable = false;

/** Resolve the effective sandbox flags for a tool execution context.
 *
 *  Confinement and approval are deliberately independent. A permission mode
 *  controls *whether the user is asked*; `workspace.sandbox` controls *what the
 *  process can reach*. YOLO therefore no longer disables the sandbox: a worker
 *  running autonomously is exactly the case where kernel confinement matters
 *  most, and the worktree grant is only meaningful if it is enforced.
 *
 *  `naturalSandboxed` is whether the execution path would normally be
 *  sandboxed (plan/critic/worker = true, direct manager = false). The
 *  configured `sandbox.mode` overrides this:
 *  - 'off'    → never sandbox (isSandboxed = false, granular flags inert)
 *  - 'always' → sandbox every agent bash call
 *  - 'auto'   → honor the natural per-path behavior
 *
 *  `workspaceSandbox` is the user's delegated-agent policy:
 *  - 'off'    → workers are never confined
 *  - 'always' → confinement is required; a command is refused if it cannot bind
 *  - 'auto'   → confine when a real engine is installed, and report the turn as
 *               degraded (not silently "isolated") when one is not
 *
 *  Granular toggles are taken from settings but only matter while sandboxed. */
export function resolveSandboxOptions(
  settings: Pick<AgentSettings, 'sandbox' | 'permissionMode'> | undefined,
  naturalSandboxed: boolean,
  workspaceSandbox: WorkspaceSandboxMode = 'auto',
): ResolvedSandboxOptions {
  const sandbox: SandboxSettings = settings?.sandbox ?? DEFAULT_SANDBOX_SETTINGS;

  let requested: boolean;
  if (workspaceSandbox === 'off') requested = false;
  else if (sandbox.mode === 'off') requested = false;
  else if (workspaceSandbox === 'always' || sandbox.mode === 'always') requested = true;
  else requested = naturalSandboxed;

  // 'always' keeps requesting confinement even without an engine; the bash tool
  // refuses those commands rather than running them unconfined.
  const degraded = requested && workspaceSandbox === 'auto' && !osSandboxAvailable();
  const isSandboxed = requested && (workspaceSandbox === 'always' || !degraded);

  if (degraded && !warnedSandboxUnavailable) {
    warnedSandboxUnavailable = true;
    serverLog.warn(
      'No OS sandbox engine detected; delegated agents run without kernel confinement. ' +
        'Install bubblewrap on Linux, or set workspace.sandbox to "always" to refuse unconfined commands instead.',
    );
  }

  return {
    isSandboxed,
    commandWhitelist: sandbox.commandWhitelist,
    metacharacters: sandbox.metacharacters,
    pathConfinement: sandbox.pathConfinement,
    network: sandbox.network,
    containerTools: sandbox.containerTools,
    degraded,
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
  /** Tool names that always prompt, even when the mode default is Allow. */
  toolAsklist: string[];
}

export type SubAgentApprovalMode = 'manager' | 'user' | 'auto';

/** Resolve the effective permission policy for a sub-agent (worker).
 *
 *  - 'manager' → inherit the manager's permission preset (default; current behavior)
 *  - 'user'    → use the dedicated sub-agent-user mode: reads and searches are
 *                free, but file edits, risky tools, and bash prompt the user
 *  - 'auto'    → force YOLO mode so workers run with no approval prompts
 *
 *  This governs approval only. Kernel confinement for workers is resolved
 *  separately by `resolveSubAgentSandboxOptions` and is independent of it.
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
 *  The sub-agent's approval mode governs prompts only. It is intentionally NOT
 *  folded into the permission mode here: rewriting it to `yolo` used to
 *  short-circuit `resolveSandboxOptions` and strip kernel confinement from
 *  workers, which is precisely backwards — the more autonomous the run, the
 *  more the worktree grant needs to be enforced rather than merely intended.
 *
 *  `subAgentApproval` is accepted so callers can keep passing their resolved
 *  approval posture, but it does not affect confinement. */
export function resolveSubAgentSandboxOptions(
  baseSettings: AgentSettings,
  _subAgentApproval: SubAgentApprovalMode | undefined,
  naturalSandboxed: boolean,
  workspaceSandbox: WorkspaceSandboxMode = 'auto',
): ResolvedSandboxOptions {
  return resolveSandboxOptions(baseSettings, naturalSandboxed, workspaceSandbox);
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
  'get_note_properties',
  'query_note_base',
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
  'manage_mcp_server',
]);

export function resolveToolPermissionPolicy(
  settings: AgentSettings,
  interactionMode: 'act' | 'plan' = 'act',
): ToolPermissionPolicy {
  const mode = (interactionMode === 'plan' ? 'plan' : settings.permissionMode) as PermissionMode;
  const tierEntry = settings.toolPermissionsByTier?.[mode as string];
  const fallbackAllow = settings.toolAllowlist ?? [];
  const fallbackBlock = settings.toolBlocklist ?? [];
  return {
    mode,
    autoRunTools: settings.autoRunTools !== false,
    autoApplySafeFixes: settings.autoApplySafeFixes === true,
    confirmRiskyActions: settings.confirmRuleViolations !== false,
    autonomyLimitsEnabled: settings.autonomyLimitsEnabled === true,
    approvalThresholdFiles: settings.approvalThresholdFiles,
    approvalThresholdLines: settings.approvalThresholdLines,
    toolAllowlist: tierEntry?.allow ?? fallbackAllow,
    toolBlocklist: tierEntry?.block ?? fallbackBlock,
    toolAsklist: tierEntry?.ask ?? [],
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

  // Explicit per-tier Ask beats the mode default (e.g. forcing a read-only
  // tool to prompt in Ask mode) but never overrides an explicit block.
  if (policy.toolAsklist?.includes(toolName)) {
    return { action: 'ask', reason: `Tool '${toolName}' is set to ask for approval` };
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
    change &&
    policy.autonomyLimitsEnabled &&
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
    return readOnly
      ? { action: 'allow', reason: 'Read-only action in Ask mode' }
      : { action: 'ask', reason: 'Ask mode requires approval for mutating actions' };
  }
  if (policy.mode === 'edits') {
    return readOnly || fileEdit
      ? {
          action: 'allow',
          reason: fileEdit ? 'Accept Edits allows file changes' : 'Read-only action',
        }
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
  return (
    policy?.mode === 'yolo' || (policy?.mode === 'custom' && policy.confirmRiskyActions === false)
  );
}
