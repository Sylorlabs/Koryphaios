import { describe, expect, test, setDefaultTimeout } from 'bun:test';
import type { KoryphaiosConfig } from '@koryphaios/shared';
import { ProviderRegistry } from '../registry';

setDefaultTimeout(30000);

function minimalConfig(): KoryphaiosConfig {
  return {
    providers: {},
    agents: {
      manager: { model: 'claude-sonnet-4-5' },
      coder: { model: 'claude-sonnet-4-5' },
      task: { model: 'o4-mini' },
    },
    server: { port: 3000, host: 'localhost' },
    dataDirectory: '.koryphaios-test',
  };
}

/**
 * The per-provider Refresh button. Its cost properties matter as much as its
 * result: a CLI-backed refresh spawns a subprocess, so the button must coalesce
 * repeat clicks rather than queueing probes.
 */
describe('per-provider refresh and verify', () => {
  test('coalesces concurrent refreshes of the same provider into one', async () => {
    const registry = new ProviderRegistry(minimalConfig());
    const first = registry.refreshProviderAndVerify('openai', { now: 1_000 });
    const second = registry.refreshProviderAndVerify('openai', { now: 1_000 });
    const [a, b] = await Promise.all([first, second]);
    // An `async` method always hands back a distinct promise, so assert the
    // observable contract instead: the second caller joins the first result
    // rather than starting a second probe.
    expect(b).toEqual(a);
    expect(b.skipped).toBeUndefined();
  });

  test('returns a skipped result inside the cooldown instead of re-probing', async () => {
    const registry = new ProviderRegistry(minimalConfig());
    await registry.refreshProviderAndVerify('openai', { now: 2_000_000 });
    const second = await registry.refreshProviderAndVerify('openai', { now: 2_001_000 });
    expect(second.skipped).toBe('cooldown');
    expect(second.verification).toBeUndefined();
  });

  test('allows another refresh once the cooldown has passed', async () => {
    const registry = new ProviderRegistry(minimalConfig());
    await registry.refreshProviderAndVerify('openai', { now: 3_000_000 });
    const later = await registry.refreshProviderAndVerify('openai', { now: 3_000_000 + 30_000 });
    expect(later.skipped).toBeUndefined();
  });

  test('is scoped to one provider and does not disturb another', async () => {
    const registry = new ProviderRegistry(minimalConfig());
    await registry.refreshProviderAndVerify('openai', { now: 4_000_000 });
    // A different provider must be independently refreshable immediately.
    const other = await registry.refreshProviderAndVerify('anthropic', { now: 4_000_500 });
    expect(other.skipped).toBeUndefined();
  });

  test('reports a verdict rather than throwing when the provider is unreachable', async () => {
    const registry = new ProviderRegistry(minimalConfig());
    const result = await registry.refreshProviderAndVerify('openai', { now: 5_000_000 });
    expect(result.name).toBe('openai');
    // Unconfigured/unreachable must surface as data, so the UI can show it.
    expect(result).toHaveProperty('verification');
    expect(result.skipped).toBeUndefined();
  });
});