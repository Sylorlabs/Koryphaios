import type { Session as SharedSession } from '@koryphaios/shared';
import { nanoid } from 'nanoid';
import { ID, SESSION } from '../constants';
import { db, sessions, type Session as DbSession } from '../db';
import { eq, and, desc } from 'drizzle-orm';

export interface ISessionStore {
  create(
    titleOrUserId?: string,
    titleOrParentId?: string,
    parentId?: string,
    workingDirectory?: string,
  ): Promise<SharedSession>;
  get(id: string): Promise<SharedSession | undefined>;
  list(): Promise<SharedSession[]>;
  listForUser(userId: string): Promise<SharedSession[]>;
  getForUser(id: string, userId: string): Promise<SharedSession | undefined>;
  update(
    id: string,
    updates: Partial<SharedSession>,
    expectedVersion?: number,
  ): Promise<SharedSession | undefined>;
  delete(id: string): Promise<void>;
  deleteForUser(id: string, userId: string): Promise<void>;
  clear(): Promise<void>;
}

function toSharedSession(s: DbSession): SharedSession {
  return {
    id: s.id,
    title: s.title,
    parentSessionId: s.parentId ?? undefined,
    workingDirectory: s.workingDirectory ?? undefined,
    messageCount: s.messageCount ?? 0,
    totalTokensIn: s.tokensIn ?? 0,
    totalTokensOut: s.tokensOut ?? 0,
    totalCost: s.totalCost ?? 0,
    version: s.version ?? 1,
    createdAt: s.createdAt.getTime(),
    updatedAt: s.updatedAt.getTime(),
  };
}

export class SessionStore implements ISessionStore {
  async create(
    titleOrUserId?: string,
    titleOrTitle?: string,
    parentId?: string,
    workingDirectory?: string,
  ): Promise<SharedSession> {
    const argc = arguments.length;
    const userId = argc >= 1 ? (titleOrUserId ?? null) : null;
    const title =
      argc >= 2
        ? (titleOrTitle ?? SESSION.DEFAULT_TITLE)
        : (titleOrUserId ?? SESSION.DEFAULT_TITLE);
    const parent = argc >= 3 ? parentId : argc === 2 ? undefined : titleOrTitle;

    const id = nanoid(ID.SESSION_ID_LENGTH);
    const now = new Date();

    const [session] = await db
      .insert(sessions)
      .values({
        id,
        userId: userId ?? null,
        title: title ?? SESSION.DEFAULT_TITLE,
        parentId: parent || null,
        workingDirectory: workingDirectory || null,
        createdAt: now,
        updatedAt: now,
        version: 1,
      })
      .returning();

    return toSharedSession(session);
  }

  async get(id: string): Promise<SharedSession | undefined> {
    const session = await db.query.sessions.findFirst({
      where: eq(sessions.id, id),
    });
    return session ? toSharedSession(session) : undefined;
  }

  async list(): Promise<SharedSession[]> {
    const results = await db.select().from(sessions).orderBy(desc(sessions.updatedAt));
    return results.map(toSharedSession);
  }

  async listForUser(userId: string): Promise<SharedSession[]> {
    const results = await db
      .select()
      .from(sessions)
      .where(eq(sessions.userId, userId))
      .orderBy(desc(sessions.updatedAt));
    return results.map(toSharedSession);
  }

  async getForUser(id: string, userId: string): Promise<SharedSession | undefined> {
    const session = await db.query.sessions.findFirst({
      where: and(eq(sessions.id, id), eq(sessions.userId, userId)),
    });
    return session ? toSharedSession(session) : undefined;
  }

  async update(
    id: string,
    updates: Partial<SharedSession>,
    expectedVersion?: number,
  ): Promise<SharedSession | undefined> {
    const drizzleUpdates: any = {
      updatedAt: new Date(),
    };

    if (updates.title !== undefined) drizzleUpdates.title = updates.title;
    if (updates.messageCount !== undefined) drizzleUpdates.messageCount = updates.messageCount;
    if (updates.totalTokensIn !== undefined) drizzleUpdates.tokensIn = updates.totalTokensIn;
    if (updates.totalTokensOut !== undefined) drizzleUpdates.tokensOut = updates.totalTokensOut;
    if (updates.totalCost !== undefined) drizzleUpdates.totalCost = updates.totalCost;
    if (updates.workingDirectory !== undefined)
      drizzleUpdates.workingDirectory = updates.workingDirectory || null;

    const whereClause = expectedVersion
      ? and(eq(sessions.id, id), eq(sessions.version, expectedVersion))
      : eq(sessions.id, id);

    const [updated] = await db.update(sessions).set(drizzleUpdates).where(whereClause).returning();

    return updated ? toSharedSession(updated) : undefined;
  }

  async delete(id: string): Promise<void> {
    await db.delete(sessions).where(eq(sessions.id, id));
  }

  async deleteForUser(id: string, userId: string): Promise<void> {
    await db.delete(sessions).where(and(eq(sessions.id, id), eq(sessions.userId, userId)));
  }

  async clear(): Promise<void> {
    await db.delete(sessions);
  }
}
