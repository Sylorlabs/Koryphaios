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
