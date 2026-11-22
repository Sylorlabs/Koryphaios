import { afterEach, describe, expect, mock, test } from 'bun:test';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'bun';
import { ProviderRegistry } from '../../providers/registry';
import {
  shouldAutoContinueAfterCap,
  shouldContinueAfterOutputLimit,
  shouldRequestFinalAnswer,
} from '../manager';
import { WorkspaceManager } from '../workspace-manager';
import { GitManager } from '../git-manager';
import { SnapshotManager } from '../snapshot-manager';
import { SessionStateService } from '../services/SessionStateService';
import { WorkerPipelineService } from '../services/WorkerPipelineService';

// isRetriableProviderError is a real method on ProviderRegistry; exercise it
// through a lightweight instance without connecting any provider.
function registry(): ProviderRegistry {
  return Object.create(ProviderRegistry.prototype) as ProviderRegistry;
}

describe('continue-loop fixes', () => {
  test('isRetriableProviderError reroutes 502/503/500/timeouts, not 4xx auth', () => {
    const r = registry();
    expect(r.isRetriableProviderError(new Error('upstream 502 Bad Gateway'))).toBe(true);
    expect(r.isRetriableProviderError(new Error('503 Service Unavailable'))).toBe(true);
    expect(r.isRetriableProviderError(new Error('500 Internal Server Error'))).toBe(true);
    expect(r.isRetriableProviderError(new Error('request ETIMEDOUT'))).toBe(true);
    expect(r.isRetriableProviderError(new Error('fetch failed'))).toBe(true);
    expect(r.isRetriableProviderError(new Error('upstream 502'))).toBe(true);
    expect(r.isRetriableProviderError({ status: 503, message: 'Service Unavailable' })).toBe(true);
    expect(r.isRetriableProviderError({ statusCode: 502, message: 'Bad Gateway' })).toBe(true);

    // Fail-closed for auth errors.
    expect(r.isRetriableProviderError(new Error('401 Unauthorized'))).toBe(false);
    expect(r.isRetriableProviderError(new Error('403 Forbidden'))).toBe(false);
    expect(r.isRetriableProviderError(new Error('invalid api key'))).toBe(false);
    expect(r.isRetriableProviderError({ status: 401, message: 'Unauthorized' })).toBe(false);
    expect(r.isRetriableProviderError({ status: 403, message: 'Forbidden' })).toBe(false);
    expect(r.isRetriableProviderError(new Error('all good'))).toBe(false);
  });

  test('isQuotaError still detects quota/429', () => {
    const r = registry();
    expect(r.isQuotaError(new Error('429 rate limit exceeded'))).toBe(true);
    expect(r.isQuotaError(new Error('quota exhausted'))).toBe(true);
    expect(r.isQuotaError(new Error('upstream 502'))).toBe(false);
  });

  test('tool-only run is handed back to the model, never marked complete', () => {
    const base = {
      noFinalContent: true,
      toolActivity: true,
      attempts: 0,
      maxAttempts: 2,
      stoppedByUser: false,
      turnFailure: false,
    };
    expect(shouldRequestFinalAnswer(base)).toBe(true);
    // Bounded: a persistently-silent provider cannot loop forever.
    expect(shouldRequestFinalAnswer({ ...base, attempts: 1 })).toBe(true);
    expect(shouldRequestFinalAnswer({ ...base, attempts: 2 })).toBe(false);
    expect(shouldRequestFinalAnswer({ ...base, attempts: 5 })).toBe(false);
    // Kory's own control-plane tools count as tool activity, not just a native
    // harness's internal tools.
    expect(shouldRequestFinalAnswer({ ...base, toolActivity: true })).toBe(true);
    // Never continue a stop, a failed turn, a run with an answer, or a run that
    // never used a tool.
    expect(shouldRequestFinalAnswer({ ...base, stoppedByUser: true })).toBe(false);
    expect(shouldRequestFinalAnswer({ ...base, turnFailure: true })).toBe(false);
    expect(shouldRequestFinalAnswer({ ...base, noFinalContent: false })).toBe(false);
    expect(shouldRequestFinalAnswer({ ...base, toolActivity: false })).toBe(false);
  });

  test('25-turn followup guard allows max one auto-followup', () => {
    const open = {
      turnCount: 25,
      stoppedByUser: false,
      hasOpenTasks: true,
      lastToolCallCount: 0,
      alreadyIssued: false,
    };
    expect(shouldAutoContinueAfterCap(open)).toBe(true);
    // Tool activity alone also indicates incomplete work.
    expect(
      shouldAutoContinueAfterCap({
        ...open,
        hasOpenTasks: false,
        lastToolCallCount: 2,
      }),
    ).toBe(true);
    // Guard rails: no repeat, no continuation when stopped, capped, or complete.
    expect(shouldAutoContinueAfterCap({ ...open, alreadyIssued: true })).toBe(false);
    expect(shouldAutoContinueAfterCap({ ...open, stoppedByUser: true })).toBe(false);
    expect(shouldAutoContinueAfterCap({ ...open, turnCount: 24 })).toBe(false);
    expect(
      shouldAutoContinueAfterCap({
        ...open,
        hasOpenTasks: false,
        lastToolCallCount: 0,
      }),
    ).toBe(false);
  });

  test('only output-limit stops are auto-resumable', () => {
    const base = {
      finishReason: 'max_tokens' as const,
      attempts: 0,
      maxAttempts: 3,
      stoppedByUser: false,
      turnFailure: false,
    };
    expect(shouldContinueAfterOutputLimit(base)).toBe(true);
    expect(shouldContinueAfterOutputLimit({ ...base, finishReason: 'stop' })).toBe(false);
    expect(shouldContinueAfterOutputLimit({ ...base, finishReason: 'end_turn' })).toBe(false);
    expect(shouldContinueAfterOutputLimit({ ...base, finishReason: 'tool_use' })).toBe(false);
    expect(shouldContinueAfterOutputLimit({ ...base, turnFailure: true })).toBe(false);
    expect(shouldContinueAfterOutputLimit({ ...base, stoppedByUser: true })).toBe(false);
    expect(shouldContinueAfterOutputLimit({ ...base, attempts: 3 })).toBe(false);
  });
});

