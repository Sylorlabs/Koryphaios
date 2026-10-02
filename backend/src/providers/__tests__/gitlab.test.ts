import { afterEach, describe, expect, it } from 'bun:test';
import type { ProviderConfig } from '@koryphaios/shared';
import {
  GITLAB_DUO_BASE_URL,
  GitLabProvider,
  normalizeGitLabBaseUrl,
  verifyGitLabDuoAccess,
} from '../gitlab';
import type { ProviderEvent, ProviderToolDef, StreamRequest } from '../types';

const originalFetch = globalThis.fetch;

function config(overrides: Partial<ProviderConfig> = {}): ProviderConfig {
  return {
    name: 'gitlab',
    disabled: false,
    apiKey: 'synthetic-pat',
    ...overrides,
  } as ProviderConfig;
}

type Capture = { url: string; headers: Headers; body: Record<string, unknown> };

function captureFetch(response: () => Response): { calls: Capture[] } {
  const calls: Capture[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({
      url: String(input),
      headers: new Headers(init?.headers),
      body: JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>,
    });
    return response();
  }) as typeof fetch;
  return { calls };
}

async function collect(
  provider: GitLabProvider,
  request: Partial<StreamRequest> = {},
): Promise<{ events: ProviderEvent[]; text: string; error?: string }> {
  const events: ProviderEvent[] = [];
  for await (const event of provider.streamResponse({
    model: 'duo',
    systemPrompt: 'Be terse.',
    messages: [{ role: 'user', content: 'Why is the build red?' }],
    ...request,
  })) {
    events.push(event);
  }
  return {
    events,
    text: events
      .filter((event) => event.type === 'content_delta')
      .map((event) => event.content)
      .join(''),
    error: events.find((event) => event.type === 'error')?.error,
  };
}

const answer = (text: string) => () =>
  new Response(JSON.stringify(text), {
    status: 201,
    headers: { 'content-type': 'application/json' },
  });

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe('GitLab Duo provider', () => {
  it('exposes the single server-selected Duo model instead of a guessed catalog', () => {
    const models = new GitLabProvider(config()).listModels();
    expect(models).toHaveLength(1);
    expect(models[0]).toMatchObject({ id: 'duo', name: 'GitLab Duo', supportsStreaming: false });
    expect(new GitLabProvider(config()).getModelDiscoveryError()).toContain('server-side');
  });

  it('requires a token and honours the disabled flag', () => {
    expect(new GitLabProvider(config()).isAvailable()).toBe(true);
    expect(new GitLabProvider(config({ apiKey: undefined })).isAvailable()).toBe(false);
    expect(new GitLabProvider(config({ disabled: true })).isAvailable()).toBe(false);
  });

  it('sends the documented body to the chat endpoint with a PAT bearer', async () => {
    const { calls } = captureFetch(answer('Because the linter is red.'));
    const result = await collect(new GitLabProvider(config()));

    expect(result.error).toBeUndefined();
    expect(result.text).toBe('Because the linter is red.');
    expect(result.events.at(-1)).toEqual({ type: 'complete', finishReason: 'stop' });
    expect(calls[0].url).toBe(`${GITLAB_DUO_BASE_URL}/chat/completions`);
    expect(calls[0].headers.get('authorization')).toBe('Bearer synthetic-pat');
    expect(calls[0].body).toEqual({
      content: 'Why is the build red?',
      additional_context: [
        { category: 'file', id: 'koryphaios-system-instructions', content: 'Be terse.' },
      ],
      with_clean_history: false,
    });
  });

  it('honours a self-managed instance base URL', async () => {
    const { calls } = captureFetch(answer('ok'));
    await collect(new GitLabProvider(config({ baseUrl: 'https://gitlab.example.com/api/v4/' })));
    expect(calls[0].url).toBe('https://gitlab.example.com/api/v4/chat/completions');
  });

  it('keeps history, tool protocol, and tool results in additional_context', async () => {
    const { calls } = captureFetch(answer('ok'));
    await collect(new GitLabProvider(config()), {
      systemPrompt: 'Rules.',
      messages: [
        { role: 'user', content: 'First question' },
        { role: 'assistant', content: 'First answer' },
        { role: 'tool', content: 'tool output' },
        { role: 'user', content: 'Second question' },
      ],
      tools: [
        {
          name: 'read_file',
          description: 'Read a file',
          inputSchema: { type: 'object', properties: { path: { type: 'string' } } },
        },
      ],
    });

    expect(calls[0].body.content).toBe('Second question');
    const context = calls[0].body.additional_context as Array<Record<string, unknown>>;
    expect(context.map((item) => item.id)).toEqual([
      'koryphaios-system-instructions',
      'user-turn-1',
      'assistant-turn-2',
      'tool-turn-3',
      'koryphaios-tool-protocol',
    ]);
    expect(context.every((item) => item.category === 'file')).toBe(true);
  });

  it('carries an over-long question in full instead of dropping the tail', async () => {
    const { calls } = captureFetch(answer('ok'));
    const question = 'q'.repeat(1400);
    await collect(new GitLabProvider(config()), {
      systemPrompt: '',
      messages: [{ role: 'user', content: question }],
    });

    expect(calls[0].body.content).toHaveLength(1000);
    const context = calls[0].body.additional_context as Array<Record<string, unknown>>;
    expect(context).toEqual([
      { category: 'file', id: 'current-question-full-text', content: question },
    ]);
  });

  it('announces dropped image attachments instead of losing them silently', async () => {
    const { calls } = captureFetch(answer('ok'));
    await collect(new GitLabProvider(config()), {
      systemPrompt: '',
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'what is this' },
            { type: 'image', imageData: 'AAAA', imageMimeType: 'image/png' },
          ],
        },
      ],
    });

    expect(calls[0].body.content).toContain('1 image attachment omitted');
  });

  it('resets Duo history for a forced-fresh conversation', async () => {
    const { calls } = captureFetch(answer('ok'));
    await collect(new GitLabProvider(config()), { forceFreshConversation: true });
    expect(calls[0].body.with_clean_history).toBe(true);
  });

  it('surfaces a text-protocol tool call instead of leaking it as chat text', async () => {
    const tools: ProviderToolDef[] = [
      {
        name: 'read_file',
        description: 'Read a file',
        inputSchema: { type: 'object', properties: { path: { type: 'string' } } },
      },
    ];
    const { calls } = captureFetch(
      answer(
        '<<TOOL_CALL>>{"tool":"read_file","arguments":{"path":"src/index.ts"}}<<END_TOOL_CALL>>',
      ),
    );
    const result = await collect(new GitLabProvider(config()), { tools });

    expect(result.text).toBe('');
    expect(calls).toHaveLength(1);
    const call = result.events.find((event) => event.type === 'tool_use_start');
    expect(call).toMatchObject({ toolName: 'read_file' });
    expect(result.events.at(-1)).toEqual({ type: 'complete', finishReason: 'tool_use' });
  });

  it('fails closed without a token and never reaches the network', async () => {
    const { calls } = captureFetch(answer('ok'));
    const result = await collect(new GitLabProvider(config({ apiKey: undefined })));
    expect(result.error).toContain('personal access token');
    expect(calls).toHaveLength(0);
  });

  it.each([
    [401, 'HTTP 401', false],
    [403, '`ai_features`', false],
    [404, 'access_rest_chat', false],
    [429, 'rate limited', true],
    [503, 'HTTP 503', true],
  ])('maps HTTP %i to an actionable error', async (status, expected, transient) => {
    captureFetch(
      () =>
        new Response(JSON.stringify({ message: 'nope' }), {
          status,
          headers: { 'content-type': 'application/json' },
        }),
    );
    const result = await collect(new GitLabProvider(config()));
    expect(result.error).toContain(expected);
    expect(result.events.at(-1)).toMatchObject({ type: 'error', errorTransient: transient });
  });

  it('treats an empty answer as a transient upstream failure', async () => {
    captureFetch(answer('   '));
    const result = await collect(new GitLabProvider(config()));
    expect(result.error).toContain('empty answer');
    expect(result.events.at(-1)).toMatchObject({ errorTransient: true });
  });
});

