import { afterEach, describe, expect, test } from 'bun:test';
import { dispatchPackagedEntry } from '../packaged-entry';
import { applyBridgeEnvironment, isCompiledStandalone } from '../runtime/standalone';
import { buildKoryCliMcpConfig } from '../providers/kory-cli-mcp-config';
import { buildKoryHookConfigs } from '../providers/cli-bridges';
import type { CliBridgeContext } from '../providers/cli-bridge';

const BRIDGE_ENV_KEYS = [
  'KORY_MCP_BRIDGE_SCRIPT',
  'KORY_HOOK_BRIDGE_SCRIPT',
  'KORY_MCP_BRIDGE_COMMAND',
  'KORY_HOOK_BRIDGE_COMMAND',
  'KORY_BACKEND_URL',
] as const;

const savedEnv = new Map<string, string | undefined>();
const savedArgv = process.argv;
const savedExitCode = process.exitCode;

afterEach(() => {
  for (const key of BRIDGE_ENV_KEYS) {
    const saved = savedEnv.get(key);
    if (saved === undefined) delete process.env[key];
    else process.env[key] = saved;
  }
  process.argv = savedArgv;
  process.exitCode = savedExitCode;
});

function clearBridgeEnv() {
  for (const key of BRIDGE_ENV_KEYS) {
    if (!savedEnv.has(key)) savedEnv.set(key, process.env[key]);
    delete process.env[key];
  }
}

function bridgeCtx(): CliBridgeContext {
  return {
    provider: 'codex',
    role: 'manager',
    sessionId: 'session-1',
    bridgeGrantLease: {
      grant: () => ({ path: '/tmp/kory-grant.json', directory: '/tmp' }),
    },
  } as unknown as CliBridgeContext;
}

describe('dispatchPackagedEntry', () => {
  test('--kory-mcp-bridge imports the MCP bridge, drops the sentinel, and runs it', async () => {
    process.argv = ['bun', '/bin/koryphaios-backend', '--kory-mcp-bridge', '--provider', 'codex'];
    let ran = false;
    await dispatchPackagedEntry(process.argv, {
      mcpBridge: async () => ({ runBridge: async () => void (ran = true) }),
      server: async () => {
        throw new Error('server must not start for a bridge invocation');
      },
    });
    expect(ran).toBe(true);
    expect(process.argv).toEqual(['bun', '/bin/koryphaios-backend', '--provider', 'codex']);
  });

  test('--kory-hook-bridge imports the hook bridge and drops the sentinel', async () => {
    process.argv = ['bun', '/bin/koryphaios-backend', '--kory-hook-bridge', '--event', 'Stop'];
    let ran = false;
    await dispatchPackagedEntry(process.argv, {
      hookBridge: async () => ({
        main: async () => void (ran = true),
        encodeHookDecision: () => ({}),
      }),
    });
    expect(ran).toBe(true);
    expect(process.argv).toEqual(['bun', '/bin/koryphaios-backend', '--event', 'Stop']);
  });

  test('any other invocation starts the server', async () => {
    process.argv = ['bun', '/bin/koryphaios-backend'];
    let started = false;
    await dispatchPackagedEntry(process.argv, {
      server: async () => void (started = true),
    });
    expect(started).toBe(true);
  });
});

describe('isCompiledStandalone', () => {
  test('detects Bun virtual roots', () => {
    expect(isCompiledStandalone('/$bunfs/root/backend/src')).toBe(true);
    expect(isCompiledStandalone('B:\\~BUN\\root\\backend\\src')).toBe(true);
    expect(isCompiledStandalone('B:/~BUN/root/backend/src')).toBe(true);
  });

  test('source and packaged-directory layouts are not compiled', () => {
    expect(isCompiledStandalone('/Users/u/koryphaios/backend/src')).toBe(false);
    expect(isCompiledStandalone('/opt/koryphaios/build')).toBe(false);
    expect(isCompiledStandalone('C:\\koryphaios\\backend\\src')).toBe(false);
  });
});

describe('applyBridgeEnvironment', () => {
  test('compiled mode self-dispatches through argv sentinels', () => {
    clearBridgeEnv();
    applyBridgeEnvironment(true);
    expect(process.env.KORY_MCP_BRIDGE_SCRIPT).toBe('--kory-mcp-bridge');
    expect(process.env.KORY_HOOK_BRIDGE_SCRIPT).toBe('--kory-hook-bridge');
    expect(process.env.KORY_MCP_BRIDGE_COMMAND).toBe(process.execPath);
  });

  test('explicit bridge env always wins', () => {
    clearBridgeEnv();
    process.env.KORY_MCP_BRIDGE_SCRIPT = '/opt/custom/bridge.js';
    process.env.KORY_MCP_BRIDGE_COMMAND = '/opt/custom/bun';
    applyBridgeEnvironment(true);
    expect(process.env.KORY_MCP_BRIDGE_SCRIPT).toBe('/opt/custom/bridge.js');
    expect(process.env.KORY_MCP_BRIDGE_COMMAND).toBe('/opt/custom/bun');
    expect(process.env.KORY_HOOK_BRIDGE_SCRIPT).toBe('--kory-hook-bridge');
  });
});

describe('sentinel bridge configs', () => {
  test('buildKoryCliMcpConfig spawns the binary as its own MCP bridge', () => {
    clearBridgeEnv();
    process.env.KORY_MCP_BRIDGE_SCRIPT = '--kory-mcp-bridge';
    const servers = buildKoryCliMcpConfig(bridgeCtx(), 'codex');
    expect(servers).not.toBeNull();
    expect(servers![0].command).toBe(process.execPath);
    expect(servers![0].args.slice(0, 3)).toEqual(['--kory-mcp-bridge', '--provider', 'codex']);
  });

  test('buildKoryHookConfigs quotes the binary plus hook sentinel', () => {
    clearBridgeEnv();
    process.env.KORY_HOOK_BRIDGE_SCRIPT = '--kory-hook-bridge';
    const hooks = buildKoryHookConfigs(bridgeCtx());
    expect(hooks).not.toBeNull();
    expect(hooks![0].command).toContain(
      `${JSON.stringify(process.execPath)} "--kory-hook-bridge" --auth-file `,
    );
  });
});
