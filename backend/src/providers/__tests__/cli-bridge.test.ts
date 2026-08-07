import { describe, test, expect } from 'bun:test';
import { DevinCliBridge } from '../devin-bridge';
import { sandboxToScopes, roleToPermissionMode } from '../cli-bridge';
import {
  ClaudeCodeCliBridge,
  CodexCliBridge,
  ClineCliBridge,
  CursorCliBridge,
  AntigravityCliBridge,
  GrokCliBridge,
  KimiCodeCliBridge,
  getCliBridge,
  KORY_HARNESS_NOTE,
} from '../cli-bridges';
import type { SandboxPolicy } from '@koryphaios/shared';
import { SANDBOX_PRESETS } from '@koryphaios/shared';

// ─── Helpers ───────────────────────────────────────────────────────────────

const balancedSandbox: SandboxPolicy = SANDBOX_PRESETS.balanced;
const readonlySandbox: SandboxPolicy = SANDBOX_PRESETS.readonly;
const hardenedSandbox: SandboxPolicy = SANDBOX_PRESETS.hardened;
const trustedSandbox: SandboxPolicy = SANDBOX_PRESETS.trusted;

function makeCtx(overrides: Partial<{
  sandbox: SandboxPolicy | undefined;
  role: 'manager' | 'worker' | 'critic';
  systemPrompt: string;
  sessionId: string;
}> = {}) {
  return {
    provider: 'devin' as const,
    role: overrides.role ?? 'manager',
    sandbox: overrides.sandbox,
    workingDirectory: '/tmp/test',
    sessionId: overrides.sessionId ?? 'test-session',
    systemPrompt: overrides.systemPrompt ?? 'You are a helpful assistant.',
    tools: [],
    promptManifestHash: 'abc123',
    taskContractHash: 'def456',
  };
}

// ─── Permission-scope translator (shared) ──────────────────────────────────

describe('sandboxToScopes', () => {
  test('balanced sandbox allows edits/shell/web', () => {
    const scopes = sandboxToScopes(balancedSandbox, 'manager');
    expect(scopes.deny).not.toContain('Write(**)');
    expect(scopes.deny).not.toContain('Exec(*)');
    expect(scopes.deny).not.toContain('Fetch(*)');
  });

  test('readonly sandbox denies writes/shell/web', () => {
    const scopes = sandboxToScopes(readonlySandbox, 'manager');
    expect(scopes.deny).toContain('Write(**)');
    expect(scopes.deny).toContain('Exec(*)');
    expect(scopes.deny).toContain('Fetch(*)');
  });

  test('hardened sandbox denies shell and web but allows edits', () => {
    const scopes = sandboxToScopes(hardenedSandbox, 'manager');
    expect(scopes.deny).toContain('Exec(*)');
    expect(scopes.deny).toContain('Fetch(*)');
    expect(scopes.deny).not.toContain('Write(**)');
  });

  test('trusted sandbox denies nothing', () => {
    const scopes = sandboxToScopes(trustedSandbox, 'manager');
    expect(scopes.deny).not.toContain('Write(**)');
    expect(scopes.deny).not.toContain('Exec(*)');
  });

  test('critic role denies writes and shell regardless of sandbox', () => {
    const scopes = sandboxToScopes(trustedSandbox, 'critic');
    expect(scopes.deny).toContain('Write(**)');
    expect(scopes.deny).toContain('Exec(*)');
  });

  test('command blocklist fragments map to Exec denies', () => {
    const scopes = sandboxToScopes(balancedSandbox, 'manager');
    expect(scopes.deny.some((d) => d.includes('rm -rf /'))).toBe(true);
    expect(scopes.deny.some((d) => d.includes('mkfs'))).toBe(true);
  });

  test('undefined sandbox denies nothing (except critic role)', () => {
    const scopes = sandboxToScopes(undefined, 'manager');
    expect(scopes.deny).toEqual([]);
  });

  test('deny scopes are deduplicated', () => {
    const scopes = sandboxToScopes(readonlySandbox, 'critic');
    const unique = new Set(scopes.deny);
    expect(scopes.deny.length).toBe(unique.size);
  });
});

// ─── Role-to-permission-mode translator ────────────────────────────────────

