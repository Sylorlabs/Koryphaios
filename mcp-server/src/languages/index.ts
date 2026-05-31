/**
 * Language handlers exports
 */

export { BaseLanguageHandler } from './base-language-handler.js';
export { TypeScriptHandler } from './typescript-handler.js';
export { JavaScriptHandler } from './javascript-handler.js';
export { PythonHandler } from './python-handler.js';
export { GoHandler } from './go-handler.js';
export { RustHandler } from './rust-handler.js';
export { PHPHandler } from './php-handler.js';
export { LanguageHandlerManager } from './language-handler-manager.js';

// Re-export types
export type {
  LanguageHandler,
  SupportedLanguage,
  DetectionOptions,
  LanguageError,
  StackFrame,
  LanguageDebugCapabilities,
  LanguageDebugConfig,
  LanguageDebugSession,
  PerformanceAnalysis,
} from '../types/languages.js';
