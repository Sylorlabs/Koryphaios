// Real integration tests for Git Workflow features
// Tests WorkspaceManager, GitManager, AutoCommitService with actual git operations

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { WorkspaceManager } from '../src/kory/workspace-manager';
import { GitManager } from '../src/kory/git-manager';
import { AutoCommitService } from '../src/kory/auto-commit-service';
import { ShadowLogger } from '../src/kory/shadow-logger';
import { SnapshotManager } from '../src/kory/snapshot-manager';
import { join } from 'node:path';
import { mkdirSync, rmSync, existsSync, writeFileSync, readFileSync } from 'node:fs';
import { spawnSync } from 'bun';

const TEST_DIR = join(process.cwd(), '.test-git-workflow');

describe('Git Workflow Integration Tests', () => {
  // Setup: Create a fresh git repo for testing
  beforeAll(() => {
    // Clean up any previous test directory
    if (existsSync(TEST_DIR)) {
      rmSync(TEST_DIR, { recursive: true, force: true });
    }

    // Create test directory
    mkdirSync(TEST_DIR, { recursive: true });

    // Initialize git repo
    spawnSync(['git', 'init'], { cwd: TEST_DIR, stdout: 'pipe', stderr: 'pipe' });
    spawnSync(['git', 'config', 'user.email', 'test@test.com'], {
      cwd: TEST_DIR,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    spawnSync(['git', 'config', 'user.name', 'Test User'], {
      cwd: TEST_DIR,
      stdout: 'pipe',
      stderr: 'pipe',
    });

    // Create initial commit
    writeFileSync(join(TEST_DIR, 'README.md'), '# Test Project');
    spawnSync(['git', 'add', '.'], { cwd: TEST_DIR, stdout: 'pipe', stderr: 'pipe' });
    spawnSync(['git', 'commit', '-m', 'Initial commit'], {
      cwd: TEST_DIR,
      stdout: 'pipe',
      stderr: 'pipe',
    });
  });

  afterAll(() => {
    // Cleanup
    if (existsSync(TEST_DIR)) {
      rmSync(TEST_DIR, { recursive: true, force: true });
    }
  });

  describe('GitManager', () => {
    test('should detect git repository', () => {
      const git = new GitManager(TEST_DIR);
      expect(git.isGitRepo()).toBe(true);
    });

    test('should get current branch', async () => {
      const git = new GitManager(TEST_DIR);
      const branch = await git.getBranch();
      // Accept either "main" (newer git) or "master" (older git)
      expect(['main', 'master']).toContain(branch);
    });

    test('should get current hash', async () => {
      const git = new GitManager(TEST_DIR);
      const hash = await git.getCurrentHash();
      expect(hash).toBeDefined();
      expect(hash?.length).toBe(40); // SHA-1 hash
    });

    test('should stage and commit files', async () => {
      const git = new GitManager(TEST_DIR);

      // Create a file
      writeFileSync(join(TEST_DIR, 'test-file.txt'), 'Test content');

      // Stage it
      const staged = await git.stageFile('test-file.txt');
      expect(staged).toBe(true);

      // Commit
      const committed = await git.commit('Add test file');
      expect(committed).toBe(true);

      // Verify status
      const status = await git.getStatus();
      expect(status.length).toBe(0); // No uncommitted changes
    });

    test('should rollback to previous hash', async () => {
      const git = new GitManager(TEST_DIR);

      // Get current hash (getCurrentHash is async — must await, else a Promise leaks into rollback)
      const originalHash = await git.getCurrentHash();
      expect(originalHash).toBeDefined();

      // Create and commit a new file
      writeFileSync(join(TEST_DIR, 'rollback-test.txt'), 'This will be rolled back');
      await git.stageFile('rollback-test.txt');
      await git.commit('Add file to rollback');

      // Verify file exists
      expect(existsSync(join(TEST_DIR, 'rollback-test.txt'))).toBe(true);

      // Rollback
      const rolledBack = await git.rollback(originalHash!);
      expect(rolledBack).toBe(true);

      // Verify file is gone
      expect(existsSync(join(TEST_DIR, 'rollback-test.txt'))).toBe(false);
    });
  });

  describe('WorkspaceManager', () => {
    let workspace: WorkspaceManager;

    beforeAll(() => {
      workspace = new WorkspaceManager(TEST_DIR, {
        worktreeDir: '.trees',
        worktreeLimit: 4,
        copyEnvFiles: false,
      });
    });

    test('should be initialized', () => {
      expect(workspace).toBeDefined();
    });

    test('should spawn worktree', async () => {
      const worktree = await workspace.spawn('test-task-1', 'Add feature', 'agent-1');
      expect(worktree).toBeDefined();
      expect(worktree?.path).toContain('.trees');
      expect(worktree?.branchName).toContain('ai/');

      // Verify worktree directory exists
      expect(existsSync(worktree!.path)).toBe(true);

      // Verify it's a valid worktree
      const result = spawnSync(['git', 'worktree', 'list'], {
        cwd: TEST_DIR,
        stdout: 'pipe',
        stderr: 'pipe',
      });
      expect(result.stdout.toString()).toContain(worktree!.path);
    });

    test('should track active worktrees', () => {
      const status = workspace.getStatus();
      expect(status.active.length).toBeGreaterThan(0);
      expect(status.maxAllowed).toBe(4);
    });

    test('should create files in worktree isolation', async () => {
      const worktree = await workspace.spawn('test-task-2', 'Another feature', 'agent-2');
      expect(worktree).toBeDefined();

      // Write file in worktree
      writeFileSync(join(worktree!.path, 'isolated-file.txt'), 'Isolated content');

      // Verify file exists in worktree
      expect(existsSync(join(worktree!.path, 'isolated-file.txt'))).toBe(true);

      // Verify file does NOT exist in main repo
      expect(existsSync(join(TEST_DIR, 'isolated-file.txt'))).toBe(false);
    });

    test('should reconcile worktree changes', async () => {
      // Spawn a worktree
      const worktree = await workspace.spawn('test-task-3', 'Reconcile test', 'agent-3');
      expect(worktree).toBeDefined();

      // Add a file in the worktree
      writeFileSync(join(worktree!.path, 'reconcile-test.txt'), 'Reconciled content');

      // Commit the file in worktree
      spawnSync(['git', 'add', '.'], { cwd: worktree!.path, stdout: 'pipe', stderr: 'pipe' });
      spawnSync(['git', 'commit', '-m', 'Add reconcile test file', '--no-verify'], {
        cwd: worktree!.path,
        stdout: 'pipe',
        stderr: 'pipe',
      });

      // Reconcile back to main
      const result = await workspace.reconcile('test-task-3', true); // squash = true
      expect(result.success).toBe(true);

      // Verify file now exists in main repo
      expect(existsSync(join(TEST_DIR, 'reconcile-test.txt'))).toBe(true);

      // Verify worktree is cleaned up
      expect(existsSync(worktree!.path)).toBe(false);
    });

    test('should cleanup worktree without reconciling', async () => {
      const worktree = await workspace.spawn('test-task-4', 'Cleanup test', 'agent-4');
      expect(worktree).toBeDefined();

      // Write file but don't commit
      writeFileSync(join(worktree!.path, 'cleanup-test.txt'), 'Cleanup content');

      // Cleanup without reconcile
      const result = await workspace.cleanup('test-task-4');
      expect(result.success).toBe(true);

      // Verify worktree is gone
      expect(existsSync(worktree!.path)).toBe(false);

      // Verify file is NOT in main repo
      expect(existsSync(join(TEST_DIR, 'cleanup-test.txt'))).toBe(false);
    });

    test('should enforce worktree limit', async () => {
      // Create max number of worktrees
      const worktrees = [];
      for (let i = 0; i < 4; i++) {
        const wt = await workspace.spawn(`limit-test-${i}`, `Limit test ${i}`, `agent-${i}`);
        if (wt) worktrees.push(wt);
      }

      // Try to create one more (should fail or return null)
      const extra = await workspace.spawn('limit-test-extra', 'Should fail', 'agent-extra');

      // Should either be null or we should be at capacity
      const status = workspace.getStatus();
      expect(status.availableSlots).toBeLessThanOrEqual(0);

      // Cleanup
      for (const wt of worktrees) {
        await workspace.cleanup(wt.id);
      }
    });
  });

  describe('AutoCommitService', () => {
    let git: GitManager;
    let autoCommit: AutoCommitService;

    beforeAll(() => {
      git = new GitManager(TEST_DIR);
      autoCommit = new AutoCommitService(TEST_DIR, git);
    });

    test('should generate branch name from task', async () => {
      // Create some changes
      writeFileSync(join(TEST_DIR, 'auto-test.txt'), 'Auto commit test');

      // Get current branch before
      const branchBefore = await git.getBranch();

      // Auto-commit
      const result = await autoCommit.autoCommitAndCreatePR('Fix authentication bug in login');

      // Should create branch
      expect(result.success).toBe(true);
      expect(result.branch).toBeDefined();
      expect(result.branch).toContain('kory/');
      expect(result.commitHash).toBeDefined();

      // Verify branch exists
      const branches = await git.getBranches();
      expect(branches.some((b) => b.includes('kory/'))).toBe(true);

      // We're back on original branch
      const branchAfter = await git.getBranch();
      expect(branchAfter).toBe(branchBefore);
    });

    test('should return to original branch after auto-commit', async () => {
      const currentBranch = await git.getBranch();

      // This test relies on previous test creating a branch
      // The auto-commit should have returned us to main/master
      expect(['main', 'master']).toContain(currentBranch);
    });
  });

  describe('ShadowLogger', () => {
    let shadowLogger: ShadowLogger;

    beforeAll(() => {
      shadowLogger = new ShadowLogger(TEST_DIR);
    });

    test('should create ghost commit', async () => {
      // Create a file to commit
      writeFileSync(join(TEST_DIR, 'ghost-test.txt'), 'Ghost content');

      const hash = await shadowLogger.createGhostCommit('Test ghost commit', {
        model: 'gpt-4',
        prompt: 'Test prompt',
        cost: 0.02,
        agentId: 'test-agent',
      });

      expect(hash).toBeDefined();
      expect(hash?.length).toBe(40);
    });

    test('should get timeline', async () => {
      const timeline = await shadowLogger.getTimeline(10);
      expect(timeline.length).toBeGreaterThan(0);
      expect(timeline[0].hash).toBeDefined();
      expect(timeline[0].recoverable).toBe(true);
    });

    test('should recover to ghost state', async () => {
      const timeline = await shadowLogger.getTimeline(1);
      expect(timeline.length).toBeGreaterThan(0);

      const targetHash = timeline[0].hash;

      // Create a new file
      writeFileSync(join(TEST_DIR, 'post-ghost.txt'), 'This should be removed');
      expect(existsSync(join(TEST_DIR, 'post-ghost.txt'))).toBe(true);

      // Recover to ghost state
      const result = await shadowLogger.recover(targetHash);
      expect(result.success).toBe(true);

      // File should be gone
      expect(existsSync(join(TEST_DIR, 'post-ghost.txt'))).toBe(false);
    });
  });

  describe('SnapshotManager', () => {
    let snapshotManager: SnapshotManager;

    beforeAll(() => {
      snapshotManager = new SnapshotManager(TEST_DIR);
    });

    test('should create snapshot', async () => {
      // Create test file
      writeFileSync(join(TEST_DIR, 'snapshot-test.txt'), 'Snapshot content');

      await snapshotManager.createSnapshot(
        'test-session',
        'latest',
        ['snapshot-test.txt'],
        TEST_DIR,
      );

      // Verify snapshot directory exists
      const snapshotDir = join(TEST_DIR, '.koryphaios', 'snapshots', 'test-session', 'latest');
      expect(existsSync(snapshotDir)).toBe(true);
      expect(existsSync(join(snapshotDir, 'snapshot-test.txt'))).toBe(true);
    });

    test('should restore snapshot', async () => {
      // Modify the file
      writeFileSync(join(TEST_DIR, 'snapshot-test.txt'), 'Modified content');

      // Restore snapshot
      const result = await snapshotManager.restoreSnapshot('test-session', 'latest', TEST_DIR);
      expect(result.success).toBe(true);

      // Verify content is restored
      const content = readFileSync(join(TEST_DIR, 'snapshot-test.txt'), 'utf-8');
      expect(content).toBe('Snapshot content');
    });
  });
});
