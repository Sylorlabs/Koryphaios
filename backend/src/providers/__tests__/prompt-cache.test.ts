import { describe, expect, test } from 'bun:test';
import {
  createPromptCachePlan,
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
    });
    expect(plan.cacheKey).toMatch(/^kory-[a-f0-9]{48}$/);
    expect(plan.cacheKey).not.toContain('stable');
    expect(plan.stablePrefixHash).toHaveLength(64);
    expect(plan.estimatedStableTokens).toBeGreaterThan(0);
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
    expect(first.promptCache.stableSystemPrompt).toBe(second.promptCache.stableSystemPrompt);
    expect(first.systemPrompt.startsWith(first.promptCache.stableSystemPrompt)).toBe(true);
    expect(first.systemPrompt).not.toBe(second.systemPrompt);
  });
});
