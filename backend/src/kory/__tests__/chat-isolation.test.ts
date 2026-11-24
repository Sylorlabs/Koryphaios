// Real-Git coverage of isolate_chat / merge_chat_back on KoryManager.
// The manager methods run against temporary repositories; the chat copies
// themselves land under the default chat-repository root (that is where
// sessionWorkspaceOwnership recognizes them) and are removed in afterEach.
import { afterEach, describe, expect, test } from 'bun:test';
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  realpathSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { Session } from '@koryphaios/shared';
import { KoryManager } from '../manager';
import { SessionRuntimeRegistry } from '../services/SessionRuntime';
import { executeTool } from '../../tools/execution-pipeline';
import type { Tool, ToolContext } from '../../tools/registry';

const roots: string[] = [];
const copies: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  for (const copy of copies.splice(0)) {
    rmSync(dirname(copy), { recursive: true, force: true });
  }
});

function git(cwd: string, ...args: string[]): string {
  const result = Bun.spawnSync(['git', ...args], { cwd, stdout: 'pipe', stderr: 'pipe' });
  if (result.exitCode !== 0) throw new Error(result.stderr.toString());
  return result.stdout.toString().trim();
}

function gitOk(cwd: string, ...args: string[]): boolean {
  return Bun.spawnSync(['git', ...args], { cwd, stdout: 'pipe', stderr: 'pipe' }).exitCode === 0;
}

function setup() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'kory-chat-auto-')));
  roots.push(root);
  const source = join(root, 'source');
  mkdirSync(source);
  git(source, 'init', '-b', 'main');
  git(source, 'config', 'user.name', 'Test');
  git(source, 'config', 'user.email', 'test@example.invalid');
  git(source, 'config', 'commit.gpgsign', 'false');
  writeFileSync(join(source, 'file.txt'), 'baseline\n');
  git(source, 'add', '.');
  git(source, 'commit', '-m', 'baseline');
  return { root, source };
}

type Row = Session & { gitWorkspace?: Session['gitWorkspace'] };

function manager(
  rows: Map<string, Row>,
  opts: { mode?: 'auto' | 'always' | 'never'; hasWorkers?: () => boolean } = {},
) {
  const instance = Object.create(KoryManager.prototype);
  const events: { sessionId: string; type: string; payload: unknown }[] = [];
  // Test hooks simulating concurrent session writes during slow Git work.
  const harness = {
    onGet: undefined as (() => void) | undefined,
    onUpdate: undefined as (() => boolean) | undefined,
  };
  Object.assign(instance, {
    runtimes: new SessionRuntimeRegistry(),
    sessions: {
      get: async (id: string) => {
        harness.onGet?.();
        return rows.get(id);
      },
      update: async (id: string, updates: object, version?: number) => {
        if (harness.onUpdate?.()) return undefined;
        const current = rows.get(id);
        if (!current || current.version !== version) return undefined;
        const next = { ...current, ...updates, version: (version ?? 0) + 1 };
        rows.set(id, next);
        return next;
      },
    },
    workers: { hasSessionWorkers: () => opts.hasWorkers?.() === true },
    getWorktreeMode: () => opts.mode ?? 'auto',
    emitWSMessage: (sessionId: string, type: string, payload: unknown) =>
      events.push({ sessionId, type, payload }),
  });
  return { kory: instance as KoryManager, events, harness };
}

function row(id: string, workingDirectory: string, over: Partial<Row> = {}): Row {
  return {
    id,
    title: `Chat ${id}`,
    workingDirectory,
    messageCount: 0,
    totalTokensIn: 0,
    totalTokensOut: 0,
    totalCost: 0,
    version: 1,
    createdAt: 1_000,
    updatedAt: 5_000,
    ...over,
  };
}

async function isolatedChat(mode?: 'auto' | 'always') {
  const { source } = setup();
  const rows = new Map<string, Row>([['c1', row('c1', source)]]);
  const { kory, events, harness } = manager(rows, { mode });
  const head = git(source, 'rev-parse', 'HEAD');
  const result = await kory.isolateSessionWorkspace('c1', 'sibling collision');
  copies.push(result.path);
  return { source, rows, kory, events, harness, head, result };
}

