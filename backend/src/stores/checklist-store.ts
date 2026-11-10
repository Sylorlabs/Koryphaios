import { nanoid } from 'nanoid';
import { desc, eq } from 'drizzle-orm';
import { db, checklists } from '../db';
import { serverLog } from '../logger';
import { redactSecretsInText } from '../security';
import type {
  Checklist,
  ChecklistActivity,
  ChecklistItem,
  ChecklistItemStatus,
  ChecklistScope,
} from '@koryphaios/shared';

const MAX_CHECKLIST_ITEMS = 512;
const MAX_ITEM_TITLE = 1_000;
const MAX_ITEM_NOTE = 4_000;
const MAX_CHECKLIST_TITLE = 1_000;
const MAX_ACTIVITY = 1_000;
const ITEM_STATUSES = new Set<ChecklistItemStatus>(['pending', 'done', 'skipped']);
const SCOPES = new Set<ChecklistScope>(['workspace', 'project', 'session']);

/** Who performed a mutation, so the UI can distinguish a person from an agent. */
export interface ChecklistActor {
  name?: string;
  role?: 'human' | 'manager' | 'worker' | 'critic';
}

/** A structural change to a checklist. Runtime state is carried over, not
 *  accepted: status and completion timestamps are read from the stored item so
 *  no actor can rewrite history by round-tripping the whole object. */
export interface ChecklistItemEdit {
  id?: string;
  title: string;
  order?: number;
}

const parseJson = (value: string | null | undefined): unknown => {
  if (!value) return undefined;
  try {
    return JSON.parse(value);
  } catch (err: unknown) {
    serverLog.debug(
      { err: err instanceof Error ? err.message : String(err) },
      'checklist JSON parse failed — using fallback',
    );
    return undefined;
  }
};

const cleanText = (value: unknown, maxLength: number): string =>
  redactSecretsInText(String(value ?? '').replace(/[\0-\x1f\x7f]/g, ' '), maxLength)
    .replace(/\s+/g, ' ')
    .trim();

/** Drop anything malformed rather than failing the whole read. */
const normalizeItems = (value: unknown): ChecklistItem[] => {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const items: ChecklistItem[] = [];
  for (const [index, entry] of value.slice(0, MAX_CHECKLIST_ITEMS).entries()) {
    const raw = entry as Partial<ChecklistItem> | null;
    const title = cleanText(raw?.title, MAX_ITEM_TITLE);
    if (!title) continue;
    let id = typeof raw?.id === 'string' && raw.id.trim() ? raw.id.trim() : nanoid(10);
    if (seen.has(id)) id = nanoid(10);
    seen.add(id);
    const status = ITEM_STATUSES.has(raw?.status as ChecklistItemStatus)
      ? (raw!.status as ChecklistItemStatus)
      : 'pending';
    const createdAt = Number.isFinite(raw?.createdAt) ? Number(raw!.createdAt) : Date.now();
    items.push({
      id,
      title,
      status,
      order: Number.isFinite(raw?.order) ? Number(raw!.order) : index,
      note: raw?.note ? cleanText(raw.note, MAX_ITEM_NOTE) || undefined : undefined,
      completedAt:
        status === 'pending'
          ? undefined
          : Number.isFinite(raw?.completedAt)
            ? Number(raw!.completedAt)
            : createdAt,
      createdAt,
    });
  }
  return items.sort((a, b) => a.order - b.order).map((item, index) => ({ ...item, order: index }));
};

const normalizeActivity = (value: unknown): ChecklistActivity[] => {
  if (!Array.isArray(value)) return [];
  return value
    .filter((entry): entry is Partial<ChecklistActivity> => !!entry && typeof entry === 'object')
    .slice(-MAX_ACTIVITY)
    .map((entry) => ({
      id: typeof entry.id === 'string' ? entry.id : nanoid(10),
      type: cleanText(entry.type, 64) || 'updated',
      message: cleanText(entry.message, 4_000),
      actor: entry.actor ? cleanText(entry.actor, 120) : undefined,
      actorRole:
        entry.actorRole === 'human' ||
        entry.actorRole === 'manager' ||
        entry.actorRole === 'worker' ||
        entry.actorRole === 'critic'
          ? entry.actorRole
          : undefined,
      createdAt: Number.isFinite(entry.createdAt) ? Number(entry.createdAt) : Date.now(),
      sessionId: typeof entry.sessionId === 'string' ? entry.sessionId : undefined,
    }))
    .filter((entry) => entry.message.length > 0);
};

