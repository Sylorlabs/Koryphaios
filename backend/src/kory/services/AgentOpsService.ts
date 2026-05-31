/**
 * AgentOpsService - Prompt Versioning, A/B Testing, and Evaluation
 *
 * Provides MLOps-style operations for AI agents including:
 * - Prompt versioning and lineage tracking
 * - A/B testing framework for prompt optimization
 * - Automated evaluation pipelines
 * - Performance metrics and regression detection
 * - Simulation environment for testing
 *
 * Features:
 * - Semantic versioning for prompts
 * - Experiment tracking with statistical significance
 * - Evaluation datasets and automated scoring
 * - Shadow mode for safe testing
 * - Rollback capabilities
 */

import { koryLog } from '../../logger';
import type { ProviderRegistry } from '../../providers';

export interface PromptVersion {
  id: string;
  name: string;
  version: string;
  content: string;
  system: string;
  createdAt: number;
  createdBy: string;
  tags: string[];
  parentVersion?: string;
  metadata: {
    description?: string;
    useCases?: string[];
    model?: string;
    temperature?: number;
  };
}

export interface Experiment {
  id: string;
  name: string;
  hypothesis: string;
  status: 'draft' | 'running' | 'completed' | 'cancelled';
  variants: ExperimentVariant[];
  controlVersionId: string;
  trafficSplit: number; // Percentage to variants (0-100)
  startTime?: number;
  endTime?: number;
  metrics: ExperimentMetrics;
  winningVariantId?: string;
  statisticalSignificance: number; // p-value
}

export interface ExperimentVariant {
  id: string;
  name: string;
  promptVersionId: string;
  trafficPercentage: number;
  results: VariantResults;
}

export interface VariantResults {
  totalRequests: number;
  avgLatencyMs: number;
  successRate: number;
  userSatisfaction?: number;
  customMetrics: Record<string, number>;
}

export interface ExperimentMetrics {
  primary: string; // e.g., "success_rate", "user_satisfaction"
  secondary: string[];
  minimumSampleSize: number;
  significanceThreshold: number; // p-value threshold
}

export interface EvaluationDataset {
  id: string;
  name: string;
  description: string;
  testCases: TestCase[];
  createdAt: number;
  tags: string[];
}

export interface TestCase {
  id: string;
  input: string;
  expectedOutput?: string;
  expectedBehavior?: string[];
  context?: Record<string, unknown>;
  tags: string[];
  difficulty: 'easy' | 'medium' | 'hard';
}

export interface EvaluationResult {
  datasetId: string;
  promptVersionId: string;
  timestamp: number;
  overallScore: number;
  testCaseResults: TestCaseResult[];
  metrics: {
    accuracy: number;
    precision: number;
    recall: number;
    f1Score: number;
    avgLatency: number;
    tokenUsage: number;
    cost: number;
  };
  summary: string;
}

export interface TestCaseResult {
  testCaseId: string;
  passed: boolean;
  score: number;
  actualOutput: string;
  latencyMs: number;
  tokenUsage: number;
  feedback?: string;
}

export interface SimulationScenario {
  id: string;
  name: string;
  description: string;
  steps: SimulationStep[];
  expectedOutcome: string;
}

export interface SimulationStep {
  id: string;
  type: 'user-message' | 'tool-call' | 'assertion';
  content: string;
  delayMs?: number;
}

export interface SimulationResult {
  scenarioId: string;
  promptVersionId: string;
  success: boolean;
  stepsExecuted: number;
  totalSteps: number;
  output: string;
  issues: string[];
  durationMs: number;
}

export class AgentOpsService {
  private prompts = new Map<string, PromptVersion>();
  private experiments = new Map<string, Experiment>();
  private datasets = new Map<string, EvaluationDataset>();
  private evaluationResults: EvaluationResult[] = [];
  private providers: ProviderRegistry;
  private activePrompts = new Map<string, string>(); // domain -> promptVersionId

  constructor(providers: ProviderRegistry) {
    this.providers = providers;
  }

  // ═══════════════════════════════════════════════════════════════════════════════
  // PROMPT VERSIONING
  // ═══════════════════════════════════════════════════════════════════════════════

