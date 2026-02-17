import { spawnSync } from "bun";
import { join } from "path";
import { existsSync, readFileSync } from "fs";
import { koryLog } from "../logger";

export interface GitFileStatus {
  path: string;
  status: 'modified' | 'added' | 'deleted' | 'renamed' | 'untracked' | 'staged';
  staged: boolean;
  additions?: number;
  deletions?: number;
}

export class GitManager {
  constructor(private workingDirectory: string) {}

  private runGit(args: string[]): { success: boolean; output: string } {
    const proc = spawnSync(["git", ...args], {
      cwd: this.workingDirectory,
      stdout: "pipe",
      stderr: "pipe",
    });

    const output = proc.stdout.toString() + proc.stderr.toString();
    return { success: proc.exitCode === 0, output };
  }

  isGitRepo(): boolean {
    return this.runGit(["rev-parse", "--is-inside-work-tree"]).success;
  }

  async getStatus(): Promise<GitFileStatus[]> {
    if (!this.isGitRepo()) return [];

    // 1. Get porcelain status
    const { success, output: porcelainOutput } = this.runGit(["status", "--porcelain"]);
    if (!success) return [];

    // 2. Get line stats (numstat)
    const { output: numstatOutput } = this.runGit(["diff", "HEAD", "--numstat"]);
    const { output: stagedNumstatOutput } = this.runGit(["diff", "--cached", "--numstat"]);

    const statsMap = new Map<string, { additions: number; deletions: number }>();

    const parseNumstat = (out: string) => {
      out.split("\n").forEach(line => {
        const [add, del, path] = line.split("\t");
        if (add && del && path) {
          statsMap.set(path, {
            additions: parseInt(add) || 0,
            deletions: parseInt(del) || 0
          });
        }
      });
    };

    parseNumstat(numstatOutput);
    parseNumstat(stagedNumstatOutput);

    const files: GitFileStatus[] = [];
    const lines = porcelainOutput.split("\n").filter(Boolean);

    for (const line of lines) {
      const x = line[0];
      const y = line[1];
      const path = line.slice(3).trim();
      const stats = statsMap.get(path);

      if (x !== ' ' && x !== '?') {
        files.push({
          path,
          status: this.mapStatus(x),
          staged: true,
          ...stats
        });
      }

      if (y !== ' ') {
        files.push({
          path,
          status: this.mapStatus(y),
          staged: false,
          ...stats
        });
      }
    }

    return files;
  }

  private mapStatus(code: string): GitFileStatus['status'] {
    switch (code) {
      case 'M': return 'modified';
      case 'A': return 'added';
      case 'D': return 'deleted';
      case 'R': return 'renamed';
      case '?': return 'untracked';
      default: return 'modified';
    }
  }

  async getDiff(path: string, staged = false): Promise<string> {
    const args = ["diff"];
    if (staged) args.push("--cached");
    args.push("--", path);
    return this.runGit(args).output;
  }

  async getFileContent(path: string): Promise<string | null> {
    const { success, output } = this.runGit(["show", `HEAD:${path}`]);
    // Fallback to local file if not in git yet (added/untracked)
    if (!success) {
      try {
        const fullPath = join(this.workingDirectory, path);
        if (existsSync(fullPath)) {
          return readFileSync(fullPath, "utf-8");
        }
      } catch {
        return null;
      }
    }
    return output;
  }

  async stageFile(path: string): Promise<boolean> {
    return this.runGit(["add", path]).success;
  }

  async unstageFile(path: string): Promise<boolean> {
    return this.runGit(["reset", "HEAD", path]).success;
  }

  async restoreFile(path: string): Promise<boolean> {
    // For unstaged changes, checkout handles restoring to index
    // Note: This is destructive for local changes
    return this.runGit(["checkout", "--", path]).success;
  }

  async commit(message: string): Promise<boolean> {
    return this.runGit(["commit", "-m", message]).success;
  }

  async push(): Promise<{ success: boolean; output: string }> {
    return this.runGit(["push"]);
  }

  async pull(): Promise<{ success: boolean; output: string }> {
    return this.runGit(["pull"]);
  }

  async getBranch(): Promise<string> {
    const { output } = this.runGit(["rev-parse", "--abbrev-ref", "HEAD"]);
    return output.trim();
  }

  async getBranches(): Promise<string[]> {
    const { output } = this.runGit(["branch", "--format=%(refname:short)"]);
    return output.split("\n").filter(Boolean);
  }

  async checkout(branch: string, create = false): Promise<boolean> {
    const args = ["checkout"];
    if (create) args.push("-b");
    args.push(branch);
    return this.runGit(args).success;
  }

  async merge(branch: string): Promise<{ success: boolean; output: string; hasConflicts: boolean }> {
    const result = this.runGit(["merge", branch]);
    const hasConflicts = result.output.includes("CONFLICT") || result.output.includes("Automatic merge failed");
    return { ...result, hasConflicts };
  }

  async getConflicts(): Promise<string[]> {
    const { success, output } = this.runGit(["diff", "--name-only", "--diff-filter=U"]);
    if (!success) return [];
    return output.split("\n").filter(Boolean);
  }

  async getAheadBehind(): Promise<{ ahead: number; behind: number }> {
    if (!this.isGitRepo()) return { ahead: 0, behind: 0 };

    // Check if we have an upstream configured
    const { success } = this.runGit(["rev-parse", "--abbrev-ref", "@{u}"]);
    if (!success) return { ahead: 0, behind: 0 };

    const { output } = this.runGit(["rev-list", "--left-right", "--count", "HEAD...@{u}"]);
    const parts = output.trim().split(/\s+/);
    if (parts.length === 2) {
      return { ahead: parseInt(parts[0]) || 0, behind: parseInt(parts[1]) || 0 };
    }
    return { ahead: 0, behind: 0 };
  }

  /** Create a shadow commit to track changes for a specific session/task */
  createShadowCommit(sessionId: string, taskDescription: string): string | null {
    if (!this.isGitRepo()) return null;

    // 1. Stage all current changes (might be risky, but needed for snapshot)
    // Professional approach: only stage if something is actually changed
    this.runGit(["add", "."]);

    // 2. Commit with a special prefix
    const message = `[KORY SHADOW] ${sessionId}: ${taskDescription.slice(0, 50)}`;
    const result = this.runGit(["commit", "-m", message, "--no-verify"]);

    if (result.success) {
      const hash = this.runGit(["rev-parse", "HEAD"]).output.trim();
      koryLog.info({ sessionId, hash }, "Created shadow commit");
      return hash;
    }
    return null;
  }

  /** Hard reset to a specific commit hash */
  rollback(hash: string): boolean {
    const result = this.runGit(["reset", "--hard", hash]);
    if (result.success) {
      // Also clean untracked files
      this.runGit(["clean", "-fd"]);
      koryLog.info({ hash }, "Rolled back to commit");
      return true;
    }
    return false;
  }

  /** Get the current HEAD hash */
  getCurrentHash(): string | null {
    const result = this.runGit(["rev-parse", "HEAD"]);
    return result.success ? result.output.trim() : null;
  }
}
