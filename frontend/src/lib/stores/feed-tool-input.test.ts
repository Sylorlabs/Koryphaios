import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  activeSessionId: '',
  apiFetch: vi.fn(),
  fetchMessages: vi.fn(),
}));

vi.mock('$lib/utils/api-url', () => ({ apiUrl: (path: string) => path }));
vi.mock('$lib/api.svelte', () => ({
  apiFetch: (path: string, init?: RequestInit) => state.apiFetch(path, init),
  parseJsonResponse: async (response: Response) => response.json(),
}));
vi.mock('$lib/stores/sessions.svelte', () => ({
  sessionStore: {
    get activeSessionId() {
      return state.activeSessionId;
    },
    getMessageDisplayBoundary: () => undefined,
    fetchMessages: (...args: unknown[]) => state.fetchMessages(...args),
  },
}));

import { feedStore } from './feed.svelte';

const archived = [
  {
    id: 'arch-1',
    ts: 100,
    type: 'terminal',
    label: 'bash {"command":"git diff"}',
    content: 'diff --git a/x b/x',
    isError: false,
    prunedForAgent: false,
    runRef: { sessionId: 'session-1', runId: 'run-1', revision: 3 },
  },
  {
    id: 'arch-2',
    ts: 200,
    type: 'tool_result',
    label: 'read_file {"path":"/very/long/pa',
    content: 'clipped label input',
    isError: false,
    prunedForAgent: false,
  },
];

function response(path: string): Response {
  if (path.includes('/timetravel')) {
    return new Response(JSON.stringify({ ok: true, data: { timeline: [] } }));
  }
  return new Response(JSON.stringify({ ok: true, lastUsage: null, data: archived }));
}

describe('tool results keep their call input', () => {
  beforeEach(() => {
    state.activeSessionId = 'session-1';
    state.apiFetch.mockReset();
    state.apiFetch.mockImplementation((path: string) => Promise.resolve(response(path)));
    feedStore.activateSessionFeed('session-1');
    feedStore.clearFeed();
  });

  it('looks up the live tool_call input by callId', () => {
    feedStore.addFeedEntry({
      timestamp: 1,
      type: 'tool_call',
      agentId: 'kory-manager',
      agentName: 'Kory',
      glowClass: '',
      text: 'Calling tool: bash',
      metadata: {
        sessionId: 'session-1',
        toolCall: { id: 'call-9', name: 'bash', input: { command: 'ls' } },
      },
    });

    expect(feedStore.findToolCallInput('call-9')).toEqual({
      id: 'call-9',
      name: 'bash',
      input: { command: 'ls' },
    });
    expect(feedStore.findToolCallInput('missing')).toBeUndefined();
  });

  it('recovers the command from a parseable archive label on reload', async () => {
    await feedStore.loadSessionMessages('session-1', []);

    const results = feedStore.feed.filter((entry) => entry.type === 'tool_result');
    expect(results).toHaveLength(2);
    expect(results[0].metadata).toMatchObject({
      toolCall: { id: 'arch-1', name: 'bash', input: { command: 'git diff' } },
      toolResult: { name: 'bash', output: 'diff --git a/x b/x' },
      runRef: { sessionId: 'session-1', runId: 'run-1', revision: 3 },
    });
    // A clipped label must not be shown as if it were the real input.
    expect(results[1].metadata?.toolCall).toBeUndefined();
    expect(results[1].metadata?.toolResult).toMatchObject({ name: 'read_file' });
  });

  it('restores full command input independently of a clipped history label', async () => {
    const command = `bun run verify --filter ${'project-'.repeat(30)}`;
    const toolInput = JSON.stringify({ command, workdir: '/workspace/app' });
    state.apiFetch.mockImplementation((path: string) =>
      Promise.resolve(
        path.includes('/context')
          ? Response.json({
              ok: true,
              data: [{ ...archived[0], label: `bash ${toolInput.slice(0, 140)}`, toolInput }],
            })
          : response(path),
      ),
    );

    await feedStore.loadSessionMessages('session-1', []);

    expect(feedStore.feed).toHaveLength(1);
    expect(feedStore.feed[0].metadata).toMatchObject({
      toolCall: { name: 'bash', input: { command, workdir: '/workspace/app' } },
      toolResult: { output: archived[0].content },
    });
  });
});
