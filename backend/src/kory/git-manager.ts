import { spawnSync } from "bun";
import { resolve, relative } from "node:path";
import { koryLog } from "../logger";

/** Branch names: alphanumeric, hyphen, underscore, slash (for refs/heads/foo). Max 255 chars. */
const SAFE_BRANCH_REGEX = /^[a-zA-Z0-9/_.-]{1,255}$/;

export interface GitFileStatus {
  path: string;
  status: 'modified' | 'added' | 'deleted' | 'renamed' | 'untracked' | 'staged';
  staged: boolean;
  additions?: number;
  deletions?: number;
}

export class GitManager {
  constructor(private workingDirectory: string) {}

  protected runGit(args: string[]): { success: boolean; output: string } {
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

  /** Resolve path under repo root; return null if outside (path traversal). */
  resolvePathUnderRepo(filePath: string): string | null {
    const root = resolve(this.workingDirectory);
    const abs = filePath.startsWith("/") ? resolve(filePath) : resolve(root, filePath);
    const rel = relative(root, abs);
    if (rel.startsWith("..") || rel.startsWith("/")) return null;
    return abs;
  }

  /** Validate branch name for checkout/merge. */
  static validateBranchName(branch: string): boolean {
    return typeof branch === "string" && branch.length > 0 && SAFE_BRANCH_REGEX.test(branch);
  }

  async getDiff(path: string, staged = false): Promise<string> {
    const safePath = this.resolvePathUnderRepo(path);
    if (!safePath) return "";
    const args = ["diff"];
    if (staged) args.push("--cached");
    args.push("--", safePath);
    return this.runGit(args).output;
  }

  async stageFile(path: string): Promise<boolean> {
    const safePath = this.resolvePathUnderRepo(path);
    if (!safePath) return false;
    return this.runGit(["add", safePath]).success;
  }

  async unstageFile(path: string): Promise<boolean> {
    const safePath = this.resolvePathUnderRepo(path);
    if (!safePath) return false;
    return this.runGit(["reset", "HEAD", safePath]).success;
  }

  async restoreFile(path: string): Promise<boolean> {
    const safePath = this.resolvePathUnderRepo(path);
    if (!safePath) return false;
    return this.runGit(["checkout", "--", safePath]).success;
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
    if (!GitManager.validateBranchName(branch)) return false;
    const args = ["checkout"];
    if (create) args.push("-b");
    args.push(branch);
    return this.runGit(args).success;
  }

  async merge(branch: string): Promise<{ success: boolean; output: string; hasConflicts: boolean }> {
    if (!GitManager.validateBranchName(branch)) {
      return { success: false, output: "Invalid branch name", hasConflicts: false };
    }
    const result = this.runGit(["merge", branch]);
    const hasConflicts = result.output.includes("CONFLICT") || result.output.includes("Automatic merge failed");
    return { ...result, hasConflicts };
  }

  async getConflicts(): Promise<string[]> {
    const { success, output } = this.runGit(["diff", "--name-only", "--diff-filter=U"]);
    if (!success) return [];
    return output.split("\n").filter(Boolean);
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

  /** Check if there are uncommitted changes */
  async hasChanges(): Promise<boolean> {
    const status = await this.getStatus();
    return status.length > 0;
  }
}
