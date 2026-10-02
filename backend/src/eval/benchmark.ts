import { join } from 'node:path';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';

/** Disposable workspaces prevent accidental reuse, but are NOT an OS sandbox.
 * Runner adapters must enforce their own filesystem/network confinement. */
export interface EvalTask {
  id: string;
  name: string;
  description: string;
  setup?: (workspaceDir: string, signal: AbortSignal) => Promise<void>;
  verify: (workspaceDir: string, signal: AbortSignal) => Promise<boolean>;
  maxTurns?: number;
  timeout?: number;
}

export interface EvalExecution {
  turns: number;
  tokensUsed?: number;
  costUsd?: number;
  humanInterventions?: number;
}

export interface EvalContext {
  task: Readonly<Pick<EvalTask, 'id' | 'name' | 'description' | 'maxTurns'>>;
  signal: AbortSignal;
}

export type EvalRunner = (workspaceDir: string, context: EvalContext) => Promise<EvalExecution>;

export interface EvalResult {
  taskId: string;
  success: boolean;
  durationMs: number;
  turns: number | null;
  tokensUsed: number | null;
  costUsd: number | null;
  humanInterventions: number | null;
  error?: string;
  /** Retained when an adapter ignored cancellation. Never delete under a writer. */
  retainedWorkspace?: string;
}

export interface EvalReport {
  schemaVersion: 1;
  suite: 'core-fixtures-v1';
  taskManifestHash: string;
  runnerIdentity: string;
  timestamp: number;
  totalTasks: number;
  passedTasks: number;
  failedTasks: number;
  passRate: number;
  avgDurationMs: number;
  totalCostUsd: number | null;
  totalHumanInterventions: number | null;
  results: EvalResult[];
}

/** Trusted verification source stays outside the agent workspace until the
 * runner has settled. Agent code executes only in a bounded child process,
 * with no ambient API keys or .env loading. This is still not confinement. */
function verifyProgram(workspace: string, program: string, signal: AbortSignal): boolean {
  signal.throwIfAborted();
  const verifier = mkdtempSync(join(tmpdir(), 'kory-verifier-'));
  try {
    const entry = join(verifier, 'verify.ts');
    const completion = `verified:${randomUUID()}`;
    writeFileSync(entry, program + `\nprocess.stdout.write(${JSON.stringify(completion)});\n`, {
      mode: 0o600,
    });
    const env: Record<string, string> = { NODE_ENV: 'test', HOME: verifier, USERPROFILE: verifier };
    for (const key of ['PATH', 'SystemRoot', 'SYSTEMROOT', 'WINDIR', 'TMPDIR', 'TEMP', 'TMP']) {
      if (process.env[key]) env[key] = process.env[key]!;
    }
    const result = spawnSync(process.execPath, ['--no-env-file', entry, workspace], {
      cwd: verifier,
      env,
      timeout: 5_000,
      killSignal: 'SIGKILL',
      maxBuffer: 64 * 1024,
      stdio: 'pipe',
    });
    return (
      !result.error &&
      result.status === 0 &&
      result.stdout.toString() === completion &&
      !signal.aborted
    );
  } finally {
    rmSync(verifier, { recursive: true, force: true });
  }
}

// Keep the verification oracle private to this module. Importing a candidate
// into the same process as node:assert lets untrusted candidate code mutate the
// module cache and disable the oracle before it runs.
const importPreamble = `
import { join } from 'node:path';
const root = process.argv[2];
const assert = Object.freeze({
  equal(actual: unknown, expected: unknown) {
    if (!Object.is(actual, expected)) throw new Error('verification mismatch');
  },
  deepEqual(actual: unknown, expected: unknown) {
    if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error('verification mismatch');
  },
  ok(value: unknown) {
    if (!value) throw new Error('verification assertion failed');
  },
});\n`;

