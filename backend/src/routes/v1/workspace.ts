import { Elysia } from 'elysia';
import { homedir } from 'node:os';
import { requireLocalRouteAuth, validateLocalBearerToken } from '../../auth/local-route-auth';
import { PROJECT_ROOT } from '../../runtime/paths';
import { registerWorkspaceRoot } from '../../memory/unified-memory';
import { loadAgentSettings } from '../../agent-settings';
import { getRequestProjectRoot } from '../../runtime/request-project';
import { IMAGE_MIME_TYPES } from '../../tools/image';
import { existsSync, statSync, readFileSync } from 'node:fs';
import { resolve, extname } from 'node:path';

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
  .post('/register', ({ request, body, set }) => {
    if (!requireLocalRouteAuth(request, set)) return { ok: false, error: 'Unauthorized' };
    const root = String((body as { root?: string })?.root ?? '').trim();
    const home = homedir();
    const abs = resolve(root);
    // Only real folders inside the user's home may become workspace roots —
    // and never home itself (that would share memory across everything).
    if (!abs || abs === home || !abs.startsWith(home + '/') || !existsSync(abs) || !statSync(abs).isDirectory()) {
      set.status = 400;
      return { ok: false, error: 'Invalid workspace root' };
    }
    registerWorkspaceRoot(abs);
    return { ok: true };
  })
  .get(
  '/files',
  async ({ request, query, set }) => {
    if (!requireLocalRouteAuth(request, set)) return { ok: false, error: 'Unauthorized' };

    const search = String(query.q ?? '')
      .trim()
      .toLowerCase();
    const glob = new Bun.Glob('**/*');
    const files: string[] = [];

    for await (const match of glob.scan({ cwd: PROJECT_ROOT, onlyFiles: true })) {
      if (shouldSkipPath(match)) continue;
      if (search && !match.toLowerCase().includes(search)) continue;
      files.push(match);
      if (files.length >= 500) break;
    }

    files.sort((a, b) => a.localeCompare(b));
    return { ok: true, data: files };
  },
).get('/home', ({ request, set }) => {
  // Used by the no-project prompt: lets the user run a quick task scoped to
  // their home folder instead of being forced to open a project.
  if (!requireLocalRouteAuth(request, set)) return { ok: false, error: 'Unauthorized' };
  return { ok: true, data: homedir() };
});