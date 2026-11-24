import { afterAll, describe, expect, it } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import {
  executableSuffixes,
  findExecutableOnPath,
  findOnPath,
  javaToolchainExecutables,
  openssl3ExecutableCandidates,
  hasHardLinks,
  hasUnexpectedMode,
  hasUnexpectedOwner,
  isContainedBy,
  directoryLinkType,
  windowsPathToWsl,
  isMac,
  isUnix,
  isWindows,
  looksLikePath,
} from '../platform';

const original = process.platform;

/**
 * Run `body` as if the host were `platform`. Every helper in this module reads
 * `process.platform` at call time precisely so a test can exercise the branch for
 * an OS it is not running on.
 */
function asHost(platform: NodeJS.Platform, body: () => void): void {
  Object.defineProperty(process, 'platform', { value: platform, configurable: true });
  try {
    body();
  } finally {
    Object.defineProperty(process, 'platform', { value: original, configurable: true });
  }
}

describe('host predicates', () => {
  it('resolves each supported OS to exactly one branch', () => {
    asHost('darwin', () => {
      expect(isMac()).toBe(true);
      expect(isWindows()).toBe(false);
      expect(isUnix()).toBe(true);
    });
    asHost('linux', () => {
      expect(isMac()).toBe(false);
      expect(isWindows()).toBe(false);
      expect(isUnix()).toBe(true);
    });
    asHost('win32', () => {
      expect(isWindows()).toBe(true);
      expect(isUnix()).toBe(false);
    });
  });
});

describe('executable lookup', () => {
  it('tries the Windows binary and script suffixes only on Windows', () => {
    asHost('win32', () => expect(executableSuffixes()).toEqual(['', '.exe', '.cmd', '.bat']));
    asHost('linux', () => expect(executableSuffixes()).toEqual(['']));
    asHost('darwin', () => expect(executableSuffixes()).toEqual(['']));
  });

  it('treats a backslash as a path separator only on Windows', () => {
    asHost('win32', () => expect(looksLikePath('C:\\tools\\git')).toBe(true));
    asHost('linux', () => expect(looksLikePath('C:\\tools\\git')).toBe(false));
    for (const platform of ['linux', 'darwin', 'win32'] as const) {
      asHost(platform, () => expect(looksLikePath('usr/bin/git')).toBe(true));
    }
  });

  const root = mkdtempSync(join(tmpdir(), 'kory-platform-'));
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it('finds a bare binary on a Unix PATH', () => {
    const bin = join(root, 'kory-probe');
    writeFileSync(bin, '#!/bin/sh\n');
    chmodSync(bin, 0o755);
    asHost('linux', () => {
      expect(findOnPath('kory-probe', root)).toBe(bin);
      expect(findOnPath('kory-missing', root)).toBeNull();
    });
  });

  it('resolves a Windows extension that the bare name does not have', () => {
    writeFileSync(join(root, 'kory-ext.exe'), '');
    asHost('win32', () => expect(findOnPath('kory-ext', root)).toBe(join(root, 'kory-ext.exe')));
    // The same name has no bare or .exe candidate to find on a Unix PATH shape.
    asHost('linux', () => expect(findOnPath('kory-ext', root)).toBeNull());
  });

  it('rejects a non-executable file when the execute bit is required', () => {
    writeFileSync(join(root, 'kory-inert'), '');
    chmodSync(join(root, 'kory-inert'), 0o600);
    asHost('linux', () => {
      expect(findExecutableOnPath('kory-inert', root)).toBeNull();
      expect(findExecutableOnPath('kory-probe', root)).toBe(join(root, 'kory-probe'));
    });
  });

  it('returns null for an empty PATH instead of scanning the process cwd', () => {
    expect(findOnPath('kory-probe', '')).toBeNull();
    expect(findOnPath('', root)).toBeNull();
  });

  it('pairs compiler and runtime from the explicit JDK without trusting a PATH launcher', () => {
    const home = join(root, 'selected-jdk');
    const bin = join(home, 'bin');
    mkdirSync(bin, { recursive: true });
    for (const file of ['java', 'javac']) {
      const executable = join(bin, file);
      writeFileSync(executable, '#!/bin/sh\nexit 0\n');
      chmodSync(executable, 0o755);
    }
    const oldHome = process.env.KORY_SKILL_EVAL_JAVA_HOME;
    const oldPath = process.env.PATH;
    try {
      process.env.KORY_SKILL_EVAL_JAVA_HOME = home;
      process.env.PATH = '/nonexistent';
      asHost('darwin', () =>
        expect(javaToolchainExecutables()).toEqual({
          javac: join(bin, 'javac'),
          java: join(bin, 'java'),
        }),
      );
    } finally {
      if (oldHome === undefined) delete process.env.KORY_SKILL_EVAL_JAVA_HOME;
      else process.env.KORY_SKILL_EVAL_JAVA_HOME = oldHome;
      if (oldPath === undefined) delete process.env.PATH;
      else process.env.PATH = oldPath;
    }
  });

  it('respects the sole explicitly selected OpenSSL3 executable', () => {
    const previous = process.env.KORY_EVAL_OPENSSL3;
    try {
      process.env.KORY_EVAL_OPENSSL3 = '/chosen/openssl3';
      asHost('darwin', () => expect(openssl3ExecutableCandidates()).toEqual(['/chosen/openssl3']));
      asHost('linux', () => expect(openssl3ExecutableCandidates()).toEqual(['/chosen/openssl3']));
    } finally {
      if (previous === undefined) delete process.env.KORY_EVAL_OPENSSL3;
      else process.env.KORY_EVAL_OPENSSL3 = previous;
    }
  });
});

