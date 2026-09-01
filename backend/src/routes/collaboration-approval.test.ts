import { afterEach, describe, expect, mock, test } from 'bun:test';
import type { PendingPrompt } from '../collaboration/manager';
import type { SessionTurnSubmission } from '../kory/manager';

process.env.NODE_ENV = 'test';
process.env.SESSION_TOKEN_SECRET =
  process.env.SESSION_TOKEN_SECRET ?? 'test_only_not_for_production_aaaaaaaaaa';

const { Elysia } = await import('elysia');
const { localAuth } = await import('../auth/local-auth');
const { buildLocalBearerToken } = await import('../auth/local-route-auth');
const { collaborationManager } = await import('../collaboration/manager');
const { setContext } = await import('../context');
const { errorHandler } = await import('../middleware/error-handling');
const { collaborationRoutes } = await import('./collaboration');

const app = new Elysia().onError(errorHandler).use(collaborationRoutes);
const originalGetPendingPrompt = collaborationManager.getPendingPrompt;
const originalResolveGuestPrompt = collaborationManager.resolveGuestPrompt;
const originalGetSessionState = collaborationManager.getSessionState;

const pending: PendingPrompt = {
  guestId: 'guest-1',
  name: 'Guest',
  role: 'collaborator',
  content: 'Review the durable command boundary.',
  sessionId: 'collaboration-1',
  sourceCommandId: 'collaboration:relay-1:prompt-1',
  timestamp: 1,
  model: 'openai:gpt-5',
  reasoningLevel: 'high',
  commandAllowlist: ['git'],
  commandBlocklist: ['git push'],
};

function approvalRequest(promptId = 'prompt-1', collaborationId = 'collaboration-1'): Request {
  return new Request(`http://localhost/api/collab/${collaborationId}/approve`, {
    method: 'POST',
    headers: {
      Authorization: buildLocalBearerToken(localAuth.createSession(['*'])),
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ promptId, approved: true }),
  });
}

function installPending(
  startSessionTurn: (input: unknown) => Promise<SessionTurnSubmission>,
  resolutionFailure?: Error,
) {
  let retained = true;
  const resolveGuestPrompt = mock(async (promptId: string, approved: boolean) => {
    if (!retained || promptId !== 'prompt-1') return null;
    if (resolutionFailure) throw resolutionFailure;
    retained = false;
    return approved ? pending : null;
  });
  collaborationManager.getPendingPrompt = mock((promptId: string) =>
    retained && promptId === 'prompt-1' ? pending : null,
  );
  collaborationManager.resolveGuestPrompt = resolveGuestPrompt;
  collaborationManager.getSessionState = mock(
    async () =>
      ({
        session: { id: 'collaboration-1', baseSessionId: 'session-1' },
        participants: [],
      }) as never,
  );
  setContext({ kory: { startSessionTurn } } as never);
  return { resolveGuestPrompt };
}

afterEach(() => {
  collaborationManager.getPendingPrompt = originalGetPendingPrompt;
  collaborationManager.resolveGuestPrompt = originalResolveGuestPrompt;
  collaborationManager.getSessionState = originalGetSessionState;
});

describe('collaboration prompt approval', () => {
  test('keeps a busy prompt pending and retries with the exact same source command identity', async () => {
    const startSessionTurn = mock(
      async (_input: unknown) =>
        ({
          accepted: false,
          result: {
            sessionId: 'session-1',
            runId: '',
            status: 'rejected',
            phase: 'streaming',
            reason: 'session_busy',
          },
        }) satisfies SessionTurnSubmission,
    );
    const { resolveGuestPrompt } = installPending(startSessionTurn);

    const first = await app.handle(approvalRequest());
    const second = await app.handle(approvalRequest());

    expect(first.status).toBe(409);
    expect(second.status).toBe(409);
    expect(await first.json()).toMatchObject({
      ok: false,
      error: expect.stringContaining('remains pending'),
    });
    expect(resolveGuestPrompt).not.toHaveBeenCalled();
    expect(startSessionTurn).toHaveBeenCalledTimes(2);
    expect(startSessionTurn.mock.calls.map(([input]) => input)).toEqual([
      expect.objectContaining({
        sessionId: 'session-1',
        source: 'collaboration',
        sourceCommandId: pending.sourceCommandId,
      }),
      expect.objectContaining({
        sessionId: 'session-1',
        source: 'collaboration',
        sourceCommandId: pending.sourceCommandId,
      }),
    ]);
  });

  test('does not report an interrupted durable command as approved or replay it', async () => {
    const startSessionTurn = mock(
      async (_input: unknown) =>
        ({
          accepted: false,
          result: {
            sessionId: 'session-1',
            runId: 'run-interrupted',
            status: 'failed',
            phase: 'error',
            reason: 'command_execution_was_interrupted; explicit retry required',
          },
        }) satisfies SessionTurnSubmission,
    );
    const { resolveGuestPrompt } = installPending(startSessionTurn);

    const response = await app.handle(approvalRequest());

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      ok: false,
      error: expect.stringContaining('was not replayed'),
    });
    expect(resolveGuestPrompt).not.toHaveBeenCalled();
    expect(startSessionTurn).toHaveBeenCalledTimes(1);
  });

  test('acknowledges an already-persisted response without dispatching another turn', async () => {
    const startSessionTurn = mock(
      async (_input: unknown) =>
        ({
          accepted: false,
          result: {
            sessionId: 'session-1',
            runId: '',
            status: 'completed',
            phase: 'done',
            reason: 'command_response_already_persisted',
          },
        }) satisfies SessionTurnSubmission,
    );
    const { resolveGuestPrompt } = installPending(startSessionTurn);

    const response = await app.handle(approvalRequest());

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      ok: true,
      data: { approved: true, prompt: { sourceCommandId: pending.sourceCommandId } },
    });
    expect(resolveGuestPrompt).toHaveBeenCalledWith('prompt-1', true);
  });

  test('does not acknowledge approval when durable prompt removal fails', async () => {
    const startSessionTurn = mock(
      async (_input: unknown) =>
        ({
          accepted: true,
          sessionId: 'session-1',
          runId: 'run-1',
          completion: Promise.resolve({
            sessionId: 'session-1',
            runId: 'run-1',
            status: 'completed',
            phase: 'done',
            reason: null,
          }),
        }) satisfies SessionTurnSubmission,
    );
    const { resolveGuestPrompt } = installPending(
      startSessionTurn,
      new Error('delete snapshot failed'),
    );

    const response = await app.handle(approvalRequest());

    expect(response.status).toBe(500);
    expect(resolveGuestPrompt).toHaveBeenCalledWith('prompt-1', true);
    expect(collaborationManager.getPendingPrompt('prompt-1')).toEqual(pending);
    expect(startSessionTurn).toHaveBeenCalledTimes(1);
  });

  test('cannot approve a pending prompt through a different collaboration session', async () => {
    const startSessionTurn = mock(async (_input: unknown) => {
      throw new Error('must not execute');
    });
    const { resolveGuestPrompt } = installPending(startSessionTurn);

    const response = await app.handle(approvalRequest('prompt-1', 'collaboration-2'));

    expect(response.status).toBe(404);
    expect(startSessionTurn).not.toHaveBeenCalled();
    expect(resolveGuestPrompt).not.toHaveBeenCalled();
  });
});
