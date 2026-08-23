import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const isolatedRoot = mkdtempSync(join(tmpdir(), 'kory-workspace-routes-'));
chmodSync(isolatedRoot, 0o700);
process.env.NODE_ENV = 'test';
process.env.SESSION_TOKEN_SECRET ??= 'test_only_not_for_production_aaaaaaaaaa';
process.env.KORYPHAIOS_DATA_DIR = isolatedRoot;
process.env.DATABASE_URL = `sqlite:${join(isolatedRoot, 'workspace-routes.sqlite')}`;

const { Elysia } = await import('elysia');
const { initDb } = await import('../../db');
const { buildLocalBearerToken } = await import('../../auth/local-route-auth');
const { localAuth } = await import('../../auth/local-auth');
const { errorHandler } = await import('../../middleware/error-handling');
const { workspaceRoutes } = await import('./workspace');

const app = new Elysia().onError(errorHandler).use(workspaceRoutes);
const workspaceRoot = join(isolatedRoot, 'workspace');
let authorization = '';
let canonicalWorkspaceRoot = workspaceRoot;

beforeAll(async () => {
  await initDb();
  mkdirSync(join(workspaceRoot, 'alpha'), { recursive: true });
  canonicalWorkspaceRoot = canonical(workspaceRoot);
  authorization = buildLocalBearerToken(localAuth.createSession(['*']));
});

/** Resolve symlinks so comparisons match the canonical paths the store persists
 *  (macOS resolves /var → /private/var via realpathSync inside the store). */
function canonical(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

afterAll(() => {
  localAuth.dispose();
  rmSync(isolatedRoot, { recursive: true, force: true });
});

function request(path: string, init: RequestInit = {}, authenticated = true): Request {
  const headers = new Headers(init.headers);
  if (authenticated) headers.set('authorization', authorization);
  return new Request(`http://localhost${path}`, { ...init, headers });
}

type WorkspaceResponse = {
  ok: boolean;
  data: {
    workspaceRoot: string | null;
    selectedProject: string | null;
    projects: Array<{ path: string; name: string }>;
    unavailableProject: string | null;
  };
};

async function body(response: Response): Promise<WorkspaceResponse> {
  return (await response.json()) as WorkspaceResponse;
}

describe('workspace navigation routes', () => {
  test('requires local authentication', async () => {
    expect((await app.handle(request('/api/workspace/state', {}, false))).status).toBe(401);
  });

  test('returns current filesystem folders and retains missing-path recovery until acknowledged', async () => {
    const opened = await app.handle(
      request('/api/workspace/open', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ root: workspaceRoot }),
      }),
    );
    expect(opened.status).toBe(200);
    expect((await body(opened)).data.projects.map((entry) => entry.name)).toEqual(['alpha']);

    renameSync(join(workspaceRoot, 'alpha'), join(workspaceRoot, 'beta'));
    mkdirSync(join(workspaceRoot, 'gamma'));
    writeFileSync(join(workspaceRoot, 'gamma', 'current.txt'), 'current');

    const refreshed = await app.handle(request('/api/workspace/state'));
    expect((await body(refreshed)).data.projects.map((entry) => entry.name)).toEqual([
      'beta',
      'gamma',
    ]);

    const selected = await app.handle(
      request('/api/workspace/select', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ path: join(workspaceRoot, 'gamma') }),
      }),
    );
    expect((await body(selected)).data.selectedProject).toBe(join(canonicalWorkspaceRoot, 'gamma'));

    rmSync(join(workspaceRoot, 'gamma'), { recursive: true });
    const missing = await body(await app.handle(request('/api/workspace/state')));
    expect(missing.data.selectedProject).toBeNull();
    expect(missing.data.unavailableProject).toBe(join(canonicalWorkspaceRoot, 'gamma'));

    const stillMissing = await body(await app.handle(request('/api/workspace/state')));
    expect(stillMissing.data.unavailableProject).toBe(join(canonicalWorkspaceRoot, 'gamma'));

    const acknowledged = await body(
      await app.handle(request('/api/workspace/acknowledge-unavailable', { method: 'POST' })),
    );
    expect(acknowledged.data.unavailableProject).toBeNull();
    expect(acknowledged.data.projects.map((entry) => entry.name)).toEqual(['beta']);
  });

  test('scopes file mentions to the authenticated current project header', async () => {
    const project = join(workspaceRoot, 'beta');
    writeFileSync(join(project, 'only-here.txt'), 'current');
    const response = await app.handle(
      request('/api/workspace/files?q=only-here', {
        headers: { 'x-koryphaios-project': project },
      }),
    );
    expect(response.status).toBe(200);
    expect((await response.json()) as unknown).toEqual({ ok: true, data: ['only-here.txt'] });
  });
});
