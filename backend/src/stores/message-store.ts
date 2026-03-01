import type { StoredMessage } from "@koryphaios/shared";
import { getDb } from "../db/sqlite";

const GET_ALL_SQL = "SELECT * FROM messages WHERE session_id = ? ORDER BY created_at ASC LIMIT ?";
const GET_RECENT_SQL = "SELECT * FROM messages WHERE session_id = ? ORDER BY created_at DESC LIMIT ?";
const ADD_SQL = "INSERT INTO messages (id, session_id, role, content, model, provider, tokens_in, tokens_out, cost, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)";

interface DbMessageRow {
  id: string;
  session_id: string;
  role: string;
  content: string;
  model: string | null;
  provider: string | null;
  tokens_in: number;
  tokens_out: number;
  cost: number;
  created_at: number;
}

function rowToMessage(row: DbMessageRow): StoredMessage {
  return {
    id: row.id,
    sessionId: row.session_id,
    role: row.role as StoredMessage["role"],
    content: row.content,
    model: row.model ?? undefined,
    provider: row.provider ?? undefined,
    tokensIn: row.tokens_in,
    tokensOut: row.tokens_out,
    cost: row.cost,
    createdAt: row.created_at,
  };
}

export interface IMessageStore {
  add(sessionId: string, msg: StoredMessage): void;
  getAll(sessionId: string, limit?: number): StoredMessage[];
  getRecent(sessionId: string, limit?: number): StoredMessage[];
}

export class MessageStore implements IMessageStore {
  private _getAllStmt: ReturnType<ReturnType<typeof getDb>['query']> | undefined;
  private _getRecentStmt: ReturnType<ReturnType<typeof getDb>['query']> | undefined;

  private get getAllStmt() {
    return this._getAllStmt ??= getDb().query(GET_ALL_SQL);
  }
  private get getRecentStmt() {
    return this._getRecentStmt ??= getDb().query(GET_RECENT_SQL);
  }

  add(sessionId: string, msg: StoredMessage): void {
    getDb().run(ADD_SQL, [
      msg.id, sessionId, msg.role, msg.content,
      msg.model || null, msg.provider || null,
      msg.tokensIn || 0, msg.tokensOut || 0, msg.cost || 0, msg.createdAt,
    ]);
  }

  getAll(sessionId: string, limit = 1000): StoredMessage[] {
    return (this.getAllStmt.all(sessionId, limit) as DbMessageRow[]).map(rowToMessage);
  }

  getRecent(sessionId: string, limit = 10): StoredMessage[] {
    return (this.getRecentStmt.all(sessionId, limit) as DbMessageRow[]).reverse().map(rowToMessage);
  }
}
