import { afterEach, describe, expect, mock, spyOn, test } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'bun';
import { WorkspaceManager } from '../workspace-manager';
import { GitManager } from '../git-manager';
import { SnapshotManager } from '../snapshot-manager';
import { CheckpointStore } from '../checkpoint-store';
import { SessionStateService } from './SessionStateService';
import {
  WorkerPipelineService,
  isReadOnlyTaskKind,
  resolveGateStrictness,
  type WorkerPipelineHost,
} from './WorkerPipelineService';

const testDirectories: string[] = [];

function makeRepo(prefix: string): string {
  const root = join(
    tmpdir(),
    `${prefix}-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`,
  );
  mkdirSync(root, { recursive: true });
  testDirectories.push(root);
  const run = (...args: string[]) => {
    const result = spawnSync(['git', ...args], { cwd: root, stdout: 'pipe', stderr: 'pipe' });
    if (result.exitCode !== 0) throw new Error(new TextDecoder().decode(result.stderr));
    return new TextDecoder().decode(result.stdout).trim();
  };
  run('init');
  run('config', 'user.email', 'worker-pipeline@test.invalid');
  run('config', 'user.name', 'Worker Pipeline Test');
  // Windows defaults (core.autocrlf=true, 260-char path limit) break
  // cross-platform worktree tests: CRLF alters file content after git
  // operations and long worktree paths exceed the default limit.
  run('config', 'core.autocrlf', 'false');
  run('config', 'core.longpaths', 'true');
  writeFileSync(join(root, '.gitignore'), '.trees/\n.koryphaios/\nnode_modules\n');
  writeFileSync(join(root, 'seed.txt'), `${prefix}\n`);
  run('add', '.');
  run('commit', '-m', 'baseline');
  return root;
}

function makeDirectory(prefix: string): string {
  const root = join(
    tmpdir(),
    `${prefix}-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`,
  );
  mkdirSync(root, { recursive: true });
  testDirectories.push(root);
  return root;
}

function gitOutput(root: string, ...args: string[]): string {
  const result = spawnSync(['git', ...args], { cwd: root, stdout: 'pipe', stderr: 'pipe' });
  if (result.exitCode !== 0) throw new Error(new TextDecoder().decode(result.stderr));
  return new TextDecoder().decode(result.stdout).trim();
}

function createHost(
  configuredRoot: string,
  sessionRoot: string,
  workflowStates: string[],
): WorkerPipelineHost {
  // WorkerPipelineService.canonicalDirectory resolves paths through realpath.
  // On macOS, tmpdir() may be under a symlinked root (e.g. /var →
  // /private/var), so canonicalize sessionRoot for comparisons against
  // paths the service has already resolved. Use a safe fallback when the
  // path does not exist (the "missing project" test relies on this).
  // On Windows, realpathSync may not consistently resolve 8.3 short names
  // (e.g. RUNNER~1 vs runneradmin), so use realpathSync.native for
  // consistent canonicalization. On other platforms, use default
  // realpathSync to avoid macOS /var → /private/var resolution issues.
  const realpath =
    process.platform === 'win32' ? (realpathSync.native ?? realpathSync) : realpathSync;
  let canonicalSessionRoot = sessionRoot;
  try {
    canonicalSessionRoot = realpath(sessionRoot);
  } catch {
    // path does not exist — keep the raw value; the service will reject it
  }
  return {
    getIsYoloMode: () => true,
    getWorkingDirectory: () => configuredRoot,
    resolveSessionWorkingDirectoryPublic: async () => sessionRoot,
    getWorkerReasoningLevel: () => 'medium',
    getQualityPolicy: () => ({ gateStrictness: 'strict', maxCriticIterations: 1 }),
    getWorktreeMode: () => 'auto' as const,
    waitForUserInput: async () => 'Allow once',
    emitThought: () => undefined,
    updateWorkflowState: async (_sessionId, state) => {
      workflowStates.push(state);
    },
    resolveActiveRouting: () => ({ model: 'worker-test-model', provider: 'openai' }),
    executeWithProvider: async (
      _sessionId,
      _provider,
      _model,
      _message,
      _domain,
      _reasoning,
      _auto,
      allowedPaths,
    ) => {
      writeFileSync(join(allowedPaths[0], 'worker-output.txt'), 'created by session worker\n');
      return {
        success: true,
        workerMessages: [{ role: 'assistant', content: 'Implemented the requested file.' }],
        usage: { tokensIn: 12, tokensOut: 8 },
      };
    },
    runCriticGate: async () => ({ passed: true, feedback: 'PASS' }),
    runDestinationChecks: async (_sessionId, workingDirectory) => ({
      passed:
        workingDirectory === canonicalSessionRoot &&
        existsSync(join(sessionRoot, 'worker-output.txt')),
      output: 'destination checked',
    }),
  };
}

