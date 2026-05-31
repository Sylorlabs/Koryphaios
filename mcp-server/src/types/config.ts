/**
 * Configuration type definitions
 */

import type { ErrorCategory, ErrorSeverity } from './errors.js';
import type { SupportedLanguage } from './languages.js';

export type TransportType = 'stdio' | 'http' | 'sse';

export interface TransportConfig {
  type: TransportType;
  // HTTP/SSE transport options (only used when type is 'http' or 'sse')
  port?: number;
  host?: string;
  // Stdio transport options (only used when type is 'stdio')
  stdio?: {
    // No additional options needed for stdio transport
  };
}

export interface ServerConfig {
  server: {
    name: string;
    version: string;
    logLevel: 'debug' | 'info' | 'warn' | 'error';
    maxConnections?: number;
    timeout?: number;
    // Legacy port/host fields (deprecated - use transport.port/host instead)
    /** @deprecated Use transport.port instead */
    port?: number;
    /** @deprecated Use transport.host instead */
    host?: string;
  };
  transport: TransportConfig;
  detection: ErrorDetectionConfig;
  analysis: ErrorAnalysisConfig;
  debugging: DebuggingConfig;
  performance: PerformanceConfig;
  integrations: IntegrationsConfig;
  security: SecurityConfig;
}

export interface ErrorDetectionConfig {
  enabled: boolean;
  realTime: boolean;
  sources: {
    console: boolean;
    runtime: boolean;
    build: boolean;
    test: boolean;
    linter: boolean;
    staticAnalysis: boolean;
    ide: boolean;
    buildTools: boolean;
    processMonitor: boolean;
    multiLanguage: boolean;
  };
  filters: {
    categories: ErrorCategory[];
    severities: ErrorSeverity[];
    excludeFiles: string[];
    excludePatterns: string[];
  };
  polling: {
    interval: number;
    maxRetries: number;
  };
  logFiles?: string[];
  watchedProcesses?: string[];
  bufferSize: number;
  maxErrorsPerSession: number;
}

export interface ErrorAnalysisConfig {
  enabled: boolean;
  aiEnhanced: boolean;
  confidenceThreshold: number;
  maxAnalysisTime: number;
  enablePatternMatching: boolean;
  enableSimilaritySearch: boolean;
  enableRootCauseAnalysis: boolean;
  enableImpactPrediction: boolean;
  customPatterns: string[];
  historicalDataRetention: number;
}

export interface DebuggingConfig {
  enabled: boolean;
  languages: Partial<Record<SupportedLanguage, LanguageDebuggingConfig>>;
  defaultTimeout: number;
  maxConcurrentSessions: number;
  enableHotReload: boolean;
  enableRemoteDebugging: boolean;
  breakpoints: {
    maxPerSession: number;
    enableConditional: boolean;
    enableLogPoints: boolean;
  };
  variableInspection: {
    maxDepth: number;
    maxStringLength: number;
    enableLazyLoading: boolean;
  };
}

export interface LanguageDebuggingConfig {
  enabled: boolean;
  debuggerPath?: string;
  defaultArgs?: string[];
  env?: Record<string, string>;
  sourceMaps?: boolean;
  skipFiles?: string[];
  justMyCode?: boolean;
  timeout?: number;
}

export interface PerformanceConfig {
  enabled: boolean;
  profiling: {
    enabled: boolean;
    sampleRate: number;
    maxDuration: number;
    includeMemory: boolean;
    includeCpu: boolean;
  };
  monitoring: {
    enabled: boolean;
    interval: number;
    thresholds: {
      memory: number;
      cpu: number;
      responseTime: number;
    };
  };
  optimization: {
    enableSuggestions: boolean;
    enableAutomaticOptimization: boolean;
    aggressiveness: 'conservative' | 'moderate' | 'aggressive';
  };
}

export interface IntegrationsConfig {
  buildSystems: {
    webpack: boolean;
    vite: boolean;
    rollup: boolean;
    parcel: boolean;
    esbuild: boolean;
  };
  testRunners: {
    jest: boolean;
    vitest: boolean;
    mocha: boolean;
    pytest: boolean;
    goTest: boolean;
    cargoTest: boolean;
  };
  linters: {
    eslint: boolean;
    tslint: boolean;
    pylint: boolean;
    flake8: boolean;
    golint: boolean;
    clippy: boolean;
  };
  versionControl: {
    git: boolean;
    enableCommitHooks: boolean;
    enableBranchAnalysis: boolean;
  };
  containers: {
    docker: boolean;
    kubernetes: boolean;
    enableContainerDebugging: boolean;
  };
  ides: {
    vscode: boolean;
    cursor: boolean;
    windsurf: boolean;
    augmentCode: boolean;
  };
}

export interface SecurityConfig {
  enableSecurityScanning: boolean;
  vulnerabilityDatabases: string[];
  enableDependencyScanning: boolean;
  enableCodeScanning: boolean;
  reportingLevel: 'all' | 'medium-high' | 'high-critical';
  autoFixVulnerabilities: boolean;
  excludePatterns: string[];
}

export interface WorkspaceConfig {
  root: string;
  projectName?: string;
  language: SupportedLanguage;
  framework?: string;
  buildSystem?: string;
  testRunner?: string;
  packageManager?: string;
  configFiles: {
    typescript?: string;
    eslint?: string;
    prettier?: string;
    jest?: string;
    vitest?: string;
    webpack?: string;
    vite?: string;
  };
  excludePatterns: string[];
  includePatterns: string[];
}

export interface UserPreferences {
  theme: 'light' | 'dark' | 'auto';
  notifications: {
    enabled: boolean;
    types: ('error' | 'warning' | 'info')[];
    sound: boolean;
  };
  ui: {
    showLineNumbers: boolean;
    showMinimap: boolean;
    fontSize: number;
    fontFamily: string;
  };
  debugging: {
    autoStartSessions: boolean;
    showInlineValues: boolean;
    showVariableTypes: boolean;
  };
  performance: {
    enableRealTimeMonitoring: boolean;
    showPerformanceHints: boolean;
  };
}

export interface ConfigValidationResult {
  valid: boolean;
  errors: ConfigValidationError[];
  warnings: ConfigValidationWarning[];
}

export interface ConfigValidationError {
  path: string;
  message: string;
  value?: unknown;
}

export interface ConfigValidationWarning {
  path: string;
  message: string;
  suggestion?: string;
}
