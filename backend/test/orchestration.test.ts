import { describe, expect, test, mock, beforeEach } from 'bun:test';
import { KoryManager } from '../src/kory/manager';
import { ProviderRegistry } from '../src/providers';
import {
  ToolRegistry,
  BashTool,
  ReadFileTool,
  WriteFileTool,
  GrepTool,
  GlobTool,
  LsTool,
} from '../src/tools';
import { isCatastrophicBashCommand } from '../src/tools/bash';
import { AskUserTool, AskManagerTool, DelegateToWorkerTool } from '../src/tools/interaction';
import type { Session, AgentIdentity, WSMessage } from '@koryphaios/shared';
import { DOMAIN } from '../src/constants';
import { compilePrompt, createTaskContract, loadRepositoryInstructions } from '../src/kory/prompts';
import { buildIntentDiscoveryBatch } from '../src/kory/clarification-gate';
import {
  buildEvalRunPlan,
  CORE_WORKFLOW_EVALS,
  LONGITUDINAL_EVALS,
  qualifies,
  rolloutDecision,
} from '../src/kory/workflow-evals';
import { parseCriticReport, parseCriticVerdict } from '../src/kory/critic-util';
import {
  DEFAULT_AGENT_SETTINGS,
  mergeAgentSettings,
  resolveAgentSettingsLayers,
} from '../src/agent-settings';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

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

    const criticNames = registry
      .getToolDefsForRole('critic')
      .map((d) => d.name)
      .sort();

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
    manager['workerPipeline']['routeToWorker'] = mock(async () => ({
      success: true,
      workerTranscript: 'worker transcript',
      criticFeedback: 'PASS',
    }));
    manager['handleAutoCommit'] = autoCommit;
    manager['workerPipeline']['workspaceManager'] = {
      spawn: () => ({ path: '/tmp/worktree-2' }),
      reconcile: () => ({ success: false, message: 'merge conflict' }),
      cleanup: mock(() => ({ success: true, message: 'cleaned' })),
    } as any;

    const result = await manager.runWorkerPipeline('session-2', 'Implement task');

    expect(result).toContain('Worktree reconcile failed: merge conflict');
    expect(autoCommit).not.toHaveBeenCalled();
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
      mode: 'beginner',
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
      mode: 'advanced',
      provider: 'claude',
      workingDirectory: '/tmp',
      taskContract: createTaskContract('Review the implementation'),
    });

    expect(compiled.manifest.capabilityProfile.mode).toBe('native-passthrough');
    expect(compiled.manifest.capabilityProfile.hardToolPolicy).toBe(false);
    expect(compiled.manifest.capabilityProfile.qualifiedRoles).toEqual([
      'manager',
      'worker',
      'critic',
    ]);
    expect(compiled.systemPrompt).toContain('wrapped by Kory role policy');
  });

  test('adaptive discovery is conservative and always exposes an immediate stop', () => {
    expect(
      buildIntentDiscoveryBatch(
        'Implement the fully specified parser contract with the existing AST and acceptance tests.',
        'feature',
        'adaptive',
      ),
    ).toEqual([]);
    const questions = buildIntentDiscoveryBatch('make it better', 'ui', 'adaptive');
    expect(questions.length).toBeGreaterThan(0);
    expect(questions.length).toBeLessThanOrEqual(3);
    expect(
      questions.every((question) => question.options.at(-1) === 'Stop asking and implement now'),
    ).toBe(true);
    expect(questions[0]!.options[0]).toContain('(Recommended)');
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
    const result = await bash.run(
      {
        sessionId: 'catastrophic-test',
        workingDirectory: '/tmp',
        isSandboxed: false,
        waitForUserInput: async (question) => {
          questions.push(question);
          return 'Cancel (Recommended)';
        },
      },
      { id: 'danger', name: 'bash', input: { command: 'rm -rf $HOME' } },
    );
    expect(result.isError).toBe(true);
    expect(result.output).toContain('cancelled by the user');
    expect(questions).toHaveLength(1);
  });
});
