// Yielded-error retry coverage for executeWithRetry. CLI harnesses like Codex
// YIELD an error event on nonzero exit instead of throwing, so the registry
// must engage its same-model retry path for yielded errors — not just thrown
// ones. CLI auto-detection is disabled: these tests don't need real CLIs.
process.env.KORY_DISABLE_CLI_AUTODETECT = '1';

import { describe, expect, test } from 'bun:test';
import { ProviderRegistry } from '../registry';
import { codexTransientFailureMessage } from '../codex-cli';
import { safeProviderDiagnostic, safeProviderFailureMessage } from '../provider-diagnostics';
import type { ModelDef, ProviderConfig, ProviderName } from '@koryphaios/shared';
import type { Provider, ProviderEvent, StreamRequest } from '../types';

type Step = 'transient' | 'auth' | 'throw-transient' | 'turn-token' | 'partial-token' | 'ok';

const TURN_TOKEN_MESSAGE = 'turn token is invalid, expired, or revoked';

const AUTH_MESSAGE = 'Codex CLI authentication failed. Run "codex login", then reconnect.';

function testModel(): ModelDef {
  return {
    id: 'test-codex-model',
    apiModelId: 'test-codex-model',
    name: 'Test Codex',
    provider: 'codex',
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

/** Stub Codex-shaped provider following a scripted per-attempt behavior. */
class ScriptedCodexStub implements Provider {
  readonly name = 'codex' as const;
  readonly config: ProviderConfig = {};
  calls = 0;
  /** Messages received per attempt (lengths + tool-role contents). */
  received: { length: number; tools: string[] }[] = [];
  constructor(private readonly script: Step[]) {}

  isAvailable(): boolean {
    return true;
  }

  listModels(): ModelDef[] {
    return [testModel()];
  }

  async *streamResponse(_request: StreamRequest): AsyncGenerator<ProviderEvent> {
    this.received.push({
      length: _request.messages.length,
      tools: _request.messages
        .filter((m) => m.role === 'tool')
        .map((m) => (typeof m.content === 'string' ? m.content : '')),
    });
    const step = this.script[this.calls++] ?? 'ok';
    if (step === 'transient') {
      // Production shape post-fix: the provider already mapped raw stderr to
      // the honest banner; the registry must still recognize it as retriable.
      yield { type: 'error', error: codexTransientFailureMessage() };
      return;
    }
    if (step === 'auth') {
      yield { type: 'error', error: AUTH_MESSAGE };
      return;
    }
    if (step === 'throw-transient') {
      throw new Error('socket hang up');
    }
    if (step === 'turn-token') {
      // Production shape pre-mapping: the raw bridge stale-binding text as it
      // can surface from a turn. The registry must recognize it as retriable
      // even before the provider maps it to the honest banner.
      yield { type: 'error', error: TURN_TOKEN_MESSAGE };
      return;
    }
    if (step === 'partial-token') {
      // Mid-turn transport death after real progress: two native tools
      // completed, then the token died. The retry must resume with both
      // results in context instead of redoing them.
      yield {
        type: 'tool_executed',
        toolName: 'codex_command',
        toolInput: JSON.stringify({ command: 'pwd' }),
        toolOutput: '/Users/Shared/micah/Documents/koryphaios',
        isError: false,
      };
      yield {
        type: 'tool_executed',
        toolName: 'codex_command',
        toolInput: JSON.stringify({ command: 'git status --short' }),
        toolOutput: `${'M backend/src/kory/skills.ts\n'.repeat(500)}trailer`,
        isError: false,
      };
      yield { type: 'error', error: TURN_TOKEN_MESSAGE };
      return;
    }
    yield { type: 'content_delta', content: 'hello' };
    yield { type: 'complete', finishReason: 'end_turn' };
  }
}

function registryWith(stub: ScriptedCodexStub): ProviderRegistry {
  const registry = new ProviderRegistry();
  registry.registerRemoteProvider(stub);
  return registry;
}

/** Stub custom Anthropic-kind route that answers the first attempt with the
 *  reported in-stream `error` frame. Mirrors production: the provider catches
 *  the SDK error and yields `safeProviderFailureMessage`, so the registry only
 *  ever sees the formatted banner. */
class ScriptedSseBlipStub implements Provider {
  readonly name = 'custom:conduit' as ProviderName;
  readonly config: ProviderConfig = {};
  calls = 0;

  constructor(private readonly alwaysFail: ProviderEvent[] = []) {}

  isAvailable(): boolean {
    return true;
  }

  listModels(): ModelDef[] {
    return [{ ...testModel(), id: 'test-conduit-model', provider: 'custom:conduit' }];
  }

  async *streamResponse(_request: StreamRequest): AsyncGenerator<ProviderEvent> {
    this.calls += 1;
    const scripted = this.alwaysFail[this.calls - 1];
    if (scripted) {
      yield scripted;
      return;
    }
    if (this.calls === 1) {
      // Anthropic SDK `streaming.ts`: `APIError.generate(undefined, 'SSE Error: …')`
      // — thrown from an open stream, so there is no HTTP status to retry on.
      const err = new Error(SSE_API_ERROR_FRAME);
      const diagnostic = safeProviderDiagnostic(this.name, 'sdk', err);
      yield { type: 'error', error: safeProviderFailureMessage(this.name, diagnostic) };
      return;
    }
    yield { type: 'content_delta', content: 'hello' };
    yield { type: 'complete', finishReason: 'end_turn' };
  }
}

const SSE_API_ERROR_FRAME =
  'Error:{"type":"error","error":{"type":"api_error","message":"Temporary service interruption. Retry the last turn; your conversation and tool state are preserved."}}:SSE Error: {"type":"error","error":{"type":"api_error",…';

async function collect(
  registry: ProviderRegistry,
): Promise<{ events: ProviderEvent[]; errors: string[] }> {
  const events: ProviderEvent[] = [];
  for await (const event of registry.executeWithRetry(
    {
      model: 'test-codex-model',
      messages: [{ role: 'user', content: 'hi' }],
      systemPrompt: '',
    },
    'codex',
  )) {
    events.push(event);
  }
  return {
    events,
    errors: events.filter((e) => e.type === 'error').map((e) => e.error ?? ''),
  };
}

describe('executeWithRetry yielded-error retry', () => {
  test('retries a yielded transient codex error and streams the recovery', async () => {
    const stub = new ScriptedCodexStub(['transient', 'ok']);
    const { events, errors } = await collect(registryWith(stub));
    expect(stub.calls).toBe(2);
    expect(errors).toEqual([]);
    expect(events.some((e) => e.type === 'complete')).toBe(true);
    expect(
      events
        .filter((e) => e.type === 'content_delta')
        .map((e) => e.content)
        .join(''),
    ).toBe('hello');
  });

  test('does not retry a yielded auth error', async () => {
    const stub = new ScriptedCodexStub(['auth']);
    const { errors } = await collect(registryWith(stub));
    expect(stub.calls).toBe(1);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('authentication failed');
  });

  test('retries a thrown transient error on the same model', async () => {
    const stub = new ScriptedCodexStub(['throw-transient', 'ok']);
    const { events, errors } = await collect(registryWith(stub));
    expect(stub.calls).toBe(2);
    expect(errors).toEqual([]);
    expect(events.some((e) => e.type === 'complete')).toBe(true);
  });

  test('exhausted transient retries yield one honest banner with the attempt count', async () => {
    const stub = new ScriptedCodexStub(['transient', 'transient', 'transient']);
    const { errors } = await collect(registryWith(stub));
    expect(stub.calls).toBe(3);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('transient ChatGPT disconnect');
    expect(errors[0]).toContain('after 3 attempts');
    expect(errors[0]).toContain('Nothing was lost');
  });

  test('retries a stale turn-token binding with a fresh attempt', async () => {
    const stub = new ScriptedCodexStub(['turn-token', 'ok']);
    const registry = registryWith(stub);
    const { events, errors } = await collect(registry);
    expect(stub.calls).toBe(2);
    expect(errors).toEqual([]);
    expect(events.some((e) => e.type === 'complete')).toBe(true);
    expect(registry.getRetryCauseCounts()).toEqual({ 'codex:turn-token-stale-binding': 1 });
  });

  test('resumes a partial turn with completed tool results, truncated', async () => {
    const stub = new ScriptedCodexStub(['partial-token', 'ok']);
    const registry = registryWith(stub);
    const { events, errors } = await collect(registry);
    expect(stub.calls).toBe(2);
    expect(errors).toEqual([]);
    expect(events.some((e) => e.type === 'complete')).toBe(true);
    // First attempt saw the bare prompt; the retry carries both tool results.
    expect(stub.received[0]?.length).toBe(1);
    expect(stub.received[1]?.length).toBe(3);
    const carried = stub.received[1]?.tools ?? [];
    expect(carried).toHaveLength(2);
    expect(carried[0]).toContain('/Users/Shared/micah/Documents/koryphaios');
    // The 15k-char git output is truncated with an honest marker.
    expect(carried[1]).toContain('…[truncated ');
    expect(carried[1]?.length ?? 0).toBeLessThan(3000);
    expect(registry.getRetryCauseCounts()).toEqual({ 'codex:turn-token-stale-binding': 1 });
  });

  test('isRetriableProviderError covers the reported stderr and stays closed on auth', () => {
    const registry = new ProviderRegistry();
    expect(
      registry.isRetriableProviderError(
        "Reconnecting... 1/5 (stream disconnected before completion: ChatGPT ended the turn with 'Something went wrong'. Retry the turn.)",
      ),
    ).toBe(true);
    expect(registry.isRetriableProviderError(codexTransientFailureMessage())).toBe(true);
    expect(registry.isRetriableProviderError(TURN_TOKEN_MESSAGE)).toBe(true);
    expect(registry.isRetriableProviderError('turn token is invalid or expired')).toBe(true);
    expect(
      registry.isRetriableProviderError(
        'This turn_token was issued for Codex turn 92bb8870a17a, which has already finished. This Codex Native action can no longer run.',
      ),
    ).toBe(true);
    expect(registry.isRetriableProviderError(AUTH_MESSAGE)).toBe(false);
    expect(
      registry.isRetriableProviderError(
        'Codex CLI is not signed in. Run `codex login` in your terminal, then reconnect.',
      ),
    ).toBe(false);
    expect(registry.isRetriableProviderError('invalid api key')).toBe(false);
    expect(registry.isRetriableProviderError(new Error('socket hang up'))).toBe(true);
  });

  test('retries a statusless in-stream api_error instead of killing the turn', async () => {
    // The reported failure: a custom route answered an open SSE stream with an
    // `api_error` frame, the SDK threw without a status, and the turn died on
    // the first blip with no retry and no fallback.
    const stub = new ScriptedSseBlipStub();
    const registry = new ProviderRegistry();
    registry.registerRemoteProvider(stub);
    const events: ProviderEvent[] = [];
    for await (const event of registry.executeWithRetry(
      {
        model: 'test-conduit-model',
        messages: [{ role: 'user', content: 'hi' }],
        systemPrompt: '',
      },
      'custom:conduit',
    )) {
      events.push(event);
    }
    expect(stub.calls).toBe(2);
    expect(events.filter((e) => e.type === 'error')).toEqual([]);
    expect(events.some((e) => e.type === 'complete')).toBe(true);
    expect(registry.getRetryCauseCounts()).toEqual({ 'custom:conduit:transient': 1 });
  });

  test('exhausted retries on a non-codex provider end in one honest banner', async () => {
    // The provider keeps interrupting; the user gets one banner that states the
    // provider's own reason and how many attempts were made, not a stack of
    // per-attempt failures.
    const blip: ProviderEvent = {
      type: 'error',
      error: 'gateway dropped the stream',
      errorTransient: true,
    };
    const provider = new ScriptedSseBlipStub([blip, blip, blip]);
    const registry = new ProviderRegistry();
    registry.registerRemoteProvider(provider);
    const events: ProviderEvent[] = [];
    for await (const event of registry.executeWithRetry(
      {
        model: 'test-conduit-model',
        messages: [{ role: 'user', content: 'hi' }],
        systemPrompt: '',
      },
      'custom:conduit',
    )) {
      events.push(event);
    }
    expect(provider.calls).toBe(3);
    const errors = events.filter((e) => e.type === 'error');
    expect(errors).toHaveLength(1);
    expect(errors[0].error).toContain('gateway dropped the stream');
    expect(errors[0].error).toContain('3 attempts');
    expect(errors[0].error).not.toContain('empty response');
  });

  test('isRetriableProviderError retries a statusless in-stream api_error', () => {
    const registry = new ProviderRegistry();
    // The custom conduit route answered an open SSE stream with an `error` frame,
    // so the SDK threw an APIError with no status and the turn died unretried.
    const diagnostic = safeProviderDiagnostic(
      'custom:conduit',
      'sdk',
      new Error(SSE_API_ERROR_FRAME),
    );
    expect(diagnostic.status).toBeUndefined();
    expect(
      registry.isRetriableProviderError(safeProviderFailureMessage('custom:conduit', diagnostic)),
    ).toBe(true);
    // Rejections and credential problems inside the same envelope stay closed.
    expect(
      registry.isRetriableProviderError(
        '{"type":"error","error":{"type":"invalid_request_error","message":"max_tokens is too large"}}',
      ),
    ).toBe(false);
    expect(
      registry.isRetriableProviderError(
        '{"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"}}',
      ),
    ).toBe(false);
  });
});
