import { afterEach, describe, expect, mock, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { KoryphaiosConfig, StoredMessage } from '@koryphaios/shared';
import type { ProviderRegistry } from '../../providers';
import type { ISessionStore } from '../../stores/session-store';
import type { ToolRegistry } from '../../tools';
import { MIGRATIONS } from '../../db/migrations';
import { SessionRunCoordinator } from '../../runs/session-run-coordinator';
import { SessionRunStore } from '../../runs/session-run-store';
import { eraseSessionDataTransaction } from '../../stores/session-erasure';

process.env.NODE_ENV = 'test';
process.env.SESSION_TOKEN_SECRET =
  process.env.SESSION_TOKEN_SECRET ?? 'test_only_not_for_production_aaaaaaaaaa';

const { Elysia } = await import('elysia');
const { localAuth } = await import('../../auth/local-auth');
const { buildLocalBearerToken } = await import('../../auth/local-route-auth');
const { setContext } = await import('../../context');
const { errorHandler } = await import('../../middleware/error-handling');
const { KoryManager } = await import('../../kory/manager');
const { agentSteeringStore } = await import('../../stores/agent-steering-store');
const { messageRoutes } = await import('./messages');

const app = new Elysia().onError(errorHandler).use(messageRoutes);
const CLIENT_ID = 'client-send-0001';
const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    if (existsSync(directory)) rmSync(directory, { recursive: true, force: true });
  }
});

/**
 * A real KoryManager over an in-memory ledger, so replay, conflict and
 * persistence behavior come from the production command ledger.
 */
