import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('Antigravity sandboxed turn lifecycle', () => {
  test('child discovers its managed config and a failed result never becomes complete', () => {
    const root = mkdtempSync(join(tmpdir(), 'kory-agy-turn-'));
    const home = join(root, 'home');
    const bin = join(root, 'bin');
    mkdirSync(home);
    mkdirSync(bin);
    const managedHome = join(home, '.koryphaios', 'antigravity-home', 'research-only');
    mkdirSync(join(managedHome, '.gemini'), { recursive: true });
    writeFileSync(join(managedHome, '.gemini', 'fixture-config'), 'managed-config');
    // Executable fixture exercises the actual spawn environment, not a mocked
    // environment builder. No real account credentials or provider calls.
    writeFileSync(
      join(bin, 'agy'),
      `#!${process.execPath}
const args = process.argv.slice(2);
if (args.includes('--help')) {
  console.log('--input-format <format> --output-format <format>');
} else if (args[0] === 'models') {
  console.log('gemini-test\\tGemini Test');
} else if (args.includes('/usage')) {
  console.log('');
} else {
  const fs = require('node:fs');
  const path = require('node:path');
  const homeConfig = path.join(process.env.HOME, '.gemini', 'fixture-config');
  const explicitConfig = path.join(process.env.GEMINI_DIR, 'fixture-config');
  const hasConfig = fs.existsSync(homeConfig) && fs.existsSync(explicitConfig);
  const error = hasConfig
    ? 'Eligibility check failed: UNAVAILABLE (code 503): The service is currently unavailable.'
    : 'authentication failed: managed config missing';
  process.stdin.resume();
  process.stdin.on('end', () => {
    console.log(JSON.stringify({ event: 'result', result: { status: 'ERROR', error } }));
    process.exitCode = 1;
  });
}
`,
      { mode: 0o700 },
    );
    const providerPath = join(import.meta.dir, '..', 'antigravity.ts');
    const runner = `
      const { AntigravityProvider } = await import(${JSON.stringify(providerPath)});
      const provider = new AntigravityProvider({ name: 'antigravity', baseUrl: '', authToken: 'fixture' });
      const events = [];
      for await (const event of provider.streamResponse({
        model: 'gemini-test', messages: [{ role: 'user', content: 'Fixture turn' }],
        capabilityProfile: 'research-only', workingDirectory: ${JSON.stringify(root)},
        sandbox: { filesystemIsolation: true, allowNetwork: true, allowEdits: false },
      })) events.push(event);
      console.log('FIXTURE_EVENTS=' + JSON.stringify(events));
    `;
    try {
      const result = spawnSync(process.execPath, ['-e', runner], {
        cwd: root,
        env: { PATH: `${bin}:${process.env.PATH}`, HOME: home, TMPDIR: root },
        encoding: 'utf8',
        timeout: 20_000,
      });
      expect(result.status).toBe(0);
      const line = result.stdout.split('\n').find((entry) => entry.startsWith('FIXTURE_EVENTS='));
      expect(line).toBeDefined();
      const events = JSON.parse(line!.slice('FIXTURE_EVENTS='.length));
      expect(events).toHaveLength(1);
      expect(events[0].type).toBe('error');
      expect(events[0].error).toContain('The service is currently unavailable');
      expect(events[0].errorTransient).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
