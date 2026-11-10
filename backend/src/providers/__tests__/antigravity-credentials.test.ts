import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { readPortableAntigravityCredential, stageAntigravityCredential, validateAntigravityCredential } from '../antigravity-credentials';

const roots: string[] = [];
const credential = JSON.stringify({ token: { access_token: 'synthetic-access', refresh_token: 'synthetic-refresh', token_type: 'Bearer', expiry: '2027-01-01T00:00:00Z' }, auth_method: 'oauth', id_token: 'synthetic-id', hooks: { unsafe: true } });
function root() { const path = mkdtempSync(join(tmpdir(), 'agy-credential-test-')); roots.push(path); return path; }
afterEach(() => { for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true }); });

test('stages only native authentication in private files and deletes the entire run home', () => {
  const parent = root();
  const staged = stageAntigravityCredential(credential, parent);
  const file = join(staged.home, '.gemini', 'antigravity-cli', 'antigravity-oauth-token');
  expect(statSync(staged.home).mode & 0o777).toBe(0o700);
  expect(statSync(file).mode & 0o777).toBe(0o600);
  expect(JSON.parse(readFileSync(file, 'utf8'))).not.toHaveProperty('hooks');
  staged.cleanup();
  expect(() => statSync(staged.home)).toThrow();
});
test('uses a valid disk login without touching the keychain', async () => {
  const home = root();
  const path = join(home, '.gemini', 'antigravity-cli');
  mkdirSync(path, { recursive: true });
  writeFileSync(join(path, 'antigravity-oauth-token'), credential, { mode: 0o600 });
  let keychainReads = 0;
  expect(await readPortableAntigravityCredential({ home, platform: 'darwin', readKeychain: async () => { keychainReads++; return credential; } })).toBe(validateAntigravityCredential(credential));
  expect(keychainReads).toBe(0);
});
test('falls back to the exact keychain item when no portable login exists', async () => {
  expect(await readPortableAntigravityCredential({ home: root(), platform: 'darwin', readKeychain: async () => credential })).toBe(validateAntigravityCredential(credential));
});
test('native file fallback rejects links and malformed records without echoing secrets', async () => {
  const home = root();
  const dir = join(home, '.gemini', 'antigravity-cli'); mkdirSync(dir, { recursive: true });
  const source = join(home, 'credential'); writeFileSync(source, credential, { mode: 0o600 });
  symlinkSync(source, join(dir, 'antigravity-oauth-token'));
  await expect(readPortableAntigravityCredential({ home, platform: 'linux' })).rejects.toThrow('cannot be transferred');
  expect(() => validateAntigravityCredential(JSON.stringify({ token: { access_token: 'private-value' } }))).toThrow('cannot be transferred');
});
test('cancelled keychain requests never fall back to another login', async () => {
  const controller = new AbortController();
  await expect(readPortableAntigravityCredential({ home: root(), platform: 'darwin', signal: controller.signal, readKeychain: async () => { controller.abort(); throw new Error('cancelled'); } })).rejects.toThrow();
});
