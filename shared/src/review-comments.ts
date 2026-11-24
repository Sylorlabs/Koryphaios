/**
 * Inline review comments on a chat's diff. A comment is anchored to one line of
 * one side of one hunk; "Send to agent" batches every open comment into a single
 * host-authored steering message.
 */

/** `old` = a line number in the pre-image (deleted/context side), `new` = post-image. */
export type ReviewCommentSide = 'old' | 'new';

export type ReviewCommentStatus = 'open' | 'resolved';

export interface ReviewComment {
  id: string;
  sessionId: string;
  /** Repository-relative path, forward slashes. */
  filePath: string;
  line: number;
  side: ReviewCommentSide;
  /** Which diff the comment was made on: index vs HEAD (true) or worktree vs index (false). */
  staged: boolean;
  body: string;
  /** `@@ -a,b +c,d @@` header of the hunk the comment was anchored to, when known. */
  hunkHeader?: string;
  status: ReviewCommentStatus;
  /** Id of the most recent "Send to agent" batch that included this comment. */
  sentBatchId?: string;
  createdAt: number;
  updatedAt: number;
  resolvedAt?: number;
}

export interface ReviewCommentCreateRequest {
  filePath: string;
  line: number;
  side: ReviewCommentSide;
  body: string;
  hunkHeader?: string;
  /** Defaults to false (the unstaged diff). */
  staged?: boolean;
}

export interface ReviewCommentSendResult {
  batchId: string;
  commentIds: string[];
  /** `true` when the message started a turn now; `'queued'` when parked behind the live run. */
  accepted: true | 'queued';
}

/** Payload of `session.review_comments`: the full comment list for the chat. */
export interface ReviewCommentsUpdatedPayload {
  sessionId: string;
  comments: ReviewComment[];
}

export const REVIEW_COMMENT_MAX_BODY_LENGTH = 8_000;
export const REVIEW_COMMENT_MAX_PER_SESSION = 500;
