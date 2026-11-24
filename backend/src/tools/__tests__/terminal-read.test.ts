import { afterEach, describe, expect, test } from 'bun:test';
import { tmpdir } from 'node:os';
import { DEFAULT_AGENT_SETTINGS } from '../../agent-settings';
import { SessionRuntime } from '../../kory/services/SessionRuntime';
import { TerminalService } from '../../terminal/terminal-service';
import {
  decideToolPermission,
  resolveToolPermissionPolicy,
  READ_ONLY_TOOLS,
} from '../permission-policy';
import {
  ReadTerminalTool,
  configureTerminalReads,
  plainTerminalText,
  resetTerminalReads,
} from '../terminal-read';
import type { ToolCallInput, ToolContext } from '../registry';

const service = new TerminalService(() => undefined);
const chatA = new SessionRuntime();
const chatB = new SessionRuntime();
const tool = new ReadTerminalTool();

afterEach(() => {
  resetTerminalReads();
  chatA.dispose();
  chatB.dispose();
});

function ctx(sessionId: string): ToolContext {
  return { sessionId } as ToolContext;
}

function call(input: Record<string, unknown>): ToolCallInput {
  return { id: 'call-1', name: 'read_terminal', input };
}

function wire() {
  configureTerminalReads((sessionId) =>
    sessionId === 'chat-a' ? chatA.terminals : sessionId === 'chat-b' ? chatB.terminals : undefined,
  );
}

describe('read_terminal tool', () => {
  test('strips terminal control sequences from output', () => {
    const raw = '\x1b[31mred\x1b[0m\r\n\x1b]0;title\x07done\r\n';
    expect(plainTerminalText(new TextEncoder().encode(raw))).toBe('red\ndone\n');
  });

  test("returns the recent output of the calling chat's own terminal", async () => {
    wire();
    const term = service.create(chatA.terminals, {
      sessionId: 'chat-a',
      scope: 'chat',
      cwd: tmpdir(),
      cols: 80,
      rows: 24,
      command: '/bin/sh',
      args: ['-c', 'echo first-line; echo second-line'],
    });
    while (term.isRunning) await Bun.sleep(20);
    const result = await tool.run(ctx('chat-a'), call({ terminalId: term.id, lines: 5 }));
    expect(result.isError).toBe(false);
    expect(result.output).toContain('first-line');
    expect(result.output).toContain('second-line');
    expect(result.output).toContain('exited, code 0');
  });

  test("refuses another chat's terminal id with no output leak", async () => {
    wire();
    const term = service.create(chatA.terminals, {
      sessionId: 'chat-a',
      scope: 'chat',
      cwd: tmpdir(),
      cols: 80,
      rows: 24,
      command: '/bin/sh',
      args: ['-c', 'echo secret-output; sleep 5'],
    });
    const result = await tool.run(ctx('chat-b'), call({ terminalId: term.id }));
    expect(result.isError).toBe(true);
    expect(result.output).not.toContain('secret-output');
    service.remove(chatA.terminals, term.id);
  });

  test('requires a terminal id and a wired lookup', async () => {
    resetTerminalReads();
    expect((await tool.run(ctx('chat-a'), call({ terminalId: 'x' }))).isError).toBe(true);
    wire();
    expect((await tool.run(ctx('chat-a'), call({}))).isError).toBe(true);
  });
});

describe('read_terminal permission', () => {
  const settings = (
    mode: 'ask' | 'guarded' | 'yolo',
    extra: Partial<typeof DEFAULT_AGENT_SETTINGS> = {},
  ) => resolveToolPermissionPolicy({ ...DEFAULT_AGENT_SETTINGS, ...extra, permissionMode: mode });

  test('asks by default in every mode, including YOLO', () => {
    for (const mode of ['ask', 'guarded', 'yolo'] as const) {
      expect(decideToolPermission(settings(mode), 'read_terminal').action).toBe('ask');
    }
  });

  test('is a read in plan mode but still asks', () => {
    expect(READ_ONLY_TOOLS.has('read_terminal')).toBe(true);
    const plan = resolveToolPermissionPolicy(DEFAULT_AGENT_SETTINGS, 'plan');
    expect(decideToolPermission(plan, 'read_terminal').action).toBe('ask');
  });

  test('an explicit allowlist entry is the only standing consent', () => {
    const allowed = settings('guarded', { toolAllowlist: ['read_terminal'] });
    expect(decideToolPermission(allowed, 'read_terminal').action).toBe('allow');
    const blocked = settings('yolo', { toolBlocklist: ['read_terminal'] });
    expect(decideToolPermission(blocked, 'read_terminal').action).toBe('deny');
  });
});
