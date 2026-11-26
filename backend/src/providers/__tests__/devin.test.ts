import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { sandboxHome } from '../../collaboration/sandbox-runner';
import { buildDevinProcessEnv, sanitizeDevinOutput, selectDevinResponseEvents } from '../devin';

describe('Devin CLI provider', () => {
  test('keeps the managed Devin home inside a sandbox', () => {
    expect(sandboxHome({ cwd: '/workspace', homeDir: '/managed/devin' })).toBe('/managed/devin');
    expect(sandboxHome({ cwd: '/workspace' })).toBe('/workspace');

    expect(
      buildDevinProcessEnv(
        { PATH: '/usr/bin', HOME: '/real/home' },
        {
          PATH: '/usr/bin',
          HOME: '/temporary/jail',
          XDG_CONFIG_HOME: '/temporary/jail/.config',
          XDG_DATA_HOME: '/temporary/jail/.local/share',
          XDG_CACHE_HOME: '/temporary/jail/.cache',
          XDG_STATE_HOME: '/temporary/jail/.local/state',
        },
        '/managed/devin',
      ),
    ).toMatchObject({
      HOME: '/managed/devin',
      USERPROFILE: '/managed/devin',
      XDG_CONFIG_HOME: '/managed/devin',
      XDG_DATA_HOME: join('/managed/devin', '.local', 'share'),
      XDG_CACHE_HOME: join('/managed/devin', '.cache'),
      XDG_STATE_HOME: join('/managed/devin', '.local', 'state'),
      DEVIN_CONFIG_DIR: '/managed/devin',
      NO_COLOR: '1',
      TERM: 'dumb',
    });
  });

  test('removes terminal control sequences and onboarding from print-mode output', () => {
    const output =
      '\u001b[1mWelcome to Devin CLI!\u001b[0m\n' +
      'Logged in as user@example.com.\n\n' +
      '✓ Organization: example\n' +
      "You're all set. Run \u001b[1mdevin\u001b[0m to get started.\n" +
      '\u001b[1mModel response\u001b[0m\u001b[?2004l';

    expect(sanitizeDevinOutput(output).trim()).toBe('Model response');
  });

  test('prefers exported agent messages over CLI stdout messages', () => {
    expect(
      selectDevinResponseEvents('Loading configuration...\nRequest cancelled\n', [
        { type: 'thinking_delta', thinking: 'Reasoning' },
        { type: 'content_delta', content: 'Agent response' },
      ]),
    ).toEqual([
      { type: 'thinking_delta', thinking: 'Reasoning' },
      { type: 'content_delta', content: 'Agent response' },
    ]);
  });

  test('keeps stdout as a fallback when an older export has no agent message', () => {
    expect(selectDevinResponseEvents('Legacy response\n', [])).toEqual([
      { type: 'content_delta', content: 'Legacy response\n' },
    ]);
  });
});

import { mkdtempSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { DevinCliBridge } from '../devin-bridge';
import type { CliBridgeContext } from '../cli-bridge';

const ctx = (sandbox?: Parameters<DevinCliBridge['buildPermissionScopes']>[0]['sandbox']) =>
  ({
    provider: 'devin',
    role: 'manager',
    sandbox,
    workingDirectory: '/workspace',
    systemPrompt: '',
    tools: [],
  }) as CliBridgeContext;

describe('writeManagedUserConfig', () => {
  // Managed CLI storage refuses writes outside ~/.koryphaios — the test home
  // must live inside that root to exercise the real writer.
  const home = () => mkdtempSync(join(homedir(), '.koryphaios', 'devin-home-test-'));
  const readConfig = (dir: string) =>
    JSON.parse(readFileSync(join(dir, 'devin', 'config.json'), 'utf8'));

  test('writes hooks, permissions, subagent kill and import isolation', () => {
    const dir = home();
    const bridge = new DevinCliBridge();
    bridge.writeManagedUserConfig(
      ctx(),
      [{ events: ['PreToolUse'], command: 'node hook.js --event PreToolUse', matcher: '' }],
      dir,
    );
    const config = readConfig(dir);
    expect(config.hooks.PreToolUse[0].hooks[0].command).toContain('hook.js');
    expect(config.permissions.allow).toContain('mcp__kory__*');
    for (const tool of ['exec', 'read', 'write', 'edit', 'request_scope', 'run_subagent']) {
      expect(config.permissions.deny).toContain(tool);
    }
    expect(config.subagents_enabled).toBe(false);
    expect(config.read_config_from.claude).toBe(false);
    expect(config.read_config_from.cloud).toBe(false);
    // The repo's own AGENTS.md is still honored.
    expect(config.read_config_from.agents_standard).toBe(true);
    expect(config.auto_update).toBe(false);
  });

  test('merges sandbox scopes into permission rules', () => {
    const dir = home();
    const bridge = new DevinCliBridge();
    bridge.writeManagedUserConfig(
      ctx({
        preset: 'custom',
        filesystemIsolation: false,
        allowNetwork: true,
        allowEdits: false,
        allowShell: false,
        allowWebSearch: false,
        commandBlocklist: ['rm', 'sudo'],
        maxRuntimeSeconds: 0,
      }),
      [],
      dir,
    );
    const deny = readConfig(dir).permissions.deny as string[];
    expect(deny).toContain('Write(**)');
    expect(deny).toContain('Exec(*)');
    expect(deny).toContain('Fetch(*)');
    expect(deny).toContain('Exec(rm)');
  });

  test('removes stale hooks when no hooks are supplied', () => {
    const dir = home();
    mkdirSync(join(dir, 'devin'), { recursive: true });
    writeFileSync(
      join(dir, 'devin', 'config.json'),
      JSON.stringify({ hooks: { PreToolUse: [{ matcher: '', hooks: [] }] }, theme_mode: 'dark' }),
    );
    new DevinCliBridge().writeManagedUserConfig(ctx(), [], dir);
    const config = readConfig(dir);
    expect(config.hooks).toBeUndefined();
    expect(config.theme_mode).toBe('dark');
  });
});

describe('buildMcpConfig', () => {
  test('emits the kory server without a capability probe', () => {
    // Regression: gating the kory server on the `devin mcp` subcommand probe
    // left managed turns with native tools denied and no mcp_config.json —
    // Devin could only talk. The config-file contract stands on its own.
    const bridge = new DevinCliBridge();
    const servers = bridge.buildMcpConfig({ ...ctx(), sessionId: 'devin-mcp-test' });
    expect(servers?.map((s) => s.name)).toEqual(['kory']);
  });

  test('still requires a session id', () => {
    const bridge = new DevinCliBridge();
    expect(bridge.buildMcpConfig(ctx())).toBeNull();
  });
});
