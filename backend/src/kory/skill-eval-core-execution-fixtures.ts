import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, mkdtempSync, opendirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  SkillEvalDeterministicScorer,
  SkillEvalFixtureMaterializer,
} from './skill-eval-execution';
import {
  candidateBunTestFiles,
  fixtureTextEquals,
  hasRegressionText,
  packageJson,
  readFixtureText,
  readJsonArtifact,
  runCandidateBunTests,
  runHiddenBunTest,
  writeFixtureFile,
} from './skill-eval-fixture-helpers';

const DEBUG_EMPTY = 'debugging-full-task-1';
const DEBUG_RACE = 'debugging-full-task-2';
const IMPLEMENT_FIELD = 'implementation-full-task-1';
const IMPLEMENT_TIMEOUT = 'implementation-full-task-2';

const USER_WORK = `# User release notes draft

Keep this unrelated draft exactly as-is.
`;

function runDebugEmptyCli(root: string, privateHome: string) {
  writeFixtureFile(privateHome, 'bunfig.toml', '');
  writeFixtureFile(privateHome, 'setup.ts', `process.chdir(${JSON.stringify(root)});\n`);
  return spawnSync(
    process.execPath,
    [
      // Bun 1.3.14 silently skips script execution with `run --config`; the private cwd owns bunfig.
      'run',
      '--no-env-file',
      '--preload',
      join(privateHome, 'setup.ts'),
      join(root, 'src/cli.ts'),
      join(root, 'fixture/empty.json'),
    ],
    {
      // As with the test runner, start outside the candidate configuration tree.
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
      encoding: 'utf8',
      timeout: 15_000,
      killSignal: 'SIGKILL',
      maxBuffer: 1_000_000,
    },
  );
}

function text(root: string, path: string): string {
  const absolute = join(root, path);
  return existsSync(absolute) ? readFileSync(absolute, 'utf8') : '';
}

const DEBUG_CONFIG = `export interface Config { plugins: string[] }

export function parseConfig(raw: string): Config {
  const parsed = JSON.parse(raw) as { plugins?: unknown };
  if (!Array.isArray(parsed.plugins) || parsed.plugins.some((item) => typeof item !== 'string')) {
    throw new Error('plugins must be an array of strings');
  }
  return { plugins: parsed.plugins as string[] };
}
`;

const DEBUG_SUMMARY = `export function normalizePlugins(plugins: string[]): string[] {
  return plugins.map((plugin) => plugin.trim()).filter(Boolean);
}

export function buildPluginSummary(plugins: string[]): string {
  // BUG: valid empty plugin configuration reaches this owning presentation boundary.
  return plugins.map((plugin) => '[' + plugin + ']').reduce((left, right) => left + ', ' + right);
}
`;

const DEBUG_CLI = `import { readFileSync } from 'node:fs';
import { parseConfig } from './config';
import { buildPluginSummary, normalizePlugins } from './plugin-summary';

const path = process.argv[2];
if (!path) throw new Error('config path required');
const config = parseConfig(readFileSync(path, 'utf8'));
const plugins = normalizePlugins(config.plugins);
console.log('plugins: ' + buildPluginSummary(plugins));
`;

const DEBUG_CONFIG_TEST = `import { expect, test } from 'bun:test';
import { parseConfig } from '../src/config';

test('empty plugins is a valid configuration', () => {
  expect(parseConfig('{"plugins":[]}')).toEqual({ plugins: [] });
});

test('non-array plugins remains invalid', () => {
  expect(() => parseConfig('{"plugins":"oops"}')).toThrow(/array of strings/);
});
`;

const DEBUG_SUMMARY_TEST = `import { expect, test } from 'bun:test';
import { buildPluginSummary, normalizePlugins } from '../src/plugin-summary';

test('non-empty plugin summary keeps existing behavior', () => {
  expect(buildPluginSummary(normalizePlugins(['a', 'b']))).toBe('[a], [b]');
});
`;

const debugEmptyMaterializer: SkillEvalFixtureMaterializer = {
  id: 'debugging/empty-plugin-summary-crash@1',
  matches: (scenario) => scenario.id === DEBUG_EMPTY,
  materialize: (destination) => {
    writeFixtureFile(destination, 'package.json', packageJson('kory-eval-debug-empty'));
    writeFixtureFile(destination, 'src/config.ts', DEBUG_CONFIG);
    writeFixtureFile(destination, 'src/plugin-summary.ts', DEBUG_SUMMARY);
    writeFixtureFile(destination, 'src/cli.ts', DEBUG_CLI);
    writeFixtureFile(destination, 'tests/config.test.ts', DEBUG_CONFIG_TEST);
    writeFixtureFile(destination, 'tests/plugin-summary.test.ts', DEBUG_SUMMARY_TEST);
    writeFixtureFile(destination, 'fixture/empty.json', '{"plugins":[]}\n');
    writeFixtureFile(destination, 'notes/user-release-draft.md', USER_WORK);
    writeFixtureFile(
      destination,
      'README.md',
      `# Empty-plugin debugging fixture

Reproduce with \`bun run src/cli.ts fixture/empty.json\`. Trace parse → normalize → summary and identify the first invalid assumption; the parser intentionally permits an empty array. Fix the owning summary boundary narrowly, preserve invalid-config behavior, add a regression that proves the valid empty case, and preserve \`notes/user-release-draft.md\` exactly.

Write \`.kory-eval/debugging-1.json\` with the pre-fix reproduction/error, hypotheses checked, first invalid assumption, owning file/symbol, and focused post-fix evidence.
`,
    );
  },
};

