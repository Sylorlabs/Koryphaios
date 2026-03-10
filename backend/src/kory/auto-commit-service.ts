/**
 * Auto-Commit Service - Handles automatic commits and PR creation for Beginner Mode
 * 
 * In Beginner Mode:
 * - Changes are automatically committed after task completion
 * - A branch is created based on the task
 * - A PR is opened on origin for review
 */

import { spawnSync } from "bun";
import { koryLog } from "../logger";
import { GitManager } from "./git-manager";

export interface AutoCommitResult {
  success: boolean;
  branch?: string;
  commitHash?: string;
  prUrl?: string;
  message: string;
}

export interface PRResult {
  success: boolean;
  prNumber?: number;
  prUrl?: string;
  message: string;
}

export class AutoCommitService {
  constructor(
    private workingDirectory: string,
    private git: GitManager
  ) {}

  /**
   * Generate a branch name from a task description
   */
  private generateBranchName(taskDescription: string): string {
    // Clean and sanitize the task description
    const clean = taskDescription
      .toLowerCase()
      .replace(/[^a-z0-9\s-]/g, '')
      .trim()
      .split(/\s+/)
      .slice(0, 6)
      .join('-');
    
    const timestamp = Date.now().toString(36).slice(-4);
    return `kory/${clean || 'update'}-${timestamp}`;
  }

  /**
   * Generate a commit message from a task description
   */
  private generateCommitMessage(taskDescription: string): string {
    // Take first 50 chars of task description
    const summary = taskDescription.slice(0, 50).trim();
    return `feat: ${summary}${taskDescription.length > 50 ? '...' : ''}`;
  }

  /**
   * Check if there's a remote named 'origin'
   */
  private hasOriginRemote(): boolean {
    const result = this.runGit(["remote", "get-url", "origin"]);
    return result.success && result.output.includes("http");
  }

  /**
   * Get the default branch from origin
   */
  private async getDefaultBranch(): Promise<string> {
    const result = this.runGit(["symbolic-ref", "refs/remotes/origin/HEAD"]);
    if (result.success) {
      const match = result.output.match(/origin\/(\S+)/);
      return match?.[1] || "main";
    }
    return "main";
  }

  /**
   * Run a git command
   */
  private runGit(args: string[]): { success: boolean; output: string } {
    const proc = spawnSync(["git", ...args], {
      cwd: this.workingDirectory,
      stdout: "pipe",
      stderr: "pipe",
    });

    const output = proc.stdout.toString() + proc.stderr.toString();
    return { success: proc.exitCode === 0, output: output.trim() };
  }

  /**
   * Auto-commit changes and create a PR for beginner mode
   * 
   * Flow:
   * 1. Check if we're in a git repo
   * 2. Check if there are changes to commit
   * 3. Create a new branch
   * 4. Stage and commit all changes
   * 5. Push branch to origin
   * 6. Create a PR using gh CLI or git request-pull
   */
  async autoCommitAndCreatePR(taskDescription: string): Promise<AutoCommitResult> {
    // Check if we're in a git repo
    if (!this.git.isGitRepo()) {
      return {
        success: false,
        message: "Not a git repository. Changes were saved but not committed.",
      };
    }

    // Check if there are changes
    const hasChanges = await this.git.hasChanges();
    if (!hasChanges) {
      return {
        success: true,
        message: "No changes to commit.",
      };
    }

    const branchName = this.generateBranchName(taskDescription);
    const commitMessage = this.generateCommitMessage(taskDescription);

    try {
      // Get current branch to return to later
      const currentBranch = await this.git.getBranch();

      // Create and checkout new branch
      const branchCreated = await this.git.checkout(branchName, true);
      if (!branchCreated) {
        return {
          success: false,
          message: `Failed to create branch: ${branchName}`,
        };
      }

      // Stage all changes
      const stageResult = this.runGit(["add", "-A"]);
      if (!stageResult.success) {
        // Try to go back to original branch
        await this.git.checkout(currentBranch);
        return {
          success: false,
          message: "Failed to stage changes for commit.",
        };
      }

      // Commit changes
      const commitResult = this.runGit(["commit", "-m", commitMessage, "--no-verify"]);
      if (!commitResult.success) {
        // Try to go back to original branch
        await this.git.checkout(currentBranch);
        return {
          success: false,
          message: "Failed to commit changes.",
        };
      }

      // Get the commit hash
      const hashResult = this.runGit(["rev-parse", "HEAD"]);
      const commitHash = hashResult.success ? hashResult.output.trim() : undefined;

      koryLog.info({ branchName, commitHash }, "Auto-committed changes in beginner mode");

      // Try to push and create PR if origin exists
      let prResult: PRResult | undefined;
      if (this.hasOriginRemote()) {
        prResult = await this.createPullRequest(branchName, taskDescription, commitMessage);
      }

      // Return to original branch but keep the new branch
      await this.git.checkout(currentBranch);

      return {
        success: true,
        branch: branchName,
        commitHash,
        prUrl: prResult?.prUrl,
        message: prResult?.success 
          ? `Changes committed to branch "${branchName}" and PR created!`
          : `Changes committed to branch "${branchName}". You can merge when ready.`,
      };

    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      koryLog.error({ error: errorMsg }, "Auto-commit failed");
      return {
        success: false,
        message: `Auto-commit failed: ${errorMsg}`,
      };
    }
  }