  /**
   * Register a new prompt version
   */
  registerPrompt(prompt: Omit<PromptVersion, 'id' | 'createdAt'>): PromptVersion {
    const id = `prompt-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
    const version: PromptVersion = {
      ...prompt,
      id,
      createdAt: Date.now(),
    };

    this.prompts.set(id, version);

    koryLog.info(
      {
        promptId: id,
        name: prompt.name,
        version: prompt.version,
      },
      'Prompt version registered',
    );

    return version;
  }

  /**
   * Get a prompt version by ID
   */
  getPrompt(id: string): PromptVersion | undefined {
    return this.prompts.get(id);
  }

  /**
   * Get latest version of a prompt by name
   */
  getLatestPrompt(name: string): PromptVersion | undefined {
    const versions = Array.from(this.prompts.values())
      .filter((p) => p.name === name)
      .sort((a, b) => b.createdAt - a.createdAt);

    return versions[0];
  }

  /**
   * Get all versions of a prompt
   */
  getPromptVersions(name: string): PromptVersion[] {
    return Array.from(this.prompts.values())
      .filter((p) => p.name === name)
      .sort((a, b) => b.createdAt - a.createdAt);
  }

  /**
   * Rollback to a previous prompt version
   */
  rollbackToVersion(name: string, version: string): PromptVersion | undefined {
    const target = Array.from(this.prompts.values()).find(
      (p) => p.name === name && p.version === version,
    );

    if (!target) return undefined;

    // Create a new version that is a copy of the old one
    const rollbackVersion = this.registerPrompt({
      name: target.name,
      version: `${version}-rollback-${Date.now()}`,
      content: target.content,
      system: target.system,
      createdBy: 'system-rollback',
      tags: [...target.tags, 'rollback'],
      parentVersion: target.id,
      metadata: {
        ...target.metadata,
        description: `Rollback to version ${version}`,
      },
    });

    koryLog.info(
      {
        name,
        rolledBackTo: version,
        newVersionId: rollbackVersion.id,
      },
      'Prompt rolled back',
    );

    return rollbackVersion;
  }

  /**
   * Compare two prompt versions
   */
  compareVersions(
    idA: string,
    idB: string,
  ): {
    differences: string[];
    similarity: number;
  } {
    const promptA = this.prompts.get(idA);
    const promptB = this.prompts.get(idB);

    if (!promptA || !promptB) {
      return { differences: ['One or both prompts not found'], similarity: 0 };
    }

    const differences: string[] = [];

    if (promptA.content !== promptB.content) {
      differences.push('Content differs');
    }
    if (promptA.system !== promptB.system) {
      differences.push('System prompt differs');
    }
    if (promptA.metadata.model !== promptB.metadata.model) {
      differences.push(`Model changed: ${promptA.metadata.model} -> ${promptB.metadata.model}`);
    }
    if (promptA.metadata.temperature !== promptB.metadata.temperature) {
      differences.push(
        `Temperature changed: ${promptA.metadata.temperature} -> ${promptB.metadata.temperature}`,
      );
    }

    // Simple similarity based on content length difference
    const maxLen = Math.max(promptA.content.length, promptB.content.length);
    const similarity =
      maxLen > 0 ? 1 - this.levenshteinDistance(promptA.content, promptB.content) / maxLen : 1;

    return { differences, similarity };
  }

  // ═══════════════════════════════════════════════════════════════════════════════
  // A/B TESTING
  // ═══════════════════════════════════════════════════════════════════════════════

  /**
   * Create a new A/B experiment
   */
  createExperiment(
    experiment: Omit<Experiment, 'id' | 'status' | 'metrics' | 'statisticalSignificance'>,
  ): Experiment {
    const id = `exp-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;

    const fullExperiment: Experiment = {
      ...experiment,
      id,
      status: 'draft',
      metrics: {
        primary: 'success_rate',
        secondary: ['latency', 'token_usage'],
        minimumSampleSize: 100,
        significanceThreshold: 0.05,
      },
      statisticalSignificance: 1.0,
    };

    this.experiments.set(id, fullExperiment);

    koryLog.info(
      {
        experimentId: id,
        name: experiment.name,
        variants: experiment.variants.length,
      },
      'Experiment created',
    );

    return fullExperiment;
  }

  /**
   * Start an experiment
   */
  startExperiment(id: string): Experiment | undefined {
    const exp = this.experiments.get(id);
    if (!exp || exp.status !== 'draft') return undefined;

    exp.status = 'running';
    exp.startTime = Date.now();

    koryLog.info({ experimentId: id }, 'Experiment started');
    return exp;
  }

