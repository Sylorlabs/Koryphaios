/**
 * Tests for the shadow repo isolation system.
 *
 * Verifies:
 * - Ghost commits are invisible to `git log --all` in the main repo
 * - Ghost commits are invisible to `git push --mirror`
 * - One-way alternates support capture without exposing private objects
 * - Shadow repo migration moves existing ghost refs
 * - Rich metadata (toolCalls, commands, fileEdits) is stored and retrieved
 * - GhostCommitTool creates checkpoints on demand
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { CheckpointStore, type GhostCommitMetadata } from '../checkpoint-store';
import { ShadowRepo } from '../shadow-repo';
import { GitExecutor } from '../git-executor';
import { GhostCommitTool } from '../../tools/checkpoint';
import { spawnSync } from 'bun';
import {
  writeFileSync,
  mkdirSync,
  rmSync,
  existsSync,
  readFileSync,
  renameSync,
  symlinkSync,
  utimesSync,
} from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { tmpdir } from 'node:os';

const TEST_DIR = join(
  tmpdir(),
  `kory-shadow-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
);

function gitInit(dir: string): void {
  spawnSync(['git', 'init', '-b', 'main'], { cwd: dir, stdout: 'pipe', stderr: 'pipe' });
  spawnSync(['git', 'config', 'user.email', 'test@test.com'], {
    cwd: dir,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  spawnSync(['git', 'config', 'user.name', 'Test'], { cwd: dir, stdout: 'pipe', stderr: 'pipe' });
}

function createCommittedRepo(dir: string): void {
  mkdirSync(dir, { recursive: true });
  gitInit(dir);
  writeFileSync(join(dir, 'README.md'), '# Test\n');
  spawnSync(['git', 'add', '-A'], { cwd: dir, stdout: 'pipe', stderr: 'pipe' });
  spawnSync(['git', 'commit', '-m', 'init'], { cwd: dir, stdout: 'pipe', stderr: 'pipe' });
}

function gitOutput(dir: string, ...args: string[]): string {
  const result = spawnSync(['git', ...args], { cwd: dir, stdout: 'pipe', stderr: 'pipe' });
  return new TextDecoder().decode(result.stdout).trim();
}

function gitOutputShadow(dir: string, ...args: string[]): string {
  const env = { ...process.env, ...ShadowRepo.shadowEnv(dir) };
  const result = spawnSync(['git', ...args], { cwd: dir, stdout: 'pipe', stderr: 'pipe', env });
  return new TextDecoder().decode(result.stdout).trim();
}

describe('Shadow Repo Isolation', () => {
  beforeAll(() => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true, force: true });
    mkdirSync(TEST_DIR, { recursive: true });
    gitInit(TEST_DIR);
    writeFileSync(join(TEST_DIR, 'README.md'), '# Test\n');
    spawnSync(['git', 'add', '-A'], { cwd: TEST_DIR, stdout: 'pipe', stderr: 'pipe' });
    spawnSync(['git', 'commit', '-m', 'init'], { cwd: TEST_DIR, stdout: 'pipe', stderr: 'pipe' });
  });

  afterAll(() => {
    try {
      rmSync(TEST_DIR, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  });

  // NOTE: Run with: bun test --timeout 60000 src/kory/__tests__/shadow-repo.test.ts

  describe('ghost commit invisibility', () => {
    test('ghost commits do not appear in git log --all', async () => {
      const store = new CheckpointStore(TEST_DIR);
      writeFileSync(join(TEST_DIR, 'invisible.txt'), 'content');
      const hash = await store.createGhostCommit('Invisible ghost', {
        agentId: 'invisibility-test',
        model: 'test-model',
      });
      expect(hash).toBeTruthy();

      // The ghost commit should NOT appear in the main repo's log
      const mainLog = gitOutput(TEST_DIR, 'log', '--all', '--format=%H');
      expect(mainLog).not.toContain(hash!);

      // But it SHOULD appear in the shadow repo's refs
      const shadowRefs = gitOutputShadow(
        TEST_DIR,
        'for-each-ref',
        '--format=%(objectname)',
        'refs/kory/checkpoints/',
      );
      expect(shadowRefs).toContain(hash!);
    });

    test('ghost commit refs do not appear in git for-each-ref in main repo', async () => {
      const store = new CheckpointStore(TEST_DIR);
      writeFileSync(join(TEST_DIR, 'refs-test.txt'), 'content');
      await store.createGhostCommit('Refs test', { agentId: 'refs-test' });

      // Main repo should not have any refs/kory/ refs
      const mainRefs = gitOutput(TEST_DIR, 'for-each-ref', '--format=%(refname)', 'refs/kory/');
      expect(mainRefs).toBe('');

      // Shadow repo should have them
      const shadowRefs = gitOutputShadow(
        TEST_DIR,
        'for-each-ref',
        '--format=%(refname)',
        'refs/kory/',
      );
      expect(shadowRefs).toContain('refs/kory/checkpoints/');
    });

    test('git push --mirror would not include ghost refs', async () => {
      const store = new CheckpointStore(TEST_DIR);
      writeFileSync(join(TEST_DIR, 'mirror-test.txt'), 'content');
      await store.createGhostCommit('Mirror test', { agentId: 'mirror-test' });

      // List all refs that would be pushed by --mirror
      const mainRefs = gitOutput(TEST_DIR, 'for-each-ref', '--format=%(refname)');
      expect(mainRefs).not.toContain('refs/kory/');
      expect(mainRefs).not.toContain('refs/notes/checkpoint-store');
    });
  });

  describe('isolated object storage', () => {
    test('shadow repo can read main repo objects', async () => {
      const store = new CheckpointStore(TEST_DIR);
      writeFileSync(join(TEST_DIR, 'alternate-read.txt'), 'content');
      const hash = await store.createGhostCommit('Alternate read test', { agentId: 'alt-read' });
      expect(hash).toBeTruthy();

      // Capture can still seed a private tree from the main repository.
      const headInMain = gitOutput(TEST_DIR, 'rev-parse', 'HEAD');
      const catFileResult = gitOutputShadow(TEST_DIR, 'cat-file', '-t', headInMain);
      expect(catFileResult).toBe('commit');
    });

    test('normal main Git cannot read private objects but a bounded explicit read can', async () => {
      const store = new CheckpointStore(TEST_DIR);
      writeFileSync(join(TEST_DIR, 'alternate-write.txt'), 'content');
      const hash = await store.createGhostCommit('Alternate write test', { agentId: 'alt-write' });
      expect(hash).toBeTruthy();

      expect(gitOutput(TEST_DIR, 'cat-file', '-t', hash!)).toBe('');
      const explicit = spawnSync(['git', 'cat-file', '-t', hash!], {
        cwd: TEST_DIR,
        stdout: 'pipe',
        stderr: 'pipe',
        env: { ...process.env, ...ShadowRepo.mainReadEnv(TEST_DIR) },
      });
      expect(explicit.exitCode).toBe(0);
      expect(new TextDecoder().decode(explicit.stdout).trim()).toBe('commit');
    });

    test('uses the common object database from a linked worktree', async () => {
      const mainDir = join(
        tmpdir(),
        `kory-worktree-main-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      );
      const linkedDir = `${mainDir}-linked`;
      try {
        createCommittedRepo(mainDir);
        const added = spawnSync(['git', 'worktree', 'add', '-b', 'linked-test', linkedDir], {
          cwd: mainDir,
          stdout: 'pipe',
          stderr: 'pipe',
        });
        expect(added.exitCode).toBe(0);

        writeFileSync(join(linkedDir, 'linked.txt'), 'linked worktree');
        const store = new CheckpointStore(linkedDir);
        const hash = await store.createGhostCommit('Linked worktree', {
          agentId: 'linked-session',
        });
        expect(hash).toBeTruthy();

        const shadowObjects = join(ShadowRepo.shadowPath(linkedDir), 'objects');
        const alternateEntry = readFileSync(
          join(shadowObjects, 'info', 'alternates'),
          'utf-8',
        ).trim();
        expect(resolve(shadowObjects, alternateEntry)).toBe(join(mainDir, '.git', 'objects'));
        expect(ShadowRepo.shadowPath(linkedDir)).toBe(
          join(mainDir, '.git', 'koryphaios', 'shadow-git'),
        );
        const removed = spawnSync(['git', 'worktree', 'remove', '--force', linkedDir], {
          cwd: mainDir,
          stdout: 'pipe',
          stderr: 'pipe',
        });
        expect(removed.exitCode).toBe(0);
        expect(gitOutputShadow(mainDir, 'cat-file', '-t', hash!)).toBe('commit');
        const status = spawnSync(['git', 'status', '--short'], {
          cwd: mainDir,
          stdout: 'pipe',
          stderr: 'pipe',
        });
        expect(status.exitCode).toBe(0);
        expect(new TextDecoder().decode(status.stderr)).toBe('');
      } finally {
        spawnSync(['git', 'worktree', 'remove', '--force', linkedDir], {
          cwd: mainDir,
          stdout: 'pipe',
          stderr: 'pipe',
        });
        rmSync(linkedDir, { recursive: true, force: true });
        rmSync(mainDir, { recursive: true, force: true });
      }
    });

    test('never captures the internal .koryphaios directory without a gitignore', async () => {
      const unignoredDir = join(
        tmpdir(),
        `kory-unignored-internals-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      );
      try {
        createCommittedRepo(unignoredDir);
        const store = new CheckpointStore(unignoredDir);
        const hash = await store.createGhostCommit('No internal ingestion', {
          agentId: 'no-internals',
        });
        expect(hash).toBeTruthy();
        const treePaths = gitOutputShadow(unignoredDir, 'ls-tree', '-r', '--name-only', hash!);
        expect(
          treePaths
            .split('\n')
            .some((path) => path === '.koryphaios' || path.startsWith('.koryphaios/')),
        ).toBe(false);
      } finally {
        rmSync(unignoredDir, { recursive: true, force: true });
      }
    });

    test('captures untracked source while an ignored top-level .koryphaios directory exists', async () => {
      const repo = join(
        tmpdir(),
        `kory-ignored-internals-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      );
      try {
        createCommittedRepo(repo);
        writeFileSync(join(repo, '.gitignore'), '.koryphaios/\n');
        spawnSync(['git', 'add', '.gitignore'], { cwd: repo, stdout: 'pipe', stderr: 'pipe' });
        spawnSync(['git', 'commit', '-m', 'ignore private state'], {
          cwd: repo,
          stdout: 'pipe',
          stderr: 'pipe',
        });
        mkdirSync(join(repo, '.koryphaios'), { recursive: true });
        writeFileSync(join(repo, '.koryphaios', 'secret.txt'), 'never persist');
        writeFileSync(join(repo, 'new-source.ts'), 'export const captured = true;\n');

        const hash = await new CheckpointStore(repo).createGhostCommit('Ignored internals', {
          agentId: 'ignored-internals',
        });
        expect(hash).toBeTruthy();
        expect(gitOutputShadow(repo, 'show', `${hash}:new-source.ts`)).toContain('captured = true');
        expect(gitOutputShadow(repo, 'ls-tree', '-r', '--name-only', hash!)).not.toContain(
          '.koryphaios',
        );
      } finally {
        rmSync(repo, { recursive: true, force: true });
      }
    });

    test('strips tracked legacy internals from a checkpoint tree', async () => {
      const trackedDir = join(
        tmpdir(),
        `kory-tracked-internals-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      );
      try {
        createCommittedRepo(trackedDir);
        mkdirSync(join(trackedDir, '.koryphaios'), { recursive: true });
        writeFileSync(join(trackedDir, '.koryphaios', 'tracked-secret.txt'), 'must-not-copy');
        spawnSync(['git', 'add', '-f', '.koryphaios/tracked-secret.txt'], { cwd: trackedDir });
        spawnSync(['git', 'commit', '-m', 'legacy tracked internal'], { cwd: trackedDir });
        const hash = await new CheckpointStore(trackedDir).createGhostCommit(
          'Exclude tracked internals',
          { agentId: 'tracked-internals' },
        );
        expect(hash).toBeTruthy();
        expect(gitOutputShadow(trackedDir, 'ls-tree', '-r', '--name-only', hash!)).not.toContain(
          '.koryphaios/',
        );
      } finally {
        rmSync(trackedDir, { recursive: true, force: true });
      }
    });

    test('publishes a root snapshot whose full closure survives loss of main objects', async () => {
      const durableDir = join(
        tmpdir(),
        `kory-standalone-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      );
      try {
        createCommittedRepo(durableDir);
        writeFileSync(join(durableDir, 'stable.txt'), 'stable content');
        const hash = await new CheckpointStore(durableDir).createGhostCommit(
          'Standalone snapshot',
          { agentId: 'standalone-session' },
        );
        expect(hash).toBeTruthy();
        const shadow = ShadowRepo.shadowPath(durableDir);
        const alternate = join(shadow, 'objects', 'info', 'alternates');
        const alternateOff = `${alternate}.off`;
        const mainObjects = join(durableDir, '.git', 'objects');
        const mainObjectsOff = join(durableDir, '.git', 'objects.off');
        renameSync(alternate, alternateOff);
        renameSync(mainObjects, mainObjectsOff);
        try {
          const show = spawnSync(['git', '--git-dir', shadow, 'show', `${hash}:stable.txt`], {
            stdout: 'pipe',
            stderr: 'pipe',
          });
          expect(show.exitCode).toBe(0);
          expect(new TextDecoder().decode(show.stdout)).toBe('stable content');
          const count = spawnSync(['git', '--git-dir', shadow, 'rev-list', '--count', hash!], {
            stdout: 'pipe',
            stderr: 'pipe',
          });
          expect(count.exitCode).toBe(0);
          expect(new TextDecoder().decode(count.stdout).trim()).toBe('1');
          const fsck = spawnSync(['git', '--git-dir', shadow, 'fsck', '--full', '--strict'], {
            stdout: 'pipe',
            stderr: 'pipe',
          });
          expect(fsck.exitCode, new TextDecoder().decode(fsck.stderr)).toBe(0);
        } finally {
          renameSync(mainObjectsOff, mainObjects);
          renameSync(alternateOff, alternate);
        }
      } finally {
        rmSync(durableDir, { recursive: true, force: true });
      }
    });

    test('ordinary main fsck does not enumerate private checkpoint objects', async () => {
      const isolatedDir = join(
        tmpdir(),
        `kory-fsck-isolation-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      );
      try {
        createCommittedRepo(isolatedDir);
        const hash = await new CheckpointStore(isolatedDir).createGhostCommit('Private from fsck', {
          agentId: 'fsck-isolation',
        });
        expect(hash).toBeTruthy();
        const fsck = spawnSync(['git', 'fsck', '--full', '--unreachable'], {
          cwd: isolatedDir,
          stdout: 'pipe',
          stderr: 'pipe',
        });
        expect(fsck.exitCode).toBe(0);
        expect(new TextDecoder().decode(fsck.stdout)).not.toContain(hash!);
        expect(new TextDecoder().decode(fsck.stderr)).not.toContain(hash!);
      } finally {
        rmSync(isolatedDir, { recursive: true, force: true });
      }
    });

    test('matches the main repository object format for SHA-256 repositories', async () => {
      const shaDir = join(
        tmpdir(),
        `kory-sha256-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      );
      try {
        mkdirSync(shaDir, { recursive: true });
        const initialized = spawnSync(['git', 'init', '-b', 'main', '--object-format=sha256'], {
          cwd: shaDir,
          stdout: 'pipe',
          stderr: 'pipe',
        });
        if (initialized.exitCode !== 0) return;
        spawnSync(['git', 'config', 'user.name', 'SHA Test'], { cwd: shaDir });
        spawnSync(['git', 'config', 'user.email', 'sha@example.com'], { cwd: shaDir });
        writeFileSync(join(shaDir, 'sha.txt'), 'sha256');
        spawnSync(['git', 'add', '.'], { cwd: shaDir });
        spawnSync(['git', 'commit', '-m', 'base'], { cwd: shaDir });
        const hash = await new CheckpointStore(shaDir).createGhostCommit('SHA-256 checkpoint', {
          agentId: 'sha256-session',
        });
        expect(hash).toHaveLength(64);
        expect(gitOutputShadow(shaDir, 'rev-parse', '--show-object-format')).toBe('sha256');
      } finally {
        rmSync(shaDir, { recursive: true, force: true });
      }
    });
  });

  describe('process-safe initialization and transactions', () => {
    test('serializes concurrent stores for one session without losing manifest entries', async () => {
      const concurrentDir = join(
        tmpdir(),
        `kory-concurrent-stores-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      );
      try {
        createCommittedRepo(concurrentDir);
        const stores = Array.from({ length: 12 }, () => new CheckpointStore(concurrentDir));
        const hashes = await Promise.all(
          stores.map((store, index) =>
            store.createGhostCommit(`Concurrent store ${index}`, {
              agentId: 'shared-session',
            }),
          ),
        );

        expect(hashes.every(Boolean)).toBe(true);
        expect(new Set(hashes).size).toBe(12);
        const metadata = await Promise.all(
          hashes.map((hash, index) => stores[index].getMetadata(hash!)),
        );
        expect(metadata.map((entry) => entry?.sequence).sort((a, b) => a! - b!)).toEqual(
          Array.from({ length: 12 }, (_, index) => index),
        );
        expect((await stores[0].getTimeline(20, 'shared-session')).length).toBe(12);
      } finally {
        rmSync(concurrentDir, { recursive: true, force: true });
      }
    });

    test('serializes independent Bun processes without checkpoint loss', async () => {
      const processDir = join(
        tmpdir(),
        `kory-concurrent-processes-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      );
      try {
        createCommittedRepo(processDir);
        const checkpointModule = join(import.meta.dir, '..', 'checkpoint-store.ts');
        const children = Array.from({ length: 8 }, (_, index) =>
          Bun.spawn(
            [
              process.execPath,
              '-e',
              `import { CheckpointStore } from ${JSON.stringify(checkpointModule)}; const store = new CheckpointStore(${JSON.stringify(processDir)}); const hash = await store.createGhostCommit(${JSON.stringify('Child checkpoint')} + ${JSON.stringify(' ')} + ${index}, { agentId: 'process-session' }); if (!hash) process.exit(2); console.log(hash);`,
            ],
            {
              cwd: processDir,
              env: { ...process.env },
              stdout: 'pipe',
              stderr: 'pipe',
            },
          ),
        );

        const results = await Promise.all(
          children.map(async (child) => {
            const [stdout, stderr, exitCode] = await Promise.all([
              new Response(child.stdout).text(),
              new Response(child.stderr).text(),
              child.exited,
            ]);
            return { stdout, stderr, exitCode };
          }),
        );
        for (const result of results) {
          expect(result.exitCode, result.stderr).toBe(0);
        }

        const store = new CheckpointStore(processDir);
        const timeline = await store.getTimeline(20, 'process-session');
        expect(timeline).toHaveLength(8);
        expect(new Set(timeline.map((entry) => entry.hash)).size).toBe(8);
        expect(timeline.map((entry) => entry.sequence).sort((a, b) => a! - b!)).toEqual(
          Array.from({ length: 8 }, (_, index) => index),
        );
      } finally {
        rmSync(processDir, { recursive: true, force: true });
      }
    });

    test('repairs an interrupted bare-repository initialization in place', async () => {
      const interruptedDir = join(
        tmpdir(),
        `kory-interrupted-init-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      );
      try {
        createCommittedRepo(interruptedDir);
        const shadow = ShadowRepo.shadowPath(interruptedDir);
        mkdirSync(join(shadow, 'hooks'), { recursive: true });
        writeFileSync(join(shadow, 'hooks', 'preserved-hook'), 'keep');

        const store = new CheckpointStore(interruptedDir);
        const hash = await store.createGhostCommit('Repair interrupted init', {
          agentId: 'repair-session',
        });
        expect(hash).toBeTruthy();
        expect(readFileSync(join(shadow, 'hooks', 'preserved-hook'), 'utf-8')).toBe('keep');
        expect(gitOutputShadow(interruptedDir, 'rev-parse', '--is-bare-repository')).toBe('false');
        const bareOnly = spawnSync(
          ['git', '--git-dir', shadow, 'rev-parse', '--is-bare-repository'],
          {
            stdout: 'pipe',
            stderr: 'pipe',
          },
        );
        expect(new TextDecoder().decode(bareOnly.stdout).trim()).toBe('true');
      } finally {
        rmSync(interruptedDir, { recursive: true, force: true });
      }
    });

    test('fails closed without deleting a corrupt shadow path', async () => {
      const corruptDir = join(
        tmpdir(),
        `kory-corrupt-shadow-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      );
      try {
        createCommittedRepo(corruptDir);
        const shadow = ShadowRepo.shadowPath(corruptDir);
        mkdirSync(dirname(shadow), { recursive: true });
        writeFileSync(shadow, 'operator-owned-corrupt-sentinel');

        const store = new CheckpointStore(corruptDir);
        await expect(
          store.createGhostCommit('Must fail', { agentId: 'corrupt-session' }),
        ).rejects.toThrow('Could not initialize shadow repository');
        expect(readFileSync(shadow, 'utf-8')).toBe('operator-owned-corrupt-sentinel');
      } finally {
        rmSync(corruptDir, { recursive: true, force: true });
      }
    });

    test('reaps a lock whose local owner process is gone', async () => {
      const staleDir = join(
        tmpdir(),
        `kory-stale-lock-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      );
      try {
        createCommittedRepo(staleDir);
        const lockPath = join(staleDir, '.git', 'koryphaios-locks', 'checkpoint-shadow.lock');
        mkdirSync(lockPath, { recursive: true });
        writeFileSync(
          join(lockPath, 'owner.json'),
          JSON.stringify({
            token: 'dead-owner',
            pid: 2_147_483_647,
            hostname: (await import('node:os')).hostname(),
            createdAt: Date.now() - 60_000,
            purpose: 'stale test lock',
          }),
        );

        const store = new CheckpointStore(staleDir);
        expect(
          await store.createGhostCommit('After stale lock', { agentId: 'stale-session' }),
        ).toBeTruthy();
        expect(existsSync(lockPath)).toBe(false);
      } finally {
        rmSync(staleDir, { recursive: true, force: true });
      }
    });

    test('recovers an ownerless reaper left by an interrupted stale-lock cleanup', async () => {
      const staleDir = join(
        tmpdir(),
        `kory-stale-reaper-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      );
      try {
        createCommittedRepo(staleDir);
        const lockPath = join(staleDir, '.git', 'koryphaios-locks', 'checkpoint-shadow.lock');
        const reaperPath = `${lockPath}.reaper`;
        mkdirSync(lockPath, { recursive: true });
        writeFileSync(
          join(lockPath, 'owner.json'),
          JSON.stringify({
            token: 'dead-owner',
            pid: 2_147_483_647,
            hostname: (await import('node:os')).hostname(),
            createdAt: Date.now() - 60_000,
            purpose: 'stale test lock',
          }),
        );
        mkdirSync(reaperPath);
        const abandonedAt = new Date(Date.now() - 10_000);
        utimesSync(reaperPath, abandonedAt, abandonedAt);

        const startedAt = Date.now();
        const hash = await new CheckpointStore(staleDir).createGhostCommit(
          'After interrupted reaper',
          { agentId: 'stale-reaper-session' },
        );

        expect(hash).toBeTruthy();
        expect(Date.now() - startedAt).toBeLessThan(3_000);
        expect(existsSync(lockPath)).toBe(false);
        expect(existsSync(reaperPath)).toBe(false);
      } finally {
        rmSync(staleDir, { recursive: true, force: true });
      }
    });

    test('does not steal a live reaper lease while recovering a stale lock', async () => {
      const staleDir = join(
        tmpdir(),
        `kory-live-reaper-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      );
      try {
        createCommittedRepo(staleDir);
        const lockPath = join(staleDir, '.git', 'koryphaios-locks', 'checkpoint-shadow.lock');
        const reaperPath = `${lockPath}.reaper`;
        mkdirSync(lockPath, { recursive: true });
        writeFileSync(
          join(lockPath, 'owner.json'),
          JSON.stringify({
            token: 'dead-owner',
            pid: 2_147_483_647,
            hostname: (await import('node:os')).hostname(),
            createdAt: Date.now() - 60_000,
            purpose: 'stale test lock',
          }),
        );
        mkdirSync(reaperPath);
        writeFileSync(
          join(reaperPath, 'owner.json'),
          JSON.stringify({
            token: 'live-reaper',
            pid: process.pid,
            hostname: (await import('node:os')).hostname(),
            createdAt: Date.now(),
            purpose: 'live reaper lease',
          }),
        );

        let liveLeaseStayedPresent = false;
        const releaseLiveLease = setTimeout(() => {
          liveLeaseStayedPresent = existsSync(reaperPath);
          rmSync(reaperPath, { recursive: true, force: true });
        }, 100);

        const hash = await new CheckpointStore(staleDir).createGhostCommit('After live reaper', {
          agentId: 'live-reaper-session',
        });
        clearTimeout(releaseLiveLease);

        expect(hash).toBeTruthy();
        expect(liveLeaseStayedPresent).toBe(true);
        expect(existsSync(lockPath)).toBe(false);
        expect(existsSync(reaperPath)).toBe(false);
      } finally {
        rmSync(staleDir, { recursive: true, force: true });
      }
    });

    test('rejects a symlinked legacy shadow path without writing outside the repo', async () => {
      const repo = join(
        tmpdir(),
        `kory-shadow-link-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      );
      const outside = `${repo}-outside`;
      try {
        createCommittedRepo(repo);
        mkdirSync(join(repo, '.koryphaios'), { recursive: true });
        mkdirSync(outside, { recursive: true });
        symlinkSync(outside, join(repo, '.koryphaios', 'shadow-git'));
        await expect(
          new CheckpointStore(repo).createGhostCommit('Unsafe path', { agentId: 'unsafe-shadow' }),
        ).rejects.toThrow('symlinked legacy checkpoint storage');
        expect(existsSync(join(outside, 'HEAD'))).toBe(false);
        expect(existsSync(join(outside, 'objects'))).toBe(false);
      } finally {
        rmSync(repo, { recursive: true, force: true });
        rmSync(outside, { recursive: true, force: true });
      }
    });

    test('reports previously initialized storage as missing instead of empty history', async () => {
      const repo = join(
        tmpdir(),
        `kory-missing-shadow-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      );
      try {
        createCommittedRepo(repo);
        const store = new CheckpointStore(repo);
        expect(
          await store.createGhostCommit('Persist me', { agentId: 'missing-shadow' }),
        ).toBeTruthy();
        const shadow = ShadowRepo.shadowPath(repo);
        const displaced = `${shadow}.missing`;
        renameSync(shadow, displaced);
        try {
          await expect(new CheckpointStore(repo).getTimeline(10, 'missing-shadow')).rejects.toThrow(
            'Checkpoint history is missing',
          );
        } finally {
          renameSync(displaced, shadow);
        }
      } finally {
        rmSync(repo, { recursive: true, force: true });
      }
    });

    test('uses an explicit identity when global auto-detection is disabled', async () => {
      const repo = join(
        tmpdir(),
        `kory-strict-ident-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      );
      try {
        createCommittedRepo(repo);
        spawnSync(['git', 'config', 'user.useConfigOnly', 'true'], { cwd: repo });
        const modulePath = join(import.meta.dir, '..', 'checkpoint-store.ts');
        const child = Bun.spawn(
          [
            process.execPath,
            '-e',
            `import { CheckpointStore } from ${JSON.stringify(modulePath)}; const hash = await new CheckpointStore(${JSON.stringify(repo)}).createGhostCommit('Strict identity', { agentId: 'strict-ident' }); if (!hash) process.exit(2); console.log(hash);`,
          ],
          {
            cwd: repo,
            env: {
              ...process.env,
              GIT_CONFIG_GLOBAL: '/dev/null',
              GIT_CONFIG_SYSTEM: '/dev/null',
            },
            stdout: 'pipe',
            stderr: 'pipe',
          },
        );
        const [stderr, exitCode] = await Promise.all([
          new Response(child.stderr).text(),
          child.exited,
        ]);
        expect(exitCode, stderr).toBe(0);
      } finally {
        rmSync(repo, { recursive: true, force: true });
      }
    });

    test('uses collision-resistant valid namespaces for adversarial session IDs', async () => {
      const repo = join(
        tmpdir(),
        `kory-session-keys-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      );
      try {
        createCommittedRepo(repo);
        const store = new CheckpointStore(repo);
        const first = await store.createGhostCommit('Slash tenant', { agentId: 'tenant/a' });
        const second = await store.createGhostCommit('Space tenant', { agentId: 'tenant a' });
        const lockSuffix = await store.createGhostCommit('Lock suffix', { agentId: 'agent.lock' });
        expect(first).toBeTruthy();
        expect(second).toBeTruthy();
        expect(lockSuffix).toBeTruthy();
        expect((await store.getTimeline(10, 'tenant/a')).map((entry) => entry.hash)).toEqual([
          first!,
        ]);
        expect((await store.getTimeline(10, 'tenant a')).map((entry) => entry.hash)).toEqual([
          second!,
        ]);
        expect(await store.getCursor('tenant/a')).toBe(first);
        expect(await store.getCursor('tenant a')).toBe(second);
        const refs = gitOutputShadow(
          repo,
          'for-each-ref',
          '--format=%(refname)',
          'refs/kory/checkpoints',
        );
        for (const ref of refs.split('\n').filter(Boolean)) {
          const checked = spawnSync(['git', 'check-ref-format', ref], {
            stdout: 'pipe',
            stderr: 'pipe',
          });
          expect(checked.exitCode, ref).toBe(0);
        }
      } finally {
        rmSync(repo, { recursive: true, force: true });
      }
    });

    test('reconciles a corrupt manifest without resetting sequence or hiding refs', async () => {
      const repo = join(
        tmpdir(),
        `kory-manifest-corrupt-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      );
      try {
        createCommittedRepo(repo);
        const store = new CheckpointStore(repo);
        const agentId = 'manifest-corruption';
        expect(await store.createGhostCommit('First', { agentId })).toBeTruthy();
        expect(await store.createGhostCommit('Second', { agentId })).toBeTruthy();
        const manifestRef = gitOutputShadow(
          repo,
          'for-each-ref',
          '--format=%(refname)',
          'refs/kory/manifests',
        );
        const corruptBlob = spawnSync(['git', 'hash-object', '-w', '--stdin'], {
          cwd: repo,
          env: { ...process.env, ...ShadowRepo.shadowEnv(repo) },
          stdin: new TextEncoder().encode('{not-json'),
          stdout: 'pipe',
          stderr: 'pipe',
        });
        const corruptOid = new TextDecoder().decode(corruptBlob.stdout).trim();
        expect(gitOutputShadow(repo, 'update-ref', manifestRef, corruptOid)).toBe('');
        const third = await store.createGhostCommit('Third', { agentId });
        expect(third).toBeTruthy();
        const timeline = await store.getTimeline(10, agentId);
        expect(timeline).toHaveLength(3);
        expect(timeline.map((entry) => entry.sequence)).toEqual([2, 1, 0]);
      } finally {
        rmSync(repo, { recursive: true, force: true });
      }
    });

    test('publishes checkpoint, metadata, manifest, high-water, and cursor all-or-nothing', async () => {
      const repo = join(
        tmpdir(),
        `kory-atomic-refs-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      );
      try {
        createCommittedRepo(repo);
        const store = new CheckpointStore(repo);
        const agentId = 'atomic-publication';
        const first = await store.createGhostCommit('First atomic', { agentId });
        expect(first).toBeTruthy();
        const shadow = ShadowRepo.shadowPath(repo);
        const manifestRef = gitOutputShadow(
          repo,
          'for-each-ref',
          '--format=%(refname)',
          'refs/kory/manifests',
        );
        const lock = join(shadow, `${manifestRef}.lock`);
        mkdirSync(dirname(lock), { recursive: true });
        writeFileSync(lock, 'held');
        const second = await store.createGhostCommit('Must not tear', { agentId });
        expect(second).toBeNull();
        expect(await store.getCursor(agentId)).toBe(first);
        expect((await store.getTimeline(10, agentId)).map((entry) => entry.hash)).toEqual([first!]);
        expect(
          gitOutputShadow(repo, 'for-each-ref', '--format=%(objectname)', 'refs/kory/checkpoints')
            .split('\n')
            .filter(Boolean),
        ).toHaveLength(1);
        expect(
          gitOutputShadow(repo, 'for-each-ref', '--format=%(objectname)', 'refs/kory/metadata')
            .split('\n')
            .filter(Boolean),
        ).toHaveLength(1);
        rmSync(lock, { force: true });
      } finally {
        rmSync(repo, { recursive: true, force: true });
      }
    });

    test('metadata namespace conflict leaves no public checkpoint', async () => {
      const repo = join(
        tmpdir(),
        `kory-metadata-ref-fail-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      );
      try {
        createCommittedRepo(repo);
        await ShadowRepo.ensure(repo);
        const blocking = spawnSync(['git', 'hash-object', '-w', '--stdin'], {
          cwd: repo,
          env: { ...process.env, ...ShadowRepo.shadowEnv(repo) },
          stdin: new TextEncoder().encode('blocking'),
          stdout: 'pipe',
          stderr: 'pipe',
        });
        const blockingOid = new TextDecoder().decode(blocking.stdout).trim();
        const blocked = spawnSync(['git', 'update-ref', 'refs/kory/metadata', blockingOid], {
          cwd: repo,
          env: { ...process.env, ...ShadowRepo.shadowEnv(repo) },
          stdout: 'pipe',
          stderr: 'pipe',
        });
        expect(blocked.exitCode).toBe(0);
        const store = new CheckpointStore(repo);
        expect(
          await store.createGhostCommit('Blocked metadata', { agentId: 'blocked-metadata' }),
        ).toBeNull();
        expect(
          gitOutputShadow(repo, 'for-each-ref', '--format=%(refname)', 'refs/kory/checkpoints'),
        ).toBe('');
        expect(await store.getCursor('blocked-metadata')).toBeNull();
      } finally {
        rmSync(repo, { recursive: true, force: true });
      }
    });
  });

  describe('rich metadata', () => {
    test('toolCalls, commands, and fileEdits are stored and retrieved', async () => {
      const store = new CheckpointStore(TEST_DIR);
      writeFileSync(join(TEST_DIR, 'rich-meta.txt'), 'content');
      const hash = await store.createGhostCommit('Rich metadata test', {
        agentId: 'rich-meta-session',
        model: 'test-model',
        summary: 'Test summary line',
        toolCalls: [
          { name: 'bash', inputPreview: 'ls -la', resultPreview: 'file.txt', durationMs: 50 },
          { name: 'write_file', inputPreview: '{"path":"foo.ts"}', isError: false },
        ],
        commands: [{ command: 'npm test', exitCode: 0, durationMs: 1200 }],
        fileEdits: [{ path: 'src/foo.ts', operation: 'edit', linesAdded: 10, linesDeleted: 3 }],
        provider: 'anthropic',
        reasoningLevel: 'high',
      });
      expect(hash).toBeTruthy();

      const metadata = await store.getMetadata(hash!);
      expect(metadata).toBeDefined();
      expect(metadata!.summary).toBe('Test summary line');
      expect(metadata!.toolCalls).toHaveLength(2);
      expect(metadata!.toolCalls![0].name).toBe('bash');
      expect(metadata!.commands).toHaveLength(1);
      expect(metadata!.commands![0].command).toMatch(/^\[command sha256:[0-9a-f]{16}\]$/);
      expect(metadata!.fileEdits).toHaveLength(1);
      expect(metadata!.fileEdits![0].linesAdded).toBe(10);
      expect(metadata!.provider).toBe('anthropic');
      expect(metadata!.reasoningLevel).toBe('high');
    });

    test('timeline entries include lightweight instrumentation counts', async () => {
      const store = new CheckpointStore(TEST_DIR);
      const agentId = 'timeline-rich-session';
      writeFileSync(join(TEST_DIR, 'timeline-rich.txt'), 'content');
      const hash = await store.createGhostCommit('Timeline rich test', {
        agentId,
        model: 'test-model',
        summary: 'Timeline test',
        toolCalls: [{ name: 'grep', inputPreview: 'pattern' }],
        commands: [{ command: 'echo hi', exitCode: 0 }],
        fileEdits: [{ path: 'a.ts', operation: 'create', linesAdded: 5, linesDeleted: 0 }],
      });
      expect(hash).toBeTruthy();

      const timeline = await store.getTimeline(10, agentId);
      const entry = timeline.find((e) => e.hash === hash);
      expect(entry).toBeDefined();
      expect(entry!.summary).toBe('Timeline test');
      expect(entry!.toolCallCount).toBe(1);
      expect(entry!.commandCount).toBe(1);
      expect(entry!.fileEditCount).toBe(1);
      expect(entry!.hasRichMetadata).toBe(true);
    });

    test('checkpoints without rich metadata have hasRichMetadata=false', async () => {
      const store = new CheckpointStore(TEST_DIR);
      const agentId = 'no-rich-session';
      writeFileSync(join(TEST_DIR, 'no-rich.txt'), 'content');
      const hash = await store.createGhostCommit('No rich metadata', { agentId });
      expect(hash).toBeTruthy();

      const timeline = await store.getTimeline(10, agentId);
      const entry = timeline.find((e) => e.hash === hash);
      expect(entry).toBeDefined();
      expect(entry!.hasRichMetadata).toBeFalsy();
      expect(entry!.toolCallCount).toBeUndefined();
    });

    test('redacts secrets, bounds previews, and preserves truthful evidence counts', async () => {
      const secret = 'sk-proj-abcdefghijklmnop1234567890';
      const store = new CheckpointStore(TEST_DIR);
      const agentId = 'sanitized-rich-session';
      const hash = await store.createGhostCommit(`Secret ${secret}`, {
        agentId,
        prompt: `Never persist this prompt ${secret}`,
        summary: `Used token=${secret}`,
        toolCalls: Array.from({ length: 55 }, (_, index) => ({
          name: 'bash',
          inputPreview: `Authorization: Bearer ${secret} ${'x'.repeat(400)} ${index}`,
          resultPreview: `api_key=${secret}`,
        })),
        commands: [{ command: `OPENAI_API_KEY=${secret} bun test` }],
        transcript: {
          userMessagePreview: `password=${secret}`,
          assistantResponsePreview: 'y'.repeat(700),
          messageIds: Array.from({ length: 60 }, (_, index) => `message-${index}`),
          messageCount: 60,
        },
      });
      expect(hash).toBeTruthy();

      const metadata = await store.getMetadata(hash!);
      const persisted = JSON.stringify(metadata);
      expect(persisted).not.toContain(secret);
      expect(metadata?.prompt).toBeUndefined();
      expect(metadata?.promptHash).toHaveLength(64);
      expect(metadata?.toolCalls).toHaveLength(50);
      expect(metadata?.transcript?.messageIds).toHaveLength(50);
      expect(metadata?.evidenceCounts).toEqual({
        toolCalls: 55,
        commands: 1,
        fileEdits: 0,
        messages: 60,
      });
      const timeline = await store.getTimeline(10, agentId);
      expect(timeline[0].toolCallCount).toBe(55);
    });

    test('drops undeclared nested metadata and bounds persisted JSON', async () => {
      const store = new CheckpointStore(TEST_DIR);
      const metadata = {
        agentId: 'metadata-allowlist',
        summary: 'Allowlisted summary',
        privateRuntimeEnvelope: {
          rawPrompt: 'DATABASE_URL=postgres://admin:SuperSecretValue@example.invalid/db',
          nested: 'x'.repeat(20_000),
        },
      } as unknown as Omit<GhostCommitMetadata, 'id' | 'timestamp' | 'sequence'>;
      const hash = await store.createGhostCommit('Allowlist metadata', metadata);
      expect(hash).toBeTruthy();
      const persisted = JSON.stringify(await store.getMetadata(hash!));
      expect(persisted).not.toContain('privateRuntimeEnvelope');
      expect(persisted).not.toContain('SuperSecretValue');
      expect(Buffer.byteLength(persisted, 'utf-8')).toBeLessThan(64 * 1024);
    });
  });

  describe('GhostCommitTool', () => {
    test('creates a checkpoint on demand', async () => {
      const tool = new GhostCommitTool();
      const ctx = {
        sessionId: 'tool-test-session',
        workingDirectory: TEST_DIR,
        activeModel: 'test-model',
        activeProvider: 'test-provider',
      };
      const result = await tool.run(ctx, {
        id: 'call-1',
        name: 'ghost_commit',
        input: { label: 'Before refactor' },
      });
      expect(result.isError).toBe(false);
      expect(result.output).toContain('Checkpoint created');
      expect(result.output).toContain('Before refactor');

      // Verify the checkpoint exists in the shadow repo
      const shadowRefs = gitOutputShadow(
        TEST_DIR,
        'for-each-ref',
        '--format=%(refname)',
        'refs/kory/checkpoints/',
      );
      expect(shadowRefs).toBeTruthy();
    });

    test('fails without a label', async () => {
      const tool = new GhostCommitTool();
      const ctx = {
        sessionId: 'tool-test-session',
        workingDirectory: TEST_DIR,
      };
      const result = await tool.run(ctx, { id: 'call-2', name: 'ghost_commit', input: {} });
      expect(result.isError).toBe(true);
      expect(result.output).toContain('label is required');
    });
  });

  describe('shadow repo migration', () => {
    test('moves a worktree-local store and migrates its exact legacy session namespace', async () => {
      const repo = join(
        tmpdir(),
        `kory-storage-migration-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      );
      try {
        createCommittedRepo(repo);
        const legacyShadow = join(repo, '.koryphaios', 'shadow-git');
        mkdirSync(dirname(legacyShadow), { recursive: true });
        expect(
          spawnSync(['git', 'init', '--bare', legacyShadow], { stdout: 'pipe', stderr: 'pipe' })
            .exitCode,
        ).toBe(0);
        mkdirSync(join(legacyShadow, 'objects', 'info'), { recursive: true });
        writeFileSync(
          join(legacyShadow, 'objects', 'info', 'alternates'),
          '../../../.git/objects\n',
        );
        const head = gitOutput(repo, 'rev-parse', 'HEAD');
        const tree = gitOutput(repo, 'rev-parse', 'HEAD^{tree}');
        const legacyEnv = {
          ...process.env,
          GIT_DIR: legacyShadow,
          GIT_WORK_TREE: repo,
          GIT_AUTHOR_NAME: 'Legacy',
          GIT_AUTHOR_EMAIL: 'legacy@example.com',
          GIT_COMMITTER_NAME: 'Legacy',
          GIT_COMMITTER_EMAIL: 'legacy@example.com',
        };
        const commit = spawnSync(
          ['git', 'commit-tree', tree, '-p', head, '-m', '[GHOST] Legacy stored checkpoint'],
          { cwd: repo, env: legacyEnv, stdout: 'pipe', stderr: 'pipe' },
        );
        const hash = new TextDecoder().decode(commit.stdout).trim();
        expect(hash).toHaveLength(40);
        expect(
          spawnSync(['git', 'update-ref', 'refs/kory/checkpoints/legacy-agent/123-legacy', hash], {
            cwd: repo,
            env: legacyEnv,
            stdout: 'pipe',
            stderr: 'pipe',
          }).exitCode,
        ).toBe(0);
        expect(
          spawnSync(
            [
              'git',
              'notes',
              '--ref=refs/notes/checkpoint-store',
              'add',
              '-m',
              JSON.stringify({
                id: 'legacy-id',
                sequence: 0,
                timestamp: 123,
                agentId: 'legacy-agent',
              }),
              hash,
            ],
            { cwd: repo, env: legacyEnv, stdout: 'pipe', stderr: 'pipe' },
          ).exitCode,
        ).toBe(0);
        expect(
          spawnSync(['git', 'update-ref', 'refs/kory/cursors/legacy-agent', hash], {
            cwd: repo,
            env: legacyEnv,
            stdout: 'pipe',
            stderr: 'pipe',
          }).exitCode,
        ).toBe(0);

        const store = new CheckpointStore(repo);
        const timeline = await store.getTimeline(10, 'legacy-agent');
        expect(timeline.map((entry) => entry.hash)).toEqual([hash]);
        expect(await store.getCursor('legacy-agent')).toBe(hash);
        expect(ShadowRepo.shadowPath(repo)).toBe(join(repo, '.git', 'koryphaios', 'shadow-git'));
        expect(existsSync(legacyShadow)).toBe(false);
        const migratedAlternate = readFileSync(
          join(ShadowRepo.shadowObjectsPath(repo), 'info', 'alternates'),
          'utf-8',
        ).trim();
        expect(migratedAlternate).toBe(
          relative(ShadowRepo.shadowObjectsPath(repo), join(repo, '.git', 'objects')),
        );
        const noWarning = spawnSync(['git', 'fsck', '--no-progress'], {
          cwd: repo,
          stdout: 'pipe',
          stderr: 'pipe',
        });
        expect(new TextDecoder().decode(noWarning.stderr)).not.toContain('alternate object path');
        expect(
          gitOutputShadow(repo, 'for-each-ref', '--format=%(refname)', 'refs/kory/metadata'),
        ).toContain(hash);
      } finally {
        rmSync(repo, { recursive: true, force: true });
      }
    });

    test('migrates existing ghost refs from main repo to shadow repo', async () => {
      // Create a separate test dir for migration testing
      const migDir = join(
        tmpdir(),
        `kory-mig-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      );
      try {
        mkdirSync(migDir, { recursive: true });
        gitInit(migDir);
        writeFileSync(join(migDir, 'mig.txt'), 'content');
        spawnSync(['git', 'add', '-A'], { cwd: migDir, stdout: 'pipe', stderr: 'pipe' });
        spawnSync(['git', 'commit', '-m', 'init'], { cwd: migDir, stdout: 'pipe', stderr: 'pipe' });

        // Create a ghost commit directly in the MAIN repo (pre-migration state)
        const mainGit = new GitExecutor(migDir);
        const headResult = await mainGit.execCombined(['rev-parse', 'HEAD']);
        const head = headResult.output.trim();
        const treeResult = await mainGit.exec(['write-tree']);
        const tree = treeResult.stdout.trim();
        const commitResult = await mainGit.execCombined([
          'commit-tree',
          tree,
          '-p',
          head,
          '-m',
          '[GHOST] Legacy checkpoint',
        ]);
        const legacyHash = commitResult.output.trim();
        expect(legacyHash).toHaveLength(40);

        // Store the ref in the MAIN repo (pre-shadow state)
        await mainGit.execCombined([
          'update-ref',
          'refs/kory/checkpoints/legacy-session/123-ghost_123',
          legacyHash,
        ]);

        // Verify it's in the main repo before migration
        const mainRefsBefore = gitOutput(
          migDir,
          'for-each-ref',
          '--format=%(objectname)',
          'refs/kory/checkpoints/',
        );
        expect(mainRefsBefore).toContain(legacyHash);

        // Now create a CheckpointStore — this triggers ShadowRepo.ensure() which migrates
        const store = new CheckpointStore(migDir);
        // Wait for shadow repo to be ready
        writeFileSync(join(migDir, 'post-mig.txt'), 'content');
        await store.createGhostCommit('Post migration', { agentId: 'post-mig-session' });

        // The legacy ref should now be in the SHADOW repo
        const shadowRefs = gitOutputShadow(
          migDir,
          'for-each-ref',
          '--format=%(objectname)',
          'refs/kory/checkpoints/',
        );
        expect(shadowRefs).toContain(legacyHash);

        // The legacy ref should have been removed from the MAIN repo
        const mainRefsAfter = gitOutput(
          migDir,
          'for-each-ref',
          '--format=%(objectname)',
          'refs/kory/checkpoints/',
        );
        expect(mainRefsAfter).not.toContain(legacyHash);

        // Migration must copy the object graph into shadow storage, not merely
        // point at objects borrowed from the main repo through alternates.
        await mainGit.execCombined(['reflog', 'expire', '--expire=now', '--all']);
        await mainGit.exec(['gc', '--prune=now'], { timeoutMs: 60_000 });
        const durable = spawnSync(
          ['git', '--git-dir', ShadowRepo.shadowPath(migDir), 'cat-file', '-t', legacyHash],
          { stdout: 'pipe', stderr: 'pipe' },
        );
        expect(durable.exitCode).toBe(0);
        expect(new TextDecoder().decode(durable.stdout).trim()).toBe('commit');
      } finally {
        try {
          rmSync(migDir, { recursive: true, force: true });
        } catch {
          /* best-effort */
        }
      }
    });
  });

  describe('shadow repo GC', () => {
    test('materialized recovery branches survive checkpoint prune and shadow GC', async () => {
      const branchDir = join(
        tmpdir(),
        `kory-branch-durable-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      );
      try {
        createCommittedRepo(branchDir);
        const store = new CheckpointStore(branchDir);
        writeFileSync(join(branchDir, 'branch-state.txt'), 'saved state');
        const hash = await store.createGhostCommit('Branch state', { agentId: 'branch-session' });
        expect(hash).toBeTruthy();
        const branch = await store.createBranchFromCheckpoint(hash!, 'recovered-state');
        expect(branch.success, branch.message).toBe(true);
        expect(await store.prune(-1)).toMatchObject({ removed: 1 });
        expect(gitOutput(branchDir, 'cat-file', '-t', 'refs/heads/recovered-state')).toBe('commit');
        expect(gitOutput(branchDir, 'show', 'refs/heads/recovered-state:branch-state.txt')).toBe(
          'saved state',
        );
        const fsck = spawnSync(['git', 'fsck', '--full', '--strict'], {
          cwd: branchDir,
          stdout: 'pipe',
          stderr: 'pipe',
        });
        expect(fsck.exitCode, new TextDecoder().decode(fsck.stderr)).toBe(0);
      } finally {
        rmSync(branchDir, { recursive: true, force: true });
      }
    });

    test('prune triggers GC and removes unreachable objects', async () => {
      const gcDir = join(
        tmpdir(),
        `kory-gc-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      );
      try {
        mkdirSync(gcDir, { recursive: true });
        gitInit(gcDir);
        writeFileSync(join(gcDir, 'gc.txt'), 'content');
        spawnSync(['git', 'add', '-A'], { cwd: gcDir, stdout: 'pipe', stderr: 'pipe' });
        spawnSync(['git', 'commit', '-m', 'init'], { cwd: gcDir, stdout: 'pipe', stderr: 'pipe' });

        const store = new CheckpointStore(gcDir);
        const agentId = 'gc-session';

        // Create a checkpoint
        writeFileSync(join(gcDir, 'gc-1.txt'), '1');
        const hash = await store.createGhostCommit('GC test', { agentId });
        expect(hash).toBeTruthy();

        // Verify it exists
        const timelineBefore = await store.getTimeline(10, agentId);
        expect(timelineBefore.length).toBe(1);

        // Prune with -1 days — removes everything
        const result = await store.prune(-1);
        expect(result.removed).toBeGreaterThanOrEqual(1);

        // Timeline should now be empty (via manifest)
        const timelineAfter = await store.getTimeline(10, agentId);
        expect(timelineAfter.length).toBe(0);

        // The shadow repo should still be functional (GC didn't break it)
        writeFileSync(join(gcDir, 'gc-2.txt'), '2');
        const hash2 = await store.createGhostCommit('Post GC', { agentId });
        expect(hash2).toBeTruthy();
      } finally {
        try {
          rmSync(gcDir, { recursive: true, force: true });
        } catch {
          /* best-effort */
        }
      }
    });
  });
});
