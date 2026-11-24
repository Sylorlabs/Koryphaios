import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import {
  mkdtempSync,
  statSync,
  rmSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  saveProviderSecrets,
  loadProviderSecrets,
  upsertProviderSecrets,
  removeProviderSecrets,
  stripProviderSecrets,
  hydrateProviderSecrets,
  migrateSecretsOutOfConfig,
} from '../secret-store';
import { isWindows } from '../../runtime/platform';

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
      console.debug(
        'secret-store test cleanup failed:',
        err instanceof Error ? err.message : String(err),
      );
    }
  });

  test('saveProviderSecrets creates .koryphaios/ at 0o700 and credentials.json at 0o600', () => {
    saveProviderSecrets(root, { openai: { apiKey: 'sk-test' } });
    const dir = join(root, '.koryphaios');
    const file = join(dir, 'credentials.json');
    expect(existsSync(file)).toBe(true);
    if (isWindows()) return;
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
    if (!isWindows()) {
      chmodSyncLoose(dir, 0o775);
      expect(statSync(dir).mode & 0o777).toBe(0o775);
    }

    upsertProviderSecrets(root, 'openai', { apiKey: 'sk-test' });
    if (isWindows()) return;
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

describe('provider credential isolation', () => {
  let root: string;
  let path: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'kory-provider-isolation-'));
    mkdirSync(join(root, '.koryphaios'), { mode: 0o700 });
    path = join(root, '.koryphaios', 'credentials.json');
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  const alpha = {
    apiKey: 'synthetic-alpha-key',
    authToken: 'synthetic-alpha-token',
    headers: { Authorization: 'Bearer synthetic-alpha', 'x-tenant': 'synthetic-alpha-tenant' },
  };
  const beta = {
    apiKey: 'synthetic-beta-key',
    authToken: 'synthetic-beta-token',
    headers: { Authorization: 'Bearer synthetic-beta', 'x-tenant': 'synthetic-beta-tenant' },
  };

  test('upsert, partial rotation, and removal affect only the named provider', () => {
    upsertProviderSecrets(root, 'custom:alpha', alpha);
    upsertProviderSecrets(root, 'custom:beta', beta);
    expect(loadProviderSecrets(root)).toEqual({ 'custom:alpha': alpha, 'custom:beta': beta });

    upsertProviderSecrets(root, 'custom:alpha', {
      apiKey: 'synthetic-alpha-rotated',
      headers: { Authorization: 'Bearer synthetic-alpha-rotated' },
    });
    const rotatedAlpha = {
      ...alpha,
      apiKey: 'synthetic-alpha-rotated',
      headers: { ...alpha.headers, Authorization: 'Bearer synthetic-alpha-rotated' },
    };
    expect(loadProviderSecrets(root)).toEqual({
      'custom:alpha': rotatedAlpha,
      'custom:beta': beta,
    });

    const beforeNoop = readFileSync(path, 'utf-8');
    upsertProviderSecrets(root, 'custom:beta', { apiKey: '', authToken: ' ', headers: {} });
    expect(removeProviderSecrets(root, 'custom:missing')).toBe(false);
    expect(readFileSync(path, 'utf-8')).toBe(beforeNoop);
    expect(removeProviderSecrets(root, 'custom:alpha')).toBe(true);
    expect(loadProviderSecrets(root)).toEqual({ 'custom:beta': beta });
    expect(removeProviderSecrets(root, 'custom:alpha')).toBe(false);
    expect(hydrateProviderSecrets(root, {})).toEqual({ 'custom:beta': beta });
    expect(removeProviderSecrets(root, 'custom:beta')).toBe(true);
    expect(loadProviderSecrets(root)).toEqual({});
  });

  test('hydration allows only credential fields and uses the provider map key as identity', () => {
    const injected = {
      ...alpha,
      name: 'custom:beta',
      baseUrl: 'https://injected.invalid',
      disabled: false,
      custom: false,
      models: ['injected-model'],
    };
    writeFileSync(path, JSON.stringify({ 'custom:alpha': injected, 'custom:beta': beta }));
    const providers = {
      'custom:alpha': {
        name: 'custom:alpha',
        baseUrl: 'https://alpha.invalid',
        disabled: true,
        custom: true,
        headers: { 'x-routing': 'alpha', Authorization: 'Bearer synthetic-old-alpha' },
      },
      'custom:beta': { name: 'custom:beta', baseUrl: 'https://beta.invalid' },
      untouched: { name: 'untouched', headers: { 'x-routing': 'untouched' } },
    };
    const original = structuredClone(providers);
    const originalStore = readFileSync(path, 'utf-8');
    const hydrated = hydrateProviderSecrets(root, providers);
    expect(hydrated).toEqual({
      ...original,
      'custom:alpha': {
        ...original['custom:alpha'],
        ...alpha,
        headers: { 'x-routing': 'alpha', ...alpha.headers },
      },
      'custom:beta': { ...original['custom:beta'], ...beta },
    });
    expect(providers).toEqual(original);
    expect(readFileSync(path, 'utf-8')).toBe(originalStore);
    expect(hydrateProviderSecrets(root, {})).toEqual({
      'custom:alpha': alpha,
      'custom:beta': beta,
    });

    // Updating a different provider must not rewrite or discard this entry.
    upsertProviderSecrets(root, 'custom:beta', { apiKey: 'synthetic-beta-rotated' });
    expect(JSON.parse(readFileSync(path, 'utf-8'))['custom:alpha']).toEqual(injected);
  });

  test('invalid credential values and extra upsert fields cannot become runtime settings', () => {
    writeFileSync(
      path,
      JSON.stringify({
        alpha: {
          apiKey: { name: 'beta' },
          authToken: 42,
          name: 'beta',
          headers: {
            Authorization: 'Bearer synthetic-alpha',
            empty: '',
            invalid: 42,
            ' ': 'ignored',
          },
        },
      }),
    );
    expect(hydrateProviderSecrets(root, { alpha: { name: 'alpha' } })).toEqual({
      alpha: { name: 'alpha', headers: { Authorization: 'Bearer synthetic-alpha' } },
    });
    const values = { ...beta, name: 'alpha', baseUrl: 'https://injected.invalid', disabled: true };
    upsertProviderSecrets(root, 'beta', values);
    expect(loadProviderSecrets(root).beta).toEqual(beta);
  });

  test('provider lookups never use inherited entries', () => {
    const inherited = { apiKey: 'synthetic-inherited', baseUrl: 'https://inherited.invalid' };
    const providers = Object.create({ alpha: inherited });
    saveProviderSecrets(root, { alpha });
    expect(hydrateProviderSecrets(root, providers)).toEqual({ alpha });
    // This ordinary key also collides with an Object.prototype property.
    const stripped = stripProviderSecrets({ toString: beta });
    expect(stripped.secrets).toEqual({ toString: beta });
    expect(Object.prototype.toString).not.toHaveProperty('apiKey');
    upsertProviderSecrets(root, 'toString', beta);
    expect(loadProviderSecrets(root)).toEqual({ alpha, toString: beta });
  });

  test.each(['__proto__', 'constructor', 'prototype'])(
    'rejects dangerous provider key %s',
    (name) => {
      saveProviderSecrets(root, { alpha });
      const before = readFileSync(path, 'utf-8');
      const dangerous = JSON.parse(JSON.stringify({ [name]: beta }));
      expect(() => upsertProviderSecrets(root, name, beta)).toThrow();
      expect(() => removeProviderSecrets(root, name)).toThrow();
      expect(() => stripProviderSecrets(dangerous)).toThrow();
      expect(() => hydrateProviderSecrets(root, dangerous)).toThrow();
      expect(() => saveProviderSecrets(root, dangerous)).toThrow();
      expect(readFileSync(path, 'utf-8')).toBe(before);

      writeFileSync(path, JSON.stringify({ alpha, ...dangerous }));
      const corrupt = readFileSync(path, 'utf-8');
      expect(() => loadProviderSecrets(root)).toThrow();
      expect(() => hydrateProviderSecrets(root, {})).toThrow();
      expect(() => upsertProviderSecrets(root, 'alpha', beta)).toThrow();
      expect(() => removeProviderSecrets(root, 'alpha')).toThrow();
      expect(readFileSync(path, 'utf-8')).toBe(corrupt);
      expect(Object.getPrototypeOf({})).toBe(Object.prototype);
      expect(Object.prototype).not.toHaveProperty('apiKey');
    },
  );

  test.each([
    ['truncated JSON', '{"alpha":{"apiKey":"synthetic-truncated"'],
    ['empty file', ''],
    ['null root', 'null'],
    ['array root', '[]'],
    ['string root', '"synthetic-root"'],
    ['number root', '42'],
    ['boolean root', 'false'],
    ['null entry', '{"alpha":null}'],
    ['array entry', '{"alpha":[]}'],
    ['string entry', '{"alpha":"synthetic-invalid-entry"}'],
  ])('preserves a corrupt store (%s) across all credential operations', (_label, contents) => {
    writeFileSync(path, contents);
    expect(() => loadProviderSecrets(root)).toThrow();
    expect(() => hydrateProviderSecrets(root, { alpha: { name: 'alpha' } })).toThrow();
    expect(() => upsertProviderSecrets(root, 'beta', beta)).toThrow();
    expect(readFileSync(path, 'utf-8')).toBe(contents);
    expect(() => removeProviderSecrets(root, 'alpha')).toThrow();
    expect(() => removeProviderSecrets(root, 'missing')).toThrow();
    expect(readFileSync(path, 'utf-8')).toBe(contents);
    expect(() => saveProviderSecrets(root, { beta })).toThrow();
    expect(readFileSync(path, 'utf-8')).toBe(contents);

    const configPath = join(root, 'koryphaios.json');
    const config = JSON.stringify({ providers: { beta } });
    writeFileSync(configPath, config);
    migrateSecretsOutOfConfig(root);
    expect(readFileSync(path, 'utf-8')).toBe(contents);
    expect(readFileSync(configPath, 'utf-8')).toBe(config);
  });

  test('read errors are not treated as an empty store', () => {
    mkdirSync(path);
    expect(() => loadProviderSecrets(root)).toThrow();
    expect(() => upsertProviderSecrets(root, 'alpha', alpha)).toThrow();
    expect(() => removeProviderSecrets(root, 'alpha')).toThrow();
    expect(statSync(path).isDirectory()).toBe(true);
  });

  test('a missing store is empty and can be initialized', () => {
    expect(loadProviderSecrets(root)).toEqual({});
    expect(removeProviderSecrets(root, 'alpha')).toBe(false);
    expect(hydrateProviderSecrets(root, { alpha: { name: 'alpha' } })).toEqual({
      alpha: { name: 'alpha' },
    });
    expect(existsSync(path)).toBe(false);
    upsertProviderSecrets(root, 'alpha', alpha);
    expect(loadProviderSecrets(root)).toEqual({ alpha });
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
    console.debug(
      'chmodSyncLoose failed (will surface in assertion):',
      err instanceof Error ? err.message : String(err),
    );
  }
}
