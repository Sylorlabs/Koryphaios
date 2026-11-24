import { NOTE_TOOL_DEFINITIONS } from '@koryphaios/shared';
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

/** How much confinement a permission preset asks for.
 *
 *  The permission presets are the user's own statement about how much they want
to be asked, so they are also where confinement strictness belongs. Guarded is
the strict end: every agent shell is confined and the two settings that open
reach beyond the workspace, network and path escape, are forced closed. Yolo is
the permissive end: the user has said the run is unconstrained. Custom keeps
exactly the granular settings the user chose.
 *
 *  This never removes a capability the permission policy grants. Computer use
 *  is allowed by policy and its window allowance is added by
 *  `OsSandboxOptions.allowWindowCapture`, so a guarded session can still drive a
 *  window: strictness narrows reach, it does not contradict a grant. */
export type SandboxPosture = 'strict' | 'standard' | 'unconstrained';

export function sandboxPostureForPermissionMode(
  mode: PermissionMode | undefined,
): SandboxPosture {
  if (mode === 'guarded') return 'strict';
  if (mode === 'yolo') return 'unconstrained';
  return 'standard';
}

/** Resolve the effective sandbox flags for a tool execution context.
 *
 *  Confinement and approval used to be fully independent, and the granular
 *  `sandbox` settings still describe the standard posture. The permission preset
 *  now sets the end of the range: guarded forces confinement and closes network
 *  and path reach, yolo runs the shell unconfined because the user asked for an
 *  unconstrained run, and every other preset keeps the granular settings. The
 *  preset can only ever be outranked by `workspace.sandbox === 'always'`, which
 *  is the explicit request to confine even a yolo run.
 *
 *  `naturalSandboxed` is whether the execution path would normally be
 *  sandboxed (plan/critic/worker = true, direct manager = false). The
 *  configured `sandbox.mode` overrides this:
 *  - 'off'    → never sandbox (isSandboxed = false, granular flags inert),
 *               even under guarded, because the user turned it off explicitly
 *  - 'always' → sandbox every agent bash call
 *  - 'auto'   → guarded confines, yolo does not, everything else honors the
 *               natural per-path behavior
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
  const posture = sandboxPostureForPermissionMode(settings?.permissionMode);

  let requested: boolean;
  if (workspaceSandbox === 'always') requested = true;
  else if (workspaceSandbox === 'off') requested = false;
  else if (sandbox.mode === 'off') requested = false;
  else if (sandbox.mode === 'always') requested = true;
  else if (posture === 'unconstrained') requested = false;
  else if (posture === 'strict') requested = true;
  else requested = naturalSandboxed;

  // A workspace policy of 'always' is an explicit request for confinement and
  // outranks the preset in both directions; it is the only thing that confines
  // a yolo run.

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
    pathConfinement: posture === 'strict' ? true : sandbox.pathConfinement,
    network: posture === 'strict' ? false : sandbox.network,
    containerTools: sandbox.containerTools,
    degraded,
  };
}

export interface ToolPermissionPolicy {
  mode: PermissionMode;
  /** Planning is an interaction posture, not a permission preset. */
  interactionMode?: 'act' | 'plan';
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
 *  - 'manager' → Guarded workers can use manager review; other presets keep
 *                their normal user-facing policy (default)
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
 *  The chat's durable approval preset decides confinement. YOLO is the user's
 *  explicit unconstrained choice for this chat, and it covers delegated
 *  workers exactly the way it covers the manager: `resolveSandboxOptions`
 *  maps the unconstrained posture to no kernel sandbox and the tool layer
 *  drops the workspace pin, so file tools and bash behave like the manager's.
 *  Every other preset keeps the worker confined to its workspace grant no
 *  matter how autonomous the run is.
 *
 *  `subAgentApproval` governs approval prompts only and does not affect
 *  confinement; it is accepted so callers can keep passing their resolved
 *  posture. */
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

// These tools only update conversation control-plane state. They never touch
// the workspace or external systems, so they remain available regardless of
// permission mode or an action-tool blocklist.
const INTERACTION_TOOLS = new Set([
  'ask_user',
  'ask_manager',
  'rename_session',
  // Creates a new chat from copied history. It never touches the workspace or the source.
  'fork_chat',
  'request_critic_review',
  // Only reshapes what this chat's agent sees; never touches the workspace.
  'manage_context',
  // Only reshapes what the feeder injects into this chat's system prompt;
  // never touches the workspace.
  'manage_skill_feeding',
]);

