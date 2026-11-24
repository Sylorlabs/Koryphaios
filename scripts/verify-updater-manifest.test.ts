import { describe, expect, test } from 'bun:test';
import {
  generateKeyPairSync,
  createHash,
  sign as cryptoSign,
  type KeyObject,
} from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  assetNamesFromJson,
  compareSemver,
  inspectMinisignature,
  parseCliArguments,
  publicKeyId,
  REQUIRED_UPDATER_PLATFORMS,
  verifyMinisignature,
  verifyUpdaterManifest,
} from './verify-updater-manifest';

const REPO_ROOT = join(import.meta.dir, '..');
const SCRIPT = join(import.meta.dir, 'verify-updater-manifest.ts');
const TAURI_CONF = join(REPO_ROOT, 'desktop/src-tauri/tauri.conf.json');

// Public material from the published v0.1.0 release: the updater public key
// the installed apps trust (desktop/src-tauri/tauri.conf.json) and a real
// signature made by the matching secret key. Neither is a secret.
const PUBKEY = JSON.parse(readFileSync(TAURI_CONF, 'utf8')).plugins.updater.pubkey as string;
const REAL_SIGNATURE =
  'dW50cnVzdGVkIGNvbW1lbnQ6IHNpZ25hdHVyZSBmcm9tIHRhdXJpIHNlY3JldCBrZXkKUlVTVU5vdkNJMXdiZmpjbEJnVlk0bXEvT2Y5Smwxa0YrVDJBRFJ1Q1NUZ1BJdFFhdU82OUxVN2dxM0ViejN2MmV1K3BKMU1LRlJERkliQWRJMTRLRkRBekpMbHR3K1c3ZGdrPQp0cnVzdGVkIGNvbW1lbnQ6IHRpbWVzdGFtcDoxNzg1ODE0MzA3CWZpbGU6S29yeXBoYWlvcy5hcHAudGFyLmd6ClgxbHpDdDB6TnFVckk1NE1ha3k4bjFiOU5JSEU3WnJ2Nzg2UFNzUjFFLy9YMk1rQ2NBSTZqV0hPWk5lOFhxbnQyVlpYMzZUOWNFMk1vaHltdzlVL0F3PT0K';
const REAL_KEY_ID = '94368bc2235c1b7e';

const REPO = 'Sylorlabs/Koryphaios';
const TAG = 'v0.5.0';

const RELEASE_ASSETS = [
  'Koryphaios_aarch64.app.tar.gz',
  'Koryphaios_aarch64.app.tar.gz.sig',
  'Koryphaios_x86_64.app.tar.gz',
  'Koryphaios-0.5.0-x64-setup.exe',
  'Koryphaios_0.5.0_amd64.AppImage',
  'Koryphaios_0.5.0_amd64.deb',
  'Koryphaios-0.5.0-1.x86_64.rpm',
  'Koryphaios-0.5.0-universal.dmg',
];

function url(file: string, tag = TAG): string {
  return `https://github.com/${REPO}/releases/download/${tag}/${file}`;
}

/** A manifest shaped exactly like release-desktop.yml publishes it. */
function manifest(overrides: Record<string, unknown> = {}): Record<string, any> {
  const entry = (file: string) => ({ url: url(file), signature: REAL_SIGNATURE });
  return {
    version: '0.5.0',
    notes: '### Fixed\n- a bug',
    pub_date: '2026-11-24T08:00:00Z',
    platforms: {
      'darwin-aarch64': entry('Koryphaios_aarch64.app.tar.gz'),
      'darwin-x86_64': entry('Koryphaios_x86_64.app.tar.gz'),
      'windows-x86_64': entry('Koryphaios-0.5.0-x64-setup.exe'),
      'linux-x86_64': entry('Koryphaios_0.5.0_amd64.AppImage'),
      'linux-x86_64-appimage': entry('Koryphaios_0.5.0_amd64.AppImage'),
      'linux-x86_64-deb': entry('Koryphaios_0.5.0_amd64.deb'),
      'linux-x86_64-rpm': entry('Koryphaios-0.5.0-1.x86_64.rpm'),
    },
    ...overrides,
  };
}

const FULL_OPTIONS = {
  expectVersion: '0.5.0',
  assetNames: RELEASE_ASSETS,
  repo: REPO,
  pubkey: PUBKEY,
};

function errorsFor(value: unknown, options = FULL_OPTIONS): string[] {
  return verifyUpdaterManifest(value, options).errors;
}

