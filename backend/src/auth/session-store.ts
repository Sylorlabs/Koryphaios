// Session store for managing active authenticated sessions
// Uses Drizzle ORM for persistence with in-memory caching

import { Session } from './types';
import { authLog } from '../logger';
import { db, authSessions } from '../db';
import { eq, lt, and, desc, gt } from 'drizzle-orm';

export interface SessionStore {
  create(session: Omit<Session, 'id'>): Promise<Session>;
  get(id: string): Promise<Session | null>;
  getByUserId(userId: string): Promise<Session[]>;
  update(id: string, updates: Partial<Session>): Promise<void>;
  delete(id: string): Promise<void>;
  deleteByUserId(userId: string): Promise<void>;
  deleteExpired(): Promise<number>;
  listActive(): Promise<Session[]>;
  touch(id: string): Promise<void>;
}

// In-memory implementation (for development/testing)
class InMemorySessionStore implements SessionStore {
  private sessions = new Map<string, Session>();
  private idCounter = 0;

  async create(session: Omit<Session, 'id'>): Promise<Session> {
    const id = `sess_${++this.idCounter}_${Date.now()}`;
    const newSession: Session = { ...session, id };
    this.sessions.set(id, newSession);
    authLog.debug({ sessionId: id, userId: session.userId }, 'Created session');
    return newSession;
  }

  async get(id: string): Promise<Session | null> {
    const session = this.sessions.get(id);
    if (!session) return null;
    if (session.expiresAt < Date.now()) {
      this.sessions.delete(id);
      return null;
    }
    return session;
  }

  async getByUserId(userId: string): Promise<Session[]> {
    const now = Date.now();
    const sessions: Session[] = [];
    for (const session of this.sessions.values()) {
      if (session.userId === userId && session.expiresAt > now) {
        sessions.push(session);
      }
    }
    return sessions;
  }

  async update(id: string, updates: Partial<Session>): Promise<void> {
    const session = this.sessions.get(id);
    if (session) Object.assign(session, updates);
  }

  async delete(id: string): Promise<void> {
    this.sessions.delete(id);
    authLog.debug({ sessionId: id }, 'Deleted session');
  }

  async deleteByUserId(userId: string): Promise<void> {
    for (const [id, session] of this.sessions.entries()) {
      if (session.userId === userId) this.sessions.delete(id);
    }
  }

  async deleteExpired(): Promise<number> {
    const now = Date.now();
    let count = 0;
    for (const [id, session] of this.sessions.entries()) {
      if (session.expiresAt < now) {
        this.sessions.delete(id);
        count++;
      }
    }
    return count;
  }

  async listActive(): Promise<Session[]> {
    const now = Date.now();
    return Array.from(this.sessions.values())
      .filter((s) => s.expiresAt > now)
      .sort((a, b) => b.lastActivityAt - a.lastActivityAt);
  }

  async touch(id: string): Promise<void> {
    const session = this.sessions.get(id);
    if (session) session.lastActivityAt = Date.now();
  }
}

// Drizzle-backed implementation (for production)
class DrizzleSessionStore implements SessionStore {
  async create(session: Omit<Session, 'id'>): Promise<Session> {
    const id = `sess_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    await db.insert(authSessions).values({
      id,
      userId: session.userId,
      userName: session.userName,
      createdAt: new Date(session.createdAt),
      expiresAt: new Date(session.expiresAt),
      lastActivityAt: new Date(session.lastActivityAt),
      ipAddress: session.ipAddress || null,
      userAgent: session.userAgent || null,
    });
    return { ...session, id };
  }

  async get(id: string): Promise<Session | null> {
    const [result] = await db
      .select()
      .from(authSessions)
      .where(and(eq(authSessions.id, id), gt(authSessions.expiresAt, new Date())))
      .limit(1);
    return result ? this.dbToSession(result) : null;
  }

  async getByUserId(userId: string): Promise<Session[]> {
    const results = await db
      .select()
      .from(authSessions)
      .where(and(eq(authSessions.userId, userId), gt(authSessions.expiresAt, new Date())))
      .orderBy(desc(authSessions.lastActivityAt));
    return results.map((r) => this.dbToSession(r));
  }

  async update(id: string, updates: Partial<Session>): Promise<void> {
    const sets: any = {};
    if (updates.lastActivityAt) sets.lastActivityAt = new Date(updates.lastActivityAt);
    if (updates.expiresAt) sets.expiresAt = new Date(updates.expiresAt);
    if (Object.keys(sets).length > 0)
      await db.update(authSessions).set(sets).where(eq(authSessions.id, id));
  }

  async delete(id: string): Promise<void> {
    await db.delete(authSessions).where(eq(authSessions.id, id));
  }

  async deleteByUserId(userId: string): Promise<void> {
    await db.delete(authSessions).where(eq(authSessions.userId, userId));
  }

  async deleteExpired(): Promise<number> {
    const res = await db
      .delete(authSessions)
      .where(lt(authSessions.expiresAt, new Date()))
      .returning();
    return res.length;
  }

  async listActive(): Promise<Session[]> {
    const results = await db
      .select()
      .from(authSessions)
      .where(gt(authSessions.expiresAt, new Date()))
      .orderBy(desc(authSessions.lastActivityAt));
    return results.map((r) => this.dbToSession(r));
  }

  async touch(id: string): Promise<void> {
    await db
      .update(authSessions)
      .set({ lastActivityAt: new Date() })
      .where(eq(authSessions.id, id));
  }

  private dbToSession(row: any): Session {
    return {
      id: row.id,
      userId: row.userId,
      userName: row.userName,
      createdAt: row.createdAt.getTime(),
      expiresAt: row.expiresAt.getTime(),
      lastActivityAt: row.lastActivityAt.getTime(),
      ipAddress: row.ipAddress || undefined,
      userAgent: row.userAgent || undefined,
    };
  }
}

let sessionStore: SessionStore | null = null;
export function initializeSessionStore(useDrizzle = false): SessionStore {
  sessionStore = useDrizzle ? new DrizzleSessionStore() : new InMemorySessionStore();
  return sessionStore;
}
export function getSessionStore(): SessionStore {
  if (!sessionStore) sessionStore = new InMemorySessionStore();
  return sessionStore;
}
export function createSessionAuthTable(): void {}
