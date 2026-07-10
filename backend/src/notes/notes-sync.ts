// End-to-end encrypted notes sync (local-first).
//
// Design: each peer holds a shared passphrase (never sent anywhere). Note
// records are serialized, AES-256-GCM encrypted with a key derived from the
// passphrase (PBKDF2), and exchanged as opaque envelopes over the existing
// relay — the relay only ever sees ciphertext. On receipt the peer decrypts and
// merges with a deterministic last-write-wins rule (by updatedAt), with
// tombstones for deletes so a delete propagates instead of being resurrected.
//
// The crypto + merge here are pure and fully unit-testable without two live
// peers; wiring the envelope exchange onto the relay socket is a thin transport
// layer on top.

export interface NoteRecord {
  id: string;
  title: string;
  content: string;
  folderPath: string;
  tags: string[];
  /** epoch millis of last change; drives last-write-wins. */
  updatedAt: number;
  /** tombstone — a deleted record still syncs so peers drop it too. */
  deleted?: boolean;
}

export interface SyncEnvelope {
  v: 1;
  /** base64 IV (12 bytes) */
  iv: string;
  /** base64 AES-GCM ciphertext */
  ct: string;
}

export interface MergeResult {
  merged: NoteRecord[];
  conflicts: { id: string; chosen: 'local' | 'remote'; reason: string }[];
}

const PBKDF2_ITERS = 210_000; // OWASP-recommended floor for PBKDF2-HMAC-SHA256

function toB64(bytes: Uint8Array): string {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

function fromB64(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/**
 * Derive a 256-bit AES-GCM key from a passphrase + salt. Both peers must use
 * the same passphrase and salt (e.g. salt = the sync-room id) to interoperate.
 */
export async function deriveKey(passphrase: string, salt: string): Promise<CryptoKey> {
  const enc = new TextEncoder();
  const baseKey = await crypto.subtle.importKey(
    'raw',
    enc.encode(passphrase) as BufferSource,
    'PBKDF2',
    false,
    ['deriveKey'],
  );
  return crypto.subtle.deriveKey(
    {
      name: 'PBKDF2',
      salt: enc.encode(salt) as BufferSource,
      iterations: PBKDF2_ITERS,
      hash: 'SHA-256',
    },
    baseKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

/** Encrypt a batch of note records into an opaque envelope. */
export async function encryptRecords(key: CryptoKey, records: NoteRecord[]): Promise<SyncEnvelope> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const plaintext = new TextEncoder().encode(JSON.stringify(records));
  const ct = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: iv as BufferSource },
    key,
    plaintext as BufferSource,
  );
  return { v: 1, iv: toB64(iv), ct: toB64(new Uint8Array(ct)) };
}

/** Decrypt an envelope. Throws (GCM auth failure) on a wrong key or tampering. */
export async function decryptRecords(key: CryptoKey, env: SyncEnvelope): Promise<NoteRecord[]> {
  const iv = fromB64(env.iv);
  const ct = fromB64(env.ct);
  const plain = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: iv as BufferSource },
    key,
    ct as BufferSource,
  );
  return JSON.parse(new TextDecoder().decode(plain)) as NoteRecord[];
}

/** Records changed at or after `sinceTs` — the outbound delta for a push. */
export function diffSince(records: NoteRecord[], sinceTs: number): NoteRecord[] {
  return records.filter((r) => r.updatedAt >= sinceTs);
}

/**
 * Deterministic last-write-wins merge. Newer updatedAt wins; on an exact tie the
 * lexicographically greater (id, content) wins so both peers converge to the
 * same result regardless of who merges. Tombstones participate in LWW.
 */
export function mergeRecords(local: NoteRecord[], remote: NoteRecord[]): MergeResult {
  const byId = new Map<string, NoteRecord>();
  for (const r of local) byId.set(r.id, r);
  const conflicts: MergeResult['conflicts'] = [];

  for (const rem of remote) {
    const loc = byId.get(rem.id);
    if (!loc) {
      byId.set(rem.id, rem);
      continue;
    }
    if (rem.updatedAt > loc.updatedAt) {
      byId.set(rem.id, rem);
    } else if (rem.updatedAt < loc.updatedAt) {
      // keep local
    } else {
      // Same timestamp, possibly divergent content → deterministic tiebreak.
      const same =
        loc.content === rem.content && loc.title === rem.title && !!loc.deleted === !!rem.deleted;
      if (!same) {
        const chooseRemote = rem.content > loc.content;
        byId.set(rem.id, chooseRemote ? rem : loc);
        conflicts.push({
          id: rem.id,
          chosen: chooseRemote ? 'remote' : 'local',
          reason: 'equal-timestamp',
        });
      }
    }
  }

  return { merged: Array.from(byId.values()), conflicts };
}

/**
 * Stateful helper around the pure core: tracks the last successful sync
 * watermark, produces encrypted push envelopes, and applies pull envelopes.
 */
export class NotesSyncSession {
  private lastSyncTs = 0;
  constructor(
    private readonly key: CryptoKey,
    private readonly getLocal: () => NoteRecord[],
    private readonly applyMerged: (merged: NoteRecord[]) => void,
  ) {}

  /** Build the encrypted delta to send to a peer. */
  async createPush(): Promise<SyncEnvelope> {
    const delta = diffSince(this.getLocal(), this.lastSyncTs);
    return encryptRecords(this.key, delta);
  }

  /** Apply a peer's encrypted delta; returns the conflicts that were resolved. */
  async applyPull(env: SyncEnvelope): Promise<MergeResult['conflicts']> {
    const remote = await decryptRecords(this.key, env);
    const { merged, conflicts } = mergeRecords(this.getLocal(), remote);
    this.applyMerged(merged);
    const maxTs = Math.max(this.lastSyncTs, ...remote.map((r) => r.updatedAt), 0);
    this.lastSyncTs = maxTs;
    return conflicts;
  }

  get watermark(): number {
    return this.lastSyncTs;
  }
}
