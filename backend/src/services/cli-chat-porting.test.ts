import { afterAll, afterEach, beforeAll, describe, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inArray } from 'drizzle-orm';
import { canonicalizePath } from '../runtime/platform';

const isolatedDbDir = !process.env.DATABASE_URL
  ? mkdtempSync(join(tmpdir(), 'kory-cli-port-db-'))
  : null;
if (isolatedDbDir) {
  process.env.DATABASE_URL = join(isolatedDbDir, 'test.db');
}

const { db, initDb, messages, sessions } = await import('../db');
const { MessageStore } = await import('../stores/message-store');
const { ALL_CLI_CHAT_PROVIDERS, discoverCliChats, importCliChats } = await import(
  './cli-chat-porting'
);

const createdSessionIds: string[] = [];
const tempDirs: string[] = [];

beforeAll(async () => {
  await initDb();
});

afterEach(async () => {
  if (createdSessionIds.length > 0) {
    const ids = [...createdSessionIds];
    createdSessionIds.length = 0;
    await db.delete(messages).where(inArray(messages.sessionId, ids));
    await db.delete(sessions).where(inArray(sessions.id, ids));
  }
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

afterAll(() => {
  if (isolatedDbDir) {
    rmSync(isolatedDbDir, { recursive: true, force: true });
  }
});

function makeTempHome(): string {
  const dir = mkdtempSync(join(tmpdir(), 'kory-cli-port-test-'));
  tempDirs.push(dir);
  return dir;
}

describe('CLI Chat Porting Service', () => {
  it('checks all 13 CLI providers unconditionally even on an empty home directory', () => {
    const homeDir = makeTempHome();
    const result = discoverCliChats({ homeDir, env: {} });

    expect(result.providers.length).toBe(ALL_CLI_CHAT_PROVIDERS.length);
    expect(result.providers.length).toBeGreaterThanOrEqual(13);
    for (const p of result.providers) {
      expect(p.checked).toBe(true);
      expect(p.storageFound).toBe(false);
      expect(p.chatCount).toBe(0);
      expect(p.checkedPaths.length).toBeGreaterThan(0);
    }
    expect(result.totalChats).toBe(0);
    expect(result.totalProjects).toBe(0);
  });

  it('discovers chats across multiple CLI providers and merges them per project', () => {
    const homeDir = makeTempHome();
    const projectAlpha = join(homeDir, 'workspace', 'alpha');
    const projectBeta = join(homeDir, 'workspace', 'beta');
    mkdirSync(projectAlpha, { recursive: true });
    mkdirSync(projectBeta, { recursive: true });

    // 1. Claude Code chat in projectAlpha
    const claudeProjDir = join(homeDir, '.claude', 'projects', '-workspace-alpha');
    mkdirSync(claudeProjDir, { recursive: true });
    writeFileSync(
      join(claudeProjDir, 'claude-sess-1.jsonl'),
      [
        JSON.stringify({
          type: 'user',
          sessionId: 'claude-sess-1',
          cwd: projectAlpha,
          timestamp: '2026-10-10T10:00:00.000Z',
          message: { role: 'user', content: 'Refactor auth middleware in alpha' },
        }),
        JSON.stringify({
          type: 'assistant',
          sessionId: 'claude-sess-1',
          cwd: projectAlpha,
          timestamp: '2026-10-10T10:01:00.000Z',
          message: {
            role: 'assistant',
            model: 'claude-sonnet-4-5',
            content: [{ type: 'text', text: 'Here is the refactored auth middleware.' }],
          },
        }),
      ].join('\n'),
    );

    // 2. Codex CLI chat in projectAlpha (mixed provider in same project!)
    const codexDir = join(homeDir, '.codex');
    mkdirSync(codexDir, { recursive: true });
    const stateDb = new Database(join(codexDir, 'state_5.sqlite'));
    stateDb.run(`
      CREATE TABLE threads (
        id TEXT PRIMARY KEY,
        rollout_path TEXT,
        created_at INTEGER,
        updated_at INTEGER,
        cwd TEXT,
        title TEXT,
        first_user_message TEXT,
        archived INTEGER DEFAULT 0,
        model TEXT,
        created_at_ms INTEGER,
        updated_at_ms INTEGER
      )
    `);
    stateDb
      .query(
        `INSERT INTO threads (id, cwd, title, first_user_message, model, created_at_ms, updated_at_ms)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        'codex-thread-1',
        projectAlpha,
        'Add unit tests for alpha',
        'Please write unit tests for alpha',
        'gpt-5.3-codex',
        1760100000000,
        1760100060000,
      );
    stateDb.close();

    const historyDb = new Database(join(codexDir, 'thread_history_1.sqlite'));
    historyDb.run(`
      CREATE TABLE thread_items (
        thread_id TEXT,
        rollout_ordinal INTEGER,
        created_at_ms INTEGER,
        item_type TEXT,
        item_json TEXT
      )
    `);
    historyDb
      .query(
        `INSERT INTO thread_items (thread_id, rollout_ordinal, created_at_ms, item_type, item_json)
         VALUES (?, ?, ?, ?, ?), (?, ?, ?, ?, ?)`,
      )
      .run(
        'codex-thread-1',
        1,
        1760100000000,
        'userMessage',
        JSON.stringify({
          type: 'userMessage',
          content: [{ type: 'text', text: 'Please write unit tests for alpha' }],
        }),
        'codex-thread-1',
        2,
        1760100030000,
        'agentMessage',
        JSON.stringify({
          type: 'agentMessage',
          text: 'Added 12 unit tests covering edge cases.',
        }),
      );
    historyDb.close();

    // 3. Devin CLI chat in projectBeta
    const devinDir = join(homeDir, '.local', 'share', 'devin', 'cli');
    mkdirSync(devinDir, { recursive: true });
    const devinDb = new Database(join(devinDir, 'sessions.db'));
    devinDb.run(`
      CREATE TABLE sessions (
        id TEXT PRIMARY KEY,
        working_directory TEXT,
        model TEXT,
        created_at INTEGER,
        last_activity_at INTEGER,
        title TEXT,
        hidden BOOLEAN DEFAULT 0
      );
      CREATE TABLE message_nodes (
        session_id TEXT,
        node_id TEXT,
        parent_node_id TEXT,
        chat_message TEXT,
        created_at INTEGER
      );
    `);
    devinDb
      .query(
        `INSERT INTO sessions (id, working_directory, model, created_at, last_activity_at, title, hidden)
         VALUES (?, ?, ?, ?, ?, ?, 0)`,
      )
      .run('devin-sess-1', projectBeta, 'devin-default', 1760200000, 1760200120, 'Optimize beta build');
    devinDb
      .query(
        `INSERT INTO message_nodes (session_id, node_id, parent_node_id, chat_message, created_at)
         VALUES (?, 'n1', NULL, ?, 1760200000), (?, 'n2', 'n1', ?, 1760200060)`,
      )
      .run(
        'devin-sess-1',
        JSON.stringify({ role: 'user', content: 'Optimize the Vite build in beta' }),
        'devin-sess-1',
        JSON.stringify({ role: 'assistant', content: 'Configured chunk splitting in beta.' }),
      );
    devinDb.close();

    // 4. Cursor CLI chat in projectBeta (via generic JSON session scanner)
    const cursorSessionsDir = join(homeDir, '.cursor', 'sessions');
    mkdirSync(cursorSessionsDir, { recursive: true });
    writeFileSync(
      join(cursorSessionsDir, 'cursor-1.json'),
      JSON.stringify({
        id: 'cursor-1',
        cwd: projectBeta,
        title: 'Cursor UI tweak',
        model: 'claude-3.7-sonnet',
        createdAt: 1760250000000,
        updatedAt: 1760250060000,
        messages: [
          { role: 'user', content: 'Align the header buttons in beta', createdAt: 1760250000000 },
          { role: 'assistant', content: 'Aligned header buttons with flex gap.', createdAt: 1760250060000 },
        ],
      }),
    );

    const discovery = discoverCliChats({ homeDir, env: {} });
    expect(discovery.totalChats).toBe(4);
    expect(discovery.totalProjects).toBe(2);

    const alphaGroup = discovery.projects.find((p) => p.projectName === 'alpha');
    const betaGroup = discovery.projects.find((p) => p.projectName === 'beta');
    expect(alphaGroup).toBeDefined();
    expect(betaGroup).toBeDefined();

    // Alpha has mixed Claude + Codex chats
    expect(alphaGroup?.chatCount).toBe(2);
    expect(alphaGroup?.providers.map((p) => p.provider).sort()).toEqual(['claude', 'codex']);

    // Beta has mixed Cursor + Devin chats
    expect(betaGroup?.chatCount).toBe(2);
    expect(betaGroup?.providers.map((p) => p.provider).sort()).toEqual(['cursor', 'devin']);
  });

  it('cherry-picks and imports chats from mixed providers into Koryphaios sessions and message lineages', async () => {
    const homeDir = makeTempHome();
    const projectAlpha = join(homeDir, 'workspace', 'alpha');
    const projectBeta = join(homeDir, 'workspace', 'beta');
    mkdirSync(projectAlpha, { recursive: true });
    mkdirSync(projectBeta, { recursive: true });

    // CodeBuddy chat in projectAlpha
    const cbDir = join(homeDir, '.codebuddy', 'projects', '-workspace-alpha');
    mkdirSync(cbDir, { recursive: true });
    writeFileSync(
      join(cbDir, 'cb-chat-1.jsonl'),
      [
        JSON.stringify({
          type: 'ai-title',
          sessionId: 'cb-chat-1',
          cwd: projectAlpha,
          aiTitle: 'CodeBuddy Ported Feature',
          timestamp: 1760300000000,
        }),
        JSON.stringify({
          type: 'message',
          sessionId: 'cb-chat-1',
          cwd: projectAlpha,
          role: 'user',
          timestamp: 1760300000000,
          content: [{ type: 'input_text', text: 'Build the porting feature' }],
        }),
        JSON.stringify({
          type: 'message',
          sessionId: 'cb-chat-1',
          cwd: projectAlpha,
          role: 'assistant',
          timestamp: 1760300010000,
          providerData: { model: 'deepseek-v3' },
          content: [{ type: 'output_text', text: 'Implemented the porting feature end-to-end.' }],
        }),
      ].join('\n'),
    );

    // Antigravity chat in projectBeta
    const agyDir = join(homeDir, '.gemini', 'antigravity-cli');
    const agyLogDir = join(
      agyDir,
      'brain',
      'agy-conv-99',
      '.system_generated',
      'logs',
    );
    mkdirSync(agyLogDir, { recursive: true });
    const agyDb = new Database(join(agyDir, 'conversation_summaries.db'));
    agyDb.run(`
      CREATE TABLE conversation_summaries (
        conversation_id TEXT PRIMARY KEY,
        title TEXT,
        step_count INTEGER,
        last_modified_time TEXT,
        workspace_uris TEXT,
        preview TEXT
      )
    `);
    agyDb
      .query(
        `INSERT INTO conversation_summaries (conversation_id, title, step_count, last_modified_time, workspace_uris, preview)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        'agy-conv-99',
        'Antigravity Architecture Review',
        4,
        '2026-10-15 12:00:00+00:00',
        JSON.stringify([
          `file://${join(homeDir, '.gemini', 'antigravity-cli', 'skills')}`,
          `file://${projectBeta}`,
        ]),
        'Review the architecture',
      );
    agyDb.close();

    writeFileSync(
      join(agyLogDir, 'transcript.jsonl'),
      [
        JSON.stringify({
          type: 'USER_INPUT',
          created_at: '2026-10-15T11:59:00Z',
          content: '<USER_REQUEST><user_request>Review the beta architecture</user_request></USER_REQUEST>',
        }),
        JSON.stringify({
          type: 'PLANNER_RESPONSE',
          created_at: '2026-10-15T12:00:00Z',
          content: 'The beta architecture looks modular and clean.',
        }),
      ].join('\n'),
    );

    // Import both mixed-provider chats
    const importResult = await importCliChats(
      { chatIds: ['codebuddy:cb-chat-1', 'antigravity:agy-conv-99'] },
      { homeDir, env: {} },
    );
    for (const s of importResult.sessions) {
      createdSessionIds.push(s.id);
    }

    expect(importResult.importedCount).toBe(2);
    expect(importResult.alreadyImportedCount).toBe(0);
    expect(importResult.sessions).toHaveLength(2);

    const messageStore = new MessageStore();

    const cbSummary = importResult.items.find((i) => i.chatId === 'codebuddy:cb-chat-1');
    expect(cbSummary?.status).toBe('imported');
    const cbMessages = await messageStore.getAll(cbSummary!.sessionId);
    expect(cbMessages).toHaveLength(2);
    expect(cbMessages[0]).toMatchObject({
      role: 'user',
      content: 'Build the porting feature',
      provider: 'codebuddy',
    });
    expect(cbMessages[1]).toMatchObject({
      role: 'assistant',
      content: 'Implemented the porting feature end-to-end.',
      provider: 'codebuddy',
      model: 'deepseek-v3',
    });

    const agySummary = importResult.items.find((i) => i.chatId === 'antigravity:agy-conv-99');
    expect(agySummary?.status).toBe('imported');
    // Verify Antigravity picked projectBeta rather than the .gemini/antigravity-cli/skills path
    expect(agySummary?.projectPath).toBe(canonicalizePath(projectBeta));
    const agyMessages = await messageStore.getAll(agySummary!.sessionId);
    expect(agyMessages).toHaveLength(2);
    expect(agyMessages[0]).toMatchObject({
      role: 'user',
      content: 'Review the beta architecture',
      provider: 'antigravity',
    });
    expect(agyMessages[1]).toMatchObject({
      role: 'assistant',
      content: 'The beta architecture looks modular and clean.',
      provider: 'antigravity',
    });

    // Re-importing the same chats is idempotent and does not duplicate sessions
    const secondImport = await importCliChats(
      { chatIds: ['codebuddy:cb-chat-1', 'antigravity:agy-conv-99'] },
      { homeDir, env: {} },
    );
    expect(secondImport.importedCount).toBe(0);
    expect(secondImport.alreadyImportedCount).toBe(2);

    // Subsequent discovery marks both chats as alreadyImported
    const rediscovery = discoverCliChats({ homeDir, env: {} });
    for (const group of rediscovery.projects) {
      for (const chat of group.chats) {
        expect(chat.alreadyImported).toBe(true);
      }
    }
  });
});

describe('CLI chat import fidelity (regressions found porting real transcripts)', () => {
  type Part = { kind: string; text?: string; name?: string; callId?: string; output?: string };

  async function importOne(homeDir: string, chatId: string) {
    const result = await importCliChats({ chatIds: [chatId] }, { homeDir, env: {} });
    for (const s of result.sessions) createdSessionIds.push(s.id);
    expect(result.importedCount).toBe(1);
    const item = result.items[0];
    const stored = await new MessageStore().getAll(item.sessionId);
    return { item, stored };
  }

  function toolParts(parts: unknown): Part[] {
    return ((parts as Part[] | undefined) ?? []).filter((p) => p.kind === 'tool');
  }

  it('imports a long Claude Code transcript whole, as turns with reasoning and tool parts', async () => {
    const homeDir = makeTempHome();
    const project = join(homeDir, 'workspace', 'long');
    mkdirSync(project, { recursive: true });
    const dir = join(homeDir, '.claude', 'projects', '-workspace-long');
    mkdirSync(dir, { recursive: true });
    const base = Date.parse('2026-10-10T10:00:00.000Z');
    const at = (s: number) => new Date(base + s * 1000).toISOString();
    const line = (o: Record<string, unknown>) =>
      JSON.stringify({ sessionId: 'claude-long', cwd: project, ...o });
    // Padding pushes the file past the 8 MB discovery head/tail window, so a
    // spliced read would drop the middle user prompt below.
    const padding = 'x'.repeat(5 * 1024 * 1024);
    writeFileSync(
      join(dir, 'claude-long.jsonl'),
      [
        line({ type: 'user', timestamp: at(0), message: { role: 'user', content: 'First prompt' } }),
        // Claude Code writes one line per content block of a single API message.
        line({
          type: 'assistant',
          timestamp: at(1),
          message: {
            role: 'assistant',
            model: 'claude-opus',
            content: [{ type: 'thinking', thinking: 'Plan the change.' }],
          },
        }),
        line({
          type: 'assistant',
          timestamp: at(2),
          message: {
            role: 'assistant',
            content: [{ type: 'text', text: 'Reading the file.' }],
          },
        }),
        line({
          type: 'assistant',
          timestamp: at(3),
          message: {
            role: 'assistant',
            content: [{ type: 'tool_use', id: 'call_1', name: 'Read', input: { path: 'a.ts' } }],
          },
        }),
        line({
          type: 'user',
          timestamp: at(4),
          message: {
            role: 'user',
            content: [{ type: 'tool_result', tool_use_id: 'call_1', content: padding }],
          },
        }),
        // A step-local id reused later in the same turn is a different call.
        line({
          type: 'assistant',
          timestamp: at(5),
          message: {
            role: 'assistant',
            content: [{ type: 'tool_use', id: 'call_1', name: 'Edit', input: { path: 'a.ts' } }],
          },
        }),
        line({
          type: 'user',
          timestamp: at(6),
          message: {
            role: 'user',
            content: [{ type: 'tool_result', tool_use_id: 'call_1', content: 'edited', is_error: false }],
          },
        }),
        line({
          type: 'assistant',
          timestamp: at(7),
          message: { role: 'assistant', content: [{ type: 'text', text: 'Done with step one.' }] },
        }),
        line({ type: 'user', timestamp: at(8), message: { role: 'user', content: 'Middle prompt' } }),
        line({
          type: 'user',
          timestamp: at(9),
          message: { role: 'user', content: '<task-notification>bg task done</task-notification>' },
        }),
        line({
          type: 'user',
          timestamp: at(10),
          message: {
            role: 'user',
            content: [{ type: 'tool_result', tool_use_id: 'orphan', content: padding }],
          },
        }),
        line({
          type: 'assistant',
          timestamp: at(11),
          message: { role: 'assistant', content: [{ type: 'text', text: 'Final answer.' }] },
        }),
      ].join('\n'),
    );

    const discovered = discoverCliChats({ homeDir, env: {} }).projects
      .flatMap((g) => g.chats)
      .find((c) => c.id === 'claude:claude-long');
    expect(discovered).toBeDefined();
    // Discovery samples never carry structured turn data.
    for (const sample of discovered!.sampleMessages) {
      expect(Object.keys(sample).sort()).toEqual(
        expect.arrayContaining(['content', 'createdAt', 'role']),
      );
      expect((sample as unknown as Record<string, unknown>).events).toBeUndefined();
    }

    const { stored } = await importOne(homeDir, 'claude:claude-long');
    expect(stored.map((m) => [m.role, m.content])).toEqual([
      ['user', 'First prompt'],
      ['assistant', 'Reading the file.\n\nDone with step one.'],
      ['user', 'Middle prompt'],
      ['assistant', 'Final answer.'],
    ]);
    const turn = stored[1];
    expect((turn.parts as Part[]).map((p) => p.kind)).toEqual([
      'reasoning',
      'text',
      'tool',
      'tool',
      'text',
    ]);
    const tools = toolParts(turn.parts);
    expect(tools.map((t) => t.name)).toEqual(['Read', 'Edit']);
    expect(tools[0].output).toContain('truncated');
    expect(tools[1].output).toBe('edited');
    // Reasoning is display-only: never persisted as provider replay input.
    expect(turn.reasoningContent).toBeUndefined();
    // Strictly increasing timestamps keep source order under any time sort.
    for (let i = 1; i < stored.length; i++) {
      expect(stored[i].createdAt).toBeGreaterThan(stored[i - 1].createdAt);
    }
  });

  it("imports only a Devin session's main conversation tree, deduplicated, without summarizer prompts", async () => {
    const homeDir = makeTempHome();
    const project = join(homeDir, 'workspace', 'devin');
    mkdirSync(project, { recursive: true });
    const devinDir = join(homeDir, '.local', 'share', 'devin', 'cli');
    mkdirSync(devinDir, { recursive: true });
    const db = new Database(join(devinDir, 'sessions.db'));
    db.run(`
      CREATE TABLE sessions (id TEXT PRIMARY KEY, working_directory TEXT, model TEXT,
        created_at INTEGER, last_activity_at INTEGER, title TEXT, main_chain_id INTEGER,
        hidden INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE message_nodes (row_id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT,
        node_id INTEGER, parent_node_id INTEGER, chat_message TEXT, created_at INTEGER);
    `);
    const input = { is_user_input: 1 };
    const notInput = { is_user_input: null };
    const nodes: Array<[number, number | null, Record<string, unknown>]> = [
      // Main tree (root 0), pre-compaction branch.
      [0, null, { message_id: 'sys', role: 'system', content: 'You are Devin' }],
      [1, 0, { message_id: 'u1', role: 'user', content: 'Fix the build', metadata: input }],
      [
        2,
        1,
        {
          message_id: 'a1',
          role: 'assistant',
          content: 'Looking.',
          thinking: { thinking: 'Check the config first.' },
          tool_calls: [{ id: 't1', name: 'exec', arguments: { command: 'ls' } }],
        },
      ],
      [3, 2, { message_id: 'r1', role: 'tool', tool_call_id: 't1', content: 'package.json' }],
      [4, 3, { message_id: 'a2', role: 'assistant', content: 'Fixed it.' }],
      // Sidekick subagent tree: not the user's conversation.
      [5, null, { message_id: 'sk-sys', role: 'system', content: 'You are the Sidekick' }],
      [6, 5, { message_id: 'sk-u', role: 'user', content: 'Handoff from the lead', metadata: input }],
      [7, 6, { message_id: 'sk-a', role: 'assistant', content: 'Sidekick reply' }],
      // Summarizer run: a separate tree with prompts that are user-role rows.
      [8, null, { message_id: 'sum-sys', role: 'system', content: 'You are a Summarizer' }],
      [9, 8, { message_id: 'sum-u', role: 'user', content: 'Conversation to summarize: …', metadata: notInput }],
      // Compaction re-roots the main conversation and repeats earlier rows.
      [10, 0, { message_id: 'cont', role: 'system', content: 'You are continuing work…' }],
      [11, 10, { message_id: 'u1', role: 'user', content: 'Fix the build', metadata: input }],
      [12, 11, { message_id: 'a2', role: 'assistant', content: 'Fixed it.' }],
      [13, 12, { message_id: 'u2', role: 'user', content: 'Now ship it', metadata: input }],
      [14, 13, { message_id: 'a3', role: 'assistant', content: 'Shipped.' }],
    ];
    const insert = db.query(
      `INSERT INTO message_nodes (session_id, node_id, parent_node_id, chat_message, created_at)
       VALUES ('dv-1', ?, ?, ?, ?)`,
    );
    for (const [nodeId, parent, msg] of nodes) {
      insert.run(nodeId, parent, JSON.stringify(msg), 1760200000 + nodeId);
    }
    db.query(
      `INSERT INTO sessions (id, working_directory, model, created_at, last_activity_at, title, main_chain_id)
       VALUES ('dv-1', ?, 'swe', 1760200000, 1760200014, 'Fix the build', 14)`,
    ).run(project);
    db.close();

    const { stored } = await importOne(homeDir, 'devin:dv-1');
    expect(stored.map((m) => [m.role, m.content])).toEqual([
      ['user', 'Fix the build'],
      ['assistant', 'Looking.\n\nFixed it.'],
      ['user', 'Now ship it'],
      ['assistant', 'Shipped.'],
    ]);
    const parts = stored[1].parts as Part[];
    // The Sidekick tree and the Summarizer run come along nested under
    // synthetic sub-agent rows where they ran, never as top-level messages.
    expect(parts.map((p) => p.kind)).toEqual(['reasoning', 'text', 'tool', 'text', 'tool', 'tool']);
    expect(toolParts(parts)[0]).toMatchObject({ name: 'exec', output: 'package.json' });
    const nested = toolParts(parts).slice(1) as Array<Part & { subagent?: { name: string; turns: unknown[] } }>;
    expect(nested.map((t) => [t.name, t.subagent?.name])).toEqual([
      ['subagent', 'subagent'],
      ['subagent', 'Context compaction'],
    ]);
    expect(JSON.stringify(nested[0].subagent)).toContain('Sidekick reply');
    expect(JSON.stringify(nested[1].subagent)).toContain('Conversation to summarize');
  });

  it('imports a Freebuff chat from its UI transcript, not the compacted run state', async () => {
    const homeDir = makeTempHome();
    const project = join(homeDir, 'workspace', 'fb');
    mkdirSync(project, { recursive: true });
    const chatDir = join(homeDir, '.config', 'manicode', 'projects', 'fb', 'chats', '2026-10-01T10-00-00.000Z');
    mkdirSync(chatDir, { recursive: true });
    writeFileSync(
      join(chatDir, 'chat-meta.json'),
      JSON.stringify({ messageCount: 5, firstPrompt: 'Add providers' }),
    );
    // After compaction run-state only knows the latest prompt.
    writeFileSync(
      join(chatDir, 'run-state.json'),
      JSON.stringify({
        projectRoot: project,
        sessionState: {
          mainAgentState: {
            messageHistory: [
              { role: 'user', tags: ['USER_PROMPT'], sentAt: 1790000100000, content: 'Ship it' },
            ],
          },
        },
      }),
    );
    writeFileSync(
      join(chatDir, 'chat-messages.json'),
      JSON.stringify([
        { id: 'divider-1790000000000', variant: 'ai', blocks: [{ type: 'mode-divider', mode: 'LITE' }] },
        { id: 'user-1790000000000', variant: 'user', content: 'Add providers' },
        {
          id: 'ai-1790000001000-abc',
          variant: 'ai',
          content: '',
          blocks: [
            { type: 'text', textType: 'reasoning', content: 'Search first.' },
            { type: 'text', textType: 'text', content: 'Searching.' },
            { type: 'tool', toolCallId: 'tc1', toolName: 'web_search', input: { query: 'x' }, output: 'results' },
            { type: 'agent', agentId: 'ag1', agentName: 'code-searcher', agentType: 'code-searcher', content: 'found 3', status: 'complete', blocks: [] },
            { type: 'text', textType: 'text', content: 'Added them.' },
          ],
        },
        { id: 'user-1790000100000', variant: 'user', content: 'Ship it' },
        { id: 'ai-1790000101000-def', variant: 'ai', blocks: [{ type: 'text', content: 'Shipped.' }] },
      ]),
    );

    const { stored } = await importOne(homeDir, 'freebuff:fb/2026-10-01T10-00-00.000Z');
    expect(stored.map((m) => [m.role, m.content])).toEqual([
      ['user', 'Add providers'],
      ['assistant', 'Searching.\n\nAdded them.'],
      ['user', 'Ship it'],
      ['assistant', 'Shipped.'],
    ]);
    expect(stored[0].createdAt).toBe(1790000000000);
    expect(stored[2].createdAt).toBe(1790000100000);
    const parts = stored[1].parts as Part[];
    expect(parts.map((p) => p.kind)).toEqual(['reasoning', 'text', 'tool', 'tool', 'text']);
    expect(toolParts(parts).map((t) => [t.name, t.output])).toEqual([
      ['web_search', 'results'],
      ['code-searcher', 'found 3'],
    ]);
  });

  it('discovers Codex threads when the history store is an unreadable WAL database, and imports compressed rollouts', async () => {
    const homeDir = makeTempHome();
    const project = join(homeDir, 'workspace', 'cx');
    mkdirSync(project, { recursive: true });
    const codexDir = join(homeDir, '.codex');
    mkdirSync(codexDir, { recursive: true });
    const rolloutPath = join(codexDir, 'sessions', 'rollout-cx-1.jsonl');
    mkdirSync(join(codexDir, 'sessions'), { recursive: true });

    const state = new Database(join(codexDir, 'state_5.sqlite'));
    state.run(`CREATE TABLE threads (id TEXT PRIMARY KEY, rollout_path TEXT, created_at INTEGER,
      updated_at INTEGER, cwd TEXT, title TEXT, first_user_message TEXT, archived INTEGER DEFAULT 0,
      model TEXT, created_at_ms INTEGER, updated_at_ms INTEGER)`);
    state
      .query(
        `INSERT INTO threads (id, rollout_path, cwd, title, first_user_message, model, created_at_ms, updated_at_ms)
         VALUES ('cx-1', ?, ?, 'Port the parser', 'Port the parser', 'gpt-6', 1760100000000, 1760100060000)`,
      )
      .run(rolloutPath, project);
    state.close();

    // A WAL-mode store whose -shm sidecar is gone: a read-only open fails at
    // the first prepare. This used to abort the whole Codex scan (0 chats).
    const historyPath = join(codexDir, 'thread_history_1.sqlite');
    const history = new Database(historyPath);
    history.run('PRAGMA journal_mode = WAL');
    history.run(`CREATE TABLE thread_items (thread_id TEXT, rollout_ordinal INTEGER,
      created_at_ms INTEGER, item_type TEXT, item_json TEXT)`);
    history.close();
    rmSync(`${historyPath}-shm`, { force: true });
    rmSync(`${historyPath}-wal`, { force: true });

    const ts = (s: number) => new Date(1760100000000 + s * 1000).toISOString();
    const rollout = [
      { timestamp: ts(0), type: 'session_meta', payload: { cwd: project } },
      {
        timestamp: ts(1),
        type: 'response_item',
        payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '<environment_context>cwd</environment_context>' }] },
      },
      {
        timestamp: ts(2),
        type: 'response_item',
        payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Port the parser' }] },
      },
      {
        timestamp: ts(3),
        type: 'response_item',
        payload: { type: 'reasoning', summary: [{ type: 'summary_text', text: 'Inspect first' }] },
      },
      {
        timestamp: ts(4),
        type: 'response_item',
        payload: { type: 'function_call', call_id: 'c1', name: 'exec_command', arguments: '{"cmd":"ls"}' },
      },
      {
        timestamp: ts(5),
        type: 'response_item',
        payload: { type: 'function_call_output', call_id: 'c1', output: 'parser.ts' },
      },
      {
        timestamp: ts(6),
        type: 'response_item',
        payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Ported.' }] },
      },
      {
        timestamp: ts(7),
        type: 'response_item',
        payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '<turn_aborted>\ninterrupted' }] },
      },
    ]
      .map((entry) => JSON.stringify(entry))
      .join('\n');
    // Codex compresses finished rollouts and keeps the uncompressed name in the DB.
    writeFileSync(`${rolloutPath}.zst`, Bun.zstdCompressSync(Buffer.from(rollout)));

    const chats = discoverCliChats({ homeDir, env: {} }).projects.flatMap((g) => g.chats);
    expect(chats.map((c) => c.id)).toContain('codex:cx-1');

    const { stored } = await importOne(homeDir, 'codex:cx-1');
    expect(stored.map((m) => [m.role, m.content])).toEqual([
      ['user', 'Port the parser'],
      ['assistant', 'Ported.'],
    ]);
    const parts = stored[1].parts as Part[];
    expect(parts.map((p) => p.kind)).toEqual(['reasoning', 'tool', 'text']);
    expect(toolParts(parts)[0]).toMatchObject({ name: 'exec_command', output: 'parser.ts' });
  });

  it('imports every step of a long OpenCode session with step-local tool ids kept distinct', async () => {
    const homeDir = makeTempHome();
    const project = join(homeDir, 'workspace', 'oc');
    mkdirSync(project, { recursive: true });
    const ocDir = join(homeDir, '.local', 'share', 'opencode');
    mkdirSync(ocDir, { recursive: true });
    const db = new Database(join(ocDir, 'opencode.db'));
    db.run(`
      CREATE TABLE session (id TEXT PRIMARY KEY, directory TEXT, title TEXT, parent_id TEXT,
        time_created INTEGER, time_updated INTEGER, time_archived INTEGER);
      CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, data TEXT);
      CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT, session_id TEXT, time_created INTEGER, data TEXT);
    `);
    db.query(
      `INSERT INTO session VALUES ('ses_1', ?, 'Long run', NULL, 1760000000000, 1760009999000, NULL)`,
    ).run(project);
    const msg = db.query(`INSERT INTO message VALUES (?, 'ses_1', ?, ?)`);
    const part = db.query(`INSERT INTO part VALUES (?, ?, 'ses_1', ?, ?)`);
    let t = 1760000000000;
    let partId = 0;
    msg.run('m_user', t, JSON.stringify({ role: 'user' }));
    part.run(`p${partId++}`, 'm_user', t, JSON.stringify({ type: 'text', text: 'Run the experiment' }));
    // 600 assistant steps, each with step parts and a tool whose id restarts at call_0.
    const steps = 600;
    for (let i = 0; i < steps; i++) {
      t += 10;
      const id = `m_a${String(i).padStart(4, '0')}`;
      msg.run(id, t, JSON.stringify({ role: 'assistant', modelID: 'zen-1' }));
      part.run(`p${partId++}`, id, t, JSON.stringify({ type: 'step-start' }));
      part.run(
        `p${partId++}`,
        id,
        t + 1,
        JSON.stringify({
          type: 'tool',
          tool: 'bash',
          callID: 'call_0',
          state: { status: 'completed', input: { command: `step ${i}` }, output: `ok ${i}` },
        }),
      );
      part.run(`p${partId++}`, id, t + 2, JSON.stringify({ type: 'step-finish' }));
    }
    t += 10;
    msg.run('m_final', t, JSON.stringify({ role: 'assistant', modelID: 'zen-1' }));
    part.run(`p${partId++}`, 'm_final', t, JSON.stringify({ type: 'text', text: 'All steps done.' }));
    db.close();

    const discovered = discoverCliChats({ homeDir, env: {} }).projects
      .flatMap((g) => g.chats)
      .find((c) => c.id === 'opencodezen:ses_1');
    expect(discovered?.messageCount).toBe(2);

    const { stored } = await importOne(homeDir, 'opencodezen:ses_1');
    expect(stored.map((m) => [m.role, m.content])).toEqual([
      ['user', 'Run the experiment'],
      ['assistant', 'All steps done.'],
    ]);
    const tools = toolParts(stored[1].parts);
    expect(tools).toHaveLength(steps);
    expect(tools[steps - 1].output).toBe(`ok ${steps - 1}`);
  });
});

