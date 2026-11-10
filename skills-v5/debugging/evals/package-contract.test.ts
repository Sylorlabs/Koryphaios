/** Package-local authoring and evaluator-integrity checks, not qualification evidence. */
import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { createTaskContract } from '../../../backend/src/kory/prompts';
import {
  CORE_EXECUTION_SKILL_EVAL_MATERIALIZERS,
  CORE_EXECUTION_SKILL_EVAL_SCORERS,
} from '../../../backend/src/kory/skill-eval-core-execution-fixtures';
import { auditSkillEvalExecutionReadiness } from '../../../backend/src/kory/skill-eval-execution';
import { writeFixtureFile } from '../../../backend/src/kory/skill-eval-fixture-helpers';
import {
  isDirectSkillSelection,
  resolveSkills,
  type SkillRevision,
} from '../../../backend/src/kory/skills';
import {
  loadV5SkillPackages,
  validateV5SkillPackage,
} from '../../../backend/src/kory/skill-packages';

const packageRoot = resolve(import.meta.dir, '..');
const packageName = 'debugging';
const taskIds = ['debugging-full-task-1', 'debugging-full-task-2'];

function validatedPackage() {
  const result = validateV5SkillPackage(packageRoot);
  expect(result.errors).toEqual([]);
  expect(result.warnings).toEqual([]);
  expect(result.valid).toBe(true);
  expect(result.package).toBeDefined();
  return result.package!;
}

function packageRevisions(): SkillRevision[] {
  const packages = loadV5SkillPackages().packages;
  const byName = new Map(packages.map((pkg) => [pkg.sidecar.name, pkg]));
  const depth = (name: string): number => {
    const parents = byName.get(name)!.sidecar.broader;
    return parents.length ? 1 + Math.max(...parents.map(depth)) : 0;
  };
  return packages.map((pkg) => {
    const hash = createHash('sha256').update(pkg.sourceContent).digest('hex');
    return {
      name: pkg.sidecar.name,
      description: pkg.definition.description,
      source: 'project',
      state: 'active',
      path: pkg.sourcePath,
      storageVersion: 1,
      document: {
        format: 'markdown',
        extension: '.md',
        renderer: 'markdown',
        mediaType: 'text/markdown',
      },
      sourceContent: pkg.sourceContent,
      coreInstructions: pkg.instructions,
      content: pkg.sourceContent,
      instructions: pkg.instructions,
      metadata: {
        ...pkg.sidecar,
        baseVersion: pkg.sidecar.version,
        baseHash: hash,
        parent: pkg.sidecar.broader[0],
        depth: depth(pkg.sidecar.name),
        sourceScope: 'local-only',
        shouldTrigger: pkg.sidecar.routing.positive,
        shouldNotTrigger: pkg.sidecar.routing.negative,
      },
      hash,
      validation: { valid: true, errors: [], warnings: [], ignoredAuthorityClaims: [] },
    };
  });
}

function scenarioFor(task: ReturnType<typeof validatedPackage>['evaluation']['tasks'][number]) {
  return {
    ...task,
    skill: packageName,
    category: 'full-task' as const,
    expectedSelection: true,
    expectedSkills: [],
    forbiddenSkills: [],
    heldOut: true,
    adjacentSkills: [],
    tags: ['held-out', 'full-task'],
  };
}

function scoreInput(workingDirectory: string) {
  return {
    scenario: {} as never,
    experiment: {} as never,
    workingDirectory,
    observation: { output: '', evidence: [], artifacts: [], durationMs: 0 },
  } as never;
}

