import { Elysia, t } from 'elysia';
import { getContext } from '../../context';
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
  .get('/', async () => {
    return { ok: true, data: await getContext().goals.list() };
  })
  .post('/', async ({ body, set }) => {
    try {
      return { ok: true, data: await getContext().goalDriver.pause(params.id) };
    } catch (error) {
      set.status = 409;
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
    catch (error) { set.status = 400; return { ok: false, error: error instanceof Error ? error.message : 'Invalid goal' }; }
  }, { body: t.Object({ objective: t.String({ minLength: 1, maxLength: 2000 }), scope: t.Union(scopes.map((value) => t.Literal(value))), projectPath: t.Optional(t.String()), sessionId: t.Optional(t.String()), linkedSessionIds: t.Optional(t.Array(t.String())), priority: t.Optional(t.Number()), planningDepth: t.Optional(t.Union([t.Literal('minimal'), t.Literal('adaptive'), t.Literal('structured')])), checklist: t.Optional(t.Array(t.Any())) }) })
  .patch('/:id', async ({ params, body, set }) => {
    const prior = await getContext().goals.get(params.id);
    if (!prior) { set.status = 404; return { ok: false, error: 'Goal not found' }; }
    if (body.status && (terminal.has(prior.status) && body.status !== prior.status)) { set.status = 409; return { ok: false, error: 'Terminal goals cannot be resumed; create a new goal.' }; }
    if (body.status === 'completed') { set.status = 409; return { ok: false, error: 'Use finalize: completion requires verified checklist evidence.' }; }
    if (body.status === 'paused') return { ok: true, data: sendUpdate(await getContext().goalDriver.pause(params.id)) };
    if (body.status === 'queued' && (prior.status === 'paused' || prior.status === 'blocked')) return { ok: true, data: sendUpdate(await getContext().goalDriver.resume(params.id)) };
    if (body.status === 'cancelled') return { ok: true, data: sendUpdate(await getContext().goalDriver.stop(params.id)) };
    const activity = body.status && body.status !== prior.status
      ? [...prior.activity, { id: crypto.randomUUID(), type: `goal_${body.status}`, message: `Goal ${body.status}`, createdAt: Date.now() }]
      : undefined;
    if (body.checklist) await getContext().goals.setChecklist(params.id, body.checklist as Goal['checklist']);
    return { ok: true, data: sendUpdate(await getContext().goals.update(params.id, { ...body, checklist: undefined, activity, blocker: body.blocker ?? undefined })) };
  }, { body: t.Partial(t.Object({ objective: t.String(), priority: t.Number(), sortOrder: t.Number(), status: t.Union(statuses.map((value) => t.Literal(value))), checklist: t.Array(t.Any()), linkedSessionIds: t.Array(t.String()), blocker: t.Nullable(t.String()) })) })
  .post('/:id/drive', async ({ params, body, set }) => {
    const { goals, sessions, goalDriver } = getContext(); const goal = await goals.get(params.id); const session = await sessions.get(body.sessionId);
    if (!goal || !session) { set.status = 404; return { ok: false, error: !goal ? 'Goal not found' : 'Session not found' }; }
    if (goal.scope === 'session' && goal.sessionId !== body.sessionId) { set.status = 409; return { ok: false, error: 'This session goal can only run in its owning chat.' }; }
    if (goal.scope === 'project' && session.workingDirectory !== goal.projectPath) { set.status = 409; return { ok: false, error: 'This project goal must run in a chat scoped to its project.' }; }
    const provider = body.provider; const policy = goalProviderPolicy(provider, body.remotePlanApproved === true);
    if (!policy.allowed) {
      const paused = await goals.update(goal.id, { status: 'paused', blocker: policy.reason }); sendUpdate(paused);
      set.status = 409; return { ok: false, error: policy.reason, data: paused };
    }
    const started = await goalDriver.start(goal.id, { sessionId: body.sessionId, provider, model: body.model, reasoningLevel: body.reasoningLevel, remotePlanApproved: body.remotePlanApproved });
    return { ok: true, data: sendUpdate(started), execution: { provider, ...policy, durable: true } };
  }, { body: t.Object({ sessionId: t.String(), provider: t.String(), model: t.String(), reasoningLevel: t.Optional(t.String()), instructions: t.Optional(t.String({ maxLength: 4000 })), remotePlanApproved: t.Optional(t.Boolean()) }) })
  .post('/:id/checklist/:itemId/complete', async ({ params, body, set }) => {
    try {
      const { goals, kory } = getContext();
      const pending = await goals.addItemEvidence(params.id, params.itemId, body);
      if (!pending) { set.status = 404; return { ok: false, error: 'Checklist item not found' }; }
      if (!pending.execution) { set.status = 409; return { ok: false, error: 'Start the goal with a provider before requesting verification', data: sendUpdate(pending) }; }
      const item = pending.checklist.find((entry) => entry.id === params.itemId)!;
      const verification = await kory.verifyGoalItem(pending.execution.sessionId, pending.objective, item.title, pending.execution.model);
      if (!verification.passed) { set.status = 409; return { ok: false, error: verification.feedback ?? 'Independent critic did not verify this item', data: sendUpdate(pending) }; }
      const goal = await goals.completeItem(params.id, params.itemId, {
        kind: 'check',
        value: verification.skipped
          ? 'Critic disabled by user; producer evidence accepted without a critic pass.'
          : `Independent Goal Mode critic PASS${verification.feedback ? `: ${verification.feedback}` : ''}`,
      });
      return { ok: true, data: sendUpdate(goal) };
    }
    catch (error) { set.status = 409; return { ok: false, error: error instanceof Error ? error.message : String(error) }; }
  }, { body: t.Object({ value: t.String(), kind: t.Union([t.Literal('check'), t.Literal('artifact'), t.Literal('note')]) }) })
  .post('/:id/finalize', async ({ params, set }) => {
    const result = await new GoalRunner(getContext().goals).finalize(params.id);
    if (result.blocked) {
      set.status = 409;
      return { ok: false, error: result.blocked, data: sendUpdate(result.goal) };
    }
    return { ok: true, data: sendUpdate(result.goal) };
  })
  .post('/:id/pause', async ({ params, set }) => {
    try { return { ok: true, data: sendUpdate(await getContext().goalDriver.pause(params.id)) }; }
    catch (error) { set.status = 409; return { ok: false, error: error instanceof Error ? error.message : String(error) }; }
  })
  .post('/:id/resume', async ({ params, set }) => {
    try { return { ok: true, data: sendUpdate(await getContext().goalDriver.resume(params.id)) }; }
    catch (error) { set.status = 409; return { ok: false, error: error instanceof Error ? error.message : String(error) }; }
  })
  .post('/:id/stop', async ({ params, set }) => {
    try { return { ok: true, data: sendUpdate(await getContext().goalDriver.stop(params.id)) }; }
    catch (error) { set.status = 409; return { ok: false, error: error instanceof Error ? error.message : String(error) }; }
  })
  .delete('/:id', async ({ params }) => {
    await getContext().goals.delete(params.id); getContext().wsManager.broadcast({ type: 'goals.updated', payload: { deletedId: params.id }, timestamp: Date.now() }); return { ok: true };
  });
