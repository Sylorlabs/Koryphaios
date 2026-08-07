import { describe, it, expect } from 'bun:test';
import { parseCursorModelList, shouldStartCursorModelRefresh } from '../cursor';

describe('Cursor model refresh lifecycle', () => {
  it('coalesces in-flight and duplicate forced refresh requests', () => {
    expect(shouldStartCursorModelRefresh({ forceRefresh: true, inFlight: true, lastStartedAt: 0, now: 20_000 })).toBe(false);
    expect(shouldStartCursorModelRefresh({ forceRefresh: true, inFlight: false, lastStartedAt: 15_000, now: 20_000 })).toBe(false);
    expect(shouldStartCursorModelRefresh({ forceRefresh: true, inFlight: false, lastStartedAt: 5_000, now: 20_000 })).toBe(true);
    expect(shouldStartCursorModelRefresh({ forceRefresh: false, inFlight: false, lastStartedAt: 19_999, now: 20_000 })).toBe(true);
  });
});

describe('parseCursorModelList', () => {
  it('parses JSON list output', () => {
    expect(parseCursorModelList('["gpt-5", {"id":"gpt-5-codex","name":"GPT 5 Codex"}]')).toEqual([
      {
        id: 'cursor-gpt-5',
        name: 'gpt-5',
        provider: 'cursor',
        apiModelId: 'gpt-5',
        contextWindow: 0,
        maxOutputTokens: 0,
        supportsStreaming: true,
        supportsAttachments: false,
      },
      {
        id: 'cursor-gpt-5-codex',
        name: 'GPT 5 Codex',
        provider: 'cursor',
        apiModelId: 'gpt-5-codex',
        contextWindow: 0,
        maxOutputTokens: 0,
        supportsStreaming: true,
        supportsAttachments: false,
      },
    ]);
  });

  it('parses object with models array', () => {
    expect(
      parseCursorModelList(
        JSON.stringify({
          models: [
            { id: 'grok-beta', name: 'Grok' },
            { id: 'cursor-mini', name: 'Cursor Mini' },
          ],
        }),
      ),
    ).toEqual([
      {
        id: 'cursor-grok-beta',
        name: 'Grok',
        provider: 'cursor',
        apiModelId: 'grok-beta',
        contextWindow: 0,
        maxOutputTokens: 0,
        supportsStreaming: true,
        supportsAttachments: false,
      },
      {
        id: 'cursor-cursor-mini',
        name: 'Cursor Mini',
        provider: 'cursor',
        apiModelId: 'cursor-mini',
        contextWindow: 0,
        maxOutputTokens: 0,
        supportsStreaming: true,
        supportsAttachments: false,
      },
    ]);
  });

  it('parses line-based models output', () => {
    const raw = [
      'Available models:',
      '* gpt-5 (current)',
      '- gpt-4o-mini',
      '1) gpt-5-codex - extra info',
      '• cursor-pro',
      '| gpt-5-mini | text reasoning |',
      'default model: gpt-5-default',
      '',
    ].join('\n');

    expect(parseCursorModelList(raw).map((model) => model.apiModelId)).toEqual([
      'gpt-5',
      'gpt-4o-mini',
      'gpt-5-codex',
      'cursor-pro',
      'gpt-5-mini',
      'gpt-5-default',
    ]);
  });

  it('returns empty list for CLI no-model message', () => {
    expect(parseCursorModelList('No models available for this account.')).toEqual([]);
  });
});
