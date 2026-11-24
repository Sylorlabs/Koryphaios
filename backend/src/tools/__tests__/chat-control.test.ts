import { afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { nanoid } from 'nanoid';
import type { StoredMessage } from '@koryphaios/shared';
import { DEFAULT_AGENT_SETTINGS } from '../../agent-settings';
import { initDb } from '../../db';
import { MessageStore } from '../../stores/message-store';
import { SessionStore } from '../../stores/session-store';
import {
  ArchiveChatTool,
  CreateChatTool,
  InterruptChatTool,
  SearchChatsTool,
  SendToChatTool,
  WaitForChatTool,
  configureChatControl,
  resetChatControl,
  type ChatRunStatus,
  type CreateAgentChatInput,
} from '../chat-control';
import {
  decideToolPermission,
  resolveToolPermissionPolicy,
} from '../permission-policy';
import { roleIncludesTool } from '../tool-roles';
import type { ToolCallInput, ToolCallOutput, ToolContext } from '../registry';
import type { SessionTurnCommandInput, SessionTurnSubmission } from '../../kory/manager';

const sessions = new SessionStore();
const messages = new MessageStore();

beforeAll(async () => {
  await initDb();
});

// ── Harness ────────────────────────────────────────────────────────────────

interface Harness {
  turns: SessionTurnCommandInput[];
  interrupts: Array<{ sessionId: string; message: string }>;
  archived: string[];
  created: CreateAgentChatInput[];
  runStates: Map<string, ChatRunStatus>;
  nextSubmission: (input: SessionTurnCommandInput) => SessionTurnSubmission;
}

let harness: Harness;

function configure(): Harness {
  const state: Harness = {
    turns: [],
    interrupts: [],
    archived: [],
    created: [],
    runStates: new Map(),
    nextSubmission: (input) => ({
      accepted: true,
      sessionId: input.sessionId,
      runId: `run-${input.sourceCommandId}`,
      userMessageId: `user-${input.sourceCommandId}`,
      completion: Promise.resolve({
        sessionId: input.sessionId,
        runId: `run-${input.sourceCommandId}`,
        status: 'completed',
        phase: 'done',
      }),
    }),
  };
  configureChatControl({
    kory: {
      startSessionTurn: async (input: SessionTurnCommandInput) => {
        state.turns.push(input);
        return state.nextSubmission(input);
      },
    } as never,
    sessions,
    messages,
    runStatus: (sessionId) => state.runStates.get(sessionId) ?? 'idle',
    interruptChat: async (sessionId, message) => {
      state.interrupts.push({ sessionId, message });
      state.runStates.set(sessionId, 'idle');
    },
    archiveChat: async (sessionId) => {
      state.archived.push(sessionId);
      const archived = await sessions.archive(sessionId);
      if (!archived) throw new Error('archive failed');
      return archived;
    },
    createChat: async (input) => {
      state.created.push(input);
      const created = await sessions.create('local-user', input.title, undefined, input.workingDirectory);
      return (await sessions.update(created.id, { createdByAgent: input.createdByAgent })) ?? created;
    },
    pollIntervalMs: 5,
  });
  return state;
}

afterEach(() => {
  resetChatControl();
});

/** A project folder unique per test run, so chats from other tests never collide. */
function projectDir(label: string): string {
  return `/tmp/kory-chat-control-${label}-${nanoid(6)}`;
}

async function chat(title: string, workingDirectory?: string) {
  return sessions.create('local-user', title, undefined, workingDirectory);
}

function ctxFor(sessionId: string, agentId = 'kory-manager'): ToolContext {
  return { sessionId, agentId, callerRole: 'manager', workingDirectory: '/tmp' };
}

function callFor(name: string, input: Record<string, unknown>, id = `call-${nanoid(6)}`): ToolCallInput {
  return { id, name, input };
}

async function run(tool: { run(ctx: ToolContext, call: ToolCallInput): Promise<ToolCallOutput> }, ctx: ToolContext, call: ToolCallInput) {
  return tool.run(ctx, call);
}

async function addMessage(sessionId: string, role: StoredMessage['role'], content: string, createdAt: number) {
  const id = `m-${nanoid(10)}`;
  await messages.add(sessionId, { id, sessionId, role, content, createdAt });
  return id;
}

// ── create_chat ────────────────────────────────────────────────────────────

describe('create_chat', () => {
  test('creates a chat in the caller project and records createdByAgent provenance', async () => {
    harness = configure();
    const dir = projectDir('create');
    const caller = await chat('Planner', dir);
    const tool = new CreateChatTool();
    const result = await run(tool, ctxFor(caller.id), callFor('create_chat', { title: 'Docs sweep' }));

    expect(result.isError).toBe(false);
    expect(harness.created).toHaveLength(1);
    const created = harness.created[0];
    expect(created.workingDirectory).toBe(dir);
    expect(created.createdByAgent).toEqual({ sessionId: caller.id, agentId: 'kory-manager' });

    const stored = (await sessions.listActive()).find(
      (session) => session.title === 'Docs sweep' && session.workingDirectory === dir,
    );
    expect(stored?.createdByAgent).toEqual({ sessionId: caller.id, agentId: 'kory-manager' });
    expect(result.output).toContain('Created chat "Docs sweep"');
    expect(harness.turns).toHaveLength(0);
  });

  test('defaults the title from the caller and refuses another project folder', async () => {
    harness = configure();
    const caller = await chat('Parent work', projectDir('create-default'));
    const tool = new CreateChatTool();

    const ok = await run(tool, ctxFor(caller.id), callFor('create_chat', {}));
    expect(ok.output).toContain('Task from Parent work');

    const foreign = await run(
      tool,
      ctxFor(caller.id),
      callFor('create_chat', { workingDirectory: projectDir('elsewhere') }),
    );
    expect(foreign.isError).toBe(true);
    expect(foreign.output).toContain('only be created in this chat');
    expect(harness.created).toHaveLength(1);
  });

  test('an initial message is refused unless start is true, so it is never persisted without a turn', async () => {
    harness = configure();
    const caller = await chat('Caller', projectDir('create-noStart'));
    const result = await run(
      new CreateChatTool(),
      ctxFor(caller.id),
      callFor('create_chat', { initialMessage: 'hello' }),
    );
    expect(result.isError).toBe(true);
    expect(harness.created).toHaveLength(0);
    expect(harness.turns).toHaveLength(0);
  });

  test('start: true runs the first message through startSessionTurn as an attributed envelope', async () => {
    harness = configure();
    const dir = projectDir('create-start');
    const caller = await chat('Lead', dir);
    const result = await run(
      new CreateChatTool(),
      ctxFor(caller.id),
      callFor('create_chat', { title: 'Child', initialMessage: 'Audit the parser', start: true, model: 'model-x' }),
    );

    expect(result.isError).toBe(false);
    expect(harness.turns).toHaveLength(1);
    const turn = harness.turns[0];
    expect(turn.source).toBe('user');
    expect(turn.userMessage).toContain('not from the user');
    expect(turn.userMessage).toContain(`"Lead" (${caller.id})`);
    expect(turn.userMessage).toContain('Audit the parser');
    expect(turn.preferredModel).toBe('model-x');
    expect(result.output).toContain('Turn started');
    expect(harness.created[0].model).toBe('model-x');
  });

  test('a refused first turn leaves the created chat and reports it', async () => {
    harness = configure();
    const caller = await chat('Lead', projectDir('create-refused'));
    harness.nextSubmission = (input) => ({
      accepted: false,
      result: { sessionId: input.sessionId, runId: '', status: 'rejected', phase: 'idle', reason: 'session_busy' },
    });
    const result = await run(
      new CreateChatTool(),
      ctxFor(caller.id),
      callFor('create_chat', { initialMessage: 'x', start: true }),
    );
    expect(harness.created).toHaveLength(1);
    expect(result.output).toContain('did not accept');
    expect(result.output).toContain('exists without its first message');
  });
});

// ── send_to_chat ───────────────────────────────────────────────────────────

describe('send_to_chat', () => {
  test('starts a turn in another chat of the same project through the user source', async () => {
    harness = configure();
    const dir = projectDir('send');
    const caller = await chat('Caller', dir);
    const target = await chat('Target', dir);
    const result = await run(
      new SendToChatTool(),
      ctxFor(caller.id),
      callFor('send_to_chat', { sessionId: target.id, message: 'Please review the diff' }),
    );

    expect(result.isError).toBe(false);
    expect(harness.turns).toHaveLength(1);
    expect(harness.turns[0].sessionId).toBe(target.id);
    expect(harness.turns[0].source).toBe('user');
    expect(harness.turns[0].userMessage).toContain('Please review the diff');
    expect(harness.turns[0].userMessage).toContain('not from the user');
    expect(result.output).toContain('Turn started');
  });

  test('a busy chat queues the message on its steering queue', async () => {
    harness = configure();
    const dir = projectDir('send-busy');
    const caller = await chat('Caller', dir);
    const target = await chat('Busy target', dir);
    harness.runStates.set(target.id, 'processing');
    harness.nextSubmission = (input) => ({
      accepted: 'queued',
      sessionId: input.sessionId,
      steeringCommandId: `usrsteer_${input.sessionId}_${input.sourceCommandId}`,
      userMessageId: `user-${input.sourceCommandId}`,
    });
    const result = await run(
      new SendToChatTool(),
      ctxFor(caller.id),
      callFor('send_to_chat', { sessionId: target.id, message: 'Also check X' }),
    );
    expect(result.isError).toBe(false);
    expect(result.output).toContain('steering queue');
    expect(harness.turns).toHaveLength(1);
  });

  test('a rejected submission is an error and says nothing was sent', async () => {
    harness = configure();
    const dir = projectDir('send-rejected');
    const caller = await chat('Caller', dir);
    const target = await chat('Target', dir);
    harness.nextSubmission = (input) => ({
      accepted: false,
      result: { sessionId: input.sessionId, runId: '', status: 'rejected', phase: 'idle', reason: 'session_busy' },
    });
    const result = await run(
      new SendToChatTool(),
      ctxFor(caller.id),
      callFor('send_to_chat', { sessionId: target.id, message: 'x' }),
    );
    expect(result.isError).toBe(true);
    expect(result.output).toContain('Nothing was sent');
  });

  test('never sends into the caller own chat', async () => {
    harness = configure();
    const caller = await chat('Self', projectDir('send-self'));
    const result = await run(
      new SendToChatTool(),
      ctxFor(caller.id),
      callFor('send_to_chat', { sessionId: caller.id, message: 'loop' }),
    );
    expect(result.isError).toBe(true);
    expect(result.output).toContain('That is this chat');
    expect(harness.turns).toHaveLength(0);
  });

  test('refuses a chat in another project and an archived chat', async () => {
    harness = configure();
    const caller = await chat('Caller', projectDir('send-iso'));
    const foreign = await chat('Foreign', projectDir('send-iso-other'));
    const cross = await run(
      new SendToChatTool(),
      ctxFor(caller.id),
      callFor('send_to_chat', { sessionId: foreign.id, message: 'x' }),
    );
    expect(cross.isError).toBe(true);
    expect(cross.output).toContain('another project');

    const archivedDir = projectDir('send-archived');
    const sameCaller = await chat('Caller2', archivedDir);
    const archivedTarget = await chat('Archived', archivedDir);
    await sessions.archive(archivedTarget.id);
    const archived = await run(
      new SendToChatTool(),
      ctxFor(sameCaller.id),
      callFor('send_to_chat', { sessionId: archivedTarget.id, message: 'x' }),
    );
    expect(archived.isError).toBe(true);
    expect(archived.output).toContain('archived');
    expect(harness.turns).toHaveLength(0);
  });

  test('an unknown id and an empty message are errors', async () => {
    harness = configure();
    const caller = await chat('Caller', projectDir('send-unknown'));
    const unknown = await run(
      new SendToChatTool(),
      ctxFor(caller.id),
      callFor('send_to_chat', { sessionId: 'no-such-chat', message: 'x' }),
    );
    expect(unknown.isError).toBe(true);
    expect(unknown.output).toContain('search_chats');

    const empty = await run(
      new SendToChatTool(),
      ctxFor(caller.id),
      callFor('send_to_chat', { sessionId: caller.id, message: '   ' }),
    );
    expect(empty.isError).toBe(true);
    expect(harness.turns).toHaveLength(0);
  });
});

// ── wait_for_chat ──────────────────────────────────────────────────────────

describe('wait_for_chat', () => {
  test('an idle chat settles at once and returns its last assistant reply', async () => {
    harness = configure();
    const dir = projectDir('wait-idle');
    const caller = await chat('Caller', dir);
    const target = await chat('Target', dir);
    const base = Date.now() - 10_000;
    await addMessage(target.id, 'user', 'question', base + 1);
    await addMessage(target.id, 'assistant', 'the answer is 42', base + 2);

    const result = await run(
      new WaitForChatTool(),
      ctxFor(caller.id),
      callFor('wait_for_chat', { sessionId: target.id }),
    );
    expect(result.isError).toBe(false);
    expect(result.output).toContain('settled: yes');
    expect(result.output).toContain('state: idle');
    expect(result.output).toContain('the answer is 42');
  });

  test('resolves when a running chat settles before the timeout', async () => {
    harness = configure();
    const dir = projectDir('wait-settle');
    const caller = await chat('Caller', dir);
    const target = await chat('Running', dir);
    harness.runStates.set(target.id, 'processing');
    setTimeout(() => harness.runStates.set(target.id, 'idle'), 30);

    const started = Date.now();
    const result = await run(
      new WaitForChatTool(),
      ctxFor(caller.id),
      callFor('wait_for_chat', { sessionId: target.id, timeoutSec: 5 }),
    );
    expect(result.output).toContain('settled: yes');
    expect(Date.now() - started).toBeLessThan(4_000);
  });

  test('times out with the current state when the run keeps going', async () => {
    harness = configure();
    const dir = projectDir('wait-timeout');
    const caller = await chat('Caller', dir);
    const target = await chat('Stuck', dir);
    harness.runStates.set(target.id, 'processing');

    const started = Date.now();
    const result = await run(
      new WaitForChatTool(),
      ctxFor(caller.id),
      callFor('wait_for_chat', { sessionId: target.id, timeoutSec: 1 }),
    );
    expect(result.isError).toBe(false);
    expect(result.output).toContain('settled: no, timed out');
    expect(result.output).toContain('state: processing');
    expect(Date.now() - started).toBeGreaterThanOrEqual(900);
  });

  test('a chat parked on input reports waiting and does not settle', async () => {
    harness = configure();
    const dir = projectDir('wait-parked');
    const caller = await chat('Caller', dir);
    const target = await chat('Parked', dir);
    harness.runStates.set(target.id, 'waiting');
    const result = await run(
      new WaitForChatTool(),
      ctxFor(caller.id),
      callFor('wait_for_chat', { sessionId: target.id, timeoutSec: 1 }),
    );
    expect(result.output).toContain('settled: no');
    expect(result.output).toContain('state: waiting');
  });

  test('rejects timeouts outside 1 to 1800 seconds and waiting on its own chat', async () => {
    harness = configure();
    const caller = await chat('Caller', projectDir('wait-bounds'));
    const tooLong = await run(
      new WaitForChatTool(),
      ctxFor(caller.id),
      callFor('wait_for_chat', { sessionId: caller.id, timeoutSec: 1801 }),
    );
    expect(tooLong.isError).toBe(true);
    expect(tooLong.output).toContain('1 and 1800');

    const zero = await run(
      new WaitForChatTool(),
      ctxFor(caller.id),
      callFor('wait_for_chat', { sessionId: caller.id, timeoutSec: 0 }),
    );
    expect(zero.isError).toBe(true);

    const self = await run(
      new WaitForChatTool(),
      ctxFor(caller.id),
      callFor('wait_for_chat', { sessionId: caller.id }),
    );
    expect(self.isError).toBe(true);
    expect(self.output).toContain('That is this chat');
  });

  test('an aborted wait ends as a cancelled error', async () => {
    harness = configure();
    const dir = projectDir('wait-abort');
    const caller = await chat('Caller', dir);
    const target = await chat('Target', dir);
    harness.runStates.set(target.id, 'processing');
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 20);
    const ctx: ToolContext = { ...ctxFor(caller.id), signal: controller.signal };
    const result = await run(
      new WaitForChatTool(),
      ctx,
      callFor('wait_for_chat', { sessionId: target.id, timeoutSec: 10 }),
    );
    expect(result.isError).toBe(true);
    expect(result.output).toContain('cancelled');
  });
});

