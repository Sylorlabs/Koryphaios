/**
 * Attachment payloads for unsent composer drafts.
 *
 * localStorage is a ~5 MB string budget shared by every draft on the origin,
 * which is smaller than a single phone photo. Keeping draft images there
 * means a large attachment cannot survive a restart, so payloads live in
 * IndexedDB, whose quota is disk-backed. There is deliberately no size cap
 * here: an attachment the platform can store is an attachment the draft keeps.
 *
 * A write that the platform refuses (quota, private mode) reports failure
 * rather than dropping the payload silently, so the composer can tell the
 * user instead of pretending the draft is safe.
 */

export type StoredDraftAttachment = {
  type: 'image' | 'file';
  data: string;
  name: string;
  mimeType?: string;
};

export interface DraftAttachmentStore {
  /** Attachments currently stored for a draft key. */
  read(key: string): Promise<StoredDraftAttachment[]>;
  /** Replace the stored attachments. Resolves false when the platform refused. */
  write(key: string, attachments: readonly StoredDraftAttachment[]): Promise<boolean>;
  remove(key: string): Promise<void>;
  /** True when payloads live outside the localStorage string budget. */
  readonly external: boolean;
}

const DB_NAME = 'koryphaios-composer-drafts';
const DB_VERSION = 1;
const STORE_NAME = 'attachments';

function indexedDbFactory(): IDBFactory | null {
  try {
    const factory = (globalThis as { indexedDB?: IDBFactory }).indexedDB;
    return factory ?? null;
  } catch {
    return null;
  }
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('IndexedDB request failed'));
  });
}

function isStoredAttachment(value: unknown): value is StoredDraftAttachment {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  return (
    (item.type === 'image' || item.type === 'file') &&
    typeof item.data === 'string' &&
    typeof item.name === 'string'
  );
}

/** An IndexedDB-backed attachment store, or null where IndexedDB is missing. */
export function createIndexedDbAttachmentStore(): DraftAttachmentStore | null {
  const factory = indexedDbFactory();
  if (!factory) return null;

  let dbPromise: Promise<IDBDatabase> | null = null;
  const openDatabase = (): Promise<IDBDatabase> => {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
      const request = factory.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(STORE_NAME)) db.createObjectStore(STORE_NAME);
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new Error('Could not open draft storage'));
      request.onblocked = () => reject(new Error('Draft storage is blocked by another window'));
    }).catch((error) => {
      // A failed open must not poison later attempts.
      dbPromise = null;
      throw error;
    });
    return dbPromise;
  };

  const withStore = async <T>(
    mode: IDBTransactionMode,
    run: (store: IDBObjectStore) => Promise<T>,
  ): Promise<T> => {
    const db = await openDatabase();
    try {
      const transaction = db.transaction(STORE_NAME, mode);
      return await run(transaction.objectStore(STORE_NAME));
    } finally {
      db.close();
    }
  };

  // Typing produces overlapping writes for one draft. Serialize per key so the
  // last issued write is also the last applied one, and so a read issued after
  // a write cannot observe the previous payload.
  const tails = new Map<string, Promise<unknown>>();
  const enqueue = <T>(key: string, task: () => Promise<T>): Promise<T> => {
    const previous = tails.get(key) ?? Promise.resolve();
    const next = previous.then(task, task);
    tails.set(
      key,
      next.catch(() => {}),
    );
    return next;
  };

  return {
    external: true,
    read(key) {
      return enqueue(key, async () => {
        try {
          const stored = await withStore('readonly', (store) => requestResult(store.get(key)));
          return Array.isArray(stored) ? stored.filter(isStoredAttachment) : [];
        } catch {
          return [];
        }
      });
    },
    write(key, attachments) {
      return enqueue(key, async () => {
        try {
          await withStore('readwrite', async (store) => {
            if (attachments.length === 0) {
              await requestResult(store.delete(key));
              return;
            }
            await requestResult(
              store.put(
                attachments.map((item) => ({ ...item })),
                key,
              ),
            );
          });
          return true;
        } catch {
          return false;
        }
      });
    },
    remove(key) {
      return enqueue(key, async () => {
        try {
          await withStore('readwrite', (store) => requestResult(store.delete(key)));
        } catch {
          // A draft the platform already lost needs no further cleanup.
        }
      });
    },
  };
}