type ChecklistRow = typeof checklists.$inferSelect;

const model = (row: ChecklistRow): Checklist => ({
  id: row.id,
  title: cleanText(row.title, MAX_CHECKLIST_TITLE) || 'Untitled checklist',
  scope: SCOPES.has(row.scope as ChecklistScope) ? (row.scope as ChecklistScope) : 'workspace',
  projectPath: row.projectPath ?? undefined,
  sessionId: row.sessionId ?? undefined,
  items: normalizeItems(parseJson(row.items)),
  activity: normalizeActivity(parseJson(row.activity)),
  archivedAt: row.archivedAt ? row.archivedAt.getTime() : undefined,
  createdAt: row.createdAt.getTime(),
  updatedAt: row.updatedAt.getTime(),
});

/**
 * Durable checklists that any actor can edit.
 *
 * Deliberately *not* the same thing as `GoalStore`: there is no evidence gate,
 * no critic verification, and no lifecycle. A worker, a critic, and a human all
 * go through the same methods, so the surface an agent sees and the surface a
 * person sees cannot drift apart.
 */
export class ChecklistStore {
  /** Active checklists first, then finished ones; most-recently-touched wins. */
  async list(options: { includeArchived?: boolean } = {}): Promise<Checklist[]> {
    const rows = await db.select().from(checklists).orderBy(desc(checklists.updatedAt));
    return rows.map(model).filter((checklist) => options.includeArchived || !checklist.archivedAt);
  }

  /** Checklists an actor in this chat should see: workspace-wide plus this
   *  chat's own and this project's. */
  async listVisible(
    options: { sessionId?: string; projectPath?: string } = {},
  ): Promise<Checklist[]> {
    const all = await this.list();
    return all.filter((checklist) => {
      if (checklist.scope === 'workspace') return true;
      if (checklist.scope === 'session') return checklist.sessionId === options.sessionId;
      return checklist.projectPath === options.projectPath;
    });
  }

  async get(id: string): Promise<Checklist | undefined> {
    const row = await db.query.checklists.findFirst({ where: eq(checklists.id, id) });
    return row ? model(row) : undefined;
  }

  async create(input: {
    title: string;
    scope?: ChecklistScope;
    projectPath?: string;
    sessionId?: string;
    items?: string[];
    actor?: ChecklistActor;
  }): Promise<Checklist> {
    const title = cleanText(input.title, MAX_CHECKLIST_TITLE);
    if (!title) throw new Error('Checklists require a title');
    // A checklist started inside a chat belongs to that chat. Defaulting to
    // workspace instead made every plan drafted in one chat show up in all of
    // them, because workspace scope is reachable from every chat by design.
    const scope = input.scope ?? (input.sessionId?.trim() ? 'session' : 'workspace');
    if (!SCOPES.has(scope)) throw new Error('Invalid checklist scope');
    if (scope === 'project' && !input.projectPath?.trim())
      throw new Error('Project checklists require a project directory');
    if (scope === 'session' && !input.sessionId?.trim())
      throw new Error('Session checklists require an owning chat');
    const now = new Date();
    const items = (input.items ?? [])
      .map((entry, index) => ({ title: entry, order: index }))
      .filter((entry) => entry.title.trim())
      .slice(0, MAX_CHECKLIST_ITEMS);
    const [row] = await db
      .insert(checklists)
      .values({
        id: nanoid(),
        title,
        scope,
        projectPath: scope === 'project' ? input.projectPath! : null,
        sessionId: scope === 'session' ? input.sessionId! : null,
        items: JSON.stringify(
          items.map((entry, index) => ({
            id: nanoid(10),
            title: entry.title.trim().slice(0, MAX_ITEM_TITLE),
            status: 'pending',
            order: index,
            createdAt: now.getTime(),
          })),
        ),
        activity: JSON.stringify([
          {
            id: nanoid(),
            type: 'created',
            message: `Checklist created with ${items.length} item${items.length === 1 ? '' : 's'}`,
            actor: input.actor?.name,
            actorRole: input.actor?.role,
            createdAt: now.getTime(),
          },
        ]),
        createdAt: now,
        updatedAt: now,
      })
      .returning();
    return model(row);
  }

