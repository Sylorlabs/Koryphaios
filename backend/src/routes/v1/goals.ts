import { Elysia, t } from 'elysia';
import { getContext } from '../../context';
import { requireLocalRouteAuth } from '../../auth/local-route-auth';
import type { Goal, GoalStatus } from '@koryphaios/shared';
import { GoalRunner } from '../../kory/goal-runner';
import { sanitizeGoalEvidence } from '../../stores/goal-store';
import {
  AuthenticationError,
  ConflictError,
  NotFoundError,
  ValidationError,
} from '../../errors/types';

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
      if (!body.objective.trim()) throw new ValidationError('Goals require an objective');
      if (body.scope === 'project' && !body.projectPath?.trim())
        throw new ValidationError('Project goals require a project directory');
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
      if (body.status || body.checklist || body.linkedSessionIds)
        throw new ConflictError(
          'Use the Goal Mode lifecycle and evidence endpoints; status, checklist, and linked-chat state cannot be patched directly.',
        );
      if (body.objective !== undefined && !body.objective.trim())
        throw new ValidationError('Goals require an objective');
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
      let started: Goal;
      try {
        started = await goalDriver.start(goal.id, {
          sessionId: body.sessionId,
          provider: body.provider,
          model: body.model,
          reasoningLevel: body.reasoningLevel,
          instructions: body.instructions,
          remotePlanApproved: body.remotePlanApproved,
        });
      } catch (error) {
        throw new ConflictError(error instanceof Error ? error.message : 'Goal could not start');
      }
      return { ok: true, data: started };
    },
    {
      body: t.Object({
        sessionId: t.String(),
        provider: t.String({ minLength: 1, maxLength: 120 }),
        model: t.String({ minLength: 1, maxLength: 240 }),
        reasoningLevel: t.Optional(t.String()),
        instructions: t.Optional(t.String({ maxLength: 4000 })),
        remotePlanApproved: t.Optional(t.Boolean()),
      }),
    },
  )
  .post('/:id/pause', async ({ request, params }) => {
    if (!requireLocalRouteAuth(request)) throw new AuthenticationError('Unauthorized');
    if (!(await getContext().goals.get(params.id))) throw new NotFoundError('Goal', params.id);
    try {
      return { ok: true, data: await getContext().goalDriver.pause(params.id) };
    } catch (error) {
      throw new ConflictError(error instanceof Error ? error.message : 'Goal could not pause');
    }
  })
  .post('/:id/resume', async ({ request, params }) => {
    if (!requireLocalRouteAuth(request)) throw new AuthenticationError('Unauthorized');
    if (!(await getContext().goals.get(params.id))) throw new NotFoundError('Goal', params.id);
    try {
      return { ok: true, data: await getContext().goalDriver.resume(params.id) };
    } catch (error) {
      throw new ConflictError(error instanceof Error ? error.message : 'Goal could not resume');
    }
  })
  .post('/:id/stop', async ({ request, params }) => {
    if (!requireLocalRouteAuth(request)) throw new AuthenticationError('Unauthorized');
    if (!(await getContext().goals.get(params.id))) throw new NotFoundError('Goal', params.id);
    try {
      return { ok: true, data: await getContext().goalDriver.stop(params.id) };
    } catch (error) {
      throw new ConflictError(error instanceof Error ? error.message : 'Goal could not stop');
    }
  })
  .post(
    '/:id/checklist/:itemId/complete',
    async ({ request, params, body }) => {
      if (!requireLocalRouteAuth(request)) throw new AuthenticationError('Unauthorized');
      const context = getContext();
      const current = await context.goals.get(params.id);
      const item = current?.checklist.find((entry) => entry.id === params.itemId);
      if (!current || !item) throw new NotFoundError('Checklist item', params.itemId);
      if (current.status !== 'running' || item.status !== 'running') {
        throw new ConflictError(
          'Start this checklist item in a running goal before submitting completion evidence.',
        );
      }
      if (
        item.dependsOn.some(
          (dependency) =>
            current.checklist.find((entry) => entry.id === dependency)?.status !== 'completed',
        )
      ) {
        throw new ConflictError("Complete this checklist item's dependencies first.");
      }
      const sessionId = current.execution?.sessionId ?? current.sessionId;
      if (!sessionId)
        throw new ConflictError('Start this goal in a chat before recording completion evidence');
      const producerProvider = current.execution?.provider?.trim();
      const producerModel = current.execution?.model?.trim();
      const attemptId = current.execution?.attemptId?.trim();
      if (!producerProvider || !producerModel || !attemptId) {
        throw new ConflictError(
          'Goal producer identity or execution attempt is unavailable; restart the goal with an explicit provider and model.',
        );
      }
      const producerEvidence = sanitizeGoalEvidence(body.value);
      let gate: Awaited<ReturnType<typeof context.kory.verifyGoalItem>>;
      try {
        gate = await context.kory.verifyGoalItem(
          sessionId,
          current.objective,
          item.title,
          producerEvidence,
          current.execution?.model,
          producerProvider,
        );
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        gate = {
          passed: false,
          feedback: sanitizeGoalEvidence(`Independent verifier failed to run: ${detail}`),
        };
      }
      const goal = await context.goals.completeItem(
        params.id,
        params.itemId,
        {
          producer: {
            kind: body.kind,
            value: producerEvidence,
            provider: producerProvider,
            model: producerModel,
          },
          verifier: gate,
        },
        attemptId,
      );
      if (!goal) {
        throw new ConflictError(
          'The Goal was paused, stopped, or restarted while evidence was being verified.',
        );
      }
      sendUpdate(goal);
      if (gate.skipped) {
        throw new ConflictError(
          'Evidence was saved but remains unverified because the Goal Mode critic is disabled.',
        );
      }
      if (!gate.passed) {
        throw new ConflictError('Independent verification rejected the completion evidence.');
      }
      if (goal.checklist.find((entry) => entry.id === params.itemId)?.status !== 'completed') {
        throw new ConflictError(
          'Evidence was saved but independent verifier provenance could not be established.',
        );
      }
      return { ok: true, data: goal };
    },
    {
      body: t.Object({
        value: t.String({ minLength: 1, maxLength: 8_000 }),
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
