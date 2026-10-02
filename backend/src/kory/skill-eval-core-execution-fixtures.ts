import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type {
  SkillEvalDeterministicScorer,
  SkillEvalFixtureMaterializer,
} from './skill-eval-execution';
import {
  hasRegressionText,
  packageJson,
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

function run(root: string, command: string, args: string[]) {
  return spawnSync(command, args, {
    cwd: root,
    encoding: 'utf8',
    timeout: 15_000,
    maxBuffer: 1_000_000,
  });
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

const debugEmptyScorer: SkillEvalDeterministicScorer = {
  id: 'debugging/empty-plugin-summary-crash-scorer@1',
  scenarioIds: [DEBUG_EMPTY],
  score: ({ workingDirectory }) => {
    const hidden = runHiddenBunTest(
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

test('hidden: non-empty and invalid config contracts remain intact', () => {
  expect(buildPluginSummary(normalizePlugins(['alpha', 'beta']))).toBe('[alpha], [beta]');
  expect(() => parseConfig('{"plugins":null}')).toThrow(/array of strings/);
});
`,
    );
    const regression = hasRegressionText(workingDirectory, [/plugins/u, /\[\]|empty/iu]);
    const userWork = text(workingDirectory, 'notes/user-release-draft.md') === USER_WORK;
    const report = readJsonArtifact<unknown>(workingDirectory, '.kory-eval/debugging-1.json');
    const reportText = JSON.stringify(report ?? '').toLowerCase();
    const causal =
      /reduce/u.test(reportText) &&
      /plugin-summary|buildpluginsummary/u.test(reportText) &&
      /empty|nonempty|non-empty/u.test(reportText) &&
      /repro|typeerror|starting/u.test(reportText);
    const cli = run(workingDirectory, 'bun', ['run', 'src/cli.ts', 'fixture/empty.json']);
    const passed = hidden.passed && regression && userWork && causal && cli.status === 0;
    return {
      passed,
      quality: passed ? 1 : hidden.passed && userWork ? 0.75 : hidden.passed ? 0.5 : 0,
      verification: hidden.passed && cli.status === 0 ? 1 : 0,
      integrityFailure: !userWork,
      evidence: [
        `hidden empty/non-empty/invalid behavior: ${hidden.passed ? 'pass' : 'fail'}`,
        `empty-case regression coverage: ${regression ? 'present' : 'missing'}`,
        `pre-fix causal record: ${causal ? 'complete' : 'incomplete'}`,
        `actual CLI after fix: ${cli.status === 0 ? 'pass' : 'fail'}`,
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

const debugRaceScorer: SkillEvalDeterministicScorer = {
  id: 'debugging/cancel-complete-race-scorer@1',
  scenarioIds: [DEBUG_RACE],
  score: ({ workingDirectory }) => {
    const hidden = runHiddenBunTest(
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
    const regression = hasRegressionText(workingDirectory, [
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
    const passed = hidden.passed && noTimingHack && regression && causal;
    return {
      passed,
      quality: passed ? 1 : hidden.passed && noTimingHack ? 0.75 : hidden.passed ? 0.5 : 0,
      verification: hidden.passed ? 1 : 0,
      integrityFailure: false,
      evidence: [
        `deterministic two-order state machine: ${hidden.passed ? 'pass' : 'fail'}`,
        `timing-delay correctness hack: ${noTimingHack ? 'absent' : 'present'}`,
        `two-order regression coverage: ${regression ? 'present' : 'missing'}`,
        `causal lifecycle evidence: ${causal ? 'complete' : 'incomplete'}`,
        hidden.evidence,
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
  id: 'implementation/thread-existing-field-scorer@1',
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
    const noParallelArchitecture =
      !existsSync(join(workingDirectory, 'src/routes')) &&
      !existsSync(join(workingDirectory, 'src/storage')) &&
      (source.match(/sourceCount\s*:/gu)?.length ?? 0) <= 3;
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
  id: 'implementation/use-existing-timeout-scorer@2',
  scenarioIds: [IMPLEMENT_TIMEOUT],
  score: ({ workingDirectory }) => {
    const hidden = runHiddenBunTest(
      workingDirectory,
      `import { expect, test } from 'bun:test';
import { executeRequest } from '../src/runtime';

test('hidden: exact non-default timeout reaches provider call', async () => {
  let observed = -1;
  expect(await executeRequest('ok', { timeoutMs: 1234 }, (value) => { observed = value; })).toBe('OK');
  expect(observed).toBe(1234);
});
`,
    );
    const runtime = text(workingDirectory, 'src/runtime.ts');
    const providerPreserved = text(workingDirectory, 'src/provider.ts') === PROVIDER_SOURCE;
    const schemaPreserved = text(workingDirectory, 'config/schema.json') === CONFIG_SCHEMA;
    const noLiteral = !/runProvider\([^;]*\b30000\b/su.test(runtime);
    const noParallelTimeout = (runtime.match(/timeoutMs/gu)?.length ?? 0) <= 4;
    let regression = false;
    let regressionEvidence =
      'Candidate regression tests were not exercised against the known-bad runtime.';
    try {
      writeFixtureFile(workingDirectory, 'src/runtime.ts', RUNTIME_SOURCE);
      const mutation = runCandidateBunTests(workingDirectory);
      regression = mutation.completed && !mutation.passed;
      regressionEvidence = mutation.evidence;
    } finally {
      writeFixtureFile(workingDirectory, 'src/runtime.ts', runtime);
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
      verification: hidden.passed ? 1 : 0,
      integrityFailure: !schemaPreserved,
      evidence: [
        `non-default timeout propagation: ${hidden.passed ? 'pass' : 'fail'}`,
        `hard-coded target literal: ${noLiteral ? 'removed' : 'still present'}`,
        `provider implementation: ${providerPreserved ? 'preserved' : 'refactored'}`,
        `public config schema: ${schemaPreserved ? 'preserved' : 'changed'}`,
        `known-bad hard-coded timeout rejected by candidate tests: ${regression ? 'yes' : 'no'}`,
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
