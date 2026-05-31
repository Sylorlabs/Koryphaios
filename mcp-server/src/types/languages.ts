/**
 * Language-specific type definitions
 */

export enum SupportedLanguage {
  TYPESCRIPT = 'typescript',
  JAVASCRIPT = 'javascript',
  PYTHON = 'python',
  GO = 'go',
  RUST = 'rust',
  PHP = 'php',
}

export interface LanguageHandler {
  language: SupportedLanguage;
  initialize(): Promise<void>;
  dispose(): Promise<void>;
  isAvailable(): Promise<boolean>;
  isFileSupported(filePath: string): boolean;
  getFileExtensions(): string[];
  getConfigFiles(): string[];
  detectErrors(source: string, options?: DetectionOptions): Promise<LanguageError[]>;
  parseStackTrace(stackTrace: string): StackFrame[];
  getDebugCapabilities(): LanguageDebugCapabilities;
  createDebugSession(config: LanguageDebugConfig): Promise<LanguageDebugSession>;
  analyzePerformance(source: string): Promise<PerformanceAnalysis>;
  on(event: string, listener: (...args: any[]) => void): this;
}

export interface DetectionOptions {
  includeWarnings?: boolean;
  includeLinting?: boolean;
  includeTypeChecking?: boolean;
  enableLinting?: boolean;
  filePath?: string;
  configPath?: string;
  workspaceRoot?: string;
}

export interface LanguageError {
  message: string;
  severity: 'error' | 'warning' | 'info' | 'hint';
  location: {
    file: string;
    line: number;
    column: number;
    endLine?: number;
    endColumn?: number;
  };
  code?: string | number;
  source: string;
  relatedInformation?: RelatedInformation[];
}

export interface RelatedInformation {
  location: {
    file: string;
    line: number;
    column: number;
  };
  message: string;
}

export interface StackFrame {
  function?: string;
  file: string;
  line: number;
  column: number;
  source?: string;
}

export interface LanguageDebugCapabilities {
  supportsBreakpoints: boolean;
  supportsConditionalBreakpoints: boolean;
  supportsStepInto: boolean;
  supportsStepOver: boolean;
  supportsStepOut: boolean;
  supportsVariableInspection: boolean;
  supportsWatchExpressions: boolean;
  supportsHotReload: boolean;
  supportsRemoteDebugging: boolean;
  // Legacy properties for backward compatibility
  breakpoints?: boolean;
  stepDebugging?: boolean;
  variableInspection?: boolean;
  callStackInspection?: boolean;
  conditionalBreakpoints?: boolean;
  hotReload?: boolean;
  profiling?: boolean;
  memoryInspection?: boolean;
}

export interface LanguageDebugConfig {
  type: 'launch' | 'attach';
  program?: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  port?: number;
  host?: string;
  [key: string]: unknown;
}

export interface LanguageDebugSession {
  id: string;
  status: 'starting' | 'running' | 'paused' | 'stopped';
  setBreakpoint(file: string, line: number, condition?: string): Promise<void>;
  removeBreakpoint(file: string, line: number): Promise<void>;
  continue(): Promise<void>;
  pause(): Promise<void>;
  stepInto(): Promise<void>;
  stepOver(): Promise<void>;
  stepOut(): Promise<void>;
  evaluateExpression(expression: string): Promise<EvaluationResult>;
  getVariables(scope?: string): Promise<Variable[]>;
  getCallStack(): Promise<CallStackFrame[]>;
  terminate(): Promise<void>;
}

export interface EvaluationResult {
  result: string;
  type: string;
  variablesReference?: number;
}

export interface Variable {
  name: string;
  value: string;
  type: string;
  variablesReference?: number;
}

export interface CallStackFrame {
  id: number;
  name: string;
  file: string;
  line: number;
  column: number;
}

export interface PerformanceAnalysis {
  complexity:
    | {
        cyclomatic: number;
        cognitive: number;
        halstead: HalsteadMetrics;
      }
    | number; // Allow backward compatibility with simple number
  maintainability?: {
    index: number;
    issues: string[];
  };
  hotspots?: PerformanceHotspot[];
  recommendations?: string[];
  // Legacy properties for backward compatibility
  suggestions?: string[];
  metrics?: {
    linesOfCode: number;
    cyclomaticComplexity: number;
  };
}

export interface HalsteadMetrics {
  vocabulary: number;
  length: number;
  calculatedLength: number;
  volume: number;
  difficulty: number;
  effort: number;
  time: number;
  bugs: number;
}

export interface PerformanceHotspot {
  type: 'complexity' | 'performance' | 'memory';
  location: {
    file: string;
    line: number;
    column: number;
  };
  description: string;
  severity: 'low' | 'medium' | 'high';
  suggestion: string;
}

// TypeScript/JavaScript specific types
export interface TypeScriptConfig {
  compilerOptions?: Record<string, unknown>;
  include?: string[];
  exclude?: string[];
  extends?: string;
}

export interface JavaScriptFramework {
  name: 'react' | 'vue' | 'angular' | 'svelte' | 'next' | 'nuxt' | 'express' | 'fastify';
  version: string;
  config?: Record<string, unknown>;
}

// Python specific types
export interface PythonEnvironment {
  type: 'system' | 'venv' | 'conda' | 'pyenv' | 'pipenv' | 'poetry';
  path: string;
  version: string;
  packages: PythonPackage[];
}

export interface PythonPackage {
  name: string;
  version: string;
  location: string;
}

// Go specific types
export interface GoModule {
  path: string;
  version: string;
  dependencies: GoDependency[];
}

export interface GoDependency {
  path: string;
  version: string;
  indirect?: boolean;
}

// Rust specific types
export interface RustCrate {
  name: string;
  version: string;
  dependencies: RustDependency[];
  features: string[];
}

export interface RustDependency {
  name: string;
  version: string;
  features?: string[];
  optional?: boolean;
  defaultFeatures?: boolean;
}

// PHP specific types
export interface PHPConfig {
  version: string;
  extensions: PHPExtension[];
  iniSettings: Record<string, string>;
  composerConfig?: ComposerConfig;
}

export interface PHPExtension {
  name: string;
  version: string;
  enabled: boolean;
}

export interface ComposerConfig {
  name: string;
  version: string;
  dependencies: ComposerPackage[];
  devDependencies: ComposerPackage[];
  autoload?: Record<string, unknown>;
}

export interface ComposerPackage {
  name: string;
  version: string;
  type?: string;
}
