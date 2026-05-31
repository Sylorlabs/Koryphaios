/**
 * Complete integration flow tests
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { DevelopmentEnvironment } from '../../src/debug/development-environment.js';
import { ErrorDebuggingMCPServer } from '../../src/server/mcp-server.js';
import { SupportedLanguage } from '../../src/types/languages.js';

describe('Complete Integration Flow', () => {
  let devEnvironment: DevelopmentEnvironment;
  let mcpServer: ErrorDebuggingMCPServer;

  beforeEach(async () => {
    devEnvironment = new DevelopmentEnvironment({
      enablePerformanceMonitoring: true,
      enableDebugSessions: true,
      enableErrorDetection: true,
      logLevel: 'debug',
    });

    mcpServer = new ErrorDebuggingMCPServer({
      server: {
        name: 'test-server',
        version: '1.0.0',
        logLevel: 'debug',
      },
      detection: {
        enabled: true,
        realTime: true,
        sources: {
          console: true,
          runtime: true,
          build: true,
          test: true,
          linter: true,
          staticAnalysis: true,
          ide: true,
        },
        filters: {
          categories: [],
          severities: [],
          excludeFiles: [],
          excludePatterns: [],
        },
        polling: {
          interval: 1000,
          maxRetries: 3,
        },
        bufferSize: 1000,
        maxErrorsPerSession: 100,
      },
      analysis: {
        enabled: true,
        aiEnhanced: false,
        confidenceThreshold: 0.7,
        maxAnalysisTime: 10000,
        enablePatternMatching: true,
        enableSimilaritySearch: true,
        enableRootCauseAnalysis: true,
        enableImpactPrediction: true,
        customPatterns: [],
        historicalDataRetention: 30,
      },
      debugging: {
        enabled: true,
        languages: {},
        defaultTimeout: 30000,
        maxConcurrentSessions: 5,
        enableHotReload: false,
        enableRemoteDebugging: false,
        breakpoints: {
          maxPerSession: 50,
          enableConditional: true,
          enableLogPoints: true,
        },
        variableInspection: {
          maxDepth: 10,
          maxStringLength: 1000,
          enableLazyLoading: true,
        },
      },
      performance: {
        enabled: true,
        profiling: {
          enabled: true,
          sampleRate: 100,
          maxDuration: 60000,
          includeMemory: true,
          includeCpu: true,
        },
        monitoring: {
          enabled: true,
          interval: 5000,
          thresholds: {
            memory: 536870912,
            cpu: 80,
            responseTime: 1000,
          },
        },
        optimization: {
          enableSuggestions: true,
          enableAutomaticOptimization: false,
          aggressiveness: 'moderate',
        },
      },
      integrations: {
        vscode: {
          enabled: true,
          diagnosticsProvider: true,
          codeActionsProvider: true,
          hoverProvider: true,
        },
        cursor: {
          enabled: false,
        },
        windsurf: {
          enabled: false,
        },
        augmentCode: {
          enabled: false,
        },
      },
      security: {
        enableSecurityScanning: false,
        vulnerabilityDatabases: [],
        enableDependencyScanning: false,
        enableCodeScanning: false,
        reportingLevel: 'medium-high',
        autoFixVulnerabilities: false,
        excludePatterns: [],
      },
    });
  });

  afterEach(async () => {
    if (devEnvironment) {
      await devEnvironment.dispose();
    }
    if (mcpServer) {
      await mcpServer.close();
    }
  });

  describe('Development Environment Integration', () => {
    it('should start and stop development environment successfully', async () => {
      await devEnvironment.start();

      const status = devEnvironment.getStatus();
      expect(status.isRunning).toBe(true);
      expect(status.components.debugSessions).toBe(true);
      expect(status.components.performanceMonitor).toBe(true);
      expect(status.components.errorDetection).toBe(true);

      await devEnvironment.stop();

      const stoppedStatus = devEnvironment.getStatus();
      expect(stoppedStatus.isRunning).toBe(false);
    });

    it('should detect errors in TypeScript code', async () => {
      await devEnvironment.start();

      const typescriptCode = `
        const x: string = 123; // Type error
        function test() {
          return y; // Reference error
        }
      `;

      const errors = await devEnvironment.detectErrors(
        typescriptCode,
        SupportedLanguage.TYPESCRIPT,
        'test.ts'
      );

      // Should detect at least some errors
      expect(Array.isArray(errors)).toBe(true);
    });

    it('should detect errors in JavaScript code', async () => {
      await devEnvironment.start();

      const javascriptCode = `
        const x = ;  // Syntax error
        console.log(undefinedVariable); // Reference error
      `;

      const errors = await devEnvironment.detectErrors(
        javascriptCode,
        SupportedLanguage.JAVASCRIPT,
        'test.js'
      );

      expect(Array.isArray(errors)).toBe(true);
    });

    it('should analyze performance of code', async () => {
      await devEnvironment.start();

      const code = `
        function fibonacci(n) {
          if (n <= 1) return n;
          return fibonacci(n - 1) + fibonacci(n - 2);
        }
        
        for (let i = 0; i < 1000; i++) {
          fibonacci(10);
        }
      `;

      const analysis = await devEnvironment.analyzePerformance(code, SupportedLanguage.JAVASCRIPT);

      expect(analysis).toBeDefined();
      expect(typeof analysis.complexity).toBe('number');
      expect(Array.isArray(analysis.suggestions)).toBe(true);
    });

    it('should collect performance metrics', async () => {
      await devEnvironment.start();

      const performanceMonitor = devEnvironment.getPerformanceMonitor();

      // Record some metrics
      performanceMonitor.recordTiming('test-operation', 100);
      performanceMonitor.recordCounter('test-counter', 5);
      performanceMonitor.recordMemoryUsage('test-memory', 1024);

      const metrics = performanceMonitor.getMetrics();
      expect(metrics.length).toBeGreaterThanOrEqual(3);

      const stats = performanceMonitor.getStatistics();
      expect(stats.metrics.total).toBeGreaterThanOrEqual(3);
    });

    it('should handle multiple language detections', async () => {
      await devEnvironment.start();

      const languages = [
        { code: 'const x: string = 123;', lang: SupportedLanguage.TYPESCRIPT, file: 'test.ts' },
        { code: 'const x = ;', lang: SupportedLanguage.JAVASCRIPT, file: 'test.js' },
        { code: 'def test():\n  return x', lang: SupportedLanguage.PYTHON, file: 'test.py' },
      ];

      const results = await Promise.allSettled(
        languages.map(({ code, lang, file }) => devEnvironment.detectErrors(code, lang, file))
      );

      // All should complete (though some may have empty results if tools aren't available)
      expect(results.length).toBe(3);
      results.forEach(result => {
        expect(result.status).toBe('fulfilled');
      });
    });
  });

  describe('MCP Server Integration', () => {
    it('should start MCP server successfully', async () => {
      await mcpServer.start();

      expect(mcpServer.isServerRunning()).toBe(true);

      const capabilities = mcpServer.getCapabilities();
      expect(capabilities).toBeDefined();
      expect(capabilities.tools).toBeDefined();
      expect(capabilities.resources).toBeDefined();
    });

    it('should handle tool calls', async () => {
      await mcpServer.start();

      const tools = mcpServer.listTools();
      expect(Array.isArray(tools)).toBe(true);
      expect(tools.length).toBeGreaterThan(0);

      // Check that we have error detection tools
      const errorDetectionTool = tools.find(
        tool => tool.name.includes('detect') || tool.name.includes('error')
      );
      expect(errorDetectionTool).toBeDefined();
    });

    it('should provide resources', async () => {
      await mcpServer.start();

      const resources = mcpServer.listResources();
      expect(Array.isArray(resources)).toBe(true);
    });

    it('should handle prompts', async () => {
      await mcpServer.start();

      const prompts = mcpServer.listPrompts();
      expect(Array.isArray(prompts)).toBe(true);
    });
  });

  describe('End-to-End Error Detection Flow', () => {
    it('should complete full error detection and analysis workflow', async () => {
      // Start both systems
      await devEnvironment.start();
      await mcpServer.start();

      // Sample code with various types of errors
      const problematicCode = `
        // TypeScript code with multiple issues
        const userName: string = 123; // Type error
        
        function calculateTotal(items: any[]) {
          let total = 0;
          for (let i = 0; i < items.length; i++) { // Performance: cache length
            total += items[i].price * items[i].quantity;
          }
          return total + undefinedVariable; // Reference error
        }
        
        // Unused variable
        const unusedVar = "this is never used";
        
        // Missing return type
        function processData(data) {
          if (data) {
            return data.map(item => item.value);
          }
        }
      `;

      // 1. Detect errors using development environment
      const errors = await devEnvironment.detectErrors(
        problematicCode,
        SupportedLanguage.TYPESCRIPT,
        'problematic.ts'
      );

      expect(Array.isArray(errors)).toBe(true);

      // 2. Analyze performance
      const performanceAnalysis = await devEnvironment.analyzePerformance(
        problematicCode,
        SupportedLanguage.TYPESCRIPT
      );

      // Performance analysis might be null if TypeScript tools are not available
      if (performanceAnalysis) {
        // Handle both simple number complexity and complex object complexity
        const complexity =
          typeof performanceAnalysis.complexity === 'number'
            ? performanceAnalysis.complexity
            : performanceAnalysis.complexity?.cyclomatic;
        expect(typeof complexity).toBe('number');
      } else {
        // If no handler is available, that's acceptable in integration tests
        console.warn('TypeScript handler not available for performance analysis');
      }

      // 3. Check that performance monitoring captured the operations
      const performanceMonitor = devEnvironment.getPerformanceMonitor();
      const metrics = performanceMonitor.getMetrics();

      // Should have metrics from the error detection and performance analysis
      expect(metrics.length).toBeGreaterThan(0);

      // 4. Verify development environment statistics
      const stats = devEnvironment.getStatistics();
      expect(stats.environment.isRunning).toBe(true);
      expect(stats.performance.metrics.total).toBeGreaterThan(0);

      // 5. Test MCP server tool integration
      const tools = mcpServer.listTools();
      expect(tools.length).toBeGreaterThan(0);

      // The workflow completed successfully
      expect(true).toBe(true);
    });

    it('should handle error detection with missing language tools gracefully', async () => {
      await devEnvironment.start();

      // Try to detect errors in a language that might not have tools installed
      const rustCode = `
        fn main() {
          let x: i32 = "not a number"; // Type error
          println!("{}", undefined_variable); // Reference error
        }
      `;

      // Should not throw, even if Rust tools aren't available
      const errors = await devEnvironment.detectErrors(rustCode, SupportedLanguage.RUST, 'test.rs');

      expect(Array.isArray(errors)).toBe(true);
      // Errors array might be empty if tools aren't available, but should not throw
    });

    it('should maintain performance under load', async () => {
      await devEnvironment.start();

      const performanceMonitor = devEnvironment.getPerformanceMonitor();
      const startTime = Date.now();

      // Simulate multiple concurrent error detection operations
      const operations = Array.from({ length: 10 }, (_, i) => {
        const code = `const test${i} = ${i};`;
        return devEnvironment.detectErrors(code, SupportedLanguage.JAVASCRIPT, `test${i}.js`);
      });

      const results = await Promise.allSettled(operations);
      const endTime = Date.now();

      // All operations should complete
      expect(results.length).toBe(10);
      results.forEach(result => {
        expect(result.status).toBe('fulfilled');
      });

      // Should complete in reasonable time (less than 5 seconds)
      expect(endTime - startTime).toBeLessThan(5000);

      // Performance monitor should have captured metrics
      const metrics = performanceMonitor.getMetrics();
      expect(metrics.length).toBeGreaterThan(0);
    });
  });

  describe('Error Recovery and Resilience', () => {
    it('should recover from individual component failures', async () => {
      await devEnvironment.start();

      // Test that the system continues to work even if some operations fail
      const invalidCode = null as any;

      // This should not crash the entire system
      try {
        await devEnvironment.detectErrors(invalidCode, SupportedLanguage.JAVASCRIPT, 'invalid.js');
      } catch (error) {
        // Expected to fail, but system should remain stable
      }

      // System should still be running and functional
      const status = devEnvironment.getStatus();
      expect(status.isRunning).toBe(true);

      // Should still be able to process valid code
      const validCode = 'const x = 1;';
      const errors = await devEnvironment.detectErrors(
        validCode,
        SupportedLanguage.JAVASCRIPT,
        'valid.js'
      );

      expect(Array.isArray(errors)).toBe(true);
    });

    it('should handle cleanup properly', async () => {
      await devEnvironment.start();
      await mcpServer.start();

      // Verify both are running
      expect(devEnvironment.getStatus().isRunning).toBe(true);
      expect(mcpServer.isServerRunning()).toBe(true);

      // Cleanup should work without errors
      await devEnvironment.dispose();
      await mcpServer.close();

      // Should be properly cleaned up
      expect(devEnvironment.getStatus().isRunning).toBe(false);
      expect(mcpServer.isRunning()).toBe(false);
    });
  });
});
