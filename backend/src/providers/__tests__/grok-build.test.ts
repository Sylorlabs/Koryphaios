import { describe, it, expect } from 'bun:test';
import {
  GrokBuildProvider,
  parseGrokCliModelsCache,
  parseGrokModelsOutput,
  parseGrokOutput,
} from '../grok-build';
import type { ProviderConfig } from '@koryphaios/shared';
import type { ProviderEvent, StreamRequest } from '../types';

const cfg = (over: Partial<ProviderConfig> = {}): ProviderConfig =>
  ({ name: 'grok', disabled: false, selectedModels: [], hideModelSelector: false, ...over }) as ProviderConfig;

describe('parseGrokOutput', () => {
  it('parses the documented --output-format json final object', () => {
    const raw = JSON.stringify({ text: 'Hello from Grok', stopReason: 'end_turn', sessionId: 's1', requestId: 'r1' });
    expect(parseGrokOutput(raw)).toEqual({ text: 'Hello from Grok', stopReason: 'end_turn' });
  });

  it('surfaces an error object', () => {
    const r = parseGrokOutput(JSON.stringify({ error: { message: 'not logged in' } }));
    expect(r.text).toBe('');
    expect(r.error).toBe('not logged in');
  });

  it('accumulates streaming-json (NDJSON) text deltas', () => {
    const ndjson = [
      JSON.stringify({ type: 'delta', delta: 'Hel' }),
      JSON.stringify({ type: 'delta', delta: 'lo' }),
      JSON.stringify({ type: 'done', stopReason: 'end_turn' }),
    ].join('\n');
    expect(parseGrokOutput(ndjson)).toEqual({ text: 'Hello', stopReason: 'end_turn' });
  });

  it('falls back to plain text', () => {
    expect(parseGrokOutput('just some text')).toEqual({ text: 'just some text' });
  });

  it('treats empty output as an error', () => {
    expect(parseGrokOutput('   ').error).toBeTruthy();
  });

  it('tolerates banner/progress lines mixed into NDJSON', () => {
    const mixed = ['Loading…', JSON.stringify({ delta: 'ok' }), ''].join('\n');
    expect(parseGrokOutput(mixed).text).toBe('ok');
  });
});

describe('parseGrokModelsOutput', () => {
  it('parses grok models CLI output', () => {
    const raw = [
      'You are logged in with grok.com.',
      '',
      'Default model: grok-composer-2.5-fast',
      '',
      'Available models:',
      '  - grok-build',
      '  * grok-composer-2.5-fast (default)',
    ].join('\n');

    expect(parseGrokModelsOutput(raw)).toEqual({
      defaultModelId: 'grok-composer-2.5-fast',
      modelIds: ['grok-build', 'grok-composer-2.5-fast'],
    });
  });

  it('returns empty list for unrecognized output', () => {
    expect(parseGrokModelsOutput('not logged in')).toEqual({
      defaultModelId: undefined,
      modelIds: [],
    });
  });
});

describe('parseGrokCliModelsCache', () => {
  it('reads real context limits and rejects boolean-like values', () => {
    const parsed = parseGrokCliModelsCache(JSON.stringify({
      models: {
        'grok-build': { info: { name: 'Grok Build', context_window: 512_000, hidden: false } },
        broken: { info: { context_window: 1, hidden: false } },
      },
    }));
    expect(parsed?.get('grok-build')?.contextWindow).toBe(512_000);
    expect(parsed?.get('broken')?.contextWindow).toBeUndefined();
  });
});

describe('GrokBuildProvider', () => {
  it('is a distinct provider named "grok" exposing Grok Build models', () => {
    const p = new GrokBuildProvider(cfg({ authToken: 'cli:grok:123' }));
    expect(p.name).toBe('grok');
    const models = p.listModels();
    expect(models.length).toBeGreaterThan(0);
    expect(models.every((m) => m.provider === 'grok')).toBe(true);
    expect(models.every((m) => Boolean(m.id) && Boolean(m.apiModelId))).toBe(true);
  });

  it('isAvailable() respects disabled and the opt-in marker', () => {
    expect(new GrokBuildProvider(cfg({ disabled: true, authToken: 'cli:grok:1' })).isAvailable()).toBe(false);
    expect(new GrokBuildProvider(cfg({ authToken: 'cli:grok:1' })).isAvailable()).toBe(true);
  });

  it('streamResponse yields a clear error when the grok CLI is not installed', async () => {
    if (whichInstalled()) return;

    const p = new GrokBuildProvider(cfg({ authToken: 'cli:grok:1' }));
    const req: StreamRequest = {
      model: 'grok-build',
      systemPrompt: 'test',
      messages: [{ role: 'user', content: 'hi' }],
    } as StreamRequest;
    const events: ProviderEvent[] = [];
    for await (const e of p.streamResponse(req)) events.push(e);
    const err = events.find((e) => e.type === 'error') as { type: 'error'; error: string } | undefined;
    expect(err).toBeTruthy();
    expect(err!.error).toMatch(/not found|install|grok login/i);
  });
});

function whichInstalled(): boolean {
  try {
    // Mirror the harness's own check without importing internals.
    const { whichBinary } = require('../cli-detection');
    return !!whichBinary('grok');
  } catch {
    return false;
  }
}
