/**
 * MCP (Model Context Protocol) specific type definitions
 */

export interface MCPTool {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
  };
}

export interface MCPResource {
  uri: string;
  name: string;
  description?: string;
  mimeType?: string;
}

export interface MCPPrompt {
  name: string;
  description: string;
  arguments?: MCPPromptArgument[];
}

export interface MCPPromptArgument {
  name: string;
  description: string;
  required?: boolean;
}

export interface MCPToolCall {
  name: string;
  arguments: Record<string, unknown>;
}

export interface MCPToolResult {
  content: MCPContent[];
  isError?: boolean;
}

export interface MCPContent {
  type: 'text' | 'image' | 'resource';
  text?: string;
  data?: string;
  mimeType?: string;
}

export interface MCPServerCapabilities {
  logging?: Record<string, unknown>;
  prompts?: {
    listChanged?: boolean;
  };
  resources?: {
    subscribe?: boolean;
    listChanged?: boolean;
  };
  tools?: {
    listChanged?: boolean;
  };
}

export interface MCPClientCapabilities {
  experimental?: Record<string, unknown>;
  sampling?: Record<string, unknown>;
}

export interface MCPInitializeParams {
  protocolVersion: string;
  capabilities: MCPClientCapabilities;
  clientInfo: {
    name: string;
    version: string;
  };
}

export interface MCPInitializeResult {
  protocolVersion: string;
  capabilities: MCPServerCapabilities;
  serverInfo: {
    name: string;
    version: string;
  };
}

// Error Debugging MCP Server specific tools
export interface DetectErrorsParams {
  source?: 'console' | 'runtime' | 'build' | 'test' | 'all';
  language?: string;
  files?: string[];
  includeWarnings?: boolean;
  realTime?: boolean;
}

export interface AnalyzeErrorParams {
  errorId: string;
  includeContext?: boolean;
  includeSuggestions?: boolean;
  includeHistory?: boolean;
}

export interface SuggestFixesParams {
  errorId: string;
  maxSuggestions?: number;
  confidenceThreshold?: number;
  includeRiskyFixes?: boolean;
}

export interface SetBreakpointParams {
  file: string;
  line: number;
  condition?: string;
  logMessage?: string;
  temporary?: boolean;
}

export interface InspectVariablesParams {
  sessionId: string;
  scope?: 'local' | 'global' | 'closure';
  frameId?: number;
  expression?: string;
}

export interface ProfilePerformanceParams {
  duration?: number;
  sampleRate?: number;
  includeMemory?: boolean;
  includeCpu?: boolean;
  filters?: string[];
}

export interface TrackMemoryParams {
  duration?: number;
  threshold?: number;
  detectLeaks?: boolean;
  includeHeapSnapshot?: boolean;
}

export interface ConfigureDebuggerParams {
  language: string;
  configuration: Record<string, unknown>;
  workspaceRoot?: string;
}

export interface GetErrorHistoryParams {
  timeRange?: {
    start: string;
    end: string;
  };
  categories?: string[];
  severities?: string[];
  limit?: number;
  offset?: number;
}

export interface ExportDiagnosticsParams {
  format: 'json' | 'csv' | 'html';
  includeStackTraces?: boolean;
  includeContext?: boolean;
  timeRange?: {
    start: string;
    end: string;
  };
}

// Resource URIs
export const MCP_RESOURCE_URIS = Object.freeze({
  ERROR_LOG: 'error-debugging://logs/errors',
  PERFORMANCE_METRICS: 'error-debugging://metrics/performance',
  MEMORY_USAGE: 'error-debugging://metrics/memory',
  DEBUG_SESSIONS: 'error-debugging://sessions/debug',
  CONFIGURATION: 'error-debugging://config/settings',
  ERROR_PATTERNS: 'error-debugging://patterns/errors',
  FIX_SUGGESTIONS: 'error-debugging://suggestions/fixes',
  BREAKPOINTS: 'error-debugging://debug/breakpoints',
  CALL_STACK: 'error-debugging://debug/callstack',
  VARIABLES: 'error-debugging://debug/variables',
} as const);

// Prompt names
export const MCP_PROMPTS = Object.freeze({
  EXPLAIN_ERROR: 'explain-error',
  SUGGEST_FIX: 'suggest-fix',
  ANALYZE_PERFORMANCE: 'analyze-performance',
  DEBUG_GUIDANCE: 'debug-guidance',
  CODE_REVIEW: 'code-review',
  ERROR_PREVENTION: 'error-prevention',
} as const);
