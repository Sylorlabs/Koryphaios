import { describe, expect, test } from 'bun:test';
import {
  byModelFromSamples,
  makeApiEquivalentResolver,
  CLI_API_PROVIDER_MAP,
  type UsageSample,
} from './cli-usage';

const NOW = 1_700_000_000_000;
const DAY = 24 * 60 * 60 * 1000;

function sample(ts: number, model: string, tokensIn: number, tokensOut: number): UsageSample {
  return { ts, model, tokensIn, tokensOut, cacheRead: 0 };
}

// ── byModelFromSamples ────────────────────────────────────────────────────────

describe('byModelFromSamples', () => {
  test('aggregates tokens per model and sorts by total descending', () => {
    const samples = [
      sample(NOW - DAY, 'claude-sonnet-4-5', 1000, 500),
      sample(NOW - DAY, 'claude-sonnet-4-5', 2000, 1000),
      sample(NOW - DAY, 'claude-haiku-3-5', 100, 50),
    ];
    const result = byModelFromSamples(samples, NOW);
    expect(result).toHaveLength(2);
    expect(result[0].model).toBe('claude-sonnet-4-5');
    expect(result[0].tokensIn).toBe(3000);
    expect(result[0].tokensOut).toBe(1500);
    expect(result[1].model).toBe('claude-haiku-3-5');
    expect(result[1].tokensIn).toBe(100);
  });

  test('excludes samples older than 30 days', () => {
    const samples = [
      sample(NOW - 31 * DAY, 'claude-sonnet-4-5', 1000, 500),
      sample(NOW - DAY, 'claude-sonnet-4-5', 500, 200),
    ];
    const result = byModelFromSamples(samples, NOW);
    expect(result).toHaveLength(1);
    expect(result[0].tokensIn).toBe(500);
  });

  test('returns empty array for no samples', () => {
    const result = byModelFromSamples([], NOW);
    expect(result).toEqual([]);
  });

  test('attaches apiEquivalent and apiProvider when resolver returns them', () => {
    const samples = [sample(NOW - DAY, 'claude-sonnet-4-5', 1000, 500)];
    const resolver = (model: string) =>
      model === 'claude-sonnet-4-5'
        ? { apiEquivalent: 'claude-sonnet-4-5-20250929', apiProvider: 'anthropic' }
        : null;
    const result = byModelFromSamples(samples, NOW, resolver);
    expect(result[0].apiEquivalent).toBe('claude-sonnet-4-5-20250929');
    expect(result[0].apiProvider).toBe('anthropic');
  });

  test('omits apiEquivalent when resolver returns null', () => {
    const samples = [sample(NOW - DAY, 'unknown-model', 1000, 500)];
    const resolver = () => null;
    const result = byModelFromSamples(samples, NOW, resolver);
    expect(result[0].apiEquivalent).toBeUndefined();
    expect(result[0].apiProvider).toBeUndefined();
  });

  test('omits apiEquivalent when no resolver is provided', () => {
    const samples = [sample(NOW - DAY, 'claude-sonnet-4-5', 1000, 500)];
    const result = byModelFromSamples(samples, NOW);
    expect(result[0].apiEquivalent).toBeUndefined();
    expect(result[0].apiProvider).toBeUndefined();
  });

  test('attaches apiProvider only when resolver returns no apiEquivalent', () => {
    const samples = [sample(NOW - DAY, 'unknown-model', 1000, 500)];
    const resolver = () => ({ apiProvider: 'anthropic' });
    const result = byModelFromSamples(samples, NOW, resolver);
    expect(result[0].apiEquivalent).toBeUndefined();
    expect(result[0].apiProvider).toBe('anthropic');
  });
});

// ── CLI_API_PROVIDER_MAP ──────────────────────────────────────────────────────

describe('CLI_API_PROVIDER_MAP', () => {
  test('maps all known CLI providers to their backing API providers', () => {
    expect(CLI_API_PROVIDER_MAP['claude']).toBe('anthropic');
    expect(CLI_API_PROVIDER_MAP['codex']).toBe('openai');
    expect(CLI_API_PROVIDER_MAP['copilot']).toBe('openai');
    expect(CLI_API_PROVIDER_MAP['grok']).toBe('xai');
    expect(CLI_API_PROVIDER_MAP['antigravity']).toBe('google');
    expect(CLI_API_PROVIDER_MAP['cursor']).toBe('openai');
    expect(CLI_API_PROVIDER_MAP['devin']).toBe('devin');
    expect(CLI_API_PROVIDER_MAP['cline']).toBe('cline');
    expect(CLI_API_PROVIDER_MAP['kimicode']).toBe('kimicode');
    expect(CLI_API_PROVIDER_MAP['kilocode']).toBe('kilocode');
    expect(CLI_API_PROVIDER_MAP['freebuff']).toBe('freebuff');
    expect(CLI_API_PROVIDER_MAP['jules']).toBe('google');
  });

  test('every CLI provider in the map has a non-empty value', () => {
    for (const [key, value] of Object.entries(CLI_API_PROVIDER_MAP)) {
      expect(key.length).toBeGreaterThan(0);
      expect(value.length).toBeGreaterThan(0);
    }
  });
});

// ── makeApiEquivalentResolver ─────────────────────────────────────────────────

describe('makeApiEquivalentResolver', () => {
  test('returns fallback apiProvider when provider catalog is unavailable', () => {
    // The 'claude' provider may not be loaded in the test environment, so
    // the resolver should fall back to CLI_API_PROVIDER_MAP['claude'].
    const resolver = makeApiEquivalentResolver('claude');
    const result = resolver('claude-sonnet-4-5');
    // In the test environment, getContext().providers may not have 'claude'
    // registered, so we expect the fallback apiProvider at minimum.
    expect(result).not.toBeNull();
    if (result) {
      expect(result.apiProvider).toBe('anthropic');
    }
  });

  test('returns null for unknown provider with no fallback', () => {
    const resolver = makeApiEquivalentResolver('nonexistent-provider-xyz');
    const result = resolver('some-model');
    // Unknown provider has no fallback in CLI_API_PROVIDER_MAP
    expect(result).toBeNull();
  });

  test('is idempotent across calls (caches model lookup)', () => {
    const resolver = makeApiEquivalentResolver('claude');
    const result1 = resolver('claude-sonnet-4-5');
    const result2 = resolver('claude-sonnet-4-5');
    expect(result1).toEqual(result2);
  });

  test('handles empty model string gracefully', () => {
    const resolver = makeApiEquivalentResolver('claude');
    const result = resolver('');
    // Should not throw; returns fallback or null
    expect(() => resolver('')).not.toThrow();
  });
});
