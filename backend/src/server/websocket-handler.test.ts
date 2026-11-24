import { describe, expect, test } from 'bun:test';
import type { ServerWebSocket } from 'bun';
import { spawnSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createIsolatedTestEnvironment } from '../../../scripts/test-backend-isolated';
import { handleWSMessage, type WSClientData } from './websocket-handler';
import { SessionStore } from '../stores/session-store';
import { ensurePendingSessionReview } from '../stores/session-review-store';
import type { WSMessage } from '@koryphaios/shared';

// Resolve relative to this test file so the path is correct regardless of CWD.
const wsHandlerModulePath = resolve(import.meta.dir, 'websocket-handler.ts');

describe('displayed review transport', () => {
  test('direct decisions carry the captured review identity to the mutation boundary', async () => {
    const calls: unknown[][] = [];
    const socket = { data: { id: 'review-client' } } as ServerWebSocket<WSClientData>;
    const dependencies = {
      sessions: { get: async () => ({ id: 'review-session' }) },
      kory: {
        handleSessionResponse: async (...args: unknown[]) => {
          calls.push(args);
        },
      },
    } as unknown as Parameters<typeof handleWSMessage>[2];
    for (const accepted of [true, false]) {
      await handleWSMessage(
        socket,
        JSON.stringify({
          type: accepted ? 'session.accept_changes' : 'session.reject_changes',
          sessionId: 'review-session',
          reviewId: 'displayed-review',
          reviewRevision: 'displayed-revision',
        }),
        dependencies,
      );
    }
    expect(calls).toEqual(
      [true, false].map((accepted) => [
        'review-session',
        accepted,
        { reviewId: 'displayed-review', reviewRevision: 'displayed-revision' },
      ]),
    );
  });

  test('subscription replay filters stale publications with the same review ID', async () => {
    const sessions = new SessionStore();
    const session = await sessions.create(
      'local-user',
      'replay revision',
      undefined,
      '/synthetic-project',
    );
    const input = {
      sessionId: session.id,
      projectRoot: '/synthetic-project',
      changes: [],
      rollback: { kind: 'unavailable' as const, reason: 'synthetic fixture' },
    };
    const old = await ensurePendingSessionReview(input);
    const current = await ensurePendingSessionReview(input);
    let filter: ((event: WSMessage) => boolean) | undefined;
    const sent: WSMessage[] = [];
    const socket = { data: { id: 'review-replay-client' } } as ServerWebSocket<WSClientData>;
    const dependencies = {
      sessions,
      runs: { get: () => undefined },
      wsManager: {
        subscribeClientToSession: (
          _client: string,
          _session: string,
          _cursor: unknown,
          predicate: typeof filter,
        ) => {
          filter = predicate;
        },
        sendToClientEphemeral: (_client: string, event: WSMessage) => {
          sent.push(event);
        },
      },
    } as unknown as Parameters<typeof handleWSMessage>[2];
    await handleWSMessage(
      socket,
      JSON.stringify({ type: 'subscribe_session', sessionId: session.id }),
      dependencies,
    );
    const event = (reviewRevision?: string): WSMessage => ({
      type: 'session.changes',
      sessionId: session.id,
      timestamp: 1,
      payload: { changes: [], reviewId: current.reviewId, reviewRevision },
    });
    expect(filter).toBeDefined();
    expect(filter!(event(old.reviewRevision))).toBe(false);
    expect(filter!(event())).toBe(false);
    expect(filter!(event(current.reviewRevision))).toBe(true);
    expect(sent.find((message) => message.type === 'session.changes')?.payload).toMatchObject({
      reviewId: current.reviewId,
      reviewRevision: current.reviewRevision,
    });
  });
});

