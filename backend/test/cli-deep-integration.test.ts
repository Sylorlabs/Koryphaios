import { describe, test, expect } from 'bun:test';
import {
  ClaudeCodeCliBridge,
  CodexCliBridge,
  AntigravityCliBridge,
  CursorCliBridge,
  KORY_HARNESS_NOTE,
} from '../src/providers/cli-bridges';
import { DevinCliBridge } from '../src/providers/devin-bridge';
import { buildKoryRules, buildKorySkills, writeAllCliRulesAndSkills } from '../src/providers/cli-rules-skills';
import { existsSync, readFileSync, rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// ─── Native tool blocking ──────────────────────────────────────────────────

describe('Native tool blocking (Claude Code)', () => {
  const bridge = new ClaudeCodeCliBridge();
  const ctx = {
    provider: 'claude' as const,
    role: 'manager' as const,
    sandbox: undefined,
    workingDirectory: '/tmp',
    sessionId: 'test',
    systemPrompt: 'test',
    tools: [],
  };

  test('denies all native Claude Code tools', () => {
    const scopes = bridge.buildPermissionScopes(ctx);
    expect(scopes.deny).toContain('Read');
    expect(scopes.deny).toContain('Edit');
    expect(scopes.deny).toContain('Write');
    expect(scopes.deny).toContain('Bash');
    expect(scopes.deny).toContain('Glob');
    expect(scopes.deny).toContain('Grep');
    expect(scopes.deny).toContain('LS');
    expect(scopes.deny).toContain('WebFetch');
    expect(scopes.deny).toContain('WebSearch');
    expect(scopes.deny).toContain('Task');
    expect(scopes.deny).toContain('Agent');
  });

  test('allows only kory__ MCP tools + TodoWrite', () => {
    const scopes = bridge.buildPermissionScopes(ctx);
    expect(scopes.allow).toContain('mcp__kory__read_file');
    expect(scopes.allow).toContain('mcp__kory__edit_file');
    expect(scopes.allow).toContain('mcp__kory__bash');
    expect(scopes.allow).toContain('mcp__kory__delegate_to_worker');
    expect(scopes.allow).toContain('TodoWrite');
    // No native tools in allow list (except TodoWrite)
    const nativeInAllow = scopes.allow.filter((t) => !t.startsWith('mcp__kory__') && t !== 'TodoWrite');
    expect(nativeInAllow).toEqual([]);
  });

  test('critic role only allows read-only kory tools', () => {
    const scopes = bridge.buildPermissionScopes({ ...ctx, role: 'critic' });
    expect(scopes.allow).toContain('mcp__kory__read_file');
    expect(scopes.allow).toContain('mcp__kory__grep');
    expect(scopes.allow).not.toContain('mcp__kory__edit_file');
    expect(scopes.allow).not.toContain('mcp__kory__write_file');
    expect(scopes.allow).not.toContain('mcp__kory__bash');
    expect(scopes.allow).not.toContain('mcp__kory__delegate_to_worker');
  });
});

describe('Native tool blocking (Devin)', () => {
  test('buildAgentConfig lists only kory__ tools as allowed', () => {
    const bridge = new DevinCliBridge();
    // Force capabilities by calling ensureCapabilitiesSync with a mock
    (bridge as any).cached = {
      supportsAgentConfig: true,
      supportsHooks: true,
      supportsMcp: true,
      supportsAcp: false,
      supportsSandbox: false,
      supportsExport: true,
      supportsPermissionMode: true,
      supportsRules: true,
      supportsSkills: true,
      version: '3000.3.22',
      binaryPath: '/usr/bin/devin',
      binaryMtimeMs: 0,
      rulesDirs: [],
      skillsDirs: [],
      models: [],
      probedAt: Date.now(),
    };
    const config = bridge.buildAgentConfig({
      provider: 'devin',
      role: 'manager',
      sandbox: undefined,
      workingDirectory: '/tmp',
      sessionId: 'test',
      systemPrompt: 'test',
      tools: [],
    });
    expect(config).not.toBeNull();
    expect(config!.allowedTools).toContain('kory__read_file');
    expect(config!.allowedTools).toContain('kory__bash');
    expect(config!.allowedTools).toContain('kory__delegate_to_worker');
    // Should not contain native tool names
    expect(config!.allowedTools).not.toContain('read');
    expect(config!.allowedTools).not.toContain('edit');
    expect(config!.allowedTools).not.toContain('exec');
  });

  test('critic role restricts to read-only kory tools', () => {
    const bridge = new DevinCliBridge();
    (bridge as any).cached = {
      supportsAgentConfig: true, supportsHooks: true, supportsMcp: true,
      supportsAcp: false, supportsSandbox: false, supportsExport: true,
      supportsPermissionMode: true, supportsRules: true, supportsSkills: true,
      version: '3000.3.22', binaryPath: '/usr/bin/devin', binaryMtimeMs: 0,
      rulesDirs: [], skillsDirs: [], models: [], probedAt: Date.now(),
    };
    const config = bridge.buildAgentConfig({
      provider: 'devin',
      role: 'critic',
      sandbox: undefined,
      workingDirectory: '/tmp',
      sessionId: 'test',
      systemPrompt: 'test',
      tools: [],
    });
    expect(config!.allowedTools).toContain('kory__read_file');
    expect(config!.allowedTools).not.toContain('kory__edit_file');
    expect(config!.allowedTools).not.toContain('kory__bash');
  });
});

describe('Native tool blocking (Codex)', () => {
  test('buildAgentConfig lists only kory__ tools', () => {
    const bridge = new CodexCliBridge();
    const config = bridge.buildAgentConfig({
      provider: 'codex',
      role: 'manager',
      sandbox: undefined,
      workingDirectory: '/tmp',
      sessionId: 'test',
      systemPrompt: 'test',
      tools: [],
    });
    expect(config).not.toBeNull();
    expect(config!.allowedTools).toContain('kory__read_file');
    expect(config!.allowedTools).toContain('kory__bash');
    expect(config!.allowedTools).toContain('kory__delegate_to_worker');
  });
});

// ─── MCP config generation ─────────────────────────────────────────────────

describe('MCP config generation', () => {
  const ctx = {
    provider: 'claude' as const,
    role: 'manager' as const,
    sandbox: undefined,
    workingDirectory: '/tmp',
    sessionId: 'test-session',
    systemPrompt: 'test',
    tools: [],
  };

  test('Claude Code always generates kory MCP config', () => {
    const bridge = new ClaudeCodeCliBridge();
    const configs = bridge.buildMcpConfig(ctx);
    expect(configs).not.toBeNull();
    expect(configs!.length).toBe(1);
    expect(configs![0].name).toBe('kory');
    expect(configs![0].args).toContain('--session-id');
    expect(configs![0].args).toContain('test-session');
  });

  test('Cursor always generates kory MCP config', () => {
    const bridge = new CursorCliBridge();
    const configs = bridge.buildMcpConfig(ctx);
    expect(configs).not.toBeNull();
    expect(configs![0].name).toBe('kory');
  });

  test('Antigravity always generates kory MCP config', () => {
    const bridge = new AntigravityCliBridge();
    const configs = bridge.buildMcpConfig(ctx);
    expect(configs).not.toBeNull();
    expect(configs![0].name).toBe('kory');
  });
});

// ─── Hooks config generation ───────────────────────────────────────────────

describe('Hooks config generation', () => {
  const ctx = {
    provider: 'claude' as const,
    role: 'manager' as const,
    sandbox: undefined,
    workingDirectory: '/tmp',
    sessionId: 'test-session',
    systemPrompt: 'test',
    tools: [],
  };

  test('Claude Code generates PreToolUse + Stop hooks when script is set', () => {
    const bridge = new ClaudeCodeCliBridge();
    process.env.KORY_HOOK_BRIDGE_SCRIPT = '/path/to/hook-bridge.js';
    const hooks = bridge.buildHooks(ctx);
    expect(hooks).not.toBeNull();
    expect(hooks!.length).toBe(2);
    expect(hooks![0].events).toContain('PreToolUse');
    expect(hooks![0].events).toContain('PostToolUse');
    expect(hooks![1].events).toContain('Stop');
    delete process.env.KORY_HOOK_BRIDGE_SCRIPT;
  });

  test('Antigravity generates hooks when script is set', () => {
    const bridge = new AntigravityCliBridge();
    process.env.KORY_HOOK_BRIDGE_SCRIPT = '/path/to/hook-bridge.js';
    const hooks = bridge.buildHooks(ctx);
    expect(hooks).not.toBeNull();
    expect(hooks![0].events).toContain('PreToolUse');
    delete process.env.KORY_HOOK_BRIDGE_SCRIPT;
  });

  test('serializeHooks produces valid JSON with event keys', () => {
    const bridge = new ClaudeCodeCliBridge();
    process.env.KORY_HOOK_BRIDGE_SCRIPT = '/path/to/hook-bridge.js';
    const hooks = bridge.buildHooks(ctx)!;
    const json = bridge.serializeHooks(hooks);
    const parsed = JSON.parse(json);
    expect(parsed).toHaveProperty('PreToolUse');
    expect(parsed).toHaveProperty('Stop');
    expect(parsed.PreToolUse[0].hooks[0].type).toBe('command');
    delete process.env.KORY_HOOK_BRIDGE_SCRIPT;
  });
});

// ─── Rules & skills mirroring ──────────────────────────────────────────────

describe('Rules & skills mirroring', () => {
  test('buildKoryRules includes tool usage + orchestration rules', () => {
    const rules = buildKoryRules('Custom session prompt');
    expect(rules).toContain('kory__ MCP tools');
    expect(rules).toContain('Do NOT use native built-in tools');
    expect(rules).toContain('kory__delegate_to_worker');
    expect(rules).toContain('Custom session prompt');
  });

  test('buildKorySkills returns tool usage + orchestration skills', () => {
    const skills = buildKorySkills();
    expect(skills.length).toBeGreaterThanOrEqual(2);
    const toolSkill = skills.find((s) => s.name === 'kory-tool-usage');
    expect(toolSkill).toBeDefined();
    expect(toolSkill!.body).toContain('kory__read_file');
    expect(toolSkill!.body).toContain('kory__bash');
    expect(toolSkill!.body).toContain('kory__delegate_to_worker');
    const orchSkill = skills.find((s) => s.name === 'kory-orchestration');
    expect(orchSkill).toBeDefined();
    expect(orchSkill!.body).toContain('Manager');
    expect(orchSkill!.body).toContain('Worker');
    expect(orchSkill!.body).toContain('Critic');
    expect(orchSkill!.body).toContain('Suggest Goal Mode');
    expect(orchSkill!.body).toContain('reusable workflow');
    expect(orchSkill!.body).toContain('explicit user approval');
  });

  test('writeAllCliRulesAndSkills writes rules files for all CLIs', () => {
    // Write to the real home (the function uses homedir() which is cached).
    // Clean up the test session dir afterward.
    const testSessionId = `test-rules-${Date.now()}`;
    writeAllCliRulesAndSkills(testSessionId, 'Test system prompt');
    const home = process.env.HOME || process.env.HOMEPATH || '';
    try {
      // Check that rules files were written for each CLI
      const expected = [
        join(home, '.koryphaios', 'devin-home', testSessionId, 'AGENTS.md'),
        join(home, '.koryphaios', 'claude-home', 'CLAUDE.md'),
        join(home, '.koryphaios', 'antigravity-home', 'AGENTS.md'),
        join(home, '.koryphaios', 'codex-home', 'AGENTS.md'),
        join(home, '.koryphaios', 'cline-home', '.clinerules'),
        join(home, '.koryphaios', 'cursor-home', '.cursorrules'),
        join(home, '.koryphaios', 'grok-home', '.grokrules'),
      ];
      for (const path of expected) {
        expect(existsSync(path)).toBe(true);
        const content = readFileSync(path, 'utf-8');
        expect(content).toContain('kory__');
      }
      // Check skills were written for Devin
      const devinSkill = join(home, '.koryphaios', 'devin-home', testSessionId, '.devin', 'skills', 'kory-tool-usage', 'SKILL.md');
      expect(existsSync(devinSkill)).toBe(true);
      // Check skills were written for Antigravity
      const agySkill = join(home, '.koryphaios', 'antigravity-home', '.claude', 'skills', 'kory-tool-usage', 'SKILL.md');
      expect(existsSync(agySkill)).toBe(true);
    } finally {
      // Clean up the test session dir
      rmSync(join(home, '.koryphaios', 'devin-home', testSessionId), { recursive: true, force: true });
    }
  });
});

// ─── Harness note content ──────────────────────────────────────────────────

describe('KORY_HARNESS_NOTE content', () => {
  test('instructs CLI to use kory__ MCP tools', () => {
    expect(KORY_HARNESS_NOTE).toContain('kory__read_file');
    expect(KORY_HARNESS_NOTE).toContain('kory__edit_file');
    expect(KORY_HARNESS_NOTE).toContain('kory__bash');
    expect(KORY_HARNESS_NOTE).toContain('kory__delegate_to_worker');
  });

  test('instructs CLI to NOT use native tools', () => {
    expect(KORY_HARNESS_NOTE).toContain('Do NOT use your native built-in tools');
    expect(KORY_HARNESS_NOTE).toContain('they are disabled');
  });

  test('mentions permission + sandbox policy', () => {
    expect(KORY_HARNESS_NOTE).toContain('permission');
    expect(KORY_HARNESS_NOTE).toContain('sandbox');
  });
});
