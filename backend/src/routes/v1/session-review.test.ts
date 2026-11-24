import { afterAll, beforeAll, describe, expect, mock, spyOn, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const root = realpathSync(mkdtempSync(join(tmpdir(), 'kory-session-review-api-')));
process.env.NODE_ENV = 'test';
process.env.KORYPHAIOS_DATA_DIR = root;
process.env.DATABASE_URL = `sqlite:${join(root, 'test.sqlite')}`;
process.env.SESSION_TOKEN_SECRET ??= 'test_only_not_for_production_aaaaaaaaaa';
const { Elysia } = await import('elysia');
const { initDb } = await import('../../db');
const { localAuth } = await import('../../auth/local-auth');
const { buildLocalBearerToken } = await import('../../auth/local-route-auth');
const { errorHandler } = await import('../../middleware/error-handling');
const { setContext } = await import('../../context');
const { SessionStore } = await import('../../stores/session-store');
const { createSessionWorkspace } = await import('../../kory/session-workspace');
const { processSupervisor } = await import('../../process-supervisor/supervisor');
const { sessionReviewRoutes } = await import('./session-review');

const app = new Elysia().onError(errorHandler).use(sessionReviewRoutes);
const sessions = new SessionStore();
const source = join(root, 'source');
const startSessionTurn = mock(async (_input: { sourceCommandId: string; userMessage: string; source: string }) => ({
  accepted: true as const,
  sessionId: 'x',
  runId: 'run',
  userMessageId: 'msg',
  completion: Promise.resolve({}),
}));
let token = '';
let chatId = '';
let chatPath = '';
const processLease = spyOn(processSupervisor, 'tryAcquireAgentToolBarrier').mockImplementation(
  () => ({ release: () => {} }),
);

function git(cwd: string, ...args: string[]): void {
  const result = Bun.spawnSync(['git', ...args], { cwd, stdout: 'pipe', stderr: 'pipe' });
  if (result.exitCode) throw new Error(result.stderr.toString());
}

beforeAll(async () => {
  await initDb();
  mkdirSync(source);
  git(source, 'init', '-b', 'main');
  git(source, 'config', 'user.name', 'Route Test');
  git(source, 'config', 'user.email', 'route@example.test');
  git(source, 'config', 'commit.gpgsign', 'false');
  writeFileSync(join(source, 'notes.txt'), Array.from({ length: 30 }, (_, i) => `line ${i + 1}`).join('\n') + '\n');
  git(source, 'add', '.');
  git(source, 'commit', '-m', 'Initial');
  const workspace = await createSessionWorkspace(source, {
    branch: 'chat-review',
    storageRoot: join(root, 'chats'),
  });
  const session = await sessions.create('local-user', 'chat-review', undefined, source, workspace);
  chatId = session.id;
  chatPath = workspace.path;
  token = buildLocalBearerToken(localAuth.createSession(['*']));
  setContext({
    sessions,
    kory: {
      resolveSessionWorkingDirectoryPublic: async () => chatPath,
      tryAcquireSessionMutationBarrier: () => ({ release: () => {} }),
      hasActiveSessionExecution: () => false,
      hasDurableSessionRun: () => false,
      startSessionTurn,
    },
    wsManager: { broadcastToSession: mock(() => {}) },
  } as never);
});

afterAll(() => {
  processLease.mockRestore();
  localAuth.dispose();
  rmSync(root, { recursive: true, force: true });
});

function call(method: string, path: string, body?: unknown, authenticated = true) {
  return app.handle(
    new Request(`http://localhost/api/sessions${path}`, {
      method,
      headers: {
        ...(authenticated && { authorization: token }),
        'content-type': 'application/json',
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  );
}

describe('session review routes', () => {
  test('require authentication', async () => {
    expect((await call('GET', `/${chatId}/review-comments`, undefined, false)).status).toBe(401);
  });

  test('a comment round-trips and send batches it into one steering message', async () => {
    const created = await call('POST', `/${chatId}/review-comments`, {
      filePath: 'notes.txt',
      line: 3,
      side: 'new',
      body: 'Name this better.',
    });
    expect(created.status).toBe(200);
    const comment = (await created.json()).data.comment;
    expect(comment).toMatchObject({ filePath: 'notes.txt', line: 3, status: 'open' });

    const list = await (await call('GET', `/${chatId}/review-comments?status=open`)).json();
    expect(list.data.comments.map((c: { id: string }) => c.id)).toEqual([comment.id]);

    const sent = await (await call('POST', `/${chatId}/review-comments/send`)).json();
    expect(sent.ok).toBe(true);
    expect(sent.data.commentIds).toEqual([comment.id]);
    expect(sent.data.accepted).toBe(true);
    const turn = startSessionTurn.mock.calls.at(-1)![0];
    expect(turn.source).toBe('internal');
    expect(turn.sourceCommandId).toBe(`review-comments-${sent.data.batchId}`);
    expect(turn.userMessage).toContain('notes.txt:3 (new side, unstaged diff)');
    expect(turn.userMessage).toContain('Name this better.');

    // Open comments stay open until resolved, so a later send carries them again in a new batch.
    const again = await (await call('POST', `/${chatId}/review-comments/send`)).json();
    expect(again.data.commentIds).toEqual([comment.id]);
    expect(again.data.batchId).not.toBe(sent.data.batchId);
  });

  test('rejects invalid comment input and resolves or deletes by id', async () => {
    const bad = await call('POST', `/${chatId}/review-comments`, {
      filePath: '../escape.txt',
      line: 1,
      side: 'new',
      body: 'x',
    });
    expect(bad.status).not.toBe(200);

    const created = await (
      await call('POST', `/${chatId}/review-comments`, { filePath: 'notes.txt', line: 5, side: 'old', body: 'gone soon' })
    ).json();
    const id = created.data.comment.id;
    const resolved = await (await call('POST', `/${chatId}/review-comments/${id}/resolve`)).json();
    expect(resolved.data.comment.status).toBe('resolved');
    expect((await call('DELETE', `/${chatId}/review-comments/${id}`)).status).toBe(200);
    expect((await call('DELETE', `/${chatId}/review-comments/${id}`)).status).toBe(404);
  });

  test('hunk listing and stage act on the chat checkout, refusing a stale revision', async () => {
    writeFileSync(
      join(chatPath, 'notes.txt'),
      Array.from({ length: 30 }, (_, i) => (i === 9 ? 'line 10 edited' : `line ${i + 1}`)).join('\n') + '\n',
    );
    const listed = await (await call('GET', `/${chatId}/git/hunks?file=notes.txt`)).json();
    expect(listed.data.hunks).toHaveLength(1);
    expect(listed.data.staged).toBe(false);

    const stale = await call('POST', `/${chatId}/git/hunks/stage`, {
      file: 'notes.txt',
      hunkIndex: 0,
      hunkHeader: listed.data.hunks[0].header,
      revision: 'sha256:' + '0'.repeat(64),
    });
    expect(stale.status).toBe(409);

    const staged = await call('POST', `/${chatId}/git/hunks/stage`, {
      file: 'notes.txt',
      hunkIndex: 0,
      hunkHeader: listed.data.hunks[0].header,
      revision: listed.data.revision,
    });
    expect(staged.status).toBe(200);
    expect((await staged.json()).data).toMatchObject({ action: 'stage', file: 'notes.txt', staged: false });
    expect(readFileSync(join(chatPath, 'notes.txt'), 'utf8')).toContain('line 10 edited');
  });

  test('pull request status for an unlinked chat reports linked false', async () => {
    const body = await (await call('GET', `/${chatId}/pull-request/status`)).json();
    expect(body).toEqual({ ok: true, data: { linked: false, status: null } });
    expect((await call('POST', `/${chatId}/pull-request/send-failures`)).status).not.toBe(200);
  });
});
