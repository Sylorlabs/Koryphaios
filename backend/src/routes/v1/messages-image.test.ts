import { afterAll, beforeAll, describe, expect, mock, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AdmittedWorkContext, SessionTurnAdmission } from '../../kory/manager';

process.env.NODE_ENV = 'test';
process.env.SESSION_TOKEN_SECRET =
  process.env.SESSION_TOKEN_SECRET ?? 'test_only_not_for_production_aaaaaaaaaa';

const { Elysia } = await import('elysia');
const { localAuth } = await import('../../auth/local-auth');
const { buildLocalBearerToken } = await import('../../auth/local-route-auth');
const { setContext } = await import('../../context');
const { errorHandler } = await import('../../middleware/error-handling');
const { messageRoutes } = await import('./messages');
const { listApiUsage } = await import('../../billing/api-usage-ledger');

const app = new Elysia().onError(errorHandler).use(messageRoutes);
const originalFetch = globalThis.fetch;
const originalDataDir = process.env.KORYPHAIOS_DATA_DIR;
const dataDir = mkdtempSync(join(tmpdir(), 'kory-image-chat-test-'));

beforeAll(() => {
  process.env.KORYPHAIOS_DATA_DIR = dataDir;
});

afterAll(() => {
  globalThis.fetch = originalFetch;
  if (originalDataDir === undefined) delete process.env.KORYPHAIOS_DATA_DIR;
  else process.env.KORYPHAIOS_DATA_DIR = originalDataDir;
  rmSync(dataDir, { recursive: true, force: true });
});

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

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt++) {
    if (predicate()) return;
    await Bun.sleep(10);
  }
  throw new Error('Timed out waiting for image chat processing');
}

function admission(controller = new AbortController(), runId = 'run-image-1') {
  return {
    controller,
    token: {
      sessionId: 'session-1',
      runId,
      signal: controller.signal,
    } satisfies SessionTurnAdmission,
  };
}

function admittedWorkExecutor(controller: AbortController) {
  return mock(
    async <T>(
      _admission: SessionTurnAdmission,
      work: (context: AdmittedWorkContext) => Promise<T>,
      _completeReason: string,
    ): Promise<T> =>
      work({
        signal: controller.signal,
        phase: async () => undefined,
      }),
  );
}

