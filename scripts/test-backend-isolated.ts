#!/usr/bin/env bun
/**
 * Cross-platform isolated backend test runner.
 *
 * Each test file runs in its own Bun process with a fresh SQLite database so
 * state from a previous file cannot leak into the next one (notes aliases and
 * FTS rows made this especially visible). Keeping the databases in one
 * temporary directory also lets SQLite create its WAL/SHM sidecars safely.
 * Watch and aggregate-coverage commands use --single-process, but still run
 * against one disposable database instead of the application database.
 *
 * Replaces the bash-only `test-backend-isolated.sh` so `bun run test:core`
 * works on macOS, Windows, and Linux without requiring bash.
 *
 * Isolated runtime setup: explicitly prefix a focused invocation with
 * BUN_INSTALL_CACHE_DIR, PLAYWRIGHT_BROWSERS_PATH, DEVELOPER_DIR, SDKROOT, and, when
 * real local Docker fixtures are intended, KORY_DOCKER_HOST. Relative paths
 * resolve from the caller's cwd; shell-expand home paths before invoking this
 * script. Unset selectors stay unset (no host HOME lookup); invalid asset
 * directories and Docker sockets fail before launch. Native iOS simulator
 * selections may be forwarded via KORY_IOS_EVAL_IPHONE_UDID and
 * KORY_IOS_EVAL_IPAD_UDID, each validated before launching tests. Explicit
 * KORY_IOS_EVAL_NATIVE_TESTS=1 opts into real XCUITest control runs.
 * PLAYWRIGHT_BROWSERS_PATH=0 is unsupported: supply an existing browser
 * directory instead. HOME, XDG roots, credentials, and temp remain disposable.
 */

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  readdirSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { canonicalizePath } from '../backend/src/runtime/platform';

const PROJECT_ROOT = join(import.meta.dir, '..');
const BACKEND_DIR = join(PROJECT_ROOT, 'backend');
const BACKEND_TEST_TIMEOUT_MS = 60_000;
/** A file slower than this is called out so slow tiers stay visible. */
const SLOW_FILE_WARN_MS = 30_000;
const LIVE_PROVIDER_TEST_FLAG = 'KORY_RUN_LIVE_PROVIDER_TESTS';
const ASSET_DIRECTORY_ENV = [
  'BUN_INSTALL_CACHE_DIR',
  'PLAYWRIGHT_BROWSERS_PATH',
  'DEVELOPER_DIR',
  'SDKROOT',
] as const;
const DOCKER_HOST_SELECTOR = 'KORY_DOCKER_HOST';
const IOS_DEVICE_SELECTORS = ['KORY_IOS_EVAL_IPHONE_UDID', 'KORY_IOS_EVAL_IPAD_UDID'] as const;
const IOS_NATIVE_TESTS_FLAG = 'KORY_IOS_EVAL_NATIVE_TESTS';
const IOS_SIMULATOR_UDID = /^[A-Fa-f0-9]{8}(?:-[A-Fa-f0-9]{4}){3}-[A-Fa-f0-9]{12}$/u;
const SAFE_HOST_ENV = new Set([
  'PATH',
  'PATHEXT',
  'SystemRoot',
  'SYSTEMROOT',
  'WINDIR',
  'COMSPEC',
  'SHELL',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'TZ',
  'CI',
  'TERM',
  'COLORTERM',
  'FORCE_COLOR',
  'NO_COLOR',
]);

/** Build the environment used by the default core gate. Closed-transport is
 * the default: ambient provider secrets, endpoints, CLI accounts, and live
 * opt-ins never cross into a test process. A live provider run requires the
 * explicit KORY_RUN_LIVE_PROVIDER_TESTS=1 boundary and is not part of core. */
