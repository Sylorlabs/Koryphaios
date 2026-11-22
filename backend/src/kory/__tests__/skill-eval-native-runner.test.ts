import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import * as childProcess from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as platform from '../../runtime/platform';
import { writeFixtureFile } from '../../eval/skills/skill-eval-fixture-helpers';
import {
  nativeFixturePreflight,
  probeNativeModes,
  scoreNativeFixture,
  type NativeFixture,
} from '../../eval/skills/skill-eval-native-runner';

const envKeys = [
  'DEVELOPER_DIR',
  'SDKROOT',
  'OPENAI_API_KEY',
  'DYLD_INSERT_LIBRARIES',
  'CPATH',
  'CXXFLAGS',
  'ASAN_OPTIONS',
  'TSAN_OPTIONS',
  'PATH',
] as const;
const savedEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
const roots: string[] = [];
const restorers: Array<() => void> = [];
afterEach(() => {
  for (const restore of restorers.splice(0)) restore();
  for (const key of envKeys) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function setup() {
  const root = mkdtempSync(join(tmpdir(), 'kory-native-toolchain-test-'));
  roots.push(root);
  const developerDir = join(root, 'Xcode with spaces.app', 'Contents', 'Developer');
  const sdkRoot = join(root, 'MacOSX.sdk');
  mkdirSync(developerDir, { recursive: true });
  mkdirSync(sdkRoot);
  const mac = spyOn(platform, 'isMac').mockReturnValue(true);
  const spawn = spyOn(childProcess, 'spawnSync').mockImplementation(
    () =>
      ({
        status: 0,
        signal: null,
        stdout: 'test clang',
        stderr: '',
      }) as never,
  );
  restorers.push(
    () => spawn.mockRestore(),
    () => mac.mockRestore(),
  );
  delete process.env.DEVELOPER_DIR;
  delete process.env.SDKROOT;
  return { root, developerDir, sdkRoot, spawn, mac };
}

describe('native evaluator caller-selected toolchain', () => {
  test('scoped Xcode and SDK selections reach compiler probes only; ambient secrets stay stripped', () => {
    const { developerDir, sdkRoot, spawn } = setup();
    process.env.DEVELOPER_DIR = developerDir;
    process.env.SDKROOT = sdkRoot;
    process.env.OPENAI_API_KEY = 'test-secret-must-not-be-forwarded';
    process.env.DYLD_INSERT_LIBRARIES = '/untrusted/injected.dylib';
    process.env.CPATH = '/untrusted/headers';
    process.env.CXXFLAGS = '-include /untrusted/header';
    process.env.ASAN_OPTIONS = 'halt_on_error=0';
    process.env.TSAN_OPTIONS = 'halt_on_error=0';
    const result = probeNativeModes('cpp', ['optimized', 'address-undefined', 'thread']);
    expect(result.reasons).toEqual([]);
    expect(result.runs).toHaveLength(7);
    for (const [index, record] of result.runs.entries()) {
      const env = (spawn.mock.calls[index]![2] as childProcess.SpawnSyncOptions).env!;
      if (record.phase.startsWith('preflight-run-')) {
        expect(env.DEVELOPER_DIR).toBeUndefined();
        expect(env.SDKROOT).toBeUndefined();
      } else {
        expect(record.command.slice(0, 4)).toEqual([
          '/usr/bin/xcrun',
          '--sdk',
          platform.canonicalizePath(sdkRoot),
          'clang++',
        ]);
        expect(env.DEVELOPER_DIR).toBe(platform.canonicalizePath(developerDir));
        expect(env.SDKROOT).toBe(platform.canonicalizePath(sdkRoot));
      }
      for (const key of ['OPENAI_API_KEY', 'DYLD_INSERT_LIBRARIES', 'CPATH', 'CXXFLAGS'])
        expect(env[key]).toBeUndefined();
      expect(env.HOME).toBe(env.TMPDIR);
      expect(env.ASAN_OPTIONS).toBe('halt_on_error=1:abort_on_error=0:detect_leaks=0');
      expect(env.TSAN_OPTIONS).toBe('halt_on_error=1:exitcode=66');
    }
  });

  test('explicit options override ambient selection and accept canonical directory aliases', () => {
    const { root, developerDir, sdkRoot } = setup();
    const alias = join(root, 'sdk-alias');
    symlinkSync(sdkRoot, alias, platform.directoryLinkType());
    process.env.DEVELOPER_DIR = 'invalid ambient developer';
    process.env.SDKROOT = 'invalid ambient sdk';
    const result = probeNativeModes('c', [], { developerDir, sdkRoot: alias });
    expect(result.reasons).toEqual([]);
    expect(result.runs[0]!.command).toEqual([
      '/usr/bin/xcrun',
      '--sdk',
      platform.canonicalizePath(sdkRoot),
      'clang',
      '--version',
    ]);
    expect(probeNativeModes('c', [], {}).runs[0]!.command).toEqual(['clang', '--version']);
  });

  test('developer-only and SDK-only selections use xcrun without guessing an Xcode location', () => {
    const { developerDir, sdkRoot } = setup();
    expect(probeNativeModes('c', [], { developerDir }).runs[0]!.command).toEqual([
      '/usr/bin/xcrun',
      '--sdk',
      'macosx',
      'clang',
      '--version',
    ]);
    expect(probeNativeModes('c', [], { sdkRoot }).runs[0]!.command).toEqual([
      '/usr/bin/xcrun',
      '--sdk',
      platform.canonicalizePath(sdkRoot),
      'clang',
      '--version',
    ]);
  });

  test('invalid absolute-directory selections fail readiness before spawning or falling back', () => {
    const { root, spawn } = setup();
    const file = join(root, 'not-a-directory');
    writeFileSync(file, 'not an SDK');
    for (const key of ['developerDir', 'sdkRoot'] as const) {
      for (const value of [
        '',
        'relative/path',
        'macosx',
        '--sdk=macosx',
        join(root, 'missing'),
        file,
        `${root}\n`,
        `${root}\0`,
      ]) {
        const result = probeNativeModes('c', ['optimized'], { [key]: value });
        expect(result.reasons.join('\n')).toContain(
          key === 'developerDir' ? 'DEVELOPER_DIR' : 'SDKROOT',
        );
        expect(result.runs).toEqual([]);
      }
    }
    expect(spawn).not.toHaveBeenCalled();
  });

  test('non-macOS defaults still use PATH clang and reject Xcode selections', () => {
    const { developerDir, spawn, mac } = setup();
    mac.mockReturnValue(false);
    expect(probeNativeModes('cpp', []).runs[0]!.command).toEqual(['clang++', '--version']);
    spawn.mockClear();
    const selected = probeNativeModes('cpp', [], { developerDir });
    expect(selected.reasons.join('\n')).toContain('macOS');
    expect(spawn).not.toHaveBeenCalled();
  });

  test('invalid caller configuration blocks readiness and scoring without claiming candidate tampering', () => {
    const { root, spawn } = setup();
    process.env.SDKROOT = 'relative/sdk';
    const fixture: NativeFixture = {
      id: 'invalid-toolchain-control',
      language: 'c',
      modes: ['optimized'],
      fixedFiles: {},
      initialSources: {},
      harness: () => '',
      reportPath: 'report.json',
    };
    expect(nativeFixturePreflight(fixture).reasons.join('\n')).toContain('SDKROOT');
    const score = scoreNativeFixture(root, fixture);
    expect(score.passed).toBe(false);
    expect(score.integrityFailure).toBe(false);
    expect(score.evidence.join('\n')).toContain('SDKROOT');
    expect(spawn).not.toHaveBeenCalled();
  });

  test('an unavailable selected compiler fails closed instead of retrying PATH clang', () => {
    const { developerDir, spawn } = setup();
    spawn.mockImplementation(
      () =>
        ({
          status: 1,
          signal: null,
          stdout: '',
          stderr: 'test invalid developer directory',
        }) as never,
    );
    const result = probeNativeModes('c', ['optimized'], { developerDir });
    expect(result.reasons.join('\n')).toContain('test invalid developer directory');
    expect(result.runs[0]!.command[0]).toBe('/usr/bin/xcrun');
    expect(spawn).toHaveBeenCalledTimes(1);
  });

  for (const language of ['c', 'cpp'] as const) {
    test(`${language}: absent compiler retains an unavailable version diagnostic`, () => {
      const { spawn } = setup();
      const command = language === 'c' ? 'clang' : 'clang++';
      spawn.mockImplementation(
        () =>
          ({
            status: null,
            signal: null,
            stdout: '',
            stderr: '',
            error: new Error(`spawnSync ${command} ENOENT`),
          }) as never,
      );
      const result = probeNativeModes(language, ['optimized']);
      expect(result.version).toBe(`${command} is unavailable: spawnSync ${command} ENOENT`);
      expect(result.reasons).toEqual([result.version]);
      expect(result.runs[0]!.error).toContain('ENOENT');
      expect(spawn).toHaveBeenCalledTimes(1);
    });

    test(`${language}: cached compiler failure cannot mask source or regression symlinks`, () => {
      const { root, spawn } = setup();
      // Exercise the unavailable-toolchain path; this never fabricates a successful native run.
      process.env.PATH = root;
      spawn.mockImplementation(
        () => ({ status: 1, signal: null, stdout: '', stderr: 'test unavailable SDK' }) as never,
      );
      const source = `src/control.${language}`;
      const regression = `tests/regression.${language}`;
      const text = 'int main(void) { return 0; }\n';
      const fixture: NativeFixture = {
        id: `unavailable-${language}-integrity-control`,
        language,
        modes: ['optimized'],
        fixedFiles: {},
        initialSources: { [source]: text },
        harness: () => '',
        reportPath: 'report.json',
      };
      writeFixtureFile(root, source, text);
      writeFixtureFile(root, regression, text);
      const unavailable = scoreNativeFixture(root, fixture);
      expect(unavailable.passed).toBe(false);
      expect(unavailable.integrityFailure).toBe(false);
      expect(unavailable.verification).toBe(0);
      expect(unavailable.evidence.join('\n')).toContain('test unavailable SDK');
      expect(spawn).toHaveBeenCalledTimes(1);
      spawn.mockClear();

      const outside = join(root, 'outside.txt');
      writeFileSync(outside, text);
      for (const path of [source, regression]) {
        rmSync(join(root, path));
        symlinkSync(outside, join(root, path));
        const tampered = scoreNativeFixture(root, fixture);
        expect(tampered.passed).toBe(false);
        expect(tampered.integrityFailure).toBe(true);
        expect(tampered.verification).toBe(0);
        expect(readFileSync(outside, 'utf8')).toBe(text);
        rmSync(join(root, path));
        writeFixtureFile(root, path, text);
      }
      rmSync(join(root, regression));
      const missing = scoreNativeFixture(root, fixture);
      expect(missing.passed).toBe(false);
      expect(missing.integrityFailure).toBe(false);
      expect(missing.evidence).toContain(`Missing candidate regression coverage: ${regression}`);
      expect(spawn).not.toHaveBeenCalled();
    });
  }

  test('preflight cache separates default, selected developer and selected SDK including failures', () => {
    const { root, developerDir, sdkRoot, spawn } = setup();
    const otherSdk = join(root, 'other.sdk');
    mkdirSync(otherSdk);
    const fixture = { language: 'cpp', modes: ['thread'] } as const;
    // Keep mocked preflights isolated from real compiler probes in other tests.
    process.env.PATH = root;
    process.env.SDKROOT = sdkRoot;
    spawn.mockImplementation(
      () => ({ status: 1, signal: null, stdout: '', stderr: 'test unavailable' }) as never,
    );
    const failed = nativeFixturePreflight(fixture);
    expect(failed.reasons.length).toBeGreaterThan(0);
    expect(nativeFixturePreflight(fixture)).toBe(failed);
    const calls = spawn.mock.calls.length;
    spawn.mockImplementation(
      () => ({ status: 0, signal: null, stdout: 'test clang', stderr: '' }) as never,
    );
    process.env.DEVELOPER_DIR = developerDir;
    const selected = nativeFixturePreflight(fixture);
    expect(selected.reasons).toEqual([]);
    expect(spawn.mock.calls.length).toBeGreaterThan(calls);
    expect(nativeFixturePreflight(fixture)).toBe(selected);
    process.env.SDKROOT = otherSdk;
    expect(nativeFixturePreflight(fixture)).not.toBe(selected);
    delete process.env.DEVELOPER_DIR;
    delete process.env.SDKROOT;
    const unselected = nativeFixturePreflight(fixture);
    expect(unselected.runs[0]!.command).toEqual(['clang++', '--version']);
    expect(unselected).not.toBe(selected);
  });
});
