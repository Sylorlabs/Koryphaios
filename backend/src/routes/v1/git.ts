import { Elysia, t } from 'elysia';
import { requireLocalRouteAuth } from '../../auth/local-route-auth';
import { GitManager } from '../../kory/git-manager';
import { gitWorkspaceOwnership } from '../../kory/git-owned-workspace';
import { GitWorkspace } from '../../kory/git-workspace';
import { getRequestProjectRoot, getRequestWorkspaceRoot } from '../../runtime/request-project';
import { getContext } from '../../context';
import {
  chatGitForSession,
  requireGitSessionId,
  switchChatGit,
  withChatGitMutation,
} from '../../services/chat-git-service';

const switchRequestSchema = t.Object({
  expectedHead: t.String({ pattern: '^[a-fA-F0-9]{40,64}$' }),
  expectedBranch: t.Union([t.String({ maxLength: 255 }), t.Null()]),
  target: t.Union([
    t.Object({
      kind: t.Union([t.Literal('branch'), t.Literal('commit')]),
      source: t.Optional(t.Boolean()),
      ref: t.String({ minLength: 1, maxLength: 1024 }),
      branch: t.Optional(t.String({ minLength: 1, maxLength: 255 })),
      expectedHash: t.Optional(t.String({ pattern: '^[a-fA-F0-9]{40,64}$' })),
    }),
    t.Object({
      kind: t.Literal('pull-request'),
      number: t.Integer({ minimum: 1, maximum: 1_000_000_000 }),
      branch: t.String({ minLength: 1, maxLength: 255 }),
      expectedHash: t.Optional(t.String({ pattern: '^[a-fA-F0-9]{40,64}$' })),
    }),
  ]),
});

// Porcelain paths are repository-relative even for a chat opened in a subfolder.
const gitForDirectory = (directory: string) =>
  new GitManager(gitWorkspaceOwnership(directory)?.checkout ?? directory);
const requestGit = async (request: Request) =>
  gitForDirectory(await getRequestWorkspaceRoot(request));
const mutateGit = <T>(request: Request, run: (git: GitManager) => Promise<T>) =>
  withChatGitMutation(requireGitSessionId(request), (directory) => run(gitForDirectory(directory)));

