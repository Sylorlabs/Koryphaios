import { describe, expect, it } from 'bun:test';
import { CopilotProvider } from '../copilot';

describe('Copilot model discovery', () => {
  it('does not expose a bundled model list before authenticated discovery', () => {
    const provider = new CopilotProvider({ name: 'copilot', authToken: 'test-token' });
    expect(provider.listModels()).toEqual([]);
  });
});