function createLedger(sessionIds: string[]) {
  const sqlite = new Database(':memory:');
  sqlite.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      parent_id TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE user_inputs (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      input_data TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE supervised_processes (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      status TEXT NOT NULL,
      provenance TEXT NOT NULL,
      supervision TEXT NOT NULL,
      is_background INTEGER NOT NULL,
      terminal_reason TEXT
    );
  `);
  const insertSession = sqlite.prepare(
    'INSERT INTO sessions (id, title, created_at, updated_at) VALUES (?, ?, 1, 1)',
  );
  for (const id of sessionIds) insertSession.run(id, 'Idempotency test');
  for (const version of ['0032', '0033', '0037', '0038', '0043', '0056']) {
    const migration = MIGRATIONS.find((candidate) => candidate.version === version);
    if (!migration) throw new Error(`Migration ${version} is missing`);
    sqlite.exec(migration.up);
  }
  return {
    sqlite,
    coordinator: new SessionRunCoordinator(new SessionRunStore(sqlite), () => undefined),
  };
}

function createFixture(sessionIds: string[]) {
  const { sqlite, coordinator } = createLedger(sessionIds);
  const directory = mkdtempSync(join(tmpdir(), 'kory-idempotency-'));
  directories.push(directory);
  const records = new Map<string, StoredMessage>();
  const messages = {
    add: mock(async (sessionId: string, message: StoredMessage) => {
      records.set(message.id, { ...message, sessionId });
    }),
    addIdempotent: mock(async (sessionId: string, message: StoredMessage) => {
      if (records.has(message.id)) return 'existing' as const;
      records.set(message.id, { ...message, sessionId });
      return 'inserted' as const;
    }),
    getById: async (sessionId: string, messageId: string) => {
      const record = records.get(messageId);
      return record?.sessionId === sessionId ? record : undefined;
    },
  };
  const resolveProvider = mock(async (): Promise<unknown> => undefined);
  const providers = {
    resolveProvider,
    executeWithRetry: mock(),
    getAvailable: () => [],
    getStatus: () => [],
    getFirstAvailableRouting: () => undefined,
    isQuotaError: () => false,
  } as unknown as ProviderRegistry;
  const tools = { getToolDefsForRole: () => [], execute: mock() } as unknown as ToolRegistry;
  const rows = new Map<string, { id: string; workingDirectory: string; version: number }>();
  const sessions = {
    get: async (id: string) => rows.get(id) ?? { id, workingDirectory: directory, version: 1 },
    update: async () => undefined,
  };
  const kory = new KoryManager(
    providers,
    tools,
    directory,
    {} as KoryphaiosConfig,
    sessions as unknown as ISessionStore,
    messages as never,
    undefined,
    undefined,
    coordinator,
  );
  setContext({
    sessions: {
      get: async (id: string) => ({ id, interactionMode: 'act' }),
    },
    messages,
    providers: { getConfigs: () => ({}), get: () => undefined },
    kory,
    wsManager: { broadcast: () => undefined, broadcastToSession: () => undefined },
  } as never);
  return { sqlite, kory, messages, records, resolveProvider };
}

function request(body: unknown): Request {
  return new Request('http://localhost/api/messages', {
    method: 'POST',
    headers: {
      Authorization: buildLocalBearerToken(localAuth.createSession(['*'])),
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
}

function startCount(sqlite: Database): number {
  return (
    sqlite
      .query<{ count: number }, []>(
        `SELECT COUNT(*) AS count FROM session_run_events
          WHERE json_extract(payload, '$.transition.command') = 'start'`,
      )
      .get()?.count ?? 0
  );
}

function commandRows(sqlite: Database, sessionId: string): number {
  return (
    sqlite
      .query<{ count: number }, [string]>(
        'SELECT COUNT(*) AS count FROM session_turn_commands WHERE session_id = ?',
      )
      .get(sessionId)?.count ?? 0
  );
}

describe('message send idempotency through the session-turn ledger', () => {
  test('same clientMessageId twice persists one user message, starts one turn, and returns an identical body', async () => {
    const sessionId = 'idem-same-id';
    const { sqlite, kory, records } = createFixture([sessionId]);
    try {
      const body = { sessionId, content: 'Send once', clientMessageId: CLIENT_ID };
      const first = await app.handle(request(body));
      const second = await app.handle(request(body));

      expect(first.status).toBe(200);
      expect(second.status).toBe(200);
      const firstBody = await first.json();
      expect(await second.json()).toEqual(firstBody);
      expect(firstBody).toEqual({
        ok: true,
        data: {
          status: 'processing',
          runId: expect.any(String),
          messageId: expect.stringMatching(/^command-user-/),
        },
      });
      expect(records.size).toBe(1);
      expect(records.get(firstBody.data.messageId)).toMatchObject({
        role: 'user',
        content: 'Send once',
      });
      expect(startCount(sqlite)).toBe(1);
      await kory.shutdown();
    } finally {
      sqlite.close();
    }
  });

  test('same clientMessageId with different text is a 409 conflict and starts nothing', async () => {
    const sessionId = 'idem-conflict';
    const { sqlite, kory, records } = createFixture([sessionId]);
    try {
      const first = await app.handle(
        request({ sessionId, content: 'Original text', clientMessageId: CLIENT_ID }),
      );
      expect(first.status).toBe(200);
      const changed = await app.handle(
        request({ sessionId, content: 'Different text', clientMessageId: CLIENT_ID }),
      );

      expect(changed.status).toBe(409);
      expect(records.size).toBe(1);
      expect(startCount(sqlite)).toBe(1);
      await kory.shutdown();
    } finally {
      sqlite.close();
    }
  });

  test('the same clientMessageId in another session is an independent send', async () => {
    const first = 'idem-session-a';
    const second = 'idem-session-b';
    const { sqlite, kory, records } = createFixture([first, second]);
    try {
      const a = await (
        await app.handle(request({ sessionId: first, content: 'A', clientMessageId: CLIENT_ID }))
      ).json();
      const b = await (
        await app.handle(request({ sessionId: second, content: 'B', clientMessageId: CLIENT_ID }))
      ).json();

      expect(a.data.messageId).not.toBe(b.data.messageId);
      expect(records.size).toBe(2);
      expect(commandRows(sqlite, first)).toBe(1);
      expect(commandRows(sqlite, second)).toBe(1);
      await kory.shutdown();
    } finally {
      sqlite.close();
    }
  });

  test('a send without clientMessageId starts a ledger command with a server-minted srv_ id and the same response shape', async () => {
    const sessionId = 'idem-no-id';
    const { sqlite, kory, messages, records } = createFixture([sessionId]);
    try {
      const response = await app.handle(request({ sessionId, content: 'Ledger send' }));
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body).toEqual({
        ok: true,
        data: {
          status: 'processing',
          runId: expect.any(String),
          messageId: expect.stringMatching(/^command-user-/),
        },
      });
      expect(messages.add).not.toHaveBeenCalled();
      expect(messages.addIdempotent).toHaveBeenCalledTimes(1);
      expect(records.size).toBe(1);
      expect(records.get(body.data.messageId)).toMatchObject({
        role: 'user',
        content: 'Ledger send',
      });
      const rows = sqlite
        .query<{ source_command_id: string }, [string]>(
          'SELECT source_command_id FROM session_turn_commands WHERE session_id = ?',
        )
        .all(sessionId);
      expect(rows).toHaveLength(1);
      expect(rows[0]!.source_command_id).toMatch(/^srv_[A-Za-z0-9_-]{21}$/);
      expect(startCount(sqlite)).toBe(1);
      await kory.shutdown();
    } finally {
      sqlite.close();
    }
  });

  test('a send during active work queues behind the live run instead of returning 409', async () => {
    const sessionId = 'idem-busy';
    const { sqlite, kory, records } = createFixture([sessionId]);
    try {
      const owner = await kory.reserveSessionTurn(sessionId, 'user_turn');
      expect(owner).not.toBeNull();
      const body = { sessionId, content: 'Wait for me', clientMessageId: CLIENT_ID };

      // A user send parks behind the live run rather than cancelling it
      // mid-flight or returning a 409 the user cannot act on: the owner
      // stays live, the message is persisted, and the send is admitted as
      // the next turn once the run releases.
      const steered = await app.handle(request(body));
      expect(steered.status).toBe(200);
      expect(owner!.signal.aborted).toBe(false);
      const { data } = await steered.json();
      expect(data.status).toBe('queued');
      expect(data.steeringCommandId).toBe(`usrsteer_${sessionId}_${CLIENT_ID}`);
      expect(data.messageId).toStartWith('command-user-');
      expect(records.size).toBe(1);

      // The same clientMessageId replays the parked receipt, never a second
      // queue row or a second message.
      const replay = await app.handle(request(body));
      expect(replay.status).toBe(200);
      expect(await replay.json()).toEqual({ ok: true, data });
      expect(records.size).toBe(1);
      await kory.shutdown();
    } finally {
      sqlite.close();
      await agentSteeringStore
        .remove(`usrsteer_${sessionId}_${CLIENT_ID}`)
        .catch(() => undefined);
    }
  });

  test('a failed input persistence is reclaimed by a retry with the same id and text: one message, one command', async () => {
    const sessionId = 'idem-persist-retry';
    const { sqlite, kory, messages, records } = createFixture([sessionId]);
    let failNextWrite = true;
    messages.addIdempotent.mockImplementation(async (sid: string, message: StoredMessage) => {
      if (failNextWrite) throw new Error('simulated message store outage');
      records.set(message.id, { ...message, sessionId: sid });
      return 'inserted' as const;
    });
    try {
      const body = { sessionId, content: 'Persist me', clientMessageId: CLIENT_ID };
      const failed = await app.handle(request(body));
      expect(failed.status).toBe(500);
      expect(records.size).toBe(0);

      // No input was written, so no side effect can have happened: the same
      // id and the same text reclaim the failed command and run it once.
      failNextWrite = false;
      const retried = await app.handle(request(body));
      expect(retried.status).toBe(200);
      const { data } = await retried.json();
      expect(data.status).toBe('processing');
      expect(data.messageId).toStartWith('command-user-');
      expect(records.size).toBe(1);
      expect(records.get(data.messageId)).toMatchObject({ role: 'user', content: 'Persist me' });
      expect(commandRows(sqlite, sessionId)).toBe(1);
      // One failed admission that never dispatched, then the reclaimed turn.
      expect(startCount(sqlite)).toBe(2);

      const replay = await app.handle(request(body));
      expect(await replay.json()).toEqual({ ok: true, data });
      expect(records.size).toBe(1);
      expect(startCount(sqlite)).toBe(2);
      await kory.shutdown();
    } finally {
      sqlite.close();
    }
  });

  test('after a failed input persistence, the same id with different text is a 409 and persists nothing', async () => {
    const sessionId = 'idem-persist-conflict';
    const { sqlite, kory, messages, records } = createFixture([sessionId]);
    let failNextWrite = true;
    messages.addIdempotent.mockImplementation(async (sid: string, message: StoredMessage) => {
      if (failNextWrite) throw new Error('simulated message store outage');
      records.set(message.id, { ...message, sessionId: sid });
      return 'inserted' as const;
    });
    try {
      const failed = await app.handle(
        request({ sessionId, content: 'Original text', clientMessageId: CLIENT_ID }),
      );
      expect(failed.status).toBe(500);

      failNextWrite = false;
      const changed = await app.handle(
        request({ sessionId, content: 'Different text', clientMessageId: CLIENT_ID }),
      );
      expect(changed.status).toBe(409);
      expect(records.size).toBe(0);
      expect(startCount(sqlite)).toBe(1);
      await kory.shutdown();
    } finally {
      sqlite.close();
    }
  });

  test('a persisted command whose run was interrupted replays by id and never starts a second turn', async () => {
    const sessionId = 'idem-interrupted';
    const { sqlite, kory, records } = createFixture([sessionId]);
    const body = { sessionId, content: 'Interrupt me', clientMessageId: CLIENT_ID };
    try {
      // Admit the command directly with the same fields the route sends, so the
      // test can await its completion instead of racing the dispatch.
      const first = await kory.startSessionTurn({
        sessionId,
        source: 'user',
        sourceCommandId: CLIENT_ID,
        userMessage: body.content,
        interactionMode: 'act',
        imageInputMode: 'reject',
      });
      if (first.accepted !== true) throw new Error('Expected the first command to be admitted');
      await first.completion;
      expect(records.size).toBe(1);

      // Simulate a restart that lost the owning run after the input was durable:
      // the receipt is still active, but no run owns it any more.
      sqlite.run(
        "UPDATE session_turn_commands SET status = 'active', terminal_reason = NULL, finished_at = NULL WHERE session_id = ?",
        [sessionId],
      );
      sqlite.run('DELETE FROM session_runs WHERE session_id = ?', [sessionId]);

      const replay = await kory.startSessionTurn({
        sessionId,
        source: 'user',
        sourceCommandId: CLIENT_ID,
        userMessage: body.content,
        interactionMode: 'act',
        imageInputMode: 'reject',
      });
      expect(replay).toMatchObject({
        accepted: false,
        replay: 'interrupted',
        userMessageId: first.userMessageId,
      });

      const response = await app.handle(request(body));
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({
        ok: true,
        data: { status: 'processing', runId: first.runId, messageId: first.userMessageId },
      });
      expect(records.size).toBe(1);
      expect(startCount(sqlite)).toBe(1);
      await kory.shutdown();
    } finally {
      sqlite.close();
    }
  });

  test('a retry while the command is in flight replays its run and message through the typed replay', async () => {
    const sessionId = 'idem-in-flight';
    const { sqlite, kory, records, resolveProvider } = createFixture([sessionId]);
    // Hold the dispatched turn at provider resolution so the run stays in flight.
    let release!: () => void;
    const gate = new Promise<undefined>((resolve) => {
      release = () => resolve(undefined);
    });
    resolveProvider.mockImplementation(async () => gate);
    try {
      const body = { sessionId, content: 'Still running', clientMessageId: CLIENT_ID };
      const first = await app.handle(request(body));
      expect(first.status).toBe(200);
      const firstBody = await first.json();

      const replay = await app.handle(request(body));
      expect(replay.status).toBe(200);
      expect(await replay.json()).toEqual(firstBody);
      expect(records.size).toBe(1);
      expect(startCount(sqlite)).toBe(1);

      release();
      await kory.shutdown();
    } finally {
      sqlite.close();
    }
  });

  test('erasing a session removes its ledger rows', async () => {
    const sessionId = 'idem-erase';
    const { sqlite, kory } = createFixture([sessionId]);
    try {
      await app.handle(request({ sessionId, content: 'Erase me', clientMessageId: CLIENT_ID }));
      expect(commandRows(sqlite, sessionId)).toBe(1);

      eraseSessionDataTransaction(sqlite, { kind: 'selected', sessionIds: [sessionId] });

      expect(commandRows(sqlite, sessionId)).toBe(0);
      await kory.shutdown();
    } finally {
      sqlite.close();
    }
  });
});
