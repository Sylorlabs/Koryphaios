// Fixture tests for the dedicated CLI transcript parsers in
// cli-chat-porting-providers.ts: Antigravity, WorkBuddy / CodeBuddy desktop,
// Omnirush (pi sessions), Cursor CLI, Grok Build, Kimi Code and generic JSON.
// Each test imports through the public `importCliChats` path into an isolated
// database and inspects the persisted turns and their transcript parts.

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inArray } from 'drizzle-orm';

const isolatedDbDir = !process.env.DATABASE_URL ? mkdtempSync(join(tmpdir(), 'kory-cli-port-providers-db-')) : null;
if (isolatedDbDir) process.env.DATABASE_URL = join(isolatedDbDir, 'test.db');

const { db, initDb, messages, sessions } = await import('../db');
const { MessageStore } = await import('../stores/message-store');
const { discoverCliChats, importCliChats } = await import('./cli-chat-porting');

const createdSessionIds: string[] = [];
const tempDirs: string[] = [];

beforeAll(async () => {
  await initDb();
});

afterEach(async () => {
  if (createdSessionIds.length > 0) {
    const ids = createdSessionIds.splice(0);
    await db.delete(messages).where(inArray(messages.sessionId, ids));
    await db.delete(sessions).where(inArray(sessions.id, ids));
  }
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

afterAll(() => {
  if (isolatedDbDir) rmSync(isolatedDbDir, { recursive: true, force: true });
});

type Part = {
  kind: string;
  text?: string;
  name?: string;
  callId?: string;
  input?: Record<string, unknown>;
  output?: string;
  isError?: boolean;
  durationMs?: number;
  timeUnknown?: true;
  startedAt?: number;
  endedAt?: number;
  subagent?: {
    agentId?: string;
    name: string;
    task?: string;
    model?: string;
    turns: Array<{ role: string; text?: string; parts?: Part[]; createdAt?: number }>;
  };
};
type Stored = { role: string; parts?: Part[]; timeUnknown?: true; createdAt: number; content: unknown };

function makeTempHome(): string {
  const dir = mkdtempSync(join(tmpdir(), 'kory-cli-port-providers-'));
  tempDirs.push(dir);
  return dir;
}

function writeJsonl(path: string, rows: unknown[]): void {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, rows.map((row) => JSON.stringify(row)).join('\n') + '\n');
}

async function importOne(homeDir: string, chatId: string): Promise<Stored[]> {
  const result = await importCliChats({ chatIds: [chatId] }, { homeDir, env: {} });
  for (const s of result.sessions) createdSessionIds.push(s.id);
  expect(result.importedCount).toBe(1);
  return (await new MessageStore().getAll(result.items[0].sessionId)) as unknown as Stored[];
}

function tools(parts: Part[] | undefined): Part[] {
  return (parts ?? []).filter((part) => part.kind === 'tool');
}

function allParts(stored: Stored[]): Part[] {
  return stored.flatMap((m) => m.parts ?? []);
}

function textOf(m: Stored): string {
  const content = m.content as unknown;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .filter((b): b is { type: string; text: string } => !!b && (b as { type?: string }).type === 'text')
      .map((b) => b.text)
      .join('');
  }
  return '';
}

// ─── Antigravity ────────────────────────────────────────────────────────────

