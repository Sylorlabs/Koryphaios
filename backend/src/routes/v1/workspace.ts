import { Elysia } from 'elysia';
import { homedir } from 'node:os';
import { spawn } from 'node:child_process';
import { normalizeProjectIconSpec } from '@koryphaios/shared';
import { requireLocalRouteAuth, validateLocalBearerToken } from '../../auth/local-route-auth';
import { registerWorkspaceRoot } from '../../memory/unified-memory';
import { loadAgentSettings } from '../../agent-settings';
import { getRequestProjectRoot, getRequestWorkspaceRoot } from '../../runtime/request-project';
import { IMAGE_MIME_TYPES } from '../../tools/image';
import { existsSync, mkdirSync, realpathSync, readdirSync, statSync, readFileSync } from 'node:fs';
import { basename, dirname, extname, isAbsolute, join, resolve } from 'node:path';
import { canonicalizePath, isContainedBy, isMac, isWindows } from '../../runtime/platform';
import { getDb } from '../../db';
import {
  validateWorkspaceRoot,
  WorkspaceNavigationStore,
} from '../../stores/workspace-navigation-store';
import { broadcastWorkspaceUpdate } from '../../stores/workspace-events';
import {
  ProjectIdentityConflictError,
  ProjectIdentityStore,
} from '../../stores/project-identity-store';
import {
  readProjectIcon,
  releaseReplacedProjectIcon,
  storeProjectIcon,
} from '../../projects/project-icons';
import { SourceControlScopeStore } from '../../stores/source-control-scope-store';

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

type BrowseLocation = {
  name: string;
  path: string;
};

function canonicalExistingDirectory(path: string): string | null {
  try {
    const resolved = resolve(path);
    if (!existsSync(resolved) || !statSync(resolved).isDirectory()) return null;
    return realpathSync(resolved);
  } catch {
    return null;
  }
}

/** Remote folder browsing is intentionally scoped to places the desktop user
 * already owns or has explicitly opened in Koryphaios. This keeps a paired
 * phone useful without turning a navigation endpoint into arbitrary host
 * filesystem discovery. */
function browseRoots(): BrowseLocation[] {
  const snapshot = new WorkspaceNavigationStore(getDb()).snapshot();
  const candidates = [
    { name: 'Home', path: homedir() },
    snapshot.workspaceRoot
      ? { name: basename(snapshot.workspaceRoot) || 'Workspace', path: snapshot.workspaceRoot }
      : null,
    snapshot.selectedProject
      ? { name: basename(snapshot.selectedProject) || 'Project', path: snapshot.selectedProject }
      : null,
    process.env.KORYPHAIOS_REMOTE_WORKSPACE
      ? {
          name: basename(process.env.KORYPHAIOS_REMOTE_WORKSPACE) || 'Remote workspace',
          path: process.env.KORYPHAIOS_REMOTE_WORKSPACE,
        }
      : null,
  ].filter((entry): entry is BrowseLocation => Boolean(entry));

  const unique = new Map<string, BrowseLocation>();
  for (const candidate of candidates) {
    const path = canonicalExistingDirectory(candidate.path);
    if (!path) continue;
    unique.set(path, { name: candidate.name, path });
  }
  return [...unique.values()];
}

function resolveBrowseDirectory(path: string | undefined): {
  path: string;
  roots: BrowseLocation[];
} {
  const roots = browseRoots();
  if (!roots.length) throw new Error('No host folders are available');
  const requested = path?.trim() || roots[0]!.path;
  if (!isAbsolute(requested)) throw new Error('Folder path must be absolute');
  const canonical = canonicalExistingDirectory(requested);
  if (!canonical) throw new Error('Folder is unavailable');
  if (!roots.some((root) => isContainedBy(root.path, canonical))) {
    throw new Error('Folder is outside the shared host locations');
  }
  return { path: canonical, roots };
}

function sanitizeFolderName(value: string): string {
  return value
    .split('')
    .filter((character) => /[\p{L}\p{N} _-]/u.test(character))
    .join('')
    .trim()
    .replace(/ +/g, '_');
}

function trySpawnEditor(cmd: string, args: string[]): Promise<boolean> {
  return new Promise((resolvePromise) => {
    try {
      const child = spawn(cmd, args, { stdio: 'ignore', detached: true });
      child.once('error', () => resolvePromise(false));
      child.once('spawn', () => {
        child.unref();
        resolvePromise(true);
      });
    } catch {
      resolvePromise(false);
    }
  });
}