export const gitRoutes = new Elysia({ prefix: '/api/git' })
  .get('/chat', async ({ request, set }) => {
    if (!requireLocalRouteAuth(request, set)) return { ok: false, error: 'Unauthorized' };
    const id = requireGitSessionId(request);
    const { git, session } = await chatGitForSession(id);
    return { ok: true, data: await git.state(id, session.gitWorkspace?.selection) };
  })
  .get(
    '/chat/commit',
    async ({ request, query, set }) => {
      if (!requireLocalRouteAuth(request, set)) return { ok: false, error: 'Unauthorized' };
      const { git } = await chatGitForSession(requireGitSessionId(request));
      return { ok: true, data: await git.details(query.ref, query.source === 'true') };
    },
    {
      query: t.Object({
        ref: t.String({ minLength: 1, maxLength: 1024 }),
        source: t.Optional(t.Union([t.Literal('true'), t.Literal('false')])),
      }),
    },
  )
  .get('/chat/pull-requests', async ({ request, set }) => {
    if (!requireLocalRouteAuth(request, set)) return { ok: false, error: 'Unauthorized' };
    const { git } = await chatGitForSession(requireGitSessionId(request));
    return { ok: true, data: await git.prs() };
  })
  .get(
    '/chat/pull-requests/:number',
    async ({ request, params, set }) => {
      if (!requireLocalRouteAuth(request, set)) return { ok: false, error: 'Unauthorized' };
      const { git } = await chatGitForSession(requireGitSessionId(request));
      return { ok: true, data: await git.pr(params.number) };
    },
    { params: t.Object({ number: t.Numeric({ minimum: 1, maximum: 1_000_000_000 }) }) },
  )
  .post(
    '/chat/switch',
    async ({ request, body, set }) => {
      if (!requireLocalRouteAuth(request, set)) return { ok: false, error: 'Unauthorized' };
      return { ok: true, data: await switchChatGit(requireGitSessionId(request), body) };
    },
    { body: switchRequestSchema },
  )
  .get('/selection', async ({ request, set }) => {
    if (!requireLocalRouteAuth(request, set)) return { ok: false, error: 'Unauthorized' };
    return { ok: true, data: await new GitWorkspace(getRequestProjectRoot(request)).selection() };
  })
  .get('/repo', async ({ request, set }) => {
    if (!requireLocalRouteAuth(request, set)) return { ok: false, error: 'Unauthorized' };
    const isRepo = (await requestGit(request)).isGitRepo();
    return { ok: true, data: { isRepo } };
  })
  .get('/status', async ({ request, set }) => {
    if (!requireLocalRouteAuth(request, set)) return { ok: false, error: 'Unauthorized' };
    const git = await requestGit(request);
    const isRepo = git.isGitRepo();
    if (!isRepo) {
      return { ok: true, data: { isRepo: false, status: [], branch: '', ahead: 0, behind: 0 } };
    }
    const status = await git.getStatus();
    const branch = await git.getBranch();
    const { ahead, behind } = await git.getAheadBehind();
    const remote = await git.getOrigin();
    const conflicts = await git.getConflicts();
    return { ok: true, data: { isRepo: true, status, branch, ahead, behind, remote, conflicts } };
  })
  .get(
    '/diff',
    async ({ request, query, set }) => {
      if (!requireLocalRouteAuth(request, set)) return { ok: false, error: 'Unauthorized' };
      const git = await requestGit(request);
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
      const git = await requestGit(request);
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
      const success = await mutateGit(request, (git) =>
        body.unstage ? git.unstageFile(body.file) : git.stageFile(body.file),
      );
      if (!success) set.status = 500;
      return {
        ok: success,
        ...(success
          ? {}
          : { error: body.unstage ? 'Could not unstage files.' : 'Could not stage files.' }),
      };
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
      const success = await mutateGit(request, (git) => git.restoreFile(body.file));
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
      const result = await mutateGit(request, (git) => git.runGit(['commit', '-m', body.message]));
      if (!result.success) set.status = 500;
      return { ok: result.success, ...(result.success ? {} : { error: result.output }) };
    },
    {
      body: t.Object({
        message: t.String({ minLength: 1, maxLength: 10000 }),
      }),
    },
  )
  .get('/branches', async ({ request, set }) => {
    if (!requireLocalRouteAuth(request, set)) return { ok: false, error: 'Unauthorized' };
    const { output } = await (
      await requestGit(request)
    ).runGit(['branch', '--format=%(refname:short)']);
    const branches = output.split('\n').filter(Boolean);
    return { ok: true, data: { branches } };
  })
  .post(
    '/checkout',
    async ({ request, body, set }) => {
      if (!requireLocalRouteAuth(request, set)) return { ok: false, error: 'Unauthorized' };
      // Legacy clients also switch only an explicitly selected chat, never a project.
      const id = requireGitSessionId(request);
      const { git } = await chatGitForSession(id);
      const state = await git.state(id);
      const data = await switchChatGit(id, {
        expectedHead: state.head ?? '',
        expectedBranch: state.branch,
        target: body.create
          ? { kind: 'commit', ref: state.head ?? '', branch: body.branch }
          : { kind: 'branch', ref: `refs/heads/${body.branch}` },
      });
      return { ok: true, data };
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
      return mutateGit(request, async (git) => {
        const result = await git.merge(body.branch);
        const conflicts = result.hasConflicts ? await git.getConflicts() : [];
        return {
          ok: result.success,
          data: { output: result.output, conflicts, hasConflicts: result.hasConflicts },
        };
      });
    },
    {
      body: t.Object({
        branch: t.String(),
      }),
    },
  )
  .get('/worktrees', async ({ request, set }) => {
    if (!requireLocalRouteAuth(request, set)) return { ok: false, error: 'Unauthorized' };
    await getRequestWorkspaceRoot(request);
    const sessionId = request.headers.get('x-koryphaios-session') ?? undefined;
    const kory = getContext().kory;
    return {
      ok: true,
      data: await (sessionId ? kory.getWorkspaceStatus(sessionId) : kory.getWorkspaceStatus()),
    };
  })
  .post(
    '/worktrees/resolve',
    async ({ request, body, set }) => {
      if (!requireLocalRouteAuth(request, set)) return { ok: false, error: 'Unauthorized' };
      await getRequestWorkspaceRoot(request);
      const sessionId = request.headers.get('x-koryphaios-session') ?? undefined;
      const result = await getContext().kory.applyWorktreeResolution(body.taskId, sessionId);
      return {
        ok: result.success,
        data: {
          outcome: result.outcome,
          message: result.message,
          conflicts: result.conflicts,
          recoveryBranch: result.recoveryBranch,
        },
      };
    },
    {
      body: t.Object({
        taskId: t.String(),
      }),
    },
  )
  .post(
    '/worktrees/discard',
    async ({ request, body, set }) => {
      if (!requireLocalRouteAuth(request, set)) return { ok: false, error: 'Unauthorized' };
      await getRequestWorkspaceRoot(request);
      const sessionId = request.headers.get('x-koryphaios-session') ?? undefined;
      const result = await getContext().kory.discardWorktreeResolution(body.taskId, sessionId);
      if (!result.success) set.status = 400;
      return { ok: result.success, data: { message: result.message } };
    },
    {
      body: t.Object({
        taskId: t.String(),
      }),
    },
  )
  .post('/push', async ({ request, set }) => {
    if (!requireLocalRouteAuth(request, set)) return { ok: false, error: 'Unauthorized' };
    const result = await mutateGit(request, (git) => git.push());
    if (!result.success) set.status = 500;
    return { ok: result.success, error: result.output };
  })
  .post(
    '/remote',
    async ({ request, body, set }) => {
      if (!requireLocalRouteAuth(request, set)) return { ok: false, error: 'Unauthorized' };
      const result = await mutateGit(request, (git) => git.setOrigin(body.url.trim()));
      if (!result.success) set.status = 400;
      return { ok: result.success, ...(result.success ? {} : { error: result.output }) };
    },
    { body: t.Object({ url: t.String({ minLength: 1, maxLength: 2048 }) }) },
  )
  .post('/pull', async ({ request, set }) => {
    if (!requireLocalRouteAuth(request, set)) return { ok: false, error: 'Unauthorized' };
    return mutateGit(request, async (git) => {
      const result = await git.pull();
      const hasConflicts =
        result.output.includes('CONFLICT') || result.output.includes('Automatic merge failed');
      const conflicts = hasConflicts ? await git.getConflicts() : [];
      return { ok: result.success, data: { output: result.output, conflicts, hasConflicts } };
    });
  });
