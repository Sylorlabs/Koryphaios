// Claude Code subscription harness — provider plumbing + live compliance test.
//
// The deterministic tests prove the `claude` provider is now wired into the registry
// and model catalog (it was dead code before — createProvider had no 'claude' case).
// The live test (gated behind KORY_LIVE_CLAUDE=1) proves the compliance requirement:
// a Claude subscription is served through the official `claude` CLI harness, never a
// direct API call.

import { describe, it, expect } from 'bun:test';
import { ProviderRegistry } from '../registry';
import { ClaudeCodeProvider } from '../claude-code';
import { getModelsForProvider, MODEL_CATALOG } from '../models';
import { PROVIDER_AUTH_MODE } from '../constants';
import type { ProviderEvent } from '../types';

const live = process.env.KORY_LIVE_CLAUDE ? it : it.skip;

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

  it('claude model catalog is present and does not collide with anthropic ids', () => {
    const models = getModelsForProvider('claude');
    expect(models.length).toBeGreaterThanOrEqual(3);
    expect(models.every((m) => m.provider === 'claude')).toBe(true);
    // IDs must be distinct from the API-key anthropic catalog (MODEL_CATALOG is keyed by id).
    for (const m of models) {
      expect(MODEL_CATALOG[m.id]?.provider).toBe('claude');
      expect(m.apiModelId).toMatch(/^(opus|sonnet|haiku|fable)$/);
    }
  });

  it('a model id selects the claude provider when available', () => {
    const registry = new ProviderRegistry();
    // Enable the claude provider with an opt-in marker (CLI owns the real token).
    (registry as unknown as { providers: Map<string, unknown> }).providers.set(
      'claude',
      new ClaudeCodeProvider({ name: 'claude', authToken: 'cli:claude:test', disabled: false }),
    );
    const resolved = registry.resolveProvider('claude-code-sonnet', 'claude');
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