describe('roleToPermissionMode', () => {
  test('critic → plan', () => {
    expect(roleToPermissionMode('critic', undefined)).toBe('plan');
  });

  test('manager with readonly sandbox → read-only', () => {
    expect(roleToPermissionMode('manager', readonlySandbox)).toBe('read-only');
  });

  test('manager with hardened sandbox → read-only', () => {
    expect(roleToPermissionMode('manager', hardenedSandbox)).toBe('read-only');
  });

  test('manager with balanced sandbox → accept-edits', () => {
    expect(roleToPermissionMode('manager', balancedSandbox)).toBe('accept-edits');
  });

  test('worker with no sandbox → accept-edits', () => {
    expect(roleToPermissionMode('worker', undefined)).toBe('accept-edits');
  });
});

// ─── Devin agent-config builder ────────────────────────────────────────────

describe('DevinCliBridge.buildAgentConfig', () => {
  test('returns null when capabilities not probed (supportsAgentConfig=false)', () => {
    const bridge = new DevinCliBridge();
    // Without ensureCapabilities(), caps is null → supportsAgentConfig is false
    expect(bridge.buildAgentConfig(makeCtx())).toBeNull();
  });

  test('serializeAgentConfig emits only strict-parser-accepted fields', () => {
    const bridge = new DevinCliBridge();
    const config = {
      systemInstructions: ['test instruction'],
      allowedTools: ['read', 'exec'],
      permissions: { allow: ['Read(**)'], deny: ['Exec(rm)'], ask: [] },
      extensions: { kory_session_id: 'test' },
    };
    const json = bridge.serializeAgentConfig(config);
    const parsed = JSON.parse(json);
    // Must have exactly these top-level keys (strict parser rejects unknowns)
    expect(Object.keys(parsed).sort()).toEqual(
      ['allowed_tools', 'extensions', 'permissions', 'system_instructions'].sort(),
    );
    expect(parsed.system_instructions).toEqual(['test instruction']);
    expect(parsed.allowed_tools).toEqual(['read', 'exec']);
    expect(parsed.permissions.allow).toEqual(['Read(**)']);
    expect(parsed.permissions.deny).toEqual(['Exec(rm)']);
    expect(parsed.extensions.kory_session_id).toBe('test');
  });

  test('serializeAgentConfig never emits mcp_servers (D3: strict parser rejects stdio)', () => {
    const bridge = new DevinCliBridge();
    const json = bridge.serializeAgentConfig({
      systemInstructions: [],
      allowedTools: [],
      permissions: { allow: [], deny: [], ask: [] },
      extensions: {},
    });
    const parsed = JSON.parse(json);
    expect(parsed).not.toHaveProperty('mcp_servers');
    expect(parsed).not.toHaveProperty('mcpServers');
  });

  test('parseTrajectory extracts reasoning, tool calls, and usage from ATIF', () => {
    const bridge = new DevinCliBridge();
    const atif = JSON.stringify({
      schema_version: 'ATIF-v1.7',
      session_id: 'test-session',
      agent: { name: 'devin', version: '3000.3.22', model_name: 'GLM-5.2', tool_definitions: [] },
      steps: [
        { step_id: 1, source: 'system', message: 'system prompt' },
        { step_id: 2, source: 'user', message: 'hello' },
        {
          step_id: 3,
          source: 'agent',
          message: 'answer',
          reasoning_content: 'thinking about it',
          tool_calls: [{ function_name: 'read', arguments: { path: '/tmp' } }],
          model_name: 'GLM-5.2',
          generation_model: 'GLM-5.2-High',
        },
      ],
      final_metrics: {
        total_prompt_tokens: 100,
        total_completion_tokens: 20,
        total_cached_tokens: 50,
        total_steps: 3,
      },
    });
    const { trajectory, events } = bridge.parseTrajectory(atif);
    expect(trajectory.schemaVersion).toBe('ATIF-v1.7');
    expect(trajectory.modelName).toBe('GLM-5.2');
    expect(trajectory.steps).toHaveLength(3);
    expect(events.some((e) => e.type === 'thinking_delta')).toBe(true);
    expect(events.some((e) => e.type === 'tool_executed')).toBe(true);
    expect(events.some((e) => e.type === 'usage_update')).toBe(true);
  });

  test('parseTrajectory handles malformed JSON gracefully', () => {
    const bridge = new DevinCliBridge();
    const { trajectory, events } = bridge.parseTrajectory('not json');
    expect(trajectory.steps).toEqual([]);
    expect(events).toEqual([]);
  });
});

// ─── Claude Code bridge ────────────────────────────────────────────────────

