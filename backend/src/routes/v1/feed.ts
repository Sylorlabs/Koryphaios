import { Elysia, t } from 'elysia';
import { requireLocalRouteAuth } from '../../auth/local-route-auth';
import { getContext } from '../../context';
import { NotFoundError, ValidationError } from '../../errors/types';
import {
  feedPersistenceStore,
  normalizeClientFeedErrorText,
  isValidFeedTargetKey,
} from '../../stores/feed-persistence-store';

async function requireSession(sessionId: string): Promise<void> {
  if (!(await getContext().sessions.get(sessionId))) throw new NotFoundError('Session', sessionId);
}

/**
 * Durable feed UI state. This intentionally does not provide a generic log
 * write endpoint: only client errors that the renderer explicitly put in the
 * session feed are accepted, while visibility changes are constrained to
 * exact stable replay identities.
 */
export const feedRoutes = new Elysia({ prefix: '/api/sessions' })
  .get('/:id/feed', async ({ request, params: { id: sessionId }, set }) => {
    if (!requireLocalRouteAuth(request, set)) return { ok: false, error: 'Unauthorized' };
    await requireSession(sessionId);
    return { ok: true, data: await feedPersistenceStore.getState(sessionId) };
  })
  .post(
    '/:id/feed/client-errors',
    async ({ request, params: { id: sessionId }, body, set }) => {
      if (!requireLocalRouteAuth(request, set)) return { ok: false, error: 'Unauthorized' };
      await requireSession(sessionId);
      try {
        await feedPersistenceStore.recordClientError({
          id: body.id,
          sessionId,
          text: normalizeClientFeedErrorText(body.text),
        });
      } catch (error) {
        throw new ValidationError(error instanceof Error ? error.message : 'Invalid feed error.');
      }
      return { ok: true };
    },
    {
      body: t.Object({
        id: t.String({ minLength: 1, maxLength: 256 }),
        text: t.String({ minLength: 1, maxLength: 16_384 }),
      }),
    },
  )
  .put(
    '/:id/feed/visibility',
    async ({ request, params: { id: sessionId }, body, set }) => {
      if (!requireLocalRouteAuth(request, set)) return { ok: false, error: 'Unauthorized' };
      await requireSession(sessionId);
      if (body.targets.some((target) => !isValidFeedTargetKey(target))) {
        throw new ValidationError('Feed visibility target is invalid.');
      }
      await feedPersistenceStore.setVisibility(sessionId, body.targets, body.visibility);
      return { ok: true };
    },
    {
      body: t.Object({
        targets: t.Array(t.String({ minLength: 1, maxLength: 512 }), {
          minItems: 1,
          maxItems: 256,
        }),
        visibility: t.Union([
          t.Literal('hidden'),
          t.Literal('deleted'),
          t.Literal('visible'),
        ]),
      }),
    },
  );
