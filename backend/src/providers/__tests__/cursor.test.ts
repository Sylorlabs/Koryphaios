import { describe, it, expect } from 'bun:test';
import { parseCursorModelList } from '../cursor';

describe('parseCursorModelList', () => {
  it('parses JSON list output', () => {
    expect(parseCursorModelList('["gpt-5", {"id":"gpt-5-codex","name":"GPT 5 Codex"}]')).toEqual([
      {
        id: 'cursor-gpt-5',
        name: 'gpt-5',
        provider: 'cursor',
        apiModelId: 'gpt-5',
        contextWindow: 200_000,
        maxOutputTokens: 32_000,
        supportsStreaming: true,
        supportsAttachments: false,
        canReason: false,
        reasoningLevels: [],
      },
      {
        id: 'cursor-gpt-5-codex',
        name: 'GPT 5 Codex',
        provider: 'cursor',
        apiModelId: 'gpt-5-codex',
        contextWindow: 200_000,
        maxOutputTokens: 32_000,
        supportsStreaming: true,
        supportsAttachments: false,
        canReason: false,
        reasoningLevels: [],
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
        contextWindow: 200_000,
        maxOutputTokens: 32_000,
        supportsStreaming: true,
        supportsAttachments: false,
        canReason: false,
        reasoningLevels: [],
      },
      {
        id: 'cursor-cursor-mini',
        name: 'Cursor Mini',
        provider: 'cursor',
        apiModelId: 'cursor-mini',
        contextWindow: 200_000,
        maxOutputTokens: 32_000,
        supportsStreaming: true,
        supportsAttachments: false,
        canReason: false,
        reasoningLevels: [],
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

  it('does not infer reasoning controls from Cursor model names', () => {
    const models = parseCursorModelList(['auto', 'thinking', 'claude-high'].join('\n'));

    expect(models.map(({ apiModelId, canReason, reasoningLevels }) => ({
      apiModelId,
      canReason,
      reasoningLevels,
    }))).toEqual([
      { apiModelId: 'auto', canReason: false, reasoningLevels: [] },
      { apiModelId: 'thinking', canReason: false, reasoningLevels: [] },
      { apiModelId: 'claude-high', canReason: false, reasoningLevels: [] },
    ]);
  });
});
