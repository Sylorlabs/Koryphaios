import { expect, test } from 'bun:test';
import { ProviderRegistry } from '../registry';

test('remote inference cannot fall through to a native host adapter with the same model ID', async () => {
  let dispatched = false;
  const provider = { name: 'claude', streamResponse: async function* () { dispatched = true; } };
  const registry = Object.create(ProviderRegistry.prototype) as ProviderRegistry;
  (registry as any).resolveProvider = () => provider;
  const events = [];
  for await (const event of registry.executeWithRetry({
    model: 'same-model', requiredProvider: 'openai', systemPrompt: '', messages: [],
  }, 'openai')) events.push(event);
  expect(dispatched).toBe(false);
  expect(events).toEqual([{ type: 'error', error: expect.stringContaining('authorized provider is unavailable') }]);
});
