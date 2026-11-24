import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { probeAntigravityMcpBridge } from '../antigravity';

describe('Antigravity sandboxed turn lifecycle', () => {
  test('fails closed when the Kory MCP bridge does not return a readiness receipt', async () => {
    const root = mkdtempSync(join(tmpdir(), 'kory-agy-mcp-probe-'));
    const ready = join(root, 'ready.js');
    const broken = join(root, 'broken.js');
    writeFileSync(
      ready,
      'process.stdout.write(JSON.stringify({ ready: true, toolCount: 3 }) + "\\n");',
    );
    writeFileSync(broken, 'process.exit(1);');
    try {
      expect(
        await probeAntigravityMcpBridge({ runtime: process.execPath, script: ready, env: {} }),
      ).toEqual({ ok: true, toolCount: 3 });
      expect(
        await probeAntigravityMcpBridge({ runtime: process.execPath, script: broken, env: {} }),
      ).toEqual({ ok: false, reason: 'bridge authorization or catalog request failed' });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

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
  const homeConfig = path.join(process.env.ANTIGRAVITY_HOME, '.gemini', 'fixture-config');
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

  test('stop signal immediately unblocks streamResponse even when agy ignores SIGTERM', () => {
    const root = mkdtempSync(join(tmpdir(), 'kory-agy-abort-'));
    const home = join(root, 'home');
    const bin = join(root, 'bin');
    mkdirSync(home);
    mkdirSync(bin);
    writeFileSync(
      join(bin, 'agy'),
      `#!${process.execPath}
const args = process.argv.slice(2);
if (args.includes('--help')) {
  console.log('--input-format <format> --output-format <format>');
} else if (args[0] === 'models') {
  console.log('gemini-test\\tGemini Test');
} else {
  process.on('SIGTERM', () => {
    // Deliberately ignore SIGTERM to simulate a wedged CLI / MCP subprocess.
  });
  console.log(JSON.stringify({ event: 'step_update', step_update: {
    step_type: 'agent_response', text_delta: 'FIXTURE_READY:' + process.pid
  } }));
  // Bound fixture lifetime even if an assertion or runner failure interrupts cleanup.
  setTimeout(() => process.exit(2), 10_000);
  setInterval(() => {}, 1000);
}
`,
      { mode: 0o700 },
    );
    const providerPath = join(import.meta.dir, '..', 'antigravity.ts');
    const runner = `
      const { AntigravityProvider } = await import(${JSON.stringify(providerPath)});
      const provider = new AntigravityProvider({ name: 'antigravity', baseUrl: '', authToken: 'fixture' });
      provider.listModels = () => [];
      const controller = new AbortController();
      let stoppedAt;
      let fixturePid;
      const events = [];
      for await (const event of provider.streamResponse({
        model: 'gemini-test',
        messages: [{ role: 'user', content: 'Hang turn' }],
        capabilityProfile: 'research-only',
        workingDirectory: ${JSON.stringify(root)},
        signal: controller.signal,
      })) {
        if (event.type === 'content_delta' && event.content?.startsWith('FIXTURE_READY:')) {
          fixturePid = Number(event.content.slice('FIXTURE_READY:'.length));
          // Stop only after the actual CLI has installed its SIGTERM handler.
          setTimeout(() => { stoppedAt = Date.now(); controller.abort(); }, 20);
          continue;
        }
        events.push(event);
      }
      const elapsed = stoppedAt === undefined ? null : Date.now() - stoppedAt;
      const isAlive = () => {
        if (!fixturePid) return false;
        try { process.kill(fixturePid, 0); return true; } catch { return false; }
      };
      const deadline = Date.now() + 3_000;
      while (isAlive() && Date.now() < deadline) await Bun.sleep(20);
      const reaped = !!fixturePid && !isAlive();
      if (isAlive()) process.kill(fixturePid, 'SIGKILL');
      console.log('ABORT_RESULT=' + JSON.stringify({ elapsed, events, reaped }));
    `;
    try {
      const result = spawnSync(process.execPath, ['-e', runner], {
        cwd: root,
        env: { PATH: `${bin}:${process.env.PATH}`, HOME: home, TMPDIR: root },
        encoding: 'utf8',
        timeout: 15_000,
      });
      expect(result.status).toBe(0);
      const line = result.stdout.split('\n').find((entry) => entry.startsWith('ABORT_RESULT='));
      expect(line).toBeDefined();
      const parsed = JSON.parse(line!.slice('ABORT_RESULT='.length)) as {
        elapsed: number | null;
        events: unknown[];
        reaped: boolean;
      };
      expect(parsed.elapsed).not.toBeNull();
      expect(parsed.elapsed).toBeLessThan(1_000);
      expect(parsed.events).toEqual([]);
      expect(parsed.reaped).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  for (const mode of ['active', 'idle', 'stderr-only'] as const) {
    test(`idle deadline preserves active output and diagnoses ${mode} CLI correctly`, () => {
      const root = mkdtempSync(join(tmpdir(), 'kory-agy-idle-'));
      const home = join(root, 'home');
      const bin = join(root, 'bin');
      mkdirSync(home);
      mkdirSync(bin);
      writeFileSync(
        join(bin, 'agy'),
        `#!${process.execPath}
const args = process.argv.slice(2);
if (args.includes('--help')) {
  console.log('--input-format <format> --output-format <format>');
} else {
  const mode = ${JSON.stringify(mode)};
  const emit = () => console.log(JSON.stringify({ event: 'step_update', step_update: {
    step_type: 'agent_response', text_delta: 'still working '
  } }));
  emit();
  const timer = setInterval(() => {
    if (mode === 'active') emit();
    if (mode === 'stderr-only') process.stderr.write('diagnostic noise\\n');
  }, 80);
  setTimeout(() => {
    clearInterval(timer);
    console.log(JSON.stringify({ event: 'result', result: { status: 'SUCCESS' } }));
    process.exit(0);
  }, mode === 'active' ? 1000 : 3000);
}
`,
        { mode: 0o700 },
      );
      const providerPath = join(import.meta.dir, '..', 'antigravity.ts');
      // Accelerate only the five minute harness deadline. Actual CLI spawning,
      // stdout parsing, polling, termination and cleanup remain production code.
      const runner = `
        const realSetTimeout = globalThis.setTimeout;
        globalThis.setTimeout = (callback, delay, ...args) =>
          realSetTimeout(callback, delay === 300_000 ? 450 : delay, ...args);
        const { AntigravityProvider } = await import(${JSON.stringify(providerPath)});
        const provider = new AntigravityProvider({ name: 'antigravity', baseUrl: '', authToken: 'fixture' });
        provider.listModels = () => [];
        const events = [];
        for await (const event of provider.streamResponse({
          model: 'gemini-test', messages: [{ role: 'user', content: 'Long fixture turn' }],
          capabilityProfile: 'research-only', workingDirectory: ${JSON.stringify(root)},
        })) events.push(event);
        console.log('IDLE_EVENTS=' + JSON.stringify(events));
      `;
      try {
        const result = spawnSync(process.execPath, ['-e', runner], {
          cwd: root,
          env: { PATH: `${bin}:${process.env.PATH}`, HOME: home, TMPDIR: root },
          encoding: 'utf8',
          timeout: 10_000,
        });
        expect(result.status).toBe(0);
        const line = result.stdout.split('\n').find((entry) => entry.startsWith('IDLE_EVENTS='));
        expect(line).toBeDefined();
        const events = JSON.parse(line!.slice('IDLE_EVENTS='.length)) as {
          type: string;
          error?: string;
          errorTransient?: boolean;
        }[];
        expect(events.some((event) => event.type === 'content_delta')).toBe(true);
        const errors = events.filter((event) => event.type === 'error');
        if (mode === 'active') {
          expect(errors).toEqual([]);
          expect(events.at(-1)?.type).toBe('complete');
        } else {
          expect(errors).toHaveLength(1);
          expect(errors[0].error).toContain('idle timeout');
          expect(errors[0].error).not.toContain('failed to launch');
          expect(errors[0].errorTransient).toBe(true);
          expect(events.some((event) => event.type === 'complete')).toBe(false);
        }
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });
  }
});
