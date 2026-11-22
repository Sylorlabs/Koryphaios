import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { lstatSync, mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import type { SkillEvalDeterministicScore } from './skill-eval-execution';
import { readFixtureText, writeFixtureFile } from './skill-eval-fixture-helpers';
import { canonicalizePath, hostOS, isMac } from '../../runtime/platform';

export interface NativeFixture {
  id: string;
  language: 'c' | 'cpp';
  fixedFiles: Readonly<Record<string, string>>;
  initialSources: Readonly<Record<string, string>>;
  modes: readonly NativeMode[];
  harness: (receipt: string) => string;
  reportPath: string;
}

export type NativeMode = 'optimized' | 'address-undefined' | 'thread';
/** Caller-owned macOS selection, never taken from candidate fixture files. */
export interface NativeToolchain {
  developerDir?: string;
  sdkRoot?: string;
}

// Only these two caller-selected environment values may enter compiler processes.
// Passing an explicit object (including {}) overrides the environment selection.
const callerToolchain = (): NativeToolchain => ({
  developerDir: process.env.DEVELOPER_DIR,
  sdkRoot: process.env.SDKROOT,
});

function resolveToolchain(selection: NativeToolchain): NativeToolchain {
  const directory = (name: string, value: string | undefined): string | undefined => {
    if (value === undefined) return undefined;
    if (typeof value !== 'string' || !isAbsolute(value) || /[\x00-\x1f\x7f]/u.test(value))
      throw new Error(`${name} must be an absolute directory path without control characters`);
    try {
      const path = canonicalizePath(value);
      if (!statSync(path).isDirectory()) throw new Error('not a directory');
      return path;
    } catch {
      throw new Error(`${name} must name an existing directory`);
    }
  };
  const developerDir = directory('DEVELOPER_DIR', selection.developerDir);
  const sdkRoot = directory('SDKROOT', selection.sdkRoot);
  if ((developerDir !== undefined || sdkRoot !== undefined) && !isMac())
    throw new Error('DEVELOPER_DIR/SDKROOT native toolchain selection requires macOS');
  return { developerDir, sdkRoot };
}

interface NativePreflight {
  reasons: string[];
  version: string;
  runs: NativeRun[];
}

const invalidToolchain = (error: unknown): NativePreflight => ({
  reasons: [error instanceof Error ? error.message : String(error)],
  version: 'Native toolchain unavailable',
  runs: [],
});

export interface NativeRun {
  phase: string;
  command: string[];
  status: number | null;
  signal: string | null;
  output: string;
  error?: string;
  durationMs: number;
}

const modeFlags = (mode: NativeMode): string[] =>
  mode === 'optimized'
    ? ['-O2']
    : [
        '-O1',
        '-g',
        '-fno-omit-frame-pointer',
        '-fno-sanitize-recover=all',
        mode === 'thread' ? '-fsanitize=thread' : '-fsanitize=address,undefined',
      ];
const compiler = (language: NativeFixture['language']) => (language === 'c' ? 'clang' : 'clang++');
const compilerCommand = (
  language: NativeFixture['language'],
  toolchain: NativeToolchain,
): string[] =>
  toolchain.developerDir !== undefined || toolchain.sdkRoot !== undefined
    ? ['/usr/bin/xcrun', '--sdk', toolchain.sdkRoot ?? 'macosx', compiler(language)]
    : [compiler(language)];
const extension = (language: NativeFixture['language']) => (language === 'c' ? 'c' : 'cpp');
const environment = (root: string): NodeJS.ProcessEnv => ({
  PATH: process.env.PATH ?? '',
  HOME: root,
  TMPDIR: root,
  TEMP: root,
  TMP: root,
  LANG: 'C',
  NO_COLOR: '1',
  TERM: 'dumb',
  ASAN_OPTIONS: 'halt_on_error=1:abort_on_error=0:detect_leaks=0',
  UBSAN_OPTIONS: 'halt_on_error=1:print_stacktrace=1',
  TSAN_OPTIONS: 'halt_on_error=1:exitcode=66',
});

function run(
  root: string,
  phase: string,
  command: string[],
  timeout = 8_000,
  toolchain: NativeToolchain = {},
): NativeRun {
  const started = Date.now();
  const result = spawnSync(command[0]!, command.slice(1), {
    cwd: root,
    env: {
      ...environment(root),
      ...(toolchain.developerDir !== undefined ? { DEVELOPER_DIR: toolchain.developerDir } : {}),
      ...(toolchain.sdkRoot !== undefined ? { SDKROOT: toolchain.sdkRoot } : {}),
    },
    encoding: 'utf8',
    timeout,
    killSignal: 'SIGKILL',
    maxBuffer: 1_000_000,
  });
  return {
    phase,
    command,
    status: result.status,
    signal: result.signal,
    output: `${result.stdout ?? ''}\n${result.stderr ?? ''}`.trim().slice(-12_000),
    ...(result.error ? { error: result.error.message } : {}),
    durationMs: Date.now() - started,
  };
}
const successful = (record: NativeRun) => !record.error && record.status === 0 && !record.signal;
const hash = (text: string) => createHash('sha256').update(text).digest('hex');

/** Probe installed compilers and actual sanitizer startup, not just a version banner. */
export function probeNativeModes(
  language: NativeFixture['language'],
  modes: readonly NativeMode[],
  selection: NativeToolchain = callerToolchain(),
): NativePreflight {
  let toolchain: NativeToolchain;
  try {
    toolchain = resolveToolchain(selection);
  } catch (error) {
    return invalidToolchain(error);
  }
  const command = compilerCommand(language, toolchain);
  const root = mkdtempSync(join(tmpdir(), 'kory-native-preflight-'));
  const runs: NativeRun[] = [];
  const reasons: string[] = [];
  try {
    const version = run(root, 'compiler-version', [...command, '--version'], 3_000, toolchain);
    runs.push(version);
    if (!successful(version)) {
      const diagnostic = `${compiler(language)} is unavailable: ${version.error ?? (version.output || version.signal || `exit ${version.status}`)}`;
      return {
        reasons: [diagnostic],
        version: diagnostic,
        runs,
      };
    }
    writeFixtureFile(
      root,
      `probe.${extension(language)}`,
      language === 'c'
        ? 'int main(void) { return 0; }\n'
        : '#include <thread>\nint main() { std::thread worker([] {}); worker.join(); }\n',
    );
    for (const mode of modes) {
      const target = join(root, `probe-${mode}`);
      const build = run(
        root,
        `preflight-build-${mode}`,
        [
          ...command,
          language === 'c' ? '-std=c11' : '-std=c++20',
          '-pthread',
          ...modeFlags(mode),
          `probe.${extension(language)}`,
          '-o',
          target,
        ],
        20_000,
        toolchain,
      );
      runs.push(build);
      if (!successful(build)) {
        reasons.push(
          `${language} ${mode} compiler support unavailable: ${build.error ?? build.output}`,
        );
        continue;
      }
      const execution = run(root, `preflight-run-${mode}`, [target]);
      runs.push(execution);
      if (!successful(execution))
        reasons.push(
          `${language} ${mode} runtime unavailable: ${execution.error ?? execution.output}`,
        );
    }
    return { reasons, version: version.output, runs };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const preflights = new Map<string, NativePreflight>();
export function nativeFixturePreflight(
  fixture: Pick<NativeFixture, 'language' | 'modes'>,
  selection: NativeToolchain = callerToolchain(),
) {
  let toolchain: NativeToolchain;
  try {
    toolchain = resolveToolchain(selection);
  } catch (error) {
    return invalidToolchain(error);
  }
  const key = JSON.stringify([
    hostOS(),
    process.arch,
    process.env.PATH,
    toolchain.developerDir,
    toolchain.sdkRoot,
    fixture.language,
    fixture.modes,
  ]);
  let result = preflights.get(key);
  if (!result) {
    result = probeNativeModes(fixture.language, fixture.modes, toolchain);
    preflights.set(key, result);
  }
  return result;
}

function candidateFiles(root: string, language: NativeFixture['language']): Record<string, string> {
  const files: Record<string, string> = {};
  let totalBytes = 0;
  const walk = (relative: string, depth: number) => {
    const stat = lstatSync(join(root, relative));
    if (stat.isSymbolicLink()) throw new Error('Native candidate sources must not be symlinks');
    if (stat.isDirectory()) {
      if (depth > 4) throw new Error('Native candidate source tree is too deep');
      const names = readdirSync(join(root, relative)).sort();
      if (names.length > 32) throw new Error('Native candidate source tree has too many entries');
      for (const name of names) walk(`${relative}/${name}`, depth + 1);
    } else if (
      stat.isFile() &&
      new RegExp(`\\.(?:${extension(language)}|h|hpp)$`, 'u').test(relative)
    ) {
      const text = readFixtureText(root, relative);
      totalBytes += Buffer.byteLength(text);
      if (Object.keys(files).length >= 32 || totalBytes > 500_000)
        throw new Error('Native candidate source budget exceeded');
      files[relative] = text;
    } else throw new Error(`Unsupported native candidate source: ${relative}`);
  };
  walk('src', 0);
  if (!Object.keys(files).some((path) => path.endsWith(`.${extension(language)}`)))
    throw new Error('Native candidate translation unit is missing');
  return files;
}

function unchanged(root: string, files: Readonly<Record<string, string>>): boolean {
  try {
    return Object.entries(files).every(([path, text]) => readFixtureText(root, path) === text);
  } catch {
    return false;
  }
}

function compileProgram(
  root: string,
  fixture: NativeFixture,
  mode: NativeMode,
  sources: Record<string, string>,
  testSource: string,
  receipt: string,
  runs: NativeRun[],
  phase: string,
  toolchain: NativeToolchain,
): NativeRun | null {
  const command = compilerCommand(fixture.language, toolchain);
  for (const [path, text] of Object.entries(sources)) writeFixtureFile(root, path, text);
  const harnessPath = `harness.${extension(fixture.language)}`;
  writeFixtureFile(root, harnessPath, testSource);
  const args = [
    fixture.language === 'c' ? '-std=c11' : '-std=c++20',
    '-pthread',
    '-Wall',
    '-Wextra',
    '-Werror',
    '-pedantic',
    ...modeFlags(mode),
    '-Iinclude',
    '-Isrc',
  ];
  // Compile the evaluator independently so candidate macros cannot disable its assertions.
  const units = [
    ...Object.keys(sources).filter((path) => path.endsWith(`.${extension(fixture.language)}`)),
    harnessPath,
  ];
  const objects: string[] = [];
  for (const [index, unit] of units.entries()) {
    const object = `unit-${index}.o`;
    const result = run(
      root,
      `${phase}-compile-${index}`,
      [...command, ...args, '-c', unit, '-o', object],
      20_000,
      toolchain,
    );
    runs.push(result);
    if (!successful(result)) return null;
    objects.push(object);
  }
  const executable = join(root, 'native-evaluation');
  const link = run(
    root,
    `${phase}-link`,
    [...command, '-pthread', ...modeFlags(mode), ...objects, '-o', executable],
    20_000,
    toolchain,
  );
  runs.push(link);
  if (!successful(link)) return null;
  const result = run(root, `${phase}-run`, [executable, receipt]);
  runs.push(result);
  return result;
}

/** Clean copies and sanitized environments are not an adversarial OS sandbox. */
export function scoreNativeFixture(
  root: string,
  fixture: NativeFixture,
  selection: NativeToolchain = callerToolchain(),
): SkillEvalDeterministicScore {
  const runs: NativeRun[] = [];
  const fail = (message: string, integrityFailure = false): SkillEvalDeterministicScore => ({
    passed: false,
    quality: 0,
    verification: 0,
    integrityFailure,
    evidence: [
      message,
      ...runs
        .slice(-3)
        .map((record) => `${record.phase}: ${record.error ?? record.output ?? record.status}`),
    ],
  });
  if (!unchanged(root, fixture.fixedFiles))
    return fail(
      'Fixed native contract or public example was changed, omitted, or replaced with a symlink.',
      true,
    );
  let toolchain: NativeToolchain;
  try {
    toolchain = resolveToolchain(selection);
  } catch (error) {
    return fail(invalidToolchain(error).reasons.join('\n'));
  }
  let sources: Record<string, string>;
  let regression: string;
  try {
    sources = candidateFiles(root, fixture.language);
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error), true);
  }
  try {
    regression = readFixtureText(root, `tests/regression.${extension(fixture.language)}`);
  } catch (error) {
    // This file is a candidate deliverable, not part of the immutable evaluator.
    // Only absence is ordinary missing coverage; unsafe paths still fail integrity.
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return fail(
        `Missing candidate regression coverage: tests/regression.${extension(fixture.language)}`,
      );
    }
    return fail(error instanceof Error ? error.message : String(error), true);
  }
  // Filesystem integrity does not depend on compiler readiness. A missing SDK
  // or cached failed probe must not mask unsafe candidate sources or regressions.
  const preflight = nativeFixturePreflight(fixture, toolchain);
  if (preflight.reasons.length) return fail(preflight.reasons.join('\n'));
  const ownedFiles = {
    ...fixture.fixedFiles,
    ...sources,
    [`tests/regression.${extension(fixture.language)}`]: regression,
  };
  const sourceFingerprint = hash(JSON.stringify(sources));
  const buildRoots: string[] = [];
  const checks: Array<{ mode: string; passed: boolean }> = [];
  let tampered = false;
  try {
    for (const mode of fixture.modes) {
      const build = mkdtempSync(join(tmpdir(), 'kory-native-eval-'));
      buildRoots.push(build);
      for (const [path, text] of Object.entries(fixture.fixedFiles))
        writeFixtureFile(build, path, text);
      const receipt = `KORY_NATIVE_${randomUUID().replaceAll('-', '')}`;
      const hidden = fixture.harness(receipt);
      const result = compileProgram(
        build,
        fixture,
        mode,
        sources,
        hidden,
        receipt,
        runs,
        mode,
        toolchain,
      );
      const passed =
        !!result &&
        successful(result) &&
        result.output.split(/\r?\n/u).filter(Boolean).at(-1) === receipt;
      tampered ||= !unchanged(build, {
        ...fixture.fixedFiles,
        ...sources,
        [`harness.${extension(fixture.language)}`]: hidden,
      });
      checks.push({ mode, passed });
    }
    // Public regression code must pass against the candidate and actually reject
    // the original defect. A test file containing only a success claim cannot pass.
    for (const [variant, program] of [
      ['candidate', sources],
      ['broken', fixture.initialSources],
    ] as const) {
      const build = mkdtempSync(join(tmpdir(), 'kory-native-regression-'));
      buildRoots.push(build);
      for (const [path, text] of Object.entries(fixture.fixedFiles))
        writeFixtureFile(build, path, text);
      const result = compileProgram(
        build,
        fixture,
        'address-undefined',
        program,
        regression,
        '',
        runs,
        `regression-${variant}`,
        toolchain,
      );
      const executed = !!result && !result.error && result.signal === null;
      checks.push({
        mode: `regression-${variant}`,
        passed: executed && (variant === 'candidate' ? successful(result) : result.status !== 0),
      });
      tampered ||= !unchanged(build, {
        ...fixture.fixedFiles,
        ...program,
        [`harness.${extension(fixture.language)}`]: regression,
      });
    }
    tampered ||= !unchanged(root, ownedFiles);
    const passed = !tampered && checks.every((check) => check.passed);
    const report = {
      schemaVersion: 1,
      scenarioId: fixture.id,
      evidenceKind: 'actual-local-native-runtime',
      language: fixture.language,
      compiler: preflight.version,
      toolchain,
      platform: hostOS(),
      architecture: process.arch,
      sourceFingerprint,
      fixedFingerprint: hash(JSON.stringify(fixture.fixedFiles)),
      checks,
      integrityFailure: tampered,
      runs,
      limitations: [
        'Sanitizers cover executed paths, not absence of all undefined behavior or races.',
        'C frame-size overflow exercises explicit 32-bit arithmetic on the current host, not a native 32-bit binary.',
        'Object release checks use weak ownership and destructor counts; a general heap-leak detector is not claimed.',
        'Candidate workspaces and build copies are not a hostile-code OS sandbox.',
        'Deterministic reference controls do not establish live-model skill uplift or independent semantic quality.',
      ],
    };
    writeFixtureFile(root, fixture.reportPath, `${JSON.stringify(report, null, 2)}\n`);
    return {
      passed,
      quality: passed ? 1 : 0,
      verification: passed ? 1 : 0,
      integrityFailure: tampered,
      evidence: [
        fixture.reportPath,
        `Source SHA-256: ${sourceFingerprint}`,
        ...checks.map((check) => `${check.mode}: ${check.passed ? 'pass' : 'fail'}`),
        ...runs
          .filter((record) => !successful(record))
          .map((record) => `${record.phase}: ${record.output.slice(-2_000)}`),
      ],
    };
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error), true);
  } finally {
    for (const path of buildRoots) rmSync(path, { recursive: true, force: true });
  }
}