describe('CLI chat import: honest time, whole data and nested sub-agents', () => {
  type Sub = { agentId?: string; name: string; task?: string; turns: Array<Record<string, unknown>> };
  type Part = {
    kind: string;
    text?: string;
    name?: string;
    callId?: string;
    input?: Record<string, unknown>;
    output?: string;
    startedAt?: number;
    endedAt?: number;
    durationMs?: number;
    timeUnknown?: true;
    subagent?: Sub;
  };

  async function importOne(homeDir: string, chatId: string) {
    const result = await importCliChats({ chatIds: [chatId] }, { homeDir, env: {} });
    for (const s of result.sessions) createdSessionIds.push(s.id);
    expect(result.importedCount).toBe(1);
    const stored = await new MessageStore().getAll(result.items[0].sessionId);
    return { item: result.items[0], stored };
  }

  const partsOf = (m: { parts?: unknown }) => (m.parts as Part[] | undefined) ?? [];
  const toolsOf = (m: { parts?: unknown }) => partsOf(m).filter((p) => p.kind === 'tool');
  const subTexts = (sub: Sub | undefined): string[] =>
    (sub?.turns ?? []).flatMap((turn) =>
      turn.role === 'user'
        ? [String(turn.text)]
        : ((turn.parts as Part[]) ?? []).filter((p) => p.kind === 'text').map((p) => String(p.text)),
    );

  function deepValue(depth: number): Record<string, unknown> {
    return depth === 0 ? { leaf: 'bottom' } : { level: depth, child: deepValue(depth - 1) };
  }

  it('Claude: keeps source times, marks missing ones unknown, and imports outputs and inputs whole', async () => {
    const homeDir = makeTempHome();
    const project = join(homeDir, 'workspace', 'time');
    mkdirSync(project, { recursive: true });
    const dir = join(homeDir, '.claude', 'projects', '-workspace-time');
    mkdirSync(dir, { recursive: true });
    const base = Date.parse('2026-10-11T10:00:00.000Z');
    const at = (s: number) => new Date(base + s * 1000).toISOString();
    const line = (o: Record<string, unknown>) => JSON.stringify({ sessionId: 'claude-time', cwd: project, ...o });
    const bigOutput = 'o'.repeat(50_000);
    const bigInput = {
      command: 'c'.repeat(10_000),
      nested: deepValue(12),
      items: Array.from({ length: 500 }, (_, i) => ({ i, tag: `item-${i}` })),
    };
    writeFileSync(
      join(dir, 'claude-time.jsonl'),
      [
        line({ type: 'user', timestamp: at(0), message: { role: 'user', content: 'Start' } }),
        line({
          type: 'assistant',
          timestamp: at(5),
          thinkingDurationMs: 1500,
          message: { role: 'assistant', content: [{ type: 'thinking', thinking: 'Plan it.' }] },
        }),
        line({
          type: 'assistant',
          timestamp: at(6),
          message: { role: 'assistant', content: [{ type: 'tool_use', id: 'tu1', name: 'Bash', input: bigInput }] },
        }),
        line({
          type: 'user',
          timestamp: at(8.5),
          message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu1', content: bigOutput }] },
        }),
        line({ type: 'assistant', timestamp: at(9), message: { role: 'assistant', content: [{ type: 'text', text: 'Done.' }] } }),
        // The source recorded no time for this prompt.
        line({ type: 'user', message: { role: 'user', content: 'Untimed follow-up' } }),
        // Thinking without a recorded duration.
        line({ type: 'assistant', timestamp: at(20), message: { role: 'assistant', content: [{ type: 'thinking', thinking: 'Hmm.' }] } }),
        // A call line without a time: its duration cannot be known.
        line({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'tu2', name: 'Read', input: { path: 'x' } }] } }),
        line({
          type: 'user',
          timestamp: at(22),
          message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu2', content: 'contents' }] },
        }),
        line({ type: 'assistant', timestamp: at(23), message: { role: 'assistant', content: [{ type: 'text', text: 'Final.' }] } }),
      ].join('\n'),
    );

    const { stored } = await importOne(homeDir, 'claude:claude-time');
    expect(stored.map((m) => [m.role, m.content])).toEqual([
      ['user', 'Start'],
      ['assistant', 'Done.'],
      ['user', 'Untimed follow-up'],
      ['assistant', 'Final.'],
    ]);
    expect(stored.map((m) => m.timeUnknown === true)).toEqual([false, false, true, false]);
    expect(stored[0].createdAt).toBe(base);
    // The unknown row is only ordered: strictly between its known neighbours.
    expect(stored[2].createdAt).toBeGreaterThan(stored[1].createdAt);
    expect(stored[2].createdAt).toBeLessThan(stored[3].createdAt);

    const [reasoning, tool] = partsOf(stored[1]);
    expect(reasoning).toMatchObject({ kind: 'reasoning', text: 'Plan it.' });
    expect(reasoning.timeUnknown).toBeUndefined();
    expect((reasoning.endedAt ?? 0) - (reasoning.startedAt ?? 0)).toBe(1500);
    expect(tool).toMatchObject({ kind: 'tool', name: 'Bash', durationMs: 2500 });
    expect(tool.timeUnknown).toBeUndefined();
    // No truncation: the 50,000-character output and the deep, wide input are intact.
    expect(tool.output).toBe(bigOutput);
    expect(tool.input).toEqual(bigInput);

    const [reasoning2, tool2] = partsOf(stored[3]);
    expect(reasoning2).toMatchObject({ kind: 'reasoning', text: 'Hmm.', timeUnknown: true });
    expect(tool2).toMatchObject({ kind: 'tool', name: 'Read', output: 'contents', timeUnknown: true });
    expect(tool2.durationMs).toBeUndefined();
  });

  it('Claude: nests sub-agent files, sidechains and compactions under the calls that ran them', async () => {
    const homeDir = makeTempHome();
    const project = join(homeDir, 'workspace', 'subs');
    mkdirSync(project, { recursive: true });
    const dir = join(homeDir, '.claude', 'projects', '-workspace-subs');
    const subDir = join(dir, 'claude-subs', 'subagents');
    mkdirSync(subDir, { recursive: true });
    const base = Date.parse('2026-10-12T10:00:00.000Z');
    const at = (s: number) => new Date(base + s * 1000).toISOString();
    const line = (o: Record<string, unknown>) => JSON.stringify({ sessionId: 'claude-subs', cwd: project, ...o });
    writeFileSync(
      join(dir, 'claude-subs.jsonl'),
      [
        line({ type: 'user', timestamp: at(0), message: { role: 'user', content: 'Investigate' } }),
        line({
          type: 'assistant',
          timestamp: at(1),
          message: {
            role: 'assistant',
            content: [{ type: 'tool_use', id: 'toolu_A', name: 'Agent', input: { description: 'Find files', prompt: 'Find the files' } }],
          },
        }),
        line({
          type: 'user',
          timestamp: at(30),
          toolUseResult: { agentId: 'a1', status: 'completed' },
          message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_A', content: 'Found 3 files' }] },
        }),
        // Old format: the sub-agent's rows live in the main file as a sidechain.
        line({
          type: 'assistant',
          timestamp: at(31),
          message: {
            role: 'assistant',
            content: [{ type: 'tool_use', id: 'toolu_C', name: 'Task', input: { description: 'Side', prompt: 'Side prompt' } }],
          },
        }),
        line({ type: 'user', isSidechain: true, uuid: 's1', parentUuid: null, timestamp: at(32), message: { role: 'user', content: 'Side prompt' } }),
        line({
          type: 'assistant',
          isSidechain: true,
          uuid: 's2',
          parentUuid: 's1',
          timestamp: at(33),
          message: { role: 'assistant', content: [{ type: 'text', text: 'Side answer' }] },
        }),
        line({
          type: 'user',
          timestamp: at(34),
          message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_C', content: 'Side answer' }] },
        }),
        line({
          type: 'system',
          subtype: 'api_error',
          uuid: 'err1',
          timestamp: at(35),
          retryAttempt: 1,
          maxRetries: 10,
          error: { formatted: "Can't reach the API server" },
        }),
        line({ type: 'assistant', timestamp: at(36), message: { role: 'assistant', content: [{ type: 'text', text: 'Summary for you.' }] } }),
        line({
          type: 'system',
          subtype: 'compact_boundary',
          uuid: 'cb1',
          timestamp: at(40),
          compactMetadata: { trigger: 'auto', preTokens: 900000, postTokens: 16000, durationMs: 86415 },
        }),
        line({
          type: 'user',
          isCompactSummary: true,
          timestamp: at(41),
          message: { role: 'user', content: 'This session is being continued. Summary: investigated files.' },
        }),
        line({ type: 'user', timestamp: at(50), message: { role: 'user', content: 'Next step' } }),
        line({ type: 'assistant', timestamp: at(51), message: { role: 'assistant', content: [{ type: 'text', text: 'On it.' }] } }),
      ].join('\n'),
    );
    const subLine = (agentId: string, o: Record<string, unknown>) =>
      JSON.stringify({ sessionId: 'claude-subs', cwd: project, isSidechain: true, agentId, ...o });
    writeFileSync(
      join(subDir, 'agent-a1.jsonl'),
      [
        subLine('a1', { type: 'user', timestamp: at(2), message: { role: 'user', content: 'Find the files' } }),
        subLine('a1', {
          type: 'assistant',
          timestamp: at(3),
          message: { role: 'assistant', model: 'claude-haiku', content: [{ type: 'tool_use', id: 'toolu_B', name: 'Agent', input: { prompt: 'Look deeper' } }] },
        }),
        subLine('a1', {
          type: 'user',
          timestamp: at(20),
          toolUseResult: { agentId: 'a2' },
          message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_B', content: 'Deep result' }] },
        }),
        subLine('a1', { type: 'assistant', timestamp: at(29), message: { role: 'assistant', content: [{ type: 'text', text: 'Found 3 files' }] } }),
      ].join('\n'),
    );
    writeFileSync(join(subDir, 'agent-a1.meta.json'), JSON.stringify({ agentType: 'Explore', toolUseId: 'toolu_A', description: 'Find files' }));
    writeFileSync(
      join(subDir, 'agent-a2.jsonl'),
      [
        subLine('a2', { type: 'user', timestamp: at(4), message: { role: 'user', content: 'Look deeper' } }),
        subLine('a2', { type: 'assistant', timestamp: at(19), message: { role: 'assistant', content: [{ type: 'text', text: 'Deep result' }] } }),
      ].join('\n'),
    );
    writeFileSync(join(subDir, 'agent-a2.meta.json'), JSON.stringify({ agentType: 'general-purpose', toolUseId: 'toolu_B' }));
    // A sub-agent no call claims still comes along, as a synthetic row.
    writeFileSync(
      join(subDir, 'agent-a3.jsonl'),
      [
        subLine('a3', { type: 'user', timestamp: at(52), message: { role: 'user', content: 'Orphan task' } }),
        subLine('a3', { type: 'assistant', timestamp: at(53), message: { role: 'assistant', content: [{ type: 'text', text: 'Orphan answer' }] } }),
      ].join('\n'),
    );

    const { stored } = await importOne(homeDir, 'claude:claude-subs');
    // Sub-agent conversations and the compaction summary never become top-level rows.
    expect(stored.map((m) => [m.role, m.content])).toEqual([
      ['user', 'Investigate'],
      ['assistant', 'Summary for you.'],
      ['user', 'Next step'],
      ['assistant', 'On it.'],
    ]);
    const tools = toolsOf(stored[1]);
    expect(tools.map((t) => t.name)).toEqual(['Agent', 'Task', 'notice', 'subagent']);

    const explore = tools[0].subagent;
    expect(explore).toMatchObject({ agentId: 'a1', name: 'Explore', task: 'Find files', model: 'claude-haiku' });
    expect(subTexts(explore)).toEqual(['Find the files', 'Found 3 files']);
    const nestedTool = (explore?.turns[1].parts as Part[]).find((p) => p.kind === 'tool');
    expect(nestedTool?.subagent).toMatchObject({ agentId: 'a2', name: 'general-purpose' });
    expect(subTexts(nestedTool?.subagent)).toEqual(['Look deeper', 'Deep result']);
    expect(explore?.turns[0].createdAt).toBe(base + 2000);

    expect(subTexts(tools[1].subagent)).toEqual(['Side prompt', 'Side answer']);
    expect(tools[2]).toMatchObject({ input: { kind: 'api_error' }, timeUnknown: true });
    expect(tools[2].output).toContain("Can't reach the API server");

    expect(tools[3].subagent?.name).toBe('Context compaction');
    expect(tools[3].durationMs).toBe(86415);
    expect(tools[3].output).toContain('Summary: investigated files.');

    const orphan = toolsOf(stored[3]).find((t) => t.name === 'subagent');
    expect(orphan?.callId).toBe('subagent:a3');
    expect(orphan?.input).toEqual({ task: 'Orphan task' });
    expect(orphan?.output).toBe('Orphan answer');
  });

  it('Devin: nests sub-agent branches under their spawning call and summarizer runs as compaction', async () => {
    const homeDir = makeTempHome();
    const project = join(homeDir, 'workspace', 'devin-subs');
    mkdirSync(project, { recursive: true });
    const devinDir = join(homeDir, '.local', 'share', 'devin', 'cli');
    mkdirSync(devinDir, { recursive: true });
    const db = new Database(join(devinDir, 'sessions.db'));
    db.run(`
      CREATE TABLE sessions (id TEXT PRIMARY KEY, working_directory TEXT, model TEXT,
        created_at INTEGER, last_activity_at INTEGER, title TEXT, main_chain_id INTEGER,
        hidden INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE message_nodes (row_id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT,
        node_id INTEGER, parent_node_id INTEGER, chat_message TEXT, created_at INTEGER);
    `);
    const iso = (s: number) => new Date(Date.parse('2026-10-13T10:00:00.000Z') + s * 1000).toISOString();
    const meta = (s: number, extra: Record<string, unknown> = {}) => ({ created_at: iso(s), ...extra });
    const task = 'Audit the parser and report gaps.';
    const nodes: Array<[number, number | null, Record<string, unknown>]> = [
      [0, null, { message_id: 'sys', role: 'system', content: 'You are Devin' }],
      [1, 0, { message_id: 'u1', role: 'user', content: 'Audit it', metadata: meta(0, { is_user_input: true }) }],
      [
        2,
        1,
        {
          message_id: 'a1',
          role: 'assistant',
          content: 'Delegating.',
          thinking: { thinking: 'A sub-agent should do this.' },
          tool_calls: [
            { id: 't1', name: 'run_subagent', arguments: { title: 'Parser audit', task } },
            { id: 't2', name: 'exec', arguments: { command: 'ls' } },
          ],
          metadata: meta(1),
        },
      ],
      [
        3,
        2,
        {
          message_id: 'r1',
          role: 'tool',
          tool_call_id: 't1',
          content: 'Background subagent started with agent_id=ag1.',
          metadata: meta(2, {
            extensions: {
              'subagent/agent_id': 'ag1',
              'chisel/tool_call_timing': { started_at: iso(1), finished_at: iso(2), duration_ms: 12 },
            },
          }),
        },
      ],
      // No timing recorded for this tool.
      [4, 3, { message_id: 'r2', role: 'tool', tool_call_id: 't2', content: 'a.ts', metadata: meta(3) }],
      [5, 4, { message_id: 'a2', role: 'assistant', content: 'The audit is running.', metadata: meta(4) }],
      // The sub-agent's own tree.
      [10, null, { message_id: 'sa-sys', role: 'system', content: 'You are a subagent of Devin' }],
      [
        11,
        10,
        {
          message_id: 'sa-task',
          role: 'user',
          content: task,
          metadata: meta(2, { is_user_input: true, telemetry: { source: 'subagent_task', operation: 'prompt' } }),
        },
      ],
      [12, 11, { message_id: 'sa-a', role: 'assistant', content: 'Found two gaps.', metadata: meta(30) }],
      // A Summarizer run.
      [20, null, { message_id: 'sum-sys', role: 'system', content: '  You are a Summarizer that summarizes' }],
      [21, 20, { message_id: 'sum-u', role: 'user', content: 'Conversation to summarize: …', metadata: meta(3.5, { is_user_input: null }) }],
      [22, 21, { message_id: 'sum-a', role: 'assistant', content: 'Summary of the work.', metadata: meta(3.6) }],
    ];
    const insert = db.query(
      `INSERT INTO message_nodes (session_id, node_id, parent_node_id, chat_message, created_at)
       VALUES ('dv-subs', ?, ?, ?, ?)`,
    );
    for (const [nodeId, parent, msg] of nodes) insert.run(nodeId, parent, JSON.stringify(msg), 1792000000 + nodeId);
    db.query(
      `INSERT INTO sessions (id, working_directory, model, created_at, last_activity_at, title, main_chain_id)
       VALUES ('dv-subs', ?, 'swe', 1792000000, 1792000100, 'Audit it', 5)`,
    ).run(project);
    db.close();

    const { stored } = await importOne(homeDir, 'devin:dv-subs');
    expect(stored.map((m) => [m.role, m.content])).toEqual([
      ['user', 'Audit it'],
      ['assistant', 'Delegating.\n\nThe audit is running.'],
    ]);
    const parts = partsOf(stored[1]);
    // Every block of a Devin message shares one timestamp: no reasoning duration.
    expect(parts[0]).toMatchObject({ kind: 'reasoning', timeUnknown: true });
    const tools = toolsOf(stored[1]);
    expect(tools.map((t) => t.name)).toEqual(['run_subagent', 'exec', 'subagent']);
    expect(tools[0]).toMatchObject({ durationMs: 12 });
    expect(tools[0].timeUnknown).toBeUndefined();
    expect(tools[0].subagent).toMatchObject({ agentId: 'ag1', name: 'Parser audit', task });
    expect(subTexts(tools[0].subagent)).toEqual([task, 'Found two gaps.']);
    expect(tools[1]).toMatchObject({ output: 'a.ts', timeUnknown: true });
    expect(tools[1].durationMs).toBeUndefined();
    expect(tools[2].subagent?.name).toBe('Context compaction');
    expect(subTexts(tools[2].subagent)).toEqual(['Conversation to summarize: …', 'Summary of the work.']);
  });

  it('OpenCode: nests a task tool child session and keeps recorded reasoning and tool timing', async () => {
    const homeDir = makeTempHome();
    const project = join(homeDir, 'workspace', 'oc-subs');
    mkdirSync(project, { recursive: true });
    const ocDir = join(homeDir, '.local', 'share', 'opencode');
    mkdirSync(ocDir, { recursive: true });
    const db = new Database(join(ocDir, 'opencode.db'));
    db.run(`
      CREATE TABLE session (id TEXT PRIMARY KEY, directory TEXT, title TEXT, parent_id TEXT,
        time_created INTEGER, time_updated INTEGER, time_archived INTEGER);
      CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, data TEXT);
      CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT, session_id TEXT, time_created INTEGER, data TEXT);
    `);
    const t = 1760500000000;
    db.query(`INSERT INTO session VALUES ('ses_p', ?, 'Parent', NULL, ?, ?, NULL)`).run(project, t, t + 60000);
    db.query(`INSERT INTO session VALUES ('ses_c', ?, 'Explore code (@explore subagent)', 'ses_p', ?, ?, NULL)`).run(project, t + 2000, t + 9000);
    const msg = db.query(`INSERT INTO message VALUES (?, ?, ?, ?)`);
    const part = db.query(`INSERT INTO part VALUES (?, ?, ?, ?, ?)`);
    msg.run('m_u', 'ses_p', t, JSON.stringify({ role: 'user' }));
    part.run('p1', 'm_u', 'ses_p', t, JSON.stringify({ type: 'text', text: 'Explore the code' }));
    msg.run('m_a', 'ses_p', t + 1000, JSON.stringify({ role: 'assistant', modelID: 'zen-1' }));
    part.run('p2', 'm_a', 'ses_p', t + 1000, JSON.stringify({ type: 'reasoning', text: 'Delegate.', time: { start: t + 1000, end: t + 1400 } }));
    part.run(
      'p3',
      'm_a',
      'ses_p',
      t + 1500,
      JSON.stringify({
        type: 'tool',
        tool: 'task',
        callID: 'call_0',
        state: {
          status: 'completed',
          input: { description: 'Explore code', prompt: 'Map the modules', subagent_type: 'explore' },
          output: 'Modules mapped',
          metadata: { sessionId: 'ses_c' },
          time: { start: t + 1500, end: t + 9500 },
        },
      }),
    );
    part.run('p4', 'm_a', 'ses_p', t + 9600, JSON.stringify({ type: 'text', text: 'Mapped.' }));
    msg.run('c_u', 'ses_c', t + 2000, JSON.stringify({ role: 'user' }));
    part.run('c1', 'c_u', 'ses_c', t + 2000, JSON.stringify({ type: 'text', text: 'Map the modules' }));
    msg.run('c_a', 'ses_c', t + 3000, JSON.stringify({ role: 'assistant', modelID: 'zen-mini' }));
    part.run('c2', 'c_a', 'ses_c', t + 3000, JSON.stringify({ type: 'text', text: 'Modules mapped' }));
    db.close();

    const chats = discoverCliChats({ homeDir, env: {} }).projects.flatMap((g) => g.chats);
    expect(chats.map((c) => c.id)).toContain('opencodezen:ses_p');
    expect(chats.map((c) => c.id)).not.toContain('opencodezen:ses_c');

    const { stored } = await importOne(homeDir, 'opencodezen:ses_p');
    expect(stored.map((m) => [m.role, m.content])).toEqual([
      ['user', 'Explore the code'],
      ['assistant', 'Mapped.'],
    ]);
    const [reasoning, tool] = partsOf(stored[1]);
    expect(reasoning.timeUnknown).toBeUndefined();
    expect((reasoning.endedAt ?? 0) - (reasoning.startedAt ?? 0)).toBe(400);
    expect(tool).toMatchObject({ name: 'task', durationMs: 8000, output: 'Modules mapped' });
    expect(tool.subagent).toMatchObject({ agentId: 'ses_c', name: 'explore', task: 'Map the modules', model: 'zen-mini' });
    expect(subTexts(tool.subagent)).toEqual(['Map the modules', 'Modules mapped']);
    expect(tool.subagent?.turns[0].createdAt).toBe(t + 2000);
  });

  it('Codex: nests a spawned child thread under spawn_agent without its copied parent history', async () => {
    const homeDir = makeTempHome();
    const project = join(homeDir, 'workspace', 'cx-subs');
    mkdirSync(project, { recursive: true });
    const codexDir = join(homeDir, '.codex');
    mkdirSync(join(codexDir, 'sessions'), { recursive: true });
    const parentPath = join(codexDir, 'sessions', 'rollout-parent.jsonl');
    const childPath = join(codexDir, 'sessions', 'rollout-child.jsonl');
    const state = new Database(join(codexDir, 'state_5.sqlite'));
    state.run(`CREATE TABLE threads (id TEXT PRIMARY KEY, rollout_path TEXT, created_at INTEGER,
      updated_at INTEGER, cwd TEXT, title TEXT, first_user_message TEXT, archived INTEGER DEFAULT 0,
      model TEXT, created_at_ms INTEGER, updated_at_ms INTEGER, agent_nickname TEXT, agent_role TEXT,
      agent_path TEXT)`);
    state.run(`CREATE TABLE thread_spawn_edges (parent_thread_id TEXT NOT NULL,
      child_thread_id TEXT NOT NULL PRIMARY KEY, status TEXT NOT NULL)`);
    const insertThread = state.query(
      `INSERT INTO threads (id, rollout_path, cwd, title, first_user_message, model, created_at_ms, updated_at_ms,
         agent_nickname, agent_path) VALUES (?, ?, ?, ?, ?, 'gpt-6', ?, ?, ?, ?)`,
    );
    insertThread.run('px', parentPath, project, 'Plan the port', 'Plan the port', 1760200000000, 1760200090000, null, null);
    insertThread.run('cx', childPath, project, 'Audit', '', 1760200010000, 1760200050000, 'Ohm', '/root/audit');
    state.run(`INSERT INTO thread_spawn_edges VALUES ('px', 'cx', 'open')`);
    state.close();

    const ts = (s: number) => new Date(1760200000000 + s * 1000).toISOString();
    const userMsg = {
      type: 'message',
      id: 'msg_user_1',
      role: 'user',
      content: [{ type: 'input_text', text: 'Plan the port' }],
    };
    const write = (path: string, rows: Array<Record<string, unknown>>) =>
      writeFileSync(path, rows.map((row) => JSON.stringify(row)).join('\n'));
    write(parentPath, [
      { timestamp: ts(0), type: 'session_meta', payload: { cwd: project } },
      { timestamp: ts(1), type: 'response_item', payload: userMsg },
      {
        timestamp: ts(9),
        type: 'response_item',
        payload: { type: 'function_call', id: 'fc_1', call_id: 'call_s', name: 'spawn_agent', arguments: '{"task_name":"audit"}' },
      },
      {
        timestamp: ts(10),
        type: 'event_msg',
        payload: { type: 'item_completed', item: { type: 'SubAgentActivity', id: 'call_s', kind: 'started', agent_thread_id: 'cx' } },
      },
      {
        timestamp: ts(10),
        type: 'response_item',
        payload: { type: 'function_call_output', id: 'fco_1', call_id: 'call_s', output: '{"task_name":"/root/audit"}' },
      },
      {
        timestamp: ts(60),
        type: 'response_item',
        payload: { type: 'message', id: 'msg_a_1', role: 'assistant', content: [{ type: 'output_text', text: 'Planned.' }] },
      },
    ]);
    write(childPath, [
      { timestamp: ts(10), type: 'session_meta', payload: { cwd: project, forked_from_id: 'px' } },
      // Forked copy of the parent's history.
      { timestamp: ts(10), type: 'response_item', payload: userMsg },
      { timestamp: ts(12), type: 'response_item', payload: { type: 'reasoning', id: 'rs_c', summary: [{ type: 'summary_text', text: 'Check the build' }] } },
      {
        timestamp: ts(40),
        type: 'response_item',
        payload: { type: 'message', id: 'msg_c_1', role: 'assistant', content: [{ type: 'output_text', text: 'Audit report' }] },
      },
    ]);

    const chats = discoverCliChats({ homeDir, env: {} }).projects.flatMap((g) => g.chats);
    expect(chats.map((c) => c.id)).toContain('codex:px');
    // A spawned sub-agent thread is part of its parent, not a chat of its own.
    expect(chats.map((c) => c.id)).not.toContain('codex:cx');

    const { stored } = await importOne(homeDir, 'codex:px');
    expect(stored.map((m) => [m.role, m.content])).toEqual([
      ['user', 'Plan the port'],
      ['assistant', 'Planned.'],
    ]);
    const spawn = toolsOf(stored[1]).find((t) => t.name === 'spawn_agent');
    expect(spawn?.durationMs).toBe(1000);
    expect(spawn?.subagent).toMatchObject({ agentId: 'cx', name: 'Ohm', task: '/root/audit', provider: 'codex' });
    expect(subTexts(spawn?.subagent)).toEqual(['Audit report']);
    const childParts = spawn?.subagent?.turns[0].parts as Part[];
    // Codex reasoning items record when they were written, not how long they took.
    expect(childParts[0]).toMatchObject({ kind: 'reasoning', text: 'Check the build', timeUnknown: true });
  });

  it('Freebuff: nests agent blocks recursively and marks untimed rows and tools unknown', async () => {
    const homeDir = makeTempHome();
    const project = join(homeDir, 'workspace', 'fb-subs');
    mkdirSync(project, { recursive: true });
    const chatDir = join(homeDir, '.config', 'manicode', 'projects', 'fb-subs', 'chats', '2026-10-02T10-00-00.000Z');
    mkdirSync(chatDir, { recursive: true });
    writeFileSync(join(chatDir, 'chat-meta.json'), JSON.stringify({ messageCount: 3, firstPrompt: 'Search' }));
    writeFileSync(join(chatDir, 'run-state.json'), JSON.stringify({ projectRoot: project }));
    writeFileSync(
      join(chatDir, 'chat-messages.json'),
      JSON.stringify([
        { id: 'user-1790100000000', variant: 'user', content: 'Search', textAttachments: [{ content: 'pasted spec' }] },
        {
          id: 'ai-1790100001000-a',
          variant: 'ai',
          blocks: [
            {
              type: 'agent',
              agentId: 'outer',
              agentType: 'code-searcher',
              initialPrompt: 'Find usages',
              content: 'Outer done',
              status: 'complete',
              blocks: [
                { type: 'tool', toolCallId: 'n1', toolName: 'code_search', input: { pattern: 'x' }, output: 'hit' },
                {
                  type: 'agent',
                  agentId: 'inner',
                  agentType: 'file-picker',
                  initialPrompt: 'Pick files',
                  content: 'Inner done',
                  status: 'complete',
                  blocks: [{ type: 'text', textType: 'text', content: 'Inner done' }],
                },
              ],
            },
            { type: 'text', textType: 'text', content: 'All found.' },
          ],
          userError: 'Your free session ended, so the agent stopped here.',
        },
        // No id: Freebuff recorded no date for this row.
        { variant: 'user', content: 'Untimed' },
      ]),
    );

    const { stored } = await importOne(homeDir, 'freebuff:fb-subs/2026-10-02T10-00-00.000Z');
    expect(stored.map((m) => [m.role, m.timeUnknown === true])).toEqual([
      ['user', false],
      ['assistant', false],
      ['user', true],
    ]);
    expect(stored[0].content).toContain('pasted spec');
    const tools = toolsOf(stored[1]);
    expect(tools.map((t) => t.name)).toEqual(['code-searcher', 'notice']);
    expect(tools[0].timeUnknown).toBe(true);
    const outer = tools[0].subagent;
    expect(outer).toMatchObject({ agentId: 'outer', name: 'code-searcher', task: 'Find usages' });
    expect(outer?.turns[0].createdAt).toBeUndefined();
    const outerTools = (outer?.turns[1].parts as Part[]).filter((p) => p.kind === 'tool');
    expect(outerTools.map((p) => [p.name, p.timeUnknown])).toEqual([
      ['code_search', true],
      ['file-picker', true],
    ]);
    expect(subTexts(outerTools[1].subagent)).toEqual(['Pick files', 'Inner done']);
    expect(tools[1]).toMatchObject({ input: { kind: 'error' }, output: 'Your free session ended, so the agent stopped here.' });
  });
});