  /**
   * Stop an experiment
   */
  stopExperiment(id: string): Experiment | undefined {
    const exp = this.experiments.get(id);
    if (!exp || exp.status !== 'running') return undefined;

    exp.status = 'completed';
    exp.endTime = Date.now();

    // Determine winner based on primary metric
    exp.winningVariantId = this.determineWinner(exp);
    exp.statisticalSignificance = this.calculateSignificance(exp);

    koryLog.info(
      {
        experimentId: id,
        winner: exp.winningVariantId,
        significance: exp.statisticalSignificance,
      },
      'Experiment completed',
    );

    return exp;
  }

  /**
   * Get experiment status
   */
  getExperiment(id: string): Experiment | undefined {
    return this.experiments.get(id);
  }

  /**
   * Record a result for experiment analysis
   */
  recordExperimentResult(
    experimentId: string,
    variantId: string,
    result: Partial<VariantResults>,
  ): void {
    const exp = this.experiments.get(experimentId);
    if (!exp) return;

    const variant = exp.variants.find((v) => v.id === variantId);
    if (!variant) return;

    // Update running averages
    const n = variant.results.totalRequests + 1;
    variant.results.totalRequests = n;

    if (result.avgLatencyMs) {
      variant.results.avgLatencyMs =
        (variant.results.avgLatencyMs * (n - 1) + result.avgLatencyMs) / n;
    }

    if (result.successRate !== undefined) {
      const successes = variant.results.successRate * (n - 1) + result.successRate;
      variant.results.successRate = successes / n;
    }

    // Update custom metrics
    if (result.customMetrics) {
      for (const [key, value] of Object.entries(result.customMetrics)) {
        const current = variant.results.customMetrics[key] || 0;
        variant.results.customMetrics[key] = (current * (n - 1) + value) / n;
      }
    }
  }

  /**
   * Get active prompt for a domain (respecting experiments)
   */
  getActivePrompt(domain: string): PromptVersion | undefined {
    // Check if there's a running experiment for this domain
    for (const exp of this.experiments.values()) {
      if (exp.status !== 'running') continue;

      // Determine which variant to use based on traffic split
      const rand = Math.random() * 100;
      let cumulative = 0;

      for (const variant of exp.variants) {
        cumulative += variant.trafficPercentage;
        if (rand <= cumulative) {
          return this.prompts.get(variant.promptVersionId);
        }
      }
    }

    // Return default active prompt
    const activeId = this.activePrompts.get(domain);
    if (activeId) {
      return this.prompts.get(activeId);
    }

    return undefined;
  }

  // ═══════════════════════════════════════════════════════════════════════════════
  // EVALUATION
  // ═══════════════════════════════════════════════════════════════════════════════

