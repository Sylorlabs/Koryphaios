import { afterEach, expect, spyOn, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import {
  appendFileSync,
  chmodSync,
  constants,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { canonicalizePath, isContainedBy, isMac } from '../backend/src/runtime/platform';
import { createNativeMacReviewerSandbox, nativeMacStageProfile } from './native-reviewer-sandbox';
import { strictJson } from './reviewer-json';

const roots: string[] = [];
const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const home = '/private/var/folders/test/native-home';
const denies = ['/Users', '/Volumes', '/private/var/folders', '/private/tmp'];

test('profile uses broad runtime reads with precise private-root exceptions and private-only writes', () => {
  const profile = nativeMacStageProfile(home, denies);
  expect(profile).toContain('(deny default)');
  expect(profile).toContain('(allow file-read*)');
  expect(profile).toContain(`(allow file-write* (subpath ${JSON.stringify(home)}))`);
  expect(profile).toContain('(allow file-write-data (literal "/dev/null"))');
  for (const root of denies)
    expect(profile).toContain(
      `(deny file-read* (require-all (subpath ${JSON.stringify(root)}) (require-not (subpath ${JSON.stringify(home)}))))`,
    );
  expect(profile).not.toContain('(allow file-write* (subpath "/tmp"))');
  expect(profile).not.toContain('(allow file-write* (subpath "/private/tmp"))');
  expect(profile).not.toContain('(allow file-read-metadata');
});

for (const [privateRoot, denyRoots] of [
  ['/', denies],
  ['relative', denies],
  [home + '\n(allow default)', denies],
  [home, []],
  [home, [home]],
  [home, [home + '/child']],
  [home, ['/']],
  [home, ['/Users', '/Users']],
  [home, ['relative']],
] as const) {
  test(`refuses invalid profile boundaries ${JSON.stringify([privateRoot, denyRoots])}`, () => {
    expect(() => nativeMacStageProfile(privateRoot, denyRoots)).toThrow(/redacted/u);
  });
}

test('profile escapes paths instead of interpreting policy syntax', () => {
  const root = '/private/tmp/a"(allow default)';
  expect(nativeMacStageProfile(root, denies)).toContain(JSON.stringify(root));
});

function setup() {
  const root = canonicalizePath(mkdtempSync(join(tmpdir(), 'kory-native-stage-control-')));
  roots.push(root);
  const privateRoot = canonicalizePath(mkdtempSync(join(root, 'private-')));
  const source = join(root, 'source.ts');
  const evaluation = join(root, 'evaluations.json');
  const credential = join(root, 'credential-canary');
  writeFileSync(source, 'source-canary');
  writeFileSync(evaluation, 'evaluation-canary');
  writeFileSync(credential, 'credential-canary');
  const archive = join(root, 'archive');
  mkdirSync(archive, { mode: 0o700 });
  const rawEvents = join(archive, 'native-cli-events.jsonl');
  writeFileSync(rawEvents, 'opaque-native-stream-canary', { mode: 0o600 });
  const sandbox = createNativeMacReviewerSandbox(privateRoot, [
    source,
    evaluation,
    credential,
    archive,
    resolve(import.meta.dir, '..'),
  ]);
  cleanups.push(sandbox.cleanup);
  const env = {
    PATH: '/usr/bin:/bin',
    HOME: privateRoot,
    USERPROFILE: privateRoot,
    CLAUDE_CONFIG_DIR: privateRoot,
    CLAUDE_CODE_TMPDIR: join(privateRoot, 'temp'),
    TMPDIR: privateRoot,
    TMP: privateRoot,
    TEMP: privateRoot,
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
  };
  return { root, privateRoot, source, evaluation, credential, archive, rawEvents, sandbox, env };
}

const kernelTest = isMac() && existsSync('/usr/bin/sandbox-exec') ? test : test.skip;
kernelTest(
  'actual macOS kernel denies source/evaluation/credential reads and writes while permitting private runtime work',
  () => {
    const control = setup();
    const expected = new Map([
      [control.source, 'source-canary'],
      [control.evaluation, 'evaluation-canary'],
      [control.credential, 'credential-canary'],
      [control.rawEvents, 'opaque-native-stream-canary'],
    ]);
    const symlink = join(control.privateRoot, 'escape');
    symlinkSync(control.credential, symlink);
    for (const [path, value] of expected) {
      const read = control.sandbox.command('/bin/cat', [path]);
      const result = spawnSync(read.binary, read.args, {
        cwd: control.privateRoot,
        env: control.env,
        encoding: 'utf8',
        timeout: 5000,
      });
      expect(result.status).not.toBe(0);
      expect(result.stdout).toBe('');
      const write = control.sandbox.command('/bin/sh', [
        '-c',
        'printf changed > "$1"',
        'control',
        path,
      ]);
      expect(
        spawnSync(write.binary, write.args, {
          cwd: control.privateRoot,
          env: control.env,
          stdio: 'ignore',
          timeout: 5000,
        }).status,
      ).not.toBe(0);
      expect(readFileSync(path, 'utf8')).toBe(value);
    }
    const createArchiveFile = control.sandbox.command('/bin/sh', [
      '-c',
      'printf forbidden > "$1"',
      'control',
      join(control.archive, 'new-file'),
    ]);
    expect(
      spawnSync(createArchiveFile.binary, createArchiveFile.args, {
        cwd: control.privateRoot,
        env: control.env,
        stdio: 'ignore',
        timeout: 5000,
      }).status,
    ).not.toBe(0);
    expect(existsSync(join(control.archive, 'new-file'))).toBe(false);
    const archiveLink = join(control.privateRoot, 'archive-escape');
    symlinkSync(control.rawEvents, archiveLink);
    const archiveRead = control.sandbox.command('/bin/cat', [archiveLink]);
    expect(
      spawnSync(archiveRead.binary, archiveRead.args, {
        cwd: control.privateRoot,
        env: control.env,
        stdio: 'ignore',
        timeout: 5000,
      }).status,
    ).not.toBe(0);
    const readLink = control.sandbox.command('/bin/cat', [symlink]);
    expect(
      spawnSync(readLink.binary, readLink.args, {
        cwd: control.privateRoot,
        env: control.env,
        stdio: 'ignore',
        timeout: 5000,
      }).status,
    ).not.toBe(0);
    const privateFile = join(control.privateRoot, 'allowed');
    const allowed = control.sandbox.command('/bin/sh', [
      '-c',
      'printf runtime-ok > "$1"; cat "$1"',
      'control',
      privateFile,
    ]);
    const result = spawnSync(allowed.binary, allowed.args, {
      cwd: control.privateRoot,
      env: control.env,
      encoding: 'utf8',
      timeout: 5000,
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toBe('runtime-ok');
    expect(readFileSync(privateFile, 'utf8')).toBe('runtime-ok');
    for (const path of [control.source, control.evaluation, control.credential])
      expect(control.sandbox.readDenyRoots.some((root) => isContainedBy(root, path))).toBe(true);
    const command = control.sandbox.command('/usr/bin/true', []);
    expect(control.sandbox.profileSha256).toBe(
      createHash('sha256').update(readFileSync(command.args[1])).digest('hex'),
    );
    expect(command.args[1].startsWith(control.privateRoot + '/')).toBe(false);
    control.sandbox.cleanup();
    expect(existsSync(command.args[1])).toBe(false);
  },
);

kernelTest('sandbox canonicalizes private-home links and refuses private/protected overlap', () => {
  const control = setup();
  const link = join(control.root, 'home-link');
  symlinkSync(control.privateRoot, link);
  const sandbox = createNativeMacReviewerSandbox(link, [control.source]);
  cleanups.push(sandbox.cleanup);
  expect(sandbox.privateRoot).toBe(control.privateRoot);
  expect(() => createNativeMacReviewerSandbox(control.privateRoot, [control.root])).toThrow();
  expect(() =>
    createNativeMacReviewerSandbox(control.privateRoot, [control.privateRoot]),
  ).toThrow();
  expect(() => sandbox.command(control.credential, [])).toThrow();
});

kernelTest(
  'actual saved profile is verified before execution and archival, refusing mutation and links',
  () => {
    const control = setup();
    const command = control.sandbox.command('/usr/bin/true', []);
    const profilePath = command.args[1];
    const original = readFileSync(profilePath);
    expect(control.sandbox.readProfileBytes().equals(original)).toBe(true);
    writeFileSync(profilePath, '(version 1)\n(allow default)');
    expect(() => control.sandbox.readProfileBytes()).toThrow();
    expect(() => control.sandbox.command('/usr/bin/true', [])).toThrow();
    writeFileSync(profilePath, original);
    chmodSync(profilePath, 0o644);
    expect(() => control.sandbox.readProfileBytes()).toThrow();
    chmodSync(profilePath, 0o600);
    const hardlink = profilePath + '.hardlink';
    linkSync(profilePath, hardlink);
    expect(() => control.sandbox.readProfileBytes()).toThrow();
    rmSync(hardlink);
    rmSync(profilePath);
    symlinkSync(control.rawEvents, profilePath);
    expect(() => control.sandbox.readProfileBytes()).toThrow();
  },
);

for (const mutation of ['grow', 'unprotect-parent'] as const)
  kernelTest(
    `actual profile reader rejects concurrent ${mutation} with bounded nonblocking reads`,
    () => {
      const control = setup();
      const profilePath = control.sandbox.command('/usr/bin/true', []).args[1];
      const originalBytes = readFileSync(profilePath);
      const originalOpen = fs.openSync;
      const originalRead = fs.readSync;
      const flags: number[] = [];
      const lengths: number[] = [];
      let changed = false;
      const open = spyOn(fs, 'openSync').mockImplementation(
        (...args: Parameters<typeof fs.openSync>) => {
          if (args[0] === profilePath) flags.push(args[1] as number);
          return originalOpen(...args);
        },
      );
      const read = spyOn(fs, 'readSync').mockImplementation(
        (
          fd: number,
          buffer: NodeJS.ArrayBufferView,
          offsetOrOptions?: number | fs.ReadOptions,
          length?: number,
          position?: fs.ReadPosition | null,
        ) => {
          if (typeof offsetOrOptions === 'number') lengths.push(length!);
          if (!changed) {
            changed = true;
            if (mutation === 'grow') appendFileSync(profilePath, Buffer.alloc(100_000, 32));
            else chmodSync(dirname(profilePath), 0o755);
          }
          return typeof offsetOrOptions === 'number'
            ? originalRead(fd, buffer, offsetOrOptions, length!, position ?? null)
            : originalRead(fd, buffer, offsetOrOptions);
        },
      );
      try {
        expect(() => control.sandbox.readProfileBytes()).toThrow();
        expect(changed).toBe(true);
        expect(lengths[0]).toBe(originalBytes.length + 1);
        expect(Math.max(...lengths)).toBeLessThanOrEqual(originalBytes.length + 1);
        expect(flags).toHaveLength(1);
        expect(flags[0] & constants.O_NOFOLLOW).toBe(constants.O_NOFOLLOW);
        expect(flags[0] & constants.O_NONBLOCK).toBe(constants.O_NONBLOCK);
      } finally {
        read.mockRestore();
        open.mockRestore();
      }
    },
  );

// The execution adapter already supports a pinned binary override. Exercise
// that same binary so host CLI auto-updates cannot silently change this probe.
const nativeReviewerBinary =
  process.env.KORY_NATIVE_REVIEW_BINARY?.trim() || '/opt/homebrew/bin/claude';
const nativeBootstrapTest =
  isMac() && existsSync('/usr/bin/sandbox-exec') && existsSync(nativeReviewerBinary)
    ? test
    : test.skip;
nativeBootstrapTest(
  'actual pinned native CLI bootstraps in kernel stage with no credentials and no tools',
  () => {
    const control = setup();
    const version = control.sandbox.command(nativeReviewerBinary, ['--version']);
    const probe = spawnSync(version.binary, version.args, {
      cwd: control.privateRoot,
      env: control.env,
      encoding: 'utf8',
      timeout: 8000,
      maxBuffer: 8192,
    });
    expect(probe.status).toBe(0);
    expect(probe.stdout.trim()).toBe('2.1.309 (Claude Code)');
    const command = control.sandbox.command(nativeReviewerBinary, [
      '--bare',
      '--restricted',
      '--strict-mcp-config',
      '--disable-slash-commands',
      '--no-session-persistence',
      '--tools',
      '',
      '--system-prompt',
      'Return no output requiring tools.',
      '--model',
      'gpt-6.1-sol',
      '--output-format',
      'stream-json',
      '--verbose',
      '--max-turns',
      '1',
      '--print',
    ]);
    const result = spawnSync(command.binary, command.args, {
      cwd: control.privateRoot,
      env: control.env,
      input: 'Public credential-free native bootstrap control.',
      encoding: 'utf8',
      timeout: 12000,
      maxBuffer: 65536,
    });
    expect(result.status).toBe(1);
    const events = result.stdout
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => strictJson(line) as Record<string, unknown>);
    const init = events.filter((event) => event.type === 'system' && event.subtype === 'init');
    expect(init).toHaveLength(1);
    for (const key of ['tools', 'mcp_servers', 'skills']) expect(init[0][key]).toEqual([]);
    const completion = events.filter((event) => event.type === 'result');
    expect(completion).toHaveLength(1);
    expect(completion[0].is_error).toBe(true);
    expect(completion[0].result).toBe('Not logged in · Please run /login');
  },
);