  /**
   * Create a pull request using GitHub CLI or alternative methods
   */
  private async createPullRequest(
    branchName: string,
    taskDescription: string,
    commitMessage: string
  ): Promise<PRResult> {
    // First, try to push the branch
    const pushResult = this.runGit(["push", "-u", "origin", branchName]);
    if (!pushResult.success) {
      return {
        success: false,
        message: `Failed to push branch: ${pushResult.output}`,
      };
    }

    // Try using GitHub CLI (gh) first
    const ghResult = this.runGh([
      "pr", "create",
      "--title", commitMessage,
      "--body", this.generatePRBody(taskDescription),
      "--head", branchName,
    ]);

    if (ghResult.success) {
      // Extract PR URL from output
      const prUrl = ghResult.output.match(/https:\/\/github\.com\/[^\s]+/)?.[0];
      return {
        success: true,
        prUrl,
        message: `PR created successfully: ${prUrl}`,
      };
    }

    // If gh CLI fails, return the branch info for manual PR creation
    const remoteUrl = this.runGit(["remote", "get-url", "origin"]).output;
    const repoMatch = remoteUrl.match(/github\.com[:\/]([^\/]+)\/([^\/\.]+)/);
    
    if (repoMatch) {
      const [, owner, repo] = repoMatch;
      const prUrl = `https://github.com/${owner}/${repo}/compare/${branchName}?expand=1`;
      return {
        success: true,
        prUrl,
        message: `Branch pushed. Create PR: ${prUrl}`,
      };
    }

    return {
      success: false,
      message: "Branch pushed but could not create PR. Please create manually.",
    };
  }

  /**
   * Run a GitHub CLI command
   */
  private runGh(args: string[]): { success: boolean; output: string } {
    const proc = spawnSync(["gh", ...args], {
      cwd: this.workingDirectory,
      stdout: "pipe",
      stderr: "pipe",
    });

    const output = proc.stdout.toString() + proc.stderr.toString();
    return { success: proc.exitCode === 0, output: output.trim() };
  }

  /**
   * Generate PR body from task description
   */
  private generatePRBody(taskDescription: string): string {
    return `## Changes Made

${taskDescription}

---

*This PR was automatically created by Koryphaios in Beginner Mode* 🤖✨`;
  }

  /**
   * Check if auto-commit is available (git repo with remote)
   */
  async isAvailable(): Promise<boolean> {
    if (!this.git.isGitRepo()) return false;
    
    // Check if we can push (have origin remote)
    return this.hasOriginRemote();
  }
}

export class AutoCommitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AutoCommitError";
  }
}
