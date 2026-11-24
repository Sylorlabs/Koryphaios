import { createHash, randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import type { ComputerUseReceipt } from '@koryphaios/shared';
import { PROJECT_ROOT } from '../runtime/paths';
import { serverLog } from '../logger';

/** How long a capture stays reachable. Re-observing identical pixels refreshes it. */
const DEFAULT_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
/** Upper bound on the whole captures folder; the oldest captures go first. */
const DEFAULT_MAX_TOTAL_BYTES = 512 * 1024 * 1024;
const DEFAULT_MAX_CAPTURE_BYTES = 16 * 1024 * 1024;
const CAPTURE_ID = /^[0-9a-f]{64}$/;

/** Stable folder for persisted captures; resolved per call so the packaged app and tests can move it. */
export function computerScreenshotsRoot(): string {
  const dataDir = process.env.KORYPHAIOS_DATA_DIR?.trim() || join(PROJECT_ROOT, '.koryphaios');
  return join(dataDir, 'computer-screenshots');
}

export interface ComputerScreenshotStoreOptions {
  root?: () => string;
  now?: () => number;
  retentionMs?: number;
  maxTotalBytes?: number;
  maxCaptureBytes?: number;
}

/**
 * Pixels captured by computer use, persisted under the stable data dir so a
 * transcript receipt still resolves after the backend or app restarts.
 *
 * Layout: `<root>/<sha256(sessionId)[:32]>/<sha256(png)>.png`. The id is the
 * content hash, so the same capture always gets the same reference, and the
 * per-session folder keeps one chat's pixels unreachable from another chat.
 * Captures are pruned by age and by total size; deleting a chat removes its folder.
 */
export class ComputerScreenshotStore {
  private readonly now: () => number;
  private readonly retentionMs: number;
  private readonly maxTotalBytes: number;
  private readonly maxCaptureBytes: number;

  constructor(private readonly options: ComputerScreenshotStoreOptions = {}) {
    this.now = options.now ?? Date.now;
    this.retentionMs = options.retentionMs ?? DEFAULT_RETENTION_MS;
    this.maxTotalBytes = options.maxTotalBytes ?? DEFAULT_MAX_TOTAL_BYTES;
    this.maxCaptureBytes = options.maxCaptureBytes ?? DEFAULT_MAX_CAPTURE_BYTES;
  }

  private root(): string {
    return (this.options.root ?? computerScreenshotsRoot)();
  }

  private sessionDir(sessionId: string): string {
    return join(this.root(), createHash('sha256').update(sessionId).digest('hex').slice(0, 32));
  }

  put(sessionId: string, base64: string): NonNullable<ComputerUseReceipt['screenshot']> {
    const bytes = Buffer.from(base64, 'base64');
    if (bytes.byteLength === 0 || bytes.byteLength > this.maxCaptureBytes) {
      throw new Error('Screenshot exceeds preview capacity');
    }
    const id = createHash('sha256').update(bytes).digest('hex');
    const dir = this.sessionDir(sessionId);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const file = join(dir, `${id}.png`);
    const now = this.now();
    if (!existsSync(file)) {
      // Write-then-rename: a crash mid-write never leaves a torn capture under its final name.
      const staging = join(dir, `.${id}.${randomUUID()}.tmp`);
      writeFileSync(staging, bytes, { mode: 0o600 });
      renameSync(staging, file);
    }
    // The file mtime is the retention clock, so it follows the store's clock, not the disk's.
    utimesSync(file, now / 1000, now / 1000);
    this.prune();
    return { id, expiresAt: now + this.retentionMs };
  }

  get(sessionId: string, id: string): Uint8Array | undefined {
    if (!CAPTURE_ID.test(id)) return undefined;
    const file = join(this.sessionDir(sessionId), `${id}.png`);
    try {
      if (statSync(file).mtimeMs + this.retentionMs <= this.now()) {
        unlinkSync(file);
        return undefined;
      }
      return readFileSync(file);
    } catch {
      return undefined;
    }
  }

  /** Remove every capture a deleted chat owned. Best effort; the folder name is derived from the id. */
  deleteSession(sessionId: string): void {
    try {
      rmSync(this.sessionDir(sessionId), { recursive: true, force: true });
    } catch (err: unknown) {
      serverLog.debug(
        { err: err instanceof Error ? err.message : String(err) },
        'Failed to remove computer-use captures for an erased chat',
      );
    }
  }

  /** Enforce the age and total-size bounds over the whole captures folder. */
  private prune(): void {
    try {
      const root = this.root();
      if (!existsSync(root)) return;
      const cutoff = this.now() - this.retentionMs;
      const live: Array<{ file: string; size: number; mtimeMs: number }> = [];
      for (const dirName of readdirSync(root)) {
        const dir = join(root, dirName);
        let entries: string[];
        try {
          entries = readdirSync(dir);
        } catch {
          continue;
        }
        for (const name of entries) {
          if (!name.endsWith('.png')) continue;
          const file = join(dir, name);
          try {
            const stats = statSync(file);
            if (stats.mtimeMs <= cutoff) unlinkSync(file);
            else live.push({ file, size: stats.size, mtimeMs: stats.mtimeMs });
          } catch {
            // A concurrent reader or pruner may have removed it already.
          }
        }
      }
      let total = live.reduce((sum, entry) => sum + entry.size, 0);
      live.sort((a, b) => a.mtimeMs - b.mtimeMs);
      for (const entry of live) {
        if (total <= this.maxTotalBytes) break;
        try {
          unlinkSync(entry.file);
          total -= entry.size;
        } catch {
          // Already gone.
        }
      }
    } catch (err: unknown) {
      serverLog.debug(
        { err: err instanceof Error ? err.message : String(err) },
        'Computer-use capture pruning skipped',
      );
    }
  }
}

export const computerScreenshots = new ComputerScreenshotStore();