function createProviders() {
  const provider = { name: 'openai' };
  return {
    getAvailable: () => [provider],
    isQuotaError: () => false,
  } as any;
}

afterEach(() => {
  for (const directory of testDirectories.splice(0)) {
    if (existsSync(directory)) rmSync(directory, { recursive: true, force: true });
  }
});

describe('resolveGateStrictness', () => {
  test('cannot disable completion-blocking review for repository mutation tasks', () => {
    for (const kind of [
      'bug',
      'mechanical-edit',
      'refactor',
      'feature',
      'ui',
      'security-infra',
    ] as const) {
      expect(resolveGateStrictness(kind, 'off')).toBe('off');
      expect(resolveGateStrictness(kind, 'advisory')).toBe('strict');
    }
  });

  test('preserves user review policy for non-mutating answer and research tasks', () => {
    expect(resolveGateStrictness('question', 'off')).toBe('off');
    expect(resolveGateStrictness('research-docs', 'advisory')).toBe('advisory');
  });

  test('critic strict policy stays strict for read-only kinds until the first review fails', () => {
    expect(resolveGateStrictness('question', 'strict')).toBe('strict');
    expect(resolveGateStrictness('research-docs', 'strict')).toBe('strict');
  });

  test('critic strict policy falls back to advisory for read-only kinds after one failed review', () => {
    expect(resolveGateStrictness('question', 'strict', 1)).toBe('advisory');
    expect(resolveGateStrictness('research-docs', 'strict', 2)).toBe('advisory');
  });

  test('critic stays strict for mutating kinds no matter how many reviews failed', () => {
    for (const kind of [
      'bug',
      'mechanical-edit',
      'refactor',
      'feature',
      'ui',
      'security-infra',
    ] as const) {
      expect(resolveGateStrictness(kind, 'strict', 3)).toBe('strict');
    }
  });

  test('critic read-only kinds are the non-mutating answer and research tasks', () => {
    expect(isReadOnlyTaskKind('question')).toBe(true);
    expect(isReadOnlyTaskKind('research-docs')).toBe(true);
    expect(isReadOnlyTaskKind('feature')).toBe(false);
    expect(isReadOnlyTaskKind('bug')).toBe(false);
  });
});

