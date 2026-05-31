import { join } from 'node:path';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { EphemeralHarness, type EvalTask, type EvalReport } from './benchmark';
import { koryLog } from '../logger';
import { spawn } from 'bun';

// SWE-bench Integration for Koryphaios
// This fetches issues from the SWE-bench dataset, isolates them, and runs the agent against them.

export interface SWEBenchInstance {
  instance_id: string;
  repo: string;
  base_commit: string;
  problem_statement: string;
  hints_text?: string;
  created_at: string;
  version: string;
  test_patch: string; // The test that was added to verify the bug
  pass_to_pass: string[]; // Tests that should continue to pass
  fail_to_pass: string[]; // Tests that should transition from fail to pass
}

export class SWEBenchHarness {
  private harness: EphemeralHarness;
  private datasetCachePath: string;

  constructor() {
    this.harness = new EphemeralHarness();
    this.datasetCachePath = join(process.cwd(), '.koryphaios', 'swe-bench-cache.json');
  }

  /**
   * Fetches a slice of the SWE-bench dataset from HuggingFace (or uses local cache)
   */
  async fetchDataset(split: 'test' | 'dev' = 'test', limit = 10): Promise<SWEBenchInstance[]> {
    if (existsSync(this.datasetCachePath)) {
      try {
        const cached = JSON.parse(readFileSync(this.datasetCachePath, 'utf8'));
        return cached.slice(0, limit);
      } catch (e) {
        koryLog.warn('Failed to read SWE-bench cache, refetching...');
      }
    }

    // In a real scenario, this would hit the HuggingFace datasets API.
    // For now, we mock the schema to demonstrate the pipeline structure.
    koryLog.info('Downloading SWE-bench verified dataset...');
    
    const mockDataset: SWEBenchInstance[] = [
      {
        instance_id: 'django__django-11001',
        repo: 'django/django',
        base_commit: '1a2b3c4d',
        problem_statement: 'Fix SQL compilation error in RawSQL queries with multiline strings.',
        created_at: '2025-01-01T00:00:00Z',
        version: '3.0',
        test_patch: 'diff --git a/tests/raw_query/tests.py b/tests/raw_query/tests.py...', // This is a placeholder, actual patch would be longer
        pass_to_pass: ['test_raw_query'],
        fail_to_pass: ['test_multiline_raw_sql'],
      }
    ];

    mkdirSync(dirname(this.datasetCachePath), { recursive: true });
    writeFileSync(this.datasetCachePath, JSON.stringify(mockDataset, null, 2));

    return mockDataset.slice(0, limit);
  }

  /**
   * Converts a SWE-bench instance into a Koryphaios EvalTask
   */
  createTaskFromInstance(instance: SWEBenchInstance): EvalTask {
    return {
      id: `swe-bench-${instance.instance_id}`,
      name: `SWE-bench: ${instance.instance_id}`,
      description: `Fix the following issue in ${instance.repo}:\n\n${instance.problem_statement}`,
      maxTurns: 30, // SWE-bench tasks often require deep reasoning and multiple files
      timeout: 10 * 60 * 1000, // 10 minutes
      
      setup: async (workspaceDir: string) => {
        koryLog.info({ instance_id: instance.instance_id }, 'Setting up SWE-bench task workspace');
        
        // 1. Clone the repository
        const cloneProc = spawn(['git', 'clone', `https://github.com/${instance.repo}.git`, '.'], {
          cwd: workspaceDir,
        });
        await cloneProc.exited;

        // 2. Checkout the base commit (the state before the fix)
        const checkoutProc = spawn(['git', 'checkout', instance.base_commit], {
          cwd: workspaceDir,
        });
        await checkoutProc.exited;

        // 3. Write the problem statement to a file for the agent to read
        writeFileSync(join(workspaceDir, 'ISSUE_DESCRIPTION.md'), instance.problem_statement);
      },

      verify: async (workspaceDir: string) => {
        koryLog.info({ instance_id: instance.instance_id }, 'Verifying SWE-bench fix');
        
        // Apply the test patch (the tests that the original author wrote to prove the bug)
        writeFileSync(join(workspaceDir, 'verify.patch'), instance.test_patch);
        const patchProc = spawn(['git', 'apply', 'verify.patch'], { cwd: workspaceDir });
        await patchProc.exited;

        // Run the specific tests. In SWE-bench, you typically run a dockerized 
        // test command like `pytest tests/raw_query/tests.py`.
        // Here we simulate the test runner.
        const testProc = spawn(['pytest', '-k', instance.fail_to_pass.join(' or ')], {
          cwd: workspaceDir,
        });
        
        const exitCode = await testProc.exited;
        
        // If exit code is 0, the agent successfully fixed the bug to make the new tests pass
        return exitCode === 0;
      }
    };
  }

  /**
   * Run the full SWE-bench evaluation
   */
  async runEvaluation(agentRunner: (workspaceDir: string) => Promise<{turns: number, tokensUsed?: number}>): Promise<EvalReport> {
    const instances = await this.fetchDataset();
    const tasks = instances.map(inst => this.createTaskFromInstance(inst));
    
    // Temporarily replace the default benchmark tasks with SWE-bench tasks
    // and run them through the ephemeral harness
    koryLog.info(`Starting SWE-bench evaluation on ${tasks.length} instances`);
    
    const results = [];
    for (const task of tasks) {
      const result = await this.harness.runTask(task, agentRunner);
      results.push(result);
      
      koryLog.info({
        taskId: task.id, 
        success: result.success, 
        duration: result.durationMs 
      }, 'Completed SWE-bench instance');
    }

    return {
      timestamp: Date.now(),
      totalTasks: results.length,
      passedTasks: results.filter(r => r.success).length,
      failedTasks: results.filter(r => !r.success).length,
      passRate: (results.filter(r => r.success).length / results.length) * 100,
      avgDurationMs: results.reduce((acc, r) => acc + r.durationMs, 0) / results.length,
      results
    };
  }
}

// Utility function used when creating directories
import { dirname } from 'node:path';