export function createIsolatedTestEnvironment(
  source: NodeJS.ProcessEnv,
  isolatedHome: string,
): Record<string, string | undefined> {
  const allowLiveProviders = source[LIVE_PROVIDER_TEST_FLAG] === '1';
  const env: Record<string, string | undefined> = {};

  if (allowLiveProviders) {
    Object.assign(env, source);
  } else {
    for (const name of SAFE_HOST_ENV) {
      if (source[name] !== undefined) {
        env[name] = source[name];
      }
    }
    for (const name of ASSET_DIRECTORY_ENV) {
      const value = source[name];
      if (!Object.prototype.hasOwnProperty.call(source, name) || value === undefined) continue;
      if (name === 'PLAYWRIGHT_BROWSERS_PATH' && value === '0') {
        throw new Error(
          'PLAYWRIGHT_BROWSERS_PATH=0 (hermetic mode) is not supported by the isolated runner; supply an existing browser directory instead.',
        );
      }
      const invalidPath = `${name} must name an existing directory; shell-expand home paths before invoking the isolated runner.`;
      if (!value.trim() || /[\x00-\x1f\x7f]/.test(value)) throw new Error(invalidPath);
      try {
        // Freeze caller-relative paths before runBackendTests changes cwd.
        const directory = canonicalizePath(resolve(value));
        if (!statSync(directory).isDirectory()) throw new Error(invalidPath);
        if (
          name === 'SDKROOT' &&
          (!/^MacOSX.*\.sdk$/u.test(basename(directory)) ||
            !existsSync(join(directory, 'SDKSettings.json')))
        ) {
          throw new Error(invalidPath);
        }
        env[name] = directory;
      } catch {
        // Never silently fall back to HOME/default assets after a bad selector.
        throw new Error(invalidPath);
      }
    }
    for (const name of IOS_DEVICE_SELECTORS) {
      const value = source[name];
      if (value === undefined) continue;
      if (!IOS_SIMULATOR_UDID.test(value)) {
        throw new Error(`${name} must be a valid explicit simulator UDID`);
      }
      env[name] = value;
    }
    const nativeIOSSelection = source[IOS_NATIVE_TESTS_FLAG];
    if (nativeIOSSelection !== undefined) {
      if (nativeIOSSelection !== '0' && nativeIOSSelection !== '1') {
        throw new Error('KORY_IOS_EVAL_NATIVE_TESTS must be 0 or 1');
      }
      env[IOS_NATIVE_TESTS_FLAG] = nativeIOSSelection;
    }
    const dockerHost = source[DOCKER_HOST_SELECTOR];
    if (dockerHost !== undefined) {
      const invalidDockerHost =
        'KORY_DOCKER_HOST must name an existing local Unix socket using unix://; shell-expand paths before invoking the isolated runner.';
      if (!dockerHost.trim() || /[\x00-\x1f\x7f\s]/.test(dockerHost)) {
        throw new Error(invalidDockerHost);
      }
      const prefix = 'unix://';
      if (!dockerHost.startsWith(prefix)) throw new Error(invalidDockerHost);
      try {
        // macOS realpath cannot canonicalize a live Unix socket (EOPNOTSUPP),
        // so validate the resolved lexical path and let Docker open the socket.
        const socketPath = resolve(dockerHost.slice(prefix.length));
        if (!statSync(socketPath).isSocket()) throw new Error(invalidDockerHost);
        env.DOCKER_HOST = `${prefix}${socketPath}`;
      } catch {
        throw new Error(invalidDockerHost);
      }
    }
    env[LIVE_PROVIDER_TEST_FLAG] = '0';
    env.KORY_LIVE_PROVIDER_TESTS = '0';
    env.KORY_LIVE_CLAUDE = '0';
    env.KORY_DISABLE_CLI_AUTODETECT = '1';
    env.AWS_EC2_METADATA_DISABLED = 'true';
    env.HOME = isolatedHome;
    env.USER = 'kory-test';
    env.USERNAME = 'kory-test';
    env.LOGNAME = 'kory-test';
    env.USERPROFILE = isolatedHome;
    env.TMPDIR = join(isolatedHome, 'tmp');
    env.TEMP = join(isolatedHome, 'tmp');
    env.TMP = join(isolatedHome, 'tmp');
    env.XDG_CONFIG_HOME = join(isolatedHome, '.config');
    env.XDG_DATA_HOME = join(isolatedHome, '.local', 'share');
    env.XDG_CACHE_HOME = join(isolatedHome, '.cache');
    env.APPDATA = join(isolatedHome, 'AppData', 'Roaming');
    env.LOCALAPPDATA = join(isolatedHome, 'AppData', 'Local');
    env.KORYPHAIOS_DATA_DIR = join(isolatedHome, '.koryphaios');
    env.KORYPHAIOS_SKILLS_HOME = join(isolatedHome, '.koryphaios', 'skills');
    env.KORYPHAIOS_WORKFLOWS_HOME = join(isolatedHome, '.koryphaios', 'workflows');
    env.PROJECT_ROOT = join(isolatedHome, 'project');
    env.LOG_DIR = join(isolatedHome, '.koryphaios', 'logs');
  }

  env.NODE_ENV = 'test';
  env.SESSION_TOKEN_SECRET = 'test_only_not_for_production_aaaaaaaaaa';
  env.KORYPHAIOS_KMS_PASSPHRASE = 'test_only_kms_passphrase_not_for_production';
  return env;
}

function gatherTestFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      gatherTestFiles(full, acc);
    } else if (entry.endsWith('.test.ts')) {
      acc.push(full);
    }
  }
  return acc;
}

function runBackendTests(
  env: Record<string, string | undefined>,
  databaseUrl: string,
  testArguments: string[],
  testTargets: string[],
) {
  // Capture per-file output instead of inheriting it: a flake is only
  // actionable if the failing file's assertion detail survives the scroll past
  // hundreds of files. The caller echoes it and persists it on failure.
  const result = spawnSync(
    process.execPath,
    [
      '--no-env-file',
      'test',
      '--timeout',
      String(BACKEND_TEST_TIMEOUT_MS),
      '--preload',
      './backend/src/__tests__/setup-db.ts',
      ...testArguments,
      ...testTargets,
    ],
    {
      cwd: PROJECT_ROOT,
      env: { ...env, DATABASE_URL: databaseUrl },
      stdio: ['inherit', 'pipe', 'pipe'],
      maxBuffer: 64 * 1024 * 1024,
    },
  );
  return {
    status: result.status ?? 1,
    output: `${result.stdout?.toString() ?? ''}${result.stderr?.toString() ?? ''}`,
  };
}

/** Explicit file selection keeps focused runs on the same database/credential
 * boundary as CI. Bare Bun path filters must not be appended to every file. */
export function parseTestSelection(args: string[], root = PROJECT_ROOT) {
  const files: string[] = [];
  const runnerArguments: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] !== '--file') {
      runnerArguments.push(args[i]);
      continue;
    }
    const value = args[++i];
    if (!value || value.startsWith('-')) throw new Error('--file requires a backend test path');
    const path = resolve(root, value);
    const backendRelative = relative(join(root, 'backend'), path);
    if (
      isAbsolute(backendRelative) ||
      backendRelative.startsWith(`..${sep}`) ||
      backendRelative === '..' ||
      !path.endsWith('.test.ts')
    ) {
      throw new Error('--file must name a .test.ts file inside backend');
    }
    if (!statSync(path).isFile()) throw new Error(`Not a test file: ${value}`);
    if (!files.includes(path)) files.push(path);
  }
  return { files, runnerArguments };
}

