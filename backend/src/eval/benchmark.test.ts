import { describe, expect, test } from 'bun:test';
import { existsSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { BENCHMARK_TASKS, EphemeralHarness, type EvalTask } from './benchmark';

const task = (overrides: Partial<EvalTask> = {}): EvalTask => ({
  id: 'fixture',
  name: 'Fixture',
  description: 'Do the fixture task',
  verify: async () => true,
  timeout: 1_000,
  maxTurns: 2,
  ...overrides,
});

describe('core evaluation evidence and lifecycle', () => {
  test('passes the task contract and removes a settled workspace', async () => {
    let workspace = '';
    const result = await new EphemeralHarness().runTask(task(), async (dir, context) => {
      workspace = dir;
      expect(context.task.description).toBe('Do the fixture task');
      expect(context.task.maxTurns).toBe(2);
      expect(context.signal.aborted).toBe(false);
      return { turns: 1 };
    });
    expect(result.success).toBe(true);
    expect(result.costUsd).toBeNull();
    expect(result.humanInterventions).toBeNull();
    expect(existsSync(workspace)).toBe(false);
  });

  test('rejects false completion and exceeding the turn budget', async () => {
    let verifications = 0;
    const result = await new EphemeralHarness().runTask(
      task({
        verify: async () => {
          verifications++;
          return true;
        },
      }),
      async () => ({ turns: 3 }),
    );
    expect(result.success).toBe(false);
    expect(result.error).toBe('Turn budget exceeded');
    expect(verifications).toBe(0);
    const falseResult = await new EphemeralHarness().runTask(
      task({ verify: async () => false }),
      async () => ({ turns: 1 }),
    );
    expect(falseResult.success).toBe(false);
  });

  test('aborts cooperative execution before deleting its workspace', async () => {
    let workspace = '';
    let existedAtAbort = false;
    const result = await new EphemeralHarness().runTask(
      task({ timeout: 20 }),
      async (dir, { signal }) => {
        workspace = dir;
        await new Promise<void>((resolve) =>
          signal.addEventListener(
            'abort',
            () => {
              existedAtAbort = existsSync(dir);
              resolve();
            },
            { once: true },
          ),
        );
        return { turns: 1 };
      },
    );
    expect(existedAtAbort).toBe(true);
    expect(result.error).toBe('Evaluation timeout');
    expect(result.success).toBe(false);
    expect(existsSync(workspace)).toBe(false);
  });

  test('retains a workspace while a non-cooperative runner is still alive', async () => {
    let release!: () => void;
    const result = await new EphemeralHarness({ cancellationGraceMs: 1 }).runTask(
      task({ timeout: 10 }),
      async () => {
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        return { turns: 1, costUsd: 100 };
      },
    );
    try {
      expect(result.success).toBe(false);
      expect(existsSync(result.retainedWorkspace!)).toBe(true);
      release();
      await new Promise((resolve) => setTimeout(resolve, 5));
      expect(result.success).toBe(false);
      expect(result.costUsd).toBeNull();
    } finally {
      rmSync(result.retainedWorkspace!, { recursive: true, force: true });
    }
  });

  test('setup and verifier failures remain failures and clean up', async () => {
    let workspace = '';
    const result = await new EphemeralHarness().runTask(
      task({
        setup: async (dir) => {
          workspace = dir;
          throw new Error('setup failed');
        },
      }),
      async () => ({ turns: 1 }),
    );
    expect(result.error).toBe('setup failed');
    expect(existsSync(workspace)).toBe(false);
    const verification = await new EphemeralHarness().runTask(
      task({
        verify: async () => {
          throw new Error('verifier failed');
        },
      }),
      async () => ({ turns: 1 }),
    );
    expect(verification.success).toBe(false);
    expect(verification.error).toBe('verifier failed');
  });

  test('does not accept forged successful workspace tests', async () => {
    const result = await new EphemeralHarness().runTask(BENCHMARK_TASKS[1], async (dir) => {
      writeFileSync(join(dir, 'math.test.ts'), 'process.exit(0);');
      return { turns: 1 };
    });
    expect(result.success).toBe(false);
    const fixed = await new EphemeralHarness().runTask(BENCHMARK_TASKS[1], async (dir) => {
      writeFileSync(join(dir, 'math.ts'), 'export function add(a,b) {return a+b}');
      return { turns: 1 };
    });
    expect(fixed.success).toBe(true);
    const earlyExit = await new EphemeralHarness().runTask(BENCHMARK_TASKS[1], async (dir) => {
      writeFileSync(join(dir, 'math.ts'), 'process.exit(0);');
      return { turns: 1 };
    });
    expect(earlyExit.success).toBe(false);
  });

  test('concurrency fixture rejects broken cache and accepts coalescing with retry', async () => {
    const harness = new EphemeralHarness();
    expect((await harness.runTask(BENCHMARK_TASKS[2], async () => ({ turns: 1 }))).success).toBe(
      false,
    );
    const result = await harness.runTask(BENCHMARK_TASKS[2], async (dir) => {
      writeFileSync(
        join(dir, 'cache.ts'),
        `export function createCache(load) {
        const entries = new Map(); return {get(key) {
          if (!entries.has(key)) entries.set(key, Promise.resolve().then(() => load(key)).catch(error => {entries.delete(key); throw error;}));
          return entries.get(key);
        }};
      }`,
      );
      return { turns: 2 };
    });
    expect(result.success).toBe(true);
  });

  test('preserves unknown totals and validates runner metrics', async () => {
    const harness = new EphemeralHarness({ runnerIdentity: 'deterministic-test-v1' });
    const report = await harness.runAll(async () => ({ turns: 1 }), [task()]);
    expect(report.totalCostUsd).toBeNull();
    expect(report.totalHumanInterventions).toBeNull();
    expect(report.taskManifestHash).toMatch(/^[a-f0-9]{64}$/);
    expect(harness.formatReport(report)).toContain('unknown');
    expect((await harness.runTask(task(), async () => ({ turns: 1, costUsd: NaN }))).success).toBe(
      false,
    );
    expect((await harness.runTask(task(), async () => ({ turns: -1 }))).success).toBe(false);
    await expect(new EphemeralHarness().runAll(async () => ({ turns: 1 }), [])).rejects.toThrow(
      'identity',
    );
    await expect(harness.runAll(async () => ({ turns: 1 }), [task(), task()])).rejects.toThrow(
      'Duplicate',
    );
  });
});