describe('isolateSessionWorkspace', () => {
  test('creates a copy from HEAD and leaves dirty source files behind', async () => {
    const { source } = setup();
    writeFileSync(join(source, 'dirty.txt'), 'uncommitted\n');
    writeFileSync(join(source, 'file.txt'), 'modified in place\n');
    const rows = new Map<string, Row>([['c1', row('c1', source)]]);
    const { kory } = manager(rows);

    const result = await kory.isolateSessionWorkspace('c1', 'colliding edits');
    copies.push(result.path);

    expect(result.path).not.toBe(source);
    expect(existsSync(join(result.path, 'file.txt'))).toBe(true);
    expect(readFileSync(join(result.path, 'file.txt'), 'utf8')).toBe('baseline\n');
    expect(existsSync(join(result.path, 'dirty.txt'))).toBe(false);
    // The source is untouched: both the modification and the new file stay.
    expect(readFileSync(join(source, 'file.txt'), 'utf8')).toBe('modified in place\n');
    expect(existsSync(join(source, 'dirty.txt'))).toBe(true);

    const ws = rows.get('c1')!.gitWorkspace;
    expect(ws?.isolation).toBe('independent-repository');
    expect(ws?.autoIsolated?.sourceDirectory).toBe(source);
    expect(ws?.autoIsolated?.sourceBranch).toBe('main');
    expect(ws?.autoIsolated?.sourceHead).toBe(git(source, 'rev-parse', 'HEAD'));
    expect(ws?.autoIsolated?.reason).toBe('colliding edits');
  });

  test('rebinds the chat: next resolution returns the copy and the turn is rebind-pending', async () => {
    const { result, kory } = await isolatedChat();
    expect(await kory.resolveSessionWorkingDirectoryPublic('c1')).toBe(realpathSync(result.path));
    expect(kory.isWorkspaceRebindPending('c1')).toBe(true);
  });

  test('emits session.updated for the rebind', async () => {
    const { events } = await isolatedChat();
    const updated = events.filter((e) => e.type === 'session.updated');
    expect(updated.length).toBe(1);
    expect(
      (updated[0].payload as { session: Row }).session.gitWorkspace?.autoIsolated,
    ).toBeDefined();
  });

  test('refuses when the chat is already isolated', async () => {
    const { kory } = await isolatedChat();
    await expect(kory.isolateSessionWorkspace('c1', 'again')).rejects.toThrow('already runs');
  });

  test('refuses when worktree mode is never', async () => {
    const { source } = setup();
    const rows = new Map<string, Row>([['c1', row('c1', source)]]);
    const { kory } = manager(rows, { mode: 'never' });
    await expect(kory.isolateSessionWorkspace('c1', 'why')).rejects.toThrow('Worktree is Off');
  });

  test('refuses a chat without a project folder', async () => {
    const rows = new Map<string, Row>([['c1', row('c1', '', { workingDirectory: undefined })]]);
    const { kory } = manager(rows);
    await expect(kory.isolateSessionWorkspace('c1', 'why')).rejects.toThrow('no project folder');
  });

  test('refuses a folder outside Git', async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'kory-chat-nogit-')));
    roots.push(root);
    const folder = join(root, 'plain');
    mkdirSync(folder);
    const rows = new Map<string, Row>([['c1', row('c1', folder)]]);
    const { kory } = manager(rows);
    await expect(kory.isolateSessionWorkspace('c1', 'why')).rejects.toThrow(
      'not inside a Git repository',
    );
  });

  test('refuses a detached HEAD', async () => {
    const { source } = setup();
    git(source, 'checkout', '--detach', 'HEAD');
    const rows = new Map<string, Row>([['c1', row('c1', source)]]);
    const { kory } = manager(rows);
    await expect(kory.isolateSessionWorkspace('c1', 'why')).rejects.toThrow('detached HEAD');
  });

  test('refuses after an in-place workspace mutation this turn', async () => {
    const { source } = setup();
    const rows = new Map<string, Row>([['c1', row('c1', source)]]);
    const { kory } = manager(rows);
    kory.markWorkspaceMutatedThisTurn('c1');
    await expect(kory.isolateSessionWorkspace('c1', 'why')).rejects.toThrow(
      'already edited files in place',
    );
    expect(rows.get('c1')!.gitWorkspace).toBeUndefined();
  });

  test('refuses while a worker of this chat is running', async () => {
    const { source } = setup();
    const rows = new Map<string, Row>([['c1', row('c1', source)]]);
    const { kory } = manager(rows, { hasWorkers: () => true });
    await expect(kory.isolateSessionWorkspace('c1', 'why')).rejects.toThrow('still running');
  });

  test('still isolates when a session write bumps the version mid-operation', async () => {
    const { source } = setup();
    const rows = new Map<string, Row>([['c1', row('c1', source)]]);
    const { kory, harness } = manager(rows);
    let gets = 0;
    harness.onGet = () => {
      gets++;
      // The second get is the rebind re-read after the clone — bump as if a
      // concurrent writer (title generation) landed during the slow Git work.
      if (gets !== 2) return;
      const r = rows.get('c1')!;
      rows.set('c1', { ...r, title: 'Renamed mid-isolate', version: (r.version ?? 0) + 1 });
    };
    const result = await kory.isolateSessionWorkspace('c1', 'r');
    copies.push(result.path);
    expect(rows.get('c1')!.gitWorkspace?.autoIsolated).toBeDefined();
    // The concurrent write is preserved, not clobbered by the rebind.
    expect(rows.get('c1')!.title).toBe('Renamed mid-isolate');
  });

  test('retries the rebind once when the update loses a version race', async () => {
    const { source } = setup();
    const rows = new Map<string, Row>([['c1', row('c1', source)]]);
    const { kory, harness } = manager(rows);
    let updates = 0;
    harness.onUpdate = () => ++updates === 1;
    const result = await kory.isolateSessionWorkspace('c1', 'r');
    copies.push(result.path);
    expect(rows.get('c1')!.gitWorkspace?.autoIsolated).toBeDefined();
    expect(updates).toBe(2);
  });

  test('conflicts cleanly when the chat gains a workspace mid-isolation', async () => {
    const { source } = setup();
    const rows = new Map<string, Row>([['c1', row('c1', source)]]);
    const { kory, harness } = manager(rows);
    let gets = 0;
    harness.onGet = () => {
      gets++;
      if (gets !== 2) return;
      const r = rows.get('c1')!;
      rows.set('c1', {
        ...r,
        version: (r.version ?? 0) + 1,
        gitWorkspace: {
          path: '/tmp/other-checkout',
          branch: 'b',
          baseCommit: 'x',
          repositoryPath: '/tmp/other-repo',
          isolation: 'independent-repository',
        },
      });
    };
    await expect(kory.isolateSessionWorkspace('c1', 'r')).rejects.toThrow('gained a workspace');
  });
});

