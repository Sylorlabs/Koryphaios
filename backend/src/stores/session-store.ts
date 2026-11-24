import type {
  Session as SharedSession,
  SessionAgentOverrides,
  SessionManagerControl,
} from '@koryphaios/shared';
import { isCriticMode, isValidProvider } from '@koryphaios/shared';
import { nanoid } from 'nanoid';
import { normalizeFallbackStepsInput } from '../kory/fallback-chain-input';
import { ID, SESSION } from '../constants';
import { db, sessions, type Session as DbSession } from '../db';
import { eq, and, desc, isNotNull, isNull, sql } from 'drizzle-orm';
import { serverLog } from '../logger';

const PERMISSION_MODES = ['yolo', 'guarded', 'edits', 'ask', 'custom'] as const;
const AGENT_EXECUTION_MODES = ['auto', 'single', 'multi'] as const;
const MAX_MANAGER_CONTROLS = 32;
const MAX_MANAGER_FALLBACKS = 20;

function sanitizeManagerControls(
  value: unknown,
): Record<string, SessionManagerControl> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const controls: Record<string, SessionManagerControl> = {};
  for (const [rawManagerId, raw] of Object.entries(value as Record<string, unknown>)) {
    if (Object.keys(controls).length >= MAX_MANAGER_CONTROLS) break;
    const managerId = rawManagerId.trim();
    if (!managerId || !raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
    const control = raw as Record<string, unknown>;
    if (typeof control.model !== 'string' || !control.model.trim()) continue;
    const fallbacks: SessionManagerControl['fallbacks'] = normalizeFallbackStepsInput(
      control.fallbacks,
      MAX_MANAGER_FALLBACKS,
    );
    controls[managerId] = {
      model: control.model.trim(),
      ...(typeof control.provider === 'string' &&
      (isValidProvider(control.provider) || control.provider.startsWith('custom:'))
        ? { provider: control.provider }
        : {}),
      ...(typeof control.reasoningLevel === 'string' && control.reasoningLevel
        ? { reasoningLevel: control.reasoningLevel }
        : {}),
      fallbacks,
    };
  }
  return Object.keys(controls).length > 0 ? controls : undefined;
}

/** Keep only known, well-typed override fields so a hand-edited metadata blob
 *  can never widen this chat's approval posture with an unrecognized value. */
export function sanitizeSessionAgentOverrides(value: unknown): SessionAgentOverrides | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  const overrides: SessionAgentOverrides = {};
  if (isCriticMode(raw.criticMode)) overrides.criticMode = raw.criticMode;
  if (
    typeof raw.permissionMode === 'string' &&
    (PERMISSION_MODES as readonly string[]).includes(raw.permissionMode)
  ) {
    overrides.permissionMode = raw.permissionMode as SessionAgentOverrides['permissionMode'];
  }
  if (
    typeof raw.agentExecutionMode === 'string' &&
    (AGENT_EXECUTION_MODES as readonly string[]).includes(raw.agentExecutionMode)
  ) {
    overrides.agentExecutionMode =
      raw.agentExecutionMode as SessionAgentOverrides['agentExecutionMode'];
  }
  if (typeof raw.criticGateEnabled === 'boolean') {
    overrides.criticGateEnabled = raw.criticGateEnabled;
  }
  if (
    raw.worktreeMode === 'auto' ||
    raw.worktreeMode === 'always' ||
    raw.worktreeMode === 'never'
  ) {
    overrides.worktreeMode = raw.worktreeMode;
  } else if (typeof raw.worktreeIsolation === 'boolean') {
    overrides.worktreeMode = raw.worktreeIsolation ? 'auto' : 'never';
  }
  const managerControls = sanitizeManagerControls(raw.managerControls);
  if (managerControls) overrides.managerControls = managerControls;
  if (Array.isArray(raw.blockedSkillFeeds)) {
    const blocked = [
      ...new Set(
        raw.blockedSkillFeeds
          .filter((name): name is string => typeof name === 'string')
          .map((name) => name.trim())
          .filter((name) => name.length > 0 && name.length <= 128),
      ),
    ].sort();
    if (blocked.length > 0) overrides.blockedSkillFeeds = blocked;
  }
  return Object.keys(overrides).length > 0 ? overrides : undefined;
}

export interface ISessionStore {
  create(
    titleOrUserId?: string,
    titleOrParentId?: string,
    parentId?: string,
    workingDirectory?: string,
    gitWorkspace?: SharedSession['gitWorkspace'],
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
    /** `gitWorkspace: null` removes the binding (merge_chat_back returns the
     *  chat to its folder); `undefined` leaves it untouched. */
    updates: Omit<Partial<SharedSession>, 'gitWorkspace'> & {
      gitWorkspace?: SharedSession['gitWorkspace'] | null;
    },
    expectedVersion?: number,
  ): Promise<SharedSession | undefined>;
  updateWithCurrentVersion(
    id: string,
    updates: Partial<SharedSession>,
  ): Promise<SharedSession | undefined>;
  archive(id: string, archivedAt?: number): Promise<SharedSession | undefined>;
  restore(id: string): Promise<SharedSession | undefined>;
}

