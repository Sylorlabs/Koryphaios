import { Elysia, t } from 'elysia';
import { getContext } from '../../context';
import { requireLocalRouteAuth } from '../../auth/local-route-auth';
import type { Goal, GoalStatus } from '@koryphaios/shared';
import { GoalRunner } from '../../kory/goal-runner';

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
  .get('/', async ({ request, set }) => {
    if (!requireLocalRouteAuth(request, set)) return { ok: false, error: 'Unauthorized' };
    return { ok: true, data: await getContext().goals.list() };
  })
  .post(
    '/',
    async ({ request, body, set }) => {
      if (!requireLocalRouteAuth(request, set)) return { ok: false, error: 'Unauthorized' };
      try {
        if (body.scope === 'session' && !(await getContext().sessions.get(body.sessionId!)))
          throw new Error('Session goals require an existing owning chat');
        return { ok: true, data: sendUpdate(await getContext().goals.create(body)) };
      } catch (error) {
        set.status = 400;
        return { ok: false, error: error instanceof Error ? error.message : 'Invalid goal' };
      }
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
    async ({ request, params, body, set }) => {
      if (!requireLocalRouteAuth(request, set)) return { ok: false, error: 'Unauthorized' };
      const prior = await getContext().goals.get(params.id);
      if (!prior) {
        set.status = 404;
        return { ok: false, error: 'Goal not found' };
      }
      if (body.status || body.checklist) {
        set.status = 409;
        return {
          ok: false,
          error:
            'Use the Goal Mode lifecycle and evidence endpoints; status and checklist state cannot be patched directly.',
        };
      }
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
    async ({ request, params, body, set }) => {
      if (!requireLocalRouteAuth(request, set)) return { ok: false, error: 'Unauthorized' };
      const { goals, sessions, goalDriver } = getContext();
      const goal = await goals.get(params.id);
      const session = await sessions.get(body.sessionId);
      if (!goal || !session) {
        set.status = 404;
        return { ok: false, error: !goal ? 'Goal not found' : 'Session not found' };
      }
      if (goal.scope === 'session' && goal.sessionId !== body.sessionId) {
        set.status = 409;
        return { ok: false, error: 'This session goal can only run in its owning chat.' };
      }
      if (goal.scope === 'project' && session.workingDirectory !== goal.projectPath) {
        set.status = 409;
        return { ok: false, error: 'This project goal must run in a chat scoped to its project.' };
      }
      try {
        const started = await goalDriver.start(goal.id, {
          sessionId: body.sessionId,
          provider: body.provider,
          model: body.model,
          reasoningLevel: body.reasoningLevel,
          instructions: body.instructions,
          remotePlanApproved: body.remotePlanApproved,
        });
        return { ok: true, data: started };
      } catch (error) {
        set.status = 409;
        return {
          ok: false,
          error: error instanceof Error ? error.message : String(error),
          data: await goals.get(goal.id),
        };
      }
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
  .post('/:id/pause', async ({ request, params, set }) => {
    if (!requireLocalRouteAuth(request, set)) return { ok: false, error: 'Unauthorized' };
    try {
      return { ok: true, data: await getContext().goalDriver.pause(params.id) };
    } catch (error) {
      set.status = 409;
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  })
  .post('/:id/resume', async ({ request, params, set }) => {
    if (!requireLocalRouteAuth(request, set)) return { ok: false, error: 'Unauthorized' };
    try {
      return { ok: true, data: await getContext().goalDriver.resume(params.id) };
    } catch (error) {
      set.status = 409;
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  })
  .post('/:id/stop', async ({ request, params, set }) => {
    if (!requireLocalRouteAuth(request, set)) return { ok: false, error: 'Unauthorized' };
    try {
      return { ok: true, data: await getContext().goalDriver.stop(params.id) };
    } catch (error) {
      set.status = 409;
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  })
  .post(
    '/:id/checklist/:itemId/complete',
    async ({ request, params, body, set }) => {
      if (!requireLocalRouteAuth(request, set)) return { ok: false, error: 'Unauthorized' };
      try {
        const context = getContext();
        const current = await context.goals.get(params.id);
        const item = current?.checklist.find((entry) => entry.id === params.itemId);
        if (!current || !item) {
          set.status = 404;
          return { ok: false, error: 'Checklist item not found' };
        }
        const sessionId = current.execution?.sessionId ?? current.sessionId;
        if (!sessionId) {
          set.status = 409;
          return {
            ok: false,
            error: 'Start this goal in a chat before recording completion evidence',
          };
        }
        const gate = await context.kory.verifyGoalItem(
          sessionId,
          current.objective,
          item.title,
          current.execution?.model,
        );
        if (!gate.passed) {
          set.status = 409;
          return { ok: false, error: gate.feedback ?? 'Critic rejected the completion evidence' };
        }
        const value = gate.skipped
          ? `Critic disabled by user; producer evidence: ${body.value}`
          : `${body.value}\nCritic PASS: ${gate.feedback ?? 'verified'}`;
        const goal = await context.goals.completeItem(params.id, params.itemId, {
          kind: body.kind,
          value,
        });
        return { ok: true, data: sendUpdate(goal) };
      } catch (error) {
        set.status = 409;
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
      }
    },
    {
      body: t.Object({
        value: t.String(),
        kind: t.Union([t.Literal('check'), t.Literal('artifact'), t.Literal('note')]),
      }),
    },
  )
  .post('/:id/finalize', async ({ request, params, set }) => {
    if (!requireLocalRouteAuth(request, set)) return { ok: false, error: 'Unauthorized' };
    const result = await new GoalRunner(getContext().goals).finalize(params.id);
    if (result.blocked) {
      set.status = 409;
      return { ok: false, error: result.blocked, data: sendUpdate(result.goal) };
    }
    return { ok: true, data: sendUpdate(result.goal) };
  })
  .delete('/:id', async ({ request, params, set }) => {
    if (!requireLocalRouteAuth(request, set)) return { ok: false, error: 'Unauthorized' };
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
