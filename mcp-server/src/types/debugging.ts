/**
 * Debugging-related type definitions
 */

import type { SourceLocation } from './errors.js';

export interface Breakpoint {
  id: string;
  location: SourceLocation;
  condition?: string;
  hitCount?: number;
  enabled: boolean;
  temporary?: boolean;
  logMessage?: string;
}

export interface DebugSession {
  id: string;
  language: string;
  framework?: string;
  processId?: number;
  status: 'starting' | 'running' | 'paused' | 'stopped' | 'error';
  breakpoints: Breakpoint[];
  watchExpressions: WatchExpression[];
  callStack: CallStackFrame[];
  variables: VariableScope[];
  configuration: DebugConfiguration;
}

export interface CallStackFrame {
  id: string;
  name: string;
  location: SourceLocation;
  variables: Variable[];
  canRestart?: boolean;
}

export interface Variable {
  name: string;
  value: string;
  type: string;
  variablesReference?: number;
  namedVariables?: number;
  indexedVariables?: number;
  memoryReference?: string;
}

export interface VariableScope {
  name: string;
  variablesReference: number;
  namedVariables?: number;
  indexedVariables?: number;
  expensive: boolean;
}

export interface WatchExpression {
  id: string;
  expression: string;
  result?: Variable;
  error?: string;
}

export interface DebugConfiguration {
  type: string;
  request: 'launch' | 'attach';
  name: string;
  program?: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  stopOnEntry?: boolean;
  console?: 'internalConsole' | 'integratedTerminal' | 'externalTerminal';
  sourceMaps?: boolean;
  outFiles?: string[];
  skipFiles?: string[];
  justMyCode?: boolean;
  port?: number;
  host?: string;
  timeout?: number;
}

export interface PerformanceProfile {
  id: string;
  sessionId: string;
  startTime: Date;
  endTime: Date;
  duration: number;
  samples: PerformanceSample[];
  hotspots: PerformanceHotspot[];
  memoryUsage: MemorySnapshot[];
  cpuUsage: CpuSnapshot[];
}

export interface PerformanceSample {
  timestamp: number;
  stackTrace: StackFrame[];
  cpuTime: number;
  memoryUsage: number;
}

export interface PerformanceHotspot {
  location: SourceLocation;
  totalTime: number;
  selfTime: number;
  hitCount: number;
  percentage: number;
}

export interface MemorySnapshot {
  timestamp: number;
  heapUsed: number;
  heapTotal: number;
  external: number;
  rss: number;
  arrayBuffers?: number;
}

export interface CpuSnapshot {
  timestamp: number;
  user: number;
  system: number;
  idle: number;
  percentage: number;
}

export interface StackFrame {
  location: SourceLocation;
  source?: string;
  context?: string[];
}

export interface DebugEvent {
  type: 'breakpoint' | 'exception' | 'step' | 'pause' | 'continue' | 'terminate';
  sessionId: string;
  timestamp: Date;
  data?: Record<string, unknown>;
}

export interface DebugCapabilities {
  supportsBreakpoints: boolean;
  supportsConditionalBreakpoints: boolean;
  supportsHitCountBreakpoints: boolean;
  supportsLogPoints: boolean;
  supportsStepInTargets: boolean;
  supportsStepBack: boolean;
  supportsSetVariable: boolean;
  supportsRestartFrame: boolean;
  supportsGotoTargets: boolean;
  supportsCompletions: boolean;
  supportsModulesRequest: boolean;
  supportsRestartRequest: boolean;
  supportsExceptionOptions: boolean;
  supportsValueFormattingOptions: boolean;
  supportsExceptionInfoRequest: boolean;
  supportTerminateDebuggee: boolean;
  supportSuspendDebuggee: boolean;
  supportsDelayedStackTraceLoading: boolean;
  supportsLoadedSourcesRequest: boolean;
  supportsLogPointsConditional: boolean;
  supportsSetExpression: boolean;
  supportsTerminateThreadsRequest: boolean;
  supportsEvaluateForHovers: boolean;
  supportsClipboardContext: boolean;
}
