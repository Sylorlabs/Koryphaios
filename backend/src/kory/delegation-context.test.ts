import { describe, expect, test } from 'bun:test';
import { buildDelegationPromptContext } from './delegation-context';

const providers = [
  { name: 'openai', models: ['gpt-4o', 'gpt-4o-mini'], adapterAvailable: true },
  { name: 'anthropic', models: ['claude-sonnet'], adapterAvailable: true },
  { name: 'disabled', models: ['hidden'], adapterAvailable: false },
];

describe('delegation prompt context', () => {
  test('renders the configured pool per category and does not leak other categories', () => {
    const context = buildDelegationPromptContext({
      managerModelAccess: { backend: ['anthropic:claude-sonnet'], ui: ['openai:gpt-4o'] },
      agentExecutionMode: 'auto',
      interactionMode: 'act',
      providerStatuses: providers,
    });

    expect(context.available).toBe(true);
    expect(context.pools.find((pool) => pool.domain === 'backend')?.models).toEqual([
      'anthropic:claude-sonnet',
    ]);
    expect(context.pools.find((pool) => pool.domain === 'ui')?.models).toEqual(['openai:gpt-4o']);
    expect(context.pools.find((pool) => pool.domain === 'test')?.unrestricted).toBe(true);
  });

  test('treats an empty category as unrestricted over reachable models only', () => {
    const context = buildDelegationPromptContext({
      agentExecutionMode: 'auto',
      interactionMode: 'act',
      providerStatuses: providers,
    });

    const general = context.pools.find((pool) => pool.domain === 'general');
    expect(general?.unrestricted).toBe(true);
    expect(general?.models).toContain('openai:gpt-4o');
    expect(general?.models).not.toContain('disabled:hidden');
  });

  test('is unavailable in Single-Agent mode', () => {
    const context = buildDelegationPromptContext({
      agentExecutionMode: 'single',
      interactionMode: 'act',
      providerStatuses: providers,
    });
    expect(context.available).toBe(false);
    expect(context.reason).toBe('Single-Agent mode');
  });

  test('stays available in Plan mode and marks the planning posture', () => {
    const context = buildDelegationPromptContext({
      agentExecutionMode: 'auto',
      interactionMode: 'plan',
      providerStatuses: providers,
    });
    expect(context.available).toBe(true);
    expect(context.planning).toBe(true);
  });

  test('fails closed when no provider model is reachable', () => {
    const context = buildDelegationPromptContext({
      agentExecutionMode: 'auto',
      interactionMode: 'act',
      providerStatuses: [],
    });
    expect(context.available).toBe(false);
    expect(context.reason).toContain('no model is reachable');
  });
});
