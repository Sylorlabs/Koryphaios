import { afterEach, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DevinLiveTail } from '../devin-live-tail';

const SCHEMA = `
CREATE TABLE sessions (id TEXT PRIMARY KEY);
CREATE TABLE message_nodes (
  row_id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  node_id INTEGER NOT NULL,
  parent_node_id INTEGER,
  chat_message TEXT NOT NULL,
  created_at INTEGER,
  metadata TEXT
);
CREATE TABLE tool_call_state (
  session_id TEXT NOT NULL,
  tool_call_id TEXT NOT NULL,
  tool_call_json TEXT,
  tool_call_update_json TEXT,
  source_node_ids TEXT
);`;

let home: string | null = null;

function makeHome(): string {
  home = mkdtempSync(join(tmpdir(), 'devin-tail-test-'));
  return home;
}

function openDb(mode: 'create' | 'append' = 'create'): Database {
  if (!home) makeHome();
  const dir = join(home!, '.local', 'share', 'devin', 'cli');
  mkdirSync(dir, { recursive: true });
  const db = new Database(join(dir, 'sessions.db'));
  db.exec('PRAGMA journal_mode=WAL');
  if (mode === 'create') db.exec(SCHEMA);
  return db;
}

function insertNode(db: Database, chat: object): void {
  db.query(
    'INSERT INTO message_nodes (session_id, node_id, parent_node_id, chat_message, created_at, metadata) VALUES (?,?,?,?,?,?)',
  ).run('sess', 1, null, JSON.stringify(chat), Date.now(), null);
}

function insertTool(db: Database, call: object, update?: object): void {
  db.query(
    'INSERT INTO tool_call_state (session_id, tool_call_id, tool_call_json, tool_call_update_json, source_node_ids) VALUES (?,?,?,?,?)',
  ).run(
    'sess',
    (call as { toolCallId: string }).toolCallId,
    JSON.stringify(call),
    update ? JSON.stringify(update) : null,
    '[]',
  );
}

function updateTool(db: Database, toolCallId: string, update: object): void {
  db.query('UPDATE tool_call_state SET tool_call_update_json = ? WHERE tool_call_id = ?').run(
    JSON.stringify(update),
    toolCallId,
  );
}

afterEach(() => {
  if (home) rmSync(home, { recursive: true, force: true });
  home = null;
});

describe('DevinLiveTail', () => {
  test('survives a missing sessions.db and picks it up once created', () => {
    const tail = new DevinLiveTail(makeHome());
    tail.snapshot();
    expect(tail.drain()).toEqual([]);

    const db = openDb();
    insertNode(db, { role: 'assistant', content: 'hello live' });
    db.close();
    const events = tail.drain();
    expect(events).toEqual([{ type: 'content_delta', content: 'hello live' }]);
    expect(tail.emittedAnyContent).toBe(true);
  });

  test('emits thinking, content and completed tool calls for new rows only', () => {
    const db = openDb();
    insertNode(db, { role: 'system', content: 'old prefix' });
    const tail = new DevinLiveTail(home!);
    tail.snapshot();

    insertNode(db, {
      role: 'assistant',
      content: 'working on it',
      thinking: { thinking: 'plan first' },
    });
    insertNode(db, { role: 'user', content: 'not streamed' });
    insertTool(
      db,
      {
        toolCallId: 'call_1',
        title: 'Calling kory__write_file from kory',
        rawInput: { path: '/w/a.txt', content: 'x' },
        _meta: { 'cognition.ai/inferenceToolName': 'mcp_call_tool' },
      },
      {
        toolCallId: 'call_1',
        status: 'completed',
        content: [{ type: 'content', content: { type: 'text', text: 'wrote a.txt' } }],
      },
    );
    db.close();

    const events = tail.drain();
    expect(events).toEqual([
      { type: 'thinking_delta', thinking: 'plan first' },
      { type: 'content_delta', content: 'working on it' },
      {
        type: 'tool_executed',
        toolCallId: 'call_1',
        toolName: 'mcp_call_tool',
        toolInput: JSON.stringify({ path: '/w/a.txt', content: 'x' }),
        toolOutput: 'wrote a.txt',
        isError: false,
      },
    ]);
    // A second drain finds nothing new.
    expect(tail.drain()).toEqual([]);
  });

  test('holds a tool call until its update row lands, marks rejections as errors', () => {
    const db = openDb();
    const tail = new DevinLiveTail(home!);
    tail.snapshot();
    insertTool(db, {
      toolCallId: 'call_denied',
      title: "Search for 'foo'",
      rawInput: { query: 'foo' },
      _meta: { 'cognition.ai/inferenceToolName': 'grep' },
    });
    db.close();

    expect(tail.drain()).toEqual([]);

    const db2 = openDb('append');
    updateTool(db2, 'call_denied', {
      toolCallId: 'call_denied',
      status: 'failed',
      content: [{ type: 'content', content: { type: 'text', text: 'denied by a deny rule' } }],
      _meta: { 'cognition.ai/rejected': true },
    });
    db2.close();

    const events = tail.drain();
    expect(events).toEqual([
      {
        type: 'tool_executed',
        toolCallId: 'call_denied',
        toolName: 'grep',
        toolInput: JSON.stringify({ query: 'foo' }),
        toolOutput: 'denied by a deny rule',
        isError: true,
      },
    ]);
  });

  test('drainFinal flushes pending calls and dedupeExportEvents removes live duplicates', () => {
    const db = openDb();
    const tail = new DevinLiveTail(home!);
    tail.snapshot();
    insertNode(db, { role: 'assistant', content: 'done already', thinking: { thinking: 't' } });
    insertTool(db, {
      toolCallId: 'call_open',
      title: 'Calling kory__bash',
      rawInput: { command: 'ls', cwd: '/w' },
      _meta: { 'cognition.ai/inferenceToolName': 'mcp_call_tool' },
    });
    insertTool(
      db,
      {
        toolCallId: 'call_done',
        title: 'Calling kory__read_file',
        rawInput: { path: '/w/a.txt' },
        _meta: { 'cognition.ai/inferenceToolName': 'mcp_call_tool' },
      },
      { toolCallId: 'call_done', status: 'completed', content: [] },
    );
    db.close();

    const finalEvents = tail.drainFinal();
    expect(finalEvents.map((e) => e.type)).toEqual([
      'thinking_delta',
      'content_delta',
      'tool_executed',
      'tool_executed',
    ]);

    const exportEvents = [
      { type: 'thinking_delta' as const, thinking: 't' },
      { type: 'content_delta' as const, content: 'done already' },
      // ATIF ids and input shapes differ from the DB — once the tail emitted
      // any tool event the export's tool calls are dropped wholesale.
      {
        type: 'tool_executed' as const,
        toolCallId: 'tc_atif_different_id',
        toolName: 'mcp_call_tool',
        toolInput: JSON.stringify({ path: '/w/a.txt' }),
      },
      { type: 'usage_update' as const, tokensIn: 5, tokensOut: 2 },
    ];
    const remaining = tail.dedupeExportEvents(exportEvents);
    expect(remaining).toEqual([{ type: 'usage_update', tokensIn: 5, tokensOut: 2 }]);
  });

  test('keeps export tool events when the tail emitted none', () => {
    const tail = new DevinLiveTail(makeHome());
    const exportEvents = [
      {
        type: 'tool_executed' as const,
        toolCallId: 'tc_1',
        toolName: 'mcp_call_tool',
        toolInput: '{}',
      },
      { type: 'content_delta' as const, content: 'kept' },
    ];
    expect(tail.dedupeExportEvents(exportEvents)).toEqual(exportEvents);
  });
});