describe('WorkerPipelineService project ownership and checkpoint acknowledgement', () => {
  test('fails closed before provider execution when the session project is unavailable', async () => {
    const repo = makeRepo('kory-worker-missing-project');
    const missingProject = join(repo, 'removed-project');
    const state = new SessionStateService();
    const workflowStates: string[] = [];
    const host = createHost(repo, missingProject, workflowStates);
    const execute = mock(host.executeWithProvider);
    host.executeWithProvider = execute;
    const service = new WorkerPipelineService({
      providers: createProviders(),
      state,
      git: new GitManager(repo),
      workspaceManager: null,
      snapshotManager: new SnapshotManager(repo),
      host,
    });

    const result = await service.runWorkerPipeline('session-missing', 'Implement in missing repo');

    expect(result).toContain('Worker was not started');
    expect(result).toContain('exact session project');
    expect(execute).not.toHaveBeenCalled();
    expect(workflowStates).toEqual(['executing', 'idle']);
    expect(gitOutput(repo, 'status', '--porcelain')).toBe('');
  });

  test('uses session project B for worktree, reconciliation, checks, and checkpoint', async () => {
    const repoA = makeRepo('kory-worker-repo-a');
    const repoB = makeRepo('kory-worker-repo-b');
    const repoAHead = gitOutput(repoA, 'rev-parse', 'HEAD');
    const state = new SessionStateService();
    state.recordToolCall('session-b', { name: 'bash', resultPreview: 'created worker-output' });
    state.recordCommand('session-b', { command: 'create worker-output', exitCode: 0 });
    const workflowStates: string[] = [];
    const host = createHost(repoA, repoB, workflowStates);
    const service = new WorkerPipelineService({
      providers: createProviders(),
      state,
      git: new GitManager(repoA),
      workspaceManager: null,
      snapshotManager: new SnapshotManager(repoA),
      host,
    });

    const result = await service.runWorkerPipeline(
      'session-b',
      'Implement the session-scoped worker file',
    );

    expect(result).toContain('PASS');
    expect(readFileSync(join(repoB, 'worker-output.txt'), 'utf8')).toContain('session worker');
    expect(existsSync(join(repoA, 'worker-output.txt'))).toBe(false);
    expect(gitOutput(repoA, 'rev-parse', 'HEAD')).toBe(repoAHead);
    expect(gitOutput(repoA, 'status', '--porcelain')).toBe('');
    expect(gitOutput(repoB, 'log', '-1', '--format=%s')).toContain(
      'Implement the session-scoped worker file',
    );

    const checkpointStore = new CheckpointStore(repoB);
    const timeline = await checkpointStore.getTimeline(10, 'session-b');
    expect(timeline).toHaveLength(1);
    expect((await checkpointStore.getMetadata(timeline[0]!.hash))?.agentId).toBe('session-b');
    expect(timeline[0]?.fileEditCount).toBe(1);
    expect(state.getToolCalls('session-b')).toEqual([]);
    expect(state.getCommands('session-b')).toEqual([]);
    expect(workflowStates.at(-1)).toBe('idle');
  });

  test('runs a non-isolated worker in the chat checkout without a worktree', async () => {
    const repo = makeRepo('kory-worker-direct');
    const state = new SessionStateService();
    const workflowStates: string[] = [];
    const host = createHost(repo, repo, workflowStates);
    host.getWorktreeMode = () => 'never' as const;
    const service = new WorkerPipelineService({
      providers: createProviders(),
      state,
      git: new GitManager(repo),
      workspaceManager: null,
      snapshotManager: new SnapshotManager(repo),
      host,
    });

    const result = await service.runWorkerPipeline('session-direct', 'Implement the direct file');

    expect(result).toContain('PASS');
    expect(readFileSync(join(repo, 'worker-output.txt'), 'utf8')).toContain('session worker');
    expect(gitOutput(repo, 'worktree', 'list', '--porcelain').match(/^worktree /gm) ?? []).toHaveLength(
      1,
    );
    expect(existsSync(join(repo, '.trees'))).toBe(false);
    expect(workflowStates.at(-1)).toBe('idle');
  });

  test('delivers worker output once and unverified when the Critic cannot run', async () => {
    const repo = makeRepo('kory-worker-critic-unavailable');
    const state = new SessionStateService();
    const workflowStates: string[] = [];
    const host = createHost(repo, repo, workflowStates);
    host.getWorktreeMode = () => 'never' as const;
    host.runCriticGate = async () => ({
      passed: false,
      skipped: true,
      criticUnavailable: true,
      feedback: 'Critic could not run after 3 attempt(s):\n- openai:critic-a: provider exploded',
    });
    const executions = mock(host.executeWithProvider);
    host.executeWithProvider = executions;
    const service = new WorkerPipelineService({
      providers: createProviders(),
      state,
      git: new GitManager(repo),
      workspaceManager: null,
      snapshotManager: new SnapshotManager(repo),
      host,
    });

    const result = await service.runWorkerPipeline(
      'session-unverified',
      'Implement the unverified file',
    );

    expect(result).toContain('UNVERIFIED: Critic could not run');
    expect(executions).toHaveBeenCalledTimes(1);
    expect(readFileSync(join(repo, 'worker-output.txt'), 'utf8')).toContain('session worker');
  });

  test("auto mode follows the per-task worktree argument and defaults to isolation", async () => {
    const repo = makeRepo('kory-worker-auto');
    const state = new SessionStateService();
    const workflowStates: string[] = [];
    const host = createHost(repo, repo, workflowStates);
    host.getWorktreeMode = () => 'auto' as const;
    const workspaceManager = new WorkspaceManager(repo);
    await workspaceManager.init();
    const service = new WorkerPipelineService({
      providers: createProviders(),
      state,
      git: new GitManager(repo),
      workspaceManager,
      snapshotManager: new SnapshotManager(repo),
      host,
    });

    // auto + explicit worktree: false → direct checkout, no worktree.
    const direct = await service.runWorkerPipeline(
      'session-auto-off',
      'Implement the direct file',
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      false,
    );
    expect(direct).toContain('PASS');
    expect(readFileSync(join(repo, 'worker-output.txt'), 'utf8')).toContain('session worker');
    expect(
      gitOutput(repo, 'worktree', 'list', '--porcelain').match(/^worktree /gm) ?? [],
    ).toHaveLength(1);

    // auto + omitted argument → the default, isolated worktree.
    const isolated = await service.runWorkerPipeline(
      'session-auto-on',
      'Implement the isolated file',
    );
    expect(isolated).toContain('PASS');
    expect(gitOutput(repo, 'log', '-1', '--format=%s')).toContain(
      'Implement the isolated file',
    );
  });

  test("always mode ignores the tool's worktree argument", async () => {
    const repo = makeRepo('kory-worker-always');
    const state = new SessionStateService();
    const workflowStates: string[] = [];
    const host = createHost(repo, repo, workflowStates);
    host.getWorktreeMode = () => 'always' as const;
    const workspaceManager = new WorkspaceManager(repo);
    await workspaceManager.init();
    const service = new WorkerPipelineService({
      providers: createProviders(),
      state,
      git: new GitManager(repo),
      workspaceManager,
      snapshotManager: new SnapshotManager(repo),
      host,
    });

    // 'always' overrides even an explicit worktree: false from the manager.
    const result = await service.runWorkerPipeline(
      'session-always',
      'Implement the forced-isolation file',
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      false,
    );
    expect(result).toContain('PASS');
    expect(gitOutput(repo, 'log', '-1', '--format=%s')).toContain(
      'Implement the forced-isolation file',
    );
  });

  test('refuses non-Git delegated writes before provider execution or false snapshots', async () => {
    const project = makeDirectory('kory-worker-non-git');
    writeFileSync(join(project, 'seed.txt'), 'uncommitted project\n');
    const state = new SessionStateService();
    const workflowStates: string[] = [];
    const host = createHost(project, project, workflowStates);
    const execute = mock(host.executeWithProvider);
    host.executeWithProvider = execute;
    const service = new WorkerPipelineService({
      providers: createProviders(),
      state,
      git: new GitManager(project),
      workspaceManager: null,
      snapshotManager: new SnapshotManager(project),
      host,
    });

    const result = await service.runWorkerPipeline(
      'session-non-git',
      'Delegate a write into this project',
    );

    expect(result).toContain('Worker was not started');
    expect(result).toContain('require a Git repository');
    expect(execute).not.toHaveBeenCalled();
    expect(existsSync(join(project, 'worker-output.txt'))).toBe(false);
    expect(existsSync(join(project, '.koryphaios', 'snapshots', 'session-non-git'))).toBe(false);
    expect(state.getCheckpoint('session-non-git')).toBeUndefined();
    expect(workflowStates).toEqual(['executing', 'idle']);
  });

  test('refuses delegated writes in an unborn Git repository', async () => {
    const project = makeDirectory('kory-worker-unborn-git');
    const init = spawnSync(['git', 'init'], { cwd: project, stdout: 'pipe', stderr: 'pipe' });
    expect(init.exitCode).toBe(0);
    const state = new SessionStateService();
    const workflowStates: string[] = [];
    const host = createHost(project, project, workflowStates);
    const execute = mock(host.executeWithProvider);
    host.executeWithProvider = execute;
    const service = new WorkerPipelineService({
      providers: createProviders(),
      state,
      git: new GitManager(project),
      workspaceManager: null,
      snapshotManager: new SnapshotManager(project),
      host,
    });

    const result = await service.runWorkerPipeline(
      'session-unborn',
      'Delegate a write before the first commit',
    );

    expect(result).toContain('Worker was not started');
    expect(result).toContain('existing Git commit');
    expect(execute).not.toHaveBeenCalled();
    expect(state.getCheckpoint('session-unborn')).toBeUndefined();
    expect(workflowStates).toEqual(['executing', 'idle']);
  });

  test('keeps completed work successful but unverified when checkpoint returns null', async () => {
    const repo = makeRepo('kory-worker-null-checkpoint');
    const state = new SessionStateService();
    state.recordToolCall('session-null', { name: 'write_file', resultPreview: 'complete' });
    state.recordCommand('session-null', { command: 'write worker-output', exitCode: 0 });
    const workflowStates: string[] = [];
    const host = createHost(repo, repo, workflowStates);
    const publish = mock(async () => null);
    const workspaceManager = new WorkspaceManager(repo);
    await workspaceManager.init();
    const service = new WorkerPipelineService({
      providers: createProviders(),
      state,
      git: new GitManager(repo),
      workspaceManager,
      snapshotManager: new SnapshotManager(repo),
      host,
      checkpointStoreFactory: () => ({ createGhostCommit: publish }),
    });

    const result = await service.runWorkerPipeline(
      'session-null',
      'Implement without a checkpoint',
    );

    expect(existsSync(join(repo, 'worker-output.txt'))).toBe(true);
    expect(result).toContain('PASS');
    expect(result).toContain('UNVERIFIED RECOVERY');
    expect(result).not.toContain('Worker failed');
    expect(publish).toHaveBeenCalledTimes(1);
    expect(state.getToolCalls('session-null')).toHaveLength(1);
    expect(state.getCommands('session-null')).toHaveLength(1);
    expect(workflowStates.at(-1)).toBe('idle');
  });
});

