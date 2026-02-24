// End-to-End Evaluation Suite for Koryphaios
// This provides a framework for benchmarking agent performance

interface EvalTask {
  id: string;
  name: string;
  description: string;
  expectedKeywords?: string[];
  maxTurns?: number;
  timeout?: number;
}

interface EvalResult {
  taskId: string;
  success: boolean;
  durationMs: number;
  turns: number;
  tokensUsed?: number;
  error?: string;
  output?: string;
}

interface EvalReport {
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
    id: "read-file",
    name: "Read File",
    description: "Read a file and extract specific information",
    expectedKeywords: ["function", "export"],
    maxTurns: 2,
    timeout: 30000,
  },
  {
    id: "write-file",
    name: "Write File",
    description: "Create a new file with specific content",
    expectedKeywords: ["created", "wrote"],
    maxTurns: 2,
    timeout: 30000,
  },
  {
    id: "edit-file",
    name: "Edit File",
    description: "Modify an existing file",
    expectedKeywords: ["edited", "modified"],
    maxTurns: 3,
    timeout: 45000,
  },
  {
    id: "multi-file",
    name: "Multi-File Edit",
    description: "Make changes across multiple files",
    expectedKeywords: ["modified", "changed"],
    maxTurns: 5,
    timeout: 60000,
  },
  {
    id: "bash-command",
    name: "Bash Command",
    description: "Execute a shell command successfully",
    expectedKeywords: ["completed", "success"],
    maxTurns: 2,
    timeout: 30000,
  },
  {
    id: "search-code",
    name: "Search Code",
    description: "Find code using grep",
    expectedKeywords: ["found", "match"],
    maxTurns: 2,
    timeout: 30000,
  },
];

export function evaluateOutput(output: string, expectedKeywords: string[]): boolean {
  const lowerOutput = output.toLowerCase();
  return expectedKeywords.every(keyword => lowerOutput.includes(keyword.toLowerCase()));
}

export function calculatePassRate(results: EvalResult[]): number {
  if (results.length === 0) return 0;
  const passed = results.filter(r => r.success).length;
  return (passed / results.length) * 100;
}

export function generateReport(results: EvalResult[]): EvalReport {
  const totalTasks = results.length;
  const passedTasks = results.filter(r => r.success).length;
  const failedTasks = totalTasks - passedTasks;
  const passRate = calculatePassRate(results);
  const avgDurationMs = results.reduce((sum, r) => sum + r.durationMs, 0) / totalTasks;

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

export function formatReport(report: EvalReport): string {
  const date = new Date(report.timestamp).toISOString();
  let output = `═══════════════════════════════════════════════════
  KORYPHAIOS EVALUATION REPORT
  ${date}
═══════════════════════════════════════════════════

SUMMARY:
  Total Tasks:    ${report.totalTasks}
  Passed:        ${report.passedTasks}
  Failed:        ${report.failedTasks}
  Pass Rate:     ${report.passRate.toFixed(1)}%
  Avg Duration:  ${(report.avgDurationMs / 1000).toFixed(2)}s

RESULTS:`;

  for (const result of report.results) {
    const status = result.success ? "✓ PASS" : "✗ FAIL";
    output += `
  ${status}  ${result.taskId}
            Duration: ${(result.durationMs / 1000).toFixed(2)}s
            Turns: ${result.turns}${result.error ? `
            Error: ${result.error}` : ""}`;
  }

  output += `
═══════════════════════════════════════════════════`;
  return output;
}
