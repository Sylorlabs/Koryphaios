import { nanoid } from 'nanoid';
import { asc, desc, eq } from 'drizzle-orm';
import { db, goals } from '../db';
import { serverLog } from '../logger';
import type { Goal, GoalChecklistItem, GoalScope, GoalStatus } from '@koryphaios/shared';

const parse = <T>(value: string | null | undefined, fallback: T): T => {
  if (!value) return fallback;
  try { return JSON.parse(value); } catch (err: unknown) {
    serverLog.debug({ err: err instanceof Error ? err.message : String(err) }, 'goal JSON parse failed — using fallback');
    return fallback;
  }
};
const active = (status: GoalStatus) => status === 'running';

/** Reject malformed dependency graphs at the persistence boundary. */
function validateChecklist(checklist: GoalChecklistItem[]) {
  const ids = new Set<string>();
  for (const item of checklist) {
    if (!item.id || ids.has(item.id)) throw new Error('Checklist item IDs must be unique');
    if (!item.title.trim()) throw new Error('Checklist items require a title');
    ids.add(item.id);
  }
  for (const item of checklist) {
    if (item.dependsOn.some((dependency) => dependency === item.id || !ids.has(dependency))) {
      throw new Error(`Checklist item "${item.title}" has an invalid dependency`);
    }
  }
  const visiting = new Set<string>(); const visited = new Set<string>();
  const byId = new Map(checklist.map((item) => [item.id, item]));
  const visit = (id: string): void => {
    if (visited.has(id)) return;
    if (visiting.has(id)) throw new Error('Checklist dependencies cannot contain a cycle');
    visiting.add(id);
    for (const dependency of byId.get(id)?.dependsOn ?? []) visit(dependency);
    visiting.delete(id); visited.add(id);
  };
  for (const item of checklist) visit(item.id);
}
function model(row: typeof goals.$inferSelect): Goal {
  return { id: row.id, objective: row.objective, scope: row.scope as GoalScope, projectPath: row.projectPath ?? undefined, sessionId: row.sessionId ?? undefined, priority: row.priority, sortOrder: row.sortOrder, status: row.status as GoalStatus, checklist: parse(row.checklist, []), linkedSessionIds: parse(row.linkedSessionIds, []), activity: parse(row.activity, []), blocker: row.blocker ?? undefined, execution: parse(row.execution, undefined), activeDurationMs: row.activeDurationMs, activeStartedAt: row.activeStartedAt?.getTime(), createdAt: row.createdAt.getTime(), updatedAt: row.updatedAt.getTime() };
}
export class GoalStore {
  async list(): Promise<Goal[]> { return (await db.select().from(goals).orderBy(desc(goals.priority), asc(goals.sortOrder))).map(model); }
  async get(id: string) { const row = await db.query.goals.findFirst({ where: eq(goals.id, id) }); return row ? model(row) : undefined; }
  async create(input: Pick<Goal, 'objective' | 'scope'> & Partial<Goal> & { planningDepth?: 'minimal' | 'adaptive' | 'structured' }): Promise<Goal> {
    if (input.scope === 'project' && !input.projectPath) throw new Error('Project goals require projectPath');
    if (input.scope === 'session' && !input.sessionId) throw new Error('Session goals require sessionId');
    const now = new Date(); const id = nanoid();
    const first = nanoid(); const second = nanoid(); const third = nanoid(); const fourth = nanoid();
    const planningDepth = input.planningDepth ?? 'adaptive';
    const checklist = input.checklist?.length ? input.checklist : planningDepth === 'minimal' ? [
      { id: first, title: 'Perform the objective', status: 'pending' as const, order: 0, dependsOn: [], evidence: [] },
      { id: second, title: 'Verify the success criteria', status: 'pending' as const, order: 1, dependsOn: [first], evidence: [] },
    ] : planningDepth === 'structured' ? [
      { id: first, title: 'Discover the relevant workspace context', status: 'pending' as const, order: 0, dependsOn: [], evidence: [] },
      { id: second, title: 'Create and validate the execution plan', status: 'pending' as const, order: 1, dependsOn: [first], evidence: [] },
      { id: third, title: 'Implement or perform the objective', status: 'pending' as const, order: 2, dependsOn: [second], evidence: [] },
      { id: fourth, title: 'Verify the success criteria', status: 'pending' as const, order: 3, dependsOn: [third], evidence: [] },
    ] : [
      { id: first, title: 'Discover the relevant workspace context', status: 'pending' as const, order: 0, dependsOn: [], evidence: [] },
      { id: second, title: 'Implement or perform the objective', status: 'pending' as const, order: 1, dependsOn: [first], evidence: [] },
      { id: third, title: 'Verify the success criteria', status: 'pending' as const, order: 2, dependsOn: [second], evidence: [] },
    ];
    validateChecklist(checklist);
    const [row] = await db.insert(goals).values({ id, objective: input.objective.trim(), scope: input.scope, projectPath: input.projectPath ?? null, sessionId: input.sessionId ?? null, priority: input.priority ?? 0, sortOrder: input.sortOrder ?? now.getTime(), status: input.status ?? 'queued', checklist: JSON.stringify(checklist), linkedSessionIds: JSON.stringify(input.linkedSessionIds ?? (input.sessionId ? [input.sessionId] : [])), activity: JSON.stringify([{ id: nanoid(), type: 'created', message: 'Goal created', createdAt: now.getTime() }]), activeDurationMs: 0, createdAt: now, updatedAt: now }).returning(); return model(row);
  }
  async update(id: string, patch: Partial<Goal>): Promise<Goal | undefined> {
    const prior = await this.get(id); if (!prior) return undefined;
    const now = Date.now(); const status = patch.status ?? prior.status; const wasActive = active(prior.status); const isActive = active(status);
    const duration = prior.activeDurationMs + (wasActive && prior.activeStartedAt ? now - prior.activeStartedAt : 0);
    const [row] = await db.update(goals).set({ objective: patch.objective?.trim(), priority: patch.priority, sortOrder: patch.sortOrder, status, checklist: patch.checklist ? JSON.stringify(patch.checklist) : undefined, linkedSessionIds: patch.linkedSessionIds ? JSON.stringify(patch.linkedSessionIds) : undefined, activity: patch.activity ? JSON.stringify(patch.activity) : undefined, blocker: patch.blocker === undefined ? prior.blocker ?? null : patch.blocker ?? null, execution: patch.execution ? JSON.stringify(patch.execution) : undefined, activeDurationMs: duration, activeStartedAt: isActive ? new Date(now) : null, updatedAt: new Date(now) }).where(eq(goals.id, id)).returning(); return row ? model(row) : undefined;
  }
  async delete(id: string) { await db.delete(goals).where(eq(goals.id, id)); }
  async addActivity(id: string, type: string, message: string, sessionId?: string) { const goal = await this.get(id); if (!goal) return undefined; return this.update(id, { activity: [...goal.activity, { id: nanoid(), type, message, sessionId, createdAt: Date.now() }] }); }
  async setChecklist(id: string, checklist: GoalChecklistItem[]) { validateChecklist(checklist); return this.update(id, { checklist }); }
  async completeItem(id: string, itemId: string, evidence: { kind: 'check' | 'artifact' | 'note'; value: string }): Promise<Goal | undefined> {
    const goal = await this.get(id); const item = goal?.checklist.find((entry) => entry.id === itemId);
    if (!goal || !item) return undefined;
    if (item.status !== 'running') throw new Error('Start the checklist item before attaching completion evidence');
    if (item.dependsOn.some((dependency) => goal.checklist.find((entry) => entry.id === dependency)?.status !== 'completed')) throw new Error('Complete dependencies before this checklist item');
    const checklist = goal.checklist.map((entry) => entry.id === itemId ? { ...entry, status: 'completed' as const, completedAt: Date.now(), evidence: [...entry.evidence, { id: nanoid(), ...evidence, verified: true, createdAt: Date.now() }] } : entry);
    return this.update(id, { checklist, activity: [...goal.activity, { id: nanoid(), type: 'item_completed', message: `Verified: ${item.title}`, createdAt: Date.now() }] });
  }
  async resetItem(id: string, itemId: string, reason: string): Promise<Goal | undefined> {
    const goal = await this.get(id); const item = goal?.checklist.find((entry) => entry.id === itemId);
    if (!goal || !item) return undefined;
    const checklist = goal.checklist.map((entry) => entry.id === itemId ? { ...entry, status: 'pending' as const, startedAt: undefined } : entry);
    return this.update(id, { status: 'queued', checklist, blocker: undefined, activity: [...goal.activity, { id: nanoid(), type: 'item_retry', message: reason, createdAt: Date.now() }] });
  }
  async finalize(id: string): Promise<Goal | undefined> {
    const goal = await this.get(id); if (!goal) return undefined;
    const incomplete = goal.checklist.find((item) => item.status !== 'completed' || !item.evidence.some((proof) => proof.verified));
    if (incomplete) throw new Error(`Goal cannot complete: "${incomplete.title}" lacks verified completion evidence`);
    return this.update(id, { status: 'completed', blocker: undefined, activity: [...goal.activity, { id: nanoid(), type: 'completed', message: 'All checklist evidence and final success criteria verified.', createdAt: Date.now() }] });
  }
}