describe('WorkerPipelineService fails closed on isolation failure', () => {
  for (const failure of [
    'unavailable',
    'not initialized',
    'init rejected',
    'spawn null',
    'spawn throws',
  ] as const) {
    test(`${failure} prevents providers and completes failed task lifecycle`, async () => {
      const repo = makeRepo('kory-worker-isolation');
      const workflowStates: string[] = [];
      const host = createHost(repo, repo, workflowStates);
      const execute = mock(host.executeWithProvider);
      host.executeWithProvider = execute;
      const manager =
        failure === 'unavailable'
          ? null
          : new WorkspaceManager(
              repo,
              failure === 'init rejected' ? { worktreeDir: '..' } : undefined,
            );
      if (manager && failure === 'init rejected') await expect(manager.init()).rejects.toThrow();
      else if (manager && failure !== 'not initialized') await manager.init();
      const spawn =
        manager && (failure === 'spawn null' || failure === 'spawn throws')
          ? spyOn(manager, 'spawn').mockImplementation(async () => {
              if (failure === 'spawn throws') throw new Error('deterministic spawn failure');
              return null;
            })
          : undefined;
      const create = mock(async () => undefined);
      const update = mock(async () => undefined);
      const state = new SessionStateService();
      state.recordCommand('isolation-session', { command: 'retained evidence', exitCode: 0 });
      const service = new WorkerPipelineService({
        providers: createProviders(),
        state,
        git: new GitManager(repo),
        workspaceManager: manager,
        snapshotManager: new SnapshotManager(repo),
        host,
        tasks: { create, update } as any,
      });
      try {
        const result = await service.runWorkerPipeline('isolation-session', 'Implement safely');
        expect(result).toContain('Worker was not started');
        expect(result).toContain('worktree isolation failed');
        expect(execute).not.toHaveBeenCalled();
        expect(create).toHaveBeenCalledTimes(1);
        expect(update).toHaveBeenCalledWith(
          expect.any(String),
          expect.objectContaining({ status: 'failed' }),
        );
        expect(workflowStates).toEqual(['executing', 'idle']);
        expect(state.getCommands('isolation-session')).toHaveLength(1);
        expect(gitOutput(repo, 'status', '--porcelain')).toBe('');
      } finally {
        spawn?.mockRestore();
      }
    });
  }

  test('alternate project initialization failure never falls back to either project', async () => {
    const repoA = makeRepo('kory-init-a');
    const repoB = makeRepo('kory-init-b');
    writeFileSync(join(repoB, '.trees'), 'not a directory');
    const workflowStates: string[] = [];
    const host = createHost(repoA, repoB, workflowStates);
    const execute = mock(host.executeWithProvider);
    host.executeWithProvider = execute;
    const service = new WorkerPipelineService({
      providers: createProviders(),
      state: new SessionStateService(),
      git: new GitManager(repoA),
      workspaceManager: null,
      snapshotManager: new SnapshotManager(repoA),
      host,
    });
    expect(await service.runWorkerPipeline('init-fail', 'Implement safely')).toContain(
      'Worker was not started',
    );
    expect(execute).not.toHaveBeenCalled();
    expect(workflowStates).toEqual(['executing', 'idle']);
    // Failed initialization must not poison the per-project resource cache.
    rmSync(join(repoB, '.trees'));
    expect(await service.runWorkerPipeline('init-retry', 'Implement safely')).toContain('PASS');
    expect(execute).toHaveBeenCalledTimes(1);
    expect(existsSync(join(repoA, 'worker-output.txt'))).toBe(false);
  });

  test('partial spawn failure cleans up the registered worktree before returning', async () => {
    const repo = makeRepo('kory-partial-spawn');
    const manager = new WorkspaceManager(repo);
    await manager.init();
    const originalSpawn = manager.spawn.bind(manager);
    const spawn = spyOn(manager, 'spawn').mockImplementation(async (...args) => {
      await originalSpawn(...args);
      throw new Error('post-spawn failure');
    });
    const workflowStates: string[] = [];
    const host = createHost(repo, repo, workflowStates);
    const execute = mock(host.executeWithProvider);
    host.executeWithProvider = execute;
    const service = new WorkerPipelineService({
      providers: createProviders(),
      state: new SessionStateService(),
      git: new GitManager(repo),
      workspaceManager: manager,
      snapshotManager: new SnapshotManager(repo),
      host,
    });
    try {
      expect(await service.runWorkerPipeline('partial', 'Implement safely')).toContain(
        'Worker was not started',
      );
      expect(execute).not.toHaveBeenCalled();
      expect(manager.getStatus().active).toHaveLength(0);
      expect(await manager.listAllWorktrees()).toHaveLength(1);
      expect(workflowStates).toEqual(['executing', 'idle']);
    } finally {
      spawn.mockRestore();
    }
  });

  test('a manager bound to another project cannot execute a session worker', async () => {
    const repo = makeRepo('kory-session-project');
    const otherRepo = makeRepo('kory-wrong-manager');
    const manager = new WorkspaceManager(otherRepo);
    await manager.init();
    const host = createHost(repo, repo, []);
    const execute = mock(host.executeWithProvider);
    host.executeWithProvider = execute;
    const service = new WorkerPipelineService({
      providers: createProviders(),
      state: new SessionStateService(),
      git: new GitManager(repo),
      workspaceManager: manager,
      snapshotManager: new SnapshotManager(repo),
      host,
    });
    expect(await service.runWorkerPipeline('wrong-manager', 'Implement safely')).toContain(
      'Worker was not started',
    );
    expect(execute).not.toHaveBeenCalled();
    expect(manager.getStatus().active).toHaveLength(0);
    expect(gitOutput(repo, 'status', '--porcelain')).toBe('');
    expect(gitOutput(otherRepo, 'status', '--porcelain')).toBe('');
  });

  test('direct routing cannot grant the project root', async () => {
    const repo = makeRepo('kory-root-grant');
    const manager = new WorkspaceManager(repo);
    await manager.init();
    await manager.spawn('root-grant', 'task', 'session');
    const host = createHost(repo, repo, []);
    const execute = mock(host.executeWithProvider);
    host.executeWithProvider = execute;
    const service = new WorkerPipelineService({
      providers: createProviders(),
      state: new SessionStateService(),
      git: new GitManager(repo),
      workspaceManager: manager,
      snapshotManager: new SnapshotManager(repo),
      host,
    });
    const result = await service.routeToWorker(
      'session',
      'Implement safely',
      undefined,
      undefined,
      [repo],
      undefined,
      'root-grant',
    );
    expect(result.success).toBe(false);
    expect(execute).not.toHaveBeenCalled();
    await manager.cleanup('root-grant');
  });

  test('concurrent providers receive distinct worktrees and failures clean up both', async () => {
    const repo = makeRepo('kory-concurrent-workers');
    const manager = new WorkspaceManager(repo);
    await manager.init();
    const host = createHost(repo, repo, []);
    const directories: string[] = [];
    let release!: () => void;
    const bothStarted = new Promise<void>((resolve) => {
      release = resolve;
    });
    host.executeWithProvider = async (...args) => {
      const directory = args[7][0];
      directories.push(directory);
      writeFileSync(join(directory, 'private.txt'), args[0]);
      if (directories.length === 2) release();
      await bothStarted;
      expect(readFileSync(join(directory, 'private.txt'), 'utf8')).toBe(args[0]);
      return { success: false };
    };
    const service = new WorkerPipelineService({
      providers: createProviders(),
      state: new SessionStateService(),
      git: new GitManager(repo),
      workspaceManager: manager,
      snapshotManager: new SnapshotManager(repo),
      host,
    });
    await Promise.all(
      ['one', 'two'].map((id) => service.runWorkerPipeline(id, 'Implement safely')),
    );
    expect(new Set(directories).size).toBe(2);
    expect(directories).not.toContain(realpathSync(repo));
    expect(existsSync(join(repo, 'private.txt'))).toBe(false);
    expect(manager.getStatus().active).toHaveLength(0);
    expect(await manager.listAllWorktrees()).toHaveLength(1);
  });
});

