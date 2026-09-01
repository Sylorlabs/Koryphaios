import { and, asc, eq, inArray } from 'drizzle-orm';
import { db, sessionFeedEntries, sessionFeedTombstones } from '../db';

export const MAX_CLIENT_FEED_ERROR_CHARS = 16_384;
export const MAX_FEED_TARGETS_PER_MUTATION = 256;

export type FeedTombstoneVisibility = 'hidden' | 'deleted';

export interface DurableClientFeedError {
  id: string;
  kind: 'client_error';
  text: string;
  timestamp: number;
}

export interface DurableFeedTombstone {
  targetKey: string;
  visibility: FeedTombstoneVisibility;
}

export interface DurableFeedState {
  entries: DurableClientFeedError[];
  tombstones: DurableFeedTombstone[];
}

const SIMPLE_TARGET_KEY = /^(?:message|archive|thread|client):[A-Za-z0-9_-]{1,256}$/;
const EVENT_TARGET_KEY = /^event:([1-9]\d{0,9}):([1-9]\d{0,11}):([1-9]\d{0,11})$/;
const CLIENT_ENTRY_ID = /^[A-Za-z0-9_-]{1,256}$/;

/**
 * Validate the only replay identities a renderer is allowed to suppress.
 * The event form carries one closed epoch/sequence range so a coalesced
 * streaming card can be hidden without giving the client a broad wildcard.
 */
export function isValidFeedTargetKey(value: string): boolean {
  if (SIMPLE_TARGET_KEY.test(value)) return true;
  const event = EVENT_TARGET_KEY.exec(value);
  if (!event) return false;
  const start = Number(event[2]);
  const end = Number(event[3]);
  return Number.isSafeInteger(start) && Number.isSafeInteger(end) && start <= end;
}

export function normalizeClientFeedErrorText(value: string): string {
  const text = value.replace(/\r\n?/g, '\n').trim();
  if (!text) throw new Error('Feed error text cannot be empty.');
  if (text.length > MAX_CLIENT_FEED_ERROR_CHARS) {
    throw new Error(`Feed error text cannot exceed ${MAX_CLIENT_FEED_ERROR_CHARS} characters.`);
  }
  // Preserve normal line breaks and tabs in diagnostics, but never persist
  // invisible controls that can corrupt a transcript or downstream renderer.
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(text)) {
    throw new Error('Feed error text contains unsupported control characters.');
  }
  return text;
}

function normalizeClientEntryId(value: string): string {
  if (!CLIENT_ENTRY_ID.test(value)) throw new Error('Feed entry ID is invalid.');
  return value;
}

function normalizeTargetKeys(targetKeys: readonly string[]): string[] {
  const unique = [...new Set(targetKeys)];
  if (unique.length === 0) throw new Error('At least one feed target is required.');
  if (unique.length > MAX_FEED_TARGETS_PER_MUTATION) {
    throw new Error(`A feed action can target at most ${MAX_FEED_TARGETS_PER_MUTATION} entries.`);
  }
  if (unique.some((key) => !isValidFeedTargetKey(key))) {
    throw new Error('Feed visibility target is invalid.');
  }
  return unique;
}

function chunks<T>(items: readonly T[], size: number): T[][] {
  const result: T[][] = [];
  for (let index = 0; index < items.length; index += size) result.push(items.slice(index, index + size));
  return result;
}

/** Durable, local-only state for explicit feed actions. */
export class FeedPersistenceStore {
  async getState(sessionId: string): Promise<DurableFeedState> {
    const [entries, tombstones] = await Promise.all([
      db
        .select({
          id: sessionFeedEntries.id,
          kind: sessionFeedEntries.kind,
          text: sessionFeedEntries.text,
          timestamp: sessionFeedEntries.timestamp,
        })
        .from(sessionFeedEntries)
        .where(eq(sessionFeedEntries.sessionId, sessionId))
        .orderBy(asc(sessionFeedEntries.timestamp), asc(sessionFeedEntries.id)),
      db
        .select({
          targetKey: sessionFeedTombstones.targetKey,
          visibility: sessionFeedTombstones.visibility,
        })
        .from(sessionFeedTombstones)
        .where(eq(sessionFeedTombstones.sessionId, sessionId))
        .orderBy(asc(sessionFeedTombstones.updatedAt)),
    ]);
    return {
      entries: entries.map((entry) => ({
        id: entry.id,
        kind: 'client_error',
        text: entry.text,
        timestamp: entry.timestamp.getTime(),
      })),
      tombstones: tombstones.map((tombstone) => ({
        targetKey: tombstone.targetKey,
        visibility: tombstone.visibility as FeedTombstoneVisibility,
      })),
    };
  }

  async recordClientError(input: {
    id: string;
    sessionId: string;
    text: string;
    timestamp?: number;
  }): Promise<void> {
    const id = normalizeClientEntryId(input.id);
    const text = normalizeClientFeedErrorText(input.text);
    const now = Date.now();
    const timestamp =
      typeof input.timestamp === 'number' && Number.isSafeInteger(input.timestamp)
        ? input.timestamp
        : now;
    await db
      .insert(sessionFeedEntries)
      .values({
        id,
        sessionId: input.sessionId,
        kind: 'client_error',
        text,
        timestamp: new Date(timestamp),
        createdAt: new Date(now),
        updatedAt: new Date(now),
      })
      .onConflictDoNothing();
  }

  async setVisibility(
    sessionId: string,
    targetKeys: readonly string[],
    visibility: FeedTombstoneVisibility | 'visible',
  ): Promise<void> {
    const targets = normalizeTargetKeys(targetKeys);
    if (visibility === 'visible') {
      for (const batch of chunks(targets, 128)) {
        await db
          .delete(sessionFeedTombstones)
          .where(
            and(
              eq(sessionFeedTombstones.sessionId, sessionId),
              inArray(sessionFeedTombstones.targetKey, batch),
            ),
          );
      }
      return;
    }

    const now = new Date();
    for (const targetKey of targets) {
      await db
        .insert(sessionFeedTombstones)
        .values({
          sessionId,
          targetKey,
          visibility,
          createdAt: now,
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: [sessionFeedTombstones.sessionId, sessionFeedTombstones.targetKey],
          set: { visibility, updatedAt: now },
        });
    }
  }
}

export const feedPersistenceStore = new FeedPersistenceStore();
