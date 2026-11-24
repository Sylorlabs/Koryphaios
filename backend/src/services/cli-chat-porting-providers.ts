// Full-fidelity transcript parsers for the CLI chat importer's "desktop" and
// long-tail providers: Antigravity, CodeBuddy / WorkBuddy desktop, Omnirush
// (pi agent sessions), Cursor CLI, Grok Build, Kimi Code and generic JSON
// session files.
//
// Every parser returns `PortedMessage` rows: the same shape as the importer's
// `ImportedCliMessage` (role, text content, createdAt, optional structured turn
// `events` and `timeUnknown`). Ordering inside an assistant turn is still
// decided by the shared reducer (`reduceTurnEvents` here for nested sub-agent
// transcripts, `buildImportTurns` in the importer for top-level turns).
//
// Honest time: a row's `createdAt` is a time the source recorded; when the
// source recorded none the row is `timeUnknown` and `createdAt` only orders it.
// A reasoning or tool duration is emitted only when the source recorded that
// block's own start and end (or a duration); otherwise it is `timeUnknown`.
//
// Sub-agents: a sub-agent's conversation is attached as `subagent` on the
// `tool_result` of the call that spawned it, or on a synthetic `subagent` call
// when the source does not identify one. It never becomes top-level rows.
//
// The importer's shared helpers are injected (`PortingHelpers`) so this module
// stays independent of the importer's internals.

import type { Database } from 'bun:sqlite';
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import {
  reduceTurnEvents,
  type MessageAttachment,
  type SubagentTranscript,
  type SubagentTurn,
  type TurnEvent,
} from '@koryphaios/shared';

// ─── Contract types ─────────────────────────────────────────────────────────

/** Structurally identical to the importer's `ImportedCliMessage`. */
export interface PortedMessage {
  role: 'user' | 'assistant';
  content: string;
  createdAt: number;
  model?: string;
  events?: TurnEvent[];
  timeUnknown?: true;
  attachments?: MessageAttachment[];
}

/** The importer's own helpers, used as they are. */
export interface PortingHelpers {
  cleanMessageText(raw: string): string;
  isNoiseUserPrompt(text: string): boolean;
  toolOutputText(value: unknown): string;
  toolInputRecord(value: unknown): Record<string, unknown>;
  sourceTimestampMs(value: unknown): number | undefined;
  readTranscriptText(filePath: string, forImport: boolean): string;
  openReadonlySqlite(dbPath: string): Database | null;
}

/** A discovered chat in provider-neutral form; the importer adapts it. */
export interface PortedChat {
  externalId: string;
  cwd: string | null;
  title: string | null;
  model?: string;
  createdAt: number;
  updatedAt: number;
  /** Text rows used for discovery samples and preview. */
  sample: PortedMessage[];
  load: () => PortedMessage[];
}

type ToolResultEvent = Extract<TurnEvent, { type: 'tool_result' }>;
type ToolCallEvent = Extract<TurnEvent, { type: 'tool_call' }>;

const MAX_SUBAGENT_DEPTH = 4;
const MAX_ROWS = 200_000;

// ─── Small utilities ────────────────────────────────────────────────────────

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function rec(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function num(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function parseJsonLines(raw: string): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{')) continue;
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      const obj = rec(parsed);
      if (obj) out.push(obj);
    } catch {
      continue;
    }
    if (out.length >= MAX_ROWS) break;
  }
  return out;
}

function readJsonFile(filePath: string): unknown {
  try {
    return JSON.parse(readFileSync(filePath, 'utf8')) as unknown;
  } catch {
    return undefined;
  }
}

function safeReaddir(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function mtimeMs(path: string): number | undefined {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return undefined;
  }
}

/**
 * The user's own words inside harness wrappers: `<user_query>` (CodeBuddy,
 * WorkBuddy, Cursor, Grok), with Cursor's `<timestamp>` stamp removed.
 */
export function extractUserQuery(raw: string): string {
  const match = raw.match(/<user_query>\s*([\s\S]*?)\s*<\/user_query>/);
  const text = match?.[1] !== undefined ? match[1] : raw;
  return text.replace(/<timestamp>[\s\S]*?<\/timestamp>/g, '').trim();
}

/** A harness context preamble (`<user_info>`, `<rules>` …) rather than a prompt. */
function isContextPreamble(text: string): boolean {
  return /^<(user_info|rules|project_layout|environment_context|agent_skills|git_status|open_and_recently_viewed_files)\b/.test(
    text.trim(),
  );
}

function textOf(events: readonly TurnEvent[]): string {
  return events
    .filter((event): event is Extract<TurnEvent, { type: 'text' }> => event.type === 'text')
    .map((event) => event.text.trim())
    .filter(Boolean)
    .join('\n\n');
}

function userRow(
  text: string,
  ts: number | undefined,
  extra: Partial<PortedMessage> = {},
): PortedMessage {
  const row: PortedMessage = { role: 'user', content: text, createdAt: ts ?? 0, ...extra };
  if (ts === undefined) row.timeUnknown = true;
  return row;
}

function assistantRow(events: TurnEvent[], ts: number | undefined, model?: string): PortedMessage {
  const row: PortedMessage = {
    role: 'assistant',
    content: textOf(events),
    createdAt: ts ?? 0,
    events,
  };
  if (model) row.model = model;
  if (ts === undefined) row.timeUnknown = true;
  return row;
}

function toolResult(input: {
  callId: string;
  name: string;
  output: string;
  isError?: boolean;
  timestamp: number;
  durationMs?: number;
  subagent?: SubagentTranscript;
}): ToolResultEvent {
  const event: ToolResultEvent = {
    type: 'tool_result',
    callId: input.callId,
    name: input.name,
    output: input.output,
    isError: input.isError === true,
    timestamp: input.timestamp,
  };
  if (
    input.durationMs !== undefined &&
    Number.isFinite(input.durationMs) &&
    input.durationMs >= 0
  ) {
    event.durationMs = Math.round(input.durationMs);
  } else {
    event.timeUnknown = true;
  }
  if (input.subagent) event.subagent = input.subagent;
  return event;
}

function knownDuration(start: number | undefined, end: number | undefined): number | undefined {
  if (start === undefined || end === undefined) return undefined;
  return end >= start ? end - start : undefined;
}

/** A source-shown system notice (API error, malformed call): display-only, never assistant text. */
function noticeEvents(
  key: string,
  kind: string,
  text: string,
  ts: number,
  isError = true,
): TurnEvent[] {
  const callId = `notice:${key}`;
  return [
    { type: 'tool_call', callId, name: 'notice', input: { kind }, timestamp: ts },
    toolResult({ callId, name: 'notice', output: text, isError, timestamp: ts }),
  ];
}

function reasoningEvent(text: string, ts: number, thinkingTokens?: number): TurnEvent {
  const event: Extract<TurnEvent, { type: 'reasoning' }> = {
    type: 'reasoning',
    text,
    timestamp: ts,
    timeUnknown: true,
  };
  if (thinkingTokens !== undefined && thinkingTokens > 0) event.thinkingTokens = thinkingTokens;
  return event;
}

/**
 * Give `timeUnknown` rows an ordering-only time between their known neighbours
 * (or after the chat start), and stamp every event of an unknown row with it.
 * Known rows keep their source time. Never uses the import time.
 */
export function assignOrderingTimes(
  rows: PortedMessage[],
  chatStartMs?: number,
  chatEndMs?: number,
): PortedMessage[] {
  let i = 0;
  while (i < rows.length) {
    if (!rows[i].timeUnknown) {
      i += 1;
      continue;
    }
    let j = i;
    while (j < rows.length && rows[j].timeUnknown) j += 1;
    const count = j - i;
    const before = i > 0 ? rows[i - 1].createdAt : chatStartMs;
    const after = j < rows.length ? rows[j].createdAt : chatEndMs;
    let start: number;
    let step: number;
    if (before !== undefined && after !== undefined && after > before) {
      step = (after - before) / (count + 1);
      start = before + step;
    } else if (before !== undefined) {
      start = before + 1;
      step = 1;
    } else if (after !== undefined) {
      start = after - count;
      step = 1;
    } else {
      start = 1;
      step = 1;
    }
    for (let k = i; k < j; k++) {
      const t = Math.round(start + (k - i) * step);
      rows[k].createdAt = t;
    }
    i = j;
  }
  // Events of a row carry no time of their own unless the parser set one.
  for (const row of rows) {
    for (const event of row.events ?? []) {
      if (row.timeUnknown || !(event.timestamp > 0)) event.timestamp = row.createdAt;
    }
  }
  return rows;
}

/** Insert a row at its chronological position (after the last row not later than it). */
function insertChronologically(rows: PortedMessage[], row: PortedMessage): void {
  let index = rows.length;
  while (index > 0 && rows[index - 1].createdAt > row.createdAt) index -= 1;
  rows.splice(index, 0, row);
}

/**
 * Fold a sub-agent's rows into a nested transcript. Consecutive assistant rows
 * are one turn, folded through the shared reducer; a turn whose time the source
 * never recorded carries no `createdAt`.
 */
export function subagentFromRows(
  meta: { agentId?: string; name: string; task?: string; model?: string; provider?: string },
  rows: readonly PortedMessage[],
): SubagentTranscript {
  const turns: SubagentTurn[] = [];
  let pendingEvents: TurnEvent[] = [];
  let pendingCreatedAt: number | undefined;
  let pendingLastAt = 0;
  let pendingOpen = false;

  const flush = () => {
    if (!pendingOpen) return;
    const parts = reduceTurnEvents([
      ...pendingEvents,
      { type: 'complete', timestamp: pendingLastAt },
    ]);
    if (parts.length > 0) {
      turns.push(
        pendingCreatedAt === undefined
          ? { role: 'assistant', parts }
          : { role: 'assistant', parts, createdAt: pendingCreatedAt },
      );
    }
    pendingEvents = [];
    pendingOpen = false;
  };

  // Several providers store the spawn prompt twice: as the sub-agent's task
  // field and again as its first user turn. The header already shows the task,
  // so a first user row that restates it verbatim would render it twice.
  let taskConsumed = false;
  for (const row of rows) {
    if (row.role === 'user') {
      flush();
      if (!row.content.trim()) continue;
      if (!taskConsumed && meta.task !== undefined && row.content.trim() === meta.task.trim()) {
        taskConsumed = true;
        continue;
      }
      turns.push(
        row.timeUnknown
          ? { role: 'user', text: row.content }
          : { role: 'user', text: row.content, createdAt: row.createdAt },
      );
      continue;
    }
    const events: TurnEvent[] =
      row.events ??
      (row.content.trim() ? [{ type: 'text', text: row.content, timestamp: row.createdAt }] : []);
    if (events.length === 0) continue;
    if (!pendingOpen) {
      pendingOpen = true;
      pendingCreatedAt = row.timeUnknown ? undefined : row.createdAt;
      pendingLastAt = row.createdAt;
    }
    let first = true;
    for (const event of events) {
      let next = event;
      if (event.type === 'text') {
        if (!event.text.trim()) continue;
        const last = pendingEvents[pendingEvents.length - 1];
        if (first && last && last.type === 'text' && !/\s$/.test(last.text)) {
          next = { ...event, text: `\n\n${event.text}` };
        }
      }
      first = false;
      pendingEvents.push(next);
      if (event.timestamp > pendingLastAt) pendingLastAt = event.timestamp;
    }
  }
  flush();

  const sub: SubagentTranscript = { name: meta.name, turns };
  if (meta.agentId) sub.agentId = meta.agentId;
  if (meta.task) sub.task = meta.task;
  if (meta.model) sub.model = meta.model;
  if (meta.provider) sub.provider = meta.provider;
  return sub;
}

