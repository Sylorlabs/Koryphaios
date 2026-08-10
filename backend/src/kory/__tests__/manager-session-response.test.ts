import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { KoryphaiosConfig, Session } from '@koryphaios/shared';
import type { ProviderRegistry, ToolRegistry } from '../../providers';
import type { ISessionStore } from '../../stores/session-store';
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
    git(cloneParent, 'clone', repoA, repoB);

    writeFileSync(join(repoA, 'repo-a-later.txt'), 'must survive session B rejection\n');
    git(repoA, 'add', '.');
    git(repoA, 'commit', '-m', 'repo A later state');
    const repoAHead = git(repoA, 'rev-parse', 'HEAD');

    writeFileSync(join(repoB, 'shared.txt'), 'session B uncommitted edit\n');
    writeFileSync(join(repoB, 'session-b-new.txt'), 'remove on rejection\n');

    const manager = createManager(repoA, sessionStore([session('session-b', repoB)]));
    try {
      const state = managerState(manager);
      state.saveCheckpoint('session-b', sessionCheckpoint);
      state.recordChange('session-b', {
        path: join(repoB, 'shared.txt'),
        operation: 'edit',
        linesAdded: 1,
        linesDeleted: 1,
      });

      await manager.handleSessionResponse('session-b', false);

      expect(git(repoB, 'rev-parse', 'HEAD')).toBe(sessionCheckpoint);
      expect(git(repoB, 'status', '--porcelain')).toBe('');
      expect(readFileSync(join(repoB, 'shared.txt'), 'utf8')).toBe('baseline\n');
      expect(existsSync(join(repoB, 'session-b-new.txt'))).toBe(false);

      expect(git(repoA, 'rev-parse', 'HEAD')).toBe(repoAHead);
      expect(readFileSync(join(repoA, 'repo-a-later.txt'), 'utf8')).toContain('must survive');
      expect(git(repoA, 'status', '--porcelain')).toBe('');
      expect(state.getCheckpoint('session-b')).toBeUndefined();
      expect(state.getChanges('session-b')).toEqual([]);
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
});
