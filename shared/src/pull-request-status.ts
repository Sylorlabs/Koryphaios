/**
 * Live status of the GitHub pull request a chat is linked to. The backend polls
 * `gh pr view`; the UI reads the cached snapshot and receives
 * `session.pull_request_status` when its signature changes.
 */

export type PullRequestCheckState =
  | 'pending'
  | 'success'
  | 'failure'
  | 'neutral'
  | 'cancelled'
  | 'skipped'
  | 'timed_out'
  | 'action_required'
  | 'error';

export interface PullRequestCheck {
  name: string;
  /** `check-run` for Checks API runs, `status-context` for commit status contexts. */
  source: 'check-run' | 'status-context';
  state: PullRequestCheckState;
  workflowName?: string;
  url?: string;
  /** GitHub Actions run id parsed from the check URL; used to fetch the failed-step log. */
  runId?: string;
}

export interface PullRequestReviewSummary {
  id: string;
  author: string;
  state: 'approved' | 'changes_requested' | 'commented' | 'dismissed' | 'pending';
  /** Review body, bounded. */
  body: string;
  submittedAt?: number;
}

export interface PullRequestCommentSummary {
  id: string;
  author: string;
  /** Comment body, bounded. */
  body: string;
  createdAt?: number;
  url?: string;
}

export interface PullRequestStatusSnapshot {
  number: number;
  repository: string;
  url: string;
  title: string;
  state: 'open' | 'closed' | 'merged';
  draft: boolean;
  headCommit?: string;
  reviewDecision: 'approved' | 'changes_requested' | 'review_required' | 'none';
  mergeable: 'mergeable' | 'conflicting' | 'unknown';
  checks: PullRequestCheck[];
  failingCheckCount: number;
  pendingCheckCount: number;
  reviews: PullRequestReviewSummary[];
  comments: PullRequestCommentSummary[];
  /** When this snapshot was read from GitHub. */
  observedAt: number;
  /** Hash of the content (excluding `observedAt`); equal signatures mean no change. */
  signature: string;
}

/** Response of GET /api/sessions/:id/pull-request/status. */
export interface PullRequestStatusView {
  linked: boolean;
  status: PullRequestStatusSnapshot | null;
  /** Bounded message when the last GitHub read failed; the snapshot may be stale. */
  lastError?: string;
}

/** Payload of `session.pull_request_status`. */
export interface PullRequestStatusUpdatedPayload {
  sessionId: string;
  status: PullRequestStatusSnapshot;
}

export interface PullRequestFailureSendResult {
  batchId: string;
  failingChecks: number;
  reviewItems: number;
  accepted: true | 'queued';
}
