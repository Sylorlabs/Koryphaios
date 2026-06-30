import { Elysia } from 'elysia';
import { requireLocalRouteAuth } from '../../auth/local-route-auth';
import { PROJECT_ROOT } from '../../runtime/paths';

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

export const workspaceRoutes = new Elysia({ prefix: '/api/workspace' }).get(
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
);