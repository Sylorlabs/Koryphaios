// Tests for scripts/install/install.sh. Run with: bun test scripts/install/install.test.ts
//
// The macOS flow is exercised with stub uname/curl/hdiutil/ditto/xattr/open/osascript
// on PATH, so nothing touches the real /Applications, the network, or a disk image.
import { afterAll, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const installDir = resolve(dirname(fileURLToPath(import.meta.url)));
const installScript = join(installDir, 'install.sh');
const effectiveUrl = 'https://downloads.example.test/releases/Koryphaios-test-arm64.dmg';
const payloadText = 'fake-dmg-bytes';

const STUBS: Record<string, string> = {
  uname: `#!/bin/sh
case "$1" in
  -s) echo "\${KORY_TEST_UNAME_S:-Darwin}" ;;
  -m) echo "\${KORY_TEST_UNAME_M:-arm64}" ;;
esac
`,
  curl: `#!/bin/sh
out=""; url=""; prev=""; want_effective=0
for arg in "$@"; do
  [ "$prev" = "-o" ] && out="$arg"
  [ "$prev" = "-w" ] && want_effective=1
  case "$arg" in https://*) url="$arg" ;; esac
  prev="$arg"
done
echo "curl $url" >> "$KORY_TEST_CALLS"
case "$url" in
  *.sha256)
    if [ -n "\${KORY_TEST_SHA256_FILE:-}" ] && [ -f "$KORY_TEST_SHA256_FILE" ]; then
      cp "$KORY_TEST_SHA256_FILE" "$out"; exit 0
    fi
    exit 22 ;;
esac
cp "$KORY_TEST_PAYLOAD" "$out" || exit 23
if [ "$want_effective" = 1 ]; then printf '%s' "$KORY_TEST_EFFECTIVE_URL"; fi
`,
  hdiutil: `#!/bin/sh
echo "hdiutil $*" >> "$KORY_TEST_CALLS"
case "$1" in
  attach)
    mp=""; prev=""
    for arg in "$@"; do [ "$prev" = "-mountpoint" ] && mp="$arg"; prev="$arg"; done
    mkdir -p "$mp/Koryphaios.app/Contents"
    printf 'plist' > "$mp/Koryphaios.app/Contents/Info.plist"
    ;;
  detach)
    for arg in "$@"; do mp="$arg"; done
    rm -rf "$mp"
    ;;
esac
`,
  ditto: `#!/bin/sh
echo "ditto $*" >> "$KORY_TEST_CALLS"
cp -R "$1" "$2"
`,
  xattr: `#!/bin/sh
echo "xattr $*" >> "$KORY_TEST_CALLS"
`,
  open: `#!/bin/sh
echo "open $*" >> "$KORY_TEST_CALLS"
`,
  osascript: `#!/bin/sh
script=""
for arg in "$@"; do script="$arg"; done
case "$script" in
  *"is running"*)
    if [ -f "$KORY_TEST_RUNNING_FLAG" ]; then echo true; else echo false; fi
    echo "osascript is-running" >> "$KORY_TEST_CALLS" ;;
  *"to quit"*)
    rm -f "$KORY_TEST_RUNNING_FLAG"
    echo "osascript quit" >> "$KORY_TEST_CALLS" ;;
esac
`,
};

type Sandbox = {
  root: string;
  bin: string;
  home: string;
  calls: string;
  payload: string;
  runningFlag: string;
  applications: string;
  noTty: string;
};

function makeSandbox(): Sandbox {
  const root = mkdtempSync(join(tmpdir(), 'kory-install-test-'));
  const bin = join(root, 'bin');
  const home = join(root, 'home');
  mkdirSync(bin, { recursive: true });
  mkdirSync(join(root, 'tmp'), { recursive: true });
  mkdirSync(home, { recursive: true });
  for (const [name, body] of Object.entries(STUBS)) {
    const path = join(bin, name);
    writeFileSync(path, body);
    chmodSync(path, 0o755);
  }
  const payload = join(root, 'payload');
  writeFileSync(payload, payloadText);
  const calls = join(root, 'calls.log');
  writeFileSync(calls, '');
  return {
    root,
    bin,
    home,
    calls,
    payload,
    runningFlag: join(root, 'running.flag'),
    applications: join(root, 'Applications'),
    noTty: join(root, 'no-tty'),
  };
}

type RunOptions = {
  uname?: { s: string; m: string };
  running?: boolean;
  tty?: string;
  sha256?: string;
  assumeYes?: boolean;
  applicationsDir?: string;
};

function runInstaller(sandbox: Sandbox, options: RunOptions = {}) {
  mkdirSync(sandbox.applications, { recursive: true });
  if (options.running) writeFileSync(sandbox.runningFlag, '1');
  let sha256File: string | undefined;
  if (options.sha256 !== undefined) {
    sha256File = join(sandbox.root, 'expected.sha256');
    writeFileSync(sha256File, options.sha256);
  }
  const env: Record<string, string> = {
    PATH: `${sandbox.bin}:${process.env.PATH ?? '/usr/bin:/bin'}`,
    HOME: sandbox.home,
    TMPDIR: join(sandbox.root, 'tmp'),
    KORYPHAIOS_DOWNLOAD_BASE: 'https://koryphaios.test/api/download',
    KORYPHAIOS_APPLICATIONS_DIR: options.applicationsDir ?? sandbox.applications,
    KORYPHAIOS_INSTALL_TTY: options.tty ?? sandbox.noTty,
    KORY_TEST_CALLS: sandbox.calls,
    KORY_TEST_PAYLOAD: sandbox.payload,
    KORY_TEST_EFFECTIVE_URL: effectiveUrl,
    KORY_TEST_RUNNING_FLAG: sandbox.runningFlag,
    KORY_TEST_UNAME_S: options.uname?.s ?? 'Darwin',
    KORY_TEST_UNAME_M: options.uname?.m ?? 'arm64',
  };
  if (sha256File) env.KORY_TEST_SHA256_FILE = sha256File;
  if (options.assumeYes) env.KORYPHAIOS_INSTALL_ASSUME_YES = '1';
  const result = spawnSync('/bin/sh', [installScript], { env, encoding: 'utf8' });
  const log = readFileSync(sandbox.calls, 'utf8')
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) =>
      line
        .replaceAll(`${sandbox.root}/tmp/`, '')
        .replace(/koryphaios-install\.[A-Za-z0-9]+/g, '<work>')
        .replaceAll(sandbox.root, '<root>'),
    );
  return { status: result.status, stdout: result.stdout, stderr: result.stderr, log };
}

