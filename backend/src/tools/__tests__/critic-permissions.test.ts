import { expect, mock, test } from 'bun:test';
import { DEFAULT_AGENT_SETTINGS } from '../../agent-settings';
import { ToolRegistry, deriveToolContext, type ToolContext } from '../registry';
import { resolveToolPermissionPolicy } from '../permission-policy';
import { canonicalizePath } from '../../runtime/platform';

test.each(['yolo', 'guarded', 'ask', 'edits', 'custom'] as const)(
  'Critic commands require an argument-bound approval in %s', async (permissionMode) => {
    const registry = new ToolRegistry();
    const run = mock(async (_ctx, call) => ({ callId: call.id, name: call.name, output: 'executed', isError: false, durationMs: 0 }));
    registry.register({ name: 'bash', description: 'test', inputSchema: {}, run });
    const approve = mock(async () => false);
    const ctx = {
      sessionId: 'review', workingDirectory: process.cwd(), callerRole: 'critic' as const,
      permissionPolicy: resolveToolPermissionPolicy({ ...DEFAULT_AGENT_SETTINGS, permissionMode }),
      requestToolApproval: approve, approvedToolCallIds: new Set<string>(),
    };
    const call = { id: 'same-id', name: 'bash', input: { command: 'bun test' } };
    expect((await registry.execute(ctx, call)).isError).toBe(true);
    expect(run).not.toHaveBeenCalled();
    expect(approve).toHaveBeenCalledWith(call, expect.any(String));
    approve.mockImplementation(async () => true);
    expect((await registry.execute(ctx, call)).isError).toBe(false);
    expect(run).toHaveBeenCalledTimes(1);
    approve.mockImplementation(async () => false);
    expect((await registry.execute(ctx, call)).isError).toBe(true);
    expect(run).toHaveBeenCalledTimes(1);
  },
);

test('explicit blocks prevent a Critic request from reaching the approver', async () => {
  const registry = new ToolRegistry();
  const run = mock(async (_ctx, call) => ({ callId: call.id, name: call.name, output: '', isError: false, durationMs: 0 }));
  registry.register({ name: 'bash', description: '', inputSchema: {}, run });
  const approve = mock(async () => true);
  const result = await registry.execute({
    sessionId: 'review', workingDirectory: process.cwd(), callerRole: 'critic',
    permissionPolicy: resolveToolPermissionPolicy({ ...DEFAULT_AGENT_SETTINGS, permissionMode: 'yolo', toolBlocklist: ['bash'] }),
    requestToolApproval: approve,
  }, { id: 'blocked', name: 'bash', input: { command: 'bun test' } });
  expect(result.isError).toBe(true);
  expect(approve).not.toHaveBeenCalled();
  expect(run).not.toHaveBeenCalled();
});

test('derived review contexts honor a block added while approval is pending', async () => {
  const registry = new ToolRegistry();
  const run = mock(async (_ctx, call) => ({ callId: call.id, name: call.name, output: '', isError: false, durationMs: 0 }));
  registry.register({ name: 'bash', description: '', inputSchema: {}, run });
  let policy = resolveToolPermissionPolicy({ ...DEFAULT_AGENT_SETTINGS, permissionMode: 'yolo' });
  let release!: (approved: boolean) => void;
  let entered!: () => void;
  const approvalEntered = new Promise<void>((resolve) => { entered = resolve; });
  const root = canonicalizePath(process.cwd());
  const ctx: ToolContext = {
    sessionId: 'review', workingDirectory: root, callerRole: 'critic',
    requiredWorkspaceRoot: root, reviewWorkspaceRoot: root,
    get permissionPolicy() { return policy; },
    requestToolApproval: async () => {
      entered();
      return new Promise<boolean>((resolve) => { release = resolve; });
    },
  };
  const specialist = deriveToolContext(ctx, { agentId: 'review-specialist' });
  const scoped = deriveToolContext(specialist, { signal: new AbortController().signal });
  const result = registry.execute(scoped, { id: 'revoked', name: 'bash', input: { command: 'bun test' } });
  await approvalEntered;
  policy = resolveToolPermissionPolicy({ ...DEFAULT_AGENT_SETTINGS, permissionMode: 'yolo', toolBlocklist: ['bash'] });
  release(true);
  expect((await result).isError).toBe(true);
  expect(run).not.toHaveBeenCalled();
  expect(scoped.approvedToolCallIds?.has('revoked')).not.toBe(true);
});
