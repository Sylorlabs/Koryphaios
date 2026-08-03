import { describe, expect, it } from 'bun:test';
import { RoutingServiceEnhanced, splitProviderModel } from './RoutingServiceEnhanced';

describe('provider model routing', () => {
  it('preserves account-scoped model IDs containing colons', () => {
    const value = 'codex:codex-account:YWNjb3VudA:gpt-5.6-sol';
    expect(splitProviderModel(value)).toEqual({
      provider: 'codex',
      model: 'codex-account:YWNjb3VudA:gpt-5.6-sol',
    });

    const routing = new RoutingServiceEnhanced({
      config: {
        providers: {},
        agents: {
          manager: { model: 'test' },
          coder: { model: 'test' },
          task: { model: 'test' },
        },
        dataDirectory: '.',
      },
    }).resolveActiveRouting(value);
    expect(routing).toEqual({
      provider: 'codex',
      model: 'codex-account:YWNjb3VudA:gpt-5.6-sol',
    });
  });
});
