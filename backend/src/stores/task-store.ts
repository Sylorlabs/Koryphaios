import { getDb } from "../db/sqlite";
import type { KoryTask } from "../kory/manager";

export interface ITaskStore {
  create(task: Omit<KoryTask, "status" | "result" | "error"> & { sessionId: string; plan?: string }): void;
  update(id: string, updates: Partial<KoryTask> & { status?: string; plan?: string }): void;
  get(id: string): (KoryTask & { sessionId: string; plan?: string }) | undefined;
  listActive(): (KoryTask & { sessionId: string; plan?: string })[];
}

export class TaskStore implements ITaskStore {
  create(task: Omit<KoryTask, "status" | "result" | "error"> & { sessionId: string; plan?: string }) {
    const now = Date.now();
    getDb().run(
      `INSERT INTO tasks (id, session_id, description, domain, status, assigned_model, assigned_provider, plan, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?)`,
      [task.id, task.sessionId, task.description, task.domain, task.assignedModel, task.assignedProvider, task.plan || null, now, now]
    );
  }

  update(id: string, updates: Partial<KoryTask> & { status?: string; plan?: string }) {
    const fields: string[] = [];
    const values: any[] = [];
    
    if (updates.status) { fields.push("status = ?"); values.push(updates.status); }
    if (updates.result) { fields.push("result = ?"); values.push(updates.result); }
    if (updates.error) { fields.push("error = ?"); values.push(updates.error); }
    if (updates.plan) { fields.push("plan = ?"); values.push(updates.plan); }
    
    if (fields.length === 0) return;

    fields.push("updated_at = ?");
    values.push(Date.now());
    values.push(id);

    getDb().run(`UPDATE tasks SET ${fields.join(", ")} WHERE id = ?`, values);
  }

  get(id: string) {
    const row = getDb().query("SELECT * FROM tasks WHERE id = ?").get(id) as any;
    if (!row) return undefined;
    return this.mapRow(row);
  }

  listActive() {
    const rows = getDb().query("SELECT * FROM tasks WHERE status IN ('active', 'pending')").all() as any[];
    return rows.map(this.mapRow);
  }

  private mapRow(row: any): KoryTask & { sessionId: string; plan?: string } {
    return {
      id: row.id,
      sessionId: row.session_id,
      description: row.description,
      domain: row.domain,
      assignedModel: row.assigned_model,
      assignedProvider: row.assigned_provider,
      status: row.status,
      result: row.result,
      error: row.error,
      plan: row.plan,
    };
  }
}
