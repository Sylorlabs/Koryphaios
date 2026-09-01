import { describe, expect, mock, test } from 'bun:test';
import type { SessionTurnAdmission } from '../../kory/manager';

process.env.NODE_ENV = 'test';
process.env.SESSION_TOKEN_SECRET =
  process.env.SESSION_TOKEN_SECRET ?? 'test_only_not_for_production_aaaaaaaaaa';

const { Elysia } = await import('elysia');
const { localAuth } = await import('../../auth/local-auth');
const { buildLocalBearerToken } = await import('../../auth/local-route-auth');
const { setContext } = await import('../../context');
const { errorHandler } = await import('../../middleware/error-handling');
const { messageRoutes } = await import('./messages');

const app = new Elysia().onError(errorHandler).use(messageRoutes);

function request(body: unknown, path = '/api/messages'): Request {
  return new Request(`http://localhost${path}`, {
    method: 'POST',
    headers: {
      Authorization: buildLocalBearerToken(localAuth.createSession(['*'])),
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
}

function admission(runId = 'run-admitted-1'): SessionTurnAdmission {
  return {
    sessionId: 'session-1',
    runId,
    signal: new AbortController().signal,
  };
}

function context(input: {
  messages: Record<string, unknown>;
  kory: Record<string, unknown>;
  sessions?: Record<string, unknown>;
}) {
  setContext({
    sessions: input.sessions ?? {
      get: async () => ({ id: 'session-1', interactionMode: 'act' }),
    },
    messages: input.messages,
    providers: { getConfigs: () => ({}), get: () => undefined },
    kory: {
      generateSessionTitle: async () => undefined,
      ...input.kory,
    },
    wsManager: { broadcast: () => undefined, broadcastToSession: () => undefined },
  } as never);
}

const regenerationHistory = [
  {
    id: 'prompt-1',
    sessionId: 'session-1',
    role: 'user',
    content: 'Original prompt',
    createdAt: 1,
  },
  {
    id: 'assistant-1',
    sessionId: 'session-1',
    role: 'assistant',
    content: 'Original response',
    createdAt: 2,
  },
];

const regenerationCandidate = {
  target: regenerationHistory[1]!,
  prompt: regenerationHistory[0]!,
  boundary: { messageId: 'assistant-1', contextRevision: 0 },
  providerConversationRevision: 0,
};

const regenerationBranch = {
  sessionId: 'session-1',
  targetMessageId: 'assistant-1',
  promptMessageId: 'prompt-1',
  expectedActiveMessageId: 'assistant-1',
  expectedProviderConversationRevision: 0,
  contextRevision: 0,
  groupId: 'response-prompt-1',
  index: 1,
};

describe('message turn admission', () => {
  test('returns the authoritative message projection and variant CAS boundary', async () => {
    context({
      messages: {
        getDisplayProjection: async () => ({
          messages: [
            {
              id: 'prompt-1',
              sessionId: 'session-1',
              role: 'user',
              content: 'Prompt',
              isActiveBranch: true,
              createdAt: 1,
            },
            {
              id: 'assistant-old',
              sessionId: 'session-1',
              role: 'assistant',
              content: 'Old response',
              isActiveBranch: false,
              createdAt: 2,
            },
          ],
          activeMessageId: 'assistant-new',
          conversationRevision: 3,
          providerConversationRevision: 7,
        }),
      },
      kory: {},
    });

    const response = await app.handle(
      new Request('http://localhost/api/messages/session-1', {
        headers: { Authorization: buildLocalBearerToken(localAuth.createSession(['*'])) },
      }),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      ok: true,
      data: {
        messages: [
          expect.objectContaining({ id: 'prompt-1', isActiveBranch: true }),
          expect.objectContaining({ id: 'assistant-old', isActiveBranch: false }),
        ],
        activeMessageId: 'assistant-new',
        conversationRevision: 3,
        providerConversationRevision: 7,
      },
    });
  });

  test('activates a response variant only while holding the session mutation barrier', async () => {
    const release = mock(() => undefined);
    const activateResponseVariant = mock(async () => ({
      previousActiveMessageId: 'answer-new',
      activeMessageId: 'answer-old',
      conversationRevision: 2,
      providerConversationRevision: 5,
      rewoundMessageCount: 2,
    }));
    context({
      messages: { activateResponseVariant },
      kory: { tryAcquireSessionMutationBarrier: () => ({ release }) },
    });
    const body = {
      sessionId: 'session-1',
      messageId: 'answer-old',
      expectedActiveMessageId: 'answer-new',
      expectedProviderConversationRevision: 4,
    };

    const response = await app.handle(request(body, '/api/messages/variant'));

    expect(response.status).toBe(200);
    expect(activateResponseVariant).toHaveBeenCalledWith(body);
    expect(release).toHaveBeenCalledTimes(1);
    expect(await response.json()).toEqual({
      ok: true,
      data: {
        previousActiveMessageId: 'answer-new',
        activeMessageId: 'answer-old',
        conversationRevision: 2,
        providerConversationRevision: 5,
        rewoundMessageCount: 2,
      },
    });
  });

  test('rejects response variant activation while session work is active', async () => {
    const activateResponseVariant = mock(async () => undefined);
    context({
      messages: { activateResponseVariant },
      kory: { tryAcquireSessionMutationBarrier: () => null },
    });

    const response = await app.handle(
      request(
        {
          sessionId: 'session-1',
          messageId: 'answer-old',
          expectedActiveMessageId: 'answer-new',
          expectedProviderConversationRevision: 4,
        },
        '/api/messages/variant',
      ),
    );

    expect(response.status).toBe(409);
    expect(activateResponseVariant).not.toHaveBeenCalled();
  });

  test('requires local authentication before response variant activation', async () => {
    const activateResponseVariant = mock(async () => undefined);
    context({
      messages: { activateResponseVariant },
      kory: { tryAcquireSessionMutationBarrier: () => ({ release: () => undefined }) },
    });

    const response = await app.handle(
      new Request('http://localhost/api/messages/variant', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sessionId: 'session-1',
          messageId: 'answer-old',
          expectedActiveMessageId: 'answer-new',
          expectedProviderConversationRevision: 4,
        }),
      }),
    );

    expect(response.status).toBe(401);
    expect(activateResponseVariant).not.toHaveBeenCalled();
  });

  test('returns 409 before deleting history from an archived chat', async () => {
    const deleteMessage = mock(async () => true);
    context({
      sessions: {
        get: async () => ({ id: 'session-1', archivedAt: 1_000 }),
      },
      messages: { deleteMessage },
      kory: {},
    });

    const response = await app.handle(
      new Request('http://localhost/api/messages/session-1/message-1', {
        method: 'DELETE',
        headers: { Authorization: buildLocalBearerToken(localAuth.createSession(['*'])) },
      }),
    );

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      ok: false,
      error: 'Recover this archived chat before deleting messages.',
    });
    expect(deleteMessage).not.toHaveBeenCalled();
  });

  test('returns 409 instead of mutating message lineage during active work', async () => {
    const deleteMessage = mock(async () => true);
    context({
      messages: { deleteMessage },
      kory: { tryAcquireSessionMutationBarrier: () => null },
    });

    const response = await app.handle(
      new Request('http://localhost/api/messages/session-1/message-1', {
        method: 'DELETE',
        headers: { Authorization: buildLocalBearerToken(localAuth.createSession(['*'])) },
      }),
    );

    expect(response.status).toBe(409);
    expect(deleteMessage).not.toHaveBeenCalled();
  });

  test('returns 409 for a busy normal send without persisting or dispatching', async () => {
    const add = mock(async () => undefined);
    const dispatchAdmittedTask = mock(async () => undefined);
    const reserveSessionTurn = mock(async () => null);
    context({
      messages: { add },
      kory: {
        reserveSessionTurn,
        dispatchAdmittedTask,
        rejectSessionTurn: async () => undefined,
      },
    });

    const response = await app.handle(
      request({ sessionId: 'session-1', content: 'Do not lose this message' }),
    );

    expect(response.status).toBe(409);
    expect((await response.json()).code).toBe('CONFLICT');
    expect(reserveSessionTurn).toHaveBeenCalledWith('session-1', 'user_turn');
    expect(add).not.toHaveBeenCalled();
    expect(dispatchAdmittedTask).not.toHaveBeenCalled();
  });

  test('returns 409 for busy regeneration without preparing a branch', async () => {
    const prepareRegenerationBranch = mock(async () => ({
      ...regenerationBranch,
    }));
    const dispatchAdmittedTask = mock(async () => undefined);
    const reserveSessionTurn = mock(async () => null);
    context({
      messages: {
        getRegenerationCandidate: async () => regenerationCandidate,
        prepareRegenerationBranch,
      },
      kory: {
        reserveSessionTurn,
        dispatchAdmittedTask,
        rejectSessionTurn: async () => undefined,
      },
    });

    const response = await app.handle(
      request({ sessionId: 'session-1', messageId: 'assistant-1' }, '/api/messages/regenerate'),
    );

    expect(response.status).toBe(409);
    expect(reserveSessionTurn).toHaveBeenCalledWith('session-1', 'regenerate_turn');
    expect(prepareRegenerationBranch).not.toHaveBeenCalled();
    expect(dispatchAdmittedTask).not.toHaveBeenCalled();
  });

  test('prepares a true branch before dispatching regeneration without duplicating the prompt', async () => {
    const order: string[] = [];
    const token = admission('run-regenerate-1');
    const prepareRegenerationBranch = mock(async () => {
      order.push('prepare-branch');
      return {
        ...regenerationBranch,
      };
    });
    const dispatchAdmittedTask = mock(async () => {
      order.push('dispatch');
    });
    context({
      messages: {
        getRegenerationCandidate: async () => regenerationCandidate,
        prepareRegenerationBranch,
      },
      kory: {
        reserveSessionTurn: async () => {
          order.push('reserve');
          return token;
        },
        dispatchAdmittedTask,
        rejectSessionTurn: async () => undefined,
      },
    });

    const response = await app.handle(
      request({ sessionId: 'session-1', messageId: 'assistant-1' }, '/api/messages/regenerate'),
    );

    expect(response.status).toBe(200);
    expect(order).toEqual(['reserve', 'prepare-branch', 'dispatch']);
    expect(prepareRegenerationBranch).toHaveBeenCalledWith({
      sessionId: 'session-1',
      targetMessageId: 'assistant-1',
      promptMessageId: 'prompt-1',
      expectedActiveMessageId: 'assistant-1',
      expectedProviderConversationRevision: 0,
    });
    expect(dispatchAdmittedTask).toHaveBeenCalledWith(token, {
      userMessage: 'Original prompt',
      preferredModel: undefined,
      reasoningLevel: undefined,
      attachments: undefined,
      responseVariant: { groupId: 'response-prompt-1', index: 1 },
      inputAlreadyPersisted: true,
      regenerationBranch,
    });
    expect(await response.json()).toMatchObject({
      ok: true,
      data: { runId: 'run-regenerate-1', groupId: 'response-prompt-1', index: 1 },
    });
  });

  test('reserves before persistence and dispatches the accepted run exactly once', async () => {
    const order: string[] = [];
    const token = admission();
    const reserveSessionTurn = mock(async () => {
      order.push('reserve');
      return token;
    });
    const add = mock(async () => {
      order.push('persist');
    });
    const dispatchAdmittedTask = mock(async () => {
      order.push('dispatch');
    });
    const rejectSessionTurn = mock(async () => undefined);
    context({
      messages: { add },
      kory: {
        reserveSessionTurn,
        dispatchAdmittedTask,
        rejectSessionTurn,
      },
    });

    const response = await app.handle(
      request({
        sessionId: 'session-1',
        content: 'Execute exactly once',
        model: 'openai:gpt-test',
        reasoningLevel: 'high',
        fastMode: true,
        interactionMode: 'plan',
      }),
    );
    const payload = (await response.json()) as {
      ok: boolean;
      data: { status: string; runId: string; messageId: string };
    };

    expect(response.status).toBe(200);
    expect(payload).toEqual({
      ok: true,
      data: { status: 'processing', runId: token.runId, messageId: expect.any(String) },
    });
    expect(order).toEqual(['reserve', 'persist', 'dispatch']);
    expect(reserveSessionTurn).toHaveBeenCalledTimes(1);
    expect(add).toHaveBeenCalledTimes(1);
    expect(dispatchAdmittedTask).toHaveBeenCalledTimes(1);
    expect(dispatchAdmittedTask).toHaveBeenCalledWith(token, {
      userMessage: 'Execute exactly once',
      preferredModel: 'openai:gpt-test',
      reasoningLevel: 'high',
      attachments: undefined,
      interactionMode: 'plan',
      fastMode: true,
      inputAlreadyPersisted: true,
      imageInputMode: 'reject',
    });
    expect(rejectSessionTurn).not.toHaveBeenCalled();
  });

  test('rejects the reserved run when user-message persistence fails', async () => {
    const token = admission('run-persistence-failed');
    const persistenceError = new Error('simulated message store outage');
    const add = mock(async () => {
      throw persistenceError;
    });
    const dispatchAdmittedTask = mock(async () => undefined);
    const rejectSessionTurn = mock(async () => undefined);
    context({
      messages: { add },
      kory: {
        reserveSessionTurn: async () => token,
        dispatchAdmittedTask,
        rejectSessionTurn,
      },
    });

    const response = await app.handle(
      request({ sessionId: 'session-1', content: 'Persistence must be atomic with admission' }),
    );

    expect(response.status).toBe(500);
    expect(add).toHaveBeenCalledTimes(1);
    expect(rejectSessionTurn).toHaveBeenCalledTimes(1);
    expect(rejectSessionTurn).toHaveBeenCalledWith(token, 'user_message_persistence_failed');
    expect(dispatchAdmittedTask).not.toHaveBeenCalled();
  });
});
