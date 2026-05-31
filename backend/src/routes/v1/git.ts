import { Elysia, t } from 'elysia';
import { getContext } from '../../context';
import { requireLocalRouteAuth } from '../../auth/local-route-auth';

export const gitRoutes = new Elysia({ prefix: '/api/git' })
  .get('/repo', async ({ request, set }) => {
    if (!requireLocalRouteAuth(request, set)) return { ok: false, error: 'Unauthorized' };
    const { kory } = getContext();
    const isRepo = kory.git.isGitRepo();
    return { ok: true, data: { isRepo } };
  })
  .get('/status', async ({ request, set }) => {
    if (!requireLocalRouteAuth(request, set)) return { ok: false, error: 'Unauthorized' };
    const { kory } = getContext();
    const isRepo = kory.git.isGitRepo();
    if (!isRepo) {
      return { ok: true, data: { isRepo: false, status: [], branch: '', ahead: 0, behind: 0 } };
    }
    const status = await kory.git.getStatus();
    const branch = await kory.git.getBranch();
    const { ahead, behind } = await kory.git.getAheadBehind();
    return { ok: true, data: { isRepo: true, status, branch, ahead, behind } };
  })
  .get(
    '/diff',
    async ({ request, query, set }) => {
      if (!requireLocalRouteAuth(request, set)) return { ok: false, error: 'Unauthorized' };
      const { kory } = getContext();
      if (!query.file) {
        set.status = 400;
        return { ok: false, error: 'file parameter required' };
      }
      const staged = query.staged === 'true';
      const diff = await kory.git.getDiff(query.file, staged);
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
      const { kory } = getContext();
      if (!query.path) {
        set.status = 400;
        return { ok: false, error: 'path parameter required' };
      }
      const content = await kory.git.getFileContent(query.path);
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
      const { kory } = getContext();
      const success = body.unstage
        ? await kory.git.unstageFile(body.file)
        : await kory.git.stageFile(body.file);
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
      const { kory } = getContext();
      const success = await kory.git.restoreFile(body.file);
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
      const { kory } = getContext();
      const success = await kory.git.commit(body.message);
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
    const { kory } = getContext();
    const { output } = (kory.git as any).runGit(['branch', '--format=%(refname:short)']);
    const branches = output.split('\n').filter(Boolean);
    return { ok: true, data: { branches } };
  })
  .post(
    '/checkout',
    async ({ request, body, set }) => {
      if (!requireLocalRouteAuth(request, set)) return { ok: false, error: 'Unauthorized' };
      const { kory } = getContext();
      const success = await kory.git.checkout(body.branch, body.create);
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
      const { kory } = getContext();
      const result = await kory.git.merge(body.branch);
      const conflicts = result.hasConflicts ? await kory.git.getConflicts() : [];
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
    const { kory } = getContext();
    const result = await kory.git.push();
    if (!result.success) set.status = 500;
    return { ok: result.success, error: result.output };
  })
  .post('/pull', async ({ request, set }) => {
    if (!requireLocalRouteAuth(request, set)) return { ok: false, error: 'Unauthorized' };
    const { kory } = getContext();
    const result = await kory.git.pull();
    const hasConflicts =
      result.output.includes('CONFLICT') || result.output.includes('Automatic merge failed');
    const conflicts = hasConflicts ? await kory.git.getConflicts() : [];
    return {
      ok: result.success,
      data: { output: result.output, conflicts, hasConflicts },
    };
  });