test('package metadata, source map, and routing corpus preserve the current boundaries', () => {
  const pkg = validatedPackage();
  expect(pkg.sidecar.version).toBe('5.0.1');
  expect(pkg.sidecar.broader).toEqual([]);
  expect(pkg.sidecar.requires).toEqual([]);
  expect(pkg.sidecar.routing.positive).toHaveLength(5);
  expect(pkg.sidecar.routing.negative).toHaveLength(5);
  expect(pkg.sidecar.routing.ambiguous).toHaveLength(3);
  expect(pkg.sidecar.routing.adversarial).toHaveLength(3);
  expect(pkg.evaluation.routing).toHaveLength(16);
  expect(pkg.evaluation.tasks.map((task) => task.id).sort()).toEqual([...taskIds].sort());
  expect(pkg.evaluation.routing.every((row) => row.selectionScope === 'direct')).toBe(true);

  const counts = pkg.evaluation.routing.reduce<Record<string, number>>((acc, row) => {
    acc[row.category] = (acc[row.category] ?? 0) + 1;
    return acc;
  }, {});
  expect(counts).toEqual({ positive: 5, negative: 5, ambiguous: 3, adversarial: 3 });
  expect(new Set(pkg.evaluation.routing.map((row) => row.id)).size).toBe(16);

  for (const task of pkg.evaluation.tasks) {
    expect(task.maturity).toBe('individual');
    expect(task.scorers.reduce((sum, scorer) => sum + scorer.weight, 0)).toBeCloseTo(1);
    expect(task.scorers.some((scorer) => scorer.kind === 'deterministic')).toBe(true);
    expect(
      task.scorers.some(
        (scorer) =>
          scorer.kind === 'blind-semantic' &&
          scorer.blindTo?.includes('skill-variant') &&
          scorer.blindTo?.includes('expected-outcome'),
      ),
    ).toBe(true);
    expect(task.prompt).toMatch(/command/u);
    expect(task.prompt).toMatch(/control/u);
    expect(task.prompt).toMatch(/negative|invalid|in-flight/u);
    expect(task.prompt).toMatch(/recovery|idempotence/u);
    expect(task.requiredEvidence.join('\n')).toMatch(/command|observed status/u);
  }

  const sourceMap = readFileSync(resolve(packageRoot, 'references/sources.md'), 'utf8');
  for (const source of pkg.sidecar.sources) {
    expect(sourceMap).toContain(source.url);
    expect(sourceMap).toContain(`Verified: ${source.verifiedAt}.`);
    expect(sourceMap.toLowerCase()).toContain(`refresh after ${source.staleAfterDays} days.`);
  }
  for (const path of ['SKILL.md', 'references/sources.md', 'evals/README.md']) {
    const absolute = resolve(packageRoot, path);
    const markdown = readFileSync(absolute, 'utf8');
    for (const [, link] of markdown.matchAll(/\[[^\]]+\]\(([^)#]+)(?:#[^)]*)?\)/g)) {
      if (/^[a-z]+:\/\//i.test(link!)) continue;
      const target = resolve(dirname(absolute), link!);
      expect(relative(packageRoot, target).startsWith('..'), `${path}: ${link}`).toBe(false);
      expect(existsSync(target), `${path}: ${link}`).toBe(true);
    }
  }
});

test('public, held-out, ambiguous, and adversarial cases route through the real resolver', () => {
  const pkg = validatedPackage();
  const root = mkdtempSync(join(tmpdir(), 'kory-debugging-routing-'));
  try {
    const cases = [
      ...pkg.sidecar.routing.positive.map((prompt, index) => ({
        id: `public-positive-${index}`,
        prompt,
        expectedSelection: true,
        expectedSkills: [],
        forbiddenSkills: [],
      })),
      ...pkg.sidecar.routing.negative.map((prompt, index) => ({
        id: `public-negative-${index}`,
        prompt,
        expectedSelection: false,
        expectedSkills: [],
        forbiddenSkills: [],
      })),
      ...pkg.sidecar.routing.ambiguous,
      ...pkg.sidecar.routing.adversarial,
      ...pkg.evaluation.routing,
    ];
    const failures: unknown[] = [];
    for (const row of cases) {
      const result = resolveSkills(root, row.prompt, createTaskContract(row.prompt), {
        skillRevisions: packageRevisions(),
        contextBudget: 60_000,
      });
      const target = result.selected.find((item) => item.skill.name === packageName);
      const direct = Boolean(target && isDirectSkillSelection(target));
      const selected = result.selected.map((item) => item.skill.name);
      const missing = row.expectedSkills.filter((name) => !selected.includes(name));
      const forbidden = row.forbiddenSkills.filter((name) => selected.includes(name));
      if (
        result.blocked ||
        direct !== row.expectedSelection ||
        missing.length ||
        forbidden.length
      ) {
        failures.push({
          id: row.id,
          direct,
          expected: row.expectedSelection,
          selected,
          missing,
          forbidden,
        });
      }
    }
    expect(failures).toEqual([]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('both registered debugging fixtures reject starters and accept focused corrected candidates', async () => {
  const pkg = validatedPackage();
  const readiness = auditSkillEvalExecutionReadiness(
    [pkg],
    CORE_EXECUTION_SKILL_EVAL_MATERIALIZERS,
    CORE_EXECUTION_SKILL_EVAL_SCORERS,
  );
  expect(readiness.map((row) => row.scenarioId).sort()).toEqual([...taskIds].sort());
  for (const row of readiness) {
    expect(row.ready, row.reasons.join('\n')).toBe(true);
    expect(row.materializerId).toBeTruthy();
    expect(row.deterministicScorerId).toBeTruthy();
  }

  const roots: string[] = [];
  try {
    for (const task of pkg.evaluation.tasks) {
      const scenario = scenarioFor(task);
      const materializer = CORE_EXECUTION_SKILL_EVAL_MATERIALIZERS.find((item) =>
        item.matches(scenario),
      );
      const scorer = CORE_EXECUTION_SKILL_EVAL_SCORERS.find((item) =>
        item.scenarioIds.includes(task.id),
      );
      expect(materializer).toBeDefined();
      expect(scorer).toBeDefined();
      const root = mkdtempSync(join(tmpdir(), `kory-debugging-${task.id}-`));
      roots.push(root);
      await materializer!.materialize(root, scenario);

      const starter = await scorer!.score(scoreInput(root));
      expect(starter.passed).toBe(false);
      expect(starter.integrityFailure).toBe(false);

      if (task.id === 'debugging-full-task-1') {
        writeFixtureFile(
          root,
          'src/plugin-summary.ts',
          `export function normalizePlugins(plugins: string[]): string[] {
  return plugins.map((plugin) => plugin.trim()).filter(Boolean);
}

export function buildPluginSummary(plugins: string[]): string {
  return plugins.map((plugin) => '[' + plugin + ']').join(', ');
}
`,
        );
        writeFixtureFile(
          root,
          'tests/empty-plugin-summary.test.ts',
          `import { expect, test } from 'bun:test';
import { parseConfig } from '../src/config';
import { buildPluginSummary, normalizePlugins } from '../src/plugin-summary';

test('valid empty plugins stay usable while invalid config remains rejected', () => {
  expect(buildPluginSummary(normalizePlugins(parseConfig('{"plugins":[]}').plugins))).toBe('');
  expect(() => parseConfig('{"plugins":null}')).toThrow(/array of strings/);
  expect(buildPluginSummary(normalizePlugins(parseConfig('{"plugins":["next"]}').plugins))).toBe('[next]');
});
`,
        );
        writeFixtureFile(
          root,
          '.kory-eval/debugging-1.json',
          `${JSON.stringify(
            {
              command: 'bun run src/cli.ts fixture/empty.json',
              environment: 'synthetic Bun CLI fixture, starting revision',
              preFix: 'TypeError: Reduce of empty array with no initial value',
              hypotheses: ['parser rejection', 'normalization loss', 'summary reduce ownership'],
              trace: 'parse config -> normalize plugins -> buildPluginSummary -> reduce',
              firstInvalidAssumption: 'buildPluginSummary assumes a non-empty mapped plugin list',
              owningBoundary: 'src/plugin-summary.ts buildPluginSummary',
              control: 'non-empty plugins produce [next]',
              negative: 'plugins:null remains rejected',
              recovery: 'a later valid config produces [next] after the rejected input',
              postFix: 'empty plugins produce an empty string',
            },
            null,
            2,
          )}\n`,
        );
      } else {
        writeFixtureFile(
          root,
          'src/job-runner.ts',
          `export type TerminalStatus = 'running' | 'completed' | 'cancelled';

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
    this.providerResolved = true;
    this.commitTerminal('completed');
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
`,
        );
        writeFixtureFile(
          root,
          'tests/two-order.test.ts',
          `import { expect, test } from 'bun:test';
import { JobRunner, runSchedule } from '../src/job-runner';

test('both orders keep exactly one terminal owner', () => {
  expect(runSchedule('complete-before-cancel')).toBe('completed');
  expect(runSchedule('cancel-before-complete')).toBe('cancelled');
  const runner = new JobRunner();
  runner.onProviderResolved();
  runner.requestCancellation();
  expect(runner.status()).toBe('completed');
});
`,
        );
        writeFixtureFile(
          root,
          '.kory-eval/debugging-2.json',
          `${JSON.stringify(
            {
              command: 'bun run scripts/reproduce.ts',
              environment: 'synthetic deterministic scheduler fixture, starting revision',
              schedules: {
                'complete-before-cancel': 'cancelled before fix, completed after fix',
                'cancel-before-complete': 'cancelled before and after fix',
              },
              hypotheses: [
                'provider callback timing',
                'cancellation semantics',
                'terminal ownership',
              ],
              firstInvalidTransition:
                'completion is observed but terminal ownership is deferred until flush',
              owningBoundary: 'src/job-runner.ts JobRunner.onProviderResolved / commitTerminal',
              control: 'cancellation-before-completion remains cancelled',
              recovery: 'later cancellation cannot overwrite completed terminal state',
              postFix: 'one terminal winner for both schedules, with no sleep or delay',
            },
            null,
            2,
          )}\n`,
        );
      }

      const corrected = await scorer!.score(scoreInput(root));
      expect(corrected.passed, corrected.evidence.join('\n')).toBe(true);
      expect(corrected.integrityFailure).toBe(false);
    }
  } finally {
    for (const root of roots) rmSync(root, { recursive: true, force: true });
  }
});
