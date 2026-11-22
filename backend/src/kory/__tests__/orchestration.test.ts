import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from 'bun:test';
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { KoryManager } from '../manager';
import {
  resetSessionAgentOverridesCache,
  setSessionAgentOverrides,
} from '../../stores/session-agent-overrides';
import { ProviderRegistry } from '../../providers';
import { registerLiveModelResolver } from '../../providers/models';
import {
  ToolRegistry,
  BashTool,
  ReadFileTool,
  WriteFileTool,
  GrepTool,
  GlobTool,
  LsTool,
} from '../../tools';
import { isCatastrophicBashCommand } from '../../tools/bash';
import { AskUserTool, AskManagerTool, DelegateToWorkerTool } from '../../tools/interaction';
import type { Session, AgentIdentity, WSMessage } from '@koryphaios/shared';
import { DOMAIN } from '../../constants';
import {
  compilePrompt,
  createTaskContract,
  loadRepositoryInstructions,
  requiresMultiAgentDelegation,
} from '../prompts';
import {
  buildEvalRunPlan,
  CORE_WORKFLOW_EVALS,
  LONGITUDINAL_EVALS,
  qualifies,
  rolloutDecision,
} from '../workflow-evals';
import { parseCriticReport, parseCriticVerdict } from '../critic-util';
import {
  DEFAULT_AGENT_SETTINGS,
  mergeAgentSettings,
  resolveAgentSettingsLayers,
} from '../../agent-settings';

const originalSkillsHome = process.env.KORYPHAIOS_SKILLS_HOME;
const testSkillsHome = mkdtempSync(join(tmpdir(), 'kory-orchestration-skills-'));

// Use a real (non-symlink) temp directory for the manager working directory.
// On macOS, `/tmp` is a symlink to `/private/tmp`, and the SnapshotManager
// constructor rejects symlinked project directories via lstatSync. Creating a
// dedicated temp dir and resolving it through realpathSync avoids this.
const testWorkDir = realpathSync(mkdtempSync(join(tmpdir(), 'kory-orchestration-wd-')));

beforeAll(() => {
  process.env.KORYPHAIOS_SKILLS_HOME = testSkillsHome;
});

afterAll(() => {
  registerLiveModelResolver(() => undefined);
  if (originalSkillsHome === undefined) {
    delete process.env.KORYPHAIOS_SKILLS_HOME;
  } else {
    process.env.KORYPHAIOS_SKILLS_HOME = originalSkillsHome;
  }
  rmSync(testSkillsHome, { recursive: true, force: true });
  rmSync(testWorkDir, { recursive: true, force: true });
});

