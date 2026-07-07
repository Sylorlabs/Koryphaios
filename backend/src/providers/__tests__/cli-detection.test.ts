import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, delimiter } from 'node:path';
import { detectAgentClis, whichBinary, canAutoEnable } from '../cli-detection';
import {
  detectAntigravityCLILogin,
  detectCursorCLILogin,
  detectGrokCLILogin,
  detectCodexCLILogin,
} from '../auth-utils';

// Snapshot the env vars these tests mutate so each test is isolated and the suite is restored.
const ENV_KEYS = [
  'HOME',
  'USERPROFILE',
  'PATH',
  'KORY_DISABLE_CLI_AUTODETECT',
  'GROK_CODE_XAI_API_KEY',
  'GROK_API_KEY',
  'ANTIGRAVITY_API_KEY',
  'GEMINI_API_KEY',
  'GOOGLE_API_KEY',
  'CURSOR_API_KEY',
] as const;
let saved: Record<string, string | undefined>;
let tmpHome: string;

beforeEach(() => {
  saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  tmpHome = mkdtempSync(join(tmpdir(), 'kory-cli-'));
  // Neutralize ambient signals so tests are deterministic regardless of the dev machine.
  process.env.HOME = tmpHome;
  process.env.USERPROFILE = tmpHome;
  for (const k of ['KORY_DISABLE_CLI_AUTODETECT', 'GROK_CODE_XAI_API_KEY', 'GROK_API_KEY', 'ANTIGRAVITY_API_KEY', 'GEMINI_API_KEY', 'GOOGLE_API_KEY', 'CURSOR_API_KEY']) {
    delete process.env[k];
  }
});
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k]!;
  }
  rmSync(tmpHome, { recursive: true, force: true });
});

describe('detectAgentClis', () => {
  it('reports all five agent CLIs with their provider mappings', () => {
    const list = detectAgentClis();
    expect(list.map((c) => c.id).sort()).toEqual(['antigravity', 'claude', 'cline', 'codex', 'cursor', 'devin', 'grok']);
    const byId = Object.fromEntries(list.map((c) => [c.id, c]));
    expect(byId.claude.provider).toBe('claude');
    expect(byId.codex.provider).toBe('codex');
    expect(byId.antigravity.provider).toBe('antigravity');
    expect(byId.grok.provider).toBe('grok'); // Grok Build has its own CLI-harness provider
    expect(byId.cursor.provider).toBe('cursor'); // Cursor CLI harness provider
    expect(byId.devin.provider).toBe('devin'); // Devin CLI harness provider
    expect(byId.cline.provider).toBe('cline'); // Cline CLI harness provider
  });

  it('every entry carries a binary path when installed, and a human note', () => {
    for (const c of detectAgentClis()) {
      expect(typeof c.note).toBe('string');
      expect(c.note.length).toBeGreaterThan(0);
      if (c.installed) expect(c.binaryPath).toBeTruthy();
      else expect(c.binaryPath).toBeNull();
      // autoEnabled implies installed + loggedIn (never claim more than we can drive).
      if (c.autoEnabled) {
        expect(c.installed).toBe(true);
        expect(c.loggedIn).toBe(true);
      }
    }
  });
});

describe('whichBinary', () => {
  it('finds an executable on PATH and returns null for a missing one', () => {
    const bin = join(tmpHome, 'bin');
    mkdirSync(bin, { recursive: true });
    const fake = join(bin, 'kory-fake-cli');
    writeFileSync(fake, '#!/bin/sh\n');
    chmodSync(fake, 0o755);
    process.env.PATH = `${bin}${delimiter}${saved.PATH ?? ''}`;
    expect(whichBinary('kory-fake-cli')).toBe(fake);
    expect(whichBinary('kory-definitely-not-installed-xyz')).toBeNull();
  });
});

describe('login detectors (deterministic via temp HOME)', () => {
  it('detects Antigravity CLI login from ANTIGRAVITY_API_KEY or ~/.gemini/antigravity-cli/settings.json', () => {
    expect(detectAntigravityCLILogin()).toBe(false);
    process.env.ANTIGRAVITY_API_KEY = 'agy-test-key';
    expect(detectAntigravityCLILogin()).toBe(true);
    delete process.env.ANTIGRAVITY_API_KEY;
    mkdirSync(join(tmpHome, '.gemini', 'antigravity-cli'), { recursive: true });
    writeFileSync(join(tmpHome, '.gemini', 'antigravity-cli', 'settings.json'), JSON.stringify({ theme: 'dark' }));
    expect(detectAntigravityCLILogin()).toBe(true);
  });

  it('detects Cursor CLI login from ~/.cursor/cli-config.json authInfo', () => {
    mkdirSync(join(tmpHome, '.cursor'), { recursive: true });
    writeFileSync(join(tmpHome, '.cursor', 'cli-config.json'), JSON.stringify({ authInfo: {} }));
    expect(detectCursorCLILogin()).toBe(false); // empty authInfo = not logged in
    writeFileSync(join(tmpHome, '.cursor', 'cli-config.json'), JSON.stringify({ authInfo: { userId: 'u1' } }));
    expect(detectCursorCLILogin()).toBe(true);
    delete process.env.CURSOR_API_KEY;
  });

  it('detects Grok via env key or ~/.grok/auth.json', () => {
    expect(detectGrokCLILogin()).toBe(false);
    process.env.GROK_CODE_XAI_API_KEY = 'xai-test';
    expect(detectGrokCLILogin()).toBe(true);
    delete process.env.GROK_CODE_XAI_API_KEY;
    mkdirSync(join(tmpHome, '.grok'), { recursive: true });
    writeFileSync(join(tmpHome, '.grok', 'auth.json'), JSON.stringify({ access_token: 'tok' }));
    expect(detectGrokCLILogin()).toBe(true);
  });

  it('detects machine Codex login from ~/.codex/auth.json tokens', () => {
    expect(detectCodexCLILogin()).toBe(false);
    mkdirSync(join(tmpHome, '.codex'), { recursive: true });
    writeFileSync(join(tmpHome, '.codex', 'auth.json'), JSON.stringify({ tokens: { access_token: 'a' } }));
    expect(detectCodexCLILogin()).toBe(true);
  });
});

describe('canAutoEnable gate', () => {
  it('honors the KORY_DISABLE_CLI_AUTODETECT opt-out', () => {
    process.env.KORY_DISABLE_CLI_AUTODETECT = '1';
    for (const p of ['claude', 'codex', 'google', 'xai'] as const) {
      expect(canAutoEnable(p)).toBe(false);
    }
  });

  it('never auto-enables a provider with no backing CLI', () => {
    expect(canAutoEnable('openai')).toBe(false);
    expect(canAutoEnable('anthropic')).toBe(false);
  });

  it('does not auto-enable xai from a bare env key when the grok CLI is absent', () => {
    process.env.GROK_CODE_XAI_API_KEY = 'xai-test'; // key present…
    process.env.PATH = join(tmpHome, 'empty'); // …but no `grok` binary on PATH
    expect(canAutoEnable('xai')).toBe(false);
  });
});
