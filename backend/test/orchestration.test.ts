import { describe, expect, test, mock, beforeEach } from 'bun:test';
import { KoryManager } from '../src/kory/manager';
import { ProviderRegistry } from '../src/providers';
import { ToolRegistry, BashTool, ReadFileTool, WriteFileTool, GrepTool, GlobTool, LsTool } from '../src/tools';
import { AskUserTool, AskManagerTool, DelegateToWorkerTool } from '../src/tools/interaction';
import type { Session, AgentIdentity, WSMessage } from '@koryphaios/shared';
import { DOMAIN } from '../src/constants';

// Mock dependencies
const mockProviderRegistry = {
  resolveProvider: mock(),
  getAvailable: mock(() => []),
  isQuotaError: mock(() => false),
  get: mock(),
} as unknown as ProviderRegistry;

const mockToolRegistry = {
  getToolDefs: mock(() => []),
  execute: mock(),
} as unknown as ToolRegistry;

const mockConfig = {
  agents: {
    manager: { model: 'mock-model' },
  },
  assignments: {},
  fallbacks: {},
};

// Mock WebSocket broker
mock.module('../src/pubsub', () => ({
  wsBroker: {
    publish: mock(),
  },
}));

describe('KoryManager Orchestration', () => {
  let manager: KoryManager;

  beforeEach(() => {
    manager = new KoryManager(
      mockProviderRegistry,
      mockToolRegistry,
      '/tmp',
      mockConfig as any,
      {} as any,
      { getRecent: () => [], add: () => {} } as any,
    );
  });

  test('should resolve correct routing for domain', () => {
    // Default: domain "general" uses DEFAULT_MODELS.general
    const generalRouting = manager['resolveActiveRouting'](undefined, 'general');
    expect(generalRouting.model).toBe(DOMAIN.DEFAULT_MODELS.general);

    // Override via config
    manager['config'].assignments = { general: 'openai:gpt-4o' };
    const overridden = manager['resolveActiveRouting'](undefined, 'general');
    expect(overridden.model).toBe('gpt-4o');
    expect(overridden.provider).toBe('openai');
  });

  test('manager role includes delegate_to_worker as sole way to spawn workers', () => {
    const registry = new ToolRegistry();
    registry.register(new AskUserTool());
    registry.register(new AskManagerTool());
    registry.register(new DelegateToWorkerTool());
    const managerDefs = registry.getToolDefsForRole('manager');
    const names = managerDefs.map((d) => d.name);
    expect(names).toContain('delegate_to_worker');
    expect(names).toContain('ask_user');
    expect(managerDefs.some((d) => d.name === 'delegate_to_worker')).toBe(true);
  });

  test('critic role is limited to read-only filesystem tools', () => {
    const registry = new ToolRegistry();
    registry.register(new BashTool());
    registry.register(new ReadFileTool());
    registry.register(new WriteFileTool());
    registry.register(new GrepTool());
    registry.register(new GlobTool());
    registry.register(new LsTool());
    registry.register(new DelegateToWorkerTool());

    const criticNames = registry.getToolDefsForRole('critic').map((d) => d.name).sort();

    expect(criticNames).toEqual(['glob', 'grep', 'ls', 'read_file']);
  });

  test('worker tool context uses the granted worktree directory as cwd', async () => {
    const observed: { workingDirectory?: string; allowedPaths?: string[] } = {};

    manager['processProviderTurn'] = mock(async (...args: any[]) => {
      const ctx = args[5];
      observed.workingDirectory = ctx.workingDirectory;
      observed.allowedPaths = ctx.allowedPaths;
      return false;
    });

    const result = await manager['executeWithProvider'](
      'session-1',
      { name: 'openai' } as any,
      'mock-model',
      'Implement task',
      'general',
      undefined,
      true,
      ['/tmp/worktree-1'],
      true,
    );

    expect(result.success).toBe(true);
    expect(observed.workingDirectory).toBe('/tmp/worktree-1');
    expect(observed.allowedPaths).toEqual(['/tmp/worktree-1']);
  });

  test('runWorkerPipeline fails when worktree reconcile fails', async () => {
    const autoCommit = mock(async () => {});

    manager.setYoloMode(true);
    manager['routeToWorker'] = mock(async () => ({
      success: true,
      workerTranscript: 'worker transcript',
      criticFeedback: 'PASS',
    }));
    manager['handleAutoCommit'] = autoCommit;
    manager['workspaceManager'] = {
      spawn: () => ({ path: '/tmp/worktree-2' }),
      reconcile: () => ({ success: false, message: 'merge conflict' }),
      cleanup: mock(() => ({ success: true, message: 'cleaned' })),
    } as any;

    const result = await manager.runWorkerPipeline('session-2', 'Implement task');

    expect(result).toContain('Worktree reconcile failed: merge conflict');
    expect(autoCommit).not.toHaveBeenCalled();
  });
});
