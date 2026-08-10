import { afterEach, describe, expect, mock, test } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'bun';
import { GitManager } from '../git-manager';
import { SnapshotManager } from '../snapshot-manager';
import { CheckpointStore } from '../checkpoint-store';
import { SessionStateService } from './SessionStateService';
import {
  WorkerPipelineService,
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
  let canonicalSessionRoot = sessionRoot;
  try {
    canonicalSessionRoot = realpathSync(sessionRoot);
  } catch {
    // path does not exist — keep the raw value; the service will reject it
  }
  return {
    getIsYoloMode: () => true,
    getWorkingDirectory: () => configuredRoot,
    resolveSessionWorkingDirectoryPublic: async () => sessionRoot,
    getWorkerReasoningLevel: () => 'medium',
    getQualityPolicy: () => ({ gateStrictness: 'strict', maxCriticIterations: 1 }),
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
      expect(resolveGateStrictness(kind, 'off')).toBe('strict');
      expect(resolveGateStrictness(kind, 'advisory')).toBe('strict');
    }
  });

  test('preserves user review policy for non-mutating answer and research tasks', () => {
    expect(resolveGateStrictness('question', 'off')).toBe('off');
    expect(resolveGateStrictness('research-docs', 'advisory')).toBe('advisory');
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
    const service = new WorkerPipelineService({
      providers: createProviders(),
      state,
      git: new GitManager(repo),
      workspaceManager: null,
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
