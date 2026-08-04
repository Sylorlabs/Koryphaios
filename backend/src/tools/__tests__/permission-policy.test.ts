import { describe, expect, it } from 'bun:test';
import { DEFAULT_AGENT_SETTINGS } from '../../agent-settings';
import {
  decideToolPermission,
  resolveToolPermissionPolicy,
} from '../permission-policy';
import { ToolRegistry, type Tool, type ToolContext } from '../registry';

function policy(
  mode: typeof DEFAULT_AGENT_SETTINGS.permissionMode,
  overrides: Partial<typeof DEFAULT_AGENT_SETTINGS> = {},
) {
  return resolveToolPermissionPolicy({
    ...DEFAULT_AGENT_SETTINGS,
    ...overrides,
    permissionMode: mode,
  });
}

describe('permission preset policy', () => {
  it('makes Plan host-enforced read-only', () => {
    const plan = resolveToolPermissionPolicy(DEFAULT_AGENT_SETTINGS, 'plan');
    expect(decideToolPermission(plan, 'read_file').action).toBe('allow');
    expect(decideToolPermission(plan, 'write_file').action).toBe('deny');
    expect(decideToolPermission(plan, 'bash').action).toBe('deny');
  });

  it('makes YOLO bypass every local tool approval', () => {
    const yolo = policy('yolo', { autonomyLimitsEnabled: true, approvalThresholdLines: 1 });
    expect(decideToolPermission(yolo, 'delete_file').action).toBe('allow');
    expect(decideToolPermission(yolo, 'bash').action).toBe('allow');
    expect(decideToolPermission(yolo, 'write_file', { fileCount: 10, linesChanged: 1000 }).action).toBe('allow');
  });

  it('makes Guarded ask for risky actions and oversized edits, not block them', () => {
    const guarded = policy('guarded', {
      autonomyLimitsEnabled: true,
      approvalThresholdFiles: 2,
      approvalThresholdLines: 20,
    });
    expect(decideToolPermission(guarded, 'read_file').action).toBe('allow');
    expect(decideToolPermission(guarded, 'write_file', { fileCount: 1, linesChanged: 10 }).action).toBe('allow');
    expect(decideToolPermission(guarded, 'write_file', { fileCount: 1, linesChanged: 30 }).action).toBe('ask');
    expect(decideToolPermission(guarded, 'delete_file').action).toBe('ask');
  });

  it('makes Accept Edits allow reads and edits while asking for other actions', () => {
    const edits = policy('edits');
    expect(decideToolPermission(edits, 'read_file').action).toBe('allow');
    expect(decideToolPermission(edits, 'edit_file').action).toBe('allow');
    expect(decideToolPermission(edits, 'bash').action).toBe('ask');
    expect(decideToolPermission(edits, 'delegate_to_worker').action).toBe('ask');
  });

  it('makes Ask require approval for each tool action', () => {
    const ask = policy('ask');
    expect(decideToolPermission(ask, 'read_file').action).toBe('ask');
    expect(decideToolPermission(ask, 'write_file').action).toBe('ask');
    expect(decideToolPermission(ask, 'bash').action).toBe('ask');
    expect(decideToolPermission(ask, 'ask_user').action).toBe('allow');
  });

  it('makes every Custom switch affect the host decision', () => {
    const strict = policy('custom', {
      autoRunTools: false,
      autoApplySafeFixes: false,
      confirmRuleViolations: true,
    });
    expect(decideToolPermission(strict, 'read_file').action).toBe('ask');
    expect(decideToolPermission(strict, 'edit_file').action).toBe('ask');
    expect(decideToolPermission(strict, 'delete_file').action).toBe('ask');

    const permissive = policy('custom', {
      autoRunTools: true,
      autoApplySafeFixes: true,
      confirmRuleViolations: false,
    });
    expect(decideToolPermission(permissive, 'read_file').action).toBe('allow');
    expect(decideToolPermission(permissive, 'edit_file').action).toBe('allow');
    expect(decideToolPermission(permissive, 'delete_file').action).toBe('allow');
  });
});

describe('ToolRegistry host enforcement', () => {
  const tool: Tool = {
    name: 'delete_file',
    description: 'test deletion gate',
    inputSchema: {},
    run: async (_ctx, call) => ({
      callId: call.id,
      name: call.name,
      output: 'ran',
      isError: false,
      durationMs: 0,
    }),
  };

  function context(mode: typeof DEFAULT_AGENT_SETTINGS.permissionMode): ToolContext {
    return {
      sessionId: 'permission-test',
      workingDirectory: process.cwd(),
      permissionPolicy: policy(mode),
    };
  }

  it('fails closed when approval is required but no human channel exists', async () => {
    const registry = new ToolRegistry();
    registry.register(tool);
    const result = await registry.execute(context('guarded'), {
      id: 'delete-1',
      name: 'delete_file',
      input: { path: 'example.txt' },
    });
    expect(result.isError).toBe(true);
    expect(result.output).toContain('no human approval channel');
  });

  it('runs only after an explicit one-time approval', async () => {
    const registry = new ToolRegistry();
    registry.register(tool);
    const ctx = context('guarded');
    ctx.waitForUserInput = async () => 'Allow once';
    const result = await registry.execute(ctx, {
      id: 'delete-2',
      name: 'delete_file',
      input: { path: 'example.txt' },
    });
    expect(result).toMatchObject({ isError: false, output: 'ran' });
    expect(ctx.approvedToolCallIds?.has('delete-2')).toBe(true);
  });

  it('runs without asking in true YOLO mode', async () => {
    const registry = new ToolRegistry();
    registry.register(tool);
    const ctx = context('yolo');
    ctx.waitForUserInput = async () => {
      throw new Error('YOLO must not ask');
    };
    const result = await registry.execute(ctx, {
      id: 'delete-3',
      name: 'delete_file',
      input: { path: 'example.txt' },
    });
    expect(result).toMatchObject({ isError: false, output: 'ran' });
  });
});