describe('Antigravity import', () => {
  function writeAntigravity(home: string) {
    const root = join(home, '.gemini', 'antigravity-cli');
    mkdirSync(root, { recursive: true });
    const parent = 'aaaaaaaa-0000-0000-0000-000000000001';
    const child = 'bbbbbbbb-0000-0000-0000-000000000002';
    const sqlite = new Database(join(root, 'conversation_summaries.db'));
    sqlite.run(`CREATE TABLE conversation_summaries (
      conversation_id text PRIMARY KEY, title text NOT NULL DEFAULT '', preview text NOT NULL DEFAULT '',
      step_count integer NOT NULL DEFAULT 0, last_modified_time datetime NOT NULL, workspace_uris text NOT NULL,
      agent_name text NOT NULL DEFAULT '', parent_conversation_id text NOT NULL DEFAULT '')`);
    sqlite.run(
      `INSERT INTO conversation_summaries VALUES (?, 'Swarm run', '', 9, '2026-11-15 12:10:00+00:00', ?, '', '')`,
      [parent, JSON.stringify([`file://${home}/proj`])],
    );
    sqlite.run(
      `INSERT INTO conversation_summaries VALUES (?, '', '', 3, '2026-11-15 12:09:00+00:00', ?, 'n01', ?)`,
      [child, JSON.stringify([`file://${home}/proj`]), parent],
    );
    sqlite.close();
    mkdirSync(join(home, 'proj'), { recursive: true });

    const logs = (id: string) => join(root, 'brain', id, '.system_generated', 'logs', 'transcript_full.jsonl');
    writeJsonl(logs(parent), [
      { step_index: 0, type: 'USER_INPUT', source: 'USER_EXPLICIT', status: 'DONE', created_at: '2026-11-15T12:00:00Z', content: '<USER_REQUEST>\nrun the swarm\n</USER_REQUEST>\n<ADDITIONAL_METADATA>x</ADDITIONAL_METADATA>' },
      {
        step_index: 1, type: 'PLANNER_RESPONSE', status: 'DONE', created_at: '2026-11-15T12:00:01Z', model: 'gemini-4-hydrogen-high',
        thinking: 'I should add a worker and look around.', content: 'Starting.',
        tool_calls: [
          { name: 'swarm', args: { action: 'add', name: 'n01', brief: 'Do task N01.', model: 'gemini-4-argon-high' } },
          { name: 'run_command', args: { CommandLine: 'ls', toolSummary: 'List' } },
          { name: 'run_command', args: { CommandLine: 'find . -name x' } },
        ],
      },
      // Results are matched by step index (call k of step s is step s+1+k), even out of file order.
      { step_index: 3, type: 'GENERIC', status: 'DONE', created_at: '2026-11-15T12:00:02Z', content: 'Created At: 2026-11-15T04:00:02-08:00\nCompleted At: 2026-11-15T04:00:05-08:00\nfile-a\nfile-b' },
      { step_index: 2, type: 'GENERIC', status: 'DONE', created_at: '2026-11-15T12:00:02Z', content: `Created At: 2026-11-15T04:00:02-08:00\nCompleted At: 2026-11-15T04:00:03-08:00\n${JSON.stringify({ status: 'added', name: 'n01', model: 'gemini-4-argon-high', conversation_id: child })}` },
      { step_index: 4, type: 'GENERIC', status: 'RUNNING', created_at: '2026-11-15T12:00:02Z', content: 'Created At: 2026-11-15T04:00:02-08:00\nTool is running as a background task with task id: aaaa/task-4\nTask Description: find' },
      { step_index: 5, type: 'SYSTEM_MESSAGE', source: 'SYSTEM', status: 'DONE', created_at: '2026-11-15T12:00:30Z', content: '<SYSTEM_MESSAGE>\n[Message] timestamp=2026-11-15T12:00:30Z sender=aaaa/task-4 priority=MESSAGE_PRIORITY_HIGH content=Task id "aaaa/task-4" finished with result:\n\nThe command exited with code 0.\nOutput:\n./x\n</SYSTEM_MESSAGE>' },
      { step_index: 6, type: 'ERROR_MESSAGE', source: 'SYSTEM', status: 'DONE', created_at: '2026-11-15T12:00:31Z', error: 'Malformed function call', content: 'Error: Malformed function call' },
      { step_index: 7, type: 'CHECKPOINT', source: 'SYSTEM', status: 'DONE', created_at: '2026-11-15T12:00:32Z', content: '# Resuming from a compaction' },
      { step_index: 8, type: 'PLANNER_RESPONSE', status: 'DONE', created_at: '2026-11-15T12:10:00Z', content: 'All done.' },
    ]);
    writeJsonl(logs(child), [
      { step_index: 0, type: 'SYSTEM_MESSAGE', source: 'SYSTEM', status: 'DONE', created_at: '2026-11-15T12:00:03Z', content: `<SYSTEM_MESSAGE>\n[Message] timestamp=2026-11-15T12:00:03Z sender=${parent} priority=MESSAGE_PRIORITY_HIGH content=[swarm] new board message #1\n</SYSTEM_MESSAGE>` },
      { step_index: 1, type: 'SYSTEM_MESSAGE', source: 'SYSTEM', status: 'DONE', created_at: '2026-11-15T12:00:03Z', content: `<SYSTEM_MESSAGE>\n[Message] timestamp=2026-11-15T12:00:03Z sender=${parent} priority=MESSAGE_PRIORITY_HIGH content=You have just started. Do task N01.\n</SYSTEM_MESSAGE>` },
      { step_index: 2, type: 'PLANNER_RESPONSE', status: 'DONE', created_at: '2026-11-15T12:00:04Z', model: 'gemini-4-argon-high', thinking: 'Reading instructions.', tool_calls: [{ name: 'read_file', args: { Path: '/tmp/N01.md' } }] },
      { step_index: 3, type: 'GENERIC', status: 'ERROR', error: 'file not found', created_at: '2026-11-15T12:00:05Z', content: 'Created At: 2026-11-15T04:00:05-08:00\nCompleted At: 2026-11-15T04:00:05-08:00\nEncountered error in step execution: file not found' },
      { step_index: 4, type: 'PLANNER_RESPONSE', status: 'DONE', created_at: '2026-11-15T12:09:00Z', content: 'N01 complete.' },
    ]);
    return { parent, child };
  }

  it('hides swarm workers from discovery and nests them under the call that added them', async () => {
    const home = makeTempHome();
    const { parent, child } = writeAntigravity(home);
    const ids = discoverCliChats({ homeDir: home, env: {} }).projects.flatMap((g) => g.chats.map((c) => c.id));
    expect(ids).toContain(`antigravity:${parent}`);
    expect(ids).not.toContain(`antigravity:${child}`);

    const stored = await importOne(home, `antigravity:${parent}`);
    expect(stored.map((m) => m.role)).toEqual(['user', 'assistant']);
    expect(textOf(stored[0])).toBe('run the swarm');
    expect(stored[0].createdAt).toBe(Date.parse('2026-11-15T12:00:00Z'));

    const parts = stored[1].parts ?? [];
    expect(parts[0]).toMatchObject({ kind: 'reasoning', text: 'I should add a worker and look around.', timeUnknown: true });
    const toolParts = tools(parts);
    expect(toolParts.map((t) => t.name)).toEqual(['swarm', 'run_command', 'run_command', 'notice']);

    const [swarm, ls, find, notice] = toolParts;
    // Durations come from the tool's own Created At / Completed At lines.
    expect(swarm.durationMs).toBe(1000);
    expect(ls).toMatchObject({ output: 'file-a\nfile-b', durationMs: 3000, input: { CommandLine: 'ls', toolSummary: 'List' } });
    expect(ls.timeUnknown).toBeUndefined();
    // A background task's completion lands on the call that started it.
    expect(find.output).toContain('task id: aaaa/task-4');
    expect(find.output).toContain('./x');
    expect(find.durationMs).toBe(28_000);
    expect(notice).toMatchObject({ isError: true, output: 'Malformed function call' });

    const sub = swarm.subagent;
    expect(sub).toBeDefined();
    expect(sub).toMatchObject({ agentId: child, name: 'n01', task: 'Do task N01.', model: 'gemini-4-argon-high' });
    expect(sub!.turns.map((t) => t.role)).toEqual(['user', 'assistant']);
    expect(sub!.turns[0]).toMatchObject({ text: 'You have just started. Do task N01.' });
    const subParts = sub!.turns[1].parts ?? [];
    expect(subParts.map((p) => p.kind)).toEqual(['reasoning', 'tool', 'text']);
    expect(tools(subParts)[0]).toMatchObject({ name: 'read_file', isError: true, durationMs: 0 });
    expect(subParts[2].text).toBe('N01 complete.');
    expect(textOf(stored[1])).toContain('All done.');
  });
});

