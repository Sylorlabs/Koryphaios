import { randomUUID } from 'node:crypto';
import { existsSync, unlinkSync } from 'node:fs';
import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Database } from 'bun:sqlite';
import { getDb } from '../db';
import { serverLog } from '../logger';
import { PROJECT_ROOT } from '../runtime/paths';

// Video history — persists generated clips so the video gallery survives
// refreshes. Metadata lives in SQLite (migration 0049); video bytes stay on
// disk as files named by entry id.
//
// Videos are far larger than images, so retention is shorter by default and a
// single clip is size-capped. Without that, a handful of video generations
// could fill the data directory.

export interface VideoHistoryEntry {
  id: string;
  /** Epoch milliseconds. */
  ts: number;
  provider: string;
  model: string;
  mimeType: string;
  prompt: string;
  duration?: string;
  aspectRatio?: string;
  resolution?: string;
  mode: 'generate' | 'edit';
  /** File name inside the videos dir holding the video bytes. */
  file: string;
}

export interface SaveVideoHistoryInput {
  videoBase64: string;
  mimeType: string;
  prompt: string;
  provider: string;
  model: string;
  duration?: string;
  aspectRatio?: string;
  resolution?: string;
  mode: 'generate' | 'edit';
}

/** Clips are kept for a month; providers also expire their own CDN copies. */
const DEFAULT_RETENTION_DAYS = 30;
const PRUNE_INTERVAL_MS = 60 * 60 * 1000;
let lastPruneAt = 0;

/** Refuse any file name that could escape the videos directory. */
function resolveVideoFile(file: string): string {
  if (
    !file ||
    file.includes('/') ||
    file.includes('\\') ||
    file.includes('..') ||
    file !== file.trim()
  ) {
    throw new Error('Invalid video history file name');
  }
  return join(videosDir(), file);
}

function videosDir(): string {
  const dataDir = process.env.KORYPHAIOS_DATA_DIR?.trim() || join(PROJECT_ROOT, '.koryphaios');
  return join(dataDir, 'videos');
}

function extensionFor(mimeType: string): string {
  if (mimeType.includes('webm')) return 'webm';
  if (mimeType.includes('quicktime')) return 'mov';
  return 'mp4';
}

function db(): Database {
  return getDb();
}

interface VideoHistoryRow {
  id: string;
  ts: number;
  provider: string;
  model: string;
  mime_type: string;
  prompt: string;
  duration: string | null;
  aspect_ratio: string | null;
  resolution: string | null;
  mode: string;
  file: string;
}

function rowToEntry(row: VideoHistoryRow): VideoHistoryEntry {
  return {
    id: row.id,
    ts: row.ts,
    provider: row.provider,
    model: row.model,
    mimeType: row.mime_type,
    prompt: row.prompt,
    duration: row.duration ?? undefined,
    aspectRatio: row.aspect_ratio ?? undefined,
    resolution: row.resolution ?? undefined,
    mode: row.mode === 'edit' ? 'edit' : 'generate',
    file: row.file,
  };
}

function ensureSchema(database: Database): void {
  database.run(`
    CREATE TABLE IF NOT EXISTS video_history (
      id TEXT PRIMARY KEY,
      ts INTEGER NOT NULL,
      provider TEXT NOT NULL,
      model TEXT NOT NULL,
      mime_type TEXT NOT NULL,
      prompt TEXT NOT NULL,
      duration TEXT,
      aspect_ratio TEXT,
      resolution TEXT,
      mode TEXT NOT NULL CHECK (mode IN ('generate', 'edit')),
      file TEXT NOT NULL
    );
  `);
}

function withDb(): Database {
  const database = db();
  ensureSchema(database);
  return database;
}