/** The last assistant text of a sub-agent: what it handed back. */
function finalAnswerOf(rows: readonly PortedMessage[]): string {
  for (let i = rows.length - 1; i >= 0; i--) {
    if (rows[i].role === 'assistant' && rows[i].content.trim()) return rows[i].content;
  }
  return '';
}

function firstKnownTime(rows: readonly PortedMessage[]): number | undefined {
  return rows.find((row) => !row.timeUnknown)?.createdAt;
}

function lastKnownTime(rows: readonly PortedMessage[]): number | undefined {
  for (let i = rows.length - 1; i >= 0; i--) if (!rows[i].timeUnknown) return rows[i].createdAt;
  return undefined;
}

/**
 * A synthetic call/result pair for a sub-agent whose spawning call the source
 * does not identify. Its duration is known only from the sub-agent's own
 * recorded first and last times.
 */
function synthesizedSubagentRow(
  key: string,
  sub: SubagentTranscript,
  childRows: readonly PortedMessage[],
): PortedMessage {
  const start = firstKnownTime(childRows);
  const end = lastKnownTime(childRows);
  const callId = `subagent:${key}`;
  const ts = start ?? 0;
  const events: TurnEvent[] = [
    { type: 'tool_call', callId, name: 'subagent', input: { task: sub.task ?? '' }, timestamp: ts },
    toolResult({
      callId,
      name: 'subagent',
      output: finalAnswerOf(childRows),
      timestamp: end ?? ts,
      durationMs: knownDuration(start, end),
      subagent: sub,
    }),
  ];
  const row = assistantRow(events, start);
  row.content = '';
  return row;
}

// ─── 1. Antigravity (brain/<conversation>/.system_generated/logs) ───────────

export interface AntigravityRelations {
  /** parent conversation id → its sub-agent conversations. */
  children: Map<string, Array<{ id: string; name?: string }>>;
  /** Every conversation that is some conversation's sub-agent. */
  childIds: Set<string>;
}

