/**
 * Compute delegation contract.
 *
 * A linked computer can be used in two different ways, and the difference is a
 * product decision, not a transport detail:
 *
 * - `stay`   — the work lives on the target. This is what a chat created on
 *              that computer means: the user asked for it to run there.
 * - `return` — the other computer is used for its compute, and the resulting
 *              changes are brought back to the origin machine.
 *
 * Nothing here authorizes execution. The device grant, the target's own policy
 * and the tool permission layer remain the enforcement points. These values
 * only describe what the agent promised the user, so the transport and the
 * prompt cannot drift apart.
 */

export type DelegationPlacement = 'stay' | 'return';

/**
 * Publishing is never implied by delegation. `none` is the only default and
 * the only value an agent may choose on its own. `local` means the origin
 * machine may keep a local commit if the user explicitly asked for it; no
 * value authorizes a push.
 */
export type DelegationCommitPolicy = 'none' | 'local';

export interface ComputeDelegation {
  placement: DelegationPlacement;
  commit: DelegationCommitPolicy;
  /** Origin chat, used to label returned artifacts and to resume the thread. */
  sourceSessionId?: string;
  /** Stable id for one delegation; also names the incoming directory. */
  transferId?: string;
}

export const DELEGATION_LIMITS = {
  maxFiles: 200,
  maxPatchBytes: 1_500_000,
  maxFileBytes: 400_000,
  maxTransferBytes: 3_000_000,
} as const;

export interface DelegatedFileChange {
  /** Workspace-relative POSIX path. Never absolute, never contains `..`. */
  path: string;
  /** Short git status, for example `M`, `A`, `??`. */
  status: string;
  size: number;
  /** Inline content for untracked text files that the patch cannot carry. */
  content?: string;
}

export interface DelegatedWorkBundle {
  version: 1;
  transferId: string;
  sessionId: string;
  /** Origin chat that asked for this work, when the caller supplied one. */
  sourceSessionId?: string;
  deviceId: string;
  deviceName: string;
  workspaceName: string;
  placement: DelegationPlacement;
  commit: DelegationCommitPolicy;
  createdAt: number;
  /** Commit the target checkout started from, when it is a git repository. */
  baseCommit: string | null;
  /** Unified diff of tracked changes, or an empty string for a non-git target. */
  patch: string;
  files: DelegatedFileChange[];
  /** Human-readable verification evidence from the target. */
  summary: string;
  truncated: boolean;
  notes: string[];
}

export function isComputeDelegation(value: unknown): value is ComputeDelegation {
  if (!value || typeof value !== 'object') return false;
  const row = value as Record<string, unknown>;
  if (row.placement !== 'stay' && row.placement !== 'return') return false;
  if (row.commit !== undefined && row.commit !== 'none' && row.commit !== 'local') return false;
  if (row.commit === 'local' && row.placement === 'stay') return false;
  if (row.sourceSessionId !== undefined && typeof row.sourceSessionId !== 'string') return false;
  if (row.transferId !== undefined && typeof row.transferId !== 'string') return false;
  return true;
}

export function normalizeComputeDelegation(input: unknown): ComputeDelegation {
  if (!isComputeDelegation(input)) {
    return { placement: 'stay', commit: 'none' };
  }
  return {
    placement: input.placement,
    // A local commit is only meaningful for work brought back to the origin.
    commit: input.placement === 'return' && input.commit === 'local' ? 'local' : 'none',
    ...(input.sourceSessionId ? { sourceSessionId: input.sourceSessionId.slice(0, 200) } : {}),
    ...(input.transferId ? { transferId: input.transferId.slice(0, 100) } : {}),
  };
}

/**
 * The agent must say this before it starts remote work, so the user can stop
 * it. Keep it one sentence and name both the machine and the return behavior.
 */
export function buildDelegationAnnouncement(input: {
  deviceName: string;
  workspaceName: string;
  placement: DelegationPlacement;
  task?: string;
}): string {
  const where = `${input.deviceName} (${input.workspaceName})`;
  if (input.placement === 'return') {
    return `I'll run this on ${where} and bring the changed files back to this machine, without committing or pushing anything.`;
  }
  return `I'll run this on ${where} and keep the work there. Nothing will be copied back unless you ask.`;
}

/** The user-visible contract for a returned bundle, used in TRANSFER.md. */
export function describeReturnedWork(bundle: DelegatedWorkBundle): string {
  const lines = [
    `# Work returned from ${bundle.deviceName}`,
    '',
    `- Transfer: \`${bundle.transferId}\``,
    `- Target workspace: \`${bundle.workspaceName}\``,
    `- Target chat: \`${bundle.sessionId}\``,
    `- Base commit: ${bundle.baseCommit ?? 'not a git checkout'}`,
    `- Files: ${bundle.files.length}`,
    `- Created: ${new Date(bundle.createdAt).toISOString()}`,
    '',
    '## Policy',
    '',
    bundle.commit === 'local'
      ? 'These changes were returned for an explicit local commit. Nothing was committed or pushed on the source or target by Koryphaios.'
      : 'Nothing was committed or pushed on either machine. Review and apply the changes yourself.',
    '',
    '## Apply',
    '',
    '```sh',
    'git apply --check .koryphaios/incoming/' + bundle.transferId + '/changes.patch',
    'git apply .koryphaios/incoming/' + bundle.transferId + '/changes.patch',
    '```',
    '',
    'Untracked files are copied under `files/`; copy them into place after review.',
  ];
  if (bundle.truncated) lines.push('', '**Truncated:** the bundle hit a safety bound. Inspect the target chat for the rest.');
  if (bundle.notes.length) lines.push('', '## Notes', '', ...bundle.notes.map((note) => `- ${note}`));
  if (bundle.summary.trim()) lines.push('', '## Target summary', '', bundle.summary.trim());
  return `${lines.join('\n')}\n`;
}
