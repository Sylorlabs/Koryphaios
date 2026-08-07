import type { AgentSettings } from '../agent-settings';

export type PermissionMode = AgentSettings['permissionMode'];

export interface ToolPermissionPolicy {
  mode: PermissionMode;
  autoRunTools: boolean;
  autoApplySafeFixes: boolean;
  confirmRiskyActions: boolean;
  autonomyLimitsEnabled: boolean;
  approvalThresholdFiles: number;
  approvalThresholdLines: number;
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
    mode: interactionMode === 'plan' ? 'plan' : settings.permissionMode,
    autoRunTools: settings.autoRunTools !== false,
    autoApplySafeFixes: settings.autoApplySafeFixes === true,
    confirmRiskyActions: settings.confirmRuleViolations !== false,
    autonomyLimitsEnabled: settings.autonomyLimitsEnabled === true,
    approvalThresholdFiles: settings.approvalThresholdFiles,
    approvalThresholdLines: settings.approvalThresholdLines,
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