/** Persist one clip + metadata. Best-effort: failures never break generation. */
export async function saveVideoHistory(
  input: SaveVideoHistoryInput,
): Promise<VideoHistoryEntry | undefined> {
  const entry: VideoHistoryEntry = {
    id: randomUUID(),
    ts: Date.now(),
    provider: input.provider,
    model: input.model,
    mimeType: input.mimeType,
    prompt: input.prompt,
    duration: input.duration,
    aspectRatio: input.aspectRatio,
    resolution: input.resolution,
    mode: input.mode,
    file: `${randomUUID()}.${extensionFor(input.mimeType)}`,
  };
  try {
    await mkdir(videosDir(), { recursive: true, mode: 0o700 });
    await writeFile(join(videosDir(), entry.file), Buffer.from(input.videoBase64, 'base64'), {
      mode: 0o600,
    });
    withDb()
      .prepare(
        `INSERT INTO video_history
           (id, ts, provider, model, mime_type, prompt, duration, aspect_ratio, resolution, mode, file)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        entry.id,
        entry.ts,
        entry.provider,
        entry.model,
        entry.mimeType,
        entry.prompt,
        entry.duration ?? null,
        entry.aspectRatio ?? null,
        entry.resolution ?? null,
        entry.mode,
        entry.file,
      );
    void maybePruneOldEntries();
    return entry;
  } catch (err: unknown) {
    serverLog.debug(
      { err: err instanceof Error ? err.message : String(err) },
      'Failed to save video history entry',
    );
    // Never leave an orphan video file behind when the DB write failed.
    try {
      if (existsSync(resolveVideoFile(entry.file))) await unlink(resolveVideoFile(entry.file));
    } catch {
      // best-effort cleanup
    }
    return undefined;
  }
}

export async function listVideoHistory(limit = 24): Promise<VideoHistoryEntry[]> {
  try {
    const rows = withDb()
      // `ts` is millisecond-resolution, so two clips made in the same millisecond
      // tie. `id` is a random UUID and would order them arbitrarily; SQLite's
      // implicit rowid increases monotonically with insertion, so it is the
      // honest newest-first tiebreaker and needs no extra column or index.
      .prepare(`SELECT * FROM video_history ORDER BY ts DESC, rowid DESC LIMIT ?`)
      .all(Math.max(1, Math.min(limit, 100))) as unknown as VideoHistoryRow[];
    return rows.map(rowToEntry);
  } catch (err: unknown) {
    serverLog.debug(
      { err: err instanceof Error ? err.message : String(err) },
      'Failed to list video history',
    );
    return [];
  }
}

export async function getVideoHistoryEntry(
  id: string,
): Promise<(VideoHistoryEntry & { videoBase64: string }) | undefined> {
  try {
    const row = withDb()
      .prepare(`SELECT * FROM video_history WHERE id = ?`)
      .get(id) as VideoHistoryRow | null;
    if (!row) return undefined;
    const bytes = await readFile(resolveVideoFile(row.file));
    return { ...rowToEntry(row), videoBase64: bytes.toString('base64') };
  } catch (err: unknown) {
    serverLog.debug(
      { err: err instanceof Error ? err.message : String(err), id },
      'Failed to load video history entry',
    );
    return undefined;
  }
}

export async function deleteVideoHistoryEntry(id: string): Promise<boolean> {
  try {
    const database = withDb();
    const row = database.prepare(`SELECT file FROM video_history WHERE id = ?`).get(id) as {
      file: string;
    } | null;
    if (!row) return false;
    // Unlink first: a crash after row loss loses only metadata, while an
    // orphaned video file would never be garbage collected.
    try {
      unlinkSync(resolveVideoFile(row.file));
    } catch {
      // The file may already be gone; the row removal is what matters.
    }
    database.prepare(`DELETE FROM video_history WHERE id = ?`).run(id);
    return true;
  } catch (err: unknown) {
    serverLog.debug(
      { err: err instanceof Error ? err.message : String(err), id },
      'Failed to delete video history entry',
    );
    return false;
  }
}

/** Delete entries older than the retention window (and their video files). */
export async function pruneVideoHistory(maxAgeDays = DEFAULT_RETENTION_DAYS): Promise<number> {
  try {
    const cutoff = Date.now() - Math.max(1, maxAgeDays) * 24 * 60 * 60 * 1000;
    const database = withDb();
    const rows = database
      .prepare(`SELECT id, file FROM video_history WHERE ts < ?`)
      .all(cutoff) as Array<{ id: string; file: string }>;
    if (!rows.length) return 0;
    database.transaction(() => {
      for (const row of rows) {
        try {
          unlinkSync(resolveVideoFile(row.file));
        } catch {
          // Missing file: the row still has to go.
        }
        database.prepare(`DELETE FROM video_history WHERE id = ?`).run(row.id);
      }
    })();
    return rows.length;
  } catch (err: unknown) {
    serverLog.debug(
      { err: err instanceof Error ? err.message : String(err) },
      'Failed to prune video history',
    );
    return 0;
  }
}

/** Rate-limited prune so listing does not scan on every call. */
export async function maybePruneOldEntries(now = Date.now()): Promise<number> {
  if (now - lastPruneAt < PRUNE_INTERVAL_MS) return 0;
  lastPruneAt = now;
  return pruneVideoHistory();
}