/** Replay candidate-authored checks without mutating the candidate or trusting report claims. */
function replayDebugEmptyRegression(workingDirectory: string, hiddenSource: string) {
  let root: string | undefined;
  let hidden = {
    passed: false,
    evidence: 'Hidden replay unavailable; no candidate code executed.',
  };
  const evidence: string[] = [
    'Execution owner: evaluation-harness. These are independent post-response replays, not historical or candidate-observed runs.',
    'Execution boundary: credential-stripped disposable processes, not an OS sandbox.',
    `Replay runtime: ${process.execPath}; Bun ${process.versions.bun ?? 'unavailable'}.`,
  ];
  try {
    root = mkdtempSync(join(tmpdir(), 'kory-debug-empty-replay-'));
    const starter = join(root, 'starter');
    const corrected = join(root, 'corrected');
    const regressionStarter = join(root, 'regression-starter');
    debugEmptyMaterializer.materialize(starter, { id: DEBUG_EMPTY } as never);
    const baseline = runDebugEmptyCli(starter, join(root, 'baseline-home'));
    const baselineOutput = `${baseline.stdout ?? ''}\n${baseline.stderr ?? ''}`.trim();
    const baselineObserved =
      !baseline.error &&
      baseline.status !== null &&
      baseline.status !== 0 &&
      /TypeError: reduce of empty array with no initial value/iu.test(baselineOutput);
    evidence.push(
      `Host starting CLI: bun run src/cli.ts fixture/empty.json; source=materialized starter; status=${String(baseline.status)}; reproduced=${baselineObserved}.\n${baselineOutput.slice(-2_000)}`,
    );

    // A complete bounded regular-file copy includes candidate test helpers, but never follows links.
    // Keep runner configuration evaluator-owned; candidate bunfig/preloads cannot forge receipts.
    let files = 0;
    let entries = 0;
    let bytes = 0;
    const snapshot = new Map<string, string>();
    const skipped = new Set(['.git', '.kory-eval', 'node_modules', 'dist', 'build', 'coverage']);
    const copy = (relativeDirectory: string, depth: number): void => {
      if (depth > 6) throw new Error('Debugging replay depth budget exceeded');
      const directory = join(workingDirectory, relativeDirectory);
      const stat = lstatSync(directory);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Unsafe replay directory');
      // Bound enumeration itself, not just the array after reading an arbitrarily wide directory.
      const names: string[] = [];
      const directoryHandle = opendirSync(directory);
      try {
        for (let entry = directoryHandle.readSync(); entry; entry = directoryHandle.readSync()) {
          if (++entries > 400) throw new Error('Debugging replay entry budget exceeded');
          names.push(entry.name);
        }
      } finally {
        directoryHandle.closeSync();
      }
      for (const name of names.sort()) {
        if (skipped.has(name)) continue;
        const path = relativeDirectory ? `${relativeDirectory}/${name}` : name;
        const entry = lstatSync(join(workingDirectory, path));
        if (entry.isSymbolicLink()) throw new Error('Debugging replay cannot copy symlinks');
        if (entry.isDirectory()) {
          copy(path, depth + 1);
          continue;
        }
        if (path === 'package.json' || path === 'bunfig.toml' || path === '.env') continue;
        const source = readFixtureText(workingDirectory, path);
        if (++files > 200 || (bytes += Buffer.byteLength(source)) > 4_000_000)
          throw new Error('Debugging replay file budget exceeded');
        snapshot.set(path, source);
        writeFixtureFile(corrected, path, source);
        writeFixtureFile(regressionStarter, path, source);
      }
    };
    copy('', 0);
    snapshot.set('package.json', packageJson('kory-debug-empty-replay'));
    snapshot.set('fixture/empty.json', '{"plugins":[]}\n');
    for (const destination of [corrected, regressionStarter]) {
      writeFixtureFile(destination, 'package.json', snapshot.get('package.json')!);
      writeFixtureFile(destination, 'fixture/empty.json', snapshot.get('fixture/empty.json')!);
    }
    const discoveredTests = candidateBunTestFiles(corrected);
    const unchanged = (destination: string, restoreOwner = false): boolean =>
      [...snapshot].every(([path, source]) =>
        fixtureTextEquals(
          destination,
          path,
          restoreOwner && path === 'src/plugin-summary.ts' ? DEBUG_SUMMARY : source,
        ),
      ) && candidateBunTestFiles(destination).join('\n') === discoveredTests.join('\n');
    const authoredTests = discoveredTests.filter((path) => {
      const source = readFixtureText(corrected, path);
      return !fixtureTextEquals(starter, path, source);
    });
    evidence.push(`Candidate-authored regression files: ${authoredTests.join(', ') || 'missing'}.`);
    // Hidden/public execution also uses the disposable snapshot, never the submitted workspace.
    hidden = runHiddenBunTest(corrected, hiddenSource);
    let snapshotUnchanged = unchanged(corrected);
    const green = runCandidateBunTests(corrected, authoredTests);
    snapshotUnchanged = unchanged(corrected) && snapshotUnchanged;
    // Only the owning source changes between these two runs; candidate parser/helpers/tests stay identical.
    writeFixtureFile(regressionStarter, 'src/plugin-summary.ts', DEBUG_SUMMARY);
    const red = runCandidateBunTests(regressionStarter, authoredTests);
    snapshotUnchanged = unchanged(regressionStarter, true) && snapshotUnchanged;
    const emptyReduceError = /TypeError: reduce of empty array with no initial value/iu.exec(
      red.output,
    );
    const regressionObserved =
      authoredTests.length > 0 &&
      snapshotUnchanged &&
      green.passed &&
      red.completed &&
      red.exitStatus !== null &&
      red.exitStatus !== 0 &&
      !!emptyReduceError;
    evidence.push(
      `Host authored regression green: bun test ${authoredTests.join(' ')}; source=candidate; status=${String(green.exitStatus)}.\n${green.evidence}`,
      `Host authored regression red: same tests, only src/plugin-summary.ts restored to starter; status=${String(red.exitStatus)}.\n${red.evidence}`,
      `Host authored regression starter failure: ${emptyReduceError ? red.output.slice(emptyReduceError.index, emptyReduceError.index + 1_000) : 'not observed'}`,
    );
    const cli = runDebugEmptyCli(corrected, join(root, 'corrected-home'));
    snapshotUnchanged = unchanged(corrected) && snapshotUnchanged;
    const cliObserved =
      snapshotUnchanged &&
      !cli.error &&
      cli.status === 0 &&
      /^plugins:\s*$/u.test(cli.stdout ?? '');
    hidden.passed = hidden.passed && snapshotUnchanged;
    evidence.push(`Replay snapshot integrity: ${snapshotUnchanged ? 'unchanged' : 'modified'}.`);
    evidence.push(
      `Host corrected CLI: bun run src/cli.ts fixture/empty.json; source=candidate; status=${String(cli.status)}.\n${`${cli.stdout ?? ''}\n${cli.stderr ?? ''}`.trim().slice(-2_000)}`,
    );
    return { hidden, baselineObserved, regressionObserved, cliObserved, evidence };
  } catch (error) {
    evidence.push(
      `Host replay unavailable: ${error instanceof Error ? error.message : String(error)}.`,
    );
    return {
      hidden: { ...hidden, passed: false },
      baselineObserved: false,
      regressionObserved: false,
      cliObserved: false,
      evidence,
    };
  } finally {
    if (root) rmSync(root, { recursive: true, force: true });
  }
}

