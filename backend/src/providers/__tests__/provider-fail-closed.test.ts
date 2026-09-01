import { afterEach, describe, expect, it } from 'bun:test';
import { existsSync, mkdtempSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { JulesProvider } from '../jules';
import { JULES_APPROVAL_REQUIRED_ERROR, runJulesTask } from '../jules-runner';

import { FreebuffProvider } from '../freebuff';

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

describe('Freebuff fail-closed without credentials', () => {
  it('does not contact the Codebuff backend when no login material is present', async () => {
    // Ensure no credentials are found on disk: redirect HOME to a temp dir
    // with no manicode config, and clear any env-based auth token.
    const tempHome = mkdtempSync(join(tmpdir(), 'freebuff-no-cred-'));
    const originalHome = process.env.HOME;
    process.env.HOME = tempHome;
    try {
      // Track only Codebuff/backend execution requests — OpenRouter model
      // metadata enrichment is benign and may fire from listModels().
      const codebuffRequests: string[] = [];
      globalThis.fetch = (async (input: RequestInfo | URL) => {
        const url =
          typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        if (/codebuff|manicode|api\.codebuff/i.test(url)) {
          codebuffRequests.push(url);
        }
        return new Response('{}');
      }) as typeof fetch;

      const provider = new FreebuffProvider({
        name: 'freebuff',
        disabled: false,
      });

      // Without credentials the provider is not available. (listModels may
      // return cached entries from a prior test's background refresh — the
      // module-level cache is shared, so we only assert availability here.)
      expect(provider.isAvailable()).toBe(false);
      // Remote model metadata may advertise vision, but the installed
      // Freebuff SDK harness has no verified image transport. It must never
      // present those models as screenshot-capable.
      expect(provider.listModels().every((model) => model.supportsAttachments !== true)).toBe(true);

      // Streaming without credentials yields a login-required error, not a
      // backend execution request.
      const events = await collectEvents(
        provider.streamResponse({
          model: 'openai/gpt-5.6-luna',
          messages: [{ role: 'user' as const, content: 'change the repository' }],
          systemPrompt: '',
        }),
      );
      expect(events).toHaveLength(1);
      expect((events[0] as { type: string; error: string }).type).toBe('error');
      expect((events[0] as { error: string }).error).toMatch(/not logged in/i);
      expect(codebuffRequests).toHaveLength(0);
    } finally {
      process.env.HOME = originalHome;
      rmSync(tempHome, { recursive: true, force: true });
    }
  });
});
