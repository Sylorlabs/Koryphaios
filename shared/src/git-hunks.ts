/**
 * Hunk-level Git actions on a chat's isolated checkout. Every action echoes the
 * `revision` token of the diff the user looked at; the server refuses when the
 * file changed since that diff was rendered.
 */

export interface GitDiffHunk {
  /** Zero-based position in the file's current diff for the requested side. */
  index: number;
  /** Full `@@ -a,b +c,d @@ section` header line. */
  header: string;
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  additions: number;
  deletions: number;
  /** Hunk body lines (each starts with ' ', '+', '-' or '\\'); the header is separate. */
  lines: string[];
}

export interface GitFileHunks {
  file: string;
  /** `true` lists index-vs-HEAD hunks (unstage); `false` lists worktree-vs-index hunks (stage, revert). */
  staged: boolean;
  /** Token of the exact diff text rendered. Hunk actions must echo it back. */
  revision: string;
  hunks: GitDiffHunk[];
}

export type GitHunkAction = 'stage' | 'unstage' | 'revert';

export interface GitHunkActionRequest {
  file: string;
  hunkIndex: number;
  hunkHeader: string;
  revision: string;
}

export interface GitHunkActionResult {
  action: GitHunkAction;
  file: string;
  staged: boolean;
  hunkHeader: string;
  /** Revision of the same diff side after the action; use it for the next action. */
  revision: string;
}
