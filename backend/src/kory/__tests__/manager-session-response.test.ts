import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { KoryphaiosConfig, Session } from '@koryphaios/shared';
import type { ProviderRegistry, ToolRegistry } from '../../providers';
import type { ISessionStore } from '../../stores/session-store';
import { SessionStore } from '../../stores/session-store';
import {
  beginSessionReviewRejection,
  ensurePendingSessionReview,
  getSessionReview,
} from '../../stores/session-review-store';
import { SessionStateService } from '../services/SessionStateService';
import { KoryManager } from '../manager';
import { processSupervisor } from '../../process-supervisor/supervisor';

const testDirectories: string[] = [];

beforeAll(async () => {
  await processSupervisor.initialize();
});

afterAll(() => {
  processSupervisor.shutdown();
});

function makeDirectory(prefix: string): string {
  const directory = mkdtempSync(join(tmpdir(), `${prefix}-`));
  testDirectories.push(directory);
  return directory;
}

function git(cwd: string, ...args: string[]): string {
  const result = Bun.spawnSync(['git', ...args], { cwd, stdout: 'pipe', stderr: 'pipe' });
  if (result.exitCode !== 0) {
    throw new Error(result.stderr.toString());
  }
  return result.stdout.toString().trim();
}

function session(id: string, workingDirectory?: string): Session {
  return {
    id,
    title: id,
    workingDirectory,
    messageCount: 0,
    totalTokensIn: 0,
    totalTokensOut: 0,
    totalCost: 0,
    createdAt: 1,
    updatedAt: 1,
  };
}

function sessionStore(entries: Session[]): ISessionStore {
  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  return {
    get: async (id) => byId.get(id),
  } as unknown as ISessionStore;
}

function createManager(managerRoot: string, sessions: ISessionStore): KoryManager {
  return new KoryManager(
    {} as ProviderRegistry,
    {} as ToolRegistry,
    managerRoot,
    {} as KoryphaiosConfig,
    sessions,
  );
}

function managerState(manager: KoryManager): SessionStateService {
  return (manager as unknown as { state: SessionStateService }).state;
}

async function waitForReviewStatus(
  sessionId: string,
  status: 'terminalized',
): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt++) {
    if ((await getSessionReview(sessionId))?.status === status) return;
    await Bun.sleep(10);
  }
  throw new Error(`Timed out waiting for session review ${sessionId} to become ${status}`);
}

afterEach(async () => {
  for (const directory of testDirectories.splice(0)) {
    if (!existsSync(directory)) continue;
    // On Windows, file handles (e.g. SQLite, git index locks) may still be
    // held briefly after the test completes. Retry with backoff to avoid
    // EBUSY during cleanup.
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        rmSync(directory, { recursive: true, force: true });
        break;
      } catch (err) {
        if (attempt === 4) {
          // Last attempt failed — surface the error so CI doesn't silently
          // leak temp directories, but don't mask the original test failure.
          console.error(`Failed to clean up ${directory}:`, err);
        } else {
          // Brief backoff so the OS can release lingering file handles.
          await new Promise((resolve) => setTimeout(resolve, 50 * (attempt + 1)));
        }
      }
    }
  }
});