describe('image generation from chat', () => {
  test('persists a CLI screenshot while forwarding explicit provider-only omission', async () => {
    const stored: Array<Record<string, unknown>> = [];
    const { token } = admission();
    const reserveSessionTurn = mock(async () => token);
    const dispatchAdmittedTask = mock(async () => undefined);
    const attachments = [
      {
        type: 'image',
        data: Buffer.from('screen').toString('base64'),
        name: 'clipboard-image.png',
        mimeType: 'image/png',
      },
    ];
    setContext({
      sessions: { get: async () => ({ id: 'session-1', interactionMode: 'act' }) },
      messages: {
        add: async (_sessionId: string, message: Record<string, unknown>) => stored.push(message),
      },
      providers: { getConfigs: () => ({}), get: () => undefined },
      kory: {
        generateSessionTitle: async () => undefined,
        reserveSessionTurn,
        dispatchAdmittedTask,
        rejectSessionTurn: async () => undefined,
      },
      wsManager: { broadcast: () => undefined, broadcastToSession: () => undefined },
    } as never);

    const response = await app.handle(
      request({
        sessionId: 'session-1',
        content: 'What controls are visible in this screenshot?',
        model: 'codex-account:primary:gpt-5.6-sol',
        attachments,
        imageInputMode: 'omit',
      }),
    );
    expect(response.status).toBe(200);
    await waitFor(() => dispatchAdmittedTask.mock.calls.length === 1);

    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({
      role: 'user',
      content: 'What controls are visible in this screenshot?',
      attachments,
    });
    expect(reserveSessionTurn).toHaveBeenCalledWith('session-1', 'user_turn');
    expect(dispatchAdmittedTask).toHaveBeenCalledWith(token, {
      userMessage: 'What controls are visible in this screenshot?',
      preferredModel: 'codex-account:primary:gpt-5.6-sol',
      reasoningLevel: undefined,
      attachments,
      interactionMode: 'act',
      fastMode: undefined,
      inputAlreadyPersisted: true,
      imageInputMode: 'omit',
    });
    expect((await response.json()).data.runId).toBe(token.runId);
  });

  test('routes a selected image model through image generation and persists the result', async () => {
    const stored: Array<Record<string, unknown>> = [];
    const events: Array<{ type: string; payload: unknown; sessionId?: string }> = [];
    const { controller, token } = admission();
    const reserveSessionTurn = mock(async () => token);
    const dispatchAdmittedWork = admittedWorkExecutor(controller);
    let requestUrl = '';
    globalThis.fetch = mock(async (input: string | URL | Request) => {
      requestUrl = String(input instanceof Request ? input.url : input);
      return Response.json({
        data: [{ b64_json: 'aW1hZ2U=', revised_prompt: 'A moonlit canyon' }],
      });
    }) as unknown as typeof fetch;
    setContext({
      sessions: { get: async () => ({ id: 'session-1', interactionMode: 'act' }) },
      messages: {
        add: async (_sessionId: string, message: Record<string, unknown>) => stored.push(message),
      },
      providers: {
        getConfigs: () => ({
          openai: {
            apiKey: 'openai-test-key',
            baseUrl: 'https://api.openai.com/v1',
            disabled: false,
          },
        }),
        get: () => undefined,
      },
      kory: {
        generateSessionTitle: async () => undefined,
        reserveSessionTurn,
        dispatchAdmittedWork,
        rejectSessionTurn: async () => undefined,
      },
      wsManager: {
        broadcast: (event: { type: string; payload: unknown; sessionId?: string }) =>
          events.push(event),
        broadcastToSession: (
          sessionId: string,
          event: { type: string; payload: unknown; sessionId?: string },
        ) => events.push({ ...event, sessionId }),
      },
    } as never);

    const response = await app.handle(
      request({
        sessionId: 'session-1',
        content: 'Generate a moonlit canyon',
        model: 'openai:gpt-image-1',
      }),
    );
    expect(response.status).toBe(200);
    await waitFor(() => stored.length === 2);

    expect(reserveSessionTurn).toHaveBeenCalledWith('session-1', 'image_turn');
    expect(dispatchAdmittedWork).toHaveBeenCalledTimes(1);
    expect(dispatchAdmittedWork.mock.calls[0]?.[0]).toBe(token);
    expect(dispatchAdmittedWork.mock.calls[0]?.[2]).toBe('image_turn_completed');
    expect(requestUrl).toBe('https://api.openai.com/v1/images/generations');
    expect(stored[1]).toMatchObject({
      role: 'assistant',
      model: 'gpt-image-1',
      provider: 'openai',
      cost: 0.05,
      attachments: [
        {
          type: 'image',
          data: 'aW1hZ2U=',
          mimeType: 'image/png',
        },
      ],
    });
    const usage = (await listApiUsage()).find((entry) => entry.id === stored[1]?.id);
    expect(usage).toMatchObject({
      kind: 'image',
      provider: 'openai',
      model: 'gpt-image-1',
      estimatedCostUsd: 0.05,
      sessionId: 'session-1',
      runId: token.runId,
    });
    expect(events.some((event) => event.type === 'agent.status')).toBe(true);
    expect(events.some((event) => event.type === 'system.error')).toBe(false);
    expect(existsSync(join(dataDir, 'images'))).toBe(false);
  });

  test('regenerates an image response through the image adapter', async () => {
    const generated: Array<Record<string, unknown>> = [];
    const { controller, token } = admission(undefined, 'run-image-regenerate');
    const reserveSessionTurn = mock(async () => token);
    const dispatchAdmittedWork = admittedWorkExecutor(controller);
    const regenerationBranch = {
      sessionId: 'session-1',
      targetMessageId: 'image-1',
      promptMessageId: 'prompt-1',
      expectedActiveMessageId: 'image-1',
      expectedProviderConversationRevision: 0,
      contextRevision: 0,
      groupId: 'response-prompt-1',
      index: 1,
    };
    globalThis.fetch = mock(async () =>
      Response.json({ data: [{ b64_json: 'bmV3LWltYWdl' }] }),
    ) as unknown as typeof fetch;
    setContext({
      sessions: { get: async () => ({ id: 'session-1', interactionMode: 'act' }) },
      messages: {
        getRegenerationCandidate: async () => ({
          target: {
            id: 'image-1',
            sessionId: 'session-1',
            role: 'assistant',
            content: 'Generated image.',
            provider: 'xai',
            model: 'grok-imagine-image-2.0',
            createdAt: 2,
          },
          prompt: {
            id: 'prompt-1',
            sessionId: 'session-1',
            role: 'user',
            content: 'Generate a moonlit canyon',
            createdAt: 1,
          },
          boundary: { messageId: 'image-1', contextRevision: 0 },
          providerConversationRevision: 0,
        }),
        prepareRegenerationBranch: async () => ({
          ...regenerationBranch,
        }),
        commitRegeneratedResponse: async (
          branch: Record<string, unknown>,
          message: Record<string, unknown>,
        ) => generated.push({ ...message, committedBranch: branch }),
      },
      providers: {
        getConfigs: () => ({
          xai: { apiKey: 'xai-test-key', baseUrl: 'https://api.x.ai/v1', disabled: false },
        }),
        get: () => undefined,
      },
      kory: {
        reserveSessionTurn,
        dispatchAdmittedWork,
        rejectSessionTurn: async () => undefined,
      },
      wsManager: { broadcastToSession: () => undefined },
    } as never);

    const response = await app.handle(
      request({ sessionId: 'session-1', messageId: 'image-1' }, '/api/messages/regenerate'),
    );
    expect(response.status).toBe(200);
    await waitFor(() => generated.length === 1);

    expect(reserveSessionTurn).toHaveBeenCalledWith('session-1', 'image_regenerate_turn');
    expect(dispatchAdmittedWork).toHaveBeenCalledTimes(1);
    expect(dispatchAdmittedWork.mock.calls[0]?.[0]).toBe(token);
    expect(generated[0]).toMatchObject({
      role: 'assistant',
      provider: 'xai',
      model: 'grok-imagine-image-2.0',
      variantGroupId: 'response-prompt-1',
      variantIndex: 1,
      attachments: [{ type: 'image', data: 'bmV3LWltYWdl', mimeType: 'image/jpeg' }],
      committedBranch: regenerationBranch,
    });
  });

  test('reports an admitted image failure without persisting an assistant response', async () => {
    const stored: Array<Record<string, unknown>> = [];
    const events: Array<{ type: string; payload: unknown; sessionId?: string }> = [];
    const { controller, token } = admission(undefined, 'run-image-failure');
    const dispatchAdmittedWork = admittedWorkExecutor(controller);
    globalThis.fetch = mock(async () =>
      Response.json({ error: { message: 'provider unavailable' } }, { status: 503 }),
    ) as unknown as typeof fetch;
    setContext({
      sessions: { get: async () => ({ id: 'session-1', interactionMode: 'act' }) },
      messages: {
        add: async (_sessionId: string, message: Record<string, unknown>) => stored.push(message),
      },
      providers: {
        getConfigs: () => ({
          xai: { apiKey: 'xai-test-key', baseUrl: 'https://api.x.ai/v1', disabled: false },
        }),
        get: () => undefined,
      },
      kory: {
        generateSessionTitle: async () => undefined,
        reserveSessionTurn: async () => token,
        dispatchAdmittedWork,
        rejectSessionTurn: async () => undefined,
      },
      wsManager: {
        broadcast: () => undefined,
        broadcastToSession: (
          sessionId: string,
          event: { type: string; payload: unknown; sessionId?: string },
        ) => events.push({ ...event, sessionId }),
      },
    } as never);

    const response = await app.handle(
      request({
        sessionId: 'session-1',
        content: 'Generate an unavailable image',
        model: 'xai:grok-imagine-image-2.0',
      }),
    );
    expect(response.status).toBe(200);
    await waitFor(() => events.some((event) => event.type === 'system.error'));

    expect(dispatchAdmittedWork).toHaveBeenCalledTimes(1);
    expect(stored.map((message) => message.role)).toEqual(['user']);
    expect(events.some((event) => event.type === 'stream.delta')).toBe(false);
    expect((await listApiUsage()).some((entry) => entry.runId === token.runId)).toBe(false);
  });

  test('does not persist an assistant image when the admitted AbortSignal is cancelled', async () => {
    const stored: Array<Record<string, unknown>> = [];
    const events: Array<{ type: string; payload: unknown; sessionId?: string }> = [];
    const { controller, token } = admission(undefined, 'run-image-cancelled');
    const dispatchAdmittedWork = admittedWorkExecutor(controller);
    let releaseFetch!: () => void;
    const fetchRelease = new Promise<void>((resolve) => {
      releaseFetch = resolve;
    });
    let markFetchStarted!: () => void;
    const fetchStarted = new Promise<void>((resolve) => {
      markFetchStarted = resolve;
    });
    let providerSignal: AbortSignal | undefined;
    globalThis.fetch = mock(async (_input: string | URL | Request, init?: RequestInit) => {
      providerSignal = init?.signal ?? undefined;
      markFetchStarted();
      await fetchRelease;
      return Response.json({ data: [{ b64_json: 'c2hvdWxkLW5vdC1wZXJzaXN0' }] });
    }) as unknown as typeof fetch;
    setContext({
      sessions: { get: async () => ({ id: 'session-1', interactionMode: 'act' }) },
      messages: {
        add: async (_sessionId: string, message: Record<string, unknown>) => stored.push(message),
      },
      providers: {
        getConfigs: () => ({
          xai: { apiKey: 'xai-test-key', baseUrl: 'https://api.x.ai/v1', disabled: false },
        }),
        get: () => undefined,
      },
      kory: {
        generateSessionTitle: async () => undefined,
        reserveSessionTurn: async () => token,
        dispatchAdmittedWork,
        rejectSessionTurn: async () => undefined,
      },
      wsManager: {
        broadcast: () => undefined,
        broadcastToSession: (
          sessionId: string,
          event: { type: string; payload: unknown; sessionId?: string },
        ) => events.push({ ...event, sessionId }),
      },
    } as never);

    const response = await app.handle(
      request({
        sessionId: 'session-1',
        content: 'Generate and then cancel',
        model: 'xai:grok-imagine-image-2.0',
      }),
    );
    expect(response.status).toBe(200);
    await fetchStarted;
    controller.abort(new DOMException('cancelled by test', 'AbortError'));
    expect(providerSignal?.aborted).toBe(true);
    releaseFetch();
    await waitFor(() => events.some((event) => event.type === 'system.error'));

    expect(stored.map((message) => message.role)).toEqual(['user']);
    expect(events.some((event) => event.type === 'stream.delta')).toBe(false);
    expect((await listApiUsage()).some((entry) => entry.runId === token.runId)).toBe(false);
    expect(
      events.some(
        (event) =>
          event.type === 'agent.status' &&
          typeof event.payload === 'object' &&
          event.payload !== null &&
          'status' in event.payload &&
          event.payload.status === 'done',
      ),
    ).toBe(false);
  });
});
