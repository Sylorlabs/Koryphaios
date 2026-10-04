import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { canAutoEnable, cliAutoEnableCreds } from '../cli-detection';
import { getProviderHarnessCapabilities, supportsKoryControlPlaneTools } from '../provider-harness';
let root: string;
let home: string | undefined;
let path: string | undefined;
let disableDetection: string | undefined;
beforeEach(() => {
  home = process.env.HOME;
  path = process.env.PATH;
  disableDetection = process.env.KORY_DISABLE_CLI_AUTODETECT;
  delete process.env.KORY_DISABLE_CLI_AUTODETECT;
  root = mkdtempSync(join(tmpdir(), 'freebuff-detection-'));
  process.env.HOME = root;
  process.env.PATH = '/nonexistent-kory-test-path';
});
afterEach(() => {
  if (home === undefined) delete process.env.HOME;
  else process.env.HOME = home;
  if (path === undefined) delete process.env.PATH;
  else process.env.PATH = path;
  if (disableDetection === undefined) delete process.env.KORY_DISABLE_CLI_AUTODETECT;
  else process.env.KORY_DISABLE_CLI_AUTODETECT = disableDetection;
  rmSync(root, { recursive: true, force: true });
});
describe('Freebuff material detection versus runtime verification', () => {
  test('secondary account discovery does not require host tmux/bwrap or default account', () => {
    const profile = join(root, '.config', 'manicode-work');
    mkdirSync(profile, { recursive: true });
    writeFileSync(
      join(profile, 'credentials.json'),
      JSON.stringify({
        default: { authToken: 'synthetic-only', fingerprintId: 'synthetic-fingerprint' },
      }),
    );
    writeFileSync(join(profile, 'freebuff'), 'synthetic-not-executed', { mode: 0o700 });
    expect(canAutoEnable('freebuff')).toBe(true);
    expect(cliAutoEnableCreds('freebuff')?.authToken).toStartWith('cli:freebuff:');
  });
  test('setup detection still needs a CLI executable and account material', () => {
    expect(canAutoEnable('freebuff')).toBe(false);
    const profile = join(root, '.config', 'manicode');
    mkdirSync(profile, { recursive: true });
    writeFileSync(
      join(profile, 'credentials.json'),
      JSON.stringify({
        default: { authToken: 'synthetic-only', fingerprintId: 'synthetic-fingerprint' },
      }),
    );
    expect(canAutoEnable('freebuff')).toBe(false);
  });
  test('unprobed Freebuff runtime never claims isolation or verification eligibility', () => {
    const capabilities = getProviderHarnessCapabilities('freebuff');
    expect(capabilities.filesystemIsolation).toBe(false);
    expect(capabilities.verificationEligible).toBe(false);
    expect(capabilities.isolationMechanism).toBe('unverified-freebuff-runtime');
    expect(capabilities.limitations.join(' ')).toContain('Native Freebuff tools remain enabled');
    expect(supportsKoryControlPlaneTools('freebuff')).toBe(true);
    expect(supportsKoryControlPlaneTools('codebuff')).toBe(false);
  });
});