describe('mergeSessionWorkspaceBack', () => {
  test('merges committed copy work back onto the source branch', async () => {
    const { source, rows, kory, result, head } = await isolatedChat();
    writeFileSync(join(result.path, 'new.txt'), 'copy work\n');
    git(result.path, 'config', 'user.name', 'Copy');
    git(result.path, 'config', 'user.email', 'copy@example.invalid');
    git(result.path, 'add', '.');
    git(result.path, 'commit', '-m', 'copy work');

    const merged = await kory.mergeSessionWorkspaceBack('c1');
    expect(merged.noop).toBe(false);
    expect(merged.filesChanged).toBe(1);
    expect(merged.autoCommitted).toBe(false);
    expect(merged.mergedCommit).toBe(git(source, 'rev-parse', 'HEAD'));
    expect(readFileSync(join(source, 'new.txt'), 'utf8')).toBe('copy work\n');
    expect(git(source, 'log', '-1', '--pretty=%s')).toBe('Merge Kory chat "Chat c1" (c1)');
    expect(rows.get('c1')!.gitWorkspace ?? null).toBeNull();
    expect(await kory.resolveSessionWorkingDirectoryPublic('c1')).toBe(source);
    expect(kory.isWorkspaceRebindPending('c1')).toBe(true);
    expect(head).not.toBe(git(source, 'rev-parse', 'HEAD'));
  });

  test('commits dirty copy work first, then merges', async () => {
    const { source, kory, result } = await isolatedChat();
    writeFileSync(join(result.path, 'dirty.txt'), 'uncommitted copy work\n');
    const merged = await kory.mergeSessionWorkspaceBack('c1');
    expect(merged.autoCommitted).toBe(true);
    expect(merged.noop).toBe(false);
    expect(readFileSync(join(source, 'dirty.txt'), 'utf8')).toBe('uncommitted copy work\n');
    // The auto-commit used the Kory message and a host identity.
    expect(git(result.path, 'log', '-1', '--pretty=%s')).toBe('Kory: work from chat "Chat c1"');
  });

  test('no-ops back into the folder when the copy has no new commits', async () => {
    const { source, rows, kory } = await isolatedChat();
    const merged = await kory.mergeSessionWorkspaceBack('c1');
    expect(merged.noop).toBe(true);
    expect(merged.mergedCommit).toBeUndefined();
    expect(rows.get('c1')!.gitWorkspace ?? null).toBeNull();
    expect(await kory.resolveSessionWorkingDirectoryPublic('c1')).toBe(source);
  });

  test('aborts on conflict, reports files and stays isolated', async () => {
    const { source, rows, kory, result, head } = await isolatedChat();
    writeFileSync(join(result.path, 'file.txt'), 'copy version\n');
    git(result.path, 'config', 'user.name', 'Copy');
    git(result.path, 'config', 'user.email', 'copy@example.invalid');
    git(result.path, 'add', '.');
    git(result.path, 'commit', '-m', 'copy change');
    writeFileSync(join(source, 'file.txt'), 'source version\n');
    git(source, 'add', '.');
    git(source, 'commit', '-m', 'source change');

    const headBefore = git(source, 'rev-parse', 'HEAD');
    await expect(kory.mergeSessionWorkspaceBack('c1')).rejects.toThrow('file.txt');
    expect(git(source, 'rev-parse', 'HEAD')).toBe(headBefore);
    expect(git(source, 'log', '-1', '--pretty=%s')).toBe('source change');
    expect(git(source, 'status', '--porcelain')).toBe('');
    expect(rows.get('c1')!.gitWorkspace?.autoIsolated).toBeDefined();
    // The temporary merge-back ref is gone and the copy is preserved.
    expect(gitOk(source, 'rev-parse', '--verify', 'refs/kory/merge-back/c1')).toBe(false);
    expect(existsSync(result.path)).toBe(true);
    void head;
  });

  test('refuses when the folder moved to another branch', async () => {
    const { source, rows, kory, result } = await isolatedChat();
    writeFileSync(join(result.path, 'new.txt'), 'copy work\n');
    git(result.path, 'config', 'user.name', 'Copy');
    git(result.path, 'config', 'user.email', 'copy@example.invalid');
    git(result.path, 'add', '.');
    git(result.path, 'commit', '-m', 'copy work');
    git(source, 'checkout', '-b', 'other');

    await expect(kory.mergeSessionWorkspaceBack('c1')).rejects.toThrow(
      'The folder is now on other, not main',
    );
    expect(rows.get('c1')!.gitWorkspace?.autoIsolated).toBeDefined();
    expect(git(source, 'status', '--porcelain')).toBe('');
    expect(gitOk(source, 'rev-parse', '--verify', 'refs/kory/merge-back/c1')).toBe(false);
  });

  test('refuses a chat that was not auto-isolated', async () => {
    const { source } = setup();
    const rows = new Map<string, Row>([
      [
        'c1',
        row('c1', source, {
          gitWorkspace: {
            path: '/tmp/picked-checkout',
            branch: 'main',
            baseCommit: 'abc',
            repositoryPath: '/tmp/picked-repo',
            isolation: 'independent-repository',
          },
        }),
      ],
    ]);
    const { kory } = manager(rows);
    await expect(kory.mergeSessionWorkspaceBack('c1')).rejects.toThrow('isolate_chat');
  });

  test('refuses while a worker of this chat is running', async () => {
    const { source } = setup();
    const rows = new Map<string, Row>([['c1', row('c1', source)]]);
    let workerRunning = false;
    const { kory } = manager(rows, { hasWorkers: () => workerRunning });
    const result = await kory.isolateSessionWorkspace('c1', 'r');
    copies.push(result.path);
    workerRunning = true;
    await expect(kory.mergeSessionWorkspaceBack('c1')).rejects.toThrow('still running');
  });

  test('still lands the merge when a session write bumps the version mid-merge', async () => {
    const { source, rows, kory, result, harness } = await isolatedChat();
    writeFileSync(join(result.path, 'new.txt'), 'copy work\n');
    git(result.path, 'config', 'user.name', 'Copy');
    git(result.path, 'config', 'user.email', 'copy@example.invalid');
    git(result.path, 'add', '.');
    git(result.path, 'commit', '-m', 'copy work');
    let gets = 0;
    harness.onGet = () => {
      gets++;
      if (gets !== 2) return;
      const r = rows.get('c1')!;
      rows.set('c1', { ...r, title: 'Renamed mid-merge', version: (r.version ?? 0) + 1 });
    };
    const merged = await kory.mergeSessionWorkspaceBack('c1');
    expect(merged.noop).toBe(false);
    expect(rows.get('c1')!.gitWorkspace ?? null).toBeNull();
    expect(rows.get('c1')!.title).toBe('Renamed mid-merge');
    expect(readFileSync(join(source, 'new.txt'), 'utf8')).toBe('copy work\n');
  });

  test('reports the landed merge when the binding changed mid-merge', async () => {
    const { source, rows, kory, result, harness } = await isolatedChat();
    writeFileSync(join(result.path, 'new.txt'), 'copy work\n');
    git(result.path, 'config', 'user.name', 'Copy');
    git(result.path, 'config', 'user.email', 'copy@example.invalid');
    git(result.path, 'add', '.');
    git(result.path, 'commit', '-m', 'copy work');
    let gets = 0;
    harness.onGet = () => {
      gets++;
      if (gets !== 2) return;
      const r = rows.get('c1')!;
      rows.set('c1', {
        ...r,
        version: (r.version ?? 0) + 1,
        gitWorkspace: { ...r.gitWorkspace!, path: '/tmp/rebound-elsewhere' },
      });
    };
    const error = await kory.mergeSessionWorkspaceBack('c1').then(
      () => new Error('expected a ConflictError'),
      (err: unknown) => (err instanceof Error ? err : new Error(String(err))),
    );
    const landedHead = git(source, 'rev-parse', 'HEAD');
    // The merge already landed; the error names the merge commit so the
    // agent/user knows the folder received the work.
    expect(error.message).toContain('already landed in the folder');
    expect(error.message).toContain(landedHead);
    expect(readFileSync(join(source, 'new.txt'), 'utf8')).toBe('copy work\n');
    expect(gitOk(source, 'rev-parse', '--verify', 'refs/kory/merge-back/c1')).toBe(false);
    // The foreign binding is left alone — nothing was clobbered back to null.
    expect(rows.get('c1')!.gitWorkspace?.path).toBe('/tmp/rebound-elsewhere');
  });
});

