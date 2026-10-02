import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getPromptCacheCapabilities, resolvePromptCacheCapabilities } from '../cache-capabilities';
import {
  readProviderReasoningCacheProbe,
  writeProviderReasoningCacheProbe,
} from '../cache-capability-store';

const originalDataDir = process.env.KORYPHAIOS_DATA_DIR;

afterEach(() => {
  if (originalDataDir === undefined) delete process.env.KORYPHAIOS_DATA_DIR;
  else process.env.KORYPHAIOS_DATA_DIR = originalDataDir;
});

describe('prompt-cache capability policy', () => {
  test('shares reasoning only for verified providers and fails unknown providers closed', () => {
    expect(resolvePromptCacheCapabilities({ provider: 'openai', model: 'gpt-5.6' })).toMatchObject({
      effectiveReasoningScope: 'shared',
      reasoningScopeSource: 'verified-catalog',
    });
    expect(resolvePromptCacheCapabilities({ provider: 'mystery', model: 'model-a' })).toMatchObject(
      {
        effectiveReasoningScope: 'isolated',
        reasoningScopeSource: 'conservative',
      },
    );
    expect(getPromptCacheCapabilities({ provider: 'custom:lab', custom: true })).toMatchObject({
      nativeCaching: 'gateway',
      reasoningScope: 'probe',
    });
  });

  test('persists a verified gateway reasoning probe and reuses it', () => {
    process.env.KORYPHAIOS_DATA_DIR = mkdtempSync(join(tmpdir(), 'kory-cache-capability-'));
    const before = resolvePromptCacheCapabilities({
      provider: 'custom:lab',
      custom: true,
      model: 'lab-model',
    });
    expect(before.effectiveReasoningScope).toBe('isolated');
    expect(before.reasoningScopeSource).toBe('conservative');

    const observedAt = Date.now();
    writeProviderReasoningCacheProbe({
      provider: 'custom:lab',
      model: 'lab-model',
      scope: 'shared',
      samples: 4,
      observedAt,
    });
    expect(
      readProviderReasoningCacheProbe('custom:lab', 'lab-model', { now: observedAt }),
    ).toMatchObject({
      scope: 'shared',
      samples: 4,
    });
    expect(
      resolvePromptCacheCapabilities({
        provider: 'custom:lab',
        custom: true,
        model: 'lab-model',
      }),
    ).toMatchObject({
      effectiveReasoningScope: 'shared',
      reasoningScopeSource: 'live-probe',
    });
  });
});
