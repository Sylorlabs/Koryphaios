import type { Session } from "@koryphaios/shared";
import { nanoid } from "nanoid";
import { getDb } from "../db/sqlite";
import { ID, SESSION } from "../constants";

export interface ISessionStore {
  create(titleOrUserId?: string, titleOrParentId?: string, parentId?: string): Session;
  get(id: string): Session | undefined;
  list(): Session[];
  listForUser(userId: string): Session[];
  getForUser(id: string, userId: string): Session | undefined;
  update(id: string, updates: Partial<Session>, expectedVersion?: number): Session | undefined;
  delete(id: string): void;
  deleteForUser(id: string, userId: string): void;
  clear(): void;
}

export class SessionStore implements ISessionStore {
  create(titleOrUserId?: string, titleOrTitle?: string, parentId?: string): Session {
    // Server calls create(userId, title?, parentId?) or create(userId, title); store also supports create(title?, parentId?)
    const argc = arguments.length;
    const userId = argc >= 1 ? (titleOrUserId ?? null) : null;
    const title =
      argc >= 2 ? (titleOrTitle ?? SESSION.DEFAULT_TITLE) : (titleOrUserId ?? SESSION.DEFAULT_TITLE);
    const parent = argc >= 3 ? parentId : (argc === 2 ? undefined : titleOrTitle);
    const id = nanoid(ID.SESSION_ID_LENGTH);
    const now = Date.now();
    const db = getDb();

    db.run(
      "INSERT INTO sessions (id, user_id, title, parent_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
      [id, userId, title ?? SESSION.DEFAULT_TITLE, parent || null, now, now],
    );

    return {
      id,
      title: title ?? SESSION.DEFAULT_TITLE,
      parentSessionId: parent || undefined,
      messageCount: 0,
      totalTokensIn: 0,
      totalTokensOut: 0,
      totalCost: 0,
      createdAt: now,
      updatedAt: now,
    };
  }

  get(id: string): Session | undefined {
    const row = getDb().query("SELECT * FROM sessions WHERE id = ?").get(id) as Record<string, unknown> | undefined;
    if (!row) return undefined;
    return this.rowToSession(row);
  }

  list(): Session[] {
    const rows = getDb().query("SELECT * FROM sessions ORDER BY updated_at DESC").all() as Record<string, unknown>[];
    return rows.map((row) => this.rowToSession(row));
  }

  /** In single-user mode, returns all sessions (no user_id column). */
  listForUser(_userId: string): Session[] {
    return this.list();
  }

  /** In single-user mode, same as get(id). */
  getForUser(id: string, _userId: string): Session | undefined {
    return this.get(id);
  }

  private rowToSession(row: Record<string, unknown>): Session {
    return {
      id: row.id as string,
      title: row.title as string,
      parentSessionId: row.parent_id as string | undefined,
      messageCount: (row.message_count as number) ?? 0,
      totalTokensIn: (row.tokens_in as number) ?? 0,
      totalTokensOut: (row.tokens_out as number) ?? 0,
      totalCost: (row.total_cost as number) ?? 0,
      version: (row.version as number) ?? 1,
      createdAt: row.created_at as number,
      updatedAt: row.updated_at as number,
    };
  }

  update(id: string, updates: Partial<Session>, expectedVersion?: number): Session | undefined {
    const mapping: Record<string, string> = {
      title: "title",
      messageCount: "message_count",
      totalTokensIn: "tokens_in",
      totalTokensOut: "tokens_out",
      totalCost: "total_cost",
      updatedAt: "updated_at",
    };

    const fields = Object.keys(updates).filter((k) => k !== "id" && k !== "version" && k in mapping);
    if (fields.length === 0 && expectedVersion === undefined) return this.get(id);

    const db = getDb();
    const now = Date.now();

    // Use optimistic locking if version is provided
    if (expectedVersion !== undefined) {
      const sets = fields.map((f) => `${mapping[f]} = ?`).join(", ");
      const values: unknown[] = fields.map((f) => (updates as Record<string, unknown>)[f]);
      values.push(now); // updated_at
      values.push(expectedVersion + 1); // new version
      values.push(id);
      values.push(expectedVersion); // expected current version

      const result = db.run(
        `UPDATE sessions SET ${sets ? sets + ", " : ""}updated_at = ?, version = ? WHERE id = ? AND version = ?`,
        values as Parameters<typeof db.run>[1]
      );

      if (result.changes === 0) {
        throw new Error(`Concurrent modification detected: session ${id} was modified by another process`);
      }
    } else {
      // No optimistic locking - just update
      const sets = fields.map((f) => `${mapping[f]} = ?`).join(", ");
      const values: unknown[] = fields.map((f) => (updates as Record<string, unknown>)[f]);
      values.push(now);
      values.push(id);

      db.run(`UPDATE sessions SET ${sets}, updated_at = ? WHERE id = ?`, values as Parameters<typeof db.run>[1]);
    }

    return this.get(id);
  }

  delete(id: string) {
    getDb().run("DELETE FROM sessions WHERE id = ?", [id]);
  }

  /** In single-user mode, same as delete(id). */
  deleteForUser(id: string, _userId: string) {
    this.delete(id);
  }

  clear() {
    getDb().run("DELETE FROM sessions");
  }
}
