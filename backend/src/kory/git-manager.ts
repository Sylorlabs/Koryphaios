import { spawnSync } from 'bun';
import { readFileSync } from 'node:fs';
import { resolve, relative, isAbsolute } from 'node:path';
import { koryLog, serverLog } from '../logger';
import { GitExecutor } from './git-executor';
import { getSafeSubprocessEnv } from '../runtime/safe-env';
import { gitWorkspaceOwnership, isIndependentChatGitRepository } from './git-owned-workspace';

/** Branch names: alphanumeric, hyphen, underscore, slash (for refs/heads/foo). Max 255 chars. */
const SAFE_BRANCH_REGEX = /^[a-zA-Z0-9/_.-]{1,255}$/;

export interface GitFileStatus {
  path: string;
  status: 'modified' | 'added' | 'deleted' | 'renamed' | 'untracked' | 'staged';
  staged: boolean;
  originalPath?: string;
  additions?: number;
  deletions?: number;
}

export class GitManager {
  private git: GitExecutor;
  private owner: ReturnType<typeof gitWorkspaceOwnership>;

  constructor(private workingDirectory: string) {
    this.git = new GitExecutor(workingDirectory);
    this.owner = gitWorkspaceOwnership(workingDirectory);
  }

  /** Async git execution via the unified GitExecutor (mutex, timeout, retry). */
  async runGit(args: string[]): Promise<{ success: boolean; output: string }> {
    return this.git.execCombined(args);
  }

  /** Sync git execution — ONLY for constructor/startup checks (isGitRepo).
   *  All runtime operations must use the async runGit() via GitExecutor. */
  private runGitSync(args: string[]): { success: boolean; output: string } {
    const proc = spawnSync(['git', ...args], {
      cwd: this.workingDirectory,
      stdout: 'pipe',
      stderr: 'pipe',
      env: getSafeSubprocessEnv(),
    });
    const output = proc.stdout.toString() + proc.stderr.toString();
    return { success: proc.exitCode === 0, output };
  }

  isGitRepo(): boolean {
    const owner = this.owner ?? gitWorkspaceOwnership(this.workingDirectory);
    if (owner) {
      this.owner = owner;
      // Even rev-parse may consult agent-controlled Git configuration. Startup
      // needs only a filesystem hint; all authoritative runtime queries go
      // through the mandatory sandbox in GitExecutor, never unrestricted Git.
      return isIndependentChatGitRepository(owner.checkout);
    }
    return this.runGitSync(['rev-parse', '--is-inside-work-tree']).success;
  }

  async getStatus(): Promise<GitFileStatus[]> {
    if (!this.isGitRepo()) return [];

    // 1. Get porcelain status
    const { success, stdout: porcelainOutput } = await this.git.exec([
      'status',
      '--porcelain=v1',
      '-z',
      '--untracked-files=all',
    ]);
    if (!success) return [];

    // 2. Get line stats (numstat)
    const { stdout: numstatOutput } = await this.git.exec(['diff', '--numstat', '-z']);
    const { stdout: stagedNumstatOutput } = await this.git.exec([
      'diff',
      '--cached',
      '--numstat',
      '-z',
    ]);

    const parseNumstat = (out: string) => {
      const stats = new Map<string, { additions: number; deletions: number }>();
      const records = out.split('\0');
      for (let i = 0; i < records.length; i++) {
        const record = records[i];
        const first = record.indexOf('\t');
        const second = record.indexOf('\t', first + 1);
        if (first < 0 || second < 0) continue;
        let path = record.slice(second + 1);
        if (!path) {
          // With -z, a rename has separate old/new pathname records.
          i++;
          path = records[++i];
        }
        if (path)
          stats.set(path, {
            additions: Number.parseInt(record.slice(0, first), 10) || 0,
            deletions: Number.parseInt(record.slice(first + 1, second), 10) || 0,
          });
      }
      return stats;
    };

    const unstagedStats = parseNumstat(numstatOutput);
    const stagedStats = parseNumstat(stagedNumstatOutput);

    const files: GitFileStatus[] = [];
    const lines = porcelainOutput.split('\0');

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (!line) continue;
      const x = line[0];
      const y = line[1];
      const path = line.slice(3);
      const originalPath =
        x === 'R' || x === 'C' || y === 'R' || y === 'C' ? lines[++i] : undefined;

      if (x !== ' ' && x !== '?') {
        files.push({
          path,
          status: this.mapStatus(x),
          staged: true,
          ...(originalPath && { originalPath }),
          ...stagedStats.get(path),
        });
      }

      if (y !== ' ') {
        files.push({
          path,
          status: this.mapStatus(y),
          staged: false,
          ...unstagedStats.get(path),
        });
      }
    }