export const workspaceRoutes = new Elysia({ prefix: '/api/workspace' })
  .post('/project-icon', async ({ request, set }) => {
    if (!requireLocalRouteAuth(request, set)) return { ok: false, error: 'Unauthorized' };
    try {
      const root = getRequestProjectRoot(request);
      const identityStore = new ProjectIdentityStore(getDb());
      const identity = identityStore.getWithRevision(root);
      const form = await request.formData();
      const file = form.get('file');
      if (!(file instanceof File)) throw new Error('Project icon file is required');
      const stored = await storeProjectIcon(identity.id, new Uint8Array(await file.arrayBuffer()));
      const presentation =
        form.has('color') || form.has('customColor') || form.has('shape')
          ? {
              color: form.get('color'),
              customColor: form.get('customColor'),
              shape: form.get('shape'),
            }
          : {
              color: identity.icon.color,
              customColor: identity.icon.customColor,
              shape: identity.icon.shape,
            };
      const updated = identityStore.update(root, {
        icon: normalizeProjectIconSpec({
          mode: 'image',
          assetId: stored.assetId,
          ...presentation,
        }),
        expectedRevision: identity.revision,
      });
      await releaseReplacedProjectIcon(identity, updated);
      const snapshot = new WorkspaceNavigationStore(getDb()).snapshot();
      broadcastWorkspaceUpdate(snapshot);
      return {
        ok: true,
        data: { ...updated, assetUrl: `/api/workspace/project-icon/${stored.assetId}` },
      };
    } catch (error) {
      set.status = error instanceof ProjectIdentityConflictError ? 409 : 400;
      return {
        ok: false,
        error: error instanceof Error ? error.message : 'Could not save project icon',
      };
    }
  })
  .get('/project-icon/:assetId', async ({ request, params, set }) => {
    if (!requireLocalRouteAuth(request, set)) return { ok: false, error: 'Unauthorized' };
    try {
      let icon = null;
      try {
        const root = getRequestProjectRoot(request);
        const identity = new ProjectIdentityStore(getDb()).get(root);
        icon = await readProjectIcon(identity.id, params.assetId);
      } catch {
        // Image elements cannot attach the project header. Fall through to the
        // owner-bound lookup below; the opaque asset id is still useless unless
        // its manifest validates against a durable project identity.
      }
      if (!icon) {
        const identities = getDb()
          .query<{ id: string }, []>('SELECT id FROM project_identities')
          .all();
        for (const candidate of identities) {
          icon = await readProjectIcon(candidate.id, params.assetId);
          if (icon) break;
        }
      }
      if (!icon) {
        set.status = 404;
        return { ok: false, error: 'Project icon not found' };
      }
      return new Response(new Uint8Array(icon.bytes), {
        headers: { 'Content-Type': 'image/png', ETag: `"${icon.revision}"` },
      });
    } catch {
      set.status = 404;
      return { ok: false, error: 'Project icon not found' };
    }
  })
  .get('/project-identity', ({ request, set }) => {
    if (!requireLocalRouteAuth(request, set)) return { ok: false, error: 'Unauthorized' };
    try {
      const root = getRequestProjectRoot(request);
      const identity = new ProjectIdentityStore(getDb()).getWithRevision(root);
      return {
        ok: true,
        data: {
          ...identity,
          ...(identity.icon.mode === 'image'
            ? { assetUrl: `/api/workspace/project-icon/${identity.icon.assetId}` }
            : {}),
        },
      };
    } catch (error) {
      set.status = 400;
      return {
        ok: false,
        error: error instanceof Error ? error.message : 'Project is unavailable',
      };
    }
  })
  .put('/project-identity', async ({ request, body, set }) => {
    if (!requireLocalRouteAuth(request, set)) return { ok: false, error: 'Unauthorized' };
    try {
      const root = getRequestProjectRoot(request);
      const input = (body ?? {}) as {
        name?: unknown;
        icon?: unknown;
        expectedRevision?: unknown;
      };
      const expectedRevision =
        input.expectedRevision === undefined ? undefined : Number(input.expectedRevision);
      const identityStore = new ProjectIdentityStore(getDb());
      const before = identityStore.getWithRevision(root);
      const identity = identityStore.update(root, {
        name: input.name,
        icon: input.icon,
        expectedRevision,
      });
      await releaseReplacedProjectIcon(before, identity);
      const snapshot = new WorkspaceNavigationStore(getDb()).snapshot();
      broadcastWorkspaceUpdate(snapshot);
      return { ok: true, data: identity };
    } catch (error) {
      set.status = error instanceof ProjectIdentityConflictError ? 409 : 400;
      return {
        ok: false,
        error: error instanceof Error ? error.message : 'Could not save project identity',
      };
    }
  })
  .delete('/project-identity', async ({ request, body, set }) => {
    if (!requireLocalRouteAuth(request, set)) return { ok: false, error: 'Unauthorized' };
    try {
      const root = getRequestProjectRoot(request);
      const identityStore = new ProjectIdentityStore(getDb());
      const before = identityStore.getWithRevision(root);
      const expectedRevision = Number(
        (body as { expectedRevision?: unknown } | undefined)?.expectedRevision,
      );
      const identity = identityStore.reset(
        root,
        Number.isFinite(expectedRevision) ? expectedRevision : undefined,
      );
      await releaseReplacedProjectIcon(before, identity);
      const snapshot = new WorkspaceNavigationStore(getDb()).snapshot();
      broadcastWorkspaceUpdate(snapshot);
      return { ok: true, data: identity };
    } catch (error) {
      set.status = error instanceof ProjectIdentityConflictError ? 409 : 400;
      return {
        ok: false,
        error: error instanceof Error ? error.message : 'Could not reset project identity',
      };
    }
  })
  .get('/source-control/roots', ({ request, set }) => {
    if (!requireLocalRouteAuth(request, set)) return { ok: false, error: 'Unauthorized' };
    try {
      const projectRoot = canonicalizePath(getRequestProjectRoot(request));
      const projectId = new ProjectIdentityStore(getDb()).get(projectRoot).id;
      return { ok: true, data: new SourceControlScopeStore(getDb()).listRoots(projectId) };
    } catch (error) {
      set.status = 400;
      return {
        ok: false,
        error: error instanceof Error ? error.message : 'Project is unavailable',
      };
    }
  })
  .post('/source-control/roots', ({ request, body, set }) => {
    if (!requireLocalRouteAuth(request, set)) return { ok: false, error: 'Unauthorized' };
    try {
      const projectRoot = canonicalizePath(getRequestProjectRoot(request));
      const projectId = new ProjectIdentityStore(getDb()).get(projectRoot).id;
      const input = (body ?? {}) as {
        path?: unknown;
        label?: unknown;
        access?: unknown;
        sourceControl?: unknown;
        repositoryPath?: unknown;
        remote?: unknown;
      };
      if (typeof input.path !== 'string') throw new Error('Root path is required');
      const rootPath = canonicalizePath(input.path);
      if (!isContainedBy(projectRoot, rootPath))
        throw new Error('Source-control roots must be contained by the selected project');
      const data = new SourceControlScopeStore(getDb()).ensureRoot(projectId, rootPath, {
        label: input.label as string | undefined,
        access: input.access as never,
        sourceControl: input.sourceControl as never,
        repositoryPath: input.repositoryPath,
        remote: typeof input.remote === 'string' ? input.remote : undefined,
      });
      return { ok: true, data };
    } catch (error) {
      set.status = 400;
      return {
        ok: false,
        error: error instanceof Error ? error.message : 'Could not allocate root',
      };
    }
  })
  .get('/state', ({ request, set }) => {
    if (!requireLocalRouteAuth(request, set)) return { ok: false, error: 'Unauthorized' };
    const { snapshot, healed } = new WorkspaceNavigationStore(getDb()).snapshotWithStatus();
    // The snapshot self-heals filesystem drift; other windows must learn
    // about the correction immediately, not on their next poll.
    if (healed) broadcastWorkspaceUpdate(snapshot);
    return { ok: true, data: snapshot };
  })
  .post('/open', ({ request, body, set }) => {
    if (!requireLocalRouteAuth(request, set)) return { ok: false, error: 'Unauthorized' };
    const root = String((body as { root?: string })?.root ?? '').trim();
    try {
      const canonicalRoot = validateWorkspaceRoot(root);
      registerWorkspaceRoot(canonicalRoot);
      const snapshot = new WorkspaceNavigationStore(getDb()).openWorkspace(canonicalRoot);
      broadcastWorkspaceUpdate(snapshot);
      return { ok: true, data: snapshot };
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
      const snapshot = new WorkspaceNavigationStore(getDb()).selectProject(path);
      broadcastWorkspaceUpdate(snapshot);
      return { ok: true, data: snapshot };
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
    const snapshot = new WorkspaceNavigationStore(getDb()).deselectProject();
    broadcastWorkspaceUpdate(snapshot);
    return { ok: true, data: snapshot };
  })
  .post('/projects/close', ({ request, body, set }) => {
    if (!requireLocalRouteAuth(request, set)) return { ok: false, error: 'Unauthorized' };
    const path = String((body as { path?: string })?.path ?? '').trim();
    try {
      const snapshot = new WorkspaceNavigationStore(getDb()).closeProject(path);
      broadcastWorkspaceUpdate(snapshot);
      return { ok: true, data: snapshot };
    } catch (error) {
      set.status = 400;
      return {
        ok: false,
        error: error instanceof Error ? error.message : 'Could not close the project',
      };
    }
  })
  .post('/acknowledge-unavailable', ({ request, set }) => {
    if (!requireLocalRouteAuth(request, set)) return { ok: false, error: 'Unauthorized' };
    const snapshot = new WorkspaceNavigationStore(getDb()).acknowledgeUnavailable();
    broadcastWorkspaceUpdate(snapshot);
    return { ok: true, data: snapshot };
  })
  .delete('/state', ({ request, set }) => {
    if (!requireLocalRouteAuth(request, set)) return { ok: false, error: 'Unauthorized' };
    const snapshot = new WorkspaceNavigationStore(getDb()).clear();
    broadcastWorkspaceUpdate(snapshot);
    return { ok: true, data: snapshot };
  })
  .get('/directories', ({ request, query, set }) => {
    if (!requireLocalRouteAuth(request, set)) return { ok: false, error: 'Unauthorized' };
    try {
      const { path, roots } = resolveBrowseDirectory(
        query.path === undefined ? undefined : String(query.path),
      );
      const containingRoot = roots.find((root) => isContainedBy(root.path, path));
      const parentCandidate = dirname(path);
      const parent =
        containingRoot && isContainedBy(containingRoot.path, parentCandidate)
          ? parentCandidate
          : null;
      const directories = readdirSync(path, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
        .flatMap((entry) => {
          const child = canonicalExistingDirectory(join(path, entry.name));
          if (!child || !containingRoot || !isContainedBy(containingRoot.path, child)) return [];
          return [{ name: entry.name, path: child }];
        })
        .sort((left, right) =>
          left.name.localeCompare(right.name, undefined, { sensitivity: 'base' }),
        )
        .slice(0, 500);
      return { ok: true, data: { path, parent, roots, directories } };
    } catch (error) {
      set.status = 400;
      return {
        ok: false,
        error: error instanceof Error ? error.message : 'Could not browse host folders',
      };
    }
  })
  .post('/directories', ({ request, body, set }) => {
    if (!requireLocalRouteAuth(request, set)) return { ok: false, error: 'Unauthorized' };
    try {
      const parentInput = String((body as { parentPath?: string })?.parentPath ?? '').trim();
      const requestedName = String((body as { name?: string })?.name ?? '');
      const { path: parentPath } = resolveBrowseDirectory(parentInput);
      const name = sanitizeFolderName(requestedName);
      if (!name) throw new Error('Invalid folder name');
      const folderPath = join(parentPath, name);
      if (existsSync(folderPath)) throw new Error('A folder with this name already exists');
      mkdirSync(folderPath);
      return { ok: true, data: { path: realpathSync(folderPath), name } };
    } catch (error) {
      set.status = 400;
      return {
        ok: false,
        error: error instanceof Error ? error.message : 'Could not create folder',
      };
    }
  })
  .get('/raw', async ({ request, query, set }) => {
    // <img src> can't send Authorization headers, so accept the bearer token
    // via ?auth= as well (same validation, local session token either way).
    const authed =
      requireLocalRouteAuth(request) ?? validateLocalBearerToken(String(query.auth ?? ''));
    if (!authed) {
      set.status = 401;
      return { ok: false, error: 'Unauthorized' };
    }
    // Image elements cannot attach routing headers either. Resolve relative
    // paths server-side so an unavailable checkout never reads the source tree.
    const headers = new Headers(request.headers);
    if (query.sessionId !== undefined) headers.set('x-koryphaios-session', String(query.sessionId));
    if (query.project !== undefined) headers.set('x-koryphaios-project', String(query.project));
    const scopedRequest = new Request(request.url, { headers });
    const workspaceRoot = await getRequestWorkspaceRoot(scopedRequest);
    const abs = resolve(workspaceRoot, String(query.path ?? ''));
    const home = homedir();
    const mime = IMAGE_MIME_TYPES[extname(abs).toLowerCase()];
    const projectSettings = loadAgentSettings(getRequestProjectRoot(scopedRequest));
    // Images only, hard 10MB cap — this is a chat renderer, not a general
    // file server. Paths outside home require the allowExternalPaths setting.
    // Use the shared, OS-aware containment check. The previous slash prefix
    // only worked on POSIX and misclassified Windows home paths.
    const inHome = existsSync(abs) && isContainedBy(canonicalizePath(home), canonicalizePath(abs));
    const externalAllowed = inHome || projectSettings.allowExternalPaths === true;
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
  .post('/open-file', async ({ request, body, set }) => {
    if (!requireLocalRouteAuth(request, set)) return { ok: false, error: 'Unauthorized' };
    const payload = (body ?? {}) as { path?: string; line?: number };
    const rawPath = String(payload.path ?? '').trim();
    if (!rawPath) {
      set.status = 400;
      return { ok: false, error: 'File path is required' };
    }
    const workspaceRoot = await getRequestWorkspaceRoot(request);
    const resolved = isAbsolute(rawPath) ? resolve(rawPath) : resolve(workspaceRoot, rawPath);
    if (!existsSync(resolved)) {
      set.status = 404;
      return { ok: false, error: 'File does not exist on disk' };
    }
    const canonical = canonicalizePath(resolved);
    const roots = browseRoots();
    const inAllowedRoot =
      roots.some((root) => isContainedBy(canonicalizePath(root.path), canonical)) ||
      isContainedBy(canonicalizePath(workspaceRoot), canonical) ||
      loadAgentSettings(getRequestProjectRoot(request)).allowExternalPaths === true;
    if (!inAllowedRoot) {
      set.status = 403;
      return { ok: false, error: 'File is outside the active workspace roots' };
    }

    const line =
      typeof payload.line === 'number' && Number.isFinite(payload.line) && payload.line >= 1
        ? Math.floor(payload.line)
        : undefined;
    const gotoTarget = line ? `${canonical}:${line}` : canonical;

    for (const [cmd, args] of [
      ['cursor', ['-g', gotoTarget]],
      ['code', ['-g', gotoTarget]],
      ['zed', [gotoTarget]],
    ] as const) {
      if (await trySpawnEditor(cmd, [...args])) {
        return { ok: true, data: { path: canonical, line, openedWith: cmd } };
      }
    }

    const platformOpener =
      isMac()
        ? (['open', [canonical]] as const)
        : isWindows()
          ? (['cmd', ['/c', 'start', '', canonical]] as const)
          : (['xdg-open', [canonical]] as const);
    if (await trySpawnEditor(platformOpener[0], [...platformOpener[1]])) {
      return { ok: true, data: { path: canonical, line, openedWith: platformOpener[0] } };
    }

    set.status = 500;
    return { ok: false, error: 'No editor or system file opener was available' };
  })
  .get('/files', async ({ request, query, set }) => {
    if (!requireLocalRouteAuth(request, set)) return { ok: false, error: 'Unauthorized' };

    const search = String(query.q ?? '')
      .trim()
      .toLowerCase();
    const glob = new Bun.Glob('**/*');
    const files: string[] = [];

    const requestRoot = await getRequestWorkspaceRoot(request);
    for await (const match of glob.scan({ cwd: requestRoot, onlyFiles: true })) {
      if (shouldSkipPath(match)) continue;
      if (search && !match.toLowerCase().includes(search)) continue;
      files.push(match);
      if (files.length >= 500) break;
    }

    files.sort((a, b) => a.localeCompare(b));
    return { ok: true, data: files };
  });
