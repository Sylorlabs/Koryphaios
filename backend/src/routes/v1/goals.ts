import { Elysia, t } from 'elysia';
import { getContext } from '../../context';
import { requireLocalRouteAuth } from '../../auth/local-route-auth';
import type { Goal, GoalStatus } from '@koryphaios/shared';
import { GoalRunner } from '../../kory/goal-runner';
import { AuthenticationError, ConflictError, NotFoundError, ValidationError } from '../../errors/types';

const statuses = [
  'queued',
  'planning',
  'running',
  'paused',
  'blocked',
  'completed',
  'cancelled',
] as const;
const scopes = ['workspace', 'project', 'session'] as const;
const terminal = new Set<GoalStatus>(['completed', 'cancelled']);
const sendUpdate = (goal: Goal | undefined) => {
  if (goal)
    getContext().wsManager.broadcast({
      type: 'goals.updated',
      payload: { goal },
      timestamp: Date.now(),
      sessionId: goal.sessionId,
    });
  return goal;
};

export const goalRoutes = new Elysia({ prefix: '/api/goals' })
  .get('/', async ({ request }) => {
    if (!requireLocalRouteAuth(request)) throw new AuthenticationError('Unauthorized');
    return { ok: true, data: await getContext().goals.list() };
  })
  .post(
    '/',
    async ({ request, body }) => {
      if (!requireLocalRouteAuth(request)) throw new AuthenticationError('Unauthorized');
      if (body.scope === 'session' && !(await getContext().sessions.get(body.sessionId!)))
        throw new ValidationError('Session goals require an existing owning chat');
      return { ok: true, data: sendUpdate(await getContext().goals.create(body)) };
    },
    {
      body: t.Object({
        objective: t.String({ minLength: 1, maxLength: 2000 }),
        scope: t.Union(scopes.map((value) => t.Literal(value))),
        projectPath: t.Optional(t.String()),
        sessionId: t.Optional(t.String()),
        priority: t.Optional(t.Number()),
        planningDepth: t.Optional(
          t.Union([t.Literal('minimal'), t.Literal('adaptive'), t.Literal('structured')]),
        ),
      }),
    },
  )
  .patch(
    '/:id',
    async ({ request, params, body }) => {
      if (!requireLocalRouteAuth(request)) throw new AuthenticationError('Unauthorized');
      const prior = await getContext().goals.get(params.id);
      if (!prior) throw new NotFoundError('Goal', params.id);
      if (body.status || body.checklist)
        throw new ConflictError(
          'Use the Goal Mode lifecycle and evidence endpoints; status and checklist state cannot be patched directly.',
        );
      return {
        ok: true,
        data: sendUpdate(
          await getContext().goals.update(params.id, {
            ...body,
          }),
        ),
      };
    },
    {
      body: t.Partial(
        t.Object({
          objective: t.String(),
          priority: t.Number(),
          sortOrder: t.Number(),
          status: t.Union(statuses.map((value) => t.Literal(value))),
          checklist: t.Array(t.Any()),
          linkedSessionIds: t.Array(t.String()),
        }),
      ),
    },
  )
  .post(
    '/:id/drive',
    async ({ request, params, body }) => {
      if (!requireLocalRouteAuth(request)) throw new AuthenticationError('Unauthorized');
      const { goals, sessions, goalDriver } = getContext();
      const goal = await goals.get(params.id);
      const session = await sessions.get(body.sessionId);
      if (!goal) throw new NotFoundError('Goal', params.id);
      if (!session) throw new NotFoundError('Session', body.sessionId);
      if (goal.scope === 'session' && goal.sessionId !== body.sessionId)
        throw new ConflictError('This session goal can only run in its owning chat.');
      if (goal.scope === 'project' && session.workingDirectory !== goal.projectPath)
        throw new ConflictError('This project goal must run in a chat scoped to its project.');
      const started = await goalDriver.start(goal.id, {
        sessionId: body.sessionId,
        provider: body.provider,
        model: body.model,
        reasoningLevel: body.reasoningLevel,
        instructions: body.instructions,
        remotePlanApproved: body.remotePlanApproved,
      });
      return { ok: true, data: started };
    },
    {
      body: t.Object({
        sessionId: t.String(),
        provider: t.String(),
        model: t.String(),
        reasoningLevel: t.Optional(t.String()),
        instructions: t.Optional(t.String({ maxLength: 4000 })),
        remotePlanApproved: t.Optional(t.Boolean()),
      }),
    },
  )
  .post('/:id/pause', async ({ request, params }) => {
    if (!requireLocalRouteAuth(request)) throw new AuthenticationError('Unauthorized');
    return { ok: true, data: await getContext().goalDriver.pause(params.id) };
  })
  .post('/:id/resume', async ({ request, params }) => {
    if (!requireLocalRouteAuth(request)) throw new AuthenticationError('Unauthorized');
    return { ok: true, data: await getContext().goalDriver.resume(params.id) };
  })
  .post('/:id/stop', async ({ request, params }) => {
    if (!requireLocalRouteAuth(request)) throw new AuthenticationError('Unauthorized');
    return { ok: true, data: await getContext().goalDriver.stop(params.id) };
  })
  .post(
    '/:id/checklist/:itemId/complete',
    async ({ request, params, body }) => {
      if (!requireLocalRouteAuth(request)) throw new AuthenticationError('Unauthorized');
      const context = getContext();
      const current = await context.goals.get(params.id);
      const item = current?.checklist.find((entry) => entry.id === params.itemId);
      if (!current || !item) throw new NotFoundError('Checklist item', params.itemId);
      const sessionId = current.execution?.sessionId ?? current.sessionId;
      if (!sessionId)
        throw new ConflictError(
          'Start this goal in a chat before recording completion evidence',
        );
      const gate = await context.kory.verifyGoalItem(
        sessionId,
        current.objective,
        item.title,
        current.execution?.model,
      );
      if (!gate.passed)
        throw new ConflictError(gate.feedback ?? 'Critic rejected the completion evidence');
      const value = gate.skipped
        ? `Critic disabled by user; producer evidence: ${body.value}`
        : `${body.value}\nCritic PASS: ${gate.feedback ?? 'verified'}`;
      const goal = await context.goals.completeItem(params.id, params.itemId, {
        kind: body.kind,
        value,
      });
      return { ok: true, data: sendUpdate(goal) };
    },
    {
      body: t.Object({
        value: t.String(),
        kind: t.Union([t.Literal('check'), t.Literal('artifact'), t.Literal('note')]),
      }),
    },
  )
  .post('/:id/finalize', async ({ request, params }) => {
    if (!requireLocalRouteAuth(request)) throw new AuthenticationError('Unauthorized');
    const result = await new GoalRunner(getContext().goals).finalize(params.id);
    if (result.blocked) {
      // Broadcast the updated goal state (logic) before throwing so connected
      // clients see the latest state; the error response is handled by middleware.
      sendUpdate(result.goal);
      throw new ConflictError(result.blocked);
    }
    return { ok: true, data: sendUpdate(result.goal) };
  })
  .delete('/:id', async ({ request, params }) => {
    if (!requireLocalRouteAuth(request)) throw new AuthenticationError('Unauthorized');
    const goal = await getContext().goals.get(params.id);
    if (goal && !terminal.has(goal.status)) await getContext().goalDriver.stop(params.id);
    await getContext().goals.delete(params.id);
    getContext().wsManager.broadcast({
      type: 'goals.updated',
      payload: { deletedId: params.id },
      timestamp: Date.now(),
    });
    return { ok: true };
  });
