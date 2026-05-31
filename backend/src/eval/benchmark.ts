import { join } from 'node:path';
import { existsSync, rmSync, mkdirSync, cpSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { AutoTestRunner } from '../testing/auto-test';
import { koryLog } from '../logger';

// State-Based Evaluation Suite for Koryphaios
// This replaces naive keyword checking with rigorous, container-less sandboxing using Ephemeral Workspaces.

export interface EvalTask {
  id: string;
  name: string;
  description: string;
  // Setup the environment before the agent starts executing
  setup?: (workspaceDir: string) => Promise<void>;
  // Verify the actual state of the files/system after the agent finishes
  verify: (workspaceDir: string) => Promise<boolean>;
  maxTurns?: number;
  timeout?: number;
}

export interface EvalResult {
  taskId: string;
  success: boolean;
  durationMs: number;
  turns: number;
  tokensUsed?: number;
  error?: string;
}

export interface EvalReport {
  timestamp: number;
  totalTasks: number;
  passedTasks: number;
  failedTasks: number;
  passRate: number;
  avgDurationMs: number;
  results: EvalResult[];
}

export const BENCHMARK_TASKS: EvalTask[] = [
  {
    id: 'create-hello-world',
    name: 'Create Hello World',
    description: 'Create a file named hello.ts that exports a default function returning "world"',
    verify: async (workspaceDir) => {
      try {
        const filePath = join(workspaceDir, 'hello.ts');
        if (!existsSync(filePath)) return false;
        
        // Dynamically import the code the agent wrote to verify execution
        const mod = await import(filePath);
        return mod.default() === 'world';
      } catch (e) {
        koryLog.error({ err: e }, 'Verification failed for create-hello-world');
        return false;
      }
    },
    maxTurns: 2,
    timeout: 30000,
  },
  {
    id: 'fix-failing-test',
    name: 'Fix Failing Test',
    description: 'Fix the broken logic so the tests pass',
    setup: async (workspaceDir) => {
      // Seed a broken codebase for the agent to fix
      const bunFile = Bun.file(join(workspaceDir, 'math.ts'));
      await Bun.write(bunFile, `export function add(a: number, b: number) { return a - b; } // Bug!`);
      
      const testFile = Bun.file(join(workspaceDir, 'math.test.ts'));
      await Bun.write(testFile, `
import { expect, test } from "bun:test";
import { add } from "./math";

test("add", () => {
  expect(add(2, 2)).toBe(4);
});
      `);
    },
    verify: async (workspaceDir) => {
      // Use the project's own AutoTest system to verify the fix
      const runner = new AutoTestRunner(workspaceDir, { frameworks: ['bun'] });
      const result = await runner.runTests();
      return result.success && result.passed > 0;
    },
    maxTurns: 3,
    timeout: 45000,
  }
];

export class EphemeralHarness {
  private baseTmpDir: string;

  constructor() {
    this.baseTmpDir = join(tmpdir(), 'koryphaios-evals');
    if (!existsSync(this.baseTmpDir)) {
      mkdirSync(this.baseTmpDir, { recursive: true });
    }
  }

  async runTask(task: EvalTask, agentRunner: (workspaceDir: string) => Promise<{turns: number, tokensUsed?: number}>): Promise<EvalResult> {
    const runId = randomUUID();
    const workspaceDir = join(this.baseTmpDir, runId);
    
    mkdirSync(workspaceDir, { recursive: true });
    const startTime = Date.now();
    let result: Partial<EvalResult> = { taskId: task.id, success: false };

    try {
      koryLog.info({ taskId: task.id, workspace: workspaceDir }, 'Starting Eval Task');

      // 1. Setup Phase
      if (task.setup) {
        await task.setup(workspaceDir);
      }

      // 2. Execution Phase (Inject the agent into the isolated workspace)
      const executionPromise = agentRunner(workspaceDir);
      
      let executionResult;
      if (task.timeout) {
        const timeoutPromise = new Promise((_, reject) => setTimeout(() => reject(new Error('Agent Timeout')), task.timeout));
        executionResult = await Promise.race([executionPromise, timeoutPromise]) as any;
      } else {
        executionResult = await executionPromise;
      }

      result.turns = executionResult.turns;
      result.tokensUsed = executionResult.tokensUsed;

      // 3. Verification Phase
      result.success = await task.verify(workspaceDir);

    } catch (err: any) {
      koryLog.error({ taskId: task.id, err }, 'Eval task threw an error');
      result.error = err.message || String(err);
    } finally {
      // 4. Teardown Phase
      result.durationMs = Date.now() - startTime;
      try {
         rmSync(workspaceDir, { recursive: true, force: true });
      } catch (cleanupErr) {
         koryLog.warn({ cleanupErr, workspace: workspaceDir }, 'Failed to cleanup ephemeral workspace');
      }
    }

    return result as EvalResult;
  }

  async runAll(agentRunner: (workspaceDir: string) => Promise<{turns: number, tokensUsed?: number}>): Promise<EvalReport> {
    const results: EvalResult[] = [];
    
    // In the future, this can be parallelized for massive speedups
    for (const task of BENCHMARK_TASKS) {
      const res = await this.runTask(task, agentRunner);
      results.push(res);
    }

    return this.generateReport(results);
  }

  private generateReport(results: EvalResult[]): EvalReport {
    const totalTasks = results.length;
    const passedTasks = results.filter((r) => r.success).length;
    const failedTasks = totalTasks - passedTasks;
    const passRate = totalTasks === 0 ? 0 : (passedTasks / totalTasks) * 100;
    const avgDurationMs = totalTasks === 0 ? 0 : results.reduce((sum, r) => sum + r.durationMs, 0) / totalTasks;

    return {
      timestamp: Date.now(),
      totalTasks,
      passedTasks,
      failedTasks,
      passRate,
      avgDurationMs,
      results,
    };
  }

  formatReport(report: EvalReport): string {
    const date = new Date(report.timestamp).toISOString();
    let output = `═══════════════════════════════════════════════════
  KORYPHAIOS EPHEMERAL EVALUATION REPORT
  ${date}
═══════════════════════════════════════════════════

SUMMARY:
  Total Tasks:    ${report.totalTasks}
  Passed:        ${report.passedTasks}
  Failed:        ${report.failedTasks}
  Pass Rate:     ${report.passRate.toFixed(1)}%
  Avg Duration:  ${(report.avgDurationMs / 1000).toFixed(2)}s

RESULTS:`

    for (const result of report.results) {
      const status = result.success ? '✓ PASS' : '✗ FAIL';
      output += `
  ${status}  ${result.taskId}
            Duration: ${(result.durationMs / 1000).toFixed(2)}s
            Turns: ${result.turns}${ 
                result.tokensUsed ? `\n            Tokens: ${result.tokensUsed}` : ''
            }${ 
                result.error ? `\n            Error: ${result.error}` : ''
            }`;
    }

    output += `\n═══════════════════════════════════════════════════`;
    return output;
  }
}
