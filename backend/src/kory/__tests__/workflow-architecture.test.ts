import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { compilePrompt, createTaskContract } from '../prompts';
import { discoverVerificationChecks } from '../verification';
import { CORE_WORKFLOW_EVALS, runProviderHarnessEval, runWorkflowEvals } from '../workflow-evals';
import { EventEmitterService } from '../services/EventEmitterService';
import { getProviderHarnessCapabilities } from '../../providers/provider-harness';
import { getCliBridge } from '../../providers/cli-bridges';
import { KORY_TOOL_WHITELIST, KORY_CRITIC_TOOL_WHITELIST } from '../../providers/cli-bridges';
import { KORY_TOOLS, toolsForRole } from '../../providers/kory-mcp-bridge';
import { ToolRegistry } from '../../tools/registry';
import { GetResourceBudgetTool } from '../../tools/resource-budget';

describe('workflow architecture', () => {
  test('instruction overrides replace the broader same-scope file', () => {
    const root = mkdtempSync(join(tmpdir(), 'kory-prompt-'));
    mkdirSync(join(root, '.git'));
    writeFileSync(join(root, 'AGENTS.md'), 'broad-only-marker');
    writeFileSync(join(root, 'AGENTS.override.md'), 'override-only-marker');
    const compiled = compilePrompt({
      role: 'manager',
      mode: 'advanced',
      provider: 'openai',
      workingDirectory: root,
      taskContract: createTaskContract('fix the bug'),
    });
    expect(compiled.systemPrompt).toContain('override-only-marker');
    expect(compiled.systemPrompt).not.toContain('broad-only-marker');
    expect(compiled.manifest.version).toBe('kory-workflow-v7-hierarchical-cache');
  });

  test('verification prefers repository CI and core gates', () => {
    const root = mkdtempSync(join(tmpdir(), 'kory-checks-'));
    writeFileSync(join(root, 'bun.lock'), '');
    writeFileSync(
      join(root, 'package.json'),
      JSON.stringify({
        scripts: { 'typecheck:ci': 'x', typecheck: 'x', 'test:core': 'x', test: 'x' },
      }),
    );
    expect(discoverVerificationChecks(root).map((check) => check.command)).toEqual([
      'bun run typecheck:ci',
      'bun run test:core',
    ]);
  });

  test('provider adapters preserve semantics while rendering native structure', () => {
    const root = mkdtempSync(join(tmpdir(), 'kory-adapters-'));
    mkdirSync(join(root, '.git'));
    const contract = createTaskContract('answer the question');
    const anthropic = compilePrompt({
      role: 'manager',
      mode: 'advanced',
      provider: 'claude',
      workingDirectory: root,
      taskContract: contract,
    });
    const google = compilePrompt({
      role: 'manager',
      mode: 'advanced',
      provider: 'gemini-cli',
      workingDirectory: root,
      taskContract: contract,
    });
    expect(anthropic.systemPrompt).toContain('<kory_section');
    expect(google.systemPrompt).toContain('--- KORY SECTION');
    expect(anthropic.systemPrompt).toContain(contract.goal);
    expect(google.systemPrompt).toContain(contract.goal);
  });

  test('every provider remains role-capable while reporting actual isolation', () => {
    for (const provider of [
      'openai',
      'claude',
      'grok',
      'cursor',
      'devin',
      'cline',
      'antigravity',
    ]) {
      const capabilities = getProviderHarnessCapabilities(provider);
      expect(capabilities.roles).toEqual(['manager', 'worker', 'critic']);
      expect(capabilities.hash).toHaveLength(64);
      if (capabilities.mode === 'native-passthrough' && !capabilities.filesystemIsolation) {
        expect(capabilities.isolationMechanism).toBe('none');
        expect(capabilities.verificationEligible).toBe(false);
        expect(capabilities.limitations.length).toBeGreaterThan(0);
      }
    }
  });

  test('provider harness qualification is executable and fail-closed', () => {
    const results = runProviderHarnessEval([
      'openai',
      'claude',
      'grok',
      'cursor',
      'devin',
      'cline',
      'antigravity',
    ]);
    expect(results.every((result) => result.passed)).toBe(true);
    expect(results.every((result) => result.roles.every((role) => role.available))).toBe(true);
    expect(results.find((result) => result.provider === 'openai')?.verification).toBe('verified');
  });

  test('the smoke runner executes 16 scenarios and records evidence', async () => {
    const report = await runWorkflowEvals({
      suite: 'smoke',
      providerModels: [{ provider: 'test', model: 'deterministic', reasoningLevel: 'low' }],
      execute: async ({ scenario }) => ({
        appliedReasoningLevel: 'low',
        passed: true,
        assertions: Object.fromEntries(
          scenario.requiredAssertions.map((assertion) => [assertion, true]),
        ),
        severeIntegrityFailure: false,
        evidence: ['fixture'],
        failureReasons: [],
      }),
    });
    expect(CORE_WORKFLOW_EVALS).toHaveLength(48);
    expect(report.summary.total).toBe(16);
    expect(report.summary.acceptanceRate).toBe(1);
    expect(report.results.every((result) => result.appliedReasoningLevel === 'low')).toBe(true);
  });

  test('workflow evaluations fail closed when a provider cannot confirm requested reasoning', async () => {
    const report = await runWorkflowEvals({
      suite: 'smoke',
      providerModels: [{ provider: 'test', model: 'unconfirmed', reasoningLevel: 'low' }],
      execute: async ({ scenario }) => ({
        passed: true,
        assertions: Object.fromEntries(
          scenario.requiredAssertions.map((assertion) => [assertion, true]),
        ),
        severeIntegrityFailure: false,
        evidence: ['fixture-without-provider-reasoning-report'],
        failureReasons: [],
      }),
    });
    expect(report.summary.acceptanceRate).toBe(0);
    expect(report.results[0]?.failureReasons).toContain(
      'Requested reasoning level low was not provider-confirmed.',
    );
  });

  test('lifecycle hooks can deny a tool without provider cooperation', async () => {
    const events = new EventEmitterService({ managerAgentId: 'test' });
    events.registerWorkflowHook('before-tool', ({ data }) => ({
      decision: data.tool === 'forbidden' ? 'deny' : 'allow',
      reason: 'protected boundary',
    }));
    expect(
      (await events.runWorkflowHooks('before-tool', 's', { tool: 'forbidden' })).decision,
    ).toBe('deny');
    expect(
      (await events.runWorkflowHooks('before-tool', 's', { tool: 'read_file' })).decision,
    ).toBe('allow');
  });

  test('every native CLI role receives truthful resource data while workflow mutation remains manager-owned', () => {
    expect(
      KORY_TOOLS.some((tool) => tool.name === 'kory__get_resource_budget' && tool.role === 'any'),
    ).toBe(true);
    expect(KORY_TOOL_WHITELIST).toContain('kory__get_resource_budget');
    expect(KORY_CRITIC_TOOL_WHITELIST).toContain('kory__get_resource_budget');
    expect(toolsForRole('manager').map((tool) => tool.name)).toContain('kory__start_workflow');
    expect(toolsForRole('worker').map((tool) => tool.name)).not.toContain('kory__start_workflow');
    expect(toolsForRole('critic').map((tool) => tool.name)).not.toContain('kory__update_workflow');
    for (const role of ['manager', 'worker', 'critic'] as const) {
      expect(toolsForRole(role).map((tool) => tool.name)).toContain('kory__get_resource_budget');
    }

    const registry = new ToolRegistry();
    registry.register(new GetResourceBudgetTool({ getConfigs: () => ({}) } as any));
    expect(registry.isAllowedForRole('get_resource_budget', 'critic')).toBe(true);

    const codexCritic = getCliBridge('codex')?.buildAgentConfig({
      provider: 'codex',
      role: 'critic',
      workingDirectory: '/tmp',
      systemPrompt: '',
      tools: [{ name: 'get_resource_budget', description: 'budget', inputSchema: {} }],
    });
    expect(codexCritic?.allowedTools).toContain('kory__get_resource_budget');
  });
});
