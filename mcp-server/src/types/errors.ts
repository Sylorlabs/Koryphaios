/**
 * Error-related type definitions
 */

export interface SourceLocation {
  file: string;
  line: number;
  column: number;
  function: string | undefined;
}

export interface StackFrame {
  location: SourceLocation;
  source?: string;
  context?: string[];
}

export interface ErrorContext {
  timestamp: Date;
  environment: string;
  version?: string;
  userId?: string;
  sessionId?: string;
  metadata?: Record<string, unknown>;
}

export enum ErrorSeverity {
  LOW = 'low',
  MEDIUM = 'medium',
  HIGH = 'high',
  CRITICAL = 'critical',
}

export enum ErrorCategory {
  SYNTAX = 'syntax',
  RUNTIME = 'runtime',
  LOGICAL = 'logical',
  PERFORMANCE = 'performance',
  SECURITY = 'security',
  MEMORY = 'memory',
  NETWORK = 'network',
  CONFIGURATION = 'configuration',
}

export interface ErrorPattern {
  id: string;
  name: string;
  description: string;
  regex?: RegExp;
  conditions?: Array<(error: DetectedError) => boolean>;
  category: ErrorCategory;
  severity: ErrorSeverity;
  commonCauses: string[];
  suggestedFixes: string[];
}

export interface DetectedError {
  id: string;
  message: string;
  type: string;
  category: ErrorCategory;
  severity: ErrorSeverity;
  stackTrace: StackFrame[];
  context: ErrorContext;
  source: ErrorSource;
  patterns: string[];
  relatedErrors?: string[];
  fixSuggestions?: FixSuggestion[];
  confidence: number;
}

export interface ErrorSource {
  type:
    | 'console'
    | 'runtime'
    | 'build'
    | 'test'
    | 'linter'
    | 'static-analysis'
    | 'ide'
    | 'build-tools'
    | 'process-monitor'
    | 'multi-language';
  tool?: string;
  version?: string;
  configuration?: Record<string, unknown>;
}

export interface FixSuggestion {
  id: string;
  description: string;
  confidence: number;
  type: 'code-change' | 'configuration' | 'dependency' | 'environment';
  changes?: CodeChange[];
  instructions?: string[];
  estimatedEffort: 'low' | 'medium' | 'high';
  riskLevel: 'low' | 'medium' | 'high';
}

export interface CodeChange {
  file: string;
  startLine: number;
  endLine: number;
  originalCode: string;
  suggestedCode: string;
  explanation: string;
}

export interface ErrorAnalysis {
  error: DetectedError;
  rootCause?: string;
  impactAssessment: string;
  relatedIssues: string[];
  historicalOccurrences: number;
  trends: ErrorTrend[];
  recommendations: string[];
}

export interface ErrorTrend {
  period: string;
  occurrences: number;
  severity: ErrorSeverity;
  resolved: number;
}

export interface ErrorFilter {
  categories?: ErrorCategory[];
  severities?: ErrorSeverity[];
  sources?: string[];
  timeRange?: {
    start: Date;
    end: Date;
  };
  files?: string[];
  functions?: string[];
  excludeFiles?: string[];
  excludePatterns?: string[];
}
