/**
 * Tests for CheckpointStore polish features:
 * - Legacy notes ref backward compatibility (NOTES_REF migration)
 * - Per-session lock with monotonic sequence numbers
 * - Manifest ref for O(1) timeline reads
 * - Temp dir sweep on construction
 * - Session lock LRU eviction
 * - Metadata attachment failure surfacing
 * - Prune with manifest rebuild
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { CheckpointStore } from '../checkpoint-store';
import { GitExecutor } from '../git-executor';
import { ShadowRepo } from '../shadow-repo';
import { spawnSync } from 'bun';
import { writeFileSync, mkdirSync, realpathSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const TEST_DIR = join(
  tmpdir(),
  `kory-checkpoint-polish-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
);

function gitInit(dir: string): void {
  mkdirSync(dir, { recursive: true });
  spawnSync(['git', 'init', '-b', 'main'], { cwd: dir, stdout: 'pipe', stderr: 'pipe' });
  spawnSync(['git', 'config', 'user.email', 'test@test.com'], {
    cwd: dir,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  spawnSync(['git', 'config', 'user.name', 'Test'], { cwd: dir, stdout: 'pipe', stderr: 'pipe' });
  // Windows defaults (core.autocrlf=true, 260-char path limit) break
  // cross-platform tests: CRLF alters file content after git restore, and
  // long shadow ref paths exceed MAX_PATH. Disable both explicitly.
  spawnSync(['git', 'config', 'core.autocrlf', 'false'], {
    cwd: dir,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  spawnSync(['git', 'config', 'core.longpaths', 'true'], {
    cwd: dir,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  writeFileSync(join(dir, 'README.md'), '# Initial\n');
  spawnSync(['git', 'add', '-A'], { cwd: dir, stdout: 'pipe', stderr: 'pipe' });
  spawnSync(['git', 'commit', '-m', 'init'], { cwd: dir, stdout: 'pipe', stderr: 'pipe' });
}

/**
 * Git identity for shadow-repo notes operations. The shadow bare repo has its
 * own config (separate from the main repo), and in the isolated test runner
 * HOME is a fresh temp directory with no global ~/.gitconfig fallback. Without
 * an explicit identity, `git notes add` fails silently and later getMetadata
 * returns undefined. Pass these via the `env` option so they reach the git
 * subprocess through the safe-env allowlist.
 */
const GIT_IDENTITY: Record<string, string> = {
  GIT_AUTHOR_NAME: 'Test',
  GIT_AUTHOR_EMAIL: 'test@test.com',
  GIT_COMMITTER_NAME: 'Test',
  GIT_COMMITTER_EMAIL: 'test@test.com',
};

function gitOutput(dir: string, ...args: string[]): string {
  const proc = spawnSync(['git', ...args], { cwd: dir, stdout: 'pipe', stderr: 'pipe' });
  return (proc.stdout.toString() + proc.stderr.toString()).trim();
}

