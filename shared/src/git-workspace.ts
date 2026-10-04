/** Revision selection is project-scoped; a new chat gets its own checkout. */
export interface GitWorkspaceRef {
  ref: string;
  name: string;
  kind: 'branch' | 'remote' | 'tag';
  hash: string;
}

export interface GitWorkspaceCommit {
  hash: string;
  subject: string;
  author: string;
  date: string;
}

export interface GitWorkspaceSelection {
  isRepo: boolean;
  repositoryPath: string;
  branch: string | null;
  head: string | null;
  dirty: boolean;
  refs: GitWorkspaceRef[];
  /** Most recent 50 commits reachable from HEAD. */
  commits: GitWorkspaceCommit[];
}

export interface CreateGitWorkspaceRequest {
  /** Fully-qualified branch/tag ref or a commit hash (not a revision expression). */
  ref: string;
  /** Expected object ID from the picker; prevents silently using a moved ref. */
  expectedHash?: string;
  branch: string;
}

export interface CreatedGitWorkspace {
  /** Current explicit revision/PR selection for this chat; live Git remains authoritative. */
  selection?: import('./chat-git').ChatGitSelectionRecord;
  /** New chats own independent Git metadata, not a shared worktree commondir. */
  isolation?: 'independent-repository';
  path: string;
  branch: string;
  baseCommit: string;
  repositoryPath: string;
}