// ─── WorkBuddy / CodeBuddy (responses-style JSONL) ──────────────────────────

describe('WorkBuddy and CodeBuddy import', () => {
  const T = 1_792_218_000_000;
  const meta = (step: string) => ({ conversationRequestId: 'r', messageId: step, model: 'hy3', requestModelName: 'HY3' });

  function writeWorkBuddy(home: string) {
    const sid = '11111111-2222-3333-4444-555555555555';
    const dir = join(home, '.workbuddy-ai', 'projects', '-proj');
    const file = join(dir, `${sid}.jsonl`);
    const subId = 'agent-aaaa';
    const base = { sessionId: sid, cwd: join(home, 'proj') };
    writeJsonl(file, [
      { ...base, type: 'session-meta', timestamp: T, meta: {} },
      { ...base, type: 'message', role: 'user', timestamp: T, content: [{ type: 'input_text', text: '<system-reminder data-role="user-context">ctx</system-reminder>\n<user_query>\nfix the bug\n</user_query>' }] },
      { ...base, type: 'message', role: 'user', timestamp: T + 1, providerData: { isMeta: true }, content: [{ type: 'input_text', text: '<task-notification>done</task-notification>' }] },
      { ...base, type: 'reasoning', timestamp: T + 5_000, providerData: meta('s1'), content: [], rawContent: [{ type: 'reasoning_text', text: 'Check two files.' }] },
      { ...base, type: 'message', role: 'assistant', timestamp: T + 5_001, providerData: meta('s1'), content: [{ type: 'output_text', text: 'Looking.' }] },
      { ...base, type: 'function_call', timestamp: T + 5_002, providerData: meta('s1'), callId: 'c1', name: 'Read', arguments: '{"file_path":"/a.ts"}' },
      { ...base, type: 'function_call', timestamp: T + 5_003, providerData: meta('s1'), callId: 'c2', name: 'Read', arguments: '{"file_path":"/b.ts"}' },
      { ...base, type: 'function_call_result', timestamp: T + 9_000, providerData: { ...meta('s1'), toolResult: {} }, callId: 'c1', name: 'Read', status: 'completed', output: { type: 'text', text: 'A' } },
      { ...base, type: 'function_call_result', timestamp: T + 9_001, providerData: { ...meta('s1'), toolResult: { rawResponse: { is_error: true } } }, callId: 'c2', name: 'Read', status: 'completed', output: { type: 'text', text: 'ENOENT' } },
      { ...base, type: 'function_call', timestamp: T + 10_000, providerData: meta('s2'), callId: 'c3', name: 'Agent', arguments: JSON.stringify({ name: 'explorer', description: 'Explore', prompt: 'Find the bug.' }) },
      { ...base, type: 'function_call_result', timestamp: T + 70_000, providerData: { ...meta('s2'), toolResult: { subAgent: { sessionId: subId, descriptor: { role: 'general-purpose' } } } }, callId: 'c3', name: 'Agent', status: 'completed', output: { type: 'text', text: 'Bug is in b.ts' } },
      { ...base, type: 'message', role: 'assistant', timestamp: T + 71_000, providerData: { ...meta('s3'), skipRun: true, error: { message: '429 usage exceeds frequency limit' } }, status: 'incomplete', content: [{ type: 'output_text', text: '429 usage exceeds frequency limit' }] },
    ]);
    writeJsonl(join(dir, sid, 'subagents', `${subId}.jsonl`), [
      { type: 'message', role: 'user', timestamp: T + 10_100, content: [{ type: 'input_text', text: 'Find the bug.' }] },
      { type: 'reasoning', timestamp: T + 20_000, providerData: meta('x1'), rawContent: [{ type: 'reasoning_text', text: 'grep it' }] },
      { type: 'function_call', timestamp: T + 20_001, providerData: meta('x1'), callId: 'g1', name: 'Grep', arguments: '{"pattern":"bug"}' },
      { type: 'function_call_result', timestamp: T + 25_001, providerData: { ...meta('x1'), toolResult: {} }, callId: 'g1', name: 'Grep', status: 'completed', output: { type: 'text', text: 'b.ts:3' } },
      { type: 'message', role: 'assistant', timestamp: T + 60_000, providerData: meta('x2'), content: [{ type: 'output_text', text: 'Bug is in b.ts' }] },
    ]);
    return sid;
  }

  it('imports tool calls, reasoning, errors and a linked sub-agent with honest durations', async () => {
    const home = makeTempHome();
    const sid = writeWorkBuddy(home);
    const stored = await importOne(home, `workbuddy-desktop:${sid}`);
    expect(stored.map((m) => m.role)).toEqual(['user', 'assistant']);
    expect(textOf(stored[0])).toBe('fix the bug');

    const parts = stored[1].parts ?? [];
    expect(parts.map((p) => p.kind)).toEqual(['reasoning', 'text', 'tool', 'tool', 'tool', 'tool']);
    expect(parts[0]).toMatchObject({ text: 'Check two files.', timeUnknown: true });
    const [a, b, agent, notice] = tools(parts);
    // Two calls in one model step: their rows are written together, so no per-tool duration.
    expect(a).toMatchObject({ name: 'Read', output: 'A', timeUnknown: true, input: { file_path: '/a.ts' } });
    expect(a.durationMs).toBeUndefined();
    expect(b).toMatchObject({ isError: true, output: 'ENOENT', timeUnknown: true });
    // A single call in its step: call and result rows bound the tool run.
    expect(agent).toMatchObject({ name: 'Agent', durationMs: 60_000, output: 'Bug is in b.ts' });
    expect(notice).toMatchObject({ name: 'notice', isError: true, output: '429 usage exceeds frequency limit' });

    expect(agent.subagent).toMatchObject({ agentId: 'agent-aaaa', name: 'explorer', task: 'Find the bug.' });
    const turns = agent.subagent!.turns;
    expect(turns.map((t) => t.role)).toEqual(['user', 'assistant']);
    expect(turns[0]).toMatchObject({ text: 'Find the bug.', createdAt: T + 10_100 });
    expect((turns[1].parts ?? []).map((p) => p.kind)).toEqual(['reasoning', 'tool', 'text']);
    expect(tools(turns[1].parts)[0]).toMatchObject({ name: 'Grep', output: 'b.ts:3', durationMs: 5_000 });
  });

  it('nests an unlinked CodeBuddy workflow sub-agent under a synthetic subagent call', async () => {
    const home = makeTempHome();
    const sid = '01a14856-0000-0000-0000-000000000000';
    const dir = join(home, '.codebuddy', 'projects', '-proj');
    writeJsonl(join(dir, `${sid}.jsonl`), [
      { sessionId: sid, cwd: home, type: 'message', role: 'user', timestamp: T, content: [{ type: 'input_text', text: '<user_query>audit</user_query>' }] },
      { sessionId: sid, type: 'message', role: 'assistant', timestamp: T + 100_000, providerData: meta('m1'), content: [{ type: 'output_text', text: 'Audit complete.' }] },
    ]);
    writeJsonl(join(dir, sid, 'subagents', 'agent-wf1.jsonl'), [
      { type: 'message', role: 'user', timestamp: T + 1_000, content: [{ type: 'input_text', text: '# Workflow context\n- Label: inventory-baseline\n- Phase: Audit\nRead the inventory.' }] },
      { type: 'message', role: 'assistant', timestamp: T + 50_000, providerData: meta('w1'), content: [{ type: 'output_text', text: '{"ready": 3}' }] },
    ]);
    const stored = await importOne(home, `codebuddy:${sid}`);
    expect(stored.map((m) => m.role)).toEqual(['user', 'assistant']);
    const toolParts = tools(stored[1].parts);
    expect(toolParts).toHaveLength(1);
    expect(toolParts[0]).toMatchObject({
      callId: 'subagent:agent-wf1',
      name: 'subagent',
      output: '{"ready": 3}',
      durationMs: 49_000,
    });
    expect(toolParts[0].subagent).toMatchObject({ name: 'inventory-baseline', agentId: 'agent-wf1' });
    // The synthetic call sits where the sub-agent ran: before the final answer.
    expect((stored[1].parts ?? []).map((p) => p.kind)).toEqual(['tool', 'text']);
  });
});