function main() {
  const { files: selectedFiles, runnerArguments } = parseTestSelection(process.argv.slice(2));
  const singleProcess = runnerArguments.includes('--single-process');
  const testArguments = runnerArguments.filter((argument) => argument !== '--single-process');
  const testDbDir = mkdtempSync(join(tmpdir(), 'kory-test-'));
  const testHome = join(testDbDir, 'home');
  let exitCode = 0;

  try {
    mkdirSync(join(testHome, 'tmp'), { recursive: true });
    mkdirSync(join(testHome, 'project'), { recursive: true });
    const env = createIsolatedTestEnvironment(process.env, testHome);
    if (singleProcess) {
      console.log('Testing backend in one process with a disposable database');
      const result = runBackendTests(
        env,
        `sqlite:${join(testDbDir, 'db', 'suite.db')}`,
        testArguments,
        selectedFiles.length ? selectedFiles : [BACKEND_DIR],
      );
      process.stdout.write(result.output);
      exitCode = result.status;
      process.exitCode = exitCode;
      return;
    }

    const searchRoots = [
      join(BACKEND_DIR, '__tests__'),
      join(BACKEND_DIR, 'src'),
      join(BACKEND_DIR, 'test'),
    ];

    const testFiles: string[] = [...selectedFiles];
    for (const root of selectedFiles.length ? [] : searchRoots) {
      try {
        gatherTestFiles(root, testFiles);
      } catch {
        // directory may not exist
      }
    }

    // Sort for deterministic ordering (matches `sort -z` in the old bash script).
    testFiles.sort();

    if (testFiles.length === 0) throw new Error('No backend tests selected');
    const failedFiles: string[] = [];
    const durations: Array<{ display: string; ms: number }> = [];
    const failureLogDir = join(PROJECT_ROOT, 'backend', '.test-logs');
    let testIndex = 0;
    for (const testFile of testFiles) {
      testIndex++;
      const display = relative(PROJECT_ROOT, testFile).split(sep).join('/');
      const startedAt = Date.now();
      console.log(`Testing ${display}`);
      const dbUrl = `sqlite:${join(testDbDir, 'db', `${testIndex}.db`)}`;

      const result = runBackendTests(env, dbUrl, testArguments, [testFile]);
      const elapsedMs = Date.now() - startedAt;
      durations.push({ display, ms: elapsedMs });
      process.stdout.write(result.output);
      if (elapsedMs > SLOW_FILE_WARN_MS) {
        console.log(`  (slow: ${(elapsedMs / 1000).toFixed(1)}s)`);
      }

      if (result.status !== 0) {
        failedFiles.push(display);
        exitCode = result.status;
        // Persist the assertion detail. Without this a flake is reported by
        // filename only, which is not enough to tell a timeout apart from a
        // real regression the next time it happens.
        mkdirSync(failureLogDir, { recursive: true });
        const logPath = join(failureLogDir, `${display.replaceAll('/', '__')}.log`);
        writeFileSync(
          logPath,
          `command: bun test ${testArguments.join(' ')} ${testFile}\nelapsed: ${elapsedMs}ms\nexit: ${result.status}\n\n${result.output}`,
        );
        console.error(`  failure log: ${relative(PROJECT_ROOT, logPath).split(sep).join('/')}`);
        // Keep going so the user sees all failures, not just the first.
      }
    }

    console.log(
      `Backend files: ${testFiles.length - failedFiles.length} passed, ${failedFiles.length} failed`,
    );
    const slowest = [...durations].sort((a, b) => b.ms - a.ms).slice(0, 5);
    console.log(
      `Slowest files: ${slowest.map((entry) => `${entry.display} (${(entry.ms / 1000).toFixed(1)}s)`).join(', ')}`,
    );
    if (failedFiles.length > 0) {
      console.error(`\nBackend test files failed (${failedFiles.length}):`);
      for (const file of failedFiles) console.error(`  - ${file}`);
    } else {
      console.log(`\nAll ${testFiles.length} backend test files passed.`);
    }
  } finally {
    rmSync(testDbDir, { recursive: true, force: true });
  }

  process.exit(exitCode);
}

if (import.meta.main) main();