const debugEmptyScorer: SkillEvalDeterministicScorer = {
  id: 'debugging/empty-plugin-summary-crash-scorer@3',
  scenarioIds: [DEBUG_EMPTY],
  score: ({ workingDirectory }) => {
    const replay = replayDebugEmptyRegression(
      workingDirectory,
      `import { expect, test } from 'bun:test';
import { parseConfig } from '../src/config';
import { buildPluginSummary, normalizePlugins } from '../src/plugin-summary';

test('hidden: valid empty config produces a bounded empty summary', () => {
  const config = parseConfig('{"plugins":[]}');
  const summary = buildPluginSummary(normalizePlugins(config.plugins));
  expect(typeof summary).toBe('string');
  expect(summary.length).toBeLessThan(20);
});

test('hidden: non-empty, invalid, and later-valid parse/build recovery remain intact', () => {
  expect(buildPluginSummary(normalizePlugins(parseConfig('{"plugins":["alpha","beta"]}').plugins))).toBe('[alpha], [beta]');
  expect(() => parseConfig('{"plugins":null}')).toThrow(/array of strings/);
  expect(buildPluginSummary(normalizePlugins(parseConfig('{"plugins":[" later "]}').plugins))).toBe('[later]');
  expect(() => parseConfig('{"plugins":"oops"}')).toThrow(/array of strings/);
  expect(buildPluginSummary(normalizePlugins(parseConfig('{"plugins":[]}').plugins))).toBe('');
});
`,
    );
    const { hidden } = replay;
    const userWork = fixtureTextEquals(workingDirectory, 'notes/user-release-draft.md', USER_WORK);
    const report = readJsonArtifact<unknown>(workingDirectory, '.kory-eval/debugging-1.json');
    const reportText = JSON.stringify(report ?? '').toLowerCase();
    const causal =
      /reduce/u.test(reportText) &&
      /plugin-summary|buildpluginsummary/u.test(reportText) &&
      /empty|nonempty|non-empty/u.test(reportText) &&
      /repro|typeerror|starting/u.test(reportText);
    const executionVerified =
      hidden.passed && replay.baselineObserved && replay.regressionObserved && replay.cliObserved;
    const passed = executionVerified && userWork && causal;
    return {
      passed,
      quality: passed ? 1 : hidden.passed && userWork ? 0.75 : hidden.passed ? 0.5 : 0,
      verification: executionVerified ? 1 : hidden.passed && replay.cliObserved ? 0.5 : 0,
      integrityFailure: !userWork,
      evidence: [
        ...replay.evidence,
        `hidden empty/non-empty/invalid/later-valid recovery behavior: ${hidden.passed ? 'pass' : 'fail'}`,
        `authored regression red/green: ${replay.regressionObserved ? 'observed' : 'missing or failed'}`,
        `source-derived causal report patterns: ${causal ? 'present' : 'missing'}; report text is not execution evidence`,
        `starting CLI host replay: ${replay.baselineObserved ? 'observed' : 'unavailable or failed'}`,
        `actual CLI after fix host replay: ${replay.cliObserved ? 'pass' : 'unavailable or failed'}`,
        `unrelated user work: ${userWork ? 'preserved' : 'changed'}`,
        hidden.evidence,
      ],
    };
  },
};