// ─── Omnirush (pi sessions) ─────────────────────────────────────────────────

describe('Omnirush pi-session import', () => {
  it('imports the active branch with thinking, tool results, durations and attachments', async () => {
    const home = makeTempHome();
    const cwd = join(home, 'proj');
    mkdirSync(cwd, { recursive: true });
    const file = join(home, '.omnirush', 'agent', 'sessions', '--proj--', '2026-11-01_s1.jsonl');
    const t0 = Date.parse('2026-11-01T10:00:00Z');
    writeJsonl(file, [
      { type: 'session', version: 3, id: 'pi-s1', timestamp: '2026-11-01T10:00:00Z', cwd },
      { type: 'model_change', id: 'e0', parentId: null, timestamp: '2026-11-01T10:00:00Z', provider: 'x', modelId: 'm-1' },
      { type: 'message', id: 'e1', parentId: 'e0', timestamp: '2026-11-01T10:00:01Z', message: { role: 'user', timestamp: t0 + 1_000, content: [{ type: 'text', text: 'abandoned prompt' }] } },
      { type: 'message', id: 'e2', parentId: 'e0', timestamp: '2026-11-01T10:00:02Z', message: { role: 'user', timestamp: t0 + 2_000, content: [{ type: 'text', text: 'list files' }, { type: 'image', data: 'aGVsbG8=', mimeType: 'image/png' }] } },
      { type: 'message', id: 'e3', parentId: 'e2', timestamp: '2026-11-01T10:00:05Z', message: { role: 'assistant', timestamp: t0 + 5_000, model: 'm-1', content: [{ type: 'thinking', thinking: 'use ls' }, { type: 'text', text: 'Listing.' }, { type: 'toolCall', id: 't1', name: 'bash', arguments: { command: 'ls' } }, { type: 'toolCall', id: 't2', name: 'edit', arguments: { path: 'a' } }] } },
      { type: 'message', id: 'e4', parentId: 'e3', timestamp: '2026-11-01T10:00:06Z', message: { role: 'toolResult', timestamp: t0 + 6_000, toolCallId: 't1', toolName: 'bash', content: [{ type: 'text', text: 'a\nb' }], isError: false, durationMs: 420 } },
      { type: 'message', id: 'e5', parentId: 'e4', timestamp: '2026-11-01T10:00:07Z', message: { role: 'toolResult', timestamp: t0 + 7_000, toolCallId: 't2', toolName: 'edit', content: [{ type: 'text', text: 'failed' }], isError: true, details: { diff: '-x\n+y' } } },
      { type: 'message', id: 'e6', parentId: 'e5', timestamp: '2026-11-01T10:00:09Z', message: { role: 'assistant', timestamp: t0 + 9_000, content: [{ type: 'text', text: 'Done.' }] } },
    ]);
    const chats = discoverCliChats({ homeDir: home, env: {} }).projects.flatMap((g) => g.chats);
    const chat = chats.find((c) => c.provider === 'omnirush');
    expect(chat).toBeDefined();
    const stored = await importOne(home, chat!.id);
    expect(stored.map((m) => m.role)).toEqual(['user', 'assistant']);
    expect(textOf(stored[0])).toBe('list files');
    expect(JSON.stringify(stored[0])).toContain('aGVsbG8=');
    const parts = stored[1].parts ?? [];
    expect(parts.map((p) => p.kind)).toEqual(['reasoning', 'text', 'tool', 'tool', 'text']);
    expect(parts[0]).toMatchObject({ text: 'use ls', timeUnknown: true });
    const [bash, edit] = tools(parts);
    expect(bash).toMatchObject({ output: 'a\nb', durationMs: 420, input: { command: 'ls' } });
    expect(edit).toMatchObject({ isError: true, timeUnknown: true });
    expect(edit.output).toContain('+y');
  });
});

