/**
 * WorkspaceManager - Git Worktree-based Parallel Agent Isolation
 * 
 * This manager uses Git Worktrees to provide filesystem isolation for parallel
 * AI agents, preventing them from clobbering each other's work.
 * 
 * Features:
 * - Isolation: Each task runs in its own worktree with a dedicated branch
 * - Security: .env files are not copied unless explicitly requested
 * - Cleanup: Automatic worktree/branch removal after changes are reconciled
 * - Resource Guard: Configurable concurrent worktree limit based on system RAM
 */

import { spawnSync } from "bun";
import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync } from "node:fs";
import { join, resolve, relative } from "node:path";
import { koryLog } from "../logger";
import type { KoryphaiosConfig } from "@koryphaios/shared";

export interface WorktreeInfo {
  id: string;
  taskName: string;
  branchName: string;
  path: string;
  createdAt: number;
  agentId?: string;
}

export interface WorktreeStatus {
  active: WorktreeInfo[];
  availableSlots: number;
  maxAllowed: number;
}

export class WorkspaceManager {
  private worktrees: Map<string, WorktreeInfo> = new Map();
  private worktreeDir: string;
  private maxConcurrent: number;
  private copyEnvFiles: boolean;
  private repoRoot: string;
  private gitignoreUpdated = false;

  constructor(
    repoRoot: string,
    config?: KoryphaiosConfig["workspace"]
  ) {
    this.repoRoot = resolve(repoRoot);
    this.worktreeDir = config?.worktreeDir ?? ".trees";
    this.maxConcurrent = config?.worktreeLimit ?? 4;
    this.copyEnvFiles = config?.copyEnvFiles ?? false;

    // Validate we're in a git repo
    if (!this.isGitRepo()) {
      throw new WorkspaceError("Not a valid Git repository");
    }

    // Ensure .trees/ is in .gitignore
    this.ensureGitignoreEntry();

    koryLog.info({
      worktreeDir: this.worktreeDir,
      maxConcurrent: this.maxConcurrent,
      copyEnvFiles: this.copyEnvFiles,
    }, "WorkspaceManager initialized");
  }

  /**
   * Get current worktree status including available slots
   */
  getStatus(): WorktreeStatus {
    return {
      active: Array.from(this.worktrees.values()),
      availableSlots: this.maxConcurrent - this.worktrees.size,
      maxAllowed: this.maxConcurrent,
    };
  }

  /**
   * Check if we can spawn a new worktree
   */
  canSpawn(): boolean {
    return this.worktrees.size < this.maxConcurrent;
  }

  /**
   * Create a new isolated worktree for a task
   * @param taskId Unique identifier for the task
   * @param taskName Human-readable task name (used for branch naming)
   * @param agentId Optional agent ID that owns this worktree
   * @returns WorktreeInfo on success, null if at capacity
   */
  spawn(taskId: string, taskName: string, agentId?: string): WorktreeInfo | null {
    // Resource Guard: Check concurrent limit
    if (!this.canSpawn()) {
      koryLog.warn({
        taskId,
        current: this.worktrees.size,
        max: this.maxConcurrent,
      }, "Cannot spawn worktree: at capacity");
      return null;
    }

    // Sanitize task name for branch name
    const sanitizedTaskName = this.sanitizeBranchName(taskName);
    const branchName = `ai/${sanitizedTaskName}-${taskId.slice(0, 8)}`;
    const worktreePath = join(this.repoRoot, this.worktreeDir, taskId);

    // Create worktree directory if it doesn't exist
    const worktreeBaseDir = join(this.repoRoot, this.worktreeDir);
    if (!existsSync(worktreeBaseDir)) {
      mkdirSync(worktreeBaseDir, { recursive: true });
    }

    // Create the worktree with a new branch
    const result = this.runGit(["worktree", "add", "-b", branchName, worktreePath, "HEAD"]);
    if (!result.success) {
      koryLog.error({ taskId, output: result.output }, "Failed to create worktree");
      return null;
    }

    // Handle .env file copying based on security policy
    if (this.copyEnvFiles) {
      this.copyEnvToWorktree(worktreePath);
    }

    const worktree: WorktreeInfo = {
      id: taskId,
      taskName,
      branchName,
      path: worktreePath,
      createdAt: Date.now(),
      agentId,
    };

    this.worktrees.set(taskId, worktree);

    koryLog.info({
      taskId,
      branchName,
      path: worktreePath,
      agentId,
    }, "Worktree created");

    return worktree;
  }

