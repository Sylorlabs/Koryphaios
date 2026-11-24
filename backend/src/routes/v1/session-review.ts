/**
 * Review-loop routes for one chat: inline diff comments, hunk-level Git actions
 * on the chat's own checkout, and the linked pull request's status and feedback.
 * Logic lives in services/session-review-service.ts and
 * services/pull-request-status-service.ts.
 */

import { Elysia, t } from 'elysia';
import { requireLocalRouteAuth } from '../../auth/local-route-auth';
import { AuthenticationError } from '../../errors/types';
import {
  actOnSessionHunk,
  addSessionReviewComment,
  deleteSessionReviewComment,
  listSessionFileHunks,
  listSessionReviewComments,
  resolveSessionReviewComment,
  sendReviewCommentsToAgent,
} from '../../services/session-review-service';
import {
  getPullRequestStatus,
  sendPullRequestFeedbackToAgent,
} from '../../services/pull-request-status-service';

const sessionParams = t.Object({ id: t.String({ minLength: 1, maxLength: 200 }) });
const commentParams = t.Object({
  id: t.String({ minLength: 1, maxLength: 200 }),
  commentId: t.String({ minLength: 1, maxLength: 200 }),
});
const stagedQuery = t.Optional(t.Union([t.Literal('true'), t.Literal('false')]));
const hunkBody = t.Object({
  file: t.String({ minLength: 1, maxLength: 1024 }),
  hunkIndex: t.Integer({ minimum: 0, maximum: 100_000 }),
  hunkHeader: t.String({ minLength: 4, maxLength: 300 }),
  revision: t.String({ minLength: 8, maxLength: 128 }),
});

function requireAuth(request: Request): void {
  if (!requireLocalRouteAuth(request)) throw new AuthenticationError('Unauthorized');
}

export const sessionReviewRoutes = new Elysia({ prefix: '/api/sessions' })
  .get(
    '/:id/review-comments',
    async ({ request, params, query }) => {
      requireAuth(request);
      const status = query.status ?? 'all';
      return { ok: true, data: { comments: await listSessionReviewComments(params.id, status) } };
    },
    {
      params: sessionParams,
      query: t.Object({
        status: t.Optional(t.Union([t.Literal('open'), t.Literal('resolved'), t.Literal('all')])),
      }),
    },
  )
  .post(
    '/:id/review-comments',
    async ({ request, params, body }) => {
      requireAuth(request);
      return { ok: true, data: { comment: await addSessionReviewComment(params.id, body) } };
    },
    {
      params: sessionParams,
      body: t.Object({
        filePath: t.String({ minLength: 1, maxLength: 1024 }),
        line: t.Integer({ minimum: 1, maximum: 10_000_000 }),
        side: t.Union([t.Literal('old'), t.Literal('new')]),
        body: t.String({ minLength: 1, maxLength: 8_000 }),
        hunkHeader: t.Optional(t.String({ maxLength: 300 })),
        staged: t.Optional(t.Boolean()),
      }),
    },
  )
  .post(
    '/:id/review-comments/send',
    async ({ request, params }) => {
      requireAuth(request);
      return { ok: true, data: await sendReviewCommentsToAgent(params.id) };
    },
    { params: sessionParams },
  )
  .post(
    '/:id/review-comments/:commentId/resolve',
    async ({ request, params }) => {
      requireAuth(request);
      return {
        ok: true,
        data: { comment: await resolveSessionReviewComment(params.id, params.commentId) },
      };
    },
    { params: commentParams },
  )
  .delete(
    '/:id/review-comments/:commentId',
    async ({ request, params }) => {
      requireAuth(request);
      await deleteSessionReviewComment(params.id, params.commentId);
      return { ok: true };
    },
    { params: commentParams },
  )
  .get(
    '/:id/git/hunks',
    async ({ request, params, query }) => {
      requireAuth(request);
      const data = await listSessionFileHunks(params.id, query.file, query.staged === 'true');
      return { ok: true, data };
    },
    {
      params: sessionParams,
      query: t.Object({
        file: t.String({ minLength: 1, maxLength: 1024 }),
        staged: stagedQuery,
      }),
    },
  )
  .post(
    '/:id/git/hunks/stage',
    async ({ request, params, body }) => {
      requireAuth(request);
      return { ok: true, data: await actOnSessionHunk(params.id, 'stage', body) };
    },
    { params: sessionParams, body: hunkBody },
  )
  .post(
    '/:id/git/hunks/unstage',
    async ({ request, params, body }) => {
      requireAuth(request);
      return { ok: true, data: await actOnSessionHunk(params.id, 'unstage', body) };
    },
    { params: sessionParams, body: hunkBody },
  )
  .post(
    '/:id/git/hunks/revert',
    async ({ request, params, body }) => {
      requireAuth(request);
      return { ok: true, data: await actOnSessionHunk(params.id, 'revert', body) };
    },
    { params: sessionParams, body: hunkBody },
  )
  .get(
    '/:id/pull-request/status',
    async ({ request, params, query }) => {
      requireAuth(request);
      return {
        ok: true,
        data: await getPullRequestStatus(params.id, { refresh: query.refresh === 'true' }),
      };
    },
    {
      params: sessionParams,
      query: t.Object({ refresh: t.Optional(t.Union([t.Literal('true'), t.Literal('false')])) }),
    },
  )
  .post(
    '/:id/pull-request/send-failures',
    async ({ request, params }) => {
      requireAuth(request);
      return { ok: true, data: await sendPullRequestFeedbackToAgent(params.id) };
    },
    { params: sessionParams },
  );
