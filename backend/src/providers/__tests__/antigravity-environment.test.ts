import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Exercise the real provider launch and soft-jail environment in a subprocess:
// only the platform predicate and OS command wrapper are replaced. The agy and
// MCP executables are fixtures, so no account, keyring, network or server is used.
for (const scenario of [
  { name: 'local macOS, sandboxed', mac: true, sandbox: true, staged: false },
  { name: 'local macOS, no outer sandbox', mac: true, sandbox: false, staged: false },
  { name: 'non-macOS, sandboxed', mac: false, sandbox: true, staged: false },
  { name: 'transferred macOS credential, sandboxed', mac: true, sandbox: true, staged: true },
]) {
  test(`Antigravity separates keyring HOME from managed config: ${scenario.name}`, () => {
    const root = mkdtempSync(join(tmpdir(), 'kory-agy-env-'));
    const home = join(root, 'host-home');
    const bin = join(root, 'bin');
    const workspace = join(root, 'workspace');
    const managed = scenario.staged
      ? join(root, 'staged-home')
      : join(home, '.koryphaios', 'antigravity-home');
    for (const dir of [home, bin, workspace, managed, join(home, '.gemini', 'config')]) {
      mkdirSync(dir, { recursive: true });
    }
    const userConfig = join(home, '.gemini', 'config', 'mcp_config.json');
    writeFileSync(userConfig, 'user-config-sentinel');
    const bridge = join(root, 'bridge.js');
    const probeMarker = join(root, 'probed');
    writeFileSync(bridge, `
      require('node:fs').writeFileSync(${JSON.stringify(probeMarker)}, 'ready');
      console.log(JSON.stringify({ ready: true, toolCount: 1 }));
    `);
    writeFileSync(join(bin, 'agy'), `#!${process.execPath}
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
if (args.includes('--help')) {
  console.log('--input-format <format> --output-format <format>');
} else if (args[0] === 'models') {
  console.log('gemini-test\\tGemini Test');
} else if (args.includes('/usage')) {
  console.log('');
} else {
  process.stdin.resume();
  process.stdin.on('end', () => {
    const env = {};
    for (const key of ['HOME', 'USERPROFILE', 'ANTIGRAVITY_HOME', 'GEMINI_DIR',
      'TMPDIR', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME', 'XDG_STATE_HOME',
      'UNRELATED_SECRET', 'AWS_SECRET_ACCESS_KEY']) env[key] = process.env[key];
    const settings = JSON.parse(fs.readFileSync(path.join(env.GEMINI_DIR, 'antigravity-cli', 'settings.json')));
    const mcp = JSON.parse(fs.readFileSync(path.join(env.GEMINI_DIR, 'config', 'mcp_config.json')));
    const hooks = JSON.parse(fs.readFileSync(path.join(env.GEMINI_DIR, 'config', 'hooks.json')));
     const receipt = { env, settings, mcp: mcp.mcpServers.kory,
       hasMcp: !!mcp.mcpServers.kory,
      hasHooks: Object.keys(hooks).length > 0,
      hasHookGrant: fs.existsSync(process.env.KORY_BRIDGE_AUTH_FILE),
      preflightRan: fs.existsSync(${JSON.stringify(probeMarker)}), sandbox: args.includes('--sandbox') };
    console.log(JSON.stringify({ event: 'step_update', step_update: {
      step_type: 'agent_response', text_delta: JSON.stringify(receipt) } }));
    console.log(JSON.stringify({ event: 'result', result: { status: 'SUCCESS' } }));
  });
}
`, { mode: 0o700 });
    const modulePath = (name: string) => JSON.stringify(join(import.meta.dir, '..', name));
    const runner = `
      import { mock } from 'bun:test';
      const platform = await import(${modulePath('../runtime/platform.ts')});
      mock.module(${modulePath('../runtime/platform.ts')}, () => ({ ...platform, isMac: () => ${scenario.mac} }));
      const sandbox = await import(${modulePath('../collaboration/sandbox-runner.ts')});
      let wrapOptions;
      let profile;
      mock.module(${modulePath('../collaboration/sandbox-runner.ts')}, () => ({
        ...sandbox,
        wrapCommand: (command, args, options) => {
          wrapOptions = options;
          profile = sandbox.buildSeatbeltProfile(options);
          return { command, args, isolated: true, mechanism: 'fixture' };
        },
      }));
      const { AntigravityProvider } = await import(${modulePath('antigravity.ts')});
      const { withProviderExecutionScope } = await import(${modulePath('execution-scope.ts')});
      const provider = new AntigravityProvider({ name: 'antigravity', baseUrl: '' });
      provider.listModels = () => [];
      const run = async () => {
        const events = [];
        for await (const event of provider.streamResponse({
          model: 'gemini-test', messages: [{ role: 'user', content: 'Environment fixture' }],
          sessionId: 'fixture-session', workingDirectory: ${JSON.stringify(workspace)},
          sandbox: ${scenario.sandbox ? "{ filesystemIsolation: true, allowNetwork: false, allowEdits: false }" : 'undefined'},
        })) events.push(event);
        console.log('RECEIPT=' + JSON.stringify({ events, wrapOptions, profile }));
      };
      if (${scenario.staged}) await withProviderExecutionScope({
        sessionId: 'fixture-session', providers: new Map(),
        antigravityHome: ${JSON.stringify(managed)}, assertActive() {},
      }, run);
      else await run();
    `;
    try {
      const result = spawnSync(process.execPath, ['--no-env-file', '-e', runner], {
        cwd: root,
        env: {
          PATH: `${bin}:${process.env.PATH}`, HOME: home, USERPROFILE: home, TMPDIR: root,
          KORY_MCP_BRIDGE_COMMAND: process.execPath, KORY_MCP_BRIDGE_SCRIPT: bridge,
          KORY_HOOK_BRIDGE_SCRIPT: bridge, KORY_BACKEND_URL: 'http://fixture.invalid',
          GEMINI_DIR: join(home, '.gemini'), ANTIGRAVITY_HOME: home,
          UNRELATED_SECRET: 'synthetic-secret', AWS_SECRET_ACCESS_KEY: 'synthetic-aws',
        },
        encoding: 'utf8', timeout: 10_000,
      });
      expect(result.status).toBe(0);
      const line = result.stdout.split('\n').find((value) => value.startsWith('RECEIPT='));
      expect(line).toBeDefined();
      const { events, wrapOptions, profile } = JSON.parse(line!.slice('RECEIPT='.length));
      expect(events.map((event: { type: string }) => event.type)).toEqual(['content_delta', 'complete']);
      const receipt = JSON.parse(events[0].content);
      const expectedHome = managed;
      expect(receipt.env.HOME).toBe(expectedHome);
      expect(receipt.env.USERPROFILE).toBe(expectedHome);
      expect(receipt.env.GEMINI_DIR).toBe(join(managed, '.gemini'));
      expect(receipt.env.ANTIGRAVITY_HOME).toBe(managed);
      expect(receipt.env.UNRELATED_SECRET).toBeUndefined();
      expect(receipt.env.AWS_SECRET_ACCESS_KEY).toBeUndefined();
      expect(receipt.settings.toolPermission).toBe('request-review');
      expect(receipt.settings.permissions.deny).toContain('command(*)');
      expect(receipt.settings.permissions.deny).toContain('write_file(*)');
      expect(receipt.settings.permissions.allow).toContain('mcp(kory/*)');
      expect(receipt.hasMcp && receipt.hasHooks && receipt.hasHookGrant && receipt.preflightRan).toBe(true);
      expect(receipt.mcp.type).toBe('stdio');
      expect(receipt.sandbox).toBe(true);
      expect(readFileSync(userConfig, 'utf8')).toBe('user-config-sentinel');
      if (scenario.sandbox) {
        expect(wrapOptions.homeDir).toBe(managed);
        expect(wrapOptions.configDirs).toContain(managed);
        expect(wrapOptions.configDirs).not.toContain(home);
        expect(wrapOptions.policy.filesystemIsolation).toBe(true);
        expect(wrapOptions.policy.allowEdits).toBe(false);
        const jailHome = wrapOptions.configDirs.find((dir: string) => dir.includes('kory-home-'));
        expect(jailHome).toBeDefined();
        expect(receipt.env.TMPDIR).toBe(join(jailHome, '.tmp'));
        for (const [key, suffix] of Object.entries({
          XDG_CONFIG_HOME: '.config', XDG_DATA_HOME: '.local/share',
          XDG_CACHE_HOME: '.cache', XDG_STATE_HOME: '.local/state',
        })) expect(receipt.env[key]).toBe(join(jailHome, suffix));
        expect(profile).toContain('(deny file-write*)');
        expect(profile).toContain('Library/Keychains');
      } else expect(wrapOptions).toBeUndefined();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}