describe('KoryManager session-scoped keep/reject decisions', () => {
  test('stale accept and reject responses cannot mutate an archived session', async () => {
    const projectRoot = makeDirectory('kory-response-archived');
    const archived = { ...session('archived-session', projectRoot), archivedAt: 1_000 };
    const manager = createManager(projectRoot, sessionStore([archived]));
    try {
      const state = managerState(manager);
      state.saveCheckpoint('archived-session', 'retain-checkpoint');
      state.recordChange('archived-session', {
        path: join(projectRoot, 'retained.txt'),
        operation: 'edit',
        linesAdded: 1,
        linesDeleted: 0,
      });

      for (const accepted of [true, false]) {
        await expect(manager.handleSessionResponse('archived-session', accepted)).rejects.toThrow(
          'Recover this archived chat before accepting or rejecting its changes.',
        );
      }

      expect(state.getCheckpoint('archived-session')).toBe('retain-checkpoint');
      expect(state.getChanges('archived-session')).toHaveLength(1);
      const managerLease = manager.tryAcquireSessionMutationBarrier('archived-session');
      expect(managerLease).not.toBeNull();
      managerLease?.release();
      const processLease = processSupervisor.tryAcquireAgentToolBarrier('archived-session');
      expect(processLease).not.toBeNull();
      processLease?.release();
    } finally {
      manager.shutdown();
    }
  });

  test('rejecting session B restores only repo B and never manager-global repo A', async () => {
    const repoA = makeDirectory('kory-response-repo-a');
    git(repoA, 'init');
    git(repoA, 'config', 'user.email', 'session-response@test.invalid');
    git(repoA, 'config', 'user.name', 'Session Response Test');
    // Windows defaults (core.autocrlf=true, 260-char path limit) break
    // cross-platform tests: CRLF alters file content after git operations,
    // and long shadow ref paths exceed MAX_PATH. Disable both explicitly.
    git(repoA, 'config', 'core.autocrlf', 'false');
    git(repoA, 'config', 'core.longpaths', 'true');
    writeFileSync(join(repoA, '.gitignore'), '.koryphaios/\n.trees/\n');
    writeFileSync(join(repoA, 'shared.txt'), 'baseline\n');
    git(repoA, 'add', '.');
    git(repoA, 'commit', '-m', 'shared baseline');
    const sessionCheckpoint = git(repoA, 'rev-parse', 'HEAD');

    const cloneParent = makeDirectory('kory-response-clone-parent');
    const repoB = join(cloneParent, 'repo-b');
    // Use -c core.autocrlf=false to override the global config during clone,
    // preventing CRLF conversion on Windows that would alter file content.
    git(cloneParent, '-c', 'core.autocrlf=false', 'clone', repoA, repoB);
    git(repoB, 'config', 'core.autocrlf', 'false');
    git(repoB, 'config', 'core.longpaths', 'true');

    writeFileSync(join(repoA, 'repo-a-later.txt'), 'must survive session B rejection\n');
    git(repoA, 'add', '.');
    git(repoA, 'commit', '-m', 'repo A later state');
    const repoAHead = git(repoA, 'rev-parse', 'HEAD');

    writeFileSync(join(repoB, 'shared.txt'), 'session B uncommitted edit\n');
    writeFileSync(join(repoB, 'session-b-new.txt'), 'remove on rejection\n');

    // The review projection is foreign-keyed to the authoritative sessions
    // table. Keep the lightweight session-store double for this manager test,
    // but seed the matching durable session row just as production does.
    const durableSession = await new SessionStore().create(
      'local-user',
      'session B durable review',
      undefined,
      repoB,
    );
    const sessionId = durableSession.id;
    const manager = createManager(repoA, sessionStore([session(sessionId, repoB)]));
    try {
      const state = managerState(manager);
      state.saveCheckpoint(sessionId, sessionCheckpoint);
      state.recordChange(sessionId, {
        path: join(repoB, 'shared.txt'),
        operation: 'edit',
        linesAdded: 1,
        linesDeleted: 1,
      });

      await manager.handleSessionResponse(sessionId, false);

      expect(git(repoB, 'rev-parse', 'HEAD')).toBe(sessionCheckpoint);
      expect(git(repoB, 'status', '--porcelain')).toBe('');
      expect(readFileSync(join(repoB, 'shared.txt'), 'utf8')).toBe('baseline\n');
      expect(existsSync(join(repoB, 'session-b-new.txt'))).toBe(false);

      expect(git(repoA, 'rev-parse', 'HEAD')).toBe(repoAHead);
      expect(readFileSync(join(repoA, 'repo-a-later.txt'), 'utf8')).toContain('must survive');
      expect(git(repoA, 'status', '--porcelain')).toBe('');
      expect(state.getCheckpoint(sessionId)).toBeUndefined();
      expect(state.getChanges(sessionId)).toEqual([]);
    } finally {
      manager.shutdown();
    }
  });

  test('fails closed and retains review state when a session has no exact project', async () => {
    const repoA = makeDirectory('kory-response-fail-closed');
    const manager = createManager(repoA, sessionStore([session('legacy-session')]));
    try {
      const state = managerState(manager);
      state.saveCheckpoint('legacy-session', 'not-applied-anywhere');
      state.recordChange('legacy-session', {
        path: join(repoA, 'unresolved.txt'),
        operation: 'edit',
        linesAdded: 1,
        linesDeleted: 0,
      });

      await expect(manager.handleSessionResponse('legacy-session', false)).rejects.toThrow(
        'no project folder',
      );

      expect(state.getCheckpoint('legacy-session')).toBe('not-applied-anywhere');
      expect(state.getChanges('legacy-session')).toHaveLength(1);
    } finally {
      manager.shutdown();
    }
  });

  test('a fresh manager rejects from the durable session-bound Git checkpoint', async () => {
    const repo = makeDirectory('kory-response-restart-durable');
    git(repo, 'init');
    git(repo, 'config', 'user.email', 'session-response@test.invalid');
    git(repo, 'config', 'user.name', 'Session Response Test');
    git(repo, 'config', 'core.autocrlf', 'false');
    writeFileSync(join(repo, 'tracked.txt'), 'baseline\n');
    git(repo, 'add', '.');
    git(repo, 'commit', '-m', 'baseline');
    const baseline = git(repo, 'rev-parse', 'HEAD');
    writeFileSync(join(repo, 'tracked.txt'), 'pending review edit\n');
    writeFileSync(join(repo, 'new.txt'), 'must be removed\n');

    const durable = await new SessionStore().create(
      'local-user',
      'restart durable review',
      undefined,
      repo,
    );
    await ensurePendingSessionReview({
      sessionId: durable.id,
      projectRoot: repo,
      rollback: { kind: 'git', baselineHash: baseline },
      changes: [
        {
          path: join(repo, 'tracked.txt'),
          operation: 'edit',
          linesAdded: 1,
          linesDeleted: 1,
        },
      ],
    });

    // This instance deliberately has an empty SessionStateService. It proves
    // restart recovery consumes the persisted review rather than an in-memory
    // checkpoint or a mutable "latest" snapshot.
    const restarted = createManager(repo, sessionStore([session(durable.id, repo)]));
    try {
      expect(managerState(restarted).getCheckpoint(durable.id)).toBeUndefined();
      await restarted.handleSessionResponse(durable.id, false);
      expect(git(repo, 'rev-parse', 'HEAD')).toBe(baseline);
      expect(git(repo, 'status', '--porcelain')).toBe('');
      expect(readFileSync(join(repo, 'tracked.txt'), 'utf8')).toBe('baseline\n');
      expect(existsSync(join(repo, 'new.txt'))).toBe(false);
      expect(await getSessionReview(durable.id)).toMatchObject({ status: 'rejected' });
    } finally {
      restarted.shutdown();
    }
  });

  test('a restarted manager terminalizes an interrupted rejection without retrying Git', async () => {
    const repo = makeDirectory('kory-response-restart-terminal');
    git(repo, 'init');
    git(repo, 'config', 'user.email', 'session-response@test.invalid');
    git(repo, 'config', 'user.name', 'Session Response Test');
    git(repo, 'config', 'core.autocrlf', 'false');
    writeFileSync(join(repo, 'tracked.txt'), 'baseline\n');
    git(repo, 'add', '.');
    git(repo, 'commit', '-m', 'baseline');
    const baseline = git(repo, 'rev-parse', 'HEAD');
    writeFileSync(join(repo, 'tracked.txt'), 'must not be reset by recovery\n');

    const durable = await new SessionStore().create(
      'local-user',
      'restart terminalized review',
      undefined,
      repo,
    );
    const pending = await ensurePendingSessionReview({
      sessionId: durable.id,
      projectRoot: repo,
      rollback: { kind: 'git', baselineHash: baseline },
      changes: [
        {
          path: join(repo, 'tracked.txt'),
          operation: 'edit',
          linesAdded: 1,
          linesDeleted: 1,
        },
      ],
    });
    expect((await beginSessionReviewRejection(pending))?.status).toBe('rejecting');

    const restarted = createManager(repo, sessionStore([session(durable.id, repo)]));
    try {
      await waitForReviewStatus(durable.id, 'terminalized');
      expect(git(repo, 'rev-parse', 'HEAD')).toBe(baseline);
      expect(readFileSync(join(repo, 'tracked.txt'), 'utf8')).toBe(
        'must not be reset by recovery\n',
      );
    } finally {
      restarted.shutdown();
    }
  });
});