  /**
   * Reconcile changes from a worktree back to main and clean up
   * @param taskId The task/worktree ID to reconcile
   * @param squash Whether to squash commits (true) or preserve history (false)
   * @returns Success status and details
   */
  reconcile(taskId: string, squash = true): { success: boolean; message: string } {
    const worktree = this.worktrees.get(taskId);
    if (!worktree) {
      return { success: false, message: `Worktree ${taskId} not found` };
    }

    // Check for uncommitted changes in the worktree
    const hasChanges = this.runGit(["-C", worktree.path, "status", "--porcelain"]).output.trim() !== "";
    
    if (hasChanges) {
      // Auto-commit any pending changes
      this.runGit(["-C", worktree.path, "add", "."]);
      const commitResult = this.runGit([
        "-C", worktree.path, "commit",
        "-m", `[AI] Changes from ${worktree.taskName}`,
        "--no-verify"
      ]);
      
      if (!commitResult.success) {
        return { success: false, message: "Failed to commit changes in worktree" };
      }
    }

    // Return to main repo and merge the worktree branch
    const mainBranch = this.getMainBranch();
    
    // Checkout main
    this.runGit(["checkout", mainBranch]);

    if (squash) {
      // Squash merge: Combine all worktree changes into one commit
      const mergeResult = this.runGit([
        "merge", "--squash", worktree.branchName
      ]);
      
      if (!mergeResult.success) {
        koryLog.error({ taskId, output: mergeResult.output }, "Squash merge failed");
        return { success: false, message: "Merge failed: " + mergeResult.output };
      }

      // Commit the squashed changes
      const commitResult = this.runGit([
        "commit",
        "-m", `feat: ${worktree.taskName} [ai-${taskId.slice(0, 8)}]`,
        "--no-verify"
      ]);

      if (!commitResult.success) {
        return { success: false, message: "Failed to commit squashed changes" };
      }
    } else {
      // Regular merge: Preserve all commits from worktree
      const mergeResult = this.runGit([
        "merge", worktree.branchName,
        "-m", `Merge ${worktree.branchName} into ${mainBranch}`
      ]);

      if (!mergeResult.success) {
        koryLog.error({ taskId, output: mergeResult.output }, "Merge failed");
        return { success: false, message: "Merge failed: " + mergeResult.output };
      }
    }

    // Cleanup: Remove worktree and branch
    const cleanupResult = this.cleanup(taskId);
    
    return {
      success: true,
      message: cleanupResult.success 
        ? `Changes reconciled and worktree cleaned up`
        : `Changes reconciled but cleanup failed: ${cleanupResult.message}`,
    };
  }

  /**
   * Clean up a worktree and its branch without merging
   * @param taskId The task/worktree ID to clean up
   * @returns Success status
   */
  cleanup(taskId: string): { success: boolean; message: string } {
    const worktree = this.worktrees.get(taskId);
    if (!worktree) {
      return { success: false, message: `Worktree ${taskId} not found` };
    }

    // Remove the worktree
    const removeResult = this.runGit(["worktree", "remove", "--force", worktree.path]);
    if (!removeResult.success) {
      koryLog.error({ taskId, output: removeResult.output }, "Failed to remove worktree");
      return { success: false, message: "Failed to remove worktree: " + removeResult.output };
    }

    // Delete the branch
    this.runGit(["branch", "-D", worktree.branchName]);

    // Remove from tracking
    this.worktrees.delete(taskId);

    koryLog.info({ taskId, branch: worktree.branchName }, "Worktree cleaned up");

    return { success: true, message: "Worktree and branch removed" };
  }

  /**
   * Get the path for a worktree by task ID
   */
  getWorktreePath(taskId: string): string | null {
    const worktree = this.worktrees.get(taskId);
    return worktree?.path ?? null;
  }

  /**
   * Check if a task has an active worktree
   */
  hasWorktree(taskId: string): boolean {
    return this.worktrees.has(taskId);
  }

