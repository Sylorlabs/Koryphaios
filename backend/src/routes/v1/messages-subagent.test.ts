import { describe, expect, test } from 'bun:test';
import type { StoredMessage, SubagentTranscript } from '@koryphaios/shared';

process.env.NODE_ENV = 'test';
process.env.SESSION_TOKEN_SECRET =
  process.env.SESSION_TOKEN_SECRET ?? 'test_only_not_for_production_aaaaaaaaaa';

const { Elysia } = await import('elysia');
const { localAuth } = await import('../../auth/local-auth');
const { buildLocalBearerToken } = await import('../../auth/local-route-auth');
const { setContext } = await import('../../context');
const { errorHandler } = await import('../../middleware/error-handling');
const { messageRoutes, withDisplayParts, subagentAtPath } = await import('./messages');

const app = new Elysia().onError(errorHandler).use(messageRoutes);

function bearer(): string {
  return buildLocalBearerToken(localAuth.createSession(['*']));
}

const innermost: SubagentTranscript = {
  name: 'summarizer',
  turns: [
    { role: 'user', text: 'Summarize this.' },
    { role: 'assistant', parts: [{ kind: 'text', text: 'Summary.', startedAt: 1 }] },
  ],
};

const outer: SubagentTranscript = {
  agentId: 'agent-1',
  name: 'Explore',
  task: 'Find every caller.',
  model: 'claude-haiku',
  provider: 'claude',
  turns: [
    { role: 'user', text: 'Search the repo.', createdAt: 10 },
    {
      role: 'assistant',
      createdAt: 20,
      parts: [
        { kind: 'text', text: 'Looking.', startedAt: 11 },
        {
          kind: 'tool',
          callId: 'nested-task',
          name: 'Task',
          input: {},
          startedAt: 12,
          endedAt: 13,
          subagent: innermost,
        },
      ],
    },
  ],
};

const storedMessage: StoredMessage = {
  id: 'm-outer',
  sessionId: 'session-1',
  role: 'assistant',
  content: 'Done.',
  createdAt: 5,
  parts: [
    { kind: 'text', text: 'Done.', startedAt: 1 },
    {
      kind: 'tool',
      callId: 'task-1',
      name: 'Task',
      input: { description: 'explore' },
      startedAt: 2,
      endedAt: 3,
      subagent: outer,
    },
  ],
};

function context(
  getById: (sessionId: string, messageId: string) => Promise<StoredMessage | undefined>,
) {
  setContext({
    sessions: { get: async () => ({ id: 'session-1' }) },
    messages: { getById },
    providers: { getConfigs: () => ({}), get: () => undefined },
    kory: {},
    wsManager: { broadcast: () => undefined, broadcastToSession: () => undefined },
  } as never);
}