// Mock dependencies
const mockProviderRegistry = {
  resolveProvider: mock(),
  getAvailable: mock(() => []),
  getStatus: mock(() => []),
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
mock.module('../../pubsub', () => ({
  wsBroker: {
    publish: mock(),
  },
}));

describe('KoryManager Orchestration', () => {
  let manager: KoryManager;
  let sessionRows: Map<string, any>;

  beforeEach(() => {
    resetSessionAgentOverridesCache();
    (mockProviderRegistry.resolveProvider as any).mockReset();
    // Chat execution resolves (and persists) that chat's own isolated
    // checkout, so the session stub has to round-trip the stored workspace.
    const rows = new Map<string, any>();
    sessionRows = rows;
    const sessions = {
      get: async (id: string) => {
        const existing = rows.get(id);
        if (existing) return existing;
        const created = {
          id,
          title: id,
          workingDirectory: testWorkDir,
          messageCount: 0,
          totalTokensIn: 0,
          totalTokensOut: 0,
          totalCost: 0,
          createdAt: 1,
          updatedAt: 1,
          version: 1,
        };
        rows.set(id, created);
        return created;
      },
      update: async (id: string, updates: object, version: number) => {
        const current = rows.get(id);
        if (!current || current.version !== version) return undefined;
        const next = { ...current, ...updates, version: version + 1 };
        rows.set(id, next);
        return next;
      },
    };
    manager = new KoryManager(
      mockProviderRegistry,
      mockToolRegistry,
      testWorkDir,
      mockConfig as any,
      sessions as any,
      { getRecent: () => [], add: () => {}, getContextMessages: () => [] } as any,
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

  test('multi-agent enforcement excludes only questions and tiny mechanical edits', () => {
    expect(requiresMultiAgentDelegation('What does this function do?')).toBe(false);
    expect(requiresMultiAgentDelegation('Rename this variable mechanically')).toBe(false);
    expect(requiresMultiAgentDelegation('Fix the broken settings persistence')).toBe(true);
    expect(requiresMultiAgentDelegation('Build a settings dashboard')).toBe(true);
    expect(requiresMultiAgentDelegation('Research and compare provider behavior')).toBe(true);
  });

  test('compiled prompts selectively suggest goals and reusable workflows', () => {
    const compiled = compilePrompt({
      role: 'manager',
      provider: 'openai',
      workingDirectory: testWorkDir,
      taskContract: createTaskContract('Explain the architecture'),
    });
    expect(compiled.systemPrompt).toContain('Suggest Goal Mode for long-running');
    expect(compiled.systemPrompt).toContain('Never create a goal or workflow without');
    expect(compiled.systemPrompt).toContain('ordinary questions, one-off fixes, or small edits');
  });

  test('manager prompt keeps one task on one machine and gives remote fan-out to the target', () => {
    const compiled = compilePrompt({
      role: 'manager',
      provider: 'openai',
      workingDirectory: testWorkDir,
      taskContract: createTaskContract('Run this build on the linked server'),
    });
    expect(compiled.systemPrompt).toContain('Default to one computer per task');
    expect(compiled.systemPrompt).toContain("target chat's manager owns that work");
    expect(compiled.systemPrompt).toContain('continues if this app quits');
    expect(compiled.systemPrompt).toContain('Do not mirror the same workstream');
  });

  test('critic role gets read tools plus approved verification commands and delegation', () => {
    const registry = new ToolRegistry();
    registry.register(new BashTool());
    registry.register(new ReadFileTool());
    registry.register(new WriteFileTool());
    registry.register(new GrepTool());
    registry.register(new GlobTool());
    registry.register(new LsTool());
    registry.register(new DelegateToWorkerTool());

    const criticNames = registry
      .getToolDefsForRole('critic')
      .map((d) => d.name)
      .sort();

    expect(criticNames).toEqual(['bash', 'delegate_to_worker', 'glob', 'grep', 'ls', 'read_file']);
  });

  test('worker tool context uses the granted worktree directory as cwd', async () => {
    const observed: { workingDirectory?: string; allowedPaths?: string[] } = {};

    registerLiveModelResolver((modelId, provider) =>
      modelId === 'mock-model'
        ? {
            id: modelId,
            name: modelId,
            provider,
            contextWindow: 128_000,
            contextVerified: true,
            maxOutputTokens: 16_384,
            costPerMInputTokens: 0,
            costPerMOutputTokens: 0,
            canReason: true,
            supportsAttachments: false,
            supportsStreaming: true,
          }
        : undefined,
    );

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
      [join(testWorkDir, 'worktree-1')],
      true,
    );
    registerLiveModelResolver(() => undefined);

    expect(result.success).toBe(true);
    expect(observed.workingDirectory).toBe(join(testWorkDir, 'worktree-1'));
    expect(observed.allowedPaths).toEqual([join(testWorkDir, 'worktree-1')]);
  });

  test('runWorkerPipeline fails when worktree reconcile fails', async () => {
    const autoCommit = mock(async () => {});

    // YOLO is per chat, so the unsandboxed worker path is enabled by giving
    // this session its own approval preset rather than a process-wide flag.
    setSessionAgentOverrides('session-2', { permissionMode: 'yolo' });
    // Reconciliation is exercised against the configured project workspace,
    // which is the one this test stubs. Per-chat checkout resolution has its
    // own coverage in manager-chat-workspace.test.ts.
    manager['resolveSessionWorkingDirectoryPublic'] = async () => testWorkDir;
    manager['workerPipeline']['prepareRecoveryBaseline'] = mock(async () => ({ ok: true }));
    manager['resolveIndependentRouting'] = mock(() => ({
      model: 'independent-worker',
      provider: 'anthropic',
    }));
    manager['workerPipeline']['routeToWorker'] = mock(async () => ({
      success: true,
      workerTranscript: 'worker transcript',
      criticFeedback: 'PASS',
    }));
    manager['handleAutoCommit'] = autoCommit;
    manager['workerPipeline']['workspaceManager'] = {
      spawn: () => ({ path: join(testWorkDir, 'worktree-2') }),
      validateWorktree: async () => join(testWorkDir, 'worktree-2'),
      reconcile: () => ({ success: false, message: 'merge conflict' }),
      cleanup: mock(() => ({ success: true, message: 'cleaned' })),
    } as any;

    const result = await manager.runWorkerPipeline('session-2', 'Implement task');

    expect(result).toContain('Worktree reconcile failed: merge conflict');
    expect(autoCommit).not.toHaveBeenCalled();
  });

  test('material delegation reuses the manager when it is the only user-enabled model', async () => {
    manager['resolveIndependentRouting'] = mock(() => null);
    // The manager branches on the structured outcome rather than the summary
    // text, so the stub must target the method it actually calls. The expected
    // routed model is unchanged.
    manager['workerPipeline']['runWorkerPipelineDetailed'] = mock(
      async (...args: any[]) => ({ success: true, text: `worker:${args[2]}` }),
    );
    const result = await manager.runWorkerPipeline(
      'session-independent',
      'Implement a material feature',
      'openai:gpt-4o',
      undefined,
      'backend',
    );
    expect(result).toContain('worker:openai:gpt-4o');
  });

  test('worker delegation and direct replies fail closed for archived sessions', async () => {
    const runWorker = mock(async () => 'must not run');
    manager['sessions'] = {
      get: async () => ({ id: 'session-archived', archivedAt: 1_000 }),
      getActive: async () => undefined,
    } as any;
    manager['workerPipeline']['runWorkerPipeline'] = runWorker;

    await expect(manager.runWorkerPipeline('session-archived', 'Do archived work')).rejects.toThrow(
      /Recover this archived chat/,
    );
    expect(runWorker).not.toHaveBeenCalled();
    const afterDelegate = manager.tryAcquireSessionMutationBarrier('session-archived');
    expect(afterDelegate).not.toBeNull();
    afterDelegate?.release();

    await expect(
      manager.sendMessageToAgent('session-archived', 'missing-agent', 'Continue'),
    ).rejects.toThrow(/Recover this archived chat/);
    const afterReply = manager.tryAcquireSessionMutationBarrier('session-archived');
    expect(afterReply).not.toBeNull();
    afterReply?.release();
  });

  test('manager controls persist per session and apply to the manager snapshot', async () => {
    const managerId = manager.agentControlSnapshots('session-controls')[0]!.agentId;
    (mockProviderRegistry.resolveProvider as any).mockImplementation(async (model: string) =>
      model === 'controlled-manager' || model === 'fallback-manager'
        ? { name: 'openai' }
        : undefined,
    );

    const updated = await manager.updateAgentControls('session-controls', managerId, {
      model: 'openai:controlled-manager',
      reasoningLevel: 'high',
      fallbacks: [{ model: 'openai:fallback-manager', reasoningLevel: 'low' }],
    });

    expect(updated).toMatchObject({
      model: 'controlled-manager',
      provider: 'openai',
      reasoningLevel: 'high',
      fallbacks: [{ model: 'openai:fallback-manager', reasoningLevel: 'low' }],
    });
    expect(
      manager['runtimes'].peek('session-controls')?.managerControls.get(managerId),
    ).toMatchObject({
      model: 'controlled-manager',
      reasoningLevel: 'high',
    });
    expect(sessionRows.get('session-controls')?.agentOverrides?.managerControls?.[managerId]).toMatchObject({
      model: 'controlled-manager',
      provider: 'openai',
      reasoningLevel: 'high',
      fallbacks: [{ model: 'openai:fallback-manager', reasoningLevel: 'low' }],
    });
    expect(manager.agentControlSnapshots('session-controls')[0]).toMatchObject({
      agentId: managerId,
      controllable: true,
      model: 'controlled-manager',
      reasoningLevel: 'high',
      fallbacks: [{ model: 'openai:fallback-manager', reasoningLevel: 'low' }],
    });
  });

  test('manager controls survive a new manager instance and empty runtime cache', async () => {
    const managerId = manager.agentControlSnapshots('session-controls-restart')[0]!.agentId;
    (mockProviderRegistry.resolveProvider as any).mockImplementation(async (model: string) =>
      model === 'restart-manager' ? { name: 'openai' } : undefined,
    );
    await manager.updateAgentControls('session-controls-restart', managerId, {
      model: 'openai:restart-manager',
      reasoningLevel: 'medium',
    });

    resetSessionAgentOverridesCache();
    const restarted = new KoryManager(
      mockProviderRegistry,
      mockToolRegistry,
      testWorkDir,
      mockConfig as any,
      { get: async (id: string) => sessionRows.get(id), update: async () => undefined } as any,
      { getRecent: () => [], add: () => {}, getContextMessages: () => [] } as any,
    );

    const listed = JSON.parse(
      await restarted.manageAgentsForSession('session-controls-restart', { action: 'list' }),
    ) as Array<{ agentId: string; model: string; reasoningLevel?: string }>;
    expect(listed[0]).toMatchObject({
      agentId: managerId,
      model: 'restart-manager',
      reasoningLevel: 'medium',
    });
    expect(restarted.agentControlSnapshots('session-controls-restart')[0]).toMatchObject({
      model: 'restart-manager',
      reasoningLevel: 'medium',
    });
  });

  test('worker follow-up advances to its fallback after a provider failure', async () => {
    (mockProviderRegistry.resolveProvider as any).mockImplementation(async (model: string) =>
      model === 'fallback-worker' ? { name: 'openai' } : { name: 'openai' },
    );
    const thread = {
      sessionId: 'session-followup-fallback',
      identity: {
        id: 'worker-followup',
        name: 'Worker',
        role: 'coder',
        model: 'primary-worker',
        provider: 'openai',
        domain: 'general',
        glowColor: '',
      },
      kind: 'worker',
      status: 'thinking',
      providerName: 'openai',
      modelId: 'primary-worker',
      systemPrompt: 'system',
      promptManifestHash: 'hash',
      taskContractHash: 'task',
      promptCache: undefined,
      toolRole: 'worker',
      reasoningLevel: 'medium',
      fallbacks: [{ model: 'openai:fallback-worker', reasoningLevel: 'high' }],
      maxTurns: 2,
      maxTokens: 1000,
      messages: [{ role: 'user', content: 'Continue' }],
      threadEntries: [],
      ctx: { sessionId: 'session-followup-fallback', workingDirectory: testWorkDir },
      busy: false,
      updatedAt: 0,
    } as any;
    manager['agentThreads'].set('worker-followup', thread);
    manager['recordAgentThreadRunMembership'] = mock(async () => {});
    manager['installAgentContextControls'] = mock(() => {});
    manager['pruneAgentThreadContext'] = mock(() => 0);
    manager['emitWSMessage'] = mock(() => {});
    const used: string[] = [];
    manager['processProviderTurn'] = mock(async (...args: any[]) => {
      used.push(args[2]);
      if (used.length === 1) throw new Error('429 rate limited');
      return false;
    });

    await manager['runAgentThread']('worker-followup', undefined, false);

    expect(used).toEqual(['primary-worker', 'fallback-worker']);
    expect(thread.providerName).toBe('openai');
    expect(thread.reasoningLevel).toBe('high');
    expect(manager.agentControlSnapshots('session-followup-fallback')).toContainEqual(
      expect.objectContaining({
        agentId: 'worker-followup',
        model: 'fallback-worker',
        reasoningLevel: 'high',
      }),
    );
  });

  test('critic gate never lets a producer verify its own work when no distinct model exists', async () => {
    manager['runHardChecks'] = mock(async () => ({ passed: true, output: 'checks passed' }));
    manager['resolveActiveRouting'] = mock(() => ({ model: 'producer-model', provider: 'openai' }));
    manager['resolveIndependentRouting'] = mock(() => null);
    // Forced review mode: the Critic Auto decider path needs a live adapter,
    // which no test env has; 'always' drives the same routing failure directly.
    manager['settingsForSession'] = mock(() => ({ criticMode: 'always' }) as never);

    const result = await manager.runCriticGate(
      'session-critic-truth',
      [{ role: 'assistant', content: 'I completed the task.' }],
      'openai:producer-model',
      'Verify the work',
      testWorkDir,
    );

    expect(result).toEqual({
      passed: false,
      skipped: true,
      feedback:
        'No distinct critic model is available. The producer cannot verify its own work, so the result remains unverified.',
    });
    expect(mockProviderRegistry.resolveProvider).not.toHaveBeenCalled();
  });

  test('critic gate rejects a resolver that returns the exact producer identity', async () => {
    manager['runHardChecks'] = mock(async () => ({ passed: true, output: 'checks passed' }));
    manager['resolveIndependentRouting'] = mock(() => ({
      model: 'producer-model',
      provider: 'openai',
    }));
    // Forced review mode: the resolver rejection lives past the Critic Auto
    // decider, which needs a live adapter no test env has.
    manager['settingsForSession'] = mock(() => ({ criticMode: 'always' }) as never);

    const result = await manager.runCriticGate(
      'session-critic-self-route',
      [{ role: 'assistant', content: 'I completed the task.' }],
      'producer-model',
      'Verify the work',
      testWorkDir,
      { provider: 'openai', model: 'producer-model' },
    );

    expect(result).toEqual({
      passed: false,
      skipped: true,
      feedback:
        'The configured critic resolves to the producer provider and model. Self-verification is not independent, so the result remains unverified.',
    });
    expect(mockProviderRegistry.resolveProvider).not.toHaveBeenCalled();
  });

  test('prompt compiler loads repository instructions broad-to-specific with manifest truth', () => {
    const root = mkdtempSync(join(tmpdir(), 'kory-prompt-'));
    mkdirSync(join(root, '.git'));
    mkdirSync(join(root, 'packages', 'app'), { recursive: true });
    writeFileSync(join(root, 'AGENTS.md'), 'Root rule');
    writeFileSync(join(root, 'packages', 'AGENTS.md'), 'Closer rule');

    const instructions = loadRepositoryInstructions(join(root, 'packages', 'app'));
    expect(instructions.map((source) => source.content)).toEqual(['Root rule', 'Closer rule']);
    expect(instructions[1]!.priority).toBeGreaterThan(instructions[0]!.priority);

    const compiled = compilePrompt({
      role: 'manager',
      provider: 'openai',
      workingDirectory: join(root, 'packages', 'app'),
      taskContract: createTaskContract('Build a custom native UI toolkit'),
    });
    expect(compiled.systemPrompt).toContain('Prefer modifying an appropriate existing file');
    expect(compiled.systemPrompt).toContain(
      'native, terminal, embedded, game, spatial, mobile, and web',
    );
    expect(compiled.systemPrompt).toContain('Root rule');
    expect(compiled.systemPrompt).toContain('Closer rule');
    expect(compiled.systemPrompt).not.toContain('commit and create a pull request automatically');
    expect(compiled.manifest.instructions).toHaveLength(2);
    expect(compiled.manifest.hash).toMatch(/^[a-f0-9]{64}$/);
  });

  test('native providers remain eligible for every role under Kory enforcement', () => {
    const compiled = compilePrompt({
      role: 'critic',
      provider: 'claude',
      workingDirectory: testWorkDir,
      taskContract: createTaskContract('Review the implementation'),
    });

    expect(compiled.manifest.capabilityProfile.mode).toBe('native-passthrough');
    expect(compiled.manifest.capabilityProfile.hardToolPolicy).toBe(true);
    expect(compiled.manifest.capabilityProfile.qualifiedRoles).toEqual([
      'manager',
      'worker',
      'critic',
    ]);
    expect(compiled.systemPrompt).toContain('wrapped by Kory role policy');
    expect(compiled.manifest.capabilityProfile.hash).toMatch(/^[a-f0-9]{64}$/);
    expect(compiled.manifest.taskContractHash).toMatch(/^[a-f0-9]{64}$/);
  });

  test('manager assigned skills are pinned into worker and critic delivery evidence', () => {
    const taskContract = createTaskContract('Explain the current module boundary', {
      skillAssignment: {
        worker: ['verification'],
        critic: ['testing-engineering'],
      },
    });
    const worker = compilePrompt({
      role: 'worker',
      provider: 'openai',
      workingDirectory: testWorkDir,
      taskContract,
    });
    expect(worker.manifest.skills.map((skill) => skill.name)).toContain('verification');
    expect(worker.skillDelivery.requiredSkills).toEqual(['verification']);
    expect(
      worker.skillDelivery.skills.find((skill) => skill.name === 'verification')?.assigned,
    ).toBe(true);
    expect(worker.skillDelivery.hash).toMatch(/^[a-f0-9]{64}$/);

    const critic = compilePrompt({
      role: 'critic',
      provider: 'openai',
      workingDirectory: testWorkDir,
      taskContract,
    });
    const managerAuto = compilePrompt({
      role: 'manager',
      provider: 'openai',
      workingDirectory: testWorkDir,
      taskContract,
      skillSelection: { pins: ['critic-auto-selection'] },
    });
    expect(managerAuto.manifest.skills.map((skill) => skill.name)).toContain('critic-auto-selection');
    expect(managerAuto.manifest.skills.map((skill) => skill.name)).not.toContain('critic-review');

    const managerWithoutAuto = compilePrompt({
      role: 'manager',
      provider: 'openai',
      workingDirectory: testWorkDir,
      taskContract,
    });
    expect(managerWithoutAuto.manifest.skills.map((skill) => skill.name)).not.toContain('critic-auto-selection');

    const criticSkills = critic.manifest.skills.map((skill) => skill.name);
    expect(criticSkills).toContain('verification');
    expect(criticSkills).toContain('critic-review');
    expect(criticSkills).toContain('testing-engineering');
    expect(critic.skillDelivery.requiredSkills).toEqual(['testing-engineering']);
    expect(
      critic.skillDelivery.skills.find((skill) => skill.name === 'testing-engineering')?.assigned,
    ).toBe(true);
  });

  test('core workflow suite contains six scenarios for all eight task classes', () => {
    expect(CORE_WORKFLOW_EVALS).toHaveLength(48);
    const counts = CORE_WORKFLOW_EVALS.reduce<Record<string, number>>((all, scenario) => {
      all[scenario.kind] = (all[scenario.kind] ?? 0) + 1;
      return all;
    }, {});
    expect(Object.values(counts).every((count) => count === 6)).toBe(true);
    expect(CORE_WORKFLOW_EVALS.every((scenario) => scenario.hazards.length > 0)).toBe(true);
    expect(buildEvalRunPlan('smoke', [{ provider: 'openai', model: 'test' }])).toHaveLength(16);
    expect(buildEvalRunPlan('full', [{ provider: 'openai', model: 'test' }])).toHaveLength(144);
    expect(LONGITUDINAL_EVALS.every((sequence) => sequence.checkpoints.length >= 4)).toBe(true);
  });

  test('qualification and rollout policy fail closed on integrity loss', () => {
    expect(
      qualifies({ roleClass: 'strong-managed', acceptanceRate: 0.85, severeIntegrityFailures: 0 }),
    ).toBe(true);
    expect(
      qualifies({ roleClass: 'bounded-worker', acceptanceRate: 0.89, severeIntegrityFailures: 0 }),
    ).toBe(false);
    expect(
      qualifies({
        roleClass: 'critic',
        acceptanceRate: 0.9,
        severeIntegrityFailures: 0,
        seededCriticalCatchRate: 0.9,
        falseFailureRate: 0.15,
      }),
    ).toBe(true);
    expect(
      rolloutDecision({
        stage: 25,
        integrityFailures: 0,
        falseCompletions: 1,
        instructionRegressions: 0,
        qualityDelta: 0.2,
      }),
    ).toBe('rollback');
  });

  test('critic output is structured and ambiguous PASS prose fails closed', () => {
    expect(parseCriticVerdict('This might pass, but evidence is missing.')).toBe(false);
    expect(
      parseCriticReport(
        '{"verdict":"PASS","findings":[],"checksReviewed":["bun test"],"unmetCriteria":[]}',
      )?.verdict,
    ).toBe('PASS');
    expect(
      parseCriticReport(
        '{"verdict":"PASS","findings":[{"severity":"major","evidence":"a.ts:1","criterion":"works","finding":"broken"}],"checksReviewed":[],"unmetCriteria":[]}',
      ),
    ).toBeNull();
  });

  test('settings resolve session over workspace over global and reject invalid API fields', () => {
    const resolved = resolveAgentSettingsLayers(
      { gateStrictness: 'advisory' },
      { gateStrictness: 'strict', intentInterview: 'deep' },
      { gateStrictness: 'off' },
    );
    expect(resolved.gateStrictness).toBe('off');
    expect(resolved.intentInterview).toBe('deep');
    const merged = mergeAgentSettings(DEFAULT_AGENT_SETTINGS, {
      gateStrictness: 'invented',
      maxCriticIterations: 'forever',
      unknownSetting: true,
      planApproval: 'always',
    });
    expect(merged.gateStrictness).toBe('strict');
    expect(merged.maxCriticIterations).toBe(3);
    expect(merged.planApproval).toBe('always');
    expect('unknownSetting' in merged).toBe(false);
  });

  test('jails auto-run ordinary commands and ask only for catastrophic destruction', async () => {
    expect(isCatastrophicBashCommand('bun test')).toBe(false);
    expect(isCatastrophicBashCommand('rm -rf ./dist')).toBe(false);
    expect(isCatastrophicBashCommand('rm -rf $HOME')).toBe(true);
    expect(isCatastrophicBashCommand('dd if=/dev/zero of=/dev/sda')).toBe(true);

    const questions: string[] = [];
    const bash = new BashTool();
    // Use a unique temp directory so persisted allowlist/blocklist from
    // prior runs doesn't interfere with the test.
    const testDir = mkdtempSync(join(tmpdir(), 'kory-bash-test-'));
    const result = await bash.run(
      {
        sessionId: 'catastrophic-test',
        workingDirectory: testDir,
        isSandboxed: false,
        waitForUserInput: async (question) => {
          questions.push(question);
          return 'Block and add command to blocklist';
        },
      },
      { id: 'danger', name: 'bash', input: { command: 'rm -rf $HOME' } },
    );
    expect(result.isError).toBe(true);
    expect(result.output).toContain('blocked by the user');
    expect(questions).toHaveLength(1);
  });
});

describe('worktree guidance in the delegation prompt', () => {
  const base = {
    role: 'manager' as const,
    provider: 'openai',
    workingDirectory: testWorkDir,
    taskContract: createTaskContract('Explain the architecture'),
  };
  const delegation = {
    available: true,
    pools: [{ domain: 'general' as const, models: ['openai:gpt-5'], unrestricted: false }],
  };

  test('auto tells the manager to decide and documents the HEAD-only worktree', () => {
    const compiled = compilePrompt({
      ...base,
      delegation: { ...delegation, worktreeMode: 'auto' },
    });
    expect(compiled.systemPrompt).toContain(
      'You decide worktree isolation for every delegation and must pass worktree explicitly',
    );
    expect(compiled.systemPrompt).toContain('a new worktree starts from the last commit');
    expect(compiled.systemPrompt).toContain('uncommitted changes in the chat checkout');
  });

  test('always/never replace the per-task choice with the fixed user setting', () => {
    const always = compilePrompt({
      ...base,
      delegation: { ...delegation, worktreeMode: 'always' },
    });
    expect(always.systemPrompt).toContain(
      'The user set Worktree to Always for this chat',
    );
    const never = compilePrompt({
      ...base,
      delegation: { ...delegation, worktreeMode: 'never' },
    });
    expect(never.systemPrompt).toContain('The user set Worktree to Never for this chat');
  });
});
