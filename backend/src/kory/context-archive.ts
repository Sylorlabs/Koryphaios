// Context archive — a private, bounded activity index for a session. It exists
// so context-window space can be reclaimed while retaining enough redacted
// evidence to identify earlier tool calls and outputs. Raw tool output is never
// durable here; fetch_context returns only the persisted preview.
//
// Storage: `.koryphaios/sessions/<id>/context-archive.jsonl` — one JSON row per
// event, plus `prune`/`unprune` marker rows so visibility survives restarts.

import { createHash } from 'node:crypto';
import { constants as fsConstants, existsSync } from 'node:fs';
import { chmod, lstat, mkdir, open, readFile, rename, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { serverLog } from '../logger';
import { redactSecretsInText } from '../security';

const ARCHIVE_PREVIEW_MAX_BYTES = 8 * 1024;
const ARCHIVE_DURABLE_MAX_BYTES = 4 * 1024 * 1024;
const ARCHIVE_DURABLE_MAX_ENTRIES = 1_000;
const SAFE_SESSION_ID = /^[A-Za-z0-9_-][A-Za-z0-9._-]{0,511}$/;

export const CONTEXT_ARCHIVE_LIMITS = {
  previewBytes: ARCHIVE_PREVIEW_MAX_BYTES,
  durableBytes: ARCHIVE_DURABLE_MAX_BYTES,
  durableEntries: ARCHIVE_DURABLE_MAX_ENTRIES,
} as const;

export type ArchiveKind = 'tool_call' | 'tool_result' | 'file_edit' | 'terminal';

export interface ArchiveEntry {
  id: string;
  sessionId: string;
  ts: number;
  kind: ArchiveKind;
  /** Short human/model-readable label, e.g. `read_file src/foo.ts`. */
  label: string;
  /** Bounded, redacted preview. This is never the exact original output. */
  content: string;
  originalByteCount: number;
  contentSha256: string;
  truncated: boolean;
  redacted: boolean;
  /** Hidden from the agent's context (stubbed). The preview stays recoverable. */
  prunedForAgent?: boolean;
}

export interface UsageSnapshot {
  used: number;
  max: number;
  contextKnown: boolean;
  breakdown?: { system: number; memory: number; tools: number; chat: number };
  ts: number;
}

export interface ArchiveRetention {
  droppedEntries: number;
  retainedEntries: number;
  maxEntries: number;
  maxBytes: number;
  compactedAt: number;
}

interface SessionState {
  entries: ArchiveEntry[];
  byId: Map<string, ArchiveEntry>;
  counter: number;
  loaded: boolean;
  lastUsage?: UsageSnapshot;
  retention?: ArchiveRetention;
}

export class ContextArchiveService {
  private sessions = new Map<string, SessionState>();
  private erasingSessions = new Set<string>();

  constructor(private workingDirectory: string) {}

  private assertSessionId(sessionId: string): void {
    if (!SAFE_SESSION_ID.test(sessionId) || sessionId === '.' || sessionId === '..') {
      throw new Error('Context archive refused an unsafe session ID');
    }
  }

  private dir(sessionId: string): string {
    this.assertSessionId(sessionId);
    return join(this.workingDirectory, '.koryphaios', 'sessions', sessionId);
  }

  private file(sessionId: string): string {
    return join(this.dir(sessionId), 'context-archive.jsonl');
  }

  private state(sessionId: string): SessionState {
    this.assertSessionId(sessionId);
    let s = this.sessions.get(sessionId);
    if (!s) {
      s = { entries: [], byId: new Map(), counter: 0, loaded: false };
      this.sessions.set(sessionId, s);
    }
    return s;
  }

  /** Lazily load a session's archive from disk (restart / reopened session). */
  private async ensureLoaded(sessionId: string): Promise<SessionState> {
    if (this.erasingSessions.has(sessionId)) {
      throw new Error('Context archive access refused because this session is being deleted');
    }
    const s = this.state(sessionId);
    if (s.loaded) return s;
    s.loaded = true;
    const path = this.file(sessionId);
    if (!existsSync(path)) return s;
    await this.healExistingPathModes(sessionId, true);
    const raw = await readFile(path, 'utf8');
    let requiresRewrite = Buffer.byteLength(raw, 'utf8') > ARCHIVE_DURABLE_MAX_BYTES;
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      try {
        const row = JSON.parse(line) as Record<string, unknown>;
        if (row.type === 'prune' || row.type === 'unprune') {
          const target = s.byId.get(row.id as string);
          if (target) target.prunedForAgent = row.type === 'prune';
          requiresRewrite = true;
          continue;
        }
        if (row.type === 'usage') {
          s.lastUsage = row.usage as UsageSnapshot;
          continue;
        }
        if (row.type === 'retention') {
          const retention = row.retention as ArchiveRetention | undefined;
          if (retention && typeof retention.droppedEntries === 'number') {
            s.retention = retention;
          } else {
            requiresRewrite = true;
          }
          continue;
        }
        const entry = this.normalizeEntry(sessionId, row);
        if (!entry) {
          requiresRewrite = true;
          continue;
        }
        if (
          row.sessionId !== sessionId ||
          row.content !== entry.content ||
          row.label !== entry.label ||
          typeof row.originalByteCount !== 'number' ||
          typeof row.contentSha256 !== 'string' ||
          typeof row.truncated !== 'boolean' ||
          typeof row.redacted !== 'boolean'
        ) {
          requiresRewrite = true;
        }
        s.entries.push(entry);
        s.byId.set(entry.id, entry);
        const n = Number(entry.id.replace(/^cx_/, ''));
        if (Number.isFinite(n) && n >= s.counter) s.counter = n + 1;
      } catch {
        // Never log parser text: malformed rows may contain the very secret
        // this migration is removing.
        serverLog.debug({ sessionId }, 'Skipping structurally invalid context archive row');
        requiresRewrite = true;
      }
    }
    if (s.entries.length > ARCHIVE_DURABLE_MAX_ENTRIES) requiresRewrite = true;
    if (requiresRewrite) await this.rewriteArchive(sessionId, s, s.entries, 0);
    return s;
  }

  private async append(sessionId: string, row: Record<string, unknown>): Promise<void> {
    if (this.erasingSessions.has(sessionId)) {
      throw new Error('Context archive write refused because this session is being deleted');
    }
    await this.ensurePrivatePaths(sessionId);
    const path = this.file(sessionId);
    const handle = await open(
      path,
      fsConstants.O_APPEND | fsConstants.O_CREAT | fsConstants.O_WRONLY | fsConstants.O_NOFOLLOW,
      0o600,
    );
    try {
      await handle.chmod(0o600);
      await handle.writeFile(`${JSON.stringify(row)}\n`, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
  }

  /** Record an event; returns its archive id (usable with fetch_context). */
  async record(
    sessionId: string,
    kind: ArchiveKind,
    label: string,
    content: string,
  ): Promise<string> {
    if (this.erasingSessions.has(sessionId)) {
      throw new Error('Context archive write refused because this session is being deleted');
    }
    const s = await this.ensureLoaded(sessionId);
    const id = `cx_${s.counter}`;
    const persisted = this.preview(content);
    const entry: ArchiveEntry = {
      id,
      sessionId,
      ts: Date.now(),
      kind,
      label: redactSecretsInText(label.replace(/[\r\n\t]+/g, ' '), 200),
      content: persisted.content,
      originalByteCount: persisted.originalByteCount,
      contentSha256: persisted.contentSha256,
      truncated: persisted.truncated,
      redacted: persisted.redacted,
    };
    await this.append(sessionId, entry as unknown as Record<string, unknown>);
    s.counter++;
    s.entries.push(entry);
    s.byId.set(id, entry);
    await this.compactIfNeeded(sessionId, s);
    return id;
  }

  async get(sessionId: string, id: string): Promise<ArchiveEntry | undefined> {
    const s = await this.ensureLoaded(sessionId);
    return s.byId.get(id);
  }

  /** Case-insensitive substring search across labels and content. */
  async search(sessionId: string, query: string, limit = 5): Promise<ArchiveEntry[]> {
    const s = await this.ensureLoaded(sessionId);
    const q = query.toLowerCase();
    const hits: ArchiveEntry[] = [];
    // Newest first — recent activity is almost always what's being recalled.
    for (let i = s.entries.length - 1; i >= 0 && hits.length < limit; i--) {
      const e = s.entries[i];
      if (e.label.toLowerCase().includes(q) || e.content.toLowerCase().includes(q)) hits.push(e);
    }
    return hits;
  }

  /** Most recent N entries, oldest→newest, for the activity index. In-memory — fast. */
  async listRecent(sessionId: string, limit = 30): Promise<ArchiveEntry[]> {
    const s = await this.ensureLoaded(sessionId);
    return s.entries.slice(-limit);
  }

  /** Persist the latest context-usage snapshot so a reloaded session's bar
   *  shows real data immediately instead of "awaiting usage data". */
  async recordUsage(sessionId: string, usage: UsageSnapshot): Promise<void> {
    if (this.erasingSessions.has(sessionId)) {
      throw new Error('Context archive write refused because this session is being deleted');
    }
    const s = await this.ensureLoaded(sessionId);
    await this.append(sessionId, { type: 'usage', usage });
    s.lastUsage = usage;
    await this.compactIfNeeded(sessionId, s);
  }

  async getLastUsage(sessionId: string): Promise<UsageSnapshot | undefined> {
    const s = await this.ensureLoaded(sessionId);
    return s.lastUsage;
  }

  async getRetention(sessionId: string): Promise<ArchiveRetention | undefined> {
    const s = await this.ensureLoaded(sessionId);
    return s.retention;
  }

  /** Remove operational context created after a conversation rewind point. */
  async truncateAfter(sessionId: string, timestamp: number): Promise<number> {
    const s = await this.ensureLoaded(sessionId);
    const kept = s.entries.filter((entry) => entry.ts <= timestamp);
    const removed = s.entries.length - kept.length;
    if (removed === 0) return 0;

    if (this.erasingSessions.has(sessionId)) {
      throw new Error('Context archive write refused because this session is being deleted');
    }
    await this.rewriteArchive(sessionId, s, kept, removed);
    return removed;
  }

  async setPrunedForAgent(sessionId: string, id: string, pruned: boolean): Promise<boolean> {
    const s = await this.ensureLoaded(sessionId);
    const entry = s.byId.get(id);
    if (!entry) return false;
    await this.append(sessionId, { type: pruned ? 'prune' : 'unprune', id, ts: Date.now() });
    entry.prunedForAgent = pruned;
    await this.compactIfNeeded(sessionId, s);
    return true;
  }

  async isPrunedForAgent(sessionId: string, id: string): Promise<boolean> {
    const s = await this.ensureLoaded(sessionId);
    return s.byId.get(id)?.prunedForAgent === true;
  }

  /** Prevent stale async work from recreating an archive while deletion runs. */
  beginSessionErasure(sessionId: string): void {
    if (this.erasingSessions.has(sessionId)) {
      throw new Error('Context archive erasure is already active for this session');
    }
    this.erasingSessions.add(sessionId);
  }

  cancelSessionErasure(sessionId: string): void {
    this.erasingSessions.delete(sessionId);
  }

  completeSessionErasure(sessionId: string): void {
    this.sessions.delete(sessionId);
    // Keep the tombstone for this process lifetime. Session IDs are unique;
    // accepting a late write would recreate sensitive state after deletion.
    this.erasingSessions.add(sessionId);
  }

  private async compactIfNeeded(sessionId: string, state: SessionState): Promise<void> {
    const path = this.file(sessionId);
    const size = existsSync(path) ? (await stat(path)).size : 0;
    if (size <= ARCHIVE_DURABLE_MAX_BYTES && state.entries.length <= ARCHIVE_DURABLE_MAX_ENTRIES) {
      return;
    }
    await this.rewriteArchive(sessionId, state, state.entries, 0);
  }

  private async rewriteArchive(
    sessionId: string,
    state: SessionState,
    candidates: readonly ArchiveEntry[],
    additionalDropped: number,
  ): Promise<void> {
    await this.ensurePrivatePaths(sessionId);
    const usageRow = state.lastUsage
      ? `${JSON.stringify({ type: 'usage', usage: state.lastUsage })}\n`
      : '';
    // Reserve enough room for retention metadata before selecting newest
    // entries. The final size check below handles digit growth deterministically.
    const metadataReserve = 1_024 + Buffer.byteLength(usageRow, 'utf8');
    let selectedBytes = 0;
    const retainedNewestFirst: ArchiveEntry[] = [];
    for (let index = candidates.length - 1; index >= 0; index--) {
      if (retainedNewestFirst.length >= ARCHIVE_DURABLE_MAX_ENTRIES) break;
      const rowBytes = Buffer.byteLength(`${JSON.stringify(candidates[index])}\n`, 'utf8');
      if (selectedBytes + rowBytes + metadataReserve > ARCHIVE_DURABLE_MAX_BYTES) break;
      retainedNewestFirst.push(candidates[index]!);
      selectedBytes += rowBytes;
    }
    const retained = retainedNewestFirst.reverse();
    const priorDropped = state.retention?.droppedEntries ?? 0;
    let retention: ArchiveRetention = {
      droppedEntries: priorDropped + additionalDropped + (candidates.length - retained.length),
      retainedEntries: retained.length,
      maxEntries: ARCHIVE_DURABLE_MAX_ENTRIES,
      maxBytes: ARCHIVE_DURABLE_MAX_BYTES,
      compactedAt: Date.now(),
    };
    const render = () => {
      const rows = [
        JSON.stringify({ type: 'retention', retention }),
        ...retained.map((entry) => JSON.stringify(entry)),
      ];
      if (state.lastUsage) rows.push(JSON.stringify({ type: 'usage', usage: state.lastUsage }));
      return `${rows.join('\n')}\n`;
    };
    let output = render();
    while (Buffer.byteLength(output, 'utf8') > ARCHIVE_DURABLE_MAX_BYTES && retained.length > 0) {
      retained.shift();
      retention = {
        ...retention,
        droppedEntries: retention.droppedEntries + 1,
        retainedEntries: retained.length,
      };
      output = render();
    }

    const target = this.file(sessionId);
    const temporary = `${target}.${crypto.randomUUID()}.tmp`;
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      handle = await open(
        temporary,
        fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY | fsConstants.O_NOFOLLOW,
        0o600,
      );
      await handle.writeFile(output, 'utf8');
      await handle.sync();
      await handle.close();
      handle = undefined;
      await rename(temporary, target);
      await chmod(target, 0o600);
    } finally {
      await handle?.close().catch(() => undefined);
      await rm(temporary, { force: true }).catch(() => undefined);
    }
    state.entries = retained;
    state.byId = new Map(retained.map((entry) => [entry.id, entry]));
    state.retention = retention;
  }

  private preview(
    content: string,
  ): Pick<
    ArchiveEntry,
    'content' | 'originalByteCount' | 'contentSha256' | 'truncated' | 'redacted'
  > {
    const originalByteCount = Buffer.byteLength(content, 'utf8');
    const contentSha256 = createHash('sha256').update(content, 'utf8').digest('hex');
    // redactSecretsInText applies every redaction before enforcing its length
    // bound. Giving it one character beyond the source avoids truncation here;
    // the byte-accurate preview bound is applied below.
    const redactedContent = redactSecretsInText(content, content.length + 1);
    const redacted = redactedContent !== content;
    const bytes = Buffer.from(redactedContent, 'utf8');
    if (bytes.byteLength <= ARCHIVE_PREVIEW_MAX_BYTES) {
      return {
        content: redactedContent,
        originalByteCount,
        contentSha256,
        truncated: false,
        redacted,
      };
    }
    const suffix = Buffer.from('…', 'utf8');
    let preview = bytes.subarray(0, ARCHIVE_PREVIEW_MAX_BYTES - suffix.byteLength).toString('utf8');
    if (preview.endsWith('\uFFFD')) preview = preview.slice(0, -1);
    return {
      content: `${preview}…`,
      originalByteCount,
      contentSha256,
      truncated: true,
      redacted,
    };
  }

  private normalizeEntry(
    sessionId: string,
    row: Record<string, unknown>,
  ): ArchiveEntry | undefined {
    if (typeof row.id !== 'string' || typeof row.content !== 'string') return undefined;
    const safe = this.preview(row.content);
    return {
      id: row.id,
      sessionId,
      ts: typeof row.ts === 'number' && Number.isFinite(row.ts) ? row.ts : 0,
      kind:
        row.kind === 'tool_call' ||
        row.kind === 'tool_result' ||
        row.kind === 'file_edit' ||
        row.kind === 'terminal'
          ? row.kind
          : 'tool_result',
      label:
        typeof row.label === 'string'
          ? redactSecretsInText(row.label.replace(/[\r\n\t]+/g, ' '), 200)
          : 'Archived activity',
      content: safe.content,
      originalByteCount:
        typeof row.originalByteCount === 'number' && Number.isSafeInteger(row.originalByteCount)
          ? row.originalByteCount
          : safe.originalByteCount,
      contentSha256:
        typeof row.contentSha256 === 'string' && /^[a-f0-9]{64}$/.test(row.contentSha256)
          ? row.contentSha256
          : safe.contentSha256,
      truncated: row.truncated === true || safe.truncated,
      redacted: row.redacted === true || safe.redacted,
      prunedForAgent: row.prunedForAgent === true,
    };
  }

  private async ensurePrivateDirectory(path: string): Promise<void> {
    await mkdir(path, { recursive: true, mode: 0o700 });
    const stat = await lstat(path);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new Error(`Context archive refused unsafe directory: ${path}`);
    }
    await chmod(path, 0o700);
  }

  private async ensurePrivatePaths(sessionId: string): Promise<void> {
    this.assertSessionId(sessionId);
    const koryRoot = join(this.workingDirectory, '.koryphaios');
    const sessionsRoot = join(koryRoot, 'sessions');
    await this.ensurePrivateDirectory(koryRoot);
    await this.ensurePrivateDirectory(sessionsRoot);
    await this.ensurePrivateDirectory(this.dir(sessionId));
    await this.healExistingPathModes(sessionId, false);
  }

  private async healExistingPathModes(sessionId: string, requireFile: boolean): Promise<void> {
    const paths = [
      join(this.workingDirectory, '.koryphaios'),
      join(this.workingDirectory, '.koryphaios', 'sessions'),
      this.dir(sessionId),
    ];
    for (const path of paths) {
      if (!existsSync(path)) {
        if (requireFile) throw new Error(`Context archive parent directory is missing: ${path}`);
        continue;
      }
      const stat = await lstat(path);
      if (!stat.isDirectory() || stat.isSymbolicLink()) {
        throw new Error(`Context archive refused unsafe directory: ${path}`);
      }
      await chmod(path, 0o700);
    }
    const file = this.file(sessionId);
    if (!existsSync(file)) {
      if (requireFile) throw new Error(`Context archive file is missing: ${file}`);
      return;
    }
    const stat = await lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new Error(`Context archive refused unsafe file: ${file}`);
    }
    await chmod(file, 0o600);
  }
}

// Module-level singleton so tools (constructed without DI) can reach the
// archive. Initialized once by the manager at startup.
let instance: ContextArchiveService | null = null;

export function initContextArchive(workingDirectory: string): ContextArchiveService {
  instance = new ContextArchiveService(workingDirectory);
  return instance;
}

export function getContextArchive(): ContextArchiveService | null {
  return instance;
}