/** Build a minisign public key and a Tauri-shaped signature from a real Ed25519
 *  key pair, so the cryptographic check can be exercised without any secret. */
function syntheticSigner(keyIdHex = 'a1b2c3d4e5f60718') {
  const { publicKey, privateKey }: { publicKey: KeyObject; privateKey: KeyObject } =
    generateKeyPairSync('ed25519');
  const raw = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32);
  const keyId = Buffer.from(keyIdHex, 'hex');
  const pubkeyText = `untrusted comment: minisign public key: ${keyIdHex.toUpperCase()}\n`;
  const pubkey = Buffer.from(
    pubkeyText + Buffer.concat([Buffer.from('Ed'), keyId, raw]).toString('base64') + '\n',
  ).toString('base64');
  const signFile = (data: Buffer): string => {
    const digest = createHash('blake2b512').update(data).digest();
    const signature = cryptoSign(null, digest, privateKey);
    const sigLine = Buffer.concat([Buffer.from('ED'), keyId, signature]).toString('base64');
    const globalSig = Buffer.alloc(64, 7).toString('base64');
    const text =
      'untrusted comment: signature from tauri secret key\n' +
      `${sigLine}\n` +
      'trusted comment: timestamp:1785814307\tfile:Koryphaios.app.tar.gz\n' +
      `${globalSig}\n`;
    return Buffer.from(text).toString('base64');
  };
  return { pubkey, signFile };
}

describe('compareSemver', () => {
  test('orders numeric cores so 0.1.0 is older than 0.5.0', () => {
    expect(compareSemver('0.5.0', '0.1.0')).toBeGreaterThan(0);
    expect(compareSemver('0.1.0', '0.5.0')).toBeLessThan(0);
    expect(compareSemver('1.0.0', '0.9.99')).toBeGreaterThan(0);
    expect(compareSemver('0.10.0', '0.9.0')).toBeGreaterThan(0);
    expect(compareSemver('0.5.0', '0.5.0')).toBe(0);
  });

  test('ranks a prerelease below its release and orders prerelease identifiers', () => {
    expect(compareSemver('0.5.0', '0.5.0-rc.1')).toBeGreaterThan(0);
    expect(compareSemver('0.5.0-rc.2', '0.5.0-rc.10')).toBeLessThan(0);
    expect(compareSemver('0.5.0-alpha', '0.5.0-alpha.1')).toBeLessThan(0);
    expect(compareSemver('0.5.0+build.7', '0.5.0+build.9')).toBe(0);
  });

  test('rejects values that are not semantic versions', () => {
    expect(() => compareSemver('0.5', '0.4.0')).toThrow();
    expect(() => compareSemver('v0.5.0', '0.4.0')).toThrow();
  });
});

describe('minisign structure', () => {
  test('reads the real v0.1.0 signature and matches the configured public key', () => {
    const shape = inspectMinisignature(REAL_SIGNATURE);
    expect(shape).toEqual({ algorithm: 'ED', keyId: REAL_KEY_ID });
    expect(publicKeyId(PUBKEY)).toBe(REAL_KEY_ID);
  });

  test('rejects text that is not a base64 minisign signature', () => {
    expect(inspectMinisignature('not base64 at all!')).toMatch(/not base64/);
    expect(inspectMinisignature(Buffer.from('plain text here').toString('base64'))).toMatch(
      /not a minisign file/,
    );
    const truncated = Buffer.from(
      'untrusted comment: x\nRUSUNov\ntrusted comment: y\nAAAA\n',
    ).toString('base64');
    expect(inspectMinisignature(truncated)).toMatch(/malformed/);
  });

  test('verifies a real Ed25519 signature and rejects tampered bytes', () => {
    const { pubkey, signFile } = syntheticSigner();
    const data = Buffer.from('the release archive bytes');
    const sig = signFile(data);
    expect(verifyMinisignature(data, sig, pubkey)).toBe(true);
    expect(verifyMinisignature(Buffer.from('tampered archive'), sig, pubkey)).toBe(false);
    const other = syntheticSigner('0000000000000001');
    expect(verifyMinisignature(data, sig, other.pubkey)).toBe(false);
  });
});

describe('assetNamesFromJson', () => {
  test('accepts gh release view output, a bare asset array, and bare names', () => {
    expect(assetNamesFromJson({ assets: [{ name: 'a.exe' }] })).toEqual(['a.exe']);
    expect(assetNamesFromJson([{ name: 'b.deb' }])).toEqual(['b.deb']);
    expect(assetNamesFromJson(['c.rpm'])).toEqual(['c.rpm']);
    expect(() => assetNamesFromJson({ assets: [{}] })).toThrow();
    expect(() => assetNamesFromJson({ nope: true })).toThrow();
  });
});

