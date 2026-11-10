import { afterAll, beforeAll, describe, expect, spyOn, test } from 'bun:test';
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = mkdtempSync(join(tmpdir(), 'kory-git-workspace-api-'));
process.env.NODE_ENV = 'test';
process.env.KORYPHAIOS_DATA_DIR = root;
process.env.DATABASE_URL = `sqlite:${join(root, 'test.sqlite')}`;
process.env.SESSION_TOKEN_SECRET ??= 'test_only_not_for_production_aaaaaaaaaa';
const { Elysia } = await import('elysia');
const { initDb } = await import('../../db');
const { buildLocalBearerToken } = await import('../../auth/local-route-auth');
const { localAuth } = await import('../../auth/local-auth');
const { errorHandler } = await import('../../middleware/error-handling');
const { setContext } = await import('../../context');
const { SessionStore } = await import('../../stores/session-store');
const { GitWorkspace } = await import('../../kory/git-workspace');
const { sourceControlService } = await import('../../services/source-control-service');
const rules = await import('../../providers/cli-rules-skills');
const rulesSpy = spyOn(rules, 'writeAllCliRulesAndSkills').mockImplementation(() => true);
const { gitRoutes } = await import('./git');
const { sessionRoutes } = await import('./sessions');
const app = new Elysia().onError(errorHandler).use(gitRoutes).use(sessionRoutes);
const repo = join(root, 'repo');
const sessions = new SessionStore();
let token: string;
let head: string;
const create = GitWorkspace.prototype.create;
const createSpy = spyOn(GitWorkspace.prototype, 'create').mockImplementation(function (input) {
  return create.call(new GitWorkspace(repo, join(root, 'workspaces')), input);
});
const inspectProjectSpy = spyOn(sourceControlService, 'inspectProject');
const createChatWorkspaceSpy = spyOn(sourceControlService, 'createChatWorkspace');
function git(...args: string[]) {
  const result = Bun.spawnSync(['git', ...args], { cwd: repo, stdout: 'pipe', stderr: 'pipe' });
  if (result.exitCode) throw new Error(result.stderr.toString());
  return result.stdout.toString().trim();
}
beforeAll(async () => {
  await initDb();
  token = buildLocalBearerToken(localAuth.createSession(['*']));
  mkdirSync(repo);
  git('init', '-b', 'main');
  git('config', 'user.name', 'Test');
  git('config', 'user.email', 'test@example.test');
  git('config', 'commit.gpgsign', 'false');
  writeFileSync(join(repo, 'hello.txt'), 'hello');
  git('add', '.');
  git('commit', '-m', 'Initial');
  head = git('rev-parse', 'HEAD');
  setContext({ sessions, wsManager: { broadcastEphemeral() {} } } as never);
});
afterAll(() => {
  createSpy.mockRestore();
  inspectProjectSpy.mockRestore();
  createChatWorkspaceSpy.mockRestore();
  rulesSpy.mockRestore();
  localAuth.dispose();
  rmSync(root, { recursive: true, force: true });
});
function request(path: string, body?: unknown, authenticated = true, project = repo) {
  return new Request(`http://localhost${path}`, {
    method: body !== undefined ? 'POST' : 'GET',
    headers: {
      ...(authenticated ? { authorization: token } : {}),
      'content-type': 'application/json',
      'X-Koryphaios-Project': project,
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}
describe('Git workspace chat API', () => {
  test('requires authentication and rejects invalid explicit project paths', async () => {
    expect((await app.handle(request('/api/git/selection', undefined, false))).status).toBe(401);
    expect(
      (await app.handle(request('/api/git/selection', undefined, true, 'relative'))).status,
    ).toBe(400);
    expect(
      (await app.handle(request('/api/git/selection', undefined, true, join(root, 'missing'))))
        .status,
    ).toBe(400);
    expect(
      (
        await app.handle(
          request('/api/sessions', { git: { ref: head, branch: 'not-created' } }, false),
        )
      ).status,
    ).toBe(401);
    expect(createSpy).not.toHaveBeenCalled();
  });
  test('reads the explicit project rather than the launch directory', async () => {
    const response = await app.handle(request('/api/git/selection'));
    expect(response.status).toBe(200);
    expect(inspectProjectSpy).toHaveBeenCalledWith(
      expect.objectContaining({ path: realpathSync(repo) }),
    );
    expect(await response.json()).toMatchObject({
      ok: true,
      data: { isRepo: true, head, branch: 'main' },
    });
  });
  test('persists the checkout and immutable origin across store instances', async () => {
    const response = await app.handle(
      request('/api/sessions', {
        title: 'Isolated chat',
        workingDirectory: '/ignored-for-git',
        git: { ref: 'refs/heads/main', expectedHash: head, branch: 'feature/api' },
      }),
    );
    expect(response.status).toBe(200);
    expect(createChatWorkspaceSpy).toHaveBeenCalledWith(
      expect.objectContaining({ path: realpathSync(repo) }),
      expect.objectContaining({
        ref: 'refs/heads/main',
        expectedHash: head,
        branch: 'feature/api',
      }),
    );
    const body = await response.json();
    expect(body.ok).toBe(true);
    expect(body.data.workingDirectory).toBe(body.data.gitWorkspace.repositoryPath);
    expect(body.data.gitWorkspace.path).not.toBe(body.data.workingDirectory);
    expect(body.data.gitWorkspace).toMatchObject({ branch: 'feature/api', baseCommit: head });
    expect((await new SessionStore().get(body.data.id))?.gitWorkspace).toEqual(
      body.data.gitWorkspace,
    );
    await sessions.update(body.data.id, { interactionMode: 'plan' });
    expect((await sessions.get(body.data.id))?.gitWorkspace).toEqual(body.data.gitWorkspace);
    expect(git('branch', '--show-current')).toBe('main');
  });
  test('a moved ref returns a conflict without persisting a chat', async () => {
    const count = (await sessions.listAll()).length;
    const response = await app.handle(
      request('/api/sessions', {
        git: { ref: 'refs/heads/main', expectedHash: 'a'.repeat(40), branch: 'stale' },
      }),
    );
    expect(response.status).toBe(409);
    expect((await sessions.listAll()).length).toBe(count);
  });
  test('rejects bad refs and malformed hashes', async () => {
    expect(
      (await app.handle(request('/api/sessions', { git: { ref: '--help', branch: 'option' } })))
        .status,
    ).toBe(400);
    expect(
      (
        await app.handle(
          request('/api/sessions', {
            git: { ref: head, branch: 'hash', expectedHash: 'not-a-hash' },
          }),
        )
      ).status,
    ).toBe(400);
  });
});
