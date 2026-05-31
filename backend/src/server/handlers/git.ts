import type { KoryManager } from '../../kory/manager';
import { requireAuth } from '../../middleware';
import { serverLog } from '../../logger';
import { json, parseJson } from '../http-helpers';

export async function handleGitRoutes(
  req: Request,
  pathname: string,
  method: string,
  corsHeaders: Record<string, string>,
  kory: KoryManager,
): Promise<Response | undefined> {
  // Repo check
  if (pathname === '/api/git/repo' && method === 'GET') {
    const isRepo = kory.git.isGitRepo();
    return json({ ok: true, data: { isRepo } }, 200, corsHeaders);
  }

  // Status
  if (pathname === '/api/git/status' && method === 'GET') {
    const auth = await requireAuth(req);
    try {
      const status = await kory.git.getStatus();
      const branch = await kory.git.getBranch();
      return json({ ok: true, data: { status, branch } }, 200, corsHeaders);
    } catch (err: unknown) {
      const detail = err instanceof Error ? err.message : String(err);
      serverLog.error({ err }, 'GET /api/git/status failed');
      return json({ ok: false, error: 'Git status failed', detail }, 500, corsHeaders);
    }
  }

  // Diff
  if (pathname === '/api/git/diff' && method === 'GET') {
    const auth = await requireAuth(req);
    const url = new URL(req.url);
    const file = url.searchParams.get('file');
    const staged = url.searchParams.get('staged') === 'true';
    if (!file) return json({ ok: false, error: 'file parameter required' }, 400, corsHeaders);
    if (!kory.git.resolvePathUnderRepo(file))
      return json({ ok: false, error: 'Invalid file path' }, 400, corsHeaders);
    const diff = await kory.git.getDiff(file, staged);
    return json({ ok: true, data: { diff } }, 200, corsHeaders);
  }

  // Stage/Unstage
  if (pathname === '/api/git/stage' && method === 'POST') {
    const auth = await requireAuth(req);
    const parsed = await parseJson<{ file: string; unstage?: boolean }>(req, corsHeaders);
    if (!parsed.ok) return parsed.res;
    const body = parsed.data;
    if (!body.file) return json({ ok: false, error: 'file required' }, 400, corsHeaders);
    if (!kory.git.resolvePathUnderRepo(body.file))
      return json({ ok: false, error: 'Invalid file path' }, 400, corsHeaders);
    const success = body.unstage
      ? await kory.git.unstageFile(body.file)
      : await kory.git.stageFile(body.file);
    return json({ ok: success }, success ? 200 : 500, corsHeaders);
  }

  // Restore (Discard)
  if (pathname === '/api/git/restore' && method === 'POST') {
    const auth = await requireAuth(req);
    const parsed = await parseJson<{ file: string }>(req, corsHeaders);
    if (!parsed.ok) return parsed.res;
    const body = parsed.data;
    if (!body.file) return json({ ok: false, error: 'file required' }, 400, corsHeaders);
    if (!kory.git.resolvePathUnderRepo(body.file))
      return json({ ok: false, error: 'Invalid file path' }, 400, corsHeaders);
    const success = await kory.git.restoreFile(body.file);
    return json({ ok: success }, success ? 200 : 500, corsHeaders);
  }

  // Commit
  if (pathname === '/api/git/commit' && method === 'POST') {
    const auth = await requireAuth(req);
    const parsed = await parseJson<{ message: string }>(req, corsHeaders);
    if (!parsed.ok) return parsed.res;
    const body = parsed.data;
    if (!body.message) return json({ ok: false, error: 'message required' }, 400, corsHeaders);
    const message = body.message;
    if (!message) return json({ ok: false, error: 'message required' }, 400, corsHeaders);
    const success = await kory.git.commit(message);
    return json({ ok: success }, success ? 200 : 500, corsHeaders);
  }

  // Branches
  if (pathname === '/api/git/branches' && method === 'GET') {
    const auth = await requireAuth(req);
    const branches = await kory.git.getBranches();
    return json({ ok: true, data: { branches } }, 200, corsHeaders);
  }

  // Checkout
  if (pathname === '/api/git/checkout' && method === 'POST') {
    const auth = await requireAuth(req);
    const parsed = await parseJson<{ branch: string; create?: boolean }>(req, corsHeaders);
    if (!parsed.ok) return parsed.res;
    const body = parsed.data;
    if (!body.branch) return json({ ok: false, error: 'branch required' }, 400, corsHeaders);
    const { GitManager } = await import('../../kory/git-manager');
    if (!GitManager.validateBranchName(body.branch))
      return json({ ok: false, error: 'Invalid branch name' }, 400, corsHeaders);
    const success = await kory.git.checkout(body.branch, body.create);
    return json({ ok: success }, success ? 200 : 500, corsHeaders);
  }

  // Merge
  if (pathname === '/api/git/merge' && method === 'POST') {
    const auth = await requireAuth(req);
    const parsed = await parseJson<{ branch: string }>(req, corsHeaders);
    if (!parsed.ok) return parsed.res;
    const body = parsed.data;
    if (!body.branch) return json({ ok: false, error: 'branch required' }, 400, corsHeaders);
    const { GitManager } = await import('../../kory/git-manager');
    if (!GitManager.validateBranchName(body.branch))
      return json({ ok: false, error: 'Invalid branch name' }, 400, corsHeaders);
    const result = await kory.git.merge(body.branch);
    const conflicts = result.hasConflicts ? await kory.git.getConflicts() : [];
    return json(
      {
        ok: result.success,
        data: { output: result.output, conflicts, hasConflicts: result.hasConflicts },
      },
      200,
      corsHeaders,
    );
  }

  // Push
  if (pathname === '/api/git/push' && method === 'POST') {
    const auth = await requireAuth(req);
    const result = await kory.git.push();
    return json(
      { ok: result.success, error: result.output },
      result.success ? 200 : 500,
      corsHeaders,
    );
  }

  // Pull
  if (pathname === '/api/git/pull' && method === 'POST') {
    const auth = await requireAuth(req);
    const result = await kory.git.pull();
    const hasConflicts =
      result.output.includes('CONFLICT') || result.output.includes('Automatic merge failed');
    const conflicts = hasConflicts ? await kory.git.getConflicts() : [];
    return json(
      { ok: result.success, data: { output: result.output, conflicts, hasConflicts } },
      200,
      corsHeaders,
    );
  }

  return undefined;
}