describe('verifyUpdaterManifest', () => {
  test('accepts a complete release manifest that matches its assets and key', () => {
    const result = verifyUpdaterManifest(manifest(), FULL_OPTIONS);
    expect(result.errors).toEqual([]);
    expect(result.warnings).toEqual([]);
    expect(result.version).toBe('0.5.0');
    expect(result.platforms).toContain('linux-x86_64-appimage');
  });

  test('requires every updater platform the release workflow publishes', () => {
    for (const platform of REQUIRED_UPDATER_PLATFORMS) {
      const copy = manifest();
      delete copy.platforms[platform];
      expect(errorsFor(copy)).toContain(`missing required platform ${platform}`);
    }
  });

  test('rejects a version that is not semver or differs from the release tag', () => {
    expect(errorsFor(manifest({ version: 'v0.5.0' }))[0]).toMatch(/semantic version/);
    expect(errorsFor(manifest({ version: '0.5' }))[0]).toMatch(/semantic version/);
    expect(errorsFor(manifest({ version: '0.4.0' }))).toContain('version is 0.4.0, expected 0.5.0');
  });

  test('requires an RFC 3339 pub_date', () => {
    const missing = manifest();
    delete missing.pub_date;
    expect(errorsFor(missing).some((e) => e.includes('pub_date'))).toBe(true);
    expect(errorsFor(manifest({ pub_date: 'yesterday' })).some((e) => e.includes('pub_date'))).toBe(
      true,
    );
  });

  test('rejects a URL that names a different release tag than the manifest version', () => {
    const copy = manifest();
    copy.platforms['linux-x86_64-deb'].url = url('Koryphaios_0.5.0_amd64.deb', 'v0.4.9');
    expect(errorsFor(copy)).toContain(
      'linux-x86_64-deb: url names release v0.4.9, expected v0.5.0',
    );
  });

  test('rejects a URL that is not a release download from the configured repository', () => {
    const copy = manifest();
    copy.platforms['windows-x86_64'].url =
      'https://github.com/someone-else/fork/releases/download/v0.5.0/Koryphaios-0.5.0-x64-setup.exe';
    expect(errorsFor(copy)[0]).toMatch(/must be a GitHub release download URL/);
    copy.platforms['windows-x86_64'].url = 'http://example.com/Koryphaios-0.5.0-x64-setup.exe';
    expect(errorsFor(copy)[0]).toMatch(/must be a GitHub release download URL/);
  });

  test('rejects a URL whose file was never uploaded to the release', () => {
    const copy = manifest();
    copy.platforms['darwin-aarch64'].url = url('Koryphaios_aarch64_renamed.app.tar.gz');
    expect(errorsFor(copy)).toContain(
      'darwin-aarch64: Koryphaios_aarch64_renamed.app.tar.gz is not an uploaded release asset',
    );
  });

  test('rejects a manual-install image where the updater payload belongs', () => {
    const copy = manifest();
    copy.platforms['darwin-aarch64'].url = url('Koryphaios-0.5.0-aarch64.dmg');
    const errors = errorsFor(copy, { ...FULL_OPTIONS, assetNames: undefined });
    expect(errors).toContain(
      'darwin-aarch64: Koryphaios-0.5.0-aarch64.dmg is not an updater payload (expected .app.tar.gz)',
    );
  });

  test('rejects an architecture that does not match the platform key', () => {
    const copy = manifest();
    copy.platforms['darwin-x86_64'].url = url('Koryphaios_aarch64.app.tar.gz');
    expect(errorsFor(copy, { ...FULL_OPTIONS, assetNames: undefined })).toContain(
      'darwin-x86_64: Koryphaios_aarch64.app.tar.gz does not name the x86_64 architecture',
    );
  });

  test('rejects a missing or non-minisign signature', () => {
    const missing = manifest();
    missing.platforms['linux-x86_64-rpm'].signature = '';
    expect(errorsFor(missing)).toContain('linux-x86_64-rpm: signature is missing');
    const plain = manifest();
    plain.platforms['linux-x86_64-deb'].signature = Buffer.from('just text').toString('base64');
    expect(errorsFor(plain)).toContain('linux-x86_64-deb: signature is not a minisign file');
  });

  test('rejects a signature made by a key the installed apps do not trust', () => {
    const other = syntheticSigner('0000000000000002');
    const copy = manifest();
    copy.platforms['windows-x86_64'].signature = other.signFile(Buffer.from('installer'));
    expect(errorsFor(copy)).toContain(
      'windows-x86_64: signed with key 0000000000000002, but the app trusts key 94368bc2235c1b7e',
    );
  });

  test('reports a configured public key that is not minisign', () => {
    const errors = errorsFor(manifest(), { ...FULL_OPTIONS, pubkey: 'bm90IGEga2V5' });
    expect(errors).toContain('configured updater pubkey is not a minisign public key');
  });

  test('requires the manifest to offer an update to the oldest supported build', () => {
    expect(errorsFor(manifest(), { ...FULL_OPTIONS, newerThan: '0.1.0' })).toEqual([]);
    expect(errorsFor(manifest(), { ...FULL_OPTIONS, newerThan: '0.5.0' })).toContain(
      'version 0.5.0 does not offer an update to builds at 0.5.0',
    );
    expect(errorsFor(manifest(), { ...FULL_OPTIONS, newerThan: 'latest' })).toContain(
      '--newer-than latest is not a semantic version',
    );
  });

  test('warns, without failing, about an unknown platform key', () => {
    const copy = manifest();
    copy.platforms['freebsd-x86_64'] = { url: url('Koryphaios-0.5.0.tar.xz'), signature: REAL_SIGNATURE };
    const result = verifyUpdaterManifest(copy, { ...FULL_OPTIONS, assetNames: undefined });
    expect(result.errors).toEqual([]);
    expect(result.warnings).toEqual(['platform freebsd-x86_64 is not a known updater target']);
  });

  test('rejects a non-object document', () => {
    expect(errorsFor(['not', 'an', 'object'])).toEqual(['manifest must be a JSON object']);
  });
});

