/**
 * AI-enhanced diagnostics type definitions
 */

import type { DetectedError, ErrorCategory, ErrorSeverity, FixSuggestion } from './errors.js';

export interface DiagnosticEngine {
  analyzeError(error: DetectedError): Promise<ErrorAnalysis>;
  suggestFixes(error: DetectedError): Promise<FixSuggestion[]>;
  findSimilarErrors(error: DetectedError): Promise<SimilarError[]>;
  explainError(error: DetectedError): Promise<ErrorExplanation>;
  predictImpact(error: DetectedError): Promise<ImpactPrediction>;
}

export interface ErrorAnalysis {
  errorId: string;
  rootCause: RootCause;
  confidence: number;
  analysisTime: number;
  context: AnalysisContext;
  patterns: PatternMatch[];
  recommendations: Recommendation[];
}

export interface RootCause {
  type: 'code-issue' | 'configuration' | 'dependency' | 'environment' | 'data' | 'logic';
  description: string;
  location?: string;
  evidence: Evidence[];
  confidence: number;
}

export interface Evidence {
  type: 'code-analysis' | 'pattern-match' | 'historical-data' | 'static-analysis';
  description: string;
  weight: number;
  source: string;
}

export interface AnalysisContext {
  codebase: CodebaseInfo;
  environment: EnvironmentInfo;
  dependencies: DependencyInfo[];
  recentChanges: ChangeInfo[];
}

export interface CodebaseInfo {
  language: string;
  framework?: string;
  version?: string;
  size: {
    files: number;
    lines: number;
  };
  complexity: 'low' | 'medium' | 'high';
}

export interface EnvironmentInfo {
  platform: string;
  runtime: string;
  version: string;
  configuration: Record<string, unknown>;
}

export interface DependencyInfo {
  name: string;
  version: string;
  type: 'direct' | 'transitive';
  vulnerabilities?: SecurityVulnerability[];
}

export interface SecurityVulnerability {
  id: string;
  severity: 'low' | 'medium' | 'high' | 'critical';
  description: string;
  fixedIn?: string;
}

export interface ChangeInfo {
  type: 'code' | 'config' | 'dependency';
  timestamp: Date;
  author?: string;
  description: string;
  files: string[];
}

export interface PatternMatch {
  patternId: string;
  confidence: number;
  description: string;
  category: ErrorCategory;
  commonSolutions: string[];
}

export interface Recommendation {
  type: 'immediate' | 'short-term' | 'long-term';
  priority: 'low' | 'medium' | 'high' | 'critical';
  description: string;
  effort: 'minimal' | 'low' | 'medium' | 'high';
  impact: 'low' | 'medium' | 'high';
  steps: string[];
}

export interface SimilarError {
  errorId: string;
  similarity: number;
  description: string;
  resolution?: string;
  timeToResolve?: number;
  frequency: number;
}

export interface ErrorExplanation {
  summary: string;
  technicalDetails: string;
  userFriendlyExplanation: string;
  commonCauses: string[];
  preventionTips: string[];
  learningResources: LearningResource[];
}

export interface LearningResource {
  type: 'documentation' | 'tutorial' | 'video' | 'article' | 'example';
  title: string;
  url: string;
  relevance: number;
}

export interface ImpactPrediction {
  severity: ErrorSeverity;
  affectedComponents: string[];
  userImpact: 'none' | 'minimal' | 'moderate' | 'significant' | 'severe';
  businessImpact: 'none' | 'low' | 'medium' | 'high' | 'critical';
  propagationRisk: number;
  timeToFix: {
    estimated: number;
    confidence: number;
  };
}

export interface DiagnosticConfiguration {
  enableAIAnalysis: boolean;
  confidenceThreshold: number;
  maxAnalysisTime: number;
  enablePatternMatching: boolean;
  enableSimilaritySearch: boolean;
  enableImpactPrediction: boolean;
  customPatterns: CustomPattern[];
}

export interface CustomPattern {
  id: string;
  name: string;
  description: string;
  regex: string;
  category: ErrorCategory;
  severity: ErrorSeverity;
  solutions: string[];
}
