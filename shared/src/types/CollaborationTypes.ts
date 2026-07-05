export type CollaborationRole = 'viewer' | 'collaborator' | 'yolo' | 'custom';
export type CollaborationJoinMode = 'approval' | 'auto';

export interface CollaborationTierPermissions {
  viewChat: boolean;
  viewSystemMessages: boolean;
  viewDiffs: boolean;
  viewAgentStatus: boolean;
  viewParticipants: boolean;
  submitPrompts: boolean;
  autoExecutePrompts: boolean;
  useTools: boolean;
  fullSystemAccess: boolean;
  readPaths: string[];
  writePaths: string[];
  commandAllowlist: string[];
  commandBlocklist: string[];
}

export interface CollaborationAccessTier {
  id: string;
  name: string;
  description: string;
  builtin: 'viewer' | 'collaborator' | 'yolo' | null;
  color: string;
  allowedModels: string[];
  /** Host-approved reasoning levels keyed by provider:model. Empty means provider default only. */
  reasoningByModel: Record<string, string[]>;
  permissions: CollaborationTierPermissions;
}

export interface CollaborationPolicy {
  sessionName: string;
  /** Host-selected workspace roots exposed to this collaboration session. */
  workspacePaths: string[];
  modelCatalog: Array<{ id: string; label: string; provider: string; reasoningLevels: string[] }>;
  joinMode: CollaborationJoinMode;
  defaultTierId: string;
  accessTiers: CollaborationAccessTier[];
  // Legacy aggregate fields retained for older relay/app compatibility.
  allowedModels: string[];
  allowPrompts: boolean;
  requirePromptApproval: boolean;
  showDiffs: boolean;
  showAgentStatus: boolean;
  showParticipants: boolean;
}

const permissions = (overrides: Partial<CollaborationTierPermissions> = {}): CollaborationTierPermissions => ({
  viewChat: true, viewSystemMessages: false, viewDiffs: true, viewAgentStatus: true,
  viewParticipants: true, submitPrompts: false, autoExecutePrompts: false,
  useTools: false, fullSystemAccess: false, readPaths: [], writePaths: [], commandAllowlist: [], commandBlocklist: [], ...overrides,
});

export const DEFAULT_COLLABORATION_TIERS: CollaborationAccessTier[] = [
  { id: 'viewer', name: 'Viewer', description: 'Read-only access to the shared session.', builtin: 'viewer', color: '#60a5fa', allowedModels: [], reasoningByModel: {}, permissions: permissions() },
  { id: 'collaborator', name: 'Collaborator', description: 'Can propose work; the host approves execution.', builtin: 'collaborator', color: '#f59e0b', allowedModels: [], reasoningByModel: {}, permissions: permissions({ submitPrompts: true }) },
  { id: 'yolo', name: 'YOLO', description: 'Unrestricted prompt, model, tool, and filesystem access. Use only for trusted people.', builtin: 'yolo', color: '#ef4444', allowedModels: ['*'], reasoningByModel: {}, permissions: permissions({ viewSystemMessages: true, submitPrompts: true, autoExecutePrompts: true, useTools: true, fullSystemAccess: true, readPaths: ['**'], writePaths: ['**'], commandAllowlist: ['*'] }) },
];

export const DEFAULT_COLLABORATION_POLICY: CollaborationPolicy = {
  sessionName: 'Team session', workspacePaths: [], modelCatalog: [], joinMode: 'approval', defaultTierId: 'viewer', accessTiers: DEFAULT_COLLABORATION_TIERS,
  allowedModels: [], allowPrompts: true, requirePromptApproval: true,
  showDiffs: true, showAgentStatus: true, showParticipants: true,
};
