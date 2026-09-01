import type { Session as SharedSession } from '@koryphaios/shared';
import { nanoid } from 'nanoid';
import { ID, SESSION } from '../constants';
import { db, sessions, type Session as DbSession } from '../db';
import { eq, and, desc, isNotNull, isNull, sql } from 'drizzle-orm';
import { serverLog } from '../logger';

export interface ISessionStore {
  create(
    titleOrUserId?: string,
    titleOrParentId?: string,
    parentId?: string,
    workingDirectory?: string,
  ): Promise<SharedSession>;
  get(id: string): Promise<SharedSession | undefined>;
  getActive(id: string): Promise<SharedSession | undefined>;
  listActive(): Promise<SharedSession[]>;
  listArchived(): Promise<SharedSession[]>;
  listAll(): Promise<SharedSession[]>;
  /** @deprecated Prefer an explicit lifecycle scope. This remains all-inclusive
   * so erasure/inventory callers cannot accidentally omit archived chats. */
  list(): Promise<SharedSession[]>;
  listForUser(userId: string): Promise<SharedSession[]>;
  getForUser(id: string, userId: string): Promise<SharedSession | undefined>;
  update(
    id: string,
    updates: Partial<SharedSession>,
    expectedVersion?: number,
  ): Promise<SharedSession | undefined>;
  updateWithCurrentVersion(
    id: string,
    updates: Partial<SharedSession>,
  ): Promise<SharedSession | undefined>;
  archive(id: string, archivedAt?: number): Promise<SharedSession | undefined>;
  restore(id: string): Promise<SharedSession | undefined>;
}