  /**
   * Replace the checklist's structure. Items present in `edits` keep their
   * stored status; omitted items are removed. An empty `edits` array clears
   * the list, which is how a caller empties a checklist without deleting it.
   */
  async edit(
    id: string,
    edits: ChecklistItemEdit[],
    actor?: ChecklistActor,
  ): Promise<Checklist | undefined> {
    if (!Array.isArray(edits)) throw new Error('Checklist items must be an array');
    const requested = edits.slice(0, MAX_CHECKLIST_ITEMS).map((edit, index) => ({
      id: typeof edit?.id === 'string' && edit.id.trim() ? edit.id.trim() : `edit-${nanoid(10)}`,
      title: cleanText(edit?.title, MAX_ITEM_TITLE),
      order: Number.isFinite(edit?.order) ? Number(edit!.order) : index,
    }));
    for (const item of requested)
      if (!item.title) throw new Error('Checklist items require a title');
    if (new Set(requested.map((item) => item.id)).size !== requested.length)
      throw new Error('Checklist item IDs must be unique non-empty strings');

    return db.transaction((tx) => {
      const row = tx.select().from(checklists).where(eq(checklists.id, id)).limit(1).get();
      if (!row) return undefined;
      const checklist = model(row);
      const stored = new Map(checklist.items.map((item) => [item.id, item]));
      const items: ChecklistItem[] = requested.map((item) => {
        const prior = stored.get(item.id);
        return {
          id: item.id,
          title: item.title,
          status: prior?.status ?? 'pending',
          order: item.order,
          note: prior?.note,
          completedAt: prior?.completedAt,
          createdAt: prior?.createdAt ?? Date.now(),
        };
      });
      const added = items.filter((item) => !stored.has(item.id)).length;
      const renamed = items.filter(
        (item) => stored.has(item.id) && stored.get(item.id)!.title !== item.title,
      ).length;
      const removed = checklist.items.length - items.filter((item) => stored.has(item.id)).length;
      const event = {
        id: nanoid(),
        type: 'items_edited',
        message: [
          'Items edited',
          added ? `+${added} added` : '',
          removed ? `-${removed} removed` : '',
          renamed ? `${renamed} renamed` : '',
        ]
          .filter(Boolean)
          .join(', '),
        actor: actor?.name,
        actorRole: actor?.role,
        createdAt: Date.now(),
      };
      const updated = tx
        .update(checklists)
        .set({
          items: JSON.stringify(items),
          activity: JSON.stringify([...checklist.activity, event].slice(-MAX_ACTIVITY)),
          updatedAt: new Date(),
        })
        .where(eq(checklists.id, id))
        .returning()
        .get();
      return updated ? model(updated) : undefined;
    });
  }

  /**
   * Append items without resending the whole plan. This is the tool a worker
   * agent reaches for, so it must not require knowing existing item ids.
   */
  async addItems(
    id: string,
    titles: string[],
    actor?: ChecklistActor,
    sessionId?: string,
  ): Promise<Checklist | undefined> {
    const cleaned = titles
      .map((title) => cleanText(title, MAX_ITEM_TITLE))
      .filter(Boolean)
      .slice(0, MAX_CHECKLIST_ITEMS);
    if (!cleaned.length) throw new Error('Provide at least one non-empty item title');
    return db.transaction((tx) => {
      const row = tx.select().from(checklists).where(eq(checklists.id, id)).limit(1).get();
      if (!row) return undefined;
      const checklist = model(row);
      if (checklist.items.length + cleaned.length > MAX_CHECKLIST_ITEMS)
        throw new Error(`A checklist holds at most ${MAX_CHECKLIST_ITEMS} items`);
      const now = Date.now();
      const appended: ChecklistItem[] = cleaned.map((title, index) => ({
        id: nanoid(10),
        title,
        status: 'pending',
        order: checklist.items.length + index,
        createdAt: now,
      }));
      const event = {
        id: nanoid(),
        type: 'items_added',
        message: `Added ${appended.length} item${appended.length === 1 ? '' : 's'}`,
        actor: actor?.name,
        actorRole: actor?.role,
        sessionId,
        createdAt: now,
      };
      const updated = tx
        .update(checklists)
        .set({
          items: JSON.stringify([...checklist.items, ...appended]),
          activity: JSON.stringify([...checklist.activity, event].slice(-MAX_ACTIVITY)),
          updatedAt: new Date(now),
        })
        .where(eq(checklists.id, id))
        .returning()
        .get();
      return updated ? model(updated) : undefined;
    });
  }

