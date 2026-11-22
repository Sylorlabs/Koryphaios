// A multi-request CLI turn must bill the cumulative receipt
// (billingTokensIn/Out), never the latest per-request occupancy snapshot the
// meter uses. The meter fold changed how occupancy is derived; this pins the
// billing path so it cannot regress.
process.env.KORY_DISABLE_CLI_AUTODETECT = '1';

import { describe, expect, mock, test } from 'bun:test';
import { ProviderRegistry } from '../registry';
import type { ModelDef, ProviderConfig } from '@koryphaios/shared';
import type { Provider, ProviderEvent, StreamRequest } from '../types';

const recordUsageCalls: unknown[][] = [];
mock.module('../../credit-accountant', () => ({
  recordUsage: (...args: unknown[]) => {
    recordUsageCalls.push(args);
  },
}));

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
  } as ModelDef;
}

class ThreeRequestTurnStub implements Provider {
  readonly name = 'codex' as const;
  readonly config: ProviderConfig = {};
  isAvailable(): boolean {
    return true;
  }
  listModels(): ModelDef[] {
    return [testModel()];
  }
  async *streamResponse(_request: StreamRequest): AsyncGenerator<ProviderEvent> {
    // Three internal requests; each reports that request's context occupancy.
    yield { type: 'usage_update', tokensIn: 10_000, tokensOut: 100 };
    yield { type: 'usage_update', tokensIn: 12_000, tokensOut: 250 };
    yield { type: 'usage_update', tokensIn: 11_500, tokensOut: 400 };
    // Turn receipt: cumulative billing totals, flagged estimated so the meter
    // never mistakes it for occupancy.
    yield {
      type: 'usage_update',
      tokensIn: 33_500,
      tokensOut: 750,
      estimated: true,
      billingTokensIn: 33_500,
      billingTokensOut: 750,
    };
    yield { type: 'content_delta', content: 'done' };
    yield { type: 'complete', finishReason: 'end_turn' };
  }
}

describe('CLI cumulative billing', () => {
  test('a 3-request turn bills the cumulative receipt, not the last snapshot', async () => {
    const registry = new ProviderRegistry();
    registry.registerRemoteProvider(new ThreeRequestTurnStub());
    for await (const _event of registry.executeWithRetry(
      { model: 'test-codex-model', messages: [{ role: 'user', content: 'hi' }], systemPrompt: '' },
      'codex',
    )) {
      // drain
    }
    expect(recordUsageCalls.length).toBe(1);
    const [model, provider, tokensIn, tokensOut] = recordUsageCalls[0] as [
      string,
      string,
      number,
      number,
    ];
    expect(model).toBe('test-codex-model');
    expect(provider).toBe('codex');
    expect(tokensIn).toBe(33_500);
    expect(tokensOut).toBe(750);
  });
});