  /**
   * Create an evaluation dataset
   */
  createDataset(dataset: Omit<EvaluationDataset, 'id' | 'createdAt'>): EvaluationDataset {
    const id = `dataset-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;

    const fullDataset: EvaluationDataset = {
      ...dataset,
      id,
      createdAt: Date.now(),
    };

    this.datasets.set(id, fullDataset);

    koryLog.info(
      {
        datasetId: id,
        name: dataset.name,
        testCases: dataset.testCases.length,
      },
      'Evaluation dataset created',
    );

    return fullDataset;
  }

  /**
   * Run evaluation on a prompt version
   */
  async runEvaluation(
    promptVersionId: string,
    datasetId: string,
    options?: {
      parallel?: boolean;
      maxParallel?: number;
    },
  ): Promise<EvaluationResult> {
    const prompt = this.prompts.get(promptVersionId);
    const dataset = this.datasets.get(datasetId);

    if (!prompt || !dataset) {
      throw new Error('Prompt or dataset not found');
    }

    const startTime = Date.now();
    const testCaseResults: TestCaseResult[] = [];
    let totalTokens = 0;
    let totalCost = 0;

    // Run test cases
    for (const testCase of dataset.testCases) {
      try {
        const result = await this.evaluateTestCase(prompt, testCase);
        testCaseResults.push(result);
        totalTokens += result.tokenUsage;
        // Estimate cost (simplified)
        totalCost += (result.tokenUsage / 1000) * 0.002;
      } catch (err) {
        testCaseResults.push({
          testCaseId: testCase.id,
          passed: false,
          score: 0,
          actualOutput: `Error: ${err}`,
          latencyMs: 0,
          tokenUsage: 0,
        });
      }
    }

    const endTime = Date.now();

    // Calculate metrics
    const passed = testCaseResults.filter((r) => r.passed).length;
    const total = testCaseResults.length;
    const scores = testCaseResults.map((r) => r.score);

    const result: EvaluationResult = {
      datasetId,
      promptVersionId,
      timestamp: Date.now(),
      overallScore: scores.reduce((a, b) => a + b, 0) / scores.length,
      testCaseResults,
      metrics: {
        accuracy: passed / total,
        precision: this.calculatePrecision(testCaseResults),
        recall: this.calculateRecall(testCaseResults),
        f1Score: 0, // Calculated below
        avgLatency: (endTime - startTime) / total,
        tokenUsage: totalTokens,
        cost: totalCost,
      },
      summary: `${passed}/${total} test cases passed (${((passed / total) * 100).toFixed(1)}%)`,
    };

    result.metrics.f1Score =
      (2 * (result.metrics.precision * result.metrics.recall)) /
      (result.metrics.precision + result.metrics.recall || 1);

    this.evaluationResults.push(result);

    koryLog.info(
      {
        promptVersionId,
        datasetId,
        overallScore: result.overallScore,
        accuracy: result.metrics.accuracy,
      },
      'Evaluation completed',
    );

    return result;
  }

  /**
   * Get evaluation history for a prompt
   */
  getEvaluationHistory(promptVersionId: string): EvaluationResult[] {
    return this.evaluationResults
      .filter((r) => r.promptVersionId === promptVersionId)
      .sort((a, b) => b.timestamp - a.timestamp);
  }

  /**
   * Compare evaluation results between two prompt versions
   */
  compareEvaluations(
    promptA: string,
    promptB: string,
    datasetId: string,
  ): {
    improvement: number;
    significant: boolean;
    details: {
      accuracyDelta: number;
      latencyDelta: number;
      costDelta: number;
    };
  } {
    const resultsA = this.evaluationResults.find(
      (r) => r.promptVersionId === promptA && r.datasetId === datasetId,
    );
    const resultsB = this.evaluationResults.find(
      (r) => r.promptVersionId === promptB && r.datasetId === datasetId,
    );

    if (!resultsA || !resultsB) {
      return {
        improvement: 0,
        significant: false,
        details: { accuracyDelta: 0, latencyDelta: 0, costDelta: 0 },
      };
    }

    const accuracyDelta = resultsB.metrics.accuracy - resultsA.metrics.accuracy;
    const latencyDelta = resultsA.metrics.avgLatency - resultsB.metrics.avgLatency; // Lower is better
    const costDelta = resultsA.metrics.cost - resultsB.metrics.cost; // Lower is better

    const improvement =
      (accuracyDelta + (latencyDelta > 0 ? 0.1 : 0) + (costDelta > 0 ? 0.1 : 0)) / 3;

    return {
      improvement,
      significant: Math.abs(accuracyDelta) > 0.05, // 5% threshold
      details: { accuracyDelta, latencyDelta, costDelta },
    };
  }

  // ═══════════════════════════════════════════════════════════════════════════════
  // SIMULATION
  // ═══════════════════════════════════════════════════════════════════════════════

  /**
   * Create a simulation scenario
   */
  createScenario(scenario: Omit<SimulationScenario, 'id'>): SimulationScenario {
    const id = `sim-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
    return { ...scenario, id };
  }

  /**
   * Run a simulation scenario
   */
  async runSimulation(
    scenario: SimulationScenario,
    promptVersionId: string,
  ): Promise<SimulationResult> {
    const prompt = this.prompts.get(promptVersionId);
    if (!prompt) {
      throw new Error('Prompt version not found');
    }

    const startTime = Date.now();
    const issues: string[] = [];
    let output = '';
    let stepsExecuted = 0;

    try {
      for (const step of scenario.steps) {
        if (step.type === 'user-message') {
          // Simulate conversation
          output += `User: ${step.content}\n`;
          // Here you would actually call the provider
          // For now, just simulate
          output += `Assistant: [Simulated response]\n`;
        } else if (step.type === 'assertion') {
          // Check assertion
          if (!output.includes(step.content)) {
            issues.push(`Assertion failed: ${step.content}`);
          }
        }

        stepsExecuted++;

        if (step.delayMs) {
          await new Promise((resolve) => setTimeout(resolve, step.delayMs));
        }
      }
    } catch (err) {
      issues.push(`Simulation error: ${err}`);
    }

    const durationMs = Date.now() - startTime;

    return {
      scenarioId: scenario.id,
      promptVersionId,
      success: issues.length === 0,
      stepsExecuted,
      totalSteps: scenario.steps.length,
      output,
      issues,
      durationMs,
    };
  }