// ── interrupt_chat ─────────────────────────────────────────────────────────

describe('interrupt_chat', () => {
  test('stops a running chat with the reason written into its transcript banner', async () => {
    harness = configure();
    const dir = projectDir('interrupt');
    const caller = await chat('Supervisor', dir);
    const target = await chat('Runaway', dir);
    harness.runStates.set(target.id, 'processing');
    const result = await run(
      new InterruptChatTool(),
      ctxFor(caller.id),
      callFor('interrupt_chat', { sessionId: target.id, reason: 'duplicate work' }),
    );
    expect(result.isError).toBe(false);
    expect(harness.interrupts).toHaveLength(1);
    expect(harness.interrupts[0].sessionId).toBe(target.id);
    expect(harness.interrupts[0].message).toContain('duplicate work');
    expect(harness.interrupts[0].message).toContain('Supervisor');
  });

  test('an idle chat has nothing to stop', async () => {
    harness = configure();
    const dir = projectDir('interrupt-idle');
    const caller = await chat('Caller', dir);
    const target = await chat('Idle', dir);
    const result = await run(
      new InterruptChatTool(),
      ctxFor(caller.id),
      callFor('interrupt_chat', { sessionId: target.id, reason: 'x' }),
    );
    expect(result.isError).toBe(false);
    expect(result.output).toContain('not running');
    expect(harness.interrupts).toHaveLength(0);
  });

  test('requires a reason, refuses its own chat and other projects', async () => {
    harness = configure();
    const dir = projectDir('interrupt-guards');
    const caller = await chat('Caller', dir);
    const target = await chat('Target', dir);
    harness.runStates.set(target.id, 'processing');

    const noReason = await run(
      new InterruptChatTool(),
      ctxFor(caller.id),
      callFor('interrupt_chat', { sessionId: target.id }),
    );
    expect(noReason.isError).toBe(true);

    const self = await run(
      new InterruptChatTool(),
      ctxFor(caller.id),
      callFor('interrupt_chat', { sessionId: caller.id, reason: 'x' }),
    );
    expect(self.isError).toBe(true);

    const foreign = await chat('Foreign', projectDir('interrupt-foreign'));
    harness.runStates.set(foreign.id, 'processing');
    const cross = await run(
      new InterruptChatTool(),
      ctxFor(caller.id),
      callFor('interrupt_chat', { sessionId: foreign.id, reason: 'x' }),
    );
    expect(cross.isError).toBe(true);
    expect(harness.interrupts).toHaveLength(0);
  });
});