export const BENCHMARK_TASKS: EvalTask[] = [
  {
    id: 'create-hello-world',
    name: 'Module contract smoke test',
    description: 'Create hello.ts exporting a default function returning "world".',
    verify: async (dir, signal) =>
      verifyProgram(
        dir,
        importPreamble +
          `const m = await import(join(root, 'hello.ts')); assert.equal(m.default(), 'world');`,
        signal,
      ),
    maxTurns: 2,
    timeout: 30_000,
  },
  {
    id: 'fix-failing-test',
    name: 'Repair arithmetic without changing its contract',
    description:
      'Fix add in math.ts so it adds finite numbers, including negatives and fractions. Preserve its named export.',
    setup: async (dir) => {
      writeFileSync(
        join(dir, 'math.ts'),
        'export function add(a: number, b: number) { return a - b; }\n',
      );
      writeFileSync(
        join(dir, 'math.test.ts'),
        'import {test, expect} from "bun:test"; import {add} from "./math"; test("add", () => expect(add(2,2)).toBe(4));\n',
      );
    },
    verify: async (dir, signal) =>
      verifyProgram(
        dir,
        importPreamble +
          `const { add } = await import(join(root, 'math.ts')); for (const [a,b] of [[2,2],[-3,7],[0,0],[1.25,2.5],[-5,-2]]) assert.equal(add(a,b), a+b);`,
        signal,
      ),
    maxTurns: 3,
    timeout: 45_000,
  },
  {
    id: 'coalesce-concurrent-loads',
    name: 'Repair concurrent cache and rejection recovery',
    description:
      'Fix createCache in cache.ts. Concurrent get(key) calls must share one in-flight loader call per key. Cache successful values, evict failed attempts so the next call retries, and keep different keys independent. Preserve createCache(load) returning {get(key)}.',
    setup: async (dir) => {
      writeFileSync(
        join(dir, 'cache.ts'),
        'export function createCache(load: (key: string) => Promise<string>) { const values = new Map<string, string>(); return { async get(key: string) { if (values.has(key)) return values.get(key)!; const value = await load(key); values.set(key, value); return value; } }; }\n',
      );
    },
    verify: async (dir, signal) =>
      verifyProgram(
        dir,
        importPreamble +
          `
const {createCache} = await import(join(root, 'cache.ts'));
let calls = 0;
const cache = createCache(async (key) => { calls++; await new Promise(r => setTimeout(r, 5)); return key + '!'; });
assert.deepEqual(await Promise.all([cache.get('a'),cache.get('a'),cache.get('b')]), ['a!','a!','b!']);
assert.equal(calls, 2); assert.equal(await cache.get('a'), 'a!'); assert.equal(calls, 2);
let attempts = 0;
const retry = createCache(async () => { if (++attempts === 1) throw new Error('retry'); return 'ok'; });
const failed = await Promise.allSettled([retry.get('x'), retry.get('x')]);
assert.ok(failed.every(r => r.status === 'rejected')); assert.equal(attempts, 1);
assert.equal(await retry.get('x'), 'ok'); assert.equal(attempts, 2);
`,
        signal,
      ),
    maxTurns: 6,
    timeout: 90_000,
  },
];

function validMetric(value: number | undefined, name: string, integer = false): number | null {
  if (value === undefined) return null;
  if (!Number.isFinite(value) || value < 0 || (integer && !Number.isInteger(value))) {
    throw new Error(`Invalid runner metric: ${name}`);
  }
  return value;
}

export class EphemeralHarness {
  constructor(
    private readonly options: { runnerIdentity?: string; cancellationGraceMs?: number } = {},
  ) {}