describe('sub-agent transcript stubs', () => {
  test('withDisplayParts replaces an embedded transcript with a stub ref', () => {
    const projected = withDisplayParts(storedMessage);
    const parts = projected.parts!;
    expect(parts).toHaveLength(2);
    const tool = parts[1] as Extract<(typeof parts)[number], { kind: 'tool' }>;
    expect(tool.subagent).toBeUndefined();
    expect(tool.subagentStub).toEqual({
      name: 'Explore',
      agentId: 'agent-1',
      task: 'Find every caller.',
      model: 'claude-haiku',
      provider: 'claude',
      turnCount: 2,
      ref: { messageId: 'm-outer', path: [1] },
    });
    expect(tool.callId).toBe('task-1');
    expect(tool.output).toBeUndefined();
    // The stored message itself is untouched.
    expect((storedMessage.parts![1] as { subagent?: unknown }).subagent).toBe(outer);
  });

  test('parts without sub-agents pass through untouched', () => {
    const plain: StoredMessage = {
      id: 'm-plain',
      sessionId: 'session-1',
      role: 'assistant',
      content: 'Hi',
      createdAt: 1,
      parts: [
        { kind: 'text', text: 'Hi', startedAt: 1 },
        { kind: 'tool', callId: 'c', name: 'read', input: {}, startedAt: 1 },
      ],
    };
    const projected = withDisplayParts(plain);
    expect(projected.parts![1]).not.toHaveProperty('subagentStub');
    expect(projected.parts![1]).toBe(plain.parts![1]);
  });

  test('subagentAtPath resolves top-level and nested paths', () => {
    expect(subagentAtPath(storedMessage, [1])).toBe(outer);
    expect(subagentAtPath(storedMessage, [1, 1, 1])).toBe(innermost);
    expect(subagentAtPath(storedMessage, [0])).toBeUndefined();
    expect(subagentAtPath(storedMessage, [9])).toBeUndefined();
    expect(subagentAtPath(storedMessage, [1, 0, 0])).toBeUndefined();
    expect(subagentAtPath(storedMessage, [1, 9, 0])).toBeUndefined();
  });

  test('GET resolves a stub path and re-stubs grandchildren', async () => {
    context(async () => storedMessage);
    const response = await app.handle(
      new Request('http://localhost/api/messages/session-1/subagent/m-outer?path=1', {
        headers: { Authorization: bearer() },
      }),
    );
    expect(response.status).toBe(200);
    const body = await response.json();
    const sub = body.data.subagent as SubagentTranscript;
    expect(sub.name).toBe('Explore');
    expect(sub.task).toBe('Find every caller.');
    expect(sub.turns).toHaveLength(2);
    const assistantTurn = sub.turns[1] as Extract<
      SubagentTranscript['turns'][number],
      { role: 'assistant' }
    >;
    const nestedPart = assistantTurn.parts[1] as Extract<
      (typeof assistantTurn.parts)[number],
      { kind: 'tool' }
    >;
    expect(nestedPart.subagent).toBeUndefined();
    expect(nestedPart.subagentStub).toMatchObject({
      name: 'summarizer',
      turnCount: 2,
      ref: { messageId: 'm-outer', path: [1, 1, 1] },
    });
  });

  test('GET resolves a nested path to the grandchild transcript', async () => {
    context(async () => storedMessage);
    const response = await app.handle(
      new Request('http://localhost/api/messages/session-1/subagent/m-outer?path=1,1,1', {
        headers: { Authorization: bearer() },
      }),
    );
    expect(response.status).toBe(200);
    const sub = (await response.json()).data.subagent as SubagentTranscript;
    expect(sub.name).toBe('summarizer');
    expect(sub.turns).toHaveLength(2);
  });

  test('GET rejects malformed and unresolvable paths', async () => {
    context(async () => storedMessage);
    const get = (path: string) =>
      app.handle(
        new Request(`http://localhost/api/messages/session-1/subagent/m-outer?path=${path}`, {
          headers: { Authorization: bearer() },
        }),
      );
    expect((await get('')).status).toBe(400); // empty
    expect((await get('1,1')).status).toBe(400); // dangling turn index
    expect((await get('x')).status).toBe(400); // not a number
    expect((await get('-1')).status).toBe(400); // negative
    expect((await get('1,,1')).status).toBe(400); // empty segment
    expect((await get('1234567')).status).toBe(400); // segment too wide
    expect(
      (await get('1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1')).status,
    ).toBe(400); // too deep
    expect((await get('9')).status).toBe(404); // valid shape, no such part
    expect((await get('0')).status).toBe(404); // text part, not a tool call
  });

  test('GET requires authentication and an existing message', async () => {
    context(async () => storedMessage);
    const unauthenticated = await app.handle(
      new Request('http://localhost/api/messages/session-1/subagent/m-outer?path=1'),
    );
    expect(unauthenticated.status).toBe(401);

    context(async () => undefined);
    const missing = await app.handle(
      new Request('http://localhost/api/messages/session-1/subagent/m-missing?path=1', {
        headers: { Authorization: bearer() },
      }),
    );
    expect(missing.status).toBe(404);
  });
});