describe('normalizeGitLabBaseUrl', () => {
  it.each([
    ['https://gitlab.com/api/v4', 'https://gitlab.com/api/v4'],
    ['https://gitlab.com/api/v4/', 'https://gitlab.com/api/v4'],
    ['  https://gitlab.com/api/v4  ', 'https://gitlab.com/api/v4'],
    // A bare host, an instance under a relative URL root, and a pasted chat
    // endpoint all have to reduce to the same API root.
    ['https://gitlab.example.com', 'https://gitlab.example.com/api/v4'],
    ['https://example.com/gitlab', 'https://example.com/gitlab/api/v4'],
    ['https://example.com/gitlab/', 'https://example.com/gitlab/api/v4'],
    ['https://gitlab.example.com/api/v4/chat/completions', 'https://gitlab.example.com/api/v4'],
    ['http://localhost:8929', 'http://localhost:8929/api/v4'],
  ])('reduces %s to the API root', (input, expected) => {
    expect(normalizeGitLabBaseUrl(input)).toBe(expected);
  });

  it('drops query and fragment so they cannot corrupt the request path', () => {
    expect(normalizeGitLabBaseUrl('https://gitlab.example.com/?tab=1#x')).toBe(
      'https://gitlab.example.com/api/v4',
    );
  });

  it.each(['gitlab.example.com', '', '   ', 'ftp://gitlab.example.com'])('rejects %p', (input) => {
    expect(() => normalizeGitLabBaseUrl(input)).toThrow();
  });
});

describe('verifyGitLabDuoAccess', () => {
  it('requires a token before probing', async () => {
    const { calls } = captureFetch(answer('pong'));
    const result = await verifyGitLabDuoAccess(config({ apiKey: undefined }));
    expect(result.success).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it('probes the chat endpoint with a clean one-word question', async () => {
    const { calls } = captureFetch(answer('pong'));
    const result = await verifyGitLabDuoAccess(config());
    expect(result).toEqual({ success: true });
    expect(calls[0].url).toBe(`${GITLAB_DUO_BASE_URL}/chat/completions`);
    expect(calls[0].body).toEqual({ content: 'ping', with_clean_history: true });
  });

  it('explains a gated instance instead of reporting a generic failure', async () => {
    captureFetch(() => new Response('{}', { status: 404 }));
    const result = await verifyGitLabDuoAccess(config());
    expect(result.success).toBe(false);
    expect(result.error).toContain('GitLab team members');
  });
});
