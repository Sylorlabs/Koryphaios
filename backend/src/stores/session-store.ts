import type { Session } from "@koryphaios/shared";
import { nanoid } from "nanoid";
import { getDb } from "../db/sqlite";
import { ID, SESSION } from "../constants";

export interface ISessionStore {
  create(userId: string, title?: string, parentId?: string): Session;
  get(id: string): Session | undefined;
  getForUser(id: string, userId: string): Session | undefined;
  list(): Session[];
  listForUser(userId: string): Session[];
  update(id: string, updates: Partial<Session>): Session | undefined;
  delete(id: string): void;
  deleteForUser(id: string, userId: string): boolean;
}

export class SessionStore implements ISessionStore {
  create(userId: string, title?: string, parentId?: string): Session {
    const id = nanoid(ID.SESSION_ID_LENGTH);
    const now = Date.now();
    const db = getDb();

    db.run(
      "INSERT INTO sessions (id, user_id, title, parent_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
      [id, userId, title ?? SESSION.DEFAULT_TITLE, parentId || null, now, now],
    );

    return {
      id,
      userId,
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
    return this.rowToSession(row);
  }

  getForUser(id: string, userId: string): Session | undefined {
    const row = getDb()
      .query("SELECT * FROM sessions WHERE id = ? AND user_id = ?")
      .get(id, userId) as any;
    if (!row) return undefined;
    return this.rowToSession(row);
  }

  list(): Session[] {
    const rows = getDb().query("SELECT * FROM sessions ORDER BY updated_at DESC").all() as any[];
    return rows.map((row) => this.rowToSession(row));
  }

  listForUser(userId: string): Session[] {
    const rows = getDb()
      .query("SELECT * FROM sessions WHERE user_id = ? ORDER BY updated_at DESC")
      .all(userId) as any[];
    return rows.map((row) => this.rowToSession(row));
  }

  update(id: string, updates: Partial<Session>): Session | undefined {
    const fields = Object.keys(updates).filter((k) => k !== "id" && k !== "userId");
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

  deleteForUser(id: string, userId: string): boolean {
    const result = getDb().run(
      "DELETE FROM sessions WHERE id = ? AND user_id = ?",
      [id, userId]
    );
    return result.changes > 0;
  }

  private rowToSession(row: any): Session {
    return {
      id: row.id,
      userId: row.user_id,
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
}