describe('path containment', () => {
  it('accepts the root itself and its descendants', () => {
    asHost('linux', () => {
      const root = '/srv/koryphaios';
      expect(isContainedBy(root, root)).toBe(true);
      expect(isContainedBy(root, `${root}${sep}projects`)).toBe(true);
      expect(isContainedBy(root, `${root}${sep}projects${sep}app`)).toBe(true);
    });
  });

  it('rejects a sibling that merely shares a name prefix', () => {
    asHost('linux', () =>
      expect(isContainedBy('/srv/koryphaios', '/srv/koryphaios-backup')).toBe(false),
    );
  });

  it('rejects a traversal out of the root', () => {
    // Only the host's own separator is exercised here: `path.relative` is bound
    // to the running OS, so the Windows spelling is covered when this suite runs
    // on Windows rather than by stubbing the platform.
    const root = isWindows() ? 'C:\\srv\\koryphaios' : '/srv/koryphaios';
    const escaped = isWindows() ? 'C:\\srv\\koryphaios\\..\\secrets' : '/srv/koryphaios/../secrets';
    expect(isContainedBy(root, escaped)).toBe(false);
    expect(isContainedBy(root, isWindows() ? 'C:\\srv' : '/srv')).toBe(false);
  });
});

describe('POSIX permission predicates', () => {
  it('reports a foreign owner only where the OS records ownership', () => {
    const owned = { uid: 501, nlink: 1, mode: 0o100600 };
    const foreign = { ...owned, uid: 502 };
    asHost('linux', () => {
      expect(hasUnexpectedOwner(owned, 501)).toBe(false);
      expect(hasUnexpectedOwner(foreign, 501)).toBe(true);
    });
    asHost('win32', () => expect(hasUnexpectedOwner(foreign, 501)).toBe(false));
  });

  it('reports hard links and loose modes only where the OS records them', () => {
    asHost('linux', () => {
      expect(hasHardLinks({ uid: 0, nlink: 1, mode: 0o100600 })).toBe(false);
      expect(hasHardLinks({ uid: 0, nlink: 2, mode: 0o100600 })).toBe(true);
      expect(hasUnexpectedMode({ uid: 0, nlink: 1, mode: 0o100644 }, 0o600)).toBe(true);
      expect(hasUnexpectedMode({ uid: 0, nlink: 1, mode: 0o100600 }, 0o600)).toBe(false);
    });
    asHost('win32', () => {
      expect(hasHardLinks({ uid: 0, nlink: 2, mode: 0o777 })).toBe(false);
      expect(hasUnexpectedMode({ uid: 0, nlink: 1, mode: 0o777 }, 0o600)).toBe(false);
    });
  });
});

describe('staged directory link type', () => {
  it('asks for a junction on Windows, where a privileged dir link is refused', () => {
    asHost('win32', () => expect(directoryLinkType()).toBe('junction'));
    asHost('linux', () => expect(directoryLinkType()).toBe('dir'));
    asHost('darwin', () => expect(directoryLinkType()).toBe('dir'));
  });
});

describe('Windows paths in the WSL sandbox', () => {
  it('translates a drive path into the distribution mount the child will see', () => {
    expect(windowsPathToWsl('C:\\work\\app')).toBe('/mnt/c/work/app');
    expect(windowsPathToWsl('D:\\')).toBe('/mnt/d');
    expect(windowsPathToWsl('c:/work/app/')).toBe('/mnt/c/work/app');
  });

  it('refuses a path the distribution does not see at the same place', () => {
    // A guessed mount would confine the child to a directory the user never
    // approved, so an untranslatable grant must abort the launch instead.
    expect(windowsPathToWsl('\\\\server\\share\\app')).toBeNull();
    expect(windowsPathToWsl('\\\\?\\C:\\work')).toBeNull();
    expect(windowsPathToWsl('relative\\path')).toBeNull();
  });
});