function toSharedSession(s: DbSession): SharedSession {
  let metadata: { interactionMode?: 'act' | 'plan'; planNoteId?: string } = {};
  try {
    metadata = s.metadata ? JSON.parse(s.metadata) : {};
  } catch (err: unknown) {
    serverLog.debug(
      { err: err instanceof Error ? err.message : String(err) },
      'session metadata parse failed — using empty metadata',
    );
    metadata = {};
  }
  return {
    id: s.id,
    title: s.title,
    archivedAt: s.archivedAt?.getTime(),
    status: s.archivedAt ? 'archived' : 'active',
    parentSessionId: s.parentId ?? undefined,
    workingDirectory: s.workingDirectory ?? undefined,
    interactionMode: metadata.interactionMode === 'plan' ? 'plan' : 'act',
    planNoteId: typeof metadata.planNoteId === 'string' ? metadata.planNoteId : undefined,
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

  async getActive(id: string): Promise<SharedSession | undefined> {
    const session = await db.query.sessions.findFirst({
      where: and(eq(sessions.id, id), isNull(sessions.archivedAt)),
    });
    return session ? toSharedSession(session) : undefined;
  }

  async listActive(): Promise<SharedSession[]> {
    const results = await db
      .select()
      .from(sessions)
      .where(isNull(sessions.archivedAt))
      .orderBy(desc(sessions.updatedAt));
    return results.map(toSharedSession);
  }

  async listArchived(): Promise<SharedSession[]> {
    const results = await db
      .select()
      .from(sessions)
      .where(isNotNull(sessions.archivedAt))
      .orderBy(desc(sessions.archivedAt), desc(sessions.updatedAt));
    return results.map(toSharedSession);
  }

  async listAll(): Promise<SharedSession[]> {
    const results = await db.select().from(sessions).orderBy(desc(sessions.updatedAt));
    return results.map(toSharedSession);
  }

  async list(): Promise<SharedSession[]> {
    return this.listAll();
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
    const drizzleUpdates: Record<string, unknown> = {
      updatedAt: new Date(),
    };

    if (updates.title !== undefined) drizzleUpdates.title = updates.title;
    if (updates.messageCount !== undefined) drizzleUpdates.messageCount = updates.messageCount;
    if (updates.totalTokensIn !== undefined) drizzleUpdates.tokensIn = updates.totalTokensIn;
    if (updates.totalTokensOut !== undefined) drizzleUpdates.tokensOut = updates.totalTokensOut;
    if (updates.totalCost !== undefined) drizzleUpdates.totalCost = updates.totalCost;
    if (updates.workingDirectory !== undefined)
      drizzleUpdates.workingDirectory = updates.workingDirectory || null;
    if (updates.interactionMode !== undefined || updates.planNoteId !== undefined) {
      const prior = await db.query.sessions.findFirst({ where: eq(sessions.id, id) });
      let metadata: Record<string, unknown> = {};
      try {
        metadata = prior?.metadata ? JSON.parse(prior.metadata) : {};
      } catch (err: unknown) {
        serverLog.debug(
          { err: err instanceof Error ? err.message : String(err) },
          'session metadata parse failed during update — using empty metadata',
        );
        metadata = {};
      }
      if (updates.interactionMode !== undefined) metadata.interactionMode = updates.interactionMode;
      if (updates.planNoteId !== undefined) metadata.planNoteId = updates.planNoteId;
      drizzleUpdates.metadata = JSON.stringify(metadata);
    }

    // Optimistic locking: when expectedVersion is provided, the update only
    // succeeds if the row's current version matches. On success, increment
    // the version so stale readers fail on retry. When no expectedVersion is
    // provided, increment unconditionally (no concurrency guard).
    if (expectedVersion !== undefined) {
      drizzleUpdates.version = expectedVersion + 1;
    } else {
      // Read current version and increment it.
      const current = await db.query.sessions.findFirst({ where: eq(sessions.id, id) });
      if (!current) return undefined;
      drizzleUpdates.version = (current.version ?? 1) + 1;
    }

    const whereClause =
      expectedVersion !== undefined
        ? and(eq(sessions.id, id), eq(sessions.version, expectedVersion))
        : eq(sessions.id, id);

    const [updated] = await db.update(sessions).set(drizzleUpdates).where(whereClause).returning();

    return updated ? toSharedSession(updated) : undefined;
  }

  /**
   * Read the current version of the session, then update it with that version
   * as the expectedVersion. This is a convenience wrapper for callers that
   * don't have a specific version in hand but still want the optimistic-lock
   * increment behavior.
   */
  async updateWithCurrentVersion(
    id: string,
    updates: Partial<SharedSession>,
  ): Promise<SharedSession | undefined> {
    const current = await this.get(id);
    if (!current) return undefined;
    return this.update(id, updates, current.version);
  }

  /** Atomically move an active chat into the archive. Retrying an already
   * committed request returns the existing row without changing its timestamp
   * or version, so a lost HTTP response is safe to retry. */
  async archive(id: string, archivedAt = Date.now()): Promise<SharedSession | undefined> {
    const at = new Date(archivedAt);
    const [updated] = await db
      .update(sessions)
      .set({
        archivedAt: at,
        version: sql`COALESCE(${sessions.version}, 1) + 1`,
      })
      .where(and(eq(sessions.id, id), isNull(sessions.archivedAt)))
      .returning();
    if (updated) return toSharedSession(updated);

    const current = await db.query.sessions.findFirst({ where: eq(sessions.id, id) });
    return current?.archivedAt ? toSharedSession(current) : undefined;
  }

  /** Atomically recover an archived chat. Retrying an already recovered chat is
   * a no-op and does not perturb sidebar ordering or optimistic versions. */
  async restore(id: string): Promise<SharedSession | undefined> {
    const [updated] = await db
      .update(sessions)
      .set({
        archivedAt: null,
        version: sql`COALESCE(${sessions.version}, 1) + 1`,
      })
      .where(and(eq(sessions.id, id), isNotNull(sessions.archivedAt)))
      .returning();
    if (updated) return toSharedSession(updated);

    const current = await db.query.sessions.findFirst({ where: eq(sessions.id, id) });
    return current && !current.archivedAt ? toSharedSession(current) : undefined;
  }
}
