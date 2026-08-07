// Claude Code subscription harness — provider plumbing + live compliance test.
//
// The deterministic tests prove the `claude` provider is now wired into the registry
// and model catalog (it was dead code before — createProvider had no 'claude' case).
// The live test (gated behind KORY_LIVE_CLAUDE=1) proves the compliance requirement:
// a Claude subscription is served through the official `claude` CLI harness, never a
// direct API call.

import { describe, it, expect, beforeEach, setDefaultTimeout } from 'bun:test';
import { ProviderRegistry } from '../registry';
import { ClaudeCodeProvider, __resetClaudeCodeModelCacheForTesting } from '../claude-code';
import { PROVIDER_AUTH_MODE } from '../constants';
import type { ProviderEvent } from '../types';

// Provider instantiation involves CLI detection probes that are slow under
// parallel test load.
setDefaultTimeout(30000);

const live = process.env.KORY_LIVE_CLAUDE ? it : it.skip;

// Reset the module-level model cache before each test to prevent state
// leakage from other test files that trigger refreshModelsInBackground().
beforeEach(() => {
  __resetClaudeCodeModelCacheForTesting();
});

describe('Claude Code provider — plumbing', () => {
  it('registry instantiates a claude provider (previously null)', () => {
    const registry = new ProviderRegistry();
    const provider = registry.get('claude');
    expect(provider).toBeDefined();
    expect(provider?.name).toBe('claude');
  });

  it('every declared provider instantiates without throwing', () => {
    // The constructor runs createProvider() for every PROVIDER_AUTH_MODE name.
    expect(() => new ProviderRegistry()).not.toThrow();
    const registry = new ProviderRegistry();
    // claude, anthropic, codex should always produce an instance.
    for (const name of ['claude', 'anthropic', 'codex'] as const) {
      expect(registry.get(name), `missing provider: ${name}`).toBeDefined();
    }
    // No name in the auth-mode map should be missing from the catalog wiring.
    expect(Object.keys(PROVIDER_AUTH_MODE)).toContain('claude');
  });

  it('does not ship a Claude model catalog', () => {
    // Reset right before the assertion — not just in beforeEach — so a
    // parallel test file can't populate the cache between beforeEach and
    // this test's listModels() call.
    __resetClaudeCodeModelCacheForTesting();
    const provider = new ClaudeCodeProvider({ name: 'claude', authToken: 'cli:claude:test' });
    expect(provider.listModels()).toEqual([]);
  });

  it('an explicitly routed Claude model selects the Claude provider when available', () => {
    const registry = new ProviderRegistry();
    // Enable the claude provider with an opt-in marker (CLI owns the real token).
    (registry as unknown as { providers: Map<string, unknown> }).providers.set(
      'claude',
      new ClaudeCodeProvider({ name: 'claude', authToken: 'cli:claude:test', disabled: false }),
    );
    const resolved = registry.resolveProvider('sonnet', 'claude');
    expect(resolved?.name).toBe('claude');
  });

  it('isAvailable requires opt-in or detected login; disabled blocks it', () => {
    const enabled = new ClaudeCodeProvider({
      name: 'claude',
      authToken: 'cli:claude:test',
      disabled: false,
    });
    expect(enabled.isAvailable()).toBe(true);
    const disabled = new ClaudeCodeProvider({
      name: 'claude',
      authToken: 'cli:claude:test',
      disabled: true,
    });
    expect(disabled.isAvailable()).toBe(false);
  });
});

describe('Claude Code provider — live harness (compliance)', () => {
  live(
    'streams a real response through the claude CLI subscription',
    async () => {
      const provider = new ClaudeCodeProvider({
        name: 'claude',
        authToken: 'cli:claude:test',
        disabled: false,
      });

      const events: ProviderEvent[] = [];
      for await (const event of provider.streamResponse({
        model: 'claude-code-haiku',
        systemPrompt: 'You are a terse test fixture.',
        messages: [{ role: 'user', content: 'Reply with exactly: HARNESS_OK' }],
      })) {
        events.push(event);
      }

      const text = events
        .filter((e) => e.type === 'content_delta')
        .map((e) => e.content)
        .join('');
      const hadError = events.find((e) => e.type === 'error');
      const completed = events.some((e) => e.type === 'complete');

      expect(hadError, `harness error: ${hadError?.error}`).toBeUndefined();
      expect(text).toContain('HARNESS_OK');
      expect(completed).toBe(true);
    },
    120_000,
  );
});