const testDirs: string[] = [];

function makeRepo(prefix: string): string {
  const root = join(
    tmpdir(),
    `${prefix}-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`,
  );
  mkdirSync(root, { recursive: true });
  testDirs.push(root);
  const run = (...args: string[]) => {
    const result = spawnSync(['git', ...args], { cwd: root, stdout: 'pipe', stderr: 'pipe' });
    if (result.exitCode !== 0) throw new Error(new TextDecoder().decode(result.stderr));
  };
  run('init');
  run('config', 'user.email', 'continue-loop@test.invalid');
  run('config', 'user.name', 'Continue Loop Test');
  run('config', 'core.autocrlf', 'false');
  run('config', 'core.longpaths', 'true');
  writeFileSync(join(root, '.gitignore'), '.trees/\n.koryphaios/\nnode_modules\n');
  writeFileSync(join(root, 'seed.txt'), `${prefix}\n`);
  run('add', '.');
  run('commit', '-m', 'baseline');
  return root;
}

afterEach(() => {
  for (const dir of testDirs.splice(0)) {
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  }
});

async function makeWorkerHarness(
  repo: string,
  executeImpl: (...args: any[]) => Promise<any>,
  maxCriticIterations = 2,
) {
  const state = new SessionStateService();
  const workflowStates: string[] = [];
  const executeWithProvider = mock(executeImpl);
  const host: any = {
    getIsYoloMode: () => true,
    getWorkingDirectory: () => repo,
    resolveSessionWorkingDirectoryPublic: async () => repo,
    getWorkerReasoningLevel: () => 'medium',
    getQualityPolicy: () => ({ gateStrictness: 'off', maxCriticIterations }),
    getWorktreeMode: () => 'auto' as const,
    waitForUserInput: async () => 'Allow once',
    emitThought: () => undefined,
    updateWorkflowState: async (_s: string, st: string) => {
      workflowStates.push(st);
    },
    resolveActiveRouting: () => ({ model: 'worker-test-model', provider: 'openai' }),
    executeWithProvider,
    runCriticGate: async () => ({ passed: true, feedback: 'PASS' }),
    runDestinationChecks: async () => ({ passed: true, output: 'ok' }),
  };
  const providers: any = {
    getAvailable: () => [{ name: 'openai' }],
    isQuotaError: (e: unknown) => registry().isQuotaError(e),
    isRetriableProviderError: (e: unknown) => registry().isRetriableProviderError(e),
  };
  const workspaceManager = new WorkspaceManager(repo);
  await workspaceManager.init();
  const worktree = await workspaceManager.spawn('retry-task', 'Retry fixture', 'retry-session');
  if (!worktree) throw new Error('Retry fixture needs an isolated worktree');
  const service = new WorkerPipelineService({
    providers,
    state,
    git: new GitManager(repo),
    workspaceManager,
    snapshotManager: new SnapshotManager(repo),
    host,
  });
  return { service, executeWithProvider, workspaceManager, worktree };
}

describe('WorkerPipeline 502 reroute (not fail-closed)', () => {
  test('transient 502 retries and then succeeds', async () => {
    const repo = makeRepo('kory-continue-502');
    let calls = 0;
    const { service, executeWithProvider, workspaceManager, worktree } = await makeWorkerHarness(
      repo,
      async () => {
        calls++;
        if (calls === 1) return { success: false, error: 'upstream 502 Bad Gateway' };
        return {
          success: true,
          workerMessages: [{ role: 'assistant', content: 'recovered' }],
          usage: { tokensIn: 1, tokensOut: 1 },
        };
      },
    );
    // 'Implement' classifies as a mutating feature task so the pipeline allows
    // a retry attempt; read-only question tasks are single-attempt by design.
    const result = await (service as any).routeToWorker(
      'retry-session',
      'Implement the session-scoped worker file',
      undefined,
      undefined,
      [worktree.path],
      undefined,
      'retry-task',
    );
    await workspaceManager.cleanup('retry-task');
    expect(result.success).toBe(true);
    expect(executeWithProvider).toHaveBeenCalledTimes(2);
  });

  test('401 auth error stays fail-closed without retry', async () => {
    const repo = makeRepo('kory-continue-401');
    const { service, executeWithProvider, workspaceManager, worktree } = await makeWorkerHarness(
      repo,
      async () => ({
        success: false,
        error: '401 Unauthorized: invalid api key',
      }),
    );
    const result = await (service as any).routeToWorker(
      'retry-session',
      'Implement the session-scoped worker file',
      undefined,
      undefined,
      [worktree.path],
      undefined,
      'retry-task',
    );
    await workspaceManager.cleanup('retry-task');
    expect(result.success).toBe(false);
    expect(executeWithProvider).toHaveBeenCalledTimes(1);
  });
});
