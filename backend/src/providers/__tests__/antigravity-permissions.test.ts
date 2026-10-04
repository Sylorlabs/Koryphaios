import { test, expect, describe } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  buildAntigravityHooks,
  buildAntigravitySettings,
  antigravityNativeToolEquivalent,
  isAntigravitySafeNativeTool,
} from '../antigravity-permissions';

describe('antigravity permission policy', () => {
  test('denies every native capability Koryphaios owns execution of', () => {
    const { permissions } = buildAntigravitySettings({ workspacePath: '/workspace/project' });
    // Deny beats Ask beats Allow, so nothing here can be re-enabled by an
    // allow-rule or by an upstream default.
    expect(permissions.deny).toContain('command(*)');
    expect(permissions.deny).toContain('unsandboxed(*)');
    expect(permissions.deny).toContain('write_file(*)');
    expect(permissions.deny).toContain('read_url(*)');
    expect(permissions.deny).toContain('execute_url(*)');
  });

  test('never selects a preset that disables the gate headlessly', () => {
    // `always-proceed` is --dangerously-skip-permissions; `strict` also denies
    // workspace reads headlessly, which leaves the agent unable to work.
    expect(buildAntigravitySettings({ workspacePath: null }).toolPermission).toBe('request-review');
  });

  test('always allows the kory MCP server — without it nothing else is reachable', () => {
    for (const workspace of [null, '/workspace/project']) {
      const settings = buildAntigravitySettings({ workspacePath: workspace });
      expect(settings.permissions.allow).toContain('mcp(kory/*)');
    }
  });

  test('trusts the workspace so reads need no approval headlessly', () => {
    const settings = buildAntigravitySettings({ workspacePath: '/workspace/project' });
    expect(settings.trustedWorkspaces).toEqual(['/workspace/project']);
    expect(settings.permissions.allow).toContain('read_file(/workspace/project)');
    expect(settings.allowNonWorkspaceAccess).toBe(false);
    expect(settings.enableTerminalSandbox).toBe(true);
  });

  test('trusts the canonical workspace path, so a symlinked path still matches', () => {
    // agy resolves a workspace to its real path before matching rules. A macOS
    // `/var` → `/private/var` style workspace would otherwise be denied.
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'kory-agy-policy-')));
    const link = join(root, 'link');
    try {
      symlinkSync(root, link);
      const viaLink = buildAntigravitySettings({ workspacePath: link });
      const viaReal = buildAntigravitySettings({ workspacePath: root });
      expect(viaLink.trustedWorkspaces).toEqual(viaReal.trustedWorkspaces);
      expect(viaLink.permissions.allow).toContain(`read_file(${root})`);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('grants nothing when there is no workspace to trust', () => {
    const settings = buildAntigravitySettings({ workspacePath: null });
    expect(settings.trustedWorkspaces).toEqual([]);
    expect(settings.permissions.allow).toEqual(['mcp(kory/*)']);
    // Writes stay denied even with no workspace, so the agent still cannot edit.
    expect(settings.permissions.deny).toContain('write_file(*)');
  });

  test('leaves ask empty because headless turns cannot answer a prompt', () => {
    expect(buildAntigravitySettings({ workspacePath: '/w' }).permissions.ask).toEqual([]);
  });

  test('policy does not vary with Kory permission mode', () => {
    // Koryphaios owns execution for every mode; the approval preset is applied
    // to kory__ bridge calls by permission-policy.ts, not here.
    const a = buildAntigravitySettings({ workspacePath: '/w' });
    const b = buildAntigravitySettings({ workspacePath: '/w' });
    expect(a).toEqual(b);
  });
});

describe('antigravity native tool mapping', () => {
  test('maps agy step-type names to kory equivalents', () => {
    // agy names tools after the step type, not Claude's read/write/exec.
    expect(antigravityNativeToolEquivalent('run_command')).toEqual({
      kind: 'kory',
      kory: 'kory__bash',
    });
    expect(antigravityNativeToolEquivalent('view_file')).toEqual({
      kind: 'kory',
      kory: 'kory__read_file',
    });
    expect(antigravityNativeToolEquivalent('write_to_file')).toEqual({
      kind: 'kory',
      kory: 'kory__write_file',
    });
    expect(antigravityNativeToolEquivalent('search_web')).toEqual({
      kind: 'kory',
      kory: 'kory__web_search',
    });
  });

  test('routes subagent tools to Koryphaios orchestration', () => {
    for (const tool of ['invoke_subagent', 'define_subagent', 'manage_subagents', 'send_message']) {
      expect(antigravityNativeToolEquivalent(tool)).toEqual({ kind: 'delegate' });
    }
  });

  test('allows only provider-local bookkeeping', () => {
    for (const tool of ['finish', 'todo_write', 'manage_task', 'list_permissions', 'generate_image']) {
      expect(isAntigravitySafeNativeTool(tool)).toBe(true);
      expect(antigravityNativeToolEquivalent(tool)).toEqual({ kind: 'safe' });
    }
    expect(isAntigravitySafeNativeTool('run_command')).toBe(false);
  });

  test('falls through to default-deny for anything unrecognized', () => {
    expect(antigravityNativeToolEquivalent('some_future_tool')).toEqual({ kind: 'unknown' });
  });
});

describe('antigravity hooks file', () => {
  const hooks = JSON.parse(
    buildAntigravityHooks({ hookScript: '/kory/hook.js', authFile: '/grant/auth.json' }),
  );

  test('keys hooks by name, which is what agy parses', () => {
    expect(Object.keys(hooks)).toEqual(['kory-permission-gate']);
    expect(hooks['kory-permission-gate'].enabled).toBe(true);
  });

  test('matches every tool so no native tool slips past unmatched', () => {
    const groups = hooks['kory-permission-gate'].PreToolUse;
    expect(groups).toHaveLength(1);
    expect(groups[0].matcher).toBe('');
  });

  test('selects the agy decision vocabulary rather than Claude approve/block', () => {
    const command: string = hooks['kory-permission-gate'].PreToolUse[0].hooks[0].command;
    expect(command).toContain('--event PreToolUse');
    expect(command).toContain('--decision-vocabulary antigravity');
    expect(command).toContain('--auth-file "/grant/auth.json"');
  });

  test('is valid JSON on disk with a trailing newline', () => {
    const raw = buildAntigravityHooks({ hookScript: '/a', authFile: '/b' });
    expect(raw.endsWith('\n')).toBe(true);
    expect(() => JSON.parse(raw)).not.toThrow();
  });
});

describe('antigravity bridge grant path', () => {
  test('auth file is carried verbatim so the hook can authenticate', () => {
    const dir = mkdtempSync(join(tmpdir(), 'kory-agy-hooks-'));
    try {
      mkdirSync(join(dir, 'nested'), { recursive: true });
      const authFile = join(dir, 'nested', 'bridge-grant.json');
      const parsed = JSON.parse(buildAntigravityHooks({ hookScript: '/a.js', authFile }));
      expect(parsed['kory-permission-gate'].PreToolUse[0].hooks[0].command).toContain(authFile);
      expect(dirname(authFile)).toBe(join(dir, 'nested'));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});