/**
 * Heuristic-based diagnostic engine for error analysis
 */

import type {
  DetectedError,
  FixSuggestion,
} from '../types/errors.js';
import type {
  DiagnosticEngine,
  ErrorAnalysis,
  SimilarError,
  ErrorExplanation,
  ImpactPrediction,
  Recommendation,
  RootCause,
} from '../types/diagnostics.js';
import { ErrorSeverity } from '../types/errors.js';

export class HeuristicDiagnosticEngine implements DiagnosticEngine {
  async analyzeError(error: DetectedError): Promise<ErrorAnalysis> {
    const startTime = Date.now();
    const rootCause = this.determineRootCause(error);
    
    return {
      errorId: error.id,
      rootCause,
      confidence: this.calculateConfidence(error),
      analysisTime: Date.now() - startTime,
      context: {
        codebase: {
          language: error.type || 'unknown',
          size: {
            files: 0,
            lines: 0,
          },
          complexity: 'medium',
        },
        environment: {
          platform: process.platform,
          runtime: 'node',
          version: process.version,
          configuration: {},
        },
        dependencies: [],
        recentChanges: [],
      },
      patterns: [],
      recommendations: this.getRecommendations(rootCause),
    };
  }

  async suggestFixes(error: DetectedError): Promise<FixSuggestion[]> {
    const fixes: FixSuggestion[] = [];

    if (error.message.includes('sqlite3') || error.message.includes('database is locked')) {
      fixes.push({
        id: `fix_${Date.now()}_1`,
        description: 'Increase SQLite busy timeout or use WAL mode',
        confidence: 0.9,
        type: 'configuration',
        instructions: [
          'Enable WAL mode: PRAGMA journal_mode=WAL;',
          'Increase busy timeout: PRAGMA busy_timeout=5000;'
        ],
        estimatedEffort: 'low',
        riskLevel: 'low',
      });
    }

    if (error.message.includes('tauri') && error.message.includes('permission')) {
      fixes.push({
        id: `fix_${Date.now()}_2`,
        description: 'Update tauri.conf.json capabilities',
        confidence: 0.85,
        type: 'configuration',
        instructions: [
          'Check src-tauri/capabilities/ directory',
          'Ensure the command is explicitly allowed in the capability file'
        ],
        estimatedEffort: 'low',
        riskLevel: 'low',
      });
    }

    return fixes;
  }

  async findSimilarErrors(_error: DetectedError): Promise<SimilarError[]> {
    return [];
  }

  async explainError(error: DetectedError): Promise<ErrorExplanation> {
    return {
      summary: `This error appears to be a ${error.category} issue related to ${error.type}.`,
      technicalDetails: error.message,
      userFriendlyExplanation: 'The system matched this error against a small set of known runtime and configuration failures.',
      commonCauses: [],
      preventionTips: [],
      learningResources: [],
    };
  }

  async predictImpact(error: DetectedError): Promise<ImpactPrediction> {
    return {
      severity: error.severity,
      affectedComponents: [],
      userImpact: error.severity === ErrorSeverity.CRITICAL ? 'significant' : 'moderate',
      businessImpact: error.severity === ErrorSeverity.CRITICAL ? 'high' : 'medium',
      propagationRisk: error.severity === ErrorSeverity.CRITICAL ? 0.9 : 0.4,
      timeToFix: {
        estimated: error.severity === ErrorSeverity.CRITICAL ? 120 : 30,
        confidence: 0.6,
      },
    };
  }

  private determineRootCause(error: DetectedError): RootCause {
    if (error.message.includes('sqlite3')) {
      return {
        type: 'data',
        description: 'SQLite database concurrency issue or locking contention',
        evidence: [
          {
            type: 'pattern-match',
            description: 'Matched sqlite lock/concurrency keywords in the error message',
            weight: 0.8,
            source: 'heuristic-engine',
          },
        ],
        confidence: 0.8,
      };
    }
    if (error.message.includes('tauri')) {
      return {
        type: 'configuration',
        description: 'Tauri bridge or capability permission issue',
        evidence: [
          {
            type: 'pattern-match',
            description: 'Matched tauri-specific capability or IPC terms',
            weight: 0.75,
            source: 'heuristic-engine',
          },
        ],
        confidence: 0.75,
      };
    }
    if (error.message.includes('auth') || error.message.includes('token')) {
      return {
        type: 'configuration',
        description: 'Authentication failure or invalid session token',
        evidence: [
          {
            type: 'pattern-match',
            description: 'Matched authentication or token-related keywords',
            weight: 0.9,
            source: 'heuristic-engine',
          },
        ],
        confidence: 0.9,
      };
    }
    return {
      type: 'logic',
      description: 'Could not determine exact root cause from heuristics',
      evidence: [
        {
          type: 'pattern-match',
          description: 'No heuristic matched strongly enough to classify the failure',
          weight: 0.3,
          source: 'heuristic-engine',
        },
      ],
      confidence: 0.3,
    };
  }

  private calculateConfidence(error: DetectedError): number {
    let confidence = 0.5;
    if (error.stackTrace.length > 0) confidence += 0.2;
    if (error.context.metadata?.['source']) confidence += 0.1;
    return Math.min(confidence, 1.0);
  }

  private getRecommendations(rootCause: RootCause): Recommendation[] {
    const recs: Recommendation[] = [];
    if (rootCause.type === 'data') {
      recs.push({
        description: 'Reduce long-running transactions and ensure connections are closed.',
        type: 'immediate',
        priority: 'high',
        effort: 'low',
        impact: 'high',
        steps: ['Enable WAL mode for SQLite', 'Increase busy timeout for transient contention'],
      });
    }
    return recs;
  }
}
