import type { GitWorkspaceSelection, GitWorkspaceRef, GitWorkspaceCommit } from './git-workspace';

export interface ChatPullRequest {
  number: number;
  title: string;
  url: string;
  state: 'open' | 'closed' | 'merged';
  draft: boolean;
  author: string;
  baseBranch: string;
  headBranch: string;
  headCommit: string;
  repository: string;
  additions?: number;
  deletions?: number;
  changedFiles?: number;
}

export type ChatGitTarget =
  | {
      kind: 'branch' | 'commit';
      ref: string;
      branch?: string;
      expectedHash?: string;
      source?: boolean;
    }
  | { kind: 'pull-request'; number: number; branch: string; expectedHash?: string };

export interface ChatGitSwitchRequest {
  target: ChatGitTarget;
  /** Compare-and-swap guards from the chat's last Git read. */
  expectedHead: string;
  expectedBranch: string | null;
}

export interface ChatGitSelectionRecord {
  kind: ChatGitTarget['kind'];
  ref: string;
  branch: string;
  commit: string;
  selectedAt: number;
  pullRequest?: ChatPullRequest;
}

export interface ChatGitState extends GitWorkspaceSelection {
  sessionId: string;
  /** True for revision-picker checkouts; false for ordinary in-place chats. */
  isolated: boolean;
  changedFiles: number;
  operationInProgress: boolean;
  githubRepository: string | null;
  sourceRefs: GitWorkspaceRef[];
  sourceCommits: GitWorkspaceCommit[];
  selection?: ChatGitSelectionRecord;
}

export interface ChatGitDetails {
  hash: string;
  subject: string;
  message: string;
  author: string;
  date: string;
  /** Bounded plain-text Git diffstat (no external diff or textconv). */
  stat: string;
}
