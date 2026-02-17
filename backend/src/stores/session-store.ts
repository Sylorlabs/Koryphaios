import type { Session } from "@koryphaios/shared";
import { nanoid } from "nanoid";
import { getDb } from "../db/sqlite";
import { ID, SESSION } from "../constants";

export interface ISessionStore {
  create(title?: string, parentId?: string): Session;
  get(id: string): Session | undefined;
  list(): Session[];
  update(id: string, updates: Partial<Session>): Session | undefined;
  delete(id: string): void;
  clear(): void;
}

export class SessionStore implements ISessionStore {
  create(title?: string, parentId?: string): Session {
    const id = nanoid(ID.SESSION_ID_LENGTH);
    const now = Date.now();
    const db = getDb();

    db.run(
      "INSERT INTO sessions (id, title, parent_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
      [id, title ?? SESSION.DEFAULT_TITLE, parentId || null, now, now],
    );

    return {
      id,
      title: title ?? SESSION.DEFAULT_TITLE,
      parentSessionId: parentId,
      messageCount: 0,
      totalTokensIn: 0,
      totalTokensOut: 0,
      totalCost: 0,
      createdAt: now,
      updatedAt: now,
    };
  }

  get(id: string): Session | undefined {
    const row = getDb().query("SELECT * FROM sessions WHERE id = ?").get(id) as any;
    if (!row) return undefined;
    return {
      id: row.id,
      title: row.title,
      parentSessionId: row.parent_id,
      messageCount: row.message_count,
      totalTokensIn: row.tokens_in,
      totalTokensOut: row.tokens_out,
      totalCost: row.total_cost,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  list(): Session[] {
    const rows = getDb().query("SELECT * FROM sessions ORDER BY updated_at DESC").all() as any[];
    return rows.map((row) => ({
      id: row.id,
      title: row.title,
      parentSessionId: row.parent_id,
      messageCount: row.message_count,
      totalTokensIn: row.tokens_in,
      totalTokensOut: row.tokens_out,
      totalCost: row.total_cost,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }));
  }

  update(id: string, updates: Partial<Session>): Session | undefined {
    const fields = Object.keys(updates).filter((k) => k !== "id");
    if (fields.length === 0) return this.get(id);

    const mapping: Record<string, string> = {
      title: "title",
      messageCount: "message_count",
      totalTokensIn: "tokens_in",
      totalTokensOut: "tokens_out",
      totalCost: "total_cost",
      updatedAt: "updated_at",
    };

    const sets = fields.map((f) => `${mapping[f] || f} = ?`).join(", ");
    const values = fields.map((f) => (updates as any)[f]);
    values.push(Date.now());
    values.push(id);

    getDb().run(`UPDATE sessions SET ${sets}, updated_at = ? WHERE id = ?`, values);
    return this.get(id);
  }

  delete(id: string) {
    getDb().run("DELETE FROM sessions WHERE id = ?", [id]);
  }

  clear() {
    getDb().run("DELETE FROM sessions");
  }
}
