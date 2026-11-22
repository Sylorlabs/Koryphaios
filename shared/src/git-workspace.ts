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
  /** Revision-picker chats own independent Git metadata, not a shared worktree commondir. */
  isolation?: 'independent-repository';
  /** Set only by isolate_chat: the chat moved itself out of its folder into an
   *  independent copy mid-conversation. Records what merge_chat_back needs to
   *  return the work. Revision-picker chats never have this field. */
  autoIsolated?: {
    /** Canonical folder the chat left; merge target on merge_chat_back. */
    sourceDirectory: string;
    /** Branch the folder was on when the chat isolated; merge refuses otherwise. */
    sourceBranch: string;
    /** Commit the copy cloned from; distinguishes real work from a no-op merge. */
    sourceHead: string;
    reason: string;
    isolatedAt: number;
  };
  path: string;
  branch: string;
  baseCommit: string;
  repositoryPath: string;
}
