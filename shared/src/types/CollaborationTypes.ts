export type CollaborationRole = 'viewer' | 'collaborator' | 'yolo' | 'models' | 'custom';
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
  /** May consume the host's SHARED PROVIDERS for remote inference in their own
   *  local workspace (distinct from submitting prompts into the host session). */
  useRemoteProviders?: boolean;
  readPaths: string[];
  writePaths: string[];
  commandAllowlist: string[];
  commandBlocklist: string[];
}

export interface CollaborationAccessTier {
  id: string;
  name: string;
  description: string;
  builtin: 'viewer' | 'collaborator' | 'yolo' | 'models' | null;
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
  { id: 'collaborator', name: 'Collaborator', description: 'Can propose work; the host approves execution. Can use shared providers.', builtin: 'collaborator', color: '#f59e0b', allowedModels: [], reasoningByModel: {}, permissions: permissions({ submitPrompts: true, useRemoteProviders: true }) },
  { id: 'yolo', name: 'YOLO', description: 'Unrestricted prompt, model, tool, and filesystem access. Use only for trusted people.', builtin: 'yolo', color: '#ef4444', allowedModels: ['*'], reasoningByModel: {}, permissions: permissions({ viewSystemMessages: true, submitPrompts: true, autoExecutePrompts: true, useTools: true, fullSystemAccess: true, readPaths: ['**'], writePaths: ['**'], commandAllowlist: ['*'], useRemoteProviders: true }) },
  // Dedicated "share my models" tier — grants ONLY remote-provider inference.
  // No session view, no prompts, no filesystem: the guest never sees the host's
  // work, they only borrow the host's models for their own local workspace.
  // Remote model users can read+edit (edits apply to THEIR OWN files) but
  // cannot run shell commands on the host (fullSystemAccess:false). The host
  // raises this per-tier if they trust the guest with their machine.
  { id: 'models', name: 'Model Access', description: 'Use the host’s shared models in their own workspace. CLI models can read+edit their files but cannot run shell commands on the host.', builtin: 'models', color: '#a78bfa', allowedModels: ['*'], reasoningByModel: {}, permissions: permissions({ viewChat: false, viewDiffs: false, viewAgentStatus: false, viewParticipants: false, useTools: true, useRemoteProviders: true }) },
];

export const DEFAULT_COLLABORATION_POLICY: CollaborationPolicy = {
  sessionName: 'Team session', workspacePaths: [], modelCatalog: [], joinMode: 'approval', defaultTierId: 'viewer', accessTiers: DEFAULT_COLLABORATION_TIERS,
  allowedModels: [], allowPrompts: true, requirePromptApproval: true,
  showDiffs: true, showAgentStatus: true, showParticipants: true,
};