/**
 * Plan mode restricts workspace mutation, not agent orchestration.
 *
 * Delegation and agent messaging schedule other agents; they do not write to
 * the workspace themselves, and each worker still runs under its own host
 * permission policy and worktree grant. Classifying them as write-capable made
 * Plan mode silently unable to use subagents, even though parallel
 * investigation is exactly what planning benefits from.
 */
const PLAN_MODE_ORCHESTRATION_TOOLS = new Set([
  'delegate_to_worker',
  'manage_agents',
  'manage_review_agents',
  'send_agent_message',
  'request_manager_relay',
  'schedule_monitor',
]);

export const READ_ONLY_TOOLS = new Set([
  'list_mcp_tools',
  'list_linked_devices',
  ...NOTE_TOOL_DEFINITIONS.filter((tool) => tool.category === 'read').map((tool) => tool.name),
  'git_inspect',
  'computer_status',
  'computer_list_apps',
  'computer_list_elements',
  'computer_observe',
  'computer_wait',
  'computer_click',
  'computer_double_click',
  'computer_move',
  'computer_drag',
  'computer_type',
  'computer_key',
  'computer_scroll',
  'computer_focus',
  'computer_place_window',
  'computer_sequence',
  'read_file',
  'grep',
  'glob',
  'ls',
  'diff',
  'web_search',
  'web_fetch',
  'view_image',
  'fetch_context',
  'list_sessions',
  'read_session',
  'get_resource_budget',
  'load_skill_detail',
  'list_notes',
  'search_notes',
  'read_note',
  'recall_notes',
  'retrieve_note_context',
  'render_note',
  'get_note_backlinks',
  'get_note_graph_summary',
  'get_note_properties',
  'query_note_base',
  'list_checklists',
  'read_checklist',
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

/** Tools the user always approves except in YOLO, whatever the preset's
 *  default for a generic non-read action would be. merge_chat_back writes the
 *  chat's work into the shared folder: in YOLO the merge runs without asking,
 *  in every other mode the user approves it first. Explicit block/ask/allow
 *  lists and Plan mode keep their existing precedence (checked earlier). */
export const APPROVAL_UNLESS_YOLO_TOOLS = new Set(['merge_chat_back']);

const RISKY_TOOLS = new Set([
  'computer_click',
  'computer_double_click',
  'computer_move',
  'computer_drag',
  'computer_type',
  'computer_key',
  'computer_scroll',
  'computer_focus',
  'computer_place_window',
  'computer_sequence',
  'delete_file',
  'delete_note',
  'shell_manage',
  'commit_and_create_pr',
  'git_switch',
  'manage_mcp_server',
  'delete_checklist',
]);

export function resolveToolPermissionPolicy(
  settings: AgentSettings,
  interactionMode: 'act' | 'plan' = 'act',
): ToolPermissionPolicy {
  const mode = settings.permissionMode;
  const tierEntry = settings.toolPermissionsByTier?.[mode as string];
  const fallbackAllow = settings.toolAllowlist ?? [];
  const fallbackBlock = settings.toolBlocklist ?? [];
  return {
    mode,
    interactionMode,
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

  // Planning is an interaction posture the host enforces itself: while the user
  // is still planning, nothing that can mutate the workspace may run, whatever
  // the preset, allowlist, or per-tier Ask/Allow lists say. Reads stay available
  // so the agent can investigate before proposing a plan, and orchestration
  // tools stay available because delegating investigation is part of planning.
  if (
    policy.interactionMode === 'plan' &&
    !READ_ONLY_TOOLS.has(toolName) &&
    !PLAN_MODE_ORCHESTRATION_TOOLS.has(toolName)
  ) {
    return {
      action: 'deny',
      reason: 'Planning mode blocked write-capable tool: switch to Act to make changes',
    };
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

  // Chat organization is available in every mode, including Plan, without
  // granting file writes or bypassing explicit per-tool block/ask settings.
  if (toolName === 'rename_session') {
    return { action: 'allow', reason: 'Session title metadata does not require approval' };
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

  //
  if (policy.mode === 'yolo') {
    return { action: 'allow', reason: 'YOLO mode bypasses local approval prompts' };
  }
  if (APPROVAL_UNLESS_YOLO_TOOLS.has(toolName)) {
    return {
      action: 'ask',
      reason: "Merging this chat's copy back into the folder needs your approval",
    };
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
