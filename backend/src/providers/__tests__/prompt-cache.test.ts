import { describe, expect, test } from 'bun:test';
import {
  canonicalizeProviderTools,
  createPromptCachePlan,
  derivePromptCacheLane,
  deriveProviderPromptCacheKey,
  resolvePromptCacheSegments,
} from '../prompt-cache';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { compilePrompt, createTaskContract } from '../../kory/prompts';

describe('Kory prompt cache contract', () => {
  test('creates an opaque stable identity without exposing prompt text', () => {
    const plan = createPromptCachePlan({
      stableSystemPrompt: 'stable instructions',
      providerAdapter: 'openai-v1',
      role: 'manager',
      workspaceScope: '/workspace/example',
    });
    expect(plan.cacheKey).toMatch(/^kory-[a-f0-9]{48}$/);
    expect(plan.cacheKey).not.toContain('stable');
    expect(plan.stablePrefixHash).toHaveLength(64);
    expect(plan.workspaceScopeHash).toHaveLength(64);
    expect(plan.workspaceScopeHash).not.toContain('/workspace/example');
    expect(plan.estimatedStableTokens).toBeGreaterThan(0);
  });

  test('shares provider cache identity across tabs in one workspace and isolates other workspaces', () => {
    const tools = [{ name: 'read_file', description: 'read', inputSchema: { type: 'object' } }];
    const workspaceA = createPromptCachePlan({
      stableSystemPrompt: 'stable',
      providerAdapter: 'openai-v1',
      role: 'manager',
      workspaceScope: '/workspace/a',
    });
    const workspaceB = createPromptCachePlan({
      stableSystemPrompt: 'stable',
      providerAdapter: 'openai-v1',
      role: 'manager',
      workspaceScope: '/workspace/b',
    });
    const firstTab = deriveProviderPromptCacheKey(
      {
        model: 'gpt-5.6',
        reasoningLevel: 'medium',
        promptCache: workspaceA,
        sessionId: 'session-a',
        harnessRole: 'manager',
      },
      tools,
    );
    const secondTab = deriveProviderPromptCacheKey(
      {
        model: 'gpt-5.6',
        reasoningLevel: 'medium',
        promptCache: workspaceA,
        sessionId: 'session-b',
        harnessRole: 'manager',
      },
      tools,
    );
    const otherWorkspace = deriveProviderPromptCacheKey(
      {
        model: 'gpt-5.6',
        reasoningLevel: 'medium',
        promptCache: workspaceB,
        sessionId: 'session-c',
        harnessRole: 'manager',
      },
      tools,
    );
    expect(firstTab).toBe(secondTab);
    expect(otherWorkspace).not.toBe(firstTab);
  });

  test('keeps dynamic suffix out of the cache segment and fails closed on tampering', () => {
    const plan = createPromptCachePlan({
      stableSystemPrompt: 'stable instructions\n',
      providerAdapter: 'anthropic-v1',
      role: 'worker',
    });
    expect(
      resolvePromptCacheSegments({
        systemPrompt: 'stable instructions\nper-turn task',
        promptCache: plan,
      }),
    ).toEqual({ stable: 'stable instructions\n', dynamic: 'per-turn task', valid: true });
    expect(
      resolvePromptCacheSegments({
        systemPrompt: 'changed\nper-turn task',
        promptCache: plan,
      }).valid,
    ).toBe(false);
  });

  test('tool schema and model changes cannot share a provider routing bucket', () => {
    const plan = createPromptCachePlan({
      stableSystemPrompt: 'stable',
      providerAdapter: 'openai-v1',
      role: 'manager',
    });
    const base = { model: 'gpt-5.6', reasoningLevel: 'medium', promptCache: plan };
    const a = deriveProviderPromptCacheKey(base, [
      { name: 'read_file', description: 'read', inputSchema: { type: 'object' } },
    ]);
    const b = deriveProviderPromptCacheKey(base, [
      { name: 'write_file', description: 'write', inputSchema: { type: 'object' } },
    ]);
    expect(a).toBeDefined();
    expect(a).not.toBe(b);
  });

  test('reasoning-only changes keep the same provider prompt cache key', () => {
    const plan = createPromptCachePlan({
      stableSystemPrompt: 'stable',
      providerAdapter: 'openai-v1',
      role: 'manager',
    });
    const tools = [{ name: 'read_file', description: 'read', inputSchema: { type: 'object' } }];
    const medium = deriveProviderPromptCacheKey(
      { model: 'gpt-5.6', reasoningLevel: 'medium', promptCache: plan },
      tools,
      { provider: 'openai' },
    );
    const high = deriveProviderPromptCacheKey(
      { model: 'gpt-5.6', reasoningLevel: 'high', promptCache: plan },
      tools,
      { provider: 'openai' },
    );
    expect(medium).toBeDefined();
    expect(high).toBe(medium);
  });

  test('reasoning changes isolate provider prompt-cache keys when the provider is not verified shared', () => {
    const plan = createPromptCachePlan({
      stableSystemPrompt: 'stable',
      providerAdapter: 'custom:lab',
      role: 'manager',
    });
    const tools = [{ name: 'read_file', description: 'read', inputSchema: { type: 'object' } }];
    const medium = deriveProviderPromptCacheKey(
      { model: 'lab-model', reasoningLevel: 'medium', promptCache: plan },
      tools,
      { provider: 'custom:lab', custom: true, reasoningScopeOverride: 'isolated' },
    );
    const high = deriveProviderPromptCacheKey(
      { model: 'lab-model', reasoningLevel: 'high', promptCache: plan },
      tools,
      { provider: 'custom:lab', custom: true, reasoningScopeOverride: 'isolated' },
    );
    expect(medium).toBeDefined();
    expect(high).not.toBe(medium);
  });

  test('equivalent tool belts keep one cache identity across registration and schema-key order', () => {
    const plan = createPromptCachePlan({
      stableSystemPrompt: 'stable',
      providerAdapter: 'openai-v1',
      role: 'manager',
    });
    const base = { model: 'gpt-5.6', reasoningLevel: 'medium', promptCache: plan };
    const first = [
      {
        name: 'write_file',
        description: 'write',
        inputSchema: {
          required: ['path', 'content'],
          type: 'object',
          properties: {
            path: { description: 'path', type: 'string' },
            content: { type: 'string', description: 'content' },
          },
        },
      },
      { name: 'read_file', description: 'read', inputSchema: { type: 'object' } },
    ];
    const second = [
      { name: 'read_file', description: 'read', inputSchema: { type: 'object' } },
      {
        name: 'write_file',
        description: 'write',
        inputSchema: {
          properties: {
            content: { description: 'content', type: 'string' },
            path: { type: 'string', description: 'path' },
          },
          type: 'object',
          required: ['path', 'content'],
        },
      },
    ];

    expect(deriveProviderPromptCacheKey(base, first)).toBe(
      deriveProviderPromptCacheKey(base, second),
    );
    expect(canonicalizeProviderTools(first)).toEqual(canonicalizeProviderTools(second));
    expect(canonicalizeProviderTools(first).map((tool) => tool.name)).toEqual([
      'read_file',
      'write_file',
    ]);
  });

  test('runtime lanes isolate sessions and roles while keeping permission-only changes warm', () => {
    const plan = createPromptCachePlan({
      stableSystemPrompt: 'stable',
      providerAdapter: 'openai-v1',
      role: 'manager',
    });
    const tools = [{ name: 'read_file', description: 'read', inputSchema: { type: 'object' } }];
    const manager = derivePromptCacheLane(
      {
        model: 'gpt-5.6',
        reasoningLevel: 'medium',
        promptCache: plan,
        sessionId: 'session-a',
        harnessRole: 'manager',
      },
      tools,
    );
    const same = derivePromptCacheLane(
      {
        model: 'gpt-5.6',
        reasoningLevel: 'medium',
        promptCache: plan,
        sessionId: 'session-a',
        harnessRole: 'manager',
      },
      tools,
    );
    const worker = derivePromptCacheLane(
      {
        model: 'gpt-5.6',
        reasoningLevel: 'medium',
        promptCache: plan,
        sessionId: 'session-a',
        harnessRole: 'worker',
      },
      tools,
    );
    const compaction = derivePromptCacheLane(
      {
        model: 'gpt-5.6',
        reasoningLevel: 'medium',
        promptCache: plan,
        sessionId: 'session-a',
        harnessRole: 'manager',
        cacheLaneKind: 'compaction',
      },
      tools,
    );
    const research = derivePromptCacheLane(
      {
        model: 'gpt-5.6',
        reasoningLevel: 'medium',
        promptCache: plan,
        sessionId: 'session-a',
        harnessRole: 'critic',
        capabilityProfile: 'research-only',
      },
      tools,
    );
    const otherSession = derivePromptCacheLane(
      {
        model: 'gpt-5.6',
        reasoningLevel: 'medium',
        promptCache: plan,
        sessionId: 'session-b',
        harnessRole: 'manager',
      },
      tools,
    );
    expect(manager?.key).toBe(same?.key);
    expect(worker?.key).not.toBe(manager?.key);
    expect(compaction?.key).not.toBe(manager?.key);
    expect(compaction?.routingKey).not.toBe(manager?.routingKey);
    expect(research?.kind).toBe('research');
    expect(research?.routingKey).not.toBe(manager?.routingKey);
    expect(otherSession?.key).not.toBe(manager?.key);
    expect(otherSession?.routingKey).toBe(manager?.routingKey);
  });

  test('compiled prompts keep the workspace prefix identical across tasks', () => {
    const root = mkdtempSync(join(tmpdir(), 'kory-cache-compile-'));
    mkdirSync(join(root, '.git'));
    const first = compilePrompt({
      role: 'manager',
      mode: 'advanced',
      provider: 'openai',
      workingDirectory: root,
      taskContract: createTaskContract('first task'),
    });
    const second = compilePrompt({
      role: 'manager',
      mode: 'advanced',
      provider: 'openai',
      workingDirectory: root,
      taskContract: createTaskContract('second task'),
    });
    expect(first.promptCache.stablePrefixHash).toBe(second.promptCache.stablePrefixHash);
    expect(first.promptCache.workspaceScopeHash).toBe(second.promptCache.workspaceScopeHash);
    expect(first.promptCache.stableSystemPrompt).toBe(second.promptCache.stableSystemPrompt);
    expect(first.systemPrompt.startsWith(first.promptCache.stableSystemPrompt)).toBe(true);
    expect(first.systemPrompt).not.toBe(second.systemPrompt);
  });

  test('compiled prompts isolate provider cache routes between different workspaces', () => {
    const firstRoot = mkdtempSync(join(tmpdir(), 'kory-cache-workspace-a-'));
    const secondRoot = mkdtempSync(join(tmpdir(), 'kory-cache-workspace-b-'));
    mkdirSync(join(firstRoot, '.git'));
    mkdirSync(join(secondRoot, '.git'));
    const first = compilePrompt({
      role: 'manager',
      mode: 'advanced',
      provider: 'openai',
      workingDirectory: firstRoot,
      taskContract: createTaskContract('same task'),
    });
    const second = compilePrompt({
      role: 'manager',
      mode: 'advanced',
      provider: 'openai',
      workingDirectory: secondRoot,
      taskContract: createTaskContract('same task'),
    });
    expect(first.promptCache.workspaceScopeHash).not.toBe(second.promptCache.workspaceScopeHash);
    expect(first.promptCache.cacheKey).not.toBe(second.promptCache.cacheKey);
  });
});