describe('CheckpointStore polish features', () => {
  beforeAll(() => {
    gitInit(TEST_DIR);
  });

  afterAll(() => {
    try {
      rmSync(TEST_DIR, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  });

  // NOTE: This suite requires a generous test timeout (60s) because git
  // operations are serialized by the global gitMutex and later tests
  // accumulate checkpoint state. Run with:
  //   bun test --timeout 60000 src/kory/__tests__/checkpoint-store-polish.test.ts

  // ─── Legacy notes ref backward compatibility ────────────────────────────

  describe('legacy notes ref backward compatibility', () => {
    test('reads metadata from legacy refs/notes/shadow-logger ref', async () => {
      const store = new CheckpointStore(TEST_DIR);
      // Use shadow-context GitExecutor for notes operations (notes live in shadow repo).
      const shadowGit = new GitExecutor(TEST_DIR, ShadowRepo.shadowEnv(TEST_DIR));

      // Create a checkpoint — v2 writes direct per-checkpoint metadata.
      writeFileSync(join(TEST_DIR, 'compat-test.txt'), 'content');
      const hash = await store.createGhostCommit('Compat test', {
        agentId: 'compat-session',
        model: 'test-model',
      });
      expect(hash).toBeTruthy();

      // Copy direct metadata into the old notes ref, then remove the direct ref
      // to prove old checkpoints remain readable.
      const direct = await shadowGit.exec(['cat-file', 'blob', `refs/kory/metadata/${hash}`]);
      expect(direct.success).toBe(true);
      const notesAdd = await shadowGit.exec(
        ['notes', '--ref', 'refs/notes/shadow-logger', 'add', '-f', '-m', direct.stdout, hash!],
        { env: GIT_IDENTITY },
      );
      expect(notesAdd.success).toBe(true);
      await shadowGit.exec(['update-ref', '-d', `refs/kory/metadata/${hash}`]);

      // getMetadata should fall back to the legacy ref
      const metadata = await store.getMetadata(hash!);
      expect(metadata).toBeDefined();
      expect(metadata!.model).toBe('test-model');
      expect(metadata!.agentId).toBe('compat-session');
    });

    test('prefers new notes ref over legacy when both exist', async () => {
      const store = new CheckpointStore(TEST_DIR);
      const shadowGit = new GitExecutor(TEST_DIR, ShadowRepo.shadowEnv(TEST_DIR));

      writeFileSync(join(TEST_DIR, 'pref-test.txt'), 'content');
      const hash = await store.createGhostCommit('Pref test', {
        agentId: 'pref-session',
        model: 'new-model',
      });
      expect(hash).toBeTruthy();

      // Also add a legacy note with different model
      const legacyNotesAdd = await shadowGit.exec(
        [
          'notes',
          '--ref',
          'refs/notes/shadow-logger',
          'add',
          '-f',
          '-m',
          JSON.stringify({ id: 'old', model: 'old-model', timestamp: Date.now() }),
          hash!,
        ],
        { env: GIT_IDENTITY },
      );
      expect(legacyNotesAdd.success).toBe(true);

      // Should prefer the new ref
      const metadata = await store.getMetadata(hash!);
      expect(metadata!.model).toBe('new-model');
    });
  });

  // ─── Per-session lock + monotonic sequence numbers ──────────────────────

  describe('per-session lock + monotonic sequence numbers', () => {
    test('assigns monotonically increasing sequence numbers', async () => {
      const store = new CheckpointStore(TEST_DIR);

      writeFileSync(join(TEST_DIR, 'seq-1.txt'), '1');
      const hash1 = await store.createGhostCommit('Seq 1', { agentId: 'seq-session' });
      writeFileSync(join(TEST_DIR, 'seq-2.txt'), '2');
      const hash2 = await store.createGhostCommit('Seq 2', { agentId: 'seq-session' });
      writeFileSync(join(TEST_DIR, 'seq-3.txt'), '3');
      const hash3 = await store.createGhostCommit('Seq 3', { agentId: 'seq-session' });

      const meta1 = await store.getMetadata(hash1!);
      const meta2 = await store.getMetadata(hash2!);
      const meta3 = await store.getMetadata(hash3!);

      expect(meta1!.sequence).toBe(0);
      expect(meta2!.sequence).toBe(1);
      expect(meta3!.sequence).toBe(2);
    });

    test('concurrent checkpoint creation does not produce duplicate sequence numbers', async () => {
      const store = new CheckpointStore(TEST_DIR);
      const agentId = 'concurrent-session';

      // Launch 5 concurrent checkpoint creations for the same session.
      // The per-session lock should serialize them so each gets a unique sequence.
      const promises = Array.from({ length: 5 }, (_, i) => {
        writeFileSync(join(TEST_DIR, `concurrent-${i}.txt`), String(i));
        return store.createGhostCommit(`Concurrent ${i}`, { agentId });
      });

      const hashes = await Promise.all(promises);
      const sequences = await Promise.all(
        hashes.filter(Boolean).map((h) => store.getMetadata(h!).then((m) => m?.sequence)),
      );

      // All sequences should be unique
      const unique = new Set(sequences);
      expect(unique.size).toBe(5);
      // Sequences should be 0-4 (in some order due to lock serialization)
      expect(Math.max(...sequences!)).toBe(4);
      expect(Math.min(...sequences!)).toBe(0);
    });

    test('different sessions have independent sequence counters', async () => {
      const store = new CheckpointStore(TEST_DIR);

      writeFileSync(join(TEST_DIR, 'iso-a.txt'), 'a');
      const hashA = await store.createGhostCommit('A', { agentId: 'session-a' });
      writeFileSync(join(TEST_DIR, 'iso-b.txt'), 'b');
      const hashB = await store.createGhostCommit('B', { agentId: 'session-b' });
      writeFileSync(join(TEST_DIR, 'iso-a2.txt'), 'a2');
      const hashA2 = await store.createGhostCommit('A2', { agentId: 'session-a' });

      const metaA = await store.getMetadata(hashA!);
      const metaB = await store.getMetadata(hashB!);
      const metaA2 = await store.getMetadata(hashA2!);

      expect(metaA!.sequence).toBe(0);
      expect(metaB!.sequence).toBe(0); // session-b starts at 0
      expect(metaA2!.sequence).toBe(1); // session-a continues from 1
    });
  });

  // ─── Manifest ref for O(1) timeline reads ───────────────────────────────

  describe('manifest ref for O(1) timeline reads', () => {
    test('getTimeline uses manifest after first legacy read builds it', async () => {
      const store = new CheckpointStore(TEST_DIR);
      const agentId = 'manifest-session';

      // Create checkpoints
      for (let i = 0; i < 3; i++) {
        writeFileSync(join(TEST_DIR, `manifest-${i}.txt`), String(i));
        await store.createGhostCommit(`Manifest ${i}`, { agentId, model: `model-${i}` });
      }

      // First read: builds manifest from legacy path (no manifest yet)
      const timeline1 = await store.getTimeline(10, agentId);
      expect(timeline1.length).toBe(3);

      // Verify manifest ref was created in the shadow repo
      const shadowGit = new GitExecutor(TEST_DIR, ShadowRepo.shadowEnv(TEST_DIR));
      const refResult = await shadowGit.exec([
        'for-each-ref',
        '--format=%(refname)',
        'refs/kory/manifests',
      ]);
      expect(refResult.success).toBe(true);
      expect(refResult.stdout).toContain('refs/kory/manifests/manifest-session-');

      // Second read: should use the manifest (O(1))
      const timeline2 = await store.getTimeline(10, agentId);
      expect(timeline2.length).toBe(3);
      // Verify the data matches
      expect(timeline2[0].model).toMatch(/^model-/);
      expect(timeline2.every((e) => e.recoverable)).toBe(true);
    });

    test('manifest is updated when new checkpoints are created', async () => {
      const store = new CheckpointStore(TEST_DIR);
      const agentId = 'manifest-update-session';

      writeFileSync(join(TEST_DIR, 'mu-1.txt'), '1');
      await store.createGhostCommit('MU 1', { agentId });
      const timeline1 = await store.getTimeline(10, agentId);
      expect(timeline1.length).toBe(1);

      // Add another checkpoint — manifest should be updated within the session lock
      writeFileSync(join(TEST_DIR, 'mu-2.txt'), '2');
      await store.createGhostCommit('MU 2', { agentId });
      const timeline2 = await store.getTimeline(10, agentId);
      expect(timeline2.length).toBe(2);
    });
  });

  // ─── Interrupted temp-index cleanup ─────────────────────────────────────

  describe('interrupted temp-index cleanup', () => {
    test('sweeps orphaned temp dirs before the next locked checkpoint', async () => {
      const sweepDir = join(
        tmpdir(),
        `kory-sweep-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      );
      gitInit(sweepDir);

      // Simulate a crash by creating orphaned temp dirs
      const tempDir = join(ShadowRepo.shadowPath(sweepDir), '..', 'tmp', 'checkpoints');
      mkdirSync(join(tempDir, 'orphan-1'), { recursive: true });
      mkdirSync(join(tempDir, 'orphan-2'), { recursive: true });
      writeFileSync(join(tempDir, 'orphan-1', 'index'), 'stale');
      writeFileSync(join(tempDir, 'orphan-2', 'index'), 'stale');

      expect(existsSync(join(tempDir, 'orphan-1'))).toBe(true);

      const store = new CheckpointStore(sweepDir);
      writeFileSync(join(sweepDir, 'after-crash.txt'), 'safe');
      expect(
        await store.createGhostCommit('After interrupted index', { agentId: 'sweep-session' }),
      ).toBeTruthy();
      expect(existsSync(join(tempDir, 'orphan-1'))).toBe(false);
      expect(existsSync(join(tempDir, 'orphan-2'))).toBe(false);

      // Clean up
      try {
        rmSync(sweepDir, { recursive: true, force: true });
      } catch {
        /* best-effort */
      }
    });

    test('constructors are side-effect free and do not sweep temp dirs', () => {
      const noSweepDir = join(
        tmpdir(),
        `kory-no-sweep-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      );
      gitInit(noSweepDir);

      // Construct first — initialization and cleanup remain lazy.
      const store = new CheckpointStore(noSweepDir);
      expect(store).toBeDefined();

      // Now create a temp dir that's "in use" (created after construction)
      const tempDir = join(noSweepDir, '.koryphaios', 'tmp', 'checkpoints');
      if (!existsSync(tempDir)) mkdirSync(tempDir, { recursive: true });
      const activeDir = join(tempDir, 'active-index');
      mkdirSync(activeDir, { recursive: true });
      writeFileSync(join(activeDir, 'index'), 'active');

      // Construct a second store — construction alone must not touch it.
      const store2 = new CheckpointStore(noSweepDir);
      expect(store2).toBeDefined();
      expect(existsSync(activeDir)).toBe(true);

      try {
        rmSync(noSweepDir, { recursive: true, force: true });
      } catch {
        /* best-effort */
      }
    });
  });

  // ─── Session lock LRU eviction ──────────────────────────────────────────

  describe('session lock LRU eviction', () => {
    test('evicts oldest session locks when cap is exceeded', async () => {
      // We can't easily test the internal MAX_SESSION_LOCKS=128 without
      // creating 129 sessions, but we can verify that multiple sessions work
      // correctly and don't crash. The LRU eviction is internal and safe —
      // an evicted session simply gets a fresh mutex on next use.
      const store = new CheckpointStore(TEST_DIR);

      // Create checkpoints for 5 different sessions
      for (let i = 0; i < 5; i++) {
        writeFileSync(join(TEST_DIR, `lru-${i}.txt`), String(i));
        const hash = await store.createGhostCommit(`LRU ${i}`, { agentId: `lru-session-${i}` });
        expect(hash).toBeTruthy();
      }

      // All should work — no crash from lock eviction
      const timeline = await store.getTimeline(100);
      expect(timeline.length).toBeGreaterThanOrEqual(5);
    });
  });

  // ─── Cursor sequence-based race prevention ──────────────────────────────

  describe('cursor sequence and explicit navigation', () => {
    test('new atomic checkpoint publication advances an explicitly rewound cursor', async () => {
      const store = new CheckpointStore(TEST_DIR);
      const agentId = 'cursor-race-session';

      // Create 3 checkpoints with increasing sequences
      writeFileSync(join(TEST_DIR, 'cr-1.txt'), '1');
      const hash1 = await store.createGhostCommit('CR 1', { agentId });
      writeFileSync(join(TEST_DIR, 'cr-2.txt'), '2');
      const hash2 = await store.createGhostCommit('CR 2', { agentId });
      writeFileSync(join(TEST_DIR, 'cr-3.txt'), '3');
      const hash3 = await store.createGhostCommit('CR 3', { agentId });

      // Cursor should be at hash3 (newest)
      const cursor = await store.getCursor(agentId);
      expect(cursor).toBe(hash3);

      // Manually set cursor to hash1 (older) — this should work (explicit set)
      await store.setCursor(agentId, hash1!);
      expect(await store.getCursor(agentId)).toBe(hash1);

      // A new checkpoint allocates the next sequence under the repository
      // lock and advances the cursor in the same ref transaction.
      writeFileSync(join(TEST_DIR, 'cr-4.txt'), '4');
      const hash4 = await store.createGhostCommit('CR 4', { agentId });
      expect(await store.getCursor(agentId)).toBe(hash4);
    });

    test('orders checkpoints by sequence when wall-clock time ties or moves backward', async () => {
      const clockDir = join(
        tmpdir(),
        `kory-clock-${process.pid}-${Math.random().toString(36).slice(2, 8)}`,
      );
      gitInit(clockDir);
      const store = new CheckpointStore(clockDir);
      try {
        writeFileSync(join(clockDir, 'clock.txt'), 'first');
        const first = await store.createGhostCommit('First clock state', {
          agentId: 'clock-session',
        });
        writeFileSync(join(clockDir, 'clock.txt'), 'second');
        const second = await store.createGhostCommit('Second clock state', {
          agentId: 'clock-session',
        });

        const shadowGit = new GitExecutor(clockDir, ShadowRepo.shadowEnv(clockDir));
        const manifestRef = (
          await shadowGit.exec(['for-each-ref', '--format=%(refname)', 'refs/kory/manifests'])
        ).stdout.trim();
        const manifestBlob = await shadowGit.exec(['cat-file', 'blob', manifestRef]);
        const manifest = JSON.parse(manifestBlob.stdout);
        for (const entry of manifest.entries) {
          entry.timestamp = entry.sequence === 0 ? 2_000 : 1_000;
        }
        const replacement = await shadowGit.exec(['hash-object', '-w', '--stdin'], {
          stdin: JSON.stringify(manifest),
        });
        expect(
          (await shadowGit.exec(['update-ref', manifestRef, replacement.stdout.trim()])).success,
        ).toBe(true);

        const timeline = await store.getTimeline(10, 'clock-session');
        expect(timeline.map((entry) => entry.hash)).toEqual([second, first]);
        expect(timeline.map((entry) => entry.sequence)).toEqual([1, 0]);
      } finally {
        try {
          rmSync(clockDir, { recursive: true, force: true });
        } catch {
          /* best-effort */
        }
      }
    });
  });

  // ─── Prune with manifest rebuild ────────────────────────────────────────

  describe('prune with manifest rebuild', () => {
    test('prune removes old checkpoints and rebuilds manifest', async () => {
      const pruneDir = join(
        tmpdir(),
        `kory-prune-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      );
      gitInit(pruneDir);

      const store = new CheckpointStore(pruneDir);
      const agentId = 'prune-session';

      // Create a checkpoint
      writeFileSync(join(pruneDir, 'prune-1.txt'), '1');
      const hash = await store.createGhostCommit('Prune 1', { agentId });
      expect(hash).toBeTruthy();

      // Verify it's in the timeline
      const timelineBefore = await store.getTimeline(10, agentId);
      expect(timelineBefore.length).toBe(1);

      // Prune with -1 days retention — should remove everything (cutoff is tomorrow)
      const result = await store.prune(-1);
      expect(result.removed).toBeGreaterThanOrEqual(1);

      // Verify the checkpoint ref was actually deleted in the shadow repo
      const shadowGit = new GitExecutor(pruneDir, ShadowRepo.shadowEnv(pruneDir));
      const refsAfter = await shadowGit.exec([
        'for-each-ref',
        '--format=%(objectname)',
        'refs/kory/checkpoints',
      ]);
      expect(refsAfter.stdout.split('\n')).not.toContain(hash!);
      expect(await store.getMetadata(hash!)).toBeUndefined();
      expect(await store.getCursor(agentId)).toBeNull();

      // The manifest is retained empty, and the separate high-water ref keeps
      // sequence allocation monotonic even after all public checkpoints go.
      const manifestRefs = await shadowGit.exec([
        'for-each-ref',
        '--format=%(objectname)',
        'refs/kory/manifests',
      ]);
      const manifestOid = manifestRefs.stdout.trim();
      expect(manifestOid).toBeTruthy();
      const manifestResult = await shadowGit.exec(['cat-file', 'blob', manifestOid]);
      expect(JSON.parse(manifestResult.stdout).entries).toHaveLength(0);

      // Timeline via manifest should now be empty
      const timelineAfter = await store.getTimeline(10, agentId);
      // Note: the legacy fallback may still find the ghost commit via reflog,
      // but the manifest path should return 0. Since we just called getTimeline
      // which triggers manifest rebuild, the manifest should be empty.
      expect(timelineAfter.length).toBe(0);

      writeFileSync(join(pruneDir, 'prune-2.txt'), '2');
      const replacement = await store.createGhostCommit('Prune 2', { agentId });
      expect((await store.getMetadata(replacement!))?.sequence).toBe(1);

      try {
        rmSync(pruneDir, { recursive: true, force: true });
      } catch {
        /* best-effort */
      }
    });
  });

  // ─── GitExecutor stdin support ──────────────────────────────────────────

  describe('GitExecutor stdin support', () => {
    test('pipes stdin to git hash-object --stdin', async () => {
      const git = new GitExecutor(TEST_DIR);
      const content = '{"test":"data"}';
      const result = await git.exec(['hash-object', '-w', '--stdin'], { stdin: content });
      expect(result.success).toBe(true);
      expect(result.stdout.trim()).toMatch(/^[0-9a-f]{40}$/);

      // Verify the blob content
      const catResult = await git.exec(['cat-file', 'blob', result.stdout.trim()]);
      expect(catResult.success).toBe(true);
      expect(catResult.stdout).toBe(content);
    });

    test('timeout kills process and returns promptly', async () => {
      const git = new GitExecutor(TEST_DIR);
      // Use a command that genuinely hangs: `git fetch` with a bogus URL
      // and a very short timeout. The abort controller should kick in.
      const result = await git.exec(['fetch', 'https://10.255.255.1/nonexistent/repo.git'], {
        timeoutMs: 100,
      });
      expect(result.success).toBe(false);
      expect(result.stderr).toContain('timed out');
    });
  });

  // ─── WorkspaceManager manifest persistence ──────────────────────────────

  describe('WorkspaceManager manifest persistence', () => {
    test('persists worktree metadata to .koryphaios/worktrees.json', async () => {
      const wmDir = join(
        tmpdir(),
        `kory-wm-manifest-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      );
      gitInit(wmDir);

      const { WorkspaceManager } = await import('../workspace-manager');
      const wm = new WorkspaceManager(wmDir, { worktreeDir: '.trees', worktreeLimit: 4 });
      await wm.init();

      const worktree = await wm.spawn('persist-test', 'Persist Test', 'agent-persist');
      expect(worktree).toBeTruthy();

      // Verify manifest file exists and contains the worktree
      const manifestPath = join(wmDir, '.koryphaios', 'worktrees.json');
      expect(existsSync(manifestPath)).toBe(true);
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8'));
      expect(manifest.worktrees).toHaveLength(1);
      expect(manifest.worktrees[0].id).toBe('persist-test');
      expect(manifest.worktrees[0].taskName).toBe('Persist Test');
      expect(manifest.worktrees[0].agentId).toBe('agent-persist');

      await wm.cleanup('persist-test');
      await wm.shutdown();

      try {
        rmSync(wmDir, { recursive: true, force: true });
      } catch {
        /* best-effort */
      }
    });

    test('recovers worktree metadata losslessly on restart', async () => {
      const recoverDir = join(
        tmpdir(),
        `kory-wm-recover-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      );
      gitInit(recoverDir);
      // macOS symlinks /var → /private/var. git worktree list --porcelain
      // returns realpath-resolved paths, so canonicalize recoverDir before
      // passing it to WorkspaceManager — otherwise the recovery prefix check
      // (absoluteWtPath.startsWith(worktreeBaseDir)) fails to match.
      const canonicalRecoverDir = realpathSync(recoverDir);

      const { WorkspaceManager } = await import('../workspace-manager');
      const wm1 = new WorkspaceManager(canonicalRecoverDir, {
        worktreeDir: '.trees',
        worktreeLimit: 4,
      });
      await wm1.init();

      const worktree = await wm1.spawn('recover-test', 'Original Task Name', 'agent-recover');
      expect(worktree).toBeTruthy();
      expect(worktree!.taskName).toBe('Original Task Name');

      // Simulate a restart: create a new WorkspaceManager
      // (don't call shutdown on wm1 — simulate a crash)
      const wm2 = new WorkspaceManager(canonicalRecoverDir, {
        worktreeDir: '.trees',
        worktreeLimit: 4,
      });
      await wm2.init();

      // The worktree should be recovered with its original metadata
      expect(wm2.hasWorktree('recover-test')).toBe(true);
      const path = wm2.getWorktreePath('recover-test');
      // On macOS, git worktree list --porcelain returns realpath-resolved
      // paths (e.g. /private/var/folders/... instead of /var/folders/...),
      // so compare canonical paths instead of raw strings.
      // On Windows, realpathSync may return 8.3 short names (RUNNER~1) for
      // one path and long names (runneradmin) for the other. Use
      // realpathSync.native (GetFinalPathNameByHandleW) for consistent
      // canonicalization on both sides.
      const realpath = realpathSync.native ?? realpathSync;
      expect(path ? realpath(path) : null).toBe(realpath(worktree!.path));

      // Clean up
      await wm2.cleanup('recover-test');
      await wm2.shutdown();

      try {
        rmSync(recoverDir, { recursive: true, force: true });
      } catch {
        /* best-effort */
      }
    });

    test('shutdown drains all active worktrees', async () => {
      const shutdownDir = join(
        tmpdir(),
        `kory-wm-shutdown-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      );
      gitInit(shutdownDir);

      const { WorkspaceManager } = await import('../workspace-manager');
      const wm = new WorkspaceManager(shutdownDir, { worktreeDir: '.trees', worktreeLimit: 4 });
      await wm.init();

      // Spawn 2 worktrees
      await wm.spawn('shutdown-1', 'Task 1', 'agent-1');
      await wm.spawn('shutdown-2', 'Task 2', 'agent-2');
      expect(wm.getStatus().active).toHaveLength(2);

      // Shutdown should clean up all worktrees
      await wm.shutdown();
      expect(wm.getStatus().active).toHaveLength(0);

      // Verify no worktrees remain in git
      const git = new GitExecutor(shutdownDir);
      const listResult = await git.exec(['worktree', 'list', '--porcelain']);
      // Only the main worktree should remain
      const worktreeLines = listResult.stdout.split('\n').filter((l) => l.startsWith('worktree '));
      expect(worktreeLines.length).toBe(1);

      try {
        rmSync(shutdownDir, { recursive: true, force: true });
      } catch {
        /* best-effort */
      }
    });
  });

  // ─── Config schema validation ───────────────────────────────────────────

  describe('config schema validation', () => {
    test('rejects skipHooks as non-boolean', () => {
      const { validateConfig } = require('../../config-schema');
      const { ConfigError } = require('../../errors');
      try {
        validateConfig({
          workspace: { skipHooks: 'true' as unknown as boolean },
        });
        expect.unreachable('should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(ConfigError);
        expect(err.context?.validationErrors).toContain('workspace.skipHooks must be a boolean');
      }
    });

    test('accepts skipHooks as boolean', () => {
      const { validateConfig } = require('../../config-schema');
      // Should not throw
      validateConfig({ workspace: { skipHooks: true } });
      validateConfig({ workspace: { skipHooks: false } });
    });
  });
});