describe('transcript replay coverage', () => {
  const MANAGER = 'kory-manager';

  function streamDelta(messageId?: string): WSMessage {
    return {
      type: 'stream.delta',
      sessionId: 'any',
      timestamp: 1,
      payload: { agentId: MANAGER, content: 'hi', model: 'm', messageId },
    };
  }

  async function captureReplayFilter(options: {
    cursor?: { epoch: number; sequence: number };
    persistedIds?: string[];
    messages?: unknown;
  }): Promise<(event: WSMessage) => boolean> {
    const sessions = new SessionStore();
    const session = await sessions.create(
      'local-user',
      'replay coverage',
      undefined,
      '/synthetic-project',
    );
    let filter: ((event: WSMessage) => boolean) | undefined;
    const dependencies = {
      sessions,
      runs: { get: () => undefined },
      wsManager: {
        subscribeClientToSession: (
          _client: string,
          _session: string,
          _cursor: unknown,
          predicate: typeof filter,
        ) => {
          filter = predicate;
        },
        sendToClientEphemeral: () => {},
      },
      messages:
        'messages' in options
          ? options.messages
          : ({ listPersistedIds: async () => options.persistedIds ?? [] } as unknown),
    } as unknown as Parameters<typeof handleWSMessage>[2];
    await handleWSMessage(
      { data: { id: 'coverage-client' } } as ServerWebSocket<WSClientData>,
      JSON.stringify({
        type: 'subscribe_session',
        sessionId: session.id,
        ...options.cursor,
      }),
      dependencies,
    );
    expect(filter).toBeDefined();
    return filter!;
  }

  test('a fresh renderer skips only stream events already durable as parts', async () => {
    const filter = await captureReplayFilter({ persistedIds: ['persisted-turn'] });
    // Folded events for a persisted turn: the HTTP projection carries them.
    expect(
      filter({
        type: 'stream.thinking',
        sessionId: 's',
        timestamp: 1,
        payload: { agentId: MANAGER, thinking: 't', messageId: 'persisted-turn' },
      }),
    ).toBe(false);
    expect(filter(streamDelta('persisted-turn'))).toBe(false);
    expect(
      filter({
        type: 'stream.tool_call',
        sessionId: 's',
        timestamp: 1,
        payload: {
          agentId: MANAGER,
          messageId: 'persisted-turn',
          toolCall: { id: 'c1', name: 'read', input: {} },
        },
      }),
    ).toBe(false);
    expect(
      filter({
        type: 'stream.tool_result',
        sessionId: 's',
        timestamp: 1,
        payload: {
          agentId: MANAGER,
          messageId: 'persisted-turn',
          toolResult: { callId: 'c1', name: 'read', output: 'ok', isError: false, durationMs: 1 },
        },
      }),
    ).toBe(false);
    expect(
      filter({
        type: 'stream.complete',
        sessionId: 's',
        timestamp: 1,
        payload: { agentId: MANAGER, messageId: 'persisted-turn' },
      }),
    ).toBe(false);

    // The in-flight turn is not yet durable: its events are the only copy.
    expect(filter(streamDelta('in-flight-turn'))).toBe(true);
    // Worker streams are never stamped with a turn messageId.
    expect(filter(streamDelta())).toBe(true);
    // Stamped but not folded into `parts` (stream.usage) and operational
    // events carrying messageId keep replaying — none are in `parts`.
    expect(
      filter({
        type: 'stream.usage',
        sessionId: 's',
        timestamp: 1,
        payload: { agentId: MANAGER, messageId: 'persisted-turn', tokensIn: 1 },
      }),
    ).toBe(true);
    expect(
      filter({
        type: 'turn.provider_completed',
        sessionId: 's',
        timestamp: 1,
        payload: { agentId: MANAGER, messageId: 'persisted-turn', completedAt: 1 },
      }),
    ).toBe(true);
    expect(
      filter({
        type: 'kory.thought',
        sessionId: 's',
        timestamp: 1,
        payload: { thought: 't', phase: 'route' },
      }),
    ).toBe(true);
  });

  test('a cursor-carrying resume is never filtered', async () => {
    const filter = await captureReplayFilter({
      cursor: { epoch: 1, sequence: 3 },
      persistedIds: ['persisted-turn'],
    });
    // The client's projection may predate the persist; the missed events are
    // the only copy of this turn's tail, so they must replay.
    expect(filter(streamDelta('persisted-turn'))).toBe(true);
  });

  test('an unavailable persisted-id lookup leaves replay unfiltered', async () => {
    const noStore = await captureReplayFilter({ messages: undefined });
    expect(noStore(streamDelta('persisted-turn'))).toBe(true);

    const failing = await captureReplayFilter({
      messages: {
        listPersistedIds: async () => {
          throw new Error('db gone');
        },
      },
    });
    expect(failing(streamDelta('persisted-turn'))).toBe(true);
  });
});

describe('websocket heartbeat handling', () => {
  test('marks the exact client alive when it answers an application heartbeat', async () => {
    const pongClients: string[] = [];
    const socket = { data: { id: 'client-heartbeat' } } as ServerWebSocket<WSClientData>;
    const dependencies = {
      wsManager: {
        handlePong: (clientId: string) => pongClients.push(clientId),
      },
      sessions: {},
      kory: {},
      providers: {},
    } as unknown as Parameters<typeof handleWSMessage>[2];

    await handleWSMessage(
      socket,
      JSON.stringify({ type: 'pong', timestamp: Date.now() }),
      dependencies,
    );

    expect(pongClients).toEqual(['client-heartbeat']);
  });

  test('logs only structural metadata when downstream user input handling fails', () => {
    const sentinel = 'SYNTHETIC_PRIVATE_PROMPT_7f2b1c';
    const childCode = `
      import { handleWSMessage } from ${JSON.stringify(wsHandlerModulePath)};
      const sentinel = ${JSON.stringify(sentinel)};
      const socket = { data: { id: 'audit-client' } };
      const dependencies = {
        wsManager: { handlePong() {} },
        sessions: { async get() { return { id: 'session-a' }; } },
        kory: { async handleUserInput() { throw new Error('synthetic downstream failure'); } },
        providers: {},
      };
      await handleWSMessage(
        socket,
        JSON.stringify({
          type: 'user_input',
          sessionId: 'session-a',
          selection: 'answer',
          text: sentinel,
          questionId: 'q',
        }),
        dependencies,
      );
    `;
    const home = mkdtempSync(join(tmpdir(), 'kory-ws-audit-'));
    mkdirSync(join(home, 'tmp'));
    mkdirSync(join(home, 'project'));
    const child = (() => {
      try {
        return spawnSync(process.execPath, ['--no-env-file', '-e', childCode], {
          cwd: process.cwd(),
          env: {
            ...createIsolatedTestEnvironment(
              { ...process.env, KORY_RUN_LIVE_PROVIDER_TESTS: '0' },
              home,
            ),
            DATABASE_URL: `sqlite:${join(home, 'db', 'audit.db')}`,
          },
          encoding: 'utf8',
          timeout: 5_000,
        });
      } finally {
        rmSync(home, { recursive: true, force: true });
      }
    })();
    const output = `${child.stdout ?? ''}${child.stderr ?? ''}`;

    expect(child.error).toBeUndefined();
    expect(child.status, output).toBe(0);
    expect(output).not.toContain(sentinel);
    expect(output).not.toContain('synthetic downstream failure');
    expect(output).not.toContain('"raw"');
    expect(output).toContain('"messageType":"user_input"');
    expect(output).toContain('"messageBytes":');
    expect(output).toContain('"errorType":"Error"');
  });
});
