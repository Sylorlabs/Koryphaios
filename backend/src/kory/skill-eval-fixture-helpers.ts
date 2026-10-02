import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';

const MAX_FIXTURE_TEXT_BYTES = 2_000_000;

/** Validate all components beneath the evaluator-owned root before touching a file. */
function fixturePath(root: string, path: string, createParents = false): string {
  if (
    isAbsolute(path) ||
    path.split(/[\\/]/u).some((part) => !part || part === '.' || part === '..')
  ) {
    throw new Error('Fixture paths must stay inside the fixture root');
  }
  let parent = resolve(root);
  if (createParents && !existsSync(parent)) mkdirSync(parent, { recursive: true, mode: 0o700 });
  const parts = path.split(/[\\/]/u);
  for (let index = 0; index < parts.length; index++) {
    const stat = lstatSync(parent);
    if (!stat.isDirectory() || stat.isSymbolicLink())
      throw new Error('Fixture parent must be a non-symlink directory');
    const next = join(parent, parts[index]!);
    if (index === parts.length - 1) return next;
    if (createParents && !existsSync(next)) mkdirSync(next, { mode: 0o700 });
    parent = next;
  }
  throw new Error('Missing fixture path');
}

export function readFixtureText(root: string, path: string): string {
  const absolute = fixturePath(root, path);
  const stat = lstatSync(absolute);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_FIXTURE_TEXT_BYTES)
    throw new Error('Fixture evidence must be a bounded regular file');
  const descriptor = openSync(
    absolute,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0),
  );
  try {
    if (!fstatSync(descriptor).isFile()) throw new Error('Fixture evidence is not a regular file');
    const bytes = Buffer.alloc(MAX_FIXTURE_TEXT_BYTES + 1);
    let offset = 0;
    while (offset < bytes.length) {
      const count = readSync(descriptor, bytes, offset, bytes.length - offset, null);
      if (!count) break;
      offset += count;
    }
    if (offset > MAX_FIXTURE_TEXT_BYTES)
      throw new Error('Fixture evidence exceeds the byte budget');
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, offset));
  } finally {
    closeSync(descriptor);
  }
}

/** Missing, unsafe, or changed immutable inputs fail integrity without a scorer crash. */
export function fixtureTextEquals(root: string, path: string, expected: string): boolean {
  try {
    return readFixtureText(root, path) === expected;
  } catch {
    return false;
  }
}

export function writeFixtureFile(root: string, path: string, content: string): void {
  const absolute = fixturePath(root, path, true);
  if (existsSync(absolute)) {
    const stat = lstatSync(absolute);
    if (!stat.isFile() || stat.isSymbolicLink())
      throw new Error('Fixture output must be a regular non-symlink file');
  }
  const descriptor = openSync(
    absolute,
    constants.O_WRONLY |
      constants.O_CREAT |
      constants.O_TRUNC |
      (constants.O_NOFOLLOW ?? 0) |
      (constants.O_NONBLOCK ?? 0),
    0o600,
  );
  try {
    if (!fstatSync(descriptor).isFile()) throw new Error('Fixture output is not a regular file');
    writeFileSync(descriptor, content);
  } finally {
    closeSync(descriptor);
  }
}

export function packageJson(
  name: string,
  scripts: Record<string, string> = { test: 'bun test' },
): string {
  return `${JSON.stringify(
    {
      name,
      private: true,
      type: 'module',
      scripts,
    },
    null,
    2,
  )}\n`;
}

const TEST_SCAN_MAX_DEPTH = 6;
const TEST_SCAN_MAX_FILES = 100;
const TEST_SCAN_IGNORED_DIRS = new Set([
  '.git',
  '.kory-eval',
  'node_modules',
  'dist',
  'build',
  'coverage',
]);

function testFiles(root: string): string[] {
  try {
    const files: string[] = [];
    const walk = (relativeDirectory: string, depth: number): void => {
      if (depth > TEST_SCAN_MAX_DEPTH) return;
      const absoluteDirectory = relativeDirectory
        ? fixturePath(root, relativeDirectory)
        : resolve(root);
      const directoryStat = lstatSync(absoluteDirectory);
      if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) return;
      for (const name of readdirSync(absoluteDirectory).sort()) {
        const relativePath = relativeDirectory ? `${relativeDirectory}/${name}` : name;
        const absolutePath = fixturePath(root, relativePath);
        const stat = lstatSync(absolutePath);
        if (stat.isSymbolicLink()) continue;
        if (stat.isDirectory()) {
          if (!TEST_SCAN_IGNORED_DIRS.has(name)) walk(relativePath, depth + 1);
          continue;
        }
        if (stat.isFile() && /\.(?:test|spec)\.[cm]?[jt]sx?$/u.test(name)) {
          files.push(relativePath);
          if (files.length > TEST_SCAN_MAX_FILES) {
            throw new Error('Candidate test-file budget exceeded');
          }
        }
      }
    };
    walk('', 0);
    return files;
  } catch {
    return [];
  }
}

