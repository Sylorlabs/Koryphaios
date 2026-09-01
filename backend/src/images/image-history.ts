// Image history — persists generated/edited images so the studio gallery
// survives refreshes. Metadata lives in SQLite (migration 0030); image bytes
// stay on disk as files named by entry id. A legacy JSONL index is imported
// once and archived.

import { createHash, randomUUID } from 'node:crypto';
import { existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { mkdir, readFile, unlink, writeFile as writeFileAsync } from 'node:fs/promises';
import { join } from 'node:path';
import type { Database } from 'bun:sqlite';
import { getDb } from '../db';
import { PROJECT_ROOT } from '../runtime/paths';
import { serverLog } from '../logger';

export interface ImageHistoryEntry {
  id: string;
  /** Epoch milliseconds. */
  ts: number;
  provider: string;
  model: string;
  mimeType: string;
  prompt: string;
  revisedPrompt?: string;
  effect?: string;
  size?: string;
  quality?: string;
  mode: 'generate' | 'edit';
  /** File name inside the images dir holding the image bytes. */
  file: string;
}

const DEFAULT_RETENTION_DAYS = 180;
const PRUNE_INTERVAL_MS = 60 * 60 * 1000;
let lastPruneAt = 0;

/** Image file names come from the DB/legacy index — refuse anything that
 *  could escape the images directory. */
function resolveImageFile(file: string): string {
  if (
    !file ||
    file.includes('/') ||
    file.includes('\\') ||
    file.includes('..') ||
    file !== file.trim()
  ) {
    throw new Error('Invalid image history file name');
  }
  return join(imagesDir(), file);
}

function imagesDir(): string {
  const dataDir = process.env.KORYPHAIOS_DATA_DIR?.trim() || join(PROJECT_ROOT, '.koryphaios');
  return join(dataDir, 'images');
}

function legacyIndexPath(): string {
  return join(imagesDir(), 'index.jsonl');
}

function extensionFor(mimeType: string): string {
  if (mimeType.includes('jpeg')) return 'jpg';
  if (mimeType.includes('webp')) return 'webp';
  return 'png';
}

function db(): Database {
  return getDb();
}

interface ImageHistoryRow {
  id: string;
  ts: number;
  provider: string;
  model: string;
  mime_type: string;
  prompt: string;
  revised_prompt: string | null;
  effect: string | null;
  size: string | null;
  quality: string | null;
  mode: string;
  file: string;
}

function rowToEntry(row: ImageHistoryRow): ImageHistoryEntry {
  return {
    id: row.id,
    ts: row.ts,
    provider: row.provider,
    model: row.model,
    mimeType: row.mime_type,
    prompt: row.prompt,
    revisedPrompt: row.revised_prompt ?? undefined,
    effect: row.effect ?? undefined,
    size: row.size ?? undefined,
    quality: row.quality ?? undefined,
    mode: row.mode === 'edit' ? 'edit' : 'generate',
    file: row.file,
  };
}

function ensureSchema(database: Database): void {
  database.run(`
    CREATE TABLE IF NOT EXISTS image_history (
      id TEXT PRIMARY KEY,
      ts INTEGER NOT NULL,
      provider TEXT NOT NULL,
      model TEXT NOT NULL,
      mime_type TEXT NOT NULL,
      prompt TEXT NOT NULL,
      revised_prompt TEXT,
      effect TEXT,
      size TEXT,
      quality TEXT,
      mode TEXT NOT NULL CHECK (mode IN ('generate', 'edit')),
      file TEXT NOT NULL
    );
  `);
}

/** One-time import of the legacy JSONL index; the file is archived after. */
function importLegacyIndex(database: Database): void {
  const path = legacyIndexPath();
  if (!existsSync(path)) return;
  try {
    const raw = readFileSync(path, 'utf8');
    const entries: ImageHistoryEntry[] = [];
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      try {
        const parsed = JSON.parse(line) as ImageHistoryEntry;
        if (parsed && typeof parsed.ts === 'number' && typeof parsed.file === 'string') {
          // Stable id from the line: a re-import after a crash between
          // INSERT and archive is a no-op via INSERT OR IGNORE.
          entries.push({
            ...parsed,
            id: parsed.id || createHash('sha256').update(line).digest('hex').slice(0, 32),
          });
        }
      } catch {
        // Skip torn/corrupt lines.
      }
    }
    const insert = database.prepare(
      `INSERT OR IGNORE INTO image_history
         (id, ts, provider, model, mime_type, prompt, revised_prompt, effect, size, quality, mode, file)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    database.transaction(() => {
      for (const entry of entries) {
        insert.run(
          entry.id,
          entry.ts,
          entry.provider,
          entry.model,
          entry.mimeType,
          entry.prompt,
          entry.revisedPrompt ?? null,
          entry.effect ?? null,
          entry.size ?? null,
          entry.quality ?? null,
          entry.mode === 'edit' ? 'edit' : 'generate',
          entry.file,
        );
      }
    })();
    renameSync(path, `${path}.imported`);
    serverLog.info({ imported: entries.length }, 'Imported legacy image history index');
  } catch (err: unknown) {
    serverLog.warn(
      { err: err instanceof Error ? err.message : String(err), path },
      'Failed to import legacy image history index',
    );
  }
}

function withDb(): Database {
  const database = db();
  ensureSchema(database);
  importLegacyIndex(database);
  return database;
}

export interface SaveImageHistoryInput {
  imageBase64: string;
  mimeType: string;
  prompt: string;
  revisedPrompt?: string;
  provider: string;
  model: string;
  effect?: string;
  size?: string;
  quality?: string;
  mode: 'generate' | 'edit';
}

/** Persist one image + metadata. Best-effort: failures never break generation. */
export async function saveImageHistory(
  input: SaveImageHistoryInput,
): Promise<ImageHistoryEntry | undefined> {
  const entry: ImageHistoryEntry = {
    id: randomUUID(),
    ts: Date.now(),
    provider: input.provider,
    model: input.model,
    mimeType: input.mimeType,
    prompt: input.prompt,
    revisedPrompt: input.revisedPrompt,
    effect: input.effect,
    size: input.size,
    quality: input.quality,
    mode: input.mode,
    file: `${randomUUID()}.${extensionFor(input.mimeType)}`,
  };
  try {
    await mkdir(imagesDir(), { recursive: true, mode: 0o700 });
    await writeFileAsync(join(imagesDir(), entry.file), Buffer.from(input.imageBase64, 'base64'), {
      mode: 0o600,
    });
    withDb()
      .prepare(
        `INSERT INTO image_history
           (id, ts, provider, model, mime_type, prompt, revised_prompt, effect, size, quality, mode, file)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        entry.id,
        entry.ts,
        entry.provider,
        entry.model,
        entry.mimeType,
        entry.prompt,
        entry.revisedPrompt ?? null,
        entry.effect ?? null,
        entry.size ?? null,
        entry.quality ?? null,
        entry.mode,
        entry.file,
      );
    void maybePruneOldEntries();
    return entry;
  } catch (err: unknown) {
    serverLog.debug(
      { err: err instanceof Error ? err.message : String(err) },
      'Failed to save image history entry',
    );
    // Never leave an orphan image file behind when the DB write failed.
    try {
      if (existsSync(resolveImageFile(entry.file))) await unlink(resolveImageFile(entry.file));
    } catch {
      // best-effort cleanup
    }
    return undefined;
  }
}