// ─── Cursor CLI ─────────────────────────────────────────────────────────────

function pbVarint(n: number): number[] {
  const out: number[] = [];
  let v = n;
  while (v >= 0x80) {
    out.push((v % 0x80) | 0x80);
    v = Math.floor(v / 0x80);
  }
  out.push(v);
  return out;
}
function pbBytes(field: number, bytes: Uint8Array | number[]): number[] {
  const arr = [...bytes];
  return [...pbVarint(field * 8 + 2), ...pbVarint(arr.length), ...arr];
}
function pbNum(field: number, n: number): number[] {
  return [...pbVarint(field * 8), ...pbVarint(n)];
}
function pbStr(field: number, s: string): number[] {
  return pbBytes(field, new TextEncoder().encode(s));
}

describe('Cursor CLI import', () => {
  it('reads the agent store: JSON model messages plus UI step times and thinking text', async () => {
    const home = makeTempHome();
    const dir = join(home, '.cursor', 'chats', 'hash1', 'agent-1');
    mkdirSync(dir, { recursive: true });
    const cwd = join(home, 'proj');
    mkdirSync(cwd, { recursive: true });
    const created = Date.parse('2026-10-29T02:56:50Z');
    writeFileSync(join(dir, 'meta.json'), JSON.stringify({ schemaVersion: 1, createdAtMs: created, updatedAtMs: created + 10_000, hasConversation: true, title: 'Cursor chat', cwd }));
    const sqlite = new Database(join(dir, 'store.db'));
    sqlite.run('CREATE TABLE blobs (id TEXT PRIMARY KEY, data BLOB)');
    sqlite.run('CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT)');
    const blobs = new Map<string, Uint8Array>();
    const put = (data: Uint8Array | number[]) => {
      const bytes = new Uint8Array(data);
      const id = createHash('sha256').update(bytes).digest('hex');
      blobs.set(id, bytes);
      return id;
    };
    const json = (v: unknown) => put(new TextEncoder().encode(JSON.stringify(v)));
    const ref = (id: string) => Buffer.from(id, 'hex');
    const userAt = created + 1_000;
    const ids = [
      json({ role: 'system', content: 'You are an AI coding assistant.' }),
      json({ role: 'user', content: '<user_info>\nOS Version: darwin\n</user_info>' }),
      json({ role: 'user', content: [{ type: 'text', text: '<timestamp>Wednesday, Oct 28, 2026, 7:56 PM (UTC-7)</timestamp>\n<user_query>\nlist files\n</user_query>' }] }),
      json({ role: 'assistant', content: [{ type: 'reasoning', text: '', signature: 'enc' }, { type: 'text', text: 'Listing.' }, { type: 'tool-call', toolCallId: 'tc1', toolName: 'Shell', args: { command: 'ls' } }], providerOptions: { cursor: { modelName: 'grok-4.7-high' } } }),
      json({ role: 'tool', content: [{ type: 'tool-result', toolCallId: 'tc1', toolName: 'Shell', result: 'a.txt' }] }),
      json({ role: 'assistant', content: [{ type: 'text', text: 'One file.' }] }),
    ];
    const userStep = put([...pbStr(1, 'list files'), ...pbNum(25, userAt), ...pbNum(26, userAt)]);
    const thinkStep = put(pbBytes(3, [...pbStr(1, 'The user wants a listing.'), ...pbNum(2, 800), ...pbNum(3, userAt + 200), ...pbNum(4, userAt + 1_000)]));
    const text1 = put(pbBytes(1, [...pbStr(1, 'Listing.'), ...pbNum(2, userAt + 1_100)]));
    const text2 = put(pbBytes(1, [...pbStr(1, 'One file.'), ...pbNum(2, userAt + 3_000)]));
    const turn = put(pbBytes(1, [...pbBytes(1, ref(userStep)), ...pbBytes(2, ref(thinkStep)), ...pbBytes(2, ref(text1)), ...pbBytes(2, ref(text2))]));
    const root = put([...ids.flatMap((id) => pbBytes(1, ref(id))), ...pbBytes(8, ref(turn))]);
    for (const [id, data] of blobs) sqlite.run('INSERT INTO blobs VALUES (?, ?)', [id, data]);
    sqlite.run("INSERT INTO meta VALUES ('0', ?)", [
      Buffer.from(JSON.stringify({ agentId: 'agent-1', latestRootBlobId: root, createdAt: created, lastUsedModel: 'grok-4.7' })).toString('hex'),
    ]);
    sqlite.close();

    const stored = await importOne(home, 'cursor:agent-1');
    expect(stored.map((m) => m.role)).toEqual(['user', 'assistant']);
    expect(textOf(stored[0])).toBe('list files');
    expect(stored[0].createdAt).toBe(userAt);
    expect(stored[0].timeUnknown).toBeUndefined();
    const parts = stored[1].parts ?? [];
    expect(parts.map((p) => p.kind)).toEqual(['reasoning', 'text', 'tool', 'text']);
    // Thinking text and its own start/end come from the UI step; the model context held only a signature.
    expect(parts[0]).toMatchObject({ text: 'The user wants a listing.', startedAt: userAt + 200, endedAt: userAt + 1_000 });
    expect(parts[0].timeUnknown).toBeUndefined();
    // No step records the tool's run: its duration is unknown.
    expect(tools(parts)[0]).toMatchObject({ name: 'Shell', input: { command: 'ls' }, output: 'a.txt', timeUnknown: true });
  });

  it('parses the Cursor prompt timestamp stamp with its UTC offset', async () => {
    const { parseCursorPromptTimestamp } = await import('./cli-chat-porting-providers');
    expect(parseCursorPromptTimestamp('<timestamp>Wednesday, Oct 28, 2026, 7:56 PM (UTC-7)</timestamp>')).toBe(
      Date.parse('2026-10-29T02:56:00Z'),
    );
  });
});

