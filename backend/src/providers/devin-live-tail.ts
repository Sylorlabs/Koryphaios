// Live transcript tail for Devin `-p` runs.
//
// The CLI persists every step to <devinHome>/.local/share/devin/cli/sessions.db
// while it runs: `message_nodes` (assistant text/thinking/tool-call intents)
// and `tool_call_state` (call insert + update rows carrying the result).
// Polling it surfaces reasoning, text, and tool activity DURING the turn —
// without it the provider could only emit the ATIF export after process exit,
// so a multi-minute turn showed a dead transcript the whole time.
//
// The ATIF export stays authoritative: everything the tail emits is
// deduplicated against it at the end (tool ids differ between the DB and ATIF,
// so identity is tool name + canonical input). Every failure is fail-open —
// the tail is an enhancement, never a turn dependency.

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { providerLog } from '../logger';
import type { ProviderEvent } from './types';

interface DevinChatMessage {
  role?: string;
  content?: string | Array<{ type?: string; text?: string }>;
  thinking?: { thinking?: string } | string;
}

interface DevinToolCallJson {
  toolCallId?: string;
  title?: string;
  rawInput?: unknown;
  _meta?: Record<string, unknown>;
}

interface DevinToolCallUpdateJson {
  toolCallId?: string;
  status?: string;
  content?: Array<{ type?: string; content?: { type?: string; text?: string } }>;
  _meta?: Record<string, unknown>;
}

type SqliteDatabase = import('bun:sqlite').Database;

/** Canonical JSON for cross-source dedup (key order differs between the CLI's
 *  serialization and ours). */
function stableJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  const obj = value as Record<string, unknown>;
  return `{${Object.keys(obj)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${stableJson(obj[k])}`)
    .join(',')}}`;
}

function toolEventKey(name: string | undefined, inputJson: string | undefined): string {
  let input: unknown = null;
  try {
    input = inputJson ? JSON.parse(inputJson) : null;
  } catch {
    input = inputJson ?? null;
  }
  return `${name ?? ''}|${stableJson(input)}`;
}

function textContent(content: DevinChatMessage['content']): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .filter((b) => b?.type === 'text' && typeof b.text === 'string')
      .map((b) => b.text as string)
      .join('\n');
  }
  return '';
}

function thinkingText(thinking: DevinChatMessage['thinking']): string {
  if (typeof thinking === 'string') return thinking;
  return thinking?.thinking ?? '';
}

function toolName(call: DevinToolCallJson): string {
  const meta = call._meta?.['cognition.ai/inferenceToolName'];
  return (typeof meta === 'string' && meta) || call.title || 'unknown';
}

function updateOutput(update: DevinToolCallUpdateJson): {
  output: string;
  isError: boolean;
  done: boolean;
} {
  const done = update.status === 'completed' || update.status === 'failed';
  const rejected = update._meta?.['cognition.ai/rejected'] === true;
  const isError = update.status === 'failed' || rejected;
  const output = (update.content ?? [])
    .map((c) => c?.content?.text)
    .filter((t): t is string => typeof t === 'string')
    .join('\n');
  return { output, isError, done };
}

export class DevinLiveTail {
  private db: SqliteDatabase | null = null;
  private dbTried = false;
  private lastNodeRow = 0;
  private lastToolRow = 0;
  private readonly pendingTools = new Map<string, { name: string; input: string }>();
  private readonly emittedToolKeys = new Set<string>();
  private readonly emittedThinking = new Set<string>();
  private readonly emittedContent = new Set<string>();
  emittedAnyContent = false;

  constructor(private readonly devinHome: string) {}

  private get dbPath(): string {
    return join(this.devinHome, '.local', 'share', 'devin', 'cli', 'sessions.db');
  }

  /** Call right before spawning the CLI so rows from earlier turns in the same
   *  per-session home are skipped. */
  snapshot(): void {
    const db = this.open();
    if (!db) return;
    try {
      this.lastNodeRow =
        (
          db.query('SELECT MAX(row_id) AS m FROM message_nodes').get() as {
            m: number | null;
          } | null
        )?.m ?? 0;
      this.lastToolRow =
        (
          db.query('SELECT MAX(rowid) AS m FROM tool_call_state').get() as {
            m: number | null;
          } | null
        )?.m ?? 0;
    } catch (err) {
      providerLog.debug({ err: String(err) }, 'Devin live tail snapshot failed — tail disabled');
      this.close();
    }
  }

  private open(): SqliteDatabase | null {
    if (this.db) return this.db;
    // The CLI creates sessions.db on its first write, which may be after our
    // first drain — only a real open failure permanently disables the tail.
    if (!existsSync(this.dbPath)) return null;
    if (this.dbTried) return null;
    this.dbTried = true;
    try {
      const { Database } = require('bun:sqlite') as typeof import('bun:sqlite');
      this.db = new Database(this.dbPath, { readonly: true });
      return this.db;
    } catch (err) {
      providerLog.debug({ err: String(err) }, 'Devin live tail could not open sessions.db');
      return null;
    }
  }

  private close(): void {
    try {
      this.db?.close();
    } catch {
      /* best effort */
    }
    this.db = null;
    this.dbTried = false;
  }

  /** Poll for rows appended since the last drain; yields them as events. */
  drain(): ProviderEvent[] {
    const db = this.open();
    if (!db) return [];
    const events: ProviderEvent[] = [];
    try {
      const nodes = db
        .query('SELECT row_id, chat_message FROM message_nodes WHERE row_id > ? ORDER BY row_id')
        .all(this.lastNodeRow) as Array<{ row_id: number; chat_message: string }>;
      for (const node of nodes) {
        this.lastNodeRow = Math.max(this.lastNodeRow, node.row_id);
        let msg: DevinChatMessage;
        try {
          msg = JSON.parse(node.chat_message) as DevinChatMessage;
        } catch {
          continue;
        }
        if (msg.role !== 'assistant') continue;
        const thinking = thinkingText(msg.thinking).trim();
        if (thinking && !this.emittedThinking.has(thinking)) {
          this.emittedThinking.add(thinking);
          events.push({ type: 'thinking_delta', thinking });
        }
        const content = textContent(msg.content).trim();
        if (content && !this.emittedContent.has(content)) {
          this.emittedContent.add(content);
          this.emittedAnyContent = true;
          events.push({ type: 'content_delta', content });
        }
      }
    } catch (err) {
      providerLog.debug({ err: String(err) }, 'Devin live tail message poll failed');
    }
    try {
      const calls = db
        .query(
          'SELECT rowid, tool_call_id, tool_call_json, tool_call_update_json FROM tool_call_state WHERE rowid > ? ORDER BY rowid',
        )
        .all(this.lastToolRow) as Array<{
        rowid: number;
        tool_call_id: string;
        tool_call_json: string | null;
        tool_call_update_json: string | null;
      }>;
      for (const row of calls) {
        this.lastToolRow = Math.max(this.lastToolRow, row.rowid);
        this.handleToolRow(row.tool_call_id, row.tool_call_json, row.tool_call_update_json, events);
      }
      if (this.pendingTools.size > 0) {
        const ids = [...this.pendingTools.keys()].slice(0, 200);
        const placeholders = ids.map(() => '?').join(',');
        const updates = db
          .query(
            `SELECT tool_call_id, tool_call_update_json FROM tool_call_state WHERE tool_call_id IN (${placeholders}) AND tool_call_update_json IS NOT NULL`,
          )
          .all(...ids) as Array<{ tool_call_id: string; tool_call_update_json: string }>;
        for (const row of updates) {
          this.handleToolRow(row.tool_call_id, null, row.tool_call_update_json, events);
        }
      }
    } catch (err) {
      providerLog.debug({ err: String(err) }, 'Devin live tail tool poll failed');
    }
    return events;
  }

  /** Final drain after process exit — flush any still-pending tool calls so
   *  they are never dropped, then release the handle. */
  drainFinal(): ProviderEvent[] {
    const events = this.drain();
    for (const [id, tool] of this.pendingTools) {
      events.push({
        type: 'tool_executed',
        toolCallId: id,
        toolName: tool.name,
        toolInput: tool.input,
      });
      this.emittedToolKeys.add(toolEventKey(tool.name, tool.input));
      this.pendingTools.delete(id);
    }
    this.close();
    return events;
  }

  private handleToolRow(
    toolCallId: string,
    callJson: string | null,
    updateJson: string | null,
    events: ProviderEvent[],
  ): void {
    let call: DevinToolCallJson = {};
    if (callJson) {
      try {
        call = JSON.parse(callJson) as DevinToolCallJson;
      } catch {
        /* keep defaults */
      }
    }
    const known = this.pendingTools.get(toolCallId);
    const name = toolName(call);
    const input = callJson ? JSON.stringify(call.rawInput ?? {}) : (known?.input ?? '{}');
    if (callJson) {
      this.pendingTools.set(toolCallId, { name, input });
    }
    if (!updateJson) return;
    let update: DevinToolCallUpdateJson = {};
    try {
      update = JSON.parse(updateJson) as DevinToolCallUpdateJson;
    } catch {
      return;
    }
    const { output, isError, done } = updateOutput(update);
    if (!done) return;
    const entry = known ?? { name, input };
    events.push({
      type: 'tool_executed',
      toolCallId,
      toolName: entry.name,
      toolInput: entry.input,
      toolOutput: output.slice(0, 8_000),
      isError,
    });
    this.emittedToolKeys.add(toolEventKey(entry.name, entry.input));
    this.pendingTools.delete(toolCallId);
  }

  /** Remove ATIF-export events the live tail already emitted so the final
   *  replay does not duplicate them. Thinking/content dedupe by exact text.
   *  Tool calls cannot be matched field-wise — the DB stores the raw call
   *  input while ATIF carries the normalized/wrapped form — but the DB's
   *  tool_call_state is the CLI's complete record of every call, so once the
   *  tail has emitted any tool events the export's are dropped wholesale. */
  dedupeExportEvents(exportEvents: ProviderEvent[]): ProviderEvent[] {
    const dropAllToolEvents = this.emittedToolKeys.size > 0;
    return exportEvents.filter((event) => {
      if (event.type === 'thinking_delta') return !this.emittedThinking.has(event.thinking ?? '');
      if (event.type === 'content_delta') return !this.emittedContent.has(event.content ?? '');
      if (event.type === 'tool_executed') return !dropAllToolEvents;
      return true;
    });
  }
}
