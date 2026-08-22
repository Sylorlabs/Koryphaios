import { Elysia } from 'elysia';
import { homedir } from 'node:os';
import { requireLocalRouteAuth, validateLocalBearerToken } from '../../auth/local-route-auth';
import { registerWorkspaceRoot } from '../../memory/unified-memory';
import { loadAgentSettings } from '../../agent-settings';
import { getRequestProjectRoot } from '../../runtime/request-project';
import { IMAGE_MIME_TYPES } from '../../tools/image';
import { existsSync, statSync, readFileSync } from 'node:fs';
import { resolve, extname } from 'node:path';
import { getDb } from '../../db';
import {
  validateWorkspaceRoot,
  WorkspaceNavigationStore,
} from '../../stores/workspace-navigation-store';

const SKIP_SEGMENTS = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  '.svelte-kit',
  '.koryphaios',
  'target',
  '.next',
  'coverage',
]);

function shouldSkipPath(relativePath: string): boolean {
  return relativePath.split('/').some((segment) => SKIP_SEGMENTS.has(segment));
}

export const workspaceRoutes = new Elysia({ prefix: '/api/workspace' })
  .get('/state', ({ request, set }) => {
    if (!requireLocalRouteAuth(request, set)) return { ok: false, error: 'Unauthorized' };
    return { ok: true, data: new WorkspaceNavigationStore(getDb()).snapshot() };
  })
  .post('/open', ({ request, body, set }) => {
    if (!requireLocalRouteAuth(request, set)) return { ok: false, error: 'Unauthorized' };
    const root = String((body as { root?: string })?.root ?? '').trim();
    try {
      const canonicalRoot = validateWorkspaceRoot(root);
      registerWorkspaceRoot(canonicalRoot);
      return {
        ok: true,
        data: new WorkspaceNavigationStore(getDb()).openWorkspace(canonicalRoot),
      };
    } catch (error) {
      set.status = 400;
      return {
        ok: false,
        error: error instanceof Error ? error.message : 'Invalid workspace root',
      };
    }
  })
  .post('/select', ({ request, body, set }) => {
    if (!requireLocalRouteAuth(request, set)) return { ok: false, error: 'Unauthorized' };
    const path = String((body as { path?: string })?.path ?? '').trim();
    try {
      return { ok: true, data: new WorkspaceNavigationStore(getDb()).selectProject(path) };
    } catch (error) {
      set.status = 400;
      return {
        ok: false,
        error: error instanceof Error ? error.message : 'Invalid project directory',
      };
    }
  })
  .post('/deselect', ({ request, set }) => {
    if (!requireLocalRouteAuth(request, set)) return { ok: false, error: 'Unauthorized' };
    return { ok: true, data: new WorkspaceNavigationStore(getDb()).deselectProject() };
  })
  .post('/acknowledge-unavailable', ({ request, set }) => {
    if (!requireLocalRouteAuth(request, set)) return { ok: false, error: 'Unauthorized' };
    return {
      ok: true,
      data: new WorkspaceNavigationStore(getDb()).acknowledgeUnavailable(),
    };
  })
  .delete('/state', ({ request, set }) => {
    if (!requireLocalRouteAuth(request, set)) return { ok: false, error: 'Unauthorized' };
    return { ok: true, data: new WorkspaceNavigationStore(getDb()).clear() };
  })
  .get('/raw', ({ request, query, set }) => {
    // <img src> can't send Authorization headers, so accept the bearer token
    // via ?auth= as well (same validation, local session token either way).
    const authed =
      requireLocalRouteAuth(request) ?? validateLocalBearerToken(String(query.auth ?? ''));
    if (!authed) {
      set.status = 401;
      return { ok: false, error: 'Unauthorized' };
    }
    const abs = resolve(String(query.path ?? ''));
    const home = homedir();
    const mime = IMAGE_MIME_TYPES[extname(abs).toLowerCase()];
    // Images only, hard 10MB cap — this is a chat renderer, not a general
    // file server. Paths outside home require the allowExternalPaths setting.
    const inHome = abs.startsWith(home + '/');
    const externalAllowed =
      inHome || loadAgentSettings(getRequestProjectRoot(request)).allowExternalPaths === true;
    if (!mime || !externalAllowed || !existsSync(abs) || !statSync(abs).isFile()) {
      set.status = 404;
      return { ok: false, error: 'Not found' };
    }
    if (statSync(abs).size > 10 * 1024 * 1024) {
      set.status = 413;
      return { ok: false, error: 'Too large' };
    }
    (set.headers as Record<string, string>)['Content-Type'] = mime;
    (set.headers as Record<string, string>)['Cache-Control'] = 'private, max-age=60';
    return readFileSync(abs);
  })
  .get('/files', async ({ request, query, set }) => {
    if (!requireLocalRouteAuth(request, set)) return { ok: false, error: 'Unauthorized' };

    const search = String(query.q ?? '')
      .trim()
      .toLowerCase();
    const glob = new Bun.Glob('**/*');
    const files: string[] = [];

    const requestRoot = getRequestProjectRoot(request);
    for await (const match of glob.scan({ cwd: requestRoot, onlyFiles: true })) {
      if (shouldSkipPath(match)) continue;
      if (search && !match.toLowerCase().includes(search)) continue;
      files.push(match);
      if (files.length >= 500) break;
    }

    files.sort((a, b) => a.localeCompare(b));
    return { ok: true, data: files };
  });