function sanitizeCreatedByAgent(value: unknown): SharedSession['createdByAgent'] {
  if (!value || typeof value !== 'object') return undefined;
  const { sessionId, agentId } = value as { sessionId?: unknown; agentId?: unknown };
  if (typeof sessionId !== 'string' || typeof agentId !== 'string') return undefined;
  if (!sessionId.trim() || !agentId.trim()) return undefined;
  return { sessionId, agentId };
}

function toSharedSession(s: DbSession): SharedSession {
  let metadata: {
    interactionMode?: 'act' | 'plan';
    planNoteId?: string;
    agentOverrides?: unknown;
    gitWorkspace?: SharedSession['gitWorkspace'];
    createdByAgent?: unknown;
  } = {};
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
    forkedFromSessionId: s.forkedFromSessionId ?? undefined,
    forkedFromMessageId: s.forkedFromMessageId ?? undefined,
    forkedAt: s.forkedAt?.getTime(),
    forkMergedAt: s.forkedMergedAt?.getTime(),
    workingDirectory: s.workingDirectory ?? undefined,
    gitWorkspace: metadata.gitWorkspace,
    interactionMode: metadata.interactionMode === 'plan' ? 'plan' : 'act',
    planNoteId: typeof metadata.planNoteId === 'string' ? metadata.planNoteId : undefined,
    agentOverrides: sanitizeSessionAgentOverrides(metadata.agentOverrides),
    createdByAgent: sanitizeCreatedByAgent(metadata.createdByAgent),
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
    gitWorkspace?: SharedSession['gitWorkspace'],
  ): Promise<SharedSession> {
    const argc = arguments.length;
    const userId = argc >= 1 ? (titleOrUserId ?? null) : null;
    const title =
      argc >= 2
        ? (titleOrTitle ?? SESSION.DEFAULT_TITLE)
        : (titleOrUserId ?? SESSION.DEFAULT_TITLE);
    const parent = argc >= 3 ? parentId : argc === 2 ? undefined : titleOrTitle;

    const id = nanoid(ID.SESSION_ID_LENGTH);
    // Ordinary folder chats work directly in the selected folder. Only an
    // explicit revision choice supplies a separate Git workspace; opening a
    // local folder must never scan or copy its contents into chat storage.
    const now = new Date();

    const [session] = await db
      .insert(sessions)
      .values({
        id,
        userId: userId ?? null,
        title: title ?? SESSION.DEFAULT_TITLE,
        parentId: parent || null,
        workingDirectory: workingDirectory || null,
        ...(gitWorkspace && { metadata: JSON.stringify({ gitWorkspace }) }),
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
    /** `gitWorkspace: null` removes the binding (merge_chat_back returns the
     *  chat to its folder); `undefined` leaves it untouched. */
    updates: Omit<Partial<SharedSession>, 'gitWorkspace'> & {
      gitWorkspace?: SharedSession['gitWorkspace'] | null;
    },
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
    if (
      updates.interactionMode !== undefined ||
      updates.planNoteId !== undefined ||
      updates.agentOverrides !== undefined ||
      updates.gitWorkspace !== undefined ||
      updates.createdByAgent !== undefined
    ) {
      // Patch the row's current metadata in the UPDATE itself. Reading and
      // serializing it before an await lets concurrent settings writes erase a
      // newly persisted Git workspace (or another writer's unrelated fields).
      let metadata = sql`CASE WHEN json_valid(${sessions.metadata}) THEN
        CASE WHEN json_type(${sessions.metadata}) = 'object' THEN ${sessions.metadata} ELSE '{}' END
        ELSE '{}' END`;
      if (updates.interactionMode !== undefined)
        metadata = sql`json_set(${metadata}, '$.interactionMode', ${updates.interactionMode})`;
      if (updates.planNoteId !== undefined)
        metadata = sql`json_set(${metadata}, '$.planNoteId', ${updates.planNoteId})`;
      if (updates.createdByAgent !== undefined) {
        const provenance = sanitizeCreatedByAgent(updates.createdByAgent);
        metadata = provenance
          ? sql`json_set(${metadata}, '$.createdByAgent', json(${JSON.stringify(provenance)}))`
          : sql`json_remove(${metadata}, '$.createdByAgent')`;
      }
      if (updates.gitWorkspace !== undefined)
        metadata =
          updates.gitWorkspace === null
            ? sql`json_remove(${metadata}, '$.gitWorkspace')`
            : sql`json_set(${metadata}, '$.gitWorkspace', json(${JSON.stringify(updates.gitWorkspace)}))`;
      if (updates.agentOverrides !== undefined) {
        const sanitized = sanitizeSessionAgentOverrides(updates.agentOverrides);
        // An empty patch clears the per-chat overrides so the chat falls back
        // to the project-wide agent settings again.
        metadata = sanitized
          ? sql`json_set(${metadata}, '$.agentOverrides', json(${JSON.stringify(sanitized)}))`
          : sql`json_remove(${metadata}, '$.agentOverrides')`;
      }
      drizzleUpdates.metadata = metadata;
    }

    // Optimistic locking: when expectedVersion is provided, the update only
    // succeeds if the row's current version matches. On success, increment
    // the version so stale readers fail on retry. When no expectedVersion is
    // provided, increment unconditionally (no concurrency guard).
    drizzleUpdates.version = sql`COALESCE(${sessions.version}, 1) + 1`;

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
