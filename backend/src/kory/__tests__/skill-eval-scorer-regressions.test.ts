import { afterEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CORE_EXECUTION_SKILL_EVAL_MATERIALIZERS,
  CORE_EXECUTION_SKILL_EVAL_SCORERS,
} from '../../eval/skills/skill-eval-core-execution-fixtures';
import {
  candidateBunTestFiles,
  runCandidateBunTests,
  writeFixtureFile,
} from '../../eval/skills/skill-eval-fixture-helpers';
import { VERIFICATION_CHILD_SKILL_EVAL_SCORERS } from '../../eval/skills/skill-eval-verification-children-fixtures';

const roots: string[] = [];

function workspace(): string {
  const root = mkdtempSync(join(tmpdir(), 'kory-scorer-regression-'));
  roots.push(root);
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('skill evaluator scorer regressions', () => {
  async function debuggingCandidate() {
    const root = workspace();
    const materializer = CORE_EXECUTION_SKILL_EVAL_MATERIALIZERS.find(
      (item) => item.id === 'debugging/empty-plugin-summary-crash@1',
    )!;
    const scorer = CORE_EXECUTION_SKILL_EVAL_SCORERS.find((item) =>
      item.scenarioIds.includes('debugging-full-task-1'),
    )!;
    await materializer.materialize(root, { id: 'debugging-full-task-1' } as never);
    const summary = readFileSync(join(root, 'src/plugin-summary.ts'), 'utf8');
    writeFixtureFile(
      root,
      'src/plugin-summary.ts',
      summary.replace(".reduce((left, right) => left + ', ' + right)", ".join(', ')"),
    );
    writeFixtureFile(
      root,
      '.kory-eval/debugging-1.json',
      JSON.stringify({
        observation: 'unavailable; commands were not run',
        sourceDerivedCause:
          'valid empty input reaches buildPluginSummary reduce without a seed; TypeError predicted',
      }),
    );
    return { root, scorer };
  }

  function debuggingRegression(root: string) {
    writeFixtureFile(
      root,
      'tests/empty-recovery.test.ts',
      `import { expect, test } from 'bun:test';
import { parseConfig } from '../src/config';
import { buildPluginSummary, normalizePlugins } from '../src/plugin-summary';
test('empty regression and later valid parse/build after rejection', () => {
  expect(buildPluginSummary(normalizePlugins(parseConfig('{"plugins":[]}').plugins))).toBe('');
  expect(() => parseConfig('{"plugins":null}')).toThrow(/array of strings/);
  expect(buildPluginSummary(normalizePlugins(parseConfig('{"plugins":[" next "]}').plugins))).toBe('[next]');
});
`,
    );
  }

  test('debugging rejects unchanged starter tests and unobserved keyword report', async () => {
    const { root, scorer } = await debuggingCandidate();
    const before = readFileSync(join(root, 'src/plugin-summary.ts'), 'utf8');
    const result = await scorer.score({ workingDirectory: root } as never);
    expect(result.passed).toBe(false);
    expect(result.verification).toBeLessThan(1);
    expect(result.evidence.join('\n')).toContain('Candidate-authored regression files: missing');
    expect(readFileSync(join(root, 'src/plugin-summary.ts'), 'utf8')).toBe(before);
  });

  test('debugging rejects a parser poisoned by invalid input even with a new empty regression', async () => {
    const { root, scorer } = await debuggingCandidate();
    writeFixtureFile(
      root,
      'tests/empty.test.ts',
      `import { expect, test } from 'bun:test';
import { buildPluginSummary, normalizePlugins } from '../src/plugin-summary';
test('empty summary regression', () => { expect(buildPluginSummary(normalizePlugins([]))).toBe(''); });
`,
    );
    const config = readFileSync(join(root, 'src/config.ts'), 'utf8');
    writeFixtureFile(
      root,
      'src/config.ts',
      'let rejected = false;\n' +
        config
          .replace(
            '  const parsed =',
            '  if (rejected) throw new Error("recovery poisoned");\n  const parsed =',
          )
          .replace(
            "    throw new Error('plugins",
            "    rejected = true;\n    throw new Error('plugins",
          ),
    );
    const result = await scorer.score({ workingDirectory: root } as never);
    expect(result.passed).toBe(false);
    expect(result.verification).toBeLessThan(1);
    expect(result.evidence.join('\n')).toContain('recovery poisoned');
  });

  test('debugging observes independent host baseline and authored red/green with real recovery', async () => {
    const { root, scorer } = await debuggingCandidate();
    debuggingRegression(root);
    const result = await scorer.score({ workingDirectory: root } as never);
    expect(scorer.id).toBe('debugging/empty-plugin-summary-crash-scorer@3');
    expect(result.passed, result.evidence.join('\n')).toBe(true);
    expect(result.verification).toBe(1);
    expect(result.evidence.join('\n')).toContain('independent post-response replays');
    expect(result.evidence.join('\n')).toContain('not historical or candidate-observed runs');
    expect(result.evidence.join('\n')).toContain('authored regression red/green: observed');
    expect(result.evidence.join('\n')).toContain('report text is not execution evidence');
  });

  test('debugging discovers changed starter and colocated tests with unchanged candidate helpers', async () => {
    const { root, scorer } = await debuggingCandidate();
    const originalTest = readFileSync(join(root, 'tests/plugin-summary.test.ts'), 'utf8');
    writeFixtureFile(
      root,
      'tests/summary-helper.ts',
      `import { parseConfig } from '../src/config';
import { buildPluginSummary, normalizePlugins } from '../src/plugin-summary';
export function summary(raw: string) { return buildPluginSummary(normalizePlugins(parseConfig(raw).plugins)); }
`,
    );
    writeFixtureFile(
      root,
      'tests/plugin-summary.test.ts',
      `${originalTest}
import { summary } from './summary-helper';
test('empty regression through helper', () => expect(summary('{"plugins":[]}')).toBe(''));
`,
    );
    writeFixtureFile(
      root,
      'src/recovery.spec.ts',
      `import { expect, test } from 'bun:test';
import { summary } from '../tests/summary-helper';
test('colocated recovery', () => {
  expect(() => summary('{"plugins":null}')).toThrow(/array of strings/);
  expect(summary('{"plugins":[" next "]}')).toBe('[next]');
});
`,
    );
    const before = readFileSync(join(root, 'tests/plugin-summary.test.ts'), 'utf8');
    const result = await scorer.score({ workingDirectory: root } as never);
    expect(result.passed, result.evidence.join('\n')).toBe(true);
    expect(result.evidence.join('\n')).toContain(
      'Candidate-authored regression files: src/recovery.spec.ts, tests/plugin-summary.test.ts.',
    );
    expect(readFileSync(join(root, 'tests/plugin-summary.test.ts'), 'utf8')).toBe(before);
    const replayPaths = [
      ...result.evidence.join('\n').matchAll(/\/[^\s()]*kory-debug-empty-replay-[^/\s()]+/gu),
    ].map((match) => match[0]);
    expect(replayPaths.length).toBeGreaterThan(0);
    for (const path of replayPaths) expect(existsSync(path)).toBe(false);
  });

  test('debugging preserves the submitted source when public tests mutate it', async () => {
    const { root, scorer } = await debuggingCandidate();
    debuggingRegression(root);
    const before = readFileSync(join(root, 'src/plugin-summary.ts'), 'utf8');
    writeFixtureFile(
      root,
      'tests/mutating.test.ts',
      `import { expect, test } from 'bun:test';
import { appendFileSync } from 'node:fs';
test('mutates the owning source', () => {
  appendFileSync(new URL('../src/plugin-summary.ts', import.meta.url), '\\n// changed by candidate tests\\n');
  expect(true).toBe(true);
});
`,
    );
    const result = await scorer.score({ workingDirectory: root } as never);
    expect(readFileSync(join(root, 'src/plugin-summary.ts'), 'utf8')).toBe(before);
    expect(result.passed).toBe(false);
    expect(result.verification).toBeLessThan(1);
    expect(result.evidence.join('\n')).toContain('Replay snapshot integrity: modified');
  });

  test('debugging CLI replay does not inherit ambient credentials', async () => {
    const { root, scorer } = await debuggingCandidate();
    debuggingRegression(root);
    const cli = readFileSync(join(root, 'src/cli.ts'), 'utf8');
    writeFixtureFile(
      root,
      'src/cli.ts',
      `if (process.env.KORY_EVAL_TEST_SECRET) throw new Error('ambient credential inherited');\n${cli}`,
    );
    const modulePath = new URL(
      '../../eval/skills/skill-eval-core-execution-fixtures.ts',
      import.meta.url,
    ).pathname;
    const probe = spawnSync(
      process.execPath,
      [
        '--no-env-file',
        '-e',
        `
import { CORE_EXECUTION_SKILL_EVAL_SCORERS } from ${JSON.stringify(modulePath)};
const scorer = CORE_EXECUTION_SKILL_EVAL_SCORERS.find(item => item.id === ${JSON.stringify(scorer.id)});
console.log(JSON.stringify(await scorer.score({ workingDirectory: ${JSON.stringify(root)} })));
`,
      ],
      {
        cwd: tmpdir(),
        env: {
          PATH: process.env.PATH ?? '',
          KORY_EVAL_TEST_SECRET: 'synthetic-canary-not-a-real-credential',
        },
        encoding: 'utf8',
        timeout: 15_000,
        maxBuffer: 1_000_000,
      },
    );
    expect(probe.error).toBeUndefined();
    expect(probe.status, probe.stderr).toBe(0);
    const result = JSON.parse(probe.stdout) as { passed: boolean; evidence: string[] };
    expect(result.passed, result.evidence.join('\n')).toBe(true);
    expect(result.evidence.join('\n')).not.toContain('ambient credential inherited');
  });

  test('debugging rejects successful CLI output that does not show the empty summary', async () => {
    const { root, scorer } = await debuggingCandidate();
    debuggingRegression(root);
    writeFixtureFile(root, 'src/cli.ts', "console.log('plugins: [incorrect]');\n");
    const result = await scorer.score({ workingDirectory: root } as never);
    expect(result.passed).toBe(false);
    expect(result.verification).toBeLessThan(1);
    expect(result.evidence.join('\n')).toContain(
      'actual CLI after fix host replay: unavailable or failed',
    );
  });

  test('debugging retains a real red failure even when later output exceeds the evidence excerpt', async () => {
    const { root, scorer } = await debuggingCandidate();
    debuggingRegression(root);
    const regression = readFileSync(join(root, 'tests/empty-recovery.test.ts'), 'utf8');
    writeFixtureFile(
      root,
      'tests/empty-recovery.test.ts',
      `${regression}
import { afterAll } from 'bun:test';
afterAll(() => { process.stderr.write('bounded diagnostic padding '.repeat(200)); });
`,
    );
    const result = await scorer.score({ workingDirectory: root } as never);
    expect(result.passed, result.evidence.join('\n')).toBe(true);
    expect(result.evidence.join('\n')).toContain('authored regression red/green: observed');
  });

  test('selected Bun tests remain bounded by discovery and cannot repeat or run arbitrary scripts', () => {
    const root = workspace();
    writeFixtureFile(
      root,
      'tests/selected.test.ts',
      `import { expect, test } from 'bun:test';
test('selected', () => expect(true).toBe(true));\n`,
    );
    writeFixtureFile(
      root,
      'tests/unselected.test.ts',
      `import { expect, test } from 'bun:test';
test('unselected failure', () => expect(true).toBe(false));\n`,
    );
    writeFixtureFile(
      root,
      'helper.ts',
      `import { expect, test } from 'bun:test';
test('not a discovered test', () => expect(true).toBe(true));\n`,
    );
    expect(candidateBunTestFiles(root)).toEqual([
      'tests/selected.test.ts',
      'tests/unselected.test.ts',
    ]);
    expect(runCandidateBunTests(root, ['tests/selected.test.ts'])).toMatchObject({
      completed: true,
      passed: true,
      exitStatus: 0,
    });
    expect(runCandidateBunTests(root)).toMatchObject({ completed: true, passed: false });
    for (const selected of [
      [],
      ['helper.ts'],
      Array(101).fill('tests/selected.test.ts'),
      ['../escape.test.ts'],
    ]) {
      expect(runCandidateBunTests(root, selected)).toMatchObject({
        completed: false,
        passed: false,
        exitStatus: null,
      });
    }
  });

  test('debugging rejects excessive file, byte, entry, and depth snapshot inputs', async () => {
    for (const budget of ['file-size', 'file-count', 'bytes', 'entry', 'depth']) {
      const { root, scorer } = await debuggingCandidate();
      debuggingRegression(root);
      const before = readFileSync(join(root, 'src/plugin-summary.ts'), 'utf8');
      if (budget === 'file-size') writeFixtureFile(root, 'oversized.txt', 'x'.repeat(2_000_001));
      if (budget === 'file-count') {
        for (let index = 0; index < 201; index++)
          writeFixtureFile(root, `file-${index}.txt`, 'bounded');
      }
      if (budget === 'bytes') {
        for (let index = 0; index < 3; index++)
          writeFixtureFile(root, `large-${index}.txt`, 'x'.repeat(1_500_000));
      }
      if (budget === 'entry') {
        for (let index = 0; index < 401; index++) mkdirSync(join(root, `empty-${index}`));
      }
      if (budget === 'depth')
        mkdirSync(join(root, ...Array(7).fill('nested')), { recursive: true });
      const result = await scorer.score({ workingDirectory: root } as never);
      expect(result.passed, budget).toBe(false);
      expect(result.verification, budget).toBeLessThan(1);
      expect(result.evidence.join('\n')).toContain('Host replay unavailable:');
      expect(readFileSync(join(root, 'src/plugin-summary.ts'), 'utf8')).toBe(before);
    }
  });

  test('candidate test deadline terminates a process that ignores SIGTERM', () => {
    const root = workspace();
    writeFixtureFile(
      root,
      'tests/hanging.test.ts',
      `process.on('SIGTERM', () => {});
setInterval(() => {}, 50);
await new Promise(() => {});
`,
    );
    const start = Date.now();
    const result = runCandidateBunTests(root);
    expect(result).toMatchObject({ completed: false, passed: false, exitStatus: null });
    expect(result.evidence).toContain('did not complete');
    expect(Date.now() - start).toBeLessThan(20_000);
  }, 25_000);

  test('debugging fails closed when the disposable replay cannot copy unsafe input', async () => {
    const { root, scorer } = await debuggingCandidate();
    debuggingRegression(root);
    symlinkSync(join(root, 'src/config.ts'), join(root, 'replay-link.txt'));
    const result = await scorer.score({ workingDirectory: root } as never);
    expect(result.passed).toBe(false);
    expect(result.verification).toBeLessThan(1);
    expect(result.evidence.join('\n')).toContain('Host replay unavailable:');
  });

  test('debugging race requires an observed red/green regression, not comment-only claims', async () => {
    const root = workspace();
    const materializer = CORE_EXECUTION_SKILL_EVAL_MATERIALIZERS.find(
      (item) => item.id === 'debugging/cancel-complete-race@1',
    )!;
    const scorer = CORE_EXECUTION_SKILL_EVAL_SCORERS.find((item) =>
      item.scenarioIds.includes('debugging-full-task-2'),
    )!;
    await materializer.materialize(root, { id: 'debugging-full-task-2' } as never);
    const initial = readFileSync(join(root, 'src/job-runner.ts'), 'utf8');
    const fixed = initial.replace(
      'this.providerResolved = true;',
      "this.providerResolved = true;\n    this.commitTerminal('completed');",
    );
    writeFixtureFile(root, 'src/job-runner.ts', fixed);
    writeFixtureFile(
      root,
      '.kory-eval/debugging-2.json',
      JSON.stringify({
        preFix: { 'complete-before-cancel': 'cancelled', 'cancel-before-complete': 'cancelled' },
        hypothesis:
          'The providerResolved marker delays terminal ownership and loses the transition',
        owner: 'commitTerminal',
        postFix: { 'complete-before-cancel': 'completed', 'cancel-before-complete': 'cancelled' },
      }),
    );
    // A keyword list in a comment must never be treated as a behavioral assertion.
    writeFixtureFile(
      root,
      'tests/claimed-regression.test.ts',
      `import { expect, test } from 'bun:test';
// complete-before-cancel cancel-before-complete completed cancelled
test('claim', () => { expect(true).toBe(true); });
`,
    );
    const commentsOnly = await scorer.score({ workingDirectory: root } as never);
    expect(scorer.id).toBe('debugging/cancel-complete-race-scorer@2');
    expect(commentsOnly.passed).toBe(false);
    expect(commentsOnly.verification).toBeLessThan(1);
    expect(commentsOnly.evidence.join('\n')).toContain(
      'authored race regression red/green: missing or failed',
    );

    writeFixtureFile(
      root,
      'tests/claimed-regression.test.ts',
      `import { expect, test } from 'bun:test';
import { JobRunner, runSchedule } from '../src/job-runner';
test('both deterministic schedules and terminal idempotence', () => {
  expect(runSchedule('complete-before-cancel')).toBe('completed');
  expect(runSchedule('cancel-before-complete')).toBe('cancelled');
  const runner = new JobRunner();
  runner.onProviderResolved();
  runner.requestCancellation();
  runner.flushProviderCompletion();
  expect(runner.status()).toBe('completed');
});
`,
    );
    const accepted = await scorer.score({ workingDirectory: root } as never);
    expect(accepted.passed, accepted.evidence.join('\n')).toBe(true);
    expect(accepted.verification).toBe(1);
    expect(accepted.evidence.join('\n')).toContain('authored race regression red/green: observed');
    expect(readFileSync(join(root, 'src/job-runner.ts'), 'utf8')).toBe(fixed);
  }, 30_000);

  test('performance release gate accepts status FAIL with bounded no-diagnosis prose and rejects a real diagnosis', async () => {
    const root = workspace();
    const artifact = {
      environment: {
        candidate: 'candidate-91f',
        baseline: 'v4.7.2',
        workload: {
          records: 1_000_000,
          requestMix: [70, 20, 10],
          targetRps: 400,
          concurrency: 40,
        },
        baselineComparability: 'equivalent workload and runtime',
      },
      warmup: { seconds: 120, excluded: true },
      measuredRuns: [
        {
          p95: 161,
          p99: 382,
          throughput: 399,
          errorRate: 0.18,
          cpu: 72,
          queue: false,
          generatorCpu: 43,
          correctness: true,
        },
        {
          p95: 166,
          p99: 371,
          throughput: 398,
          errorRate: 0.22,
          cpu: 74,
          queue: false,
          generatorCpu: 45,
          correctness: true,
        },
        {
          p95: 159,
          p99: 365,
          throughput: 400,
          errorRate: 0.17,
          cpu: 71,
          queue: false,
          generatorCpu: 42,
          correctness: true,
        },
      ],
      repeatVariance: { p99Range: 17 },
      gates: { p95: 180, p99: 350 },
      decisionScope: 'Release verification only; no diagnosis or remediation was performed.',
      verdict: {
        status: 'FAIL',
        reason: 'p99 exceeds 350 while p95 passes',
        diagnosisAttempted: false,
        boundedConclusion: 'Do not release under the declared performance contract.',
        causeDetermination: 'Out of scope and not attempted.',
      },
    };
    writeFixtureFile(
      root,
      '.kory-eval/performance-api.json',
      `${JSON.stringify(artifact, null, 2)}\n`,
    );
    const scorer = VERIFICATION_CHILD_SKILL_EVAL_SCORERS.find(
      (item) => item.id === 'performance-verification/api-release-gate-scorer@4',
    );
    expect(scorer).toBeDefined();
    const accepted = await scorer!.score({ workingDirectory: root } as never);
    expect(accepted.passed, accepted.evidence.join('\n')).toBe(true);

    writeFixtureFile(
      root,
      '.kory-eval/performance-api.json',
      `${JSON.stringify({ ...artifact, diagnosis: 'cache contention is the root cause' }, null, 2)}\n`,
    );
    const rejected = await scorer!.score({ workingDirectory: root } as never);
    expect(rejected.passed).toBe(false);
  });

  test('implementation field scorer accepts the existing two-model path and rejects a parallel model', async () => {
    const root = workspace();
    const materializer = CORE_EXECUTION_SKILL_EVAL_MATERIALIZERS.find(
      (item) => item.id === 'implementation/thread-existing-field@1',
    );
    expect(materializer).toBeDefined();
    await materializer!.materialize(root, { id: 'implementation-full-task-1' } as never);

    const source = `export interface LoadedSkillPackage {
  name: string;
  sourceCount: number;
  version: string;
}

export interface SkillSummary {
  name: string;
  sourceCount: number;
  version: string;
}

export function loadSkillPackage(input: { name: string; sources: string[]; version: string }): LoadedSkillPackage {
  return { name: input.name, sourceCount: input.sources.length, version: input.version };
}

export function summarizeSkill(pkg: LoadedSkillPackage): SkillSummary {
  return { name: pkg.name, sourceCount: pkg.sourceCount, version: pkg.version };
}
`;
    writeFixtureFile(root, 'src/skills.ts', source);
    writeFixtureFile(
      root,
      'tests/skill-summary.test.ts',
      `import { expect, test } from 'bun:test';
import { loadSkillPackage, summarizeSkill } from '../src/skills';
test('sourceCount is present in the summary response', () => {
  expect(summarizeSkill(loadSkillPackage({ name: 'alpha', sources: ['a', 'b', 'c'], version: '1.2.0' }))).toEqual({ name: 'alpha', sourceCount: 3, version: '1.2.0' });
});
`,
    );

    const scorer = CORE_EXECUTION_SKILL_EVAL_SCORERS.find(
      (item) => item.id === 'implementation/thread-existing-field-scorer@2',
    );
    expect(scorer).toBeDefined();
    const accepted = await scorer!.score({ workingDirectory: root } as never);
    expect(accepted.passed, accepted.evidence.join('\n')).toBe(true);

    writeFixtureFile(
      root,
      'src/skills.ts',
      `${source}\ninterface ParallelSkillMetadata { sourceCount: number }\n`,
    );
    const rejected = await scorer!.score({ workingDirectory: root } as never);
    expect(rejected.passed).toBe(false);
  });
});