describe('rebind turn safety', () => {
  function stubTool(name: string, run: () => Promise<string>): Tool {
    return {
      name,
      role: 'any',
      description: 'stub',
      inputSchema: {},
      run: async (_ctx, call) => ({
        callId: call.id,
        name,
        output: await run(),
        isError: false,
        durationMs: 0,
      }),
    };
  }

  const ctx = (over: Partial<ToolContext> = {}): ToolContext =>
    ({
      sessionId: 'c1',
      workingDirectory: '/tmp',
      ...over,
    }) as ToolContext;

  test('denies mutating tools while the workspace binding is rebind-pending', async () => {
    let ran = false;
    const out = await executeTool(
      stubTool('bash', async () => {
        ran = true;
        return 'ran';
      }),
      ctx({ workspaceRebindPending: true }),
      { id: 'call-1', name: 'bash', input: {} },
    );
    expect(ran).toBe(false);
    expect(out.isError).toBe(true);
    expect(out.output).toContain('workspace changed during this turn');
  });

  test('non-mutating tools still run while rebind-pending', async () => {
    const out = await executeTool(
      stubTool('web_search', async () => 'results'),
      ctx({ workspaceRebindPending: true }),
      { id: 'call-2', name: 'web_search', input: {} },
    );
    expect(out.isError).toBe(false);
    expect(out.output).toBe('results');
  });

  test('a successful mutation marks the turn so a later isolate_chat refuses', async () => {
    let marked = false;
    const out = await executeTool(
      stubTool('bash', async () => 'ran'),
      ctx({ noteWorkspaceMutation: () => (marked = true) }),
      { id: 'call-3', name: 'bash', input: {} },
    );
    expect(out.isError).toBe(false);
    expect(marked).toBe(true);
  });
});
