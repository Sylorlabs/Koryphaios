import { afterEach, describe, expect, it } from 'bun:test';
import { existsSync, mkdtempSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { JulesProvider } from '../jules';
import { JULES_APPROVAL_REQUIRED_ERROR, runJulesTask } from '../jules-runner';

import { FREEBUFF_UNAVAILABLE_ERROR, FreebuffProvider } from '../freebuff';

const request = {
  model: 'unavailable',
  messages: [{ role: 'user' as const, content: 'change the repository' }],
  systemPrompt: '',
};

async function collectEvents(stream: AsyncGenerator<unknown>): Promise<unknown[]> {
  const events: unknown[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

const originalFetch = globalThis.fetch;
const originalPath = process.env.PATH;

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalPath === undefined) delete process.env.PATH;
  else process.env.PATH = originalPath;
});

describe('Jules fail-closed approval boundary', () => {
  it('does not contact Jules or create a cloud session from the provider adapter', async () => {
    let requests = 0;
    globalThis.fetch = (async () => {
      requests += 1;
      return new Response('{}');
    }) as typeof fetch;
    const provider = new JulesProvider({
      name: 'jules',
      apiKey: 'test-key',
      disabled: false,
    });

    expect(provider.isAvailable()).toBe(false);
    expect(provider.listModels()).toEqual([]);
    const events = await collectEvents(provider.streamResponse(request));
    expect(events).toEqual([{ type: 'error', error: JULES_APPROVAL_REQUIRED_ERROR }]);
    expect(requests).toBe(0);
  });

  it('also blocks the direct delegation runner used outside the provider adapter', async () => {
    let requests = 0;
    globalThis.fetch = (async () => {
      requests += 1;
      return new Response('{}');
    }) as typeof fetch;

    const events = await collectEvents(
      runJulesTask({
        apiKey: 'test-key',
        prompt: 'create a branch and pull request',
        automationMode: 'AUTO_CREATE_PR',
        requirePlanApproval: false,
      }),
    );
    expect(events).toEqual([{ type: 'error', error: JULES_APPROVAL_REQUIRED_ERROR }]);
    expect(requests).toBe(0);
  });
});

describe('Freebuff fail-closed protocol boundary', () => {
  it('does not contact Codebuff or expose reverse-engineered models', async () => {
    let requests = 0;
    globalThis.fetch = (async () => {
      requests += 1;
      return new Response('{}');
    }) as typeof fetch;
    const provider = new FreebuffProvider({
      name: 'freebuff',
      authToken: 'detected-local-login-material',
      disabled: false,
    });

    expect(provider.isAvailable()).toBe(false);
    expect(provider.listModels()).toEqual([]);
    const events = await collectEvents(provider.streamResponse(request));
    expect(events).toEqual([{ type: 'error', error: FREEBUFF_UNAVAILABLE_ERROR }]);
    expect(requests).toBe(0);
  });
});