// ─── Grok Build ─────────────────────────────────────────────────────────────

describe('Grok Build import', () => {
  it('imports updates.jsonl with tool durations and nests a child session', async () => {
    const home = makeTempHome();
    const cwd = join(home, 'proj');
    mkdirSync(cwd, { recursive: true });
    const group = join(home, '.grok', 'sessions', encodeURIComponent(cwd));
    const t0 = Date.parse('2026-11-19T19:30:00Z');
    const line = (ms: number, update: Record<string, unknown>, promptId = 'p1') => ({
      timestamp: Math.floor(ms / 1000),
      method: 'session/update',
      params: { sessionId: 's', update, _meta: { agentTimestampMs: ms, promptId } },
    });
    mkdirSync(join(group, 'parent-1'), { recursive: true });
    writeFileSync(join(group, 'parent-1', 'summary.json'), JSON.stringify({ info: { id: 'parent-1', cwd }, created_at: '2026-11-19T19:30:00Z', generated_title: 'Grok chat', current_model_id: 'grok-5' }));
    writeJsonl(join(group, 'parent-1', 'updates.jsonl'), [
      line(t0, { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: '<user_query>check tests</user_query>' }, _meta: { promptIndex: 0 } }),
      line(t0 + 1_000, { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'Run the ' } }),
      line(t0 + 1_100, { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'suite.' } }),
      line(t0 + 2_000, { sessionUpdate: 'tool_call', toolCallId: 'call1', title: 'Shell', kind: 'execute', status: 'pending', rawInput: { command: 'bun test' } }),
      line(t0 + 9_000, { sessionUpdate: 'tool_call_update', toolCallId: 'call1', status: 'failed', content: [{ type: 'content', content: { type: 'text', text: '1 fail' } }] }),
      line(t0 + 9_500, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'One test ' } }),
      line(t0 + 9_600, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'fails.' } }),
    ]);
    mkdirSync(join(group, 'child-1'), { recursive: true });
    writeFileSync(join(group, 'child-1', 'summary.json'), JSON.stringify({ info: { id: 'child-1', cwd }, parent_session_id: 'parent-1', created_at: '2026-11-19T19:30:03Z' }));
    writeJsonl(join(group, 'child-1', 'updates.jsonl'), [
      line(t0 + 3_000, { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'investigate failure' } }, 'c1'),
      line(t0 + 8_000, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Flaky timer.' } }, 'c1'),
    ]);

    const ids = discoverCliChats({ homeDir: home, env: {} }).projects.flatMap((g) => g.chats.map((c) => c.id));
    expect(ids).toContain('grok:parent-1');
    expect(ids).not.toContain('grok:child-1');

    const stored = await importOne(home, 'grok:parent-1');
    expect(stored.map((m) => m.role)).toEqual(['user', 'assistant']);
    expect(textOf(stored[0])).toBe('check tests');
    const parts = stored[1].parts ?? [];
    expect(parts.map((p) => p.kind)).toEqual(['reasoning', 'tool', 'tool', 'text']);
    expect(parts[0]).toMatchObject({ text: 'Run the suite.' });
    const [shell, sub] = tools(parts);
    expect(shell).toMatchObject({ name: 'Shell', isError: true, output: '1 fail', durationMs: 7_000, input: { command: 'bun test' } });
    expect(sub).toMatchObject({ name: 'subagent', callId: 'subagent:child-1', output: 'Flaky timer.', durationMs: 5_000 });
    expect(sub.subagent?.turns.map((t) => t.role)).toEqual(['user', 'assistant']);
    expect(textOf(stored[1])).toBe('One test fails.');
  });
});

