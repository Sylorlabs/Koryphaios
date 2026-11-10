import { afterEach, describe, expect, it } from 'bun:test';
import {
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readlinkSync,
  readdirSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { canonicalizePath } from '../../runtime/platform';
import { prepareCodeBuddyCliEnvironment, stageCodeBuddyCliAuth } from '../codebuddy-environment';

const AUTH = 'Tencent-Cloud.coding-copilot.info';
const LAYOUTS = [
  join('Library', 'Application Support', 'CodeBuddyExtension', 'Data', 'Public', 'auth'),
  join('AppData', 'Local', 'CodeBuddyExtension', 'Data', 'Public', 'auth'),
  join('.local', 'share', 'CodeBuddyExtension', 'Data', 'Public', 'auth'),
];
const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

function fixture(layout = LAYOUTS[0]) {
  const root = mkdtempSync(join(tmpdir(), 'kory-codebuddy-auth-'));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const sourceHome = join(root, 'real-home');
  const home = join(root, 'managed');
  const source = join(sourceHome, layout, AUTH);
  const target = join(home, layout, AUTH);
  mkdirSync(dirname(source), { recursive: true });
  writeFileSync(source, 'synthetic-cli-auth-never-parsed', { mode: 0o600 });
  return { root, sourceHome, home, source, target, storage: { root: home } };
}

describe('CodeBuddy CLI-owned auth isolation', () => {
  for (const layout of LAYOUTS) {
    it(`links only the standalone CLI identity in ${layout}`, () => {
      const f = fixture(layout);
      for (const name of ['workbuddy-desktop-ai.info', `${AUTH}.backup`, 'unrelated.info']) {
        writeFileSync(join(dirname(f.source), name), 'synthetic-other-account');
      }
      const before = lstatSync(f.source);
      const mounts = stageCodeBuddyCliAuth(f.home, f.sourceHome, f.storage);
      expect(readlinkSync(f.target)).toBe(canonicalizePath(f.source));
      expect(mounts).toEqual([canonicalizePath(f.source)]);
      expect(mounts).not.toContain(dirname(f.source));
      expect(readdirSync(dirname(f.target))).toEqual([AUTH]);
      expect(lstatSync(f.source).mtimeMs).toBe(before.mtimeMs);
      expect(lstatSync(f.source).mode).toBe(before.mode);
    });
  }

  it('honors the exact logged-out marker without exposing backups or reading it', () => {
    const f = fixture();
    writeFileSync(`${f.source}.logged-out`, 'synthetic-logout-marker');
    expect(stageCodeBuddyCliAuth(f.home, f.sourceHome, f.storage)).toEqual([
      canonicalizePath(f.source),
      canonicalizePath(`${f.source}.logged-out`),
    ]);
    expect(existsSync(`${f.target}.logged-out`)).toBe(true);
  });

  it('drops stale managed credentials and markers when the real login is removed', () => {
    const f = fixture();
    writeFileSync(`${f.source}.logged-out`, 'synthetic-logout-marker');
    stageCodeBuddyCliAuth(f.home, f.sourceHome, f.storage);
    unlinkSync(f.target);
    writeFileSync(f.target, 'synthetic-private-cli-refresh');
    unlinkSync(f.source);
    unlinkSync(`${f.source}.logged-out`);
    expect(stageCodeBuddyCliAuth(f.home, f.sourceHome, f.storage)).toEqual([]);
    expect(lstatSync(f.target, { throwIfNoEntry: false })).toBeUndefined();
    expect(lstatSync(`${f.target}.logged-out`, { throwIfNoEntry: false })).toBeUndefined();
  });

  it('retires legacy links without copying settings, local storage or user state', () => {
    const f = fixture();
    mkdirSync(join(f.sourceHome, '.codebuddy', 'local_storage'), { recursive: true });
    mkdirSync(f.home);
    for (const name of ['settings.json', '.credentials.json', 'auth.json']) {
      const source = join(f.sourceHome, '.codebuddy', name);
      writeFileSync(source, 'synthetic-legacy-file');
      symlinkSync(source, join(f.home, name));
    }
    stageCodeBuddyCliAuth(f.home, f.sourceHome, f.storage);
    expect(existsSync(join(f.sourceHome, '.codebuddy', 'settings.json'))).toBe(true);
    for (const name of [
      'settings.json',
      '.credentials.json',
      'auth.json',
      'local_storage',
      'user-state.json',
    ]) {
      expect(existsSync(join(f.home, name))).toBe(false);
    }
    writeFileSync(join(f.home, 'settings.json'), 'synthetic-private-settings');
    stageCodeBuddyCliAuth(f.home, f.sourceHome, f.storage);
    expect(lstatSync(join(f.home, 'settings.json')).isFile()).toBe(true);
  });

  for (const link of ['file-symlink', 'parent-symlink', 'hard-link'] as const) {
    it(`refuses a redirected credential: ${link}`, () => {
      const f = fixture();
      const other = join(f.root, 'other');
      writeFileSync(other, 'synthetic-other-file');
      unlinkSync(f.source);
      if (link === 'parent-symlink') {
        rmSync(dirname(f.source), { recursive: true });
        const directory = join(f.root, 'other-auth');
        mkdirSync(directory);
        writeFileSync(join(directory, AUTH), 'synthetic-other-file');
        symlinkSync(directory, dirname(f.source), 'dir');
      } else if (link === 'file-symlink') symlinkSync(other, f.source);
      else linkSync(other, f.source);
      expect(() => stageCodeBuddyCliAuth(f.home, f.sourceHome, f.storage)).toThrow(
        'Unsafe CodeBuddy CLI auth resource',
      );
    });
  }

  it('refuses a symlinked managed auth directory and never stages into the real HOME', () => {
    const f = fixture();
    expect(() => stageCodeBuddyCliAuth(f.sourceHome, f.sourceHome, { root: f.sourceHome })).toThrow(
      'separate managed HOME',
    );
    mkdirSync(dirname(f.target), { recursive: true });
    rmSync(dirname(f.target), { recursive: true });
    symlinkSync(dirname(f.source), dirname(f.target), 'dir');
    expect(() => stageCodeBuddyCliAuth(f.home, f.sourceHome, f.storage)).toThrow();
    expect(lstatSync(f.source).isFile()).toBe(true);
  });

  for (const filesystemIsolation of [false, true]) {
    it(`preserves managed HOME, config and exact read-only mounts (soft jail: ${filesystemIsolation})`, () => {
      const f = fixture();
      const prepared = prepareCodeBuddyCliEnvironment(f.home, {
        ...f,
        filesystemIsolation,
        sourceEnv: {
          HOME: f.sourceHome,
          USERPROFILE: f.sourceHome,
          CODEBUDDY_HOME: 'unsupported-old-home',
          CODEBUDDY_CONFIG_DIR: 'real-config',
          CODEBUDDY_API_KEY: 'synthetic-cli-key',
          WORKBUDDY_CONFIG_DIR: 'other-product',
          UNRELATED_SECRET: 'synthetic-secret',
        },
      });
      cleanups.push(prepared.cleanup);
      expect(prepared.env.HOME).toBe(f.home);
      expect(prepared.env.USERPROFILE).toBe(f.home);
      expect(prepared.env.CODEBUDDY_CONFIG_DIR).toBe(f.home);
      expect(prepared.env.CODEBUDDY_HOME).toBeUndefined();
      expect(prepared.env.WORKBUDDY_CONFIG_DIR).toBeUndefined();
      expect(prepared.env.UNRELATED_SECRET).toBeUndefined();
      expect(prepared.env.CODEBUDDY_API_KEY).toBe('synthetic-cli-key');
      expect(prepared.readonlyConfigDirs).toEqual([canonicalizePath(f.source)]);
      expect(prepared.configDirs).toContain(f.home);
      expect(prepared.configDirs).not.toContain(f.sourceHome);
      expect(prepared.configDirs).not.toContain(dirname(f.source));
      expect(existsSync(f.target)).toBe(true);
      if (filesystemIsolation) {
        const softHome = dirname(prepared.env.TMPDIR!);
        expect(softHome).not.toBe(f.home);
        expect(prepared.configDirs).toContain(softHome);
        expect(prepared.env.XDG_DATA_HOME).toBe(join(softHome, '.local', 'share'));
        prepared.cleanup();
        expect(existsSync(softHome)).toBe(false);
        expect(existsSync(f.source)).toBe(true);
      }
    });
  }
});