describe('WorkerPipelineService workspace configuration', () => {
  test('a session project uses the configured workspace settings, not hard-coded defaults', async () => {
    // A chat bound to a project other than the backend's working directory
    // builds its own WorkspaceManager. That manager previously received no
    // config, so it silently used limit 4 / ".trees" regardless of the user's
    // workspace.worktreeLimit and workspace.worktreeDir.
    const configuredRoot = makeRepo('kory-ws-configured');
    const sessionRoot = makeRepo('kory-ws-session');
    const workflowStates: string[] = [];
    const host = createHost(configuredRoot, sessionRoot, workflowStates);

    const service = new WorkerPipelineService({
      providers: createProviders(),
      state: new SessionStateService(),
      git: new GitManager(configuredRoot),
      workspaceManager: null,
      snapshotManager: new SnapshotManager(configuredRoot),
      host,
      workspaceConfig: { worktreeLimit: 1, worktreeDir: '.agent-trees' },
    });

    const results = await Promise.all([
      service.runWorkerPipeline('session-limit', 'Implement safely'),
      service.runWorkerPipeline('session-limit-2', 'Implement safely'),
    ]);

    // With worktreeLimit: 1 the second task queues behind the first rather
    // than quietly receiving a second slot from the default of unlimited.
    expect(results.some((r) => r.includes('at capacity'))).toBe(false);
    // And the worktrees live in the configured directory, not the default.
    expect(existsSync(join(sessionRoot, '.agent-trees'))).toBe(true);
    expect(existsSync(join(sessionRoot, '.trees'))).toBe(false);

    await service.dispose();
  });

  test('dispose drains the per-session-project managers it created', async () => {
    const configuredRoot = makeRepo('kory-ws-dispose-configured');
    const sessionRoot = makeRepo('kory-ws-dispose-session');
    const workflowStates: string[] = [];
    const host = createHost(configuredRoot, sessionRoot, workflowStates);

    const service = new WorkerPipelineService({
      providers: createProviders(),
      state: new SessionStateService(),
      git: new GitManager(configuredRoot),
      workspaceManager: null,
      snapshotManager: new SnapshotManager(configuredRoot),
      host,
    });

    // A delegation that fails after spawn still leaves a worktree behind.
    await service.runWorkerPipeline('session-dispose', 'Implement safely');
    await service.dispose();

    // The alternate project's worktree directory is released, so no stale
    // worktrees survive the manager's lifetime.
    expect(
      gitOutput(sessionRoot, 'worktree', 'list', '--porcelain').match(/^worktree /gm),
    ).toHaveLength(1);
  });
});