export function hasRegressionText(root: string, required: RegExp[]): boolean {
  try {
    const files = testFiles(root);
    if (!files.length) return false;
    const text = files.map((path) => readFixtureText(root, path)).join('\n');
    return required.every((pattern) => {
      pattern.lastIndex = 0;
      return pattern.test(text);
    });
  } catch {
    return false;
  }
}

export function runCandidateBunTests(root: string): {
  completed: boolean;
  passed: boolean;
  evidence: string;
} {
  let privateHome: string | undefined;
  try {
    const publicTests = testFiles(root);
    if (!publicTests.length) {
      return { completed: false, passed: false, evidence: 'Candidate tests are missing.' };
    }
    privateHome = mkdtempSync(join(tmpdir(), 'kory-eval-public-test-home-'));
    const runnerConfig = '[test]\npreload = ["./setup.ts"]\n';
    const runnerSetup = `process.chdir(${JSON.stringify(resolve(root))});\n`;
    writeFixtureFile(privateHome, 'bunfig.toml', runnerConfig);
    writeFixtureFile(privateHome, 'setup.ts', runnerSetup);
    const executionOptions = {
      cwd: privateHome,
      env: {
        PATH: process.env.PATH ?? '',
        HOME: privateHome,
        XDG_CONFIG_HOME: join(privateHome, 'config'),
        XDG_CACHE_HOME: join(privateHome, 'cache'),
        TMPDIR: privateHome,
        TEMP: privateHome,
        TMP: privateHome,
        NO_COLOR: '1',
        TERM: 'dumb',
      },
      encoding: 'utf8' as const,
      timeout: 15_000,
      maxBuffer: 1_000_000,
    };
    const runnerArgs = [
      'test',
      '--no-env-file',
      '--config',
      join(privateHome, 'bunfig.toml'),
      ...publicTests.map((path) => join(resolve(root), path)),
    ];
    const result = spawnSync(process.execPath, runnerArgs, executionOptions);
    const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`.trim();
    const passedTests = [...output.matchAll(/(?:^|\n)\s*(\d+) pass\b/gu)].at(-1)?.[1];
    const failedTests = [...output.matchAll(/(?:^|\n)\s*(\d+) fail\b/gu)].at(-1)?.[1];
    const completed = !result.error && Number(passedTests ?? 0) + Number(failedTests ?? 0) > 0;
    const passed =
      completed && result.status === 0 && Number(passedTests) > 0 && failedTests === '0';
    return {
      completed,
      passed,
      evidence: `Candidate tests: ${completed ? (passed ? 'passed' : 'failed') : 'did not complete'}.\n${output.slice(-2_000) || `bun test exited ${String(result.status)}`}`,
    };
  } catch (error) {
    return {
      completed: false,
      passed: false,
      evidence: `Candidate test execution failure: ${error instanceof Error ? error.message : String(error)}`,
    };
  } finally {
    if (privateHome) rmSync(privateHome, { recursive: true, force: true });
  }
}

export function runHiddenBunTest(
  root: string,
  source: string,
): {
  passed: boolean;
  evidence: string;
} {
  const nonce = randomUUID().replaceAll('-', '');
  const hiddenRelativePath = `tests/__kory_hidden_eval_${nonce}.test.ts`;
  const receipt = `KORY_EVAL_COMPLETED_${nonce}`;
  const ownedSource = `${source}\nimport { afterAll as __koryAfterAll_${nonce} } from 'bun:test';\n__koryAfterAll_${nonce}(() => { process.stdout.write(${JSON.stringify(`${receipt}\n`)}); });\n`;
  let privateHome: string | undefined;
  try {
    writeFixtureFile(root, hiddenRelativePath, ownedSource);
    privateHome = mkdtempSync(join(tmpdir(), 'kory-eval-test-home-'));
    const runnerConfig = '[test]\npreload = ["./setup.ts"]\n';
    const runnerSetup = `process.chdir(${JSON.stringify(resolve(root))});\n`;
    writeFixtureFile(privateHome, 'bunfig.toml', runnerConfig);
    writeFixtureFile(privateHome, 'setup.ts', runnerSetup);
    // This removes ambient credentials/configuration. It is not an OS sandbox:
    // live adversarial evaluation still requires a separately confined executor.
    const executionOptions = {
      // Start outside the candidate tree. Bun merges a cwd bunfig even when
      // --config names another file; changing directory in our own preload
      // retains fixture-relative runtime behavior without executing its config.
      cwd: privateHome,
      env: {
        PATH: process.env.PATH ?? '',
        HOME: privateHome,
        XDG_CONFIG_HOME: join(privateHome, 'config'),
        XDG_CACHE_HOME: join(privateHome, 'cache'),
        TMPDIR: privateHome,
        TEMP: privateHome,
        TMP: privateHome,
        NO_COLOR: '1',
        TERM: 'dumb',
      },
      encoding: 'utf8' as const,
      timeout: 15_000,
      maxBuffer: 1_000_000,
    };
    // Bun 1.3.14 accepts --config before the subcommand but then exits without
    // running tests. Keep the command first and verify completion below.
    const runnerArgs = ['test', '--no-env-file', '--config', join(privateHome, 'bunfig.toml')];
    // Candidate tests cannot preload mocks or terminate the hidden test process.
    // Run both suites, in separate processes, while keeping the original public-test gate.
    const result = spawnSync(
      process.execPath,
      [...runnerArgs, join(resolve(root), hiddenRelativePath)],
      executionOptions,
    );
    const combined = `${result.stdout ?? ''}\n${result.stderr ?? ''}`.trim();
    const publicTests = testFiles(root).filter((path) => path !== hiddenRelativePath);
    const publicResult = publicTests.length
      ? spawnSync(
          process.execPath,
          [...runnerArgs, ...publicTests.map((path) => join(resolve(root), path))],
          executionOptions,
        )
      : null;
    const publicOutput = publicResult
      ? `${publicResult.stdout ?? ''}\n${publicResult.stderr ?? ''}`.trim()
      : '';
    const publicCompleted =
      !publicResult ||
      (!publicResult.error &&
        publicResult.status === 0 &&
        /(?:^|\n)\s*[1-9]\d* pass\b/u.test(publicOutput) &&
        /(?:^|\n)\s*0 fail\b/u.test(publicOutput));
    const unchanged =
      readFixtureText(root, hiddenRelativePath) === ownedSource &&
      readFixtureText(privateHome, 'bunfig.toml') === runnerConfig &&
      readFixtureText(privateHome, 'setup.ts') === runnerSetup;
    const passedTests = [...combined.matchAll(/(?:^|\n)\s*(\d+) pass\b/gu)].at(-1)?.[1];
    const failedTests = [...combined.matchAll(/(?:^|\n)\s*(\d+) fail\b/gu)].at(-1)?.[1];
    const completed = combined.includes(receipt) && Number(passedTests) > 0 && failedTests === '0';
    return {
      passed: !result.error && result.status === 0 && unchanged && completed && publicCompleted,
      evidence: `Evaluator integrity: ${unchanged ? 'unchanged' : 'modified'}. Hidden test completion: ${completed ? 'observed' : 'missing or failed'}. Public tests: ${publicCompleted ? 'passed or absent' : 'failed'}.\n${combined.slice(-3_000) || `bun test exited ${String(result.status)}`}\n${publicOutput.slice(-1_000)}`,
    };
  } catch (error) {
    return {
      passed: false,
      evidence: `Evaluator integrity/execution failure: ${error instanceof Error ? error.message : String(error)}`,
    };
  } finally {
    try {
      if (readFixtureText(root, hiddenRelativePath) === ownedSource)
        rmSync(fixturePath(root, hiddenRelativePath), { force: true });
    } catch {
      /* Preserve unsafe or tampered paths as evidence; never follow them during cleanup. */
    }
    if (privateHome) rmSync(privateHome, { recursive: true, force: true });
  }
}

export function readJsonArtifact<T = unknown>(root: string, path: string): T | null {
  try {
    return JSON.parse(readFixtureText(root, path)) as T;
  } catch {
    return null;
  }
}
