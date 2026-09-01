import { describe, expect, it } from 'bun:test';
import {
  parseCodexCliModelsCache,
  enrichCodexModelsWithCliCache,
  readCodexModelsCacheFromProfile,
  type CodexCliModelMeta,
} from '../codex-models-cache';

describe('parseCodexCliModelsCache', () => {
  it('parses the real cache shape and stamps context_window with contextVerified', () => {
    const raw = JSON.stringify({
      fetched_at: '2026-08-29T05:30:59Z',
      models: [
        {
          slug: 'gpt-5.6-terra',
          display_name: 'GPT-5.6-Terra',
          context_window: 272_000,
          visibility: 'list',
          supported_reasoning_levels: [{ effort: 'low' }, { effort: 'high' }],
        },
        {
          slug: 'gpt-reserve',
          display_name: 'GPT Reserve',
          context_window: 272_000,
          visibility: 'hide',
        },
        {
          slug: 'broken',
          context_window: 1,
          visibility: 'list',
        },
      ],
    });
    const parsed = parseCodexCliModelsCache(raw);
    expect(parsed.get('gpt-5.6-terra')).toMatchObject({
      slug: 'gpt-5.6-terra',
      contextWindow: 272_000,
      visible: true,
      reasoningLevels: ['low', 'high'],
    });
    expect(parsed.get('gpt-reserve')?.visible).toBe(false);
    // A context_window of 1 is below the 1024 minimum — reject.
    expect(parsed.get('broken')?.contextWindow).toBeUndefined();
  });

  it('falls back to max_context_window when context_window is missing', () => {
    const raw = JSON.stringify({
      models: [
        { slug: 'm', max_context_window: 512_000, visibility: 'list' },
      ],
    });
    expect(parseCodexCliModelsCache(raw).get('m')?.contextWindow).toBe(512_000);
  });

  it('returns an empty map for malformed or empty input', () => {
    expect(parseCodexCliModelsCache('').size).toBe(0);
    expect(parseCodexCliModelsCache('not json').size).toBe(0);
    expect(parseCodexCliModelsCache(JSON.stringify({ models: 'nope' })).size).toBe(0);
  });
});

describe('enrichCodexModelsWithCliCache', () => {
  const cache = new Map<string, CodexCliModelMeta>([
    [
      'gpt-5.6-terra',
      {
        slug: 'gpt-5.6-terra',
        contextWindow: 272_000,
        visible: true,
        reasoningLevels: ['low', 'high', 'max'],
      },
    ],
    [
      'hidden',
      {
        slug: 'hidden',
        contextWindow: 128_000,
        visible: false,
      },
    ],
  ]);

  it('stamps the real context window and marks it verified', () => {
    const enriched = enrichCodexModelsWithCliCache(
      [
        {
          id: 'codex-account:abc:gpt-5.6-terra',
          apiModelId: 'gpt-5.6-terra',
          name: 'GPT-5.6-Terra',
          provider: 'codex',
          contextWindow: 0,
          contextVerified: false,
          maxOutputTokens: 0,
        },
      ],
      cache,
    );
    expect(enriched[0].contextWindow).toBe(272_000);
    expect(enriched[0].contextVerified).toBe(true);
    expect(enriched[0].reasoningLevels).toEqual(['low', 'high', 'max']);
    expect(enriched[0].canReason).toBe(true);
  });

  it('passes models through untouched when the cache has no entry for them', () => {
    const enriched = enrichCodexModelsWithCliCache(
      [
        {
          id: 'codex-account:abc:unknown',
          apiModelId: 'unknown',
          name: 'Unknown',
          provider: 'codex',
          contextWindow: 0,
          contextVerified: false,
          maxOutputTokens: 0,
        },
      ],
      cache,
    );
    expect(enriched[0].contextWindow).toBe(0);
    expect(enriched[0].contextVerified).toBe(false);
  });

  it('returns the input unchanged when the cache is empty or null', () => {
    const models = [
      {
        id: 'a',
        apiModelId: 'a',
        name: 'a',
        provider: 'codex',
        contextWindow: 0,
        contextVerified: false,
        maxOutputTokens: 0,
      },
    ];
    expect(enrichCodexModelsWithCliCache(models, null)).toBe(models);
    expect(enrichCodexModelsWithCliCache(models, new Map())).toBe(models);
  });
});

describe('readCodexModelsCacheFromProfile', () => {
  it('returns null when the profile dir is missing the cache file', () => {
    expect(readCodexModelsCacheFromProfile('/nonexistent/path')).toBeNull();
  });

  it('returns null for an empty profileDir', () => {
    expect(readCodexModelsCacheFromProfile('')).toBeNull();
  });
});
