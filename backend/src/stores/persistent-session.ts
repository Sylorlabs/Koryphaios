/**
 * Persistent Session Store
 */

import { db, persistentSessions } from '../db';
import { koryLog } from '../logger';
import { eq, gt, desc } from 'drizzle-orm';

export interface PersistentSession {
  id: string;
  name: string;
  createdAt: number;
  lastActivity: number;
  context: SessionContext;
  history: MessageRecord[];
  ghostCommits: string[];
  metadata: Record<string, unknown>;
}

export interface SessionContext {
  workingDirectory: string;
  preferredModel?: string;
  reasoningLevel?: string;
  currentBranch?: string;
  activeWorkers: string[];
  pendingToolCalls: string[];
}

export interface MessageRecord {
  id: string;
  role: 'user' | 'assistant' | 'tool' | 'system';
  content: string;
  timestamp: number;
  model?: string;
  toolCalls?: Array<{
    id: string;
    name: string;
    input: Record<string, unknown>;
    result?: unknown;
  }>;
}

export class PersistentSessionStore {
  private cache = new Map<string, PersistentSession>();
  private dirtySessions = new Set<string>();
  private saveInterval: Timer | null = null;

  constructor() {
    this.saveInterval = setInterval(() => this.flushDirtySessions(), 10000);
  }

  async createSession(
    name: string,
    workingDirectory: string,
    preferredModel?: string,
  ): Promise<PersistentSession> {
    const id = `session_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    const session: PersistentSession = {
      id,
      name,
      createdAt: Date.now(),
      lastActivity: Date.now(),
      context: { workingDirectory, preferredModel, activeWorkers: [], pendingToolCalls: [] },
      history: [],
      ghostCommits: [],
      metadata: {},
    };
    this.cache.set(id, session);
    this.dirtySessions.add(id);
    await this.saveSession(session);
    return session;
  }

  async getSession(id: string): Promise<PersistentSession | null> {
    if (this.cache.has(id)) {
      const s = this.cache.get(id)!;
      s.lastActivity = Date.now();
      return s;
    }
    const [row] = await db
      .select()
      .from(persistentSessions)
      .where(eq(persistentSessions.id, id))
      .limit(1);
    if (!row) return null;
    const session: PersistentSession = {
      id: row.id,
      name: row.name,
      createdAt: row.createdAt.getTime(),
      lastActivity: row.lastActivity.getTime(),
      context: JSON.parse(row.context),
      history: JSON.parse(row.history),
      ghostCommits: JSON.parse(row.ghostCommits),
      metadata: JSON.parse(row.metadata),
    };
    this.cache.set(id, session);
    return session;
  }

  async listSessions(options?: { active?: boolean; limit?: number }): Promise<
    Array<{
      id: string;
      name: string;
      createdAt: number;
      lastActivity: number;
      messageCount: number;
    }>
  > {
    let q = db.select().from(persistentSessions);
    if (options?.active)
      q = q.where(
        gt(persistentSessions.lastActivity, new Date(Date.now() - 24 * 60 * 60 * 1000)),
      ) as any;
    q = q.orderBy(desc(persistentSessions.lastActivity)) as any;
    if (options?.limit) q = q.limit(options.limit) as any;
    const rows = await q;
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      createdAt: r.createdAt.getTime(),
      lastActivity: r.lastActivity.getTime(),
      messageCount: JSON.parse(r.history).length,
    }));
  }

  async deleteSession(id: string): Promise<boolean> {
    this.cache.delete(id);
    this.dirtySessions.delete(id);
    await db.delete(persistentSessions).where(eq(persistentSessions.id, id));
    return true;
  }

  private async saveSession(session: PersistentSession): Promise<void> {
    await db
      .insert(persistentSessions)
      .values({
        id: session.id,
        name: session.name,
        createdAt: new Date(session.createdAt),
        lastActivity: new Date(session.lastActivity),
        context: JSON.stringify(session.context),
        history: JSON.stringify(session.history),
        ghostCommits: JSON.stringify(session.ghostCommits),
        metadata: JSON.stringify(session.metadata),
      })
      .onConflictDoUpdate({
        target: persistentSessions.id,
        set: {
          name: session.name,
          lastActivity: new Date(session.lastActivity),
          context: JSON.stringify(session.context),
          history: JSON.stringify(session.history),
          ghostCommits: JSON.stringify(session.ghostCommits),
          metadata: JSON.stringify(session.metadata),
        },
      });
  }

  private async flushDirtySessions(): Promise<void> {
    for (const id of this.dirtySessions) {
      const s = this.cache.get(id);
      if (s) await this.saveSession(s);
    }
    this.dirtySessions.clear();
  }

  async shutdown(): Promise<void> {
    if (this.saveInterval) clearInterval(this.saveInterval);
    await this.flushDirtySessions();
  }
}

export const persistentSessionStore = new PersistentSessionStore();
