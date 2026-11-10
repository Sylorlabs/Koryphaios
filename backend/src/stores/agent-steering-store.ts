import type { AgentSteeringCommand, AgentSteeringStatus } from '@koryphaios/shared';
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { nanoid } from 'nanoid';
import { db, agentSteeringCommands } from '../db';

type Row = typeof agentSteeringCommands.$inferSelect;

function mapRow(row: Row): AgentSteeringCommand {
  return {
    id: row.id,
    sessionId: row.sessionId,
    agentId: row.agentId,
    content: row.content,
    ...(row.model ? { model: row.model } : {}),
    ...(row.reasoningLevel ? { reasoningLevel: row.reasoningLevel } : {}),
    status: row.status as AgentSteeringStatus,
    position: row.position,
    createdAt: row.createdAt.getTime(),
    updatedAt: row.updatedAt.getTime(),
    ...(row.startedAt ? { startedAt: row.startedAt.getTime() } : {}),
    ...(row.finishedAt ? { finishedAt: row.finishedAt.getTime() } : {}),
    ...(row.error ? { error: row.error } : {}),
  };
}

const editable = ['queued'] as const;

export class AgentSteeringStore {
  async list(sessionId: string, agentId: string): Promise<AgentSteeringCommand[]> {
    const rows = await db
      .select()
      .from(agentSteeringCommands)
      .where(and(
        eq(agentSteeringCommands.sessionId, sessionId),
        eq(agentSteeringCommands.agentId, agentId),
        inArray(agentSteeringCommands.status, ['queued', 'dispatching', 'running']),
      ))
      .orderBy(asc(agentSteeringCommands.position), asc(agentSteeringCommands.createdAt));
    return rows.map(mapRow);
  }

  async enqueue(input: {
    sessionId: string;
    agentId: string;
    content: string;
    model?: string;
    reasoningLevel?: string;
  }): Promise<AgentSteeringCommand> {
    const now = new Date();
    const id = nanoid(16);
    const [row] = await db
      .insert(agentSteeringCommands)
      .values({
        id,
        sessionId: input.sessionId,
        agentId: input.agentId,
        content: input.content,
        model: input.model,
        reasoningLevel: input.reasoningLevel,
        status: 'queued',
        position: sql<number>`coalesce((select max(position) + 1 from agent_steering_commands where session_id = ${input.sessionId} and agent_id = ${input.agentId} and status in ('queued', 'dispatching', 'running')), 0)`,
        createdAt: now,
        updatedAt: now,
      })
      .returning();
    if (!row) throw new Error('Could not queue steering command');
    return mapRow(row);
  }

  async claimNext(sessionId: string, agentId: string): Promise<AgentSteeringCommand | null> {
    const next = await db
      .select()
      .from(agentSteeringCommands)
      .where(and(
        eq(agentSteeringCommands.sessionId, sessionId),
        eq(agentSteeringCommands.agentId, agentId),
        eq(agentSteeringCommands.status, 'queued'),
      ))
      .orderBy(asc(agentSteeringCommands.position), asc(agentSteeringCommands.createdAt))
      .limit(1);
    const row = next[0];
    if (!row) return null;
    const now = new Date();
    const updated = await db
      .update(agentSteeringCommands)
      .set({ status: 'dispatching', updatedAt: now, startedAt: now })
      .where(and(eq(agentSteeringCommands.id, row.id), eq(agentSteeringCommands.status, 'queued')))
      .returning();
    return updated[0] ? mapRow(updated[0]) : null;
  }

  async updateStatus(id: string, status: AgentSteeringStatus, error?: string): Promise<AgentSteeringCommand | null> {
    const now = new Date();
    const [row] = await db
      .update(agentSteeringCommands)
      .set({
        status,
        updatedAt: now,
        ...(status === 'completed' || status === 'cancelled' || status === 'failed' ? { finishedAt: now } : {}),
        ...(error !== undefined ? { error } : {}),
      })
      .where(eq(agentSteeringCommands.id, id))
      .returning();
    return row ? mapRow(row) : null;
  }

  async edit(id: string, content: string): Promise<AgentSteeringCommand> {
    const now = new Date();
    const [row] = await db
      .update(agentSteeringCommands)
      .set({ content, updatedAt: now })
      .where(and(eq(agentSteeringCommands.id, id), inArray(agentSteeringCommands.status, [...editable])))
      .returning();
    if (!row) throw new Error('Only queued steering can be edited');
    return mapRow(row);
  }

  async remove(id: string): Promise<AgentSteeringCommand> {
    const now = new Date();
    const [row] = await db
      .update(agentSteeringCommands)
      .set({ status: 'cancelled', updatedAt: now, finishedAt: now })
      .where(and(eq(agentSteeringCommands.id, id), inArray(agentSteeringCommands.status, [...editable])))
      .returning();
    if (!row) throw new Error('Only queued steering can be deleted');
    return mapRow(row);
  }

  async reorder(id: string, beforeId: string | null): Promise<AgentSteeringCommand[]> {
    const [target] = await db.select().from(agentSteeringCommands).where(eq(agentSteeringCommands.id, id));
    if (!target || target.status !== 'queued') throw new Error('Only queued steering can be reordered');
    const items = (await this.list(target.sessionId, target.agentId)).filter((item) => item.status === 'queued');
    const without = items.filter((item) => item.id !== id);
    const index = beforeId ? Math.max(0, without.findIndex((item) => item.id === beforeId)) : without.length;
    without.splice(index < 0 ? without.length : index, 0, mapRow(target));
    const now = new Date();
    for (const [position, item] of without.entries()) {
      await db.update(agentSteeringCommands).set({ position, updatedAt: now }).where(eq(agentSteeringCommands.id, item.id));
    }
    return this.list(target.sessionId, target.agentId);
  }
}

export const agentSteeringStore = new AgentSteeringStore();
