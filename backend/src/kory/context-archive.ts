// Context archive — the local, append-only record of everything an agent did
// in a session (tool calls, outputs, file edits). It exists so context-window
// space can be reclaimed without losing anything: old tool outputs are stubbed
// out of the LLM context ("pruned") and can always be recovered exactly via
// the fetch_context tool, or re-hidden/re-shown by the user.
//
// Storage: `.koryphaios/sessions/<id>/context-archive.jsonl` — one JSON row per
// event, plus `prune`/`unprune` marker rows so visibility survives restarts.

import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { koryLog } from '../logger';

export type ArchiveKind = 'tool_call' | 'tool_result' | 'file_edit' | 'terminal';

export interface ArchiveEntry {
  id: string;
  sessionId: string;
  ts: number;
  kind: ArchiveKind;
  /** Short human/model-readable label, e.g. `read_file src/foo.ts`. */
  label: string;
  content: string;
  /** Hidden from the agent's context (stubbed). Content stays recoverable. */
  prunedForAgent?: boolean;
}

export interface UsageSnapshot {
  used: number;
  max: number;
  contextKnown: boolean;
  breakdown?: { system: number; memory: number; tools: number; chat: number };
  ts: number;
}

interface SessionState {
  entries: ArchiveEntry[];
  byId: Map<string, ArchiveEntry>;
  counter: number;
  loaded: boolean;
  lastUsage?: UsageSnapshot;
}

const MAX_CONTENT_CHARS = 200_000; // per entry cap so a runaway output can't bloat the file

export class ContextArchiveService {
  private sessions = new Map<string, SessionState>();

  constructor(private workingDirectory: string) {}

  private dir(sessionId: string): string {
    return join(this.workingDirectory, '.koryphaios', 'sessions', sessionId);
  }

  private file(sessionId: string): string {
    return join(this.dir(sessionId), 'context-archive.jsonl');
  }

  private state(sessionId: string): SessionState {
    let s = this.sessions.get(sessionId);
    if (!s) {
      s = { entries: [], byId: new Map(), counter: 0, loaded: false };
      this.sessions.set(sessionId, s);
    }
    return s;
  }

  /** Lazily load a session's archive from disk (restart / reopened session). */
  private async ensureLoaded(sessionId: string): Promise<SessionState> {
    const s = this.state(sessionId);
    if (s.loaded) return s;
    s.loaded = true;
    const path = this.file(sessionId);
    if (!existsSync(path)) return s;
    try {
      const raw = await readFile(path, 'utf8');
      for (const line of raw.split('\n')) {
        if (!line.trim()) continue;
        try {
          const row = JSON.parse(line) as Record<string, unknown>;
          if (row.type === 'prune' || row.type === 'unprune') {
            const target = s.byId.get(row.id as string);
            if (target) target.prunedForAgent = row.type === 'prune';
            continue;
          }
          if (row.type === 'usage') {
            s.lastUsage = row.usage as UsageSnapshot;
            continue;
          }
          const entry = row as unknown as ArchiveEntry;
          if (!entry.id) continue;
          s.entries.push(entry);
          s.byId.set(entry.id, entry);
          const n = Number(entry.id.replace(/^cx_/, ''));
          if (Number.isFinite(n) && n >= s.counter) s.counter = n + 1;
        } catch {
          /* skip corrupt line */
        }
      }
    } catch (err) {
      koryLog.warn({ err, sessionId }, 'Context archive load failed');
    }
    return s;
  }

  private async append(sessionId: string, row: Record<string, unknown>): Promise<void> {
    try {
      await mkdir(this.dir(sessionId), { recursive: true });
      await appendFile(this.file(sessionId), `${JSON.stringify(row)}\n`, 'utf8');
    } catch (err) {
      koryLog.warn({ err, sessionId }, 'Context archive append failed');
    }
  }

  /** Record an event; returns its archive id (usable with fetch_context). */
  async record(
    sessionId: string,
    kind: ArchiveKind,
    label: string,
    content: string,
  ): Promise<string> {
    const s = await this.ensureLoaded(sessionId);
    const id = `cx_${s.counter++}`;
    const entry: ArchiveEntry = {
      id,
      sessionId,
      ts: Date.now(),
      kind,
      label: label.slice(0, 200),
      content: content.slice(0, MAX_CONTENT_CHARS),
    };
    s.entries.push(entry);
    s.byId.set(id, entry);
    await this.append(sessionId, entry as unknown as Record<string, unknown>);
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
    const s = await this.ensureLoaded(sessionId);
    s.lastUsage = usage;
    await this.append(sessionId, { type: 'usage', usage });
  }

  async getLastUsage(sessionId: string): Promise<UsageSnapshot | undefined> {
    const s = await this.ensureLoaded(sessionId);
    return s.lastUsage;
  }

  async setPrunedForAgent(sessionId: string, id: string, pruned: boolean): Promise<boolean> {
    const s = await this.ensureLoaded(sessionId);
    const entry = s.byId.get(id);
    if (!entry) return false;
    entry.prunedForAgent = pruned;
    await this.append(sessionId, { type: pruned ? 'prune' : 'unprune', id, ts: Date.now() });
    return true;
  }

  async isPrunedForAgent(sessionId: string, id: string): Promise<boolean> {
    const s = await this.ensureLoaded(sessionId);
    return s.byId.get(id)?.prunedForAgent === true;
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
