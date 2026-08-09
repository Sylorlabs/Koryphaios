import { Elysia, t } from 'elysia';
import { requireLocalRouteAuth } from '../../auth/local-route-auth';
import { GitManager } from '../../kory/git-manager';
import { getRequestProjectRoot } from '../../runtime/request-project';

const requestGit = (request: Request) => new GitManager(getRequestProjectRoot(request));

export const gitRoutes = new Elysia({ prefix: '/api/git' })
  .get('/repo', async ({ request, set }) => {
    if (!requireLocalRouteAuth(request, set)) return { ok: false, error: 'Unauthorized' };
    const isRepo = requestGit(request).isGitRepo();
    return { ok: true, data: { isRepo } };
  })
  .get('/status', async ({ request, set }) => {
    if (!requireLocalRouteAuth(request, set)) return { ok: false, error: 'Unauthorized' };
    const git = requestGit(request);
    const isRepo = git.isGitRepo();
    if (!isRepo) {
      return { ok: true, data: { isRepo: false, status: [], branch: '', ahead: 0, behind: 0 } };
    }
    const status = await git.getStatus();
    const branch = await git.getBranch();
    const { ahead, behind } = await git.getAheadBehind();
    return { ok: true, data: { isRepo: true, status, branch, ahead, behind } };
  })
  .get(
    '/diff',
    async ({ request, query, set }) => {
      if (!requireLocalRouteAuth(request, set)) return { ok: false, error: 'Unauthorized' };
      const git = requestGit(request);
      if (!query.file) {
        set.status = 400;
        return { ok: false, error: 'file parameter required' };
      }
      const staged = query.staged === 'true';
      const diff = await git.getDiff(query.file, staged);
      return { ok: true, data: { diff } };
    },
    {
      query: t.Object({
        file: t.String(),
        staged: t.Optional(t.String()),
      }),
    },
  )
  .get(
    '/file',
    async ({ request, query, set }) => {
      if (!requireLocalRouteAuth(request, set)) return { ok: false, error: 'Unauthorized' };
      const git = requestGit(request);
      if (!query.path) {
        set.status = 400;
        return { ok: false, error: 'path parameter required' };
      }
      const content = await git.getFileContent(query.path);
      return { ok: content !== null, data: { content } };
    },
    {
      query: t.Object({
        path: t.String(),
      }),
    },
  )
  .post(
    '/stage',
    async ({ request, body, set }) => {
      if (!requireLocalRouteAuth(request, set)) return { ok: false, error: 'Unauthorized' };
      const git = requestGit(request);
      const success = body.unstage
        ? await git.unstageFile(body.file)
        : await git.stageFile(body.file);
      if (!success) set.status = 500;
      return { ok: success };
    },
    {
      body: t.Object({
        file: t.String(),
        unstage: t.Optional(t.Boolean()),
      }),
    },
  )
  .post(
    '/restore',
    async ({ request, body, set }) => {
      if (!requireLocalRouteAuth(request, set)) return { ok: false, error: 'Unauthorized' };
      const success = await requestGit(request).restoreFile(body.file);
      if (!success) set.status = 500;
      return { ok: success };
    },
    {
      body: t.Object({
        file: t.String(),
      }),
    },
  )
  .post(
    '/commit',
    async ({ request, body, set }) => {
      if (!requireLocalRouteAuth(request, set)) return { ok: false, error: 'Unauthorized' };
      const success = await requestGit(request).commit(body.message);
      if (!success) set.status = 500;
      return { ok: success };
    },
    {
      body: t.Object({
        message: t.String(),
      }),
    },
  )
  .get('/branches', async ({ request, set }) => {
    if (!requireLocalRouteAuth(request, set)) return { ok: false, error: 'Unauthorized' };
    const { output } = await requestGit(request).runGit(['branch', '--format=%(refname:short)']);
    const branches = output.split('\n').filter(Boolean);
    return { ok: true, data: { branches } };
  })
  .post(
    '/checkout',
    async ({ request, body, set }) => {
      if (!requireLocalRouteAuth(request, set)) return { ok: false, error: 'Unauthorized' };
      const success = await requestGit(request).checkout(body.branch, body.create);
      if (!success) set.status = 500;
      return { ok: success };
    },
    {
      body: t.Object({
        branch: t.String(),
        create: t.Optional(t.Boolean()),
      }),
    },
  )
  .post(
    '/merge',
    async ({ request, body, set }) => {
      if (!requireLocalRouteAuth(request, set)) return { ok: false, error: 'Unauthorized' };
      const git = requestGit(request);
      const result = await git.merge(body.branch);
      const conflicts = result.hasConflicts ? await git.getConflicts() : [];
      return {
        ok: result.success,
        data: { output: result.output, conflicts, hasConflicts: result.hasConflicts },
      };
    },
    {
      body: t.Object({
        branch: t.String(),
      }),
    },
  )
  .post('/push', async ({ request, set }) => {
    if (!requireLocalRouteAuth(request, set)) return { ok: false, error: 'Unauthorized' };
    const result = await requestGit(request).push();
    if (!result.success) set.status = 500;
    return { ok: result.success, error: result.output };
  })
  .post('/pull', async ({ request, set }) => {
    if (!requireLocalRouteAuth(request, set)) return { ok: false, error: 'Unauthorized' };
    const git = requestGit(request);
    const result = await git.pull();
    const hasConflicts =
      result.output.includes('CONFLICT') || result.output.includes('Automatic merge failed');
    const conflicts = hasConflicts ? await git.getConflicts() : [];
    return {
      ok: result.success,
      data: { output: result.output, conflicts, hasConflicts },
    };
  });
