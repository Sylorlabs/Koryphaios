import { describe, expect, it } from 'bun:test';
import { DEFAULT_AGENT_SETTINGS } from '../../agent-settings';
import {
  decideToolPermission,
  resolveToolPermissionPolicy,
  resolveSandboxOptions,
  resolveSubAgentPermissionPolicy,
  resolveSubAgentSandboxOptions,
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
    expect(decideToolPermission(plan, 'record_work_note').action).toBe('deny');
    expect(decideToolPermission(plan, 'bash').action).toBe('deny');
  });

  it('makes YOLO bypass every local tool approval', () => {
    const yolo = policy('yolo', { autonomyLimitsEnabled: true, approvalThresholdLines: 1 });
    expect(decideToolPermission(yolo, 'delete_file').action).toBe('allow');
    expect(decideToolPermission(yolo, 'bash').action).toBe('allow');
    expect(decideToolPermission(yolo, 'record_work_note').action).toBe('allow');
    expect(
      decideToolPermission(yolo, 'write_file', { fileCount: 10, linesChanged: 1000 }).action,
    ).toBe('allow');
  });

  it('makes Guarded allow every file edit and ask only for risky non-edit actions', () => {
    const guarded = policy('guarded', {
      autonomyLimitsEnabled: true,
      approvalThresholdFiles: 2,
      approvalThresholdLines: 20,
    });
    expect(decideToolPermission(guarded, 'read_file').action).toBe('allow');
    expect(
      decideToolPermission(guarded, 'write_file', { fileCount: 1, linesChanged: 10 }).action,
    ).toBe('allow');
    expect(
      decideToolPermission(guarded, 'write_file', { fileCount: 10, linesChanged: 3000 }).action,
    ).toBe('allow');
    expect(decideToolPermission(guarded, 'delete_file').action).toBe('ask');
    expect(decideToolPermission(guarded, 'record_work_note').action).toBe('allow');
  });

  it('makes Accept Edits allow reads and edits while asking for other actions', () => {
    const edits = policy('edits');
    expect(decideToolPermission(edits, 'read_file').action).toBe('allow');
    expect(decideToolPermission(edits, 'edit_file').action).toBe('allow');
    expect(decideToolPermission(edits, 'bash').action).toBe('ask');
    expect(decideToolPermission(edits, 'delegate_to_worker').action).toBe('ask');
    expect(decideToolPermission(edits, 'record_work_note').action).toBe('ask');
  });

  it('makes Ask auto-allow reads and require approval only for writes', () => {
    const ask = policy('ask');
    expect(decideToolPermission(ask, 'read_file').action).toBe('allow');
    expect(decideToolPermission(ask, 'grep').action).toBe('allow');
    expect(decideToolPermission(ask, 'web_search').action).toBe('allow');
    expect(decideToolPermission(ask, 'list_notes').action).toBe('allow');
    expect(decideToolPermission(ask, 'read_note').action).toBe('allow');
    expect(decideToolPermission(ask, 'write_file').action).toBe('ask');
    expect(decideToolPermission(ask, 'edit_file').action).toBe('ask');
    expect(decideToolPermission(ask, 'bash').action).toBe('ask');
    expect(decideToolPermission(ask, 'record_work_note').action).toBe('ask');
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

describe('resolveSandboxOptions', () => {
  it('auto mode honors the natural sandboxed state', () => {
    expect(resolveSandboxOptions(DEFAULT_AGENT_SETTINGS, true).isSandboxed).toBe(true);
    expect(resolveSandboxOptions(DEFAULT_AGENT_SETTINGS, false).isSandboxed).toBe(false);
  });

  it('always mode sandboxes even the direct manager path', () => {
    const settings = {
      ...DEFAULT_AGENT_SETTINGS,
      sandbox: { ...DEFAULT_AGENT_SETTINGS.sandbox, mode: 'always' as const },
    };
    expect(resolveSandboxOptions(settings, false).isSandboxed).toBe(true);
  });

  it('off mode disables the sandbox regardless of natural state', () => {
    const settings = {
      ...DEFAULT_AGENT_SETTINGS,
      sandbox: { ...DEFAULT_AGENT_SETTINGS.sandbox, mode: 'off' as const },
    };
    expect(resolveSandboxOptions(settings, true).isSandboxed).toBe(false);
  });

  it('carries granular toggles from settings', () => {
    const settings = {
      ...DEFAULT_AGENT_SETTINGS,
      sandbox: { ...DEFAULT_AGENT_SETTINGS.sandbox, metacharacters: false, network: false },
    };
    const resolved = resolveSandboxOptions(settings, true);
    expect(resolved.metacharacters).toBe(false);
    expect(resolved.network).toBe(false);
    expect(resolved.commandWhitelist).toBe(true);
  });

  it('falls back to defaults when settings.sandbox is missing', () => {
    const resolved = resolveSandboxOptions(undefined, true);
    expect(resolved.isSandboxed).toBe(true);
    expect(resolved.commandWhitelist).toBe(true);
    expect(resolved.metacharacters).toBe(true);
  });

  it('YOLO permission mode bypasses the sandbox for sub-agents', () => {
    // Even with sandbox.mode='always' and a naturally-sandboxed worker/critic
    // path, YOLO forces isSandboxed=false so sub-agents run unconstrained.
    const settings = {
      ...DEFAULT_AGENT_SETTINGS,
      permissionMode: 'yolo' as const,
      sandbox: { ...DEFAULT_AGENT_SETTINGS.sandbox, mode: 'always' as const },
    };
    expect(resolveSandboxOptions(settings, true).isSandboxed).toBe(false);
    expect(resolveSandboxOptions(settings, false).isSandboxed).toBe(false);
  });
});

describe('sub-agent approval policy', () => {
  it('manager mode inherits the manager permission preset', () => {
    const guarded = { ...DEFAULT_AGENT_SETTINGS, permissionMode: 'guarded' as const };
    expect(resolveSubAgentPermissionPolicy(guarded, 'manager').mode).toBe('guarded');

    const ask = { ...DEFAULT_AGENT_SETTINGS, permissionMode: 'ask' as const };
    expect(resolveSubAgentPermissionPolicy(ask, 'manager').mode).toBe('ask');
  });

  it('user mode uses sub-agent-user so reads are free but mutations prompt', () => {
    const yolo = { ...DEFAULT_AGENT_SETTINGS, permissionMode: 'yolo' as const };
    const policy = resolveSubAgentPermissionPolicy(yolo, 'user');
    expect(policy.mode).toBe('sub-agent-user');
    // Reads are free
    expect(decideToolPermission(policy, 'read_file').action).toBe('allow');
    expect(decideToolPermission(policy, 'grep').action).toBe('allow');
    expect(decideToolPermission(policy, 'glob').action).toBe('allow');
    // Mutations prompt
    expect(decideToolPermission(policy, 'write_file').action).toBe('ask');
    expect(decideToolPermission(policy, 'delete_file').action).toBe('ask');
    expect(decideToolPermission(policy, 'bash').action).toBe('ask');
  });

  it('auto mode forces YOLO so workers run without approval prompts', () => {
    const ask = { ...DEFAULT_AGENT_SETTINGS, permissionMode: 'ask' as const };
    expect(resolveSubAgentPermissionPolicy(ask, 'auto').mode).toBe('yolo');
  });

  it('undefined falls back to manager inheritance', () => {
    const guarded = { ...DEFAULT_AGENT_SETTINGS, permissionMode: 'guarded' as const };
    expect(resolveSubAgentPermissionPolicy(guarded, undefined).mode).toBe('guarded');
  });

  it('auto mode bypasses the sandbox for workers', () => {
    const settings = {
      ...DEFAULT_AGENT_SETTINGS,
      sandbox: { ...DEFAULT_AGENT_SETTINGS.sandbox, mode: 'always' as const },
    };
    expect(resolveSubAgentSandboxOptions(settings, 'auto', true).isSandboxed).toBe(false);
  });

  it('user mode honors the sandbox settings', () => {
    const settings = {
      ...DEFAULT_AGENT_SETTINGS,
      sandbox: { ...DEFAULT_AGENT_SETTINGS.sandbox, mode: 'always' as const },
    };
    expect(resolveSubAgentSandboxOptions(settings, 'user', true).isSandboxed).toBe(true);
  });

  it('manager mode honors the sandbox settings', () => {
    const settings = { ...DEFAULT_AGENT_SETTINGS };
    expect(resolveSubAgentSandboxOptions(settings, 'manager', true).isSandboxed).toBe(true);
    expect(resolveSubAgentSandboxOptions(settings, 'manager', false).isSandboxed).toBe(false);
  });
});

describe('sub-agent approval integration with ToolRegistry', () => {
  const riskyTool: Tool = {
    name: 'delete_file',
    description: 'Delete a file (risky tool)',
    parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
    category: 'file-edit',
    run: async (_ctx, call) => ({
      callId: call.id,
      name: 'delete_file',
      output: 'ran',
      isError: false,
      durationMs: 0,
    }),
  };
  const editTool: Tool = {
    name: 'write_file',
    description: 'Write a file (file-edit tool, not risky)',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string' }, content: { type: 'string' } },
      required: ['path', 'content'],
    },
    category: 'file-edit',
    run: async (_ctx, call) => ({
      callId: call.id,
      name: 'write_file',
      output: 'ran',
      isError: false,
      durationMs: 0,
    }),
  };
  const registry = new ToolRegistry();
  registry.register(riskyTool);
  registry.register(editTool);

  function workerCtx(
    approval: 'manager' | 'user' | 'auto',
    baseSettingsOverrides: Partial<typeof DEFAULT_AGENT_SETTINGS> = {},
  ): ToolContext {
    const baseSettings = { ...DEFAULT_AGENT_SETTINGS, ...baseSettingsOverrides };
    const ctx: ToolContext = {
      sessionId: 'sub-agent-integration',
      workingDirectory: '/tmp/test',
      permissionPolicy: resolveSubAgentPermissionPolicy(baseSettings, approval),
      sandboxOptions: resolveSubAgentSandboxOptions(baseSettings, approval, true),
      approvedToolCallIds: new Set(),
      waitForUserInput: async () => 'Reject', // simulate user rejecting
    };
    return ctx;
  }

  it('user mode prompts the user via waitForUserInput for a risky tool', async () => {
    const ctx = workerCtx('user', { permissionMode: 'yolo' });
    // Even though the base preset is YOLO, user mode forces sub-agent-user.
    const result = await registry.execute(ctx, {
      id: 'sub-agent-user-1',
      name: 'delete_file',
      input: { path: 'example.txt' },
    });
    expect(result.isError).toBe(true);
    expect(result.output).toContain('rejected');
  });

  it('user mode also prompts for file edits (writes are mutations)', async () => {
    const ctx = workerCtx('user', { permissionMode: 'yolo' });
    const result = await registry.execute(ctx, {
      id: 'sub-agent-user-2',
      name: 'write_file',
      input: { path: 'example.txt', content: 'test' },
    });
    // File edits are mutations → user must approve → user rejected.
    expect(result.isError).toBe(true);
    expect(result.output).toContain('rejected');
  });

  it('user mode allows read-only tools without prompting', async () => {
    const ctx = workerCtx('user', { permissionMode: 'ask' });
    let prompted = false;
    ctx.waitForUserInput = async () => {
      prompted = true;
      return 'Allow once';
    };
    // read_file is read-only → sub-agent-user allows it without prompting.
    // We don't have a read_file tool registered, but we can verify the policy
    // decision directly.
    const decision = decideToolPermission(ctx.permissionPolicy, 'read_file');
    expect(decision.action).toBe('allow');
    expect(prompted).toBe(false);
  });

  it('auto mode bypasses all approval for a risky tool', async () => {
    const ctx = workerCtx('auto', { permissionMode: 'ask' });
    // Even though the base preset is Ask, auto mode forces YOLO.
    let prompted = false;
    ctx.waitForUserInput = async () => {
      prompted = true;
      return 'Allow once';
    };
    const result = await registry.execute(ctx, {
      id: 'sub-agent-auto-1',
      name: 'delete_file',
      input: { path: 'example.txt' },
    });
    expect(prompted).toBe(false);
    expect(result).toMatchObject({ isError: false, output: 'ran' });
  });

  it('manager mode inherits guarded: file edits allowed, risky tools prompt', async () => {
    const ctx = workerCtx('manager', { permissionMode: 'guarded' });
    // write_file is a FILE_EDIT_TOOL (not risky) → guarded allows without prompting.
    let prompted = false;
    ctx.waitForUserInput = async () => {
      prompted = true;
      return 'Deny';
    };
    const editResult = await registry.execute(ctx, {
      id: 'sub-agent-manager-1',
      name: 'write_file',
      input: { path: 'example.txt', content: 'test' },
    });
    expect(prompted).toBe(false);
    expect(editResult).toMatchObject({ isError: false, output: 'ran' });

    // delete_file is risky → guarded prompts. User denies → tool not run.
    const riskyResult = await registry.execute(ctx, {
      id: 'sub-agent-manager-2',
      name: 'delete_file',
      input: { path: 'example.txt' },
    });
    expect(prompted).toBe(true);
    expect(riskyResult.isError).toBe(true);
  });

  it('auto mode bypasses the sandbox for bash commands', () => {
    const ctx = workerCtx('auto', {
      permissionMode: 'ask',
      sandbox: { ...DEFAULT_AGENT_SETTINGS.sandbox, mode: 'always' },
    });
    // sandboxOptions should have isSandboxed=false even with mode='always'.
    expect(ctx.sandboxOptions?.isSandboxed).toBe(false);
  });

  it('user mode keeps the sandbox active', () => {
    const ctx = workerCtx('user', {
      sandbox: { ...DEFAULT_AGENT_SETTINGS.sandbox, mode: 'always' },
    });
    expect(ctx.sandboxOptions?.isSandboxed).toBe(true);
  });
});

describe('tool allowlist and blocklist', () => {
  function policyWith(overrides: Partial<typeof DEFAULT_AGENT_SETTINGS> = {}) {
    return resolveToolPermissionPolicy({ ...DEFAULT_AGENT_SETTINGS, ...overrides });
  }

  it('blocklist denies a tool regardless of permission mode', () => {
    const p = policyWith({ permissionMode: 'yolo', toolBlocklist: ['bash'] });
    expect(decideToolPermission(p, 'bash')).toMatchObject({ action: 'deny' });
  });

  it('blocklist denies even if the tool is also on the allowlist', () => {
    const p = policyWith({
      permissionMode: 'yolo',
      toolAllowlist: ['bash'],
      toolBlocklist: ['bash'],
    });
    expect(decideToolPermission(p, 'bash')).toMatchObject({ action: 'deny' });
  });

  it('allowlist bypasses approval in ask mode', () => {
    const p = policyWith({ permissionMode: 'ask', toolAllowlist: ['write_file'] });
    expect(decideToolPermission(p, 'write_file')).toMatchObject({ action: 'allow' });
  });

  it('allowlist bypasses approval for risky tools', () => {
    const p = policyWith({ permissionMode: 'guarded', toolAllowlist: ['delete_file'] });
    expect(decideToolPermission(p, 'delete_file')).toMatchObject({ action: 'allow' });
  });

  it('allowlist bypasses approval in sub-agent-user mode', () => {
    const p = resolveSubAgentPermissionPolicy(
      { ...DEFAULT_AGENT_SETTINGS, permissionMode: 'yolo', toolAllowlist: ['bash'] },
      'user',
    );
    expect(decideToolPermission(p, 'bash')).toMatchObject({ action: 'allow' });
  });

  it('blocklist denies in sub-agent-user mode', () => {
    const p = resolveSubAgentPermissionPolicy(
      { ...DEFAULT_AGENT_SETTINGS, permissionMode: 'yolo', toolBlocklist: ['read_file'] },
      'user',
    );
    expect(decideToolPermission(p, 'read_file')).toMatchObject({ action: 'deny' });
  });

  it('default (no lists) follows the permission mode', () => {
    const p = policyWith({ permissionMode: 'ask', toolAllowlist: [], toolBlocklist: [] });
    expect(decideToolPermission(p, 'bash')).toMatchObject({ action: 'ask' });
  });

  it('interaction tools are always allowed even if blocklisted', () => {
    const p = policyWith({ permissionMode: 'ask', toolBlocklist: ['ask_user'] });
    expect(decideToolPermission(p, 'ask_user')).toMatchObject({ action: 'allow' });
  });

  it('allowlist does not affect tools not on the list', () => {
    const p = policyWith({ permissionMode: 'ask', toolAllowlist: ['read_file'] });
    expect(decideToolPermission(p, 'bash')).toMatchObject({ action: 'ask' });
  });

  it('blocklist does not affect tools not on the list', () => {
    const p = policyWith({ permissionMode: 'yolo', toolBlocklist: ['bash'] });
    expect(decideToolPermission(p, 'read_file')).toMatchObject({ action: 'allow' });
  });

  it('resolveToolPermissionPolicy carries the lists into the policy', () => {
    const p = policyWith({ toolAllowlist: ['bash', 'grep'], toolBlocklist: ['delete_file'] });
    expect(p.toolAllowlist).toEqual(['bash', 'grep']);
    expect(p.toolBlocklist).toEqual(['delete_file']);
  });

  it('resolveToolPermissionPolicy defaults to empty arrays when unset', () => {
    const p = resolveToolPermissionPolicy({
      ...DEFAULT_AGENT_SETTINGS,
      toolAllowlist: undefined as unknown as string[],
      toolBlocklist: undefined as unknown as string[],
    });
    expect(p.toolAllowlist).toEqual([]);
    expect(p.toolBlocklist).toEqual([]);
  });
});

describe('tool allowlist/blocklist integration with ToolRegistry', () => {
  const testTool: Tool = {
    name: 'delete_file',
    description: 'Delete a file',
    parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
    category: 'file-edit',
    run: async (_ctx, call) => ({
      callId: call.id,
      name: 'delete_file',
      output: 'ran',
      isError: false,
      durationMs: 0,
    }),
  };
  const registry = new ToolRegistry();
  registry.register(testTool);

  function ctxWith(overrides: Partial<typeof DEFAULT_AGENT_SETTINGS> = {}): ToolContext {
    const settings = { ...DEFAULT_AGENT_SETTINGS, ...overrides };
    return {
      sessionId: 'allowlist-test',
      workingDirectory: '/tmp/test',
      permissionPolicy: resolveToolPermissionPolicy(settings),
      approvedToolCallIds: new Set(),
      waitForUserInput: async () => 'Reject',
    };
  }

  it('blocklisted tool is denied even in YOLO mode', async () => {
    const ctx = ctxWith({ permissionMode: 'yolo', toolBlocklist: ['delete_file'] });
    const result = await registry.execute(ctx, {
      id: 'call-1',
      name: 'delete_file',
      input: { path: 'example.txt' },
    });
    expect(result.isError).toBe(true);
    expect(result.output).toContain('blocked');
  });

  it('allowlisted tool runs without prompting in ask mode', async () => {
    const ctx = ctxWith({ permissionMode: 'ask', toolAllowlist: ['delete_file'] });
    let prompted = false;
    ctx.waitForUserInput = async () => {
      prompted = true;
      return 'Allow once';
    };
    const result = await registry.execute(ctx, {
      id: 'call-2',
      name: 'delete_file',
      input: { path: 'example.txt' },
    });
    expect(prompted).toBe(false);
    expect(result).toMatchObject({ isError: false, output: 'ran' });
  });
});
