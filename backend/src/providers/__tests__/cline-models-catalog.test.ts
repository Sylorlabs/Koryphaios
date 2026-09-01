import { describe, expect, it, beforeAll, afterAll } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import {
  parseClineOpenRouterCache,
  lookupClineModelMeta,
  enrichClineModel,
} from '../cline-models-catalog';

/**
 * The isolated test runner redirects HOME to a fresh temp directory, so the
 * Cline user's on-disk OpenRouter cache (~/.cline/data/cache/openrouter_models.json)
 * is absent and the lookup falls back to whatever the bundled @cline/llms
 * catalog can provide (or nothing if Cline isn't installed). Seed a minimal
 * cache so the enrichment test exercises the user-cache path.
 */
const CLINE_CACHE_DIR = join(homedir(), '.cline', 'data', 'cache');
const CLINE_CACHE_PATH = join(CLINE_CACHE_DIR, 'openrouter_models.json');
let backup: string | null = null;
let existed = false;

beforeAll(() => {
  existed = existsSync(CLINE_CACHE_PATH);
  if (existed) backup = readFileSync(CLINE_CACHE_PATH, 'utf8');
  else mkdirSync(CLINE_CACHE_DIR, { recursive: true });
  writeFileSync(
    CLINE_CACHE_PATH,
    JSON.stringify({
      'qwen/qwen3.5-plus-02-15': {
        name: 'Qwen 3.5 Plus',
        maxTokens: 65536,
        contextWindow: 1_000_000,
      },
    }),
  );
});

afterAll(() => {
  if (backup !== null) writeFileSync(CLINE_CACHE_PATH, backup);
  else if (!existed) {
    try {
      rmSync(CLINE_CACHE_PATH);
    } catch {
      /* best-effort */
    }
  }
});

describe('parseClineOpenRouterCache', () => {
  it('parses the real cache shape and stamps contextWindow', () => {
    const raw = JSON.stringify({
      'qwen/qwen3.5-plus-02-15': {
        name: 'Qwen: Qwen3.5 Plus 2026-02-15',
        maxTokens: 65536,
        contextWindow: 1_000_000,
        supportsImages: true,
        supportsPromptCache: false,
      },
      broken: { contextWindow: 1 },
    });
    const parsed = parseClineOpenRouterCache(raw);
    expect(parsed.get('qwen/qwen3.5-plus-02-15')?.contextWindow).toBe(1_000_000);
    expect(parsed.get('qwen/qwen3.5-plus-02-15')?.maxOutputTokens).toBe(65536);
    expect(parsed.get('broken')?.contextWindow).toBeUndefined();
  });

  it('returns an empty map for malformed input', () => {
    expect(parseClineOpenRouterCache('').size).toBe(0);
    expect(parseClineOpenRouterCache('not json').size).toBe(0);
    expect(parseClineOpenRouterCache(JSON.stringify(null)).size).toBe(0);
  });
});

describe('enrichClineModel', () => {
  it('stamps the real context window from the seeded user cache', () => {
    const enriched = enrichClineModel({
      id: 'cline-qwen/qwen3.5-plus-02-15',
      apiModelId: 'qwen/qwen3.5-plus-02-15',
      name: '',
      provider: 'cline',
      contextWindow: 0,
      maxOutputTokens: 0,
    });
    expect(enriched.contextWindow).toBe(1_000_000);
    expect(enriched.contextVerified).toBe(true);
    expect(enriched.maxOutputTokens).toBe(65536);
  });

  it('passes a model through untouched when the lookup yields nothing', () => {
    const base = {
      id: 'cline-anthropic/does-not-exist-1234',
      apiModelId: 'anthropic/does-not-exist-1234',
      name: '',
      provider: 'cline',
      contextWindow: 0,
      maxOutputTokens: 0,
    };
    const enriched = enrichClineModel({ ...base });
    expect(enriched.contextWindow).toBe(0);
    expect(enriched.contextVerified).toBeUndefined();
  });
});

describe('lookupClineModelMeta', () => {
  it('returns null for an empty id', () => {
    expect(lookupClineModelMeta('')).toBeNull();
  });

  it('finds a real value via the user cache', () => {
    const meta = lookupClineModelMeta('qwen/qwen3.5-plus-02-15');
    expect(meta?.contextWindow).toBe(1_000_000);
  });
});