// ─── Kimi Code ──────────────────────────────────────────────────────────────

describe('Kimi Code import', () => {
  it('folds wire.jsonl with streamed arguments, timed thinking and a sub-agent under its Agent call', async () => {
    const home = makeTempHome();
    const cwd = join(home, 'proj');
    mkdirSync(cwd, { recursive: true });
    const root = join(home, '.kimi');
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, 'kimi.json'), JSON.stringify({ work_dirs: [{ path: cwd }] }));
    const sessionDir = join(root, 'sessions', createHash('md5').update(cwd).digest('hex'), 'sess-1');
    const t0 = 1_793_000_000;
    const rec = (s: number, type: string, payload: Record<string, unknown>) => ({ timestamp: t0 + s, message: { type, payload } });
    writeJsonl(join(sessionDir, 'wire.jsonl'), [
      { type: 'metadata', protocol_version: '1.3' },
      rec(0, 'TurnBegin', { user_input: 'find the leak' }),
      rec(0.1, 'StepBegin', { n: 1 }),
      rec(1, 'ContentPart', { type: 'think', think: 'Spawn an ' }),
      rec(2.5, 'ContentPart', { type: 'think', think: 'explorer.' }),
      rec(3, 'ContentPart', { type: 'text', text: 'Delegating.' }),
      rec(3.1, 'ToolCall', { type: 'function', id: 'tc1', function: { name: 'Agent', arguments: '{"description":"leak hunt",' } }),
      rec(3.2, 'ToolCallPart', { arguments_part: '"prompt":"Find the leak."}' }),
      rec(4, 'SubagentEvent', { parent_tool_call_id: 'tc1', agent_id: 'sa1', subagent_type: 'explore', event: { type: 'TurnBegin', payload: { user_input: 'Find the leak.' } } }),
      rec(5, 'SubagentEvent', { parent_tool_call_id: 'tc1', agent_id: 'sa1', event: { type: 'ToolCall', payload: { type: 'function', id: 'x1', function: { name: 'Grep', arguments: '{"pattern":"alloc"}' } } } }),
      rec(7, 'SubagentEvent', { parent_tool_call_id: 'tc1', agent_id: 'sa1', event: { type: 'ToolResult', payload: { tool_call_id: 'x1', return_value: { is_error: false, output: 'pool.ts:9', message: '', display: [] } } } }),
      rec(8, 'SubagentEvent', { parent_tool_call_id: 'tc1', agent_id: 'sa1', event: { type: 'ContentPart', payload: { type: 'text', text: 'Leak in pool.ts' } } }),
      rec(10, 'ToolResult', { tool_call_id: 'tc1', return_value: { is_error: false, output: 'Leak in pool.ts', message: '', display: [] } }),
      rec(11, 'ContentPart', { type: 'text', text: 'Found it.' }),
      rec(11.5, 'TurnEnd', {}),
    ]);
    const stored = await importOne(home, 'kimicode:sess-1');
    expect(stored.map((m) => m.role)).toEqual(['user', 'assistant']);
    expect(textOf(stored[0])).toBe('find the leak');
    expect(stored[0].createdAt).toBe(t0 * 1000);
    const parts = stored[1].parts ?? [];
    expect(parts.map((p) => p.kind)).toEqual(['reasoning', 'text', 'tool', 'text']);
    // Streamed think parts record the block's own first and last arrival.
    expect(parts[0]).toMatchObject({ text: 'Spawn an explorer.', startedAt: (t0 + 1) * 1000 });
    expect(parts[0].timeUnknown).toBeUndefined();
    const agent = tools(parts)[0];
    expect(agent).toMatchObject({
      name: 'Agent',
      input: { description: 'leak hunt', prompt: 'Find the leak.' },
      output: 'Leak in pool.ts',
      durationMs: 6_900,
    });
    expect(agent.subagent).toMatchObject({ agentId: 'sa1', name: 'leak hunt', task: 'Find the leak.' });
    const subTurns = agent.subagent!.turns;
    expect(subTurns.map((t) => t.role)).toEqual(['user', 'assistant']);
    expect(tools(subTurns[1].parts)[0]).toMatchObject({ name: 'Grep', output: 'pool.ts:9', durationMs: 2_000 });
  });
});