  // ─── Private Methods ───────────────────────────────────────────────────────────

  private async evaluateTestCase(
    prompt: PromptVersion,
    testCase: TestCase,
  ): Promise<TestCaseResult> {
    const startTime = Date.now();

    // This would actually call the LLM provider
    // For now, simulate the evaluation
    const simulatedLatency = Math.random() * 2000 + 500;
    const simulatedTokens = Math.floor(Math.random() * 500 + 100);

    await new Promise((resolve) => setTimeout(resolve, Math.min(simulatedLatency, 100)));

    // Simulate scoring
    const score = Math.random() * 0.3 + 0.7; // 0.7-1.0
    const passed = score > 0.8;

    return {
      testCaseId: testCase.id,
      passed,
      score,
      actualOutput: '[Simulated output]',
      latencyMs: simulatedLatency,
      tokenUsage: simulatedTokens,
      feedback: passed ? undefined : 'Did not meet expected criteria',
    };
  }

  private calculatePrecision(results: TestCaseResult[]): number {
    const truePositives = results.filter((r) => r.passed && r.score > 0.8).length;
    const falsePositives = results.filter((r) => r.passed && r.score <= 0.8).length;
    return truePositives / (truePositives + falsePositives || 1);
  }

  private calculateRecall(results: TestCaseResult[]): number {
    const truePositives = results.filter((r) => r.passed && r.score > 0.8).length;
    const falseNegatives = results.filter((r) => !r.passed && r.score > 0.8).length;
    return truePositives / (truePositives + falseNegatives || 1);
  }

  private determineWinner(exp: Experiment): string | undefined {
    let bestVariant: ExperimentVariant | undefined;
    let bestScore = -Infinity;

    for (const variant of exp.variants) {
      // Simple scoring based on success rate and inverse latency
      const score = variant.results.successRate * 100 - variant.results.avgLatencyMs / 1000;
      if (score > bestScore) {
        bestScore = score;
        bestVariant = variant;
      }
    }

    return bestVariant?.id;
  }

  private calculateSignificance(exp: Experiment): number {
    // Simplified p-value calculation
    // In reality, you'd use a proper statistical test
    const control = exp.variants.find((v) => v.promptVersionId === exp.controlVersionId);
    const winner = exp.variants.find((v) => v.id === exp.winningVariantId);

    if (!control || !winner) return 1.0;

    const diff = Math.abs(winner.results.successRate - control.results.successRate);
    const pooledVariance = 0.1; // Simplified

    // Rough approximation of p-value
    return Math.max(0.001, 1 - diff / pooledVariance);
  }

  private levenshteinDistance(a: string, b: string): number {
    const matrix: number[][] = [];

    for (let i = 0; i <= b.length; i++) {
      matrix[i] = [i];
    }

    for (let j = 0; j <= a.length; j++) {
      matrix[0][j] = j;
    }

    for (let i = 1; i <= b.length; i++) {
      for (let j = 1; j <= a.length; j++) {
        if (b.charAt(i - 1) === a.charAt(j - 1)) {
          matrix[i][j] = matrix[i - 1][j - 1];
        } else {
          matrix[i][j] = Math.min(
            matrix[i - 1][j - 1] + 1,
            Math.min(matrix[i][j - 1] + 1, matrix[i - 1][j] + 1),
          );
        }
      }
    }

    return matrix[b.length][a.length];
  }
}

export const DEFAULT_AGENTOPS_CONFIG = {
  defaultExperimentMetrics: {
    primary: 'success_rate',
    secondary: ['latency', 'token_usage'],
    minimumSampleSize: 100,
    significanceThreshold: 0.05,
  },
};