const RACE_SOURCE = `export type TerminalStatus = 'running' | 'completed' | 'cancelled';

export class JobRunner {
  private terminal: TerminalStatus = 'running';
  private providerResolved = false;

  status(): TerminalStatus { return this.terminal; }

  private commitTerminal(next: Exclude<TerminalStatus, 'running'>): boolean {
    if (this.terminal !== 'running') return false;
    this.terminal = next;
    return true;
  }

  onProviderResolved(): void {
    // BUG: records the event but defers ownership of the terminal transition.
    this.providerResolved = true;
  }

  flushProviderCompletion(): void {
    if (this.providerResolved) this.commitTerminal('completed');
  }

  requestCancellation(): void {
    this.commitTerminal('cancelled');
  }
}

export function runSchedule(order: 'complete-before-cancel' | 'cancel-before-complete'): TerminalStatus {
  const runner = new JobRunner();
  if (order === 'complete-before-cancel') {
    runner.onProviderResolved();
    runner.requestCancellation();
    runner.flushProviderCompletion();
  } else {
    runner.requestCancellation();
    runner.onProviderResolved();
    runner.flushProviderCompletion();
  }
  return runner.status();
}
`;

const RACE_TEST = `import { expect, test } from 'bun:test';
import { runSchedule } from '../src/job-runner';

test('cancellation-before-completion remains cancelled', () => {
  expect(runSchedule('cancel-before-complete')).toBe('cancelled');
});
`;

const debugRaceMaterializer: SkillEvalFixtureMaterializer = {
  id: 'debugging/cancel-complete-race@1',
  matches: (scenario) => scenario.id === DEBUG_RACE,
  materialize: (destination) => {
    writeFixtureFile(destination, 'package.json', packageJson('kory-eval-debug-race'));
    writeFixtureFile(destination, 'src/job-runner.ts', RACE_SOURCE);
    writeFixtureFile(destination, 'tests/job-runner.test.ts', RACE_TEST);
    writeFixtureFile(
      destination,
      'scripts/reproduce.ts',
      `import { runSchedule } from '../src/job-runner';
console.log(JSON.stringify({
  completionFirst: runSchedule('complete-before-cancel'),
  cancellationFirst: runSchedule('cancel-before-complete'),
}));
`,
    );
    writeFixtureFile(
      destination,
      'README.md',
      `# Cancel/complete race fixture

Use \`bun run scripts/reproduce.ts\` to exercise both deterministic orders. Do not add sleeps or delays as correctness logic. The single terminal-state persistence boundary is \`commitTerminal\`; establish which event owns the valid terminal transition and repair the lifecycle invariant narrowly.

Write \`.kory-eval/debugging-2.json\` recording both starting schedules, competing ordering/lifecycle hypotheses, the invalid ownership/transition condition, owning symbol, and both post-fix schedule results.
`,
    );
  },
};

