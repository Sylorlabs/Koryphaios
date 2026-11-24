import { describe, expect, it } from 'bun:test';
import { KORY_TOOLS, toolsForRole } from '../../providers/kory-mcp-bridge';
import { ForkChatTool } from '../session';
import { DEFAULT_AGENT_SETTINGS } from '../../agent-settings';
import type { ToolCallInput, ToolContext } from '../registry';
import { decideToolPermission, resolveToolPermissionPolicy } from '../permission-policy';

type ForkInput = Parameters<NonNullable<ToolContext['forkChat']>>[0];

function ctx(overrides: Partial<ToolContext> = {}, calls: ForkInput[] = []): ToolContext {
  return {
    sessionId: 'chat-a',
    agentId: 'kory',
    callerRole: 'manager',
    workingDirectory: '/tmp/fork-tool',
    forkChat: async (input) => {
      calls.push(input);
      return { sessionId: 'chat-fork-1', title: 'Chat A (fork)', copiedMessageCount: 4 };
    },
    ...overrides,
  } as ToolContext;
}

function call(input: Record<string, unknown>): ToolCallInput {
  return { id: 'call-1', name: 'fork_chat', input } as ToolCallInput;
}

describe('fork_chat tool', () => {
  const tool = new ForkChatTool();

  it('returns the new session id and forwards only the fields the caller set', async () => {
    const calls: ForkInput[] = [];
    const result = await tool.run(ctx({}, calls), call({ messageId: ' m-9 ' }));

    expect(result.isError).toBe(false);
    expect(result.output).toContain('session chat-fork-1');
    expect(result.output).toContain('4 message(s) copied');
    expect(calls).toEqual([{ messageId: 'm-9' }]);
  });

  it('passes an explicit sessionId and title through', async () => {
    const calls: ForkInput[] = [];
    await tool.run(ctx({}, calls), call({ sessionId: 'chat-b', title: 'Alt path' }));
    expect(calls).toEqual([{ sessionId: 'chat-b', title: 'Alt path' }]);
  });

  it('is refused for non-manager callers and when no host hook is wired', async () => {
    const worker = await tool.run(ctx({ callerRole: 'worker' }), call({}));
    expect(worker.isError).toBe(true);
    expect(worker.output).toContain('only available to this chat');
    const unwired = await tool.run(ctx({ forkChat: undefined }), call({}));
    expect(unwired.isError).toBe(true);
  });

  it('rejects non-string inputs before reaching the host', async () => {
    const calls: ForkInput[] = [];
    const result = await tool.run(ctx({}, calls), call({ messageId: 42 }));
    expect(result.isError).toBe(true);
    expect(calls).toHaveLength(0);
  });

  it('surfaces host failures as tool errors', async () => {
    const failing = ctx({
      forkChat: async () => {
        throw new Error('Choose a message to fork from.');
      },
    });
    const result = await tool.run(failing, call({}));
    expect(result.isError).toBe(true);
    expect(result.output).toBe('Error: Choose a message to fork from.');
  });

  it('is a control-plane tool allowed in every permission mode, like rename_session', () => {
    const policy = resolveToolPermissionPolicy({ ...DEFAULT_AGENT_SETTINGS, permissionMode: 'plan' });
    expect(decideToolPermission(policy, 'fork_chat').action).toBe('allow');
  });

  it('is advertised through the kory MCP bridge catalog to the manager only', () => {
    const entry = KORY_TOOLS.find((candidate) => candidate.name === 'kory__fork_chat');
    expect(entry?.role).toBe('manager');
    expect(toolsForRole('manager').map((candidate) => candidate.name)).toContain('kory__fork_chat');
    expect(toolsForRole('critic').map((candidate) => candidate.name)).not.toContain('kory__fork_chat');
  });
});
