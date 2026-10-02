// Retry policy shared by the registry's chat turn and the auxiliary provider
// calls (compaction, titles, plan parsing, inquiry/relay routing, the Settings
// merge). The point of these tests is that a user never sees a provider blip:
// a transient failure is repeated on the same model, and a credential or
// request rejection still fails closed on the first attempt.
process.env.KORY_DISABLE_CLI_AUTODETECT = '1';

import { describe, expect, test } from 'bun:test';
import {
  collectProviderEvents,
  isRetriableProviderFailure,
  SAME_MODEL_MAX_RETRIES,
} from '../provider-retry';
import type { ModelDef, ProviderConfig, ProviderName } from '@koryphaios/shared';
import type { Provider, ProviderEvent, StreamRequest } from '../types';

const request: StreamRequest = {
  model: 'test-retry-model',
  messages: [{ role: 'user', content: 'hi' }],
  systemPrompt: '',
};

const AUTH_ERROR = 'Anthropic authentication failed. Reconnect the provider and retry.';

function testModel(): ModelDef {
  return {
    id: 'test-retry-model',
    apiModelId: 'test-retry-model',
    name: 'Test Retry',
    provider: 'anthropic' as ProviderName,
    contextWindow: 0,
    contextVerified: false,
    maxOutputTokens: 0,
    costPerMInputTokens: 0,
    costPerMOutputTokens: 0,
    canReason: false,
    reasoningLevels: [],
    supportsFastMode: false,
    supportsAttachments: false,
    supportsStreaming: true,
  };
}

/** Provider that plays a scripted event list per attempt. */
class ScriptedStream implements Provider {
  readonly name = 'anthropic' as ProviderName;
  readonly config: ProviderConfig = {};
  calls = 0;
  constructor(private readonly script: ProviderEvent[][]) {}

  isAvailable(): boolean {
    return true;
  }

  listModels(): ModelDef[] {
    return [testModel()];
  }

  async *streamResponse(_request: StreamRequest): AsyncGenerator<ProviderEvent> {
    const step = this.script[this.calls++] ?? [];
    yield* step;
  }
}

describe('collectProviderEvents', () => {
  test('repeats a flagged transient failure and returns the recovered attempt', async () => {
    const provider = new ScriptedStream([
      [
        { type: 'content_delta', content: 'partial' },
        { type: 'error', error: 'upstream went away', errorTransient: true },
      ],
      [
        { type: 'content_delta', content: 'hello' },
        { type: 'complete', finishReason: 'end_turn' },
      ],
    ]);
    const collected = await collectProviderEvents(provider, request);
    expect(provider.calls).toBe(2);
    expect(collected.failed).toBe(false);
    expect(collected.attempts).toBe(2);
    // The failed attempt's partial text is discarded, not concatenated.
    expect(collected.events.map((e) => (e.type === 'content_delta' ? e.content : e.type))).toEqual([
      'hello',
      'complete',
    ]);
  });

  test('repeats a text-classified transient failure from an adapter with no flag', async () => {
    const provider = new ScriptedStream([
      [
        {
          type: 'error',
          error:
            'SSE Error: {"type":"error","error":{"type":"api_error","message":"Temporary service interruption."}}',
        },
      ],
      [
        { type: 'content_delta', content: 'hello' },
        { type: 'complete', finishReason: 'end_turn' },
      ],
    ]);
    const collected = await collectProviderEvents(provider, request);
    expect(provider.calls).toBe(2);
    expect(collected.failed).toBe(false);
  });

  test('reports the provider reason once the retry budget is spent', async () => {
    const failing: ProviderEvent[] = [
      { type: 'error', error: 'upstream went away', errorTransient: true },
    ];
    const provider = new ScriptedStream([failing, failing, failing, failing]);
    const collected = await collectProviderEvents(provider, request);
    expect(provider.calls).toBe(SAME_MODEL_MAX_RETRIES + 1);
    expect(collected.failed).toBe(true);
    expect(collected.error).toBe('upstream went away');
    expect(collected.attempts).toBe(SAME_MODEL_MAX_RETRIES + 1);
  });

  test('fails closed on a credential rejection without retrying', async () => {
    const provider = new ScriptedStream([
      [{ type: 'error', error: AUTH_ERROR }],
      [{ type: 'content_delta', content: 'hello' }],
    ]);
    const collected = await collectProviderEvents(provider, request);
    expect(provider.calls).toBe(1);
    expect(collected.failed).toBe(true);
    expect(collected.error).toBe(AUTH_ERROR);
  });

  test('stops immediately when the caller aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    const provider = new ScriptedStream([
      [{ type: 'error', error: 'upstream went away', errorTransient: true }],
      [{ type: 'content_delta', content: 'hello' }],
    ]);
    const collected = await collectProviderEvents(provider, request, { signal: controller.signal });
    expect(provider.calls).toBe(1);
    expect(collected.failed).toBe(true);
  });

  test('reports a thrown mid-stream failure the same way as an error event', async () => {
    class ThrowingProvider extends ScriptedStream {
      override async *streamResponse(_request: StreamRequest): AsyncGenerator<ProviderEvent> {
        this.calls += 1;
        if (this.calls === 1) throw new Error('socket hang up');
        yield { type: 'content_delta', content: 'hello' };
      }
    }
    const provider = new ThrowingProvider([[]]);
    const collected = await collectProviderEvents(provider, request);
    expect(provider.calls).toBe(2);
    expect(collected.failed).toBe(false);
  });

  test('surfaces each retry to the caller for logging', async () => {
    const retries: number[] = [];
    const provider = new ScriptedStream([
      [{ type: 'error', error: 'upstream went away', errorTransient: true }],
      [{ type: 'error', error: 'upstream went away', errorTransient: true }],
      [{ type: 'content_delta', content: 'hello' }],
    ]);
    await collectProviderEvents(provider, request, {
      onRetry: (attempt, reason) => retries.push(attempt),
      maxRetries: 2,
    });
    expect(retries).toEqual([1, 2]);
  });
});

describe('isRetriableProviderFailure', () => {
  test('retries the reported statusless in-stream api_error', () => {
    expect(
      isRetriableProviderFailure(
        'SSE Error: {"type":"error","error":{"type":"api_error","message":"Temporary service interruption."}}',
      ),
    ).toBe(true);
  });

  test('retries server statuses and transport deaths', () => {
    expect(isRetriableProviderFailure(Object.assign(new Error('upstream'), { status: 503 }))).toBe(
      true,
    );
    expect(isRetriableProviderFailure(new Error('fetch failed'))).toBe(true);
    expect(isRetriableProviderFailure(new Error('socket hang up'))).toBe(true);
  });

  test('stays closed on credentials, rejections, and route context limits', () => {
    expect(isRetriableProviderFailure(AUTH_ERROR)).toBe(false);
    expect(isRetriableProviderFailure('invalid api key')).toBe(false);
    expect(isRetriableProviderFailure('codex login required')).toBe(false);
    expect(
      isRetriableProviderFailure(Object.assign(new Error('bad request'), { status: 400 })),
    ).toBe(false);
    expect(
      isRetriableProviderFailure(
        '{"type":"error","error":{"type":"invalid_request_error","message":"The request exceeds this model route context limit. Reduce the request."}}',
      ),
    ).toBe(false);
  });
});
