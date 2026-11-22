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
  wsManager?: Record<string, unknown>;
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
    wsManager: input.wsManager ?? {
      broadcast: () => undefined,
      broadcastToSession: () => undefined,
    },
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
        reserveSessionTurnAfterSteer: reserveSessionTurn,
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
        reserveSessionTurnAfterSteer: async () => {
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

  test('returns 409 for a busy normal send without dispatching a turn', async () => {
    const startSessionTurn = mock(async () => ({
      accepted: false as const,
      result: {
        sessionId: 'session-1',
        runId: '',
        status: 'rejected' as const,
        phase: 'idle' as const,
        reason: 'session_busy',
      },
    }));
    const dispatchAdmittedTask = mock(async () => undefined);
    context({
      messages: { add: mock(async () => undefined), getById: async () => undefined },
      kory: { startSessionTurn, dispatchAdmittedTask },
    });

    const response = await app.handle(
      request({ sessionId: 'session-1', content: 'Do not lose this message' }),
    );

    expect(response.status).toBe(409);
    expect((await response.json()).code).toBe('CONFLICT');
    expect(startSessionTurn).toHaveBeenCalledTimes(1);
    expect(startSessionTurn).toHaveBeenCalledWith(
      expect.objectContaining({ source: 'user', sourceCommandId: expect.stringMatching(/^srv_/) }),
    );
    expect(dispatchAdmittedTask).not.toHaveBeenCalled();
  });

  test('admits a send without clientMessageId through startSessionTurn with a server-minted id, exactly once', async () => {
    const completion = Promise.resolve({
      sessionId: 'session-1',
      runId: 'run-ledger-1',
      status: 'completed' as const,
      phase: 'done' as const,
      reason: null,
    });
    const startSessionTurn = mock(async () => ({
      accepted: true as const,
      sessionId: 'session-1',
      runId: 'run-ledger-1',
      userMessageId: 'command-user-abc',
      completion,
    }));
    const add = mock(async () => undefined);
    const dispatchAdmittedTask = mock(async () => undefined);
    context({
      messages: { add, addIdempotent: mock(async () => undefined) },
      kory: { startSessionTurn, dispatchAdmittedTask, reserveSessionTurn: mock(async () => null) },
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

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      ok: true,
      data: { status: 'processing', runId: 'run-ledger-1', messageId: 'command-user-abc' },
    });
    expect(startSessionTurn).toHaveBeenCalledTimes(1);
    expect(startSessionTurn).toHaveBeenCalledWith({
      sessionId: 'session-1',
      source: 'user',
      sourceCommandId: expect.stringMatching(/^srv_[A-Za-z0-9_-]{21}$/),
      userMessage: 'Execute exactly once',
      preferredModel: 'openai:gpt-test',
      reasoningLevel: 'high',
      contextWindow: undefined,
      attachments: undefined,
      interactionMode: 'plan',
      fastMode: true,
      speedTier: 'priority',
      modelParameters: undefined,
      fusion: undefined,
      imageInputMode: 'reject',
    });
    // The legacy write and dispatch are gone: one durable path only.
    expect(add).not.toHaveBeenCalled();
    expect(dispatchAdmittedTask).not.toHaveBeenCalled();
  });

  test('a client-supplied clientMessageId is used as the ledger source id unchanged', async () => {
    const startSessionTurn = mock(async () => ({
      accepted: true as const,
      sessionId: 'session-1',
      runId: 'run-ledger-2',
      userMessageId: 'command-user-def',
      completion: Promise.resolve(undefined as never),
    }));
    context({ messages: {}, kory: { startSessionTurn } });

    await app.handle(
      request({ sessionId: 'session-1', content: 'With id', clientMessageId: 'client-id-0001' }),
    );

    expect(startSessionTurn).toHaveBeenCalledWith(
      expect.objectContaining({ sourceCommandId: 'client-id-0001' }),
    );
  });

  test('does not publish a system error when a ledger turn settles with its user cancellation', async () => {
    const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
    const cancellation = new DOMException('Stopped by user', 'AbortError');
    context({
      messages: {},
      kory: {
        startSessionTurn: async () => ({
          accepted: true as const,
          sessionId: 'session-1',
          runId: 'run-cancelled-1',
          userMessageId: 'command-user-cancel',
          completion: Promise.reject(cancellation),
        }),
      },
      wsManager: {
        broadcastToSession: (
          _sessionId: string,
          event: { type: string; payload: Record<string, unknown> },
        ) => {
          events.push(event);
        },
      },
    });

    const response = await app.handle(request({ sessionId: 'session-1', content: 'Stop me' }));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(response.status).toBe(200);
    expect(events.some((event) => event.type === 'system.error')).toBe(false);
  });

  test('continues to publish genuine ledger turn failures', async () => {
    const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
    context({
      messages: {},
      kory: {
        startSessionTurn: async () => ({
          accepted: true as const,
          sessionId: 'session-1',
          runId: 'run-failed-1',
          userMessageId: 'command-user-failed',
          completion: Promise.reject(new Error('Provider request failed')),
        }),
      },
      wsManager: {
        broadcastToSession: (
          _sessionId: string,
          event: { type: string; payload: Record<string, unknown> },
        ) => {
          events.push(event);
        },
      },
    });

    const response = await app.handle(
      request({ sessionId: 'session-1', content: 'Report real errors' }),
    );
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(response.status).toBe(200);
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'system.error',
        payload: expect.objectContaining({
          error: 'Provider request failed',
          sessionId: 'session-1',
        }),
      }),
    );
  });

  test('surfaces a ledger input-persistence failure as a server error and dispatches nothing', async () => {
    const dispatchAdmittedTask = mock(async () => undefined);
    context({
      messages: {},
      kory: {
        startSessionTurn: mock(async () => {
          throw new Error('simulated message store outage');
        }),
        dispatchAdmittedTask,
      },
    });

    const response = await app.handle(
      request({ sessionId: 'session-1', content: 'Persistence must be atomic with admission' }),
    );

    expect(response.status).toBe(500);
    expect(dispatchAdmittedTask).not.toHaveBeenCalled();
  });
});
