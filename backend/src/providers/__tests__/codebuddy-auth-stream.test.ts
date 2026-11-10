import { expect, test } from 'bun:test';
import { SANDBOX_PRESETS } from '@koryphaios/shared';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { canonicalizePath, isUnix } from '../../runtime/platform';

// Full adapter launch with a synthetic CLI/login. Only the outer OS wrapper is
// intercepted so we can assert its mount contract; the real soft jail is used.
const scenarios = [
  { name: 'managed home', sandbox: false, research: false, result: 'success', text: true },
  {
    name: 'soft jail and OS mounts',
    sandbox: true,
    research: false,
    result: 'success',
    text: true,
  },
  { name: 'research-only home', sandbox: true, research: true, result: 'success', text: true },
  {
    name: 'exit 0 with auth-required',
    sandbox: true,
    research: false,
    result: 'error',
    text: false,
  },
  {
    name: 'exit 0 with text then auth-required',
    sandbox: true,
    research: false,
    result: 'error',
    text: true,
  },
  {
    name: 'exit 0 with CLI errors array',
    sandbox: true,
    research: false,
    result: 'errors-array',
    text: false,
  },
  { name: 'exit 0 without result', sandbox: true, research: false, result: 'missing', text: true },
];

for (const scenario of scenarios) {
  test.skipIf(!isUnix())(`CodeBuddy auth launch: ${scenario.name}`, () => {
    const root = mkdtempSync(join(tmpdir(), 'kory-codebuddy-launch-'));
    const realHome = join(root, 'host-home');
    const workspace = join(root, 'workspace');
    const binDir = join(root, 'bin');
    const relativeAuth = join(
      'Library',
      'Application Support',
      'CodeBuddyExtension',
      'Data',
      'Public',
      'auth',
      'Tencent-Cloud.coding-copilot.info',
    );
    const authFile = join(realHome, relativeAuth);
    for (const path of [dirname(authFile), workspace, binDir, join(realHome, '.codebuddy')]) {
      mkdirSync(path, { recursive: true });
    }
    writeFileSync(authFile, 'synthetic-auth-resource', { mode: 0o600 });
    writeFileSync(join(realHome, '.codebuddy', 'settings.json'), 'must-not-link-real-settings');
    writeFileSync(
      join(binDir, 'codebuddy'),
      `#!${process.execPath}
const fs = require('node:fs');
const path = require('node:path');
const emit = (value) => console.log(JSON.stringify(value));
process.stdin.resume();
process.stdin.on('end', () => {
  const home = process.env.HOME;
  const authFound = fs.existsSync(path.join(home, ${JSON.stringify(relativeAuth)}));
  const receipt = {
    home, profile: process.env.USERPROFILE, config: process.env.CODEBUDDY_CONFIG_DIR,
    oldHomeAbsent: process.env.CODEBUDDY_HOME === undefined,
    unrelatedAbsent: process.env.UNRELATED_SECRET === undefined,
    authFound, settingsLinked: fs.existsSync(path.join(home, 'settings.json')),
    tmp: process.env.TMPDIR,
  };
  if (${scenario.text}) emit({ type: 'assistant', message: { content: [{ type: 'text', text: JSON.stringify(receipt) }] } });
  if (${JSON.stringify(scenario.result)} !== 'missing') {
    const payload = { type: 'result', is_error: !authFound || ${scenario.result === 'error' || scenario.result === 'errors-array'} };
    if (${JSON.stringify(scenario.result)} === 'errors-array') {
      payload.errors = ['Authentication required. Please use /login command to sign in to your account'];
    } else {
      payload.result = 'synthetic-auth-required';
    }
    emit(payload);
  }
});
`,
      { mode: 0o700 },
    );
    const modulePath = (file: string) => JSON.stringify(join(import.meta.dir, '..', file));
    const runner = `
      import { mock } from 'bun:test';
      const sandbox = await import(${modulePath('../collaboration/sandbox-runner.ts')});
      let wrapOptions;
      mock.module(${modulePath('../collaboration/sandbox-runner.ts')}, () => ({
        ...sandbox,
        wrapCommand: (command, args, options) => {
          wrapOptions = options;
          return { command, args, isolated: true, mechanism: 'fixture' };
        },
      }));
      const { CodeBuddyProvider, codebuddyStateHome } = await import(${modulePath('codebuddy.ts')});
      const provider = new CodeBuddyProvider({ name: 'codebuddy' });
      provider.listModels = () => [{ id: 'codebuddy-fixture', apiModelId: 'fixture' }];
      const events = [];
      for await (const event of provider.streamResponse({
        model: 'codebuddy-fixture', messages: [{ role: 'user', content: 'Synthetic fixture' }],
        workingDirectory: ${JSON.stringify(workspace)},
        capabilityProfile: ${scenario.research ? "'research-only'" : 'undefined'},
        sandbox: ${scenario.sandbox ? JSON.stringify({ ...SANDBOX_PRESETS.readonly, filesystemIsolation: true }) : 'undefined'},
      })) events.push(event);
      console.log('RECEIPT=' + JSON.stringify({ events, wrapOptions, configRoot: codebuddyStateHome() }));
    `;
    try {
      const result = spawnSync(process.execPath, ['--no-env-file', '-e', runner], {
        cwd: root,
        env: {
          PATH: `${binDir}${delimiter}${process.env.PATH}`,
          HOME: realHome,
          USERPROFILE: realHome,
          TMPDIR: root,
          PROJECT_ROOT: workspace,
          LOG_DIR: join(root, 'logs'),
          CODEBUDDY_HOME: 'unsupported-home',
          CODEBUDDY_CONFIG_DIR: join(realHome, '.codebuddy'),
          UNRELATED_SECRET: 'synthetic-must-not-cross',
        },
        encoding: 'utf8',
        timeout: 10_000,
      });
      expect(result.status, result.stderr).toBe(0);
      const line = result.stdout.split('\n').find((value) => value.startsWith('RECEIPT='));
      expect(line).toBeDefined();
      const { events, wrapOptions, configRoot } = JSON.parse(line!.slice('RECEIPT='.length));
      expect(configRoot).toBe(join(realHome, '.codebuddy'));
      const types = events.map((event: { type: string }) => event.type);
      if (scenario.result === 'success') {
        expect(types).toEqual(['content_delta', 'complete']);
      } else {
        expect(types).toEqual(scenario.text ? ['content_delta', 'error'] : ['error']);
        if (scenario.result === 'errors-array') {
          // The CLI's own diagnostic must reach the user, with the login
          // action, instead of the opaque "CodeBuddy request failed".
          expect(events.at(-1).error).toContain('Authentication required');
          expect(events.at(-1).error).toContain('codebuddy /login');
        } else {
          expect(events.at(-1).error).toBe(
            scenario.result === 'missing'
              ? 'CodeBuddy CLI ended without a successful result.'
              : 'synthetic-auth-required',
          );
        }
      }
      const home = join(
        realHome,
        '.koryphaios',
        'codebuddy-home',
        ...(scenario.research ? ['research-only'] : []),
      );
      if (scenario.text) {
        const receipt = JSON.parse(events[0].content);
        expect(receipt).toMatchObject({
          home,
          profile: home,
          config: home,
          oldHomeAbsent: true,
          unrelatedAbsent: true,
          authFound: true,
          settingsLinked: false,
        });
        if (scenario.sandbox) expect(wrapOptions.configDirs).toContain(dirname(receipt.tmp));
      }
      if (scenario.sandbox) {
        expect(wrapOptions.homeDir).toBe(home);
        expect(wrapOptions.configDirs).toContain(home);
        expect(wrapOptions.configDirs).not.toContain(realHome);
        expect(wrapOptions.readonlyConfigDirs).toEqual([canonicalizePath(authFile)]);
        expect(wrapOptions.policy.filesystemIsolation).toBe(true);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}