// ── archive_chat ───────────────────────────────────────────────────────────

describe('archive_chat', () => {
  test('archives another chat in the project and keeps its history', async () => {
    harness = configure();
    const dir = projectDir('archive');
    const caller = await chat('Caller', dir);
    const target = await chat('Old', dir);
    await addMessage(target.id, 'user', 'keep me', Date.now());

    const result = await run(
      new ArchiveChatTool(),
      ctxFor(caller.id),
      callFor('archive_chat', { sessionId: target.id }),
    );
    expect(result.isError).toBe(false);
    expect(harness.archived).toEqual([target.id]);
    expect((await sessions.get(target.id))?.archivedAt).toBeDefined();
    expect((await messages.getAll(target.id)).some((m) => m.content === 'keep me')).toBe(true);
  });

  test('an already archived chat is a no-op, and self or foreign targets are refused', async () => {
    harness = configure();
    const dir = projectDir('archive-guards');
    const caller = await chat('Caller', dir);
    const target = await chat('Done', dir);
    await sessions.archive(target.id);
    const again = await run(
      new ArchiveChatTool(),
      ctxFor(caller.id),
      callFor('archive_chat', { sessionId: target.id }),
    );
    expect(again.isError).toBe(false);
    expect(again.output).toContain('already archived');
    expect(harness.archived).toHaveLength(0);

    const self = await run(
      new ArchiveChatTool(),
      ctxFor(caller.id),
      callFor('archive_chat', { sessionId: caller.id }),
    );
    expect(self.isError).toBe(true);

    const foreign = await chat('Foreign', projectDir('archive-foreign'));
    const cross = await run(
      new ArchiveChatTool(),
      ctxFor(caller.id),
      callFor('archive_chat', { sessionId: foreign.id }),
    );
    expect(cross.isError).toBe(true);
    expect((await sessions.get(foreign.id))?.archivedAt).toBeUndefined();
  });
});