describe('worker fallback chain', () => {
  test('fails over to the next route only after a quota failure', async () => {
    const repo = makeRepo('kory-worker-fallback');
    const state = new SessionStateService();
    const workflowStates: string[] = [];
    const host = createHost(repo, repo, workflowStates);
    host.getWorktreeMode = () => 'never' as const;
    host.getQualityPolicy = () => ({ gateStrictness: 'off', maxCriticIterations: 1 });
    host.resolveActiveRouting = (preferredModel) => ({
      model: preferredModel ?? 'primary-model',
      provider: 'openai',
    });
    const calls: Array<{ model: string; reasoningLevel?: string }> = [];
    host.executeWithProvider = async (
      _sessionId,
      _provider,
      model,
      _message,
      _domain,
      reasoningLevel,
      _auto,
      allowedPaths,
    ) => {
      calls.push({ model, ...(reasoningLevel ? { reasoningLevel } : {}) });
      if (calls.length === 1) return { success: false, error: '429 rate limited' };
      writeFileSync(join(allowedPaths[0], 'worker-output.txt'), 'created by fallback\n');
      return {
        success: true,
        workerMessages: [{ role: 'assistant', content: 'Implemented the requested file.' }],
        usage: { tokensIn: 12, tokensOut: 8 },
      };
    };
    const providers = createProviders();
    providers.isQuotaError = () => true;
    const service = new WorkerPipelineService({
      providers,
      state,
      git: new GitManager(repo),
      workspaceManager: null,
      snapshotManager: new SnapshotManager(repo),
      host,
    });

    const result = await service.runWorkerPipelineDetailed(
      'session-fallback',
      'Implement the change',
      'primary-model',
      'low',
      'backend',
      undefined,
      undefined,
      false,
      [{ model: 'fallback-model', reasoningLevel: 'high' }],
    );

    expect(result.success).toBe(true);
    expect(calls).toEqual([
      { model: 'primary-model', reasoningLevel: 'low' },
      { model: 'fallback-model', reasoningLevel: 'high' },
    ]);
    expect(readFileSync(join(repo, 'worker-output.txt'), 'utf8')).toContain('fallback');
  });
});
