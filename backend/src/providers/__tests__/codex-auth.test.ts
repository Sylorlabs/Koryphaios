import { afterAll, describe, expect, it, mock, setDefaultTimeout } from 'bun:test';

// Codex auth tests involve provider instantiation that can be slow under
// parallel test load.
setDefaultTimeout(30000);
import type { KoryphaiosConfig } from '@koryphaios/shared';

const account = mock(async () => ({
  account: { type: 'chatgpt', planType: 'pro' },
  requiresOpenaiAuth: true,
}));
const listModels = mock(async () => [{ model: 'gpt-5.6-sol', displayName: 'GPT-5.6 Sol', isDefault: true }]);

// A successful browser callback reaches setCredentials before a provider
// instance exists. This mock proves the registry validates that path directly
// against the managed app-server and then creates the provider.
mock.module('../codex-app-server', () => ({
  getManagedCodexAppServer: () => ({ account, listModels }),
}));

const { ProviderRegistry } = await import('../registry');
const { CODEX_MANAGED_AUTH_MARKER } = await import('../codex-auth');

function config(): KoryphaiosConfig {
  return {
    providers: {},
    agents: {
      manager: { model: 'gpt-5.6-sol' },
      coder: { model: 'gpt-5.6-sol' },
      task: { model: 'gpt-5.6-sol' },
    },
    server: { port: 3000, host: 'localhost' },
    dataDirectory: '.koryphaios-test',
  };
}

describe('OpenAI Codex managed ChatGPT auth', () => {
  it('rejects API keys because it is not the OpenAI API provider', async () => {
    const registry = new ProviderRegistry(config());
    const result = await registry.setCredentials('codex-auth', { apiKey: 'sk-not-accepted' });

    expect(result.success).toBe(false);
    expect(result.error).toContain('account auth only');
  });

  it('activates a fresh provider from app-server ChatGPT state without raw OAuth tokens', async () => {
    const registry = new ProviderRegistry(config());
    const result = await registry.setCredentials('codex-auth', {
      authToken: CODEX_MANAGED_AUTH_MARKER,
    });

    expect(result).toEqual({ success: true });
    expect(account).toHaveBeenCalledWith(true);
    expect(registry.get('codex-auth')?.isAvailable()).toBe(true);
    expect(registry.get('codex-auth')?.listModels().map((model) => model.apiModelId)).toEqual(['gpt-5.6-sol']);
  });
});

afterAll(() => mock.restore());