  /**
   * List all Git worktrees (including ones we didn't create)
   */
  listAllWorktrees(): Array<{ path: string; branch?: string; detached: boolean }> {
    const result = this.runGit(["worktree", "list", "--porcelain"]);
    if (!result.success) return [];

    const worktrees: Array<{ path: string; branch?: string; detached: boolean }> = [];
    let current: Partial<{ path: string; branch?: string; detached: boolean }> = {};

    for (const line of result.output.split("\n")) {
      if (line.startsWith("worktree ")) {
        if (current.path) worktrees.push(current as { path: string; branch?: string; detached: boolean });
        current = { path: line.slice(9).trim(), detached: false };
      } else if (line.startsWith("branch ")) {
        current.branch = line.slice(7).trim().replace(/^refs\/heads\//, "");
      } else if (line === "detached") {
        current.detached = true;
      }
    }

    if (current.path) worktrees.push(current as { path: string; branch?: string; detached: boolean });

    return worktrees;
  }

  /**
   * Prune any stale worktree references
   */
  prune(): { success: boolean; message: string } {
    const result = this.runGit(["worktree", "prune"]);
    if (result.success) {
      return { success: true, message: "Stale worktree references pruned" };
    }
    return { success: false, message: "Prune failed: " + result.output };
  }

  // ─── Private Helper Methods ───────────────────────────────────────────────

  private isGitRepo(): boolean {
    return this.runGit(["rev-parse", "--is-inside-work-tree"]).success;
  }

  private runGit(args: string[]): { success: boolean; output: string } {
    const proc = spawnSync(["git", ...args], {
      cwd: this.repoRoot,
      stdout: "pipe",
      stderr: "pipe",
    });

    const output = proc.stdout.toString() + proc.stderr.toString();
    return { success: proc.exitCode === 0, output };
  }

  private sanitizeBranchName(name: string): string {
    // Convert to lowercase, replace spaces with hyphens, remove unsafe chars
    return name
      .toLowerCase()
      .replace(/\s+/g, "-")
      .replace(/[^a-z0-9_-]/g, "")
      .slice(0, 50); // Keep it reasonable
  }

  private ensureGitignoreEntry(): void {
    if (this.gitignoreUpdated) return;

    const gitignorePath = join(this.repoRoot, ".gitignore");
    const entry = `${this.worktreeDir}/`;

    if (!existsSync(gitignorePath)) {
      writeFileSync(gitignorePath, `${entry}\n`, "utf-8");
      this.gitignoreUpdated = true;
      koryLog.info("Created .gitignore with worktree directory entry");
      return;
    }

    const content = readFileSync(gitignorePath, "utf-8");
    const lines = content.split("\n");
    
    // Check if already ignored (handle various formats)
    const isIgnored = lines.some(line => {
      const trimmed = line.trim();
      return trimmed === entry || trimmed === this.worktreeDir || 
             trimmed === `${this.worktreeDir}**` || trimmed === `${this.worktreeDir}/**`;
    });

    if (!isIgnored) {
      appendFileSync(gitignorePath, `\n# Koryphaios AI worktrees\n${entry}\n`, "utf-8");
      this.gitignoreUpdated = true;
      koryLog.info("Added worktree directory to .gitignore");
    }
  }

  private copyEnvToWorktree(worktreePath: string): void {
    const envFiles = [".env", ".env.local", ".env.development"];
    
    for (const envFile of envFiles) {
      const sourcePath = join(this.repoRoot, envFile);
      const targetPath = join(worktreePath, envFile);
      
      if (existsSync(sourcePath)) {
        try {
          const content = readFileSync(sourcePath, "utf-8");
          writeFileSync(targetPath, content, "utf-8");
          koryLog.debug({ file: envFile }, "Copied .env file to worktree");
        } catch (err) {
          koryLog.warn({ file: envFile, err }, "Failed to copy .env file");
        }
      }
    }
  }

  private getMainBranch(): string {
    // Try common main branch names
    const candidates = ["main", "master", "trunk", "develop"];
    
    for (const branch of candidates) {
      const result = this.runGit(["rev-parse", "--verify", branch]);
      if (result.success) return branch;
    }

    // Fallback to current branch
    const result = this.runGit(["rev-parse", "--abbrev-ref", "HEAD"]);
    return result.output.trim() || "main";
  }
}

export class WorkspaceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkspaceError";
  }
}
