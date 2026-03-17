import type { StoredMessage } from "@koryphaios/shared";
import { getDb } from "../db/sqlite";

const GET_ALL_SQL = "SELECT * FROM messages WHERE session_id = ? ORDER BY created_at ASC LIMIT ?";
const GET_RECENT_SQL = "SELECT * FROM messages WHERE session_id = ? ORDER BY created_at DESC LIMIT ?";
const ADD_SQL = "INSERT INTO messages (id, session_id, role, content, model, provider, tokens_in, tokens_out, cost, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)";
const GET_PAGINATED_SQL = "SELECT * FROM messages WHERE session_id = ? AND created_at > ? ORDER BY created_at ASC LIMIT ?";
const GET_COUNT_SQL = "SELECT COUNT(*) as count FROM messages WHERE session_id = ?";
const GET_TOTAL_SIZE_SQL = "SELECT SUM(LENGTH(content)) as totalSize FROM messages WHERE session_id = ?";
// OPTIMIZED: Single query pagination with count
const GET_PAGINATED_WITH_COUNT_SQL = `
  SELECT *, COUNT(*) OVER() as total_count 
  FROM messages 
  WHERE session_id = ? AND created_at > ? 
  ORDER BY created_at ASC 
  LIMIT ?
`;

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

interface DbMessageRowWithCount extends DbMessageRow {
  total_count: number;
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

export interface PaginatedMessages {
  messages: StoredMessage[];
  hasMore: boolean;
  totalCount: number;
  nextCursor?: number;
}

export interface IMessageStore {
  add(sessionId: string, msg: StoredMessage): void;
  getAll(sessionId: string, limit?: number): StoredMessage[];
  getRecent(sessionId: string, limit?: number): StoredMessage[];
  getPaginated(sessionId: string, cursor?: number, pageSize?: number): PaginatedMessages;
  getTotalCount(sessionId: string): number;
  getTotalContentSize(sessionId: string): number;
  trimOldMessages(sessionId: string, keepCount: number): number;
}

export class MessageStore implements IMessageStore {
  private _getAllStmt: ReturnType<ReturnType<typeof getDb>['query']> | undefined;
  private _getRecentStmt: ReturnType<ReturnType<typeof getDb>['query']> | undefined;
  private _getPaginatedStmt: ReturnType<ReturnType<typeof getDb>['query']> | undefined;
  private _getPaginatedWithCountStmt: ReturnType<ReturnType<typeof getDb>['query']> | undefined;
  private _getCountStmt: ReturnType<ReturnType<typeof getDb>['query']> | undefined;
  private _getTotalSizeStmt: ReturnType<ReturnType<typeof getDb>['query']> | undefined;

  // Default limits to prevent unbounded memory growth
  private readonly DEFAULT_PAGE_SIZE = 50;
  private readonly MAX_PAGE_SIZE = 200;
  private readonly DEFAULT_GET_ALL_LIMIT = 100;

  private get getAllStmt() {
    return this._getAllStmt ??= getDb().query(GET_ALL_SQL);
  }
  private get getRecentStmt() {
    return this._getRecentStmt ??= getDb().query(GET_RECENT_SQL);
  }
  private get getPaginatedStmt() {
    return this._getPaginatedStmt ??= getDb().query(GET_PAGINATED_SQL);
  }
  private get getPaginatedWithCountStmt() {
    return this._getPaginatedWithCountStmt ??= getDb().query(GET_PAGINATED_WITH_COUNT_SQL);
  }
  private get getCountStmt() {
    return this._getCountStmt ??= getDb().query(GET_COUNT_SQL);
  }
  private get getTotalSizeStmt() {
    return this._getTotalSizeStmt ??= getDb().query(GET_TOTAL_SIZE_SQL);
  }

  add(sessionId: string, msg: StoredMessage): void {
    getDb().run(ADD_SQL, [
      msg.id, sessionId, msg.role, msg.content,
      msg.model || null, msg.provider || null,
      msg.tokensIn || 0, msg.tokensOut || 0, msg.cost || 0, msg.createdAt,
    ]);
  }

  getAll(sessionId: string, limit = this.DEFAULT_GET_ALL_LIMIT): StoredMessage[] {
    // Cap limit to prevent unbounded memory usage
    const cappedLimit = Math.min(limit, this.MAX_PAGE_SIZE);
    return (this.getAllStmt.all(sessionId, cappedLimit) as DbMessageRow[]).map(rowToMessage);
  }

  getRecent(sessionId: string, limit = 10): StoredMessage[] {
    const cappedLimit = Math.min(limit, this.MAX_PAGE_SIZE);
    return (this.getRecentStmt.all(sessionId, cappedLimit) as DbMessageRow[]).reverse().map(rowToMessage);
  }

  /**
   * Get paginated messages with efficient single-query count.
   * PERFORMANCE: Uses window function to get total count in same query as data.
   */
  getPaginated(sessionId: string, cursor?: number, pageSize = this.DEFAULT_PAGE_SIZE): PaginatedMessages {
    const effectivePageSize = Math.min(pageSize, this.MAX_PAGE_SIZE);
    const afterTimestamp = cursor ?? 0;
    
    // Fetch one extra to determine hasMore
    const fetchLimit = effectivePageSize + 1;
    const rows = this.getPaginatedWithCountStmt.all(sessionId, afterTimestamp, fetchLimit) as DbMessageRowWithCount[];
    
    if (rows.length === 0) {
      return {
        messages: [],
        hasMore: false,
        totalCount: 0,
      };
    }
    
    const totalCount = rows[0].total_count;
    const hasMore = rows.length > effectivePageSize;
    const messages = hasMore ? rows.slice(0, effectivePageSize) : rows;
    
    const lastMessage = messages[messages.length - 1];
    const nextCursor = hasMore && lastMessage ? lastMessage.created_at : undefined;
    
    return {
      messages: messages.map(rowToMessage),
      hasMore,
      totalCount,
      nextCursor,
    };
  }

  getTotalCount(sessionId: string): number {
    const row = this.getCountStmt.get(sessionId) as { count: number } | undefined;
    return row?.count ?? 0;
  }

  getTotalContentSize(sessionId: string): number {
    const row = this.getTotalSizeStmt.get(sessionId) as { totalSize: number } | undefined;
    return row?.totalSize ?? 0;
  }

  /**
   * Trim old messages to keep only the most recent `keepCount` messages.
   * Returns the number of messages deleted.
   * 
   * PERFORMANCE NOTE: This uses a DELETE with subquery. For large tables,
   * ensure there's a composite index on (session_id, created_at).
   */
  trimOldMessages(sessionId: string, keepCount: number): number {
    const count = this.getTotalCount(sessionId);
    const toDelete = Math.max(0, count - keepCount);
    
    if (toDelete === 0) return 0;
    
    // PERFORMANCE: Direct delete without subquery for better SQLite performance
    const db = getDb();
    const result = db.run(
      `DELETE FROM messages 
       WHERE session_id = ? 
       AND id IN (
         SELECT id FROM messages 
         WHERE session_id = ? 
         ORDER BY created_at ASC 
         LIMIT ?
       )`,
      [sessionId, sessionId, toDelete]
    );
    
    return result.changes ?? 0;
  }
}