describe('parseCliArguments', () => {
  test('reads the manifest path and the release options', () => {
    const parsed = parseCliArguments([
      'latest.json',
      '--expect-version',
      '0.5.0',
      '--repo',
      REPO,
      '--tauri-conf',
      TAURI_CONF,
      '--newer-than',
      '0.1.0',
    ]);
    expect(parsed.manifestPath).toBe('latest.json');
    expect(parsed.options).toMatchObject({
      expectVersion: '0.5.0',
      repo: REPO,
      pubkey: PUBKEY,
      newerThan: '0.1.0',
    });
  });

  test('rejects unknown flags, missing values and a missing manifest path', () => {
    expect(() => parseCliArguments(['latest.json', '--bogus'])).toThrow(/unknown option/);
    expect(() => parseCliArguments(['latest.json', '--repo'])).toThrow(/needs a value/);
    expect(() => parseCliArguments(['--repo', REPO])).toThrow(/usage/);
  });
});

describe('verify-updater-manifest CLI', () => {
  function runCli(body: unknown, extraArgs: string[]): { status: number; stdout: string; stderr: string } {
    const dir = mkdtempSync(join(tmpdir(), 'kory-updater-manifest-'));
    try {
      const file = join(dir, 'latest.json');
      writeFileSync(file, JSON.stringify(body));
      const assets = join(dir, 'assets.json');
      writeFileSync(assets, JSON.stringify({ assets: RELEASE_ASSETS.map((name) => ({ name })) }));
      try {
        const stdout = execFileSync(
          process.execPath,
          [SCRIPT, file, '--expect-version', '0.5.0', '--repo', REPO, '--assets', assets, '--tauri-conf', TAURI_CONF, ...extraArgs],
          { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
        );
        return { status: 0, stdout, stderr: '' };
      } catch (error) {
        const failed = error as { status: number; stdout: string; stderr: string };
        return { status: failed.status, stdout: failed.stdout, stderr: failed.stderr };
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  test('exits 0 for a publishable manifest and names what it checked', () => {
    const result = runCli(manifest(), ['--newer-than', '0.1.0']);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('latest.json ok: v0.5.0 with 7 platform(s)');
  });

  test('exits 1 and lists every problem for an unpublishable manifest', () => {
    const broken = manifest();
    broken.platforms['darwin-aarch64'].url = url('Koryphaios-0.5.0-aarch64.dmg');
    const result = runCli(broken, []);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('is not an updater payload');
    expect(result.stderr).toContain('not publishable');
  });

  test('exits 2 when the file is missing', () => {
    expect(() =>
      execFileSync(process.execPath, [SCRIPT, join(tmpdir(), 'kory-does-not-exist.json')], {
        stdio: 'ignore',
      }),
    ).toThrow();
  });
});
