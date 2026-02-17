import type { StoredMessage } from "@koryphaios/shared";
import { getDb } from "../db/sqlite";

export interface IMessageStore {
  add(sessionId: string, msg: StoredMessage): void;
  getAll(sessionId: string): StoredMessage[];
  getRecent(sessionId: string, limit?: number): StoredMessage[];
}

export class MessageStore implements IMessageStore {
  add(sessionId: string, msg: StoredMessage): void {
    getDb().run(
      "INSERT INTO messages (id, session_id, role, content, model, provider, tokens_in, tokens_out, cost, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      [
        msg.id,
        sessionId,
        msg.role,
        msg.content,
        msg.model || null,
        msg.provider || null,
        msg.tokensIn || 0,
        msg.tokensOut || 0,
        msg.cost || 0,
        msg.createdAt,
      ],
    );
  }

  getAll(sessionId: string): StoredMessage[] {
    const rows = getDb().query("SELECT * FROM messages WHERE session_id = ? ORDER BY created_at ASC").all(sessionId) as any[];
    return rows.map((row) => ({
      id: row.id,
      sessionId: row.session_id,
      role: row.role,
      content: row.content,
      model: row.model,
      provider: row.provider,
      tokensIn: row.tokens_in,
      tokensOut: row.tokens_out,
      cost: row.cost,
      createdAt: row.created_at,
    }));
  }

  getRecent(sessionId: string, limit: number = 10): StoredMessage[] {
    const rows = getDb().query("SELECT * FROM messages WHERE session_id = ? ORDER BY created_at DESC LIMIT ?").all(sessionId, limit) as any[];
    return rows.reverse().map((row) => ({
      id: row.id,
      sessionId: row.session_id,
      role: row.role,
      content: row.content,
      model: row.model,
      provider: row.provider,
      tokensIn: row.tokens_in,
      tokensOut: row.tokens_out,
      cost: row.cost,
      createdAt: row.created_at,
    }));
  }
}