  async runTask(task: EvalTask, agentRunner: EvalRunner): Promise<EvalResult> {
    const timeout = task.timeout ?? 60_000;
    const grace = this.options.cancellationGraceMs ?? 1_000;
    if (!Number.isFinite(timeout) || timeout <= 0 || !Number.isFinite(grace) || grace < 0) {
      throw new Error('Evaluation deadlines must be finite and positive (grace may be zero)');
    }
    if (task.maxTurns !== undefined && (!Number.isInteger(task.maxTurns) || task.maxTurns < 1)) {
      throw new Error('maxTurns must be a positive integer');
    }
    const workspace = mkdtempSync(join(tmpdir(), 'kory-eval-'));
    const started = performance.now();
    const controller = new AbortController();
    let settled = false;
    let expired = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let graceTimer: ReturnType<typeof setTimeout> | undefined;
    const result: EvalResult = {
      taskId: task.id,
      success: false,
      durationMs: 0,
      turns: null,
      tokensUsed: null,
      costUsd: null,
      humanInterventions: null,
    };
    const operation = (async () => {
      await task.setup?.(workspace, controller.signal);
      controller.signal.throwIfAborted();
      const metrics = await agentRunner(workspace, {
        task: Object.freeze({
          id: task.id,
          name: task.name,
          description: task.description,
          maxTurns: task.maxTurns,
        }),
        signal: controller.signal,
      });
      controller.signal.throwIfAborted();
      if (metrics.turns === undefined) throw new Error('Runner must report turns');
      result.turns = validMetric(metrics.turns, 'turns', true);
      result.tokensUsed = validMetric(metrics.tokensUsed, 'tokensUsed', true);
      result.costUsd = validMetric(metrics.costUsd, 'costUsd');
      result.humanInterventions = validMetric(
        metrics.humanInterventions,
        'humanInterventions',
        true,
      );
      if (task.maxTurns !== undefined && metrics.turns > task.maxTurns)
        throw new Error('Turn budget exceeded');
      result.success = await task.verify(workspace, controller.signal);
      controller.signal.throwIfAborted();
      if (performance.now() - started >= timeout) throw new Error('Evaluation timeout');
    })()
      .catch((error: unknown) => {
        result.success = false;
        result.error = error instanceof Error ? error.message : String(error);
      })
      .finally(() => {
        settled = true;
      });

    try {
      await Promise.race([
        operation,
        new Promise<void>((resolve) => {
          timer = setTimeout(() => {
            expired = true;
            controller.abort(new Error('Evaluation timeout'));
            resolve();
          }, timeout);
        }),
      ]);
      if (expired && !settled) {
        await Promise.race([
          operation,
          new Promise<void>((resolve) => {
            graceTimer = setTimeout(resolve, grace);
          }),
        ]);
      }
      if (expired) {
        result.success = false;
        result.error = 'Evaluation timeout';
      }
    } finally {
      clearTimeout(timer);
      clearTimeout(graceTimer);
      result.durationMs = performance.now() - started;
      if (settled) {
        try {
          rmSync(workspace, { recursive: true, force: true });
        } catch {
          result.success = false;
          result.error = 'Workspace cleanup failed';
          result.retainedWorkspace = workspace;
        }
      } else {
        result.retainedWorkspace = workspace;
      }
    }
    // A non-cooperative callback may settle later; never let it mutate returned evidence.
    return { ...result };
  }

  async runAll(
    agentRunner: EvalRunner,
    tasks: readonly EvalTask[] = BENCHMARK_TASKS,
  ): Promise<EvalReport> {
    if (!this.options.runnerIdentity?.trim())
      throw new Error('A runner identity/version is required for comparable reports');
    if (new Set(tasks.map((t) => t.id)).size !== tasks.length)
      throw new Error('Duplicate task ids');
    const results: EvalResult[] = [];
    for (const task of tasks) results.push(await this.runTask(task, agentRunner));
    const passedTasks = results.filter((r) => r.success).length;
    const sumKnown = (key: 'costUsd' | 'humanInterventions') =>
      results.some((r) => r[key] === null) ? null : results.reduce((sum, r) => sum + r[key]!, 0);
    return {
      schemaVersion: 1,
      suite: 'core-fixtures-v1',
      runnerIdentity: this.options.runnerIdentity,
      taskManifestHash: createHash('sha256')
        .update(
          JSON.stringify(
            tasks.map((task) => ({
              id: task.id,
              description: task.description,
              maxTurns: task.maxTurns,
              timeout: task.timeout,
              setup: task.setup?.toString(),
              verify: task.verify.toString(),
            })),
          ),
        )
        .digest('hex'),
      timestamp: Date.now(),
      totalTasks: results.length,
      passedTasks,
      failedTasks: results.length - passedTasks,
      passRate: results.length ? (passedTasks / results.length) * 100 : 0,
      avgDurationMs: results.length
        ? results.reduce((sum, r) => sum + r.durationMs, 0) / results.length
        : 0,
      totalCostUsd: sumKnown('costUsd'),
      totalHumanInterventions: sumKnown('humanInterventions'),
      results,
    };
  }

  formatReport(report: EvalReport): string {
    const cell = (value: unknown) =>
      String(value)
        .replaceAll('|', '\\|')
        .replace(/[\r\n]+/g, ' ');
    return [
      `Core fixture evaluation: ${cell(report.runnerIdentity)}`,
      '',
      `${report.passedTasks}/${report.totalTasks} passed. These fixtures do not establish real-world competitive performance.`,
      '',
      '| Task | Result | Duration (ms) | Turns | Cost (USD) | Human interventions |',
      '| --- | --- | ---: | ---: | ---: | ---: |',
      ...report.results.map(
        (r) =>
          `| ${cell(r.taskId)} | ${r.success ? 'Pass' : cell(r.error ?? 'Verification failed')} | ${Math.round(r.durationMs)} | ${r.turns ?? 'unknown'} | ${r.costUsd ?? 'unknown'} | ${r.humanInterventions ?? 'unknown'} |`,
      ),
    ].join('\n');
  }
}