export async function listImageHistory(limit = 24): Promise<ImageHistoryEntry[]> {
  try {
    const rows = withDb()
      .prepare(`SELECT * FROM image_history ORDER BY ts DESC, id DESC LIMIT ?`)
      .all(Math.max(1, Math.min(limit, 100))) as unknown as ImageHistoryRow[];
    return rows.map(rowToEntry);
  } catch (err: unknown) {
    serverLog.debug(
      { err: err instanceof Error ? err.message : String(err) },
      'Failed to list image history',
    );
    return [];
  }
}

export async function getImageHistoryEntry(
  id: string,
): Promise<(ImageHistoryEntry & { imageBase64: string }) | undefined> {
  try {
    const row = withDb()
      .prepare(`SELECT * FROM image_history WHERE id = ?`)
      .get(id) as ImageHistoryRow | null;
    if (!row) return undefined;
    const bytes = await readFile(resolveImageFile(row.file));
    return { ...rowToEntry(row), imageBase64: bytes.toString('base64') };
  } catch (err: unknown) {
    serverLog.debug(
      { err: err instanceof Error ? err.message : String(err), id },
      'Failed to load image history entry',
    );
    return undefined;
  }
}

export async function deleteImageHistoryEntry(id: string): Promise<boolean> {
  try {
    const database = withDb();
    const row = database
      .prepare(`SELECT file FROM image_history WHERE id = ?`)
      .get(id) as { file: string } | null;
    if (!row) return false;
    // Unlink first: a crash after row loss loses only metadata, while an
    // orphaned image file would never be garbage collected.
    try {
      unlinkSync(resolveImageFile(row.file));
    } catch {
      // The image file may already be gone; the row removal is what matters.
    }
    database.prepare(`DELETE FROM image_history WHERE id = ?`).run(id);
    return true;
  } catch (err: unknown) {
    serverLog.debug(
      { err: err instanceof Error ? err.message : String(err), id },
      'Failed to delete image history entry',
    );
    return false;
  }
}

/** Delete entries older than the retention window (and their image files). */
export async function pruneImageHistory(maxAgeDays = DEFAULT_RETENTION_DAYS): Promise<number> {
  try {
    const cutoff = Date.now() - Math.max(1, maxAgeDays) * 24 * 60 * 60 * 1000;
    const database = withDb();
    const stale = database
      .prepare(`SELECT file FROM image_history WHERE ts < ?`)
      .all(cutoff) as Array<{ file: string }>;
    if (stale.length === 0) return 0;
    for (const row of stale) {
      try {
        unlinkSync(resolveImageFile(row.file));
      } catch {
        // best-effort file cleanup
      }
    }
    database.prepare(`DELETE FROM image_history WHERE ts < ?`).run(cutoff);
    return stale.length;
  } catch (err: unknown) {
    serverLog.debug(
      { err: err instanceof Error ? err.message : String(err) },
      'Failed to prune image history',
    );
    return 0;
  }
}

/** Throttled retention pass — at most once per hour, best-effort. */
export async function maybePruneOldEntries(): Promise<number> {
  const now = Date.now();
  if (now - lastPruneAt < PRUNE_INTERVAL_MS) return 0;
  const pruned = await pruneImageHistory();
  lastPruneAt = Date.now();
  return pruned;
}

/** Test helper: write directly into the images dir. */
export async function writeImageFileForTests(file: string, bytes: Buffer): Promise<void> {
  await mkdir(imagesDir(), { recursive: true, mode: 0o700 });
  writeFileSync(join(imagesDir(), file), bytes, { mode: 0o600 });
}