    return files;
  }

  private mapStatus(code: string): GitFileStatus['status'] {
    switch (code) {
      case 'M':
        return 'modified';
      case 'A':
        return 'added';
      case 'D':
        return 'deleted';
      case 'R':
        return 'renamed';
      case '?':
        return 'untracked';
      default:
        return 'modified';
    }
  }

  /** Resolve path under repo root; return null if outside (path traversal). */
  resolvePathUnderRepo(filePath: string): string | null {
    const root = resolve(this.workingDirectory);
    const abs = isAbsolute(filePath) ? resolve(filePath) : resolve(root, filePath);
    const rel = relative(root, abs);
    if (rel.startsWith('..') || isAbsolute(rel)) return null;
    return abs;
  }

  /** Validate branch name for checkout/merge. */
  static validateBranchName(branch: string): boolean {
    return typeof branch === 'string' && branch.length > 0 && SAFE_BRANCH_REGEX.test(branch);
  }

  async getDiff(path: string, staged = false): Promise<string> {
    const safePath = this.resolvePathUnderRepo(path);
    if (!safePath) return '';
    const args = ['diff'];
    if (staged) args.push('--cached');
    args.push('--', safePath);
    return (await this.runGit(args)).output;
  }

  async stageFile(path: string): Promise<boolean> {
    const safePath = this.resolvePathUnderRepo(path);
    if (!safePath) return false;
    return (await this.runGit(['add', '--', safePath])).success;
  }

  async unstageFile(path: string): Promise<boolean> {
    const safePath = this.resolvePathUnderRepo(path);
    if (!safePath) return false;
    const renamed = (await this.getStatus()).find(
      (file) => file.staged && file.path === path && file.originalPath,
    );
    const original = renamed?.originalPath ? this.resolvePathUnderRepo(renamed.originalPath) : null;
    return (await this.runGit(['reset', 'HEAD', '--', safePath, ...(original ? [original] : [])]))
      .success;
  }

  async restoreFile(path: string): Promise<boolean> {
    const safePath = this.resolvePathUnderRepo(path);
    if (!safePath) return false;
    return (await this.runGit(['checkout', '--', safePath])).success;
  }

  async commit(message: string): Promise<boolean> {
    return (await this.runGit(['commit', '-m', message])).success;
  }

  async push(): Promise<{ success: boolean; output: string }> {
    const upstream = await this.runGit(['rev-parse', '--abbrev-ref', '@{upstream}']);
    if (upstream.success) return this.runGit(['push']);
    const branch = await this.getBranch();
    if (!GitManager.validateBranchName(branch) || branch === 'HEAD')
      return { success: false, output: 'Check out a branch before pushing.' };
    return this.runGit(['push', '--set-upstream', 'origin', branch]);
  }

  async getOrigin(): Promise<string | null> {
    const result = await this.runGit(['remote', 'get-url', 'origin']);
    return result.success ? result.output.trim() : null;
  }

  async setOrigin(url: string): Promise<{ success: boolean; output: string }> {
    // Publication is explicit. Local paths must never point a chat push back
    // into the source checkout; accept hosted Git transports only.
    let hosted = false;
    try {
      const parsed = new URL(url);
      hosted =
        ['https:', 'ssh:'].includes(parsed.protocol) &&
        !!parsed.hostname &&
        !parsed.password &&
        (parsed.protocol !== 'https:' || !parsed.username);
    } catch {
      hosted = /^[\w.-]+@[\w.-]+:[^\s]+$/.test(url);
    }
    if (!hosted) return { success: false, output: 'Use an HTTPS or SSH Git remote URL.' };
    const origin = await this.getOrigin();
    return this.runGit(['remote', origin ? 'set-url' : 'add', 'origin', url]);
  }

  async pull(): Promise<{ success: boolean; output: string }> {
    return this.runGit(['pull']);
  }

  async getBranch(): Promise<string> {
    const { output } = await this.runGit(['rev-parse', '--abbrev-ref', 'HEAD']);
    return output.trim();
  }

  async getAheadBehind(): Promise<{ ahead: number; behind: number }> {
    const { success, output } = await this.runGit([
      'rev-list',
      '--left-right',
      '--count',
      'HEAD...@{upstream}',
    ]);
    if (!success) return { ahead: 0, behind: 0 };
    const [aheadRaw, behindRaw] = output.trim().split(/\s+/);
    return {
      ahead: Number.parseInt(aheadRaw ?? '0', 10) || 0,
      behind: Number.parseInt(behindRaw ?? '0', 10) || 0,
    };
  }

  async getFileContent(path: string): Promise<string | null> {
    const safePath = this.resolvePathUnderRepo(path);
    if (!safePath) return null;
    try {
      return readFileSync(safePath, 'utf-8');
    } catch (err: unknown) {
      serverLog.debug(
        { err: err instanceof Error ? err.message : String(err) },
        'Failed to read file content in git manager',
      );
      return null;
    }
  }

  async getBranches(): Promise<string[]> {
    const { output } = await this.runGit(['branch', '--format=%(refname:short)']);
    return output.split('\n').filter(Boolean);
  }

  async checkout(branch: string, create = false): Promise<boolean> {
    if (!GitManager.validateBranchName(branch)) return false;
    const args = ['checkout'];
    if (create) args.push('-b');
    args.push(branch);
    return (await this.runGit(args)).success;
  }

  async merge(
    branch: string,
  ): Promise<{ success: boolean; output: string; hasConflicts: boolean }> {
    if (!GitManager.validateBranchName(branch)) {
      return { success: false, output: 'Invalid branch name', hasConflicts: false };
    }
    const result = await this.runGit(['merge', branch]);
    const hasConflicts =
      result.output.includes('CONFLICT') || result.output.includes('Automatic merge failed');
    return { ...result, hasConflicts };
  }

  async getConflicts(): Promise<string[]> {
    const { success, output } = await this.runGit(['diff', '--name-only', '--diff-filter=U']);
    if (!success) return [];
    return output.split('\n').filter(Boolean);
  }

  /** Create a shadow commit to track changes for a specific session/task */
  async createShadowCommit(sessionId: string, taskDescription: string): Promise<string | null> {
    if (!this.isGitRepo()) return null;

    // 1. Stage all current changes
    await this.runGit(['add', '.']);

    // 2. Commit with a special prefix
    const message = `[KORY SHADOW] ${sessionId}: ${taskDescription.slice(0, 50)}`;
    const result = await this.runGit(['commit', '-m', message, '--no-verify']);

    if (result.success) {
      const hashResult = await this.runGit(['rev-parse', 'HEAD']);
      const hash = hashResult.output.trim();
      koryLog.info({ sessionId, hash }, 'Created shadow commit');
      return hash;
    }
    return null;
  }

  /** Hard reset to a specific commit hash */
  async rollback(hash: string): Promise<boolean> {
    const result = await this.runGit(['reset', '--hard', hash]);
    if (result.success) {
      await this.runGit(['clean', '-fd']);
      koryLog.info({ hash }, 'Rolled back to commit');
      return true;
    }
    return false;
  }

  /** Get the current HEAD hash */
  async getCurrentHash(): Promise<string | null> {
    const result = await this.runGit(['rev-parse', 'HEAD']);
    return result.success ? result.output.trim() : null;
  }

  /** Check if there are uncommitted changes */
  async hasChanges(): Promise<boolean> {
    const status = await this.getStatus();
    return status.length > 0;
  }
}