const cleanups: string[] = [];
function sandbox(): Sandbox {
  const s = makeSandbox();
  cleanups.push(s.root);
  return s;
}

describe('install.sh static checks', () => {
  test('parses under bash and POSIX sh', () => {
    expect(spawnSync('bash', ['-n', installScript]).status).toBe(0);
    expect(spawnSync('sh', ['-n', installScript]).status).toBe(0);
  });

  test.skipIf(Bun.which('shellcheck') === null)('passes shellcheck', () => {
    const result = spawnSync('shellcheck', ['-s', 'sh', installScript], { encoding: 'utf8' });
    expect(result.stdout + result.stderr).toBe('');
    expect(result.status).toBe(0);
  });
});

describe('install.sh on macOS (stubbed toolchain)', () => {
  test('downloads, attaches, copies, detaches, strips quarantine from the installed app only, then opens', () => {
    const s = sandbox();
    const dest = join(s.applications, 'Koryphaios.app');
    const run = runInstaller(s);

    expect(run.status).toBe(0);
    expect(run.log).toEqual([
      'curl https://koryphaios.test/api/download/macos-arm64',
      `curl ${effectiveUrl}.sha256`,
      'hdiutil attach -nobrowse -readonly -noautoopen -mountpoint <work>/mount <work>/Koryphaios-macos-arm64.dmg',
      'osascript is-running',
      'ditto <work>/mount/Koryphaios.app <root>/Applications/.Koryphaios.app.installing',
      'hdiutil detach -quiet <work>/mount',
      'xattr -dr com.apple.quarantine <root>/Applications/Koryphaios.app',
      'open <root>/Applications/Koryphaios.app',
    ]);
    expect(existsSync(join(dest, 'Contents', 'Info.plist'))).toBe(true);
    expect(existsSync(join(s.applications, '.Koryphaios.app.installing'))).toBe(false);
  });

  test('quarantine is never stripped from the mounted image, the download, or anything but the install', () => {
    const s = sandbox();
    const run = runInstaller(s);
    const xattrLines = run.log.filter((line) => line.startsWith('xattr '));
    expect(xattrLines).toHaveLength(1);
    expect(xattrLines[0]).toBe('xattr -dr com.apple.quarantine <root>/Applications/Koryphaios.app');
    expect(xattrLines.join('\n')).not.toContain('<work>');
  });

  test('selects the x64 DMG on Intel Macs', () => {
    const s = sandbox();
    const run = runInstaller(s, { uname: { s: 'Darwin', m: 'x86_64' } });
    expect(run.status).toBe(0);
    expect(run.log[0]).toBe('curl https://koryphaios.test/api/download/macos-x64');
  });

  test('verifies a published SHA-256 before touching anything else', () => {
    const s = sandbox();
    const digest = createHash('sha256').update(payloadText).digest('hex');
    const run = runInstaller(s, { sha256: `${digest}  Koryphaios.dmg\n` });
    expect(run.status).toBe(0);
    expect(run.stdout).toContain('SHA-256 verified.');
    expect(run.log.some((line) => line.startsWith('ditto '))).toBe(true);
    expect(run.log.some((line) => line.startsWith('open '))).toBe(true);
  });

  test('a checksum mismatch stops the install before the disk image is mounted', () => {
    const s = sandbox();
    const run = runInstaller(s, { sha256: '0'.repeat(64) });
    expect(run.status).not.toBe(0);
    expect(run.stderr).toContain('checksum mismatch');
    expect(run.log.some((line) => line.startsWith('hdiutil attach'))).toBe(false);
    expect(run.log.some((line) => line.startsWith('ditto '))).toBe(false);
    expect(existsSync(join(s.applications, 'Koryphaios.app'))).toBe(false);
  });

  test('a running app is quit (after consent) before the copy', () => {
    const s = sandbox();
    writeFileSync(join(s.root, 'answer-yes'), 'y\n');
    const run = runInstaller(s, { running: true, tty: join(s.root, 'answer-yes') });
    expect(run.status).toBe(0);
    const quitAt = run.log.indexOf('osascript quit');
    const copyAt = run.log.findIndex((line) => line.startsWith('ditto '));
    expect(quitAt).toBeGreaterThan(-1);
    expect(quitAt).toBeLessThan(copyAt);
    expect(run.stdout + run.stderr).toContain('Koryphaios is running');
  });

  test('a running app with no terminal to ask on fails clearly and changes nothing', () => {
    const s = sandbox();
    const run = runInstaller(s, { running: true });
    expect(run.status).not.toBe(0);
    expect(run.stderr).toContain('Koryphaios is running');
    expect(run.log.some((line) => line.startsWith('ditto '))).toBe(false);
    expect(run.log.some((line) => line.startsWith('osascript quit'))).toBe(false);
  });

  test('declining the quit prompt cancels without copying', () => {
    const s = sandbox();
    writeFileSync(join(s.root, 'answer-no'), 'n\n');
    const run = runInstaller(s, { running: true, tty: join(s.root, 'answer-no') });
    expect(run.status).not.toBe(0);
    expect(run.stderr).toContain('cancelled');
    expect(run.log.some((line) => line.startsWith('ditto '))).toBe(false);
  });

  test('KORYPHAIOS_INSTALL_ASSUME_YES accepts the quit prompt without a terminal', () => {
    const s = sandbox();
    const run = runInstaller(s, { running: true, assumeYes: true });
    expect(run.status).toBe(0);
    expect(run.log).toContain('osascript quit');
  });

  const canWriteAnywhereRegardless = process.getuid?.() === 0;
  test.skipIf(canWriteAnywhereRegardless)(
    'falls back to ~/Applications without sudo when /Applications is not writable and no terminal can confirm',
    () => {
      const s = sandbox();
      const locked = join(s.root, 'LockedApplications');
      mkdirSync(locked);
      chmodSync(locked, 0o555);
      try {
        const run = runInstaller(s, { applicationsDir: locked });
        expect(run.status).toBe(0);
        const fallback = join(s.home, 'Applications', 'Koryphaios.app');
        expect(run.log).toContain('open <root>/home/Applications/Koryphaios.app');
        expect(fallback.startsWith(s.root)).toBe(true);
        expect(run.log.some((line) => line.includes('sudo'))).toBe(false);
        expect(statSync(fallback).isDirectory()).toBe(true);
      } finally {
        chmodSync(locked, 0o755);
      }
    },
  );

  test('a missing application in the image is reported, not silently skipped', () => {
    const s = sandbox();
    // Replace the hdiutil stub with one that mounts an image lacking Koryphaios.app.
    const emptyDmgBin = join(s.bin, 'hdiutil');
    writeFileSync(
      emptyDmgBin,
      `#!/bin/sh
echo "hdiutil $*" >> "$KORY_TEST_CALLS"
mp=""; prev=""; last=""
for arg in "$@"; do [ "$prev" = "-mountpoint" ] && mp="$arg"; prev="$arg"; last="$arg"; done
case "$1" in
  attach) mkdir -p "$mp/empty" ;;
  detach) rm -rf "$last" ;;
esac
`,
    );
    chmodSync(emptyDmgBin, 0o755);
    const run = runInstaller(s);
    expect(run.status).not.toBe(0);
    expect(run.stderr).toContain('does not contain Koryphaios.app');
    expect(run.log.some((line) => line.startsWith('xattr '))).toBe(false);
    expect(run.log.some((line) => line.startsWith('open '))).toBe(false);
  });
});