describe('ClaudeCodeCliBridge', () => {
  test('buildPermissionScopes blocks Task/Agent and sandbox-gated tools', () => {
    const bridge = new ClaudeCodeCliBridge();
    const scopes = bridge.buildPermissionScopes({
      ...makeCtx({ sandbox: readonlySandbox, role: 'manager' }),
      provider: 'claude',
    });
    expect(scopes.deny).toContain('Task');
    expect(scopes.deny).toContain('Agent');
    expect(scopes.deny).toContain('Edit');
    expect(scopes.deny).toContain('Bash');
    expect(scopes.deny).toContain('WebFetch');
  });

  test('buildPermissionScopes critic role denies edits+shell', () => {
    const bridge = new ClaudeCodeCliBridge();
    const scopes = bridge.buildPermissionScopes({
      ...makeCtx({ sandbox: trustedSandbox, role: 'critic' }),
      provider: 'claude',
    });
    expect(scopes.deny).toContain('Edit');
    expect(scopes.deny).toContain('Bash');
  });

  test('buildAgentConfig packages system prompt + harness note', () => {
    const bridge = new ClaudeCodeCliBridge();
    const config = bridge.buildAgentConfig({
      ...makeCtx({ systemPrompt: 'Be careful.' }),
      provider: 'claude',
    });
    expect(config).not.toBeNull();
    expect(config!.systemInstructions[0]).toContain('Be careful.');
    expect(config!.systemInstructions[0]).toContain('Koryphaios');
  });

  test('capabilities report MCP + hooks + rules support', () => {
    const bridge = new ClaudeCodeCliBridge();
    const caps = bridge.getCapabilities();
    expect(caps.supportsMcp).toBe(true);
    expect(caps.supportsHooks).toBe(true);
    expect(caps.supportsRules).toBe(true);
  });
});

// ─── Codex bridge ──────────────────────────────────────────────────────────

describe('CodexCliBridge', () => {
  test('buildAgentConfig returns config for any role (kory__ tools)', () => {
    const bridge = new CodexCliBridge();
    const config = bridge.buildAgentConfig({
      ...makeCtx({ role: 'worker' }),
      provider: 'codex',
    });
    expect(config).not.toBeNull();
    expect(config!.allowedTools).toContain('kory__read_file');
  });

  test('buildAgentConfig returns config for manager with tools', () => {
    const bridge = new CodexCliBridge();
    const config = bridge.buildAgentConfig({
      ...makeCtx({ role: 'manager' }),
      provider: 'codex',
      tools: [{ name: 'kory__create_note', description: 'test', inputSchema: {} }],
    });
    expect(config).not.toBeNull();
    expect(config!.allowedTools).toContain('kory__create_note');
  });

  test('capabilities report sandbox + ACP support', () => {
    const bridge = new CodexCliBridge();
    const caps = bridge.getCapabilities();
    expect(caps.supportsSandbox).toBe(true);
    expect(caps.supportsAcp).toBe(true);
  });
});

// ─── Bridge registry ───────────────────────────────────────────────────────

describe('getCliBridge', () => {
  test('returns the correct bridge class for each provider', () => {
    expect(getCliBridge('claude')).toBeInstanceOf(ClaudeCodeCliBridge);
    expect(getCliBridge('codex')).toBeInstanceOf(CodexCliBridge);
    expect(getCliBridge('cline')).toBeInstanceOf(ClineCliBridge);
    expect(getCliBridge('cursor')).toBeInstanceOf(CursorCliBridge);
    expect(getCliBridge('antigravity')).toBeInstanceOf(AntigravityCliBridge);
    expect(getCliBridge('grok')).toBeInstanceOf(GrokCliBridge);
    expect(getCliBridge('kimicode')).toBeInstanceOf(KimiCodeCliBridge);
  });

  test('returns null for devin (use DevinCliBridge directly)', () => {
    expect(getCliBridge('devin')).toBeNull();
  });

  test('returns null for unknown providers', () => {
    expect(getCliBridge('openai' as any)).toBeNull();
  });

  test('caches bridge instances', () => {
    const a = getCliBridge('claude');
    const b = getCliBridge('claude');
    expect(a).toBe(b);
  });
});

// ─── Shared harness note ───────────────────────────────────────────────────

describe('KORY_HARNESS_NOTE', () => {
  test('mentions Koryphaios orchestrator, kory__ tools, and subagent blocking', () => {
    expect(KORY_HARNESS_NOTE).toContain('Koryphaios');
    expect(KORY_HARNESS_NOTE).toContain('kory__');
    expect(KORY_HARNESS_NOTE).toContain('subagents');
    expect(KORY_HARNESS_NOTE).toContain('delegate');
    expect(KORY_HARNESS_NOTE).toContain('native');
  });
});