  /** Tick, untick, or skip an item. Idempotent: re-sending the same state is a
   *  no-op rather than an error, so a retried agent call is safe. */
  async setItemStatus(
    id: string,
    itemId: string,
    status: ChecklistItemStatus,
    actor?: ChecklistActor,
    sessionId?: string,
  ): Promise<Checklist | undefined> {
    if (!ITEM_STATUSES.has(status)) throw new Error('Invalid checklist item status');
    return db.transaction((tx) => {
      const row = tx.select().from(checklists).where(eq(checklists.id, id)).limit(1).get();
      if (!row) return undefined;
      const checklist = model(row);
      if (!checklist.items.some((item) => item.id === itemId))
        throw new Error(`No item ${itemId} on checklist ${id}`);
      const now = Date.now();
      const items = checklist.items.map((item) =>
        item.id === itemId
          ? {
              ...item,
              status,
              completedAt: status === 'pending' ? undefined : (item.completedAt ?? now),
            }
          : item,
      );
      // A list whose every item is settled is finished, but stays readable.
      // Reopening an item un-archives the list it belonged to.
      const settled = items.every((item) => item.status !== 'pending');
      const event = {
        id: nanoid(),
        type: 'item_status',
        message: `Item ${status === 'done' ? 'completed' : status === 'skipped' ? 'skipped' : 'reopened'}`,
        actor: actor?.name,
        actorRole: actor?.role,
        sessionId,
        createdAt: now,
      };
      const updated = tx
        .update(checklists)
        .set({
          items: JSON.stringify(items),
          activity: JSON.stringify([...checklist.activity, event].slice(-MAX_ACTIVITY)),
          archivedAt: settled
            ? checklist.archivedAt !== undefined
              ? new Date(checklist.archivedAt)
              : new Date(now)
            : null,
          updatedAt: new Date(now),
        })
        .where(eq(checklists.id, id))
        .returning()
        .get();
      return updated ? model(updated) : undefined;
    });
  }

  async setTitle(
    id: string,
    title: string,
    actor?: ChecklistActor,
  ): Promise<Checklist | undefined> {
    const clean = cleanText(title, MAX_CHECKLIST_TITLE);
    if (!clean) throw new Error('Checklists require a title');
    return this.patch(id, {
      title: clean,
      event: { type: 'renamed', message: 'Renamed checklist', actor },
    });
  }

  async archive(id: string, actor?: ChecklistActor): Promise<Checklist | undefined> {
    const checklist = await this.get(id);
    if (!checklist) return undefined;
    return this.patch(id, {
      archivedAt: new Date(),
      event: { type: 'archived', message: 'Checklist archived', actor },
    });
  }

  async unarchive(id: string, actor?: ChecklistActor): Promise<Checklist | undefined> {
    return this.patch(id, {
      archivedAt: null,
      event: { type: 'reopened', message: 'Checklist reopened', actor },
    });
  }

  async delete(id: string): Promise<boolean> {
    const existing = await this.get(id);
    if (!existing) return false;
    await db.delete(checklists).where(eq(checklists.id, id));
    return true;
  }

  private async patch(
    id: string,
    change: {
      title?: string;
      archivedAt?: Date | null;
      event: { type: string; message: string; actor?: ChecklistActor };
    },
  ): Promise<Checklist | undefined> {
    return db.transaction((tx) => {
      const row = tx.select().from(checklists).where(eq(checklists.id, id)).limit(1).get();
      if (!row) return undefined;
      const checklist = model(row);
      const event = {
        id: nanoid(),
        type: change.event.type,
        message: change.event.message,
        actor: change.event.actor?.name,
        actorRole: change.event.actor?.role,
        createdAt: Date.now(),
      };
      const updated = tx
        .update(checklists)
        .set({
          ...(change.title ? { title: change.title } : {}),
          ...(change.archivedAt !== undefined ? { archivedAt: change.archivedAt } : {}),
          activity: JSON.stringify([...checklist.activity, event].slice(-MAX_ACTIVITY)),
          updatedAt: new Date(),
        })
        .where(eq(checklists.id, id))
        .returning()
        .get();
      return updated ? model(updated) : undefined;
    });
  }
}