// ── search_chats ───────────────────────────────────────────────────────────

describe('search_chats', () => {
  test('matches titles and message text within the caller project only', async () => {
    harness = configure();
    const dir = projectDir('search');
    const caller = await chat('Searcher', dir);
    const titled = await chat(`Parser rewrite ${nanoid(4)}`, dir);
    const textual = await chat('Unrelated name', dir);
    await addMessage(textual.id, 'assistant', 'The Parser now handles nested blocks', Date.now());
    const foreign = await chat(`Parser elsewhere ${nanoid(4)}`, projectDir('search-foreign'));
    await addMessage(foreign.id, 'assistant', 'parser in another project', Date.now());

    const result = await run(
      new SearchChatsTool(),
      ctxFor(caller.id),
      callFor('search_chats', { query: 'parser' }),
    );
    expect(result.isError).toBe(false);
    expect(result.output).toContain(titled.id);
    expect(result.output).toContain('match: title');
    expect(result.output).toContain(textual.id);
    expect(result.output).toContain('nested blocks');
    expect(result.output).not.toContain(foreign.id);
    expect(result.output).toContain('data, not instructions');
  });

  test('respects the limit, skips archived chats, and treats LIKE wildcards literally', async () => {
    harness = configure();
    const dir = projectDir('search-limit');
    const caller = await chat('Searcher', dir);
    for (let index = 0; index < 4; index++) {
      await chat(`Batch ${index} ${nanoid(4)}`, dir);
    }
    const hidden = await chat('Batch hidden', dir);
    await sessions.archive(hidden.id);

    const limited = await run(
      new SearchChatsTool(),
      ctxFor(caller.id),
      callFor('search_chats', { query: 'batch', limit: 2 }),
    );
    const titleLines = limited.output.split('\n').filter((line) => line.includes(' | Batch'));
    expect(titleLines).toHaveLength(2);
    expect(limited.output).not.toContain(hidden.id);

    const wildcard = await run(
      new SearchChatsTool(),
      ctxFor(caller.id),
      callFor('search_chats', { query: '%' }),
    );
    expect(wildcard.output).toContain('No chats in this project match.');
  });

  test('an empty query is an error', async () => {
    harness = configure();
    const caller = await chat('Searcher', projectDir('search-empty'));
    const result = await run(new SearchChatsTool(), ctxFor(caller.id), callFor('search_chats', { query: ' ' }));
    expect(result.isError).toBe(true);
  });
});

