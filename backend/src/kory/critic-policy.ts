import type { CriticMode } from '@koryphaios/shared';

export interface CriticEvidence {
  task: string;
  response?: string;
  changedFiles?: readonly string[];
  delegated?: boolean;
  failedTool?: boolean;
  nativeToolActivity?: boolean;
  /** True for commands, writes, external tools, or other non-read-only actions. */
  consequentialToolActivity?: boolean;
  managerRequestedReview?: boolean;
  managerReviewReason?: string;
  purpose?: 'response' | 'worker' | 'goal' | 'image';
}

/** Always/Off overrides. Auto follows the finishing agent decision. */
export function decideCriticReview(mode: CriticMode, evidence: CriticEvidence): { review: boolean; reason: string } {
  if (mode === 'off') return { review: false, reason: 'Critic disabled by user.' };
  if (mode === 'always') return { review: true, reason: 'Always review is selected.' };
  const review = (reason: string) => ({ review: true, reason });
  if (evidence.managerRequestedReview) {
    return review(evidence.managerReviewReason?.trim() || 'The finishing agent requested a Critic review.');
  }
  return { review: false, reason: 'Agent declined Critic review.' };
}

/** A bare readiness probe ("test", "are you there") is not a review request by
 *  itself. Spending a model turn to decide whether it needs independent
 *  verification makes a handshake look like work, so the host skips the Critic
 *  Auto decision entirely for these messages. */
const READINESS_PROBE =
  /^\s*(test|testing|ping|pong|hello|hi|hey|are you (there|ready|working|alive)|ready\?|you there|ok|okay|thanks)\s*[.?!]*\s*$/iu;

export function isReadinessProbeTask(task: string): boolean {
  return READINESS_PROBE.test(task);
}

/** Unknown/external tools are conservative: they may mutate outside recorded file edits. */
export function isConsequentialCriticTool(name: string): boolean {
  return !new Set([
    'read_file', 'read', 'glob', 'grep', 'list_files', 'list_directory', 'ls',
    'web_search', 'web_fetch', 'fetch', 'view_image', 'fetch_context',
    'request_tools', 'ask_user', 'question', 'rename_session', 'request_critic_review',
  ]).has(name.replace(/^kory__/, '').toLowerCase());
}