function tableColumns(sqlite: Database, table: string): Set<string> {
  try {
    const rows = sqlite.query(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
    return new Set(rows.map((row) => row.name));
  } catch {
    return new Set();
  }
}

/**
 * Parent/child links between Antigravity conversations. Swarm workers are
 * separate conversations whose `parent_conversation_id` (or the
 * `conversation_parents` table) names the coordinator. Older stores have
 * neither; then there are no known children.
 */
export function readAntigravityRelations(sqlite: Database): AntigravityRelations {
  const children = new Map<string, Array<{ id: string; name?: string }>>();
  const childIds = new Set<string>();
  const add = (parent: string, id: string, name?: string) => {
    if (!parent || !id || parent === id) return;
    childIds.add(id);
    const list = children.get(parent) ?? [];
    const existing = list.find((entry) => entry.id === id);
    if (existing) {
      if (!existing.name && name) existing.name = name;
    } else {
      list.push(name ? { id, name } : { id });
    }
    children.set(parent, list);
  };
  const columns = tableColumns(sqlite, 'conversation_summaries');
  if (columns.has('parent_conversation_id')) {
    try {
      const nameColumn = columns.has('agent_name') ? 'agent_name' : "''";
      const rows = sqlite
        .query(
          `SELECT conversation_id AS id, parent_conversation_id AS parent, ${nameColumn} AS name
           FROM conversation_summaries
           WHERE COALESCE(parent_conversation_id, '') <> ''`,
        )
        .all() as Array<{ id: string; parent: string; name: string | null }>;
      for (const row of rows) add(row.parent, row.id, row.name || undefined);
    } catch {
      // Tolerate a schema we do not know.
    }
  }
  if (tableColumns(sqlite, 'conversation_parents').has('parent_id')) {
    try {
      const rows = sqlite
        .query('SELECT conversation_id AS id, parent_id AS parent FROM conversation_parents')
        .all() as Array<{ id: string; parent: string }>;
      for (const row of rows) add(row.parent, row.id);
    } catch {
      // Ignore.
    }
  }
  return { children, childIds };
}

export function antigravityTranscriptPath(root: string, convId: string): string | null {
  const logs = join(root, 'brain', convId, '.system_generated', 'logs');
  for (const name of ['transcript_full.jsonl', 'transcript.jsonl']) {
    const candidate = join(logs, name);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/**
 * A GENERIC step's content opens with the tool run's own `Created At:` and
 * `Completed At:` lines (sometimes repeated). They are the tool's recorded
 * start and end; the rest is the output.
 */
function splitAntigravityToolHeader(
  content: string,
  h: PortingHelpers,
): { body: string; startedAt?: number; completedAt?: number } {
  const lines = content.split('\n');
  let startedAt: number | undefined;
  let completedAt: number | undefined;
  while (lines.length > 0) {
    const match = lines[0].match(/^(Created|Completed) At:\s*(.+?)\s*$/);
    if (!match) break;
    const ts = h.sourceTimestampMs(match[2]);
    if (match[1] === 'Created' && startedAt === undefined) startedAt = ts;
    if (match[1] === 'Completed' && completedAt === undefined) completedAt = ts;
    lines.shift();
  }
  return { body: lines.join('\n').trim(), startedAt, completedAt };
}

function parseAntigravitySystemMessage(
  content: string,
): { sender: string; timestamp?: string; text: string } | null {
  const match = content.match(
    /\[Message\]\s+timestamp=(\S+)\s+sender=(\S+)\s+(?:priority=\S+\s+)?content=([\s\S]*?)\s*(?:<\/SYSTEM_MESSAGE>\s*)?$/,
  );
  if (!match) return null;
  return { timestamp: match[1], sender: match[2], text: match[3].trim() };
}

function antigravityToolCalls(value: unknown): Array<{ name: string; args: unknown }> {
  let list = value;
  if (typeof list === 'string') {
    try {
      list = JSON.parse(list) as unknown;
    } catch {
      return [];
    }
  }
  if (!Array.isArray(list)) return [];
  return list
    .map((item) => rec(item))
    .filter((item): item is Record<string, unknown> => !!item)
    .map((item) => ({ name: str(item.name) ?? 'tool', args: item.args ?? item.arguments ?? {} }));
}

export interface AntigravityLoadOptions {
  relations?: AntigravityRelations;
  /** Load as the sub-agent of this conversation: its messages become user turns. */
  parentId?: string;
  depth?: number;
  visited?: Set<string>;
  chatStartMs?: number;
}

/**
 * Load one Antigravity conversation with its reasoning (`thinking`), tool calls
 * (`tool_calls`, results in the following GENERIC steps by step index),
 * errors, background-task completions and swarm sub-agents.
 */
export function loadAntigravityConversation(
  root: string,
  convId: string,
  h: PortingHelpers,
  opts: AntigravityLoadOptions = {},
): PortedMessage[] {
  const transcriptPath = antigravityTranscriptPath(root, convId);
  if (!transcriptPath) return [];
  let raw: string;
  try {
    raw = h.readTranscriptText(transcriptPath, true);
  } catch {
    return [];
  }
  const visited = opts.visited ?? new Set<string>();
  visited.add(convId);
  const depth = opts.depth ?? 0;

  const steps = parseJsonLines(raw)
    .map((step, index) => ({
      step,
      index,
      stepIndex: num(step.step_index) ?? Number.POSITIVE_INFINITY,
    }))
    .sort((a, b) => (a.stepIndex === b.stepIndex ? a.index - b.index : a.stepIndex - b.stepIndex))
    .map((entry) => entry.step);

  const rows: PortedMessage[] = [];
  const pendingByStep = new Map<number, { callId: string; name: string; args: unknown }>();
  const unresolved: Array<{ callId: string; name: string; args: unknown }> = [];
  const runningTasks = new Map<
    string,
    { event: ToolResultEvent; body: string; startedAt?: number }
  >();
  const spawned = new Map<
    string,
    { event: ToolResultEvent; name?: string; model?: string; task?: string }
  >();

  for (const step of steps) {
    const type = str(step.type) ?? '';
    const stepIndex = num(step.step_index) ?? -1;
    const ts = h.sourceTimestampMs(step.created_at);
    const at = ts ?? 0;
    const content = typeof step.content === 'string' ? step.content : '';

    if (type === 'USER_INPUT') {
      const text = h.cleanMessageText(content);
      if (text) rows.push(userRow(text, ts));
      continue;
    }

    if (type === 'PLANNER_RESPONSE') {
      const events: TurnEvent[] = [];
      const thinking = str(step.thinking);
      if (thinking) events.push(reasoningEvent(thinking.trim(), at));
      const text = h.cleanMessageText(content);
      if (text) events.push({ type: 'text', text, timestamp: at });
      antigravityToolCalls(step.tool_calls).forEach((call, k) => {
        const callId = `ag:${convId}:${stepIndex}:${k}`;
        events.push({
          type: 'tool_call',
          callId,
          name: call.name,
          input: h.toolInputRecord(call.args),
          timestamp: at,
        });
        const pending = { callId, name: call.name, args: call.args };
        if (stepIndex >= 0) pendingByStep.set(stepIndex + 1 + k, pending);
        unresolved.push(pending);
      });
      if (events.length > 0) rows.push(assistantRow(events, ts, str(step.model)));
      continue;
    }

    if (type === 'GENERIC') {
      let pending = pendingByStep.get(stepIndex);
      if (pending) pendingByStep.delete(stepIndex);
      else pending = unresolved[0];
      if (pending) {
        const at2 = unresolved.indexOf(pending);
        if (at2 >= 0) unresolved.splice(at2, 1);
      }
      const { body, startedAt, completedAt } = splitAntigravityToolHeader(content, h);
      const error = str(step.error);
      const status = str(step.status) ?? '';
      const isError =
        status === 'ERROR' ||
        status === 'INVALID' ||
        !!error ||
        /^Error invalid tool call/.test(body) ||
        /^Encountered error in step execution/.test(body);
      const callId = pending?.callId ?? `ag:${convId}:result:${stepIndex}`;
      const name = pending?.name ?? 'tool';
      const running = status === 'RUNNING';
      const event = toolResult({
        callId,
        name,
        output: h.toolOutputText(body || error || ''),
        isError,
        timestamp: completedAt ?? startedAt ?? at,
        durationMs: running ? undefined : knownDuration(startedAt, completedAt),
      });
      if (running) {
        const taskId = body.match(/task id:\s*(\S+)/)?.[1];
        if (taskId) runningTasks.set(taskId, { event, body, startedAt });
      }
      if (name === 'swarm') {
        const args = rec(pending?.args) ?? {};
        const parsed = rec(
          (() => {
            try {
              return JSON.parse(body) as unknown;
            } catch {
              return undefined;
            }
          })(),
        );
        const childId = str(parsed?.conversation_id);
        if (childId) {
          spawned.set(childId, {
            event,
            name: str(parsed?.name) ?? str(args.name),
            model: str(parsed?.model) ?? str(args.model),
            task: str(args.brief) ?? str(args.prompt) ?? str(args.task),
          });
        }
      }
      const row = assistantRow([event], ts);
      row.content = '';
      rows.push(row);
      continue;
    }

    if (type === 'SYSTEM_MESSAGE') {
      const message = parseAntigravitySystemMessage(content);
      if (!message) continue;
      const task = runningTasks.get(message.sender);
      if (task) {
        // A background task finished: its result belongs to the call that started it.
        const finishedAt = h.sourceTimestampMs(message.timestamp) ?? ts;
        task.event.output = h.toolOutputText(`${task.body}\n\n${message.text}`);
        if (finishedAt !== undefined) task.event.timestamp = finishedAt;
        const duration = knownDuration(task.startedAt, finishedAt);
        if (duration !== undefined) {
          task.event.durationMs = duration;
          delete task.event.timeUnknown;
        }
        if (/exited with code [1-9]/.test(message.text)) task.event.isError = true;
        runningTasks.delete(message.sender);
        continue;
      }
      if (
        opts.parentId &&
        message.sender === opts.parentId &&
        !/^\[swarm\] new board message/.test(message.text)
      ) {
        rows.push(userRow(message.text, h.sourceTimestampMs(message.timestamp) ?? ts));
      }
      continue;
    }

    if (type === 'ERROR_MESSAGE') {
      const text = str(step.error) ?? content;
      if (text.trim()) {
        const row = assistantRow(
          noticeEvents(`${convId}:${stepIndex}`, 'error', text.trim(), at),
          ts,
        );
        row.content = '';
        rows.push(row);
      }
      continue;
    }
    // CHECKPOINT (compaction summaries) is internal context, not conversation.
  }

  assignOrderingTimes(rows, opts.chatStartMs);

  // Swarm sub-agents: separate conversations nested under the call that added them.
  if (depth < MAX_SUBAGENT_DEPTH) {
    const known = new Map<string, string | undefined>();
    for (const [childId, info] of spawned) known.set(childId, info.name);
    for (const child of opts.relations?.children.get(convId) ?? []) {
      if (!known.has(child.id)) known.set(child.id, child.name);
      else if (!known.get(child.id) && child.name) known.set(child.id, child.name);
    }
    for (const [childId, childName] of known) {
      if (visited.has(childId)) continue;
      const childRows = loadAntigravityConversation(root, childId, h, {
        relations: opts.relations,
        parentId: convId,
        depth: depth + 1,
        visited,
      });
      if (childRows.length === 0) continue;
      const info = spawned.get(childId);
      const model = info?.model ?? childRows.find((row) => row.model)?.model;
      const sub = subagentFromRows(
        {
          agentId: childId,
          name: info?.name ?? childName ?? 'subagent',
          task: info?.task ?? childRows.find((row) => row.role === 'user')?.content,
          model,
          provider: 'antigravity',
        },
        childRows,
      );
      if (info) info.event.subagent = sub;
      else insertChronologically(rows, synthesizedSubagentRow(childId, sub, childRows));
    }
  }
  return rows;
}

// ─── 2. CodeBuddy CLI / WorkBuddy desktop (projects/<slug>/<session>.jsonl) ─

/** Top-level transcripts under `<root>/projects/<slug>/`, keyed by file stem. */
export function listProjectTranscriptFiles(root: string): Map<string, string> {
  const files = new Map<string, string>();
  const projectsDir = join(root, 'projects');
  for (const slug of safeReaddir(projectsDir)) {
    const dir = join(projectsDir, slug);
    if (!isDirectory(dir)) continue;
    for (const file of safeReaddir(dir)) {
      if (!file.endsWith('.jsonl')) continue;
      files.set(file.slice(0, -'.jsonl'.length), join(dir, file));
    }
  }
  return files;
}

function codeBuddyTexts(content: unknown, types: readonly string[]): string[] {
  if (typeof content === 'string') return content.trim() ? [content] : [];
  if (!Array.isArray(content)) return [];
  const out: string[] = [];
  for (const item of content) {
    const block = rec(item);
    if (!block) continue;
    const type = str(block.type) ?? '';
    if ((types.includes(type) || !type) && typeof block.text === 'string' && block.text.trim()) {
      out.push(block.text);
    }
  }
  return out;
}

export interface CodeBuddyParse {
  /** False when the file holds no CodeBuddy-format rows (e.g. Claude-format lines). */
  codeBuddyFormat: boolean;
  messages: PortedMessage[];
}

interface CodeBuddyParseState {
  depth: number;
  linked: Set<string>;
}

/**
 * Parse a CodeBuddy / WorkBuddy responses-style transcript: `message` rows
 * (user / assistant), `reasoning`, `function_call` and `function_call_result`
 * rows, each with its own epoch-ms `timestamp`. `Agent` calls whose result
 * names a `subAgent.sessionId` nest `subagents/<sessionId>.jsonl`.
 *
 * A tool's duration is taken from its call and result rows only when the call
 * is the only one in its model step: the rows of a parallel batch are written
 * together, so their gap is the batch's, not the tool's.
 */
export function parseCodeBuddyTranscript(
  filePath: string,
  h: PortingHelpers,
  state: CodeBuddyParseState = { depth: 0, linked: new Set() },
): CodeBuddyParse | null {
  let raw: string;
  try {
    raw = h.readTranscriptText(filePath, true);
  } catch {
    return null;
  }
  const entries = parseJsonLines(raw);
  const isTopLevel = state.depth === 0;
  const stem = basename(filePath).replace(/\.jsonl$/, '');
  const subagentsDir = isTopLevel ? join(dirname(filePath), stem, 'subagents') : dirname(filePath);

  const callsPerStep = new Map<string, number>();
  const calls = new Map<string, { ts?: number; step?: string; args: unknown; name: string }>();
  let codeBuddyFormat = false;
  for (const entry of entries) {
    const type = entry.type;
    if (type === 'function_call' || type === 'function_call_result' || type === 'reasoning')
      codeBuddyFormat = true;
    if (
      type === 'message' &&
      (entry.role === 'user' || entry.role === 'assistant') &&
      !entry.message
    ) {
      codeBuddyFormat = true;
    }
    if (type !== 'function_call') continue;
    const step = str(rec(entry.providerData)?.messageId);
    if (step) callsPerStep.set(step, (callsPerStep.get(step) ?? 0) + 1);
    const callId = str(entry.callId);
    if (callId) {
      calls.set(callId, {
        ts: h.sourceTimestampMs(entry.timestamp),
        step,
        args: entry.arguments,
        name: str(entry.name) ?? 'tool',
      });
    }
  }

  const rows: PortedMessage[] = [];
  let model: string | undefined;
  /** Spawn calls whose result names no sub-agent session (e.g. it reported an error). */
  const unlinkedSpawns: Array<{ event: ToolResultEvent; args: Record<string, unknown> }> = [];
  for (const entry of entries) {
    const type = str(entry.type) ?? '';
    const providerData = rec(entry.providerData) ?? {};
    const ts = h.sourceTimestampMs(entry.timestamp);
    const at = ts ?? 0;
    const rowModel = str(providerData.model) ?? str(providerData.requestModelName);
    if (rowModel) model = rowModel;

    if (type === 'message' && entry.role === 'user') {
      if (
        providerData.isMeta === true ||
        providerData.skipRun === true ||
        providerData.isCompactInternal === true
      ) {
        continue;
      }
      const joined = codeBuddyTexts(entry.content, ['input_text', 'text']).join('\n\n');
      const hasQuery = /<user_query>/.test(joined);
      const text = h.cleanMessageText(hasQuery ? extractUserQuery(joined) : joined);
      if (!text || h.isNoiseUserPrompt(text)) continue;
      if (!hasQuery && isContextPreamble(text)) continue;
      rows.push(userRow(text, ts));
      continue;
    }

    if (type === 'message' && entry.role === 'assistant') {
      const text = h.cleanMessageText(
        codeBuddyTexts(entry.content, ['output_text', 'text']).join('\n\n'),
      );
      const error = rec(providerData.error);
      if (error) {
        const message = str(error.message) ?? text;
        if (message) {
          const row = assistantRow(
            noticeEvents(str(entry.id) ?? `${stem}:${rows.length}`, 'error', message, at),
            ts,
            rowModel,
          );
          row.content = '';
          rows.push(row);
        }
        continue;
      }
      if (text)
        rows.push(assistantRow([{ type: 'text', text, timestamp: at }], ts, rowModel ?? model));
      continue;
    }

    if (type === 'reasoning') {
      const texts = codeBuddyTexts(entry.rawContent, ['reasoning_text', 'text']);
      if (texts.length === 0)
        texts.push(...codeBuddyTexts(entry.content, ['reasoning_text', 'input_text', 'text']));
      const text = texts.join('\n\n').trim();
      if (text) rows.push(assistantRow([reasoningEvent(text, at)], ts, rowModel ?? model));
      continue;
    }

    if (type === 'function_call') {
      const callId = str(entry.callId);
      if (!callId) continue;
      const event: ToolCallEvent = {
        type: 'tool_call',
        callId,
        name: str(entry.name) ?? 'tool',
        input: h.toolInputRecord(entry.arguments),
        timestamp: at,
      };
      const row = assistantRow([event], ts, rowModel ?? model);
      row.content = '';
      rows.push(row);
      continue;
    }

    if (type === 'function_call_result') {
      const callId = str(entry.callId);
      if (!callId) continue;
      const call = calls.get(callId);
      const toolResultData = rec(providerData.toolResult) ?? {};
      const rawResponse = rec(toolResultData.rawResponse) ?? {};
      const output = rec(entry.output);
      const outputValue = output && typeof output.text === 'string' ? output.text : entry.output;
      const isError =
        rawResponse.is_error === true ||
        !!toolResultData.error ||
        entry.status === 'incomplete' ||
        entry.status === 'error';
      const single = call?.step ? callsPerStep.get(call.step) === 1 : false;
      const event = toolResult({
        callId,
        name: str(entry.name) ?? call?.name ?? 'tool',
        output: h.toolOutputText(outputValue ?? toolResultData.error ?? ''),
        isError,
        timestamp: at,
        durationMs: single ? knownDuration(call?.ts, ts) : undefined,
      });

      const subAgent = rec(toolResultData.subAgent);
      const subSessionId = str(subAgent?.sessionId);
      if (!subSessionId && (event.name === 'Agent' || event.name === 'Task')) {
        unlinkedSpawns.push({ event, args: h.toolInputRecord(call?.args) });
      }
      if (subSessionId && state.depth < MAX_SUBAGENT_DEPTH) {
        const subPath = join(subagentsDir, `${subSessionId}.jsonl`);
        if (existsSync(subPath) && !state.linked.has(subPath)) {
          state.linked.add(subPath);
          const nested = parseCodeBuddyTranscript(subPath, h, {
            depth: state.depth + 1,
            linked: state.linked,
          });
          if (nested && nested.messages.length > 0) {
            const args = h.toolInputRecord(call?.args);
            const descriptor = rec(subAgent?.descriptor);
            event.subagent = subagentFromRows(
              {
                agentId: subSessionId,
                name:
                  str(args.name) ?? str(args.description) ?? str(descriptor?.role) ?? 'subagent',
                task: str(args.prompt) ?? str(args.description) ?? str(descriptor?.description),
                model: str(args.model) ?? nested.messages.find((m) => m.model)?.model,
                provider: 'codebuddy',
              },
              nested.messages,
            );
          }
        }
      }
      const row = assistantRow([event], ts);
      row.content = '';
      rows.push(row);
      continue;
    }
  }

  assignOrderingTimes(rows);

  // Sub-agent transcripts no recorded call result links to (for example a run
  // whose spawn reported an error after the sub-agent was created).
  if (isTopLevel) {
    for (const file of safeReaddir(subagentsDir)) {
      if (!file.endsWith('.jsonl')) continue;
      const subPath = join(subagentsDir, file);
      if (state.linked.has(subPath)) continue;
      state.linked.add(subPath);
      const nested = parseCodeBuddyTranscript(subPath, h, { depth: 1, linked: state.linked });
      if (!nested || nested.messages.length === 0) continue;
      const agentId = file.replace(/\.jsonl$/, '');
      const task = nested.messages.find((m) => m.role === 'user')?.content;
      // A spawn call whose result lost the session link still carries the
      // prompt the sub-agent received.
      const spawnIndex = task
        ? unlinkedSpawns.findIndex((spawn) => {
            const prompt = str(spawn.args.prompt)?.trim();
            return !!prompt && (task.trim() === prompt || task.includes(prompt.slice(0, 400)));
          })
        : -1;
      const spawn = spawnIndex >= 0 ? unlinkedSpawns.splice(spawnIndex, 1)[0] : undefined;
      const sub = subagentFromRows(
        {
          agentId,
          name:
            str(spawn?.args.name) ??
            str(spawn?.args.description) ??
            task?.match(/^- Label:\s*(.+)$/m)?.[1]?.trim() ??
            'subagent',
          task,
          model: str(spawn?.args.model) ?? nested.messages.find((m) => m.model)?.model,
          provider: 'codebuddy',
        },
        nested.messages,
      );
      if (spawn) spawn.event.subagent = sub;
      else insertChronologically(rows, synthesizedSubagentRow(agentId, sub, nested.messages));
    }
  }

  return { codeBuddyFormat, messages: rows };
}

// ─── 3. Omnirush agent sessions (pi format: agent/sessions/--slug--/*.jsonl) ─

function piImageAttachment(
  block: Record<string, unknown>,
  index: number,
): MessageAttachment | null {
  const data = str(block.data);
  if (!data) return null;
  const mimeType = str(block.mimeType) ?? str(block.mime_type) ?? 'image/png';
  return {
    type: 'image',
    data,
    name: `image-${index + 1}.${mimeType.split('/')[1] ?? 'png'}`,
    mimeType,
  };
}

/**
 * Parse a pi-format session (Omnirush's agent sessions). Entries form a tree via
 * `id`/`parentId`; the conversation is the branch that ends at the last entry.
 * Assistant content blocks are `text`, `thinking` and `toolCall`; tool results
 * are `toolResult` messages (`toolCallId`, `isError`, optional `durationMs`
 * and `details`). A `subagent` tool's `details.results[].messages` nest.
 */
export function parsePiSessionEntries(
  entries: Record<string, unknown>[],
  h: PortingHelpers,
  depth = 0,
): { messages: PortedMessage[]; model?: string; title?: string; cwd?: string; id?: string } {
  let cwd: string | undefined;
  let id: string | undefined;
  let title: string | undefined;
  let model: string | undefined;

  const header = entries.find((entry) => entry.type === 'session');
  if (header) {
    cwd = str(header.cwd);
    id = str(header.id);
  }
  // Active branch: walk parents from the last tree entry.
  const tree = entries.filter((entry) => entry.type !== 'session');
  const byId = new Map<string, Record<string, unknown>>();
  for (const entry of tree) {
    const entryId = str(entry.id);
    if (entryId) byId.set(entryId, entry);
  }
  let branch = tree;
  const hasTree = tree.some((entry) => 'parentId' in entry);
  if (hasTree && tree.length > 0) {
    const chain: Record<string, unknown>[] = [];
    const seen = new Set<string>();
    let cursor: Record<string, unknown> | undefined = tree[tree.length - 1];
    while (cursor) {
      chain.push(cursor);
      const parentId = str(cursor.parentId);
      if (!parentId || seen.has(parentId)) break;
      seen.add(parentId);
      cursor = byId.get(parentId);
    }
    branch = chain.reverse();
  }

  const rows: PortedMessage[] = [];
  const callTimes = new Map<string, number>();
  for (const entry of branch) {
    const type = str(entry.type) ?? '';
    if (type === 'model_change') {
      model = str(entry.modelId) ?? model;
      continue;
    }
    if (type === 'session_info') {
      title = str(entry.name) ?? str(entry.title) ?? title;
      continue;
    }
    if (type !== 'message') continue;
    const message = rec(entry.message);
    if (!message) continue;
    const role = str(message.role) ?? '';
    const ts = h.sourceTimestampMs(message.timestamp) ?? h.sourceTimestampMs(entry.timestamp);
    const at = ts ?? 0;

    if (role === 'user') {
      const content = message.content;
      const texts: string[] = [];
      const attachments: MessageAttachment[] = [];
      if (typeof content === 'string') texts.push(content);
      else if (Array.isArray(content)) {
        content.forEach((item, index) => {
          const block = rec(item);
          if (!block) return;
          if (block.type === 'text' && typeof block.text === 'string') texts.push(block.text);
          else if (block.type === 'image') {
            const attachment = piImageAttachment(block, index);
            if (attachment) attachments.push(attachment);
          }
        });
      }
      const text = h.cleanMessageText(texts.join('\n\n'));
      if ((!text || h.isNoiseUserPrompt(text)) && attachments.length === 0) continue;
      rows.push(userRow(text, ts, attachments.length > 0 ? { attachments } : {}));
      continue;
    }

    if (role === 'assistant') {
      const rowModel = str(message.model) ?? model;
      const events: TurnEvent[] = [];
      for (const item of Array.isArray(message.content) ? message.content : []) {
        const block = rec(item);
        if (!block) continue;
        if (block.type === 'text' && typeof block.text === 'string') {
          const text = h.cleanMessageText(block.text);
          if (text) events.push({ type: 'text', text, timestamp: at });
        } else if (
          block.type === 'thinking' &&
          typeof block.thinking === 'string' &&
          block.thinking.trim()
        ) {
          if (block.redacted !== true) events.push(reasoningEvent(block.thinking, at));
        } else if (block.type === 'toolCall') {
          const callId = str(block.id);
          if (!callId) continue;
          callTimes.set(callId, at);
          events.push({
            type: 'tool_call',
            callId,
            name: str(block.name) ?? 'tool',
            input: h.toolInputRecord(block.arguments),
            timestamp: at,
          });
        }
      }
      const errorMessage = str(message.errorMessage);
      if (errorMessage && (message.stopReason === 'error' || message.stopReason === 'aborted')) {
        events.push(
          ...noticeEvents(
            str(entry.id) ?? `pi:${rows.length}`,
            String(message.stopReason),
            errorMessage,
            at,
          ),
        );
      }
      if (events.length > 0) rows.push(assistantRow(events, ts, rowModel));
      continue;
    }

    if (role === 'toolResult') {
      const callId = str(message.toolCallId) ?? `pi:result:${rows.length}`;
      const name = str(message.toolName) ?? 'tool';
      const details = rec(message.details);
      let output = h.toolOutputText(message.content);
      const diff = str(details?.diff);
      if (diff) output = h.toolOutputText(`${output}\n\n${diff}`.trim());
      const event = toolResult({
        callId,
        name,
        output,
        isError: message.isError === true,
        timestamp: at,
        durationMs: num(message.durationMs),
      });
      const extraRows: PortedMessage[] = [];
      if (name === 'subagent' && depth < MAX_SUBAGENT_DEPTH && Array.isArray(details?.results)) {
        (details.results as unknown[]).forEach((item, index) => {
          const result = rec(item);
          if (!result || !Array.isArray(result.messages)) return;
          const nested = parsePiSessionEntries(
            (result.messages as unknown[])
              .map((m) => rec(m))
              .filter((m): m is Record<string, unknown> => !!m)
              .map((m) => ({ type: 'message', message: m })),
            h,
            depth + 1,
          );
          if (nested.messages.length === 0) return;
          const sub = subagentFromRows(
            {
              agentId: `${callId}:${index}`,
              name: str(result.agent) ?? 'subagent',
              task: str(result.task),
              model: str(result.model) ?? nested.model,
              provider: 'omnirush',
            },
            nested.messages,
          );
          if (!event.subagent) event.subagent = sub;
          else extraRows.push(synthesizedSubagentRow(`${callId}:${index}`, sub, nested.messages));
        });
      }
      const row = assistantRow([event], ts);
      row.content = '';
      rows.push(row, ...extraRows);
      continue;
    }
    // bashExecution (user `!command`), custom and summary roles are not turns.
  }
  assignOrderingTimes(rows);
  return { messages: rows, model, title, cwd, id };
}

export function parsePiSessionFile(filePath: string, h: PortingHelpers): PortedMessage[] {
  try {
    return parsePiSessionEntries(parseJsonLines(h.readTranscriptText(filePath, true)), h).messages;
  } catch {
    return [];
  }
}

// ─── Generic message shapes (OpenAI / Anthropic / AI SDK) ───────────────────

/**
 * Turn events for one message in any of the common chat shapes:
 * OpenAI (`tool_calls`, role `tool`), Anthropic content blocks (`thinking`,
 * `tool_use`, `tool_result`) and AI SDK parts (`reasoning`, `tool-call`,
 * `tool-result`). Text blocks become text events.
 */
export function genericMessageEvents(
  message: Record<string, unknown>,
  at: number,
  h: PortingHelpers,
  idPrefix: string,
): TurnEvent[] {
  const events: TurnEvent[] = [];
  const role = str(message.role) ?? '';
  const content = message.content;
  const pushText = (text: string) => {
    const cleaned = h.cleanMessageText(text);
    if (cleaned) events.push({ type: 'text', text: cleaned, timestamp: at });
  };

  if (role === 'tool') {
    const callId = str(message.tool_call_id) ?? str(message.toolCallId);
    if (callId && !Array.isArray(content)) {
      events.push(
        toolResult({
          callId,
          name: str(message.name) ?? 'tool',
          output: h.toolOutputText(content),
          isError: message.is_error === true || message.isError === true,
          timestamp: at,
        }),
      );
      return events;
    }
  }
  const reasoning = str(message.reasoning_content) ?? str(message.reasoning);
  if (reasoning) events.push(reasoningEvent(reasoning, at));

  if (typeof content === 'string') {
    if (role !== 'tool') pushText(content);
  } else if (Array.isArray(content)) {
    content.forEach((item, index) => {
      const block = rec(item);
      if (!block) return;
      const type = str(block.type) ?? '';
      if (type === 'text' || type === 'output_text' || type === 'input_text') {
        if (typeof block.text === 'string') pushText(block.text);
      } else if (type === 'thinking' || type === 'reasoning' || type === 'think') {
        const text = str(block.thinking) ?? str(block.text) ?? str(block.think);
        if (text) events.push(reasoningEvent(text, at));
      } else if (
        type === 'tool_use' ||
        type === 'tool-call' ||
        type === 'toolCall' ||
        type === 'function_call'
      ) {
        const callId =
          str(block.id) ?? str(block.toolCallId) ?? str(block.call_id) ?? `${idPrefix}:${index}`;
        events.push({
          type: 'tool_call',
          callId,
          name: str(block.name) ?? str(block.toolName) ?? 'tool',
          input: h.toolInputRecord(block.input ?? block.args ?? block.arguments),
          timestamp: at,
        });
      } else if (
        type === 'tool_result' ||
        type === 'tool-result' ||
        type === 'function_call_output'
      ) {
        const callId = str(block.tool_use_id) ?? str(block.toolCallId) ?? str(block.call_id);
        if (!callId) return;
        const output = rec(block.output);
        const value =
          block.content ??
          block.result ??
          (output && 'value' in output ? output.value : block.output);
        events.push(
          toolResult({
            callId,
            name: str(block.toolName) ?? str(block.name) ?? 'tool',
            output: h.toolOutputText(value),
            isError:
              block.is_error === true ||
              block.isError === true ||
              (output !== undefined && /error/.test(str(output.type) ?? '')),
            timestamp: at,
          }),
        );
      } else if (type === 'redacted-reasoning' || type === 'redacted_thinking') {
        // Encrypted reasoning: nothing readable to show.
      }
    });
  }

  for (const item of Array.isArray(message.tool_calls) ? message.tool_calls : []) {
    const call = rec(item);
    if (!call) continue;
    const fn = rec(call.function) ?? call;
    const callId = str(call.id);
    if (!callId) continue;
    events.push({
      type: 'tool_call',
      callId,
      name: str(fn.name) ?? 'tool',
      input: h.toolInputRecord(fn.arguments ?? fn.input),
      timestamp: at,
    });
  }
  return events;
}

/**
 * Rows for a list of generic messages (a `sessions/*.json` file's `messages`).
 * A message without its own time is `timeUnknown`.
 */
export function genericMessagesToRows(
  messages: unknown[],
  h: PortingHelpers,
  opts: { model?: string; idPrefix: string; chatStartMs?: number; chatEndMs?: number },
): PortedMessage[] {
  const rows: PortedMessage[] = [];
  messages.forEach((item, index) => {
    const message = rec(item);
    if (!message) return;
    const role = str(message.role) ?? '';
    const ts =
      h.sourceTimestampMs(message.createdAt) ??
      h.sourceTimestampMs(message.timestamp) ??
      h.sourceTimestampMs(message.created_at) ??
      h.sourceTimestampMs(message.time);
    const at = ts ?? 0;
    if (role === 'user') {
      const content = message.content;
      const events = genericMessageEvents(message, at, h, `${opts.idPrefix}:${index}`);
      const results = events.filter((event) => event.type === 'tool_result');
      if (results.length > 0) {
        const row = assistantRow(results, ts);
        row.content = '';
        rows.push(row);
      }
      const raw =
        typeof content === 'string'
          ? content
          : Array.isArray(content)
            ? content
                .map((block) => rec(block))
                .filter(
                  (block): block is Record<string, unknown> =>
                    !!block && typeof block.text === 'string',
                )
                .map((block) => String(block.text))
                .join('\n\n')
            : '';
      const hasQuery = /<user_query>/.test(raw);
      const text = h.cleanMessageText(hasQuery ? extractUserQuery(raw) : raw);
      if (!text || h.isNoiseUserPrompt(text) || (!hasQuery && isContextPreamble(text))) return;
      rows.push(userRow(text, ts));
      return;
    }
    if (role !== 'assistant' && role !== 'tool') return;
    const events = genericMessageEvents(message, at, h, `${opts.idPrefix}:${index}`);
    if (events.length === 0) return;
    rows.push(assistantRow(events, ts, str(message.model) ?? opts.model));
  });
  return assignOrderingTimes(rows, opts.chatStartMs, opts.chatEndMs);
}

// ─── 4. Cursor CLI (chats/<hash>/<agentId>/store.db + meta.json) ────────────

/** Minimal protobuf field reader: (field number, wire type, value). */
function readProtoFields(
  buf: Uint8Array,
): Array<{ field: number; wire: number; value: number | Uint8Array }> {
  const out: Array<{ field: number; wire: number; value: number | Uint8Array }> = [];
  let i = 0;
  const varint = (): number => {
    let result = 0;
    let shift = 0;
    for (;;) {
      if (i >= buf.length) throw new Error('truncated');
      const byte = buf[i++];
      result += (byte & 0x7f) * 2 ** shift;
      shift += 7;
      if (byte < 0x80) return result;
      if (shift > 63) throw new Error('varint');
    }
  };
  while (i < buf.length) {
    const key = varint();
    const field = Math.floor(key / 8);
    const wire = key & 7;
    if (wire === 0) out.push({ field, wire, value: varint() });
    else if (wire === 2) {
      const len = varint();
      if (i + len > buf.length) throw new Error('truncated');
      out.push({ field, wire, value: buf.subarray(i, i + len) });
      i += len;
    } else if (wire === 1) i += 8;
    else if (wire === 5) i += 4;
    else throw new Error('wire type');
  }
  return out;
}

function protoFields(
  buf: Uint8Array | undefined,
): Array<{ field: number; wire: number; value: number | Uint8Array }> {
  if (!buf) return [];
  try {
    return readProtoFields(buf);
  } catch {
    return [];
  }
}

function protoBytes(fields: ReturnType<typeof protoFields>, field: number): Uint8Array[] {
  return fields
    .filter((f) => f.field === field && f.value instanceof Uint8Array)
    .map((f) => f.value as Uint8Array);
}

function protoNumber(fields: ReturnType<typeof protoFields>, field: number): number | undefined {
  const found = fields.find((f) => f.field === field && typeof f.value === 'number');
  return found ? (found.value as number) : undefined;
}

function protoString(fields: ReturnType<typeof protoFields>, field: number): string | undefined {
  const bytes = protoBytes(fields, field)[0];
  return bytes ? Buffer.from(bytes).toString('utf8') : undefined;
}

function hex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('hex');
}

/** `Wednesday, Oct 28, 2026, 7:56 PM (UTC-7)` — Cursor's per-prompt timestamp stamp. */
export function parseCursorPromptTimestamp(text: string): number | undefined {
  const match = text.match(
    /<timestamp>\s*(?:\w+,\s*)?(\w{3})\w*\s+(\d{1,2}),\s*(\d{4}),\s*(\d{1,2}):(\d{2})\s*(AM|PM)\s*\(UTC([+-]\d{1,2})(?::?(\d{2}))?\)\s*<\/timestamp>/i,
  );
  if (!match) return undefined;
  const months = [
    'jan',
    'feb',
    'mar',
    'apr',
    'may',
    'jun',
    'jul',
    'aug',
    'sep',
    'oct',
    'nov',
    'dec',
  ];
  const month = months.indexOf(match[1].toLowerCase());
  if (month < 0) return undefined;
  let hour = Number(match[4]) % 12;
  if (match[6].toUpperCase() === 'PM') hour += 12;
  const offsetHours = Number(match[7]);
  const offsetMinutes = Number(match[8] ?? 0) * Math.sign(offsetHours || 1);
  const utc = Date.UTC(Number(match[3]), month, Number(match[2]), hour, Number(match[5]));
  return utc - (offsetHours * 60 + offsetMinutes) * 60_000;
}

interface CursorStepTiming {
  thinking: Array<{ text: string; startedAt?: number; endedAt?: number }>;
  texts: number[];
  userAt?: number;
}

/**
 * Read a Cursor CLI agent store: a content-addressed blob DAG whose root
 * (`meta['0'].latestRootBlobId`) lists the model-context messages (field 1,
 * AI-SDK JSON blobs) and the UI turns (field 8). Turn step blobs record the
 * user prompt time, thinking text with its own start/end, and text times.
 */
export function readCursorAgentStore(
  dbPath: string,
  h: PortingHelpers,
): {
  messages: PortedMessage[];
  model?: string;
} {
  const sqlite = h.openReadonlySqlite(dbPath);
  if (!sqlite) return { messages: [] };
  try {
    const metaRow = sqlite.query("SELECT value FROM meta WHERE key = '0'").get() as {
      value: string;
    } | null;
    if (!metaRow?.value) return { messages: [] };
    const metaText = /^[0-9a-f]+$/i.test(metaRow.value)
      ? Buffer.from(metaRow.value, 'hex').toString('utf8')
      : metaRow.value;
    const meta = rec(JSON.parse(metaText) as unknown) ?? {};
    const rootId = str(meta.latestRootBlobId);
    if (!rootId) return { messages: [] };
    const blobQuery = sqlite.query('SELECT data FROM blobs WHERE id = ?');
    const blob = (id: string): Uint8Array | undefined => {
      const row = blobQuery.get(id) as { data: Uint8Array | null } | null;
      return row?.data ? new Uint8Array(row.data) : undefined;
    };
    const rootFields = protoFields(blob(rootId));

    const jsonMessages: Record<string, unknown>[] = [];
    for (const ref of protoBytes(rootFields, 1)) {
      const data = blob(hex(ref));
      if (!data || data[0] !== 0x7b) continue;
      try {
        const parsed = rec(JSON.parse(Buffer.from(data).toString('utf8')) as unknown);
        if (parsed) jsonMessages.push(parsed);
      } catch {
        continue;
      }
    }

    // UI turns: one per user prompt, in order.
    const turns: CursorStepTiming[] = [];
    for (const turnRef of protoBytes(rootFields, 8)) {
      for (const turn of protoBytes(protoFields(blob(hex(turnRef))), 1)) {
        const turnFields = protoFields(turn);
        const timing: CursorStepTiming = { thinking: [], texts: [] };
        const userRef = protoBytes(turnFields, 1)[0];
        if (userRef) {
          const userFields = protoFields(blob(hex(userRef)));
          timing.userAt = h.sourceTimestampMs(
            protoNumber(userFields, 25) ?? protoNumber(userFields, 26),
          );
        }
        for (const stepRef of protoBytes(turnFields, 2)) {
          const stepFields = protoFields(blob(hex(stepRef)));
          const thinking = protoBytes(stepFields, 3)[0];
          if (thinking) {
            const f = protoFields(thinking);
            timing.thinking.push({
              text: protoString(f, 1) ?? '',
              startedAt: h.sourceTimestampMs(protoNumber(f, 3)),
              endedAt: h.sourceTimestampMs(protoNumber(f, 4)),
            });
            continue;
          }
          const text = protoBytes(stepFields, 1)[0];
          if (text) {
            const at = h.sourceTimestampMs(protoNumber(protoFields(text), 2));
            if (at !== undefined) timing.texts.push(at);
          }
        }
        turns.push(timing);
      }
    }

    const rows: PortedMessage[] = [];
    let model = str(meta.lastUsedModel);
    let turnIndex = -1;
    let timing: CursorStepTiming | undefined;
    let thinkingIndex = 0;
    let textIndex = 0;
    jsonMessages.forEach((message, index) => {
      const role = str(message.role) ?? '';
      if (role === 'system') return;
      if (role === 'user') {
        const content = message.content;
        const raw =
          typeof content === 'string'
            ? content
            : Array.isArray(content)
              ? content
                  .map((block) => rec(block))
                  .filter(
                    (block): block is Record<string, unknown> =>
                      !!block && typeof block.text === 'string',
                  )
                  .map((block) => String(block.text))
                  .join('\n\n')
              : '';
        const hasQuery = /<user_query>/.test(raw);
        const text = h.cleanMessageText(hasQuery ? extractUserQuery(raw) : raw);
        if (!text || (!hasQuery && isContextPreamble(text)) || h.isNoiseUserPrompt(text)) {
          // Tool results can arrive on user messages in some AI-SDK versions.
          const results = genericMessageEvents(message, 0, h, `cursor:${index}`).filter(
            (e) => e.type === 'tool_result',
          );
          if (results.length > 0) {
            const row = assistantRow(results, undefined);
            row.content = '';
            rows.push(row);
          }
          return;
        }
        turnIndex += 1;
        timing = turns[turnIndex];
        thinkingIndex = 0;
        textIndex = 0;
        rows.push(userRow(text, timing?.userAt ?? parseCursorPromptTimestamp(raw)));
        return;
      }
      if (role !== 'assistant' && role !== 'tool') return;
      const cursorOptions = rec(rec(message.providerOptions)?.cursor);
      const events: TurnEvent[] = [];
      let rowAt: number | undefined;
      let lastAt = 0;
      const blocks = Array.isArray(message.content) ? (message.content as unknown[]) : null;
      const rawEvents: Array<TurnEvent | { type: 'cursor-reasoning'; text: string }> = [];
      if (blocks) {
        blocks.forEach((item, blockIndex) => {
          const block = rec(item);
          if (block?.type === 'reasoning') {
            // Cursor keeps the readable thinking in the UI step; the model
            // context often holds only an encrypted signature.
            rawEvents.push({
              type: 'cursor-reasoning',
              text: typeof block.text === 'string' ? block.text : '',
            });
          } else {
            rawEvents.push(
              ...genericMessageEvents(
                { ...message, content: [item], tool_calls: undefined },
                0,
                h,
                `cursor:${index}:${blockIndex}`,
              ),
            );
          }
        });
        if (Array.isArray(message.tool_calls)) {
          rawEvents.push(
            ...genericMessageEvents(
              { role, tool_calls: message.tool_calls },
              0,
              h,
              `cursor:${index}`,
            ),
          );
        }
      } else {
        rawEvents.push(...genericMessageEvents(message, 0, h, `cursor:${index}`));
      }
      for (const event of rawEvents) {
        if (event.type === 'cursor-reasoning') {
          const step = timing?.thinking[thinkingIndex++];
          const text = event.text.trim() ? event.text : (step?.text ?? '');
          if (!text.trim()) continue;
          if (
            step?.startedAt !== undefined &&
            step.endedAt !== undefined &&
            step.endedAt >= step.startedAt
          ) {
            events.push({ type: 'reasoning', text, timestamp: step.startedAt });
            events.push({ type: 'complete', timestamp: step.endedAt });
            rowAt ??= step.startedAt;
            lastAt = step.endedAt;
          } else {
            events.push(reasoningEvent(text, lastAt));
          }
          continue;
        }
        if (event.type === 'text') {
          const at = timing?.texts[textIndex++];
          if (at !== undefined) {
            event.timestamp = at;
            rowAt ??= at;
            lastAt = at;
          } else event.timestamp = lastAt;
          events.push(event);
          continue;
        }
        event.timestamp = lastAt;
        events.push(event);
      }
      if (events.length === 0) return;
      const rowModel = str(rec(cursorOptions)?.modelName) ?? model;
      if (rowModel) model = rowModel;
      rows.push(assistantRow(events, rowAt, rowModel));
    });
    assignOrderingTimes(rows, h.sourceTimestampMs(meta.createdAt));
    return { messages: rows, model };
  } catch {
    return { messages: [] };
  } finally {
    try {
      sqlite.close();
    } catch {}
  }
}

/**
 * The `agent-transcripts/<id>/<id>.jsonl` export (written "for citation"): text
 * with thinking folded in and tool calls without results or times. Used only
 * when an agent has no readable store.
 */
export function parseCursorAgentTranscript(
  filePath: string,
  h: PortingHelpers,
  chatStartMs?: number,
): PortedMessage[] {
  let raw: string;
  try {
    raw = h.readTranscriptText(filePath, true);
  } catch {
    return [];
  }
  const rows: PortedMessage[] = [];
  parseJsonLines(raw).forEach((entry, index) => {
    if (entry.type === 'turn_ended') {
      if (entry.status === 'error' || entry.status === 'aborted') {
        const text = str(entry.error) ?? `Turn ended: ${String(entry.status)}`;
        const row = assistantRow(
          noticeEvents(`cursor-transcript:${index}`, String(entry.status), text, 0),
          undefined,
        );
        row.content = '';
        rows.push(row);
      }
      return;
    }
    const role = entry.role;
    const message = rec(entry.message);
    if ((role !== 'user' && role !== 'assistant') || !message) return;
    if (role === 'user') {
      const raw2 = codeBuddyTexts(message.content, ['text']).join('\n\n');
      const hasQuery = /<user_query>/.test(raw2);
      const text = h.cleanMessageText(hasQuery ? extractUserQuery(raw2) : raw2);
      if (!text || (!hasQuery && isContextPreamble(text))) return;
      rows.push(userRow(text, parseCursorPromptTimestamp(raw2)));
      return;
    }
    const events = genericMessageEvents(
      { role: 'assistant', content: message.content },
      0,
      h,
      `cursor-transcript:${index}`,
    );
    if (events.length > 0) rows.push(assistantRow(events, undefined));
  });
  return assignOrderingTimes(rows, chatStartMs);
}

export function scanCursorAgentChats(root: string, h: PortingHelpers): PortedChat[] {
  const chats: PortedChat[] = [];
  const seen = new Set<string>();
  const chatsDir = join(root, 'chats');
  for (const hash of safeReaddir(chatsDir)) {
    const hashDir = join(chatsDir, hash);
    if (!isDirectory(hashDir)) continue;
    for (const agentId of safeReaddir(hashDir)) {
      const dir = join(hashDir, agentId);
      const dbPath = join(dir, 'store.db');
      if (!existsSync(dbPath)) continue;
      const meta = rec(readJsonFile(join(dir, 'meta.json'))) ?? {};
      if (meta.hasConversation === false) continue;
      const createdAt = h.sourceTimestampMs(meta.createdAtMs) ?? mtimeMs(dbPath) ?? 0;
      const updatedAt = h.sourceTimestampMs(meta.updatedAtMs) ?? mtimeMs(dbPath) ?? createdAt;
      const store = readCursorAgentStore(dbPath, h);
      if (store.messages.length === 0) continue;
      seen.add(agentId);
      chats.push({
        externalId: agentId,
        cwd: str(meta.cwd) ?? null,
        title: str(meta.title) ?? null,
        model: store.model,
        createdAt,
        updatedAt,
        sample: store.messages.filter((m) => m.content.trim()),
        load: () => readCursorAgentStore(dbPath, h).messages,
      });
    }
  }
  const projectsDir = join(root, 'projects');
  for (const slug of safeReaddir(projectsDir)) {
    const transcripts = join(projectsDir, slug, 'agent-transcripts');
    for (const agentId of safeReaddir(transcripts)) {
      if (seen.has(agentId)) continue;
      const file = join(transcripts, agentId, `${agentId}.jsonl`);
      if (!existsSync(file)) continue;
      const mtime = mtimeMs(file) ?? 0;
      const messages = parseCursorAgentTranscript(file, h);
      if (!messages.some((m) => m.role === 'user')) continue;
      const repo = rec(readJsonFile(join(projectsDir, slug, 'repo.json')));
      chats.push({
        externalId: agentId,
        cwd: str(repo?.workspacePath) ?? str(repo?.path) ?? str(repo?.cwd) ?? null,
        title: null,
        createdAt: firstKnownTime(messages) ?? mtime,
        updatedAt: mtime,
        sample: messages.filter((m) => m.content.trim()),
        load: () => parseCursorAgentTranscript(file, h),
      });
    }
  }
  return chats;
}

// ─── 5. Grok Build (sessions/<encoded-cwd>/<session-uuid>/) ─────────────────

function grokContentText(content: unknown): { text: string; images: MessageAttachment[] } {
  const images: MessageAttachment[] = [];
  const texts: string[] = [];
  const visit = (item: unknown, index: number) => {
    const block = rec(item);
    if (!block) {
      if (typeof item === 'string') texts.push(item);
      return;
    }
    if (block.type === 'text' && typeof block.text === 'string') texts.push(block.text);
    else if (block.type === 'image') {
      const attachment = piImageAttachment(block, index);
      if (attachment) images.push(attachment);
    } else if (block.type === 'content') visit(block.content, index);
  };
  if (Array.isArray(content)) content.forEach(visit);
  else visit(content, 0);
  return { text: texts.join(''), images };
}

function grokToolOutput(update: Record<string, unknown>, h: PortingHelpers): string | undefined {
  if (update.rawOutput !== undefined && update.rawOutput !== null)
    return h.toolOutputText(update.rawOutput);
  if (!Array.isArray(update.content)) return undefined;
  const pieces: string[] = [];
  for (const item of update.content) {
    const block = rec(item);
    if (!block) continue;
    if (block.type === 'content') {
      const inner = grokContentText(block.content).text;
      if (inner) pieces.push(inner);
    } else if (block.type === 'diff') {
      pieces.push(
        `--- ${String(block.path ?? '')}\n${block.oldText ? `- ${String(block.oldText)}\n` : ''}+ ${String(block.newText ?? '')}`,
      );
    } else if (block.type === 'terminal' && block.terminalId) {
      pieces.push(`[terminal ${String(block.terminalId)}]`);
    }
  }
  return pieces.length > 0 ? h.toolOutputText(pieces.join('\n')) : undefined;
}

/**
 * Parse Grok Build's `updates.jsonl`, the authoritative ACP session-update log.
 * Every line carries the agent time (`_meta.agentTimestampMs`, else the epoch
 * `timestamp`). Chunks of one streamed message are coalesced; a tool's
 * duration comes from its `tool_call` and terminal `tool_call_update` lines.
 */
export function parseGrokUpdates(
  raw: string,
  h: PortingHelpers,
): { messages: PortedMessage[]; model?: string } {
  const rows: PortedMessage[] = [];
  let model: string | undefined;
  let current: {
    kind: 'user' | 'agent' | 'thought';
    marker?: string;
    text: string;
    images: MessageAttachment[];
    at?: number;
    chunks: number;
  } | null = null;
  const tools = new Map<
    string,
    { started?: number; name: string; input: Record<string, unknown>; done: boolean }
  >();

  const flushMessage = () => {
    if (!current) return;
    const at = current.at;
    if (current.kind === 'user') {
      const hasQuery = /<user_query>/.test(current.text);
      const text = h.cleanMessageText(hasQuery ? extractUserQuery(current.text) : current.text);
      if (
        (text && !h.isNoiseUserPrompt(text) && (hasQuery || !isContextPreamble(text))) ||
        current.images.length > 0
      ) {
        rows.push(
          userRow(text, at, current.images.length > 0 ? { attachments: current.images } : {}),
        );
      }
    } else if (current.kind === 'agent') {
      const text = h.cleanMessageText(current.text);
      if (text) rows.push(assistantRow([{ type: 'text', text, timestamp: at ?? 0 }], at, model));
    } else if (current.text.trim()) {
      const row = assistantRow([reasoningEvent(current.text.trim(), at ?? 0)], at, model);
      row.content = '';
      rows.push(row);
    }
    current = null;
  };

  for (const line of parseJsonLines(raw)) {
    const params = rec(line.params) ?? {};
    const update = rec(params.update);
    if (!update) continue;
    const meta = rec(params._meta) ?? {};
    const updateMeta = rec(update._meta) ?? {};
    const at = h.sourceTimestampMs(meta.agentTimestampMs) ?? h.sourceTimestampMs(line.timestamp);
    const kind = str(update.sessionUpdate) ?? '';
    const modelId = str(updateMeta.modelId) ?? str(meta.modelId);
    if (modelId) model = modelId;

    if (
      kind === 'user_message_chunk' ||
      kind === 'agent_message_chunk' ||
      kind === 'agent_thought_chunk'
    ) {
      const chunkKind =
        kind === 'user_message_chunk'
          ? 'user'
          : kind === 'agent_message_chunk'
            ? 'agent'
            : 'thought';
      const marker =
        chunkKind === 'user'
          ? String(updateMeta.promptIndex ?? meta.promptId ?? '')
          : String(meta.promptId ?? '');
      if (!current || current.kind !== chunkKind || current.marker !== marker) {
        flushMessage();
        current = { kind: chunkKind, marker, text: '', images: [], at, chunks: 0 };
      }
      const { text, images } = grokContentText(update.content);
      current.text += text;
      current.images.push(...images);
      current.chunks += 1;
      continue;
    }

    if (kind === 'tool_call' || kind === 'tool_call_update') {
      flushMessage();
      const callId = str(update.toolCallId);
      if (!callId) continue;
      const xaiTool =
        rec(update['x.ai/tool']) ?? rec(updateMeta['x.ai/tool']) ?? rec(meta['x.ai/tool']);
      const name = str(xaiTool?.name) ?? str(update.title) ?? str(update.kind) ?? 'tool';
      let tool = tools.get(callId);
      if (!tool) {
        tool = {
          started: at,
          name,
          input: h.toolInputRecord(update.rawInput ?? xaiTool?.input ?? {}),
          done: false,
        };
        tools.set(callId, tool);
        const row = assistantRow(
          [{ type: 'tool_call', callId, name: tool.name, input: tool.input, timestamp: at ?? 0 }],
          at,
          model,
        );
        row.content = '';
        rows.push(row);
      } else if (update.rawInput !== undefined && Object.keys(tool.input).length === 0) {
        tool.input = h.toolInputRecord(update.rawInput);
      }
      const status = str(update.status);
      if ((status === 'completed' || status === 'failed') && !tool.done) {
        tool.done = true;
        const row = assistantRow(
          [
            toolResult({
              callId,
              name: tool.name,
              output: grokToolOutput(update, h) ?? '',
              isError: status === 'failed',
              timestamp: at ?? 0,
              durationMs: knownDuration(tool.started, at),
            }),
          ],
          at,
        );
        row.content = '';
        rows.push(row);
      }
      continue;
    }
    if (kind === 'turn_completed' || kind === 'retry_state') flushMessage();
  }
  flushMessage();
  assignOrderingTimes(rows);
  return { messages: rows, model };
}

/** Fallback: Grok's `chat_history.jsonl` model log (no timestamps). */
export function parseGrokChatHistory(
  raw: string,
  h: PortingHelpers,
  chatStartMs?: number,
): PortedMessage[] {
  const rows: PortedMessage[] = [];
  parseJsonLines(raw).forEach((entry, index) => {
    const type = str(entry.type) ?? '';
    if (type === 'user') {
      const rawText =
        typeof entry.content === 'string'
          ? entry.content
          : codeBuddyTexts(entry.content, ['text']).join('\n\n');
      const hasQuery = /<user_query>/.test(rawText);
      const text = h.cleanMessageText(hasQuery ? extractUserQuery(rawText) : rawText);
      if (text && (hasQuery || !isContextPreamble(text))) rows.push(userRow(text, undefined));
    } else if (type === 'assistant') {
      const events = genericMessageEvents(
        { role: 'assistant', content: entry.content, tool_calls: entry.tool_calls },
        0,
        h,
        `grok:${index}`,
      );
      for (const item of Array.isArray(entry.tool_calls) ? entry.tool_calls : []) {
        const call = rec(item);
        const callId = str(call?.id);
        if (call && callId && !events.some((e) => e.type === 'tool_call' && e.callId === callId)) {
          events.push({
            type: 'tool_call',
            callId,
            name: str(call.name) ?? 'tool',
            input: h.toolInputRecord(call.arguments),
            timestamp: 0,
          });
        }
      }
      if (events.length > 0) rows.push(assistantRow(events, undefined, str(entry.model_id)));
    } else if (type === 'reasoning') {
      const text = (Array.isArray(entry.summary) ? entry.summary : [])
        .map((part) => str(rec(part)?.text) ?? '')
        .filter(Boolean)
        .join('\n\n');
      if (text) {
        const row = assistantRow([reasoningEvent(text, 0)], undefined);
        row.content = '';
        rows.push(row);
      }
    } else if (type === 'tool_result') {
      const callId = str(entry.tool_call_id);
      if (!callId) return;
      const row = assistantRow(
        [
          toolResult({
            callId,
            name: 'tool',
            output: h.toolOutputText(entry.content),
            timestamp: 0,
          }),
        ],
        undefined,
      );
      row.content = '';
      rows.push(row);
    }
  });
  return assignOrderingTimes(rows, chatStartMs);
}

function loadGrokSession(
  dir: string,
  h: PortingHelpers,
  chatStartMs?: number,
): { messages: PortedMessage[]; model?: string } {
  const updates = join(dir, 'updates.jsonl');
  if (existsSync(updates)) {
    try {
      const parsed = parseGrokUpdates(h.readTranscriptText(updates, true), h);
      if (parsed.messages.length > 0) return parsed;
    } catch {
      // Fall back to the model log.
    }
  }
  const history = join(dir, 'chat_history.jsonl');
  if (existsSync(history)) {
    try {
      return {
        messages: parseGrokChatHistory(h.readTranscriptText(history, true), h, chatStartMs),
      };
    } catch {
      return { messages: [] };
    }
  }
  return { messages: [] };
}

function decodeGrokCwd(encoded: string): string | null {
  try {
    const decoded = decodeURIComponent(encoded);
    return decoded.startsWith('/') || /^[A-Za-z]:[\\/]/.test(decoded) ? decoded : null;
  } catch {
    return null;
  }
}

export function scanGrokSessions(root: string, h: PortingHelpers): PortedChat[] {
  const sessionsDir = join(root, 'sessions');
  const found: Array<{
    dir: string;
    summary: Record<string, unknown>;
    groupCwd: string | null;
    id: string;
  }> = [];
  for (const group of safeReaddir(sessionsDir)) {
    const groupDir = join(sessionsDir, group);
    if (!isDirectory(groupDir)) continue;
    let groupCwd = decodeGrokCwd(group);
    if (!groupCwd && existsSync(join(groupDir, '.cwd'))) {
      try {
        groupCwd = readFileSync(join(groupDir, '.cwd'), 'utf8').trim() || null;
      } catch {}
    }
    for (const sessionId of safeReaddir(groupDir)) {
      const dir = join(groupDir, sessionId);
      if (!isDirectory(dir)) continue;
      if (!existsSync(join(dir, 'updates.jsonl')) && !existsSync(join(dir, 'chat_history.jsonl')))
        continue;
      const summary = rec(readJsonFile(join(dir, 'summary.json'))) ?? {};
      found.push({
        dir,
        summary,
        groupCwd,
        id: str(rec(summary.info)?.id) ?? str(summary.id) ?? sessionId,
      });
    }
  }

  // Child sessions (sub-agents) live in the same tree; they nest under their parent.
  const parentOf = (summary: Record<string, unknown>): string | undefined => {
    const info = rec(summary.info) ?? {};
    return (
      str(summary.parent_session_id) ??
      str(summary.parentSessionId) ??
      str(info.parent_session_id) ??
      str(info.parentSessionId) ??
      str(rec(summary.subagent)?.parent_session_id) ??
      str(rec(summary.subagent)?.parentSessionId)
    );
  };
  const byId = new Map(found.map((entry) => [entry.id, entry]));
  const childrenOf = new Map<string, typeof found>();
  for (const entry of found) {
    const parent = parentOf(entry.summary);
    if (!parent || !byId.has(parent) || parent === entry.id) continue;
    const list = childrenOf.get(parent) ?? [];
    list.push(entry);
    childrenOf.set(parent, list);
  }

  const loadWithChildren = (
    entry: (typeof found)[number],
    depth: number,
    visited: Set<string>,
  ): PortedMessage[] => {
    visited.add(entry.id);
    const start =
      h.sourceTimestampMs(entry.summary.created_at) ?? h.sourceTimestampMs(entry.summary.createdAt);
    const rows = loadGrokSession(entry.dir, h, start).messages;
    if (depth >= MAX_SUBAGENT_DEPTH) return rows;
    for (const child of childrenOf.get(entry.id) ?? []) {
      if (visited.has(child.id)) continue;
      const childRows = loadWithChildren(child, depth + 1, visited);
      if (childRows.length === 0) continue;
      const sub = subagentFromRows(
        {
          agentId: child.id,
          name:
            str(rec(child.summary.subagent)?.name) ??
            str(child.summary.agent_name) ??
            str(child.summary.generated_title) ??
            'subagent',
          task: childRows.find((m) => m.role === 'user')?.content,
          model: str(child.summary.current_model_id) ?? childRows.find((m) => m.model)?.model,
          provider: 'grok',
        },
        childRows,
      );
      // Link to a tool call that names the child session, else synthesize one.
      let linked = false;
      for (const row of rows) {
        for (const event of row.events ?? []) {
          if (event.type === 'tool_result' && !event.subagent && event.output.includes(child.id)) {
            event.subagent = sub;
            linked = true;
            break;
          }
        }
        if (linked) break;
      }
      if (!linked) insertChronologically(rows, synthesizedSubagentRow(child.id, sub, childRows));
    }
    return rows;
  };

  const chats: PortedChat[] = [];
  for (const entry of found) {
    const parent = parentOf(entry.summary);
    if (parent && byId.has(parent)) continue;
    const info = rec(entry.summary.info) ?? {};
    const sessionStart =
      h.sourceTimestampMs(entry.summary.created_at) ?? h.sourceTimestampMs(entry.summary.createdAt);
    const sample = loadGrokSession(entry.dir, h, sessionStart);
    if (!sample.messages.some((m) => m.role === 'user' && m.content.trim())) continue;
    const mtime = mtimeMs(entry.dir) ?? 0;
    const createdAt = sessionStart ?? firstKnownTime(sample.messages) ?? mtime;
    chats.push({
      externalId: entry.id,
      cwd: str(info.cwd) ?? str(entry.summary.cwd) ?? entry.groupCwd,
      title: str(entry.summary.title) ?? str(entry.summary.generated_title) ?? null,
      model: str(entry.summary.current_model_id) ?? sample.model,
      createdAt,
      updatedAt:
        h.sourceTimestampMs(entry.summary.updated_at) ??
        h.sourceTimestampMs(entry.summary.updatedAt) ??
        lastKnownTime(sample.messages) ??
        mtime,
      sample: sample.messages.filter((m) => m.content.trim()),
      load: () => loadWithChildren(entry, 0, new Set()),
    });
  }
  return chats;
}

// ─── 6. Kimi Code (sessions/<md5(workdir)>/<session>/wire.jsonl) ────────────

function kimiUserText(input: unknown): { text: string; images: MessageAttachment[] } {
  if (typeof input === 'string') return { text: input, images: [] };
  const texts: string[] = [];
  const images: MessageAttachment[] = [];
  (Array.isArray(input) ? input : []).forEach((item, index) => {
    const part = rec(item);
    if (!part) return;
    if (part.type === 'text' && typeof part.text === 'string') texts.push(part.text);
    if (part.type === 'image_url') {
      const url = str(rec(part.image_url)?.url) ?? '';
      const match = url.match(/^data:([^;]+);base64,(.+)$/);
      if (match)
        images.push({
          type: 'image',
          data: match[2],
          mimeType: match[1],
          name: `image-${index + 1}`,
        });
    }
  });
  return { text: texts.join('\n\n'), images };
}

function kimiToolOutput(returnValue: Record<string, unknown>, h: PortingHelpers): string {
  const output = returnValue.output;
  let text = '';
  if (typeof output === 'string') text = output;
  else if (Array.isArray(output)) text = h.toolOutputText(output);
  const message = str(returnValue.message);
  if (!text.trim() && message) text = message;
  else if (returnValue.is_error === true && message && !text.includes(message))
    text = `${message}\n\n${text}`;
  for (const item of Array.isArray(returnValue.display) ? returnValue.display : []) {
    const block = rec(item);
    if (block?.type === 'diff') {
      text += `\n\n--- ${String(block.path ?? '')}\n- ${String(block.old_text ?? '')}\n+ ${String(block.new_text ?? '')}`;
    }
  }
  return h.toolOutputText(text.trim());
}

interface KimiWireState {
  rows: PortedMessage[];
  results: Map<string, ToolResultEvent>;
  subagentEvents: Map<
    string,
    { agentId?: string; type?: string; records: Record<string, unknown>[] }
  >;
}

/**
 * Fold Kimi wire records (`{timestamp, message: {type, payload}}`) into rows.
 * `TurnBegin`/`SteerInput` are user input; `ContentPart` text/think, `ToolCall`
 * (+ streamed `ToolCallPart` arguments) and `ToolResult` build the assistant
 * turn; `SubagentEvent`s are collected per parent tool call.
 */
function foldKimiWire(records: Record<string, unknown>[], h: PortingHelpers): KimiWireState {
  const state: KimiWireState = { rows: [], results: new Map(), subagentEvents: new Map() };
  const calls = new Map<
    string,
    { at?: number; name: string; args: string; event: ToolCallEvent }
  >();
  let lastCall: { at?: number; name: string; args: string; event: ToolCallEvent } | undefined;
  let thought: { text: string; at?: number; parts: number } | null = null;

  const flushThought = (nextAt?: number) => {
    if (!thought) return;
    const text = thought.text.trim();
    if (text) {
      const events: TurnEvent[] = [];
      if (
        thought.parts > 1 &&
        thought.at !== undefined &&
        nextAt !== undefined &&
        nextAt >= thought.at
      ) {
        // Streamed think parts: the source recorded the block's first and last arrival.
        events.push(
          { type: 'reasoning', text, timestamp: thought.at },
          { type: 'complete', timestamp: nextAt },
        );
      } else {
        events.push(reasoningEvent(text, thought.at ?? 0));
      }
      const row = assistantRow(events, thought.at);
      row.content = '';
      state.rows.push(row);
    }
    thought = null;
  };
  const finalizeCall = () => {
    if (lastCall) lastCall.event.input = h.toolInputRecord(lastCall.args);
    lastCall = undefined;
  };

  for (const record of records) {
    const message = rec(record.message);
    if (!message) continue;
    const type = str(message.type) ?? '';
    const payload = rec(message.payload) ?? {};
    const at = h.sourceTimestampMs(record.timestamp);
    if (type !== 'ToolCallPart') finalizeCall();
    if (thought && !(type === 'ContentPart' && payload.type === 'think')) flushThought(at);

    if (type === 'TurnBegin' || type === 'SteerInput') {
      const { text: raw, images } = kimiUserText(payload.user_input);
      const text = h.cleanMessageText(raw);
      if ((text && !h.isNoiseUserPrompt(text)) || images.length > 0) {
        state.rows.push(userRow(text, at, images.length > 0 ? { attachments: images } : {}));
      }
      continue;
    }
    if (type === 'ContentPart') {
      if (payload.type === 'think' && typeof payload.think === 'string') {
        if (!thought) thought = { text: '', at, parts: 0 };
        thought.text += payload.think;
        thought.parts += 1;
      } else if (payload.type === 'text' && typeof payload.text === 'string') {
        const last = state.rows[state.rows.length - 1];
        const lastEvent = last?.events?.[last.events.length - 1];
        if (
          last &&
          last.role === 'assistant' &&
          lastEvent?.type === 'text' &&
          last.events?.length === 1
        ) {
          lastEvent.text += payload.text;
          last.content = lastEvent.text;
        } else {
          state.rows.push(
            assistantRow([{ type: 'text', text: payload.text, timestamp: at ?? 0 }], at),
          );
        }
      }
      continue;
    }
    if (type === 'ToolCall') {
      const fn = rec(payload.function) ?? {};
      const callId = str(payload.id);
      if (!callId) continue;
      const event: ToolCallEvent = {
        type: 'tool_call',
        callId,
        name: str(fn.name) ?? 'tool',
        input: {},
        timestamp: at ?? 0,
      };
      const call = {
        at,
        name: event.name,
        args: typeof fn.arguments === 'string' ? fn.arguments : '',
        event,
      };
      if (fn.arguments && typeof fn.arguments !== 'string')
        call.args = JSON.stringify(fn.arguments);
      calls.set(callId, call);
      lastCall = call;
      const row = assistantRow([event], at);
      row.content = '';
      state.rows.push(row);
      continue;
    }
    if (type === 'ToolCallPart') {
      if (lastCall && typeof payload.arguments_part === 'string')
        lastCall.args += payload.arguments_part;
      continue;
    }
    if (type === 'ToolResult') {
      const callId = str(payload.tool_call_id);
      if (!callId) continue;
      const call = calls.get(callId);
      const returnValue = rec(payload.return_value) ?? {};
      const event = toolResult({
        callId,
        name: call?.name ?? 'tool',
        output: kimiToolOutput(returnValue, h),
        isError: returnValue.is_error === true,
        timestamp: at ?? 0,
        durationMs: knownDuration(call?.at, at),
      });
      state.results.set(callId, event);
      const row = assistantRow([event], at);
      row.content = '';
      state.rows.push(row);
      continue;
    }
    if (type === 'SubagentEvent') {
      const parentCallId = str(payload.parent_tool_call_id) ?? str(payload.task_tool_call_id);
      const inner = rec(payload.event);
      if (!parentCallId || !inner) continue;
      const bucket = state.subagentEvents.get(parentCallId) ?? { records: [] };
      bucket.agentId ??= str(payload.agent_id);
      bucket.type ??= str(payload.subagent_type);
      bucket.records.push({ timestamp: record.timestamp, message: inner });
      state.subagentEvents.set(parentCallId, bucket);
      continue;
    }
    if (type === 'StepInterrupted') {
      const row = assistantRow(
        noticeEvents(
          `kimi:${state.rows.length}`,
          'interrupted',
          'Step interrupted',
          at ?? 0,
          false,
        ),
        at,
      );
      row.content = '';
      state.rows.push(row);
    }
  }
  finalizeCall();
  flushThought();
  return state;
}

/** Fallback: Kimi's `context.jsonl` (OpenAI-style messages, no timestamps). */
function parseKimiContext(raw: string, h: PortingHelpers): PortedMessage[] {
  const messages = parseJsonLines(raw).filter((entry) => !String(entry.role ?? '').startsWith('_'));
  return genericMessagesToRows(messages, h, { idPrefix: 'kimi' });
}

export function loadKimiSession(
  dir: string,
  h: PortingHelpers,
  depth = 0,
  chatStartMs?: number,
): PortedMessage[] {
  const wire = join(dir, 'wire.jsonl');
  let rows: PortedMessage[] = [];
  let subagentEvents = new Map<
    string,
    { agentId?: string; type?: string; records: Record<string, unknown>[] }
  >();
  let results = new Map<string, ToolResultEvent>();
  if (existsSync(wire)) {
    try {
      const state = foldKimiWire(parseJsonLines(h.readTranscriptText(wire, true)), h);
      rows = state.rows;
      subagentEvents = state.subagentEvents;
      results = state.results;
    } catch {
      rows = [];
    }
  }
  if (rows.length === 0 && existsSync(join(dir, 'context.jsonl'))) {
    try {
      rows = parseKimiContext(h.readTranscriptText(join(dir, 'context.jsonl'), true), h);
    } catch {
      rows = [];
    }
  }
  assignOrderingTimes(rows, chatStartMs);
  if (depth >= MAX_SUBAGENT_DEPTH) return rows;

  // Sub-agents: persisted `subagents/<agentId>/` sessions, else the events the
  // parent wire forwarded, both nested under the spawning call.
  const subagentsDir = join(dir, 'subagents');
  const usedDirs = new Set<string>();
  for (const [parentCallId, bucket] of subagentEvents) {
    let childRows: PortedMessage[] = [];
    if (bucket.agentId && isDirectory(join(subagentsDir, bucket.agentId))) {
      usedDirs.add(bucket.agentId);
      childRows = loadKimiSession(join(subagentsDir, bucket.agentId), h, depth + 1);
    }
    if (childRows.length === 0)
      childRows = assignOrderingTimes(foldKimiWire(bucket.records, h).rows);
    if (childRows.length === 0) continue;
    const resultEvent = results.get(parentCallId);
    const callRow = rows.find((row) =>
      row.events?.some((event) => event.type === 'tool_call' && event.callId === parentCallId),
    );
    const callEvent = callRow?.events?.find(
      (event): event is ToolCallEvent =>
        event.type === 'tool_call' && event.callId === parentCallId,
    );
    const sub = subagentFromRows(
      {
        agentId: bucket.agentId ?? parentCallId,
        name:
          str(callEvent?.input.subagent_name) ??
          str(callEvent?.input.description) ??
          bucket.type ??
          'subagent',
        task: str(callEvent?.input.prompt) ?? childRows.find((m) => m.role === 'user')?.content,
        provider: 'kimicode',
      },
      childRows,
    );
    if (resultEvent) resultEvent.subagent = sub;
    else
      insertChronologically(
        rows,
        synthesizedSubagentRow(bucket.agentId ?? parentCallId, sub, childRows),
      );
  }
  for (const agentId of safeReaddir(subagentsDir)) {
    if (usedDirs.has(agentId) || !isDirectory(join(subagentsDir, agentId))) continue;
    if ([...subagentEvents.values()].some((bucket) => bucket.agentId === agentId)) continue;
    const childRows = loadKimiSession(join(subagentsDir, agentId), h, depth + 1);
    if (childRows.length === 0) continue;
    const sub = subagentFromRows(
      {
        agentId,
        name: 'subagent',
        task: childRows.find((m) => m.role === 'user')?.content,
        provider: 'kimicode',
      },
      childRows,
    );
    insertChronologically(rows, synthesizedSubagentRow(agentId, sub, childRows));
  }
  return rows;
}

function kimiWorkDirs(root: string): Map<string, string> {
  const map = new Map<string, string>();
  const metadata = rec(readJsonFile(join(root, 'kimi.json')));
  for (const item of Array.isArray(metadata?.work_dirs) ? metadata.work_dirs : []) {
    const path = str(rec(item)?.path);
    if (path) map.set(createHash('md5').update(path).digest('hex'), path);
  }
  return map;
}

export function scanKimiSessions(root: string, h: PortingHelpers): PortedChat[] {
  const sessionsDir = join(root, 'sessions');
  const workDirs = kimiWorkDirs(root);
  const chats: PortedChat[] = [];
  for (const hash of safeReaddir(sessionsDir)) {
    const hashDir = join(sessionsDir, hash);
    if (!isDirectory(hashDir)) continue;
    for (const sessionId of safeReaddir(hashDir)) {
      const dir = join(hashDir, sessionId);
      if (!isDirectory(dir)) continue;
      if (!existsSync(join(dir, 'wire.jsonl')) && !existsSync(join(dir, 'context.jsonl'))) continue;
      const sample = loadKimiSession(dir, h, MAX_SUBAGENT_DEPTH);
      if (!sample.some((m) => m.role === 'user' && m.content.trim())) continue;
      const state = rec(readJsonFile(join(dir, 'state.json'))) ?? {};
      const mtime = mtimeMs(dir) ?? 0;
      const createdAt = firstKnownTime(sample) ?? mtime;
      chats.push({
        externalId: sessionId,
        cwd: workDirs.get(hash) ?? str(state.work_dir) ?? null,
        title: str(state.title) ?? null,
        model: str(state.model),
        createdAt,
        updatedAt: lastKnownTime(sample) ?? mtime,
        sample: sample.filter((m) => m.content.trim()),
        load: () => loadKimiSession(dir, h, 0, createdAt),
      });
    }
  }
  return chats;
}
