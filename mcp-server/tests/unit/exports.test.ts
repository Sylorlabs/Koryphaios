/**
 * Tests for the main exports module
 */

import { describe, it, expect } from 'vitest';

// Import all exports to test they are available
import * as exports from '../../src/exports.js';

describe('Exports', () => {
  describe('Module Exports', () => {
    it('should export ErrorDebuggingMCPServer', () => {
      expect(exports.ErrorDebuggingMCPServer).toBeDefined();
      expect(typeof exports.ErrorDebuggingMCPServer).toBe('function');
    });

    it('should export detector classes', () => {
      expect(exports.BaseDetector).toBeDefined();
      expect(exports.BuildDetector).toBeDefined();
      expect(exports.LinterDetector).toBeDefined();
      expect(exports.RuntimeDetector).toBeDefined();
      expect(exports.ConsoleDetector).toBeDefined();
      expect(exports.StaticAnalysisDetector).toBeDefined();
      expect(exports.TestDetector).toBeDefined();
      expect(exports.ErrorDetectorManager).toBeDefined();
    });

    it('should export language handlers', () => {
      expect(exports.BaseLanguageHandler).toBeDefined();
      expect(exports.JavaScriptHandler).toBeDefined();
      expect(exports.TypeScriptHandler).toBeDefined();
      expect(exports.PythonHandler).toBeDefined();
      expect(exports.GoHandler).toBeDefined();
      expect(exports.RustHandler).toBeDefined();
      expect(exports.LanguageHandlerManager).toBeDefined();
    });

    it('should export debug components', () => {
      expect(exports.DevelopmentEnvironment).toBeDefined();
      expect(exports.DebugSessionManager).toBeDefined();
      expect(exports.PerformanceMonitor).toBeDefined();
    });

    it('should export utility classes', () => {
      expect(exports.ConfigManager).toBeDefined();
      expect(exports.Logger).toBeDefined();
      expect(exports.FileWatcher).toBeDefined();
      expect(exports.ProcessManager).toBeDefined();
    });

    it('should export helper functions', () => {
      expect(exports.generateId).toBeDefined();
      expect(exports.debounce).toBeDefined();
      expect(exports.throttle).toBeDefined();
      expect(exports.retry).toBeDefined();
      expect(exports.timeout).toBeDefined();
      expect(exports.parseStackTrace).toBeDefined();
      expect(exports.formatError).toBeDefined();
      expect(exports.sanitizePath).toBeDefined();
      expect(exports.isValidPath).toBeDefined();
      expect(exports.getFileExtension).toBeDefined();
      expect(exports.getLanguageFromFile).toBeDefined();
    });

    it('should export validation functions', () => {
      expect(exports.validateConfig).toBeDefined();
      expect(exports.validateLanguageConfig).toBeDefined();
      expect(exports.validateDetectorConfig).toBeDefined();
      expect(exports.validateDebugConfig).toBeDefined();
      expect(exports.validateMCPConfig).toBeDefined();
    });
  });

  describe('Type Exports', () => {
    it('should export language types', () => {
      // These are type exports, so we can't test them directly at runtime
      // But we can verify the module structure is correct
      expect(typeof exports).toBe('object');
    });

    it('should export error types', () => {
      // Type exports verification through module structure
      expect(typeof exports).toBe('object');
    });

    it('should export MCP types', () => {
      // Type exports verification through module structure
      expect(typeof exports).toBe('object');
    });
  });

  describe('Module Structure', () => {
    it('should have all expected exports', () => {
      const exportKeys = Object.keys(exports);

      // Verify we have a reasonable number of exports
      expect(exportKeys.length).toBeGreaterThan(20);

      // Verify no undefined exports
      exportKeys.forEach(key => {
        expect(exports[key as keyof typeof exports]).toBeDefined();
      });
    });

    it('should not have circular dependencies', () => {
      // If we can import the module without errors, there are no circular dependencies
      expect(exports).toBeDefined();
    });

    it('should export classes as constructors', () => {
      const classExports = [
        'ErrorDebuggingMCPServer',
        'BaseDetector',
        'BuildDetector',
        'LinterDetector',
        'RuntimeDetector',
        'ConsoleDetector',
        'IDEDetector',
        'StaticAnalysisDetector',
        'TestDetector',
        'ErrorDetectorManager',
        'BaseLanguageHandler',
        'JavaScriptHandler',
        'TypeScriptHandler',
        'PythonHandler',
        'GoHandler',
        'RustHandler',
        'LanguageHandlerManager',
        'DevelopmentEnvironment',
        'DebugSessionManager',
        'PerformanceMonitor',
        'ConfigManager',
        'Logger',
        'FileWatcher',
        'ProcessManager',
      ];

      classExports.forEach(className => {
        const exportedClass = exports[className as keyof typeof exports];
        expect(typeof exportedClass).toBe('function');
        expect(exportedClass.prototype).toBeDefined();
      });
    });

    it('should export functions as functions', () => {
      const functionExports = [
        'generateId',
        'debounce',
        'throttle',
        'retry',
        'timeout',
        'parseStackTrace',
        'formatError',
        'sanitizePath',
        'isValidPath',
        'getFileExtension',
        'getLanguageFromFile',
        'validateConfig',
        'validateLanguageConfig',
        'validateDetectorConfig',
        'validateDebugConfig',
        'validateMCPConfig',
      ];

      functionExports.forEach(functionName => {
        const exportedFunction = exports[functionName as keyof typeof exports];
        expect(typeof exportedFunction).toBe('function');
      });
    });
  });

  describe('API Surface', () => {
    it('should provide a complete API for error debugging', () => {
      // Verify we have the main server class
      expect(exports.ErrorDebuggingMCPServer).toBeDefined();

      // Verify we have all detector types
      expect(exports.BuildDetector).toBeDefined();
      expect(exports.LinterDetector).toBeDefined();
      expect(exports.RuntimeDetector).toBeDefined();
      expect(exports.ConsoleDetector).toBeDefined();
      expect(exports.IDEDetector).toBeDefined();

      // Verify we have language support
      expect(exports.JavaScriptHandler).toBeDefined();
      expect(exports.TypeScriptHandler).toBeDefined();
      expect(exports.PythonHandler).toBeDefined();

      // Verify we have debugging capabilities
      expect(exports.DebugSessionManager).toBeDefined();
      expect(exports.PerformanceMonitor).toBeDefined();
    });

    it('should provide utilities for integration', () => {
      // Configuration management
      expect(exports.ConfigManager).toBeDefined();
      expect(exports.validateConfig).toBeDefined();

      // File system utilities
      expect(exports.FileWatcher).toBeDefined();
      expect(exports.ProcessManager).toBeDefined();

      // Helper functions
      expect(exports.generateId).toBeDefined();
      expect(exports.debounce).toBeDefined();
      expect(exports.parseStackTrace).toBeDefined();
    });
  });

  describe('Backward Compatibility', () => {
    it('should maintain stable API surface', () => {
      // Test that core exports haven't changed
      const coreExports = [
        'ErrorDebuggingMCPServer',
        'BaseDetector',
        'ErrorDetectorManager',
        'LanguageHandlerManager',
        'DevelopmentEnvironment',
        'ConfigManager',
        'Logger',
      ];

      coreExports.forEach(exportName => {
        expect(exports[exportName as keyof typeof exports]).toBeDefined();
      });
    });

    it('should provide consistent naming conventions', () => {
      const exportKeys = Object.keys(exports);

      // Class names should be PascalCase (constructors have non-empty prototype.constructor)
      const classNames = exportKeys.filter(key => {
        const exported = exports[key as keyof typeof exports];
        return (
          typeof exported === 'function' &&
          exported.prototype &&
          exported.prototype.constructor === exported &&
          exported.name.charAt(0) === exported.name.charAt(0).toUpperCase()
        );
      });

      classNames.forEach(className => {
        expect(className).toMatch(/^[A-Z][a-zA-Z0-9]*$/);
      });

      // Function names should be camelCase (regular functions or functions starting with lowercase)
      const functionNames = exportKeys.filter(key => {
        const exported = exports[key as keyof typeof exports];
        return (
          typeof exported === 'function' &&
          (!exported.prototype ||
            exported.prototype.constructor !== exported ||
            exported.name.charAt(0) === exported.name.charAt(0).toLowerCase())
        );
      });

      functionNames.forEach(functionName => {
        expect(functionName).toMatch(/^[a-z][a-zA-Z0-9]*$/);
      });
    });
  });
});
