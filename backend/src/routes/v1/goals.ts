import { Elysia, t } from 'elysia';
import { getContext } from '../../context';
import { requireLocalRouteAuth } from '../../auth/local-route-auth';
import type { Goal, GoalStatus } from '@koryphaios/shared';
import { GoalRunner, goalProviderPolicy } from '../../kory/goal-runner';

const statuses = ['queued', 'planning', 'running', 'paused', 'blocked', 'completed', 'cancelled'] as const;
const scopes = ['workspace', 'project', 'session'] as const;
const terminal = new Set<GoalStatus>(['completed', 'cancelled']);
const sendUpdate = (goal: Goal | undefined) => { if (goal) getContext().wsManager.broadcast({ type: 'goals.updated', payload: { goal }, timestamp: Date.now(), sessionId: goal.sessionId }); return goal; };

export const goalRoutes = new Elysia({ prefix: '/api/goals' })
  .get('/', async ({ request, set }) => {
    if (!requireLocalRouteAuth(request, set)) return { ok: false, error: 'Unauthorized' };
    return { ok: true, data: await getContext().goals.list() };
  })
  .post('/', async ({ request, body, set }) => {
    if (!requireLocalRouteAuth(request, set)) return { ok: false, error: 'Unauthorized' };
    try {
      if (body.scope === 'session' && !(await getContext().sessions.get(body.sessionId!))) throw new Error('Session goals require an existing owning chat');
      return { ok: true, data: sendUpdate(await getContext().goals.create(body)) };
    }
    catch (error) { set.status = 400; return { ok: false, error: error instanceof Error ? error.message : 'Invalid goal' }; }
  }, { body: t.Object({ objective: t.String({ minLength: 1, maxLength: 2000 }), scope: t.Union(scopes.map((value) => t.Literal(value))), projectPath: t.Optional(t.String()), sessionId: t.Optional(t.String()), linkedSessionIds: t.Optional(t.Array(t.String())), priority: t.Optional(t.Number()), planningDepth: t.Optional(t.Union([t.Literal('minimal'), t.Literal('adaptive'), t.Literal('structured')])), checklist: t.Optional(t.Array(t.Any())) }) })
  .patch('/:id', async ({ request, params, body, set }) => {
    if (!requireLocalRouteAuth(request, set)) return { ok: false, error: 'Unauthorized' };
    const prior = await getContext().goals.get(params.id);
    if (!prior) { set.status = 404; return { ok: false, error: 'Goal not found' }; }
    if (body.status && (terminal.has(prior.status) && body.status !== prior.status)) { set.status = 409; return { ok: false, error: 'Terminal goals cannot be resumed; create a new goal.' }; }
    if (body.status === 'completed') { set.status = 409; return { ok: false, error: 'Use finalize: completion requires verified checklist evidence.' }; }
    const activity = body.status && body.status !== prior.status
      ? [...prior.activity, { id: crypto.randomUUID(), type: `goal_${body.status}`, message: `Goal ${body.status}`, createdAt: Date.now() }]
      : undefined;
    if (body.checklist) await getContext().goals.setChecklist(params.id, body.checklist as Goal['checklist']);
    return { ok: true, data: sendUpdate(await getContext().goals.update(params.id, { ...body, checklist: undefined, activity, blocker: body.blocker ?? undefined })) };
  }, { body: t.Partial(t.Object({ objective: t.String(), priority: t.Number(), sortOrder: t.Number(), status: t.Union(statuses.map((value) => t.Literal(value))), checklist: t.Array(t.Any()), linkedSessionIds: t.Array(t.String()), blocker: t.Nullable(t.String()) })) })
  .post('/:id/drive', async ({ request, params, body, set }) => {
    if (!requireLocalRouteAuth(request, set)) return { ok: false, error: 'Unauthorized' };
    const { goals, sessions, kory } = getContext(); const goal = await goals.get(params.id); const session = await sessions.get(body.sessionId);
    if (!goal || !session) { set.status = 404; return { ok: false, error: !goal ? 'Goal not found' : 'Session not found' }; }
    if (goal.scope === 'session' && goal.sessionId !== body.sessionId) { set.status = 409; return { ok: false, error: 'This session goal can only run in its owning chat.' }; }
    if (goal.scope === 'project' && session.workingDirectory !== goal.projectPath) { set.status = 409; return { ok: false, error: 'This project goal must run in a chat scoped to its project.' }; }
    const provider = body.provider; const policy = goalProviderPolicy(provider, body.remotePlanApproved === true);
    if (!policy.allowed) {
      const paused = await goals.update(goal.id, { status: 'paused', blocker: policy.reason }); sendUpdate(paused);
      set.status = 409; return { ok: false, error: policy.reason, data: paused };
    }
    const runner = new GoalRunner(goals); const started = await runner.startNext(goal.id);
    if (!started.item || !started.goal) { const current = sendUpdate(started.goal); set.status = 409; return { ok: false, error: started.blocked ?? 'No eligible checklist item', data: current }; }
    const linked = started.goal.linkedSessionIds.includes(body.sessionId) ? started.goal : await goals.update(goal.id, { linkedSessionIds: [...started.goal.linkedSessionIds, body.sessionId] });
    const running = await goals.addActivity(goal.id, 'provider_dispatched', `${provider}: ${policy.verification}${policy.reason ? ` — ${policy.reason}` : ''}`, body.sessionId);
    sendUpdate(running ?? linked);
    const prompt = `[GOAL MODE — immutable goal ${goal.id}]
Objective: ${goal.objective}
Active checklist item: ${started.item.title}
Provider verification status: ${policy.verification}.
Perform exactly this ready item. Report concrete artifacts/check output. Never claim the item or goal complete without verified evidence; a native CLI or remote Jules result must be independently verified before completion.${body.instructions?.trim() ? `\nUser direction for this item: ${body.instructions.trim()}` : ''}`;
    void kory.processTask(body.sessionId, prompt, body.model, body.reasoningLevel, undefined, undefined, undefined, {
      goalId: goal.id, objective: goal.objective, itemId: started.item.id, itemTitle: started.item.title, verification: policy.verification,
    }).catch(async (error) => {
      const failed = await goals.update(goal.id, { status: 'blocked', blocker: `Provider dispatch failed: ${error instanceof Error ? error.message : String(error)}` }); sendUpdate(failed);
    });
    return { ok: true, data: sendUpdate(await goals.get(goal.id)), execution: { provider, ...policy, itemId: started.item.id } };
  }, { body: t.Object({ sessionId: t.String(), provider: t.String(), model: t.String(), reasoningLevel: t.Optional(t.String()), instructions: t.Optional(t.String({ maxLength: 4000 })), remotePlanApproved: t.Optional(t.Boolean()) }) })
  .post('/:id/checklist/:itemId/complete', async ({ request, params, body, set }) => {
    if (!requireLocalRouteAuth(request, set)) return { ok: false, error: 'Unauthorized' };
    try { const goal = await getContext().goals.completeItem(params.id, params.itemId, body); if (!goal) { set.status = 404; return { ok: false, error: 'Checklist item not found' }; } return { ok: true, data: sendUpdate(goal) }; }
    catch (error) { set.status = 409; return { ok: false, error: error instanceof Error ? error.message : String(error) }; }
  }, { body: t.Object({ value: t.String(), kind: t.Union([t.Literal('check'), t.Literal('artifact'), t.Literal('note')]) }) })
  .post('/:id/finalize', async ({ request, params, set }) => {
    if (!requireLocalRouteAuth(request, set)) return { ok: false, error: 'Unauthorized' };
    const result = await new GoalRunner(getContext().goals).finalize(params.id);
    if (result.blocked) { set.status = 409; return { ok: false, error: result.blocked, data: sendUpdate(result.goal) }; }
    return { ok: true, data: sendUpdate(result.goal) };
  })
  .delete('/:id', async ({ request, params, set }) => {
    if (!requireLocalRouteAuth(request, set)) return { ok: false, error: 'Unauthorized' };
    await getContext().goals.delete(params.id); getContext().wsManager.broadcast({ type: 'goals.updated', payload: { deletedId: params.id }, timestamp: Date.now() }); return { ok: true };
  });
