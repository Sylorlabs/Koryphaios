import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, statSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  saveProviderSecrets,
  loadProviderSecrets,
  upsertProviderSecrets,
  removeProviderSecrets,
  stripProviderSecrets,
  hydrateProviderSecrets,
} from '../secret-store';

// Windows doesn't support POSIX permission modes.
const isWindows = process.platform === 'win32';

describe('secret-store permissions', () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'kory-secret-store-'));
  });
  afterEach(() => {
    try {
      rmSync(root, { recursive: true, force: true });
    } catch (err: unknown) {
      // Best-effort temp dir cleanup — tests don't need serverLog.
      console.debug('secret-store test cleanup failed:', err instanceof Error ? err.message : String(err));
    }
  });

  test('saveProviderSecrets creates .koryphaios/ at 0o700 and credentials.json at 0o600', () => {
    saveProviderSecrets(root, { openai: { apiKey: 'sk-test' } });
    const dir = join(root, '.koryphaios');
    const file = join(dir, 'credentials.json');
    expect(existsSync(file)).toBe(true);
    if (isWindows) return;
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  test('upsertProviderSecrets heals a loose .koryphaios/ dir to 0o700', () => {
    // Simulate an older build that created .koryphaios/ at 0o775.
    const dir = join(root, '.koryphaios');
    mkdtempSync(dir); // no-op if exists; we want a loose dir
    rmSync(dir, { recursive: true, force: true });
    const { mkdirSync } = require('node:fs') as typeof import('node:fs');
    mkdirSync(dir, { recursive: true, mode: 0o775 });
    if (!isWindows) {
      chmodSyncLoose(dir, 0o775);
      expect(statSync(dir).mode & 0o777).toBe(0o775);
    }

    upsertProviderSecrets(root, 'openai', { apiKey: 'sk-test' });
    if (isWindows) return;
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    expect(statSync(join(dir, 'credentials.json')).mode & 0o777).toBe(0o600);
  });

  test('round-trip: save → load preserves secrets', () => {
    saveProviderSecrets(root, { openai: { apiKey: 'sk-abc' }, claude: { authToken: 'tok-xyz' } });
    const loaded = loadProviderSecrets(root);
    expect(loaded.openai?.apiKey).toBe('sk-abc');
    expect(loaded.claude?.authToken).toBe('tok-xyz');
  });

  test('stripProviderSecrets removes secret fields from the clean map', () => {
    const { clean, secrets } = stripProviderSecrets({
      openai: {
        apiKey: 'sk-abc',
        baseUrl: 'https://api.openai.com/v1',
        headers: { Authorization: 'Bearer custom-secret', 'x-tenant-token': 'tenant-secret' },
      },
      claude: { authToken: 'tok-xyz', name: 'claude' },
    });
    expect(clean.openai).toEqual({ baseUrl: 'https://api.openai.com/v1' });
    expect(clean.claude).toEqual({ name: 'claude' });
    expect(secrets.openai?.apiKey).toBe('sk-abc');
    expect(secrets.openai?.headers).toEqual({
      Authorization: 'Bearer custom-secret',
      'x-tenant-token': 'tenant-secret',
    });
    expect(secrets.claude?.authToken).toBe('tok-xyz');
  });

  test('hydrateProviderSecrets merges stored secrets back into a providers map', () => {
    saveProviderSecrets(root, {
      openai: {
        apiKey: 'sk-abc',
        headers: { Authorization: 'Bearer custom-secret', 'x-private-key': 'private' },
      },
    });
    const hydrated = hydrateProviderSecrets(root, {
      openai: {
        baseUrl: 'https://api.openai.com/v1',
        headers: { 'x-public-routing': 'west' },
      },
      claude: { name: 'claude' },
    });
    expect(hydrated.openai).toEqual({
      baseUrl: 'https://api.openai.com/v1',
      apiKey: 'sk-abc',
      headers: {
        'x-public-routing': 'west',
        Authorization: 'Bearer custom-secret',
        'x-private-key': 'private',
      },
    });
    expect(hydrated.claude).toEqual({ name: 'claude' });
  });

  test('removeProviderSecrets deletes a provider entry', () => {
    saveProviderSecrets(root, { openai: { apiKey: 'sk-abc' }, claude: { authToken: 'tok-xyz' } });
    removeProviderSecrets(root, 'openai');
    const loaded = loadProviderSecrets(root);
    expect(loaded.openai).toBeUndefined();
    expect(loaded.claude?.authToken).toBe('tok-xyz');
  });
});

// Helper: chmod that tolerates filesystems which reject the mode (the test
// still asserts the mode below, so a silent failure surfaces there).
function chmodSyncLoose(path: string, mode: number): void {
  try {
    const { chmodSync } = require('node:fs') as typeof import('node:fs');
    chmodSync(path, mode);
  } catch (err: unknown) {
    // Filesystems that reject the mode will surface in the assertion below.
    console.debug('chmodSyncLoose failed (will surface in assertion):', err instanceof Error ? err.message : String(err));
  }
}