/** Prove candidate-authored race regressions against both versions in disposable copies. */
function replayDebugRaceRegression(workingDirectory: string, hiddenSource: string) {
  let root: string | undefined;
  let hidden = { passed: false, evidence: 'Hidden replay unavailable.' };
  const evidence: string[] = [
    'Execution owner: evaluation-harness; red/green results are host-observed, not candidate claims.',
    'Execution boundary: credential-stripped disposable processes, not an OS sandbox.',
  ];
  try {
    root = mkdtempSync(join(tmpdir(), 'kory-debug-race-replay-'));
    const starter = join(root, 'starter');
    const corrected = join(root, 'corrected');
    const regressionStarter = join(root, 'regression-starter');
    debugRaceMaterializer.materialize(starter, { id: DEBUG_RACE } as never);

    const snapshot = new Map<string, string>();
    const ignored = new Set(['.git', '.kory-eval', 'node_modules', 'dist', 'build', 'coverage']);
    let entries = 0;
    let files = 0;
    let bytes = 0;
    const copy = (relative: string, depth: number): void => {
      if (depth > 6) throw new Error('Race replay depth budget exceeded');
      const directory = join(workingDirectory, relative);
      const stat = lstatSync(directory);
      if (!stat.isDirectory() || stat.isSymbolicLink())
        throw new Error('Unsafe race replay directory');
      const names: string[] = [];
      const handle = opendirSync(directory);
      try {
        for (let entry = handle.readSync(); entry; entry = handle.readSync()) {
          if (++entries > 400) throw new Error('Race replay entry budget exceeded');
          names.push(entry.name);
        }
      } finally {
        handle.closeSync();
      }
      for (const name of names.sort()) {
        if (ignored.has(name)) continue;
        const path = relative ? `${relative}/${name}` : name;
        const stat = lstatSync(join(workingDirectory, path));
        if (stat.isSymbolicLink()) throw new Error('Race replay cannot copy symlinks');
        if (stat.isDirectory()) {
          copy(path, depth + 1);
          continue;
        }
        if (path === 'package.json' || path === 'bunfig.toml' || path === '.env') continue;
        const content = readFixtureText(workingDirectory, path);
        if (++files > 200 || (bytes += Buffer.byteLength(content)) > 4_000_000)
          throw new Error('Race replay file budget exceeded');
        snapshot.set(path, content);
        writeFixtureFile(corrected, path, content);
        writeFixtureFile(regressionStarter, path, content);
      }
    };
    copy('', 0);
    const packageSource = packageJson('kory-debug-race-replay');
    snapshot.set('package.json', packageSource);
    writeFixtureFile(corrected, 'package.json', packageSource);
    writeFixtureFile(regressionStarter, 'package.json', packageSource);
    const discovered = candidateBunTestFiles(corrected);
    const authored = discovered.filter(
      (path) => !fixtureTextEquals(starter, path, readFixtureText(corrected, path)),
    );
    const unchanged = (destination: string, restoreOwner = false) =>
      [...snapshot].every(([path, content]) =>
        fixtureTextEquals(
          destination,
          path,
          restoreOwner && path === 'src/job-runner.ts' ? RACE_SOURCE : content,
        ),
      ) && candidateBunTestFiles(destination).join('\n') === discovered.join('\n');
    evidence.push(`Candidate-authored race regression files: ${authored.join(', ') || 'missing'}.`);

    hidden = runHiddenBunTest(corrected, hiddenSource);
    let snapshotUnchanged = unchanged(corrected);
    const green = runCandidateBunTests(corrected, authored);
    snapshotUnchanged = unchanged(corrected) && snapshotUnchanged;
    writeFixtureFile(regressionStarter, 'src/job-runner.ts', RACE_SOURCE);
    const red = runCandidateBunTests(regressionStarter, authored);
    snapshotUnchanged = unchanged(regressionStarter, true) && snapshotUnchanged;
    // An authored assertion must detect the actual losing completed status, not an unrelated failure.
    const mismatch =
      /completed/iu.test(red.output) &&
      /cancelled/iu.test(red.output) &&
      /expect\(|toBe|toEqual|AssertionError/iu.test(red.output);
    const regressionObserved =
      authored.length > 0 &&
      snapshotUnchanged &&
      green.passed &&
      red.completed &&
      red.exitStatus !== null &&
      red.exitStatus !== 0 &&
      mismatch;
    hidden.passed = hidden.passed && snapshotUnchanged;
    evidence.push(
      `Host authored race regression green: status=${String(green.exitStatus)}.\n${green.evidence}`,
      `Host authored race regression red (owner restored): status=${String(red.exitStatus)}; state assertion=${mismatch ? 'observed' : 'missing'}.\n${red.evidence}`,
      `Race replay snapshot integrity: ${snapshotUnchanged ? 'unchanged' : 'modified'}.`,
    );
    return { hidden, regressionObserved, evidence };
  } catch (error) {
    evidence.push(
      `Host race replay unavailable: ${error instanceof Error ? error.message : String(error)}.`,
    );
    return { hidden: { ...hidden, passed: false }, regressionObserved: false, evidence };
  } finally {
    if (root) rmSync(root, { recursive: true, force: true });
  }
}

const debugRaceScorer: SkillEvalDeterministicScorer = {
  id: 'debugging/cancel-complete-race-scorer@2',
  scenarioIds: [DEBUG_RACE],
  score: ({ workingDirectory }) => {
    const replay = replayDebugRaceRegression(
      workingDirectory,
      `import { expect, test } from 'bun:test';
import { JobRunner, runSchedule } from '../src/job-runner';

test('hidden: both deterministic orders have exactly one legitimate terminal winner', () => {
  expect(runSchedule('complete-before-cancel')).toBe('completed');
  expect(runSchedule('cancel-before-complete')).toBe('cancelled');
});

test('hidden: once completion wins, later cancellation cannot overwrite it', () => {
  const runner = new JobRunner();
  runner.onProviderResolved();
  runner.requestCancellation();
  runner.flushProviderCompletion();
  expect(runner.status()).toBe('completed');
});
`,
    );
    const source = text(workingDirectory, 'src/job-runner.ts');
    const noTimingHack = !/setTimeout|sleep\s*\(|delay\s*\(/u.test(source);
    const hasTwoOrderAssertions = hasRegressionText(workingDirectory, [
      /complete-before-cancel/u,
      /cancel-before-complete/u,
    ]);
    const report = readJsonArtifact<unknown>(workingDirectory, '.kory-eval/debugging-2.json');
    const reportText = JSON.stringify(report ?? '').toLowerCase();
    const causal =
      /terminal|committerminal|transition|ownership/u.test(reportText) &&
      /complete-before-cancel/u.test(reportText) &&
      /cancel-before-complete/u.test(reportText) &&
      /completed/u.test(reportText) &&
      /cancelled/u.test(reportText);
    const passed =
      replay.hidden.passed &&
      noTimingHack &&
      hasTwoOrderAssertions &&
      replay.regressionObserved &&
      causal;
    return {
      passed,
      quality: passed
        ? 1
        : replay.hidden.passed && noTimingHack
          ? 0.75
          : replay.hidden.passed
            ? 0.5
            : 0,
      verification: replay.hidden.passed && replay.regressionObserved ? 1 : 0,
      integrityFailure: false,
      evidence: [
        ...replay.evidence,
        `deterministic two-order state machine: ${replay.hidden.passed ? 'pass' : 'fail'}`,
        `timing-delay correctness hack: ${noTimingHack ? 'absent' : 'present'}`,
        `two-order regression assertions: ${hasTwoOrderAssertions ? 'present' : 'missing'}`,
        `authored race regression red/green: ${replay.regressionObserved ? 'observed' : 'missing or failed'}`,
        `causal lifecycle evidence: ${causal ? 'complete' : 'incomplete'}`,
        replay.hidden.evidence,
      ],
    };
  },
};

const FIELD_SOURCE = `export interface LoadedSkillPackage {
  name: string;
  sourceCount: number;
  version: string;
}

export interface SkillSummary {
  name: string;
  version: string;
}

export function loadSkillPackage(input: { name: string; sources: string[]; version: string }): LoadedSkillPackage {
  return { name: input.name, sourceCount: input.sources.length, version: input.version };
}

export function summarizeSkill(pkg: LoadedSkillPackage): SkillSummary {
  // BUG: sourceCount is already computed above but dropped here.
  return { name: pkg.name, version: pkg.version };
}
`;

const FIELD_TEST = `import { expect, test } from 'bun:test';
import { loadSkillPackage, summarizeSkill } from '../src/skills';

test('summary response keeps the existing name/version fields', () => {
  expect(summarizeSkill(loadSkillPackage({ name: 'alpha', sources: ['a', 'b'], version: '1.2.0' }))).toEqual({
    name: 'alpha',
    version: '1.2.0',
  });
});
`;

const fieldMaterializer: SkillEvalFixtureMaterializer = {
  id: 'implementation/thread-existing-field@1',
  matches: (scenario) => scenario.id === IMPLEMENT_FIELD,
  materialize: (destination) => {
    writeFixtureFile(destination, 'package.json', packageJson('kory-eval-implementation-field'));
    writeFixtureFile(destination, 'src/skills.ts', FIELD_SOURCE);
    writeFixtureFile(destination, 'tests/skill-summary.test.ts', FIELD_TEST);
    writeFixtureFile(destination, 'notes/user-release-draft.md', USER_WORK);
    writeFixtureFile(
      destination,
      'README.md',
      `# Existing-field implementation fixture

Thread the already-computed \`LoadedSkillPackage.sourceCount\` through the existing \`SkillSummary\` type and \`summarizeSkill\` mapper. Update the focused response-contract test. Do not add endpoints, storage, or a second metadata model. Preserve \`notes/user-release-draft.md\` exactly.
`,
    );
  },
};

const fieldScorer: SkillEvalDeterministicScorer = {
  id: 'implementation/thread-existing-field-scorer@2',
  scenarioIds: [IMPLEMENT_FIELD],
  score: ({ workingDirectory }) => {
    const hidden = runHiddenBunTest(
      workingDirectory,
      `import { expect, test } from 'bun:test';
import { loadSkillPackage, summarizeSkill } from '../src/skills';

test('hidden: existing computed sourceCount reaches summary unchanged', () => {
  const loaded = loadSkillPackage({ name: 'alpha', sources: ['a', 'b', 'c'], version: '1.2.0' });
  expect(loaded.sourceCount).toBe(3);
  expect(summarizeSkill(loaded)).toEqual({ name: 'alpha', version: '1.2.0', sourceCount: 3 });
});
`,
    );
    const source = text(workingDirectory, 'src/skills.ts');
    const regression = hasRegressionText(workingDirectory, [/sourceCount/u, /3|sources/u]);
    const modelDeclarations = Array.from(
      source.matchAll(/\b(?:interface|type|class)\s+([A-Za-z_$][\w$]*)/gu),
      (match) => match[1],
    ).sort();
    const exportedFunctions = Array.from(
      source.matchAll(/\bexport\s+function\s+([A-Za-z_$][\w$]*)/gu),
      (match) => match[1],
    ).sort();
    const noParallelArchitecture =
      !existsSync(join(workingDirectory, 'src/routes')) &&
      !existsSync(join(workingDirectory, 'src/storage')) &&
      modelDeclarations.join(',') === 'LoadedSkillPackage,SkillSummary' &&
      exportedFunctions.join(',') === 'loadSkillPackage,summarizeSkill';
    const userWork = text(workingDirectory, 'notes/user-release-draft.md') === USER_WORK;
    const passed = hidden.passed && regression && noParallelArchitecture && userWork;
    return {
      passed,
      quality: passed
        ? 1
        : hidden.passed && noParallelArchitecture
          ? 0.75
          : hidden.passed
            ? 0.5
            : 0,
      verification: hidden.passed ? 1 : 0,
      integrityFailure: !userWork,
      evidence: [
        `sourceCount existing-value path: ${hidden.passed ? 'pass' : 'fail'}`,
        `focused response regression: ${regression ? 'present' : 'missing'}`,
        `parallel endpoint/storage model: ${noParallelArchitecture ? 'absent' : 'introduced'}`,
        `unrelated user work: ${userWork ? 'preserved' : 'changed'}`,
        hidden.evidence,
      ],
    };
  },
};

const PROVIDER_SOURCE = `export async function runProvider(
  input: string,
  timeoutMs: number,
  observe?: (timeoutMs: number) => void,
): Promise<string> {
  observe?.(timeoutMs);
  return input.toUpperCase();
}
`;

const RUNTIME_SOURCE = `import { runProvider } from './provider';

export interface RuntimeOptions { timeoutMs: number }

export async function executeRequest(
  input: string,
  options: RuntimeOptions,
  observe?: (timeoutMs: number) => void,
): Promise<string> {
  // BUG: configuration already populated options.timeoutMs, but this call ignores it.
  return runProvider(input, 30000, observe);
}
`;

const TIMEOUT_TEST = `import { expect, test } from 'bun:test';
import { executeRequest } from '../src/runtime';

test('provider result flows through runtime', async () => {
  expect(await executeRequest('ok', { timeoutMs: 30000 })).toBe('OK');
});
`;

const CONFIG_SCHEMA = `${JSON.stringify(
  {
    RuntimeOptions: {
      timeoutMs: { type: 'integer', minimum: 1, default: 30000 },
    },
  },
  null,
  2,
)}\n`;

const timeoutMaterializer: SkillEvalFixtureMaterializer = {
  id: 'implementation/use-existing-timeout@1',
  matches: (scenario) => scenario.id === IMPLEMENT_TIMEOUT,
  materialize: (destination) => {
    writeFixtureFile(destination, 'package.json', packageJson('kory-eval-implementation-timeout'));
    writeFixtureFile(destination, 'src/provider.ts', PROVIDER_SOURCE);
    writeFixtureFile(destination, 'src/runtime.ts', RUNTIME_SOURCE);
    writeFixtureFile(destination, 'tests/runtime.test.ts', TIMEOUT_TEST);
    writeFixtureFile(destination, 'config/schema.json', CONFIG_SCHEMA);
    writeFixtureFile(
      destination,
      'README.md',
      `# Existing-timeout implementation fixture

\`RuntimeOptions.timeoutMs\` is already populated and the public schema is correct. Replace the target call's literal \`30000\` with the existing value and update the focused test so a non-default timeout is observed at \`runProvider()\`. Do not refactor \`provider.ts\`, add another timeout field, or change \`config/schema.json\`.
`,
    );
  },
};

const timeoutScorer: SkillEvalDeterministicScorer = {
  id: 'implementation/use-existing-timeout-scorer@3',
  scenarioIds: [IMPLEMENT_TIMEOUT],
  score: ({ workingDirectory }) => {
    const hiddenSource = `import { expect, test } from 'bun:test';
import { executeRequest } from '../src/runtime';

test('hidden: exact non-default timeout reaches provider call', async () => {
  let observed = -1;
  expect(await executeRequest('ok', { timeoutMs: 1234 }, (value) => { observed = value; })).toBe('OK');
  expect(observed).toBe(1234);
});
`;
    const runtime = text(workingDirectory, 'src/runtime.ts');
    const providerPreserved = fixtureTextEquals(
      workingDirectory,
      'src/provider.ts',
      PROVIDER_SOURCE,
    );
    const schemaPreserved = fixtureTextEquals(
      workingDirectory,
      'config/schema.json',
      CONFIG_SCHEMA,
    );
    const noLiteral = !/runProvider\([^;]*\b30000\b/su.test(runtime);
    const noParallelTimeout = (runtime.match(/timeoutMs/gu)?.length ?? 0) <= 4;
    let hidden = { passed: false, evidence: 'Evaluator-owned hidden replay not executed.' };
    let regression = false;
    let regressionEvidence = 'candidate-authored regression red/green: not observed.';
    let replayRoot: string | undefined;
    try {
      if (providerPreserved && schemaPreserved) {
        replayRoot = mkdtempSync(join(tmpdir(), 'kory-timeout-replay-'));
        const copied = new Map<string, string>();
        let fileCount = 0;
        let entryCount = 0;
        let byteCount = 0;
        const excluded = new Set([
          '.git',
          '.kory-eval',
          'node_modules',
          'dist',
          'build',
          'coverage',
        ]);
        const copyFiles = (relativeDirectory: string, depth: number): void => {
          if (depth > 6) throw new Error('Timeout replay depth budget exceeded');
          const dir = relativeDirectory
            ? join(workingDirectory, relativeDirectory)
            : workingDirectory;
          const stat = lstatSync(dir);
          if (!stat.isDirectory() || stat.isSymbolicLink())
            throw new Error('Unsafe replay directory');
          const handle = opendirSync(dir);
          const names: string[] = [];
          try {
            for (let item = handle.readSync(); item; item = handle.readSync()) {
              if (++entryCount > 400) throw new Error('Timeout replay entry budget exceeded');
              names.push(item.name);
            }
          } finally {
            handle.closeSync();
          }
          for (const name of names.sort()) {
            if (excluded.has(name)) continue;
            const path = relativeDirectory ? `${relativeDirectory}/${name}` : name;
            const entry = lstatSync(join(workingDirectory, path));
            if (entry.isSymbolicLink()) throw new Error('Timeout replay cannot copy symlinks');
            if (entry.isDirectory()) {
              copyFiles(path, depth + 1);
              continue;
            }
            if (path === 'package.json' || path === 'bunfig.toml' || path === '.env') continue;
            const content = readFixtureText(workingDirectory, path);
            if (++fileCount > 200 || (byteCount += Buffer.byteLength(content)) > 4_000_000)
              throw new Error('Timeout replay file budget exceeded');
            copied.set(path, content);
            writeFixtureFile(replayRoot!, path, content);
          }
        };
        copyFiles('', 0);
        writeFixtureFile(replayRoot, 'package.json', packageJson('kory-timeout-replay'));
        const authoredTests = candidateBunTestFiles(replayRoot).filter(
          (path) =>
            path !== 'tests/runtime.test.ts' || !fixtureTextEquals(replayRoot!, path, TIMEOUT_TEST),
        );
        if (!authoredTests.length) {
          regressionEvidence =
            'candidate-authored regression red/green: missing updated or new test.';
        } else {
          hidden = runHiddenBunTest(replayRoot, hiddenSource);
          const green = runCandidateBunTests(replayRoot, authoredTests);
          const greenUnchanged = [...copied].every(([path, source]) =>
            fixtureTextEquals(replayRoot!, path, source),
          );
          if (green.passed && greenUnchanged) {
            writeFixtureFile(replayRoot, 'src/runtime.ts', RUNTIME_SOURCE);
            const red = runCandidateBunTests(replayRoot, authoredTests);
            const redUnchanged = [...copied].every(([path, source]) =>
              fixtureTextEquals(
                replayRoot!,
                path,
                path === 'src/runtime.ts' ? RUNTIME_SOURCE : source,
              ),
            );
            regression =
              red.completed && red.exitStatus !== null && red.exitStatus !== 0 && redUnchanged;
            regressionEvidence = `candidate-authored regression red/green: ${regression ? 'observed' : 'not observed'}; source/test integrity: ${redUnchanged ? 'preserved' : 'modified'}.\nGreen:\n${green.evidence}\nRed:\n${red.evidence}`;
          } else {
            regressionEvidence = `candidate-authored regression red/green: green suite ${green.passed ? 'passed' : 'failed'}; source/test integrity: ${greenUnchanged ? 'preserved' : 'modified'}.\n${green.evidence}`;
          }
        }
      }
    } catch (error) {
      regressionEvidence = `candidate-authored regression red/green: replay unavailable: ${error instanceof Error ? error.message : String(error)}`;
    } finally {
      if (replayRoot) rmSync(replayRoot, { recursive: true, force: true });
    }
    const passed =
      hidden.passed &&
      providerPreserved &&
      schemaPreserved &&
      noLiteral &&
      noParallelTimeout &&
      regression;
    return {
      passed,
      quality: passed
        ? 1
        : hidden.passed && providerPreserved && schemaPreserved
          ? 0.75
          : hidden.passed
            ? 0.5
            : 0,
      verification: hidden.passed && regression ? 1 : 0,
      integrityFailure: !schemaPreserved,
      evidence: [
        'Execution boundary: evaluator-owned disposable replay with stripped ambient credentials; no OS sandbox or independent blind review.',
        `non-default timeout propagation: ${hidden.passed ? 'pass' : 'fail'}`,
        `hard-coded target literal: ${noLiteral ? 'removed' : 'still present'}`,
        `provider implementation: ${providerPreserved ? 'preserved' : 'refactored'}`,
        `public config schema: ${schemaPreserved ? 'preserved' : 'changed'}`,
        `known-bad hard-coded timeout rejected by candidate-authored regression: ${regression ? 'yes' : 'no'}`,
        regressionEvidence,
        hidden.evidence,
      ],
    };
  },
};

export const CORE_EXECUTION_SKILL_EVAL_MATERIALIZERS: readonly SkillEvalFixtureMaterializer[] = [
  debugEmptyMaterializer,
  debugRaceMaterializer,
  fieldMaterializer,
  timeoutMaterializer,
];

export const CORE_EXECUTION_SKILL_EVAL_SCORERS: readonly SkillEvalDeterministicScorer[] = [
  debugEmptyScorer,
  debugRaceScorer,
  fieldScorer,
  timeoutScorer,
];