// ─── Generic JSON session files ─────────────────────────────────────────────

describe('generic JSON session import', () => {
  it('imports OpenAI-style tool calls and marks untimed messages timeUnknown', async () => {
    const home = makeTempHome();
    const cwd = join(home, 'proj');
    mkdirSync(join(home, '.kimi', 'chats'), { recursive: true });
    mkdirSync(cwd, { recursive: true });
    const created = Date.parse('2026-11-02T08:00:00Z');
    writeFileSync(
      join(home, '.kimi', 'chats', 'g1.json'),
      JSON.stringify({
        id: 'g1',
        cwd,
        title: 'Generic chat',
        model: 'kimi-k3',
        createdAt: created,
        updatedAt: created + 60_000,
        messages: [
          { role: 'user', content: 'read the config', createdAt: created },
          { role: 'assistant', content: 'Reading.', reasoning_content: 'open config.toml', tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'read', arguments: '{"path":"config.toml"}' } }] },
          { role: 'tool', tool_call_id: 'call_1', content: 'port = 80' },
          { role: 'assistant', content: 'Port is 80.' },
        ],
      }),
    );
    const stored = await importOne(home, 'kimicode:g1');
    expect(stored.map((m) => m.role)).toEqual(['user', 'assistant']);
    expect(stored[0].createdAt).toBe(created);
    expect(stored[1].timeUnknown).toBe(true);
    // The ordering-only time sits between the known neighbours, never "now".
    expect(stored[1].createdAt).toBeGreaterThan(created);
    expect(stored[1].createdAt).toBeLessThan(created + 60_000);
    const parts = allParts(stored);
    expect(parts.map((p) => p.kind)).toEqual(['reasoning', 'text', 'tool', 'text']);
    expect(parts[0]).toMatchObject({ text: 'open config.toml', timeUnknown: true });
    expect(tools(parts)[0]).toMatchObject({ name: 'read', input: { path: 'config.toml' }, output: 'port = 80', timeUnknown: true });
  });
});
