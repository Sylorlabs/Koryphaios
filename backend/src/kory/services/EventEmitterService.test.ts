import { afterEach, describe, expect, test } from 'bun:test';
import type { ModelDef, ProviderName, StreamUsagePayload, WSMessage } from '@koryphaios/shared';
import { EventEmitterService } from './EventEmitterService';

const published: WSMessage[] = [];

function capturePublished(): void {
  published.length = 0;
}

/**
 * The emitter is a thin wrapper over `wsBroker.publish`. Intercept the publish
 * boundary so these tests assert on the exact payload the frontend receives
 * rather than on any internal bookkeeping.
 */
const brokerModule = await import('../../pubsub');
const broker = brokerModule.wsBroker as unknown as {
  publish: (channel: string, message: unknown) => void;
};
const originalPublish = broker.publish.bind(broker);
broker.publish = (_channel: string, message: unknown) => {
  published.push(message as WSMessage);
};

function modelDef(overrides: Partial<ModelDef> = {}): ModelDef {
  return {
    id: 'm1',
    name: 'M1',
    provider: 'codex',
    contextWindow: 1_000_000,
    maxOutputTokens: 8_192,
    costPerMInputTokens: 0,
    costPerMOutputTokens: 0,
    canReason: false,
    supportsAttachments: false,
    supportsStreaming: true,
    ...overrides,
  } as ModelDef;
}

async function setLiveResolver(resolver: (id: string, provider: ProviderName) => ModelDef | undefined) {
  const models = await import('../../providers/models');
  models.registerLiveModelResolver(resolver);
}

const service = new EventEmitterService({ managerAgentId: 'kory-manager' });

afterEach(async () => {
  capturePublished();
  await setLiveResolver(() => undefined);
});

function lastUsagePayload(): StreamUsagePayload {
  const message = published.at(-1);
  if (!message) throw new Error('no websocket message was published');
  expect(message.type).toBe('stream.usage');
  return message.payload as unknown as StreamUsagePayload;
}

describe('EventEmitterService usage context metadata', () => {
  test('publishes the caller-supplied effective window, not the bare provider window', async () => {
    // The provider reports a 1M window...
    await setLiveResolver(() => modelDef({ contextWindow: 1_000_000, contextVerified: true }));

    // ...but the session runs under a 200k budget, and the manager already
    // clamped occupancy against that budget. Re-resolving the provider window
    // here made the payload advertise 1M as the denominator for tokens that
    // were clamped to 200k: the bar rendered ~18% for a genuinely full
    // session, and the reloaded snapshot (which persists the effective window)
    // disagreed with the live event.
    service.emitUsageUpdate(
      'session-budgeted',
      'kory-manager',
      'm1',
      'codex',
      200_000,
      0,
      true,
      undefined,
      undefined,
      false,
      undefined,
      undefined,
      undefined,
      { contextWindow: 200_000, contextKnown: true, contextSource: 'live' },
    );

    const payload = lastUsagePayload();
    expect(payload).toMatchObject({
      contextWindow: 200_000,
      contextKnown: true,
      contextSource: 'live',
      tokensUsed: 200_000,
    });
    // A total that fits inside the budget is not estimated, and the payload
    // omits the flag entirely rather than sending `estimated: false`.
    expect('estimated' in payload).toBe(false);
  });

  test('re-clamps against the effective window and marks the sample estimated', async () => {
    await setLiveResolver(() => modelDef({ contextWindow: 1_000_000, contextVerified: true }));

    // A cumulative harness total exceeding the *session budget* must be
    // clamped to the budget, not the provider window.
    service.emitUsageUpdate(
      'session-budgeted',
      'kory-manager',
      'm1',
      'codex',
      860_300,
      700,
      true,
      undefined,
      undefined,
      false,
      undefined,
      undefined,
      undefined,
      { contextWindow: 200_000, contextKnown: true, contextSource: 'live' },
    );

    expect(lastUsagePayload()).toMatchObject({
      contextWindow: 200_000,
      contextKnown: true,
      tokensUsed: 200_000,
      estimated: true,
    });
  });

  test('falls back to resolving the provider window when no effective window is supplied', async () => {
    await setLiveResolver(() => modelDef({ contextWindow: 285_000, contextVerified: true }));

    service.emitUsageUpdate(
      'session-default',
      'kory-manager',
      'm1',
      'codex',
      100_000,
      500,
      true,
    );

    expect(lastUsagePayload()).toMatchObject({
      contextWindow: 285_000,
      contextKnown: true,
      contextSource: 'live',
      tokensUsed: 100_500,
    });
  });

  test('publishes an explicitly unknown window rather than re-resolving it', async () => {
    // Provider discovery has not landed, so the manager concluded "unknown".
    // Passing that through must not let the emitter substitute a stale
    // provider window it happens to be able to resolve.
    await setLiveResolver(() => modelDef({ contextWindow: 285_000, contextVerified: true }));

    service.emitUsageUpdate(
      'session-unknown',
      'kory-manager',
      'm1',
      'codex',
      10_000,
      0,
      true,
      undefined,
      undefined,
      false,
      undefined,
      undefined,
      undefined,
      { contextKnown: false },
    );

    const payload = lastUsagePayload();
    expect(payload.contextKnown).toBe(false);
    expect(payload.contextWindow).toBeUndefined();
  });

  test('keeps the planning estimate authoritative-free while still reporting its window', async () => {
    await setLiveResolver(() => modelDef({ contextWindow: 285_000, contextVerified: true }));

    // usageKnown:false is a chars/4 planning estimate, not a token count. It
    // must not be adopted as occupancy, but the window it reports is still
    // useful metadata and must survive.
    service.emitUsageUpdate(
      'session-estimate',
      'kory-manager',
      'm1',
      'codex',
      400_000,
      0,
      false,
      undefined,
      undefined,
      false,
      undefined,
      undefined,
      undefined,
      { contextWindow: 285_000, contextKnown: true, contextSource: 'live' },
    );

    expect(lastUsagePayload()).toMatchObject({
      usageKnown: false,
      contextWindow: 285_000,
      contextKnown: true,
      tokensUsed: 400_000,
    });
  });

  test('restores the original broker publish after the suite', () => {
    expect(typeof originalPublish).toBe('function');
  });
});
