import { Elysia, t } from 'elysia';
import { getContext } from '../../context';
import { requireLocalRouteAuth } from '../../auth/local-route-auth';
import type { Checklist, ChecklistItemStatus, ChecklistScope } from '@koryphaios/shared';
import {
  AuthenticationError,
  ConflictError,
  NotFoundError,
  ValidationError,
} from '../../errors/types';

const scopes = ['workspace', 'project', 'session'] as const;
const itemStatuses = ['pending', 'done', 'skipped'] as const;

/** Every mutation lands here, so the user and the agents see one live list. */
const sendUpdate = (checklist: Checklist | undefined, deletedId?: string) => {
  if (deletedId)
    getContext().wsManager.broadcast({
      type: 'checklists.updated',
      payload: { deletedId },
      timestamp: Date.now(),
    });
  else if (checklist)
    getContext().wsManager.broadcast({
      type: 'checklists.updated',
      payload: { checklist },
      timestamp: Date.now(),
      sessionId: checklist.sessionId,
    });
  return checklist;
};

/** Translate a store invariant into a status code rather than a 500. */
const asConflict = (run: () => Promise<Checklist | undefined>) =>
  run().catch((error: unknown) => {
    throw new ConflictError(error instanceof Error ? error.message : 'Checklist edit rejected');
  });