describe('install.sh on Linux (stubbed toolchain)', () => {
  test('installs the AppImage binary and writes a desktop launcher entry', () => {
    const s = sandbox();
    const xdgBin = join(s.root, 'xdg-bin');
    const xdgData = join(s.root, 'xdg-data');
    const result = spawnSync('/bin/sh', [installScript], {
      env: {
        PATH: `${s.bin}:${process.env.PATH ?? '/usr/bin:/bin'}`,
        HOME: s.home,
        TMPDIR: join(s.root, 'tmp'),
        XDG_BIN_HOME: xdgBin,
        XDG_DATA_HOME: xdgData,
        KORYPHAIOS_DOWNLOAD_BASE: 'https://koryphaios.test/api/download',
        KORYPHAIOS_INSTALL_TTY: s.noTty,
        KORY_TEST_CALLS: s.calls,
        KORY_TEST_PAYLOAD: s.payload,
        KORY_TEST_EFFECTIVE_URL: effectiveUrl,
        KORY_TEST_RUNNING_FLAG: s.runningFlag,
        KORY_TEST_UNAME_S: 'Linux',
        KORY_TEST_UNAME_M: 'x86_64',
      },
      encoding: 'utf8',
    });
    expect(result.status).toBe(0);
    const binary = join(xdgBin, 'koryphaios');
    expect(readFileSync(binary, 'utf8')).toBe(payloadText);
    expect(statSync(binary).mode & 0o111).not.toBe(0);
    const desktop = readFileSync(join(xdgData, 'applications', 'koryphaios.desktop'), 'utf8');
    expect(desktop).toContain('[Desktop Entry]');
    expect(desktop).toContain('Name=Koryphaios');
    expect(desktop).toContain(`Exec="${binary}"`);
    expect(readFileSync(s.calls, 'utf8')).not.toContain('hdiutil');
  });

  test('unsupported architectures fail with a clear message', () => {
    const s = sandbox();
    const run = runInstaller(s, { uname: { s: 'Linux', m: 'riscv64' } });
    expect(run.status).not.toBe(0);
    expect(run.stderr).toContain('does not have a Linux riscv64 build');
  });
});

afterAll(() => {
  for (const root of cleanups) rmSync(root, { recursive: true, force: true });
});
