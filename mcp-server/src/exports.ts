/**
 * Library exports for the Error Debugging MCP Server
 */

// Export all modules
export * from './detectors/index.js';
export * from './languages/index.js';
export * from './debug/index.js';
export * from './utils/index.js';

// Export server separately to avoid conflicts
export { ErrorDebuggingMCPServer } from './server/index.js';

// Export types separately to avoid conflicts
export type {
  SupportedLanguage,
  LanguageError,
  LanguageHandler,
  DetectionOptions,
  LanguageDebugCapabilities,
  LanguageDebugConfig,
  LanguageDebugSession,
  PerformanceAnalysis,
} from './types/languages.js';

export type { DetectedError, ErrorSeverity, ErrorContext } from './types/errors.js';

export type { MCPServerCapabilities, MCPClientCapabilities } from './types/mcp.js';