export const checklistRoutes = new Elysia({ prefix: '/api/checklists' })
  .get(
    '/',
    async ({ request, query }) => {
      if (!requireLocalRouteAuth(request)) throw new AuthenticationError('Unauthorized');
      const { checklists } = getContext();
      const data = query.includeArchived
        ? await checklists.list({ includeArchived: true })
        : await checklists.list();
      return { ok: true, data };
    },
    { query: t.Object({ includeArchived: t.Optional(t.Boolean()) }) },
  )
  .post(
    '/',
    async ({ request, body }) => {
      if (!requireLocalRouteAuth(request)) throw new AuthenticationError('Unauthorized');
      if (!body.title.trim()) throw new ValidationError('Checklists require a title');
      if (body.scope === 'session' && !body.sessionId?.trim())
        throw new ValidationError('Session checklists require an owning chat');
      if (body.scope === 'project' && !body.projectPath?.trim())
        throw new ValidationError('Project checklists require a project directory');
      const checklist = await asConflict(() =>
        getContext().checklists.create({
          title: body.title,
          // Left undefined so the store scopes a checklist created inside a
          // chat to that chat, and only falls back to workspace without one.
          scope: body.scope as ChecklistScope | undefined,
          projectPath: body.projectPath,
          sessionId: body.sessionId,
          items: body.items,
          actor: { name: 'you', role: 'human' },
        }),
      );
      return { ok: true, data: sendUpdate(checklist) };
    },
    {
      body: t.Object({
        title: t.String({ minLength: 1, maxLength: 1000 }),
        items: t.Optional(t.Array(t.String({ maxLength: 1000 }))),
        scope: t.Optional(t.Union(scopes.map((value) => t.Literal(value)))),
        projectPath: t.Optional(t.String()),
        sessionId: t.Optional(t.String()),
      }),
    },
  )
  .get('/:id', async ({ request, params }) => {
    if (!requireLocalRouteAuth(request)) throw new AuthenticationError('Unauthorized');
    const checklist = await getContext().checklists.get(params.id);
    if (!checklist) throw new NotFoundError('Checklist', params.id);
    return { ok: true, data: checklist };
  })
  /** Replace the plan. Items omitted here are deleted; surviving items keep
   *  their done/skipped state, which the store reads from disk rather than
   *  trusting this body. */
  .patch(
    '/:id/items',
    async ({ request, params, body }) => {
      if (!requireLocalRouteAuth(request)) throw new AuthenticationError('Unauthorized');
      if (!(await getContext().checklists.get(params.id)))
        throw new NotFoundError('Checklist', params.id);
      const checklist = await asConflict(() =>
        getContext().checklists.edit(
          params.id,
          body.items.map((item, index) => ({
            ...(item.id ? { id: item.id } : {}),
            title: item.title,
            order: item.order ?? index,
          })),
          { name: 'you', role: 'human' },
        ),
      );
      if (!checklist) throw new NotFoundError('Checklist', params.id);
      return { ok: true, data: sendUpdate(checklist) };
    },
    {
      body: t.Object({
        items: t.Array(
          t.Object({
            id: t.Optional(t.String({ minLength: 1, maxLength: 200 })),
            title: t.String({ minLength: 1, maxLength: 1000 }),
            order: t.Optional(t.Number()),
          }),
        ),
      }),
    },
  )
  /** Append without resending the plan -- what a row's "+" and an agent's
   *  add_checklist_item both land on. */
  .post(
    '/:id/items',
    async ({ request, params, body }) => {
      if (!requireLocalRouteAuth(request)) throw new AuthenticationError('Unauthorized');
      if (!(await getContext().checklists.get(params.id)))
        throw new NotFoundError('Checklist', params.id);
      if (!body.items.some((item) => item.trim()))
        throw new ValidationError('Provide at least one non-empty item');
      const checklist = await asConflict(() =>
        getContext().checklists.addItems(
          params.id,
          body.items,
          { name: 'you', role: 'human' },
          body.sessionId,
        ),
      );
      if (!checklist) throw new NotFoundError('Checklist', params.id);
      return { ok: true, data: sendUpdate(checklist) };
    },
    {
      body: t.Object({
        items: t.Array(t.String({ maxLength: 1000 })),
        sessionId: t.Optional(t.String()),
      }),
    },
  )
  .patch(
    '/:id/items/:itemId',
    async ({ request, params, body }) => {
      if (!requireLocalRouteAuth(request)) throw new AuthenticationError('Unauthorized');
      if (!(await getContext().checklists.get(params.id)))
        throw new NotFoundError('Checklist', params.id);
      const checklist = await asConflict(() =>
        getContext().checklists.setItemStatus(
          params.id,
          params.itemId,
          body.status as ChecklistItemStatus,
          { name: 'you', role: 'human' },
          body.sessionId,
        ),
      );
      if (!checklist) throw new NotFoundError('Checklist', params.id);
      return { ok: true, data: sendUpdate(checklist) };
    },
    {
      body: t.Object({
        status: t.Union(itemStatuses.map((value) => t.Literal(value))),
        sessionId: t.Optional(t.String()),
      }),
    },
  )
  .patch(
    '/:id',
    async ({ request, params, body }) => {
      if (!requireLocalRouteAuth(request)) throw new AuthenticationError('Unauthorized');
      if (!(await getContext().checklists.get(params.id)))
        throw new NotFoundError('Checklist', params.id);
      const { checklists } = getContext();
      let checklist: Checklist | undefined;
      if (body.title !== undefined) {
        if (!body.title.trim()) throw new ValidationError('Checklists require a title');
        checklist = await asConflict(() =>
          checklists.setTitle(params.id, body.title!, { name: 'you', role: 'human' }),
        );
      }
      if (body.archived === true)
        checklist = await asConflict(() =>
          checklists.archive(params.id, { name: 'you', role: 'human' }),
        );
      if (body.archived === false)
        checklist = await asConflict(() =>
          checklists.unarchive(params.id, { name: 'you', role: 'human' }),
        );
      if (!checklist) throw new NotFoundError('Checklist', params.id);
      return { ok: true, data: sendUpdate(checklist) };
    },
    {
      body: t.Object({
        title: t.Optional(t.String({ minLength: 1, maxLength: 1000 })),
        archived: t.Optional(t.Boolean()),
      }),
    },
  )
  .delete('/:id', async ({ request, params }) => {
    if (!requireLocalRouteAuth(request)) throw new AuthenticationError('Unauthorized');
    const removed = await getContext().checklists.delete(params.id);
    if (!removed) throw new NotFoundError('Checklist', params.id);
    sendUpdate(undefined, params.id);
    return { ok: true, data: { id: params.id, deleted: true } };
  });