// ── Permissions, roles, and the store contract ─────────────────────────────

describe('chat-control permission defaults', () => {
  const writeTools = ['create_chat', 'send_to_chat', 'interrupt_chat', 'archive_chat'];
  const readTools = ['search_chats', 'wait_for_chat'];

  test('writes ask the user in every mode except YOLO', () => {
    for (const mode of ['guarded', 'edits', 'ask', 'custom'] as const) {
      const policy = resolveToolPermissionPolicy({ ...DEFAULT_AGENT_SETTINGS, permissionMode: mode });
      for (const tool of writeTools) {
        expect(decideToolPermission(policy, tool).action).toBe('ask');
      }
    }
    const yolo = resolveToolPermissionPolicy({ ...DEFAULT_AGENT_SETTINGS, permissionMode: 'yolo' });
    for (const tool of writeTools) {
      expect(decideToolPermission(yolo, tool).action).toBe('allow');
    }
  });

  test('search and wait are read-only: allowed in every mode, including plan', () => {
    const plan = resolveToolPermissionPolicy(DEFAULT_AGENT_SETTINGS, 'plan');
    const ask = resolveToolPermissionPolicy({ ...DEFAULT_AGENT_SETTINGS, permissionMode: 'ask' });
    for (const tool of readTools) {
      expect(decideToolPermission(plan, tool).action).toBe('allow');
      expect(decideToolPermission(ask, tool).action).toBe('allow');
    }
  });

  test('plan mode denies chat writes, since planning cannot change other work', () => {
    const plan = resolveToolPermissionPolicy(DEFAULT_AGENT_SETTINGS, 'plan');
    for (const tool of writeTools) {
      expect(decideToolPermission(plan, tool).action).toBe('deny');
    }
  });

  test('an explicit block still wins, and an explicit allowlist entry is the user choice', () => {
    const blocked = resolveToolPermissionPolicy({
      ...DEFAULT_AGENT_SETTINGS,
      permissionMode: 'yolo',
      toolBlocklist: ['send_to_chat'],
    });
    expect(decideToolPermission(blocked, 'send_to_chat').action).toBe('deny');

    const allowed = resolveToolPermissionPolicy({
      ...DEFAULT_AGENT_SETTINGS,
      permissionMode: 'guarded',
      toolAllowlist: ['archive_chat'],
    });
    expect(decideToolPermission(allowed, 'archive_chat').action).toBe('allow');
  });

  test('the write tools are manager-only, so workers and critics cannot approve or act', () => {
    for (const tool of writeTools) {
      expect(roleIncludesTool(tool, 'manager', 'manager')).toBe(true);
      expect(roleIncludesTool(tool, 'worker', 'manager')).toBe(false);
      expect(roleIncludesTool(tool, 'critic', 'manager')).toBe(false);
    }
    for (const tool of readTools) {
      expect(roleIncludesTool(tool, 'worker', 'any')).toBe(true);
    }
  });
});

describe('createdByAgent provenance', () => {
  test('round-trips through the session store and rejects malformed values', async () => {
    const caller = await chat('Origin', projectDir('provenance'));
    const created = await chat('Child', projectDir('provenance-child'));
    const updated = await sessions.update(created.id, {
      createdByAgent: { sessionId: caller.id, agentId: 'kory-manager' },
    });
    expect(updated?.createdByAgent).toEqual({ sessionId: caller.id, agentId: 'kory-manager' });
    expect((await sessions.get(created.id))?.createdByAgent?.sessionId).toBe(caller.id);

    const cleared = await sessions.update(created.id, { createdByAgent: undefined as never });
    expect(cleared?.createdByAgent).toEqual({ sessionId: caller.id, agentId: 'kory-manager' });
  });
});
