import { db, tasks } from '../db';
import { eq, or, and, inArray } from 'drizzle-orm';
import type { KoryTask } from '../kory/services/WorkerLifecycleService';
// Note: Import from worker-lifecycle-service directly, not manager

export interface ITaskStore {
  create(
    task: Omit<KoryTask, 'status' | 'result' | 'error'> & { sessionId: string; plan?: string },
  ): Promise<void>;
  update(
    id: string,
    updates: Partial<KoryTask> & { status?: string; plan?: string },
  ): Promise<void>;
  get(id: string): Promise<(KoryTask & { sessionId: string; plan?: string }) | undefined>;
  listActive(): Promise<(KoryTask & { sessionId: string; plan?: string })[]>;
}

export class TaskStore implements ITaskStore {
  async create(
    task: Omit<KoryTask, 'status' | 'result' | 'error'> & { sessionId: string; plan?: string },
  ) {
    const now = new Date();
    await db.insert(tasks).values({
      id: task.id,
      sessionId: task.sessionId,
      description: task.description,
      domain: task.domain,
      status: 'pending',
      assignedModel: task.assignedModel,
      assignedProvider: task.assignedProvider,
      plan: task.plan || null,
      createdAt: now,
      updatedAt: now,
    });
  }

  async update(id: string, updates: Partial<KoryTask> & { status?: string; plan?: string }) {
    const values: any = {};

    if (updates.status) values.status = updates.status;
    if (updates.result) values.result = updates.result;
    if (updates.error) values.error = updates.error;
    if (updates.plan) values.plan = updates.plan;

    if (Object.keys(values).length === 0) return;

    values.updatedAt = new Date();

    await db.update(tasks).set(values).where(eq(tasks.id, id));
  }

  async get(id: string) {
    const row = await db.select().from(tasks).where(eq(tasks.id, id)).get();
    if (!row) return undefined;
    return this.mapRow(row);
  }

  async listActive() {
    const rows = await db
      .select()
      .from(tasks)
      .where(inArray(tasks.status, ['active', 'pending']))
      .all();
    return rows.map((r) => this.mapRow(r));
  }

  private mapRow(row: any): KoryTask & { sessionId: string; plan?: string } {
    return {
      id: row.id,
      sessionId: row.sessionId,
      description: row.description,
      domain: row.domain as KoryTask['domain'],
      assignedModel: row.assignedModel,
      assignedProvider: row.assignedProvider,
      status: row.status as KoryTask['status'],
      result: row.result ?? undefined,
      error: row.error ?? undefined,
      plan: row.plan ?? undefined,
    };
  }
}
